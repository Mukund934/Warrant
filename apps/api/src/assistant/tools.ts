import { diffChain, effectiveScope, moneySchema, scopeSchema } from "@warrant/core";
import { z } from "zod";
import type { ZodType } from "zod";
import { EVIDENCE_PAGE_LIMIT } from "../persistence/types.js";
import type { Repositories } from "../persistence/types.js";
import { capabilityInputSchema, capabilityObjections } from "../services/capabilities.js";
import { simulateAction } from "../services/execution.js";
import type { Actor } from "../services/issuance.js";
import type { LLMToolDefinition } from "./provider.js";

/**
 * The seven tools of ROADMAP §13a, and nothing else.
 *
 * Two properties hold across every one of them, and both are tested rather than asserted:
 *
 * 1. **No tool takes an organisation.** Not "ignores one" — none *declares* one, and every schema is
 *    `.strict()`, so a model that names an organisation produces a validation failure rather than a
 *    silent cross-tenant read. Tenancy comes from `context.actor`, which the route derived from the
 *    caller's own session, and there is no path by which model output can reach it.
 * 2. **No tool writes.** Every one is `read` or `propose`. A `propose` tool returns a document plus
 *    the request a human would have to make themselves; it never makes that request.
 */

export type ToolEffect = "read" | "propose";

export interface AssistantContext {
  repositories: Repositories;
  /** Derived from the request, never from the model. This is the whole tenancy argument. */
  actor: Actor;
}

export interface AssistantTool<Input = unknown> {
  name: string;
  effect: ToolEffect;
  description: string;
  schema: ZodType<Input>;
  /** JSON Schema, because that is the one dialect every provider understands. */
  parameters: Record<string, unknown>;
  run(input: Input, context: AssistantContext): Promise<unknown>;
}

export class ToolRefusedError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ToolRefusedError";
    this.code = code;
  }
}

const packId = z.string().min(3).max(120);
const mandateId = z.string().min(3).max(120);

const isoDateTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/, "must be an ISO-8601 UTC timestamp");

const text = (description: string) => ({ type: "string", description });
const object = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object",
  properties,
  required,
});

const money = {
  type: "object",
  description: "an amount in minor units, never a decimal",
  properties: {
    currency: { type: "string", enum: ["INR", "USD", "EUR"] },
    minor: { type: "integer", description: "paise, cents - 250000 is 2,500.00" },
  },
  required: ["currency", "minor"],
};

/** Kept small on purpose: a page of evidence is for reading, not for filling a context window. */
const SEARCH_LIMIT = 25;

async function packOr404(id: string, context: AssistantContext) {
  const pack = await context.repositories.evidence.findById(id, context.actor.scope);
  if (!pack) {
    throw new ToolRefusedError(
      "not_found",
      `no evidence pack with id ${id} is visible to this organisation`,
    );
  }
  return pack;
}

// ---------------------------------------------------------------------------------------------

const getDecision: AssistantTool<{ packId: string }> = {
  name: "getDecision",
  effect: "read",
  description:
    "Read the decision that was already made and signed for one evidence pack. Returns the recorded " +
    "verdict and the named checks behind it. It does not re-run the gate and cannot produce a " +
    "different answer than the one on file.",
  schema: z.object({ packId }).strict(),
  parameters: object({ packId: text("the evidence pack id, like pack_...") }, ["packId"]),

  async run(input, context) {
    const pack = await packOr404(input.packId, context);
    return {
      packId: pack.packId,
      verdict: pack.decision.verdict,
      reason: pack.decision.reason,
      evaluatedAt: pack.decision.evaluatedAt,
      checks: pack.decision.checks.map((check) => ({
        id: check.id,
        title: check.title,
        status: check.status,
        detail: check.detail,
      })),
      inputs: pack.decision.inputs,
      note: "copied from the signed decision, not recomputed",
    };
  },
};

