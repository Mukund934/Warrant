import { describe, expect, it } from "vitest";
import {
  assess,
  buildEvidencePack,
  digestOf,
  ledgerEntryDigest,
  evaluate,
  issueRootMandate,
  signActionRequest,
  signApproval,
  signDetached,
  signerFromJwk,
  verifyEvidencePack,
} from "../src/index.js";
import type {
  ActionRequest,
  Approval,
  LegalPerson,
  Mandate,
  RevocationSnapshot,
  Scope,
} from "../src/index.js";
import { apAgentKey, gateKey, ledgerKey, principalKey } from "../src/fixtures/keys.js";
import {
  KALYANI,
  TIMELINE,
  apAgent,
  inr,
  organisation,
  priyaSharma,
  rootScope,
} from "../src/fixtures/parties.js";
import { trustRoots } from "../src/fixtures/index.js";

const principalSigner = signerFromJwk(principalKey.keyId, principalKey.privateKeyJwk);
const apSigner = signerFromJwk(apAgentKey.keyId, apAgentKey.privateKeyJwk);
const recorder = signerFromJwk(ledgerKey.keyId, ledgerKey.privateKeyJwk);
const gateSigner = signerFromJwk(gateKey.keyId, gateKey.privateKeyJwk);

const ERP = rootScope.audience[0]!;
const NEEDS_APPROVAL: Scope = { ...rootScope, approval: { above: inr(200_000) } };

// A second named human who happens to hold the principal key in this demonstration.
const rahul: LegalPerson = {
  kind: "legal_person",
  id: "person:rahul-menon",
  name: "Rahul Menon",
  role: "Chief Financial Officer",
  legalEntity: "Meridian Technologies Pvt Ltd",
  identifier: "DIN 07781234",
  keyId: principalKey.keyId,
};

async function emptyRevocation(): Promise<RevocationSnapshot> {
  const body = { asOf: TIMELINE.evaluatedAt, revoked: [] };
  return { ...body, proof: await signDetached(body, recorder, body.asOf) };
}

async function root(): Promise<Mandate> {
  return issueRootMandate(
    {
      id: "mnd_root_fa1",
      organisation,
      liablePrincipal: priyaSharma,
      subject: apAgent,
      scope: NEEDS_APPROVAL,
      maxDelegationDepth: 1,
      notBefore: TIMELINE.rootNotBefore,
      expiresAt: TIMELINE.rootExpiresAt,
      issuedAt: TIMELINE.rootIssuedAt,
    },
    principalSigner,
  );
}

async function requestFor(amount: number, nonce: string): Promise<ActionRequest> {
  return signActionRequest(
    {
      id: `req_fa1_${nonce}`,
      nonce: `nonce-fa1-${nonce}`,
      actor: apAgent.id,
      action: "payment.execute",
      resource: ERP,
      counterparty: KALYANI,
      description: "Invoice settlement needing sign-off",
      requestedAt: TIMELINE.evaluatedAt,
      amount: inr(amount),
    },
    apSigner,
  );
}

async function approvalFor(
  request: ActionRequest,
  approver: LegalPerson = rahul,
): Promise<Approval> {
  return signApproval(
    { id: "apr_fa1", request, approver, approvedAt: TIMELINE.evaluatedAt, note: "Checked the invoice" },
    principalSigner,
  );
}

async function outcomeFor(request: ActionRequest, approval?: Approval) {
  return assess(request, [await root()], {
    trustRoots,
    revocation: await emptyRevocation(),
    inputs: { evaluatedAt: TIMELINE.evaluatedAt, replayStatus: "fresh" },
    ...(approval ? { approval } : {}),
  });
}

describe("an action that needs approval, without one", () => {
  it("escalates, as it always did", async () => {
    const outcome = await outcomeFor(await requestFor(400_000, "none"));

    expect(outcome.verdict).toBe("ESCALATE");
    expect(outcome.checks.find((check) => check.id === "policy.escalation")?.status).toBe("warn");
    expect(outcome.checks.find((check) => check.id === "approval.binding")).toBeUndefined();
  });

  it("is unaffected below the threshold", async () => {
    const outcome = await outcomeFor(await requestFor(100_000, "under"));
    expect(outcome.verdict).toBe("ALLOW");
  });
});

