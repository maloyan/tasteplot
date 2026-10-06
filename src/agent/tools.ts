// The agent's tools. Each tool = a zod input schema (also sent to the LLM as
// JSON Schema) + an executor that calls Qloo and writes what it saw into
// AgentState. Results go back to the LLM as compact JSON.
import { z } from "zod";
import { BASELINE_TAG, SEED_TYPES, type QlooClient } from "../qloo/client";
import type { QlooEntity, QlooHeatCell } from "../qloo/types";
import { findMetro, type Metro } from "../shared/metros";
import type { AnchorPick, AudienceComparison, BrandPick, NeighborhoodHeat, SignalRef, SiteRec, WhyChip } from "../shared/types";
import type { ToolSpec } from "../llm/types";
import { haversineKm, nameSimilarity, round } from "../qloo/fixtures/util";
import type { AgentState } from "./state";
import { buildMemo } from "./memo";

export interface ToolContext {
  qloo: QlooClient;
  state: AgentState;
  provenance: () => { qloo: "fixtures" | "live"; llm: string };
}

interface ToolDef<S extends z.ZodType> {
  name: string;
  label: (input: z.infer<S>, ctx: ToolContext) => string;
  description: string;
  schema: S;
  run: (input: z.infer<S>, ctx: ToolContext) => Promise<{ result: unknown; summary: string }>;
}

function def<S extends z.ZodType>(d: ToolDef<S>): ToolDef<S> {
  return d;
}

const hoodLabel = (ctx: ToolContext, id: string) => ctx.state.primaryHeat()?.hoods.find((h) => h.id === id)?.name ?? id;

function requireSignals(ctx: ToolContext) {
  if (!ctx.state.signals.length) throw new Error("No audience signal yet. Call resolve_audience first.");
  return ctx.state.signal();
}

function requireHood(ctx: ToolContext, id: string): NeighborhoodHeat {
  if (!ctx.state.primaryHeat()) throw new Error(`Call map_taste_heat for ${ctx.state.metro.name} first.`);
  const h = ctx.state.hood(id);
  if (!h) throw new Error(`neighborhood_id "${id}" was not returned with heat by map_taste_heat for ${ctx.state.metro.name}.`);
  return h;
}

/**
 * Taste fit of a neighbourhood, 0..1. With a baseline it is lift / 2, capped at 1:
 * 1.0x lift (same as the baseline) = 0.5, 2x or more = 1. Without a baseline it falls
 * back to raw heat. Code, not the LLM.
 */
export function tasteFit(h: { heat: number; lift?: number }): number {
  return h.lift !== undefined ? round(Math.min(1, h.lift / 2), 3) : h.heat;
}

/** Score for a site: 0.6 x taste fit + 0.4 x mean affinity of its top 3 anchors. Code, not the LLM. */
export function siteScore(fit: number, anchors: { affinity: number }[]): number {
  return round(0.6 * fit + 0.4 * topAnchorMean(anchors), 3);
}

export function topAnchorMean(anchors: { affinity: number }[]): number {
  const top = [...anchors].sort((a, b) => b.affinity - a.affinity).slice(0, 3);
  return top.length ? top.reduce((s, a) => s + a.affinity, 0) / top.length : 0;
}

/**
 * A neighbourhood ranks by lift only when its raw heat is at least this. Why: lift on a
 * cold area is noisy (0.10 / 0.05 = 2x), and a site needs some audience to start with.
 */
export const LIFT_MIN_HEAT = 0.5;

/** The gazetteer neighbourhood a cell snaps to: the nearest centre within 1.6 x its radius. */
function snapId(c: { lat: number; lon: number }, metro: Metro): string | undefined {
  let best: { id: string; d: number } | undefined;
  for (const n of metro.neighborhoods) {
    const d = haversineKm(c, n);
    if (d <= n.radiusKm * 1.6 && (!best || d < best.d)) best = { id: n.id, d };
  }
  return best?.id;
}

