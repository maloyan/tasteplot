// Provider-agnostic LLM interface for the agent loop.
//
// A session owns its own provider-native history. The loop only sends new
// input (a user message or tool results) and reads back text + tool calls.
// This keeps the history append-only and byte-identical for each provider,
// which matters for Claude: thinking blocks must go back unchanged.

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the tool input. */
  input_schema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResult {
  id: string;
  content: string;
  isError?: boolean;
}

export type StopReason = "tool_use" | "end" | "max_tokens" | "refusal" | "other";

export interface TurnResult {
  text: string;
  toolCalls: ToolCall[];
  stop: StopReason;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface TurnInput {
  userText?: string;
  toolResults?: ToolResult[];
}

export interface LLMSession {
  next(input: TurnInput): Promise<TurnResult>;
}

export interface CompleteOptions {
  system: string;
  prompt: string;
  maxTokens?: number;
}

export interface LLMProvider {
  /** For provenance, for example "anthropic:claude-opus-5-5" or "scripted". */
  readonly id: string;
  /** True when the provider spends no money and makes no network call. */
  readonly dryRun: boolean;
  startSession(opts: { system: string; tools: ToolSpec[] }): LLMSession;
  /** One-shot text completion, used by the LLM-only baseline. */
  complete(opts: CompleteOptions): Promise<string>;
}
