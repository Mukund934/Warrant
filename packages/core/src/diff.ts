import { formatMoney, narrows } from "./scope.js";
import type { Counterparties, Mandate, Money, Scope } from "./types.js";

export type ChangeDirection = "narrowed" | "widened" | "unchanged";

export type AuthorityField =
  | "actions"
  | "audience"
  | "counterparties"
  | "limits.perAction"
  | "limits.perPeriod"
  | "approval"
  | "purpose";

export interface AuthorityChange {
  field: string;
  direction: ChangeDirection;
  summary: string;
  from: string;
  to: string;
  removed?: string[];
  added?: string[];
  violation?: string;
}

export interface AuthorityHop {
  from: { id: string; subject: string; depth: number };
  to: { id: string; subject: string; depth: number };
  changes: AuthorityChange[];
  narrowed: boolean;
  widened: boolean;
}

/**
 * Which field each violation `narrows` can raise belongs to. The diff never decides for itself
 * whether a hop widened — it asks `narrows`, so the two can never disagree about the same pair.
 */
const FIELD_FOR_VIOLATION: Record<string, AuthorityField> = {
  "scope/action_not_delegable": "actions",
  "scope/audience_not_delegable": "audience",
  "scope/counterparty_widened": "counterparties",
  "scope/counterparty_not_delegable": "counterparties",
  "scope/approval_removed": "approval",
  "scope/approval_currency_changed": "approval",
  "scope/approval_weakened": "approval",
  "scope/per_action_limit_removed": "limits.perAction",
  "scope/per_action_currency_changed": "limits.perAction",
  "scope/per_action_limit_exceeded": "limits.perAction",
  "scope/per_period_limit_removed": "limits.perPeriod",
  "scope/per_period_currency_changed": "limits.perPeriod",
  "scope/per_period_limit_exceeded": "limits.perPeriod",
  "scope/purpose_changed": "purpose",
};

const NONE = "none";

