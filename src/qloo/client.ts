// Typed Qloo client. One method per Qloo workflow that Tasteplot uses.
// Every method: builds query params -> checks them (insights only) -> sends
// through the transport -> passes the body through one adapter in ./types.
import {
  adaptCompare,
  adaptDemographics,
  adaptHeatmap,
  adaptInsightsEntities,
  adaptSearch,
  adaptTags,
  type QlooComparison,
  type QlooDemographics,
  type QlooEntity,
  type QlooHeatCell,
  type QlooTag,
} from "./types";
import { checkInsightsParams, QlooParamError, toQuery, wktPoint, type InsightType } from "./params";
import { budgetTransport, QlooBudgetError, type Budget, type Transport } from "./transport";

export { QlooBudgetError };

/** Endpoint paths. All [LIVE] (hackathon host, 2026-10-06). */
export const PATHS = {
  search: "/search",
  insights: "/v2/insights",
  tags: "/v2/tags",
  compare: "/v2/analysis/compare",
} as const;

/**
 * Entity types for seed lookup: everything a customer can "love" plus localities.
 * [LIVE] Without a types filter, "Starbucks", "Nike" or "Waterstones" return mostly
 * single stores (urn:entity:place), and "Blue Bottle Coffee" returns no brand in the
 * top 5. urn:entity:place is left out on purpose. The values are the ones /search
 * accepts (its 400 lists them); note `videogame`, not `video_game`.
 */
export const SEED_TYPES = [
  "urn:entity:brand", "urn:entity:artist", "urn:entity:author", "urn:entity:person", "urn:entity:book",
  "urn:entity:movie", "urn:entity:tv_show", "urn:entity:podcast", "urn:entity:album", "urn:entity:videogame",
  "urn:entity:locality", "urn:entity:destination",
];

/**
 * [LIVE] The baseline audience: fans of restaurants, the broadest place taste Qloo has.
 * Its heatmap is the metro's general going-out activity.
 */
export const BASELINE_TAG = "urn:tag:genre:place:restaurant";

/** An audience signal: Qloo entity IDs plus Qloo tag IDs. */
export interface Signal {
  entities: string[];
  tags: string[];
}

export interface CallRecord {
  path: string;
  params: Record<string, string>;
  ms: number;
  cached: boolean;
  count: number;
}

export interface QlooClientOptions {
  transport: Transport;
  /** "strict" throws on a parameter that Qloo would ignore. "warn" logs it and sends anyway. */
  paramMode?: "strict" | "warn";
  /**
   * Upstream budget. Pass the same object that a budgetTransport under the cache
   * uses (see makeQlooClient). With only `maxCalls`, the client wraps its own
   * transport, and every call counts.
   */
  budget?: Budget;
  maxCalls?: number;
  onCall?: (rec: CallRecord) => void;
}

type Q = Record<string, string | number | boolean | string[] | undefined>;

interface SharedState {
  calls: CallRecord[];
  warnings: string[];
  budget: Budget;
  transport: Transport;
}

export class QlooClient {
  private shared: SharedState;
  private listener?: (rec: CallRecord) => void;

  constructor(private opts: QlooClientOptions, shared?: SharedState) {
    if (shared) this.shared = shared;
    else {
      const budget = opts.budget ?? { max: opts.maxCalls, used: 0 };
      const transport = opts.budget ? opts.transport : budgetTransport(opts.transport, budget);
      this.shared = { calls: [], warnings: [], budget, transport };
    }
  }

  /** All calls made through this client and its scoped children. */
  get calls(): CallRecord[] {
    return this.shared.calls;
  }

  get warnings(): string[] {
    return this.shared.warnings;
  }

  get upstreamCalls(): number {
    return this.shared.budget.used;
  }

