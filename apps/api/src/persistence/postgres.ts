import pg from "pg";
import type { Pool } from "pg";
import { GENESIS_DIGEST, WarrantError, ledgerEntryDigest } from "@warrant/core";
import type {
  AgentStatus,
  EvidencePack,
  LedgerEntry,
  Mandate,
  Money,
  RiskLevel,
  Scope,
} from "@warrant/core";
import { decodeCursor, encodeCursor, summaryOf } from "./types.js";
import type {
  Account,
  AgentKey,
  AgentRepository,
  Capability,
  CapabilityRepository,
  CapabilityStatus,
  CatalogueEnforcement,
  CatalogueState,
  DirectoryRepository,
  EvidencePage,
  EvidenceQuery,
  EvidenceRepository,
  LedgerRepository,
  MandateRepository,
  MemberSummary,
  Membership,
  MembershipRole,
  NonceStore,
  Organisation,
  RegisteredAgent,
  ReplayScope,
  Repositories,
  RevocationRecord,
  TenantScope,
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

  async entriesFor(refs: string[]): Promise<LedgerEntry[]> {
    if (refs.length === 0) return [];
    const rows = await this.pool.query<LedgerRow>(
      `select ${LEDGER_COLUMNS} from ledger_entries where ref = any($1::text[]) order by seq`,
      [refs],
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

  async findById(id: string, scope: TenantScope): Promise<Mandate | undefined> {
    const rows = await this.pool.query<{ document: Mandate }>(
      `select document from mandates
       where id = $1 and ($2::text is null or organisation_id = $2)`,
      [id, scope],
    );
    return rows.rows[0]?.document;
  }

  async descendants(id: string, scope: TenantScope): Promise<Mandate[]> {
    const rows = await this.pool.query<{ document: Mandate }>(
      `with recursive tree as (
         select id, document, 0 as generation from mandates
          where id = $1 and ($2::text is null or organisation_id = $2)
         union all
         select child.id, child.document, tree.generation + 1
           from mandates child
           join tree on child.parent_id = tree.id
          where ($2::text is null or child.organisation_id = $2)
            and tree.generation < 32
       )
       select document from tree order by generation, id`,
      [id, scope],
    );
    return rows.rows.map((row) => row.document);
  }

  async findChain(leafId: string, scope: TenantScope): Promise<Mandate[] | undefined> {
    const rows = await this.pool.query<{ document: Mandate; parent_id: string | null }>(
      `with recursive lineage as (
         select id, parent_id, document, 1 as hops from mandates
         where id = $1 and ($3::text is null or organisation_id = $3)
         union all
         select above.id, above.parent_id, above.document, lineage.hops + 1
         from mandates above
         join lineage on above.id = lineage.parent_id
         where lineage.hops <= $2 and ($3::text is null or above.organisation_id = $3)
       )
       select document, parent_id from lineage order by hops desc`,
      [leafId, MAX_CHAIN_DEPTH, scope],
    );

    const chain = rows.rows;
    if (chain.length === 0 || chain.length > MAX_CHAIN_DEPTH) return undefined;
    if (chain[0]!.parent_id !== null) return undefined;

    return chain.map((row) => row.document);
  }

  async revoke(record: RevocationRecord, scope: TenantScope): Promise<boolean> {
    const withdrawn = await this.pool.query(
      `update mandates set revoked_at = $2, revocation_reason = $3
       where id = $1 and revoked_at is null and ($4::text is null or organisation_id = $4)`,
      [record.mandateId, record.revokedAt, record.reason, scope],
    );
    return withdrawn.rowCount === 1;
  }

  async revocations(scope: TenantScope): Promise<RevocationRecord[]> {
    const rows = await this.pool.query<{
      id: string;
      revoked_at: Date;
      revocation_reason: string;
    }>(
      `select id, revoked_at, revocation_reason from mandates
       where revoked_at is not null and ($1::text is null or organisation_id = $1)
       order by revoked_at, id`,
      [scope],
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

  async save(pack: EvidencePack, organisationId: string): Promise<void> {
    const amount = pack.request.amount;
    await this.pool.query(
      `insert into evidence_packs (
         pack_id, root_mandate_id, organisation_id, verdict, evaluated_at, generated_at,
         amount_currency, amount_minor, document
       )
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       on conflict (pack_id) do nothing`,
      [
        pack.packId,
        pack.authority.chain[0]!.id,
        organisationId,
        pack.decision.verdict,
        pack.decision.evaluatedAt,
        pack.generatedAt,
        amount?.currency ?? null,
        amount?.minor ?? null,
        pack,
      ],
    );
  }

  async findById(packId: string, scope: TenantScope): Promise<EvidencePack | undefined> {
    const rows = await this.pool.query<{ document: EvidencePack }>(
      `select document from evidence_packs
       where pack_id = $1 and ($2::text is null or organisation_id = $2)`,
      [packId, scope],
    );
    return rows.rows[0]?.document;
  }

  async recent(limit: number, scope: TenantScope): Promise<EvidencePack[]> {
    const rows = await this.pool.query<{ document: EvidencePack }>(
      `select document from evidence_packs
       where ($2::text is null or organisation_id = $2)
       order by evaluated_at desc, created_at desc, pack_id desc
       limit $1`,
      [limit, scope],
    );
    return rows.rows.map((row) => row.document);
  }

  async search(query: EvidenceQuery, scope: TenantScope): Promise<EvidencePage> {
    // Every filter is a SQL predicate, tenant included. Fetching and then filtering would put
    // another organisation's evidence into this process's memory, which is where a leak starts.
    const values: unknown[] = [scope];
    const where = ["($1::text is null or organisation_id = $1)"];
    const bind = (value: unknown): string => `$${values.push(value)}`;

    if (query.verdict) where.push(`verdict = ${bind(query.verdict)}`);
    if (query.action) where.push(`action = ${bind(query.action)}`);
    if (query.counterparty) where.push(`counterparty = ${bind(query.counterparty)}`);
    if (query.actor) where.push(`actor = ${bind(query.actor)}`);
    if (query.rootMandateId) where.push(`root_mandate_id = ${bind(query.rootMandateId)}`);
    if (query.currency) where.push(`amount_currency = ${bind(query.currency)}`);
    if (query.minAmount !== undefined) where.push(`amount_minor >= ${bind(query.minAmount)}`);
    if (query.maxAmount !== undefined) where.push(`amount_minor <= ${bind(query.maxAmount)}`);
    if (query.from) where.push(`evaluated_at >= ${bind(query.from)}::timestamptz`);
    if (query.to) where.push(`evaluated_at <= ${bind(query.to)}::timestamptz`);

    const after = query.cursor ? decodeCursor(query.cursor) : undefined;
    if (after) {
      where.push(
        `(evaluated_at, pack_id) < (${bind(after.evaluatedAt)}::timestamptz, ${bind(after.packId)})`,
      );
    }

    // One row more than asked for, so "is there another page" costs no second count query.
    const rows = await this.pool.query<{ document: EvidencePack }>(
      `select document from evidence_packs
       where ${where.join(" and ")}
       order by evaluated_at desc, pack_id desc
       limit ${bind(query.limit + 1)}`,
      values,
    );

    const documents = rows.rows.map((row) => row.document);
    const results = documents.slice(0, query.limit).map(summaryOf);
    const last = results[results.length - 1];

    return {
      results,
      ...(last && documents.length > query.limit
        ? { nextCursor: encodeCursor(last.evaluatedAt, last.packId) }
        : {}),
    };
  }
}


interface AgentRow {
  id: string;
  organisation_id: string;
  name: string;
  runtime: string;
  status: AgentStatus;
  registered_at: Date;
  status_changed_at: Date;
  status_reason: string | null;
}

interface AgentKeyRow {
  key_id: string;
  agent_id: string;
  public_key_jwk: AgentKey["publicKeyJwk"];
  signing_from: Date;
  signing_until: Date | null;
}

function agentFrom(row: AgentRow): RegisteredAgent {
  return {
    id: row.id,
    organisationId: row.organisation_id,
    name: row.name,
    runtime: row.runtime,
    status: row.status,
    registeredAt: isoFromDatabase(row.registered_at),
    statusChangedAt: isoFromDatabase(row.status_changed_at),
    ...(row.status_reason ? { statusReason: row.status_reason } : {}),
  };
}

function agentKeyFrom(row: AgentKeyRow): AgentKey {
  return {
    keyId: row.key_id,
    agentId: row.agent_id,
    publicKeyJwk: row.public_key_jwk,
    signingFrom: isoFromDatabase(row.signing_from),
    ...(row.signing_until ? { signingUntil: isoFromDatabase(row.signing_until) } : {}),
  };
}

const AGENT_COLUMNS =
  "id, organisation_id, name, runtime, status, registered_at, status_changed_at, status_reason";
const AGENT_KEY_COLUMNS = "key_id, agent_id, public_key_jwk, signing_from, signing_until";

export class PostgresAgentRepository implements AgentRepository {
  constructor(private readonly pool: Pool) {}

  async register(agent: RegisteredAgent, key: AgentKey): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const inserted = await client.query(
        `insert into agents (id, organisation_id, name, runtime, status, registered_at, status_changed_at, status_reason)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         on conflict do nothing`,
        [
          agent.id,
          agent.organisationId,
          agent.name,
          agent.runtime,
          agent.status,
          agent.registeredAt,
          agent.statusChangedAt,
          agent.statusReason ?? null,
        ],
      );
      if (inserted.rowCount !== 1) {
        await client.query("rollback");
        return false;
      }

      await client.query(
        `insert into agent_keys (key_id, agent_id, public_key_jwk, signing_from)
         values ($1, $2, $3, $4)`,
        [key.keyId, key.agentId, key.publicKeyJwk, key.signingFrom],
      );

      await client.query("commit");
      return true;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      if ((error as { code?: string }).code === "23505") return false;
      throw error;
    } finally {
      client.release();
    }
  }

  async findById(id: string, scope: TenantScope): Promise<RegisteredAgent | undefined> {
    const rows = await this.pool.query<AgentRow>(
      `select ${AGENT_COLUMNS} from agents
       where id = $1 and ($2::text is null or organisation_id = $2)`,
      [id, scope],
    );
    const row = rows.rows[0];
    return row ? agentFrom(row) : undefined;
  }

  async findByKeyId(keyId: string): Promise<RegisteredAgent | undefined> {
    const rows = await this.pool.query<AgentRow>(
      `select ${AGENT_COLUMNS.split(", ").map((column) => `agents.${column}`).join(", ")}
       from agents join agent_keys on agent_keys.agent_id = agents.id
       where agent_keys.key_id = $1`,
      [keyId],
    );
    const row = rows.rows[0];
    return row ? agentFrom(row) : undefined;
  }

  async list(scope: TenantScope): Promise<RegisteredAgent[]> {
    const rows = await this.pool.query<AgentRow>(
      `select ${AGENT_COLUMNS} from agents
       where ($1::text is null or organisation_id = $1)
       order by name`,
      [scope],
    );
    return rows.rows.map(agentFrom);
  }

  async setStatus(
    id: string,
    status: AgentStatus,
    changedAt: string,
    reason: string | undefined,
    scope: TenantScope,
  ): Promise<boolean> {
    const updated = await this.pool.query(
      `update agents set status = $2, status_changed_at = $3, status_reason = $4
       where id = $1 and ($5::text is null or organisation_id = $5)`,
      [id, status, changedAt, reason ?? null, scope],
    );
    return updated.rowCount === 1;
  }

  async currentKey(agentId: string): Promise<AgentKey | undefined> {
    const rows = await this.pool.query<AgentKeyRow>(
      `select ${AGENT_KEY_COLUMNS} from agent_keys
       where agent_id = $1 and signing_until is null`,
      [agentId],
    );
    const row = rows.rows[0];
    return row ? agentKeyFrom(row) : undefined;
  }

  async keysFor(organisationId: string): Promise<AgentKey[]> {
    const rows = await this.pool.query<AgentKeyRow>(
      `select ${AGENT_KEY_COLUMNS.split(", ").map((column) => `agent_keys.${column}`).join(", ")}
       from agent_keys join agents on agents.id = agent_keys.agent_id
       where agents.organisation_id = $1
       order by agent_keys.signing_from, agent_keys.key_id`,
      [organisationId],
    );
    return rows.rows.map(agentKeyFrom);
  }

  async rotate(agentId: string, replacement: AgentKey, retiredAt: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const retired = await client.query(
        `update agent_keys set signing_until = $2
         where agent_id = $1 and signing_until is null`,
        [agentId, retiredAt],
      );
      if (retired.rowCount !== 1) {
        await client.query("rollback");
        return false;
      }

      await client.query(
        `insert into agent_keys (key_id, agent_id, public_key_jwk, signing_from)
         values ($1, $2, $3, $4)`,
        [replacement.keyId, replacement.agentId, replacement.publicKeyJwk, replacement.signingFrom],
      );

      await client.query("commit");
      return true;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      if ((error as { code?: string }).code === "23505") return false;
      throw error;
    } finally {
      client.release();
    }
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

export class PostgresDirectoryRepository implements DirectoryRepository {
  constructor(private readonly pool: Pool) {}

  async createOrganisation(organisation: Organisation): Promise<boolean> {
    const created = await this.pool.query(
      `insert into organisations (id, name, jurisdiction) values ($1, $2, $3)
       on conflict (id) do nothing`,
      [organisation.id, organisation.name, organisation.jurisdiction],
    );
    return created.rowCount === 1;
  }

  async findOrganisation(id: string): Promise<Organisation | undefined> {
    const rows = await this.pool.query<Organisation>(
      "select id, name, jurisdiction from organisations where id = $1",
      [id],
    );
    return rows.rows[0];
  }

  async rememberAccount(account: Account): Promise<Account> {
    const rows = await this.pool.query<{
      id: string;
      issuer: string;
      subject: string;
      email: string | null;
    }>(
      `insert into accounts (id, issuer, subject, email) values ($1, $2, $3, $4)
       on conflict (issuer, subject) do update set email = coalesce(excluded.email, accounts.email)
       returning id, issuer, subject, email`,
      [account.id, account.issuer, account.subject, account.email ?? null],
    );
    const row = rows.rows[0]!;
    return {
      id: row.id,
      issuer: row.issuer,
      subject: row.subject,
      ...(row.email ? { email: row.email } : {}),
    };
  }

  async grant(membership: Membership): Promise<void> {
    await this.pool.query(
      `insert into memberships (organisation_id, account_id, role) values ($1, $2, $3)
       on conflict (organisation_id, account_id) do update set role = excluded.role`,
      [membership.organisationId, membership.accountId, membership.role],
    );
  }

  async withdraw(organisationId: string, accountId: string): Promise<boolean> {
    const removed = await this.pool.query(
      "delete from memberships where organisation_id = $1 and account_id = $2",
      [organisationId, accountId],
    );
    return removed.rowCount === 1;
  }

  async membership(organisationId: string, accountId: string): Promise<Membership | undefined> {
    const rows = await this.pool.query<{ role: MembershipRole }>(
      "select role from memberships where organisation_id = $1 and account_id = $2",
      [organisationId, accountId],
    );
    const row = rows.rows[0];
    return row ? { organisationId, accountId, role: row.role } : undefined;
  }

  async membershipsFor(accountId: string): Promise<Membership[]> {
    const rows = await this.pool.query<{ organisation_id: string; role: MembershipRole }>(
      `select organisation_id, role from memberships
       where account_id = $1 order by granted_at, organisation_id`,
      [accountId],
    );
    return rows.rows.map((row) => ({
      organisationId: row.organisation_id,
      accountId,
      role: row.role,
    }));
  }

  async members(organisationId: string): Promise<MemberSummary[]> {
    const rows = await this.pool.query<{
      account_id: string;
      role: MembershipRole;
      email: string | null;
    }>(
      `select memberships.account_id, memberships.role, accounts.email
       from memberships join accounts on accounts.id = memberships.account_id
       where memberships.organisation_id = $1
       order by memberships.granted_at, memberships.account_id`,
      [organisationId],
    );
    return rows.rows.map((row) => ({
      organisationId,
      accountId: row.account_id,
      role: row.role,
      ...(row.email ? { email: row.email } : {}),
    }));
  }

  async setHouseScope(organisationId: string, scope: Scope | null, at: string): Promise<void> {
    await this.pool.query(
      `insert into house_scopes (organisation_id, scope, set_at)
       values ($1, $2, $3)
       on conflict (organisation_id) do update
         set scope = excluded.scope, set_at = excluded.set_at`,
      [organisationId, scope, at],
    );
  }

  async houseScope(organisationId: string): Promise<Scope | undefined> {
    const rows = await this.pool.query<{ scope: Scope | null }>(
      "select scope from house_scopes where organisation_id = $1",
      [organisationId],
    );
    return rows.rows[0]?.scope ?? undefined;
  }
}

const CAPABILITY_COLUMNS =
  "organisation_id, id, title, description, risk, amount_rule, currencies, " +
  "approval_above_currency, approval_above_minor, status, registered_at, status_changed_at";

interface CapabilityRow {
  organisation_id: string;
  id: string;
  title: string;
  description: string;
  risk: RiskLevel;
  amount_rule: Capability["amount"];
  currencies: string[] | null;
  approval_above_currency: string | null;
  approval_above_minor: string | null;
  status: CapabilityStatus;
  registered_at: Date;
  status_changed_at: Date;
}

function capabilityFrom(row: CapabilityRow): Capability {
  const approval =
    row.approval_above_currency !== null && row.approval_above_minor !== null
      ? {
          currency: row.approval_above_currency as Money["currency"],
          minor: Number(row.approval_above_minor),
        }
      : undefined;

  return {
    id: row.id,
    organisationId: row.organisation_id,
    title: row.title,
    description: row.description,
    risk: row.risk,
    amount: row.amount_rule,
    ...(row.currencies && row.currencies.length > 0
      ? { currencies: row.currencies as Money["currency"][] }
      : {}),
    ...(approval ? { approvalAbove: approval } : {}),
    status: row.status,
    registeredAt: isoFromDatabase(row.registered_at),
    statusChangedAt: isoFromDatabase(row.status_changed_at),
  };
}

export class PostgresCapabilityRepository implements CapabilityRepository {
  constructor(private readonly pool: Pool) {}

  async register(capability: Capability): Promise<boolean> {
    const inserted = await this.pool.query(
      `insert into capabilities (
         organisation_id, id, title, description, risk, amount_rule, currencies,
         approval_above_currency, approval_above_minor, status, registered_at, status_changed_at
       )
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       on conflict do nothing`,
      [
        capability.organisationId,
        capability.id,
        capability.title,
        capability.description,
        capability.risk,
        capability.amount,
        capability.currencies ?? null,
        capability.approvalAbove?.currency ?? null,
        capability.approvalAbove?.minor ?? null,
        capability.status,
        capability.registeredAt,
        capability.statusChangedAt,
      ],
    );
    return inserted.rowCount === 1;
  }

  async find(id: string, organisationId: string): Promise<Capability | undefined> {
    const rows = await this.pool.query<CapabilityRow>(
      `select ${CAPABILITY_COLUMNS} from capabilities
       where organisation_id = $1 and id = $2`,
      [organisationId, id],
    );
    const row = rows.rows[0];
    return row ? capabilityFrom(row) : undefined;
  }

  async list(scope: TenantScope): Promise<Capability[]> {
    const rows = await this.pool.query<CapabilityRow>(
      `select ${CAPABILITY_COLUMNS} from capabilities
       where ($1::text is null or organisation_id = $1)
       order by id`,
      [scope],
    );
    return rows.rows.map(capabilityFrom);
  }

  async setStatus(
    id: string,
    status: CapabilityStatus,
    changedAt: string,
    organisationId: string,
  ): Promise<boolean> {
    const updated = await this.pool.query(
      `update capabilities set status = $3, status_changed_at = $4
       where organisation_id = $1 and id = $2`,
      [organisationId, id, status, changedAt],
    );
    return updated.rowCount === 1;
  }

  async catalogue(organisationId: string): Promise<CatalogueState> {
    const rows = await this.pool.query<{ enforcement: CatalogueEnforcement | null; size: string }>(
      `select
         (select enforcement from catalogue_settings where organisation_id = $1) as enforcement,
         (select count(*) from capabilities where organisation_id = $1) as size`,
      [organisationId],
    );
    const row = rows.rows[0];
    return { enforcement: row?.enforcement ?? "advisory", size: Number(row?.size ?? 0) };
  }

  async setEnforcement(
    organisationId: string,
    enforcement: CatalogueEnforcement,
    changedAt: string,
  ): Promise<void> {
    await this.pool.query(
      `insert into catalogue_settings (organisation_id, enforcement, changed_at)
       values ($1, $2, $3)
       on conflict (organisation_id) do update
         set enforcement = excluded.enforcement, changed_at = excluded.changed_at`,
      [organisationId, enforcement, changedAt],
    );
  }
}

export function createPostgresRepositories(pool: Pool, retentionSeconds: number): Repositories {
  return {
    mandates: new PostgresMandateRepository(pool),
    evidence: new PostgresEvidenceRepository(pool),
    ledger: new PostgresLedgerRepository(pool),
    nonces: new PostgresNonceStore(pool, retentionSeconds),
    directory: new PostgresDirectoryRepository(pool),
    agents: new PostgresAgentRepository(pool),
    capabilities: new PostgresCapabilityRepository(pool),
  };
}
