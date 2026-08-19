import {
  buildEvidencePack,
  checkpointFor,
  digestOf,
  evaluate,
  signActionRequest,
  signDetached,
} from "@warrant/core";
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
import { DEMONSTRATION_ACTOR } from "./issuance.js";
import type { Actor } from "./issuance.js";
import {
  ESCALATION_THRESHOLD,
  gate,
  identifier,
  CHECKPOINT_ORIGIN,
  REQUEST_FRESHNESS,
  nowIso,
  recorder,
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

async function revocationSnapshot(
  repositories: Repositories,
  scope: TenantScope,
): Promise<RevocationSnapshot> {
  const body = { asOf: nowIso(), revoked: await repositories.mandates.revocations(scope) };
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
  const since = new Date(at).getTime() - windowDays * 24 * 60 * 60 * 1000;
  const packs = await repositories.evidence.recent(500, scope);

  let total = 0;
  for (const pack of packs) {
    if (pack.decision.verdict !== "ALLOW") continue;
    if (pack.authority.chain[0]?.id !== rootMandateId) continue;
    if (new Date(pack.decision.evaluatedAt).getTime() < since) continue;
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

export async function takeCheckpoint(repositories: Repositories): Promise<Checkpoint> {
  const latest = await repositories.ledger.head();
  if (!latest) {
    throw unprocessable("ledger_empty", "there is nothing to commit to yet");
  }
  const takenAt = nowIso();
  const head = await signSegment([latest], await repositories.ledger.count(), takenAt);
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

async function recordAction(
  request: ActionRequest,
  chain: Mandate[],
  evaluatedAt: string,
  repositories: Repositories,
  actor: Actor,
  approval?: Approval,
): Promise<SubmitActionResult> {
  const leaf = chain[chain.length - 1]!;

  const fresh = await repositories.nonces.claim(request.nonce);
  const revocation = await revocationSnapshot(repositories, actor.scope);
  const roots = await trustRootsFor(repositories, actor.scope);
  const agentStatus = await agentStatusFor(repositories, leaf.subject.keyId);

  // The catalogue consulted is the one belonging to the organisation that issued the authority, not
  // the one the caller happens to be signed in to. An organisation defines what its own verbs mean.
  const capability = await resolveCapability(
    repositories,
    chain[0]!.organisation.id,
    request.action,
  );

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

  const decision = await evaluate(
    request,
    chain,
    {
      trustRoots: roots,
      revocation,
      ...(approval ? { approval } : {}),
      inputs: {
        evaluatedAt,
        replayStatus: fresh ? "fresh" : "replayed",
        freshness: REQUEST_FRESHNESS,
        escalationThreshold: ESCALATION_THRESHOLD,
        ...(agentStatus ? { agentStatus } : {}),
        ...(capability ? { capability } : {}),
        ...(priorSpend ? { priorSpend } : {}),
      },
    },
    gate,
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
      ledger: { entries: segment, head: await signSegment(segment, total, nowIso()) },
      revocation,
      ...(approval ? { approval } : {}),
      trustRoots: roots,
    },
    recorder,
  );

  await repositories.evidence.save(pack, chain[0]!.organisation.id);
  return { decision, pack };
}
