import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { exportJWK, generateKeyPair } from "jose";
import type { JWK } from "jose";
import { verifyEvidencePack } from "@warrant/core";
import type { EvidencePack } from "@warrant/core";
import { apAgent, apAgentKey, trustRoots } from "@warrant/core/fixtures";
import { createApp } from "../src/app.js";
import { createInMemoryRepositories } from "../src/persistence/memory.js";
import type { Repositories } from "../src/persistence/types.js";
import { canTransition, trustRootsFor } from "../src/services/agents.js";
import { testIdentity } from "./support/identity.js";
import type { TestIdentity } from "./support/identity.js";

const inr = (major: number) => ({ currency: "INR" as const, minor: major * 100 });
const ERP = "erp:meridian/accounts-payable";

const ROOT_MANDATE = {
  scope: {
    actions: ["payment.execute"],
    audience: [ERP],
    counterparties: { any: true },
    limits: { perAction: inr(1_000_000) },
  },
  notBefore: "2026-01-01T00:00:00Z",
  expiresAt: "2027-01-01T00:00:00Z",
  maxDelegationDepth: 2,
};

let identity: TestIdentity;
let repositories: Repositories;
let app: Express;

beforeAll(async () => {
  identity = await testIdentity();
});

beforeEach(() => {
  repositories = createInMemoryRepositories();
  app = createApp({ repositories, auth: { mode: "required", verifier: identity.verifier } });
});

async function publicJwk(): Promise<JWK> {
  const { publicKey } = await generateKeyPair("ES256", { extractable: true });
  return exportJWK(publicKey);
}

async function privateJwk(): Promise<JWK> {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  return exportJWK(privateKey);
}

interface Member {
  token: string;
  organisationId: string;
}

const as = (who: Member) => ({ authorization: `Bearer ${who.token}` });

async function enrol(subject: string, organisation: string): Promise<Member> {
  const token = await identity.mint(subject, `${subject}@example.test`);
  const created = await request(app)
    .post("/v1/organisations")
    .set("authorization", `Bearer ${token}`)
    .send({ name: organisation, jurisdiction: "IN-MH" })
    .expect(201);
  return { token, organisationId: created.body.id };
}

async function registerAgent(owner: Member, name = "Payments runner"): Promise<string> {
  const response = await request(app)
    .post("/v1/agents")
    .set(as(owner))
    .send({ name, runtime: "node/22", publicKeyJwk: await publicJwk() })
    .expect(201);
  return response.body.id;
}

const move = (owner: Member, agentId: string, status: string, reason?: string) =>
  request(app)
    .post(`/v1/agents/${agentId}/status`)
    .set(as(owner))
    .send({ status, ...(reason ? { reason } : {}) });

describe("registering an agent", () => {
  it("records it as registered, not yet able to act", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const response = await request(app)
      .post("/v1/agents")
      .set(as(owner))
      .send({ name: "Payments runner", runtime: "node/22", publicKeyJwk: await publicJwk() })
      .expect(201);

    expect(response.body.status).toBe("registered");
    expect(response.body.organisationId).toBe(owner.organisationId);
    expect(response.body.id).toMatch(/^agt_/);
  }, 30_000);

  it("refuses a key that carries its private half, and says why that matters", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const response = await request(app)
      .post("/v1/agents")
      .set(as(owner))
      .send({ name: "Leaky", runtime: "node/22", publicKeyJwk: await privateJwk() })
      .expect(422);

    expect(response.body.error).toBe("private_key_supplied");
    expect(response.body.message).toMatch(/treat the key you just transmitted as compromised/);
  }, 30_000);

  it("never stores or echoes private key material", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const secret = await privateJwk();

    await request(app)
      .post("/v1/agents")
      .set(as(owner))
      .send({ name: "Leaky", runtime: "node/22", publicKeyJwk: secret })
      .expect(422);

    const listed = await request(app).get("/v1/agents").set(as(owner)).expect(200);
    expect(JSON.stringify(listed.body)).not.toContain(secret.d);
    expect(await repositories.agents.list(null)).toEqual([]);
  }, 30_000);

  it("refuses a key on a curve Warrant does not sign with", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const response = await request(app)
      .post("/v1/agents")
      .set(as(owner))
      .send({ name: "Wrong curve", runtime: "node/22", publicKeyJwk: { kty: "OKP", crv: "Ed25519", x: "abc" } })
      .expect(422);

    expect(response.body.error).toBe("unsupported_key");
  }, 30_000);

  it("refuses a second agent with the same name in one organisation", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    await registerAgent(owner, "Payments runner");

    const response = await request(app)
      .post("/v1/agents")
      .set(as(owner))
      .send({ name: "Payments runner", runtime: "node/22", publicKeyJwk: await publicJwk() })
      .expect(422);

    expect(response.body.error).toBe("agent_exists");
  }, 30_000);

  it("refuses a key already registered to another organisation", async () => {
    const meridian = await enrol("user_priya", "Meridian Technologies");
    const kalyani = await enrol("user_rahul", "Kalyani Steel Works");
    const shared = await publicJwk();

    await request(app)
      .post("/v1/agents")
      .set(as(meridian))
      .send({ name: "Runner", runtime: "node/22", publicKeyJwk: shared })
      .expect(201);

    const response = await request(app)
      .post("/v1/agents")
      .set(as(kalyani))
      .send({ name: "Runner", runtime: "node/22", publicKeyJwk: shared })
      .expect(422);

    expect(response.body.error).toBe("key_already_registered");
  }, 30_000);

  it("refuses a member and an auditor", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");

    for (const role of ["member", "auditor"] as const) {
      await request(app)
        .post(`/v1/organisations/${owner.organisationId}/members`)
        .set(as(owner))
        .send({ subject: `user_${role}`, role })
        .expect(201);

      const token = await identity.mint(`user_${role}`);
      const response = await request(app)
        .post("/v1/agents")
        .set({ authorization: `Bearer ${token}` })
        .send({ name: `By ${role}`, runtime: "node/22", publicKeyJwk: await publicJwk() })
        .expect(403);

      expect(response.body.error).toBe("insufficient_role");
    }
  }, 30_000);
});

