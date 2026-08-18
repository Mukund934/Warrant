import { readFile } from "node:fs/promises";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { verifyEvidencePack } from "@warrant/core";
import type { EvidencePack } from "@warrant/core";
import { trustRoots } from "@warrant/core/fixtures";
import { createApp } from "../src/app.js";
import { ORGANISATION_HEADER } from "../src/auth/tenancy.js";
import { TEST_ISSUER, testIdentity } from "./support/identity.js";
import type { TestIdentity } from "./support/identity.js";

const inr = (major: number) => ({ currency: "INR" as const, minor: major * 100 });
const ERP = "erp:meridian/accounts-payable";

const ROOT_MANDATE = {
  scope: {
    actions: ["payment.execute"],
    audience: [ERP],
    counterparties: { any: true },
    limits: {
      perAction: inr(1_000_000),
      perPeriod: { amount: inr(600_000), days: 30 },
    },
  },
  notBefore: "2026-01-01T00:00:00Z",
  expiresAt: "2027-01-01T00:00:00Z",
  maxDelegationDepth: 2,
};

let identity: TestIdentity;
let app: Express;

beforeAll(async () => {
  identity = await testIdentity();
});

beforeEach(() => {
  app = createApp({ auth: { mode: "required", verifier: identity.verifier } });
});

interface Member {
  token: string;
  organisationId: string;
}

async function enrol(subject: string, organisation: string): Promise<Member> {
  const token = await identity.mint(subject, `${subject}@example.test`);
  const created = await request(app)
    .post("/v1/organisations")
    .set("authorization", `Bearer ${token}`)
    .send({ name: organisation, jurisdiction: "IN-MH" })
    .expect(201);

  return { token, organisationId: created.body.id };
}

const as = (member: Member) => ({ authorization: `Bearer ${member.token}` });

async function issueRoot(member: Member): Promise<string> {
  const response = await request(app)
    .post("/v1/mandates")
    .set(as(member))
    .send(ROOT_MANDATE)
    .expect(201);
  return response.body.id;
}

async function delegate(member: Member, parentId: string, perAction = 500_000): Promise<string> {
  const response = await request(app)
    .post(`/v1/mandates/${parentId}/delegations`)
    .set(as(member))
    .send({ scopeDelta: { actions: ["payment.execute"], limits: { perAction: inr(perAction) } } })
    .expect(201);
  return response.body.id;
}

function action(mandateId: string, major: number, nonce: string) {
  return {
    mandateId,
    action: "payment.execute",
    resource: ERP,
    counterparty: "Kalyani Steel Works",
    description: "Invoice settlement",
    nonce,
    amount: inr(major),
  };
}

