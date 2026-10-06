// Parameter check per filter.type for GET /v2/insights.
//
// Why: Qloo silently ignores a parameter that is not valid for a filter.type and
// still returns 200 OK (hackathon developer guide, "invalid parameters are
// silently ignored"). A silently ignored filter.location gives anchor places
// from the whole metro instead of one neighbourhood. So the client checks every
// insights call against this table before it sends it.
//
// Source: docs.qloo.com/reference/available-parameters-by-entity-type (the
// per-type tables), read on 2026-10-05. Two additions come from the Parameter
// Reference (docs.qloo.com/reference/parameters), which lists them for all
// entity types although the per-type tables do not: feature.explainability,
// and filter.location.query for Place. Both are marked below.

export const INSIGHT_TYPES = [
  "urn:entity:artist",
  "urn:entity:book",
  "urn:entity:brand",
  "urn:entity:destination",
  "urn:entity:movie",
  "urn:entity:person",
  "urn:entity:place",
  "urn:entity:podcast",
  "urn:entity:tv_show",
  "urn:entity:video_game",
  "urn:heatmap",
  "urn:demographics",
  "urn:tag",
] as const;
export type InsightType = (typeof INSIGHT_TYPES)[number];

const SIGNALS = [
  "signal.interests.entities",
  "signal.interests.tags",
  "operator.signal.interests.tags",
  "signal.demographics.age",
  "signal.demographics.gender",
  "signal.demographics.audiences",
  "signal.demographics.audiences.weight",
];

const ENTITY_COMMON = [
  "filter.type",
  ...SIGNALS,
  "bias.trends",
  "filter.exclude.entities",
  "filter.exclude.tags",
  "operator.exclude.tags",
  "filter.external.exists",
  "operator.filter.external.exists",
  "filter.parents.types",
  "filter.popularity.min",
  "filter.popularity.max",
  "filter.results.entities",
  "filter.results.entities.query",
  "filter.tags",
  "operator.filter.tags",
  "offset",
  "take",
  "page",
  // Parameter Reference: "Artist, Book, Brand, ... Video Game". Not in the per-type tables.
  "feature.explainability",
];

const PLACE = [
  ...ENTITY_COMMON,
  "bias.quality",
  "filter.address",
  "filter.geocode.name",
  "filter.geocode.admin1_region",
  "filter.geocode.admin2_region",
  "filter.geocode.country_code",
  "filter.hours",
  "filter.location",
  "filter.location.geohash",
  "filter.exclude.location.geohash",
  "filter.location.radius",
  // Parameter Reference lists it for "Destination, Place". Not in the Place table.
  "filter.location.query",
  "filter.price_level.min",
  "filter.price_level.max",
  "filter.properties.business_rating.min",
  "filter.properties.business_rating.max",
  "sort_by",
];

const ALLOWED: Record<InsightType, Set<string>> = {
  "urn:entity:artist": new Set(ENTITY_COMMON),
  "urn:entity:book": new Set([...ENTITY_COMMON, "filter.publication_year.min", "filter.publication_year.max"]),
  // [LIVE] signal.location changes brand results (filter.location does not). From the Parameter Reference, not the Brand table.
  "urn:entity:brand": new Set([...ENTITY_COMMON, "signal.location", "signal.location.radius"]),
  "urn:entity:destination": new Set([...ENTITY_COMMON, "filter.geocode.name", "filter.geocode.admin1_region", "filter.geocode.admin2_region", "filter.geocode.country_code", "filter.location", "filter.location.radius", "filter.location.geohash", "filter.exclude.location.geohash"]),
  "urn:entity:movie": new Set([...ENTITY_COMMON, "filter.release_year.min", "filter.release_year.max", "filter.content_rating"]),
  "urn:entity:person": new Set(ENTITY_COMMON),
  "urn:entity:place": new Set(PLACE),
  "urn:entity:podcast": new Set(ENTITY_COMMON),
  "urn:entity:tv_show": new Set([...ENTITY_COMMON, "filter.release_year.min", "filter.release_year.max", "filter.content_rating"]),
  "urn:entity:video_game": new Set(ENTITY_COMMON),
  // Heatmap table, plus bias.trends from the heatmap use-case page.
  "urn:heatmap": new Set([
    "filter.type", "filter.location", "filter.location.query", "filter.location.radius", "heatmap.dimensions",
    "filter.dimensions.hotel_class", "filter.dimensions.price_level", "output.heatmap.boundary",
    "signal.demographics.age", "signal.demographics.audiences", "signal.demographics.gender",
    "signal.interests.entities", "signal.interests.tags", "operator.signal.interests.tags", "bias.trends", "take",
  ]),
  // Demographics use-case page: entities and/or tags as the signal.
  "urn:demographics": new Set(["filter.type", "signal.interests.entities", "signal.interests.tags"]),
  "urn:tag": new Set(["filter.type", ...SIGNALS, "diversify.by", "diversify.take", "offset", "take"]),
};

export class QlooParamError extends Error {
  constructor(public filterType: string, public invalid: string[]) {
    super(`Parameters not valid for filter.type=${filterType}: ${invalid.join(", ")}. Qloo would ignore them silently.`);
    this.name = "QlooParamError";
  }
}

export interface ParamCheck {
  ok: boolean;
  invalid: string[];
}

export function checkInsightsParams(params: Record<string, string>): ParamCheck {
  const type = params["filter.type"];
  if (!type) return { ok: false, invalid: ["filter.type (missing)"] };
  const allowed = ALLOWED[type as InsightType];
  if (!allowed) return { ok: false, invalid: [`filter.type=${type} (unknown type)`] };
  const invalid = Object.keys(params).filter((k) => !allowed.has(k));
  return { ok: invalid.length === 0, invalid };
}

/** Drop undefined values and stringify the rest. Arrays become comma lists. */
export function toQuery(input: Record<string, string | number | boolean | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) {
      if (v.length === 0) continue;
      out[k] = v.join(",");
    } else out[k] = String(v);
  }
  return out;
}

/** WKT point for filter.location. [DOC] WKT is "X then Y, therefore longitude is first". */
export function wktPoint(p: { lat: number; lon: number }): string {
  return `POINT(${p.lon} ${p.lat})`;
}
