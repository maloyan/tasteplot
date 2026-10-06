// Qloo wire types and adapters.
//
// RULE: every Qloo response passes through one adapter in this file before any
// other code reads it. Downstream code uses only the normalised types below.
// When the live API shows a different shape, fix the adapter here and nothing else.
//
// Each schema is "loose": unknown fields pass through, most fields are optional.
// Status tags (see docs/QLOO_API_ASSUMPTIONS.md for the full list):
//   [LIVE]  seen in a live hackathon API response on 2026-10-06
//           (curated copies: fixtures/qloo/recorded/)
//   [DOC]   shown in a docs.qloo.com example or schema read on 2026-10-05
import { z } from "zod";

// ---------------------------------------------------------------------------
// Normalised types (what the rest of the app uses)
// ---------------------------------------------------------------------------

export interface QlooTag {
  id: string;
  name: string;
  type?: string;
}

export interface QlooEntity {
  id: string;
  name: string;
  type?: string;
  popularity?: number;
  /** query.affinity for insights results. 0..1. */
  affinity?: number;
  tags: QlooTag[];
  location?: { lat: number; lon: number };
  address?: string;
  disambiguation?: string;
  /** feature.explainability output: which input entity drove this result. */
  explain: { entityId: string; score: number }[];
  properties: Record<string, unknown>;
}

export interface QlooHeatCell {
  lat: number;
  lon: number;
  geohash: string;
  affinity: number;
  popularity: number;
}

export interface QlooDemographics {
  age: Record<string, number>;
  gender: Record<string, number>;
}

/** One tag in an /v2/analysis/compare result. */
export interface QlooCompareTag {
  id: string;
  name: string;
  /** results.tags only: Qloo's score for a tag that both sides share. */
  score?: number;
  /** results.a / results.b only: how many entities on that side carry the tag. */
  count?: number;
}

/**
 * [LIVE] /v2/analysis/compare returns three tag lists: `tags` (shared by both
 * sides, with query.score), `a` (tags of side a, with query.count) and `b`.
 */
export interface QlooComparison {
  shared: QlooCompareTag[];
  a: QlooCompareTag[];
  b: QlooCompareTag[];
}

// ---------------------------------------------------------------------------
// Wire schemas
// ---------------------------------------------------------------------------

const Tag = z.looseObject({
  // [DOC] Tags inside entity results: { id, name, type } (basic-insights-use-case).
  // [DOC] Tags from /v2/tags and filter.type=urn:tag: { tag_id, name, types[], subtype, tag_value } (taste-analysis example).
  id: z.string().optional(),
  tag_id: z.string().optional(),
  name: z.string().optional(),
  type: z.string().optional(),
  types: z.array(z.string()).optional(),
  subtype: z.string().optional(),
});

const Location = z.looseObject({
  // [LIVE] Places (in /search and in insights) carry `location: { lat, lon, geohash }`.
  // [LIVE] Heatmap cells carry `location: { latitude, longitude, geohash }`.
  // The adapter also reads `properties.geocode.latitude/longitude` as a fallback.
  // With no coordinates, the caller uses the neighbourhood centre it sent in filter.location.
  lat: z.number().optional(),
  lon: z.number().optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  geohash: z.string().optional(),
});

const Entity = z.looseObject({
  // [LIVE] entity_id, name, popularity, disambiguation, properties, location, tags.
  entity_id: z.string().optional(),
  id: z.string().optional(),
  name: z.string().optional(),
  // [LIVE] /search returns `types: ["urn:entity:brand"]`. Insights returns
  // `type: "urn:entity"` and `subtype: "urn:entity:place"`, so subtype wins.
  type: z.string().optional(),
  types: z.array(z.string()).optional(),
  subtype: z.string().optional(),
  disambiguation: z.string().optional(),
  popularity: z.number().optional(),
  properties: z.looseObject({}).optional(),
  tags: z.array(Tag).optional(),
  location: Location.optional(),
  // [LIVE] insights results carry `query.affinity` (0..1) and, for places with
  // filter.location, `query.distance` (metres). feature.explainability=true adds
  // `query.explainability: { "signal.interests.entities": [{ entity_id, score }] }`.
  // Tag signals get no explainability entry. The adapter also accepts a map { <id>: score }.
  query: z
    .looseObject({
      affinity: z.number().optional(),
      explainability: z.unknown().optional(),
    })
    .optional(),
});

