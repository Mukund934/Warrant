import type { Counterparties, Money, Scope, ScopeDelta } from "./types.js";
import { WarrantError } from "./types.js";

export interface ScopeViolation {
  code: string;
  message: string;
  parentValue?: string;
  childValue?: string;
}

export function formatMoney(money: Money): string {
  const symbol = money.currency === "INR" ? "₹" : money.currency === "USD" ? "$" : "€";
  const major = money.minor / 100;
  const locale = money.currency === "INR" ? "en-IN" : "en-US";
  return `${symbol}${major.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function assertSameCurrency(child: Money, parent: Money, code: string): ScopeViolation | null {
  if (child.currency === parent.currency) return null;
  return {
    code,
    message: "a delegated limit may not change currency",
    parentValue: parent.currency,
    childValue: child.currency,
  };
}

function isAny(counterparties: Counterparties): counterparties is { any: true } {
  return "any" in counterparties && counterparties.any === true;
}

function allowedList(counterparties: Counterparties): string[] {
  return isAny(counterparties) ? [] : counterparties.allow;
}

export function resolveDelta(delta: ScopeDelta, parent: Scope): Scope {
  const limits = delta.limits ?? {};
  return {
    actions: delta.actions ?? [...parent.actions],
    audience: delta.audience ?? [...parent.audience],
    counterparties: delta.counterparties ?? structuredClone(parent.counterparties),
    limits: {
      perAction: limits.perAction ?? parent.limits.perAction,
      perPeriod: limits.perPeriod ?? parent.limits.perPeriod,
    },
    purpose: delta.purpose ?? parent.purpose,
  };
}

export function narrows(child: Scope, parent: Scope): ScopeViolation[] {
  const violations: ScopeViolation[] = [];

  const widerActions = child.actions.filter((action) => !parent.actions.includes(action));
  if (widerActions.length > 0) {
    violations.push({
      code: "scope/action_not_delegable",
      message: "the delegated mandate claims actions the issuing mandate does not hold",
      parentValue: parent.actions.join(", "),
      childValue: widerActions.join(", "),
    });
  }

  const widerAudience = child.audience.filter((item) => !parent.audience.includes(item));
  if (widerAudience.length > 0) {
    violations.push({
      code: "scope/audience_not_delegable",
      message: "the delegated mandate claims resources the issuing mandate does not cover",
      parentValue: parent.audience.join(", "),
      childValue: widerAudience.join(", "),
    });
  }

  if (!isAny(parent.counterparties)) {
    if (isAny(child.counterparties)) {
      violations.push({
        code: "scope/counterparty_widened",
        message: "the delegated mandate claims any counterparty from a restricted issuing mandate",
        parentValue: allowedList(parent.counterparties).join(", "),
        childValue: "any",
      });
    } else {
      const parentAllows = allowedList(parent.counterparties);
      const extra = child.counterparties.allow.filter((item) => !parentAllows.includes(item));
      if (extra.length > 0) {
        violations.push({
          code: "scope/counterparty_not_delegable",
          message: "the delegated mandate claims counterparties the issuing mandate does not hold",
          parentValue: parentAllows.join(", "),
          childValue: extra.join(", "),
        });
      }
    }
  }

  const parentPerAction = parent.limits.perAction;
  const childPerAction = child.limits.perAction;
  if (parentPerAction) {
    if (!childPerAction) {
      violations.push({
        code: "scope/per_action_limit_removed",
        message: "the delegated mandate removes a per-action limit set by the issuing mandate",
        parentValue: formatMoney(parentPerAction),
        childValue: "unlimited",
      });
    } else {
      const currencyViolation = assertSameCurrency(
        childPerAction,
        parentPerAction,
        "scope/per_action_currency_changed",
      );
      if (currencyViolation) {
        violations.push(currencyViolation);
      } else if (childPerAction.minor > parentPerAction.minor) {
        violations.push({
          code: "scope/per_action_limit_exceeded",
          message: "the delegated mandate claims a higher per-action limit than the issuing mandate",
          parentValue: formatMoney(parentPerAction),
          childValue: formatMoney(childPerAction),
        });
      }
    }
  }

  const parentPerPeriod = parent.limits.perPeriod;
  const childPerPeriod = child.limits.perPeriod;
  if (parentPerPeriod) {
    if (!childPerPeriod) {
      violations.push({
        code: "scope/per_period_limit_removed",
        message: "the delegated mandate removes a periodic limit set by the issuing mandate",
        parentValue: `${formatMoney(parentPerPeriod.amount)} / ${parentPerPeriod.days}d`,
        childValue: "unlimited",
      });
    } else {
      const currencyViolation = assertSameCurrency(
        childPerPeriod.amount,
        parentPerPeriod.amount,
        "scope/per_period_currency_changed",
      );
      if (currencyViolation) {
        violations.push(currencyViolation);
      } else {
        const childRateExceeds =
          childPerPeriod.amount.minor * parentPerPeriod.days >
          parentPerPeriod.amount.minor * childPerPeriod.days;
        if (childPerPeriod.amount.minor > parentPerPeriod.amount.minor || childRateExceeds) {
          violations.push({
            code: "scope/per_period_limit_exceeded",
            message:
              "the delegated mandate claims a periodic budget that permits more spend than the issuing mandate",
            parentValue: `${formatMoney(parentPerPeriod.amount)} / ${parentPerPeriod.days}d`,
            childValue: `${formatMoney(childPerPeriod.amount)} / ${childPerPeriod.days}d`,
          });
        }
      }
    }
  }

  if (parent.purpose && child.purpose !== parent.purpose) {
    violations.push({
      code: "scope/purpose_changed",
      message: "the delegated mandate restates the purpose recorded by the issuing mandate",
      parentValue: parent.purpose,
      childValue: child.purpose ?? "unstated",
    });
  }

  return violations;
}

function meetCounterparties(a: Counterparties, b: Counterparties): Counterparties {
  if (isAny(a) && isAny(b)) return { any: true };
  if (isAny(a)) return { allow: [...allowedList(b)] };
  if (isAny(b)) return { allow: [...allowedList(a)] };
  const bAllows = allowedList(b);
  return { allow: allowedList(a).filter((item) => bAllows.includes(item)) };
}

function meetMoney(a: Money | undefined, b: Money | undefined): Money | undefined {
  if (!a) return b;
  if (!b) return a;
  if (a.currency !== b.currency) {
    throw new WarrantError(
      "scope/currency_mismatch",
      "cannot combine limits denominated in different currencies",
    );
  }
  return a.minor <= b.minor ? a : b;
}

function meetPeriod(
  a: Scope["limits"]["perPeriod"],
  b: Scope["limits"]["perPeriod"],
): Scope["limits"]["perPeriod"] {
  if (!a) return b;
  if (!b) return a;
  if (a.amount.currency !== b.amount.currency) {
    throw new WarrantError(
      "scope/currency_mismatch",
      "cannot combine periodic limits denominated in different currencies",
    );
  }
  const aIsTighter = a.amount.minor * b.days <= b.amount.minor * a.days;
  return aIsTighter ? a : b;
}

export function meet(a: Scope, b: Scope): Scope {
  return {
    actions: a.actions.filter((action) => b.actions.includes(action)),
    audience: a.audience.filter((item) => b.audience.includes(item)),
    counterparties: meetCounterparties(a.counterparties, b.counterparties),
    limits: {
      perAction: meetMoney(a.limits.perAction, b.limits.perAction),
      perPeriod: meetPeriod(a.limits.perPeriod, b.limits.perPeriod),
    },
    purpose: a.purpose ?? b.purpose,
  };
}

export function effectiveScope(scopes: Scope[]): Scope {
  const [first, ...rest] = scopes;
  if (!first) {
    throw new WarrantError("scope/empty_chain", "an authority chain must contain at least one mandate");
  }
  return rest.reduce<Scope>((accumulated, scope) => meet(accumulated, scope), structuredClone(first));
}

export function isScopeEmpty(scope: Scope): boolean {
  return scope.actions.length === 0 || scope.audience.length === 0;
}

export function permitsCounterparty(scope: Scope, counterparty: string): boolean {
  return isAny(scope.counterparties) || scope.counterparties.allow.includes(counterparty);
}

export function describeCounterparties(scope: Scope): string {
  return isAny(scope.counterparties) ? "any counterparty" : scope.counterparties.allow.join(", ");
}
