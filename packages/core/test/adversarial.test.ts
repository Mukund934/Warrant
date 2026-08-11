import { describe, expect, it } from "vitest";
import {
  Ledger,
  buildEvidencePack,
  createKeyPair,
  delegateMandate,
  evaluate,
  issueRootMandate,
  signDetached,
  verifyEvidencePack,
} from "../src/index.js";
import type { EvidencePack, TrustRoot } from "../src/index.js";
import { demoScenarios, trustRoots } from "../src/fixtures/scenarios.js";
import { KALYANI, TIMELINE, inr, organisation, priyaSharma, rootScope } from "../src/fixtures/parties.js";

const scenarios = await demoScenarios();
const allowed = scenarios.find((scenario) => scenario.id === "authorised-payment")!;
const escalation = scenarios.find((scenario) => scenario.id === "delegation-escalation")!;

const verifiedAt = "2026-08-21T09:00:00Z";
const clone = (pack: EvidencePack): EvidencePack => structuredClone(pack);
const failing = (checks: { id: string; status: string }[]) =>
  checks.filter((check) => check.status === "fail").map((check) => check.id);

describe("attacks on the authority chain", () => {
  it("refuses a chain with the middle hop cut out", async () => {
    const pack = clone(escalation.pack);
    pack.authority.chain.splice(1, 1);
    const report = await verifyEvidencePack(pack, { trustRoots, verifiedAt });
    expect(report.result).toBe("INVALID");
    expect(failing(report.checks)).toContain("chain.sequence");
  });

  it("refuses a chain whose leaf has been dropped to promote a wider mandate", async () => {
    const pack = clone(allowed.pack);
    pack.authority.chain.pop();
    const report = await verifyEvidencePack(pack, { trustRoots, verifiedAt });
    expect(report.result).toBe("INVALID");
    expect(failing(report.checks)).toContain("decision.chain_binding");
  });

  it("records a validly signed escalation as evidence of a block, not as a broken pack", async () => {
    const report = await verifyEvidencePack(escalation.pack, { trustRoots, verifiedAt });
    expect(report.result).toBe("VERIFIED");
    expect(report.authority?.verdict).toBe("BLOCK");
    expect(report.authority?.reproduced).toBe(true);
    expect(failing(report.authority?.checks ?? [])).toContain("chain.narrowing");
  });

  it("refuses a decision signed by a key that is not registered as a gate", async () => {
    const principal = trustRoots.find((root) => root.role === "principal")!;
    const pack = clone(allowed.pack);
    pack.decision.proof.verificationMethod = principal.keyId;
    const report = await verifyEvidencePack(pack, { trustRoots, verifiedAt });
    expect(report.result).toBe("INVALID");
    expect(failing(report.checks)).toContain("decision.signature");
  });

  it("refuses a mandate whose stated issuer is not the key that signed it", async () => {
    const pack = clone(allowed.pack);
    const otherKey = trustRoots.find((root) => root.role === "gate")!;
    pack.authority.chain[0]!.issuer.keyId = otherKey.keyId;
    const report = await verifyEvidencePack(pack, { trustRoots, verifiedAt });
    expect(report.result).toBe("INVALID");
    expect(failing(report.checks)).toContain("chain.signatures");
  });

  it("refuses a reordered ledger", async () => {
    const pack = clone(allowed.pack);
    const entries = pack.ledger.entries;
    [entries[0], entries[1]] = [entries[1]!, entries[0]!];
    const report = await verifyEvidencePack(pack, { trustRoots, verifiedAt });
    expect(report.result).toBe("INVALID");
    expect(failing(report.checks)).toContain("ledger.continuity");
  });

  it("refuses a revocation snapshot backdated after signing", async () => {
    const pack = clone(allowed.pack);
    pack.revocation.asOf = "2026-08-21T00:00:00Z";
    const report = await verifyEvidencePack(pack, { trustRoots, verifiedAt });
    expect(report.result).toBe("INVALID");
    expect(failing(report.checks)).toContain("revocation.snapshot");
  });
});

