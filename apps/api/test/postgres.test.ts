import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { GENESIS_DIGEST, ledgerEntryDigest, verifyEvidencePack } from "@warrant/core";
import type { EvidencePack, LedgerEntry, Mandate, Scope } from "@warrant/core";
import { trustRoots } from "@warrant/core/fixtures";
import { createApp } from "../src/app.js";
import {
  PostgresLedgerRepository,
  PostgresNonceStore,
  createPostgresRepositories,
  pingDatabase,
} from "../src/persistence/postgres.js";
import { deploymentScopedNonceStore } from "./support/nonce-contract.js";
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
    const [withdrawn] = await createPostgresRepositories(main.admin, 600).mandates.revocations();

    expect(withdrawn?.mandateId).toBe(leafId);
    expect(withdrawn?.revokedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it("resolves nothing for records that were never written", async () => {
    const repositories = createPostgresRepositories(main.admin, 600);

    expect(await repositories.mandates.findChain("mnd_never_existed")).toBeUndefined();
    expect(await repositories.mandates.findById("mnd_never_existed")).toBeUndefined();
    expect(await repositories.evidence.findById("pack_never_existed")).toBeUndefined();
    expect(
      await repositories.mandates.revoke({
        mandateId: "mnd_never_existed",
        revokedAt: "2026-08-20T14:00:00Z",
        reason: "nothing to withdraw",
      }),
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
});
