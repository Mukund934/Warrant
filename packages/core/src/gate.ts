import { verifyActionRequest } from "./action.js";
import { digestOf } from "./canonical.js";
import { verifyApproval } from "./approval.js";
import { findTrustRoot, keyLifecycleFault, validateChain } from "./chain.js";
import { mandateDigest } from "./mandate.js";
import { formatMoney, isScopeEmpty, permitsCounterparty, describeCounterparties } from "./scope.js";
import { signDetached } from "./sign.js";
import type { SignerIdentity } from "./sign.js";
import { DECISION_VERSION, WarrantError } from "./types.js";
import type {
  ActionRequest,
  Approval,
  Check,
  Decision,
  EvaluationInputs,
  Mandate,
  RevocationSnapshot,
  Scope,
  TrustRoot,
  Verdict,
} from "./types.js";

export interface AssessmentContext {
  trustRoots: TrustRoot[];
  revocation: RevocationSnapshot;
  inputs: EvaluationInputs;
  approval?: Approval;
}

export interface Assessment {
  verdict: Verdict;
  reason: string;
  checks: Check[];
  effectiveScope: Scope;
}

const EMPTY_SCOPE: Scope = {
  actions: [],
  audience: [],
  counterparties: { allow: [] },
  limits: {},
};

function pass(id: string, title: string, detail: string): Check {
  return { id, title, status: "pass", detail };
}

function fail(id: string, title: string, detail: string, expected?: string, observed?: string): Check {
  const check: Check = { id, title, status: "fail", detail };
  if (expected !== undefined) check.expected = expected;
  if (observed !== undefined) check.observed = observed;
  return check;
}

function describeSeconds(seconds: number): string {
  const whole = Math.round(Math.abs(seconds));
  if (whole < 60) return `${whole}s`;
  if (whole < 3600) return `${Math.round(whole / 60)}m`;
  if (whole < 86_400) return `${Math.round(whole / 3600)}h`;
  return `${Math.round(whole / 86_400)}d`;
}

