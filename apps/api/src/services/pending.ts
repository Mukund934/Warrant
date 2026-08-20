import { digestOf } from "@warrant/core";
import type { ActionRequest, Approval, Decision, Mandate } from "@warrant/core";
import { notFound, unprocessable } from "../http/errors.js";
import type { PendingAction, Repositories } from "../persistence/types.js";
import { instant, recordDecision } from "./execution.js";
import type { SubmitActionResult } from "./execution.js";
import type { Actor } from "./issuance.js";
import { PENDING_FRESHNESS, identifier, nowIso } from "../warrant/context.js";

/** A parked action waits exactly as long as a resumed decision would still be judged fresh. */
const PENDING_WINDOW_SECONDS = PENDING_FRESHNESS.maxAgeSeconds;

export async function parkAction(
  request: ActionRequest,
  chain: Mandate[],
  decision: Decision,
  packId: string,
  repositories: Repositories,
  at: string,
): Promise<PendingAction> {
  const expiresAt = new Date(instant(at) + PENDING_WINDOW_SECONDS * 1000)
    .toISOString()
    .replace(/\.\d+Z$/, "Z");

  const action: PendingAction = {
    id: identifier("pnd"),
    organisationId: chain[0]!.organisation.id,
    mandateId: chain[chain.length - 1]!.id,
    // The digest an approval must name. Stored so an approver can be handed it without having to
    // recompute it from bytes they may not have.
    requestDigest: await digestOf(request),
    request,
    reason: decision.reason,
    packId,
    status: "pending",
    createdAt: at,
    expiresAt,
  };

  await repositories.pending.park(action);
  return action;
}

export interface ResumeResult extends SubmitActionResult {
  pendingActionId: string;
}

/**
 * Continue an action that escalated, now that a human has approved it.
 *
 * The nonce was claimed when the action was parked, so this is not a second use of it — which is
 * why the parked row must move out of `pending` before anything else happens. That move is a
 * conditional update, so two resumes racing cannot both proceed.
 */
export async function resumePending(
  id: string,
  approval: Approval,
  repositories: Repositories,
  actor: Actor,
): Promise<ResumeResult> {
  const parked = await repositories.pending.find(id, actor.scope);
  if (!parked) throw notFound(`no pending action with id ${id}`);

  if (parked.status !== "pending") {
    throw unprocessable(
      "already_resolved",
      `this action was already ${parked.status}; a parked action is spent once, because it holds the nonce claim of the request it carries`,
    );
  }

  const at = nowIso();
  if (instant(at) > instant(parked.expiresAt)) {
    await repositories.pending.claim(id, "expired", at, actor.scope);
    throw unprocessable(
      "pending_expired",
      `this action was parked until ${parked.expiresAt} and was not approved in time; an escalation nobody answered is not permission`,
    );
  }

  const won = await repositories.pending.claim(id, "resumed", at, actor.scope);
  if (!won) {
    throw unprocessable(
      "already_resolved",
      "this action was resolved by another request while this one was being handled",
    );
  }

  const chain = await repositories.mandates.findChain(parked.mandateId, actor.scope);
  if (!chain || chain.length === 0) {
    throw notFound(`no mandate chain could be resolved for ${parked.mandateId}`);
  }

  const outcome = await recordDecision(
    parked.request,
    chain,
    at,
    repositories,
    actor,
    // Judged against the window a parked action is allowed to wait, and that window is written into
    // the signed inputs, so the verdict reproduces offline against the rule that was applied.
    { replayStatus: "fresh", freshness: PENDING_FRESHNESS, park: false },
    approval,
  );

  return { ...outcome, pendingActionId: id };
}
