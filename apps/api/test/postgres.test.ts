import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { exportJWK, generateKeyPair } from "jose";
import { GENESIS_DIGEST, ledgerEntryDigest, verifyEvidencePack } from "@warrant/core";
import type { EvidencePack, LedgerEntry, Mandate, Scope, TrustRoot } from "@warrant/core";
import { demoScenarios, trustRoots } from "@warrant/core/fixtures";
import { createApp } from "../src/app.js";
import {
  PostgresCapabilityRepository,
  PostgresDirectoryRepository,
  PostgresOrganisationKeyRepository,
  PostgresEvidenceRepository,
  PostgresLedgerRepository,
  PostgresMandateRepository,
  PostgresNonceStore,
  createPostgresRepositories,
  pingDatabase,
} from "../src/persistence/postgres.js";
import { deploymentScopedNonceStore } from "./support/nonce-contract.js";
import { testIdentity } from "./support/identity.js";
import type { TestIdentity } from "./support/identity.js";
import { TestSchema, databaseAvailable } from "./support/database.js";

const withDatabase = databaseAvailable ? describe : describe.skip;

const main = new TestSchema();
const rewritten = new TestSchema();

beforeAll(async () => {
  if (!databaseAvailable) return;
  await main.create();
  await rewritten.create();
  await main.warm();
}, 120_000);

afterAll(async () => {
  if (!databaseAvailable) return;
  await main.drop();
  await rewritten.drop();
}, 120_000);

const entry = (ref: string): Omit<LedgerEntry, "seq" | "prevDigest" | "digest"> => ({
  type: "mandate.issued",
  recordedAt: "2026-08-20T14:00:00Z",
  ref,
  payloadDigest: "sha256:JMoiHzpVXAelYzCa5Zc5-6TF-QjKrJRQNI9WLoDlWpI",
});

withDatabase("PostgresNonceStore, against two independent connection pools", () => {
  const nonce = (suffix: string) => `nonce_${suffix}`;

  let stores: { first: PostgresNonceStore; second: PostgresNonceStore } | undefined;

  async function pair() {
    stores ??= {
      first: new PostgresNonceStore(main.admin, 600),
      second: new PostgresNonceStore(main.second, 600),
    };
    return stores;
  }

  deploymentScopedNonceStore("PostgresNonceStore", pair, nonce, 30_000);

  it("prunes a nonce only once it can no longer be replayed inside the freshness window", async () => {
    const expired = new PostgresNonceStore(main.admin, -60);
    const live = new PostgresNonceStore(main.admin, 600);

    const stale = nonce("stale");
    const current = nonce("current");
    expect(await expired.claim(stale)).toBe(true);
    expect(await live.claim(current)).toBe(true);

    await live.prune();

    const remaining = await main.admin.query(
      "select nonce from nonces where nonce = any($1::text[])",
      [[stale, current]],
    );
    expect(remaining.rows.map((row) => row.nonce)).toEqual([current]);
  });

  it("refuses a nonce whose row was written without a round trip through the API", async () => {
    const store = new PostgresNonceStore(main.admin, 600);
    const value = nonce("written-directly");

    await main.admin.query(
      "insert into nonces (nonce, expires_at) values ($1, now() + interval '10 minutes')",
      [value],
    );

    expect(await store.claim(value)).toBe(false);
  });
});

withDatabase("PostgresLedgerRepository", () => {
  it("starts the chain at the genesis marker and links each entry to the one before it", async () => {
    const ledger = new PostgresLedgerRepository(main.admin);

    const first = await ledger.append(entry("mnd_first"));
    const second = await ledger.append(entry("mnd_second"));

    expect(first.seq).toBe(0);
    expect(first.prevDigest).toBe(GENESIS_DIGEST);
    expect(second.seq).toBe(1);
    expect(second.prevDigest).toBe(first.digest);
    expect(await ledger.count()).toBe(2);
    expect((await ledger.head())?.digest).toBe(second.digest);
  });

  it("hands the same entries back to a repository that never wrote them", async () => {
    const reader = new PostgresLedgerRepository(main.second);
    const entries = await reader.entries();

    expect(entries.map((row) => row.seq)).toEqual([0, 1]);
    expect(entries[0]?.prevDigest).toBe(GENESIS_DIGEST);
    expect(entries[1]?.prevDigest).toBe(entries[0]?.digest);
  });

  it("gives twelve simultaneous appends a contiguous unbroken chain", async () => {
    const writers = [
      new PostgresLedgerRepository(main.admin),
      new PostgresLedgerRepository(main.second),
    ];
    const before = await writers[0]!.count();

    const appended = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        writers[index % writers.length]!.append(entry(`mnd_${index}`)),
      ),
    );

    expect(new Set(appended.map((row) => row.seq)).size).toBe(12);

    const entries = await writers[0]!.entries();
    expect(entries.map((row) => row.seq)).toEqual([...Array(before + 12).keys()]);

    for (const [index, row] of entries.entries()) {
      const previous = entries[index - 1];
      expect(row.prevDigest).toBe(previous ? previous.digest : GENESIS_DIGEST);
    }
  }, 60_000);

  it("leaves no gap behind when an append fails inside its transaction", async () => {
    const ledger = new PostgresLedgerRepository(main.admin);
    const before = await ledger.count();

    await expect(
      ledger.append({ ...entry("mnd_broken"), recordedAt: "not-a-timestamp" }),
    ).rejects.toThrow();

    expect(await ledger.count()).toBe(before);

    const next = await ledger.append(entry("mnd_after_failure"));
    expect(next.seq).toBe(before);
    expect(next.prevDigest).toBe((await ledger.entries())[before - 1]?.digest);
  });
});

const inr = (major: number) => ({ currency: "INR" as const, minor: major * 100 });
const KALYANI = "Kalyani Steel Works";

