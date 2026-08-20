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
 * The two-organisation flagship, asserted rather than described.
 *
 * One organisation records evidence; a second verifies it **without trusting the first**. All three
 * things that needs now hold, and the last of them is what Phase 9 was:
 *
 * | Claim | State |
 * | --- | --- |
 * | Neither organisation can read the other's evidence through the API | ✅ F-P2, **D34** |
 * | A pack verifies offline against keys fetched from the issuer, with no service involved | ✅ |
 * | A pack verifies **only** under the issuer's trust roots | ✅ **D58**, Phase 9 |
 *
 * The last block used to assert the opposite on purpose, because a limitation written in a document
 * gets quoted as though it were fixed. It inverted the day each organisation got its own principal,
 * gate and recorder keys — which is the whole of Phase 9, and the only part of the claim that was
 * ever missing.
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
 * **Cryptographic independence — the Phase 9 claim, earned.**
 *
 * Tenancy is no longer only a data boundary. Each organisation signs with its own principal, gate
 * and recorder keys (**D58**), so a pack issued by one **fails** under the trust roots of the other.
 * The second organisation is not taking the first's word for anything: it checks a signature against
 * a key it holds, and the key is not there.
 */
describe("cryptographic independence between organisations", () => {
  it("refuses one organisation's pack under the other's trust roots", async () => {
    const { meridian, sundaram } = await twoOrganisations();
    const theirs = await recordEvidence(sundaram);

    const mine = await request(app).get("/v1/trust-roots").set(as(meridian)).expect(200);
    const report = await verifyEvidencePack(theirs, { trustRoots: mine.body as TrustRoot[] });

    // This assertion is the flagship. Before Phase 9 it read `toBe("VERIFIED")` and was true for
    // the worst possible reason: the two organisations were never separate keys.
    expect(report.result).not.toBe("VERIFIED");

    // And it still verifies for its own issuer, so the refusal above is about the key rather than
    // about the pack being broken.
    const theirRoots = await request(app).get("/v1/trust-roots").set(as(sundaram)).expect(200);
    const owner = await verifyEvidencePack(theirs, { trustRoots: theirRoots.body as TrustRoot[] });
    expect(owner.result).toBe("VERIFIED");
    expect(owner.authority?.reproduced).toBe(true);
  });

  it("gives each organisation its own principal, gate and recorder keys", async () => {
    const { meridian, sundaram } = await twoOrganisations();

    const mine = await trustRootsFor(repositories, meridian.organisationId);
    const theirs = await trustRootsFor(repositories, sundaram.organisationId);

    const authorityKeys = (roots: TrustRoot[]) =>
      roots.filter((root) => root.role !== "agent").map((root) => root.keyId).sort();

    const ours = authorityKeys(mine);
    const yours = authorityKeys(theirs);

    expect(ours).toHaveLength(3);
    expect(yours).toHaveLength(3);
    // Disjoint. Not one authority key in common.
    expect(ours.filter((keyId) => yours.includes(keyId))).toEqual([]);

    for (const role of ["principal", "gate", "ledger"] as const) {
      expect(mine.some((root) => root.role === role)).toBe(true);
      expect(theirs.some((root) => root.role === role)).toBe(true);
    }
  });

  // The demonstration agents are shared fixtures and their keys are published by both, because a
  // mandate naming one as its subject is signed by that agent's key when it delegates. Agent keys
  // are not authority keys, and sharing them changes nothing about the claim above.
  it("shares only the demonstration agent keys, which sign no verdict", async () => {
    const { meridian, sundaram } = await twoOrganisations();

    const mine = await trustRootsFor(repositories, meridian.organisationId);
    const theirs = await trustRootsFor(repositories, sundaram.organisationId);

    const shared = mine
      .filter((root) => theirs.some((other) => other.keyId === root.keyId))
      .map((root) => root.role);

    expect(shared.length).toBeGreaterThan(0);
    expect([...new Set(shared)]).toEqual(["agent"]);
  });

  it("names the deciding organisation in its own gate id", async () => {
    const { sundaram } = await twoOrganisations();
    const pack = await recordEvidence(sundaram);

    expect(pack.decision.gate.id).toBe(`gate:${sundaram.organisationId}`);
  });
});
