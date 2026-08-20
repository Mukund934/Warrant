import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { exportJWK, generateKeyPair } from "jose";
import type { JWK } from "jose";
import { createApp } from "../src/app.js";
import { InMemoryMandateRepository, createInMemoryRepositories } from "../src/persistence/memory.js";
import type { Repositories } from "../src/persistence/types.js";
import type { TimelineEntry } from "../src/services/timeline.js";
import { demoScenarios } from "@warrant/core/fixtures";
import { testIdentity } from "./support/identity.js";
import type { TestIdentity } from "./support/identity.js";

const inr = (major: number) => ({ currency: "INR" as const, minor: major * 100 });

const ERP = "erp:meridian/accounts-payable";
const KALYANI = "Kalyani Steel Works";

const SCOPE = {
  actions: ["payment.execute", "invoice.read"],
  audience: [ERP],
  counterparties: { allow: [KALYANI] },
  limits: { perAction: inr(300_000) },
};

const window = { notBefore: "2026-01-01T00:00:00Z", expiresAt: "2027-01-01T00:00:00Z" };

let identity: TestIdentity;
let repositories: Repositories;
let app: Express;
let counter = 0;

const unique = () => (counter += 1).toString().padStart(6, "0");

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
    .send({ scope: SCOPE, ...window, maxDelegationDepth: 3 })
    .expect(201);
  return created.body.id as string;
}

async function delegate(who: Member, parentId: string, actions: string[]): Promise<string> {
  const created = await request(app)
    .post(`/v1/mandates/${parentId}/delegations`)
    .set(as(who))
    .send({ scopeDelta: { actions } })
    .expect(201);
  return created.body.id as string;
}

async function act(who: Member, mandateId: string, amount = inr(100_000)): Promise<string> {
  const outcome = await request(app)
    .post("/v1/actions")
    .set(as(who))
    .send({
      mandateId,
      action: "payment.execute",
      resource: ERP,
      counterparty: KALYANI,
      description: "Invoice settlement",
      nonce: `nonce-timeline-${unique()}`,
      amount,
    })
    .expect(201);
  return outcome.body.packId as string;
}

const timeline = (who: Member, mandateId: string) =>
  request(app).get(`/v1/mandates/${mandateId}/timeline`).set(as(who));

const typesIn = (entries: TimelineEntry[]) => entries.map((entry) => entry.type);

describe("the ordered account of one authority", () => {
  it("opens with the issuance and names who delegated to whom", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const mandateId = await issue(owner);

    const view = await timeline(owner, mandateId).expect(200);

    expect(view.body.mandates).toEqual([mandateId]);
    expect(view.body.entries).toHaveLength(1);
    expect(view.body.entries[0].type).toBe("mandate.issued");
    expect(view.body.entries[0].summary).toMatch(/delegated authority to .* at depth 0/);
  });

  it("covers everything delegated beneath it, not merely the mandate named", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const rootId = await issue(owner);
    const childId = await delegate(owner, rootId, ["payment.execute"]);

    const view = await timeline(owner, rootId).expect(200);

    expect(view.body.mandates).toEqual([rootId, childId]);
    expect(typesIn(view.body.entries)).toEqual(["mandate.issued", "mandate.issued"]);
  });

  it("reads in the order the ledger recorded, request before decision", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const mandateId = await issue(owner);
    await act(owner, mandateId);

    const view = await timeline(owner, mandateId).expect(200);

    expect(typesIn(view.body.entries)).toEqual([
      "mandate.issued",
      "action.requested",
      "decision.recorded",
    ]);
    const seqs = view.body.entries.map((entry: TimelineEntry) => entry.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
  });

  it("says what was asked and what was decided, in words", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const mandateId = await issue(owner);
    const packId = await act(owner, mandateId, inr(250_000));

    const view = await timeline(owner, mandateId).expect(200);
    const requested = view.body.entries.find((e: TimelineEntry) => e.type === "action.requested");
    const decided = view.body.entries.find((e: TimelineEntry) => e.type === "decision.recorded");

    expect(requested.summary).toMatch(/asked to payment\.execute for ₹2,50,000\.00 with Kalyani/);
    expect(requested.packId).toBe(packId);
    expect(decided.verdict).toBe("ALLOW");
    expect(decided.packId).toBe(packId);
  });

  it("records a withdrawal with the reason it was given", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const mandateId = await issue(owner);

    await request(app)
      .post(`/v1/mandates/${mandateId}/revocation`)
      .set(as(owner))
      .send({ reason: "the supplier relationship ended" })
      .expect(204);

    const view = await timeline(owner, mandateId).expect(200);
    const revoked = view.body.entries.find((e: TimelineEntry) => e.type === "mandate.revoked");

    expect(revoked.summary).toMatch(/was withdrawn: the supplier relationship ended/);
  });

  it("shows the agent lifecycle that explains a later refusal", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");

    const { publicKey } = await generateKeyPair("ES256", { extractable: true });
    const registered = await request(app)
      .post("/v1/agents")
      .set(as(owner))
      .send({
        name: "Payments runner",
        runtime: "node/22",
        publicKeyJwk: (await exportJWK(publicKey)) as JWK,
      })
      .expect(201);

    const agentId = registered.body.id as string;
    await request(app)
      .post(`/v1/agents/${agentId}/status`)
      .set(as(owner))
      .send({ status: "active" })
      .expect(200);

    const created = await request(app)
      .post("/v1/mandates")
      .set(as(owner))
      .send({ scope: SCOPE, ...window, maxDelegationDepth: 1, agentId })
      .expect(201);

    await request(app)
      .post(`/v1/agents/${agentId}/status`)
      .set(as(owner))
      .send({ status: "suspended", reason: "under review" })
      .expect(200);

    const view = await timeline(owner, created.body.id).expect(200);

    expect(typesIn(view.body.entries)).toContain("agent.registered");
    expect(typesIn(view.body.entries)).toContain("agent.status_changed");
    expect(
      view.body.entries.find((e: TimelineEntry) => e.type === "agent.registered").summary,
    ).toMatch(/Payments runner was registered/);
  });

  it("states what the view covers rather than implying it is the whole chain", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const view = await timeline(owner, await issue(owner)).expect(200);

    expect(view.body.coverage).toMatch(/filtered view/);
    expect(view.body.coverage).toMatch(/continuity across the full chain is not claimed/);
    expect(view.body.coverage).toMatch(/not recomputed/);
  });

  it("refuses a mandate it cannot resolve", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    await timeline(owner, "mnd_nope").expect(404);
  });
});

