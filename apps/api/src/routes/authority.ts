import { Router } from "express";
import { z } from "zod";
import { moneySchema, scopeSchema } from "@warrant/core";
import { actorFor, scopeOf } from "../auth/tenancy.js";
import { notFound } from "../http/errors.js";
import { parseBody } from "../http/validate.js";
import type { Repositories } from "../persistence/types.js";
import { delegate, issueRoot, revoke } from "../services/issuance.js";
import { submitAction, takeCheckpoint } from "../services/execution.js";

const isoDateTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/, "must be an ISO-8601 UTC timestamp");

const issueSchema = z.object({
  scope: scopeSchema,
  notBefore: isoDateTime,
  expiresAt: isoDateTime,
  maxDelegationDepth: z.number().int().min(0).max(8),
  agentId: z.string().min(1).optional(),
});

const delegateSchema = z.object({
  scopeDelta: scopeSchema.partial(),
  notBefore: isoDateTime.optional(),
  expiresAt: isoDateTime.optional(),
  agentId: z.string().min(1).optional(),
});

const revokeSchema = z.object({
  reason: z.string().min(1).max(240),
});

const actionSchema = z.object({
  mandateId: z.string().min(1),
  action: z.string().min(1).max(80),
  resource: z.string().min(1).max(160),
  counterparty: z.string().min(1).max(160),
  description: z.string().min(1).max(240),
  nonce: z.string().min(8).max(120),
  amount: moneySchema.optional(),
});

export function authorityRoutes(repositories: Repositories): Router {
  const router = Router();

  router.post("/mandates", async (request, response) => {
    const body = parseBody(issueSchema, request.body);
    const mandate = await issueRoot(body, repositories, await actorFor(request, repositories));
    response.status(201).json(mandate);
  });

  router.get("/mandates/:id", async (request, response) => {
    const scope = scopeOf(request);
    const mandate = await repositories.mandates.findById(request.params.id, scope);
    if (!mandate) throw notFound(`no mandate with id ${request.params.id}`);
    const chain = await repositories.mandates.findChain(mandate.id, scope);
    response.json({ mandate, chain });
  });

  router.post("/mandates/:id/delegations", async (request, response) => {
    const body = parseBody(delegateSchema, request.body);
    const actor = await actorFor(request, repositories);
    const mandate = await delegate(request.params.id, body, repositories, actor);
    response.status(201).json(mandate);
  });

  router.post("/mandates/:id/revocation", async (request, response) => {
    const body = parseBody(revokeSchema, request.body);
    const actor = await actorFor(request, repositories);
    await revoke(request.params.id, body.reason, repositories, actor);
    response.status(204).end();
  });

  router.post("/actions", async (request, response) => {
    const body = parseBody(actionSchema, request.body);
    const actor = await actorFor(request, repositories);
    const outcome = await submitAction(body, repositories, actor);
    response.status(201).json({
      verdict: outcome.decision.verdict,
      reason: outcome.decision.reason,
      decision: outcome.decision,
      packId: outcome.pack.packId,
      packDigest: outcome.pack.integrity.packDigest,
    });
  });

  router.post("/checkpoint", async (_request, response) => {
    response.status(201).json(await takeCheckpoint(repositories));
  });

  return router;
}
