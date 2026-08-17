import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { verifyCheckpoint } from "@warrant/core";
import { createApp } from "../src/app.js";
import { createInMemoryRepositories } from "../src/persistence/memory.js";
import { trustRoots } from "../src/warrant/context.js";

let app: ReturnType<typeof createApp>;
let repositories: ReturnType<typeof createInMemoryRepositories>;

beforeEach(() => {
  repositories = createInMemoryRepositories();
  app = createApp({ repositories });
});

describe("on-demand checkpoints", () => {
  it("refuses to commit to an empty ledger", async () => {
    const response = await request(app).post("/v1/checkpoint").expect(422);
    expect(response.body.error).toBe("ledger_empty");
  });

  it("commits to the ledger head and verifies against the recorder key", async () => {
    await repositories.ledger.append({
      type: "mandate.issued",
      recordedAt: "2026-08-20T14:00:00Z",
      ref: "mnd_test",
      payloadDigest: "sha256:JMoiHzpVXAelYzCa5Zc5-6TF-QjKrJRQNI9WLoDlWpI",
    });

    const response = await request(app).post("/v1/checkpoint").expect(201);
    expect(response.body.version).toBe("warrant/checkpoint/v0.1");
    expect(response.body.treeSize).toBe(1);

    const recorderKey = trustRoots.find((root) => root.keyId === response.body.proof.verificationMethod);
    expect(recorderKey).toBeDefined();
    expect(await verifyCheckpoint(response.body, recorderKey!.publicKeyJwk)).toEqual({ valid: true });
  });

  it("is on demand — nothing schedules it", async () => {
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../src/app.ts", import.meta.url), "utf8"),
    );
    expect(source).not.toMatch(/setInterval|setTimeout|cron/);
  });
});
