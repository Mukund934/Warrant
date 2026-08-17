import { describe, expect, it } from "vitest";
import { assess } from "../src/index.js";
import type { EvaluationInputs } from "../src/index.js";
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

describe("request freshness", () => {
  const allowed = scenarios.find((scenario) => scenario.id === "authorised-payment")!;
  const signedAt = allowed.request.requestedAt;

  function shift(seconds: number): string {
    return new Date(new Date(signedAt).getTime() + seconds * 1000)
      .toISOString()
      .replace(/\.\d+Z$/, "Z");
  }

  async function freshnessAt(evaluatedAt: string, inputs: Partial<EvaluationInputs> = {}) {
    const assessment = await assess(allowed.request, allowed.chain, {
      trustRoots,
      revocation: allowed.revocation,
      inputs: { ...allowed.decision.inputs, evaluatedAt, ...inputs },
    });
    return {
      verdict: assessment.verdict,
      check: assessment.checks.find((check) => check.id === "request.freshness")!,
    };
  }

  it("carries the acceptance window in the signed decision inputs", () => {
    expect(allowed.decision.inputs.freshness).toEqual({ maxAgeSeconds: 300, clockSkewSeconds: 30 });
  });

  it("accepts a request presented inside the acceptance window", async () => {
    const { verdict, check } = await freshnessAt(shift(60));
    expect(check.status).toBe("pass");
    expect(verdict).toBe("ALLOW");
  });

  it("blocks a request presented long after it was signed", async () => {
    const { verdict, check } = await freshnessAt(shift(60 * 60 * 24 * 30));
    expect(check.status).toBe("fail");
    expect(verdict).toBe("BLOCK");
  });

  it("accepts a request at the exact clock-skew boundary", async () => {
    const { check } = await freshnessAt(shift(330));
    expect(check.status).toBe("pass");
  });

  it("blocks a request one second past the clock-skew boundary", async () => {
    const { check } = await freshnessAt(shift(331));
    expect(check.status).toBe("fail");
  });

  it("tolerates a future-dated request inside the skew allowance", async () => {
    const { verdict, check } = await freshnessAt(shift(-30));
    expect(check.status).toBe("pass");
    expect(verdict).toBe("ALLOW");
  });

  it("blocks a request dated further into the future than the skew allowance", async () => {
    const { verdict, check } = await freshnessAt(shift(-31));
    expect(check.status).toBe("fail");
    expect(verdict).toBe("BLOCK");
  });

  it("blocks rather than passes when a timestamp cannot be read as a date", async () => {
    const { verdict, check } = await freshnessAt("the twentieth of August");
    expect(check.status).toBe("fail");
    expect(verdict).toBe("BLOCK");
  });

  it("records that freshness was not enforced when no window was supplied", async () => {
    const inputs: EvaluationInputs = { ...allowed.decision.inputs };
    delete inputs.freshness;
    const assessment = await assess(allowed.request, allowed.chain, {
      trustRoots,
      revocation: allowed.revocation,
      inputs,
    });
    const check = assessment.checks.find((entry) => entry.id === "request.freshness")!;
    expect(check.status).toBe("skip");
    expect(assessment.verdict).toBe("ALLOW");
  });

  it("reproduces the same freshness verdict from the decision's own recorded inputs", async () => {
    const stale = shift(60 * 60 * 24 * 30);
    const first = await freshnessAt(stale);
    const second = await freshnessAt(stale);
    expect(second.check).toEqual(first.check);
    expect(second.verdict).toBe(first.verdict);
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
