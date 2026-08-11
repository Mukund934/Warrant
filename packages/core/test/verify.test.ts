import { describe, expect, it } from "vitest";
import { verifyEvidencePack } from "../src/index.js";
import type { EvidencePack, TrustRoot } from "../src/index.js";
import { demoScenarios, trustRoots } from "../src/fixtures/scenarios.js";
import { createKeyPair } from "../src/keys.js";

const scenarios = await demoScenarios();
const allowed = scenarios.find((scenario) => scenario.id === "authorised-payment")!;
const blocked = scenarios.find((scenario) => scenario.id === "over-limit")!;

const verifiedAt = "2026-08-21T09:00:00Z";
const clone = (pack: EvidencePack): EvidencePack => JSON.parse(JSON.stringify(pack)) as EvidencePack;
const failing = (checks: { id: string; status: string }[]) =>
  checks.filter((check) => check.status === "fail").map((check) => check.id);

describe("offline verification of an untouched pack", () => {
  it("verifies with independently supplied keys", async () => {
    const report = await verifyEvidencePack(allowed.pack, { trustRoots, verifiedAt });
    expect(report.result).toBe("VERIFIED");
    expect(report.trustRootSource).toBe("independent");
    expect(failing(report.checks)).toEqual([]);
  });

  it("reproduces the recorded verdict without contacting the issuing service", async () => {
    const report = await verifyEvidencePack(allowed.pack, { trustRoots, verifiedAt });
    const reproduced = report.checks.find((check) => check.id === "decision.reproducible");
    expect(reproduced?.status).toBe("pass");
  });

  it("treats a pack recording a blocked action as valid evidence", async () => {
    const report = await verifyEvidencePack(blocked.pack, { trustRoots, verifiedAt });
    expect(report.result).toBe("VERIFIED");
    expect(report.summary?.verdict).toBe("BLOCK");
  });

  it("warns when the only keys available came from the pack itself", async () => {
    const report = await verifyEvidencePack(allowed.pack, { verifiedAt });
    expect(report.result).toBe("VERIFIED");
    expect(report.trustRootSource).toBe("embedded");
    expect(report.checks.find((check) => check.id === "trust.roots")?.status).toBe("warn");
    expect(report.limitations[0]).toMatch(/read from the pack itself/);
  });

  it("states what offline verification cannot establish", async () => {
    const report = await verifyEvidencePack(allowed.pack, { trustRoots, verifiedAt });
    expect(report.limitations.join(" ")).toMatch(/revoked after that moment/);
    expect(report.limitations.join(" ")).toMatch(/nonce/);
    expect(report.limitations.join(" ")).toMatch(/transparency log/);
  });
});

describe("tamper detection", () => {
  it("catches a changed payment amount", async () => {
    const pack = clone(allowed.pack);
    pack.request.amount = { currency: "INR", minor: 420_000_000 };
    const report = await verifyEvidencePack(pack, { trustRoots, verifiedAt });
    expect(report.result).toBe("INVALID");
    expect(failing(report.checks)).toContain("decision.request_binding");
    expect(failing(report.checks)).toContain("pack.digest");
    expect(failing(report.checks)).toContain("pack.signature");
  });

  it("catches a widened limit inside a mandate", async () => {
    const pack = clone(allowed.pack);
    pack.authority.chain[1]!.scope.limits.perAction = { currency: "INR", minor: 900_000_000 };
    const report = await verifyEvidencePack(pack, { trustRoots, verifiedAt });
    expect(report.result).toBe("INVALID");
    expect(failing(report.checks)).toContain("chain.signatures");
    expect(failing(report.checks)).toContain("decision.chain_binding");
  });

  it("catches a flipped verdict", async () => {
    const pack = clone(blocked.pack);
    pack.decision.verdict = "ALLOW";
    pack.summary.verdict = "ALLOW";
    const report = await verifyEvidencePack(pack, { trustRoots, verifiedAt });
    expect(report.result).toBe("INVALID");
    expect(failing(report.checks)).toContain("decision.signature");
    expect(failing(report.checks)).toContain("decision.reproducible");
  });

  it("catches a rewritten check result inside the decision", async () => {
    const pack = clone(blocked.pack);
    const check = pack.decision.checks.find((item) => item.id === "limit.per_action")!;
    check.status = "pass";
    check.detail = "within the delegated limit";
    const report = await verifyEvidencePack(pack, { trustRoots, verifiedAt });
    expect(report.result).toBe("INVALID");
    expect(failing(report.checks)).toContain("decision.signature");
  });

  it("catches a summary that disagrees with the signed decision", async () => {
    const pack = clone(blocked.pack);
    pack.summary.verdict = "ALLOW";
    const report = await verifyEvidencePack(pack, { trustRoots, verifiedAt });
    expect(report.result).toBe("INVALID");
    expect(failing(report.checks)).toContain("pack.consistency");
  });

  it("catches a renamed accountable person in the readable summary", async () => {
    const pack = clone(allowed.pack);
    pack.authority.liablePrincipal.name = "A. Nother";
    const report = await verifyEvidencePack(pack, { trustRoots, verifiedAt });
    expect(report.result).toBe("INVALID");
    expect(failing(report.checks)).toContain("pack.consistency");
  });

  it("catches a removed ledger entry", async () => {
    const pack = clone(allowed.pack);
    pack.ledger.entries.splice(1, 1);
    const report = await verifyEvidencePack(pack, { trustRoots, verifiedAt });
    expect(report.result).toBe("INVALID");
    expect(failing(report.checks)).toContain("ledger.continuity");
  });

  it("catches an edited ledger entry", async () => {
    const pack = clone(allowed.pack);
    pack.ledger.entries[2]!.recordedAt = "2026-08-20T09:00:00Z";
    const report = await verifyEvidencePack(pack, { trustRoots, verifiedAt });
    expect(report.result).toBe("INVALID");
    expect(failing(report.checks)).toContain("ledger.continuity");
  });

  it("catches a scrubbed revocation entry", async () => {
    const revoked = scenarios.find((scenario) => scenario.id === "revoked-mandate")!;
    const pack = clone(revoked.pack);
    pack.revocation.revoked = [];
    const report = await verifyEvidencePack(pack, { trustRoots, verifiedAt });
    expect(report.result).toBe("INVALID");
    expect(failing(report.checks)).toContain("revocation.snapshot");
    expect(failing(report.checks)).toContain("decision.reproducible");
  });

  it("catches a pack presented under keys that are not the issuer's", async () => {
    const impostor = await createKeyPair("Impostor Ltd", "ledger");
    const substituted: TrustRoot[] = trustRoots.map((root) =>
      root.role === "ledger"
        ? { ...root, publicKeyJwk: impostor.publicKeyJwk }
        : root,
    );
    const report = await verifyEvidencePack(allowed.pack, {
      trustRoots: substituted,
      verifiedAt,
    });
    expect(report.result).toBe("INVALID");
    expect(failing(report.checks)).toContain("pack.signature");
  });

  it("refuses a pack that is not a Warrant pack at all", async () => {
    const report = await verifyEvidencePack({ hello: "world" }, { trustRoots, verifiedAt });
    expect(report.result).toBe("INVALID");
    expect(report.summary).toBeNull();
    expect(failing(report.checks)).toEqual(["pack.structure"]);
  });
});
