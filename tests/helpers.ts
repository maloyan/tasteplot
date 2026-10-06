import type { LLMProvider, LLMSession, ToolCall, TurnInput, TurnResult } from "../src/llm/types";
import type { AgentEvent } from "../src/shared/types";

/** A provider that plays a script of turns. Each step may look at the input it got. */
export class ScriptProvider implements LLMProvider {
  readonly id = "test-script";
  readonly dryRun = true;
  inputs: TurnInput[] = [];
  constructor(private steps: ((input: TurnInput) => TurnResult)[]) {}
  startSession(): LLMSession {
    let i = 0;
    return {
      next: async (input) => {
        this.inputs.push(input);
        const step = this.steps[i++];
        return step ? step(input) : { text: "", toolCalls: [], stop: "end" };
      },
    };
  }
  async complete(): Promise<string> {
    return "";
  }
}

let n = 0;
export const tc = (name: string, input: unknown): ToolCall => ({ id: `t${++n}`, name, input });
export const turn = (...toolCalls: ToolCall[]): TurnResult => ({ text: "", toolCalls, stop: toolCalls.length ? "tool_use" : "end" });

export function collect() {
  const events: AgentEvent[] = [];
  return { events, emit: (e: AgentEvent) => events.push(e) };
}

export function resultOf(input: TurnInput, id?: string): any {
  const r = id ? input.toolResults?.find((x) => x.id === id) : input.toolResults?.[0];
  return r ? JSON.parse(r.isError ? JSON.stringify({ error: r.content }) : r.content) : undefined;
}
