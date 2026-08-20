import { Router } from "express";
import { z } from "zod";
import { actorFor } from "../auth/tenancy.js";
import { HttpError } from "../http/errors.js";
import { parseBody } from "../http/validate.js";
import type { Repositories } from "../persistence/types.js";
import { ProviderProtocolError, ProviderUnavailableError } from "../assistant/provider.js";
import type { LLMProvider } from "../assistant/provider.js";
import { ASSISTANT_DISCLAIMER, AssistantError, ask } from "../assistant/session.js";
import type { AssistantLimits } from "../assistant/session.js";
import { ASSISTANT_TOOLS } from "../assistant/tools.js";

export interface AssistantOptions {
  /** Absent means the assistant is switched off. Everything else in the service still works. */
  provider?: LLMProvider;
  limits?: AssistantLimits;
}

const askSchema = z.object({ question: z.string().min(3).max(2_000) }).strict();

export function assistantRoutes(
  repositories: Repositories,
  options: AssistantOptions = {},
): Router {
  const router = Router();

  /**
   * The tool surface, readable whether or not a model is configured. It is deliberately part of the
   * product rather than an implementation detail: the interesting claim about this assistant is what
   * it *cannot* reach, and that claim is only checkable if the list is public.
   */
  router.get("/assistant/tools", (_request, response) => {
    response.json({
      configured: Boolean(options.provider),
      ...(options.provider
        ? { provider: { id: options.provider.id, model: options.provider.model } }
        : {}),
      tools: ASSISTANT_TOOLS.map((tool) => ({
        name: tool.name,
        effect: tool.effect,
        description: tool.description,
        parameters: tool.parameters,
      })),
      guarantees: [
        "every tool is read-only or proposal-only; none writes",
        "no tool accepts an organisation - the caller's session decides what is visible",
        "no tool can issue, delegate, revoke, approve or sign anything",
        "the assistant produces narrative, never evidence and never a decision",
      ],
      disclaimer: ASSISTANT_DISCLAIMER,
    });
  });

  router.post("/assistant/ask", async (request, response) => {
    const provider = options.provider;
    if (!provider) {
      throw new HttpError(
        503,
        "assistant_not_configured",
        "no model provider is configured for this deployment, so the assistant is switched off. Every other endpoint, the gate and offline verification are unaffected",
      );
    }

    const body = parseBody(askSchema, request.body);
    const actor = await actorFor(request, repositories);

    try {
      const answer = await ask(body.question, { repositories, actor }, provider, options.limits);
      response.json(answer);
    } catch (error) {
      if (error instanceof ProviderUnavailableError) {
        throw new HttpError(
          503,
          "assistant_unavailable",
          `the assistant could not reach its model: ${error.message}. Nothing else is affected`,
        );
      }
      if (error instanceof ProviderProtocolError) {
        throw new HttpError(
          502,
          "assistant_protocol_error",
          `the model's answer could not be read: ${error.message}`,
        );
      }
      if (error instanceof AssistantError) {
        throw new HttpError(502, error.code, error.message);
      }
      throw error;
    }
  });

  return router;
}