  /**
   * A child client that shares the budget, call log and warnings, and also
   * reports its own calls to `listener`. Each agent tool step gets one, so
   * parallel steps keep separate traces.
   */
  scoped(listener: (rec: CallRecord) => void): QlooClient {
    const c = new QlooClient(this.opts, this.shared);
    c.listener = listener;
    return c;
  }

  private async get(path: string, q: Q): Promise<unknown> {
    const params = toQuery(q);
    if (path === PATHS.insights) {
      const check = checkInsightsParams(params);
      if (!check.ok) {
        if (this.opts.paramMode === "strict") throw new QlooParamError(params["filter.type"] ?? "?", check.invalid);
        this.shared.warnings.push(`ignored-param risk on ${params["filter.type"]}: ${check.invalid.join(", ")}`);
      }
    }
    const t0 = Date.now();
    const res = await this.shared.transport({ path, params });
    const body = res.body;
    const count = countResults(body);
    const rec: CallRecord = { path, params, ms: Date.now() - t0, cached: !!res.cached, count };
    this.shared.calls.push(rec);
    this.opts.onCall?.(rec);
    this.listener?.(rec);
    if (count === 0) {
      // [DOC] An empty result with 200 OK usually means a wrong parameter.
      this.shared.warnings.push(`empty result: ${path} ${params["filter.type"] ?? params.types ?? ""} ${params["filter.location.query"] ?? params["filter.location"] ?? params.query ?? params["filter.query"] ?? ""}`.trim());
    }
    return body;
  }

  // ---- Lookup ----------------------------------------------------------

  /** [LIVE] GET /search?query=&types=&take= : entity IDs by name. `types` is a comma list. */
  async search(query: string, types: string[] = [], take = 5): Promise<QlooEntity[]> {
    return adaptSearch(await this.get(PATHS.search, { query, types, take }));
  }

  /** [LIVE] GET /v2/tags?filter.query=&take= : tag IDs by text, in Qloo's relevance order. */
  async findTags(query: string, take = 5): Promise<QlooTag[]> {
    return adaptTags(await this.get(PATHS.tags, { "filter.query": query, take }));
  }

  // ---- Insights --------------------------------------------------------

  /** Raw insights call that returns entities. Use the helpers below where possible. */
  async insights(type: InsightType, q: Q): Promise<QlooEntity[]> {
    return adaptInsightsEntities(await this.get(PATHS.insights, { "filter.type": type, ...q }));
  }

  /**
   * Where does this taste live in a metro? [LIVE] filter.type=urn:heatmap with
   * filter.location.query and signal.interests.entities / .tags. The default
   * boundary is geohash cells (6 or 7 characters, by metro). [LIVE] `take` is ignored for heatmaps, and
   * output.heatmap.boundary accepts only "urn:geohash" or "urn:entity:locality"
   * (the locality boundary returned HTTP 500 on the hackathon host), so neither is sent.
   */
  async heatmap(signal: Signal, locationQuery: string, take?: number): Promise<QlooHeatCell[]> {
    const body = await this.get(PATHS.insights, {
      "filter.type": "urn:heatmap",
      "signal.interests.entities": signal.entities,
      "signal.interests.tags": signal.tags,
      "filter.location.query": locationQuery,
      take,
    });
    return adaptHeatmap(body);
  }

  /**
   * Baseline heat for a metro: the same heatmap for a generic audience (fans of
   * restaurants, BASELINE_TAG) instead of the brand's taste signals. It shows general
   * going-out activity. [LIVE] A heatmap needs at least one signal (no signal gives
   * HTTP 400). Tasteplot divides the audience heat by this baseline to get lift, so busy
   * central areas stop winning by default. On 2026-10-06 we also tried an all-ages
   * demographic baseline (signal.demographics.age); it tracks where people live, so
   * downtown River North still over-indexed for every Chicago audience. One call per
   * metro, then cached for 7 days.
   */
  async baselineHeatmap(locationQuery: string): Promise<QlooHeatCell[]> {
    return adaptHeatmap(
      await this.get(PATHS.insights, {
        "filter.type": "urn:heatmap",
        "signal.interests.tags": [BASELINE_TAG],
        "filter.location.query": locationQuery,
      }),
    );
  }

