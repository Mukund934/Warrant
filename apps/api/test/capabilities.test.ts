import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { verifyEvidencePack } from "@warrant/core";
import type { Check, EvidencePack, TrustRoot } from "@warrant/core";
import { createApp } from "../src/app.js";
import { InMemoryCapabilityRepository, createInMemoryRepositories } from "../src/persistence/memory.js";
import type { Capability, Repositories } from "../src/persistence/types.js";
import { testIdentity } from "./support/identity.js";
import type { TestIdentity } from "./support/identity.js";

const inr = (major: number) => ({ currency: "INR" as const, minor: major * 100 });

const ERP = "erp:meridian/accounts-payable";
const KALYANI = "Kalyani Steel Works";

const SCOPE = {
  actions: ["payment.execute", "invoice.read"],
  audience: [ERP],
  counterparties: { any: true },
  limits: { perAction: inr(1_000_000) },
};

const ROOT_MANDATE = {
  scope: SCOPE,
  notBefore: "2026-01-01T00:00:00Z",
  expiresAt: "2027-01-01T00:00:00Z",
  maxDelegationDepth: 2,
};

const PAYMENT = {
  id: "payment.execute",
  title: "Execute a payment",
  description: "Move money to a supplier against an approved invoice",
  risk: "high" as const,
  amount: "required" as const,
  currencies: ["INR" as const],
};

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


const statusOf = (checks: Check[], id: string) => checks.find((check) => check.id === id)?.status;
const detailOf = (checks: Check[], id: string) => checks.find((check) => check.id === id)?.detail;

async function enrol(subject: string, organisation: string): Promise<Member> {
  const token = await identity.mint(subject, `${subject}@example.test`);
  const created = await request(app)
    .post("/v1/organisations")
    .set("authorization", `Bearer ${token}`)
    .send({ name: organisation, jurisdiction: "IN-MH" })
    .expect(201);
  return { token, organisationId: created.body.id };
}

const define = (who: Member, capability: Record<string, unknown>) =>
  request(app).post("/v1/capabilities").set(as(who)).send(capability);

const enforce = (who: Member, enforcement: "advisory" | "required") =>
  request(app).post("/v1/capabilities/enforcement").set(as(who)).send({ enforcement });

const move = (who: Member, id: string, status: string) =>
  request(app).post(`/v1/capabilities/${id}/status`).set(as(who)).send({ status });

async function mandateFor(who: Member, scope: Record<string, unknown> = SCOPE): Promise<string> {
  const created = await request(app)
    .post("/v1/mandates")
    .set(as(who))
    .send({ ...ROOT_MANDATE, scope })
    .expect(201);
  return created.body.id as string;
}

interface ActionShape {
  action?: string;
  amount?: ReturnType<typeof inr> | null;
}

function act(who: Member, mandateId: string, shape: ActionShape = {}) {
  const amount = shape.amount === undefined ? inr(100_000) : shape.amount;

  return request(app)
    .post("/v1/actions")
    .set(as(who))
    .send({
      mandateId,
      action: shape.action ?? "payment.execute",
      resource: ERP,
      counterparty: KALYANI,
      description: "Invoice settlement",
      nonce: `nonce-catalogue-${unique()}`,
      ...(amount ? { amount } : {}),
    });
}

const packFor = async (who: Member, packId: string): Promise<EvidencePack> =>
  (await request(app).get(`/v1/evidence/${packId}`).set(as(who)).expect(200)).body;

describe("registering a capability", () => {
  it("records it as active, carrying the risk the organisation assigned", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const created = await define(owner, PAYMENT).expect(201);

    expect(created.body.status).toBe("active");
    expect(created.body.risk).toBe("high");
    expect(created.body.organisationId).toBe(owner.organisationId);
  });

  it("refuses an id that is not qualified, so a mandate reads the same as the catalogue", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const refused = await define(owner, { ...PAYMENT, id: "execute" }).expect(422);

    expect(refused.body.error).toBe("capability_id_rejected");
  });

  it("refuses a capability that contradicts itself", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const refused = await define(owner, {
      id: "invoice.read",
      title: "Read an invoice",
      description: "Look at a supplier invoice",
      risk: "low",
      amount: "forbidden",
      approvalAbove: inr(1_000),
    }).expect(422);

    expect(refused.body.error).toBe("capability_contradicts_itself");
  });

  it("refuses a second registration of the same id", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    await define(owner, PAYMENT).expect(201);

    expect((await define(owner, PAYMENT).expect(422)).body.error).toBe("capability_exists");
  });

  it("refuses an unknown field rather than dropping it", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    await define(owner, { ...PAYMENT, enforcement: "advisory" }).expect(400);
  });
});