// The ledger is one chain for the whole deployment with no tenant column. These are the tests that
// matter: a leak here would not look like a wrong verdict, only like rows that should not be there.
describe("a timeline never reaches another organisation", () => {
  it("refuses a mandate belonging to someone else", async () => {
    const meridian = await enrol("user_priya", "Meridian Technologies");
    const kalyani = await enrol("user_rahul", "Kalyani Steel Works");

    const theirs = await issue(meridian);
    await act(meridian, theirs);

    await timeline(kalyani, theirs).expect(404);
  });

  it("shows only its own entries when both organisations are busy on one ledger", async () => {
    const meridian = await enrol("user_priya", "Meridian Technologies");
    const kalyani = await enrol("user_rahul", "Kalyani Steel Works");

    const mine = await issue(meridian);
    const theirs = await issue(kalyani);
    await act(meridian, mine);
    await act(kalyani, theirs);
    await act(kalyani, theirs);

    const view = await timeline(meridian, mine).expect(200);
    const total = await repositories.ledger.count();

    expect(view.body.entries).toHaveLength(3);
    expect(total).toBeGreaterThan(view.body.entries.length);
    expect(view.body.mandates).toEqual([mine]);
    expect(JSON.stringify(view.body)).not.toContain(theirs);
  });

  it("does not sweep in a sibling branch when asked about one part of a tree", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const rootId = await issue(owner);
    const branch = await delegate(owner, rootId, ["payment.execute"]);
    const sibling = await delegate(owner, rootId, ["invoice.read"]);

    const view = await timeline(owner, branch).expect(200);

    expect(view.body.mandates).toEqual([branch]);
    expect(JSON.stringify(view.body)).not.toContain(sibling);
  });
});

// Delegation always inherits its parent's organisation, so the API cannot produce a mandate whose
// parent belongs to someone else. That makes the store's own tenant check unreachable from above,
// and therefore untested unless something reaches past the service to build the state directly.
describe("the mandate store refuses to walk out of its own organisation", () => {
  it("stops at a child recorded under a different organisation", async () => {
    const chain = (await demoScenarios())
      .map((scenario) => scenario.pack.authority.chain)
      .find((candidate) => candidate.length > 1)!;

    const parent = { ...chain[0]!, organisation: { ...chain[0]!.organisation, id: "org:ours" } };
    const stray = {
      ...chain[1]!,
      organisation: { ...chain[1]!.organisation, id: "org:theirs" },
      parent: { id: parent.id, digest: chain[1]!.parent!.digest },
    };

    const store = new InMemoryMandateRepository();
    await store.save(parent);
    await store.save(stray);

    const ours = await store.descendants(parent.id, "org:ours");
    expect(ours.map((mandate) => mandate.id)).toEqual([parent.id]);

    const unscoped = await store.descendants(parent.id, null);
    expect(unscoped.map((mandate) => mandate.id)).toEqual([parent.id, stray.id]);
  });
});