const getEvidence: AssistantTool<{ packId: string }> = {
  name: "getEvidence",
  effect: "read",
  description:
    "Summarise one evidence pack: what was asked, who asked it, under which authority, what was " +
    "decided, and the pack's integrity digest. Proofs and key material are omitted because they are " +
    "for a verifier, not for a reader.",
  schema: z.object({ packId }).strict(),
  parameters: object({ packId: text("the evidence pack id, like pack_...") }, ["packId"]),

  async run(input, context) {
    const pack = await packOr404(input.packId, context);
    return {
      packId: pack.packId,
      generatedAt: pack.generatedAt,
      packDigest: pack.integrity.packDigest,
      request: {
        id: pack.request.id,
        actor: pack.request.actor,
        action: pack.request.action,
        resource: pack.request.resource,
        counterparty: pack.request.counterparty,
        description: pack.request.description,
        requestedAt: pack.request.requestedAt,
        ...(pack.request.amount ? { amount: pack.request.amount } : {}),
      },
      decision: {
        verdict: pack.decision.verdict,
        reason: pack.decision.reason,
        evaluatedAt: pack.decision.evaluatedAt,
      },
      authority: pack.authority.chain.map((mandate) => ({
        id: mandate.id,
        depth: mandate.depth,
        issuer: mandate.issuer.name,
        subject: mandate.subject.name,
      })),
      approval: pack.approval
        ? { approver: pack.approval.approver.name, approvedAt: pack.approval.approvedAt }
        : null,
    };
  },
};

const searchSchema = z
  .object({
    verdict: z.enum(["ALLOW", "BLOCK", "ESCALATE"]).optional(),
    action: z.string().min(1).max(120).optional(),
    counterparty: z.string().min(1).max(200).optional(),
    actor: z.string().min(1).max(200).optional(),
    rootMandateId: z.string().min(1).max(120).optional(),
    currency: z.enum(["INR", "USD", "EUR"]).optional(),
    minAmount: z.number().int().nonnegative().optional(),
    maxAmount: z.number().int().nonnegative().optional(),
    from: isoDateTime.optional(),
    to: isoDateTime.optional(),
    limit: z.number().int().min(1).max(SEARCH_LIMIT).optional(),
  })
  .strict();

const searchEvidence: AssistantTool<z.infer<typeof searchSchema>> = {
  name: "searchEvidence",
  effect: "read",
  description:
    "Find recorded decisions by what was decided. Every filter is exact; there is no free-text " +
    "search. Results are summaries copied from stored decisions. Turn the question into filters here " +
    "rather than reading everything and filtering it yourself.",
  schema: searchSchema,
  parameters: object(
    {
      verdict: { type: "string", enum: ["ALLOW", "BLOCK", "ESCALATE"] },
      action: text("exact action name, like payment.execute"),
      counterparty: text("exact counterparty name"),
      actor: text("exact acting agent id"),
      rootMandateId: text("the root of the authority chain"),
      currency: { type: "string", enum: ["INR", "USD", "EUR"] },
      minAmount: { type: "integer", description: "minor units, inclusive" },
      maxAmount: { type: "integer", description: "minor units, inclusive" },
      from: text("ISO-8601 UTC, inclusive"),
      to: text("ISO-8601 UTC, inclusive"),
      limit: { type: "integer", description: "1 to 25" },
    },
    [],
  ),

  async run(input, context) {
    if (
      input.minAmount !== undefined &&
      input.maxAmount !== undefined &&
      input.minAmount > input.maxAmount
    ) {
      throw new ToolRefusedError(
        "range_inverted",
        "minAmount is greater than maxAmount, so nothing can match",
      );
    }
    if (input.from && input.to && input.from > input.to) {
      throw new ToolRefusedError("range_inverted", "from is later than to, so nothing can match");
    }

    const page = await context.repositories.evidence.search(
      { ...input, limit: Math.min(input.limit ?? SEARCH_LIMIT, EVIDENCE_PAGE_LIMIT) },
      context.actor.scope,
    );

    return {
      results: page.results,
      truncated: Boolean(page.nextCursor),
      note: page.nextCursor
        ? "more decisions match than were returned; say so rather than implying this is all of them"
        : "every decision matching these filters is here",
    };
  },
};

