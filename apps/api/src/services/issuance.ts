import {
  DelegationError,
  delegateMandate,
  digestOf,
  issueRootMandate,
  narrows,
  resolveDelta,
} from "@warrant/core";
import type { LegalPerson, Mandate, Scope, ScopeDelta } from "@warrant/core";
import { notFound, unprocessable } from "../http/errors.js";
import { subjectAgentFor } from "./agents.js";
import { DEMONSTRATION_KEYRING } from "./keyring.js";
import type { Keyring } from "./keyring.js";
import type { Repositories, TenantScope } from "../persistence/types.js";
import {
  apAgent,
  identifier,
  nowIso,
  organisation,
  paymentAgent,
  priyaSharma,
  signerForKeyId,
} from "../warrant/context.js";

export interface Actor {
  organisation: Mandate["organisation"];
  liablePrincipal: LegalPerson;
  scope: TenantScope;
  /**
   * The keys this organisation signs with. Carried on the actor because the actor is already
   * threaded through every write path, so there is no route by which a decision gets recorded
   * without the caller having said, explicitly, whose keys it is being recorded under.
   */
  keyring: Keyring;
}

export const DEMONSTRATION_ACTOR: Actor = {
  organisation,
  liablePrincipal: priyaSharma,
  scope: null,
  keyring: DEMONSTRATION_KEYRING,
};

export interface AccountablePersonInput {
  accountId: string;
  issuer: string;
  subject: string;
  email?: string;
  role: string;
  organisationName: string;
  at: string;
  /** The organisation's own principal key, so the person is named against the key that signs for them. */
  keyId: string;
}

export function accountablePerson(input: AccountablePersonInput): LegalPerson {
  const identified = Boolean(input.email);

  return {
    kind: "legal_person",
    id: `person:${input.accountId}`,
    name: input.email ?? input.subject,
    role: input.role,
    legalEntity: input.organisationName,
    identifier: identified ? `mailto:${input.email}` : `oidc:${input.issuer}#${input.subject}`,
    keyId: input.keyId,
    assurance: {
      identity: "authenticated",
      keyCustody: "service",
      method: identified
        ? "OpenID Connect, email claim from the identity provider"
        : "OpenID Connect, subject claim from the identity provider",
      assertedBy: input.issuer,
      assertedAt: input.at,
    },
  };
}

// The ceiling is enforced with `narrows`, the same function that refuses a widening delegation.
// A root mandate is simply given a parent it cannot exceed; no second comparison exists to drift.
async function assertInsideHouseScope(
  scope: Scope,
  repositories: Repositories,
  organisationId: string,
): Promise<void> {
  const ceiling = await repositories.directory.houseScope(organisationId);
  if (!ceiling) return;

  const violations = narrows(scope, ceiling);
  if (violations.length > 0) {
    throw unprocessable(
      "outside_house_scope",
      "this organisation set a ceiling above its mandates, and this one would exceed it",
      violations,
    );
  }
}

async function record(mandate: Mandate, repositories: Repositories): Promise<void> {
  await repositories.mandates.save(mandate);
  await repositories.ledger.append({
    type: "mandate.issued",
    recordedAt: mandate.issuedAt,
    ref: mandate.id,
    payloadDigest: await digestOf(mandate),
  });
}

export interface IssueRootInput {
  scope: Scope;
  notBefore: string;
  expiresAt: string;
  maxDelegationDepth: number;
  agentId?: string;
}

export async function issueRoot(
  input: IssueRootInput,
  repositories: Repositories,
  actor: Actor = DEMONSTRATION_ACTOR,
): Promise<Mandate> {
  const subject = input.agentId
    ? await subjectAgentFor(repositories, input.agentId, actor.scope)
    : apAgent;

  await assertInsideHouseScope(input.scope, repositories, actor.organisation.id);

  let mandate: Mandate;
  try {
    mandate = await issueRootMandate(
      {
        id: identifier("mnd"),
        organisation: actor.organisation,
        liablePrincipal: actor.liablePrincipal,
        subject,
        scope: input.scope,
        maxDelegationDepth: input.maxDelegationDepth,
        notBefore: input.notBefore,
        expiresAt: input.expiresAt,
        issuedAt: nowIso(),
      },
      actor.keyring.principal,
    );
  } catch (error) {
    throw unprocessable("mandate_rejected", (error as Error).message);
  }

  await record(mandate, repositories);
  return mandate;
}

export interface DelegateInput {
  scopeDelta: ScopeDelta;
  notBefore?: string;
  expiresAt?: string;
  agentId?: string;
}

