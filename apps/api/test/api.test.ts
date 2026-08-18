import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { verifyEvidencePack } from "@warrant/core";
import type { EvidencePack, Mandate, Scope } from "@warrant/core";
import { trustRoots } from "@warrant/core/fixtures";
import { createApp } from "../src/app.js";

const inr = (major: number) => ({ currency: "INR" as const, minor: major * 100 });

const BANK = "bank:hdfc/corporate-api";
const ERP = "erp:meridian/accounts-payable";
const KALYANI = "Kalyani Steel Works";

const rootScope: Scope = {
  actions: ["invoice.read", "payment.approve", "payment.execute"],
  audience: [ERP, BANK],
  counterparties: { allow: [KALYANI, "Sundaram Fasteners"] },
  limits: { perAction: inr(1_000_000), perPeriod: { amount: inr(4_000_000), days: 30 } },
  purpose: "Settlement of approved supplier invoices",
};

const window = { notBefore: "2026-01-01T00:00:00Z", expiresAt: "2027-01-01T00:00:00Z" };

let app: Express;
let nonceCounter = 0;
const nonce = () => `n-test-${(nonceCounter += 1).toString().padStart(8, "0")}`;

async function issueRoot(): Promise<Mandate> {
  const response = await request(app)
    .post("/v1/mandates")
    .send({ scope: rootScope, ...window, maxDelegationDepth: 2 })
    .expect(201);
  return response.body as Mandate;
}

function delegateTo(parentId: string, perAction: number, periodBudget?: number) {
  return request(app)
    .post(`/v1/mandates/${parentId}/delegations`)
    .send({
      scopeDelta: {
        actions: ["payment.execute"],
        counterparties: { allow: [KALYANI] },
        limits: {
          perAction: inr(perAction),
          ...(periodBudget ? { perPeriod: { amount: inr(periodBudget), days: 30 } } : {}),
        },
      },
    });
}

beforeEach(() => {
  app = createApp();
});

describe("service surface", () => {
  it("reports that it runs without a database", async () => {
    const response = await request(app).get("/health").expect(200);
    expect(response.body).toEqual({
      status: "ok",
      persistence: "in-memory",
      database: false,
      databaseReachable: false,
      replayScope: "process",
      auth: "open",
      authIssuer: null,
    });
  });

  it("distinguishes a configured database from a reachable one", async () => {
    const unreachable = createApp({ database: { probe: async () => false } });
    const response = await request(unreachable).get("/health").expect(503);

    expect(response.body).toEqual({
      status: "degraded",
      persistence: "postgres",
      database: true,
      databaseReachable: false,
      replayScope: "process",
      auth: "open",
      authIssuer: null,
    });
  });

  it("reports healthy once the database answers", async () => {
    const reachable = createApp({ database: { probe: async () => true } });
    const response = await request(reachable).get("/health").expect(200);

    expect(response.body).toMatchObject({
      status: "ok",
      persistence: "postgres",
      database: true,
      databaseReachable: true,
    });
  });

  it("never puts the connection string in the health response", async () => {
    const configured = createApp({ database: { probe: async () => true } });
    const response = await request(configured).get("/health").expect(200);

    expect(JSON.stringify(response.body)).not.toMatch(/postgres(ql)?:\/\/|password|@/i);
  });

  it("publishes the trust roots", async () => {
    const response = await request(app).get("/v1/trust-roots").expect(200);
    expect(response.body).toHaveLength(trustRoots.length);
    expect(response.body[0]).not.toHaveProperty("privateKeyJwk");
  });

  it("lists the demonstration scenarios", async () => {
    const response = await request(app).get("/v1/scenarios").expect(200);
    expect(response.body).toHaveLength(8);
    expect(response.body.map((item: { id: string }) => item.id)).toContain("delegation-escalation");
  });

  it("serves a fixture evidence pack by scenario name", async () => {
    const response = await request(app).get("/v1/evidence/over-limit").expect(200);
    expect(response.body.decision.verdict).toBe("BLOCK");
  });

  it("answers 404 for an unknown route", async () => {
    const response = await request(app).get("/v1/nothing-here").expect(404);
    expect(response.body.error).toBe("not_found");
  });

  it("rejects a body that does not match the endpoint", async () => {
    const response = await request(app).post("/v1/mandates").send({ scope: "wide" }).expect(400);
    expect(response.body.error).toBe("invalid_request");
    expect(response.body.details.length).toBeGreaterThan(0);
  });
});

