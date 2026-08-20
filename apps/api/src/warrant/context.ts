import {
  apAgent,
  apAgentKey,
  demoKeys,
  gateKey,
  ledgerKey,
  organisation,
  paymentAgent,
  principalKey,
  priyaSharma,
  trustRoots,
} from "@warrant/core/fixtures";
import { signerFromJwk } from "@warrant/core";
import type { GateIdentity, SignerIdentity } from "@warrant/core";

const signerOf = (key: (typeof demoKeys)[number]): SignerIdentity =>
  signerFromJwk(key.keyId, key.privateKeyJwk);

const keyring = new Map<string, SignerIdentity>(
  demoKeys.map((key) => [key.keyId, signerOf(key)]),
);

export function signerForKeyId(keyId: string): SignerIdentity | undefined {
  return keyring.get(keyId);
}

export const principalSigner = signerOf(principalKey);
export const apAgentSigner = signerOf(apAgentKey);
export const recorder = signerOf(ledgerKey);
export const gate: GateIdentity = { id: "gate:meridian-sandbox", signer: signerOf(gateKey) };

export { apAgent, organisation, paymentAgent, priyaSharma, trustRoots };

export const ESCALATION_THRESHOLD = { currency: "INR" as const, minor: 45_000_000 };
export const REQUEST_FRESHNESS = { maxAgeSeconds: 300, clockSkewSeconds: 30 };

// A parked action waits for a person, and people take longer than five minutes. This wider window is
// used ONLY for a decision resumed from a pending action, and it is written into that decision's
// signed inputs, so an offline verifier reproduces the verdict against the window that was actually
// applied. Widening REQUEST_FRESHNESS instead would have weakened every live action to suit one
// workflow.
export const PENDING_FRESHNESS = { maxAgeSeconds: 86_400, clockSkewSeconds: 30 };
export const CHECKPOINT_ORIGIN = "warrant/meridian-sandbox";

export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

export function identifier(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}