const getMandate: AssistantTool<{ mandateId: string }> = {
  name: "getMandate",
  effect: "read",
  description:
    "Read one mandate: who issued it, to whom, what it permits, when it is valid, and whether it has " +
    "been withdrawn.",
  schema: z.object({ mandateId }).strict(),
  parameters: object({ mandateId: text("the mandate id, like mnd_...") }, ["mandateId"]),

  async run(input, context) {
    const mandate = await context.repositories.mandates.findById(
      input.mandateId,
      context.actor.scope,
    );
    if (!mandate) {
      throw new ToolRefusedError(
        "not_found",
        `no mandate with id ${input.mandateId} is visible to this organisation`,
      );
    }

    const withdrawn = (await context.repositories.mandates.revocations(context.actor.scope)).find(
      (record) => record.mandateId === mandate.id,
    );

    return {
      id: mandate.id,
      depth: mandate.depth,
      issuer: mandate.issuer.name,
      subject: { id: mandate.subject.id, name: mandate.subject.name },
      organisation: mandate.organisation.name,
      scope: mandate.scope,
      notBefore: mandate.notBefore,
      expiresAt: mandate.expiresAt,
      maxDelegationDepth: mandate.maxDelegationDepth,
      revoked: withdrawn ? { at: withdrawn.revokedAt, reason: withdrawn.reason } : null,
    };
  },
};

const getDelegationChain: AssistantTool<{ mandateId: string }> = {
  name: "getDelegationChain",
  effect: "read",
  description:
    "Trace a mandate back to its root and show what each hop gave away. `effectiveScope` is what " +
    "actually remains after every narrowing. Use this to answer why an agent can or cannot do " +
    "something, rather than reading one mandate and guessing.",
  schema: z.object({ mandateId }).strict(),
  parameters: object({ mandateId: text("the mandate id, like mnd_...") }, ["mandateId"]),

  async run(input, context) {
    const chain = await context.repositories.mandates.findChain(
      input.mandateId,
      context.actor.scope,
    );
    if (!chain || chain.length === 0) {
      throw new ToolRefusedError(
        "not_found",
        `no mandate chain could be resolved for ${input.mandateId} in this organisation`,
      );
    }

    return {
      chain: chain.map((mandate) => ({
        id: mandate.id,
        depth: mandate.depth,
        issuer: mandate.issuer.name,
        subject: mandate.subject.name,
      })),
      effectiveScope: effectiveScope(chain.map((mandate) => mandate.scope)),
      hops: diffChain(chain),
    };
  },
};

const simulateSchema = z
  .object({
    mandateId,
    action: z.string().min(1).max(120),
    resource: z.string().min(1).max(200),
    counterparty: z.string().min(1).max(200),
    description: z.string().min(1).max(400).optional(),
    amount: moneySchema.optional(),
  })
  .strict();

const simulate: AssistantTool<z.infer<typeof simulateSchema>> = {
  name: "simulateAction",
  effect: "read",
  description:
    "Ask what the gate would decide about a hypothetical action, without taking it. The " +
    "deterministic gate answers; you only phrase the question and report the result. Nothing is " +
    "recorded: no evidence, no ledger entry, no nonce. Never predict a verdict yourself - call this.",
  schema: simulateSchema,
  parameters: object(
    {
      mandateId: text("the mandate the action would be taken under"),
      action: text("the action name, like payment.execute"),
      resource: text("the resource the action targets"),
      counterparty: text("who the action would be with"),
      description: text("a short human description"),
      amount: money,
    },
    ["mandateId", "action", "resource", "counterparty"],
  ),

  // The deterministic simulator, reached through exactly the service the API route uses, so a
  // prediction the assistant reports cannot drift from the prediction the product makes.
  run: (input, context) => simulateAction(input, context.repositories, context.actor),
};

