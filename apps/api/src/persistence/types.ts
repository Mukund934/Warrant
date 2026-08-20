import type {
  ActionRequest,
  AgentStatus,
  EvidencePack,
  LedgerEntry,
  Mandate,
  Money,
  RiskLevel,
  Scope,
  TrustRoot,
  Verdict,
} from "@warrant/core";

export type TenantScope = string | null;

export type MembershipRole = "owner" | "admin" | "member" | "auditor";

export interface Organisation {
  id: string;
  name: string;
  jurisdiction: string;
}

export interface Account {
  id: string;
  issuer: string;
  subject: string;
  email?: string;
}

export interface Membership {
  organisationId: string;
  accountId: string;
  role: MembershipRole;
}

export interface MemberSummary extends Membership {
  email?: string;
}

export interface RevocationRecord {
  mandateId: string;
  revokedAt: string;
  reason: string;
}

export interface MandateRepository {
  save(mandate: Mandate): Promise<void>;
  findById(id: string, scope: TenantScope): Promise<Mandate | undefined>;
  findChain(leafId: string, scope: TenantScope): Promise<Mandate[] | undefined>;
  revoke(record: RevocationRecord, scope: TenantScope): Promise<boolean>;
  revocations(scope: TenantScope): Promise<RevocationRecord[]>;
  /** This mandate and everything delegated beneath it, nearest first. Empty if it is not visible. */
  descendants(id: string, scope: TenantScope): Promise<Mandate[]>;
}

export interface EvidenceQuery {
  verdict?: Verdict;
  action?: string;
  counterparty?: string;
  actor?: string;
  rootMandateId?: string;
  currency?: Money["currency"];
  minAmount?: number;
  maxAmount?: number;
  from?: string;
  to?: string;
  limit: number;
  /** `<evaluatedAt>|<packId>`, the exact pair the ordering uses, so a page boundary cannot drift. */
  cursor?: string;
}

/** What was already decided, copied from the stored decision. Nothing here is recomputed. */
export interface EvidenceSummary {
  packId: string;
  rootMandateId: string;
  verdict: Verdict;
  evaluatedAt: string;
  action: string;
  resource: string;
  counterparty: string;
  actor: string;
  reason: string;
  amount?: Money;
}

export interface EvidencePage {
  results: EvidenceSummary[];
  nextCursor?: string;
}

export const EVIDENCE_PAGE_LIMIT = 100;

/** The pair the ordering uses. Encoding both is what keeps a page boundary stable under writes. */
export function encodeCursor(evaluatedAt: string, packId: string): string {
  return `${evaluatedAt}|${packId}`;
}

export function decodeCursor(cursor: string): { evaluatedAt: string; packId: string } | undefined {
  const separator = cursor.lastIndexOf("|");
  if (separator <= 0 || separator === cursor.length - 1) return undefined;
  return { evaluatedAt: cursor.slice(0, separator), packId: cursor.slice(separator + 1) };
}

export function summaryOf(pack: EvidencePack): EvidenceSummary {
  const amount = pack.request.amount;
  return {
    packId: pack.packId,
    rootMandateId: pack.authority.chain[0]!.id,
    verdict: pack.decision.verdict,
    evaluatedAt: pack.decision.evaluatedAt,
    action: pack.request.action,
    resource: pack.request.resource,
    counterparty: pack.request.counterparty,
    actor: pack.request.actor,
    reason: pack.decision.reason,
    ...(amount ? { amount } : {}),
  };
}

export function matchesQuery(summary: EvidenceSummary, query: EvidenceQuery): boolean {
  if (query.verdict && summary.verdict !== query.verdict) return false;
  if (query.action && summary.action !== query.action) return false;
  if (query.counterparty && summary.counterparty !== query.counterparty) return false;
  if (query.actor && summary.actor !== query.actor) return false;
  if (query.rootMandateId && summary.rootMandateId !== query.rootMandateId) return false;
  if (query.from && summary.evaluatedAt < query.from) return false;
  if (query.to && summary.evaluatedAt > query.to) return false;

  if (query.currency || query.minAmount !== undefined || query.maxAmount !== undefined) {
    const amount = summary.amount;
    if (!amount) return false;
    if (query.currency && amount.currency !== query.currency) return false;
    if (query.minAmount !== undefined && amount.minor < query.minAmount) return false;
    if (query.maxAmount !== undefined && amount.minor > query.maxAmount) return false;
  }

  return true;
}

export interface EvidenceRepository {
  save(pack: EvidencePack, organisationId: string): Promise<void>;
  findById(packId: string, scope: TenantScope): Promise<EvidencePack | undefined>;
  recent(limit: number, scope: TenantScope): Promise<EvidencePack[]>;
  search(query: EvidenceQuery, scope: TenantScope): Promise<EvidencePage>;
}