/** Percentile rank 0..1 of each value (ties share their mean rank). */
function percentiles(xs: number[]): number[] {
  const idx = xs.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const out = new Array<number>(xs.length);
  const den = Math.max(1, xs.length - 1);
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1]![0] === idx[i]![0]) j++;
    for (let k = i; k <= j; k++) out[idx[k]![1]] = (i + j) / 2 / den;
    i = j + 1;
  }
  return out;
}

const aggHeat = (xs: number[]) => (xs.length ? round(Math.max(...xs) * 0.6 + (xs.reduce((s, v) => s + v, 0) / xs.length) * 0.4) : 0);
const meanOf = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / xs.length;

/**
 * Snap heatmap cells to gazetteer neighbourhoods and rank them.
 * heat = 0.6 x max + 0.4 x mean cell affinity. [LIVE] Raw heat follows general
 * activity (it correlates 0.92 to 0.97 with popularity), so busy centres win for every
 * audience. With `baseline` (the going-out heatmap for the same metro, see BASELINE_TAG), each
 * neighbourhood also gets a lift: both heatmaps are re-ranked 0..1 on the cells they
 * share, and lift = (mean audience rank + 0.05) / (mean baseline rank + 0.05). The order
 * is then by lift among neighbourhoods with heat >= LIFT_MIN_HEAT, the rest by heat.
 */
export function rankNeighborhoods(cells: QlooHeatCell[], metro: Metro, baseline?: QlooHeatCell[]): NeighborhoodHeat[] {
  const raw = new Map<string, number[]>();
  for (const c of cells) {
    const id = snapId(c, metro);
    if (id) (raw.get(id) ?? raw.set(id, []).get(id)!).push(c.affinity);
  }
  const shared = new Map<string, { a: number[]; b: number[]; braw: number[] }>();
  if (baseline?.length) {
    const base = new Map(baseline.filter((c) => c.geohash).map((c) => [c.geohash, c.affinity]));
    const common = cells.filter((c) => c.geohash && base.has(c.geohash));
    const pa = percentiles(common.map((c) => c.affinity));
    const pb = percentiles(common.map((c) => base.get(c.geohash)!));
    common.forEach((c, i) => {
      const id = snapId(c, metro);
      if (!id) return;
      const g = shared.get(id) ?? shared.set(id, { a: [], b: [], braw: [] }).get(id)!;
      g.a.push(pa[i]!); g.b.push(pb[i]!); g.braw.push(base.get(c.geohash)!);
    });
  }
  const out: NeighborhoodHeat[] = metro.neighborhoods.map((n) => {
    const a = raw.get(n.id) ?? [];
    const g = shared.get(n.id);
    return {
      id: n.id, name: n.name, metroId: metro.id, lat: n.lat, lon: n.lon, heat: aggHeat(a), cells: a.length, rank: 0, heatRank: 0,
      ...(g ? { baseHeat: aggHeat(g.braw), lift: round((meanOf(g.a) + 0.05) / (meanOf(g.b) + 0.05), 2) } : {}),
    };
  });
  out.sort((a, b) => b.heat - a.heat || a.name.localeCompare(b.name));
  out.forEach((h, i) => (h.heatRank = i + 1));
  const ranked = (h: NeighborhoodHeat) => h.cells > 0 && h.lift !== undefined && h.heat >= LIFT_MIN_HEAT;
  if (out.some(ranked)) {
    out.sort((a, b) => Number(ranked(b)) - Number(ranked(a)) || (ranked(a) ? b.lift! - a.lift! : 0) || b.heat - a.heat || a.name.localeCompare(b.name));
  }
  out.forEach((h, i) => (h.rank = i + 1));
  return out;
}

function explainChip(e: QlooEntity, ctx: ToolContext): WhyChip | undefined {
  const top = [...e.explain].sort((a, b) => b.score - a.score)[0];
  if (!top) return undefined;
  const name = ctx.state.signals.find((s) => s.id === top.entityId)?.name ?? top.entityId;
  return { label: `Driven by ${name}`, score: round(top.score, 2), source: "query.explainability" };
}