const SearchResponse = z.looseObject({
  // [LIVE] GET /search -> { results: [{ entity_id, name, types[], popularity, disambiguation, properties, location?, tags }] }
  results: z.array(Entity).optional(),
});

const TagsResponse = z.looseObject({
  // [LIVE] GET /v2/tags -> { success, duration, results: { tags: [{ id, name, type, popularity, parents[] }] } }
  results: z.looseObject({ tags: z.array(Tag).optional() }).optional(),
});

const InsightsEntitiesResponse = z.looseObject({
  // [DOC] GET /v2/insights (filter.type=urn:entity:*) -> { success, results: { entities: [...] } }
  success: z.boolean().optional(),
  results: z.looseObject({ entities: z.array(Entity).optional() }).optional(),
});

const HeatCellWire = z.looseObject({
  // [LIVE] heatmap cells: { location: { latitude, longitude, geohash (6 or 7 chars by metro) }, query: { affinity, affinity_rank, popularity, ... } }.
  // affinity is a 0..1 rank inside the metro (cells come sorted by it). `take` is ignored: a metro returns 1,700 to 3,600 cells.
  location: Location.optional(),
  query: z
    .looseObject({
      affinity: z.number().optional(),
      affinity_rank: z.number().optional(),
      popularity: z.number().optional(),
    })
    .optional(),
});

const HeatmapResponse = z.looseObject({
  results: z.looseObject({ heatmap: z.array(HeatCellWire).optional() }).optional(),
});

const DemographicsResponse = z.looseObject({
  // [LIVE] filter.type=urn:demographics works on the hackathon host ->
  // { results: { demographics: [{ entity_id, query: { age: {...}, gender: {...} } }] } }
  // with ONE item per signal (each entity and each tag), not one for the whole audience.
  results: z
    .looseObject({
      demographics: z
        .array(
          z.looseObject({
            entity_id: z.string().optional(),
            query: z
              .looseObject({
                age: z.record(z.string(), z.number()).optional(),
                gender: z.record(z.string(), z.number()).optional(),
              })
              .optional(),
          }),
        )
        .optional(),
    })
    .optional(),
});

const CompareTag = z.looseObject({
  tag_id: z.string().optional(),
  id: z.string().optional(),
  name: z.string().optional(),
  query: z.looseObject({ score: z.number().optional(), count: z.union([z.string(), z.number()]).optional() }).optional(),
});

const CompareResponse = z.looseObject({
  // [LIVE] GET /v2/analysis/compare -> { duration, results: { tags: [shared, query.score], a: [query.count], b: [query.count], matchEntities: [] } }
  results: z
    .looseObject({
      tags: z.array(CompareTag).optional(),
      a: z.array(CompareTag).optional(),
      b: z.array(CompareTag).optional(),
    })
    .optional(),
});

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

export class QlooShapeError extends Error {
  constructor(public endpoint: string, public issues: string) {
    super(`Qloo response for ${endpoint} did not match the expected shape: ${issues}`);
    this.name = "QlooShapeError";
  }
}

function parse<T>(schema: z.ZodType<T>, body: unknown, endpoint: string): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new QlooShapeError(endpoint, r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  return r.data;
}

function toTag(t: z.infer<typeof Tag>): QlooTag | undefined {
  const id = t.id ?? t.tag_id;
  if (!id) return undefined;
  return { id, name: t.name ?? id, type: t.type ?? t.subtype ?? t.types?.[0] };
}

function toLocation(e: z.infer<typeof Entity>): { lat: number; lon: number } | undefined {
  const l = e.location;
  const lat = l?.lat ?? l?.latitude;
  const lon = l?.lon ?? l?.longitude;
  if (typeof lat === "number" && typeof lon === "number") return { lat, lon };
  const geo = (e.properties as Record<string, unknown> | undefined)?.geocode as Record<string, unknown> | undefined;
  const glat = geo?.latitude, glon = geo?.longitude;
  if (typeof glat === "number" && typeof glon === "number") return { lat: glat, lon: glon };
  return undefined;
}