describe("server-side verification", () => {
  it("verifies a fixture pack", async () => {
    const pack = (await request(app).get("/v1/evidence/authorised-payment")).body as EvidencePack;
    const response = await request(app).post("/v1/verify").send({ pack, trustRoots }).expect(200);
    expect(response.body.result).toBe("VERIFIED");
  });

  it("rejects a tampered pack", async () => {
    const pack = (await request(app).get("/v1/evidence/authorised-payment")).body as EvidencePack;
    pack.request.amount = { currency: "INR", minor: 999_999_900 };
    const response = await request(app).post("/v1/verify").send({ pack, trustRoots }).expect(200);
    expect(response.body.result).toBe("INVALID");
  });
});

describe("issuance and delegation", () => {
  it("issues a root mandate and resolves its chain", async () => {
    const root = await issueRoot();
    expect(root.depth).toBe(0);
    expect(root.liablePrincipal.name).toBe("Priya Sharma");

    const fetched = await request(app).get(`/v1/mandates/${root.id}`).expect(200);
    expect(fetched.body.chain).toHaveLength(1);
  });

  it("accepts a delegation that narrows", async () => {
    const root = await issueRoot();
    const response = await delegateTo(root.id, 500_000).expect(201);
    expect(response.body.depth).toBe(1);
    expect(response.body.parent.id).toBe(root.id);
  });

  it("refuses a delegation that widens, and names the violation", async () => {
    const root = await issueRoot();
    const response = await request(app)
      .post(`/v1/mandates/${root.id}/delegations`)
      .send({ scopeDelta: { limits: { perAction: inr(8_000_000) } } })
      .expect(422);
    expect(response.body.error).toBe("delegation_would_widen");
    expect(response.body.details[0].code).toBe("scope/per_action_limit_exceeded");
  });

  it("refuses to delegate from a mandate that does not exist", async () => {
    await request(app).post("/v1/mandates/mnd_nope/delegations").send({ scopeDelta: {} }).expect(404);
  });
});

