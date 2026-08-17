import { afterAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { PostgresNonceStore, createPool } from "../src/persistence/postgres.js";
import { deploymentScopedNonceStore } from "./support/nonce-contract.js";

const connectionString = process.env.DATABASE_URL;
const withDatabase = connectionString ? describe : describe.skip;

const runId = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
const nonce = (suffix: string) => `nonce_${runId}_${suffix}`;

const pools: Pool[] = [];

function instance(): Pool {
  const pool = createPool({ connectionString: connectionString ?? "", max: 4 });
  pools.push(pool);
  return pool;
}

afterAll(async () => {
  if (pools.length > 0) {
    await pools[0]!.query("delete from nonces where nonce like $1", [`nonce_${runId}_%`]);
  }
  await Promise.all(pools.map((pool) => pool.end()));
});

withDatabase("PostgresNonceStore, against two independent connection pools", () => {
  let first: Pool | undefined;
  let second: Pool | undefined;

  async function pair() {
    first ??= instance();
    second ??= instance();
    return {
      first: new PostgresNonceStore(first, 600),
      second: new PostgresNonceStore(second, 600),
    };
  }

  deploymentScopedNonceStore("PostgresNonceStore", pair, nonce);

  it("keeps refusing a replayed nonce after the claiming instance goes away", async () => {
    const { first: alive } = await pair();
    const value = nonce("survives-restart");
    expect(await alive.claim(value)).toBe(true);

    const restarted = new PostgresNonceStore(instance(), 600);
    expect(await restarted.claim(value)).toBe(false);
  });

  it("prunes a nonce only once it can no longer be replayed inside the freshness window", async () => {
    const pool = instance();
    const expired = new PostgresNonceStore(pool, -60);
    const live = new PostgresNonceStore(pool, 600);

    const stale = nonce("stale");
    const current = nonce("current");
    expect(await expired.claim(stale)).toBe(true);
    expect(await live.claim(current)).toBe(true);

    await live.prune();

    const remaining = await pool.query("select nonce from nonces where nonce = any($1::text[])", [
      [stale, current],
    ]);
    expect(remaining.rows.map((row) => row.nonce)).toEqual([current]);
  });

  it("refuses a nonce whose row was written by another instance without a round trip through the API", async () => {
    const pool = instance();
    const store = new PostgresNonceStore(pool, 600);
    const value = nonce("written-directly");

    await pool.query("insert into nonces (nonce, expires_at) values ($1, now() + interval '10 minutes')", [
      value,
    ]);

    expect(await store.claim(value)).toBe(false);
  });
});
