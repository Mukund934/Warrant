import { Router } from "express";
import { z } from "zod";
import { badRequest, notFound } from "../http/errors.js";
import { parseBody } from "../http/validate.js";
import { assertRole, scopeOf } from "../auth/tenancy.js";
import type { Repositories } from "../persistence/types.js";
import { changeAgentStatus, registerAgent, rotateAgentKey } from "../services/agents.js";

const registerSchema = z.object({
  name: z.string().min(2).max(120),
  runtime: z.string().min(2).max(120),
  publicKeyJwk: z.record(z.string(), z.unknown()),
});

const statusSchema = z.object({
  status: z.enum(["registered", "active", "suspended", "revoked", "archived"]),
  reason: z.string().min(1).max(240).optional(),
});

const rotationSchema = z.object({
  publicKeyJwk: z.record(z.string(), z.unknown()),
});

export function agentRoutes(repositories: Repositories): Router {
  const router = Router();

  router.post("/agents", async (request, response) => {
    assertRole(request, "admin");
    const body = parseBody(registerSchema, request.body);

    const organisationId = request.tenant?.organisationId;
    if (!organisationId) {
      throw badRequest(
        "no_organisation",
        "an agent belongs to an organisation, so registering one needs an authenticated caller in one",
      );
    }

    const agent = await registerAgent(body, repositories, organisationId);
    response.status(201).json(agent);
  });

  router.get("/agents", async (request, response) => {
    response.json(await repositories.agents.list(scopeOf(request)));
  });

  router.get("/agents/:id", async (request, response) => {
    const agent = await repositories.agents.findById(request.params.id, scopeOf(request));
    if (!agent) throw notFound(`no agent with id ${request.params.id}`);

    const key = await repositories.agents.currentKey(agent.id);
    response.json({ ...agent, ...(key ? { keyId: key.keyId } : {}) });
  });

  router.post("/agents/:id/status", async (request, response) => {
    assertRole(request, "admin");
    const body = parseBody(statusSchema, request.body);

    const agent = await changeAgentStatus(
      request.params.id,
      body.status,
      body.reason,
      repositories,
      scopeOf(request),
    );
    response.status(200).json(agent);
  });

  router.post("/agents/:id/key-rotation", async (request, response) => {
    assertRole(request, "admin");
    const body = parseBody(rotationSchema, request.body);

    const key = await rotateAgentKey(
      request.params.id,
      body.publicKeyJwk,
      repositories,
      scopeOf(request),
    );
    response.status(201).json({ agentId: key.agentId, keyId: key.keyId, signingFrom: key.signingFrom });
  });

  return router;
}
