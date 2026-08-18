import type { AgentStatus, EvidencePack, LedgerEntry, Mandate, TrustRoot } from "@warrant/core";

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
}

export interface EvidenceRepository {
  save(pack: EvidencePack, organisationId: string): Promise<void>;
  findById(packId: string, scope: TenantScope): Promise<EvidencePack | undefined>;
  recent(limit: number, scope: TenantScope): Promise<EvidencePack[]>;
}

export interface LedgerRepository {
  append(record: Omit<LedgerEntry, "seq" | "prevDigest" | "digest">): Promise<LedgerEntry>;
  entries(): Promise<LedgerEntry[]>;
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

export interface Repositories {
  mandates: MandateRepository;
  evidence: EvidenceRepository;
  ledger: LedgerRepository;
  nonces: NonceStore;
  directory: DirectoryRepository;
  agents: AgentRepository;
}
