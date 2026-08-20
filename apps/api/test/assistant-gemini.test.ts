import { describe, expect, it } from "vitest";
import { geminiProvider } from "../src/assistant/gemini.js";
import { ProviderProtocolError, ProviderUnavailableError } from "../src/assistant/provider.js";
import type { LLMRequest } from "../src/assistant/provider.js";

/**
 * The one file in this repository that knows a vendor exists.
 *
 * It is tested against a fake transport rather than the network, so these run in CI with no key and
 * no egress — which is the same property that lets the whole assistant be switched off without the
 * rest of the service noticing.
 */

interface Captured {
  url: string;
  init: RequestInit;
}

function transportReturning(
  body: unknown,
  options: { status?: number; text?: string } = {},
): { fetch: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const fake = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const payload = options.text ?? JSON.stringify(body);
    return new Response(payload, {
      status: options.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  return { fetch: fake, calls };
}

const answering = (text: string) => ({
  candidates: [{ content: { parts: [{ text }] } }],
});

const REQUEST: LLMRequest = {
  system: "you advise, you do not decide",
  turns: [{ role: "user", text: "what happened?" }],
  tools: [],
};

const bodyOf = (call: Captured): Record<string, unknown> =>
  JSON.parse(call.init.body as string) as Record<string, unknown>;

describe("the Gemini transport", () => {
  it("returns the model's text", async () => {
    const { fetch: transport } = transportReturning(answering("Two payments were allowed."));
    const provider = geminiProvider({ apiKey: "k", fetch: transport });

    const reply = await provider.complete(REQUEST);

    expect(reply.text).toBe("Two payments were allowed.");
    expect(reply.toolCalls).toEqual([]);
  });

  it("sends the key in a header, never in the URL", async () => {
    const { fetch: transport, calls } = transportReturning(answering("hello"));
    const provider = geminiProvider({ apiKey: "super-secret", fetch: transport });

    await provider.complete(REQUEST);

    const [call] = calls;
    expect(call!.url).not.toMatch(/super-secret/);
    expect((call!.init.headers as Record<string, string>)["x-goog-api-key"]).toBe("super-secret");
  });

  it("carries the system instruction separately from the conversation", async () => {
    const { fetch: transport, calls } = transportReturning(answering("hello"));
    const provider = geminiProvider({ apiKey: "k", fetch: transport });

    await provider.complete(REQUEST);

    const body = bodyOf(calls[0]!);
    expect(body.systemInstruction).toEqual({ parts: [{ text: "you advise, you do not decide" }] });
    expect(body.contents).toEqual([{ role: "user", parts: [{ text: "what happened?" }] }]);
  });

  // Gemini has two speaker roles and Warrant has three. A tool result is a `user` turn carrying a
  // `functionResponse`, and getting this wrong is silent: the model simply stops seeing its results.
  it("maps a tool result onto the role the API expects", async () => {
    const { fetch: transport, calls } = transportReturning(answering("done"));
    const provider = geminiProvider({ apiKey: "k", fetch: transport });

    await provider.complete({
      system: "s",
      tools: [],
      turns: [
        { role: "user", text: "why?" },
        { role: "model", toolCalls: [{ name: "getDecision", arguments: { packId: "pack_1" } }] },
        { role: "tool", name: "getDecision", result: { ok: true, data: { verdict: "ALLOW" } } },
      ],
    });

    expect(bodyOf(calls[0]!).contents).toEqual([
      { role: "user", parts: [{ text: "why?" }] },
      { role: "model", parts: [{ functionCall: { name: "getDecision", args: { packId: "pack_1" } } }] },
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              name: "getDecision",
              response: { result: { ok: true, data: { verdict: "ALLOW" } } },
            },
          },
        ],
      },
    ]);
  });

  it("keeps a marker part on a model turn that said nothing", async () => {
    const { fetch: transport, calls } = transportReturning(answering("done"));
    const provider = geminiProvider({ apiKey: "k", fetch: transport });

    await provider.complete({ system: "s", tools: [], turns: [{ role: "model" }] });

    // The API rejects a turn with no parts at all, so an empty one still has to carry something.
    expect(bodyOf(calls[0]!).contents).toEqual([{ role: "model", parts: [{ text: "" }] }]);
  });

  it("declares the tools it was offered, and none when offered none", async () => {
    const { fetch: transport, calls } = transportReturning(answering("hello"));
    const provider = geminiProvider({ apiKey: "k", fetch: transport });

    await provider.complete({
      ...REQUEST,
      tools: [{ name: "getDecision", description: "read one", parameters: { type: "object" } }],
    });
    await provider.complete(REQUEST);

    expect(bodyOf(calls[0]!).tools).toEqual([
      {
        functionDeclarations: [
          { name: "getDecision", description: "read one", parameters: { type: "object" } },
        ],
      },
    ]);
    expect(bodyOf(calls[1]!).tools).toBeUndefined();
  });

  // "may not call one" and "there are none" are different states. Conflating them breaks the final
  // round, because a conversation that already contains a tool call needs the declarations to stay.
  it("forbids calling without withdrawing the declarations", async () => {
    const { fetch: transport, calls } = transportReturning(answering("hello"));
    const provider = geminiProvider({ apiKey: "k", fetch: transport });
    const tools = [{ name: "getDecision", description: "read one", parameters: { type: "object" } }];

    await provider.complete({ ...REQUEST, tools, allowToolCalls: false });
    await provider.complete({ ...REQUEST, tools, allowToolCalls: true });
    await provider.complete({ ...REQUEST, tools });

    const modeOf = (call: Captured) =>
      (bodyOf(call).toolConfig as { functionCallingConfig: { mode: string } }).functionCallingConfig
        .mode;

    expect(modeOf(calls[0]!)).toBe("NONE");
    expect((bodyOf(calls[0]!).tools as unknown[])).toHaveLength(1);

    expect(modeOf(calls[1]!)).toBe("AUTO");
    // Absent means allowed: only an explicit `false` forbids.
    expect(modeOf(calls[2]!)).toBe("AUTO");
  });

  it("reads a tool call out of the answer, arguments untouched", async () => {
    const { fetch: transport } = transportReturning({
      candidates: [
        {
          content: {
            parts: [
              { text: "Let me look." },
              { functionCall: { name: "searchEvidence", args: { verdict: "BLOCK" } } },
            ],
          },
        },
      ],
    });
    const provider = geminiProvider({ apiKey: "k", fetch: transport });

    const reply = await provider.complete(REQUEST);

    expect(reply.text).toBe("Let me look.");
    expect(reply.toolCalls).toEqual([{ name: "searchEvidence", arguments: { verdict: "BLOCK" } }]);
  });

  it("gives a tool call with no arguments an empty object rather than undefined", async () => {
    const { fetch: transport } = transportReturning({
      candidates: [{ content: { parts: [{ functionCall: { name: "searchEvidence" } }] } }],
    });
    const provider = geminiProvider({ apiKey: "k", fetch: transport });

    const reply = await provider.complete(REQUEST);
    expect(reply.toolCalls).toEqual([{ name: "searchEvidence", arguments: {} }]);
  });

  it("honours a model and endpoint chosen by the deployment", async () => {
    const { fetch: transport, calls } = transportReturning(answering("hello"));
    const provider = geminiProvider({
      apiKey: "k",
      model: "gemini-3-pro",
      endpoint: "https://example.test/v1/",
      fetch: transport,
    });

    expect(provider.model).toBe("gemini-3-pro");
    await provider.complete(REQUEST);
    expect(calls[0]!.url).toBe("https://example.test/v1/models/gemini-3-pro:generateContent");
  });
});

