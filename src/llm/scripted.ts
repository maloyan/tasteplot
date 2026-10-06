// Dry-run "LLM": a deterministic policy that drives the same tools in the same
// order a good model would. It costs $0, needs no key and no network, and makes
// the full app and the tests runnable on fixtures.
//
// It is NOT a stand-in for the model's judgement in the write-up: provenance
// says "scripted (dry-run)" everywhere it appears. Its one piece of "language
// understanding" is splitting the plain-words audience on commas.
import { TASK_MARKER } from "../agent/prompt";
import type { SiteRequest } from "../shared/types";
import type { CompleteOptions, LLMProvider, LLMSession, ToolCall, TurnInput, TurnResult } from "./types";

type Json = Record<string, any>;

const ageLabel = (b?: string | null) => (b ? b.replace(/_/g, " ").replace("and younger", "and under") : "core");
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export class ScriptedProvider implements LLMProvider {
  readonly id = "scripted (dry-run)";
  readonly dryRun = true;

  startSession(): LLMSession {
    let req: SiteRequest | undefined;
    let seq = 0;
    const issued = new Map<string, string>(); // call id -> tool name
    const mem: { metroId?: string; compareMetroId?: string | null; hoods: Json[]; anchors: Json; brands: Json; audience?: Json; compare?: Json; scouted: string[] } = {
      hoods: [], anchors: {}, brands: {}, scouted: [],
    };

    const call = (name: string, input: unknown): ToolCall => {
      const id = `scripted_${++seq}`;
      issued.set(id, name);
      return { id, name, input };
    };
    const turn = (text: string, toolCalls: ToolCall[] = []): TurnResult => ({ text, toolCalls, stop: toolCalls.length ? "tool_use" : "end" });

    return {
      next: async (input: TurnInput): Promise<TurnResult> => {
        if (input.userText?.includes(TASK_MARKER)) {
          req = JSON.parse(input.userText.slice(input.userText.indexOf(TASK_MARKER) + TASK_MARKER.length).trim().split("\n")[0]!);
          const keywords = req!.audience.split(",").map((s) => s.trim()).filter((s) => s.length > 1).slice(0, 4);
          return turn(`First I turn the brief into Qloo signals: ${req!.seeds.length} seed${req!.seeds.length === 1 ? "" : "s"} the customers love and ${keywords.length} taste keyword${keywords.length === 1 ? "" : "s"}.`, [
            call("resolve_audience", { seeds: req!.seeds, keywords, ...(req!.compareSeeds?.length ? { compare_seeds: req!.compareSeeds } : {}) }),
          ]);
        }
        if (!req) return turn("No task received.");
        const results = new Map<string, Json[]>();
        for (const r of input.toolResults ?? []) {
          const name = issued.get(r.id) ?? "?";
          let body: Json;
          try { body = JSON.parse(r.content); } catch { body = { status: "error", error: r.content }; }
          if (r.isError) body = { status: "error", error: r.content };
          results.set(name, [...(results.get(name) ?? []), body]);
        }

        // Phase: resolved
        const resolved = results.get("resolve_audience")?.[0];
        if (resolved) {
          if (resolved.status === "needs_input") return turn(`"${resolved.candidates[0].name}" matches ${resolved.candidates.length} Qloo entities. I need the user to pick one before mapping.`);
          if (resolved.status !== "ok") return turn(`Qloo has no entity or tag for this audience. I stop here rather than guess.`);
          mem.metroId = resolved.metro_id;
          mem.compareMetroId = resolved.compare_metro_id;
          const calls = [call("map_taste_heat", { metro_id: resolved.metro_id })];
          if (resolved.compare_metro_id) calls.push(call("map_taste_heat", { metro_id: resolved.compare_metro_id }));
          calls.push(call("audience_profile", {}));
          if (resolved.compare_signals?.length) calls.push(call("compare_audiences", {}));
          const names = resolved.signals.map((s: Json) => s.name).join(", ");
          return turn(`Signals: ${names}. Next: where this taste lives${resolved.compare_metro_id ? " in both metros" : ""}, and who the audience is.`, calls);
        }

        // Phase: mapped
        const heats = results.get("map_taste_heat");
        if (heats) {
          mem.audience = results.get("audience_profile")?.[0];
          mem.compare = results.get("compare_audiences")?.[0];
          const main = heats.find((h) => h.metro_id === mem.metroId);
          if (!main || main.status !== "ok") return turn("Qloo returned no taste heat for this metro, so there is no grounded plan to make.");
          mem.hoods = main.neighborhoods;
          const scout = mem.hoods.slice(0, Math.min(mem.hoods.length, req.sites + 2));
          mem.scouted = scout.map((h) => h.neighborhood_id);
          const byLift = scout.some((h) => h.lift != null);
          const top = scout.slice(0, 3).map((h) => (byLift ? `${h.name} (${h.lift.toFixed(2)}x)` : `${h.name} (${Math.round(h.heat * 100)})`)).join(", ");
          return turn(`${byLift ? "Neighbourhoods where this audience over-indexes most vs the general going-out crowd" : "Hottest neighbourhoods"}: ${top}. I scout ${scout.length} of them for places this audience already loves.`, scout.map((h) => call("find_anchor_places", { neighborhood_id: h.neighborhood_id })));
        }

        // Phase: anchors
        const anchorRes = results.get("find_anchor_places");
        if (anchorRes) {
          for (const a of anchorRes) if (a.neighborhood_id) mem.anchors[a.neighborhood_id] = a.places;
          const withAnchors = mem.scouted.filter((id) => mem.anchors[id]?.length);
          if (!withAnchors.length) return turn("No anchor places came back in any scouted neighbourhood, so I stop instead of inventing some.");
          return turn("Each neighbourhood has anchors. Now the brands that this audience and the top anchor's fans both like.", withAnchors.map((id) => call("find_partner_brands", { neighborhood_id: id })));
        }

        // Phase: brands -> choose and submit
        const brandRes = results.get("find_partner_brands");
        if (brandRes) {
          for (const b of brandRes) if (b.neighborhood_id) mem.brands[b.neighborhood_id] = b.brands;
          const age = ageLabel(mem.audience?.strongest_age_bucket);
          const ranked = mem.hoods
            .filter((h) => mem.anchors[h.neighborhood_id]?.length)
            .map((h) => {
              const anchors = [...mem.anchors[h.neighborhood_id]].sort((a: Json, b: Json) => b.affinity - a.affinity);
              // Same formula as siteScore in agent/tools.ts: 0.6 x taste fit + 0.4 x top-3 anchor affinity.
              return { h, anchors, score: 0.6 * (h.fit ?? h.heat) + 0.4 * mean(anchors.slice(0, 3).map((a: Json) => a.affinity)) };
            })
            .sort((a, b) => b.score - a.score)
            .slice(0, req.sites);
          const fmt = req.format === "popup" ? "pop-up" : "store";
          const sites = ranked.map(({ h, anchors }) => {
            const brands: Json[] = mem.brands[h.neighborhood_id] ?? [];
            const a3 = anchors.slice(0, 3);
            const lead = h.lift != null
              ? `${h.name} over-indexes ${h.lift.toFixed(2)}x vs the general going-out crowd (lift rank ${h.rank}, raw heat rank ${h.heat_rank}).`
              : `${h.name} is heat rank ${h.rank} for this audience (${Math.round(h.heat * 100)}).`;
            const parts = [lead, `Anchors: ${a3.map((a: Json) => a.name).join(", ")}.`];
            if (brands[0]) parts.push(`Co-launch with ${brands[0].name}; aim at ${age}.`);
            return {
              neighborhood_id: h.neighborhood_id,
              anchor_ids: a3.map((a: Json) => a.place_id),
              ...(brands.length ? { brand_ids: brands.slice(0, 1).map((b: Json) => b.brand_id) } : {}),
              angle: parts.join(" ").slice(0, 260),
            };
          });
          const names = ranked.map((r) => r.h.name);
          const how = mem.hoods.some((h) => h.lift != null) ? "the neighbourhoods where this audience over-indexes most against the metro's general going-out crowd (Qloo heat lift)" : "the hottest Qloo taste-heat neighbourhoods for this audience";
          const summary = `${names.length} ${fmt} site${names.length === 1 ? "" : "s"} for ${req.brand}, led by ${names.slice(0, 2).join(" and ")}: ${how} that also have strong anchor places. Every place and brand comes from a Qloo result in this run, with affinity scores attached.`;
          return turn("Choosing sites by heat and anchor strength. The server checks every ID against what Qloo returned.", [call("submit_site_plan", { sites, summary })]);
        }

        const submitted = results.get("submit_site_plan")?.[0];
        if (submitted) return turn(submitted.status === "accepted" ? "Plan accepted." : `Plan rejected: ${JSON.stringify(submitted.errors)}`);
        const err = [...results.values()].flat().find((b) => b.status === "error");
        return turn(err ? `A tool failed: ${err.error}` : "Nothing left to do.");
      },
    };
  }

  async complete(_o: CompleteOptions): Promise<string> {
    throw new Error("The scripted provider has no free-text mode. Dry-run baselines come from recorded fixtures.");
  }
}