export async function assess(
  request: ActionRequest,
  chain: Mandate[],
  context: AssessmentContext,
): Promise<Assessment> {
  const chainReport = await validateChain(chain, {
    trustRoots: context.trustRoots,
    now: context.inputs.evaluatedAt,
    revocation: context.revocation,
  });

  const checks = [...chainReport.checks];
  const scope = chainReport.effectiveScope ?? EMPTY_SCOPE;
  const leaf = chain[chain.length - 1];

  if (!leaf) {
    return {
      verdict: "BLOCK",
      reason: "no authority was presented with this action",
      checks,
      effectiveScope: scope,
    };
  }

  if (request.actor === leaf.subject.id) {
    checks.push(
      pass(
        "actor.binding",
        "The acting agent holds the mandate it presented",
        `${leaf.subject.name} (${leaf.subject.id}) is the subject of the presenting mandate`,
      ),
    );
  } else {
    checks.push(
      fail(
        "actor.binding",
        "The acting agent holds the mandate it presented",
        "the agent requesting this action is not the agent the mandate was issued to",
        `${leaf.subject.name} (${leaf.subject.id})`,
        request.actor,
      ),
    );
  }

  const requestKey = findTrustRoot(context.trustRoots, request.proof.verificationMethod);
  if (!requestKey) {
    checks.push(
      fail(
        "request.signature",
        "The request itself is signed and unaltered",
        `no public key is known for ${request.proof.verificationMethod}`,
      ),
    );
  } else {
    const lifecycle = keyLifecycleFault(requestKey, request.proof.created);
    const outcome = lifecycle
      ? { valid: false, reason: lifecycle }
      : await verifyActionRequest(request, requestKey.publicKeyJwk);
    checks.push(
      outcome.valid
        ? pass(
            "request.signature",
            "The request itself is signed and unaltered",
            `signed by ${request.proof.verificationMethod} at ${request.requestedAt}`,
          )
        : fail(
            "request.signature",
            "The request itself is signed and unaltered",
            outcome.reason ?? "the request signature is invalid",
          ),
    );
  }

  if (request.proof.verificationMethod === leaf.subject.keyId) {
    checks.push(
      pass(
        "actor.possession",
        "The requesting agent proved it holds the mandate's key",
        `${leaf.subject.name} signed this request with ${leaf.subject.keyId}`,
      ),
    );
  } else {
    checks.push(
      fail(
        "actor.possession",
        "The requesting agent proved it holds the mandate's key",
        "presenting a mandate is not enough; this request was signed by a different key",
        leaf.subject.keyId,
        request.proof.verificationMethod,
      ),
    );
  }

  if (scope.audience.includes(request.resource)) {
    checks.push(
      pass(
        "audience.binding",
        "The target system is covered by the mandate",
        `${request.resource} is within the delegated audience`,
      ),
    );
  } else {
    checks.push(
      fail(
        "audience.binding",
        "The target system is covered by the mandate",
        "the mandate does not authorise action against this system",
        scope.audience.join(", ") || "no resources",
        request.resource,
      ),
    );
  }

  if (scope.actions.includes(request.action)) {
    checks.push(
      pass(
        "action.in_scope",
        "The requested action is inside the delegated scope",
        `${request.action} is one of the delegated actions`,
      ),
    );
  } else {
    checks.push(
      fail(
        "action.in_scope",
        "The requested action is inside the delegated scope",
        isScopeEmpty(scope)
          ? "the delegated scope is empty once every hop is intersected"
          : "the mandate does not authorise this action",
        scope.actions.join(", ") || "no actions",
        request.action,
      ),
    );
  }

  if (permitsCounterparty(scope, request.counterparty)) {
    checks.push(
      pass(
        "counterparty.allowed",
        "The counterparty is on the delegated list",
        `${request.counterparty} is permitted`,
      ),
    );
  } else {
    checks.push(
      fail(
        "counterparty.allowed",
        "The counterparty is on the delegated list",
        "the mandate does not authorise action involving this counterparty",
        describeCounterparties(scope) || "no counterparties",
        request.counterparty,
      ),
    );
  }

  const perAction = scope.limits.perAction;
  if (!request.amount) {
    checks.push(
      pass("limit.per_action", "The amount is within the per-action limit", "this action carries no amount"),
    );
  } else if (!perAction) {
    checks.push(
      pass(
        "limit.per_action",
        "The amount is within the per-action limit",
        "the mandate sets no per-action limit",
      ),
    );
  } else if (request.amount.currency !== perAction.currency) {
    checks.push(
      fail(
        "limit.per_action",
        "The amount is within the per-action limit",
        "the requested amount is denominated in a currency the mandate does not cover",
        perAction.currency,
        request.amount.currency,
      ),
    );
  } else if (request.amount.minor > perAction.minor) {
    checks.push(
      fail(
        "limit.per_action",
        "The amount is within the per-action limit",
        "the requested amount exceeds the delegated per-action limit",
        formatMoney(perAction),
        formatMoney(request.amount),
      ),
    );
  } else {
    checks.push(
      pass(
        "limit.per_action",
        "The amount is within the per-action limit",
        `${formatMoney(request.amount)} of ${formatMoney(perAction)} permitted`,
      ),
    );
  }

  const perPeriod = scope.limits.perPeriod;
  const priorSpend = context.inputs.priorSpend;
  if (!request.amount || !perPeriod) {
    checks.push(
      pass(
        "limit.per_period",
        "The periodic budget has not been exhausted",
        perPeriod ? "this action carries no amount" : "the mandate sets no periodic limit",
      ),
    );
  } else if (priorSpend && priorSpend.currency !== perPeriod.amount.currency) {
    checks.push(
      fail(
        "limit.per_period",
        "The periodic budget has not been exhausted",
        "recorded spend is denominated in a currency the mandate does not cover",
        perPeriod.amount.currency,
        priorSpend.currency,
      ),
    );
  } else {
    const spent = priorSpend?.minor ?? 0;
    const projected = spent + request.amount.minor;
    if (projected > perPeriod.amount.minor) {
      checks.push(
        fail(
          "limit.per_period",
          "The periodic budget has not been exhausted",
          `this action would take spend past the ${perPeriod.days}-day delegated budget`,
          formatMoney(perPeriod.amount),
          formatMoney({ currency: perPeriod.amount.currency, minor: projected }),
        ),
      );
    } else {
      checks.push(
        pass(
          "limit.per_period",
          "The periodic budget has not been exhausted",
          `${formatMoney({ currency: perPeriod.amount.currency, minor: projected })} of ${formatMoney(
            perPeriod.amount,
          )} across ${perPeriod.days} days`,
        ),
      );
    }
  }

  const freshness = context.inputs.freshness;
  const FRESHNESS_TITLE = "The request was presented soon after it was signed";
  if (!freshness) {
    checks.push({
      id: "request.freshness",
      title: FRESHNESS_TITLE,
      status: "skip",
      detail: "this decision recorded no acceptance window, so the age of the request was not enforced",
    });
  } else {
    const window = `at most ${describeSeconds(freshness.maxAgeSeconds)} old, allowing ${describeSeconds(
      freshness.clockSkewSeconds,
    )} of clock skew`;
    const ageSeconds =
      (new Date(context.inputs.evaluatedAt).getTime() - new Date(request.requestedAt).getTime()) / 1000;

    if (!Number.isFinite(ageSeconds)) {
      checks.push(
        fail(
          "request.freshness",
          FRESHNESS_TITLE,
          "a timestamp on this request or decision cannot be read as a date, so its age cannot be established",
          window,
          `requested ${request.requestedAt}, evaluated ${context.inputs.evaluatedAt}`,
        ),
      );
    } else if (ageSeconds > freshness.maxAgeSeconds + freshness.clockSkewSeconds) {
      checks.push(
        fail(
          "request.freshness",
          FRESHNESS_TITLE,
          "this request was signed too long before it was presented; a validly signed request is not indefinitely spendable",
          window,
          `signed ${describeSeconds(ageSeconds)} before it was evaluated`,
        ),
      );
    } else if (ageSeconds < -freshness.clockSkewSeconds) {
      checks.push(
        fail(
          "request.freshness",
          FRESHNESS_TITLE,
          "this request is dated after the moment it was evaluated, by more than the tolerated clock skew",
          window,
          `signed ${describeSeconds(ageSeconds)} after it was evaluated`,
        ),
      );
    } else {
      checks.push(
        pass(
          "request.freshness",
          FRESHNESS_TITLE,
          `signed ${describeSeconds(ageSeconds)} before evaluation, within a window of ${window}`,
        ),
      );
    }
  }

  if (context.inputs.replayStatus === "replayed") {
    checks.push(
      fail(
        "replay.freshness",
        "The request has not been seen before",
        "this request nonce was already used by an accepted action",
        "an unused nonce",
        request.nonce,
      ),
    );
  } else if (context.inputs.replayStatus === "fresh") {
    checks.push(
      pass("replay.freshness", "The request has not been seen before", `nonce ${request.nonce} was unused`),
    );
  } else {
    checks.push({
      id: "replay.freshness",
      title: "The request has not been seen before",
      status: "skip",
      detail: "nonce novelty is decided by the gate at the moment of the action and cannot be recomputed later",
    });
  }

  const agentStatus = context.inputs.agentStatus;
  const AGENT_STATUS_TITLE = "The acting agent was in good standing when it acted";
  if (!agentStatus) {
    checks.push({
      id: "agent.status",
      title: AGENT_STATUS_TITLE,
      status: "skip",
      detail:
        "this decision recorded no registration state for the acting agent, so its standing was not enforced",
    });
  } else if (agentStatus === "active") {
    checks.push(
      pass(
        "agent.status",
        AGENT_STATUS_TITLE,
        `${leaf.subject.name} was registered and active in its organisation at the moment of the action`,
      ),
    );
  } else {
    checks.push(
      fail(
        "agent.status",
        AGENT_STATUS_TITLE,
        `${leaf.subject.name} was ${agentStatus} in its organisation when this action was presented`,
        "active",
        agentStatus,
      ),
    );
  }

  const failing = checks.filter((check) => check.status === "fail");
  if (failing.length > 0) {
    return {
      verdict: "BLOCK",
      reason: failing[0]!.detail,
      checks,
      effectiveScope: scope,
    };
  }

  const carried = scope.approval?.above;
  const configured = context.inputs.escalationThreshold;
  const applicable = [
    ...(carried ? [{ source: "authority" as const, amount: carried }] : []),
    ...(configured ? [{ source: "deployment" as const, amount: configured }] : []),
  ].filter((candidate) => candidate.amount.currency === request.amount?.currency);

  const binding = applicable.reduce<(typeof applicable)[number] | undefined>(
    (tightest, candidate) =>
      !tightest || candidate.amount.minor < tightest.amount.minor ? candidate : tightest,
    undefined,
  );

  if (binding && request.amount && request.amount.minor > binding.amount.minor) {
    const origin =
      binding.source === "authority"
        ? `the authority itself carries that requirement, so a reader of this chain reaches the same conclusion without knowing how this service is configured`
        : `this deployment applies that threshold; it is not carried in the authority`;

    const approval = context.approval;
    if (!approval) {
      checks.push({
        id: "policy.escalation",
        title: "Human approval is required above the escalation threshold",
        status: "warn",
        detail: `${formatMoney(request.amount)} is above the ${formatMoney(
          binding.amount,
        )} threshold at which ${leaf.liablePrincipal.name} requires a human approval. ${origin}`,
        expected: `at most ${formatMoney(binding.amount)} without approval`,
        observed: formatMoney(request.amount),
      });
      return {
        verdict: "ESCALATE",
        reason: `authority is sufficient, but ${formatMoney(request.amount)} exceeds the ${formatMoney(
          binding.amount,
        )} threshold at which a human must approve`,
        checks,
        effectiveScope: scope,
      };
    }

    const approvalChecks = await verifyApproval(approval, {
      request,
      liablePrincipalId: leaf.liablePrincipal.id,
      trustRoots: context.trustRoots,
    });
    checks.push(...approvalChecks);

    const unsound = approvalChecks.find((check) => check.status === "fail");
    if (unsound) {
      checks.push({
        id: "policy.escalation",
        title: "Human approval is required above the escalation threshold",
        status: "warn",
        detail: `${formatMoney(request.amount)} is above the ${formatMoney(
          binding.amount,
        )} threshold at which ${leaf.liablePrincipal.name} requires a human approval, and the approval presented does not hold: ${unsound.detail}`,
        expected: `a sound approval for amounts above ${formatMoney(binding.amount)}`,
        observed: unsound.id,
      });
      return {
        verdict: "ESCALATE",
        reason: `${formatMoney(request.amount)} needs a human approval, and the one presented does not hold: ${unsound.detail}`,
        checks,
        effectiveScope: scope,
      };
    }

    checks.push({
      id: "policy.escalation",
      title: "Human approval is required above the escalation threshold",
      status: "pass",
      detail: `${formatMoney(request.amount)} is above the ${formatMoney(
        binding.amount,
      )} threshold at which ${leaf.liablePrincipal.name} requires a human approval, and ${approval.approver.name} approved this exact action at ${approval.approvedAt}. ${origin}`,
    });
  }

  return {
    verdict: "ALLOW",
    reason: `${leaf.subject.name} is acting inside authority delegated by ${leaf.liablePrincipal.name}, ${leaf.liablePrincipal.role}`,
    checks,
    effectiveScope: scope,
  };
}

