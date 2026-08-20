/**
 * The seam between Warrant and whatever model is answering.
 *
 * It is deliberately small and carries no vendor's vocabulary: a request is a system instruction, a
 * list of turns and a list of tool definitions; a reply is some text and some tool calls. Everything
 * a provider does that is particular to it — REST shapes, safety blocks, part arrays, token
 * accounting — stops at its own implementation and never reaches the tool layer or a route.
 *
 * The reason the seam matters more than the provider (D12): a second implementation should need no
 * change above this file, and nothing above this file should be able to tell which one is installed.
 * That property is what makes the assistant removable, and being removable is what makes the
 * §13a invariant "LLM unavailable → Warrant still functions" true by construction rather than by
 * discipline.
 */

/** A tool the model may ask for, described in JSON Schema because every provider speaks it. */
export interface LLMToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LLMToolCall {
  name: string;
  /** Whatever the model produced. Unknown on purpose — nothing may trust it before validation. */
  arguments: unknown;
}

export type LLMTurn =
  | { role: "user"; text: string }
  | { role: "model"; text?: string; toolCalls?: LLMToolCall[] }
  | { role: "tool"; name: string; result: unknown };

export interface LLMRequest {
  system: string;
  turns: LLMTurn[];
  tools: LLMToolDefinition[];
}

export interface LLMReply {
  text?: string;
  toolCalls: LLMToolCall[];
}

/**
 * The model could not be reached, or refused to answer. Distinct from a protocol error because the
 * two need different handling: this one is a 503 and a retry might work.
 */
export class ProviderUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ProviderUnavailableError";
  }
}

/**
 * The model answered, and the answer was not the shape it claims to be. Never retried and never
 * partially trusted: a reply that does not parse is discarded whole.
 */
export class ProviderProtocolError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ProviderProtocolError";
  }
}

export interface LLMProvider {
  /** Reported on the answer so a reader knows what produced the narrative. */
  readonly id: string;
  readonly model: string;
  complete(request: LLMRequest): Promise<LLMReply>;
}
