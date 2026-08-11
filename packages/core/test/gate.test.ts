import { describe, expect, it } from "vitest";
import { assess } from "../src/index.js";
import { demoScenarios, trustRoots } from "../src/fixtures/scenarios.js";

const scenarios = await demoScenarios();

describe("gate decisions across the demonstration scenarios", () => {
  for (const scenario of scenarios) {
    it(`${scenario.id} reaches ${scenario.expected}`, () => {
      expect(scenario.decision.verdict).toBe(scenario.expected);
    });

    it(`${scenario.id} fails at ${scenario.failsAt ?? "no check"}`, () => {
      const failing = scenario.decision.checks.filter((check) => check.status === "fail");
      if (scenario.failsAt === null) {
        expect(failing).toEqual([]);
      } else {
        expect(failing.map((check) => check.id)).toContain(scenario.failsAt);
      }
    });
  }
});

describe("gate decision structure", () => {
  const allowed = scenarios.find((scenario) => scenario.id === "authorised-payment")!;

  it("binds the decision to the exact request and chain", () => {
    expect(allowed.decision.requestDigest).toMatch(/^sha256:/);
    expect(allowed.decision.chainDigest).toMatch(/^sha256:/);
  });

  it("records the accountable legal person on the decision itself", () => {
    expect(allowed.decision.liablePrincipal.name).toBe("Priya Sharma");
    expect(allowed.decision.liablePrincipal.legalEntity).toBe("Meridian Technologies Pvt Ltd");
  });

  it("narrows the effective scope to the intersection of the whole chain", () => {
    expect(allowed.decision.effectiveScope.actions).toEqual(["payment.execute"]);
    expect(allowed.decision.effectiveScope.limits.perAction).toEqual({
      currency: "INR",
      minor: 50_000_000,
    });
  });

  it("runs every authority check, not only the one that fails first", () => {
    const blocked = scenarios.find((scenario) => scenario.id === "over-limit")!;
    const ids = blocked.decision.checks.map((check) => check.id);
    expect(ids).toContain("chain.signatures");
    expect(ids).toContain("chain.narrowing");
    expect(ids).toContain("actor.binding");
    expect(ids).toContain("limit.per_action");
  });

  it("holds an in-scope payment for human approval above the threshold", () => {
    const escalated = scenarios.find((scenario) => scenario.id === "human-approval")!;
    expect(escalated.decision.verdict).toBe("ESCALATE");
    expect(escalated.decision.checks.filter((check) => check.status === "fail")).toEqual([]);
    expect(escalated.decision.checks.find((check) => check.id === "policy.escalation")?.status).toBe(
      "warn",
    );
  });
});

describe("replay protection", () => {
  const allowed = scenarios.find((scenario) => scenario.id === "authorised-payment")!;

  it("blocks a request whose nonce the gate has already accepted", async () => {
    const assessment = await assess(allowed.request, allowed.chain, {
      trustRoots,
      revocation: allowed.revocation,
      inputs: { ...allowed.decision.inputs, replayStatus: "replayed" },
    });
    expect(assessment.verdict).toBe("BLOCK");
    expect(assessment.checks.find((check) => check.id === "replay.freshness")?.status).toBe("fail");
  });

  it("marks nonce freshness as unrecomputable when it is checked after the fact", async () => {
    const assessment = await assess(allowed.request, allowed.chain, {
      trustRoots,
      revocation: allowed.revocation,
      inputs: { ...allowed.decision.inputs, replayStatus: "unchecked" },
    });
    expect(assessment.verdict).toBe("ALLOW");
    expect(assessment.checks.find((check) => check.id === "replay.freshness")?.status).toBe("skip");
  });
});

describe("periodic budget", () => {
  const allowed = scenarios.find((scenario) => scenario.id === "authorised-payment")!;

  it("blocks an action that would take spend past the delegated period budget", async () => {
    const assessment = await assess(allowed.request, allowed.chain, {
      trustRoots,
      revocation: allowed.revocation,
      inputs: {
        ...allowed.decision.inputs,
        priorSpend: { currency: "INR", minor: 148_000_000 },
      },
    });
    expect(assessment.verdict).toBe("BLOCK");
    expect(assessment.checks.find((check) => check.id === "limit.per_period")?.status).toBe("fail");
  });
});
