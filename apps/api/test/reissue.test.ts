import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { MANDATE_VERSION, digestOf, verifyEvidencePack } from "@warrant/core";
import type { EvidencePack, Mandate, TrustRoot } from "@warrant/core";
import { createApp } from "../src/app.js";
import { createInMemoryRepositories } from "../src/persistence/memory.js";
import type { Repositories } from "../src/persistence/types.js";
import { testIdentity } from "./support/identity.js";
import type { TestIdentity } from "./support/identity.js";

/**
 * Mandate versioning — F-M1's other half, and the last open protocol item (**D44**, closed by
 * **D59**).
 *
 * A mandate can now say what it was issued in place of. The whole design turns on one restraint:
 * **supersession is lineage and never authority.** It records that one document replaced another and
 * says nothing about whether the replaced one still works — revocation decides that, and revocation
 * already travels in the signed snapshot every verifier checks.
 *
 * That restraint is what lets the field be added without a `MANDATE_VERSION` bump, and the tests
 * below are the argument for it: the field is signed, it is not a gate input, and a verifier that has
 * never heard of it reaches the same verdict as one that has.
 */

const inr = (major: number) => ({ currency: "INR" as const, minor: major * 100 });

const ERP = "erp:meridian/accounts-payable";
const KALYANI = "Kalyani Steel Works";

const SCOPE = {
  actions: ["payment.execute"],
  audience: [ERP],
  counterparties: { allow: [KALYANI] },
  limits: { perAction: inr(300_000) },
};

const WINDOW = { notBefore: "2026-01-01T00:00:00Z", expiresAt: "2027-01-01T00:00:00Z" };

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

const issue = (who: Member, scope: unknown = SCOPE) =>
  request(app)
    .post("/v1/mandates")
    .set(as(who))
    .send({ scope, ...WINDOW, maxDelegationDepth: 2 });

const reissue = (who: Member, id: string, body: Record<string, unknown> = {}) =>
  request(app)
    .post(`/v1/mandates/${id}/reissue`)
    .set(as(who))
    .send({ scope: SCOPE, ...WINDOW, maxDelegationDepth: 2, reason: "annual review", ...body });

const publishedRoots = async (who: Member): Promise<TrustRoot[]> =>
  (await request(app).get("/v1/trust-roots").set(as(who)).expect(200)).body;

const act = (who: Member, mandateId: string, amount = inr(100_000)) =>
  request(app)
    .post("/v1/actions")
    .set(as(who))
    .send({
      mandateId,
      action: "payment.execute",
      resource: ERP,
      counterparty: KALYANI,
      description: "Invoice settlement",
      nonce: `nonce-reissue-${unique()}`,
      amount,
    });

// ---------------------------------------------------------------------------------------------

describe("a mandate can say what it replaced", () => {
  it("carries a digest of the exact document it supersedes", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const first = await issue(owner).expect(201);

    const outcome = await reissue(owner, first.body.id).expect(201);
    const successor = outcome.body.mandate as Mandate;

    expect(outcome.body.superseded).toBe(first.body.id);
    expect(successor.supersedes?.id).toBe(first.body.id);
    expect(successor.supersedes?.digest).toBe(await digestOf(first.body as Mandate));
  });

  it("withdraws the mandate it replaced, and keeps the successor working", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const first = await issue(owner).expect(201);
    const outcome = await reissue(owner, first.body.id).expect(201);

    // The predecessor stops working because it was revoked — not because anything read `supersedes`.
    const refused = await act(owner, first.body.id).expect(201);
    expect(refused.body.verdict).toBe("BLOCK");

    const allowed = await act(owner, outcome.body.mandate.id).expect(201);
    expect(allowed.body.verdict).toBe("ALLOW");
  });

  it("records the withdrawal with the reason it was given", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const first = await issue(owner).expect(201);
    await reissue(owner, first.body.id, { reason: "limit reduced after audit" }).expect(201);

    const withdrawn = await repositories.mandates.revocations(owner.organisationId);
    expect(withdrawn).toEqual([
      expect.objectContaining({ mandateId: first.body.id, reason: "limit reduced after audit" }),
    ]);
  });

  it("leaves an ordinary mandate with no supersedes field at all", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const first = await issue(owner).expect(201);

    // Absent, not null. A field that is present-and-empty is a different document to sign.
    expect("supersedes" in first.body).toBe(false);
  });
});

