import { canonicalJson, digestOf, withoutProof } from "./canonical.js";
import { findTrustRoot, verifyAgainstTrustRoot } from "./chain.js";
import { packBodyOf } from "./evidence.js";
import { assess, chainDigestOf } from "./gate.js";
import { verifyLedgerSegment } from "./ledger.js";
import { VERIFIER_VERSION, evidencePackSchema } from "./types.js";
import type { Check, EvidencePack, TrustRoot } from "./types.js";

export type VerificationResult = "VERIFIED" | "INVALID";

const AUTHENTICITY_CHECKS = new Set([
  "chain.present",
  "chain.rooted",
  "chain.sequence",
  "chain.linkage",
  "chain.signatures",
  "chain.root_trusted",
  "chain.liable_principal",
  "request.signature",
]);

export interface VerificationOptions {
  trustRoots?: TrustRoot[];
  verifiedAt?: string;
}

export interface AuthorityFinding {
  verdict: string;
  reproduced: boolean;
  reason: string;
  checks: Check[];
}

export interface VerificationReport {
  result: VerificationResult;
  verifier: string;
  verifiedAt: string;
  trustRootSource: "independent" | "embedded";
  checks: Check[];
  authority: AuthorityFinding | null;
  limitations: string[];
  summary: {
    packId: string;
    headline: string;
    authorisedBy: string;
    performedBy: string;
    verdict: string;
    occurredAt: string;
    packDigest: string;
  } | null;
}

function fail(id: string, title: string, detail: string, expected?: string, observed?: string): Check {
  const check: Check = { id, title, status: "fail", detail };
  if (expected !== undefined) check.expected = expected;
  if (observed !== undefined) check.observed = observed;
  return check;
}

function pass(id: string, title: string, detail: string): Check {
  return { id, title, status: "pass", detail };
}

function report(
  checks: Check[],
  verifiedAt: string,
  trustRootSource: VerificationReport["trustRootSource"],
  authority: AuthorityFinding | null,
  limitations: string[],
  summary: VerificationReport["summary"],
): VerificationReport {
  return {
    result: checks.some((check) => check.status === "fail") ? "INVALID" : "VERIFIED",
    verifier: VERIFIER_VERSION,
    verifiedAt,
    trustRootSource,
    checks,
    authority,
    limitations,
    summary,
  };
}

