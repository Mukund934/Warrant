import { describe, expect, it } from "vitest";
import { diffChain, diffScope, narrows } from "../src/index.js";
import type { AuthorityChange, Scope } from "../src/index.js";
import { demoScenarios } from "../src/fixtures/index.js";
import { KALYANI, NAGPUR, SUNDARAM, inr, rootScope } from "../src/fixtures/parties.js";

const ERP = rootScope.audience[0]!;
const BANK = rootScope.audience[1]!;

const KNOWN_FIELDS = new Set([
  "actions",
  "audience",
  "counterparties",
  "limits.perAction",
  "limits.perPeriod",
  "approval",
  "purpose",
]);

const changeFor = (changes: AuthorityChange[], field: string): AuthorityChange | undefined =>
  changes.find((change) => change.field === field);

const fieldsMoving = (changes: AuthorityChange[], direction: string): string[] =>
  changes.filter((change) => change.direction === direction).map((change) => change.field).sort();

const bare: Scope = {
  actions: ["payment.execute"],
  audience: [ERP],
  counterparties: { any: true },
  limits: {},
};

describe("a hop that narrows", () => {
  const parent: Scope = {
    actions: ["invoice.read", "payment.approve", "payment.execute"],
    audience: [ERP, BANK],
    counterparties: { allow: [KALYANI, SUNDARAM, NAGPUR] },
    limits: { perAction: inr(1_000_000), perPeriod: { amount: inr(4_000_000), days: 30 } },
    approval: { above: inr(500_000) },
    purpose: "Settlement of approved supplier invoices",
  };

  const child: Scope = {
    actions: ["payment.execute"],
    audience: [ERP],
    counterparties: { allow: [KALYANI] },
    limits: { perAction: inr(200_000), perPeriod: { amount: inr(1_000_000), days: 30 } },
    approval: { above: inr(100_000) },
    purpose: "Settlement of approved supplier invoices",
  };

  it("names exactly what each field lost", () => {
    const changes = diffScope(parent, child);

    expect(changeFor(changes, "actions")?.removed).toEqual(["invoice.read", "payment.approve"]);
    expect(changeFor(changes, "actions")?.summary).toBe("dropped invoice.read and payment.approve");
    expect(changeFor(changes, "audience")?.removed).toEqual([BANK]);
    expect(changeFor(changes, "counterparties")?.removed).toEqual([SUNDARAM, NAGPUR]);
  });

  it("says which way each limit moved, in money a person can read", () => {
    const changes = diffScope(parent, child);

    expect(changeFor(changes, "limits.perAction")?.summary).toMatch(/^lowered from ₹/);
    expect(changeFor(changes, "limits.perPeriod")?.summary).toMatch(/^lowered from ₹/);
    expect(changeFor(changes, "approval")?.summary).toMatch(/^tightened from approval above ₹/);
  });

  it("leaves an untouched field alone rather than inventing a change", () => {
    const changes = diffScope(parent, child);

    expect(changeFor(changes, "purpose")?.direction).toBe("unchanged");
    expect(fieldsMoving(changes, "widened")).toEqual([]);
  });

  it("reports every field, so nothing is silently omitted", () => {
    const changes = diffScope(parent, child);
    expect(new Set(changes.map((change) => change.field))).toEqual(KNOWN_FIELDS);
  });
});

describe("a hop that adds a constraint where there was none", () => {
  it("counts a new limit, a new approval requirement and a new purpose as narrowing", () => {
    const changes = diffScope(bare, {
      ...bare,
      limits: { perAction: inr(50_000), perPeriod: { amount: inr(500_000), days: 7 } },
      approval: { above: inr(10_000) },
      purpose: "Only the September reconciliation",
    });

    expect(fieldsMoving(changes, "narrowed")).toEqual([
      "approval",
      "limits.perAction",
      "limits.perPeriod",
      "purpose",
    ]);
    expect(changeFor(changes, "approval")?.summary).toMatch(/where the mandate above demanded none/);
  });

  it("narrows when an unrestricted counterparty list becomes a named one", () => {
    const changes = diffScope(bare, { ...bare, counterparties: { allow: [KALYANI] } });

    expect(changeFor(changes, "counterparties")?.direction).toBe("narrowed");
    expect(changeFor(changes, "counterparties")?.from).toBe("any counterparty");
    expect(changeFor(changes, "counterparties")?.to).toBe(KALYANI);
  });
});

describe("a hop that changes nothing", () => {
  it("says so for every field", () => {
    const changes = diffScope(rootScope, structuredClone(rootScope));

    expect(fieldsMoving(changes, "unchanged")).toEqual([...KNOWN_FIELDS].sort());
    expect(changes.every((change) => change.summary === "unchanged")).toBe(true);
  });
});