describe("an approval bound to the exact action", () => {
  it("satisfies the requirement and the action proceeds", async () => {
    const request = await requestFor(400_000, "ok");
    const outcome = await outcomeFor(request, await approvalFor(request));

    expect(outcome.verdict).toBe("ALLOW");
    expect(outcome.checks.find((check) => check.id === "approval.binding")?.status).toBe("pass");
    expect(outcome.checks.find((check) => check.id === "approval.signature")?.status).toBe("pass");
    expect(outcome.checks.find((check) => check.id === "approval.second_human")?.status).toBe("pass");

    const escalation = outcome.checks.find((check) => check.id === "policy.escalation");
    expect(escalation?.status).toBe("pass");
    expect(escalation?.detail).toMatch(/Rahul Menon approved this exact action/);
  });

  it("cannot be moved to a different action", async () => {
    const approved = await requestFor(400_000, "approved");
    const other = await requestFor(900_000, "other");

    const outcome = await outcomeFor(other, await approvalFor(approved));

    expect(outcome.verdict).toBe("ESCALATE");
    const binding = outcome.checks.find((check) => check.id === "approval.binding");
    expect(binding?.status).toBe("fail");
    expect(binding?.detail).toMatch(/not transferable between actions/);
  });

  it("is refused when the approver is the person already accountable", async () => {
    const request = await requestFor(400_000, "self");
    const outcome = await outcomeFor(request, await approvalFor(request, priyaSharma));

    expect(outcome.verdict).toBe("ESCALATE");
    const second = outcome.checks.find((check) => check.id === "approval.second_human");
    expect(second?.status).toBe("fail");
    expect(second?.detail).toMatch(/nothing was independently checked/);
  });

  it("is refused when signed by a key that is not the approver's", async () => {
    const request = await requestFor(400_000, "wrongkey");
    const forged = await signApproval(
      { id: "apr_forged", request, approver: rahul, approvedAt: TIMELINE.evaluatedAt },
      apSigner,
    );

    const outcome = await outcomeFor(request, forged);

    expect(outcome.verdict).toBe("ESCALATE");
    expect(outcome.checks.find((check) => check.id === "approval.signature")?.status).toBe("fail");
  });

  it("is refused when its contents are edited after signing", async () => {
    const request = await requestFor(400_000, "tampered");
    const approval = await approvalFor(request);
    const edited: Approval = {
      ...approval,
      approver: { ...approval.approver, name: "Someone Else" },
    };

    const outcome = await outcomeFor(request, edited);

    expect(outcome.verdict).toBe("ESCALATE");
    expect(outcome.checks.find((check) => check.id === "approval.signature")?.status).toBe("fail");
  });

  it("does not rescue an action that fails for another reason", async () => {
    const request = await signActionRequest(
      {
        id: "req_fa1_outofscope",
        nonce: "nonce-fa1-outofscope",
        actor: apAgent.id,
        action: "payment.execute",
        resource: "erp:someone-else/ledger",
        counterparty: KALYANI,
        description: "Outside the delegated audience",
        requestedAt: TIMELINE.evaluatedAt,
        amount: inr(400_000),
      },
      apSigner,
    );

    const outcome = await outcomeFor(request, await approvalFor(request));

    expect(outcome.verdict).toBe("BLOCK");
    expect(outcome.checks.find((check) => check.id === "audience.binding")?.status).toBe("fail");
  });
});

describe("the approval travels with the evidence and is checked by the verifier", () => {
  async function packFor(request: ActionRequest, approval?: Approval) {
    const chain = [await root()];
    const decision = await evaluate(
      request,
      chain,
      {
        trustRoots,
        revocation: await emptyRevocation(),
        inputs: { evaluatedAt: TIMELINE.evaluatedAt, replayStatus: "fresh" },
        ...(approval ? { approval } : {}),
      },
      { id: "gate:warrant/test", signer: gateSigner },
    );

    const body = {
      seq: 0,
      prevDigest: "warrant/ledger/v0.1/genesis",
      type: "decision.recorded" as const,
      recordedAt: TIMELINE.evaluatedAt,
      ref: decision.id,
      payloadDigest: await digestOf(decision),
    };
    const entry = { ...body, digest: await ledgerEntryDigest(body) };
    const head = {
      seq: 0,
      digest: entry.digest,
      entryCount: 1,
      signedAt: TIMELINE.evaluatedAt,
    };

    return buildEvidencePack(
      {
        packId: "pack_fa1",
        generatedAt: TIMELINE.evaluatedAt,
        generatedBy: "Warrant test",
        request,
        chain,
        decision,
        ledger: {
          entries: [entry],
          head: { ...head, proof: await signDetached(head, recorder, TIMELINE.evaluatedAt) },
        },
        revocation: await emptyRevocation(),
        ...(approval ? { approval } : {}),
        trustRoots,
      },
      recorder,
    );
  }

  it("reproduces ALLOW offline from the approval inside the pack", async () => {
    const request = await requestFor(400_000, "pack");
    const pack = await packFor(request, await approvalFor(request));

    expect(pack.approval).toBeDefined();

    const report = await verifyEvidencePack(pack, { trustRoots });
    expect(report.result).toBe("VERIFIED");
    expect(report.authority?.verdict).toBe("ALLOW");
    expect(report.authority?.reproduced).toBe(true);
    expect(
      report.authority?.checks.find((check) => check.id === "approval.signature")?.status,
    ).toBe("pass");
  });

  it("stops reproducing if the approval is stripped from the pack", async () => {
    const request = await requestFor(400_000, "stripped");
    const pack = await packFor(request, await approvalFor(request));

    const { approval, ...withoutApproval } = pack;
    const report = await verifyEvidencePack(withoutApproval, { trustRoots });

    expect(report.authority?.reproduced).toBe(false);
    expect(report.result).toBe("INVALID");
  });

  it("leaves a pack that never needed an approval free of the field", async () => {
    const pack = await packFor(await requestFor(100_000, "noapproval"));

    expect(pack.approval).toBeUndefined();
    expect("approval" in pack).toBe(false);
    expect((await verifyEvidencePack(pack, { trustRoots })).result).toBe("VERIFIED");
  });
});
