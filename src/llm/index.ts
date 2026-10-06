// Pick the LLM provider from config. Default is the $0 scripted dry-run.
// A live provider needs both LLM_PROVIDER and its key: a key alone never
// switches on spend.
import { AnthropicProvider } from "./anthropic";
import { OpenAICompatibleProvider } from "./openai-compatible";
import { ScriptedProvider } from "./scripted";
import type { LLMProvider } from "./types";

export interface LLMConfig {
  LLM_PROVIDER?: string;
  LLM_MODEL?: string;
  LLM_EFFORT?: string;
  ANTHROPIC_API_KEY?: string;
  LLM_BASE_URL?: string;
  LLM_API_KEY?: string;
}

export function createProvider(cfg: LLMConfig): LLMProvider {
  const p = (cfg.LLM_PROVIDER ?? "scripted").toLowerCase();
  if (p === "anthropic") {
    if (!cfg.ANTHROPIC_API_KEY) throw new Error("LLM_PROVIDER=anthropic needs ANTHROPIC_API_KEY.");
    return new AnthropicProvider({
      apiKey: cfg.ANTHROPIC_API_KEY,
      model: cfg.LLM_MODEL || "claude-opus-5-5",
      effort: (cfg.LLM_EFFORT as "medium") || "medium",
    });
  }
  if (p === "openai-compatible") {
    if (!cfg.LLM_BASE_URL || !cfg.LLM_API_KEY || !cfg.LLM_MODEL) throw new Error("LLM_PROVIDER=openai-compatible needs LLM_BASE_URL, LLM_API_KEY and LLM_MODEL.");
    return new OpenAICompatibleProvider({ baseUrl: cfg.LLM_BASE_URL, apiKey: cfg.LLM_API_KEY, model: cfg.LLM_MODEL });
  }
  return new ScriptedProvider();
}

export type { LLMProvider } from "./types";