describe("one organisation cannot reach into another", () => {
  it("hides a mandate, its chain, and every way of changing it", async () => {
    const meridian = await enrol("user_priya", "Meridian Technologies");
    const kalyani = await enrol("user_rahul", "Kalyani Steel Works");

    const mandateId = await issueRoot(meridian);

    await request(app).get(`/v1/mandates/${mandateId}`).set(as(meridian)).expect(200);
    await request(app).get(`/v1/mandates/${mandateId}`).set(as(kalyani)).expect(404);

    await request(app)
      .post(`/v1/mandates/${mandateId}/delegations`)
      .set(as(kalyani))
      .send({ scopeDelta: { actions: ["payment.execute"] } })
      .expect(404);

    await request(app)
      .post(`/v1/mandates/${mandateId}/revocation`)
      .set(as(kalyani))
      .send({ reason: "not mine to withdraw" })
      .expect(404);

    await request(app)
      .post("/v1/actions")
      .set(as(kalyani))
      .send(action(mandateId, 10_000, "nonce-cross-tenant-action"))
      .expect(404);
  }, 30_000);

  it("hides a recorded evidence pack while leaving the published fixtures public", async () => {
    const meridian = await enrol("user_priya", "Meridian Technologies");
    const kalyani = await enrol("user_rahul", "Kalyani Steel Works");

    const leaf = await delegate(meridian, await issueRoot(meridian));
    const recorded = await request(app)
      .post("/v1/actions")
      .set(as(meridian))
      .send(action(leaf, 100_000, "nonce-evidence-scope"))
      .expect(201);

    const packId = recorded.body.packId;
    await request(app).get(`/v1/evidence/${packId}`).set(as(meridian)).expect(200);
    await request(app).get(`/v1/evidence/${packId}`).set(as(kalyani)).expect(404);

    await request(app).get("/v1/evidence/over-limit").set(as(kalyani)).expect(200);
    await request(app).get("/v1/evidence/over-limit").expect(200);
  }, 30_000);

  it("keeps another organisation's revocations out of the signed revocation snapshot", async () => {
    const meridian = await enrol("user_priya", "Meridian Technologies");
    const kalyani = await enrol("user_rahul", "Kalyani Steel Works");

    const theirRoot = await issueRoot(kalyani);
    await request(app)
      .post(`/v1/mandates/${theirRoot}/revocation`)
      .set(as(kalyani))
      .send({ reason: "withdrawn inside Kalyani" })
      .expect(204);

    const leaf = await delegate(meridian, await issueRoot(meridian));
    const recorded = await request(app)
      .post("/v1/actions")
      .set(as(meridian))
      .send(action(leaf, 100_000, "nonce-revocation-scope"))
      .expect(201);

    const pack = await request(app)
      .get(`/v1/evidence/${recorded.body.packId}`)
      .set(as(meridian))
      .expect(200);

    const revoked = pack.body.revocation.revoked.map((row: { mandateId: string }) => row.mandateId);
    expect(revoked).not.toContain(theirRoot);
    expect(JSON.stringify(pack.body.revocation)).not.toMatch(/Kalyani/);
  }, 30_000);

  it("accumulates a periodic budget within one chain and never across organisations", async () => {
    const meridian = await enrol("user_priya", "Meridian Technologies");
    const kalyani = await enrol("user_rahul", "Kalyani Steel Works");

    const theirLeaf = await delegate(kalyani, await issueRoot(kalyani));
    const theirs = await request(app)
      .post("/v1/actions")
      .set(as(kalyani))
      .send(action(theirLeaf, 400_000, "nonce-their-spend"))
      .expect(201);
    expect(theirs.body.verdict).toBe("ALLOW");

    const ourLeaf = await delegate(meridian, await issueRoot(meridian));

    const first = await request(app)
      .post("/v1/actions")
      .set(as(meridian))
      .send(action(ourLeaf, 400_000, "nonce-our-first"))
      .expect(201);
    expect(first.body.verdict).toBe("ALLOW");
    expect(JSON.stringify(first.body.decision)).not.toMatch(/nonce-their-spend/);

    const second = await request(app)
      .post("/v1/actions")
      .set(as(meridian))
      .send(action(ourLeaf, 400_000, "nonce-our-second"))
      .expect(201);

    expect(second.body.verdict).toBe("BLOCK");
    const budget = second.body.decision.checks.find(
      (check: { id: string }) => check.id === "limit.per_period",
    );
    expect(budget?.status).toBe("fail");
  }, 30_000);

  it("bounds the periodic budget by the root mandate, which is why a tenant cannot spend another's", async () => {
    const source = await readFile(
      new URL("../src/services/execution.ts", import.meta.url),
      "utf8",
    );

    expect(source).toMatch(/pack\.authority\.chain\[0\]\?\.id !== rootMandateId/);
    expect(source).toMatch(/repositories\.evidence\.recent\(500, scope\)/);
  });
});