const GEO_TYPES = new Set(["urn:entity:locality", "urn:entity:destination"]);
/** Type order for a seed that Qloo knows in several guises (Rapha brand vs Rapha artist, Murakami author vs person). */
const TYPE_RANK = ["urn:entity:brand", "urn:entity:artist", "urn:entity:author", "urn:entity:person", "urn:entity:book", "urn:entity:movie", "urn:entity:tv_show", "urn:entity:podcast"];
const typeRank = (t?: string) => { const i = TYPE_RANK.indexOf(t ?? ""); return i < 0 ? TYPE_RANK.length : i; };

/**
 * Choose the Qloo entity for a seed name.
 * [LIVE] One name often matches the same thing in several types (artist + person,
 * author + brand) and a chain matches many single stores. Those are not ambiguous:
 * keep the best entity per type and prefer brand > artist > author > person.
 * A name is ambiguous only when a locality or region and a taste entity match it with
 * similar popularity ("Patagonia": a region and a brand). Then the agent asks.
 */
export function pickEntity(hits: QlooEntity[], name: string, chosen?: string): { pick?: QlooEntity; ambiguous?: QlooEntity[] } {
  if (chosen) {
    const p = hits.find((h) => h.id === chosen);
    if (p) return { pick: p };
  }
  const exact = hits.filter((h) => nameSimilarity(h.name, name) >= 0.99);
  const bestPerType = new Map<string, QlooEntity>();
  for (const h of exact) {
    const k = h.type ?? "?";
    const cur = bestPerType.get(k);
    if (!cur || (h.popularity ?? 0) > (cur.popularity ?? 0)) bestPerType.set(k, h);
  }
  const kinds = [...bestPerType.values()].sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0));
  const geo = kinds.find((k) => GEO_TYPES.has(k.type ?? ""));
  const taste = kinds.filter((k) => !GEO_TYPES.has(k.type ?? "") && k.type !== "urn:entity:place").sort((a, b) => typeRank(a.type) - typeRank(b.type));
  if (geo && taste[0]) {
    const [hi, lo] = [geo, taste[0]].sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0));
    if ((hi!.popularity ?? 0) / Math.max(0.01, lo!.popularity ?? 0) < 3) return { ambiguous: [hi!, lo!] };
  }
  const pick = taste[0] ?? kinds[0] ?? hits.find((h) => nameSimilarity(h.name, name) >= 0.6);
  return { pick };
}

const stem = (w: string) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w);
const words = (x: string) => x.toLowerCase().normalize("NFKD").replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean).map(stem);

/**
 * Choose the Qloo tag for a keyword. [LIVE] /v2/tags matches on any word, so
 * "independent bookstores" returns the music genre "Independent" first. A tag counts
 * only if its name contains every word of the keyword (plural or singular). Among
 * those, the closest name wins, then Qloo's own order.
 */
export function pickTag<T extends { name: string }>(tags: T[], keyword: string): T | undefined {
  const k = words(keyword);
  if (!k.length) return undefined;
  let best: { t: T; j: number } | undefined;
  for (const t of tags) {
    const w = new Set(words(t.name));
    if (!k.every((x) => w.has(x))) continue;
    const j = k.length / new Set([...k, ...w]).size;
    if (!best || j > best.j) best = { t, j };
  }
  return best?.t;
}

// ---------------------------------------------------------------------------

