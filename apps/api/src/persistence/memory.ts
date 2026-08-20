import { GENESIS_DIGEST, ledgerEntryDigest } from "@warrant/core";
import type { EvidencePack, LedgerEntry, Mandate, Scope } from "@warrant/core";
import type { AgentStatus } from "@warrant/core";
import {
  decodeCursor,
  encodeCursor,
  matchesQuery,
  summaryOf,
} from "./types.js";
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
  NonceStore,
  Organisation,
  RegisteredAgent,
  Repositories,
  RevocationRecord,
  TenantScope,
} from "./types.js";

const MAX_CHAIN_DEPTH = 16;

const withinScope = (organisationId: string, scope: TenantScope): boolean =>
  scope === null || scope === organisationId;

export class InMemoryMandateRepository implements MandateRepository {
  private readonly rows = new Map<string, Mandate>();
  private readonly withdrawn = new Map<string, RevocationRecord>();

  async save(mandate: Mandate): Promise<void> {
    this.rows.set(mandate.id, mandate);
  }

  async revoke(record: RevocationRecord, scope: TenantScope): Promise<boolean> {
    const mandate = this.rows.get(record.mandateId);
    if (!mandate || !withinScope(mandate.organisation.id, scope)) return false;
    if (this.withdrawn.has(record.mandateId)) return false;
    this.withdrawn.set(record.mandateId, record);
    return true;
  }

  async revocations(scope: TenantScope): Promise<RevocationRecord[]> {
    return [...this.withdrawn.values()].filter((record) => {
      const mandate = this.rows.get(record.mandateId);
      return mandate ? withinScope(mandate.organisation.id, scope) : false;
    });
  }

  async findById(id: string, scope: TenantScope): Promise<Mandate | undefined> {
    const mandate = this.rows.get(id);
    return mandate && withinScope(mandate.organisation.id, scope) ? mandate : undefined;
  }

  async findChain(leafId: string, scope: TenantScope): Promise<Mandate[] | undefined> {
    const chain: Mandate[] = [];
    let cursor = await this.findById(leafId, scope);
    while (cursor) {
      chain.unshift(cursor);
      if (chain.length > MAX_CHAIN_DEPTH) return undefined;
      if (!cursor.parent) return chain;
      cursor = await this.findById(cursor.parent.id, scope);
    }
    return undefined;
  }
}

export class InMemoryEvidenceRepository implements EvidenceRepository {
  private readonly rows = new Map<string, { pack: EvidencePack; organisationId: string }>();
  private readonly order: string[] = [];

  async save(pack: EvidencePack, organisationId: string): Promise<void> {
    if (!this.rows.has(pack.packId)) this.order.push(pack.packId);
    this.rows.set(pack.packId, { pack, organisationId });
  }

  async findById(packId: string, scope: TenantScope): Promise<EvidencePack | undefined> {
    const stored = this.rows.get(packId);
    return stored && withinScope(stored.organisationId, scope) ? stored.pack : undefined;
  }

  async recent(limit: number, scope: TenantScope): Promise<EvidencePack[]> {
    const visible: EvidencePack[] = [];
    for (let index = this.order.length - 1; index >= 0 && visible.length < limit; index -= 1) {
      const stored = this.rows.get(this.order[index]!);
      if (stored && withinScope(stored.organisationId, scope)) visible.push(stored.pack);
    }
    return visible;
  }

  async search(query: EvidenceQuery, scope: TenantScope): Promise<EvidencePage> {
    const after = query.cursor ? decodeCursor(query.cursor) : undefined;

    const ordered = [...this.rows.values()]
      .filter((stored) => withinScope(stored.organisationId, scope))
      .map((stored) => summaryOf(stored.pack))
      .filter((summary) => matchesQuery(summary, query))
      .sort((a, b) =>
        a.evaluatedAt === b.evaluatedAt
          ? b.packId.localeCompare(a.packId)
          : a.evaluatedAt < b.evaluatedAt
            ? 1
            : -1,
      )
      .filter(
        (summary) =>
          !after ||
          summary.evaluatedAt < after.evaluatedAt ||
          (summary.evaluatedAt === after.evaluatedAt && summary.packId < after.packId),
      );

    const results = ordered.slice(0, query.limit);
    const last = results[results.length - 1];

    return {
      results,
      ...(last && ordered.length > results.length
        ? { nextCursor: encodeCursor(last.evaluatedAt, last.packId) }
        : {}),
    };
  }
}

