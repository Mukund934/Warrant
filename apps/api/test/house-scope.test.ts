import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { verifyEvidencePack } from "@warrant/core";
import type { Check, EvidencePack } from "@warrant/core";
import { trustRoots } from "@warrant/core/fixtures";
import { createApp } from "../src/app.js";
import { createInMemoryRepositories } from "../src/persistence/memory.js";
import type { Repositories } from "../src/persistence/types.js";
import { testIdentity } from "./support/identity.js";
import type { TestIdentity } from "./support/identity.js";

const inr = (major: number) => ({ currency: "INR" as const, minor: major * 100 });

const ERP = "erp:meridian/accounts-payable";
const BANK = "bank:hdfc/corporate-api";
const KALYANI = "Kalyani Steel Works";

const MANDATE_SCOPE = {
  actions: ["payment.execute", "invoice.read"],
  audience: [ERP, BANK],
  counterparties: { any: true },
  limits: { perAction: inr(1_000_000) },
};

const CEILING = {
  actions: ["payment.execute", "invoice.read"],
  audience: [ERP, BANK],
  counterparties: { any: true },
  limits: {},
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

const setCeiling = (who: Member, scope: Record<string, unknown>) =>
  request(app).post("/v1/house-scope").set(as(who)).send({ scope });

const issue = (who: Member, scope: Record<string, unknown> = MANDATE_SCOPE) =>
  request(app)
    .post("/v1/mandates")
    .set(as(who))
    .send({ scope, ...window, maxDelegationDepth: 2 });

function act(who: Member, mandateId: string, amount = inr(100_000), action = "payment.execute") {
  return request(app)
    .post("/v1/actions")
    .set(as(who))
    .send({
      mandateId,
      action,
      resource: ERP,
      counterparty: KALYANI,
      description: "Invoice settlement",
      nonce: `nonce-house-${unique()}`,
      amount,
    });
}

describe("setting a ceiling", () => {
  it("records it and hands it back", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const set = await setCeiling(owner, CEILING).expect(200);

    expect(set.body.scope.actions).toEqual(CEILING.actions);
    expect(set.body.organisationId).toBe(owner.organisationId);

    const read = await request(app).get("/v1/house-scope").set(as(owner)).expect(200);
    expect(read.body.scope.actions).toEqual(CEILING.actions);
  });

  it("reports no ceiling before one is set, rather than inventing one", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const read = await request(app).get("/v1/house-scope").set(as(owner)).expect(200);

    expect(read.body.scope).toBeNull();
  });

  it("refuses an unknown field rather than dropping it", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    await request(app)
      .post("/v1/house-scope")
      .set(as(owner))
      .send({ scope: CEILING, enforcement: "advisory" })
      .expect(400);
  });

  it("can be withdrawn, and then no longer applies", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    await setCeiling(owner, { ...CEILING, actions: ["invoice.read"] }).expect(200);
    await issue(owner).expect(422);

    await request(app).post("/v1/house-scope/withdrawal").set(as(owner)).expect(204);
    await issue(owner).expect(201);
  });
});

describe("issuing under a ceiling", () => {
  it("accepts a mandate that stays inside it", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    await setCeiling(owner, CEILING).expect(200);

    await issue(owner).expect(201);
  });

  it("refuses a mandate that claims an action the ceiling does not hold", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    await setCeiling(owner, { ...CEILING, actions: ["invoice.read"] }).expect(200);

    const refused = await issue(owner).expect(422);
    expect(refused.body.error).toBe("outside_house_scope");
    expect(refused.body.details[0].code).toBe("scope/action_not_delegable");
  });

  it("refuses a mandate that exceeds a limit the ceiling sets", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    await setCeiling(owner, { ...CEILING, limits: { perAction: inr(500_000) } }).expect(200);

    const refused = await issue(owner).expect(422);
    expect(refused.body.details[0].code).toBe("scope/per_action_limit_exceeded");
  });

  it("refuses a mandate that sets no limit at all where the ceiling sets one", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    await setCeiling(owner, { ...CEILING, limits: { perAction: inr(500_000) } }).expect(200);

    const refused = await issue(owner, { ...MANDATE_SCOPE, limits: {} }).expect(422);
    expect(refused.body.details[0].code).toBe("scope/per_action_limit_removed");
  });

  it("holds a delegation to the ceiling in force when the delegation is made", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const root = await issue(owner).expect(201);

    await setCeiling(owner, { ...CEILING, actions: ["invoice.read"] }).expect(200);

    const refused = await request(app)
      .post(`/v1/mandates/${root.body.id}/delegations`)
      .set(as(owner))
      .send({ scopeDelta: { actions: ["payment.execute"] } })
      .expect(422);

    expect(refused.body.error).toBe("outside_house_scope");
  });

  it("still accepts a delegation that narrows inside the tightened ceiling", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const root = await issue(owner).expect(201);
    await setCeiling(owner, { ...CEILING, actions: ["invoice.read"] }).expect(200);

    await request(app)
      .post(`/v1/mandates/${root.body.id}/delegations`)
      .set(as(owner))
      .send({ scopeDelta: { actions: ["invoice.read"] } })
      .expect(201);
  });
});

