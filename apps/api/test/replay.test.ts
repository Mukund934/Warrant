import { describe, expect, it } from "vitest";
import { InMemoryNonceStore } from "../src/persistence/memory.js";
import type { NonceStore, ReplayScope } from "../src/persistence/types.js";
import { nonceRetentionSeconds } from "../src/persistence/postgres.js";
import { REQUEST_FRESHNESS } from "../src/warrant/context.js";
import { deploymentScopedNonceStore } from "./support/nonce-contract.js";

const NONCE = "nonce_2026_08_17_0001";

class SharedNonceStore implements NonceStore {
  readonly scope: ReplayScope = "deployment";

  constructor(private readonly seen: Set<string>) {}

  async claim(nonce: string): Promise<boolean> {
    if (this.seen.has(nonce)) return false;
    this.seen.add(nonce);
    return true;
  }
}

describe("replay protection inside one process", () => {
  it("accepts a nonce once and refuses it afterwards", async () => {
    const store = new InMemoryNonceStore();
    expect(await store.claim(NONCE)).toBe(true);
    expect(await store.claim(NONCE)).toBe(false);
  });
});

describe("the boundary of the in-memory store, stated as an executable fact", () => {
  it("declares itself process-scoped", () => {
    expect(new InMemoryNonceStore().scope).toBe("process");
  });

  it("does NOT refuse a nonce already spent against a second instance", async () => {
    const first = new InMemoryNonceStore();
    const second = new InMemoryNonceStore();

    expect(await first.claim(NONCE)).toBe(true);
    expect(await second.claim(NONCE)).toBe(true);
  });

  it("fails open rather than closed, which is why the scope must be declared", async () => {
    const first = new InMemoryNonceStore();
    const second = new InMemoryNonceStore();
    await first.claim(NONCE);

    const replayedElsewhere = await second.claim(NONCE);
    expect(replayedElsewhere).toBe(true);
    expect(second.scope).not.toBe("deployment");
  });
});

deploymentScopedNonceStore(
  "an in-process stand-in",
  async () => {
    const shared = new Set<string>();
    return { first: new SharedNonceStore(shared), second: new SharedNonceStore(shared) };
  },
  (suffix) => `nonce_shared_${suffix}`,
);

describe("how long a shared store must remember a nonce", () => {
  it("outlives the window in which the request is still spendable", () => {
    const retention = nonceRetentionSeconds(REQUEST_FRESHNESS);
    const spendableFor = REQUEST_FRESHNESS.maxAgeSeconds + REQUEST_FRESHNESS.clockSkewSeconds;

    expect(retention).toBeGreaterThan(spendableFor);
  });

  it("leaves room for the API and the database disagreeing about the time", () => {
    const retention = nonceRetentionSeconds(REQUEST_FRESHNESS);
    const spendableFor = REQUEST_FRESHNESS.maxAgeSeconds + REQUEST_FRESHNESS.clockSkewSeconds;

    expect(retention - spendableFor).toBeGreaterThanOrEqual(REQUEST_FRESHNESS.clockSkewSeconds);
  });
});
