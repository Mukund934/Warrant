import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import type { Check } from "@warrant/core";
import { createApp } from "../src/app.js";
import { createInMemoryRepositories } from "../src/persistence/memory.js";
import type { Repositories } from "../src/persistence/types.js";
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

const failing = (checks: Check[]) =>
  checks.filter((check) => check.status === "fail").map((check) => check.id);

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

async function mandateFor(who: Member, scope: Record<string, unknown> = SCOPE): Promise<string> {
  const created = await request(app)
    .post("/v1/mandates")
    .set(as(who))
    .send({ scope, ...window, maxDelegationDepth: 2 })
    .expect(201);
  return created.body.id as string;
}

interface Shape {
  action?: string;
  resource?: string;
  counterparty?: string;
  amount?: ReturnType<typeof inr>;
}

const body = (mandateId: string, shape: Shape) => ({
  mandateId,
  action: shape.action ?? "payment.execute",
  resource: shape.resource ?? ERP,
  counterparty: shape.counterparty ?? KALYANI,
  amount: shape.amount ?? inr(100_000),
});

const predict = (who: Member, mandateId: string, shape: Shape = {}) =>
  request(app).post("/v1/simulations").set(as(who)).send(body(mandateId, shape));

const perform = (who: Member, mandateId: string, shape: Shape = {}) =>
  request(app)
    .post("/v1/actions")
    .set(as(who))
    .send({
      ...body(mandateId, shape),
      description: "Invoice settlement",
      nonce: `nonce-sim-${unique()}`,
    });

describe("asking what would happen", () => {
  it("predicts an action the authority permits", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const outcome = await predict(owner, await mandateFor(owner)).expect(200);

    expect(outcome.body.simulated).toBe(true);
    expect(outcome.body.verdict).toBe("ALLOW");
    expect(outcome.body.effectiveScope.actions).toEqual(SCOPE.actions);
  });

  it("names the check that would refuse, not merely that it would fail", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const outcome = await predict(owner, await mandateFor(owner), {
      amount: inr(900_000),
    }).expect(200);

    expect(outcome.body.verdict).toBe("BLOCK");
    expect(failing(outcome.body.checks)).toEqual(["limit.per_action"]);
    expect(outcome.body.reason).toMatch(/exceeds the delegated per-action limit/);
  });

  it("says plainly what it assumed rather than pretending it proved everything", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const outcome = await predict(owner, await mandateFor(owner)).expect(200);

    expect(outcome.body.assumptions).toHaveLength(2);
    expect(checkFor(outcome.body.checks, "request.signature")?.detail).toMatch(/assumed for this/);
    expect(checkFor(outcome.body.checks, "actor.possession")?.detail).toMatch(/Nothing was signed/);
    expect(checkFor(outcome.body.checks, "replay.freshness")?.status).toBe("skip");
  });

  it("refuses an unknown field rather than dropping it", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const mandateId = await mandateFor(owner);

    await request(app)
      .post("/v1/simulations")
      .set(as(owner))
      .send({ ...body(mandateId, {}), nonce: "n-00000001" })
      .expect(400);
  });

  it("refuses a chain it cannot resolve", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    await request(app)
      .post("/v1/simulations")
      .set(as(owner))
      .send(body("mnd_nope", {}))
      .expect(404);
  });
});

describe("a simulation records nothing", () => {
  it("appends no ledger entry and saves no evidence", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const mandateId = await mandateFor(owner);

    const before = await repositories.ledger.count();
    await predict(owner, mandateId).expect(200);
    await predict(owner, mandateId, { amount: inr(900_000) }).expect(200);

    expect(await repositories.ledger.count()).toBe(before);
    expect(await repositories.evidence.recent(50, owner.organisationId)).toEqual([]);
  });

  it("burns no nonce, so the real action is still fresh afterwards", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const mandateId = await mandateFor(owner);

    for (let attempt = 0; attempt < 3; attempt += 1) await predict(owner, mandateId).expect(200);

    const real = await perform(owner, mandateId).expect(201);
    expect(real.body.verdict).toBe("ALLOW");
    expect(checkFor(real.body.decision.checks, "replay.freshness")?.status).toBe("pass");
  });

  it("returns nothing that could be mistaken for a decision", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const outcome = await predict(owner, await mandateFor(owner)).expect(200);

    expect(outcome.body.id).toBeUndefined();
    expect(outcome.body.proof).toBeUndefined();
    expect(outcome.body.packId).toBeUndefined();
    expect(outcome.body.gate).toBeUndefined();
    expect(outcome.body.evaluatedAt).toBeUndefined();
  });
});