describe("a ceiling tightened after a mandate was already signed", () => {
  it("caps the action without touching the mandate", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const root = await issue(owner).expect(201);

    expect((await act(owner, root.body.id, inr(400_000)).expect(201)).body.verdict).toBe("ALLOW");

    await setCeiling(owner, { ...CEILING, limits: { perAction: inr(200_000) } }).expect(200);

    const capped = await act(owner, root.body.id, inr(400_000)).expect(201);
    expect(capped.body.verdict).toBe("BLOCK");
    expect(capped.body.reason).toMatch(/ceiling narrowed limits\.perAction after delegation/);

    const stored = await request(app)
      .get(`/v1/mandates/${root.body.id}`)
      .set(as(owner))
      .expect(200);
    expect(stored.body.mandate.scope.limits.perAction).toEqual(inr(1_000_000));
  });

  it("lets an action under the new cap through", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const root = await issue(owner).expect(201);
    await setCeiling(owner, { ...CEILING, limits: { perAction: inr(200_000) } }).expect(200);

    const outcome = await act(owner, root.body.id, inr(100_000)).expect(201);
    expect(outcome.body.verdict).toBe("ALLOW");
    expect(statusOf(outcome.body.decision.checks, "house.ceiling")).toBe("warn");
  });

  it("says no ceiling was applied when the organisation set none", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const root = await issue(owner).expect(201);

    const outcome = await act(owner, root.body.id).expect(201);
    expect(statusOf(outcome.body.decision.checks, "house.ceiling")).toBe("skip");
  });
});

describe("a ceiling belongs to one organisation only", () => {
  it("does not reach a neighbour's mandates", async () => {
    const meridian = await enrol("user_priya", "Meridian Technologies");
    const kalyani = await enrol("user_rahul", "Kalyani Steel Works");

    await setCeiling(meridian, { ...CEILING, actions: ["invoice.read"] }).expect(200);

    await issue(meridian).expect(422);
    await issue(kalyani).expect(201);
  });

  it("is not visible to a neighbour", async () => {
    const meridian = await enrol("user_priya", "Meridian Technologies");
    const kalyani = await enrol("user_rahul", "Kalyani Steel Works");
    await setCeiling(meridian, CEILING).expect(200);

    const theirs = await request(app).get("/v1/house-scope").set(as(kalyani)).expect(200);
    expect(theirs.body.scope).toBeNull();
  });

  it("does not apply a neighbour's ceiling at decision time", async () => {
    const meridian = await enrol("user_priya", "Meridian Technologies");
    const kalyani = await enrol("user_rahul", "Kalyani Steel Works");

    const theirRoot = await issue(kalyani).expect(201);
    await setCeiling(meridian, { ...CEILING, limits: { perAction: inr(1_000) } }).expect(200);

    const outcome = await act(kalyani, theirRoot.body.id, inr(400_000)).expect(201);
    expect(outcome.body.verdict).toBe("ALLOW");
    expect(statusOf(outcome.body.decision.checks, "house.ceiling")).toBe("skip");
  });
});

describe("evidence produced under a ceiling", () => {
  const packFor = async (who: Member, packId: string): Promise<EvidencePack> =>
    (await request(app).get(`/v1/evidence/${packId}`).set(as(who)).expect(200)).body;

  it("carries the ceiling and reproduces offline", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const root = await issue(owner).expect(201);
    await setCeiling(owner, { ...CEILING, limits: { perAction: inr(200_000) } }).expect(200);

    const outcome = await act(owner, root.body.id, inr(400_000)).expect(201);
    expect(outcome.body.verdict).toBe("BLOCK");

    const pack = await packFor(owner, outcome.body.packId);
    expect(pack.decision.inputs.houseScope?.limits.perAction).toEqual(inr(200_000));

    const report = await verifyEvidencePack(pack, { trustRoots });
    expect(report.result).toBe("VERIFIED");
    expect(report.authority?.verdict).toBe("BLOCK");
    expect(report.authority?.reproduced).toBe(true);
  });

  it("keeps reproducing after the ceiling is tightened again", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const root = await issue(owner).expect(201);

    const outcome = await act(owner, root.body.id, inr(400_000)).expect(201);
    expect(outcome.body.verdict).toBe("ALLOW");

    await setCeiling(owner, { ...CEILING, limits: { perAction: inr(1_000) } }).expect(200);

    const report = await verifyEvidencePack(await packFor(owner, outcome.body.packId), {
      trustRoots,
    });
    expect(report.result).toBe("VERIFIED");
    expect(report.authority?.verdict).toBe("ALLOW");
    expect(report.authority?.reproduced).toBe(true);
  });

  it("refuses a pack whose recorded ceiling has been loosened", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const root = await issue(owner).expect(201);
    await setCeiling(owner, { ...CEILING, limits: { perAction: inr(200_000) } }).expect(200);

    const outcome = await act(owner, root.body.id, inr(400_000)).expect(201);
    const pack = await packFor(owner, outcome.body.packId);

    const edited = {
      ...pack,
      decision: {
        ...pack.decision,
        inputs: { ...pack.decision.inputs, houseScope: CEILING },
      },
    };

    expect((await verifyEvidencePack(edited, { trustRoots })).result).toBe("INVALID");
  });
});
