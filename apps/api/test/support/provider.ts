import type {
  LLMProvider,
  LLMReply,
  LLMRequest,
  LLMToolCall,
} from "../../src/assistant/provider.js";

/**
 * A model whose every answer is written by the test.
 *
 * The §13a invariants are about what happens when the model is unavailable, wrong, or hostile, and
 * none of those three can be provoked reliably from a real one. Scripting the replies turns
 * "the assistant should not obey an injected instruction" into a test that obeys the injected
 * instruction as hard as it possibly can, and then checks that nothing happened.
 */

export interface StubProvider extends LLMProvider {
  /** Every request the application made, so a test can assert what the model was *shown*. */
  readonly requests: LLMRequest[];
}

export type Step = LLMReply | ((request: LLMRequest, index: number) => LLMReply | Promise<LLMReply>);

export interface StubOptions {
  id?: string;
  model?: string;
}

export function stubProvider(script: Step[] | Step, options: StubOptions = {}): StubProvider {
  const steps = Array.isArray(script) ? script : undefined;
  const single = Array.isArray(script) ? undefined : script;
  const requests: LLMRequest[] = [];

  return {
    id: options.id ?? "stub",
    model: options.model ?? "stub-1",
    requests,

    async complete(request: LLMRequest): Promise<LLMReply> {
      const index = requests.length;
      requests.push(request);

      // Repeated forever, which is what a model stuck in a tool loop actually does.
      const step = single ?? steps![index];
      if (!step) {
        throw new Error(
          `the stub was asked for reply ${index + 1} but only ${steps!.length} were scripted`,
        );
      }
      return typeof step === "function" ? step(request, index) : step;
    },
  };
}

/** A provider that cannot be reached at all. */
export function brokenProvider(error: Error): StubProvider {
  const requests: LLMRequest[] = [];
  return {
    id: "broken",
    model: "broken-1",
    requests,
    async complete(request: LLMRequest): Promise<LLMReply> {
      requests.push(request);
      throw error;
    },
  };
}

export const says = (text: string): LLMReply => ({ text, toolCalls: [] });

export const asks = (...toolCalls: LLMToolCall[]): LLMReply => ({ toolCalls });

export const call = (name: string, args: unknown = {}): LLMToolCall => ({
  name,
  arguments: args,
});

/** Every tool result the application handed back, flattened for assertions. */
export function toolResultsIn(request: LLMRequest): { name: string; result: unknown }[] {
  return request.turns
    .filter((turn): turn is Extract<typeof turn, { role: "tool" }> => turn.role === "tool")
    .map((turn) => ({ name: turn.name, result: turn.result }));
}
