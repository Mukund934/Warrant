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
  /**
   * An opaque token the provider attached to this call and wants back, verbatim, when the call is
   * replayed in a later turn. Gemini 3 calls it a thought signature and refuses a conversation that
   * has dropped it.
   *
   * Deliberately typed as an opaque string rather than named after any vendor: it is round-tripped
   * and never interpreted, never parsed, never logged and never returned to a caller. It is the
   * provider's state, and the only correct thing to do with it is hand it back unchanged.
   */
  signature?: string;
}

export type LLMTurn =
  | { role: "user"; text: string }
  | { role: "model"; text?: string; toolCalls?: LLMToolCall[] }
  | { role: "tool"; name: string; result: unknown };

export interface LLMRequest {
  system: string;
  turns: LLMTurn[];
  tools: LLMToolDefinition[];
  /**
   * Whether the model may call a tool on this turn. Defaults to true.
   *
   * Separate from `tools` because "may not call one" and "there are none" are different states, and
   * conflating them breaks the final round: once the conversation contains a tool call, the
   * declarations have to stay present for the history to remain valid, even though nothing further
   * may be called. A provider with no such concept can ignore this — the application refuses an
   * unexpected call regardless, which is where the guarantee actually lives.
   */
  allowToolCalls?: boolean;
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