const resolveAudience = def({
  name: "resolve_audience",
  description:
    "Turn the brand's audience into Qloo signals. Seeds (things the customers love) are resolved with GET /search; keywords become Qloo tags with GET /v2/tags. Returns status ok with the signals, or needs_input with candidates when a seed name is ambiguous. Always call this first.",
  schema: z.object({
    seeds: z.array(z.string().min(1)).max(6).describe("Entity names exactly as the user typed them"),
    keywords: z.array(z.string().min(2)).max(5).describe("2 to 4 short taste keywords you derive from the plain-words audience, e.g. 'specialty coffee'"),
    compare_seeds: z.array(z.string().min(1)).max(4).optional().describe("Second-audience entity names, only when the request has them"),
  }),
  label: (i) => `Resolve ${i.seeds.length} seed(s), ${i.keywords.length} keyword(s)`,
  run: async ({ seeds, keywords, compare_seeds }, ctx) => {
    const st = ctx.state;
    st.signals = []; st.compareSignals = []; st.unresolved = [];
    const picks = st.request.picks ?? {};
    const toRef = (e: QlooEntity, from: string): SignalRef => ({ id: e.id, name: e.name, kind: "entity", type: e.type, popularity: e.popularity, disambiguation: e.disambiguation, from });
    // Seeds are looked up without single stores first (SEED_TYPES). Only a name with
    // no match there gets a second lookup that includes places.
    const lookup = async (name: string) => {
      const hits = await ctx.qloo.search(name, SEED_TYPES, 8);
      return hits.some((h) => nameSimilarity(h.name, name) >= 0.6) ? hits : ctx.qloo.search(name, [], 5);
    };
    const [seedHits, tagHits, cmpHits] = await Promise.all([
      Promise.all(seeds.map(lookup)),
      Promise.all(keywords.map((k) => ctx.qloo.findTags(k, 8))),
      Promise.all((compare_seeds ?? []).map(lookup)),
    ]);
    for (let i = 0; i < seeds.length; i++) {
      const name = seeds[i]!;
      const { pick, ambiguous } = pickEntity(seedHits[i]!, name, picks[name]);
      if (ambiguous) {
        st.needsInput = { seed: name, candidates: ambiguous.map((e) => ({ id: e.id, name: e.name, type: e.type, disambiguation: e.disambiguation, popularity: e.popularity })) };
        return { result: { status: "needs_input", question: `Which "${name}" do you mean?`, candidates: st.needsInput.candidates }, summary: `"${name}" matches ${ambiguous.length} Qloo entities. Asking the user.` };
      }
      if (pick) st.signals.push(toRef(pick, name)); else st.unresolved.push(name);
    }
    for (let i = 0; i < keywords.length; i++) {
      const k = keywords[i]!;
      const tags = tagHits[i]!;
      const t = pickTag(tags, k);
      if (t && !st.signals.some((s) => s.id === t.id)) st.signals.push({ id: t.id, name: t.name, kind: "tag", type: t.type, from: k });
      else if (!t) st.unresolved.push(k);
    }
    for (let i = 0; i < (compare_seeds ?? []).length; i++) {
      const name = compare_seeds![i]!;
      const { pick } = pickEntity(cmpHits[i]!, name, picks[name]);
      if (pick) st.compareSignals.push(toRef(pick, name)); else st.unresolved.push(name);
    }
    if (!st.signals.length) return { result: { status: "empty", message: "No seed or keyword matched a Qloo entity or tag.", unresolved: st.unresolved }, summary: "No signal" };
    return {
      result: {
        status: "ok",
        signals: st.signals.map((s) => ({ signal_id: s.id, name: s.name, kind: s.kind, type: s.type ?? null, from: s.from })),
        compare_signals: st.compareSignals.map((s) => ({ signal_id: s.id, name: s.name, type: s.type ?? null })),
        unresolved: st.unresolved,
        metro_id: st.metro.id,
        compare_metro_id: st.compareMetro?.id ?? null,
      },
      summary: `${st.signals.filter((s) => s.kind === "entity").length} entities, ${st.signals.filter((s) => s.kind === "tag").length} tags${st.unresolved.length ? `; not found: ${st.unresolved.join(", ")}` : ""}`,
    };
  },
});

const MAP_CELLS = 700;

