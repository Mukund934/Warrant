import {
  buildEvidencePack,
  checkpointFor,
  digestOf,
  evaluate,
  signActionRequest,
  signDetached,
  simulate,
} from "@warrant/core";
import type { AssessmentContext, Simulation, SignerIdentity } from "@warrant/core";
import type {
  ActionRequest,
  Approval,
  Checkpoint,
  Decision,
  EvidencePack,
  LedgerEntry,
  Mandate,
  Money,
  RevocationSnapshot,
  SignedHead,
} from "@warrant/core";
import { notFound, unprocessable } from "../http/errors.js";
import type { Repositories, TenantScope } from "../persistence/types.js";
import { agentStatusFor, trustRootsFor } from "./agents.js";
import { resolveCapability } from "./capabilities.js";
import { parkAction } from "./pending.js";
import { DEMONSTRATION_ACTOR } from "./issuance.js";
import type { Actor } from "./issuance.js";
import {
  ESCALATION_THRESHOLD,
  PENDING_FRESHNESS,
  identifier,
  CHECKPOINT_ORIGIN,
  REQUEST_FRESHNESS,
  nowIso,
  signerForKeyId,
} from "../warrant/context.js";

export interface SubmitActionInput {
  mandateId: string;
  action: string;
  resource: string;
  counterparty: string;
  description: string;
  nonce: string;
  amount?: Money;
}

export interface SubmitActionResult {
  decision: Decision;
  pack: EvidencePack;
}

/**
 * Both `2026-01-01T00:00:00Z` and `2026-01-01T00:00:00.000Z` are valid here and are the same moment,
 * but they sort in the wrong order as strings. Every comparison of two timestamps goes through this.
 */
export function instant(iso: string): number {
  return new Date(iso).getTime();
}

async function revocationSnapshot(
  repositories: Repositories,
  scope: TenantScope,
  asOf: string,
  recorder: SignerIdentity,
): Promise<RevocationSnapshot> {
  const withdrawn = await repositories.mandates.revocations(scope);
  const body = {
    asOf,
    // A mandate withdrawn after the moment being judged was still live at that moment. On the live
    // path `asOf` is now and this removes nothing.
    revoked: withdrawn.filter((record) => instant(record.revokedAt) <= instant(asOf)),
  };
  return { ...body, proof: await signDetached(body, recorder, body.asOf) };
}

async function priorSpendFor(
  rootMandateId: string,
  currency: Money["currency"],
  windowDays: number,
  at: string,
  repositories: Repositories,
  scope: TenantScope,
): Promise<Money | undefined> {
  const until = new Date(at).getTime();
  const since = until - windowDays * 24 * 60 * 60 * 1000;
  const packs = await repositories.evidence.recent(500, scope);

  let total = 0;
  for (const pack of packs) {
    if (pack.decision.verdict !== "ALLOW") continue;
    if (pack.authority.chain[0]?.id !== rootMandateId) continue;
    const spentAt = new Date(pack.decision.evaluatedAt).getTime();
    if (spentAt < since) continue;
    // Spend recorded after the moment being judged had not happened yet. Nothing is after `now`.
    if (spentAt > until) continue;
    const amount = pack.request.amount;
    if (!amount || amount.currency !== currency) continue;
    total += amount.minor;
  }

  return total > 0 ? { currency, minor: total } : undefined;
}

async function signSegment(
  entries: LedgerEntry[],
  totalEntries: number,
  signedAt: string,
  recorder: SignerIdentity,
): Promise<SignedHead> {
  const last = entries[entries.length - 1]!;
  const unsigned = {
    seq: last.seq,
    digest: last.digest,
    entryCount: totalEntries,
    signedAt,
  };
  return { ...unsigned, proof: await signDetached(unsigned, recorder, signedAt) };
}

export async function takeCheckpoint(
  repositories: Repositories,
  actor: Actor = DEMONSTRATION_ACTOR,
): Promise<Checkpoint> {
  const latest = await repositories.ledger.head();
  if (!latest) {
    throw unprocessable("ledger_empty", "there is nothing to commit to yet");
  }
  const takenAt = nowIso();
  const recorder = actor.keyring.recorder;
  const head = await signSegment([latest], await repositories.ledger.count(), takenAt, recorder);
  return checkpointFor(head, CHECKPOINT_ORIGIN, takenAt, recorder);
}