describe("a pack forged end to end under the attacker's own keys", () => {
  async function forgePack(): Promise<{ pack: EvidencePack; roots: TrustRoot[] }> {
    const fakePrincipal = await createKeyPair("Priya Sharma, Head of Finance", "principal");
    const fakeAgent = await createKeyPair("PAY-Agent-07", "agent");
    const fakeGate = await createKeyPair("Warrant Gate", "gate");
    const fakeRecorder = await createKeyPair("Warrant recording service", "ledger");

    const roots: TrustRoot[] = [fakePrincipal, fakeAgent, fakeGate, fakeRecorder].map((key) => ({
      keyId: key.keyId,
      subject: key.subject,
      role: key.role,
      publicKeyJwk: key.publicKeyJwk,
    }));

    const principal = { ...priyaSharma, keyId: fakePrincipal.keyId };
    const agent = {
      kind: "agent" as const,
      id: "agent:pay-agent-07",
      name: "PAY-Agent-07",
      runtime: "Payment execution agent, MCP runtime",
      keyId: fakeAgent.keyId,
    };

    const root = await issueRootMandate(
      {
        id: "mnd_root_forged",
        organisation,
        liablePrincipal: principal,
        subject: agent,
        scope: rootScope,
        maxDelegationDepth: 1,
        notBefore: TIMELINE.rootNotBefore,
        expiresAt: TIMELINE.rootExpiresAt,
        issuedAt: TIMELINE.rootIssuedAt,
      },
      { keyId: fakePrincipal.keyId, privateKeyJwk: fakePrincipal.privateKeyJwk },
    );

    const revocationBody = { asOf: TIMELINE.revocationAsOf, revoked: [] };
    const revocation = {
      ...revocationBody,
      proof: await signDetached(
        revocationBody,
        { keyId: fakeRecorder.keyId, privateKeyJwk: fakeRecorder.privateKeyJwk },
        TIMELINE.revocationAsOf,
      ),
    };

    const request = {
      id: "req_forged",
      nonce: "n-forged-0000dead",
      actor: agent.id,
      action: "payment.execute",
      resource: "bank:hdfc/corporate-api",
      counterparty: KALYANI,
      amount: inr(900_000),
      description: "supplier invoice MTPL/2026/08/9999",
      requestedAt: TIMELINE.evaluatedAt,
    };

    const decision = await evaluate(
      request,
      [root],
      {
        trustRoots: roots,
        revocation,
        inputs: { evaluatedAt: TIMELINE.evaluatedAt, replayStatus: "fresh" },
      },
      { id: "gate:forged", signer: { keyId: fakeGate.keyId, privateKeyJwk: fakeGate.privateKeyJwk } },
    );

    const ledger = new Ledger();
    await ledger.append("mandate.issued", root.id, root, root.issuedAt);
    await ledger.append("action.requested", request.id, request, request.requestedAt);
    await ledger.append("decision.recorded", decision.id, decision, decision.evaluatedAt);
    const head = await ledger.signHead(
      { keyId: fakeRecorder.keyId, privateKeyJwk: fakeRecorder.privateKeyJwk },
      TIMELINE.recordedAt,
    );

    const pack = await buildEvidencePack(
      {
        packId: "pack_forged",
        generatedAt: TIMELINE.packGeneratedAt,
        generatedBy: "Warrant demonstrator, recording service for Meridian Technologies Pvt Ltd",
        request,
        chain: [root],
        decision,
        ledger: { entries: ledger.all, head },
        revocation,
        trustRoots: roots,
      },
      { keyId: fakeRecorder.keyId, privateKeyJwk: fakeRecorder.privateKeyJwk },
    );

    return { pack, roots };
  }

  it("passes when checked only against the keys it carries, and says so", async () => {
    const { pack } = await forgePack();
    const report = await verifyEvidencePack(pack, { verifiedAt });
    expect(report.result).toBe("VERIFIED");
    expect(report.trustRootSource).toBe("embedded");
    expect(report.checks.find((check) => check.id === "trust.roots")?.status).toBe("warn");
    expect(report.limitations[0]).toMatch(/not that it came from the organisation it names/);
  });

  it("fails the moment the real organisation's published keys are used", async () => {
    const { pack } = await forgePack();
    const report = await verifyEvidencePack(pack, { trustRoots, verifiedAt });
    expect(report.result).toBe("INVALID");
    expect(failing(report.checks)).toContain("pack.signature");
    expect(failing(report.checks)).toContain("chain.signatures");
    expect(failing(report.checks)).toContain("decision.signature");
  });
});
