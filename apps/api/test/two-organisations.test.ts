import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createKeyPair, verifyEvidencePack } from "@warrant/core";
import type { EvidencePack, TrustRoot } from "@warrant/core";
import { createApp } from "../src/app.js";
import { createInMemoryRepositories } from "../src/persistence/memory.js";
import type { Repositories } from "../src/persistence/types.js";
import { trustRootsFor } from "../src/services/agents.js";
import { testIdentity } from "./support/identity.js";
import type { TestIdentity } from "./support/identity.js";

/**
 * Where the two-organisation claim actually stands, written down as tests rather than as a caveat.
 *
 * Phase 9 is the flagship: one organisation records evidence, a second verifies it without trusting
 * the first. Two of the three things that needs are already true and are asserted here. The third is
 * not, and the point of this file is that **the gap is a failing-shaped test rather than a sentence
 * in a document** — when Phase 9 lands, the test named below inverts, and nothing else here moves.
 *
 * | Claim | State |
 * | --- | --- |
 * | Neither organisation can read the other's evidence through the API | ✅ holds (F-P2, D34) |
 * | A pack verifies offline against keys fetched from the issuer, with no service involved | ✅ holds |
 * | A pack verifies **only** under the issuer's trust roots | ❌ not yet — see the last describe |
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

async function recordEvidence(who: Member): Promise<EvidencePack> {
  const mandate = await request(app)
    .post("/v1/mandates")
    .set(as(who))
    .send({ scope: SCOPE, ...window, maxDelegationDepth: 2 })
    .expect(201);

  const outcome = await request(app)
    .post("/v1/actions")
    .set(as(who))
    .send({
      mandateId: mandate.body.id,
      action: "payment.execute",
      resource: ERP,
      counterparty: KALYANI,
      description: "Invoice settlement",
      nonce: `nonce-two-org-${unique()}`,
      amount: inr(100_000),
    })
    .expect(201);

  expect(outcome.body.verdict).toBe("ALLOW");

  // Fetched by id, which is deliberately open: evidence exists to be handed to a relying party.
  const pack = await request(app).get(`/v1/evidence/${outcome.body.packId}`).expect(200);
  return pack.body as EvidencePack;
}

async function twoOrganisations() {
  const meridian = await enrol("user_priya", "Meridian Technologies");
  const sundaram = await enrol("user_arjun", "Sundaram Holdings");
  return { meridian, sundaram };
}

// ---------------------------------------------------------------------------------------------

describe("neither organisation can read the other's records", () => {
  it("refuses a search across the boundary, and a direct read of a mandate", async () => {
    const { meridian, sundaram } = await twoOrganisations();
    const theirs = await recordEvidence(sundaram);

    const mine = await request(app).get("/v1/search/evidence").set(as(meridian)).expect(200);
    expect(mine.body.results).toEqual([]);

    const mandateId = theirs.authority.chain[0]!.id;
    await request(app).get(`/v1/mandates/${mandateId}`).set(as(meridian)).expect(404);
    await request(app).get(`/v1/mandates/${mandateId}/timeline`).set(as(meridian)).expect(404);
  });

  it("refuses to replay the other organisation's pack, while its owner may", async () => {
    const { meridian, sundaram } = await twoOrganisations();
    const theirs = await recordEvidence(sundaram);

    await request(app).get(`/v1/replays/${theirs.packId}`).set(as(meridian)).expect(404);

    const owner = await request(app)
      .get(`/v1/replays/${theirs.packId}`)
      .set(as(sundaram))
      .expect(200);
    expect(owner.body.result).toBe("VERIFIED");
  });

  // Enumerating is a different act from being handed one pack, which is why this is open on purpose
  // (D50). A relying party holding an unguessable id must not need an account here.
  it("still hands one pack to anyone holding its id, because that is the point", async () => {
    const { sundaram } = await twoOrganisations();
    const theirs = await recordEvidence(sundaram);

    await request(app).get(`/v1/evidence/${theirs.packId}`).expect(200);
  });
});

describe("a pack verifies away from the service that made it", () => {
  it("verifies offline against trust roots fetched from the issuer", async () => {
    const { sundaram } = await twoOrganisations();
    const pack = await recordEvidence(sundaram);

    // What a counterparty would do: take the pack, take the issuer's published keys, and check one
    // against the other with no service involved. `verifyEvidencePack` is the offline verifier.
    const published = await request(app).get("/v1/trust-roots").set(as(sundaram)).expect(200);

    const report = await verifyEvidencePack(pack, { trustRoots: published.body as TrustRoot[] });

    expect(report.result).toBe("VERIFIED");
    expect(report.authority?.reproduced).toBe(true);
    expect(report.authority?.verdict).toBe(pack.decision.verdict);
  });

  it("refuses the same pack under a trust root that never signed it", async () => {
    const { sundaram } = await twoOrganisations();
    const pack = await recordEvidence(sundaram);

    // A stranger's key, generated here and belonging to nobody. This is the check that makes the
    // one above mean something: verification must depend on the key, not on the pack's own claims.
    const stranger = await createKeyPair("Someone Else Entirely", "gate");
    const foreign: TrustRoot[] = [
      {
        keyId: stranger.keyId,
        subject: "Someone Else Entirely",
        role: "gate",
        publicKeyJwk: stranger.publicKeyJwk,
        signingFrom: "2026-01-01T00:00:00Z",
      },
    ];

    const report = await verifyEvidencePack(pack, { trustRoots: foreign });
    expect(report.result).not.toBe("VERIFIED");
  });

  it("refuses a pack whose recorded verdict was edited", async () => {
    const { sundaram } = await twoOrganisations();
    const pack = await recordEvidence(sundaram);
    const published = await request(app).get("/v1/trust-roots").set(as(sundaram)).expect(200);

    const tampered = JSON.parse(JSON.stringify(pack)) as EvidencePack;
    (tampered.decision as { verdict: string }).verdict = "BLOCK";

    const report = await verifyEvidencePack(tampered, { trustRoots: published.body as TrustRoot[] });
    expect(report.result).not.toBe("VERIFIED");
  });
});

/**
 * **The Phase 9 gap, stated precisely.**
 *
 * Tenancy today is a data boundary and not a cryptographic one. Every organisation on a deployment
 * signs with the same demonstration gate and recorder keys, so a pack issued by one verifies under
 * the trust roots of the other — not because the second organisation checked anything, but because
 * they were never separate keys.
 *
 * That is asserted here rather than described, so the claim cannot quietly be made in a deck while
 * the code says otherwise. **Phase 9 inverts the first test in this block**: cross-organisation
 * verification must fail on an unknown key, and the flagship becomes real at the moment it does.
 */
