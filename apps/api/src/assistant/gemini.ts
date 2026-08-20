import { ProviderProtocolError, ProviderUnavailableError } from "./provider.js";
import type { LLMProvider, LLMReply, LLMRequest, LLMToolCall, LLMTurn } from "./provider.js";

/**
 * Gemini, over its REST API with `fetch`, and with no SDK.
 *
 * That is a deliberate supply-chain decision and not laziness. `packages/core` and
 * `packages/verifier` are sealed against provider packages by `boundaries.test.ts`, but a dependency
 * added anywhere in the workspace still lands in the lockfile and in `node_modules`, where the
 * distance between "the verifier does not import it" and "the verifier cannot reach it" is one
 * careless edit. Adding no package at all makes the transitive guard trivially true: there is no
 * provider package in this repository to depend on, and the boundary test now checks that too.
 *
 * The cost is this file — one request shape, one response shape, both stable and both small.
 */

/**
 * Chosen against the key's own model list rather than assumed, because assuming was wrong twice: the
 * obvious default `gemini-2.0-flash` is retired and answers 404, and the newest flash exhausted a
 * free-tier daily quota during one afternoon of testing.
 *
 * A demonstration that answers 503 because its default model ran out of quota looks broken in
 * exactly the moment it is being watched, so the default is the model that was actually observed
 * doing the work within a free key's limits — selecting the right tool, citing the pack it read, and
 * refusing what it must. A deployment with paid quota sets `GEMINI_MODEL` and changes no code.
 */
const DEFAULT_MODEL = "gemini-3.1-flash-lite";
const DEFAULT_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_TIMEOUT_MS = 30_000;

export interface GeminiOptions {
  apiKey: string;
  model?: string;
  endpoint?: string;
  timeoutMs?: number;
  /** Injected in tests so the transport can be exercised without a network. */
  fetch?: typeof fetch;
}

interface GeminiPart {
  text?: string;
  functionCall?: { name?: unknown; args?: unknown };
  functionResponse?: { name: string; response: { result: unknown } };
  /**
   * Opaque, and load-bearing. Gemini 3 attaches it to a `functionCall` and rejects the next request
   * with `Function call is missing a thought_signature` if the call comes back without it. That
   * failure only appears once a tool result is handed back, which is why it survived a suite of
   * transport tests and was caught by the first real call instead.
   */
  thoughtSignature?: string;
}

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

/**
 * Gemini has two speaker roles, not three: a tool result is a `user` turn carrying a
 * `functionResponse`. Collapsing our three onto its two happens here and nowhere else.
 */
function contentsFrom(turns: LLMTurn[]): GeminiContent[] {
  return turns.map((turn): GeminiContent => {
    if (turn.role === "user") return { role: "user", parts: [{ text: turn.text }] };

    if (turn.role === "tool") {
      return {
        role: "user",
        parts: [{ functionResponse: { name: turn.name, response: { result: turn.result } } }],
      };
    }

    const parts: GeminiPart[] = [];
    if (turn.text) parts.push({ text: turn.text });
    for (const call of turn.toolCalls ?? []) {
      parts.push({
        functionCall: { name: call.name, args: call.arguments },
        ...(call.signature ? { thoughtSignature: call.signature } : {}),
      });
    }
    // A turn with no parts at all is rejected by the API, so an empty model turn keeps a marker.
    return { role: "model", parts: parts.length > 0 ? parts : [{ text: "" }] };
  });
}

function replyFrom(body: unknown): LLMReply {
  if (typeof body !== "object" || body === null) {
    throw new ProviderProtocolError("the provider returned something that is not an object");
  }

  const candidates = (body as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    // A blocked prompt comes back as a well-formed body with no candidates, so the reason is worth
    // repeating: "no answer" and "refused to answer" read identically to a caller otherwise.
    const feedback = (body as { promptFeedback?: { blockReason?: unknown } }).promptFeedback;
    const blocked = typeof feedback?.blockReason === "string" ? feedback.blockReason : undefined;
    throw new ProviderProtocolError(
      blocked
        ? `the provider returned no answer and reported ${blocked}`
        : "the provider returned no answer",
    );
  }

  const parts = (candidates[0] as { content?: { parts?: unknown } }).content?.parts;
  if (parts !== undefined && !Array.isArray(parts)) {
    throw new ProviderProtocolError("the provider's answer carries parts that are not a list");
  }

  const texts: string[] = [];
  const toolCalls: LLMToolCall[] = [];

  for (const part of (parts ?? []) as GeminiPart[]) {
    if (typeof part?.text === "string" && part.text.length > 0) texts.push(part.text);
    if (part?.functionCall) {
      const name = part.functionCall.name;
      if (typeof name !== "string" || name.length === 0) {
        throw new ProviderProtocolError("the provider asked for a tool with no name");
      }
      const signature = typeof part.thoughtSignature === "string" ? part.thoughtSignature : undefined;
      // `args` stays `unknown`. It is validated against a schema before anything runs.
      toolCalls.push({
        name,
        arguments: part.functionCall.args ?? {},
        ...(signature ? { signature } : {}),
      });
    }
  }

  const text = texts.join("\n").trim();
  return { ...(text ? { text } : {}), toolCalls };
}

export function geminiProvider(options: GeminiOptions): LLMProvider {
  const model = options.model ?? DEFAULT_MODEL;
  const endpoint = (options.endpoint ?? DEFAULT_ENDPOINT).replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const transport = options.fetch ?? fetch;

  return {
    id: "gemini",
    model,

    async complete(request: LLMRequest): Promise<LLMReply> {
      const payload = {
        systemInstruction: { parts: [{ text: request.system }] },
        contents: contentsFrom(request.turns),
        ...(request.tools.length > 0
          ? {
              tools: [{ functionDeclarations: request.tools }],
              // `NONE` keeps the declarations in the request while forbidding a call, which is what
              // the last round needs: a conversation that already contains a `functionCall` is only
              // valid while the tools it names are still declared.
              //
              // The mode is a convenience rather than a control — the registry refuses an undeclared
              // name and the loop refuses any call it did not permit — but a request the application
              // would reject is better not made.
              toolConfig: {
                functionCallingConfig: { mode: request.allowToolCalls === false ? "NONE" : "AUTO" },
              },
            }
          : {}),
        generationConfig: { temperature: 0.2, maxOutputTokens: 2048 },
      };

      const abort = AbortSignal.timeout(timeoutMs);
      let response: Response;
      try {
        response = await transport(`${endpoint}/models/${model}:generateContent`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            // In the header rather than the query string, so a key cannot reach a log or a referer.
            "x-goog-api-key": options.apiKey,
          },
          body: JSON.stringify(payload),
          signal: abort,
        });
      } catch (error) {
        throw new ProviderUnavailableError(
          `the model could not be reached: ${(error as Error).message}`,
          { cause: error },
        );
      }

      if (!response.ok) {
        // Never the body: a provider error body can quote the prompt, and the prompt carries
        // evidence. The status is enough to act on and discloses nothing.
        throw new ProviderUnavailableError(
          `the model refused the request with status ${response.status}`,
        );
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch (error) {
        throw new ProviderProtocolError("the provider's answer was not valid JSON", { cause: error });
      }

      return replyFrom(body);
    },
  };
}