const rootScope: Scope = {
  actions: ["invoice.read", "payment.approve", "payment.execute"],
  audience: ["erp:meridian/accounts-payable", "bank:hdfc/corporate-api"],
  counterparties: { allow: [KALYANI] },
  limits: { perAction: inr(1_000_000), perPeriod: { amount: inr(4_000_000), days: 30 } },
  purpose: "Settlement of approved supplier invoices",
};

const validity = { notBefore: "2026-01-01T00:00:00Z", expiresAt: "2027-01-01T00:00:00Z" };

withDatabase("the whole API on top of PostgreSQL", () => {
  function boot() {
    return createApp({
      repositories: createPostgresRepositories(main.admin, 600),
      database: { probe: () => pingDatabase(main.admin) },
    });
  }

  const payment = (mandateId: string, description: string, major: number) => ({
    mandateId,
    action: "payment.execute",
    resource: "erp:meridian/accounts-payable",
    counterparty: KALYANI,
    description,
    nonce: `nonce_${crypto.randomUUID()}`,
    amount: inr(major),
  });

  let rootId = "";
  let leafId = "";
  let packId = "";
  let ledgerBefore = 0;

  it("reports a reachable database on /health", async () => {
    const response = await request(boot()).get("/health").expect(200);
    expect(response.body).toEqual({
      status: "ok",
      persistence: "postgres",
      database: true,
      databaseReachable: true,
      replayScope: "deployment",
      auth: "open",
      authIssuer: null,
      assistant: null,
    });
  });

  it("issues, delegates and records an action that verifies offline", async () => {
    const app = boot();
    ledgerBefore = await new PostgresLedgerRepository(main.admin).count();

    const root = await request(app)
      .post("/v1/mandates")
      .send({ scope: rootScope, ...validity, maxDelegationDepth: 2 })
      .expect(201);
    rootId = (root.body as Mandate).id;

    const delegated = await request(app)
      .post(`/v1/mandates/${rootId}/delegations`)
      .send({
        scopeDelta: {
          actions: ["payment.execute"],
          counterparties: { allow: [KALYANI] },
          limits: { perAction: inr(500_000) },
        },
      })
      .expect(201);
    leafId = (delegated.body as Mandate).id;

    const action = await request(app)
      .post("/v1/actions")
      .send(payment(leafId, "Invoice 7781 settlement", 120_000))
      .expect(201);

    expect(action.body.verdict).toBe("ALLOW");
    packId = action.body.packId;

    const stored = await request(app).get(`/v1/evidence/${packId}`).expect(200);
    const report = await verifyEvidencePack(stored.body as EvidencePack, { trustRoots });
    expect(report.result).toBe("VERIFIED");
  }, 60_000);

  it("keeps the mandate chain, the evidence and the ledger across a restart", async () => {
    const restarted = boot();

    const chain = await request(restarted).get(`/v1/mandates/${leafId}`).expect(200);
    expect(chain.body.chain.map((mandate: Mandate) => mandate.id)).toEqual([rootId, leafId]);

    const pack = await request(restarted).get(`/v1/evidence/${packId}`).expect(200);
    expect(pack.body.packId).toBe(packId);

    const checkpoint = await request(restarted).post("/v1/checkpoint").expect(201);
    expect(checkpoint.body.treeSize).toBe(ledgerBefore + 4);
  }, 60_000);

  it("refuses the same nonce a second time and records the refusal as evidence", async () => {
    const app = boot();
    const body = payment(leafId, "Invoice 7782 settlement", 90_000);

    const accepted = await request(app).post("/v1/actions").send(body).expect(201);
    expect(accepted.body.verdict).toBe("ALLOW");

    const replayed = await request(app).post("/v1/actions").send(body).expect(201);
    expect(replayed.body.verdict).toBe("BLOCK");
    expect(replayed.body.reason).toMatch(/nonce/i);
  }, 60_000);

  it("revokes a mandate once, refuses to revoke it twice, and blocks what it authorised", async () => {
    const app = boot();

    await request(app)
      .post(`/v1/mandates/${leafId}/revocation`)
      .send({ reason: "agent retired" })
      .expect(204);

    const second = await request(app)
      .post(`/v1/mandates/${leafId}/revocation`)
      .send({ reason: "agent retired" })
      .expect(422);
    expect(second.body.error).toBe("already_revoked");

    const blocked = await request(app)
      .post("/v1/actions")
      .send(payment(leafId, "Invoice 7783 settlement", 10_000))
      .expect(201);

    expect(blocked.body.verdict).toBe("BLOCK");
    expect(blocked.body.reason).toMatch(/revoked/i);
  }, 60_000);

  it("hands back the revocation timestamp exactly as it was written", async () => {
    const [withdrawn] = await createPostgresRepositories(main.admin, 600).mandates.revocations(null);

    expect(withdrawn?.mandateId).toBe(leafId);
    expect(withdrawn?.revokedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it("resolves nothing for records that were never written", async () => {
    const repositories = createPostgresRepositories(main.admin, 600);

    expect(await repositories.mandates.findChain("mnd_never_existed", null)).toBeUndefined();
    expect(await repositories.mandates.findById("mnd_never_existed", null)).toBeUndefined();
    expect(await repositories.evidence.findById("pack_never_existed", null)).toBeUndefined();
    expect(
      await repositories.mandates.revoke({
        mandateId: "mnd_never_existed",
        revokedAt: "2026-08-20T14:00:00Z",
        reason: "nothing to withdraw",
      }, null),
    ).toBe(false);
  });
});

withDatabase("the database refuses to rewrite a recorded ledger", () => {
  it("refuses an update, a delete, and a read of an entry that no longer matches its digest", async () => {
    const ledger = new PostgresLedgerRepository(rewritten.admin);
    const recorded = await ledger.append(entry("mnd_immutable"));

    await expect(
      rewritten.admin.query("update ledger_entries set ref = 'rewritten' where seq = $1", [
        recorded.seq,
      ]),
    ).rejects.toThrow(/append-only/);

    await expect(
      rewritten.admin.query("delete from ledger_entries where seq = $1", [recorded.seq]),
    ).rejects.toThrow(/append-only/);

    const forged = await ledgerEntryDigest({
      seq: 1,
      prevDigest: recorded.digest,
      ...entry("mnd_forged"),
    });
    await rewritten.admin.query(
      `insert into ledger_entries (seq, type, ref, recorded_at, payload_digest, prev_digest, digest)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        1,
        "mandate.issued",
        "mnd_substituted",
        "2026-08-20T14:00:00Z",
        "sha256:JMoiHzpVXAelYzCa5Zc5-6TF-QjKrJRQNI9WLoDlWpI",
        recorded.digest,
        forged,
      ],
    );

    await expect(ledger.entries()).rejects.toThrow(/does not match the digest/);
  }, 60_000);

  it("withholds rewrite privileges from the application role the API is meant to hold", async () => {
    const granted = async (table: string, privilege: string) => {
      const answer = await rewritten.admin.query<{ allowed: boolean }>(
        "select has_table_privilege('warrant_api', $1, $2) as allowed",
        [`${rewritten.name}.${table}`, privilege],
      );
      return answer.rows[0]?.allowed;
    };

    expect(await granted("ledger_entries", "INSERT")).toBe(true);
    expect(await granted("ledger_entries", "SELECT")).toBe(true);
    expect(await granted("ledger_entries", "UPDATE")).toBe(false);
    expect(await granted("ledger_entries", "DELETE")).toBe(false);
    expect(await granted("ledger_entries", "TRUNCATE")).toBe(false);

    expect(await granted("evidence_packs", "UPDATE")).toBe(false);
    expect(await granted("evidence_packs", "DELETE")).toBe(false);

    expect(await granted("mandates", "UPDATE")).toBe(true);
    expect(await granted("mandates", "DELETE")).toBe(false);
  }, 60_000);

  it("does not let that role log in yet, so today only the triggers bind", async () => {
    const role = await rewritten.admin.query<{ rolcanlogin: boolean }>(
      "select rolcanlogin from pg_roles where rolname = 'warrant_api'",
    );
    const connected = await rewritten.admin.query<{ user: string }>(
      "select current_user as user",
    );

    expect(role.rows[0]?.rolcanlogin).toBe(false);
    expect(connected.rows[0]?.user).not.toBe("warrant_api");
  }, 60_000);
});

withDatabase("tenant isolation, enforced by the database rather than by the caller", () => {
  let identity: TestIdentity;
  let meridian = { token: "", organisationId: "" };
  let kalyani = { token: "", organisationId: "" };
  let theirMandate = "";
  let theirPack = "";

  function boot() {
    return createApp({
      repositories: createPostgresRepositories(main.admin, 600),
      auth: { mode: "required", verifier: identity.verifier },
    });
  }

  const as = (member: { token: string }) => ({ authorization: `Bearer ${member.token}` });

  async function enrol(subject: string, name: string) {
    const token = await identity.mint(subject, `${subject}@example.test`);
    const created = await request(boot())
      .post("/v1/organisations")
      .set("authorization", `Bearer ${token}`)
      .send({ name, jurisdiction: "IN-MH" })
      .expect(201);
    return { token, organisationId: created.body.id as string };
  }

  beforeAll(async () => {
    if (!databaseAvailable) return;
    identity = await testIdentity();
    const stamp = crypto.randomUUID().slice(0, 8);
    meridian = await enrol(`user_priya_${stamp}`, `Meridian ${stamp}`);
    kalyani = await enrol(`user_rahul_${stamp}`, `Kalyani ${stamp}`);

    const app = boot();
    const root = await request(app)
      .post("/v1/mandates")
      .set(as(kalyani))
      .send({ scope: rootScope, ...validity, maxDelegationDepth: 2 })
      .expect(201);
    theirMandate = root.body.id;

    const leaf = await request(app)
      .post(`/v1/mandates/${theirMandate}/delegations`)
      .set(as(kalyani))
      .send({ scopeDelta: { actions: ["payment.execute"], limits: { perAction: inr(500_000) } } })
      .expect(201);

    const recorded = await request(app)
      .post("/v1/actions")
      .set(as(kalyani))
      .send({
        mandateId: leaf.body.id,
        action: "payment.execute",
        resource: "erp:meridian/accounts-payable",
        counterparty: KALYANI,
        description: "Invoice inside Kalyani",
        nonce: `nonce_${crypto.randomUUID()}`,
        amount: inr(100_000),
      })
      .expect(201);
    theirPack = recorded.body.packId;
  }, 120_000);

  it("returns no row for a mandate belonging to another organisation", async () => {
    const repositories = createPostgresRepositories(main.admin, 600);

    expect(await repositories.mandates.findById(theirMandate, kalyani.organisationId)).toBeDefined();
    expect(
      await repositories.mandates.findById(theirMandate, meridian.organisationId),
    ).toBeUndefined();
    expect(
      await repositories.mandates.findChain(theirMandate, meridian.organisationId),
    ).toBeUndefined();
  }, 60_000);

  it("returns no row for evidence belonging to another organisation", async () => {
    const repositories = createPostgresRepositories(main.admin, 600);

    expect(await repositories.evidence.findById(theirPack, kalyani.organisationId)).toBeDefined();
    expect(
      await repositories.evidence.findById(theirPack, meridian.organisationId),
    ).toBeUndefined();
    expect(await repositories.evidence.recent(50, meridian.organisationId)).toEqual([]);
  }, 60_000);

  it("refuses a revocation aimed at another organisation's mandate", async () => {
    const repositories = createPostgresRepositories(main.admin, 600);

    const applied = await repositories.mandates.revoke(
      { mandateId: theirMandate, revokedAt: "2026-08-20T14:00:00Z", reason: "not mine" },
      meridian.organisationId,
    );
    expect(applied).toBe(false);
  }, 60_000);

  it("refuses the whole request through the API, not merely at the repository", async () => {
    const app = boot();

    await request(app).get(`/v1/mandates/${theirMandate}`).set(as(kalyani)).expect(200);
    await request(app).get(`/v1/mandates/${theirMandate}`).set(as(meridian)).expect(404);
    await request(app).get(`/v1/evidence/${theirPack}`).set(as(meridian)).expect(404);
    await request(app).get(`/v1/evidence/${theirPack}`).set(as(kalyani)).expect(200);
  }, 60_000);

  it("will not record a mandate against an organisation that does not exist", async () => {
    await expect(
      main.admin.query(
        `insert into mandates (id, parent_id, depth, organisation_id, liable_principal_id,
           subject_id, issuer_key_id, not_before, expires_at, issued_at, document)
         values ($1, null, 0, $2, 'person:x', 'agent:y', 'key:z',
           now(), now() + interval '1 day', now(), '{}'::jsonb)`,
        [`mnd_orphan_${crypto.randomUUID().slice(0, 8)}`, "org:does-not-exist"],
      ),
    ).rejects.toThrow(/foreign key|violates/i);
  }, 60_000);
});

withDatabase("an assurance block survives a jsonb round trip", () => {
  let identity: TestIdentity;
  let member = { token: "", organisationId: "" };

  function boot() {
    return createApp({
      repositories: createPostgresRepositories(main.admin, 600),
      auth: { mode: "required", verifier: identity.verifier },
    });
  }

  const as = (who: { token: string }) => ({ authorization: `Bearer ${who.token}` });

  beforeAll(async () => {
    if (!databaseAvailable) return;
    identity = await testIdentity();
    const stamp = crypto.randomUUID().slice(0, 8);
    const token = await identity.mint(`user_anchor_${stamp}`, `anchor_${stamp}@example.test`);
    const created = await request(boot())
      .post("/v1/organisations")
      .set("authorization", `Bearer ${token}`)
      .send({ name: `Anchor ${stamp}`, jurisdiction: "IN-MH" })
      .expect(201);
    member = { token, organisationId: created.body.id as string };
  }, 120_000);

  it("comes back from the database byte for byte, signature intact", async () => {
    const app = boot();
    const issued = await request(app)
      .post("/v1/mandates")
      .set(as(member))
      .send({ scope: rootScope, ...validity, maxDelegationDepth: 2 })
      .expect(201);

    const reread = await request(app).get(`/v1/mandates/${issued.body.id}`).set(as(member)).expect(200);

    expect(reread.body.mandate).toEqual(issued.body);
    expect(reread.body.mandate.liablePrincipal.assurance).toEqual(
      issued.body.liablePrincipal.assurance,
    );
    expect(reread.body.mandate.liablePrincipal.assurance.reference).toBeUndefined();
    expect("reference" in reread.body.mandate.liablePrincipal.assurance).toBe(false);

    const stored = await main.admin.query<{ document: { liablePrincipal: { assurance: unknown } } }>(
      "select document from mandates where id = $1",
      [issued.body.id],
    );
    expect(stored.rows[0]?.document.liablePrincipal.assurance).not.toBeNull();
  }, 60_000);

  it("still verifies offline after the pack has been through the database", async () => {
    const app = boot();
    const root = await request(app)
      .post("/v1/mandates")
      .set(as(member))
      .send({ scope: rootScope, ...validity, maxDelegationDepth: 2 })
      .expect(201);

    const delegated = await request(app)
      .post(`/v1/mandates/${root.body.id}/delegations`)
      .set(as(member))
      .send({ scopeDelta: { actions: ["payment.execute"], limits: { perAction: inr(500_000) } } })
      .expect(201);

    expect(delegated.body.liablePrincipal).toEqual(root.body.liablePrincipal);

    const recorded = await request(app)
      .post("/v1/actions")
      .set(as(member))
      .send({
        mandateId: delegated.body.id,
        action: "payment.execute",
        resource: "erp:meridian/accounts-payable",
        counterparty: KALYANI,
        description: "Invoice under a real accountable human",
        nonce: `nonce_${crypto.randomUUID()}`,
        amount: inr(100_000),
      })
      .expect(201);

    const stored = await request(app)
      .get(`/v1/evidence/${recorded.body.packId}`)
      .set(as(member))
      .expect(200);

    // The organisation publishes its own roots since D58, so this is what a relying party fetches.
    const published = await request(app).get("/v1/trust-roots").set(as(member)).expect(200);
    const report = await verifyEvidencePack(stored.body as EvidencePack, {
      trustRoots: published.body as TrustRoot[],
    });
    expect(report.result).toBe("VERIFIED");
    expect(report.authority?.reproduced).toBe(true);

    const assurance = report.authority?.checks.find((check) => check.id === "principal.assurance");
    expect(assurance?.status).toBe("warn");
  }, 60_000);

  it("names the caller's own organisation as the legal entity", async () => {
    const app = boot();
    const issued = await request(app)
      .post("/v1/mandates")
      .set(as(member))
      .send({ scope: rootScope, ...validity, maxDelegationDepth: 1 })
      .expect(201);

    const organisation = await main.admin.query<{ name: string }>(
      "select name from organisations where id = $1",
      [member.organisationId],
    );

    expect(issued.body.liablePrincipal.legalEntity).toBe(organisation.rows[0]?.name);
    expect(issued.body.organisation.name).toBe(organisation.rows[0]?.name);
  }, 60_000);
});

withDatabase("the agent registry on real SQL", () => {
  let identity: TestIdentity;
  let owner = { token: "", organisationId: "" };

  function boot() {
    return createApp({
      repositories: createPostgresRepositories(main.admin, 600),
      auth: { mode: "required", verifier: identity.verifier },
    });
  }

  const as = (who: { token: string }) => ({ authorization: `Bearer ${who.token}` });

  async function publicJwk() {
    const { publicKey } = await generateKeyPair("ES256", { extractable: true });
    return exportJWK(publicKey);
  }

  beforeAll(async () => {
    if (!databaseAvailable) return;
    identity = await testIdentity();
    const stamp = crypto.randomUUID().slice(0, 8);
    const token = await identity.mint(`user_reg_${stamp}`, `reg_${stamp}@example.test`);
    const created = await request(boot())
      .post("/v1/organisations")
      .set("authorization", `Bearer ${token}`)
      .send({ name: `Registry ${stamp}`, jurisdiction: "IN-MH" })
      .expect(201);
    owner = { token, organisationId: created.body.id as string };
  }, 120_000);

  it("stores the agent, its key and its lifecycle entries", async () => {
    const app = boot();
    const registered = await request(app)
      .post("/v1/agents")
      .set(as(owner))
      .send({ name: `Runner ${crypto.randomUUID().slice(0, 6)}`, runtime: "node/22", publicKeyJwk: await publicJwk() })
      .expect(201);

    const agentId = registered.body.id;
    await request(app).post(`/v1/agents/${agentId}/status`).set(as(owner)).send({ status: "active" }).expect(200);

    const stored = await main.admin.query<{ status: string; organisation_id: string }>(
      "select status, organisation_id from agents where id = $1",
      [agentId],
    );
    expect(stored.rows[0]?.status).toBe("active");
    expect(stored.rows[0]?.organisation_id).toBe(owner.organisationId);

    const keys = await main.admin.query("select key_id from agent_keys where agent_id = $1", [agentId]);
    expect(keys.rows).toHaveLength(1);

    const events = await main.admin.query<{ type: string }>(
      "select type from ledger_entries where ref = $1 order by seq",
      [agentId],
    );
    expect(events.rows.map((row) => row.type)).toEqual(["agent.registered", "agent.status_changed"]);
  }, 60_000);

  it("lets the database refuse a second current key for one agent", async () => {
    const app = boot();
    const registered = await request(app)
      .post("/v1/agents")
      .set(as(owner))
      .send({ name: `Rotator ${crypto.randomUUID().slice(0, 6)}`, runtime: "node/22", publicKeyJwk: await publicJwk() })
      .expect(201);

    const agentId = registered.body.id;
    const jwk = await publicJwk();

    await expect(
      main.admin.query(
        `insert into agent_keys (key_id, agent_id, public_key_jwk, signing_from)
         values ($1, $2, $3, now())`,
        [`key:agent:duplicate_${crypto.randomUUID().slice(0, 8)}`, agentId, jwk],
      ),
    ).rejects.toThrow(/duplicate key|unique/i);
  }, 60_000);

  it("retires the old key and keeps it queryable after a rotation", async () => {
    const app = boot();
    const registered = await request(app)
      .post("/v1/agents")
      .set(as(owner))
      .send({ name: `Rotate ${crypto.randomUUID().slice(0, 6)}`, runtime: "node/22", publicKeyJwk: await publicJwk() })
      .expect(201);

    const agentId = registered.body.id;
    const before = await main.admin.query<{ key_id: string }>(
      "select key_id from agent_keys where agent_id = $1",
      [agentId],
    );

    await request(app)
      .post(`/v1/agents/${agentId}/key-rotation`)
      .set(as(owner))
      .send({ publicKeyJwk: await publicJwk() })
      .expect(201);

    const after = await main.admin.query<{ key_id: string; signing_until: Date | null }>(
      "select key_id, signing_until from agent_keys where agent_id = $1 order by signing_from",
      [agentId],
    );

    expect(after.rows).toHaveLength(2);
    expect(after.rows[0]?.key_id).toBe(before.rows[0]?.key_id);
    expect(after.rows[0]?.signing_until).not.toBeNull();
    expect(after.rows[1]?.signing_until).toBeNull();
  }, 60_000);

  it("will not record an agent against an organisation that does not exist", async () => {
    await expect(
      main.admin.query(
        `insert into agents (id, organisation_id, name, runtime, status, registered_at, status_changed_at)
         values ($1, $2, 'Orphan', 'node/22', 'registered', now(), now())`,
        [`agt_orphan_${crypto.randomUUID().slice(0, 8)}`, "org:does-not-exist"],
      ),
    ).rejects.toThrow(/foreign key|violates/i);
  }, 60_000);

  it("will not record a lifecycle state the schema does not know", async () => {
    await expect(
      main.admin.query(
        `insert into agents (id, organisation_id, name, runtime, status, registered_at, status_changed_at)
         values ($1, $2, 'Bad state', 'node/22', 'retired', now(), now())`,
        [`agt_badstate_${crypto.randomUUID().slice(0, 8)}`, owner.organisationId],
      ),
    ).rejects.toThrow(/check constraint|violates/i);
  }, 60_000);
});

withDatabase("the capability catalogue in Postgres", () => {
  const store = () => new PostgresCapabilityRepository(main.admin);
  const orgs = { first: "", second: "" };

  const record = (organisationId: string, overrides: Record<string, unknown> = {}) => ({
    id: "payment.execute",
    organisationId,
    title: "Execute a payment",
    description: "Move money to a supplier against an approved invoice",
    risk: "high" as const,
    amount: "required" as const,
    currencies: ["INR" as const],
    approvalAbove: { currency: "INR" as const, minor: 20_000_000 },
    status: "active" as const,
    registeredAt: "2026-08-19T09:00:00Z",
    statusChangedAt: "2026-08-19T09:00:00Z",
    ...overrides,
  });

  beforeAll(async () => {
    if (!databaseAvailable) return;
    const stamp = crypto.randomUUID().slice(0, 8);
    orgs.first = `org:catalogue-a-${stamp}`;
    orgs.second = `org:catalogue-b-${stamp}`;

    for (const id of [orgs.first, orgs.second]) {
      await main.admin.query(
        "insert into organisations (id, name, jurisdiction) values ($1, $2, 'IN-MH')",
        [id, `Catalogue ${id.slice(-8)}`],
      );
    }
  }, 120_000);

  it("lets two organisations hold the same capability id with different meanings", async () => {
    const capabilities = store();
    expect(await capabilities.register(record(orgs.first))).toBe(true);
    expect(await capabilities.register(record(orgs.second, { risk: "low" }))).toBe(true);

    expect((await capabilities.find("payment.execute", orgs.first))?.risk).toBe("high");
    expect((await capabilities.find("payment.execute", orgs.second))?.risk).toBe("low");
  }, 60_000);

  it("hands a threshold back as a number, not the string the driver returns for a bigint", async () => {
    const capabilities = store();
    const found = await capabilities.find("payment.execute", orgs.first);

    expect(typeof found?.approvalAbove?.minor).toBe("number");
    expect(found?.approvalAbove?.minor).toBe(20_000_000);
    expect(found?.currencies).toEqual(["INR"]);
  }, 60_000);

  it("refuses in SQL a status change aimed at another organisation's capability", async () => {
    const capabilities = store();
    const applied = await capabilities.setStatus(
      "payment.execute",
      "withdrawn",
      "2026-08-19T10:00:00Z",
      `${orgs.first}-not-a-real-organisation`,
    );

    expect(applied).toBe(false);
    expect((await capabilities.find("payment.execute", orgs.first))?.status).toBe("active");
  }, 60_000);

  it("counts and enforces per organisation, never across the table", async () => {
    const capabilities = store();
    await capabilities.setEnforcement(orgs.first, "required", "2026-08-19T10:00:00Z");

    expect(await capabilities.catalogue(orgs.first)).toEqual({ enforcement: "required", size: 1 });
    expect(await capabilities.catalogue(orgs.second)).toEqual({ enforcement: "advisory", size: 1 });
  }, 60_000);

  it("will not record a capability against an organisation that does not exist", async () => {
    await expect(
      main.admin.query(
        `insert into capabilities (organisation_id, id, title, description, risk, amount_rule, status)
         values ($1, 'payment.execute', 'Orphan', 'No owner', 'low', 'optional', 'active')`,
        ["org:does-not-exist"],
      ),
    ).rejects.toThrow(/foreign key|violates/i);
  }, 60_000);

  it("will not record a risk level the schema does not know", async () => {
    await expect(
      main.admin.query(
        `insert into capabilities (organisation_id, id, title, description, risk, amount_rule, status)
         values ($1, 'payment.unknown', 'Bad risk', 'Unknown level', 'apocalyptic', 'optional', 'active')`,
        [orgs.first],
      ),
    ).rejects.toThrow(/check constraint|violates/i);
  }, 60_000);

  it("will not record half an approval threshold", async () => {
    await expect(
      main.admin.query(
        `insert into capabilities (
           organisation_id, id, title, description, risk, amount_rule, status, approval_above_currency
         )
         values ($1, 'payment.half', 'Half a threshold', 'Currency without an amount', 'low', 'optional', 'active', 'INR')`,
        [orgs.first],
      ),
    ).rejects.toThrow(/check constraint|violates/i);
  }, 60_000);
});

withDatabase("the house scope in Postgres", () => {
  const directory = () => new PostgresDirectoryRepository(main.admin);
  const orgs = { first: "", second: "" };

  const CEILING = {
    actions: ["payment.execute"],
    audience: ["erp:meridian/accounts-payable"],
    counterparties: { allow: ["Kalyani Steel Works"] },
    limits: {
      perAction: { currency: "INR" as const, minor: 20_000_000 },
      perPeriod: { amount: { currency: "INR" as const, minor: 90_000_000 }, days: 30 },
    },
    approval: { above: { currency: "INR" as const, minor: 5_000_000 } },
    purpose: "Supplier settlement only",
  };

  beforeAll(async () => {
    if (!databaseAvailable) return;
    const stamp = crypto.randomUUID().slice(0, 8);
    orgs.first = `org:house-a-${stamp}`;
    orgs.second = `org:house-b-${stamp}`;

    for (const id of [orgs.first, orgs.second]) {
      await main.admin.query(
        "insert into organisations (id, name, jurisdiction) values ($1, $2, 'IN-MH')",
        [id, `House ${id.slice(-8)}`],
      );
    }
  }, 120_000);

  it("round-trips a whole scope through jsonb, nested money included", async () => {
    const store = directory();
    await store.setHouseScope(orgs.first, CEILING, "2026-08-19T09:00:00Z");

    expect(await store.houseScope(orgs.first)).toEqual(CEILING);
  }, 60_000);

  it("holds one ceiling per organisation and never leaks it sideways", async () => {
    const store = directory();
    expect(await store.houseScope(orgs.second)).toBeUndefined();
  }, 60_000);

  it("replaces rather than duplicates when a ceiling is set again", async () => {
    const store = directory();
    await store.setHouseScope(
      orgs.first,
      { ...CEILING, actions: ["invoice.read"] },
      "2026-08-19T10:00:00Z",
    );

    expect((await store.houseScope(orgs.first))?.actions).toEqual(["invoice.read"]);

    const rows = await main.admin.query("select 1 from house_scopes where organisation_id = $1", [
      orgs.first,
    ]);
    expect(rows.rows).toHaveLength(1);
  }, 60_000);

  it("keeps the row but reports no ceiling once it is withdrawn", async () => {
    const store = directory();
    await store.setHouseScope(orgs.first, null, "2026-08-19T11:00:00Z");

    expect(await store.houseScope(orgs.first)).toBeUndefined();

    const rows = await main.admin.query("select scope from house_scopes where organisation_id = $1", [
      orgs.first,
    ]);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.scope).toBeNull();
  }, 60_000);

  it("will not record a ceiling against an organisation that does not exist", async () => {
    await expect(
      main.admin.query(
        "insert into house_scopes (organisation_id, scope) values ($1, $2)",
        ["org:does-not-exist", CEILING],
      ),
    ).rejects.toThrow(/foreign key|violates/i);
  }, 60_000);
});

withDatabase("evidence search in Postgres", () => {
  const evidence = () => new PostgresEvidenceRepository(main.admin);
  const orgs = { first: "", second: "" };
  const mine: EvidencePack[] = [];
  const theirs: EvidencePack[] = [];

  beforeAll(async () => {
    if (!databaseAvailable) return;
    const stamp = crypto.randomUUID().slice(0, 8);
    orgs.first = `org:search-a-${stamp}`;
    orgs.second = `org:search-b-${stamp}`;

    for (const id of [orgs.first, orgs.second]) {
      await main.admin.query(
        "insert into organisations (id, name, jurisdiction) values ($1, $2, 'IN-MH')",
        [id, `Search ${id.slice(-8)}`],
      );
    }

    // Real signed packs, split between two organisations so nothing collides on the primary key.
    const scenarios = await demoScenarios();
    const store = evidence();
    for (const [index, scenario] of scenarios.entries()) {
      const target = index % 2 === 0 ? mine : theirs;
      target.push(scenario.pack);
      await store.save(scenario.pack, index % 2 === 0 ? orgs.first : orgs.second);
    }
  }, 120_000);

  it("fills the derived columns from the stored document, leaving the pack untouched", async () => {
    const sample = mine[0]!;
    const rows = await main.admin.query<{
      action: string;
      resource: string;
      counterparty: string;
      actor: string;
      document: EvidencePack;
    }>(
      "select action, resource, counterparty, actor, document from evidence_packs where pack_id = $1",
      [sample.packId],
    );

    const row = rows.rows[0]!;
    expect(row.action).toBe(sample.request.action);
    expect(row.resource).toBe(sample.request.resource);
    expect(row.counterparty).toBe(sample.request.counterparty);
    expect(row.actor).toBe(sample.request.actor);
    expect(row.document).toEqual(sample);
  }, 60_000);

  // The repository inserts only the document, so these columns being right is Postgres computing
  // them, not the application remembering to. That is what makes them independent of deploy order:
  // a pack written by an older build still becomes searchable.
  it("refuses to let anything write the derived columns directly", async () => {
    const sample = mine[0]!;
    await expect(
      main.admin.query(
        `insert into evidence_packs (
           pack_id, root_mandate_id, organisation_id, verdict, evaluated_at, generated_at,
           action, document
         )
         values ($1, $2, $3, 'ALLOW', now(), now(), 'payment.forged', $4)`,
        [`pack_forced_${crypto.randomUUID().slice(0, 8)}`, sample.authority.chain[0]!.id, orgs.first, sample],
      ),
    ).rejects.toThrow(/non-DEFAULT value/i);
  }, 60_000);

  it("filters in SQL and never reaches another organisation", async () => {
    const page = await evidence().search({ limit: 50 }, orgs.first);
    const found = page.results.map((row) => row.packId);

    expect(found.sort()).toEqual(mine.map((pack) => pack.packId).sort());
    for (const pack of theirs) expect(found).not.toContain(pack.packId);
  }, 60_000);

  it("filters by verdict and by counterparty", async () => {
    const store = evidence();
    const blocked = mine.filter((pack) => pack.decision.verdict === "BLOCK");

    const byVerdict = await store.search({ verdict: "BLOCK", limit: 50 }, orgs.first);
    expect(byVerdict.results.map((row) => row.packId).sort()).toEqual(
      blocked.map((pack) => pack.packId).sort(),
    );

    const counterparty = mine[0]!.request.counterparty;
    const byCounterparty = await store.search({ counterparty, limit: 50 }, orgs.first);
    expect(byCounterparty.results.every((row) => row.counterparty === counterparty)).toBe(true);
    expect(byCounterparty.results.length).toBeGreaterThan(0);
  }, 60_000);

  it("pages on the pair it orders by, without repeating a row", async () => {
    const store = evidence();
    const seen: string[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < 10; page += 1) {
      const result = await store.search(
        { limit: 2, ...(cursor ? { cursor } : {}) },
        orgs.first,
      );
      seen.push(...result.results.map((row) => row.packId));
      cursor = result.nextCursor;
      if (!cursor) break;
    }

    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.sort()).toEqual(mine.map((pack) => pack.packId).sort());
  }, 60_000);

  it("returns nothing at all for an organisation that recorded nothing", async () => {
    const empty = await evidence().search({ limit: 50 }, `${orgs.first}-nobody`);
    expect(empty.results).toEqual([]);
    expect(empty.nextCursor).toBeUndefined();
  }, 60_000);
});

withDatabase("walking a mandate tree in Postgres", () => {
  const mandates = () => new PostgresMandateRepository(main.admin);
  const ledger = () => new PostgresLedgerRepository(main.admin);
  const orgs = { ours: "", theirs: "" };
  let parent: Mandate;
  let child: Mandate;
  let stray: Mandate;

  beforeAll(async () => {
    if (!databaseAvailable) return;
    const stamp = crypto.randomUUID().slice(0, 8);
    orgs.ours = `org:tree-a-${stamp}`;
    orgs.theirs = `org:tree-b-${stamp}`;

    for (const id of [orgs.ours, orgs.theirs]) {
      await main.admin.query(
        "insert into organisations (id, name, jurisdiction) values ($1, $2, 'IN-MH')",
        [id, `Tree ${id.slice(-8)}`],
      );
    }

    const chain = (await demoScenarios())
      .map((scenario) => scenario.pack.authority.chain)
      .find((candidate) => candidate.length > 1)!;

    const rename = (mandate: Mandate, id: string, organisationId: string, parentId?: string) => ({
      ...mandate,
      id,
      organisation: { ...mandate.organisation, id: organisationId },
      ...(parentId ? { parent: { id: parentId, digest: mandate.parent!.digest } } : {}),
    });

    parent = rename(chain[0]!, `mnd_tree_root_${stamp}`, orgs.ours);
    child = rename(chain[1]!, `mnd_tree_child_${stamp}`, orgs.ours, parent.id);
    // A mandate whose parent belongs to someone else cannot be created through the API, because a
    // delegation inherits its parent's organisation. Written directly, it is what the recursive
    // query has to refuse to walk into.
    stray = rename(chain[1]!, `mnd_tree_stray_${stamp}`, orgs.theirs, parent.id);

    const store = mandates();
    for (const mandate of [parent, child, stray]) await store.save(mandate);
  }, 120_000);

  it("returns the mandate and everything beneath it, nearest first", async () => {
    const found = await mandates().descendants(parent.id, orgs.ours);
    expect(found.map((mandate) => mandate.id)).toEqual([parent.id, child.id]);
  }, 60_000);

  it("will not walk into a child recorded under another organisation", async () => {
    const found = await mandates().descendants(parent.id, orgs.ours);
    expect(found.map((mandate) => mandate.id)).not.toContain(stray.id);
  }, 60_000);

  it("returns nothing at all for a tree the caller cannot see", async () => {
    expect(await mandates().descendants(parent.id, orgs.theirs)).toEqual([]);
  }, 60_000);

  it("returns just the leaf when asked about one, not its ancestors", async () => {
    const found = await mandates().descendants(child.id, orgs.ours);
    expect(found.map((mandate) => mandate.id)).toEqual([child.id]);
  }, 60_000);

  it("reads ledger entries for named refs only, in sequence order", async () => {
    const store = ledger();
    const first = await store.append(entry(`tree-a-${crypto.randomUUID().slice(0, 8)}`));
    const ignored = await store.append(entry(`tree-b-${crypto.randomUUID().slice(0, 8)}`));
    const second = await store.append(entry(`tree-c-${crypto.randomUUID().slice(0, 8)}`));

    const found = await store.entriesFor([second.ref, first.ref]);
    expect(found.map((row) => row.ref)).toEqual([first.ref, second.ref]);
    expect(found.map((row) => row.ref)).not.toContain(ignored.ref);
  }, 60_000);

  it("asks the database nothing when there are no refs", async () => {
    expect(await ledger().entriesFor([])).toEqual([]);
  }, 60_000);
});

/**
 * An organisation's keys carry the moment they became usable, and a proof carries the moment it was
 * made. If those two come from different clocks, an organisation's own fresh evidence verifies as
 * *"published but not yet in use"* — which is exactly what happened when `created_at` was left to
 * the column default and the database's clock ran a little ahead of the application's.
 *
 * The fix is that the application stamps the key. This is the test that would have caught it.
 */
withDatabase("an organisation's keys are stamped by the application clock", () => {
  const keys = () => new PostgresOrganisationKeyRepository(main.admin);

  it("stores the instant it was given, not the database's own now()", async () => {
    const organisationId = `org:clock-${crypto.randomUUID().slice(0, 8)}`;
    await new PostgresDirectoryRepository(main.admin).createOrganisation({
      id: organisationId,
      name: `Clock ${organisationId.slice(-8)}`,
      jurisdiction: "IN-MH",
    });

    // Deliberately in the past, and deliberately to the second: nothing the database would produce.
    const stamped = "2026-01-02T03:04:05Z";
    const installed = await keys().install([
      {
        organisationId,
        role: "principal",
        keyId: `key:principal:clock-${crypto.randomUUID().slice(0, 8)}`,
        publicKeyJwk: { kty: "EC", crv: "P-256", x: "abc", y: "def" },
        privateKeyJwk: { kty: "EC", crv: "P-256", x: "abc", y: "def", d: "ghi" },
        createdAt: stamped,
      },
    ]);

    expect(installed).toBe(true);

    const [stored] = await keys().keyring(organisationId);
    expect(stored?.createdAt).toBe(stamped);
  }, 60_000);

  it("refuses a second keyring for the same organisation", async () => {
    const organisationId = `org:once-${crypto.randomUUID().slice(0, 8)}`;
    await new PostgresDirectoryRepository(main.admin).createOrganisation({
      id: organisationId,
      name: `Once ${organisationId.slice(-8)}`,
      jurisdiction: "IN-MH",
    });

    const key = (suffix: string) => ({
      organisationId,
      role: "gate" as const,
      keyId: `key:gate:once-${suffix}`,
      publicKeyJwk: { kty: "EC" as const, crv: "P-256" as const, x: "abc", y: "def" },
      privateKeyJwk: { kty: "EC" as const, crv: "P-256" as const, x: "abc", y: "def", d: "ghi" },
      createdAt: "2026-01-02T03:04:05Z",
    });

    expect(await keys().install([key("first")])).toBe(true);
    // A second is refused by the unique constraint rather than quietly added. An organisation whose
    // gate key changed underneath it would leave all its earlier evidence unverifiable.
    expect(await keys().install([key("second")])).toBe(false);
    expect(await keys().keyring(organisationId)).toHaveLength(1);
  }, 60_000);
});
