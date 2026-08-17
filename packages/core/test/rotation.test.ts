import { describe, expect, it } from "vitest";
import { keyLifecycleFault, verifyEvidencePack } from "../src/index.js";
import type { TrustRoot } from "../src/index.js";
import { demoScenarios, trustRoots } from "../src/fixtures/scenarios.js";

const scenarios = await demoScenarios();
const pack = scenarios.find((scenario) => scenario.id === "authorised-payment")!.pack;

const BEFORE_ANYTHING = "2026-07-01T00:00:00Z";
const MID_TIMELINE = "2026-08-10T00:00:00Z";
const AFTER_EVERYTHING = "2026-12-31T23:59:59Z";

function withLifecycle(patch: Partial<TrustRoot>): TrustRoot[] {
  return trustRoots.map((root) => ({ ...root, ...patch }));
}

describe("a key that carries no lifecycle behaves exactly as before", () => {
  it("verifies a pack", async () => {
    const report = await verifyEvidencePack(pack, { trustRoots });
    expect(report.result).toBe("VERIFIED");
  });

  it("reports no lifecycle fault", () => {
    expect(keyLifecycleFault(trustRoots[0]!, "2026-08-20T14:32:07Z")).toBeUndefined();
  });
});

describe("retirement does not invalidate evidence the key already signed", () => {
  it("still verifies a pack signed while the key was active", async () => {
    const retiredLater = withLifecycle({
      status: "retired",
      signingFrom: BEFORE_ANYTHING,
      signingUntil: AFTER_EVERYTHING,
    });
    const report = await verifyEvidencePack(pack, { trustRoots: retiredLater });
    expect(report.result).toBe("VERIFIED");
    expect(report.authority?.reproduced).toBe(true);
  });

  it("is the point of the feature: a retired key keeps its history verifiable", async () => {
    const longRetired = withLifecycle({
      status: "retired",
      signingUntil: AFTER_EVERYTHING,
      acceptUntil: "2030-01-01T00:00:00Z",
    });
    const report = await verifyEvidencePack(pack, { trustRoots: longRetired });
    expect(report.result).toBe("VERIFIED");
  });
});

describe("a retired key cannot sign anything new", () => {
  it("refuses a proof created after the key stopped signing", async () => {
    const retiredEarly = withLifecycle({ status: "retired", signingUntil: MID_TIMELINE });
    const report = await verifyEvidencePack(pack, { trustRoots: retiredEarly });
    expect(report.result).toBe("INVALID");
    const failed = report.checks.filter((check) => check.status === "fail");
    expect(failed.length).toBeGreaterThan(0);
    expect(failed.map((check) => check.detail).join(" ")).toMatch(/already been retired/);
  });

  it("names the key and the moment it stopped signing", () => {
    const fault = keyLifecycleFault(
      { ...trustRoots[0]!, signingUntil: MID_TIMELINE },
      "2026-08-20T14:32:07Z",
    );
    expect(fault).toContain(trustRoots[0]!.keyId);
    expect(fault).toContain(MID_TIMELINE);
  });
});

describe("pre-rotation: a published key is not yet a usable key", () => {
  it("refuses a proof created before the key was allowed to sign", async () => {
    const notYet = withLifecycle({ status: "next", signingFrom: AFTER_EVERYTHING });
    const report = await verifyEvidencePack(pack, { trustRoots: notYet });
    expect(report.result).toBe("INVALID");
    expect(
      report.checks
        .filter((check) => check.status === "fail")
        .map((check) => check.detail)
        .join(" "),
    ).toMatch(/published but not yet in use/);
  });

  it("lets a key be distributed before it is trusted to sign", () => {
    const next: TrustRoot = { ...trustRoots[0]!, status: "next", signingFrom: AFTER_EVERYTHING };
    expect(keyLifecycleFault(next, MID_TIMELINE)).toMatch(/not yet in use/);
    expect(keyLifecycleFault(next, "2027-06-01T00:00:00Z")).toBeUndefined();
  });
});

describe("lifecycle edges", () => {
  it("accepts a proof signed exactly at the boundary in either direction", () => {
    const root = { ...trustRoots[0]!, signingFrom: MID_TIMELINE, signingUntil: AFTER_EVERYTHING };
    expect(keyLifecycleFault(root, MID_TIMELINE)).toBeUndefined();
    expect(keyLifecycleFault(root, AFTER_EVERYTHING)).toBeUndefined();
  });

  it("refuses a proof whose creation time cannot be read as a date", () => {
    expect(keyLifecycleFault(trustRoots[0]!, "sometime last Tuesday")).toMatch(/cannot be read as a date/);
  });

  it("does not reject on acceptUntil, because evidence must not expire", () => {
    const root = { ...trustRoots[0]!, acceptUntil: "2026-01-01T00:00:00Z" };
    expect(keyLifecycleFault(root, "2026-08-20T14:32:07Z")).toBeUndefined();
  });
});
