import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { CONFORMANCE_VERSION, runVector } from "../src/index.js";
import type { ConformanceManifest, TrustRoot } from "../src/index.js";

const base = new URL("../../../conformance/", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("manifest.json", base), "utf8")) as ConformanceManifest;
const trustRoots = JSON.parse(
  await readFile(new URL(manifest.trustRootsFile, base), "utf8"),
) as TrustRoot[];

describe("the published conformance suite", () => {
  it("declares the version this build implements", () => {
    expect(manifest.version).toBe(CONFORMANCE_VERSION);
  });

  it("covers both genuine and tampered evidence", () => {
    const verified = manifest.vectors.filter((vector) => vector.result === "VERIFIED");
    const invalid = manifest.vectors.filter((vector) => vector.result === "INVALID");
    expect(verified.length).toBeGreaterThanOrEqual(8);
    expect(invalid.length).toBeGreaterThanOrEqual(5);
  });

  it("includes a genuine pack for every verdict, so a refusal is covered as evidence", () => {
    const verdicts = new Set(
      manifest.vectors.filter((vector) => vector.result === "VERIFIED").map((vector) => vector.verdict),
    );
    expect(verdicts).toEqual(new Set(["ALLOW", "BLOCK", "ESCALATE"]));
  });

  for (const vector of manifest.vectors) {
    it(`${vector.name} behaves as the suite declares`, async () => {
      const pack: unknown = JSON.parse(await readFile(new URL(vector.file, base), "utf8"));
      const outcome = await runVector(vector, pack, trustRoots, manifest.generatedAt);
      expect(outcome.failures).toEqual([]);
      expect(outcome.passed).toBe(true);
    });
  }
});