// The diff must never form its own opinion about widening. These pairs are the ones `narrows`
// refuses, and the diff has to agree with it on every one.
describe("the diff and the delegation rule cannot disagree", () => {
  const WIDENINGS: Array<{ what: string; child: Scope; field: string }> = [
    {
      what: "claims an action the parent does not hold",
      child: { ...bare, actions: ["payment.execute", "payroll.run"] },
      field: "actions",
    },
    {
      what: "claims a resource the parent does not cover",
      child: { ...bare, audience: [ERP, BANK] },
      field: "audience",
    },
    {
      what: "claims any counterparty from a named list",
      child: { ...bare, counterparties: { any: true } },
      field: "counterparties",
    },
    {
      what: "removes a per-action limit",
      child: { ...bare, limits: {} },
      field: "limits.perAction",
    },
    {
      what: "raises a per-action limit",
      child: { ...bare, limits: { perAction: inr(900_000) } },
      field: "limits.perAction",
    },
    {
      what: "removes a periodic budget",
      child: { ...bare, limits: { perAction: inr(100_000) } },
      field: "limits.perPeriod",
    },
    {
      what: "raises the rate of a periodic budget",
      child: {
        ...bare,
        limits: { perAction: inr(100_000), perPeriod: { amount: inr(400_000), days: 7 } },
      },
      field: "limits.perPeriod",
    },
    {
      what: "drops an approval requirement",
      child: { ...bare, limits: { perAction: inr(100_000) }, approval: undefined },
      field: "approval",
    },
    {
      what: "raises an approval threshold",
      child: { ...bare, limits: { perAction: inr(100_000) }, approval: { above: inr(800_000) } },
      field: "approval",
    },
    {
      what: "restates the purpose",
      child: { ...bare, limits: { perAction: inr(100_000) }, purpose: "Something else entirely" },
      field: "purpose",
    },
  ];

  const parent: Scope = {
    ...bare,
    counterparties: { allow: [KALYANI] },
    limits: { perAction: inr(100_000), perPeriod: { amount: inr(400_000), days: 30 } },
    approval: { above: inr(50_000) },
    purpose: "Settlement of approved supplier invoices",
  };

  for (const widening of WIDENINGS) {
    it(`reports a widening when the child ${widening.what}`, () => {
      const child = { ...widening.child };
      expect(narrows(child, parent).length).toBeGreaterThan(0);

      const changes = diffScope(parent, child);
      const change = changeFor(changes, widening.field);

      expect(change?.direction).toBe("widened");
      expect(change?.violation).toMatch(/^scope\//);
    });
  }

  it("classifies every refusal onto a named field, never onto a raw code", () => {
    for (const widening of WIDENINGS) {
      const fields = diffScope(parent, widening.child)
        .filter((change) => change.direction === "widened")
        .map((change) => change.field);

      for (const field of fields) expect(KNOWN_FIELDS).toContain(field);
    }
  });

  it("reports no widening at all for a pair the delegation rule accepts", () => {
    const tighter: Scope = { ...parent, actions: [], limits: { ...parent.limits } };
    expect(narrows(tighter, parent)).toEqual([]);
    expect(fieldsMoving(diffScope(parent, tighter), "widened")).toEqual([]);
  });
});

describe("a chain a relying party is holding", () => {
  const scenario = async (id: string) => {
    const found = (await demoScenarios()).find((candidate) => candidate.id === id);
    expect(found, `no scenario ${id}`).toBeDefined();
    return found!;
  };

  it("reads hop by hop, naming who handed authority to whom", async () => {
    const { pack } = await scenario("authorised-payment");
    const hops = diffChain(pack.authority.chain);

    expect(hops).toHaveLength(pack.authority.chain.length - 1);
    expect(hops[0]!.from.depth).toBe(0);
    expect(hops[0]!.to.depth).toBe(1);
    expect(hops[0]!.narrowed).toBe(true);
    expect(hops[0]!.widened).toBe(false);
  });

  it("is computable from the evidence pack alone, with nothing else to hand", async () => {
    const { pack } = await scenario("authorised-payment");
    const changed = diffChain(pack.authority.chain)[0]!.changes.filter(
      (change) => change.direction !== "unchanged",
    );

    expect(changed.length).toBeGreaterThan(0);
    expect(changed.every((change) => change.summary.length > 0)).toBe(true);
  });

  // The gate reached its conclusion at decision time by validating the chain; the diff reaches the
  // same one afterwards from the pack. Two routes to the same hop is the point.
  it("names the same hop the gate refused, and agrees on why", async () => {
    const { pack } = await scenario("delegation-escalation");
    const bad = diffChain(pack.authority.chain).filter((hop) => hop.widened);

    expect(bad).toHaveLength(1);
    expect(bad[0]!.to.subject).toBe("SETTLE-Agent-12");

    const change = bad[0]!.changes.find((entry) => entry.direction === "widened");
    expect(change?.field).toBe("limits.perAction");
    expect(change?.violation).toBe("scope/per_action_limit_exceeded");

    const narrowing = pack.decision.checks.find((check) => check.id === "chain.narrowing");
    expect(narrowing?.status).toBe("fail");
    expect(narrowing?.detail).toContain(bad[0]!.to.subject);
    expect(pack.decision.verdict).toBe("BLOCK");
  });

  it("finds no widening in any chain that was actually issued by the service", async () => {
    for (const candidate of await demoScenarios()) {
      if (candidate.id === "delegation-escalation") continue;
      expect(
        diffChain(candidate.pack.authority.chain).some((hop) => hop.widened),
        `${candidate.id} should not widen`,
      ).toBe(false);
    }
  });

  it("has no hops to report for a single mandate", () => {
    expect(diffChain([])).toEqual([]);
  });
});
