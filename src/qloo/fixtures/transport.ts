// Fixture transport: answers Qloo requests from the synthetic world in the
// wire shapes of the live hackathon API (checked on 2026-10-06; curated live
// copies are in fixtures/qloo/recorded/). The values are synthetic, the shapes are real.
//
// It mirrors these endpoints: /search, /v2/tags, /v2/insights (urn:heatmap,
// urn:demographics, urn:entity:place, urn:entity:brand), /v2/analysis/compare.
import { METROS, findMetro, type Metro } from "../../shared/metros";
import { QlooHttpError, type QlooRequest, type QlooResponse, type Transport } from "../transport";
import { checkInsightsParams } from "../params";
import { BASELINE_TAG } from "../client";
import { clamp01, geohashEncode, haversineKm, nameSimilarity, noise, round } from "./util";
import {
  affinity, audienceVec, AXES, BY_ID, neighborhoodHeat, TAG_BY_ID, TAGS, WORLD, type TasteVec, type WorldEntity,
} from "./world";

const list = (v: string | undefined) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : []);
const num = (v: string | undefined, d: number) => (v !== undefined && Number.isFinite(Number(v)) ? Number(v) : d);

function wireTag(id: string) {
  const t = TAG_BY_ID.get(id);
  return t ? { id: t.id, name: t.name, type: t.type } : undefined;
}

function wireEntity(e: WorldEntity, extra: Record<string, unknown> = {}) {
  const metro = e.neighborhoodId ? METROS.find((m) => e.neighborhoodId!.startsWith(`${m.id}:`)) : undefined;
  return {
    entity_id: e.id,
    name: e.name,
    type: e.type,
    types: [e.type],
    disambiguation: e.disambiguation,
    popularity: e.popularity,
    properties: {
      ...(e.address ? { address: e.address } : {}),
      ...(e.lat !== undefined ? { geocode: { name: metro?.name, city: metro?.name, latitude: e.lat, longitude: e.lon } } : {}),
    },
    tags: e.tagIds.map(wireTag).filter(Boolean),
    ...(e.lat !== undefined ? { location: { lat: e.lat, lon: e.lon, geohash: geohashEncode(e.lat, e.lon!, 7) } } : {}),
    ...extra,
  };
}

/** The audience a request describes: its signal entities and signal tags. */
function signalOf(p: Record<string, string>): { ids: string[]; vec: TasteVec; salt: string } {
  const ids = list(p["signal.interests.entities"]);
  const tags = list(p["signal.interests.tags"]);
  return { ids, vec: audienceVec(ids, tags), salt: [...ids, ...tags].join(",") };
}

const hasSignal = (s: { vec: TasteVec }) => Object.keys(s.vec).length > 0;

function bad(path: string, message: string): never {
  throw new QlooHttpError(400, path, JSON.stringify({ error: message }));
}

function search(p: Record<string, string>) {
  const q = p.query ?? "";
  const types = list(p.types);
  const take = num(p.take, 20);
  const hits = WORLD.filter((e) => types.length === 0 || types.includes(e.type))
    .map((e) => ({ e, s: nameSimilarity(q, e.name) }))
    .filter((x) => x.s >= 0.6)
    .sort((a, b) => b.s - a.s || b.e.popularity - a.e.popularity)
    .slice(0, take);
  return { success: true, duration: 3, results: hits.map(({ e }) => wireEntity(e)) };
}

function tags(p: Record<string, string>) {
  const q = (p["filter.query"] ?? "").toLowerCase().trim();
  const take = Math.min(50, num(p.take, 20));
  const words = q.split(/\s+/).filter((w) => w.length > 2);
  const found = TAGS.filter((t) => t.type !== "urn:tag:category:place")
    .map((t) => ({ t, s: Math.max(nameSimilarity(q, t.name), words.some((w) => t.name.toLowerCase().includes(w.replace(/s$/, ""))) ? 0.5 : 0) }))
    .filter((x) => x.s >= 0.5)
    .sort((a, b) => b.s - a.s)
    .slice(0, take);
  // [LIVE] item shape: { id, name, type, popularity, parents[], properties, tags }.
  return { success: true, duration: 3, results: { tags: found.map(({ t }) => ({ id: t.id, name: t.name, type: t.type, popularity: 0.9, parents: [], properties: {}, tags: [] })) } };
}

