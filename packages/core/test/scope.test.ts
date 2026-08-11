import { describe, expect, it } from "vitest";
import { effectiveScope, meet, narrows, resolveDelta } from "../src/index.js";
import type { Scope } from "../src/index.js";

const inr = (major: number) => ({ currency: "INR" as const, minor: major * 100 });

const parent: Scope = {
  actions: ["payment.approve", "payment.execute", "invoice.read"],
  audience: ["erp:ap", "bank:api"],
  counterparties: { allow: ["Kalyani", "Sundaram", "Nagpur"] },
  limits: { perAction: inr(500_000), perPeriod: { amount: inr(4_000_000), days: 30 } },
  purpose: "Settlement of approved supplier invoices",
};

describe("resolveDelta", () => {
  it("inherits every field the delegation does not restate", () => {
    const resolved = resolveDelta({ limits: { perAction: inr(100_000) } }, parent);
    expect(resolved.actions).toEqual(parent.actions);
    expect(resolved.audience).toEqual(parent.audience);
    expect(resolved.counterparties).toEqual(parent.counterparties);
    expect(resolved.purpose).toBe(parent.purpose);
  });

  it("never turns an unstated limit into an unlimited one", () => {
    const resolved = resolveDelta({ actions: ["payment.execute"] }, parent);
    expect(resolved.limits.perAction).toEqual(parent.limits.perAction);
    expect(resolved.limits.perPeriod).toEqual(parent.limits.perPeriod);
  });

  it("keeps an unstated periodic limit when only the per-action limit is restated", () => {
    const resolved = resolveDelta({ limits: { perAction: inr(50_000) } }, parent);
    expect(resolved.limits.perPeriod).toEqual(parent.limits.perPeriod);
  });
});

describe("narrows", () => {
  it("accepts a strictly narrower delegation", () => {
    const child = resolveDelta(
      {
        actions: ["payment.execute"],
        counterparties: { allow: ["Kalyani"] },
        limits: { perAction: inr(200_000) },
      },
      parent,
    );
    expect(narrows(child, parent)).toEqual([]);
  });

  it("rejects an action the parent does not hold", () => {
    const child = resolveDelta({ actions: ["payment.execute", "vendor.create"] }, parent);
    expect(narrows(child, parent).map((violation) => violation.code)).toContain(
      "scope/action_not_delegable",
    );
  });

  it("rejects a higher per-action limit", () => {
    const child = resolveDelta({ limits: { perAction: inr(800_000) } }, parent);
    const violation = narrows(child, parent).find(
      (item) => item.code === "scope/per_action_limit_exceeded",
    );
    expect(violation).toBeDefined();
    expect(violation?.parentValue).toContain("5,00,000");
    expect(violation?.childValue).toContain("8,00,000");
  });

  it("rejects removing a limit the parent set", () => {
    const child: Scope = { ...parent, limits: { perPeriod: parent.limits.perPeriod } };
    expect(narrows(child, parent).map((violation) => violation.code)).toContain(
      "scope/per_action_limit_removed",
    );
  });

  it("rejects widening from a named counterparty list to any counterparty", () => {
    const child: Scope = { ...parent, counterparties: { any: true } };
    expect(narrows(child, parent).map((violation) => violation.code)).toContain(
      "scope/counterparty_widened",
    );
  });

  it("rejects a counterparty the parent does not hold", () => {
    const child: Scope = { ...parent, counterparties: { allow: ["Kalyani", "Vantage Global"] } };
    const violation = narrows(child, parent).find(
      (item) => item.code === "scope/counterparty_not_delegable",
    );
    expect(violation?.childValue).toBe("Vantage Global");
  });

  it("rejects a shorter period that permits a higher rate of spend", () => {
    const child = resolveDelta(
      { limits: { perPeriod: { amount: inr(1_000_000), days: 1 } } },
      parent,
    );
    expect(narrows(child, parent).map((violation) => violation.code)).toContain(
      "scope/per_period_limit_exceeded",
    );
  });

  it("accepts a shorter period that stays inside the parent rate", () => {
    const child = resolveDelta({ limits: { perPeriod: { amount: inr(100_000), days: 1 } } }, parent);
    expect(narrows(child, parent)).toEqual([]);
  });

  it("rejects a change of currency", () => {
    const child = resolveDelta(
      { limits: { perAction: { currency: "USD", minor: 100 } } },
      parent,
    );
    expect(narrows(child, parent).map((violation) => violation.code)).toContain(
      "scope/per_action_currency_changed",
    );
  });

  it("rejects restating the purpose", () => {
    const child = resolveDelta({ purpose: "General corporate spending" }, parent);
    expect(narrows(child, parent).map((violation) => violation.code)).toContain(
      "scope/purpose_changed",
    );
  });
});

describe("meet", () => {
  it("intersects actions, audience and counterparties", () => {
    const other: Scope = {
      actions: ["payment.execute", "vendor.create"],
      audience: ["bank:api"],
      counterparties: { allow: ["Kalyani", "Vantage"] },
      limits: {},
    };
    const combined = meet(parent, other);
    expect(combined.actions).toEqual(["payment.execute"]);
    expect(combined.audience).toEqual(["bank:api"]);
    expect(combined.counterparties).toEqual({ allow: ["Kalyani"] });
  });

  it("keeps the tighter monetary limit", () => {
    const other: Scope = { ...parent, limits: { perAction: inr(50_000) } };
    expect(meet(parent, other).limits.perAction).toEqual(inr(50_000));
  });

  it("keeps a limit that only one side sets", () => {
    const unlimited: Scope = { ...parent, limits: {} };
    expect(meet(unlimited, parent).limits.perAction).toEqual(inr(500_000));
  });

  it("holds the tighter value even when a chain widens illegally", () => {
    const widened: Scope = { ...parent, limits: { perAction: inr(9_000_000) } };
    expect(effectiveScope([parent, widened]).limits.perAction).toEqual(inr(500_000));
  });
});
