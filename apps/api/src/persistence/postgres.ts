import pg from "pg";
import type { Pool } from "pg";
import { GENESIS_DIGEST, WarrantError, ledgerEntryDigest } from "@warrant/core";
import type { EvidencePack, LedgerEntry, Mandate } from "@warrant/core";
import type {
  EvidenceRepository,
  LedgerRepository,
  MandateRepository,
  NonceStore,
  ReplayScope,
  Repositories,
  RevocationRecord,
} from "./types.js";

export interface PostgresOptions {
  connectionString: string;
  caCertificate?: string;
  schema?: string;
  max?: number;
}

export function createPool(options: PostgresOptions): Pool {
  return new pg.Pool({
    connectionString: options.connectionString,
    ssl: options.caCertificate
      ? { ca: options.caCertificate, rejectUnauthorized: true }
      : { rejectUnauthorized: false },
    ...(options.schema ? { options: `-c search_path=${options.schema}` } : {}),
    max: options.max ?? 10,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  });
}

export interface FreshnessWindow {
  maxAgeSeconds: number;
  clockSkewSeconds: number;
}

export function nonceRetentionSeconds(freshness: FreshnessWindow): number {
  return freshness.maxAgeSeconds + freshness.clockSkewSeconds * 2;
}

const PRUNE_EVERY = 512;

export class PostgresNonceStore implements NonceStore {
  readonly scope: ReplayScope = "deployment";
  private sincePrune = 0;

  constructor(
    private readonly pool: Pool,
    private readonly retentionSeconds: number,
  ) {}

  async claim(nonce: string): Promise<boolean> {
    const claimed = await this.pool.query(
      `insert into nonces (nonce, expires_at)
       values ($1, now() + make_interval(secs => $2::double precision))
       on conflict (nonce) do nothing
       returning nonce`,
      [nonce, this.retentionSeconds],
    );

    this.sincePrune += 1;
    if (this.sincePrune >= PRUNE_EVERY) {
      this.sincePrune = 0;
      try {
        await this.prune();
      } catch {
        this.sincePrune = PRUNE_EVERY;
      }
    }

    return claimed.rowCount === 1;
  }

  async prune(): Promise<number> {
    const removed = await this.pool.query("delete from nonces where expires_at <= now()");
    return removed.rowCount ?? 0;
  }
}

const LEDGER_APPEND_LOCK = 20260817;

const LEDGER_COLUMNS = "seq, type, ref, recorded_at, payload_digest, prev_digest, digest";

interface LedgerRow {
  seq: string;
  type: string;
  ref: string;
  recorded_at: Date;
  payload_digest: string;
  prev_digest: string;
  digest: string;
}

export function isoFromDatabase(value: Date): string {
  return value.toISOString().replace(/\.000Z$/, "Z");
}

async function ledgerEntryFrom(row: LedgerRow): Promise<LedgerEntry> {
  const body: Omit<LedgerEntry, "digest"> = {
    seq: Number(row.seq),
    prevDigest: row.prev_digest,
    type: row.type as LedgerEntry["type"],
    recordedAt: isoFromDatabase(row.recorded_at),
    ref: row.ref,
    payloadDigest: row.payload_digest,
  };

  const recomputed = await ledgerEntryDigest(body);
  if (recomputed !== row.digest) {
    throw new WarrantError(
      "ledger/altered",
      `ledger entry ${body.seq} does not match the digest stored with it`,
    );
  }

  return { ...body, digest: row.digest };
}

export class PostgresLedgerRepository implements LedgerRepository {
  constructor(private readonly pool: Pool) {}

  async append(record: Omit<LedgerEntry, "seq" | "prevDigest" | "digest">): Promise<LedgerEntry> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock($1)", [LEDGER_APPEND_LOCK]);

      const head = await client.query<Pick<LedgerRow, "seq" | "digest">>(
        "select seq, digest from ledger_entries order by seq desc limit 1",
      );
      const previous = head.rows[0];

      const body: Omit<LedgerEntry, "digest"> = {
        seq: previous ? Number(previous.seq) + 1 : 0,
        prevDigest: previous ? previous.digest : GENESIS_DIGEST,
        ...record,
      };
      const entry: LedgerEntry = { ...body, digest: await ledgerEntryDigest(body) };