const mapTasteHeat = def({
  name: "map_taste_heat",
  description:
    "Map where the audience's taste lives in a metro (GET /v2/insights filter.type=urn:heatmap, filter.location.query=<metro>, signal.interests.entities and .tags = the audience). Code snaps the heat cells to named neighbourhoods and ranks them. Call it for the main metro, and for the compare metro if the request has one.",
  schema: z.object({ metro_id: z.string().describe("metro_id or compare_metro_id from resolve_audience") }),
  label: (i) => `Map taste heat in ${findMetro(i.metro_id)?.name ?? i.metro_id}`,
  run: async ({ metro_id }, ctx) => {
    const signal = requireSignals(ctx);
    const st = ctx.state;
    const metro = [st.metro, st.compareMetro].find((m) => m?.id === metro_id);
    if (!metro) throw new Error(`metro_id "${metro_id}" is not in this request. Use ${[st.metro.id, st.compareMetro?.id].filter(Boolean).join(" or ")}.`);
    // The main metro also gets the going-out baseline heatmap, in parallel, for lift.
    // A failed baseline (quota, HTTP error) is not fatal: the ranking falls back to raw heat.
    const primary = metro.id === st.metro.id;
    const [cells, baseline] = await Promise.all([
      ctx.qloo.heatmap(signal, metro.query),
      primary
        ? ctx.qloo.baselineHeatmap(metro.query).catch((e: Error) => { ctx.qloo.warnings.push(`baseline heatmap failed, ranking by raw heat: ${e.message}`); return undefined; })
        : Promise.resolve(undefined),
    ]);
    const hoods = rankNeighborhoods(cells, metro, baseline);
    // [LIVE] A metro returns 1,700 to 3,600 geohash cells. All of them rank the
    // neighbourhoods; only the hottest MAP_CELLS go to the map, to keep the plan small.
    const mapCells = [...cells].sort((a, b) => b.affinity - a.affinity).slice(0, MAP_CELLS);
    st.heat.set(metro.id, { metro, cells: mapCells.map((c) => ({ lat: c.lat, lon: c.lon, geohash: c.geohash, affinity: c.affinity, popularity: c.popularity })), hoods });
    const hot = hoods.filter((h) => h.cells > 0);
    if (!hot.length) return { result: { status: "empty", metro_id, message: `No heat cells near a known neighbourhood in ${metro.name}.` }, summary: "No heat" };
    const withLift = hot.some((h) => h.lift !== undefined);
    const rawTop = [...hot].sort((a, b) => a.heatRank - b.heatRank)[0]!;
    return {
      result: {
        status: "ok",
        metro_id,
        heat_cells: cells.length,
        ranked_by: withLift ? `lift vs the metro's going-out baseline (neighbourhoods with heat >= ${LIFT_MIN_HEAT} first)` : "raw heat",
        neighborhoods: hot.map((h) => ({ neighborhood_id: h.id, name: h.name, rank: h.rank, heat: h.heat, heat_rank: h.heatRank, lift: h.lift ?? null, base_heat: h.baseHeat ?? null, fit: tasteFit(h), cells: h.cells })),
      },
      summary: withLift
        ? `${cells.length} cells → ${hot.length} neighbourhoods. Top by lift: ${hot.slice(0, 3).map((h) => `${h.name} ${h.lift!.toFixed(2)}×`).join(", ")}. Raw heat leader: ${rawTop.name} ${rawTop.heat}`
        : `${cells.length} cells → ${hot.length} neighbourhoods. Top: ${hot.slice(0, 3).map((h) => `${h.name} ${h.heat}`).join(", ")}`,
    };
  },
});

const audienceProfile = def({
  name: "audience_profile",
  description:
    "Aggregate age and gender skew of the audience (GET /v2/insights filter.type=urn:demographics with the audience signal). Aggregate only: never infer anything about a person. Use it for the marketing angle.",
  schema: z.object({}),
  label: () => "Audience profile",
  run: async (_i, ctx) => {
    const signal = requireSignals(ctx);
    const d = await ctx.qloo.demographics(signal);
    const age = d?.age ?? {};
    const topAge = Object.entries(age).sort((a, b) => b[1] - a[1])[0]?.[0];
    ctx.state.audience = { age, gender: d?.gender ?? {}, topAge };
    return { result: { age_skew: age, gender_skew: d?.gender ?? {}, strongest_age_bucket: topAge ?? null }, summary: topAge ? `Skews ${topAge.replace(/_/g, " ")}` : "No demographics" };
  },
});