describe("membership cannot be assumed, only granted", () => {
  it("refuses an organisation header naming an organisation the account is not in", async () => {
    const meridian = await enrol("user_priya", "Meridian Technologies");
    const kalyani = await enrol("user_rahul", "Kalyani Steel Works");

    const response = await request(app)
      .get("/v1/organisations")
      .set(as(kalyani))
      .set(ORGANISATION_HEADER, meridian.organisationId)
      .expect(403);

    expect(response.body.error).toBe("not_a_member");
  }, 30_000);

  it("lists only the organisations an account actually belongs to", async () => {
    const meridian = await enrol("user_priya", "Meridian Technologies");
    await enrol("user_rahul", "Kalyani Steel Works");

    const response = await request(app).get("/v1/organisations").set(as(meridian)).expect(200);

    expect(response.body).toHaveLength(1);
    expect(response.body[0].id).toBe(meridian.organisationId);
  }, 30_000);

  it("refuses to grant membership in an organisation the caller does not administer", async () => {
    const meridian = await enrol("user_priya", "Meridian Technologies");
    const kalyani = await enrol("user_rahul", "Kalyani Steel Works");

    await request(app)
      .post(`/v1/organisations/${meridian.organisationId}/members`)
      .set(as(kalyani))
      .send({ subject: "user_mallory", role: "owner" })
      .expect(404);
  }, 30_000);

  it("shows an outsider no member list", async () => {
    const meridian = await enrol("user_priya", "Meridian Technologies");
    const kalyani = await enrol("user_rahul", "Kalyani Steel Works");

    await request(app)
      .get(`/v1/organisations/${meridian.organisationId}/members`)
      .set(as(kalyani))
      .expect(404);
  }, 30_000);
});

describe("an auditor may read the record and may not add to it", () => {
  async function auditorOf(owner: Member): Promise<Member> {
    await request(app)
      .post(`/v1/organisations/${owner.organisationId}/members`)
      .set(as(owner))
      .send({ subject: "user_auditor", email: "auditor@example.test", role: "auditor" })
      .expect(201);

    return { token: await identity.mint("user_auditor"), organisationId: owner.organisationId };
  }

  it("reads a mandate and its evidence", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const auditor = await auditorOf(owner);

    const mandateId = await issueRoot(owner);
    await request(app).get(`/v1/mandates/${mandateId}`).set(as(auditor)).expect(200);
    await request(app).get("/v1/organisations").set(as(auditor)).expect(200);
  }, 30_000);

  it("cannot issue, delegate, revoke, act or checkpoint", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const auditor = await auditorOf(owner);
    const mandateId = await issueRoot(owner);

    const refusals = await Promise.all([
      request(app).post("/v1/mandates").set(as(auditor)).send(ROOT_MANDATE),
      request(app)
        .post(`/v1/mandates/${mandateId}/delegations`)
        .set(as(auditor))
        .send({ scopeDelta: { actions: ["payment.execute"] } }),
      request(app)
        .post(`/v1/mandates/${mandateId}/revocation`)
        .set(as(auditor))
        .send({ reason: "auditors do not withdraw" }),
      request(app).post("/v1/actions").set(as(auditor)).send(action(mandateId, 1000, "nonce-aud")),
      request(app).post("/v1/checkpoint").set(as(auditor)).send({}),
    ]);

    for (const refusal of refusals) {
      expect(refusal.status).toBe(403);
      expect(refusal.body.error).toBe("insufficient_role");
    }
  }, 30_000);

  it("cannot promote itself", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const auditor = await auditorOf(owner);

    const response = await request(app)
      .post(`/v1/organisations/${owner.organisationId}/members`)
      .set(as(auditor))
      .send({ subject: "user_auditor", role: "owner" })
      .expect(403);

    expect(response.body.error).toBe("insufficient_role");
  }, 30_000);

  it("cannot withdraw the owner", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const auditor = await auditorOf(owner);
    const members = await request(app)
      .get(`/v1/organisations/${owner.organisationId}/members`)
      .set(as(owner))
      .expect(200);

    const ownerAccount = members.body.find(
      (row: { role: string }) => row.role === "owner",
    ).accountId;

    await request(app)
      .post(`/v1/organisations/${owner.organisationId}/members/${ownerAccount}/withdrawal`)
      .set(as(auditor))
      .expect(403);
  }, 30_000);
});

