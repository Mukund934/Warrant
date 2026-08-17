import { canonicalBytes } from "./canonical.js";
import { leafHashOf } from "./transparency.js";
import type { Checkpoint, InclusionProof, TransparencyAnchor } from "./transparency.js";

export interface AnchorRequest {
  leafHash: string;
  checkpoint: Checkpoint;
}

export interface TransparencyLog {
  readonly name: string;
  submit(request: AnchorRequest, signal: AbortSignal): Promise<TransparencyAnchor>;
}

export type AnchorOutcome =
  | { anchored: true; anchor: TransparencyAnchor }
  | { anchored: false; reason: string };

export interface AnchorOptions {
  timeoutMs?: number;
}

export async function leafHashForCheckpoint(checkpoint: Checkpoint): Promise<string> {
  return leafHashOf(canonicalBytes(checkpoint));
}

function looksLikeInclusion(value: unknown): value is InclusionProof {
  const proof = value as Partial<InclusionProof> | null;
  return (
    !!proof &&
    typeof proof === "object" &&
    Number.isInteger(proof.logIndex) &&
    Number.isInteger(proof.treeSize) &&
    typeof proof.leafHash === "string" &&
    typeof proof.rootHash === "string" &&
    Array.isArray(proof.hashes) &&
    proof.hashes.every((hash) => typeof hash === "string")
  );
}

export async function anchorCheckpoint(
  checkpoint: Checkpoint,
  log: TransparencyLog,
  options: AnchorOptions = {},
): Promise<AnchorOutcome> {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 10_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const leafHash = await leafHashForCheckpoint(checkpoint);
    const anchor = await log.submit({ leafHash, checkpoint }, controller.signal);

    if (!anchor || !looksLikeInclusion(anchor.inclusion)) {
      return { anchored: false, reason: `${log.name} returned a response without a usable inclusion proof` };
    }
    if (anchor.inclusion.leafHash !== leafHash) {
      return {
        anchored: false,
        reason: `${log.name} returned an inclusion proof for a different entry than the one submitted`,
      };
    }
    return { anchored: true, anchor };
  } catch (error) {
    const reason =
      (error as Error)?.name === "AbortError"
        ? `${log.name} did not respond within ${timeoutMs}ms`
        : `${log.name} could not be reached: ${(error as Error).message}`;
    return { anchored: false, reason };
  } finally {
    clearTimeout(timer);
  }
}