const findAnchors = def({
  name: "find_anchor_places",
  description:
    "Places inside one neighbourhood that the audience already loves: cafes, shops, galleries, bars (GET /v2/insights filter.type=urn:entity:place, filter.location=WKT POINT of the neighbourhood centre, filter.location.radius in metres, audience signals, feature.explainability=true). These are anchor tenants and co-marketing partners.",
  schema: z.object({ neighborhood_id: z.string() }),
  label: (i, ctx) => `Anchor places in ${hoodLabel(ctx, i.neighborhood_id)}`,
  run: async ({ neighborhood_id }, ctx) => {
    const signal = requireSignals(ctx);
    const hood = requireHood(ctx, neighborhood_id);
    const gaz = ctx.state.metro.neighborhoods.find((n) => n.id === neighborhood_id)!;
    let found = await ctx.qloo.placesNear({ signal, at: gaz, radiusM: gaz.radiusKm * 1000, take: 6, explain: true });
    if (!found.length) {
      ctx.qloo.warnings.push(`no places within ${gaz.radiusKm} km of ${gaz.name}; retried at 1.6x radius`);
      found = await ctx.qloo.placesNear({ signal, at: gaz, radiusM: gaz.radiusKm * 1600, take: 6, explain: true });
    }
    const picks: AnchorPick[] = found.map((e) => {
      const at = e.location ?? { lat: gaz.lat, lon: gaz.lon };
      const why: WhyChip[] = [{ label: "Audience affinity", score: round(e.affinity ?? 0, 2), source: "query.affinity" }];
      const ex = explainChip(e, ctx);
      if (ex) why.push(ex);
      return {
        id: e.id, name: e.name, address: e.address, lat: at.lat, lon: at.lon, affinity: round(e.affinity ?? 0, 3),
        tags: e.tags.map((t) => t.name), distanceM: Math.round(haversineKm(at, gaz) * 1000), why,
      };
    });
    ctx.state.anchors.set(neighborhood_id, picks);
    return {
      result: { neighborhood_id, heat: hood.heat, places: picks.map((p) => ({ place_id: p.id, name: p.name, affinity: p.affinity, tags: p.tags.slice(0, 2), distance_m: p.distanceM })) },
      summary: picks.length ? picks.slice(0, 3).map((p) => `${p.name} ${p.affinity.toFixed(2)}`).join(", ") : "No places",
    };
  },
});

const findBrands = def({
  name: "find_partner_brands",
  description:
    "Brands to partner with in one neighbourhood: brands with high affinity for the audience plus the fans of that neighbourhood's top anchor place (GET /v2/insights filter.type=urn:entity:brand, signal.interests.entities = audience + top anchor, signal.location = the neighbourhood centre, filter.exclude.entities = the seeds). Call find_anchor_places for the neighbourhood first.",
  schema: z.object({ neighborhood_id: z.string() }),
  label: (i, ctx) => `Partner brands for ${hoodLabel(ctx, i.neighborhood_id)}`,
  run: async ({ neighborhood_id }, ctx) => {
    const signal = requireSignals(ctx);
    requireHood(ctx, neighborhood_id);
    const gaz = ctx.state.metro.neighborhoods.find((n) => n.id === neighborhood_id)!;
    const anchors = ctx.state.anchors.get(neighborhood_id);
    if (!anchors) throw new Error(`Call find_anchor_places for ${neighborhood_id} first.`);
    const top = anchors[0];
    const found = await ctx.qloo.brands(
      { entities: [...signal.entities, ...(top ? [top.id] : [])], tags: signal.tags },
      { exclude: signal.entities, take: 3, explain: true, near: gaz, radiusM: gaz.radiusKm * 1000 },
    );
    const picks: BrandPick[] = found.map((e) => {
      const why: WhyChip[] = [{ label: "Audience affinity", score: round(e.affinity ?? 0, 2), source: "query.affinity" }];
      const ex = explainChip(e, ctx);
      if (ex) why.push(ex);
      return { id: e.id, name: e.name, affinity: round(e.affinity ?? 0, 3), tags: e.tags.map((t) => t.name), why };
    });
    ctx.state.brands.set(neighborhood_id, picks);
    return {
      result: { neighborhood_id, via_anchor: top?.name ?? null, brands: picks.map((b) => ({ brand_id: b.id, name: b.name, affinity: b.affinity })) },
      summary: picks.length ? picks.map((b) => `${b.name} ${b.affinity.toFixed(2)}`).join(", ") : "No brands",
    };
  },
});

