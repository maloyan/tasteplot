// The "Without Qloo" side of the side-by-side: the same brief to an LLM with no
// tools, then every neighbourhood and anchor place it names is checked against Qloo.
import { SEED_TYPES, type QlooClient } from "../qloo/client";
import type { LLMProvider } from "../llm/types";
import type { Transcript } from "../llm/replay";
import { findMetro, findNeighborhoodByName, type Metro } from "../shared/metros";
import { haversineKm, nameSimilarity, slug } from "../qloo/fixtures/util";
import type { BaselineCheckedSite, BaselineReport, BaselineSite, SiteRequest } from "../shared/types";
import { pickEntity, pickTag, rankNeighborhoods } from "./tools";
import quietcup from "../../fixtures/llm/baseline/quietcup-coffee-roasters.json";
import lowtide from "../../fixtures/llm/baseline/lowtide-supply-co.json";
import folio from "../../fixtures/llm/baseline/folio-and-fern-books.json";

const BASELINE_FIXTURES: Record<string, Transcript> = {
  "quietcup-coffee-roasters": quietcup as unknown as Transcript,
  "lowtide-supply-co": lowtide as unknown as Transcript,
  "folio-and-fern-books": folio as unknown as Transcript,
};

export const BASELINE_BRANDS = ["Quietcup Coffee Roasters", "Lowtide Supply Co.", "Folio & Fern Books"];

export function baselineFixture(brand: string): Transcript | undefined {
  return BASELINE_FIXTURES[slug(brand)];
}

export const BASELINE_SYSTEM = "You are an experienced retail site-selection consultant. Answer with JSON only.";

export function baselinePrompt(r: SiteRequest, metro: Metro): string {
  return `A brand called "${r.brand}" wants to open a ${r.format === "popup" ? "pop-up" : "store"} in ${metro.name}.
Its target customer: ${r.audience || "(not described)"}. These customers love: ${r.seeds.join(", ") || "(none given)"}.
Recommend the ${r.sites} best neighbourhoods. For each, name 2 or 3 specific real businesses in that neighbourhood that this audience already loves (anchor places for co-marketing).
Return only JSON in this shape: {"sites":[{"neighborhood":"...","anchors":["...","..."],"reason":"..."}]}`;
}

/** Extract the sites array from model text. Tolerates code fences and prose around the JSON. */
export function parseBaseline(text: string): BaselineSite[] {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fence ? fence[1]! : text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  let obj: unknown;
  try { obj = JSON.parse(raw); } catch { throw new Error("Baseline output is not valid JSON."); }
  const sites = (obj as { sites?: unknown }).sites;
  if (!Array.isArray(sites)) throw new Error("Baseline JSON has no sites array.");
  return sites
    .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
    .map((s) => ({
      neighborhood: String(s.neighborhood ?? ""),
      anchors: Array.isArray(s.anchors) ? s.anchors.map(String).filter(Boolean).slice(0, 4) : [],
      reason: s.reason ? String(s.reason) : undefined,
    }))
    .filter((s) => s.neighborhood);
}

/**
 * Check each baseline site against Qloo.
 * Area: the neighbourhood's rank in this audience's Qloo heatmap. hot = top half of the
 * neighbourhoods with heat; cold = the rest; unknown = not a neighbourhood in the gazetteer.
 * Anchor: GET /search types=urn:entity:place. verified = a name match inside the named
 * neighbourhood (1.5 x its radius); wrong_area = a name match elsewhere; not_found = no match.
 */