export async function submitAction(
  input: SubmitActionInput,
  repositories: Repositories,
  actor: Actor = DEMONSTRATION_ACTOR,
): Promise<SubmitActionResult> {
  const chain = await repositories.mandates.findChain(input.mandateId, actor.scope);
  if (!chain || chain.length === 0) {
    throw notFound(`no mandate chain could be resolved for ${input.mandateId}`);
  }

  const leaf = chain[chain.length - 1]!;
  const signer = signerForKeyId(leaf.subject.keyId);
  if (!signer) {
    throw unprocessable(
      "agent_key_unavailable",
      `this deployment holds no signing key for ${leaf.subject.name}. Sign the request with that agent's own key and present it to /v1/actions/signed`,
    );
  }

  const evaluatedAt = nowIso();
  const request: ActionRequest = await signActionRequest(
    {
      id: identifier("req"),
      nonce: input.nonce,
      actor: leaf.subject.id,
      action: input.action,
      resource: input.resource,
      counterparty: input.counterparty,
      description: input.description,
      requestedAt: evaluatedAt,
      ...(input.amount ? { amount: input.amount } : {}),
    },
    signer,
  );

  return recordAction(request, chain, evaluatedAt, repositories, actor);
}

export interface PresentedActionInput {
  mandateId: string;
  request: ActionRequest;
  approval?: Approval;
}

export async function submitSignedAction(
  input: PresentedActionInput,
  repositories: Repositories,
  actor: Actor = DEMONSTRATION_ACTOR,
): Promise<SubmitActionResult> {
  const chain = await repositories.mandates.findChain(input.mandateId, actor.scope);
  if (!chain || chain.length === 0) {
    throw notFound(`no mandate chain could be resolved for ${input.mandateId}`);
  }

  return recordAction(input.request, chain, nowIso(), repositories, actor, input.approval);
}

/**
 * Everything the gate is allowed to see. Extracted so that a simulation is judged against the same
 * catalogue, the same ceiling, the same revocation snapshot and the same spend as a real action —
 * a simulator assembling its own context would eventually predict something the gate would not do.
 */
export async function gateContext(
  chain: Mandate[],
  evaluatedAt: string,
  repositories: Repositories,
  actor: Actor,
  replayStatus: "fresh" | "replayed" | "unchecked",
  action: string,
  freshness: { maxAgeSeconds: number; clockSkewSeconds: number } = REQUEST_FRESHNESS,
): Promise<AssessmentContext> {
  const leaf = chain[chain.length - 1]!;
  const organisationId = chain[0]!.organisation.id;

  const [revocation, roots, agentStatus, capability, houseScope] = await Promise.all([
    revocationSnapshot(repositories, actor.scope, evaluatedAt, actor.keyring.recorder),
    trustRootsFor(repositories, actor.scope),
    agentStatusFor(repositories, leaf.subject.keyId),
    resolveCapability(repositories, organisationId, action),
    repositories.directory.houseScope(organisationId),
  ]);

  const perPeriod = leaf.scope.limits.perPeriod;
  const priorSpend = perPeriod
    ? await priorSpendFor(
        chain[0]!.id,
        perPeriod.amount.currency,
        perPeriod.days,
        evaluatedAt,
        repositories,
        actor.scope,
      )
    : undefined;

  return {
    trustRoots: roots,
    revocation,
    inputs: {
      evaluatedAt,
      replayStatus,
      freshness,
      escalationThreshold: ESCALATION_THRESHOLD,
      ...(agentStatus ? { agentStatus } : {}),
      ...(capability ? { capability } : {}),
      ...(houseScope ? { houseScope } : {}),
      ...(priorSpend ? { priorSpend } : {}),
    },
  };
}

export interface SimulateInput {
  mandateId: string;
  action: string;
  resource: string;
  counterparty: string;
  description?: string;
  amount?: Money;
}

