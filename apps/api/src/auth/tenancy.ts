import { createHash } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { HttpError } from "../http/errors.js";
import type {
  Account,
  MembershipRole,
  Repositories,
  TenantScope,
} from "../persistence/types.js";
import { DEMONSTRATION_ACTOR, accountablePerson } from "../services/issuance.js";
import type { Actor } from "../services/issuance.js";
import { DEMONSTRATION_KEYRING, keyringFor } from "../services/keyring.js";
import { nowIso } from "../warrant/context.js";

export interface Tenant {
  accountId: string;
  organisationId: string;
  role: MembershipRole;
}

declare module "express-serve-static-core" {
  interface Request {
    tenant?: Tenant;
    account?: Account;
  }
}

export const ORGANISATION_HEADER = "x-warrant-organisation";

const RANK: Record<MembershipRole, number> = { auditor: 0, member: 1, admin: 2, owner: 3 };

export function accountIdFor(issuer: string, subject: string): string {
  const digest = createHash("sha256").update(`${issuer}\n${subject}`).digest("hex");
  return `acct_${digest.slice(0, 24)}`;
}

export function organisationIdFor(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const salt = createHash("sha256").update(name).digest("hex").slice(0, 8);
  return `org:${slug || "organisation"}-${salt}`;
}

export function scopeOf(request: Request): TenantScope {
  return request.tenant ? request.tenant.organisationId : null;
}

export function resolveTenant(repositories: Repositories): RequestHandler {
  return async (request: Request, _response: Response, next: NextFunction) => {
    const principal = request.principal;
    if (!principal) {
      next();
      return;
    }

    try {
      const account = await repositories.directory.rememberAccount({
        id: accountIdFor(principal.issuer, principal.subject),
        issuer: principal.issuer,
        subject: principal.subject,
        ...(principal.email ? { email: principal.email } : {}),
      });

      request.account = account;
      const memberships = await repositories.directory.membershipsFor(account.id);
      const requested = request.header(ORGANISATION_HEADER);

      if (requested) {
        const chosen = memberships.find((row) => row.organisationId === requested);
        if (!chosen) {
          next(
            new HttpError(
              403,
              "not_a_member",
              `this account is not a member of ${requested}`,
            ),
          );
          return;
        }
        request.tenant = {
          accountId: account.id,
          organisationId: chosen.organisationId,
          role: chosen.role,
        };
        next();
        return;
      }

      if (memberships.length === 1) {
        const only = memberships[0]!;
        request.tenant = {
          accountId: account.id,
          organisationId: only.organisationId,
          role: only.role,
        };
      } else if (memberships.length > 1) {
        next(
          new HttpError(
            400,
            "organisation_ambiguous",
            `this account belongs to ${memberships.length} organisations; name one with the ${ORGANISATION_HEADER} header`,
          ),
        );
        return;
      }

      next();
    } catch (error) {
      next(error);
    }
  };
}

export function requireTenant(): RequestHandler {
  return (request: Request, _response: Response, next: NextFunction) => {
    if (!request.principal || request.tenant) {
      next();
      return;
    }

    next(
      new HttpError(
        403,
        "no_organisation",
        "this account belongs to no organisation yet; create one before recording authority under it",
      ),
    );
  };
}

export function requireRole(minimum: MembershipRole): RequestHandler {
  return (request: Request, _response: Response, next: NextFunction) => {
    const tenant = request.tenant;
    if (!tenant) {
      next();
      return;
    }

    if (RANK[tenant.role] < RANK[minimum]) {
      next(
        new HttpError(
          403,
          "insufficient_role",
          `this action needs ${minimum} in ${tenant.organisationId}; this account is ${tenant.role}`,
        ),
      );
      return;
    }

    next();
  };
}

export async function actorFor(request: Request, repositories: Repositories): Promise<Actor> {
  const tenant = request.tenant;
  const principal = request.principal;
  if (!tenant || !principal) return DEMONSTRATION_ACTOR;

  const organisation = await repositories.directory.findOrganisation(tenant.organisationId);
  if (!organisation) {
    throw new HttpError(
      404,
      "organisation_missing",
      `membership names ${tenant.organisationId}, but no such organisation is recorded`,
    );
  }

  // An organisation recorded before Phase 9 has no keyring and keeps signing with the shared
  // demonstration keys, exactly as it always did. That fallback is what makes this change additive:
  // nothing already recorded moves, and no backfill is needed.
  const keyring = (await keyringFor(repositories, organisation)) ?? DEMONSTRATION_KEYRING;

  return {
    organisation,
    liablePrincipal: accountablePerson({
      accountId: tenant.accountId,
      issuer: principal.issuer,
      subject: principal.subject,
      ...(principal.email ? { email: principal.email } : {}),
      role: tenant.role,
      organisationName: organisation.name,
      at: nowIso(),
      keyId: keyring.principal.keyId,
    }),
    scope: organisation.id,
    keyring,
  };
}

export function writesNeed(minimum: MembershipRole): RequestHandler {
  const guard = requireRole(minimum);
  return (request: Request, response: Response, next: NextFunction) => {
    if (request.method === "GET" || request.method === "OPTIONS") {
      next();
      return;
    }
    guard(request, response, next);
  };
}

export function assertRole(request: Request, minimum: MembershipRole): void {
  const tenant = request.tenant;
  if (!tenant) return;

  if (RANK[tenant.role] < RANK[minimum]) {
    throw new HttpError(
      403,
      "insufficient_role",
      `this action needs ${minimum} in ${tenant.organisationId}; this account is ${tenant.role}`,
    );
  }
}
