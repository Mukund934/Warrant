import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { signApproval, signerFromJwk, verifyEvidencePack } from "@warrant/core";
import type { ActionRequest, Approval, Check, EvidencePack, LegalPerson, TrustRoot } from "@warrant/core";
import { principalKey } from "@warrant/core/fixtures";
import { createApp } from "../src/app.js";
import { createInMemoryRepositories } from "../src/persistence/memory.js";
import type { PendingAction, Repositories } from "../src/persistence/types.js";
import { testIdentity } from "./support/identity.js";
import type { TestIdentity } from "./support/identity.js";

const inr = (major: number) => ({ currency: "INR" as const, minor: major * 100 });

const ERP = "erp:meridian/accounts-payable";
const KALYANI = "Kalyani Steel Works";

const SCOPE = {
  actions: ["payment.execute"],
  audience: [ERP],
  counterparties: { allow: [KALYANI] },
  limits: { perAction: inr(300_000) },
  approval: { above: inr(50_000) },
};

const window = { notBefore: "2026-01-01T00:00:00Z", expiresAt: "2027-01-01T00:00:00Z" };

const principalSigner = signerFromJwk(principalKey.keyId, principalKey.privateKeyJwk);

// A second named human. The fixtures hold one principal key, so Rahul signs with it; the
// second-human rule compares people, not keys.
const rahul: LegalPerson = {
  kind: "legal_person",
  id: "person:rahul-menon",
  name: "Rahul Menon",
  role: "Chief Financial Officer",
  legalEntity: "Meridian Technologies Pvt Ltd",
  identifier: "DIN 07781234",
  keyId: principalKey.keyId,
};

let identity: TestIdentity;
let repositories: Repositories;
let app: Express;
let counter = 0;

const unique = () => (counter += 1).toString().padStart(6, "0");
const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");

beforeAll(async () => {
  identity = await testIdentity();
});

beforeEach(() => {
  repositories = createInMemoryRepositories();
  app = createApp({ repositories, auth: { mode: "required", verifier: identity.verifier } });
});

interface Member {
  token: string;
  organisationId: string;
}

const as = (who: Member) => ({ authorization: `Bearer ${who.token}` });

/**
 * The roots this organisation actually publishes, fetched the way a relying party would.
 *
 * Since Phase 9 (**D58**) each organisation signs with its own principal, gate and recorder keys, so
 * the demonstration fixture roots verify only the demonstration path. Asking the service which keys
 * it publishes is both closer to what a counterparty does and a stronger test: it proves the
 * published set is the one that actually verifies.
 */
const publishedRoots = async (who: Member): Promise<TrustRoot[]> =>
  (await request(app).get("/v1/trust-roots").set(as(who)).expect(200)).body;

const checkFor = (checks: Check[], id: string) => checks.find((check) => check.id === id);

async function enrol(subject: string, organisation: string): Promise<Member> {
  const token = await identity.mint(subject, `${subject}@example.test`);
  const created = await request(app)
    .post("/v1/organisations")
    .set("authorization", `Bearer ${token}`)
    .send({ name: organisation, jurisdiction: "IN-MH" })
    .expect(201);
  return { token, organisationId: created.body.id };
}

async function issue(who: Member): Promise<string> {
  const created = await request(app)
    .post("/v1/mandates")
    .set(as(who))
    .send({ scope: SCOPE, ...window, maxDelegationDepth: 2 })
    .expect(201);
  return created.body.id as string;
}

function act(who: Member, mandateId: string, amount = inr(200_000), nonce?: string) {
  return request(app)
    .post("/v1/actions")
    .set(as(who))
    .send({
      mandateId,
      action: "payment.execute",
      resource: ERP,
      counterparty: KALYANI,
      description: "Invoice needing sign-off",
      nonce: nonce ?? `nonce-pending-${unique()}`,
      amount,
    })
    .expect(201);
}

const parked = (who: Member) => request(app).get("/v1/pending").set(as(who));

const read = (who: Member, id: string) => request(app).get(`/v1/pending/${id}`).set(as(who));

const resume = (who: Member, id: string, approval: Approval) =>
  request(app).post(`/v1/pending/${id}/resume`).set(as(who)).send({ approval });

/**
 * The approver's key, as this organisation publishes it.
 *
 * Since Phase 9 (**D58**) an organisation's trust roots hold its own principal key and not the
 * demonstration one, so an approval signed with the fixture key is refused by the gate — correctly,
 * and that refusal is itself asserted below. A real approver is a person in the organisation whose
 * key the service holds, which is what this returns.
 */
async function approverSigner(who: Member) {
  const keys = await repositories.organisationKeys.keyring(who.organisationId);
  const principal = keys.find((key) => key.role === "principal");
  return principal ? signerFromJwk(principal.keyId, principal.privateKeyJwk) : principalSigner;
}

/**
 * A valid approval from this organisation: signed with its principal key, and naming that same key
 * as the approver's. The two have to agree — an approval whose named key is not the one that signed
 * it is exactly the forgery the gate is meant to refuse, and one of the tests below does that on
 * purpose.
 */