export interface LedgerRepository {
  append(record: Omit<LedgerEntry, "seq" | "prevDigest" | "digest">): Promise<LedgerEntry>;
  entries(): Promise<LedgerEntry[]>;
  /**
   * The chain is deployment-wide and deliberately carries no tenant column — splitting it per
   * organisation would fork the hash chain. So this takes refs the caller has already resolved
   * through a scoped repository, and never a tenant of its own.
   */
  entriesFor(refs: string[]): Promise<LedgerEntry[]>;
  head(): Promise<LedgerEntry | undefined>;
  count(): Promise<number>;
}

export type ReplayScope = "process" | "deployment";

export interface NonceStore {
  readonly scope: ReplayScope;
  claim(nonce: string): Promise<boolean>;
}

export interface DirectoryRepository {
  createOrganisation(organisation: Organisation): Promise<boolean>;
  findOrganisation(id: string): Promise<Organisation | undefined>;
  rememberAccount(account: Account): Promise<Account>;
  grant(membership: Membership): Promise<void>;
  withdraw(organisationId: string, accountId: string): Promise<boolean>;
  membership(organisationId: string, accountId: string): Promise<Membership | undefined>;
  membershipsFor(accountId: string): Promise<Membership[]>;
  members(organisationId: string): Promise<MemberSummary[]>;
  // The ceiling above every mandate this organisation issues. Stored beside the organisation and
  // never on it, because that row is copied verbatim into each signed mandate.
  setHouseScope(organisationId: string, scope: Scope | null, at: string): Promise<void>;
  houseScope(organisationId: string): Promise<Scope | undefined>;
}

export interface RegisteredAgent {
  id: string;
  organisationId: string;
  name: string;
  runtime: string;
  status: AgentStatus;
  registeredAt: string;
  statusChangedAt: string;
  statusReason?: string;
}

export interface AgentKey {
  keyId: string;
  agentId: string;
  publicKeyJwk: TrustRoot["publicKeyJwk"];
  signingFrom: string;
  signingUntil?: string;
}

export interface AgentRepository {
  register(agent: RegisteredAgent, key: AgentKey): Promise<boolean>;
  findById(id: string, scope: TenantScope): Promise<RegisteredAgent | undefined>;
  findByKeyId(keyId: string): Promise<RegisteredAgent | undefined>;
  list(scope: TenantScope): Promise<RegisteredAgent[]>;
  setStatus(
    id: string,
    status: AgentStatus,
    changedAt: string,
    reason: string | undefined,
    scope: TenantScope,
  ): Promise<boolean>;
  currentKey(agentId: string): Promise<AgentKey | undefined>;
  keysFor(organisationId: string): Promise<AgentKey[]>;
  rotate(agentId: string, replacement: AgentKey, retiredAt: string): Promise<boolean>;
}

export type CapabilityStatus = "active" | "deprecated" | "withdrawn";

export type CatalogueEnforcement = "advisory" | "required";

export interface Capability {
  id: string;
  organisationId: string;
  title: string;
  description: string;
  risk: RiskLevel;
  amount: "required" | "optional" | "forbidden";
  currencies?: Money["currency"][];
  approvalAbove?: Money;
  status: CapabilityStatus;
  registeredAt: string;
  statusChangedAt: string;
}

export interface CatalogueState {
  enforcement: CatalogueEnforcement;
  size: number;
}

export interface CapabilityRepository {
  register(capability: Capability): Promise<boolean>;
  // Organisation-scoped by construction, not by filter. A capability id is unique only within an
  // organisation, so a nullable scope here would let one tenant's catalogue answer for another's.
  find(id: string, organisationId: string): Promise<Capability | undefined>;
  list(scope: TenantScope): Promise<Capability[]>;
  setStatus(
    id: string,
    status: CapabilityStatus,
    changedAt: string,
    organisationId: string,
  ): Promise<boolean>;
  catalogue(organisationId: string): Promise<CatalogueState>;
  setEnforcement(
    organisationId: string,
    enforcement: CatalogueEnforcement,
    changedAt: string,
  ): Promise<void>;
}

export type PendingStatus = "pending" | "resumed" | "expired";

export interface PendingAction {
  id: string;
  organisationId: string;
  mandateId: string;
  requestDigest: string;
  request: ActionRequest;
  reason: string;
  packId?: string;
  status: PendingStatus;
  createdAt: string;
  expiresAt: string;
  resolvedAt?: string;
}

export interface PendingActionRepository {
  park(action: PendingAction): Promise<void>;
  find(id: string, scope: TenantScope): Promise<PendingAction | undefined>;
  open(scope: TenantScope): Promise<PendingAction[]>;
  /**
   * Moves one parked action out of `pending` and reports whether this caller is the one that moved
   * it. A conditional update rather than a read-then-write, because two resumes racing must not both
   * win: the parked row holds the nonce claim, so winning it twice would be a double spend.
   */
  claim(id: string, to: Exclude<PendingStatus, "pending">, at: string, scope: TenantScope): Promise<boolean>;
}

export interface Repositories {
  mandates: MandateRepository;
  evidence: EvidenceRepository;
  ledger: LedgerRepository;
  nonces: NonceStore;
  directory: DirectoryRepository;
  agents: AgentRepository;
  capabilities: CapabilityRepository;
  pending: PendingActionRepository;
}
