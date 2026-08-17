import { describe, expect, it } from "vitest";
import type { NonceStore } from "../../src/persistence/types.js";

export interface NonceStorePair {
  first: NonceStore;
  second: NonceStore;
}

export function deploymentScopedNonceStore(
  label: string,
  pair: () => Promise<NonceStorePair>,
  nonce: (suffix: string) => string,
): void {
  describe(`the contract a deployment-scoped store must satisfy — ${label}`, () => {
    it("refuses a nonce spent against any other instance", async () => {
      const { first, second } = await pair();
      const value = nonce("cross-instance");
      expect(await first.claim(value)).toBe(true);
      expect(await second.claim(value)).toBe(false);
    });

    it("claims each distinct nonce exactly once across instances", async () => {
      const { first, second } = await pair();
      const [a, b, c] = [nonce("a"), nonce("b"), nonce("c")];
      const order = [a, b, c, a, b, c];
      const accepted: string[] = [];

      for (const [index, value] of order.entries()) {
        const store = index % 2 === 0 ? first : second;
        if (await store.claim(value)) accepted.push(value);
      }

      expect(accepted).toEqual([a, b, c]);
    });

    it("claims a contested nonce exactly once under concurrency", async () => {
      const { first, second } = await pair();
      const value = nonce("contested");
      const stores = Array.from({ length: 12 }, (_, index) =>
        index % 2 === 0 ? first : second,
      );

      const outcomes = await Promise.all(stores.map((store) => store.claim(value)));
      expect(outcomes.filter(Boolean)).toHaveLength(1);
    });

    it("declares itself deployment-scoped", async () => {
      const { first } = await pair();
      expect(first.scope).toBe("deployment");
    });
  });
}