describe("the lifecycle is a state machine, not a status column", () => {
  it("permits only the transitions the roadmap names", () => {
    expect(canTransition("registered", "active")).toBe(true);
    expect(canTransition("active", "suspended")).toBe(true);
    expect(canTransition("suspended", "active")).toBe(true);
    expect(canTransition("active", "revoked")).toBe(true);
    expect(canTransition("revoked", "archived")).toBe(true);

    expect(canTransition("registered", "suspended")).toBe(false);
    expect(canTransition("revoked", "active")).toBe(false);
    expect(canTransition("archived", "active")).toBe(false);
    expect(canTransition("suspended", "registered")).toBe(false);
  });

  it("walks an agent from registration to archive", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const agentId = await registerAgent(owner);

    expect((await move(owner, agentId, "active").expect(200)).body.status).toBe("active");
    expect((await move(owner, agentId, "suspended", "under review").expect(200)).body.status).toBe(
      "suspended",
    );
    expect((await move(owner, agentId, "active").expect(200)).body.status).toBe("active");
    expect((await move(owner, agentId, "revoked", "retired").expect(200)).body.status).toBe(
      "revoked",
    );
    expect((await move(owner, agentId, "archived").expect(200)).body.status).toBe("archived");
  }, 30_000);

  it("refuses to bring a revoked agent back, and says what was permitted", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const agentId = await registerAgent(owner);
    await move(owner, agentId, "active").expect(200);
    await move(owner, agentId, "revoked", "compromised").expect(200);

    const response = await move(owner, agentId, "active").expect(422);
    expect(response.body.error).toBe("transition_refused");
    expect(response.body.message).toMatch(/may only become archived/);
  }, 30_000);

  it("refuses a move to the state it is already in", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const agentId = await registerAgent(owner);

    const response = await move(owner, agentId, "registered").expect(422);
    expect(response.body.error).toBe("already_in_state");
  }, 30_000);

  it("writes a ledger entry for registration and for every transition", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const agentId = await registerAgent(owner);
    await move(owner, agentId, "active").expect(200);
    await move(owner, agentId, "suspended", "under review").expect(200);

    const entries = await repositories.ledger.entries();
    const mine = entries.filter((entry) => entry.ref === agentId);

    expect(mine.map((entry) => entry.type)).toEqual([
      "agent.registered",
      "agent.status_changed",
      "agent.status_changed",
    ]);
    expect(new Set(mine.map((entry) => entry.payloadDigest)).size).toBe(3);
  }, 30_000);
});

