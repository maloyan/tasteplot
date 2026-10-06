// The agent loop. Provider-agnostic: the LLM decides which tools to call and
// with what; this loop validates inputs, runs tools (in parallel when the LLM
// asks for several in one turn), streams trace events and enforces budgets.
import type { QlooClient } from "../qloo/client";
import { QlooBudgetError } from "../qloo/client";
import type { LLMProvider, ToolResult, TurnInput } from "../llm/types";
import type { AgentEvent, SitePlan, SiteRequest, TraceStep } from "../shared/types";
import { findMetro } from "../shared/metros";
import { AgentState } from "./state";
import { getTool, toolSpecs, type ToolContext } from "./tools";
import { splitNames } from "../shared/names";
import { SYSTEM_PROMPT, taskMessage } from "./prompt";

export interface RunOptions {
  qloo: QlooClient;
  qlooMode: "fixtures" | "live";
  llm: LLMProvider;
  emit: (e: AgentEvent) => void;
  maxTurns?: number;
  /** Max characters of one tool result sent back to the LLM. */
  maxResultChars?: number;
}

export interface RunOutcome {
  plan?: SitePlan;
  state: AgentState;
  turns: number;
  stoppedBy: "plan" | "needs_input" | "max_turns" | "no_progress" | "refusal" | "error";
}

const cleanList = (v: unknown, max: number): string[] =>
  (Array.isArray(v) ? v : splitNames(String(v ?? "")))
    .map((x) => String(x).trim().slice(0, 80))
    .filter(Boolean)
    .slice(0, max);

export type RawRequest = Omit<Partial<SiteRequest>, "seeds" | "compareSeeds"> & { seeds?: string[] | string; compareSeeds?: string[] | string };

export function validateRequest(r: RawRequest): SiteRequest {
  const brand = String(r.brand ?? "").trim().slice(0, 80);
  if (!brand) throw new Error("brand is required");
  const metro = findMetro(String(r.metro ?? ""));
  if (!metro) throw new Error(`metro must be one of the supported metros`);
  const seeds = cleanList(r.seeds, 6);
  const audience = String(r.audience ?? "").trim().slice(0, 200);
  if (!seeds.length && !audience) throw new Error("describe the audience or name at least one thing the customers love");
  const cmp = r.compareMetro ? findMetro(String(r.compareMetro)) : undefined;
  const compareSeeds = cleanList(r.compareSeeds, 4);
  const picks: Record<string, string> = {};
  for (const [k, v] of Object.entries(r.picks ?? {})) if (seeds.includes(k) || compareSeeds.includes(k)) picks[k] = String(v).slice(0, 200);
  return {
    brand,
    audience,
    seeds,
    metro: metro.id,
    compareMetro: cmp && cmp.id !== metro.id ? cmp.id : undefined,
    compareSeeds: compareSeeds.length ? compareSeeds : undefined,
    format: r.format === "popup" ? "popup" : "store",
    sites: Math.max(1, Math.min(5, Math.round(Number(r.sites ?? 3)) || 3)),
    picks: Object.keys(picks).length ? picks : undefined,
  };
}

