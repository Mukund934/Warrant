import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../src/app.js";
import { createInMemoryRepositories } from "../src/persistence/memory.js";
import type { Repositories } from "../src/persistence/types.js";
import type { ReplayedCheck } from "../src/services/replay.js";
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
    .send({ scope: SCOPE, ...window, maxDelegationDepth: 2 })
    .expect(201);
  return created.body.id as string;
}

async function act(who: Member, mandateId: string, amount = inr(100_000)) {
  return request(app)
    .post("/v1/actions")
    .set(as(who))
    .send({
      mandateId,
      action: "payment.execute",
      resource: ERP,
      counterparty: KALYANI,
      description: "Invoice settlement",
      nonce: `nonce-evidence-replay-${unique()}`,
      amount,
    })
    .expect(201);
}

const replay = (who: Member, packId: string) =>
  request(app).get(`/v1/replays/${packId}`).set(as(who));

describe("re-deriving a decision that was recorded", () => {
  it("reaches the same verdict and says every check agrees", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const outcome = await act(owner, await issue(owner));

    const view = await replay(owner, outcome.body.packId).expect(200);

    expect(view.body.replayed).toBe(true);
    expect(view.body.result).toBe("VERIFIED");
    expect(view.body.recorded.verdict).toBe("ALLOW");
    expect(view.body.rederived.verdict).toBe("ALLOW");
    expect(view.body.rederived.reproduced).toBe(true);
    expect(view.body.checks.every((check: ReplayedCheck) => check.agrees)).toBe(true);
  });

  it("puts each re-derived check beside the one the decision recorded", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const outcome = await act(owner, await issue(owner));

    const view = await replay(owner, outcome.body.packId).expect(200);
    const binding = view.body.checks.find((check: ReplayedCheck) => check.id === "actor.binding");

    expect(binding.status).toBe("pass");
    expect(binding.recorded).toBe("pass");
    expect(binding.title.length).toBeGreaterThan(0);
  });

  it("re-derives a refusal as a refusal, which is still valid evidence", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const outcome = await act(owner, await issue(owner), inr(900_000));

    expect(outcome.body.verdict).toBe("BLOCK");
    const view = await replay(owner, outcome.body.packId).expect(200);

    expect(view.body.result).toBe("VERIFIED");
    expect(view.body.recorded.verdict).toBe("BLOCK");
    expect(view.body.rederived.verdict).toBe("BLOCK");
    expect(view.body.rederived.reproduced).toBe(true);
  });

  it("is honest that the issuer checking its own evidence proves the least", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const outcome = await act(owner, await issue(owner));

    const view = await replay(owner, outcome.body.packId).expect(200);

    expect(view.body.limitations.join(" ")).toMatch(/weakest form of verification/);
    expect(view.body.limitations.join(" ")).toMatch(/warrant-verify replay/);
    expect(view.body.trustRootSource).toBe("independent");
  });

  it("carries nothing that could be mistaken for a decision", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const outcome = await act(owner, await issue(owner));

    const view = await replay(owner, outcome.body.packId).expect(200);

    expect(view.body.id).toBeUndefined();
    expect(view.body.proof).toBeUndefined();
    expect(view.body.gate).toBeUndefined();
    expect(view.body.evaluatedAt).toBeUndefined();
  });

  it("records nothing", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const outcome = await act(owner, await issue(owner));

    const before = await repositories.ledger.count();
    await replay(owner, outcome.body.packId).expect(200);
    await replay(owner, outcome.body.packId).expect(200);

    expect(await repositories.ledger.count()).toBe(before);
  });
});

describe("who may replay what", () => {
  it("refuses a pack it cannot find", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    await replay(owner, "pack_nope").expect(404);
  });

  it("refuses a neighbour's pack, though a pack handed over still verifies openly", async () => {
    const meridian = await enrol("user_priya", "Meridian Technologies");
    const kalyani = await enrol("user_rahul", "Kalyani Steel Works");
    const outcome = await act(meridian, await issue(meridian));

    await replay(kalyani, outcome.body.packId).expect(404);

    // The same evidence, handed to a stranger, still verifies without any caller at all. Replaying a
    // stored pack enumerates someone's records; verifying one you were given does not.
    const pack = (
      await request(app).get(`/v1/evidence/${outcome.body.packId}`).set(as(meridian)).expect(200)
    ).body;

    const open = await request(app).post("/v1/verify").send({ pack }).expect(200);
    expect(open.body.result).toBe("VERIFIED");
  });

  it("needs a caller at all", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const outcome = await act(owner, await issue(owner));

    await request(app).get(`/v1/replays/${outcome.body.packId}`).expect(401);
  });
});
