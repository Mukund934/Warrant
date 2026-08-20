import { Router } from "express";
import { z } from "zod";
import { scopeOf } from "../auth/tenancy.js";
import { badRequest } from "../http/errors.js";
import { parseBody } from "../http/validate.js";
import { EVIDENCE_PAGE_LIMIT } from "../persistence/types.js";
import { replayEvidence } from "../services/replay.js";
import type { Repositories } from "../persistence/types.js";

const isoDateTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/, "must be an ISO-8601 UTC timestamp");

// Strict, as D42 requires: a filter that is silently ignored returns evidence the caller did not ask
// for, and looks exactly like evidence that does not exist.
const searchSchema = z
  .object({
    verdict: z.enum(["ALLOW", "BLOCK", "ESCALATE"]).optional(),
    action: z.string().min(1).max(120).optional(),
    counterparty: z.string().min(1).max(200).optional(),
    actor: z.string().min(1).max(200).optional(),
    rootMandateId: z.string().min(1).max(120).optional(),
    currency: z.enum(["INR", "USD", "EUR"]).optional(),
    minAmount: z.coerce.number().int().nonnegative().optional(),
    maxAmount: z.coerce.number().int().nonnegative().optional(),
    from: isoDateTime.optional(),
    to: isoDateTime.optional(),
    limit: z.coerce.number().int().min(1).max(EVIDENCE_PAGE_LIMIT).default(25),
    cursor: z.string().min(3).max(300).optional(),
  })
  .strict();

export function searchRoutes(repositories: Repositories): Router {
  const router = Router();

  router.get("/search/evidence", async (request, response) => {
    const query = parseBody(searchSchema, request.query);

    if (query.minAmount !== undefined && query.maxAmount !== undefined && query.minAmount > query.maxAmount) {
      throw badRequest("range_inverted", "minAmount is greater than maxAmount, so nothing can match");
    }
    if (query.from && query.to && query.from > query.to) {
      throw badRequest("range_inverted", "from is later than to, so nothing can match");
    }

    response.json(await repositories.evidence.search(query, scopeOf(request)));
  });

  router.get("/replays/:packId", async (request, response) => {
    response.json(await replayEvidence(request.params.packId, repositories, scopeOf(request)));
  });

  return router;
}