describe("actions through the gate", () => {
  it("allows an action inside the delegated authority and produces verifiable evidence", async () => {
    const root = await issueRoot();
    const delegated = (await delegateTo(root.id, 500_000)).body as Mandate;

    const response = await request(app)
      .post("/v1/actions")
      .send({
        mandateId: delegated.id,
        action: "payment.execute",
        resource: BANK,
        counterparty: KALYANI,
        description: "supplier invoice TEST/001",
        nonce: nonce(),
        amount: inr(120_000),
      })
      .expect(201);

    expect(response.body.verdict).toBe("ALLOW");

    const pack = (await request(app).get(`/v1/evidence/${response.body.packId}`).expect(200))
      .body as EvidencePack;
    const report = await verifyEvidencePack(pack, { trustRoots });
    expect(report.result).toBe("VERIFIED");
    expect(report.authority?.reproduced).toBe(true);
  });

  it("blocks an action above the delegated limit", async () => {
    const root = await issueRoot();
    const delegated = (await delegateTo(root.id, 500_000)).body as Mandate;

    const response = await request(app)
      .post("/v1/actions")
      .send({
        mandateId: delegated.id,
        action: "payment.execute",
        resource: BANK,
        counterparty: KALYANI,
        description: "supplier invoice TEST/002",
        nonce: nonce(),
        amount: inr(800_000),
      })
      .expect(201);

    expect(response.body.verdict).toBe("BLOCK");
    expect(
      response.body.decision.checks.find((check: { id: string }) => check.id === "limit.per_action")
        .status,
    ).toBe("fail");
  });

  it("blocks a replayed nonce on the second attempt", async () => {
    const root = await issueRoot();
    const delegated = (await delegateTo(root.id, 500_000)).body as Mandate;
    const shared = nonce();

    const body = {
      mandateId: delegated.id,
      action: "payment.execute",
      resource: BANK,
      counterparty: KALYANI,
      description: "supplier invoice TEST/003",
      nonce: shared,
      amount: inr(90_000),
    };

    const first = await request(app).post("/v1/actions").send(body).expect(201);
    const second = await request(app).post("/v1/actions").send(body).expect(201);

    expect(first.body.verdict).toBe("ALLOW");
    expect(second.body.verdict).toBe("BLOCK");
    expect(
      second.body.decision.checks.find((check: { id: string }) => check.id === "replay.freshness")
        .status,
    ).toBe("fail");
  });

  it("blocks an action once the mandate is withdrawn", async () => {
    const root = await issueRoot();
    const delegated = (await delegateTo(root.id, 500_000)).body as Mandate;

    await request(app)
      .post(`/v1/mandates/${delegated.id}/revocation`)
      .send({ reason: "withdrawn during a payment review" })
      .expect(204);

    const response = await request(app)
      .post("/v1/actions")
      .send({
        mandateId: delegated.id,
        action: "payment.execute",
        resource: BANK,
        counterparty: KALYANI,
        description: "supplier invoice TEST/004",
        nonce: nonce(),
        amount: inr(50_000),
      })
      .expect(201);

    expect(response.body.verdict).toBe("BLOCK");
    expect(
      response.body.decision.checks.find((check: { id: string }) => check.id === "revocation.status")
        .status,
    ).toBe("fail");
  });

  it("counts earlier allowed spend against the periodic budget", async () => {
    const root = await issueRoot();
    const delegated = (await delegateTo(root.id, 400_000, 1_000_000)).body as Mandate;

    const send = (amount: number) =>
      request(app)
        .post("/v1/actions")
        .send({
          mandateId: delegated.id,
          action: "payment.execute",
          resource: BANK,
          counterparty: KALYANI,
          description: "supplier invoice TEST/periodic",
          nonce: nonce(),
          amount: inr(amount),
        })
        .expect(201);

    const first = await send(400_000);
    const second = await send(400_000);
    const third = await send(400_000);

    expect(first.body.verdict).toBe("ALLOW");
    expect(second.body.verdict).toBe("ALLOW");
    expect(third.body.verdict).toBe("BLOCK");
    expect(
      third.body.decision.checks.find((check: { id: string }) => check.id === "limit.per_period")
        .status,
    ).toBe("fail");
  });

  it("does not count an escalated action as spend, because it did not execute", async () => {
    const root = await issueRoot();
    const delegated = (await delegateTo(root.id, 500_000, 1_000_000)).body as Mandate;

    const send = (amount: number) =>
      request(app)
        .post("/v1/actions")
        .send({
          mandateId: delegated.id,
          action: "payment.execute",
          resource: BANK,
          counterparty: KALYANI,
          description: "supplier invoice TEST/escalated",
          nonce: nonce(),
          amount: inr(amount),
        })
        .expect(201);

    const escalated = await send(480_000);
    const following = await send(400_000);

    expect(escalated.body.verdict).toBe("ESCALATE");
    expect(following.body.verdict).toBe("ALLOW");
    expect(
      following.body.decision.checks.find((check: { id: string }) => check.id === "limit.per_period")
        .detail,
    ).toContain("₹4,00,000.00");
  });

  it("refuses an action against a mandate that does not exist", async () => {
    await request(app)
      .post("/v1/actions")
      .send({
        mandateId: "mnd_nope",
        action: "payment.execute",
        resource: BANK,
        counterparty: KALYANI,
        description: "supplier invoice TEST/005",
        nonce: nonce(),
        amount: inr(1_000),
      })
      .expect(404);
  });
});