describe("an organisation that has registered nothing", () => {
  it("is not consulted at all, so its decisions are unchanged", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const outcome = await act(owner, await mandateFor(owner)).expect(201);

    expect(outcome.body.verdict).toBe("ALLOW");
    expect(statusOf(outcome.body.decision.checks, "capability.registered")).toBe("skip");
  });

  it("is still not consulted after enforcement is switched on with an empty catalogue", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    await enforce(owner, "required").expect(200);

    const outcome = await act(owner, await mandateFor(owner)).expect(201);
    expect(outcome.body.verdict).toBe("ALLOW");
    expect(statusOf(outcome.body.decision.checks, "capability.registered")).toBe("skip");
  });
});

describe("a catalogue the organisation only observes", () => {
  it("records an unknown action as a warning without changing the verdict", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    await define(owner, { ...PAYMENT, id: "invoice.read", amount: "optional" }).expect(201);

    const outcome = await act(owner, await mandateFor(owner)).expect(201);

    expect(outcome.body.verdict).toBe("ALLOW");
    expect(statusOf(outcome.body.decision.checks, "capability.registered")).toBe("warn");
    expect(detailOf(outcome.body.decision.checks, "capability.registered")).toMatch(
      /advisory, so the action was not refused/,
    );
  });
});

describe("a catalogue the organisation enforces", () => {
  async function enforcing(): Promise<Member> {
    const owner = await enrol("user_priya", "Meridian Technologies");
    await define(owner, PAYMENT).expect(201);
    await enforce(owner, "required").expect(200);
    return owner;
  }

  it("lets a defined capability proceed and names its risk in the evidence", async () => {
    const owner = await enforcing();
    const outcome = await act(owner, await mandateFor(owner)).expect(201);

    expect(outcome.body.verdict).toBe("ALLOW");
    expect(statusOf(outcome.body.decision.checks, "capability.registered")).toBe("pass");
    expect(detailOf(outcome.body.decision.checks, "capability.registered")).toMatch(/at high risk/);
  });

  it("blocks an action the organisation has never defined", async () => {
    const owner = await enforcing();
    const outcome = await act(owner, await mandateFor(owner), { action: "invoice.read" }).expect(201);

    expect(outcome.body.verdict).toBe("BLOCK");
    expect(statusOf(outcome.body.decision.checks, "capability.registered")).toBe("fail");
  });

  it("blocks a withdrawn capability and says it was withdrawn, not that it never existed", async () => {
    const owner = await enforcing();
    await move(owner, "payment.execute", "withdrawn").expect(200);

    const outcome = await act(owner, await mandateFor(owner)).expect(201);

    expect(outcome.body.verdict).toBe("BLOCK");
    expect(detailOf(outcome.body.decision.checks, "capability.registered")).toMatch(/was withdrawn/);
  });

  it("still honours a deprecated capability, with a warning", async () => {
    const owner = await enforcing();
    await move(owner, "payment.execute", "deprecated").expect(200);

    const outcome = await act(owner, await mandateFor(owner)).expect(201);

    expect(outcome.body.verdict).toBe("ALLOW");
    expect(statusOf(outcome.body.decision.checks, "capability.registered")).toBe("warn");
  });

  it("refuses to move a withdrawn capability anywhere, because withdrawal is final", async () => {
    const owner = await enforcing();
    await move(owner, "payment.execute", "withdrawn").expect(200);

    expect((await move(owner, "payment.execute", "active").expect(422)).body.error).toBe(
      "transition_refused",
    );
  });

  it("enforces the shape the capability declares", async () => {
    const owner = await enforcing();
    await define(owner, {
      id: "invoice.read",
      title: "Read an invoice",
      description: "Look at a supplier invoice",
      risk: "low",
      amount: "forbidden",
    }).expect(201);

    const outcome = await act(owner, await mandateFor(owner), {
      action: "invoice.read",
      amount: inr(100_000),
    }).expect(201);

    expect(outcome.body.verdict).toBe("BLOCK");
    expect(statusOf(outcome.body.decision.checks, "capability.contract")).toBe("fail");
  });
});