export async function delegate(
  parentId: string,
  input: DelegateInput,
  repositories: Repositories,
  actor: Actor = DEMONSTRATION_ACTOR,
): Promise<Mandate> {
  const parent = await repositories.mandates.findById(parentId, actor.scope);
  if (!parent) throw notFound(`no mandate with id ${parentId}`);

  const signer = signerForKeyId(parent.subject.keyId);
  if (!signer) {
    throw unprocessable(
      "holder_key_unavailable",
      `this deployment holds no signing key for ${parent.subject.name}, so it cannot delegate on its behalf`,
    );
  }

  const subject = input.agentId
    ? await subjectAgentFor(repositories, input.agentId, actor.scope)
    : paymentAgent;

  // A delegation issued today answers to today's ceiling, not the one in force when its parent
  // was signed. The resolved scope is what the child would actually carry.
  await assertInsideHouseScope(
    resolveDelta(input.scopeDelta, parent.scope),
    repositories,
    parent.organisation.id,
  );

  let mandate: Mandate;
  try {
    mandate = await delegateMandate(
      {
        id: identifier("mnd"),
        parent,
        subject,
        scopeDelta: input.scopeDelta,
        notBefore: input.notBefore ?? parent.notBefore,
        expiresAt: input.expiresAt ?? parent.expiresAt,
        issuedAt: nowIso(),
      },
      signer,
    );
  } catch (error) {
    if (error instanceof DelegationError) {
      throw unprocessable(
        "delegation_would_widen",
        "a delegated mandate may only narrow the authority it derives from",
        error.violations,
      );
    }
    throw unprocessable("mandate_rejected", (error as Error).message);
  }

  await record(mandate, repositories);
  return mandate;
}

export interface ReissueInput extends IssueRootInput {
  reason: string;
}

/**
 * Issues a mandate in place of another, and withdraws the one it replaces.
 *
 * The two halves are deliberately separate facts. The successor carries `supersedes`, which is
 * lineage and nothing else; the predecessor stops working because it is **revoked**, which is what
 * has always stopped a mandate working and what every verifier already checks in the signed
 * revocation snapshot.
 *
 * Keeping them apart is the whole compatibility argument (**D59**): a verifier that has never heard
 * of supersession still refuses the old mandate, because it was told about the revocation rather
 * than being expected to infer it from a field it cannot read.
 *
 * **Issue first, then revoke.** If the issue fails there is no gap; the old mandate is still good.
 * The other order would leave an organisation briefly holding no valid authority at all.
 */
export async function reissue(
  previousId: string,
  input: ReissueInput,
  repositories: Repositories,
  actor: Actor = DEMONSTRATION_ACTOR,
): Promise<{ mandate: Mandate; superseded: string }> {
  const previous = await repositories.mandates.findById(previousId, actor.scope);
  if (!previous) throw notFound(`no mandate with id ${previousId}`);

  // Root-only, and not arbitrarily: a root mandate is signed by the liable principal, whose key this
  // service holds. A delegation is signed by the agent holding it, whose key it generally does not —
  // which is the same reason `delegate` refuses when it has no signer for the holder.
  if (previous.depth !== 0) {
    throw unprocessable(
      "reissue_needs_a_root",
      `mandate ${previousId} is a delegation at depth ${previous.depth}; delegate again from its parent instead, which the holder's own key must sign`,
    );
  }

  const subject = input.agentId
    ? await subjectAgentFor(repositories, input.agentId, actor.scope)
    : apAgent;

  await assertInsideHouseScope(input.scope, repositories, actor.organisation.id);

  let mandate: Mandate;
  try {
    mandate = await issueRootMandate(
      {
        id: identifier("mnd"),
        organisation: actor.organisation,
        liablePrincipal: actor.liablePrincipal,
        subject,
        scope: input.scope,
        maxDelegationDepth: input.maxDelegationDepth,
        notBefore: input.notBefore,
        expiresAt: input.expiresAt,
        issuedAt: nowIso(),
        supersedes: previous,
      },
      actor.keyring.principal,
    );
  } catch (error) {
    throw unprocessable("mandate_rejected", (error as Error).message);
  }

  await record(mandate, repositories);
  await revoke(previousId, input.reason, repositories, actor);

  return { mandate, superseded: previousId };
}

export async function revoke(
  mandateId: string,
  reason: string,
  repositories: Repositories,
  actor: Actor = DEMONSTRATION_ACTOR,
): Promise<void> {
  const mandate = await repositories.mandates.findById(mandateId, actor.scope);
  if (!mandate) throw notFound(`no mandate with id ${mandateId}`);

  const revokedAt = nowIso();
  const applied = await repositories.mandates.revoke({ mandateId, revokedAt, reason }, actor.scope);
  if (!applied) {
    throw unprocessable("already_revoked", `mandate ${mandateId} was already withdrawn`);
  }

  await repositories.ledger.append({
    type: "mandate.revoked",
    recordedAt: revokedAt,
    ref: mandateId,
    payloadDigest: await digestOf({ mandateId, revokedAt, reason }),
  });
}