export async function runAgent(request: SiteRequest, o: RunOptions): Promise<RunOutcome> {
  const t0 = Date.now();
  const state = new AgentState(request, findMetro(request.metro)!, request.compareMetro ? findMetro(request.compareMetro) : undefined);
  const maxTurns = o.maxTurns ?? 24;
  const ctx: ToolContext = {
    qloo: o.qloo,
    state,
    provenance: () => ({ qloo: o.qlooMode, llm: o.llm.id }),
  };
  o.emit({ type: "start", request, mode: { qloo: o.qlooMode, llm: o.llm.id } });

  const session = o.llm.startSession({ system: SYSTEM_PROMPT, tools: toolSpecs() });
  let input: TurnInput = { userText: taskMessage(request, state.metro.name, state.compareMetro?.name) };
  let turns = 0;
  let nudges = 0;
  let stopNote = ""; // the agent's own reason, from its first turn without tool calls
  let stepSeq = 0;
  let stoppedBy: RunOutcome["stoppedBy"] = "max_turns";

  const finish = (): RunOutcome => {
    const provenance = {
      qloo: o.qlooMode,
      llm: o.llm.id,
      qlooCalls: o.qloo.calls.length,
      llmTurns: turns,
      ms: Date.now() - t0,
      warnings: [...new Set(o.qloo.warnings)].slice(0, 20),
    };
    if (state.plan) {
      state.plan.provenance = provenance;
      o.emit({ type: "plan", plan: state.plan });
    }
    o.emit({ type: "done", provenance });
    return { plan: state.plan, state, turns, stoppedBy };
  };

  try {
    while (turns < maxTurns) {
      turns++;
      const turn = await session.next(input);
      if (turn.text) o.emit({ type: "thought", text: turn.text });
      if (turn.stop === "refusal") {
        stoppedBy = "refusal";
        o.emit({ type: "error", message: "The model declined this request." });
        break;
      }
      if (turn.toolCalls.length === 0) {
        if (state.plan) { stoppedBy = "plan"; break; }
        if (state.needsInput) { stoppedBy = "needs_input"; break; }
        if (!stopNote && turn.text) stopNote = turn.text.trim().slice(0, 300);
        if (++nudges > 2) {
          stoppedBy = "no_progress";
          o.emit({ type: "error", message: `The agent stopped without submitting a plan.${stopNote ? ` Reason: ${stopNote}` : ""}` });
          break;
        }
        input = { userText: "You have not submitted a site plan. Continue with the tools and finish with submit_site_plan." };
        continue;
      }

      const results: ToolResult[] = await Promise.all(
        turn.toolCalls.map(async (call): Promise<ToolResult> => {
          const tool = getTool(call.name);
          const step: TraceStep = { id: `s${++stepSeq}`, tool: call.name, label: call.name, status: "running", qloo: [] };
          if (!tool) {
            return { id: call.id, content: `Unknown tool "${call.name}".`, isError: true };
          }
          const parsed = tool.schema.safeParse(call.input);
          if (!parsed.success) {
            return { id: call.id, content: `Invalid input for ${call.name}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, isError: true };
          }
          const scoped = o.qloo.scoped((rec) => step.qloo.push({ path: rec.path, params: rec.params, ms: rec.ms, cached: rec.cached, count: rec.count }));
          const tctx: ToolContext = { ...ctx, qloo: scoped };
          step.label = tool.label(parsed.data, tctx);
          o.emit({ type: "step", step: { ...step } });
          const s0 = Date.now();
          try {
            const { result, summary } = await tool.run(parsed.data, tctx);
            step.status = "done";
            step.summary = summary;
            step.ms = Date.now() - s0;
            o.emit({ type: "step", step: { ...step, qloo: [...step.qloo] } });
            if (call.name === "map_taste_heat") {
              const h = state.heat.get(String((parsed.data as { metro_id?: string }).metro_id));
              if (h) o.emit({ type: "heatmap", metroId: h.metro.id, cells: h.cells, neighborhoods: h.hoods });
            }
            let content = JSON.stringify(result);
            const max = o.maxResultChars ?? 6000;
            if (content.length > max) content = content.slice(0, max) + "…(truncated)";
            return { id: call.id, content };
          } catch (err) {
            step.status = "error";
            step.summary = (err as Error).message;
            step.ms = Date.now() - s0;
            o.emit({ type: "step", step: { ...step, qloo: [...step.qloo] } });
            const hint = err instanceof QlooBudgetError ? " Submit the site plan now with the neighbourhoods you already scouted." : "";
            return { id: call.id, content: `${(err as Error).message}${hint}`, isError: true };
          }
        }),
      );

      if (state.needsInput) {
        stoppedBy = "needs_input";
        o.emit({ type: "needs_input", question: `Which "${state.needsInput.seed}" do you mean?`, seed: state.needsInput.seed, candidates: state.needsInput.candidates });
        break;
      }
      if (state.plan) { stoppedBy = "plan"; break; }
      input = { toolResults: results };
    }
  } catch (err) {
    stoppedBy = "error";
    o.emit({ type: "error", message: (err as Error).message });
  }
  return finish();
}