/** Parse a WKT POINT(lon lat). */
function parsePoint(wkt: string | undefined): { lat: number; lon: number } | undefined {
  const m = wkt?.match(/^POINT\(\s*(-?[\d.]+)\s+(-?[\d.]+)\s*\)$/i);
  return m ? { lon: Number(m[1]), lat: Number(m[2]) } : undefined;
}

function locality(path: string, query: string | undefined): Metro | undefined {
  if (!query) return undefined;
  const m = findMetro(query);
  // [DOC] "If no localities are found, the API returns a 400 error."
  if (!m) bad(path, `No locality found for filter.location.query=${query}. Fixture localities: ${METROS.map((x) => x.name).join(", ")}.`);
  return m;
}

function heatmap(path: string, p: Record<string, string>) {
  const sig = signalOf(p);
  // The baseline audience (fans of restaurants, see BASELINE_TAG in ../client) gets a density-only heat.
  const broad = p["signal.interests.tags"] === BASELINE_TAG && !p["signal.interests.entities"];
  if (!hasSignal(sig) && !broad) bad(path, "at least one valid signal or filter is required");
  const metro = locality(path, p["filter.location.query"]);
  if (!metro) bad(path, "filter.location.query or filter.location is required for urn:heatmap");
  if (broad) return broadHeatmap(metro);
  const heats = metro.neighborhoods.map((n) => ({ n, h: neighborhoodHeat(sig.vec, n, sig.salt) }));
  // A geohash-6 grid (about 0.6 x 1.2 km) over the metro. Each cell's raw value is the
  // strongest neighbourhood heat, falling off with distance from that neighbourhood.
  const cells: { location: { latitude: number; longitude: number; geohash: string }; query: { affinity: number; affinity_rank: number; popularity: number } }[] = [];
  const latStep = 0.0055, lonStep = 0.011;
  for (let lat = metro.lat - 0.11; lat <= metro.lat + 0.11; lat += latStep) {
    for (let lon = metro.lon - 0.16; lon <= metro.lon + 0.16; lon += lonStep) {
      let v = 0;
      let pop = 0.1;
      for (const { n, h } of heats) {
        const d = haversineKm({ lat, lon }, n) / (n.radiusKm * 1.3);
        v = Math.max(v, h * Math.exp(-d * d));
        pop = Math.max(pop, Math.exp(-d * d) * 0.9);
      }
      const gh = geohashEncode(lat, lon, 6);
      v = clamp01(v * (0.9 + noise(`${sig.salt}|${gh}`) * 0.2));
      if (v < 0.1) continue;
      cells.push({ location: { latitude: round(lat, 6), longitude: round(lon, 6), geohash: gh }, query: { affinity: round(v, 4), affinity_rank: 0, popularity: round(pop, 4) } });
    }
  }
  cells.sort((a, b) => b.query.affinity - a.query.affinity);
  cells.forEach((c, i) => (c.query.affinity_rank = round(1 - i / Math.max(1, cells.length), 4)));
  const take = p.take ? num(p.take, 200) : 200;
  return { success: true, results: { heatmap: cells.slice(0, take) } };
}

/**
 * Fixture baseline: general going-out heat follows density only. Each neighbourhood weighs
 * the same, so the cell value is the distance falloff from the nearest centre. Same
 * grid and geohashes as the audience heatmap, all cells (like live, no `take`).
 */
function broadHeatmap(metro: Metro) {
  const cells: { location: { latitude: number; longitude: number; geohash: string }; query: { affinity: number; popularity: number } }[] = [];
  const latStep = 0.0055, lonStep = 0.011;
  for (let lat = metro.lat - 0.11; lat <= metro.lat + 0.11; lat += latStep) {
    for (let lon = metro.lon - 0.16; lon <= metro.lon + 0.16; lon += lonStep) {
      let v = 0;
      for (const n of metro.neighborhoods) {
        const d = haversineKm({ lat, lon }, n) / (n.radiusKm * 1.3);
        v = Math.max(v, Math.exp(-d * d) * 0.9);
      }
      const gh = geohashEncode(lat, lon, 6);
      v = clamp01(v * (0.9 + noise(`baseline|${gh}`) * 0.2));
      if (v < 0.1) continue;
      cells.push({ location: { latitude: round(lat, 6), longitude: round(lon, 6), geohash: gh }, query: { affinity: round(v, 4), popularity: round(v, 4) } });
    }
  }
  cells.sort((a, b) => b.query.affinity - a.query.affinity);
  return { success: true, results: { heatmap: cells } };
}