describe("an agent belongs to exactly one organisation", () => {
  async function twoOrganisations() {
    const meridian = await enrol("user_priya", "Meridian Technologies");
    const kalyani = await enrol("user_rahul", "Kalyani Steel Works");
    const agentId = await registerAgent(meridian);
    return { meridian, kalyani, agentId };
  }

  it("hides it from another organisation entirely", async () => {
    const { kalyani, agentId } = await twoOrganisations();

    await request(app).get(`/v1/agents/${agentId}`).set(as(kalyani)).expect(404);
    expect((await request(app).get("/v1/agents").set(as(kalyani)).expect(200)).body).toEqual([]);
  }, 30_000);

  it("refuses a cross-tenant lifecycle change", async () => {
    const { kalyani, agentId } = await twoOrganisations();
    await move(kalyani, agentId, "active").expect(404);
  }, 30_000);

  it("refuses a cross-tenant key rotation", async () => {
    const { kalyani, agentId } = await twoOrganisations();

    await request(app)
      .post(`/v1/agents/${agentId}/key-rotation`)
      .set(as(kalyani))
      .send({ publicKeyJwk: await publicJwk() })
      .expect(404);
  }, 30_000);

  it("keeps its key out of another organisation's trust roots", async () => {
    const { meridian, kalyani, agentId } = await twoOrganisations();
    const key = await repositories.agents.currentKey(agentId);

    const ours = await trustRootsFor(repositories, meridian.organisationId);
    const theirs = await trustRootsFor(repositories, kalyani.organisationId);

    expect(ours.map((root) => root.keyId)).toContain(key?.keyId);
    expect(theirs.map((root) => root.keyId)).not.toContain(key?.keyId);
  }, 30_000);
});

describe("a registered key reaches the verifier through the existing trust roots", () => {
  it("publishes the agent key beside the fixture keys, never instead of them", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const agentId = await registerAgent(owner);
    const key = await repositories.agents.currentKey(agentId);

    const fixtureOnly = await trustRootsFor(repositories, null);
    const withAgent = await trustRootsFor(repositories, owner.organisationId);

    expect(withAgent).toHaveLength(fixtureOnly.length + 1);
    for (const root of fixtureOnly) {
      expect(withAgent.map((entry) => entry.keyId)).toContain(root.keyId);
    }

    const published = withAgent.find((root) => root.keyId === key?.keyId);
    expect(published?.role).toBe("agent");
    expect(published?.publicKeyJwk).toEqual(key?.publicKeyJwk);
    expect(JSON.stringify(published)).not.toMatch(/"d":/);
  }, 30_000);

  it("keeps a retired key published so evidence it signed still verifies", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const agentId = await registerAgent(owner);
    const original = await repositories.agents.currentKey(agentId);

    const rotated = await request(app)
      .post(`/v1/agents/${agentId}/key-rotation`)
      .set(as(owner))
      .send({ publicKeyJwk: await publicJwk() })
      .expect(201);

    const roots = await trustRootsFor(repositories, owner.organisationId);
    const retired = roots.find((root) => root.keyId === original?.keyId);
    const current = roots.find((root) => root.keyId === rotated.body.keyId);

    expect(retired?.signingUntil).toBeDefined();
    expect(current?.signingUntil).toBeUndefined();
  }, 30_000);

  it("refuses to rotate the key of a revoked agent", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const agentId = await registerAgent(owner);
    await move(owner, agentId, "active").expect(200);
    await move(owner, agentId, "revoked", "compromised").expect(200);

    const response = await request(app)
      .post(`/v1/agents/${agentId}/key-rotation`)
      .set(as(owner))
      .send({ publicKeyJwk: await publicJwk() })
      .expect(422);

    expect(response.body.error).toBe("transition_refused");
  }, 30_000);
});

describe("authority is granted to an active agent and to no other", () => {
  it("issues a mandate whose subject is the registered agent", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const agentId = await registerAgent(owner);
    await move(owner, agentId, "active").expect(200);
    const key = await repositories.agents.currentKey(agentId);

    const mandate = await request(app)
      .post("/v1/mandates")
      .set(as(owner))
      .send({ ...ROOT_MANDATE, agentId })
      .expect(201);

    expect(mandate.body.subject.id).toBe(agentId);
    expect(mandate.body.subject.keyId).toBe(key?.keyId);
    expect(mandate.body.subject.name).toBe("Payments runner");
  }, 30_000);

  it("refuses to grant authority to an agent that is only registered", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const agentId = await registerAgent(owner);

    const response = await request(app)
      .post("/v1/mandates")
      .set(as(owner))
      .send({ ...ROOT_MANDATE, agentId })
      .expect(422);

    expect(response.body.error).toBe("agent_not_active");
  }, 30_000);

  it("refuses to grant authority to a suspended or revoked agent", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const agentId = await registerAgent(owner);
    await move(owner, agentId, "active").expect(200);
    await move(owner, agentId, "suspended", "under review").expect(200);

    await request(app)
      .post("/v1/mandates")
      .set(as(owner))
      .send({ ...ROOT_MANDATE, agentId })
      .expect(422);

    await move(owner, agentId, "revoked", "done").expect(200);
    await request(app)
      .post("/v1/mandates")
      .set(as(owner))
      .send({ ...ROOT_MANDATE, agentId })
      .expect(422);
  }, 30_000);

  it("refuses to grant authority to another organisation's agent", async () => {
    const meridian = await enrol("user_priya", "Meridian Technologies");
    const kalyani = await enrol("user_rahul", "Kalyani Steel Works");
    const agentId = await registerAgent(meridian);
    await move(meridian, agentId, "active").expect(200);

    await request(app)
      .post("/v1/mandates")
      .set(as(kalyani))
      .send({ ...ROOT_MANDATE, agentId })
      .expect(404);
  }, 30_000);
});

