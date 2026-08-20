import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { verifyControlStatement } from "@warrant/core";
import type { Check, ControlFiring, TrustRoot } from "@warrant/core";
import { createApp } from "../src/app.js";
import { createInMemoryRepositories } from "../src/persistence/memory.js";
import type { Repositories } from "../src/persistence/types.js";
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
};

const window = { notBefore: "2026-01-01T00:00:00Z", expiresAt: "2027-01-01T00:00:00Z" };
const PERIOD = { from: "2026-01-01T00:00:00Z", to: "2030-01-01T00:00:00Z" };

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

function act(who: Member, mandateId: string, amount = inr(100_000), counterparty = KALYANI) {
  return request(app)
    .post("/v1/actions")
    .set(as(who))
    .send({
      mandateId,
      action: "payment.execute",
      resource: ERP,
      counterparty,
      description: "Invoice settlement",
      nonce: `nonce-statement-${unique()}`,
      amount,
    })
    .expect(201);
}

const statement = (who: Member, period = PERIOD) =>
  request(app).post("/v1/statements").set(as(who)).send(period);

describe("a signed statement of what the controls did", () => {
  it("counts by verdict and says which control refused each action", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const mandateId = await issue(owner);

    await act(owner, mandateId);
    await act(owner, mandateId);
    await act(owner, mandateId, inr(900_000));
    await act(owner, mandateId, inr(100_000), "Nobody Ltd");

    const view = await statement(owner).expect(201);

    expect(view.body.counts).toEqual({ total: 4, allowed: 2, refused: 2, escalated: 0 });
    const fired = view.body.firings as ControlFiring[];
    expect(fired.map((firing) => firing.check).sort()).toEqual([
      "counterparty.allowed",
      "limit.per_action",
    ]);
    expect(fired.every((firing) => firing.count === 1)).toBe(true);
  });

  it("verifies as a signed document against a published key", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    await act(owner, await issue(owner));

    const view = await statement(owner).expect(201);
    const checks = await verifyControlStatement(view.body, await publishedRoots(owner));

    expect(statusOf(checks, "statement.format")).toBe("pass");
    expect(statusOf(checks, "statement.signature")).toBe("pass");
    expect(statusOf(checks, "statement.arithmetic")).toBe("pass");
    expect(statusOf(checks, "statement.completeness")).toBe("pass");
  });

  it("refuses to verify once a figure has been edited", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const mandateId = await issue(owner);
    await act(owner, mandateId, inr(900_000));

    const view = await statement(owner).expect(201);
    const edited = { ...view.body, counts: { ...view.body.counts, refused: 0, allowed: 1 } };

    const checks = await verifyControlStatement(edited, await publishedRoots(owner));
    expect(statusOf(checks, "statement.signature")).toBe("fail");
  });

  it("catches figures that do not add up, before the signature is even considered", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    await act(owner, await issue(owner));

    const view = await statement(owner).expect(201);
    const edited = { ...view.body, counts: { ...view.body.counts, total: 99 } };

    const checks = await verifyControlStatement(edited, await publishedRoots(owner));
    expect(statusOf(checks, "statement.arithmetic")).toBe("fail");
  });

  it("carries the basis inside the signed document, not beside it", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    await act(owner, await issue(owner));

    const view = await statement(owner).expect(201);

    expect(view.body.basis).toMatch(/not a claim that every action/);
    expect(view.body.complete).toBe(true);
    expect(view.body.organisation.id).toBe(owner.organisationId);
  });

  it("counts an escalation as neither allowed nor refused", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const created = await request(app)
      .post("/v1/mandates")
      .set(as(owner))
      .send({
        scope: { ...SCOPE, approval: { above: inr(50_000) } },
        ...window,
        maxDelegationDepth: 1,
      })
      .expect(201);

    await act(owner, created.body.id, inr(200_000));

    const view = await statement(owner).expect(201);
    expect(view.body.counts).toEqual({ total: 1, allowed: 0, refused: 0, escalated: 1 });
  });

  it("refuses a period that ends before it starts", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const refused = await statement(owner, {
      from: "2026-08-02T00:00:00Z",
      to: "2026-08-01T00:00:00Z",
    }).expect(400);

    expect(refused.body.error).toBe("range_inverted");
  });

  it("refuses an unknown field rather than dropping it", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    await request(app)
      .post("/v1/statements")
      .set(as(owner))
      .send({ ...PERIOD, organisationId: "org:someone-else" })
      .expect(400);
  });

  it("reports an empty period as zero rather than failing", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    await act(owner, await issue(owner));

    const view = await statement(owner, {
      from: "2020-01-01T00:00:00Z",
      to: "2020-12-31T00:00:00Z",
    }).expect(201);

    expect(view.body.counts).toEqual({ total: 0, allowed: 0, refused: 0, escalated: 0 });
    expect(view.body.firings).toEqual([]);
  });
});

describe("a statement covers one organisation only", () => {
  it("does not count a neighbour's decisions", async () => {
    const meridian = await enrol("user_priya", "Meridian Technologies");
    const kalyani = await enrol("user_rahul", "Kalyani Steel Works");

    await act(meridian, await issue(meridian));
    await act(meridian, await issue(meridian));
    await act(kalyani, await issue(kalyani));

    const mine = await statement(meridian).expect(201);
    const theirs = await statement(kalyani).expect(201);

    expect(mine.body.counts.total).toBe(2);
    expect(theirs.body.counts.total).toBe(1);
    expect(mine.body.organisation.id).not.toBe(theirs.body.organisation.id);
  });

  it("needs a caller", async () => {
    await request(app).post("/v1/statements").send(PERIOD).expect(401);
  });
});