function explain(sigIds: string[], target: WorldEntity, a: number) {
  // [LIVE] shape: { "signal.interests.entities": [{ entity_id, score }] }.
  const scored = sigIds
    .map((id) => {
      const e = BY_ID.get(id);
      if (!e) return undefined;
      return { entity_id: id, score: round(clamp01(affinity(e.taste, target, "explain") * (0.7 + a * 0.3))) };
    })
    .filter((x): x is { entity_id: string; score: number } => !!x && x.score >= 0.1);
  return { "signal.interests.entities": scored };
}

function entities(path: string, p: Record<string, string>, type: "urn:entity:place" | "urn:entity:brand") {
  const sig = signalOf(p);
  const take = Math.min(50, num(p.take, 20));
  const only = list(p["filter.results.entities"]);
  const exclude = new Set([...list(p["filter.exclude.entities"]), ...sig.ids]);
  let pool = WORLD.filter((e) => e.type === type && !exclude.has(e.id));
  if (type === "urn:entity:brand") pool = pool.filter((e) => e.disambiguation === "Fictional fixture brand" || only.includes(e.id));
  if (only.length) pool = pool.filter((e) => only.includes(e.id));

  if (type === "urn:entity:place") {
    const at = parsePoint(p["filter.location"]);
    if (p["filter.location"] && !at) bad(path, `filter.location must be a WKT POINT, got ${p["filter.location"]}`);
    const radiusKm = num(p["filter.location.radius"], 15000) / 1000;
    if (at) pool = pool.filter((e) => e.lat !== undefined && haversineKm(at, { lat: e.lat, lon: e.lon! }) <= radiusKm);
    const metro = locality(path, p["filter.location.query"]);
    if (metro) pool = pool.filter((e) => e.neighborhoodId?.startsWith(`${metro.id}:`));
    const tagFilter = list(p["filter.tags"]);
    if (tagFilter.length) {
      const union = (p["operator.filter.tags"] ?? "union") === "union";
      pool = pool.filter((e) => (union ? tagFilter.some((t) => e.tagIds.includes(t)) : tagFilter.every((t) => e.tagIds.includes(t))));
    }
  }

  const scored = pool.map((e) => ({ e, a: hasSignal(sig) ? affinity(sig.vec, e, sig.salt) : round(e.popularity) }));
  scored.sort((x, y) => y.a - x.a || x.e.id.localeCompare(y.e.id));
  const wantExplain = p["feature.explainability"] === "true";
  return {
    success: true,
    results: {
      entities: scored.slice(0, take).map(({ e, a }) =>
        // [LIVE] insights entities: type "urn:entity", subtype "urn:entity:place" | "urn:entity:brand".
        wireEntity(e, { type: "urn:entity", subtype: e.type, query: { affinity: a, ...(wantExplain && sig.ids.length ? { explainability: explain(sig.ids, e, a) } : {}) } }),
      ),
    },
  };
}

function demographics(path: string, p: Record<string, string>) {
  const sig = signalOf(p);
  if (!hasSignal(sig)) bad(path, "at least one valid signal or filter is required");
  // [LIVE] one item per signal (each entity, then each tag).
  const ids = list(p["signal.interests.entities"]).filter((id) => BY_ID.has(id));
  const tagIds = list(p["signal.interests.tags"]).filter((id) => TAG_BY_ID.has(id));
  const items = [...tagIds.map((id) => ({ id, vec: audienceVec([], [id]) })), ...ids.map((id) => ({ id, vec: audienceVec([id], []) }))];
  return { success: true, results: { demographics: items.map(({ id, vec }) => ({ entity_id: id, query: skewOf(vec, `${sig.salt}:${id}`) })) } };
}

