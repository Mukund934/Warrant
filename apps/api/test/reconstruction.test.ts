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

const PAST = "2026-06-01T12:00:00Z";
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

async function issue(who: Member, overrides: Record<string, unknown> = {}): Promise<string> {
  const created = await request(app)
    .post("/v1/mandates")
    .set(as(who))
    .send({ scope: SCOPE, ...window, maxDelegationDepth: 2, ...overrides })
    .expect(201);
  return created.body.id as string;
}

const hypothetical = (amount = inr(100_000)) => ({
  action: "payment.execute",
  resource: ERP,
  counterparty: KALYANI,
  amount,
});

const rebuild = (who: Member, body: Record<string, unknown>) =>
  request(app).post("/v1/reconstructions").set(as(who)).send(body);

const at = (who: Member, mandateId: string, instant: string, ask = false) =>
  rebuild(who, { mandateId, at: instant, ...(ask ? { hypothetical: hypothetical() } : {}) });

const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");

// Recorded timestamps have one-second resolution, so two events in the same second are the same
// instant as far as any reconstruction can tell. Waiting for the second to turn is what makes
// "before" genuinely before, and it is no slower than it has to be.
async function untilTheSecondTurns(): Promise<void> {
  const start = nowIso();
  while (nowIso() === start) await new Promise((resolve) => setTimeout(resolve, 20));
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
      nonce: `nonce-rebuild-${unique()}`,
      amount,
    })
    .expect(201);
}

describe("rebuilding the authority as it stood", () => {
  it("reports the chain, its standing and what it granted", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const mandateId = await issue(owner);

    const view = await at(owner, mandateId, nowIso()).expect(200);

    expect(view.body.reconstructed).toBe(true);
    expect(view.body.standing).toBe("live");
    expect(view.body.chain).toHaveLength(1);
    expect(view.body.chain[0].id).toBe(mandateId);
    expect(view.body.effectiveScope.actions).toEqual(SCOPE.actions);
  });

  it("says the authority did not exist before it was issued", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const mandateId = await issue(owner);

    const view = await at(owner, mandateId, PAST).expect(200);

    expect(view.body.standing).toBe("not-yet-issued");
    expect(view.body.chain).toEqual([]);
    expect(view.body.effectiveScope).toBeUndefined();
    expect(view.body.outcome).toBeUndefined();
  });

  it("reports a window that had not opened, and one that had closed", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const early = await issue(owner, {
      notBefore: "2099-01-01T00:00:00Z",
      expiresAt: "2099-12-31T00:00:00Z",
    });
    expect((await at(owner, early, nowIso()).expect(200)).body.standing).toBe("not-yet-valid");

    const lapsed = await issue(owner, {
      notBefore: "2020-01-01T00:00:00Z",
      expiresAt: "2020-12-31T00:00:00Z",
    });
    expect((await at(owner, lapsed, nowIso()).expect(200)).body.standing).toBe("expired");
  });

  it("refuses an instant that has not happened yet rather than guessing", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const mandateId = await issue(owner);

    const refused = await at(owner, mandateId, "2099-01-01T00:00:00Z").expect(400);
    expect(refused.body.error).toBe("instant_in_the_future");
  });

  it("refuses a mandate it cannot resolve, and a neighbour's", async () => {
    const meridian = await enrol("user_priya", "Meridian Technologies");
    const kalyani = await enrol("user_rahul", "Kalyani Steel Works");
    const theirs = await issue(meridian);

    await at(meridian, "mnd_nope", nowIso()).expect(404);
    await at(kalyani, theirs, nowIso()).expect(404);
  });
});

// The point of the feature: a mandate withdrawn since was still live at the earlier instant.
describe("a withdrawal does not reach backwards", () => {
  it("still permits the action at an instant before the withdrawal", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const mandateId = await issue(owner);

    const before = nowIso();
    await act(owner, mandateId);
    await untilTheSecondTurns();

    await request(app)
      .post(`/v1/mandates/${mandateId}/revocation`)
      .set(as(owner))
      .send({ reason: "the supplier relationship ended" })
      .expect(204);

    const nowRefused = await at(owner, mandateId, nowIso(), true).expect(200);
    expect(nowRefused.body.standing).toBe("revoked");
    expect(nowRefused.body.outcome.verdict).toBe("BLOCK");

    const thenAllowed = await at(owner, mandateId, before, true).expect(200);
    expect(thenAllowed.body.standing).toBe("live");
    expect(thenAllowed.body.outcome.verdict).toBe("ALLOW");
    expect(checkFor(thenAllowed.body.outcome.checks, "revocation.status")?.status).toBe("pass");
  });
});