export interface GateIdentity {
  id: string;
  signer: SignerIdentity;
}

export async function chainDigestOf(chain: Mandate[]): Promise<string> {
  const digests = await Promise.all(chain.map((mandate) => mandateDigest(mandate)));
  return digestOf(digests);
}

export async function evaluate(
  request: ActionRequest,
  chain: Mandate[],
  context: AssessmentContext,
  gate: GateIdentity,
): Promise<Decision> {
  const leaf = chain[chain.length - 1];
  if (!leaf) {
    throw new WarrantError("gate/empty_chain", "an action must be presented with at least one mandate");
  }

  const assessment = await assess(request, chain, context);
  const unsigned: Omit<Decision, "proof"> = {
    version: DECISION_VERSION,
    id: `dec_${request.id.replace(/^req_/, "")}`,
    gate: { id: gate.id, keyId: gate.signer.keyId },
    requestDigest: await digestOf(request),
    chainDigest: await chainDigestOf(chain),
    inputs: context.inputs,
    verdict: assessment.verdict,
    reason: assessment.reason,
    checks: assessment.checks,
    effectiveScope: assessment.effectiveScope,
    liablePrincipal: leaf.liablePrincipal,
    evaluatedAt: context.inputs.evaluatedAt,
  };

  const proof = await signDetached(unsigned, gate.signer, context.inputs.evaluatedAt);
  return { ...unsigned, proof };
}
