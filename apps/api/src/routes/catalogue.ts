import { Router } from "express";
import { verifyEvidencePack } from "@warrant/core";
import type { TrustRoot } from "@warrant/core";
import { demoScenarios } from "@warrant/core/fixtures";
import { z } from "zod";
import { scopeOf } from "../auth/tenancy.js";
import { notFound } from "../http/errors.js";
import { parseBody } from "../http/validate.js";
import { trustRoots } from "../warrant/context.js";
import type { Repositories } from "../persistence/types.js";

const verifyRequestSchema = z.object({
  pack: z.unknown(),
  trustRoots: z.array(z.unknown()).optional(),
});

export function catalogueRoutes(repositories: Repositories): Router {
  const router = Router();

  router.get("/trust-roots", (_request, response) => {
    response.json(trustRoots);
  });

  router.get("/scenarios", async (_request, response) => {
    const scenarios = await demoScenarios();
    response.json(
      scenarios.map((scenario) => ({
        id: scenario.id,
        title: scenario.title,
        question: scenario.question,
        expected: scenario.expected,
        failsAt: scenario.failsAt,
        takeaway: scenario.takeaway,
        packId: scenario.pack.packId,
      })),
    );
  });

  router.get("/scenarios/:id", async (request, response) => {
    const scenario = (await demoScenarios()).find((item) => item.id === request.params.id);
    if (!scenario) throw notFound(`no scenario named ${request.params.id}`);
    response.json({
      id: scenario.id,
      title: scenario.title,
      question: scenario.question,
      expected: scenario.expected,
      request: scenario.request,
      chain: scenario.chain,
      decision: scenario.decision,
      pack: scenario.pack,
    });
  });

  router.get("/evidence/:id", async (request, response) => {
    const stored = await repositories.evidence.findById(request.params.id, scopeOf(request));
    if (stored) {
      response.json(stored);
      return;
    }

    const scenario = (await demoScenarios()).find(
      (item) => item.pack.packId === request.params.id || item.id === request.params.id,
    );
    if (!scenario) throw notFound(`no evidence pack with id ${request.params.id}`);
    response.json(scenario.pack);
  });

  router.post("/verify", async (request, response) => {
    const body = parseBody(verifyRequestSchema, request.body);
    const report = await verifyEvidencePack(body.pack, {
      ...(body.trustRoots ? { trustRoots: body.trustRoots as TrustRoot[] } : {}),
    });
    response.json(report);
  });

  return router;
}
