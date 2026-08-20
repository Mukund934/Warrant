import { signActionRequest } from "./action.js";
import { assess } from "./gate.js";
import type { AssessmentContext } from "./gate.js";
import { createKeyPair } from "./keys.js";
import { signerFromJwk } from "./sign.js";
import type { Check, Mandate, Money, Scope, TrustRoot, Verdict } from "./types.js";

export interface HypotheticalAction {
  action: string;
  resource: string;
  counterparty: string;
  description?: string;
  amount?: Money;
}

export interface Simulation {
  /** Present so a simulation can never be mistaken for a `Decision`, which has no such field. */
  simulated: true;
  verdict: Verdict;
  reason: string;
  checks: Check[];
  effectiveScope: Scope;
  assumptions: string[];
}

const ASSUMED_SIGNATURE =
  "assumed for this simulation. Nothing was signed and nothing was proved here; a real request must " +
  "be signed by the acting agent with the key its mandate names";

/**
 * What the gate *would* say, recording nothing.
 *
 * The hypothetical is signed with a throwaway key that exists only inside this call, and that key is
 * offered as a trust root for the same one call. That is deliberate: it lets the real `assess` run
 * with **no special case whatsoever** — no simulation flag reaches the gate, so nothing here can ever
 * weaken a real decision. The price is that possession and signature are assumed rather than proved,
 * which is what `assumptions` and the rewritten check details say plainly.
 *
 * The result carries no id, no proof and no signature. It cannot be recorded, and
 * `evidencePackSchema` rejects it.
 */
export async function simulate(
  hypothetical: HypotheticalAction,
  chain: Mandate[],
  context: AssessmentContext,
): Promise<Simulation> {
  const leaf = chain[chain.length - 1];
  const at = context.inputs.evaluatedAt;

  if (!leaf) {
    const assessment = await assess(
      await unsignedRequest(hypothetical, "simulation:no-subject", at),
      chain,
      context,
    );
    return {
      simulated: true,
      verdict: assessment.verdict,
      reason: assessment.reason,
      checks: assessment.checks,
      effectiveScope: assessment.effectiveScope,
      assumptions: [],
    };
  }

  const ephemeral = await createKeyPair(leaf.subject.name, "agent");
  const request = await signActionRequest(
    {
      id: "simulation",
      nonce: "simulation-nonce",
      actor: leaf.subject.id,
      action: hypothetical.action,
      resource: hypothetical.resource,
      counterparty: hypothetical.counterparty,
      description: hypothetical.description ?? "a hypothetical action, never presented",
      requestedAt: at,
      ...(hypothetical.amount ? { amount: hypothetical.amount } : {}),
    },
    signerFromJwk(leaf.subject.keyId, ephemeral.privateKeyJwk),
  );

  const standIn: TrustRoot = {
    keyId: leaf.subject.keyId,
    subject: leaf.subject.name,
    role: "agent",
    publicKeyJwk: ephemeral.publicKeyJwk,
    signingFrom: leaf.notBefore,
  };

  const assessment = await assess(request, chain, {
    ...context,
    // The stand-in replaces the agent's real key for this call only; `findTrustRoot` takes the first
    // match, so it must come first.
    trustRoots: [standIn, ...context.trustRoots],
    inputs: { ...context.inputs, replayStatus: "unchecked" },
  });

  const assumed = new Set(["request.signature", "actor.possession"]);
  const checks = assessment.checks.map((check) =>
    assumed.has(check.id) ? { ...check, detail: ASSUMED_SIGNATURE } : check,
  );

  return {
    simulated: true,
    verdict: assessment.verdict,
    reason: assessment.reason,
    checks,
    effectiveScope: assessment.effectiveScope,
    assumptions: [
      `${leaf.subject.name} signed this request with ${leaf.subject.keyId}`,
      "the request nonce had never been used, so replay was not checked",
    ],
  };
}

async function unsignedRequest(hypothetical: HypotheticalAction, actor: string, at: string) {
  const ephemeral = await createKeyPair("simulation", "agent");
  return signActionRequest(
    {
      id: "simulation",
      nonce: "simulation-nonce",
      actor,
      action: hypothetical.action,
      resource: hypothetical.resource,
      counterparty: hypothetical.counterparty,
      description: hypothetical.description ?? "a hypothetical action, never presented",
      requestedAt: at,
      ...(hypothetical.amount ? { amount: hypothetical.amount } : {}),
    },
    signerFromJwk(ephemeral.keyId, ephemeral.privateKeyJwk),
  );
}
