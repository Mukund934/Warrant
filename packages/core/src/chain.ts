import { narrows } from "./scope.js";
import { effectiveScope } from "./scope.js";
import { mandateDigest, unsignedPartOf } from "./mandate.js";
import { verifyDetached } from "./sign.js";
import type { ProofVerification } from "./sign.js";
import type { Check, Mandate, Proof, RevocationSnapshot, Scope, TrustRoot } from "./types.js";

export interface ChainContext {
  trustRoots: TrustRoot[];
  now: string;
  revocation: RevocationSnapshot;
}

export interface ChainReport {
  checks: Check[];
  effectiveScope: Scope | null;
  sound: boolean;
}

function pass(id: string, title: string, detail: string): Check {
  return { id, title, status: "pass", detail };
}

function fail(id: string, title: string, detail: string, expected?: string, observed?: string): Check {
  const check: Check = { id, title, status: "fail", detail };
  if (expected !== undefined) check.expected = expected;
  if (observed !== undefined) check.observed = observed;
  return check;
}

export function findTrustRoot(trustRoots: TrustRoot[], keyId: string): TrustRoot | undefined {
  return trustRoots.find((root) => root.keyId === keyId);
}

export function keyLifecycleFault(root: TrustRoot, signedAt: string): string | undefined {
  const signed = new Date(signedAt).getTime();
  if (!Number.isFinite(signed)) {
    return `the proof from ${root.keyId} carries a creation time that cannot be read as a date`;
  }
  if (root.signingFrom && signed < new Date(root.signingFrom).getTime()) {
    return `${root.keyId} was published but not yet in use when this was signed; it became a signing key at ${root.signingFrom}`;
  }
  if (root.signingUntil && signed > new Date(root.signingUntil).getTime()) {
    return `${root.keyId} had already been retired when this was signed; it stopped being a signing key at ${root.signingUntil}`;
  }
  return undefined;
}

export async function verifyAgainstTrustRoot(
  document: unknown,
  proof: Proof,
  root: TrustRoot,
): Promise<ProofVerification> {
  const fault = keyLifecycleFault(root, proof.created);
  if (fault) return { valid: false, reason: fault };
  return verifyDetached(document, proof, root.publicKeyJwk);
}