// The whole value of a prediction is that it is the same answer. These run both paths and compare.
describe("the prediction and the decision agree", () => {
  it("agrees on an action that proceeds", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const mandateId = await mandateFor(owner);

    const predicted = await predict(owner, mandateId).expect(200);
    const real = await perform(owner, mandateId).expect(201);

    expect(predicted.body.verdict).toBe(real.body.verdict);
    expect(failing(predicted.body.checks)).toEqual(failing(real.body.decision.checks));
  });

  it("agrees on an action that is refused, down to the failing check", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const mandateId = await mandateFor(owner);
    const shape = { counterparty: "Someone Else Ltd" as string };

    const predicted = await predict(owner, mandateId, shape).expect(200);
    const real = await perform(owner, mandateId, shape).expect(201);

    expect(predicted.body.verdict).toBe("BLOCK");
    expect(real.body.verdict).toBe("BLOCK");
    expect(failing(predicted.body.checks)).toEqual(failing(real.body.decision.checks));
  });

  it("agrees after the mandate has been revoked", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const mandateId = await mandateFor(owner);

    await request(app)
      .post(`/v1/mandates/${mandateId}/revocation`)
      .set(as(owner))
      .send({ reason: "withdrawn" })
      .expect(204);

    const predicted = await predict(owner, mandateId).expect(200);
    const real = await perform(owner, mandateId).expect(201);

    expect(predicted.body.verdict).toBe("BLOCK");
    expect(failing(predicted.body.checks)).toEqual(failing(real.body.decision.checks));
  });
});

describe("a simulation sees the same policy a real action sees", () => {
  it("consults the capability catalogue", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    await request(app)
      .post("/v1/capabilities")
      .set(as(owner))
      .send({
        id: "invoice.read",
        title: "Read an invoice",
        description: "Look at a supplier invoice",
        risk: "low",
        amount: "optional",
      })
      .expect(201);
    await request(app)
      .post("/v1/capabilities/enforcement")
      .set(as(owner))
      .send({ enforcement: "required" })
      .expect(200);

    const outcome = await predict(owner, await mandateFor(owner)).expect(200);

    expect(outcome.body.verdict).toBe("BLOCK");
    expect(checkFor(outcome.body.checks, "capability.registered")?.status).toBe("fail");
  });

  it("applies the house ceiling", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const mandateId = await mandateFor(owner);

    await request(app)
      .post("/v1/house-scope")
      .set(as(owner))
      .send({
        scope: {
          actions: SCOPE.actions,
          audience: SCOPE.audience,
          counterparties: { any: true },
          limits: { perAction: inr(50_000) },
        },
      })
      .expect(200);

    const outcome = await predict(owner, mandateId, { amount: inr(100_000) }).expect(200);

    expect(outcome.body.verdict).toBe("BLOCK");
    expect(outcome.body.reason).toMatch(/ceiling narrowed limits\.perAction after delegation/);
  });
});

describe("who may ask", () => {
  it("refuses to simulate against another organisation's mandate", async () => {
    const meridian = await enrol("user_priya", "Meridian Technologies");
    const kalyani = await enrol("user_rahul", "Kalyani Steel Works");
    const theirs = await mandateFor(meridian);

    await request(app)
      .post("/v1/simulations")
      .set(as(kalyani))
      .send(body(theirs, {}))
      .expect(404);
  });

  it("lets an auditor ask, since nothing is written, but not act", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const mandateId = await mandateFor(owner);

    await request(app)
      .post(`/v1/organisations/${owner.organisationId}/members`)
      .set(as(owner))
      .send({ subject: "user_auditor", email: "auditor@example.test", role: "auditor" })
      .expect(201);

    const auditor: Member = {
      token: await identity.mint("user_auditor", "auditor@example.test"),
      organisationId: owner.organisationId,
    };

    await predict(auditor, mandateId).expect(200);
    await perform(auditor, mandateId).expect(403);
  });
});
