import pg from "pg";
import type { Pool } from "pg";
import { GENESIS_DIGEST, WarrantError, ledgerEntryDigest } from "@warrant/core";
import type { LedgerEntry } from "@warrant/core";
import type { LedgerRepository, NonceStore, ReplayScope } from "./types.js";

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