function readable(items: string[]): string {
  if (items.length === 0) return "nothing";
  if (items.length === 1) return items[0]!;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function isAny(counterparties: Counterparties): counterparties is { any: true } {
  return "any" in counterparties && counterparties.any === true;
}

const describeParties = (counterparties: Counterparties): string =>
  isAny(counterparties) ? "any counterparty" : readable(counterparties.allow);

const describeMoney = (money: Money | undefined): string => (money ? formatMoney(money) : NONE);

const describePeriod = (period: Scope["limits"]["perPeriod"]): string =>
  period ? `${formatMoney(period.amount)} every ${period.days} days` : NONE;

const describeApproval = (approval: Scope["approval"]): string =>
  approval ? `approval above ${formatMoney(approval.above)}` : NONE;

export function diffScope(parent: Scope, child: Scope): AuthorityChange[] {
  const widened = new Map<string, string>();
  const unclassified: AuthorityChange[] = [];

  for (const violation of narrows(child, parent)) {
    const field = FIELD_FOR_VIOLATION[violation.code];
    if (field) {
      if (!widened.has(field)) widened.set(field, violation.code);
      continue;
    }
    // A violation this file has never been taught about is reported rather than dropped, so a new
    // code added to `narrows` shows up as an unexplained widening instead of vanishing.
    unclassified.push({
      field: violation.code,
      direction: "widened",
      summary: violation.message,
      from: violation.parentValue ?? NONE,
      to: violation.childValue ?? NONE,
      violation: violation.code,
    });
  }

  const changes: AuthorityChange[] = [];

  function record(
    field: AuthorityField,
    from: string,
    to: string,
    narrowedSummary: string | undefined,
    extra: Partial<AuthorityChange> = {},
  ): void {
    const violation = widened.get(field);
    if (violation) {
      changes.push({
        field,
        direction: "widened",
        summary: `claims more than the mandate above holds`,
        from,
        to,
        violation,
        ...extra,
      });
      return;
    }

    changes.push({
      field,
      direction: narrowedSummary ? "narrowed" : "unchanged",
      summary: narrowedSummary ?? "unchanged",
      from,
      to,
      ...extra,
    });
  }

  const droppedActions = parent.actions.filter((action) => !child.actions.includes(action));
  const addedActions = child.actions.filter((action) => !parent.actions.includes(action));
  record(
    "actions",
    readable(parent.actions),
    readable(child.actions),
    droppedActions.length > 0 ? `dropped ${readable(droppedActions)}` : undefined,
    {
      ...(droppedActions.length > 0 ? { removed: droppedActions } : {}),
      ...(addedActions.length > 0 ? { added: addedActions } : {}),
    },
  );

  const droppedAudience = parent.audience.filter((item) => !child.audience.includes(item));
  const addedAudience = child.audience.filter((item) => !parent.audience.includes(item));
  record(
    "audience",
    readable(parent.audience),
    readable(child.audience),
    droppedAudience.length > 0 ? `dropped ${readable(droppedAudience)}` : undefined,
    {
      ...(droppedAudience.length > 0 ? { removed: droppedAudience } : {}),
      ...(addedAudience.length > 0 ? { added: addedAudience } : {}),
    },
  );

  const parentParties = parent.counterparties;
  const childParties = child.counterparties;
  let partiesSummary: string | undefined;
  let removedParties: string[] = [];
  if (isAny(parentParties) && !isAny(childParties)) {
    partiesSummary = `narrowed from any counterparty to ${readable(childParties.allow)}`;
  } else if (!isAny(parentParties) && !isAny(childParties)) {
    removedParties = parentParties.allow.filter((item) => !childParties.allow.includes(item));
    if (removedParties.length > 0) partiesSummary = `dropped ${readable(removedParties)}`;
  }
  record(
    "counterparties",
    describeParties(parentParties),
    describeParties(childParties),
    partiesSummary,
    removedParties.length > 0 ? { removed: removedParties } : {},
  );

  const parentPerAction = parent.limits.perAction;
  const childPerAction = child.limits.perAction;
  let perActionSummary: string | undefined;
  if (!parentPerAction && childPerAction) {
    perActionSummary = `set a per-action limit of ${formatMoney(childPerAction)} where the mandate above set none`;
  } else if (
    parentPerAction &&
    childPerAction &&
    childPerAction.currency === parentPerAction.currency &&
    childPerAction.minor < parentPerAction.minor
  ) {
    perActionSummary = `lowered from ${formatMoney(parentPerAction)} to ${formatMoney(childPerAction)}`;
  }
  record(
    "limits.perAction",
    describeMoney(parentPerAction),
    describeMoney(childPerAction),
    perActionSummary,
  );

  const parentPerPeriod = parent.limits.perPeriod;
  const childPerPeriod = child.limits.perPeriod;
  let perPeriodSummary: string | undefined;
  if (!parentPerPeriod && childPerPeriod) {
    perPeriodSummary = `set a periodic budget of ${describePeriod(childPerPeriod)} where the mandate above set none`;
  } else if (
    parentPerPeriod &&
    childPerPeriod &&
    childPerPeriod.amount.currency === parentPerPeriod.amount.currency &&
    childPerPeriod.amount.minor * parentPerPeriod.days <
      parentPerPeriod.amount.minor * childPerPeriod.days
  ) {
    perPeriodSummary = `lowered from ${describePeriod(parentPerPeriod)} to ${describePeriod(childPerPeriod)}`;
  }
  record(
    "limits.perPeriod",
    describePeriod(parentPerPeriod),
    describePeriod(childPerPeriod),
    perPeriodSummary,
  );

  const parentApproval = parent.approval;
  const childApproval = child.approval;
  let approvalSummary: string | undefined;
  if (!parentApproval && childApproval) {
    approvalSummary = `now demands ${describeApproval(childApproval)}, where the mandate above demanded none`;
  } else if (
    parentApproval &&
    childApproval &&
    childApproval.above.currency === parentApproval.above.currency &&
    childApproval.above.minor < parentApproval.above.minor
  ) {
    approvalSummary = `tightened from ${describeApproval(parentApproval)} to ${describeApproval(childApproval)}`;
  }
  record("approval", describeApproval(parentApproval), describeApproval(childApproval), approvalSummary);

  const purposeSummary =
    !parent.purpose && child.purpose
      ? `stated a purpose where the mandate above stated none`
      : undefined;
  record("purpose", parent.purpose ?? NONE, child.purpose ?? NONE, purposeSummary);

  return [...changes, ...unclassified];
}

export function diffChain(chain: Mandate[]): AuthorityHop[] {
  const hops: AuthorityHop[] = [];

  for (let index = 1; index < chain.length; index += 1) {
    const parent = chain[index - 1]!;
    const child = chain[index]!;
    const changes = diffScope(parent.scope, child.scope);

    hops.push({
      from: { id: parent.id, subject: parent.subject.name, depth: parent.depth },
      to: { id: child.id, subject: child.subject.name, depth: child.depth },
      changes,
      narrowed: changes.some((change) => change.direction === "narrowed"),
      widened: changes.some((change) => change.direction === "widened"),
    });
  }

  return hops;
}
