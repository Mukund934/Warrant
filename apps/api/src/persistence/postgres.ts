import pg from "pg";
import type { Pool } from "pg";
import type { NonceStore, ReplayScope } from "./types.js";

export interface PostgresOptions {
  connectionString: string;
  caCertificate?: string;
  max?: number;
}

export function createPool(options: PostgresOptions): Pool {
  return new pg.Pool({
    connectionString: options.connectionString,
    ssl: options.caCertificate
      ? { ca: options.caCertificate, rejectUnauthorized: true }
      : { rejectUnauthorized: false },
    max: options.max ?? 10,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  });
}

export interface FreshnessWindow {
  maxAgeSeconds: number;
  clockSkewSeconds: number;
}

export function nonceRetentionSeconds(freshness: FreshnessWindow): number {
  return freshness.maxAgeSeconds + freshness.clockSkewSeconds * 2;
}

const PRUNE_EVERY = 512;

export class PostgresNonceStore implements NonceStore {
  readonly scope: ReplayScope = "deployment";
  private sincePrune = 0;

  constructor(
    private readonly pool: Pool,
    private readonly retentionSeconds: number,
  ) {}

  async claim(nonce: string): Promise<boolean> {
    const claimed = await this.pool.query(
      `insert into nonces (nonce, expires_at)
       values ($1, now() + make_interval(secs => $2::double precision))
       on conflict (nonce) do nothing
       returning nonce`,
      [nonce, this.retentionSeconds],
    );

    this.sincePrune += 1;
    if (this.sincePrune >= PRUNE_EVERY) {
      this.sincePrune = 0;
      try {
        await this.prune();
      } catch {
        this.sincePrune = PRUNE_EVERY;
      }
    }

    return claimed.rowCount === 1;
  }

  async prune(): Promise<number> {
    const removed = await this.pool.query("delete from nonces where expires_at <= now()");
    return removed.rowCount ?? 0;
  }
}