describe("spend is counted up to the instant, not up to now", () => {
  it("does not charge the budget with spend recorded after the instant", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const mandateId = await issue(owner, {
      scope: {
        ...SCOPE,
        limits: { perAction: inr(300_000), perPeriod: { amount: inr(400_000), days: 30 } },
      },
    });

    const before = nowIso();
    await untilTheSecondTurns();
    await act(owner, mandateId, inr(250_000));
    await act(owner, mandateId, inr(150_000));

    const nowExhausted = await rebuild(owner, {
      mandateId,
      at: nowIso(),
      hypothetical: hypothetical(inr(250_000)),
    }).expect(200);
    expect(nowExhausted.body.outcome.verdict).toBe("BLOCK");
    expect(checkFor(nowExhausted.body.outcome.checks, "limit.per_period")?.status).toBe("fail");

    const thenFree = await rebuild(owner, {
      mandateId,
      at: before,
      hypothetical: hypothetical(inr(250_000)),
    }).expect(200);
    expect(thenFree.body.outcome.verdict).toBe("ALLOW");
    expect(checkFor(thenFree.body.outcome.checks, "limit.per_period")?.status).toBe("pass");
  });
});

describe("what it will not pretend to reconstruct", () => {
  it("says the ceiling it used is today's, and applies it", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const mandateId = await issue(owner);
    const before = nowIso();

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

    const view = await at(owner, mandateId, before, true).expect(200);

    expect(view.body.outcome.verdict).toBe("BLOCK");
    expect(view.body.notHistorised).toContain(
      "the house ceiling keeps no history, so this used the ceiling as it stands today, not as it stood then",
    );
  });

  it("says the catalogue it used is today's", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const mandateId = await issue(owner);
    const before = nowIso();

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

    const view = await at(owner, mandateId, before, true).expect(200);

    expect(view.body.notHistorised.join(" ")).toMatch(/capability catalogue keeps no history/);
  });

  it("discloses nothing where nothing unhistorised bore on the answer", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const view = await at(owner, await issue(owner), nowIso(), true).expect(200);

    expect(view.body.outcome.verdict).toBe("ALLOW");
    expect(view.body.notHistorised).toEqual([]);
  });
});

describe("a reconstruction is not a decision", () => {
  it("carries no id, proof or gate, and marks itself", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const view = await at(owner, await issue(owner), nowIso(), true).expect(200);

    expect(view.body.reconstructed).toBe(true);
    expect(view.body.outcome.simulated).toBe(true);
    expect(view.body.outcome.id).toBeUndefined();
    expect(view.body.outcome.proof).toBeUndefined();
    expect(view.body.outcome.gate).toBeUndefined();
    expect(view.body.packId).toBeUndefined();
  });

  it("records nothing at all and burns no nonce", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const mandateId = await issue(owner);

    const before = await repositories.ledger.count();
    await at(owner, mandateId, nowIso(), true).expect(200);
    await at(owner, mandateId, nowIso(), true).expect(200);

    expect(await repositories.ledger.count()).toBe(before);
    expect(await repositories.evidence.recent(50, owner.organisationId)).toEqual([]);

    const real = await act(owner, mandateId);
    expect(real.body.verdict).toBe("ALLOW");
  });

  it("reports replay as unchecked, never as verified fresh", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const view = await at(owner, await issue(owner), nowIso(), true).expect(200);

    expect(checkFor(view.body.outcome.checks, "replay.freshness")?.status).toBe("skip");
    expect(view.body.outcome.assumptions).toHaveLength(2);
  });

  it("refuses an unknown field rather than dropping it", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const mandateId = await issue(owner);

    await rebuild(owner, { mandateId, at: nowIso(), verdict: "ALLOW" }).expect(400);
    await rebuild(owner, {
      mandateId,
      at: nowIso(),
      hypothetical: { ...hypothetical(), nonce: "n-0000001" },
    }).expect(400);
  });
});