export async function verifyBaseline(sites: BaselineSite[], r: SiteRequest, qloo: QlooClient): Promise<BaselineCheckedSite[]> {
  const metro = findMetro(r.metro)!;
  // The same audience signal the agent uses, with the same lookups (so live calls hit the cache).
  const [ents, tags] = await Promise.all([
    Promise.all(r.seeds.map((s) => qloo.search(s, SEED_TYPES, 8).then((h) => { const p = pickEntity(h, s, r.picks?.[s]); return (p.pick ?? p.ambiguous?.[0])?.id; }))),
    Promise.all(r.audience.split(",").map((k) => k.trim()).filter(Boolean).slice(0, 4).map((k) => qloo.findTags(k, 8).then((t) => pickTag(t, k)?.id))),
  ]);
  const signal = { entities: ents.filter((x): x is string => !!x), tags: tags.filter((x): x is string => !!x) };
  const ranked = signal.entities.length || signal.tags.length ? rankNeighborhoods(await qloo.heatmap(signal, metro.query), metro).filter((h) => h.cells > 0) : [];
  const half = Math.ceil(ranked.length / 2);

  return Promise.all(
    sites.map(async (s): Promise<BaselineCheckedSite> => {
      const gaz = findNeighborhoodByName(metro, s.neighborhood);
      const h = gaz ? ranked.find((x) => x.id === gaz.id) : undefined;
      const checkedAnchors = await Promise.all(
        s.anchors.map(async (name) => {
          const hits = (await qloo.search(name, ["urn:entity:place"], 5)).filter((p) => nameSimilarity(p.name, name) >= 0.6);
          if (!hits.length) return { name, verdict: "not_found" as const };
          const inside = gaz ? hits.find((p) => p.location && haversineKm(p.location, gaz) <= gaz.radiusKm * 1.5) : hits[0];
          return inside ? { name, verdict: "verified" as const, match: inside.name } : { name, verdict: "wrong_area" as const, match: hits[0]!.name };
        }),
      );
      return {
        ...s,
        areaVerdict: !gaz || !h ? (gaz ? "cold" : "unknown") : h.rank <= half ? "hot" : "cold",
        heatRank: h?.rank,
        heat: h?.heat,
        checkedAnchors,
      };
    }),
  );
}

export function scoreBaseline(sites: BaselineCheckedSite[]): BaselineReport["score"] {
  const anchors = sites.flatMap((s) => s.checkedAnchors);
  return {
    areas: sites.length,
    areasHot: sites.filter((s) => s.areaVerdict === "hot").length,
    anchors: anchors.length,
    anchorsVerified: anchors.filter((a) => a.verdict === "verified").length,
    anchorsWrongArea: anchors.filter((a) => a.verdict === "wrong_area").length,
    anchorsNotFound: anchors.filter((a) => a.verdict === "not_found").length,
  };
}

/**
 * The answer for a brief that the dry-run cannot compare: no LLM to ask and no recorded
 * answer. It is a normal result, not an error, and it costs 0 Qloo calls.
 */
export function unavailableBaseline(r: SiteRequest, model: string): BaselineReport {
  return {
    brand: r.brand,
    source: "unavailable",
    model,
    sites: [],
    score: { areas: 0, areasHot: 0, anchors: 0, anchorsVerified: 0, anchorsWrongArea: 0, anchorsNotFound: 0 },
    note: `The public demo runs at $0 with a scripted planner, so there is no LLM to ask for a no-tools answer. Recorded LLM-only answers exist for ${BASELINE_BRANDS.join(", ")}: try one of those sample briefs, or run Tasteplot with an LLM key.`,
  };
}

export async function runBaseline(r: SiteRequest, o: { llm: LLMProvider; qloo: QlooClient }): Promise<BaselineReport> {
  const metro = findMetro(r.metro);
  if (!metro) throw new Error(`Unknown metro "${r.metro}".`);
  let text: string;
  let source: BaselineReport["source"];
  let model: string;
  if (o.llm.dryRun) {
    const fx = baselineFixture(r.brand);
    if (!fx || !fx.completions[0]) return unavailableBaseline(r, o.llm.id);
    text = fx.completions[0];
    source = fx.source === "recorded" ? "recorded" : "illustrative-fixture";
    model = fx.provider;
  } else {
    text = await o.llm.complete({ system: BASELINE_SYSTEM, prompt: baselinePrompt(r, metro), maxTokens: 4000 });
    source = "live";
    model = o.llm.id;
  }
  const sites = parseBaseline(text);
  const checked = await verifyBaseline(sites, r, o.qloo);
  return { brand: r.brand, source, model, sites: checked, score: scoreBaseline(checked) };
}
