import { effectiveScope, simulate } from "@warrant/core";
import type { Mandate, Money, Scope, Simulation } from "@warrant/core";
import { badRequest, notFound } from "../http/errors.js";
import type { Repositories } from "../persistence/types.js";
import { gateContext, instant } from "./execution.js";
import type { Actor } from "./issuance.js";
import { nowIso } from "../warrant/context.js";

/** Tolerance for a caller whose clock runs a little fast. Beyond it, the instant is the future. */
const SKEW_SECONDS = 60;

export type Standing = "live" | "not-yet-issued" | "not-yet-valid" | "expired" | "revoked";

export interface HypotheticalAt {
  action: string;
  resource: string;
  counterparty: string;
  amount?: Money;
}

export interface ReconstructionInput {
  mandateId: string;
  at: string;
  hypothetical?: HypotheticalAt;
}

export interface ReconstructedHop {
  id: string;
  depth: number;
  issuer: string;
  subject: string;
  issuedAt: string;
  notBefore: string;
  expiresAt: string;
  revokedAt?: string;
}

export interface Reconstruction {
  /** Never a decision. There is no id, no proof and no gate, and nothing here can be recorded. */
  reconstructed: true;
  at: string;
  standing: Standing;
  chain: ReconstructedHop[];
  effectiveScope?: Scope;
  outcome?: Simulation;
  notHistorised: string[];
}

const hopOf = (mandate: Mandate, revokedAt?: string): ReconstructedHop => ({
  id: mandate.id,
  depth: mandate.depth,
  issuer: mandate.issuer.name,
  subject: mandate.subject.name,
  issuedAt: mandate.issuedAt,
  notBefore: mandate.notBefore,
  expiresAt: mandate.expiresAt,
  ...(revokedAt ? { revokedAt } : {}),
});

function standingOf(chain: Mandate[], at: string, revokedAt: Map<string, string>): Standing {
  const when = instant(at);
  for (const mandate of chain) {
    const withdrawn = revokedAt.get(mandate.id);
    if (withdrawn && instant(withdrawn) <= when) return "revoked";
  }
  for (const mandate of chain) {
    if (when < instant(mandate.notBefore)) return "not-yet-valid";
    if (when > instant(mandate.expiresAt)) return "expired";
  }
  return "live";
}

/**
 * The authority as it stood at a chosen instant, judged by the policy as it stands now.
 *
 * That split is the honest one and it is stated in the response. Mandates are signed documents with
 * their own timestamps, so the authority genuinely reconstructs. The capability catalogue, the house
 * ceiling and an agent's standing hold only their current value, so they cannot. Pretending
 * otherwise would make this feature answer confidently and wrongly, which is the one thing an
 * after-the-fact reconstruction must never do.
 */
export async function reconstruct(
  input: ReconstructionInput,
  repositories: Repositories,
  actor: Actor,
): Promise<Reconstruction> {
  const now = nowIso();
  if (instant(input.at) > instant(now) + SKEW_SECONDS * 1000) {
    throw badRequest(
      "instant_in_the_future",
      `this reconstruction is for ${input.at}, which has not happened yet; the latest answerable instant is ${now}`,
    );
  }

  const full = await repositories.mandates.findChain(input.mandateId, actor.scope);
  if (!full || full.length === 0) throw notFound(`no mandate with id ${input.mandateId}`);

  const revokedAt = new Map(
    (await repositories.mandates.revocations(actor.scope)).map((record) => [
      record.mandateId,
      record.revokedAt,
    ]),
  );

  // Nothing issued after the instant existed at it. A chain is issued root first, so this keeps a
  // prefix; losing the leaf means the authority being asked about had not been granted yet.
  const asItStood = full.filter((mandate) => instant(mandate.issuedAt) <= instant(input.at));
  const leaf = full[full.length - 1]!;

  if (asItStood.length === 0 || asItStood[asItStood.length - 1]!.id !== leaf.id) {
    return {
      reconstructed: true,
      at: input.at,
      standing: "not-yet-issued",
      chain: asItStood.map((mandate) => hopOf(mandate, revokedAt.get(mandate.id))),
      notHistorised: [],
    };
  }

  const standing = standingOf(asItStood, input.at, revokedAt);
  const chain = asItStood.map((mandate) => hopOf(mandate, revokedAt.get(mandate.id)));
  const scope = effectiveScope(asItStood.map((mandate) => mandate.scope));

  if (!input.hypothetical) {
    return { reconstructed: true, at: input.at, standing, chain, effectiveScope: scope, notHistorised: [] };
  }

  // The same context a real action gets, asked for a different instant. Revocation and recorded
  // spend are both anchored to `evaluatedAt`, so they answer for then rather than for now.
  const context = await gateContext(
    asItStood,
    input.at,
    repositories,
    actor,
    "unchecked",
    input.hypothetical.action,
  );

  const outcome = await simulate(input.hypothetical, asItStood, context);

  // Disclose only what actually bore on this answer. Listing a ceiling nobody set would be noise.
  const notHistorised: string[] = [];
  if (context.inputs.capability) {
    notHistorised.push(
      "the capability catalogue keeps no history, so this used the catalogue as it stands today, not as it stood then",
    );
  }
  if (context.inputs.houseScope) {
    notHistorised.push(
      "the house ceiling keeps no history, so this used the ceiling as it stands today, not as it stood then",
    );
  }
  if (context.inputs.agentStatus) {
    notHistorised.push(
      "an agent's standing keeps no history, so this used its standing today, not its standing then",
    );
  }

  return {
    reconstructed: true,
    at: input.at,
    standing,
    chain,
    effectiveScope: scope,
    outcome,
    notHistorised,
  };
}
