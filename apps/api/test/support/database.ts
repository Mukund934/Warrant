import { readFile } from "node:fs/promises";
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
    const migrations = await Promise.all(
      [
        "001_initial.sql",
        "002_append_only_grants.sql",
        "003_organisations.sql",
        "004_agents.sql",
        "005_capabilities.sql",
        "006_house_scope.sql",
        "007_evidence_search.sql",
        "008_generated_evidence_columns.sql",
      ].map((file) =>
        readFile(new URL(`../../migrations/${file}`, import.meta.url), "utf8"),
      ),
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