/** [LIVE] { "signal.interests.entities": [{ entity_id, score }] }. A map { <id>: score } is accepted too. */
function toExplain(raw: unknown): { entityId: string; score: number }[] {
  if (!raw) return [];
  const out: { entityId: string; score: number }[] = [];
  const visit = (v: unknown) => {
    if (Array.isArray(v)) {
      for (const item of v) {
        if (item && typeof item === "object") {
          const o = item as Record<string, unknown>;
          const id = (o.entity_id ?? o.id) as string | undefined;
          const score = (o.score ?? o.weight ?? o.affinity) as number | undefined;
          if (typeof id === "string" && typeof score === "number") out.push({ entityId: id, score });
          else visit(o);
        }
      }
    } else if (v && typeof v === "object") {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (typeof val === "number" && k.length > 8) out.push({ entityId: k, score: val });
        else visit(val);
      }
    }
  };
  visit(raw);
  return out;
}

function toEntity(e: z.infer<typeof Entity>): QlooEntity | undefined {
  const id = e.entity_id ?? e.id;
  if (!id || !e.name) return undefined;
  const props = (e.properties ?? {}) as Record<string, unknown>;
  const subtype = e.subtype?.startsWith("urn:entity:") ? e.subtype : undefined;
  return {
    id,
    name: e.name,
    type: subtype ?? e.types?.[0] ?? e.type,
    popularity: e.popularity,
    affinity: e.query?.affinity,
    tags: (e.tags ?? []).map(toTag).filter((t): t is QlooTag => !!t),
    location: toLocation(e),
    address: typeof props.address === "string" ? props.address : undefined,
    disambiguation: e.disambiguation ?? (typeof props.short_description === "string" ? props.short_description : undefined),
    explain: toExplain(e.query?.explainability),
    properties: props,
  };
}

const defined = <T>(x: T | undefined): x is T => x !== undefined;

export function adaptSearch(body: unknown): QlooEntity[] {
  return (parse(SearchResponse, body, "/search").results ?? []).map(toEntity).filter(defined);
}

export function adaptTags(body: unknown): QlooTag[] {
  return (parse(TagsResponse, body, "/v2/tags").results?.tags ?? []).map(toTag).filter(defined);
}

export function adaptInsightsEntities(body: unknown): QlooEntity[] {
  return (parse(InsightsEntitiesResponse, body, "/v2/insights").results?.entities ?? []).map(toEntity).filter(defined);
}

export function adaptHeatmap(body: unknown): QlooHeatCell[] {
  const cells = parse(HeatmapResponse, body, "/v2/insights (heatmap)").results?.heatmap ?? [];
  return cells
    .map((c): QlooHeatCell | undefined => {
      const lat = c.location?.latitude ?? c.location?.lat;
      const lon = c.location?.longitude ?? c.location?.lon;
      if (typeof lat !== "number" || typeof lon !== "number") return undefined;
      return {
        lat,
        lon,
        geohash: c.location?.geohash ?? "",
        affinity: c.query?.affinity ?? 0,
        popularity: c.query?.popularity ?? 0,
      };
    })
    .filter(defined);
}

/** [LIVE] One item per signal. The audience skew is the mean over all items, per bucket. */
export function adaptDemographics(body: unknown): QlooDemographics | undefined {
  const items = (parse(DemographicsResponse, body, "/v2/insights (demographics)").results?.demographics ?? []).filter((d) => d.query);
  if (!items.length) return undefined;
  const mean = (pick: (q: NonNullable<(typeof items)[number]["query"]>) => Record<string, number> | undefined) => {
    const sum = new Map<string, { s: number; n: number }>();
    for (const it of items) {
      for (const [k, v] of Object.entries(pick(it.query!) ?? {})) {
        const a = sum.get(k) ?? { s: 0, n: 0 };
        a.s += v; a.n++;
        sum.set(k, a);
      }
    }
    return Object.fromEntries([...sum].map(([k, { s, n }]) => [k, Math.round((s / n) * 100) / 100]));
  };
  return { age: mean((q) => q.age), gender: mean((q) => q.gender) };
}

export function adaptCompare(body: unknown): QlooComparison {
  const r = parse(CompareResponse, body, "/v2/analysis/compare").results;
  const conv = (items: z.infer<typeof CompareTag>[] | undefined): QlooCompareTag[] =>
    (items ?? [])
      .map((t): QlooCompareTag | undefined => {
        const id = t.tag_id ?? t.id;
        if (!id) return undefined;
        const count = t.query?.count !== undefined ? Number(t.query.count) : undefined;
        return { id, name: t.name ?? id, score: t.query?.score, count: Number.isFinite(count) ? count : undefined };
      })
      .filter(defined);
  return { shared: conv(r?.tags), a: conv(r?.a), b: conv(r?.b) };
}