/**
 * Gemini 3 attaches an opaque `thoughtSignature` to a function call and refuses the next request if
 * the call is replayed without it. Nothing in a single request/response exchange reveals that, which
 * is exactly why it was found by a real call rather than by any of the tests above — the failure only
 * appears on the turn *after* a tool result goes back.
 *
 * These lock the round trip in, so it is a caught regression rather than a rediscovery.
 */
describe("the Gemini transport round-trips the provider's own state", () => {
  it("reads a thought signature off a tool call", async () => {
    const { fetch: transport } = transportReturning({
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: { name: "searchEvidence", args: { verdict: "BLOCK" } },
                thoughtSignature: "opaque-token-abc",
              },
            ],
          },
        },
      ],
    });
    const provider = geminiProvider({ apiKey: "k", fetch: transport });

    const reply = await provider.complete(REQUEST);

    expect(reply.toolCalls).toEqual([
      { name: "searchEvidence", arguments: { verdict: "BLOCK" }, signature: "opaque-token-abc" },
    ]);
  });

  it("hands it back verbatim when the call is replayed", async () => {
    const { fetch: transport, calls } = transportReturning(answering("done"));
    const provider = geminiProvider({ apiKey: "k", fetch: transport });

    await provider.complete({
      system: "s",
      tools: [],
      turns: [
        { role: "user", text: "why?" },
        {
          role: "model",
          toolCalls: [
            { name: "getDecision", arguments: { packId: "pack_1" }, signature: "opaque-token-abc" },
          ],
        },
        { role: "tool", name: "getDecision", result: { ok: true } },
      ],
    });

    const contents = bodyOf(calls[0]!).contents as { role: string; parts: unknown[] }[];
    expect(contents[1]!.parts).toEqual([
      {
        functionCall: { name: "getDecision", args: { packId: "pack_1" } },
        thoughtSignature: "opaque-token-abc",
      },
    ]);
  });

  it("sends no signature field when the provider gave none", async () => {
    const { fetch: transport, calls } = transportReturning(answering("done"));
    const provider = geminiProvider({ apiKey: "k", fetch: transport });

    await provider.complete({
      system: "s",
      tools: [],
      turns: [{ role: "model", toolCalls: [{ name: "getDecision", arguments: {} }] }],
    });

    const contents = bodyOf(calls[0]!).contents as { parts: unknown[] }[];
    expect(contents[0]!.parts).toEqual([{ functionCall: { name: "getDecision", args: {} } }]);
  });

  it("keeps the signature out of what a caller ever sees", async () => {
    // It is the provider's state. It is round-tripped, never interpreted, and never surfaced.
    const { fetch: transport } = transportReturning({
      candidates: [
        {
          content: {
            parts: [
              { functionCall: { name: "searchEvidence", args: {} }, thoughtSignature: "secret-state" },
            ],
          },
        },
      ],
    });
    const provider = geminiProvider({ apiKey: "k", fetch: transport });

    const reply = await provider.complete(REQUEST);

    // Present on the wire object the session replays, absent from the invocation record the API
    // returns - `ToolInvocation` carries only the name, the arguments and the outcome.
    expect(reply.toolCalls[0]!.signature).toBe("secret-state");
    expect(Object.keys(reply.toolCalls[0]!).sort()).toEqual(["arguments", "name", "signature"]);
  });
});

