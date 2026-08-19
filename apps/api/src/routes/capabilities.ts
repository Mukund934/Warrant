import { Router } from "express";
import { moneySchema } from "@warrant/core";
import { z } from "zod";
import { assertRole, scopeOf } from "../auth/tenancy.js";
import { badRequest, notFound } from "../http/errors.js";
import { parseBody } from "../http/validate.js";
import type { Repositories } from "../persistence/types.js";
import {
  changeCapabilityStatus,
  registerCapability,
  setCatalogueEnforcement,
} from "../services/capabilities.js";

// Strict, for the reason D42 records: a security input that is silently dropped is indistinguishable
// from one that was applied.
const registerSchema = z
  .object({
    id: z.string().min(3).max(120),
    title: z.string().min(2).max(120),
    description: z.string().min(2).max(480),
    risk: z.enum(["low", "medium", "high", "critical"]),
    amount: z.enum(["required", "optional", "forbidden"]),
    currencies: z.array(z.enum(["INR", "USD", "EUR"])).min(1).optional(),
    approvalAbove: moneySchema.optional(),
  })
  .strict();

const statusSchema = z.object({ status: z.enum(["active", "deprecated", "withdrawn"]) }).strict();

const enforcementSchema = z.object({ enforcement: z.enum(["advisory", "required"]) }).strict();

export function capabilityRoutes(repositories: Repositories): Router {
  const router = Router();

  const organisationOf = (organisationId: string | undefined): string => {
    if (!organisationId) {
      throw badRequest(
        "no_organisation",
        "a catalogue belongs to an organisation, so reading or changing one needs an authenticated caller in one",
      );
    }
    return organisationId;
  };

  router.post("/capabilities", async (request, response) => {
    assertRole(request, "admin");
    const body = parseBody(registerSchema, request.body);
    const organisationId = organisationOf(request.tenant?.organisationId);

    response.status(201).json(await registerCapability(body, repositories, organisationId));
  });

  router.get("/capabilities", async (request, response) => {
    response.json(await repositories.capabilities.list(scopeOf(request)));
  });

  router.post("/capabilities/enforcement", async (request, response) => {
    assertRole(request, "admin");
    const body = parseBody(enforcementSchema, request.body);
    const organisationId = organisationOf(request.tenant?.organisationId);

    response.json(await setCatalogueEnforcement(body.enforcement, repositories, organisationId));
  });

  router.get("/capabilities/enforcement", async (request, response) => {
    response.json(await repositories.capabilities.catalogue(organisationOf(request.tenant?.organisationId)));
  });

  router.get("/capabilities/:id", async (request, response) => {
    const organisationId = organisationOf(request.tenant?.organisationId);
    const capability = await repositories.capabilities.find(request.params.id, organisationId);
    if (!capability) throw notFound(`no capability ${request.params.id} in this organisation's catalogue`);

    response.json(capability);
  });

  router.post("/capabilities/:id/status", async (request, response) => {
    assertRole(request, "admin");
    const body = parseBody(statusSchema, request.body);
    const organisationId = organisationOf(request.tenant?.organisationId);

    response.json(
      await changeCapabilityStatus(request.params.id, body.status, repositories, organisationId),
    );
  });

  return router;
}
