import { readFile } from "node:fs/promises";
import type { Pool } from "pg";
import { createPool } from "../../src/persistence/postgres.js";

const connectionString = process.env.DATABASE_URL;

export const databaseAvailable = Boolean(connectionString);

export class TestSchema {
  readonly name = `warrant_test_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  private readonly pools: Pool[] = [];
  private administrator: Pool | undefined;

  private open(schema: string | undefined, max: number): Pool {
    const pool = createPool({
      connectionString: connectionString ?? "",
      ...(schema ? { schema } : {}),
      max,
    });
    this.pools.push(pool);
    return pool;
  }

  get admin(): Pool {
    this.administrator ??= this.open(this.name, 2);
    return this.administrator;
  }

  instance(max = 2): Pool {
    return this.open(this.name, max);
  }

  async create(): Promise<void> {
    const bootstrap = this.open(undefined, 1);
    const migration = await readFile(
      new URL("../../migrations/001_initial.sql", import.meta.url),
      "utf8",
    );

    await bootstrap.query(`create schema ${this.name}`);
    const client = await bootstrap.connect();
    try {
      await client.query(`set search_path to ${this.name}`);
      await client.query(migration);
      await client.query("set search_path to public");
    } finally {
      client.release();
    }
    await bootstrap.end();
    this.pools.splice(this.pools.indexOf(bootstrap), 1);
  }

  async drop(): Promise<void> {
    try {
      await this.admin.query(`drop schema if exists ${this.name} cascade`);
    } finally {
      await Promise.all(this.pools.map((pool) => pool.end()));
      this.pools.length = 0;
      this.administrator = undefined;
    }
  }
}
