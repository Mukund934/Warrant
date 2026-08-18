import { DelegationError, delegateMandate, digestOf, issueRootMandate } from "@warrant/core";
import type { Mandate, Scope, ScopeDelta } from "@warrant/core";
import { notFound, unprocessable } from "../http/errors.js";
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
  scope: TenantScope;
}

export const DEMONSTRATION_ACTOR: Actor = { organisation, scope: null };

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
}

export async function issueRoot(
  input: IssueRootInput,
  repositories: Repositories,
  actor: Actor = DEMONSTRATION_ACTOR,
): Promise<Mandate> {
  let mandate: Mandate;
  try {
    mandate = await issueRootMandate(
      {
        id: identifier("mnd"),
        organisation: actor.organisation,
        liablePrincipal: priyaSharma,
        subject: apAgent,
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

  let mandate: Mandate;
  try {
    mandate = await delegateMandate(
      {
        id: identifier("mnd"),
        parent,
        subject: paymentAgent,
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
