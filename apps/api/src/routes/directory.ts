import { Router } from "express";
import { z } from "zod";
import { badRequest, notFound, unprocessable } from "../http/errors.js";
import { parseBody } from "../http/validate.js";
import { accountIdFor, assertRole, organisationIdFor } from "../auth/tenancy.js";
import type { Repositories } from "../persistence/types.js";

const createOrganisationSchema = z.object({
  name: z.string().min(2).max(120),
  jurisdiction: z.string().min(2).max(40),
});

const grantSchema = z.object({
  subject: z.string().min(1).max(200),
  email: z.string().email().optional(),
  role: z.enum(["owner", "admin", "member", "auditor"]),
});

export function directoryRoutes(repositories: Repositories): Router {
  const router = Router();

  router.post("/organisations", async (request, response) => {
    const body = parseBody(createOrganisationSchema, request.body);
    const account = request.account;
    if (!account) {
      throw badRequest(
        "anonymous_organisation",
        "an organisation needs an accountable owner, so this endpoint needs an authenticated caller",
      );
    }

    const organisation = {
      id: organisationIdFor(body.name),
      name: body.name,
      jurisdiction: body.jurisdiction,
    };

    const created = await repositories.directory.createOrganisation(organisation);
    if (!created) {
      throw unprocessable(
        "organisation_exists",
        `an organisation named ${body.name} is already recorded`,
      );
    }

    await repositories.directory.grant({
      organisationId: organisation.id,
      accountId: account.id,
      role: "owner",
    });

    response.status(201).json({ ...organisation, role: "owner" });
  });

  router.get("/organisations", async (request, response) => {
    const account = request.account;
    if (!account) {
      response.json([]);
      return;
    }

    const memberships = await repositories.directory.membershipsFor(account.id);
    const organisations = await Promise.all(
      memberships.map(async (membership) => {
        const organisation = await repositories.directory.findOrganisation(
          membership.organisationId,
        );
        return organisation ? { ...organisation, role: membership.role } : undefined;
      }),
    );

    response.json(organisations.filter(Boolean));
  });

  router.get("/organisations/:id/members", async (request, response) => {
    if (request.tenant && request.tenant.organisationId !== request.params.id) {
      throw notFound(`no organisation with id ${request.params.id}`);
    }
    response.json(await repositories.directory.members(request.params.id));
  });

  router.post("/organisations/:id/members", async (request, response) => {
    assertRole(request, "admin");
    const body = parseBody(grantSchema, request.body);
    const tenant = request.tenant;
    if (tenant && tenant.organisationId !== request.params.id) {
      throw notFound(`no organisation with id ${request.params.id}`);
    }

    const organisation = await repositories.directory.findOrganisation(request.params.id);
    if (!organisation) throw notFound(`no organisation with id ${request.params.id}`);

    const issuer = request.principal?.issuer;
    if (!issuer) {
      throw badRequest(
        "anonymous_grant",
        "membership is granted to an identity from the configured provider, so this needs an authenticated caller",
      );
    }

    const account = await repositories.directory.rememberAccount({
      id: accountIdFor(issuer, body.subject),
      issuer,
      subject: body.subject,
      ...(body.email ? { email: body.email } : {}),
    });

    await repositories.directory.grant({
      organisationId: organisation.id,
      accountId: account.id,
      role: body.role,
    });

    response.status(201).json({
      organisationId: organisation.id,
      accountId: account.id,
      role: body.role,
    });
  });

  router.post("/organisations/:id/members/:accountId/withdrawal", async (request, response) => {
    assertRole(request, "admin");
    const tenant = request.tenant;
    if (tenant && tenant.organisationId !== request.params.id) {
      throw notFound(`no organisation with id ${request.params.id}`);
    }
    if (tenant && tenant.accountId === request.params.accountId) {
      throw unprocessable(
        "last_owner",
        "an account cannot withdraw its own membership; ask another owner or admin",
      );
    }

    const removed = await repositories.directory.withdraw(
      request.params.id,
      request.params.accountId,
    );
    if (!removed) throw notFound(`no membership for ${request.params.accountId}`);

    response.status(204).end();
  });

  return router;
}
