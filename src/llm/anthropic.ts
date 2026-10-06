// Claude through the official Anthropic SDK (works on Node and Workers).
//
// Request choices:
// - model claude-opus-5-5 by default (LLM_MODEL overrides).
// - adaptive thinking with summarized display: the trace panel shows the
//   reasoning summaries as "thought" lines.
// - effort "medium" set explicitly (the Opus 5.5 default, stated so it is visible).
// - server-side refusal fallbacks ("default" routing) so a classifier decline
//   is retried on Anthropic's recommended fallback model instead of failing the plan.
// - tool_choice auto. Forced tool choice returns 400 on Opus 5.5.
// - assistant content goes back into history unchanged (thinking blocks included).
import Anthropic from "@anthropic-ai/sdk";
import type { CompleteOptions, LLMProvider, LLMSession, StopReason, ToolSpec, TurnInput, TurnResult } from "./types";

export interface AnthropicProviderOptions {
  apiKey: string;
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  maxTokens?: number;
  /** For tests: a fetch that returns canned API responses. */
  fetch?: typeof fetch;
}

const FALLBACK_BETA = "server-side-fallback-2026-07-01";

function mapStop(s: string | null | undefined): StopReason {
  switch (s) {
    case "tool_use": return "tool_use";
    case "end_turn":
    case "stop_sequence": return "end";
    case "max_tokens": return "max_tokens";
    case "refusal": return "refusal";
    default: return "other";
  }
}

export class AnthropicProvider implements LLMProvider {
  readonly id: string;
  readonly dryRun = false;
  private client: Anthropic;
  private model: string;

  constructor(private o: AnthropicProviderOptions) {
    this.model = o.model ?? "claude-opus-5-5";
    this.id = `anthropic:${this.model}`;
    this.client = new Anthropic({ apiKey: o.apiKey, ...(o.fetch ? { fetch: o.fetch } : {}), maxRetries: 2 });
  }

  private base() {
    return {
      model: this.model,
      max_tokens: this.o.maxTokens ?? 16000,
      thinking: { type: "adaptive" as const, display: "summarized" as const },
      output_config: { effort: this.o.effort ?? ("medium" as const) },
      betas: [FALLBACK_BETA],
      fallbacks: "default" as const,
    };
  }

  startSession(opts: { system: string; tools: ToolSpec[] }): LLMSession {
    const messages: Anthropic.Beta.BetaMessageParam[] = [];
    const tools = opts.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema as Anthropic.Beta.BetaTool.InputSchema }));
    return {
      next: async (input: TurnInput): Promise<TurnResult> => {
        const content: Anthropic.Beta.BetaContentBlockParam[] = [];
        for (const r of input.toolResults ?? []) content.push({ type: "tool_result", tool_use_id: r.id, content: r.content, is_error: r.isError });
        if (input.userText) content.push({ type: "text", text: input.userText });
        // All tool results of one turn go back in ONE user message.
        messages.push({ role: "user", content });
        const res = await this.client.beta.messages.create({
          ...this.base(),
          system: opts.system,
          tools,
          tool_choice: { type: "auto" },
          messages,
        } as Anthropic.Beta.MessageCreateParamsNonStreaming);
        messages.push({ role: "assistant", content: res.content as Anthropic.Beta.BetaContentBlockParam[] });
        let text = "";
        const toolCalls: TurnResult["toolCalls"] = [];
        for (const b of res.content) {
          if (b.type === "text") text += b.text;
          else if (b.type === "thinking" && b.thinking) text += (text ? "\n" : "") + b.thinking;
          else if (b.type === "tool_use") toolCalls.push({ id: b.id, name: b.name, input: b.input });
        }
        return {
          text: text.trim(),
          toolCalls,
          stop: mapStop(res.stop_reason),
          usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens },
        };
      },
    };
  }

  async complete(o: CompleteOptions): Promise<string> {
    const res = await this.client.beta.messages.create({
      ...this.base(),
      max_tokens: o.maxTokens ?? 16000,
      system: o.system,
      messages: [{ role: "user", content: o.prompt }],
    } as Anthropic.Beta.MessageCreateParamsNonStreaming);
    if (res.stop_reason === "refusal") throw new Error("The model declined the baseline request (stop_reason=refusal).");
    return res.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
  }
}