export async function validateChain(chain: Mandate[], context: ChainContext): Promise<ChainReport> {
  const checks: Check[] = [];
  const root = chain[0];
  const leaf = chain[chain.length - 1];

  if (!root || !leaf) {
    return {
      checks: [fail("chain.present", "Authority chain present", "no mandate was presented with this action")],
      effectiveScope: null,
      sound: false,
    };
  }

  if (root.depth !== 0 || root.parent !== null) {
    checks.push(
      fail(
        "chain.rooted",
        "Chain begins at a root mandate",
        "the first mandate in the chain is itself derived from another mandate that was not supplied",
        "depth 0 with no parent",
        `depth ${root.depth}`,
      ),
    );
  } else {
    checks.push(
      pass(
        "chain.rooted",
        "Chain begins at a root mandate",
        `issued directly by ${root.liablePrincipal.name}, ${root.liablePrincipal.role}`,
      ),
    );
  }

  let structureSound = true;
  for (let index = 1; index < chain.length; index += 1) {
    const child = chain[index];
    const parent = chain[index - 1];
    if (!child || !parent) continue;
    if (child.depth !== parent.depth + 1 || child.parent?.id !== parent.id) {
      structureSound = false;
      checks.push(
        fail(
          "chain.sequence",
          "Chain hops are contiguous",
          `mandate ${child.id} does not follow ${parent.id}`,
          `parent ${parent.id} at depth ${parent.depth + 1}`,
          `parent ${child.parent?.id ?? "none"} at depth ${child.depth}`,
        ),
      );
    }
  }
  if (structureSound && chain.length > 1) {
    checks.push(pass("chain.sequence", "Chain hops are contiguous", `${chain.length} mandates in sequence`));
  }

  let linkageSound = true;
  for (let index = 1; index < chain.length; index += 1) {
    const child = chain[index];
    const parent = chain[index - 1];
    if (!child || !parent) continue;
    const actual = await mandateDigest(parent);
    if (child.parent?.digest !== actual) {
      linkageSound = false;
      checks.push(
        fail(
          "chain.linkage",
          "Each hop is bound to the exact mandate above it",
          `mandate ${child.id} references a different version of its issuing mandate`,
          actual,
          child.parent?.digest ?? "none",
        ),
      );
    }
  }
  if (linkageSound) {
    checks.push(
      pass(
        "chain.linkage",
        "Each hop is bound to the exact mandate above it",
        chain.length > 1 ? "every parent digest matches the mandate supplied" : "single mandate, no hops to bind",
      ),
    );
  }

  let signaturesSound = true;
  for (const mandate of chain) {
    const trustRoot = findTrustRoot(context.trustRoots, mandate.issuer.keyId);
    if (!trustRoot) {
      signaturesSound = false;
      checks.push(
        fail(
          "chain.signatures",
          "Every mandate is signed by its stated issuer",
          `no public key is known for ${mandate.issuer.name} (${mandate.issuer.keyId})`,
        ),
      );
      continue;
    }
    if (mandate.proof.verificationMethod !== mandate.issuer.keyId) {
      signaturesSound = false;
      checks.push(
        fail(
          "chain.signatures",
          "Every mandate is signed by its stated issuer",
          `mandate ${mandate.id} was signed by a key other than its stated issuer`,
          mandate.issuer.keyId,
          mandate.proof.verificationMethod,
        ),
      );
      continue;
    }
    const outcome = await verifyAgainstTrustRoot(unsignedPartOf(mandate), mandate.proof, trustRoot);
    if (!outcome.valid) {
      signaturesSound = false;
      checks.push(
        fail(
          "chain.signatures",
          "Every mandate is signed by its stated issuer",
          `mandate ${mandate.id}: ${outcome.reason ?? "signature is invalid"}`,
        ),
      );
    }
  }
  if (signaturesSound) {
    checks.push(
      pass(
        "chain.signatures",
        "Every mandate is signed by its stated issuer",
        `${chain.length} signature${chain.length === 1 ? "" : "s"} verified with ES256`,
      ),
    );
  }

  const rootTrust = findTrustRoot(context.trustRoots, root.issuer.keyId);
  if (rootTrust && rootTrust.role === "principal") {
    checks.push(
      pass(
        "chain.root_trusted",
        "Chain terminates in a known legal person",
        `${root.liablePrincipal.name} — ${root.liablePrincipal.legalEntity} (${root.liablePrincipal.identifier})`,
      ),
    );
  } else {
    checks.push(
      fail(
        "chain.root_trusted",
        "Chain terminates in a known legal person",
        "the root issuer is not a trusted principal key",
        "a principal key present in the trust roots",
        rootTrust ? `key with role ${rootTrust.role}` : "unknown key",
      ),
    );
  }

  const inconsistentPrincipal = chain.find(
    (mandate) => mandate.liablePrincipal.id !== root.liablePrincipal.id,
  );
  if (inconsistentPrincipal) {
    checks.push(
      fail(
        "chain.liable_principal",
        "Accountability is not reassigned down the chain",
        `mandate ${inconsistentPrincipal.id} names a different accountable person`,
        root.liablePrincipal.id,
        inconsistentPrincipal.liablePrincipal.id,
      ),
    );
  } else {
    checks.push(
      pass(
        "chain.liable_principal",
        "Accountability is not reassigned down the chain",
        `every hop remains answerable to ${root.liablePrincipal.name}`,
      ),
    );
  }

  let narrowingSound = true;
  for (let index = 1; index < chain.length; index += 1) {
    const child = chain[index];
    const parent = chain[index - 1];
    if (!child || !parent) continue;
    const violations = narrows(child.scope, parent.scope);
    if (new Date(child.notBefore) < new Date(parent.notBefore)) {
      violations.push({
        code: "scope/validity_starts_earlier",
        message: "a delegated mandate may not become valid before the mandate it derives from",
        parentValue: parent.notBefore,
        childValue: child.notBefore,
      });
    }
    if (new Date(child.expiresAt) > new Date(parent.expiresAt)) {
      violations.push({
        code: "scope/validity_outlives_parent",
        message: "a delegated mandate may not outlive the mandate it derives from",
        parentValue: parent.expiresAt,
        childValue: child.expiresAt,
      });
    }
    for (const violation of violations) {
      narrowingSound = false;
      checks.push(
        fail(
          "chain.narrowing",
          "Authority only narrows at each hop",
          `${child.subject.name}: ${violation.message}`,
          violation.parentValue,
          violation.childValue,
        ),
      );
    }
  }
  if (narrowingSound) {
    checks.push(
      pass(
        "chain.narrowing",
        "Authority only narrows at each hop",
        chain.length > 1
          ? `${chain.length - 1} delegation${chain.length === 2 ? "" : "s"} verified against the authority above`
          : "single mandate, no delegation to check",
      ),
    );
  }

  if (leaf.depth > root.maxDelegationDepth) {
    checks.push(
      fail(
        "chain.depth",
        "Delegation depth is within the permitted limit",
        "the chain was delegated further than the root mandate allows",
        `at most ${root.maxDelegationDepth} hop${root.maxDelegationDepth === 1 ? "" : "s"}`,
        `${leaf.depth} hops`,
      ),
    );
  } else {
    checks.push(
      pass(
        "chain.depth",
        "Delegation depth is within the permitted limit",
        `${leaf.depth} of ${root.maxDelegationDepth} permitted hops used`,
      ),
    );
  }

  const now = new Date(context.now);
  const expired = chain.filter((mandate) => new Date(mandate.expiresAt) <= now);
  const notYetValid = chain.filter((mandate) => new Date(mandate.notBefore) > now);
  if (expired.length > 0) {
    const first = expired[0]!;
    checks.push(
      fail(
        "temporal.validity",
        "Every mandate is inside its validity window",
        `mandate held by ${first.subject.name} expired before this action`,
        `valid until ${first.expiresAt}`,
        `action evaluated at ${context.now}`,
      ),
    );
  } else if (notYetValid.length > 0) {
    const first = notYetValid[0]!;
    checks.push(
      fail(
        "temporal.validity",
        "Every mandate is inside its validity window",
        `mandate held by ${first.subject.name} is not yet valid`,
        `valid from ${first.notBefore}`,
        `action evaluated at ${context.now}`,
      ),
    );
  } else {
    checks.push(
      pass(
        "temporal.validity",
        "Every mandate is inside its validity window",
        `evaluated at ${context.now}; earliest expiry ${chain
          .map((mandate) => mandate.expiresAt)
          .sort()[0]}`,
      ),
    );
  }

  const revokedIds = new Set(context.revocation.revoked.map((entry) => entry.mandateId));
  const revoked = chain.find((mandate) => revokedIds.has(mandate.id));
  if (revoked) {
    const record = context.revocation.revoked.find((entry) => entry.mandateId === revoked.id)!;
    checks.push(
      fail(
        "revocation.status",
        "No mandate in the chain has been revoked",
        `mandate held by ${revoked.subject.name} was revoked: ${record.reason}`,
        "not revoked",
        `revoked at ${record.revokedAt}`,
      ),
    );
  } else {
    checks.push(
      pass(
        "revocation.status",
        "No mandate in the chain has been revoked",
        `checked against the revocation state published at ${context.revocation.asOf}`,
      ),
    );
  }

  const sound = checks.every((check) => check.status !== "fail");
  return {
    checks,
    effectiveScope: effectiveScope(chain.map((mandate) => mandate.scope)),
    sound,
  };
}
