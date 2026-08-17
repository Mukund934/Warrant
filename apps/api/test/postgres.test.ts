import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GENESIS_DIGEST, ledgerEntryDigest } from "@warrant/core";
import type { LedgerEntry } from "@warrant/core";
import { PostgresLedgerRepository, PostgresNonceStore } from "../src/persistence/postgres.js";
import { deploymentScopedNonceStore } from "./support/nonce-contract.js";
import { TestSchema, databaseAvailable } from "./support/database.js";

const withDatabase = databaseAvailable ? describe : describe.skip;

const entry = (ref: string): Omit<LedgerEntry, "seq" | "prevDigest" | "digest"> => ({
  type: "mandate.issued",
  recordedAt: "2026-08-20T14:00:00Z",
  ref,
  payloadDigest: "sha256:JMoiHzpVXAelYzCa5Zc5-6TF-QjKrJRQNI9WLoDlWpI",
});

function usingSchema(): TestSchema {
  const schema = new TestSchema();

  beforeAll(async () => {
    await schema.create();
  }, 60_000);

  afterAll(async () => {
    await schema.drop();
  }, 60_000);

  return schema;
}

withDatabase("PostgresNonceStore, against two independent connection pools", () => {
  const schema = usingSchema();
  const nonce = (suffix: string) => `nonce_${suffix}`;

  let stores: { first: PostgresNonceStore; second: PostgresNonceStore } | undefined;

  async function pair() {
    stores ??= {
      first: new PostgresNonceStore(schema.instance(), 600),
      second: new PostgresNonceStore(schema.instance(), 600),
    };
    return stores;
  }

  deploymentScopedNonceStore("PostgresNonceStore", pair, nonce);

  it("prunes a nonce only once it can no longer be replayed inside the freshness window", async () => {
    const expired = new PostgresNonceStore(schema.admin, -60);
    const live = new PostgresNonceStore(schema.admin, 600);

    const stale = nonce("stale");
    const current = nonce("current");
    expect(await expired.claim(stale)).toBe(true);
    expect(await live.claim(current)).toBe(true);

    await live.prune();

    const remaining = await schema.admin.query(
      "select nonce from nonces where nonce = any($1::text[])",
      [[stale, current]],
    );
    expect(remaining.rows.map((row) => row.nonce)).toEqual([current]);
  });

  it("refuses a nonce whose row was written without a round trip through the API", async () => {
    const store = new PostgresNonceStore(schema.admin, 600);
    const value = nonce("written-directly");

    await schema.admin.query(
      "insert into nonces (nonce, expires_at) values ($1, now() + interval '10 minutes')",
      [value],
    );

    expect(await store.claim(value)).toBe(false);
  });
});

withDatabase("PostgresLedgerRepository, appending to an empty ledger", () => {
  const schema = usingSchema();

  it("starts the chain at the genesis marker and links each entry to the one before it", async () => {
    const ledger = new PostgresLedgerRepository(schema.admin);

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
    const reader = new PostgresLedgerRepository(schema.instance());
    const entries = await reader.entries();

    expect(entries.map((row) => row.seq)).toEqual([0, 1]);
    expect(entries[0]?.prevDigest).toBe(GENESIS_DIGEST);
    expect(entries[1]?.prevDigest).toBe(entries[0]?.digest);
  });
});

withDatabase("PostgresLedgerRepository, under concurrency", () => {
  const schema = usingSchema();

  it("gives twelve simultaneous appends a contiguous unbroken chain", async () => {
    const writers = [
      new PostgresLedgerRepository(schema.admin),
      new PostgresLedgerRepository(schema.instance(3)),
    ];
    const work = Array.from({ length: 12 }, (_, index) =>
      writers[index % writers.length]!.append(entry(`mnd_${index}`)),
    );

    const appended = await Promise.all(work);
    expect(new Set(appended.map((row) => row.seq)).size).toBe(12);

    const entries = await writers[0]!.entries();
    expect(entries.map((row) => row.seq)).toEqual([...Array(12).keys()]);

    for (const [index, row] of entries.entries()) {
      const previous = entries[index - 1];
      expect(row.prevDigest).toBe(previous ? previous.digest : GENESIS_DIGEST);
    }
  }, 60_000);

  it("leaves no gap behind when an append fails inside its transaction", async () => {
    const ledger = new PostgresLedgerRepository(schema.admin);
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

withDatabase("the database refuses to rewrite a recorded ledger", () => {
  const schema = usingSchema();

  it("refuses an update, a delete, and a read of an entry that no longer matches its digest", async () => {
    const ledger = new PostgresLedgerRepository(schema.admin);
    const recorded = await ledger.append(entry("mnd_immutable"));

    await expect(
      schema.admin.query("update ledger_entries set ref = 'rewritten' where seq = $1", [
        recorded.seq,
      ]),
    ).rejects.toThrow(/append-only/);

    await expect(
      schema.admin.query("delete from ledger_entries where seq = $1", [recorded.seq]),
    ).rejects.toThrow(/append-only/);

    const forged = await ledgerEntryDigest({
      seq: 1,
      prevDigest: recorded.digest,
      ...entry("mnd_forged"),
    });
    await schema.admin.query(
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
  });
});
