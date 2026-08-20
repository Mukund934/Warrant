import { readFile, readdir } from "node:fs/promises";
import type { Pool } from "pg";
import { createPool } from "../../src/persistence/postgres.js";

const connectionString = process.env.DATABASE_URL;

export const databaseAvailable = Boolean(connectionString);

export class TestSchema {
  readonly name = `warrant_test_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  private readonly pools: Pool[] = [];
  private administrator: Pool | undefined;
  private companion: Pool | undefined;

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

  get second(): Pool {
    this.companion ??= this.open(this.name, 2);
    return this.companion;
  }

  async warm(): Promise<void> {
    await Promise.all([this.admin.query("select 1"), this.second.query("select 1")]);
  }

  async create(): Promise<void> {
    const bootstrap = this.open(undefined, 1);
    // Read from the directory rather than listed by hand. A hardcoded list silently stops applying
    // new migrations, and the failure surfaces as a table that does not exist in a test schema long
    // after the migration itself was written and applied everywhere else.
    const directory = new URL("../../migrations/", import.meta.url);
    const files = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
    if (files.length === 0) throw new Error("no migrations found to build a test schema from");

    const migrations = await Promise.all(
      files.map((file) => readFile(new URL(file, directory), "utf8")),
    );

    await bootstrap.query(`create schema ${this.name}`);
    const client = await bootstrap.connect();
    try {
      await client.query(`set search_path to ${this.name}`);
      for (const migration of migrations) await client.query(migration);
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
      this.companion = undefined;
    }
  }
}
