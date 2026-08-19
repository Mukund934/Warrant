import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import {
  signActionRequest,
  signApproval,
  signerFromJwk,
  verifyEvidencePack,
} from "@warrant/core";
import type {
  ActionRequest,
  Approval,
  EvidencePack,
  LegalPerson,
  Mandate,
  Scope,
} from "@warrant/core";
import { apAgent, apAgentKey, principalKey, priyaSharma, trustRoots } from "@warrant/core/fixtures";
import { createApp } from "../src/app.js";

const inr = (major: number) => ({ currency: "INR" as const, minor: major * 100 });

const ERP = "erp:meridian/accounts-payable";
const KALYANI = "Kalyani Steel Works";

const principalSigner = signerFromJwk(principalKey.keyId, principalKey.privateKeyJwk);
const apSigner = signerFromJwk(apAgentKey.keyId, apAgentKey.privateKeyJwk);

// A second named human. The fixture key set holds one principal key, so Rahul signs with it; the
// second-human rule compares people, not keys. A real deployment gives each approver their own.
const rahul: LegalPerson = {
  kind: "legal_person",
  id: "person:rahul-menon",
  name: "Rahul Menon",
  role: "Chief Financial Officer",
  legalEntity: "Meridian Technologies Pvt Ltd",
  identifier: "DIN 07781234",
  keyId: principalKey.keyId,
};

const NEEDS_APPROVAL: Scope = {
  actions: ["payment.execute"],
  audience: [ERP],
  counterparties: { allow: [KALYANI] },
  limits: { perAction: inr(2_000_000) },
  approval: { above: inr(200_000) },
};

const validity = { notBefore: "2026-01-01T00:00:00Z", expiresAt: "2027-01-01T00:00:00Z" };

let app: Express;
let counter = 0;
const unique = () => (counter += 1).toString().padStart(6, "0");

beforeEach(() => {
  app = createApp();
});

async function mandateNeedingApproval(): Promise<string> {
  const response = await request(app)
    .post("/v1/mandates")
    .send({ scope: NEEDS_APPROVAL, ...validity, maxDelegationDepth: 1 })
    .expect(201);
  return (response.body as Mandate).id;
}

async function agentSigned(major: number, resource = ERP): Promise<ActionRequest> {
  const id = unique();
  return signActionRequest(
    {
      id: `req_approval_${id}`,
      nonce: `nonce-approval-${id}`,
      actor: apAgent.id,
      action: "payment.execute",
      resource,
      counterparty: KALYANI,
      description: "Invoice needing sign-off",
      requestedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
      amount: inr(major),
    },
    apSigner,
  );
}

async function approvalFor(
  target: ActionRequest,
  approver: LegalPerson = rahul,
  signer = principalSigner,
): Promise<Approval> {
  return signApproval(
    {
      id: `apr_${unique()}`,
      request: target,
      approver,
      approvedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    },
    signer,
  );
}

function present(mandateId: string, action: ActionRequest, approval?: Approval) {
  return request(app)
    .post("/v1/actions/signed")
    .send({ mandateId, request: action, ...(approval ? { approval } : {}) });
}

const statusOf = (checks: Array<{ id: string; status: string }>, id: string) =>
  checks.find((check) => check.id === id)?.status;

describe("an approval is presented with the action it approves", () => {
  it("escalates when no approval accompanies an action that needs one", async () => {
    const mandateId = await mandateNeedingApproval();
    const outcome = await present(mandateId, await agentSigned(400_000)).expect(201);

    expect(outcome.body.verdict).toBe("ESCALATE");
    expect(outcome.body.reason).toMatch(/human must approve/);
  });

  it("allows the action when a second human approved that exact request", async () => {
    const mandateId = await mandateNeedingApproval();
    const action = await agentSigned(400_000);

    const outcome = await present(mandateId, action, await approvalFor(action)).expect(201);

    expect(outcome.body.verdict).toBe("ALLOW");
    expect(statusOf(outcome.body.decision.checks, "approval.binding")).toBe("pass");
    expect(statusOf(outcome.body.decision.checks, "approval.signature")).toBe("pass");
    expect(statusOf(outcome.body.decision.checks, "approval.second_human")).toBe("pass");
    expect(statusOf(outcome.body.decision.checks, "policy.escalation")).toBe("pass");
  });

  it("needs no approval below the threshold", async () => {
    const mandateId = await mandateNeedingApproval();
    const outcome = await present(mandateId, await agentSigned(100_000)).expect(201);

    expect(outcome.body.verdict).toBe("ALLOW");
    expect(statusOf(outcome.body.decision.checks, "approval.binding")).toBeUndefined();
  });

  it("refuses an approval that names a different action", async () => {
    const mandateId = await mandateNeedingApproval();
    const approved = await agentSigned(400_000);
    const presented = await agentSigned(400_000);

    const outcome = await present(mandateId, presented, await approvalFor(approved)).expect(201);

    expect(outcome.body.verdict).toBe("ESCALATE");
    expect(statusOf(outcome.body.decision.checks, "approval.binding")).toBe("fail");
    expect(outcome.body.reason).toMatch(/not transferable between actions/);
  });

  it("refuses an approval from the person already accountable", async () => {
    const mandateId = await mandateNeedingApproval();
    const action = await agentSigned(400_000);

    const outcome = await present(
      mandateId,
      action,
      await approvalFor(action, priyaSharma),
    ).expect(201);

    expect(outcome.body.verdict).toBe("ESCALATE");
    expect(statusOf(outcome.body.decision.checks, "approval.second_human")).toBe("fail");
  });

  it("refuses an approval signed by a key that is not the approver's", async () => {
    const mandateId = await mandateNeedingApproval();
    const action = await agentSigned(400_000);

    const outcome = await present(
      mandateId,
      action,
      await approvalFor(action, rahul, apSigner),
    ).expect(201);

    expect(outcome.body.verdict).toBe("ESCALATE");
    expect(statusOf(outcome.body.decision.checks, "approval.signature")).toBe("fail");
  });

  it("refuses an approval edited after signing", async () => {
    const mandateId = await mandateNeedingApproval();
    const action = await agentSigned(400_000);
    const approval = await approvalFor(action);

    const outcome = await present(mandateId, action, {
      ...approval,
      approver: { ...approval.approver, name: "Someone Else" },
    }).expect(201);

    expect(outcome.body.verdict).toBe("ESCALATE");
    expect(statusOf(outcome.body.decision.checks, "approval.signature")).toBe("fail");
  });

  it("rejects a malformed approval before it reaches the gate", async () => {
    const mandateId = await mandateNeedingApproval();
    const response = await request(app)
      .post("/v1/actions/signed")
      .send({
        mandateId,
        request: await agentSigned(400_000),
        approval: { id: "apr_nonsense" },
      })
      .expect(400);

    expect(response.body.error).toBe("invalid_request");
  });
});