export class InMemoryLedgerRepository implements LedgerRepository {
  private readonly rows: LedgerEntry[] = [];

  async append(record: Omit<LedgerEntry, "seq" | "prevDigest" | "digest">): Promise<LedgerEntry> {
    const previous = this.rows[this.rows.length - 1];
    const body: Omit<LedgerEntry, "digest"> = {
      seq: this.rows.length,
      prevDigest: previous ? previous.digest : GENESIS_DIGEST,
      ...record,
    };
    const entry: LedgerEntry = { ...body, digest: await ledgerEntryDigest(body) };
    this.rows.push(entry);
    return entry;
  }

  async entries(): Promise<LedgerEntry[]> {
    return [...this.rows];
  }

  async head(): Promise<LedgerEntry | undefined> {
    return this.rows[this.rows.length - 1];
  }

  async count(): Promise<number> {
    return this.rows.length;
  }
}

export class InMemoryNonceStore implements NonceStore {
  readonly scope = "process" as const;
  private readonly seen = new Set<string>();

  async claim(nonce: string): Promise<boolean> {
    if (this.seen.has(nonce)) return false;
    this.seen.add(nonce);
    return true;
  }
}

export class InMemoryDirectoryRepository implements DirectoryRepository {
  private readonly organisations = new Map<string, Organisation>();
  private readonly accounts = new Map<string, Account>();
  private readonly memberships = new Map<string, Membership>();
  private readonly ceilings = new Map<string, Scope>();

  private static key(organisationId: string, accountId: string): string {
    return `${organisationId}\0${accountId}`;
  }

  async createOrganisation(organisation: Organisation): Promise<boolean> {
    if (this.organisations.has(organisation.id)) return false;
    this.organisations.set(organisation.id, organisation);
    return true;
  }

  async findOrganisation(id: string): Promise<Organisation | undefined> {
    return this.organisations.get(id);
  }

  async rememberAccount(account: Account): Promise<Account> {
    const existing = [...this.accounts.values()].find(
      (row) => row.issuer === account.issuer && row.subject === account.subject,
    );
    if (existing) {
      const merged = { ...existing, ...(account.email ? { email: account.email } : {}) };
      this.accounts.set(existing.id, merged);
      return merged;
    }
    this.accounts.set(account.id, account);
    return account;
  }

  async grant(membership: Membership): Promise<void> {
    this.memberships.set(
      InMemoryDirectoryRepository.key(membership.organisationId, membership.accountId),
      membership,
    );
  }

  async withdraw(organisationId: string, accountId: string): Promise<boolean> {
    return this.memberships.delete(InMemoryDirectoryRepository.key(organisationId, accountId));
  }

  async membership(organisationId: string, accountId: string): Promise<Membership | undefined> {
    return this.memberships.get(InMemoryDirectoryRepository.key(organisationId, accountId));
  }

  async membershipsFor(accountId: string): Promise<Membership[]> {
    return [...this.memberships.values()].filter((row) => row.accountId === accountId);
  }

  async members(organisationId: string): Promise<MemberSummary[]> {
    return [...this.memberships.values()]
      .filter((row) => row.organisationId === organisationId)
      .map((row) => {
        const account = this.accounts.get(row.accountId);
        return { ...row, ...(account?.email ? { email: account.email } : {}) };
      });
  }

  async setHouseScope(organisationId: string, scope: Scope | null, _at: string): Promise<void> {
    if (scope) this.ceilings.set(organisationId, scope);
    else this.ceilings.delete(organisationId);
  }

  async houseScope(organisationId: string): Promise<Scope | undefined> {
    return this.ceilings.get(organisationId);
  }
}

export class InMemoryAgentRepository implements AgentRepository {
  private readonly rows = new Map<string, RegisteredAgent>();
  private readonly keys = new Map<string, AgentKey>();

  async register(agent: RegisteredAgent, key: AgentKey): Promise<boolean> {
    const clash = [...this.rows.values()].some(
      (row) => row.organisationId === agent.organisationId && row.name === agent.name,
    );
    if (this.rows.has(agent.id) || this.keys.has(key.keyId) || clash) return false;

    this.rows.set(agent.id, agent);
    this.keys.set(key.keyId, key);
    return true;
  }

