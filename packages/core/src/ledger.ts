import { digestOf } from "./canonical.js";
import { findTrustRoot, verifyAgainstTrustRoot } from "./chain.js";
import { signDetached, verifyDetached } from "./sign.js";
import type { SignerIdentity } from "./sign.js";
import { WarrantError } from "./types.js";
import type { Check, LedgerEntry, SignedHead, TrustRoot } from "./types.js";

export const GENESIS_DIGEST = "warrant/ledger/v0.1/genesis";

export type LedgerEntryType = LedgerEntry["type"];

export async function ledgerEntryDigest(entry: Omit<LedgerEntry, "digest">): Promise<string> {
  return digestOf(entry);
}

const entryDigest = ledgerEntryDigest;

export class Ledger {
  private readonly entries: LedgerEntry[] = [];

  get all(): LedgerEntry[] {
    return [...this.entries];
  }

  get head(): LedgerEntry | undefined {
    return this.entries[this.entries.length - 1];
  }

  async append(
    type: LedgerEntryType,
    ref: string,
    payload: unknown,
    recordedAt: string,
  ): Promise<LedgerEntry> {
    const previous = this.head;
    const body: Omit<LedgerEntry, "digest"> = {
      seq: this.entries.length,
      prevDigest: previous ? previous.digest : GENESIS_DIGEST,
      type,
      recordedAt,
      ref,
      payloadDigest: await digestOf(payload),
    };
    const entry: LedgerEntry = { ...body, digest: await entryDigest(body) };
    this.entries.push(entry);
    return entry;
  }

  async signHead(signer: SignerIdentity, signedAt: string): Promise<SignedHead> {
    const head = this.head;
    if (!head) {
      throw new WarrantError("ledger/empty", "an empty ledger has no head to sign");
    }
    const unsigned = {
      seq: head.seq,
      digest: head.digest,
      entryCount: this.entries.length,
      signedAt,
    };
    const proof = await signDetached(unsigned, signer, signedAt);
    return { ...unsigned, proof };
  }
}

export async function verifyLedgerSegment(
  entries: LedgerEntry[],
  head: SignedHead,
  trustRoots: TrustRoot[],
): Promise<Check[]> {
  const checks: Check[] = [];

  let continuous = true;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) continue;
    const previous = entries[index - 1];
    const expectedPrev = previous ? previous.digest : entry.seq === 0 ? GENESIS_DIGEST : entry.prevDigest;

    if (previous && entry.seq !== previous.seq + 1) {
      continuous = false;
      checks.push({
        id: "ledger.continuity",
        title: "The evidence ledger has no gaps or rewrites",
        status: "fail",
        detail: `entry ${entry.seq} does not follow entry ${previous.seq}`,
        expected: `sequence ${previous.seq + 1}`,
        observed: `sequence ${entry.seq}`,
      });
      continue;
    }

    if (entry.prevDigest !== expectedPrev) {
      continuous = false;
      checks.push({
        id: "ledger.continuity",
        title: "The evidence ledger has no gaps or rewrites",
        status: "fail",
        detail: `entry ${entry.seq} does not chain to the entry before it`,
        expected: expectedPrev,
        observed: entry.prevDigest,
      });
      continue;
    }

    const { digest, ...body } = entry;
    const recomputed = await entryDigest(body);
    if (recomputed !== digest) {
      continuous = false;
      checks.push({
        id: "ledger.continuity",
        title: "The evidence ledger has no gaps or rewrites",
        status: "fail",
        detail: `entry ${entry.seq} was altered after it was recorded`,
        expected: recomputed,
        observed: digest,
      });
    }
  }

  if (continuous) {
    checks.push({
      id: "ledger.continuity",
      title: "The evidence ledger has no gaps or rewrites",
      status: "pass",
      detail: `${entries.length} hash-chained entries recomputed from the genesis marker`,
    });
  }

  const last = entries[entries.length - 1];
  if (!last || last.digest !== head.digest || last.seq !== head.seq) {
    checks.push({
      id: "ledger.head",
      title: "The signed ledger head covers these entries",
      status: "fail",
      detail: "the signed head does not describe the entries supplied with this pack",
      expected: head.digest,
      observed: last ? last.digest : "no entries",
    });
  } else {
    checks.push({
      id: "ledger.head",
      title: "The signed ledger head covers these entries",
      status: "pass",
      detail: `head at sequence ${head.seq}, ${head.entryCount} entries recorded`,
    });
  }

  const trustRoot = findTrustRoot(trustRoots, head.proof.verificationMethod);
  if (!trustRoot) {
    checks.push({
      id: "ledger.head_signature",
      title: "The ledger head is signed by the recording service",
      status: "fail",
      detail: `no public key is known for ${head.proof.verificationMethod}`,
    });
  } else {
    const { proof, ...unsigned } = head;
    const outcome = await verifyAgainstTrustRoot(unsigned, proof, trustRoot);
    checks.push(
      outcome.valid
        ? {
            id: "ledger.head_signature",
            title: "The ledger head is signed by the recording service",
            status: "pass",
            detail: `signed by ${trustRoot.subject} at ${head.signedAt}`,
          }
        : {
            id: "ledger.head_signature",
            title: "The ledger head is signed by the recording service",
            status: "fail",
            detail: outcome.reason ?? "the ledger head signature is invalid",
          },
    );
  }

  return checks;
}