describe("the Gemini transport fails safely", () => {
  it("reports an unreachable model as unavailable", async () => {
    const exploding = (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as unknown as typeof fetch;

    const provider = geminiProvider({ apiKey: "k", fetch: exploding });

    await expect(provider.complete(REQUEST)).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it("reports a refused request by status, and never repeats the body", async () => {
    // A provider error body can quote the prompt back, and the prompt carries evidence.
    const { fetch: transport } = transportReturning(
      { error: { message: "quota exceeded for project warrant-prod, prompt was: Kalyani Steel" } },
      { status: 429 },
    );
    const provider = geminiProvider({ apiKey: "k", fetch: transport });

    await expect(provider.complete(REQUEST)).rejects.toThrow(/status 429/);
    await expect(provider.complete(REQUEST)).rejects.not.toThrow(/Kalyani Steel/);
  });

  it("refuses an answer that is not JSON", async () => {
    const { fetch: transport } = transportReturning(undefined, { text: "<html>gateway timeout" });
    const provider = geminiProvider({ apiKey: "k", fetch: transport });

    await expect(provider.complete(REQUEST)).rejects.toBeInstanceOf(ProviderProtocolError);
  });

  it("distinguishes a blocked prompt from an empty one", async () => {
    const blocked = transportReturning({ promptFeedback: { blockReason: "SAFETY" } });
    const provider = geminiProvider({ apiKey: "k", fetch: blocked.fetch });
    await expect(provider.complete(REQUEST)).rejects.toThrow(/SAFETY/);

    const empty = transportReturning({ candidates: [] });
    const other = geminiProvider({ apiKey: "k", fetch: empty.fetch });
    await expect(other.complete(REQUEST)).rejects.toThrow(/no answer/);
  });

  it("refuses a tool call that names no tool", async () => {
    const { fetch: transport } = transportReturning({
      candidates: [{ content: { parts: [{ functionCall: { args: { a: 1 } } }] } }],
    });
    const provider = geminiProvider({ apiKey: "k", fetch: transport });

    await expect(provider.complete(REQUEST)).rejects.toThrow(/tool with no name/);
  });

  it("refuses an answer whose parts are not a list", async () => {
    const { fetch: transport } = transportReturning({
      candidates: [{ content: { parts: "not a list" } }],
    });
    const provider = geminiProvider({ apiKey: "k", fetch: transport });

    await expect(provider.complete(REQUEST)).rejects.toBeInstanceOf(ProviderProtocolError);
  });

  it("refuses an answer that is not an object at all", async () => {
    const { fetch: transport } = transportReturning(null, { text: "null" });
    const provider = geminiProvider({ apiKey: "k", fetch: transport });

    await expect(provider.complete(REQUEST)).rejects.toThrow(/not an object/);
  });
});
