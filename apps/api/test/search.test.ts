import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../src/app.js";
import { createInMemoryRepositories } from "../src/persistence/memory.js";
import type { EvidenceSummary, Repositories } from "../src/persistence/types.js";
import { testIdentity } from "./support/identity.js";
import type { TestIdentity } from "./support/identity.js";

const inr = (major: number) => ({ currency: "INR" as const, minor: major * 100 });

const ERP = "erp:meridian/accounts-payable";
const KALYANI = "Kalyani Steel Works";
const SUNDARAM = "Sundaram Fasteners";

const SCOPE = {
  actions: ["payment.execute", "invoice.read"],
  audience: [ERP],
  counterparties: { allow: [KALYANI, SUNDARAM] },
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

async function mandateFor(who: Member): Promise<string> {
  const created = await request(app)
    .post("/v1/mandates")
    .set(as(who))
    .send({ scope: SCOPE, ...window, maxDelegationDepth: 2 })
    .expect(201);
  return created.body.id as string;
}

interface Shape {
  action?: string;
  counterparty?: string;
  amount?: ReturnType<typeof inr>;
}

async function record(who: Member, mandateId: string, shape: Shape = {}): Promise<string> {
  const outcome = await request(app)
    .post("/v1/actions")
    .set(as(who))
    .send({
      mandateId,
      action: shape.action ?? "payment.execute",
      resource: ERP,
      counterparty: shape.counterparty ?? KALYANI,
      description: "Invoice settlement",
      nonce: `nonce-search-${unique()}`,
      amount: shape.amount ?? inr(100_000),
    })
    .expect(201);
  return outcome.body.packId as string;
}

const search = (who: Member, query: Record<string, string | number> = {}) =>
  request(app).get("/v1/search/evidence").set(as(who)).query(query);

const idsIn = (body: { results: EvidenceSummary[] }) => body.results.map((row) => row.packId);

describe("finding evidence by what was decided", () => {
  it("filters by verdict", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const mandateId = await mandateFor(owner);

    await record(owner, mandateId);
    const refused = await record(owner, mandateId, { amount: inr(290_000), counterparty: "Nobody Ltd" });

    const found = await search(owner, { verdict: "BLOCK" }).expect(200);
    expect(idsIn(found.body)).toEqual([refused]);
  });

  it("filters by counterparty", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const mandateId = await mandateFor(owner);

    await record(owner, mandateId, { counterparty: KALYANI });
    const theirs = await record(owner, mandateId, { counterparty: SUNDARAM });

    const found = await search(owner, { counterparty: SUNDARAM }).expect(200);
    expect(idsIn(found.body)).toEqual([theirs]);
  });

  it("filters by action", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const mandateId = await mandateFor(owner);

    await record(owner, mandateId, { action: "payment.execute" });
    const read = await record(owner, mandateId, { action: "invoice.read" });

    const found = await search(owner, { action: "invoice.read" }).expect(200);
    expect(idsIn(found.body)).toEqual([read]);
  });

  it("filters by amount range within a currency", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const mandateId = await mandateFor(owner);

    await record(owner, mandateId, { amount: inr(10_000) });
    const middle = await record(owner, mandateId, { amount: inr(150_000) });
    await record(owner, mandateId, { amount: inr(280_000) });

    const found = await search(owner, {
      currency: "INR",
      minAmount: inr(100_000).minor,
      maxAmount: inr(200_000).minor,
    }).expect(200);

    expect(idsIn(found.body)).toEqual([middle]);
  });

  it("combines filters rather than treating them as alternatives", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const mandateId = await mandateFor(owner);

    await record(owner, mandateId, { counterparty: SUNDARAM, amount: inr(10_000) });
    const wanted = await record(owner, mandateId, { counterparty: SUNDARAM, amount: inr(250_000) });
    await record(owner, mandateId, { counterparty: KALYANI, amount: inr(250_000) });

    const found = await search(owner, {
      counterparty: SUNDARAM,
      minAmount: inr(200_000).minor,
    }).expect(200);

    expect(idsIn(found.body)).toEqual([wanted]);
  });

  it("excludes an action carrying no amount once an amount filter is asked for", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const mandateId = await mandateFor(owner);

    await request(app)
      .post("/v1/actions")
      .set(as(owner))
      .send({
        mandateId,
        action: "invoice.read",
        resource: ERP,
        counterparty: KALYANI,
        description: "Reading an invoice",
        nonce: `nonce-search-${unique()}`,
      })
      .expect(201);

    const found = await search(owner, { minAmount: 0 }).expect(200);
    expect(found.body.results).toEqual([]);
  });

  it("reports what was decided rather than recomputing it", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const mandateId = await mandateFor(owner);
    const packId = await record(owner, mandateId, { amount: inr(250_000) });

    const found = await search(owner).expect(200);
    const summary = found.body.results.find((row: EvidenceSummary) => row.packId === packId);

    const pack = (await request(app).get(`/v1/evidence/${packId}`).set(as(owner)).expect(200)).body;
    expect(summary.verdict).toBe(pack.decision.verdict);
    expect(summary.reason).toBe(pack.decision.reason);
    expect(summary.evaluatedAt).toBe(pack.decision.evaluatedAt);
    expect(summary.amount).toEqual(inr(250_000));
    expect(summary.rootMandateId).toBe(mandateId);
  });
});