describe("a member may record authority and may not change who else can", () => {
  it("issues and acts, but cannot grant a role", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    await request(app)
      .post(`/v1/organisations/${owner.organisationId}/members`)
      .set(as(owner))
      .send({ subject: "user_dev", role: "member" })
      .expect(201);

    const member: Member = {
      token: await identity.mint("user_dev"),
      organisationId: owner.organisationId,
    };

    const mandateId = await issueRoot(member);
    expect(mandateId).toMatch(/^mnd_/);

    const response = await request(app)
      .post(`/v1/organisations/${owner.organisationId}/members`)
      .set(as(member))
      .send({ subject: "user_mallory", role: "owner" })
      .expect(403);

    expect(response.body.error).toBe("insufficient_role");
  }, 30_000);
});

describe("the mandate records who authorised it, and how they were identified", () => {
  it("derives the accountable human from the authenticated caller", async () => {
    const meridian = await enrol("user_priya", "Meridian Technologies");
    const root = await request(app)
      .post("/v1/mandates")
      .set(as(meridian))
      .send(ROOT_MANDATE)
      .expect(201);

    const principal = root.body.liablePrincipal;
    expect(principal.name).toBe("user_priya@example.test");
    expect(principal.identifier).toBe("mailto:user_priya@example.test");
    expect(principal.legalEntity).toBe("Meridian Technologies");
    expect(principal.role).toBe("owner");
    expect(principal.assurance).toEqual({
      identity: "authenticated",
      keyCustody: "service",
      method: "OpenID Connect, email claim from the identity provider",
      assertedBy: TEST_ISSUER,
      assertedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
    });
  }, 30_000);

  it("invents no company register reference it cannot support", async () => {
    const meridian = await enrol("user_priya", "Meridian Technologies");
    const root = await request(app)
      .post("/v1/mandates")
      .set(as(meridian))
      .send(ROOT_MANDATE)
      .expect(201);

    expect(root.body.liablePrincipal.assurance.reference).toBeUndefined();
    expect(JSON.stringify(root.body.liablePrincipal)).not.toMatch(/DIN|CIN|registry-verified/i);
  }, 30_000);

  it("tells a relying party, offline, that the service held the key and not the person", async () => {
    const meridian = await enrol("user_priya", "Meridian Technologies");
    const leaf = await delegate(meridian, await issueRoot(meridian));
    const recorded = await request(app)
      .post("/v1/actions")
      .set(as(meridian))
      .send(action(leaf, 100_000, "nonce-assurance-pack"))
      .expect(201);

    const stored = await request(app)
      .get(`/v1/evidence/${recorded.body.packId}`)
      .set(as(meridian))
      .expect(200);

    const report = await verifyEvidencePack(stored.body as EvidencePack, { trustRoots });
    expect(report.result).toBe("VERIFIED");

    const assurance = report.authority?.checks.find((check) => check.id === "principal.assurance");
    expect(assurance?.status).toBe("warn");
    expect(assurance?.detail).toMatch(/identity authenticated by OpenID Connect/);
    expect(assurance?.detail).toMatch(/held by the service rather than by user_priya@example\.test/);
  }, 30_000);

  it("keeps the demonstration principal when nobody is logged in", async () => {
    const open = createApp({ auth: { mode: "open" } });
    const root = await request(open).post("/v1/mandates").send(ROOT_MANDATE).expect(201);

    expect(root.body.liablePrincipal.name).toBe("Priya Sharma");
    expect(root.body.liablePrincipal.assurance).toBeUndefined();
  }, 30_000);
});