export async function verifyEvidencePack(
  raw: unknown,
  options: VerificationOptions = {},
): Promise<VerificationReport> {
  const verifiedAt = options.verifiedAt ?? new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const parsed = evidencePackSchema.safeParse(raw);

  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return report(
      [
        fail(
          "pack.structure",
          "The evidence pack is a well-formed Warrant pack",
          issue ? `${issue.path.join(".") || "pack"}: ${issue.message}` : "the pack does not match the format",
        ),
      ],
      verifiedAt,
      options.trustRoots ? "independent" : "embedded",
      null,
      [],
      null,
    );
  }

  const pack = raw as EvidencePack;
  const checks: Check[] = [
    pass("pack.structure", "The evidence pack is a well-formed Warrant pack", `format ${pack.version}`),
  ];

  const trustRootSource = options.trustRoots ? "independent" : "embedded";
  const trustRoots = options.trustRoots ?? pack.trustRoots;

  if (trustRootSource === "independent") {
    checks.push(
      pass(
        "trust.roots",
        "Signing keys were supplied independently of the pack",
        `${trustRoots.length} key${trustRoots.length === 1 ? "" : "s"} supplied by the verifying party`,
      ),
    );
  } else {
    checks.push({
      id: "trust.roots",
      title: "Signing keys were supplied independently of the pack",
      status: "warn",
      detail:
        "verification used the keys carried inside the pack, so it proves internal consistency rather than authenticity; supply the counterparty's published keys to close this",
      expected: "keys obtained from the issuing organisation",
      observed: "keys embedded in the pack",
    });
  }

  const body = packBodyOf(pack);
  const recomputedDigest = await digestOf(body);
  if (recomputedDigest !== pack.integrity.packDigest) {
    checks.push(
      fail(
        "pack.digest",
        "The pack contents match their recorded fingerprint",
        "the pack was modified after it was generated",
        pack.integrity.packDigest,
        recomputedDigest,
      ),
    );
  } else {
    checks.push(
      pass("pack.digest", "The pack contents match their recorded fingerprint", recomputedDigest),
    );
  }

  const packSigner = findTrustRoot(trustRoots, pack.integrity.proof.verificationMethod);
  if (!packSigner) {
    checks.push(
      fail(
        "pack.signature",
        "The pack is signed by the organisation that produced it",
        `no public key is known for ${pack.integrity.proof.verificationMethod}`,
      ),
    );
  } else {
    const outcome = await verifyAgainstTrustRoot(body, pack.integrity.proof, packSigner);
    checks.push(
      outcome.valid
        ? pass(
            "pack.signature",
            "The pack is signed by the organisation that produced it",
            `signed by ${packSigner.subject} at ${pack.generatedAt}`,
          )
        : fail(
            "pack.signature",
            "The pack is signed by the organisation that produced it",
            outcome.reason ?? "the pack signature is invalid",
          ),
    );
  }

  const root = pack.authority.chain[0]!;
  const inconsistencies: string[] = [];
  if (pack.summary.verdict !== pack.decision.verdict) {
    inconsistencies.push(
      `the summary reads ${pack.summary.verdict} while the signed decision says ${pack.decision.verdict}`,
    );
  }
  if (pack.authority.liablePrincipal.id !== root.liablePrincipal.id) {
    inconsistencies.push("the named accountable person is not the one the root mandate names");
  }
  if (pack.authority.liablePrincipal.name !== root.liablePrincipal.name) {
    inconsistencies.push(
      `the summary names ${pack.authority.liablePrincipal.name} while the root mandate names ${root.liablePrincipal.name}`,
    );
  }
  if (pack.organisation.id !== root.organisation.id) {
    inconsistencies.push("the pack is attributed to a different organisation than the mandates are");
  }
  if (canonicalJson(pack.authority.effectiveScope) !== canonicalJson(pack.decision.effectiveScope)) {
    inconsistencies.push("the scope shown alongside the chain is not the scope the gate evaluated");
  }

  if (inconsistencies.length > 0) {
    checks.push(
      fail(
        "pack.consistency",
        "The readable summary matches the signed records beneath it",
        inconsistencies.join("; "),
      ),
    );
  } else {
    checks.push(
      pass(
        "pack.consistency",
        "The readable summary matches the signed records beneath it",
        "the verdict, the accountable person, the organisation and the effective scope all agree with the signed decision and the root mandate",
      ),
    );
  }

  const requestDigest = await digestOf(pack.request);
  if (requestDigest !== pack.decision.requestDigest) {
    checks.push(
      fail(
        "decision.request_binding",
        "The recorded decision is bound to this exact request",
        "the action described in this pack is not the action the gate decided on",
        pack.decision.requestDigest,
        requestDigest,
      ),
    );
  } else {
    checks.push(
      pass(
        "decision.request_binding",
        "The recorded decision is bound to this exact request",
        requestDigest,
      ),
    );
  }

  const chainDigest = await chainDigestOf(pack.authority.chain);
  if (chainDigest !== pack.decision.chainDigest) {
    checks.push(
      fail(
        "decision.chain_binding",
        "The recorded decision is bound to this exact authority chain",
        "the mandates in this pack are not the mandates the gate evaluated",
        pack.decision.chainDigest,
        chainDigest,
      ),
    );
  } else {
    checks.push(
      pass(
        "decision.chain_binding",
        "The recorded decision is bound to this exact authority chain",
        chainDigest,
      ),
    );
  }

  const gateKey = findTrustRoot(trustRoots, pack.decision.proof.verificationMethod);
  if (!gateKey) {
    checks.push(
      fail(
        "decision.signature",
        "The gate signed its own decision",
        `no public key is known for ${pack.decision.proof.verificationMethod}`,
      ),
    );
  } else if (gateKey.role !== "gate") {
    checks.push(
      fail(
        "decision.signature",
        "The gate signed its own decision",
        "the decision was signed by a key that is not registered as a gate key",
        "a key with role gate",
        `role ${gateKey.role}`,
      ),
    );
  } else {
    const outcome = await verifyAgainstTrustRoot(
      withoutProof(pack.decision),
      pack.decision.proof,
      gateKey,
    );
    checks.push(
      outcome.valid
        ? pass(
            "decision.signature",
            "The gate signed its own decision",
            `signed by ${gateKey.subject} at ${pack.decision.evaluatedAt}`,
          )
        : fail(
            "decision.signature",
            "The gate signed its own decision",
            outcome.reason ?? "the decision signature is invalid",
          ),
    );
  }

  const reassessment = await assess(pack.request, pack.authority.chain, {
    trustRoots,
    revocation: pack.revocation,
    inputs: pack.decision.inputs,
  });

  checks.push(...reassessment.checks.filter((check) => AUTHENTICITY_CHECKS.has(check.id)));

  if (reassessment.verdict === pack.decision.verdict) {
    checks.push(
      pass(
        "decision.reproducible",
        "This verifier reached the same verdict independently",
        `re-evaluated the full authority chain and reached ${reassessment.verdict} without contacting the issuing service`,
      ),
    );
  } else {
    checks.push(
      fail(
        "decision.reproducible",
        "This verifier reached the same verdict independently",
        "re-evaluating the authority in this pack does not reproduce the recorded verdict",
        pack.decision.verdict,
        reassessment.verdict,
      ),
    );
  }

  const revocationSigner = findTrustRoot(trustRoots, pack.revocation.proof.verificationMethod);
  if (!revocationSigner) {
    checks.push(
      fail(
        "revocation.snapshot",
        "The revocation snapshot is signed",
        `no public key is known for ${pack.revocation.proof.verificationMethod}`,
      ),
    );
  } else {
    const outcome = await verifyAgainstTrustRoot(
      withoutProof(pack.revocation),
      pack.revocation.proof,
      revocationSigner,
    );
    checks.push(
      outcome.valid
        ? pass(
            "revocation.snapshot",
            "The revocation snapshot is signed",
            `published by ${revocationSigner.subject}, current as of ${pack.revocation.asOf}`,
          )
        : fail(
            "revocation.snapshot",
            "The revocation snapshot is signed",
            outcome.reason ?? "the revocation snapshot signature is invalid",
          ),
    );
  }

  checks.push(...(await verifyLedgerSegment(pack.ledger.entries, pack.ledger.head, trustRoots)));

  const limitations = [
    `Revocation is verified against the signed snapshot published at ${pack.revocation.asOf}. This verifier is offline and cannot know whether a mandate was revoked after that moment.`,
    "Whether the request nonce had been seen before is decided by the gate at the moment of the action. It cannot be recomputed from the pack, so the recorded replay status is the gate's claim reproduced, not an independent finding — and it is only as strong as the scope of the nonce store that gate was using.",
    "The ledger is hash-chained and its head is signed, which detects alteration by a third party. It is not anchored to an external transparency log, so it does not detect the issuing organisation rewriting its own history from the genesis entry.",
  ];

  if (trustRootSource === "embedded") {
    limitations.unshift(
      "Signing keys were read from the pack itself. That proves the pack is internally consistent, not that it came from the organisation it names. Supply that organisation's published keys to make this check meaningful.",
    );
  }

  const authority: AuthorityFinding = {
    verdict: pack.decision.verdict,
    reproduced: reassessment.verdict === pack.decision.verdict,
    reason: reassessment.reason,
    checks: reassessment.checks.filter((check) => !AUTHENTICITY_CHECKS.has(check.id)),
  };

  return report(checks, verifiedAt, trustRootSource, authority, limitations, {
    packId: pack.packId,
    headline: pack.summary.headline,
    authorisedBy: pack.summary.authorisedBy,
    performedBy: pack.summary.performedBy,
    verdict: pack.decision.verdict,
    occurredAt: pack.summary.occurredAt,
    packDigest: pack.integrity.packDigest,
  });
}
