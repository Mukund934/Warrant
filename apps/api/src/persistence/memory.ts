import { GENESIS_DIGEST, ledgerEntryDigest } from "@warrant/core";
import type { EvidencePack, LedgerEntry, Mandate } from "@warrant/core";
import type {
  EvidenceRepository,
  LedgerRepository,
  MandateRepository,
  NonceStore,
  Repositories,
  RevocationRecord,
} from "./types.js";

const MAX_CHAIN_DEPTH = 16;

export class InMemoryMandateRepository implements MandateRepository {
  private readonly rows = new Map<string, Mandate>();
  private readonly withdrawn = new Map<string, RevocationRecord>();

  async save(mandate: Mandate): Promise<void> {
    this.rows.set(mandate.id, mandate);
  }

  async revoke(record: RevocationRecord): Promise<boolean> {
    if (!this.rows.has(record.mandateId) || this.withdrawn.has(record.mandateId)) return false;
    this.withdrawn.set(record.mandateId, record);
    return true;
  }

  async revocations(): Promise<RevocationRecord[]> {
    return [...this.withdrawn.values()];
  }

  async findById(id: string): Promise<Mandate | undefined> {
    return this.rows.get(id);
  }

  async findChain(leafId: string): Promise<Mandate[] | undefined> {
    const chain: Mandate[] = [];
    let cursor = this.rows.get(leafId);
    while (cursor) {
      chain.unshift(cursor);
      if (chain.length > MAX_CHAIN_DEPTH) return undefined;
      if (!cursor.parent) return chain;
      cursor = this.rows.get(cursor.parent.id);
    }
    return undefined;
  }
}

export class InMemoryEvidenceRepository implements EvidenceRepository {
  private readonly rows = new Map<string, EvidencePack>();
  private readonly order: string[] = [];

  async save(pack: EvidencePack): Promise<void> {
    if (!this.rows.has(pack.packId)) this.order.push(pack.packId);
    this.rows.set(pack.packId, pack);
  }

  async findById(packId: string): Promise<EvidencePack | undefined> {
    return this.rows.get(packId);
  }

  async recent(limit: number): Promise<EvidencePack[]> {
    return this.order
      .slice(-limit)
      .reverse()
      .map((id) => this.rows.get(id))
      .filter((pack): pack is EvidencePack => pack !== undefined);
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

export function createInMemoryRepositories(): Repositories {
  return {
    mandates: new InMemoryMandateRepository(),
    evidence: new InMemoryEvidenceRepository(),
    ledger: new InMemoryLedgerRepository(),
    nonces: new InMemoryNonceStore(),
  };
}