const draftSchema = z
  .object({
    kind: z.enum(["capability", "house-scope"]),
    // Exactly the schema `POST /v1/capabilities` applies, so a draft this tool calls acceptable
    // is one that endpoint will actually accept.
    capability: capabilityInputSchema.optional(),
    scope: scopeSchema.optional(),
    rationale: z.string().min(1).max(600),
  })
  .strict()
  .refine(
    (value) =>
      value.kind === "capability"
        ? Boolean(value.capability) && !value.scope
        : Boolean(value.scope) && !value.capability,
    { message: "a capability proposal carries `capability`; a house-scope proposal carries `scope`" },
  );

const draftPolicy: AssistantTool<z.infer<typeof draftSchema>> = {
  name: "draftPolicy",
  effect: "propose",
  description:
    "Draft a capability entry or a house ceiling for a human to review. This changes nothing. It " +
    "returns the proposal, whatever Warrant already objects to about it, and the exact request a " +
    "person would have to make themselves to apply it. You cannot apply it, and must not imply that " +
    "it has been applied.",
  schema: draftSchema,
  parameters: object(
    {
      kind: { type: "string", enum: ["capability", "house-scope"] },
      rationale: text("why this is being proposed, in one or two sentences"),
      capability: {
        type: "object",
        description: "present only when kind is capability",
        properties: {
          id: text("qualified and lower-case, like payment.execute"),
          title: text("a short human title"),
          description: text("what this capability permits"),
          risk: { type: "string", enum: ["low", "medium", "high", "critical"] },
          amount: { type: "string", enum: ["required", "optional", "forbidden"] },
          currencies: { type: "array", items: { type: "string", enum: ["INR", "USD", "EUR"] } },
          approvalAbove: money,
        },
        required: ["id", "title", "description", "risk", "amount"],
      },
      scope: {
        type: "object",
        description: "present only when kind is house-scope: the ceiling above every mandate",
        properties: {
          actions: { type: "array", items: { type: "string" } },
          audience: { type: "array", items: { type: "string" } },
          counterparties: {
            type: "object",
            properties: { allow: { type: "array", items: { type: "string" } } },
          },
          limits: {
            type: "object",
            properties: {
              perAction: money,
              perPeriod: {
                type: "object",
                properties: { amount: money, days: { type: "integer" } },
              },
            },
          },
        },
      },
    },
    ["kind", "rationale"],
  ),

  async run(input) {
    // Nothing here reads a repository and nothing here writes one. A proposal is a document.
    const objections = input.capability ? capabilityObjections(input.capability) : [];

    const submit =
      input.kind === "capability"
        ? { method: "POST", path: "/v1/capabilities", body: input.capability }
        : { method: "PUT", path: "/v1/house-scope", body: { scope: input.scope } };

    return {
      proposed: true,
      /** Load-bearing, and inside the payload so it survives being quoted out of context. */
      applied: false,
      kind: input.kind,
      rationale: input.rationale,
      proposal: input.kind === "capability" ? input.capability : input.scope,
      objections,
      acceptable: objections.length === 0,
      submit,
      note:
        "a proposal only. Warrant has not applied this and the assistant cannot: a person with the " +
        "right role must make the request above, and that endpoint will judge it again.",
    };
  },
};

// ---------------------------------------------------------------------------------------------

/**
 * The whole surface. A tool that is not in this array cannot be called, whatever the model asks for,
 * because dispatch is a lookup in this map and not a property access on an object of handlers.
 */
export const ASSISTANT_TOOLS: readonly AssistantTool<never>[] = [
  getDecision,
  getEvidence,
  searchEvidence,
  getMandate,
  getDelegationChain,
  simulate,
  draftPolicy,
] as unknown as readonly AssistantTool<never>[];

const BY_NAME = new Map(ASSISTANT_TOOLS.map((tool) => [tool.name, tool]));

export function findTool(name: string): AssistantTool<never> | undefined {
  // A `Map` rather than an object literal, so `constructor`, `__proto__` and `toString` are misses
  // rather than functions a model could name its way into.
  return BY_NAME.get(name);
}

export function toolDefinitions(): LLMToolDefinition[] {
  return ASSISTANT_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}