const compareAudiences = def({
  name: "compare_audiences",
  description:
    "Compare the main audience with the second audience (GET /v2/analysis/compare, a.signal.interests.entities = main seeds, b.signal.interests.entities = second seeds). Returns the taste tags both share and the tags only one side has. tag_overlap = shared tags / all tags. Only when the request has a second audience.",
  schema: z.object({}),
  label: () => "Compare the two audiences",
  run: async (_i, ctx) => {
    const st = ctx.state;
    const a = st.signals.filter((s) => s.kind === "entity");
    const b = st.compareSignals;
    if (!a.length || !b.length) throw new Error("compare_audiences needs entity seeds on both sides. The request has no resolved second audience.");
    const cmp = await ctx.qloo.compare(a.map((s) => s.id), b.map((s) => s.id));
    // [LIVE] results.tags = tags both sides share (with a score); results.a / results.b =
    // each side's tags. A tag leans to a side when only that side has it.
    const sharedIds = new Set(cmp.shared.map((t) => t.id));
    const all: AudienceComparison["tags"] = [
      ...cmp.shared.map((t) => ({ name: t.name, lean: "shared" as const, score: t.score !== undefined ? round(t.score, 2) : undefined })),
      ...cmp.a.filter((t) => !sharedIds.has(t.id)).map((t) => ({ name: t.name, lean: "a" as const })),
      ...cmp.b.filter((t) => !sharedIds.has(t.id)).map((t) => ({ name: t.name, lean: "b" as const })),
    ];
    // [LIVE] Two tag IDs can share a name (two "Fashion" tags): show each name once per side.
    const tags = all.filter((t, i) => all.findIndex((u) => u.lean === t.lean && u.name === t.name) === i);
    const union = new Set([...cmp.shared, ...cmp.a, ...cmp.b].map((t) => t.id)).size;
    st.audienceCompare = { a, b, tags, overlap: union ? round(sharedIds.size / union, 3) : undefined };
    const lean = (side: "a" | "b" | "shared") => tags.filter((t) => t.lean === side).slice(0, 4).map((t) => t.name);
    return {
      result: { shared: lean("shared"), leans_main: lean("a"), leans_second: lean("b"), tag_overlap: st.audienceCompare.overlap ?? null },
      summary: `Overlap ${st.audienceCompare.overlap !== undefined ? Math.round(st.audienceCompare.overlap * 100) + "%" : "n/a"}. Main leans ${lean("a").slice(0, 2).join(", ") || "none"}`,
    };
  },
});

const submitSite = z.object({
  neighborhood_id: z.string(),
  anchor_ids: z.array(z.string()).min(1).max(4),
  brand_ids: z.array(z.string()).max(2).optional(),
  angle: z.string().min(1).max(260).describe("One-line rationale for this site, grounded in the data"),
});