/**
 * Answers what the gate would say, and records nothing at all: no nonce is claimed, no ledger entry
 * is appended, no evidence is saved. The context comes from `gateContext`, the same function a real
 * action uses, so a prediction cannot quietly drift from the decision it predicts.
 */
export async function simulateAction(
  input: SimulateInput,
  repositories: Repositories,
  actor: Actor = DEMONSTRATION_ACTOR,
): Promise<Simulation> {
  const chain = await repositories.mandates.findChain(input.mandateId, actor.scope);
  if (!chain || chain.length === 0) {
    throw notFound(`no mandate chain could be resolved for ${input.mandateId}`);
  }

  const context = await gateContext(
    chain,
    nowIso(),
    repositories,
    actor,
    "unchecked",
    input.action,
  );

  return simulate(
    {
      action: input.action,
      resource: input.resource,
      counterparty: input.counterparty,
      ...(input.description ? { description: input.description } : {}),
      ...(input.amount ? { amount: input.amount } : {}),
    },
    chain,
    context,
  );
}

async function recordAction(
  request: ActionRequest,
  chain: Mandate[],
  evaluatedAt: string,
  repositories: Repositories,
  actor: Actor,
  approval?: Approval,
): Promise<SubmitActionResult> {
  const fresh = await repositories.nonces.claim(request.nonce);
  return recordDecision(
    request,
    chain,
    evaluatedAt,
    repositories,
    actor,
    { replayStatus: fresh ? "fresh" : "replayed", freshness: REQUEST_FRESHNESS, park: true },
    approval,
  );
}

export interface DecisionMode {
  replayStatus: "fresh" | "replayed" | "unchecked";
  freshness: { maxAgeSeconds: number; clockSkewSeconds: number };
  /** A resumed action is never re-parked; its pending row is already resolved. */
  park: boolean;
}

export async function recordDecision(
  request: ActionRequest,
  chain: Mandate[],
  evaluatedAt: string,
  repositories: Repositories,
  actor: Actor,
  mode: DecisionMode,
  approval?: Approval,
): Promise<SubmitActionResult> {
  const context = await gateContext(
    chain,
    evaluatedAt,
    repositories,
    actor,
    mode.replayStatus,
    request.action,
    mode.freshness,
  );
  const roots = context.trustRoots;
  const revocation = context.revocation;

  // The organisation's own gate signs its own verdict. Before Phase 9 this was one key shared by
  // every tenant, which is what let one organisation's evidence verify under another's roots.
  const decision = await evaluate(
    request,
    chain,
    { ...context, ...(approval ? { approval } : {}) },
    actor.keyring.gate,
  );

  const requestEntry = await repositories.ledger.append({
    type: "action.requested",
    recordedAt: request.requestedAt,
    ref: request.id,
    payloadDigest: await digestOf(request),
  });
  const decisionEntry = await repositories.ledger.append({
    type: "decision.recorded",
    recordedAt: decision.evaluatedAt,
    ref: decision.id,
    payloadDigest: await digestOf(decision),
  });

  const total = await repositories.ledger.count();
  const segment = [requestEntry, decisionEntry];

  const pack = await buildEvidencePack(
    {
      packId: identifier("pack"),
      generatedAt: nowIso(),
      generatedBy: "Warrant demonstrator API, recording service for Meridian Technologies Pvt Ltd",
      request,
      chain,
      decision,
      ledger: {
        entries: segment,
        head: await signSegment(segment, total, nowIso(), actor.keyring.recorder),
      },
      revocation,
      ...(approval ? { approval } : {}),
      trustRoots: roots,
    },
    actor.keyring.recorder,
  );

  await repositories.evidence.save(pack, chain[0]!.organisation.id);

  // The nonce was claimed above, so from here the parked row holds that claim. Resuming it is the
  // continuation of this same request, not a second use of the nonce.
  if (mode.park && decision.verdict === "ESCALATE" && !approval) {
    await parkAction(request, chain, decision, pack.packId, repositories, evaluatedAt);
  }

  return { decision, pack };
}
