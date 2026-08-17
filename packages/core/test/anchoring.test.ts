import { describe, expect, it } from "vitest";
import {
  anchorCheckpoint,
  checkpointFor,
  createKeyPair,
  leafHashForCheckpoint,
  signerFromJwk,
} from "../src/index.js";
import type { Checkpoint, SignedHead, TransparencyLog } from "../src/index.js";

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

async function aCheckpoint(): Promise<Checkpoint> {
  const pair = await createKeyPair("Anchor signer", "ledger");
  return checkpointFor(head, "warrant/demo", "2026-08-20T15:00:00Z", signerFromJwk(pair.keyId, pair.privateKeyJwk));
}

function logThat(behaviour: TransparencyLog["submit"], name = "stub-log"): TransparencyLog {
  return { name, submit: behaviour };
}

describe("anchoring a checkpoint", () => {
  it("returns the inclusion proof when the log accepts the entry", async () => {
    const checkpoint = await aCheckpoint();
    const leafHash = await leafHashForCheckpoint(checkpoint);
    const log = logThat(async (request) => ({
      log: "stub-log",
      submittedAt: "2026-08-20T15:00:01Z",
      inclusion: {
        logIndex: 0,
        treeSize: 1,
        leafHash: request.leafHash,
        rootHash: request.leafHash,
        hashes: [],
      },
    }));

    const outcome = await anchorCheckpoint(checkpoint, log);
    expect(outcome.anchored).toBe(true);
    if (outcome.anchored) expect(outcome.anchor.inclusion.leafHash).toBe(leafHash);
  });

  it("refuses a proof for a different entry than the one submitted", async () => {
    const checkpoint = await aCheckpoint();
    const log = logThat(async () => ({
      log: "stub-log",
      submittedAt: "2026-08-20T15:00:01Z",
      inclusion: {
        logIndex: 0,
        treeSize: 1,
        leafHash: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        rootHash: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        hashes: [],
      },
    }));

    const outcome = await anchorCheckpoint(checkpoint, log);
    expect(outcome.anchored).toBe(false);
    if (!outcome.anchored) expect(outcome.reason).toMatch(/different entry/);
  });

  it("reports a malformed response rather than throwing", async () => {
    const checkpoint = await aCheckpoint();
    const log = logThat(async () => ({ log: "stub-log", submittedAt: "now" }) as never);
    const outcome = await anchorCheckpoint(checkpoint, log);
    expect(outcome.anchored).toBe(false);
    if (!outcome.anchored) expect(outcome.reason).toMatch(/without a usable inclusion proof/);
  });

  it("reports an unavailable log rather than throwing", async () => {
    const checkpoint = await aCheckpoint();
    const log = logThat(async () => {
      throw new Error("connect ECONNREFUSED");
    });
    const outcome = await anchorCheckpoint(checkpoint, log);
    expect(outcome.anchored).toBe(false);
    if (!outcome.anchored) expect(outcome.reason).toMatch(/could not be reached/);
  });

  it("times out instead of hanging", async () => {
    const checkpoint = await aCheckpoint();
    const log = logThat(
      (_request, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        }),
    );
    const outcome = await anchorCheckpoint(checkpoint, log, { timeoutMs: 20 });
    expect(outcome.anchored).toBe(false);
    if (!outcome.anchored) expect(outcome.reason).toMatch(/did not respond within 20ms/);
  });

  it("treats a duplicate submission as anchored when the log returns the existing entry", async () => {
    const checkpoint = await aCheckpoint();
    const log = logThat(async (request) => ({
      log: "stub-log",
      submittedAt: "2026-08-20T15:00:01Z",
      entryUri: "stub://entries/7",
      inclusion: {
        logIndex: 7,
        treeSize: 8,
        leafHash: request.leafHash,
        rootHash: request.leafHash,
        hashes: [],
      },
    }));
    const outcome = await anchorCheckpoint(checkpoint, log);
    expect(outcome.anchored).toBe(true);
    if (outcome.anchored) expect(outcome.anchor.entryUri).toBe("stub://entries/7");
  });

  it("produces a stable leaf hash for the same checkpoint", async () => {
    const checkpoint = await aCheckpoint();
    expect(await leafHashForCheckpoint(checkpoint)).toBe(await leafHashForCheckpoint(checkpoint));
  });
});

describe("the transparency log is never on the critical path", () => {
  it("leaves the checkpoint usable when anchoring fails completely", async () => {
    const checkpoint = await aCheckpoint();
    const log = logThat(async () => {
      throw new Error("the log is gone");
    });

    const outcome = await anchorCheckpoint(checkpoint, log);
    expect(outcome.anchored).toBe(false);
    expect(checkpoint.ledgerDigest).toBe(head.digest);
    expect(checkpoint.proof.jws).toContain("..");
  });
});