  /**
   * Places near a point that the audience likes. [LIVE] filter.location takes a WKT
   * POINT, longitude first (latitude first returns 0 results), and
   * filter.location.radius is in metres (radius 300 kept every result within 250 m).
   */
  async placesNear(o: { signal: Signal; at: { lat: number; lon: number }; radiusM: number; tagIds?: string[]; take?: number; explain?: boolean }): Promise<QlooEntity[]> {
    return this.insights("urn:entity:place", {
      "signal.interests.entities": o.signal.entities,
      "signal.interests.tags": o.signal.tags,
      "filter.location": wktPoint(o.at),
      "filter.location.radius": Math.round(o.radiusM),
      "filter.tags": o.tagIds,
      "operator.filter.tags": o.tagIds && o.tagIds.length > 1 ? "union" : undefined,
      "feature.explainability": o.explain ? true : undefined,
      take: o.take ?? 6,
    });
  }

  /**
   * Brands with high affinity to a signal. [DOC] Brand table: signals, filter.exclude.entities, take.
   * [LIVE] filter.location is ignored for brands (same results with and without it), but
   * signal.location (WKT point) changes the ranking, so `near` sends that instead.
   */
  async brands(signal: Signal, o: { exclude?: string[]; take?: number; explain?: boolean; near?: { lat: number; lon: number }; radiusM?: number } = {}): Promise<QlooEntity[]> {
    return this.insights("urn:entity:brand", {
      "signal.interests.entities": signal.entities,
      "signal.interests.tags": signal.tags,
      "signal.location": o.near ? wktPoint(o.near) : undefined,
      "signal.location.radius": o.near && o.radiusM ? Math.round(o.radiusM) : undefined,
      "filter.exclude.entities": o.exclude,
      "feature.explainability": o.explain ? true : undefined,
      take: o.take ?? 3,
    });
  }

  /** Score given candidates against a signal. [DOC] filter.results.entities. */
  async rank(type: InsightType, signal: Signal, candidateIds: string[]): Promise<QlooEntity[]> {
    return this.insights(type, {
      "signal.interests.entities": signal.entities,
      "signal.interests.tags": signal.tags,
      "filter.results.entities": candidateIds,
      take: candidateIds.length,
    });
  }

  /** Age and gender skew of an audience. Aggregate only. [LIVE] one item per signal; the adapter averages them. */
  async demographics(signal: Signal): Promise<QlooDemographics | undefined> {
    return adaptDemographics(
      await this.get(PATHS.insights, {
        "filter.type": "urn:demographics",
        "signal.interests.entities": signal.entities,
        "signal.interests.tags": signal.tags,
      }),
    );
  }

  // ---- Analysis --------------------------------------------------------

  /** [LIVE] GET /v2/analysis/compare with a./b.signal.interests.entities -> shared tags, side-a tags, side-b tags. */
  async compare(a: string[], b: string[], take = 20): Promise<QlooComparison> {
    return adaptCompare(await this.get(PATHS.compare, { "a.signal.interests.entities": a, "b.signal.interests.entities": b, take }));
  }
}

/** Count results in any known response shape, for the empty-result warning. */
function countResults(body: unknown): number {
  if (!body || typeof body !== "object") return 0;
  const r = (body as { results?: unknown }).results;
  if (Array.isArray(r)) return r.length;
  if (r && typeof r === "object") {
    // [LIVE] compare has several lists (tags, a, b): count them all.
    const arrays = Object.values(r as Record<string, unknown>).filter(Array.isArray) as unknown[][];
    if (arrays.length) return arrays.reduce((n, a) => n + a.length, 0);
    return Object.keys(r).length;
  }
  return 0;
}