describe("an approval changes nothing it is not entitled to change", () => {
  it("does not rescue an action that is out of scope", async () => {
    const mandateId = await mandateNeedingApproval();
    const action = await agentSigned(400_000, "erp:someone-else/ledger");

    const outcome = await present(mandateId, action, await approvalFor(action)).expect(201);

    expect(outcome.body.verdict).toBe("BLOCK");
    expect(statusOf(outcome.body.decision.checks, "audience.binding")).toBe("fail");
  });

  it("does not rescue a replayed nonce", async () => {
    const mandateId = await mandateNeedingApproval();
    const action = await agentSigned(400_000);
    const approval = await approvalFor(action);

    expect((await present(mandateId, action, approval).expect(201)).body.verdict).toBe("ALLOW");

    const replayed = await present(mandateId, action, approval).expect(201);
    expect(replayed.body.verdict).toBe("BLOCK");
    expect(statusOf(replayed.body.decision.checks, "replay.freshness")).toBe("fail");
  });

  it("does not survive a mandate that has been revoked", async () => {
    const mandateId = await mandateNeedingApproval();
    await request(app)
      .post(`/v1/mandates/${mandateId}/revocation`)
      .send({ reason: "withdrawn before the approval was used" })
      .expect(204);

    const action = await agentSigned(400_000);
    const outcome = await present(mandateId, action, await approvalFor(action)).expect(201);

    expect(outcome.body.verdict).toBe("BLOCK");
    expect(statusOf(outcome.body.decision.checks, "revocation.status")).toBe("fail");
  });

  it("is not accepted on the endpoint where the service builds the request", async () => {
    const mandateId = await mandateNeedingApproval();
    const action = await agentSigned(400_000);

    const response = await request(app)
      .post("/v1/actions")
      .send({
        mandateId,
        action: "payment.execute",
        resource: ERP,
        counterparty: KALYANI,
        description: "Invoice needing sign-off",
        nonce: `nonce-rejected-${unique()}`,
        amount: inr(400_000),
        approval: await approvalFor(action),
      })
      .expect(400);

    expect(response.body.error).toBe("invalid_request");
  });
});

describe("the approval reaches the evidence a relying party receives", () => {
  it("is carried in the pack and checked by an offline verifier", async () => {
    const mandateId = await mandateNeedingApproval();
    const action = await agentSigned(400_000);
    const approval = await approvalFor(action);

    const outcome = await present(mandateId, action, approval).expect(201);
    expect(outcome.body.verdict).toBe("ALLOW");

    const pack = (await request(app).get(`/v1/evidence/${outcome.body.packId}`).expect(200))
      .body as EvidencePack;

    expect(pack.approval).toEqual(approval);

    const report = await verifyEvidencePack(pack, { trustRoots });
    expect(report.result).toBe("VERIFIED");
    expect(report.authority?.verdict).toBe("ALLOW");
    expect(report.authority?.reproduced).toBe(true);
    expect(statusOf(report.authority?.checks ?? [], "approval.signature")).toBe("pass");
  });

  it("stops reproducing if the approval is stripped from the pack", async () => {
    const mandateId = await mandateNeedingApproval();
    const action = await agentSigned(400_000);

    const outcome = await present(mandateId, action, await approvalFor(action)).expect(201);
    const pack = (await request(app).get(`/v1/evidence/${outcome.body.packId}`).expect(200))
      .body as EvidencePack;

    const { approval, ...stripped } = pack;
    const report = await verifyEvidencePack(stripped, { trustRoots });

    expect(report.authority?.reproduced).toBe(false);
    expect(report.result).toBe("INVALID");
  });

  it("leaves a pack that never needed an approval free of the field", async () => {
    const mandateId = await mandateNeedingApproval();
    const outcome = await present(mandateId, await agentSigned(100_000)).expect(201);

    const pack = (await request(app).get(`/v1/evidence/${outcome.body.packId}`).expect(200))
      .body as EvidencePack;

    expect(pack.approval).toBeUndefined();
    expect((await verifyEvidencePack(pack, { trustRoots })).result).toBe("VERIFIED");
  });
});