describe("supersession is signed, so the pointer cannot be re-aimed", () => {
  /** A real pack, recorded under a mandate that replaced another. */
  async function packUnderASuccessor(owner: Member) {
    const first = await issue(owner).expect(201);
    const outcome = await reissue(owner, first.body.id).expect(201);
    const recorded = await act(owner, outcome.body.mandate.id).expect(201);
    const pack = await request(app).get(`/v1/evidence/${recorded.body.packId}`).expect(200);
    return { pack: pack.body as EvidencePack, first: first.body as Mandate };
  }

  it("refuses a pack whose supersedes pointer was aimed somewhere else", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const { pack } = await packUnderASuccessor(owner);
    const roots = await publishedRoots(owner);

    expect((await verifyEvidencePack(pack, { trustRoots: roots })).result).toBe("VERIFIED");

    const edited = JSON.parse(JSON.stringify(pack)) as EvidencePack;
    const root = edited.authority.chain[0] as Mandate & {
      supersedes?: { id: string; digest: string };
    };
    root.supersedes = { id: "mnd_something_else", digest: root.supersedes!.digest };

    expect((await verifyEvidencePack(edited, { trustRoots: roots })).result).not.toBe("VERIFIED");
  });

  it("refuses a pack whose supersedes block was removed", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const { pack } = await packUnderASuccessor(owner);
    const roots = await publishedRoots(owner);

    const stripped = JSON.parse(JSON.stringify(pack)) as EvidencePack;
    delete (stripped.authority.chain[0] as Record<string, unknown>).supersedes;

    // Signed over like every other field: taking it away is as detectable as changing it. This is
    // what stops "lineage only" from meaning "safe to edit".
    expect((await verifyEvidencePack(stripped, { trustRoots: roots })).result).not.toBe("VERIFIED");
  });

  it("commits to the whole predecessor, so a different document with the same id does not match", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const { pack, first } = await packUnderASuccessor(owner);

    const root = pack.authority.chain[0] as Mandate;
    expect(root.supersedes?.digest).toBe(await digestOf(first));

    const impostor = { ...first, scope: { ...first.scope, actions: ["payment.execute", "wire.send"] } };
    expect(await digestOf(impostor as Mandate)).not.toBe(root.supersedes?.digest);
  });
});

/**
 * The compatibility argument, which is the reason there is no `MANDATE_VERSION` bump.
 *
 * An older verifier does not know the field exists. It parses the document, ignores what it does not
 * recognise, canonicalises what it was given and checks the signature — so it verifies a superseding
 * mandate correctly and reaches the same verdict. That only holds because the field decides nothing.
 */
describe("an older verifier reaches the same verdict", () => {
  it("keeps the format version unchanged", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const first = await issue(owner).expect(201);
    const outcome = await reissue(owner, first.body.id).expect(201);

    expect(MANDATE_VERSION).toBe("warrant/mandate/v0.1");
    expect(outcome.body.mandate.version).toBe(MANDATE_VERSION);
    expect(first.body.version).toBe(MANDATE_VERSION);
  });

  it("produces evidence that verifies offline, superseding chain and all", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const first = await issue(owner).expect(201);
    const outcome = await reissue(owner, first.body.id).expect(201);

    const recorded = await act(owner, outcome.body.mandate.id).expect(201);
    const pack = await request(app).get(`/v1/evidence/${recorded.body.packId}`).expect(200);

    const report = await verifyEvidencePack(pack.body as EvidencePack, {
      trustRoots: await publishedRoots(owner),
    });

    expect(report.result).toBe("VERIFIED");
    expect(report.authority?.reproduced).toBe(true);
    expect(report.authority?.verdict).toBe("ALLOW");
  });

  it("never lets supersession reach the gate", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const first = await issue(owner).expect(201);
    const outcome = await reissue(owner, first.body.id).expect(201);

    const plain = await act(owner, first.body.id).expect(201);
    const superseding = await act(owner, outcome.body.mandate.id).expect(201);

    // Not a named check, not a signed input. The only difference between these two decisions is the
    // revocation, which is what a verifier that cannot read `supersedes` still sees.
    const named = (body: { decision: { checks: { id: string }[] } }) =>
      body.decision.checks.map((check) => check.id);

    expect(named(superseding.body)).toEqual(named(plain.body));
    expect(JSON.stringify(superseding.body.decision.inputs)).not.toMatch(/supersede/i);
  });
});

describe("what a reissue refuses", () => {
  it("refuses to reissue a delegation, and says whose key would have to sign", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const root = await issue(owner).expect(201);
    const child = await request(app)
      .post(`/v1/mandates/${root.body.id}/delegations`)
      .set(as(owner))
      .send({ scopeDelta: { limits: { perAction: inr(50_000) } } })
      .expect(201);

    const refused = await reissue(owner, child.body.id).expect(422);
    expect(refused.body.error).toBe("reissue_needs_a_root");
    expect(refused.body.message).toMatch(/holder's own key/);
  });

  it("refuses to reissue a mandate belonging to another organisation", async () => {
    const meridian = await enrol("user_priya", "Meridian Technologies");
    const rival = await enrol("user_arjun", "Sundaram Holdings");
    const theirs = await issue(rival).expect(201);

    await reissue(meridian, theirs.body.id).expect(404);
  });

  it("refuses a reissue that would exceed the organisation's ceiling", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const first = await issue(owner).expect(201);

    await request(app)
      .post("/v1/house-scope")
      .set(as(owner))
      .send({ scope: { ...SCOPE, limits: { perAction: inr(120_000) } } })
      .expect(200);

    const refused = await reissue(owner, first.body.id).expect(422);
    expect(refused.body.error).toBe("outside_house_scope");
  });

  it("refuses a reissue with no reason for the withdrawal", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const first = await issue(owner).expect(201);

    await request(app)
      .post(`/v1/mandates/${first.body.id}/reissue`)
      .set(as(owner))
      .send({ scope: SCOPE, ...WINDOW, maxDelegationDepth: 2 })
      .expect(400);
  });

  it("leaves the predecessor working when the successor is refused", async () => {
    const owner = await enrol("user_priya", "Meridian Technologies");
    const first = await issue(owner).expect(201);

    // Issue first, revoke second — so a rejected successor cannot leave an organisation holding
    // nothing valid at all.
    await reissue(owner, first.body.id, { scope: { ...SCOPE, actions: [] } }).expect(422);

    const still = await act(owner, first.body.id).expect(201);
    expect(still.body.verdict).toBe("ALLOW");
  });
});
