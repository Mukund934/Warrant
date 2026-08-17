import { canonicalBytes, decodeBase64Url, encodeBase64Url } from "./canonical.js";
import { signDetached, verifyDetached } from "./sign.js";
import type { SignerIdentity } from "./sign.js";
import type { PublicKeyJwk } from "./keys.js";
import { WarrantError } from "./types.js";
import type { Proof, SignedHead } from "./types.js";

export const CHECKPOINT_VERSION = "warrant/checkpoint/v0.1";

const LEAF_PREFIX = 0x00;
const NODE_PREFIX = 0x01;

export interface CheckpointBody {
  version: typeof CHECKPOINT_VERSION;
  origin: string;
  treeSize: number;
  ledgerDigest: string;
  headSeq: number;
  takenAt: string;
}

export interface Checkpoint extends CheckpointBody {
  proof: Proof;
}

export interface InclusionProof {
  logIndex: number;
  treeSize: number;
  leafHash: string;
  rootHash: string;
  hashes: string[];
}

export interface TransparencyAnchor {
  log: string;
  submittedAt: string;
  entryUri?: string;
  inclusion: InclusionProof;
}

async function digest(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes)));
}

function concat(prefix: number, left: Uint8Array, right?: Uint8Array): Uint8Array {
  const size = 1 + left.length + (right?.length ?? 0);
  const out = new Uint8Array(size);
  out[0] = prefix;
  out.set(left, 1);
  if (right) out.set(right, 1 + left.length);
  return out;
}

export async function leafHashOf(entry: Uint8Array): Promise<string> {
  return encodeBase64Url(await digest(concat(LEAF_PREFIX, entry)));
}

export async function nodeHashOf(left: Uint8Array, right: Uint8Array): Promise<string> {
  return encodeBase64Url(await digest(concat(NODE_PREFIX, left, right)));
}

export async function checkpointFor(
  head: SignedHead,
  origin: string,
  takenAt: string,
  signer: SignerIdentity,
): Promise<Checkpoint> {
  const body: CheckpointBody = {
    version: CHECKPOINT_VERSION,
    origin,
    treeSize: head.entryCount,
    ledgerDigest: head.digest,
    headSeq: head.seq,
    takenAt,
  };
  return { ...body, proof: await signDetached(body, signer, takenAt) };
}

export async function verifyCheckpoint(
  checkpoint: Checkpoint,
  publicKeyJwk: PublicKeyJwk,
): Promise<{ valid: boolean; reason?: string }> {
  const { proof, ...body } = checkpoint;
  if (body.version !== CHECKPOINT_VERSION) {
    return { valid: false, reason: `unexpected checkpoint version \`${String(body.version)}\`` };
  }
  return verifyDetached(body, proof, publicKeyJwk);
}

export async function recomputeRoot(proof: InclusionProof): Promise<string> {
  if (proof.treeSize <= 0) {
    throw new WarrantError("transparency/empty_tree", "an inclusion proof needs a tree size above zero");
  }
  if (proof.logIndex < 0 || proof.logIndex >= proof.treeSize) {
    throw new WarrantError(
      "transparency/index_out_of_range",
      `log index ${proof.logIndex} is not inside a tree of ${proof.treeSize} entries`,
    );
  }

  let fn = proof.logIndex;
  let sn = proof.treeSize - 1;
  let hash = decodeBase64Url(proof.leafHash);

  for (const sibling of proof.hashes) {
    if (sn === 0) {
      throw new WarrantError(
        "transparency/proof_too_long",
        "the inclusion proof carries more hashes than the tree size allows",
      );
    }
    const node = decodeBase64Url(sibling);
    if (fn % 2 === 1 || fn === sn) {
      hash = decodeBase64Url(await nodeHashOf(node, hash));
      while (fn % 2 === 0 && fn !== 0) {
        fn = Math.floor(fn / 2);
        sn = Math.floor(sn / 2);
      }
    } else {
      hash = decodeBase64Url(await nodeHashOf(hash, node));
    }
    fn = Math.floor(fn / 2);
    sn = Math.floor(sn / 2);
  }

  if (sn !== 0) {
    throw new WarrantError(
      "transparency/proof_too_short",
      "the inclusion proof does not carry enough hashes to reach the root",
    );
  }
  return encodeBase64Url(hash);
}

export async function verifyInclusion(
  proof: InclusionProof,
): Promise<{ valid: boolean; reason?: string }> {
  let computed: string;
  try {
    computed = await recomputeRoot(proof);
  } catch (error) {
    return { valid: false, reason: (error as Error).message };
  }
  if (computed !== proof.rootHash) {
    return {
      valid: false,
      reason: `the inclusion proof does not reach the stated root: expected ${proof.rootHash}, recomputed ${computed}`,
    };
  }
  return { valid: true };
}

export async function verifyAnchor(
  checkpoint: Checkpoint,
  anchor: TransparencyAnchor,
  publicKeyJwk: PublicKeyJwk,
): Promise<{ valid: boolean; reason?: string }> {
  const signature = await verifyCheckpoint(checkpoint, publicKeyJwk);
  if (!signature.valid) return signature;

  const expected = await leafHashOf(canonicalBytes({ ...checkpoint, proof: checkpoint.proof }));
  if (anchor.inclusion.leafHash !== expected) {
    return {
      valid: false,
      reason: "the anchored leaf is not this checkpoint",
    };
  }
  return verifyInclusion(anchor.inclusion);
}