describe("the catalogue never grants what the mandate withholds", () => {
  it("cannot put an action into scope by defining it", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    await define(owner, { ...PAYMENT, id: "payroll.run" }).expect(201);
    await enforce(owner, "required").expect(200);

    const mandateId = await mandateFor(owner, { ...SCOPE, actions: ["invoice.read"] });
    const outcome = await act(owner, mandateId, { action: "payroll.run" }).expect(201);

    expect(outcome.body.verdict).toBe("BLOCK");
    expect(statusOf(outcome.body.decision.checks, "action.in_scope")).toBe("fail");
  });

  it("cannot loosen an approval requirement the authority already carries", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    await define(owner, { ...PAYMENT, approvalAbove: inr(900_000) }).expect(201);

    const mandateId = await mandateFor(owner, { ...SCOPE, approval: { above: inr(200_000) } });
    const outcome = await act(owner, mandateId, { amount: inr(400_000) }).expect(201);

    expect(outcome.body.verdict).toBe("ESCALATE");
    expect(detailOf(outcome.body.decision.checks, "policy.escalation")).toMatch(
      /the authority itself carries that requirement/,
    );
  });

  it("does tighten an approval requirement, and says the catalogue is why", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    await define(owner, { ...PAYMENT, approvalAbove: inr(150_000) }).expect(201);

    const mandateId = await mandateFor(owner, { ...SCOPE, approval: { above: inr(600_000) } });
    const outcome = await act(owner, mandateId, { amount: inr(400_000) }).expect(201);

    expect(outcome.body.verdict).toBe("ESCALATE");
    expect(detailOf(outcome.body.decision.checks, "policy.escalation")).toMatch(
      /capability catalogue attaches that requirement/,
    );
  });

  it("reaches an action taken further down a delegated chain", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    await define(owner, PAYMENT).expect(201);
    await enforce(owner, "required").expect(200);

    const rootId = await mandateFor(owner);
    const delegated = await request(app)
      .post(`/v1/mandates/${rootId}/delegations`)
      .set(as(owner))
      .send({ scopeDelta: { actions: ["invoice.read"] } })
      .expect(201);

    const outcome = await act(owner, delegated.body.id, {
      action: "invoice.read",
      amount: null,
    }).expect(201);

    expect(outcome.body.verdict).toBe("BLOCK");
    expect(statusOf(outcome.body.decision.checks, "capability.registered")).toBe("fail");
  });
});

describe("one organisation's catalogue never answers for another's", () => {
  it("does not let a neighbour's registration satisfy an enforced catalogue", async () => {
    const meridian = await enrol("user_priya", "Meridian Technologies");
    const kalyani = await enrol("user_rahul", "Kalyani Steel Works");

    await define(kalyani, PAYMENT).expect(201);
    await define(meridian, { ...PAYMENT, id: "invoice.read", amount: "optional" }).expect(201);
    await enforce(meridian, "required").expect(200);

    const outcome = await act(meridian, await mandateFor(meridian)).expect(201);

    expect(outcome.body.verdict).toBe("BLOCK");
    expect(statusOf(outcome.body.decision.checks, "capability.registered")).toBe("fail");
  });

  it("lists only the caller's own capabilities", async () => {
    const meridian = await enrol("user_priya", "Meridian Technologies");
    const kalyani = await enrol("user_rahul", "Kalyani Steel Works");
    await define(kalyani, PAYMENT).expect(201);

    const mine = await request(app).get("/v1/capabilities").set(as(meridian)).expect(200);
    expect(mine.body).toEqual([]);

    const theirs = await request(app).get("/v1/capabilities").set(as(kalyani)).expect(200);
    expect(theirs.body).toHaveLength(1);
  });

  it("refuses to read a capability that belongs to someone else", async () => {
    const meridian = await enrol("user_priya", "Meridian Technologies");
    const kalyani = await enrol("user_rahul", "Kalyani Steel Works");
    await define(kalyani, PAYMENT).expect(201);

    await request(app).get("/v1/capabilities/payment.execute").set(as(meridian)).expect(404);
  });

  it("refuses to withdraw a capability that belongs to someone else", async () => {
    const meridian = await enrol("user_priya", "Meridian Technologies");
    const kalyani = await enrol("user_rahul", "Kalyani Steel Works");
    await define(kalyani, PAYMENT).expect(201);

    await move(meridian, "payment.execute", "withdrawn").expect(404);

    const theirs = await request(app)
      .get("/v1/capabilities/payment.execute")
      .set(as(kalyani))
      .expect(200);
    expect(theirs.body.status).toBe("active");
  });

  it("keeps enforcement itself per organisation", async () => {
    const meridian = await enrol("user_priya", "Meridian Technologies");
    const kalyani = await enrol("user_rahul", "Kalyani Steel Works");
    await enforce(meridian, "required").expect(200);

    const theirs = await request(app)
      .get("/v1/capabilities/enforcement")
      .set(as(kalyani))
      .expect(200);
    expect(theirs.body.enforcement).toBe("advisory");
  });
});

