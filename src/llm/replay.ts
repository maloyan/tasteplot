// Record and replay LLM output, so a real model run can be replayed later at $0.
//
// RecordingProvider wraps a live provider and keeps every turn and every
// completion. ReplayProvider plays them back in order. Tool calls still run
// for real against Qloo (or the fixture world), so a replay re-exercises the
// tools and the grounding check.
import type { CompleteOptions, LLMProvider, LLMSession, ToolSpec, TurnInput, TurnResult } from "./types";

export interface Transcript {
  kind: "tasteplot-llm-transcript";
  version: 1;
  provider: string;
  recordedAt: string;
  /** "recorded" = real model output. "illustrative-fixture" = hand-written example. */
  source: "recorded" | "illustrative-fixture";
  note?: string;
  turns: TurnResult[];
  completions: string[];
}

export class RecordingProvider implements LLMProvider {
  readonly id: string;
  readonly dryRun: boolean;
  readonly transcript: Transcript;

  constructor(private inner: LLMProvider, now = new Date().toISOString()) {
    this.id = inner.id;
    this.dryRun = inner.dryRun;
    this.transcript = { kind: "tasteplot-llm-transcript", version: 1, provider: inner.id, recordedAt: now, source: "recorded", turns: [], completions: [] };
  }

  startSession(opts: { system: string; tools: ToolSpec[] }): LLMSession {
    const s = this.inner.startSession(opts);
    return {
      next: async (input: TurnInput) => {
        const r = await s.next(input);
        this.transcript.turns.push(r);
        return r;
      },
    };
  }

  async complete(o: CompleteOptions): Promise<string> {
    const r = await this.inner.complete(o);
    this.transcript.completions.push(r);
    return r;
  }
}

export class ReplayProvider implements LLMProvider {
  readonly id: string;
  readonly dryRun = true;
  private turn = 0;
  private completion = 0;

  constructor(private t: Transcript) {
    this.id = `replay of ${t.provider} (${t.source})`;
  }

  startSession(): LLMSession {
    return {
      next: async () => {
        const r = this.t.turns[this.turn++];
        if (!r) return { text: "Replay finished: no more recorded turns.", toolCalls: [], stop: "end" };
        return r;
      },
    };
  }

  async complete(): Promise<string> {
    const r = this.t.completions[this.completion++];
    if (r === undefined) throw new Error("Replay has no recorded completion left.");
    return r;
  }
}
