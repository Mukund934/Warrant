import type { EvidencePack, LedgerEntry, Mandate } from "@warrant/core";

export interface RevocationRecord {
  mandateId: string;
  revokedAt: string;
  reason: string;
}

export interface MandateRepository {
  save(mandate: Mandate): Promise<void>;
  findById(id: string): Promise<Mandate | undefined>;
  findChain(leafId: string): Promise<Mandate[] | undefined>;
  revoke(record: RevocationRecord): Promise<boolean>;
  revocations(): Promise<RevocationRecord[]>;
}

export interface EvidenceRepository {
  save(pack: EvidencePack): Promise<void>;
  findById(packId: string): Promise<EvidencePack | undefined>;
  recent(limit: number): Promise<EvidencePack[]>;
}

export interface LedgerRepository {
  append(record: Omit<LedgerEntry, "seq" | "prevDigest" | "digest">): Promise<LedgerEntry>;
  entries(): Promise<LedgerEntry[]>;
}

export type ReplayScope = "process" | "deployment";

export interface NonceStore {
  readonly scope: ReplayScope;
  claim(nonce: string): Promise<boolean>;
}

export interface Repositories {
  mandates: MandateRepository;
  evidence: EvidenceRepository;
  ledger: LedgerRepository;
  nonces: NonceStore;
}
