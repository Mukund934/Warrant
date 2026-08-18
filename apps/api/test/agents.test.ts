import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { exportJWK, generateKeyPair } from "jose";
import type { CryptoKey, JWK } from "jose";
import { signActionRequest, signerFromJwk, verifyEvidencePack } from "@warrant/core";
import type { ActionRequest, EvidencePack, PrivateKeyJwk } from "@warrant/core";
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

describe("what the published key set discloses, and what it must never let a tenant claim", () => {
  it("serves the caller's own agent keys, so an independent verifier can obtain them", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const agentId = await registerAgent(owner);
    const key = await repositories.agents.currentKey(agentId);

    const published = await request(app).get("/v1/trust-roots").set(as(owner)).expect(200);
    expect(published.body.map((root: { keyId: string }) => root.keyId)).toContain(key?.keyId);

    const anonymous = await request(app).get("/v1/trust-roots").expect(200);
    expect(anonymous.body.map((root: { keyId: string }) => root.keyId)).not.toContain(key?.keyId);
    expect(anonymous.body).toHaveLength(trustRoots.length);
  }, 30_000);

  it("never lets a registered key claim to be a principal, a gate or a ledger key", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    await registerAgent(owner, "First");
    await registerAgent(owner, "Second");

    const roots = await trustRootsFor(repositories, owner.organisationId);
    const registered = roots.slice(trustRoots.length);

    expect(registered).toHaveLength(2);
    for (const root of registered) {
      expect(root.role).toBe("agent");
    }
  }, 30_000);

  it("keeps the fixture keys first, so a registered key can never shadow one", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    await registerAgent(owner);

    const roots = await trustRootsFor(repositories, owner.organisationId);
    expect(roots.slice(0, trustRoots.length).map((root) => root.keyId)).toEqual(
      trustRoots.map((root) => root.keyId),
    );
  }, 30_000);

  it("publishes no private material for any registered key", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    await registerAgent(owner);

    const published = await request(app).get("/v1/trust-roots").set(as(owner)).expect(200);
    const serialised = JSON.stringify(published.body);

    expect(serialised).not.toMatch(/"d"\s*:/);
    for (const root of published.body as Array<{ publicKeyJwk: Record<string, unknown> }>) {
      expect(Object.keys(root.publicKeyJwk).sort()).toEqual(["crv", "kty", "x", "y"]);
    }
  }, 30_000);

  it("shows one organisation nothing about another organisation's agents", async () => {
    const meridian = await enrol("user_priya", "Meridian Technologies");
    const kalyani = await enrol("user_rahul", "Kalyani Steel Works");
    await registerAgent(meridian, "Meridian runner");

    const theirs = await request(app).get("/v1/trust-roots").set(as(kalyani)).expect(200);
    expect(theirs.body).toHaveLength(trustRoots.length);
    expect(JSON.stringify(theirs.body)).not.toMatch(/Meridian runner/);
  }, 30_000);
});