describe("cryptographic independence — NOT YET TRUE, and this is the Phase 9 target", () => {
  it("today, one organisation's pack verifies under the other's trust roots", async () => {
    const { meridian, sundaram } = await twoOrganisations();
    const theirs = await recordEvidence(sundaram);

    const mine = await request(app).get("/v1/trust-roots").set(as(meridian)).expect(200);
    const report = await verifyEvidencePack(theirs, { trustRoots: mine.body as TrustRoot[] });

    // When Phase 9 gives each organisation its own gate and recorder keys, this becomes
    // `not.toBe("VERIFIED")` and the flagship claim is earned.
    expect(report.result).toBe("VERIFIED");
  });

  it("because both organisations are handed the same signing keys", async () => {
    const { meridian, sundaram } = await twoOrganisations();

    const mine = await trustRootsFor(repositories, meridian.organisationId);
    const theirs = await trustRootsFor(repositories, sundaram.organisationId);

    const keyIds = (roots: TrustRoot[]) => roots.map((root) => root.keyId).sort();

    // Identical, and that is the whole gap. After Phase 9 these sets must be disjoint except for
    // whatever a deployment deliberately publishes in common.
    expect(keyIds(mine)).toEqual(keyIds(theirs));
    expect(mine.some((root) => root.role === "gate")).toBe(true);
  });
});
