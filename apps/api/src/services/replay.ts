import { verifyEvidencePack } from "@warrant/core";
import type { Check, VerificationReport } from "@warrant/core";
import { notFound } from "../http/errors.js";
import type { Repositories, TenantScope } from "../persistence/types.js";
import { trustRootsFor } from "./agents.js";

export interface ReplayedCheck {
  id: string;
  title: string;
  status: Check["status"];
  detail: string;
  recorded?: Check["status"];
  agrees: boolean;
}

export interface Replay {
  /** A re-derivation of a decision already made. Never a decision, and never storable as one. */
  replayed: true;
  packId: string;
  result: VerificationReport["result"];
  trustRootSource: VerificationReport["trustRootSource"];
  recorded: { verdict: string; reason: string; evaluatedAt: string };
  rederived?: { verdict: string; reason: string; reproduced: boolean };
  checks: ReplayedCheck[];
  limitations: string[];
}

const WEAKEST_FORM =
  "This is the issuing service checking its own evidence against its own published keys, which is " +
  "the weakest form of verification there is. The claim worth making is the other one: run " +
  "`warrant-verify replay <pack.json>` against keys you obtained yourself, with this service " +
  "switched off.";

export async function replayEvidence(
  packId: string,
  repositories: Repositories,
  scope: TenantScope,
): Promise<Replay> {
  const pack = await repositories.evidence.findById(packId, scope);
  if (!pack) throw notFound(`no evidence pack with id ${packId}`);

  // Verified against the keys this deployment publishes rather than the ones travelling inside the
  // pack, so a pack whose embedded roots were swapped does not verify against itself.
  const report = await verifyEvidencePack(pack, {
    trustRoots: await trustRootsFor(repositories, scope),
  });

  const recorded = new Map(pack.decision.checks.map((check) => [check.id, check.status]));
  const rederived = report.authority?.checks ?? report.checks;

  const checks: ReplayedCheck[] = rederived.map((check) => {
    const before = recorded.get(check.id);
    return {
      id: check.id,
      title: check.title,
      status: check.status,
      detail: check.detail,
      ...(before ? { recorded: before } : {}),
      agrees: before === undefined || before === check.status,
    };
  });

  return {
    replayed: true,
    packId: pack.packId,
    result: report.result,
    trustRootSource: report.trustRootSource,
    recorded: {
      verdict: pack.decision.verdict,
      reason: pack.decision.reason,
      evaluatedAt: pack.decision.evaluatedAt,
    },
    ...(report.authority
      ? {
          rederived: {
            verdict: report.authority.verdict,
            reason: report.authority.reason,
            reproduced: report.authority.reproduced,
          },
        }
      : {}),
    checks,
    limitations: [...report.limitations, WEAKEST_FORM],
  };
}
