import { digestOf, withoutProof } from "./canonical.js";
import { narrows, resolveDelta } from "./scope.js";
import type { ScopeViolation } from "./scope.js";
import { signDetached } from "./sign.js";
import type { SignerIdentity } from "./sign.js";
import { MANDATE_VERSION, WarrantError, mandateSchema } from "./types.js";
import type { Agent, LegalPerson, Mandate, Scope, ScopeDelta, UnsignedMandate } from "./types.js";

export class DelegationError extends WarrantError {
  readonly violations: ScopeViolation[];

  constructor(message: string, violations: ScopeViolation[]) {
    super("mandate/escalation", message);
    this.name = "DelegationError";
    this.violations = violations;
  }
}

export async function mandateDigest(mandate: Mandate): Promise<string> {
  return digestOf(mandate);
}

export interface RootMandateInput {
  id: string;
  organisation: Mandate["organisation"];
  liablePrincipal: LegalPerson;
  subject: Agent;
  scope: Scope;
  maxDelegationDepth: number;
  notBefore: string;
  expiresAt: string;
  issuedAt: string;
}

export async function issueRootMandate(
  input: RootMandateInput,
  signer: SignerIdentity,
): Promise<Mandate> {
  if (input.scope.actions.length === 0 || input.scope.audience.length === 0) {
    throw new WarrantError(
      "mandate/empty_scope",
      "a root mandate must name at least one action and one resource",
    );
  }
  if (new Date(input.expiresAt) <= new Date(input.notBefore)) {
    throw new WarrantError("mandate/invalid_window", "a mandate must expire after it becomes valid");
  }
  if (signer.keyId !== input.liablePrincipal.keyId) {
    throw new WarrantError(
      "mandate/issuer_key_mismatch",
      "a root mandate must be signed by the key of the liable principal issuing it",
    );
  }

  const unsigned: UnsignedMandate = {
    version: MANDATE_VERSION,
    id: input.id,
    organisation: input.organisation,
    liablePrincipal: input.liablePrincipal,
    issuer: input.liablePrincipal,
    subject: input.subject,
    parent: null,
    depth: 0,
    maxDelegationDepth: input.maxDelegationDepth,
    scope: input.scope,
    notBefore: input.notBefore,
    expiresAt: input.expiresAt,
    issuedAt: input.issuedAt,
  };

  const proof = await signDetached(unsigned, signer, input.issuedAt);
  return { ...unsigned, proof };
}

export interface DelegationInput {
  id: string;
  parent: Mandate;
  subject: Agent;
  scopeDelta: ScopeDelta;
  notBefore: string;
  expiresAt: string;
  issuedAt: string;
}

export interface DelegationOptions {
  enforceNarrowing?: boolean;
}

export async function delegateMandate(
  input: DelegationInput,
  signer: SignerIdentity,
  options: DelegationOptions = {},
): Promise<Mandate> {
  const enforceNarrowing = options.enforceNarrowing !== false;
  const parent = input.parent;

  if (signer.keyId !== parent.subject.keyId) {
    throw new WarrantError(
      "mandate/issuer_key_mismatch",
      "only the holder of a mandate may delegate from it",
    );
  }

  const scope = resolveDelta(input.scopeDelta, parent.scope);
  const violations = narrows(scope, parent.scope);

  if (parent.depth + 1 > parent.maxDelegationDepth) {
    violations.push({
      code: "scope/delegation_depth_exceeded",
      message: "the issuing mandate does not permit delegation at this depth",
      parentValue: `max depth ${parent.maxDelegationDepth}`,
      childValue: `depth ${parent.depth + 1}`,
    });
  }
  if (new Date(input.notBefore) < new Date(parent.notBefore)) {
    violations.push({
      code: "scope/validity_starts_earlier",
      message: "a delegated mandate may not become valid before the mandate it derives from",
      parentValue: parent.notBefore,
      childValue: input.notBefore,
    });
  }
  if (new Date(input.expiresAt) > new Date(parent.expiresAt)) {
    violations.push({
      code: "scope/validity_outlives_parent",
      message: "a delegated mandate may not outlive the mandate it derives from",
      parentValue: parent.expiresAt,
      childValue: input.expiresAt,
    });
  }

  if (enforceNarrowing && violations.length > 0) {
    throw new DelegationError(
      "the requested delegation would widen the authority it derives from",
      violations,
    );
  }

  const unsigned: UnsignedMandate = {
    version: MANDATE_VERSION,
    id: input.id,
    organisation: parent.organisation,
    liablePrincipal: parent.liablePrincipal,
    issuer: parent.subject,
    subject: input.subject,
    parent: { id: parent.id, digest: await mandateDigest(parent) },
    depth: parent.depth + 1,
    maxDelegationDepth: parent.maxDelegationDepth,
    scope,
    notBefore: input.notBefore,
    expiresAt: input.expiresAt,
    issuedAt: input.issuedAt,
  };

  const proof = await signDetached(unsigned, signer, input.issuedAt);
  return { ...unsigned, proof };
}

export function parseMandate(raw: unknown): Mandate {
  const outcome = mandateSchema.safeParse(raw);
  if (!outcome.success) {
    const first = outcome.error.issues[0];
    throw new WarrantError(
      "mandate/malformed",
      first ? `${first.path.join(".") || "mandate"}: ${first.message}` : "mandate is malformed",
    );
  }
  return raw as Mandate;
}

export function unsignedPartOf(mandate: Mandate): UnsignedMandate {
  return withoutProof(mandate);
}