function skewOf(v: TasteVec, salt: string) {
  const g = (k: (typeof AXES)[number]) => v[k] ?? 0;
  const young = g("streetwear") * 0.5 + g("sneakers") * 0.4 + g("skate") * 0.5 + g("hiphop") * 0.4 + g("nightlife") * 0.3 + g("indie") * 0.2;
  const old = g("family") * 0.4 + g("luxury") * 0.3 + g("wine") * 0.2 + g("outdoor") * 0.15 + g("literary") * 0.15;
  const skew = (young - old) / 1.2;
  const n = (k: string) => (noise(`${salt}:${k}`) - 0.5) * 0.1;
  const age = {
    "24_and_younger": round(skew * 0.6 + n("a1"), 2),
    "25_to_29": round(skew * 0.35 + 0.12 + n("a2"), 2),
    "30_to_34": round(0.1 - Math.abs(skew) * 0.1 + n("a3"), 2),
    "35_to_44": round(-skew * 0.25 + n("a4"), 2),
    "45_to_54": round(-skew * 0.45 - 0.08 + n("a5"), 2),
    "55_and_older": round(-skew * 0.6 - 0.12 + n("a6"), 2),
  };
  const male = round((g("streetwear") * 0.3 + g("cycling") * 0.3 + g("sneakers") * 0.2 - g("literary") * 0.3 - g("design") * 0.15 - g("fashion") * 0.2) * 0.7 + n("g"), 2);
  return { age, gender: { male, female: round(-male, 2) } };
}

function compare(path: string, p: Record<string, string>) {
  const a = list(p["a.signal.interests.entities"]);
  const b = list(p["b.signal.interests.entities"]);
  if (!a.length || !b.length) bad(path, "a.signal.interests.entities and b.signal.interests.entities are required");
  const va = audienceVec(a, []), vb = audienceVec(b, []);
  const take = num(p.take, 20);
  const items = TAGS.filter((t) => t.type !== "urn:tag:category:place")
    .map((t) => ({ t, sa: round(clamp01((va[t.axis] ?? 0) + (noise(`cmpA:${a}:${t.id}`) - 0.5) * 0.06), 3), sb: round(clamp01((vb[t.axis] ?? 0) + (noise(`cmpB:${b}:${t.id}`) - 0.5) * 0.06), 3) }))
    .filter((x) => Math.max(x.sa, x.sb) >= 0.2)
    .sort((x, y) => Math.max(y.sa, y.sb) - Math.max(x.sa, x.sb))
    .slice(0, take);
  // [LIVE] shape: results.tags = shared tags with query.score; results.a / results.b = each side's tags with query.count.
  const wire = (t: (typeof items)[number]["t"], query: Record<string, unknown>) => ({ tag_id: t.id, name: t.name, type: "urn:tag", subtype: t.type, query });
  const onA = items.filter((x) => x.sa >= 0.3), onB = items.filter((x) => x.sb >= 0.3);
  const shared = items.filter((x) => x.sa >= 0.3 && x.sb >= 0.3);
  return {
    duration: 3,
    results: {
      tags: shared.map((x) => wire(x.t, { score: round((x.sa + x.sb) / 2, 3) })),
      a: onA.map((x) => wire(x.t, { count: String(a.length) })),
      b: onB.map((x) => wire(x.t, { count: String(b.length) })),
      matchEntities: [],
    },
  };
}

export interface FixtureTransportOptions {
  /** Simulate latency so the trace panel animates like the real thing. */
  latencyMs?: number;
}

export function fixtureTransport(opts: FixtureTransportOptions = {}): Transport {
  return async (req: QlooRequest): Promise<QlooResponse> => {
    if (opts.latencyMs) await new Promise((r) => setTimeout(r, opts.latencyMs! * (0.5 + noise(JSON.stringify(req)))));
    const p = req.params;
    switch (req.path) {
      case "/search": return { status: 200, body: search(p) };
      case "/v2/tags": return { status: 200, body: tags(p) };
      case "/v2/analysis/compare": return { status: 200, body: compare(req.path, p) };
      case "/v2/insights": {
        // Like the live API, an invalid param is ignored, not rejected.
        void checkInsightsParams(p);
        const t = p["filter.type"];
        if (t === "urn:heatmap") return { status: 200, body: heatmap(req.path, p) };
        if (t === "urn:demographics") return { status: 200, body: demographics(req.path, p) };
        if (t === "urn:entity:place" || t === "urn:entity:brand") return { status: 200, body: entities(req.path, p, t) };
        return { status: 200, body: { success: true, results: { entities: [] } } };
      }
      default:
        throw new QlooHttpError(404, req.path, "fixture transport has no route for this path");
    }
  };
}