  async findById(id: string, scope: TenantScope): Promise<RegisteredAgent | undefined> {
    const agent = this.rows.get(id);
    return agent && withinScope(agent.organisationId, scope) ? agent : undefined;
  }

  async findByKeyId(keyId: string): Promise<RegisteredAgent | undefined> {
    const key = this.keys.get(keyId);
    return key ? this.rows.get(key.agentId) : undefined;
  }

  async list(scope: TenantScope): Promise<RegisteredAgent[]> {
    return [...this.rows.values()]
      .filter((agent) => withinScope(agent.organisationId, scope))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async setStatus(
    id: string,
    status: AgentStatus,
    changedAt: string,
    reason: string | undefined,
    scope: TenantScope,
  ): Promise<boolean> {
    const agent = await this.findById(id, scope);
    if (!agent) return false;

    this.rows.set(id, {
      ...agent,
      status,
      statusChangedAt: changedAt,
      ...(reason ? { statusReason: reason } : {}),
    });
    return true;
  }

  async currentKey(agentId: string): Promise<AgentKey | undefined> {
    return [...this.keys.values()].find((key) => key.agentId === agentId && !key.signingUntil);
  }

  async keysFor(organisationId: string): Promise<AgentKey[]> {
    const mine = new Set(
      [...this.rows.values()]
        .filter((agent) => agent.organisationId === organisationId)
        .map((agent) => agent.id),
    );
    return [...this.keys.values()].filter((key) => mine.has(key.agentId));
  }

  async rotate(agentId: string, replacement: AgentKey, retiredAt: string): Promise<boolean> {
    if (this.keys.has(replacement.keyId)) return false;
    const current = await this.currentKey(agentId);
    if (!current) return false;

    this.keys.set(current.keyId, { ...current, signingUntil: retiredAt });
    this.keys.set(replacement.keyId, replacement);
    return true;
  }
}

export class InMemoryCapabilityRepository implements CapabilityRepository {
  private readonly rows = new Map<string, Capability>();
  private readonly settings = new Map<string, { enforcement: CatalogueEnforcement; changedAt: string }>();

  private static key(organisationId: string, id: string): string {
    return `${organisationId}\0${id}`;
  }

  async register(capability: Capability): Promise<boolean> {
    const key = InMemoryCapabilityRepository.key(capability.organisationId, capability.id);
    if (this.rows.has(key)) return false;
    this.rows.set(key, capability);
    return true;
  }

  async find(id: string, organisationId: string): Promise<Capability | undefined> {
    return this.rows.get(InMemoryCapabilityRepository.key(organisationId, id));
  }

  async list(scope: TenantScope): Promise<Capability[]> {
    return [...this.rows.values()]
      .filter((capability) => withinScope(capability.organisationId, scope))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async setStatus(
    id: string,
    status: CapabilityStatus,
    changedAt: string,
    organisationId: string,
  ): Promise<boolean> {
    const key = InMemoryCapabilityRepository.key(organisationId, id);
    const capability = this.rows.get(key);
    if (!capability) return false;

    this.rows.set(key, { ...capability, status, statusChangedAt: changedAt });
    return true;
  }

  async catalogue(organisationId: string): Promise<CatalogueState> {
    let size = 0;
    for (const capability of this.rows.values()) {
      if (capability.organisationId === organisationId) size += 1;
    }
    return { enforcement: this.settings.get(organisationId)?.enforcement ?? "advisory", size };
  }

  async setEnforcement(
    organisationId: string,
    enforcement: CatalogueEnforcement,
    changedAt: string,
  ): Promise<void> {
    this.settings.set(organisationId, { enforcement, changedAt });
  }
}

export function createInMemoryRepositories(): Repositories {
  return {
    mandates: new InMemoryMandateRepository(),
    evidence: new InMemoryEvidenceRepository(),
    ledger: new InMemoryLedgerRepository(),
    nonces: new InMemoryNonceStore(),
    directory: new InMemoryDirectoryRepository(),
    agents: new InMemoryAgentRepository(),
    capabilities: new InMemoryCapabilityRepository(),
  };
}