describe("a lifecycle change never rewrites what already happened", () => {
  async function withRegisteredFixtureAgent() {
    const owner = await enrol("user_priya", "Meridian Technologies");

    await repositories.agents.register(
      {
        id: "agt_fixture_runner",
        organisationId: owner.organisationId,
        name: apAgent.name,
        runtime: apAgent.runtime,
        status: "active",
        registeredAt: "2026-01-01T00:00:00Z",
        statusChangedAt: "2026-01-01T00:00:00Z",
      },
      {
        keyId: apAgent.keyId,
        agentId: "agt_fixture_runner",
        publicKeyJwk: apAgentKey.publicKeyJwk,
        signingFrom: "2026-01-01T00:00:00Z",
      },
    );

    return owner;
  }

  const spend = (owner: Member, mandateId: string, nonce: string) =>
    request(app)
      .post("/v1/actions")
      .set(as(owner))
      .send({
        mandateId,
        action: "payment.execute",
        resource: ERP,
        counterparty: "Kalyani Steel Works",
        description: "Invoice settlement",
        nonce,
        amount: inr(100_000),
      })
      .expect(201);

  it("records the agent's standing in the decision at the moment it acted", async () => {
    const owner = await withRegisteredFixtureAgent();
    const mandate = await request(app)
      .post("/v1/mandates")
      .set(as(owner))
      .send(ROOT_MANDATE)
      .expect(201);

    const allowed = await spend(owner, mandate.body.id, "nonce-agent-active");

    expect(allowed.body.verdict).toBe("ALLOW");
    expect(allowed.body.decision.inputs.agentStatus).toBe("active");
    expect(
      allowed.body.decision.checks.find((check: { id: string }) => check.id === "agent.status")
        ?.status,
    ).toBe("pass");
  }, 30_000);

  it("blocks the next action once the agent is suspended", async () => {
    const owner = await withRegisteredFixtureAgent();
    const mandate = await request(app)
      .post("/v1/mandates")
      .set(as(owner))
      .send(ROOT_MANDATE)
      .expect(201);

    await spend(owner, mandate.body.id, "nonce-before-suspension");
    await move(owner, "agt_fixture_runner", "suspended", "under review").expect(200);

    const blocked = await spend(owner, mandate.body.id, "nonce-after-suspension");

    expect(blocked.body.verdict).toBe("BLOCK");
    expect(blocked.body.decision.inputs.agentStatus).toBe("suspended");
    const check = blocked.body.decision.checks.find(
      (entry: { id: string }) => entry.id === "agent.status",
    );
    expect(check?.status).toBe("fail");
    expect(check?.observed).toBe("suspended");
  }, 30_000);

  it("keeps the earlier evidence verifying as ALLOW after the agent is suspended and revoked", async () => {
    const owner = await withRegisteredFixtureAgent();
    const mandate = await request(app)
      .post("/v1/mandates")
      .set(as(owner))
      .send(ROOT_MANDATE)
      .expect(201);

    const allowed = await spend(owner, mandate.body.id, "nonce-history-invariant");
    const packId = allowed.body.packId;

    await move(owner, "agt_fixture_runner", "suspended", "under review").expect(200);
    await move(owner, "agt_fixture_runner", "revoked", "compromised").expect(200);

    const stored = await request(app).get(`/v1/evidence/${packId}`).set(as(owner)).expect(200);
    const report = await verifyEvidencePack(stored.body as EvidencePack, { trustRoots });

    expect(report.result).toBe("VERIFIED");
    expect(report.authority?.verdict).toBe("ALLOW");
    expect(report.authority?.reproduced).toBe(true);
    expect(
      report.authority?.checks.find((check) => check.id === "agent.status")?.status,
    ).toBe("pass");
  }, 30_000);

  it("leaves a mandate issued before the suspension untouched, because revocation is separate", async () => {
    const owner = await withRegisteredFixtureAgent();
    const mandate = await request(app)
      .post("/v1/mandates")
      .set(as(owner))
      .send(ROOT_MANDATE)
      .expect(201);

    await move(owner, "agt_fixture_runner", "revoked", "compromised").expect(200);

    const reread = await request(app).get(`/v1/mandates/${mandate.body.id}`).set(as(owner)).expect(200);
    expect(reread.body.mandate).toEqual(mandate.body);

    const revocations = await repositories.mandates.revocations(owner.organisationId);
    expect(revocations).toEqual([]);
  }, 30_000);
});