describe("an agent acts by signing for itself", () => {
  async function activeAgentHoldingItsOwnKey() {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
    const jwk = (await exportJWK(privateKey)) as PrivateKeyJwk;

    const registered = await request(app)
      .post("/v1/agents")
      .set(as(owner))
      .send({
        name: "Self-signing runner",
        runtime: "node/22",
        publicKeyJwk: await exportJWK(publicKey),
      })
      .expect(201);

    const agentId = registered.body.id;
    await move(owner, agentId, "active").expect(200);

    const detail = await request(app).get(`/v1/agents/${agentId}`).set(as(owner)).expect(200);
    const keyId = detail.body.keyId as string;

    const mandate = await request(app)
      .post("/v1/mandates")
      .set(as(owner))
      .send({ ...ROOT_MANDATE, agentId })
      .expect(201);

    return {
      owner,
      agentId,
      keyId,
      mandateId: mandate.body.id as string,
      signer: signerFromJwk(keyId, jwk),
      privateKey: privateKey as CryptoKey,
    };
  }

  const sign = (
    holder: { agentId: string; signer: ReturnType<typeof signerFromJwk> },
    overrides: Partial<{ nonce: string; requestedAt: string; actor: string; amount: unknown }> = {},
  ): Promise<ActionRequest> =>
    signActionRequest(
      {
        id: `req_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`,
        nonce: (overrides.nonce ?? `nonce-${crypto.randomUUID()}`) as string,
        actor: (overrides.actor ?? holder.agentId) as string,
        action: "payment.execute",
        resource: ERP,
        counterparty: "Kalyani Steel Works",
        description: "Invoice settled by the agent itself",
        requestedAt: (overrides.requestedAt ?? new Date().toISOString().replace(/\.\d+Z$/, "Z")) as string,
        amount: inr(100_000),
      },
      holder.signer,
    );

  const present = (holder: { owner: Member; mandateId: string }, signed: ActionRequest) =>
    request(app)
      .post("/v1/actions/signed")
      .set(as(holder.owner))
      .send({ mandateId: holder.mandateId, request: signed });

  it("still refuses to sign on a registered agent's behalf, and says where to go", async () => {
    const holder = await activeAgentHoldingItsOwnKey();

    const response = await request(app)
      .post("/v1/actions")
      .set(as(holder.owner))
      .send({
        mandateId: holder.mandateId,
        action: "payment.execute",
        resource: ERP,
        counterparty: "Kalyani Steel Works",
        description: "Service tries to act for the agent",
        nonce: `nonce-${crypto.randomUUID()}`,
        amount: inr(100_000),
      })
      .expect(422);

    expect(response.body.error).toBe("agent_key_unavailable");
    expect(response.body.message).toMatch(/\/v1\/actions\/signed/);
  }, 30_000);

  it("accepts a request the agent signed and verifies it against the published key", async () => {
    const holder = await activeAgentHoldingItsOwnKey();
    const outcome = await present(holder, await sign(holder)).expect(201);

    expect(outcome.body.verdict).toBe("ALLOW");

    const checks = outcome.body.decision.checks as Array<{ id: string; status: string }>;
    expect(checks.find((check) => check.id === "request.signature")?.status).toBe("pass");
    expect(checks.find((check) => check.id === "actor.possession")?.status).toBe("pass");
    expect(checks.find((check) => check.id === "agent.status")?.status).toBe("pass");

    const stored = await request(app)
      .get(`/v1/evidence/${outcome.body.packId}`)
      .set(as(holder.owner))
      .expect(200);
    const report = await verifyEvidencePack(stored.body as EvidencePack, {
      trustRoots: stored.body.trustRoots,
    });
    expect(report.result).toBe("VERIFIED");
    expect(report.authority?.reproduced).toBe(true);
  }, 30_000);

  it("blocks a request signed by a key that is not the mandate subject's", async () => {
    const holder = await activeAgentHoldingItsOwnKey();
    const stranger = await generateKeyPair("ES256", { extractable: true });
    const strangerJwk = (await exportJWK(stranger.privateKey)) as PrivateKeyJwk;

    const forged = await sign({
      agentId: holder.agentId,
      signer: signerFromJwk(holder.keyId, strangerJwk),
    });

    const outcome = await present(holder, forged).expect(201);
    expect(outcome.body.verdict).toBe("BLOCK");

    const checks = outcome.body.decision.checks as Array<{ id: string; status: string }>;
    expect(checks.find((check) => check.id === "request.signature")?.status).toBe("fail");
  }, 30_000);

  it("blocks a request whose actor is not the agent the mandate names", async () => {
    const holder = await activeAgentHoldingItsOwnKey();
    const outcome = await present(holder, await sign(holder, { actor: "agt_somebody_else" })).expect(
      201,
    );

    expect(outcome.body.verdict).toBe("BLOCK");
    const checks = outcome.body.decision.checks as Array<{ id: string; status: string }>;
    expect(checks.find((check) => check.id === "actor.binding")?.status).toBe("fail");
  }, 30_000);

  it("finally makes the freshness window bite: a request signed long ago is refused", async () => {
    const holder = await activeAgentHoldingItsOwnKey();
    const stale = await sign(holder, { requestedAt: "2026-01-02T00:00:00Z" });

    const outcome = await present(holder, stale).expect(201);
    expect(outcome.body.verdict).toBe("BLOCK");

    const freshness = (outcome.body.decision.checks as Array<{ id: string; status: string }>).find(
      (check) => check.id === "request.freshness",
    );
    expect(freshness?.status).toBe("fail");
  }, 30_000);

  it("claims the nonce from the presented request, so a replay is caught", async () => {
    const holder = await activeAgentHoldingItsOwnKey();
    const nonce = `nonce-${crypto.randomUUID()}`;

    const first = await present(holder, await sign(holder, { nonce })).expect(201);
    expect(first.body.verdict).toBe("ALLOW");

    const second = await present(holder, await sign(holder, { nonce })).expect(201);
    expect(second.body.verdict).toBe("BLOCK");

    const replay = (second.body.decision.checks as Array<{ id: string; status: string }>).find(
      (check) => check.id === "replay.freshness",
    );
    expect(replay?.status).toBe("fail");
  }, 30_000);

  it("blocks once the agent is suspended, even though the signature is still good", async () => {
    const holder = await activeAgentHoldingItsOwnKey();
    await move(holder.owner, holder.agentId, "suspended", "under review").expect(200);

    const outcome = await present(holder, await sign(holder)).expect(201);
    expect(outcome.body.verdict).toBe("BLOCK");

    const checks = outcome.body.decision.checks as Array<{ id: string; status: string }>;
    expect(checks.find((check) => check.id === "request.signature")?.status).toBe("pass");
    expect(checks.find((check) => check.id === "agent.status")?.status).toBe("fail");
  }, 30_000);

  it("refuses to present a request against another organisation's mandate", async () => {
    const holder = await activeAgentHoldingItsOwnKey();
    const outsider = await enrol("user_rahul", "Kalyani Steel Works");

    await request(app)
      .post("/v1/actions/signed")
      .set(as(outsider))
      .send({ mandateId: holder.mandateId, request: await sign(holder) })
      .expect(404);
  }, 30_000);
});
