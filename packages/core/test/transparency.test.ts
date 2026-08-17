import { describe, expect, it } from "vitest";
import {
  WarrantError,
  checkpointFor,
  createKeyPair,
  decodeBase64Url,
  encodeBase64Url,
  leafHashOf,
  nodeHashOf,
  recomputeRoot,
  signerFromJwk,
  verifyCheckpoint,
  verifyInclusion,
} from "../src/index.js";
import type { InclusionProof, SignedHead } from "../src/index.js";

async function buildTree(count: number): Promise<{ leaves: string[]; root: string }> {
  const leaves = await Promise.all(
    Array.from({ length: count }, (_, index) => leafHashOf(new TextEncoder().encode(`entry-${index}`))),
  );

  async function root(range: string[]): Promise<string> {
    if (range.length === 1) return range[0]!;
    let split = 1;
    while (split * 2 < range.length) split *= 2;
    const left = await root(range.slice(0, split));
    const right = await root(range.slice(split));
    return nodeHashOf(decodeBase64Url(left), decodeBase64Url(right));
  }

  return { leaves, root: await root(leaves) };
}

async function proofFor(leaves: string[], index: number): Promise<string[]> {
  async function walk(range: string[], offset: number): Promise<string[]> {
    if (range.length === 1) return [];
    let split = 1;
    while (split * 2 < range.length) split *= 2;

    async function root(part: string[]): Promise<string> {
      if (part.length === 1) return part[0]!;
      let inner = 1;
      while (inner * 2 < part.length) inner *= 2;
      return nodeHashOf(
        decodeBase64Url(await root(part.slice(0, inner))),
        decodeBase64Url(await root(part.slice(inner))),
      );
    }

    if (index - offset < split) {
      return [...(await walk(range.slice(0, split), offset)), await root(range.slice(split))];
    }
    return [...(await walk(range.slice(split), offset + split)), await root(range.slice(0, split))];
  }
  return walk(leaves, 0);
}

describe("RFC 6962 hashing uses domain separation", () => {
  it("hashes a leaf differently from a node over the same bytes", async () => {
    const bytes = new TextEncoder().encode("same");
    const leaf = await leafHashOf(bytes);
    const node = await nodeHashOf(bytes, new Uint8Array(0));
    expect(leaf).not.toBe(node);
  });

  it("produces a distinct hash per leaf", async () => {
    const a = await leafHashOf(new TextEncoder().encode("a"));
    const b = await leafHashOf(new TextEncoder().encode("b"));
    expect(a).not.toBe(b);
  });
});

describe("inclusion proofs round-trip for every index", () => {
  for (const size of [1, 2, 3, 4, 5, 7, 8, 9, 16, 17]) {
    it(`recomputes the root for all ${size} leaves`, async () => {
      const { leaves, root } = await buildTree(size);
      for (let index = 0; index < size; index += 1) {
        const proof: InclusionProof = {
          logIndex: index,
          treeSize: size,
          leafHash: leaves[index]!,
          rootHash: root,
          hashes: await proofFor(leaves, index),
        };
        const outcome = await verifyInclusion(proof);
        expect(outcome.reason ?? "ok").toBe("ok");
        expect(outcome.valid).toBe(true);
      }
    });
  }
});

describe("a proof that does not hold up is refused", () => {
  async function validProof(): Promise<InclusionProof> {
    const { leaves, root } = await buildTree(8);
    return {
      logIndex: 3,
      treeSize: 8,
      leafHash: leaves[3]!,
      rootHash: root,
      hashes: await proofFor(leaves, 3),
    };
  }

  it("refuses a proof whose leaf was swapped", async () => {
    const proof = await validProof();
    const { leaves } = await buildTree(8);
    const outcome = await verifyInclusion({ ...proof, leafHash: leaves[4]! });
    expect(outcome.valid).toBe(false);
    expect(outcome.reason).toMatch(/does not reach the stated root/);
  });

  it("refuses a proof with a hash removed", async () => {
    const proof = await validProof();
    const outcome = await verifyInclusion({ ...proof, hashes: proof.hashes.slice(1) });
    expect(outcome.valid).toBe(false);
  });

  it("refuses a proof with an extra hash", async () => {
    const proof = await validProof();
    const outcome = await verifyInclusion({
      ...proof,
      hashes: [...proof.hashes, encodeBase64Url(new Uint8Array(32))],
    });
    expect(outcome.valid).toBe(false);
  });

  it("refuses an index outside the tree", async () => {
    const proof = await validProof();
    await expect(recomputeRoot({ ...proof, logIndex: 99 })).rejects.toThrow(WarrantError);
  });

  it("refuses an empty tree", async () => {
    const proof = await validProof();
    await expect(recomputeRoot({ ...proof, treeSize: 0 })).rejects.toThrow(WarrantError);
  });
});

describe("checkpoints", () => {
  const head: SignedHead = {
    seq: 4,
    entryCount: 5,
    digest: "sha256:JMoiHzpVXAelYzCa5Zc5-6TF-QjKrJRQNI9WLoDlWpI",
    signedAt: "2026-08-20T14:32:07Z",
    proof: {
      type: "JsonWebSignature2020",
      created: "2026-08-20T14:32:07Z",
      verificationMethod: "key:ledger:placeholder",
      alg: "ES256",
      jws: "aa..bb",
    },
  };

  it("commits to the ledger head and verifies against the signer's key", async () => {
    const pair = await createKeyPair("Checkpoint signer", "ledger");
    const checkpoint = await checkpointFor(
      head,
      "warrant/demo",
      "2026-08-20T15:00:00Z",
      signerFromJwk(pair.keyId, pair.privateKeyJwk),
    );
    expect(checkpoint.treeSize).toBe(head.entryCount);
    expect(checkpoint.ledgerDigest).toBe(head.digest);
    expect(await verifyCheckpoint(checkpoint, pair.publicKeyJwk)).toEqual({ valid: true });
  });

  it("fails verification when the committed ledger digest is edited", async () => {
    const pair = await createKeyPair("Checkpoint tamper", "ledger");
    const checkpoint = await checkpointFor(
      head,
      "warrant/demo",
      "2026-08-20T15:00:00Z",
      signerFromJwk(pair.keyId, pair.privateKeyJwk),
    );
    const edited = { ...checkpoint, ledgerDigest: "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" };
    const outcome = await verifyCheckpoint(edited, pair.publicKeyJwk);
    expect(outcome.valid).toBe(false);
  });

  it("needs no network, no log and no credential to verify", async () => {
    const pair = await createKeyPair("Offline", "ledger");
    const checkpoint = await checkpointFor(
      head,
      "warrant/demo",
      "2026-08-20T15:00:00Z",
      signerFromJwk(pair.keyId, pair.privateKeyJwk),
    );
    const original = globalThis.fetch;
    Object.defineProperty(globalThis, "fetch", {
      value: () => {
        throw new Error("verification must not reach the network");
      },
      configurable: true,
    });
    try {
      expect(await verifyCheckpoint(checkpoint, pair.publicKeyJwk)).toEqual({ valid: true });
    } finally {
      Object.defineProperty(globalThis, "fetch", { value: original, configurable: true });
    }
  });
});