describe("evidence a relying party already holds", () => {
  it("keeps reproducing after the capability is withdrawn", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    await define(owner, PAYMENT).expect(201);
    await enforce(owner, "required").expect(200);

    const outcome = await act(owner, await mandateFor(owner)).expect(201);
    expect(outcome.body.verdict).toBe("ALLOW");

    await move(owner, "payment.execute", "withdrawn").expect(200);

    const pack = await packFor(owner, outcome.body.packId);
    const report = await verifyEvidencePack(pack, { trustRoots: await publishedRoots(owner) });

    expect(report.result).toBe("VERIFIED");
    expect(report.authority?.verdict).toBe("ALLOW");
    expect(report.authority?.reproduced).toBe(true);
  });

  it("reproduces a catalogue-driven refusal without the verifier holding the catalogue", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    await define(owner, { ...PAYMENT, id: "invoice.read", amount: "optional" }).expect(201);
    await enforce(owner, "required").expect(200);

    const outcome = await act(owner, await mandateFor(owner)).expect(201);
    expect(outcome.body.verdict).toBe("BLOCK");

    const pack = await packFor(owner, outcome.body.packId);
    const report = await verifyEvidencePack(pack, { trustRoots: await publishedRoots(owner) });

    expect(report.result).toBe("VERIFIED");
    expect(report.authority?.verdict).toBe("BLOCK");
    expect(report.authority?.reproduced).toBe(true);
  });

  it("refuses a pack whose recorded capability has been edited", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    await define(owner, { ...PAYMENT, id: "invoice.read", amount: "optional" }).expect(201);
    await enforce(owner, "required").expect(200);

    const outcome = await act(owner, await mandateFor(owner)).expect(201);
    const pack = await packFor(owner, outcome.body.packId);

    const edited = {
      ...pack,
      decision: {
        ...pack.decision,
        inputs: {
          ...pack.decision.inputs,
          capability: { ...pack.decision.inputs.capability!, status: "registered" as const },
        },
      },
    };

    expect((await verifyEvidencePack(edited, { trustRoots: await publishedRoots(owner) })).result).toBe("INVALID");
  });
});

// The service refuses a foreign capability before the store is ever asked, so these reach past it.
// Without them a store that ignored the organisation would still look correct through the API.
describe("the store beneath the service is scoped in its own right", () => {
  const record = (organisationId: string): Capability => ({
    id: "payment.execute",
    organisationId,
    title: "Execute a payment",
    description: "Move money to a supplier",
    risk: "high",
    amount: "required",
    status: "active",
    registeredAt: "2026-08-19T09:00:00Z",
    statusChangedAt: "2026-08-19T09:00:00Z",
  });

  it("refuses a status change aimed at another organisation's capability", async () => {
    const store = new InMemoryCapabilityRepository();
    await store.register(record("org:meridian"));

    const applied = await store.setStatus(
      "payment.execute",
      "withdrawn",
      "2026-08-19T10:00:00Z",
      "org:kalyani",
    );

    expect(applied).toBe(false);
    expect((await store.find("payment.execute", "org:meridian"))?.status).toBe("active");
  });

  it("lets two organisations hold the same id with different meanings", async () => {
    const store = new InMemoryCapabilityRepository();
    expect(await store.register(record("org:meridian"))).toBe(true);
    expect(await store.register({ ...record("org:kalyani"), risk: "low" })).toBe(true);

    expect((await store.find("payment.execute", "org:meridian"))?.risk).toBe("high");
    expect((await store.find("payment.execute", "org:kalyani"))?.risk).toBe("low");
  });

  it("counts only the organisation's own capabilities", async () => {
    const store = new InMemoryCapabilityRepository();
    await store.register(record("org:meridian"));

    expect((await store.catalogue("org:kalyani")).size).toBe(0);
    expect((await store.catalogue("org:meridian")).size).toBe(1);
  });
});