      await client.query(
        `insert into ledger_entries (seq, type, ref, recorded_at, payload_digest, prev_digest, digest)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [
          entry.seq,
          entry.type,
          entry.ref,
          entry.recordedAt,
          entry.payloadDigest,
          entry.prevDigest,
          entry.digest,
        ],
      );

      await client.query("commit");
      return entry;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async entries(): Promise<LedgerEntry[]> {
    const rows = await this.pool.query<LedgerRow>(
      `select ${LEDGER_COLUMNS} from ledger_entries order by seq`,
    );
    return Promise.all(rows.rows.map(ledgerEntryFrom));
  }

  async head(): Promise<LedgerEntry | undefined> {
    const rows = await this.pool.query<LedgerRow>(
      `select ${LEDGER_COLUMNS} from ledger_entries order by seq desc limit 1`,
    );
    const row = rows.rows[0];
    return row ? ledgerEntryFrom(row) : undefined;
  }

  async count(): Promise<number> {
    const rows = await this.pool.query<{ total: string }>(
      "select count(*) as total from ledger_entries",
    );
    return Number(rows.rows[0]?.total ?? 0);
  }
}

const MAX_CHAIN_DEPTH = 16;

export class PostgresMandateRepository implements MandateRepository {
  constructor(private readonly pool: Pool) {}

  async save(mandate: Mandate): Promise<void> {
    await this.pool.query(
      `insert into mandates (
         id, parent_id, depth, organisation_id, liable_principal_id, subject_id,
         issuer_key_id, not_before, expires_at, issued_at, document
       )
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       on conflict (id) do nothing`,
      [
        mandate.id,
        mandate.parent?.id ?? null,
        mandate.depth,
        mandate.organisation.id,
        mandate.liablePrincipal.id,
        mandate.subject.id,
        mandate.issuer.keyId,
        mandate.notBefore,
        mandate.expiresAt,
        mandate.issuedAt,
        mandate,
      ],
    );
  }

  async findById(id: string): Promise<Mandate | undefined> {
    const rows = await this.pool.query<{ document: Mandate }>(
      "select document from mandates where id = $1",
      [id],
    );
    return rows.rows[0]?.document;
  }

  async findChain(leafId: string): Promise<Mandate[] | undefined> {
    const rows = await this.pool.query<{ document: Mandate; parent_id: string | null }>(
      `with recursive lineage as (
         select id, parent_id, document, 1 as hops from mandates where id = $1
         union all
         select above.id, above.parent_id, above.document, lineage.hops + 1
         from mandates above
         join lineage on above.id = lineage.parent_id
         where lineage.hops <= $2
       )
       select document, parent_id from lineage order by hops desc`,
      [leafId, MAX_CHAIN_DEPTH],
    );

    const chain = rows.rows;
    if (chain.length === 0 || chain.length > MAX_CHAIN_DEPTH) return undefined;
    if (chain[0]!.parent_id !== null) return undefined;

    return chain.map((row) => row.document);
  }

  async revoke(record: RevocationRecord): Promise<boolean> {
    const withdrawn = await this.pool.query(
      `update mandates set revoked_at = $2, revocation_reason = $3
       where id = $1 and revoked_at is null`,
      [record.mandateId, record.revokedAt, record.reason],
    );
    return withdrawn.rowCount === 1;
  }

  async revocations(): Promise<RevocationRecord[]> {
    const rows = await this.pool.query<{
      id: string;
      revoked_at: Date;
      revocation_reason: string;
    }>(
      `select id, revoked_at, revocation_reason from mandates
       where revoked_at is not null
       order by revoked_at, id`,
    );

    return rows.rows.map((row) => ({
      mandateId: row.id,
      revokedAt: isoFromDatabase(row.revoked_at),
      reason: row.revocation_reason,
    }));
  }
}

export class PostgresEvidenceRepository implements EvidenceRepository {
  constructor(private readonly pool: Pool) {}

  async save(pack: EvidencePack): Promise<void> {
    const amount = pack.request.amount;
    await this.pool.query(
      `insert into evidence_packs (
         pack_id, root_mandate_id, verdict, evaluated_at, generated_at,
         amount_currency, amount_minor, document
       )
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (pack_id) do nothing`,
      [
        pack.packId,
        pack.authority.chain[0]!.id,
        pack.decision.verdict,
        pack.decision.evaluatedAt,
        pack.generatedAt,
        amount?.currency ?? null,
        amount?.minor ?? null,
        pack,
      ],
    );
  }

  async findById(packId: string): Promise<EvidencePack | undefined> {
    const rows = await this.pool.query<{ document: EvidencePack }>(
      "select document from evidence_packs where pack_id = $1",
      [packId],
    );
    return rows.rows[0]?.document;
  }

  async recent(limit: number): Promise<EvidencePack[]> {
    const rows = await this.pool.query<{ document: EvidencePack }>(
      `select document from evidence_packs
       order by evaluated_at desc, created_at desc, pack_id desc
       limit $1`,
      [limit],
    );
    return rows.rows.map((row) => row.document);
  }
}

export async function pingDatabase(pool: Pool): Promise<boolean> {
  try {
    await pool.query("select 1");
    return true;
  } catch {
    return false;
  }
}

export function createPostgresRepositories(pool: Pool, retentionSeconds: number): Repositories {
  return {
    mandates: new PostgresMandateRepository(pool),
    evidence: new PostgresEvidenceRepository(pool),
    ledger: new PostgresLedgerRepository(pool),
    nonces: new PostgresNonceStore(pool, retentionSeconds),
  };
}
