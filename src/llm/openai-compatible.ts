// Any provider that speaks the /chat/completions wire format with function
// tools (many hosted and local model servers do). This keeps Tasteplot
// provider-agnostic. It is not used for Claude: Claude goes through the
// official SDK in ./anthropic.ts.
import type { CompleteOptions, LLMProvider, LLMSession, StopReason, ToolSpec, TurnInput, TurnResult } from "./types";

export interface OpenAICompatibleOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens?: number;
  fetch?: typeof fetch;
}

type Msg =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] }
  | { role: "tool"; tool_call_id: string; content: string };

interface ChatResponse {
  choices: { message: { content: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] }; finish_reason: string }[];
  usage?: { prompt_tokens: number; completion_tokens: number };
}

function mapStop(s: string): StopReason {
  if (s === "tool_calls") return "tool_use";
  if (s === "stop") return "end";
  if (s === "length") return "max_tokens";
  if (s === "content_filter") return "refusal";
  return "other";
}

export class OpenAICompatibleProvider implements LLMProvider {
  readonly id: string;
  readonly dryRun = false;
  constructor(private o: OpenAICompatibleOptions) {
    this.id = `openai-compatible:${o.model}`;
  }

  private async chat(messages: Msg[], tools?: ToolSpec[]): Promise<ChatResponse> {
    const f = this.o.fetch ?? fetch;
    const res = await f(`${this.o.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.o.apiKey}` },
      body: JSON.stringify({
        model: this.o.model,
        max_tokens: this.o.maxTokens ?? 8000,
        messages,
        ...(tools?.length
          ? { tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } })), tool_choice: "auto" }
          : {}),
      }),
    });
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as ChatResponse;
  }

  startSession(opts: { system: string; tools: ToolSpec[] }): LLMSession {
    const messages: Msg[] = [{ role: "system", content: opts.system }];
    return {
      next: async (input: TurnInput): Promise<TurnResult> => {
        for (const r of input.toolResults ?? []) messages.push({ role: "tool", tool_call_id: r.id, content: r.isError ? `ERROR: ${r.content}` : r.content });
        if (input.userText) messages.push({ role: "user", content: input.userText });
        const res = await this.chat(messages, opts.tools);
        const choice = res.choices[0];
        if (!choice) throw new Error("LLM returned no choices");
        const calls = choice.message.tool_calls ?? [];
        messages.push({ role: "assistant", content: choice.message.content, ...(calls.length ? { tool_calls: calls.map((c) => ({ id: c.id, type: "function" as const, function: c.function })) } : {}) });
        return {
          text: choice.message.content ?? "",
          toolCalls: calls.map((c) => {
            let input: unknown;
            try { input = JSON.parse(c.function.arguments || "{}"); } catch { input = { __invalid_json: c.function.arguments }; }
            return { id: c.id, name: c.function.name, input };
          }),
          stop: mapStop(choice.finish_reason),
          usage: res.usage ? { inputTokens: res.usage.prompt_tokens, outputTokens: res.usage.completion_tokens } : undefined,
        };
      },
    };
  }

  async complete(o: CompleteOptions): Promise<string> {
    const res = await this.chat([{ role: "system", content: o.system }, { role: "user", content: o.prompt }]);
    return res.choices[0]?.message.content ?? "";
  }
}