describe("paging through evidence", () => {
  it("hands back a cursor and continues from it without repeating", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const mandateId = await mandateFor(owner);

    const all: string[] = [];
    for (let index = 0; index < 5; index += 1) all.push(await record(owner, mandateId));

    const first = await search(owner, { limit: 2 }).expect(200);
    expect(first.body.results).toHaveLength(2);
    expect(first.body.nextCursor).toBeDefined();

    const second = await search(owner, { limit: 2, cursor: first.body.nextCursor }).expect(200);
    const third = await search(owner, { limit: 2, cursor: second.body.nextCursor }).expect(200);

    const seen = [...idsIn(first.body), ...idsIn(second.body), ...idsIn(third.body)];
    expect(new Set(seen).size).toBe(5);
    expect(seen.sort()).toEqual([...all].sort());
    expect(third.body.nextCursor).toBeUndefined();
  });

  // `nowIso` truncates to whole seconds, so evidence recorded in the same second shares
  // `evaluatedAt` and the tiebreaker is the random pack id. A row written mid-pagination can
  // therefore sort into ground the reader has not covered yet, and legitimately appear. What keyset
  // pagination does guarantee is the pair below: nothing is returned twice, and nothing that already
  // existed is skipped. A boundary keyed on time alone would give neither.
  it("skips nothing and repeats nothing while new evidence is being recorded", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const mandateId = await mandateFor(owner);

    const existing: string[] = [];
    for (let index = 0; index < 4; index += 1) existing.push(await record(owner, mandateId));

    const seen: string[] = [];
    let cursor: string | undefined;
    let inserted = false;

    for (let page = 0; page < 10; page += 1) {
      const query: Record<string, string | number> = { limit: 2 };
      if (cursor) query.cursor = cursor;

      const response = await search(owner, query).expect(200);
      seen.push(...idsIn(response.body));

      if (!inserted) {
        for (let index = 0; index < 3; index += 1) await record(owner, mandateId);
        inserted = true;
      }

      cursor = response.body.nextCursor;
      if (!cursor) break;
    }

    expect(new Set(seen).size).toBe(seen.length);
    for (const packId of existing) expect(seen).toContain(packId);
  });

  it("omits the cursor when nothing remains", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const mandateId = await mandateFor(owner);
    await record(owner, mandateId);

    const only = await search(owner, { limit: 25 }).expect(200);
    expect(only.body.results).toHaveLength(1);
    expect(only.body.nextCursor).toBeUndefined();
  });
});

describe("what search refuses", () => {
  it("refuses a filter it does not know rather than ignoring it", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    await search(owner, { verdictt: "BLOCK" }).expect(400);
  });

  it("refuses an inverted amount range", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    await search(owner, { minAmount: 5_000, maxAmount: 100 }).expect(400);
  });

  it("refuses an inverted time window", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    await search(owner, { from: "2026-08-02T00:00:00Z", to: "2026-08-01T00:00:00Z" }).expect(400);
  });

  it("refuses a limit past the ceiling", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    await search(owner, { limit: 5_000 }).expect(400);
  });

  it("needs a caller, unlike fetching one pack by its id", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const packId = await record(owner, await mandateFor(owner));

    await request(app).get("/v1/search/evidence").expect(401);
    await request(app).get(`/v1/evidence/${packId}`).expect(200);
  });
});

describe("search never crosses an organisation", () => {
  it("returns nothing belonging to a neighbour", async () => {
    const meridian = await enrol("user_priya", "Meridian Technologies");
    const kalyani = await enrol("user_rahul", "Kalyani Steel Works");

    const mine = await record(meridian, await mandateFor(meridian));
    const theirs = await record(kalyani, await mandateFor(kalyani));

    const found = await search(kalyani).expect(200);
    expect(idsIn(found.body)).toEqual([theirs]);
    expect(idsIn(found.body)).not.toContain(mine);
  });

  it("cannot be widened by naming the neighbour's own mandate", async () => {
    const meridian = await enrol("user_priya", "Meridian Technologies");
    const kalyani = await enrol("user_rahul", "Kalyani Steel Works");

    const theirMandate = await mandateFor(meridian);
    await record(meridian, theirMandate);

    const found = await search(kalyani, { rootMandateId: theirMandate }).expect(200);
    expect(found.body.results).toEqual([]);
  });
});
