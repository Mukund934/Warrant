import { describe, expect, it } from "vitest";
import { InMemoryNonceStore } from "../src/persistence/memory.js";
import type { NonceStore, ReplayScope } from "../src/persistence/types.js";

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

describe("the contract a deployment-scoped store must satisfy", () => {
  function deploymentScoped(): [NonceStore, NonceStore] {
    const shared = new Set<string>();
    return [new SharedNonceStore(shared), new SharedNonceStore(shared)];
  }

  it("refuses a nonce spent against any other instance", async () => {
    const [first, second] = deploymentScoped();
    expect(await first.claim(NONCE)).toBe(true);
    expect(await second.claim(NONCE)).toBe(false);
  });

  it("claims each distinct nonce exactly once across instances", async () => {
    const [first, second] = deploymentScoped();
    const nonces = ["a", "b", "c", "a", "b", "c"];
    const accepted: string[] = [];

    for (const [index, nonce] of nonces.entries()) {
      const store = index % 2 === 0 ? first : second;
      if (await store.claim(nonce)) accepted.push(nonce);
    }

    expect(accepted).toEqual(["a", "b", "c"]);
  });

  it("declares itself deployment-scoped", () => {
    const [store] = deploymentScoped();
    expect(store.scope).toBe("deployment");
  });
});