const submitPlan = def({
  name: "submit_site_plan",
  description:
    "Submit the final site plan. Every neighborhood_id, anchor_id and brand_id must come from an earlier tool result in this run for that neighbourhood, or the plan is rejected with a list of errors. Code computes each site's score and the final order.",
  schema: z.object({ sites: z.array(submitSite).min(1).max(5), summary: z.string().min(1).max(800) }),
  label: (i) => `Submit ${i.sites.length}-site plan`,
  run: async ({ sites, summary }, ctx) => {
    const st = ctx.state;
    const errors = groundingErrors(st, sites);
    if (errors.length) return { result: { status: "rejected", errors }, summary: `Rejected: ${errors.length} grounding error(s)` };
    const built: SiteRec[] = sites.map((s) => {
      const hood = st.hood(s.neighborhood_id)!;
      const anchors = s.anchor_ids.map((id) => st.anchors.get(s.neighborhood_id)!.find((a) => a.id === id)!);
      const brands = (s.brand_ids ?? []).map((id) => st.brands.get(s.neighborhood_id)!.find((b) => b.id === id)!);
      const score = siteScore(tasteFit(hood), anchors);
      const meanTop = round(topAnchorMean(anchors), 2);
      const why: WhyChip[] = [{ label: "Taste heat (raw)", score: round(hood.heat, 2), source: `urn:heatmap query.affinity, snapped to the neighbourhood. Raw heat rank ${hood.heatRank}.` }];
      if (hood.lift !== undefined) {
        why.push({ label: "Lift vs baseline", score: tasteFit(hood), display: `${hood.lift.toFixed(2)}×`, source: `Audience heat ÷ the metro's going-out heat (Qloo heatmap for fans of restaurants, ${BASELINE_TAG}) on the same cells. Baseline heat ${hood.baseHeat?.toFixed(2) ?? "n/a"}. Bar = lift ÷ 2.` });
      }
      why.push({ label: "Anchor affinity (top 3)", score: meanTop, source: "urn:entity:place query.affinity" });
      const ex = anchors.flatMap((a) => a.why.filter((w) => w.source === "query.explainability"))[0];
      if (ex) why.push(ex);
      return { rank: 0, neighborhood: hood, score, anchors, brands, angle: s.angle, why };
    });
    built.sort((a, b) => b.score - a.score);
    built.forEach((s, i) => (s.rank = i + 1));
    const prim = st.primaryHeat()!;
    st.plan = {
      brand: st.request.brand,
      request: st.request,
      metro: { id: st.metro.id, name: st.metro.name, lat: st.metro.lat, lon: st.metro.lon },
      signals: st.signals,
      audience: st.audience,
      sites: built,
      summary,
      memoMarkdown: "",
      heatmap: prim.cells,
      neighborhoods: prim.hoods,
      metroCompare: st.metroCompare(),
      audienceCompare: st.audienceCompare,
      provenance: { ...ctx.provenance(), qlooCalls: ctx.qloo.calls.length, llmTurns: 0, ms: 0, warnings: [] },
    };
    st.plan.memoMarkdown = buildMemo(st.plan);
    return { result: { status: "accepted", sites: built.map((s) => ({ rank: s.rank, neighborhood_id: s.neighborhood.id, score: s.score })) }, summary: `Accepted: ${built.length} sites, top ${built[0]!.neighborhood.name} (${Math.round(built[0]!.score * 100)})` };
  },
});

/** Every ID in the plan must be one the agent observed from Qloo in this run. */
export function groundingErrors(state: AgentState, sites: z.infer<typeof submitSite>[]): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  const max = state.request.sites;
  if (sites.length > max) errors.push(`The request asks for ${max} site(s), the plan has ${sites.length}.`);
  for (const s of sites) {
    const where = `site ${s.neighborhood_id}`;
    if (seen.has(s.neighborhood_id)) errors.push(`${where}: neighbourhood appears twice.`);
    seen.add(s.neighborhood_id);
    if (!state.hood(s.neighborhood_id)) { errors.push(`${where}: neighborhood_id not returned with heat by map_taste_heat for ${state.metro.name}.`); continue; }
    const anchors = state.anchors.get(s.neighborhood_id);
    if (!anchors) errors.push(`${where}: call find_anchor_places for this neighbourhood first.`);
    else for (const id of s.anchor_ids) if (!anchors.some((a) => a.id === id)) errors.push(`${where}: anchor_id "${id}" was not returned by find_anchor_places for this neighbourhood.`);
    if (new Set(s.anchor_ids).size !== s.anchor_ids.length) errors.push(`${where}: an anchor_id appears twice.`);
    for (const id of s.brand_ids ?? []) {
      if (!(state.brands.get(s.neighborhood_id) ?? []).some((b) => b.id === id)) errors.push(`${where}: brand_id "${id}" was not returned by find_partner_brands for this neighbourhood.`);
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------

export const TOOLS = [resolveAudience, mapTasteHeat, audienceProfile, findAnchors, findBrands, compareAudiences, submitPlan] as const;
const BY_NAME = new Map<string, ToolDef<z.ZodType>>(TOOLS.map((t) => [t.name, t as unknown as ToolDef<z.ZodType>]));

export function toolSpecs(): ToolSpec[] {
  return TOOLS.map((t) => {
    const schema = z.toJSONSchema(t.schema) as Record<string, unknown>;
    delete schema.$schema;
    return { name: t.name, description: t.description, input_schema: schema };
  });
}

export function getTool(name: string): ToolDef<z.ZodType> | undefined {
  return BY_NAME.get(name);
}