async function approvalBy(who: Member, target: ActionRequest): Promise<Approval> {
  const signer = await approverSigner(who);
  return approvalFor(target, { ...rahul, keyId: signer.keyId }, signer);
}

async function approvalFor(
  target: ActionRequest,
  approver: LegalPerson = rahul,
  signer = principalSigner,
): Promise<Approval> {
  return signApproval(
    { id: `apr_${unique()}`, request: target, approver, approvedAt: nowIso() },
    signer,
  );
}

/** Escalate an action, then read back the parked record and the digest an approver must sign. */
async function escalate(who: Member): Promise<PendingAction> {
  const mandateId = await issue(who);
  const outcome = await act(who, mandateId);
  expect(outcome.body.verdict).toBe("ESCALATE");

  const open = await parked(who).expect(200);
  expect(open.body).toHaveLength(1);
  return open.body[0] as PendingAction;
}

describe("an action that escalates is kept, not lost", () => {
  it("parks the request exactly as it was presented, with the digest an approval must name", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const pending = await escalate(owner);

    expect(pending.status).toBe("pending");
    expect(pending.reason).toMatch(/human must approve/);
    expect(pending.requestDigest).toMatch(/^sha256:/);
    expect(pending.request.amount).toEqual(inr(200_000));
    expect(pending.packId).toBeDefined();

    const one = await read(owner, pending.id).expect(200);
    expect(one.body.request).toEqual(pending.request);
  });

  it("holds the nonce while it waits, so the same request cannot be spent beside it", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const mandateId = await issue(owner);
    const nonce = `nonce-held-${unique()}`;

    await act(owner, mandateId, inr(200_000), nonce);
    const second = await act(owner, mandateId, inr(10_000), nonce);

    expect(second.body.verdict).toBe("BLOCK");
    expect(checkFor(second.body.decision.checks, "replay.freshness")?.status).toBe("fail");
  });
});

describe("resuming with the approval that satisfies it", () => {
  it("proceeds, and does not mistake the continuation for a replay", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const pending = await escalate(owner);

    const outcome = await resume(owner, pending.id, await approvalBy(owner, pending.request)).expect(201);

    expect(outcome.body.verdict).toBe("ALLOW");
    expect(outcome.body.pendingActionId).toBe(pending.id);
    // The whole hazard: the nonce was claimed at park time, so a naive resume refuses itself.
    expect(checkFor(outcome.body.decision.checks, "replay.freshness")?.status).toBe("pass");
    expect(checkFor(outcome.body.decision.checks, "policy.escalation")?.status).toBe("pass");
  });

  it("records the window a parked action is judged against, not the live one", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const pending = await escalate(owner);

    const live = await request(app)
      .get(`/v1/evidence/${pending.packId}`)
      .set(as(owner))
      .expect(200);
    expect(live.body.decision.inputs.freshness.maxAgeSeconds).toBe(300);

    const outcome = await resume(owner, pending.id, await approvalBy(owner, pending.request)).expect(201);

    // Wider, and written into the signed inputs so it reproduces offline against the rule applied.
    expect(outcome.body.decision.inputs.freshness.maxAgeSeconds).toBe(86_400);
    expect(checkFor(outcome.body.decision.checks, "request.freshness")?.status).toBe("pass");
  });

  it("produces evidence a stranger reproduces without this service", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const pending = await escalate(owner);
    const outcome = await resume(owner, pending.id, await approvalBy(owner, pending.request)).expect(201);

    const pack = (
      await request(app).get(`/v1/evidence/${outcome.body.packId}`).set(as(owner)).expect(200)
    ).body as EvidencePack;

    expect(pack.approval).toBeDefined();
    const report = await verifyEvidencePack(pack, { trustRoots: await publishedRoots(owner) });
    expect(report.result).toBe("VERIFIED");
    expect(report.authority?.verdict).toBe("ALLOW");
    expect(report.authority?.reproduced).toBe(true);
  });

  it("clears the parked action, so it no longer waits", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const pending = await escalate(owner);
    await resume(owner, pending.id, await approvalBy(owner, pending.request)).expect(201);

    expect((await parked(owner).expect(200)).body).toEqual([]);
    expect((await read(owner, pending.id).expect(200)).body.status).toBe("resumed");
  });
});

