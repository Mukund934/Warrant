import { verifyEvidencePack } from "./verify.js";
import type { TrustRoot } from "./types.js";

export const CONFORMANCE_VERSION = "warrant/conformance/v0.1";

export interface ConformanceExpectation {
  name: string;
  description: string;
  result: "VERIFIED" | "INVALID";
  verdict?: "ALLOW" | "BLOCK" | "ESCALATE";
  failingChecks?: string[];
}

export interface ConformanceManifest {
  version: string;
  generatedAt: string;
  trustRootsFile: string;
  vectors: (ConformanceExpectation & { file: string })[];
}

export interface VectorOutcome {
  name: string;
  passed: boolean;
  failures: string[];
}

export async function runVector(
  expectation: ConformanceExpectation,
  pack: unknown,
  trustRoots: TrustRoot[],
  verifiedAt: string,
): Promise<VectorOutcome> {
  const failures: string[] = [];
  const report = await verifyEvidencePack(pack, { trustRoots, verifiedAt });

  if (report.result !== expectation.result) {
    failures.push(`expected ${expectation.result}, got ${report.result}`);
  }

  if (expectation.verdict && report.authority?.verdict !== expectation.verdict) {
    failures.push(`expected verdict ${expectation.verdict}, got ${report.authority?.verdict ?? "none"}`);
  }

  for (const id of expectation.failingChecks ?? []) {
    const all = [...report.checks, ...(report.authority?.checks ?? [])];
    const check = all.find((entry) => entry.id === id);
    if (!check) {
      failures.push(`expected check ${id} to be present`);
    } else if (check.status !== "fail") {
      failures.push(`expected check ${id} to fail, it was ${check.status}`);
    }
  }

  return { name: expectation.name, passed: failures.length === 0, failures };
}
