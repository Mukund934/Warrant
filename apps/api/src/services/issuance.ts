import { DelegationError, delegateMandate, digestOf, issueRootMandate } from "@warrant/core";
import type { LegalPerson, Mandate, Scope, ScopeDelta } from "@warrant/core";
import { notFound, unprocessable } from "../http/errors.js";
import { subjectAgentFor } from "./agents.js";
import type { Repositories, TenantScope } from "../persistence/types.js";
import {
  apAgent,
  identifier,
  nowIso,
  organisation,
  paymentAgent,
  principalSigner,
  priyaSharma,
  signerForKeyId,
} from "../warrant/context.js";

export interface Actor {
  organisation: Mandate["organisation"];
  liablePrincipal: LegalPerson;
  scope: TenantScope;
}

export const DEMONSTRATION_ACTOR: Actor = {
  organisation,
  liablePrincipal: priyaSharma,
  scope: null,
};

export interface AccountablePersonInput {
  accountId: string;
  issuer: string;
  subject: string;
  email?: string;
  role: string;
  organisationName: string;
  at: string;
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
    keyId: principalSigner.keyId,
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
      principalSigner,
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