// A parked action holds the nonce claim of the request it carries, so spending it twice would be a
// double spend of that nonce.
describe("a parked action is spent once", () => {
  it("refuses a second resume", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const pending = await escalate(owner);
    const approval = await approvalBy(owner, pending.request);

    await resume(owner, pending.id, approval).expect(201);
    const again = await resume(owner, pending.id, approval).expect(422);

    expect(again.body.error).toBe("already_resolved");
  });

  it("is consumed even when the approval presented does not hold", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const pending = await escalate(owner);

    // Signed by a key that is not the approver's, so the approval fails and the action still escalates.
    const outcome = await resume(
      owner,
      pending.id,
      await approvalFor(pending.request, rahul, signerFromJwk("key:not-rahuls", principalKey.privateKeyJwk)),
    ).expect(201);

    expect(outcome.body.verdict).toBe("ESCALATE");
    expect(checkFor(outcome.body.decision.checks, "approval.signature")?.status).toBe("fail");
    expect((await read(owner, pending.id).expect(200)).body.status).toBe("resumed");
  });

  // The service reads the status before it claims, which is a read-then-write and therefore not
  // race-safe on its own. Two resumes arriving together both pass that read; the store's conditional
  // update is what actually decides, and nothing exercised it until this.
  it("lets exactly one of two simultaneous resumes through", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const pending = await escalate(owner);
    const approval = await approvalBy(owner, pending.request);

    const [first, second] = await Promise.all([
      resume(owner, pending.id, approval),
      resume(owner, pending.id, approval),
    ]);

    const codes = [first.status, second.status].sort();
    expect(codes).toEqual([201, 422]);

    const refused = first.status === 422 ? first : second;
    expect(refused.body.error).toBe("already_resolved");
  });

  it("hands the claim to the first caller only, at the store itself", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const pending = await escalate(owner);

    const at = nowIso();
    expect(await repositories.pending.claim(pending.id, "resumed", at, owner.organisationId)).toBe(true);
    expect(await repositories.pending.claim(pending.id, "resumed", at, owner.organisationId)).toBe(false);
    expect(await repositories.pending.claim(pending.id, "expired", at, owner.organisationId)).toBe(false);
  });

  it("refuses one that was never approved in time", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const pending = await escalate(owner);

    await repositories.pending.park({ ...pending, expiresAt: "2020-01-01T00:00:00Z" });

    const refused = await resume(owner, pending.id, await approvalBy(owner, pending.request)).expect(422);
    expect(refused.body.error).toBe("pending_expired");
    expect((await read(owner, pending.id).expect(200)).body.status).toBe("expired");
  });
});

describe("an approval still rescues nothing it is not entitled to", () => {
  it("does not resume an action whose mandate was withdrawn while it waited", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const pending = await escalate(owner);

    await request(app)
      .post(`/v1/mandates/${pending.mandateId}/revocation`)
      .set(as(owner))
      .send({ reason: "withdrawn while the approval was pending" })
      .expect(204);

    const outcome = await resume(owner, pending.id, await approvalBy(owner, pending.request)).expect(201);

    expect(outcome.body.verdict).toBe("BLOCK");
    expect(checkFor(outcome.body.decision.checks, "revocation.status")?.status).toBe("fail");
  });

  it("refuses an approval naming a different action", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const pending = await escalate(owner);

    const elsewhere = await act(owner, pending.mandateId, inr(150_000));
    const other = (await parked(owner).expect(200)).body.find(
      (row: PendingAction) => row.id !== pending.id,
    ) as PendingAction;

    const outcome = await resume(owner, pending.id, await approvalBy(owner, other.request)).expect(201);

    expect(elsewhere.body.verdict).toBe("ESCALATE");
    expect(outcome.body.verdict).toBe("ESCALATE");
    expect(checkFor(outcome.body.decision.checks, "approval.binding")?.status).toBe("fail");
  });

  it("refuses an approval from the person already accountable", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const pending = await escalate(owner);

    const pack = (
      await request(app).get(`/v1/evidence/${pending.packId}`).set(as(owner)).expect(200)
    ).body as EvidencePack;

    const outcome = await resume(
      owner,
      pending.id,
      await approvalFor(pending.request, {
        ...pack.authority.liablePrincipal,
        keyId: principalKey.keyId,
      }),
    ).expect(201);

    expect(outcome.body.verdict).toBe("ESCALATE");
    expect(checkFor(outcome.body.decision.checks, "approval.second_human")?.status).toBe("fail");
  });

  it("refuses an unknown field rather than dropping it", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const pending = await escalate(owner);

    await request(app)
      .post(`/v1/pending/${pending.id}/resume`)
      .set(as(owner))
      .send({ approval: await approvalBy(owner, pending.request), verdict: "ALLOW" })
      .expect(400);
  });
});

describe("a parked action belongs to one organisation", () => {
  it("is invisible to a neighbour, and cannot be resumed by one", async () => {
    const meridian = await enrol("user_priya", "Meridian Technologies");
    const kalyani = await enrol("user_rahul", "Kalyani Steel Works");
    const pending = await escalate(meridian);

    expect((await parked(kalyani).expect(200)).body).toEqual([]);
    await read(kalyani, pending.id).expect(404);
    await resume(kalyani, pending.id, await approvalBy(meridian, pending.request)).expect(404);

    expect((await read(meridian, pending.id).expect(200)).body.status).toBe("pending");
  });

  it("refuses a pending action that does not exist", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const pending = await escalate(owner);
    await resume(owner, "pnd_nope", await approvalBy(owner, pending.request)).expect(404);
  });
});
