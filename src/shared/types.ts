// Domain types shared by the agent, the server and the web app.
// These are Tasteplot types, not Qloo wire types. The Qloo wire types and
// their adapters live in src/qloo/types.ts.

export interface GeoPoint {
  lat: number;
  lon: number;
}

export interface WhyChip {
  /** Short human label, for example "Audience affinity". */
  label: string;
  /** 0..1 score from Qloo (affinity, explainability weight) or from code that combines them. */
  score: number;
  /** Which Qloo field (or which code formula) the score came from. Shown in the UI tooltip. */
  source: string;
  /** Text shown instead of score.toFixed(2), for example "1.46×" for a lift. */
  display?: string;
}

/** What the brand sent: a plain-words audience and a few things its customers love. */
export interface SiteRequest {
  /** The brand's own name. Only used in text, never sent to Qloo. */
  brand: string;
  /** Plain words about the customer, comma separated, for example "specialty coffee, cycling, vinyl". */
  audience: string;
  /** Entity names the customers love: brands, artists, places, books, films. */
  seeds: string[];
  /** Metro id or name from the gazetteer. */
  metro: string;
  /** Optional second metro for a side-by-side fit check. */
  compareMetro?: string;
  /** Optional second audience (entity names) to compare with the first one. */
  compareSeeds?: string[];
  format: "store" | "popup";
  /** How many neighbourhoods to recommend (1 to 5). */
  sites: number;
  /** Seed name -> Qloo entity id, set when the user resolved an ambiguous seed. */
  picks?: Record<string, string>;
}

/** One resolved audience signal: a Qloo entity or a Qloo tag. */
export interface SignalRef {
  id: string;
  name: string;
  kind: "entity" | "tag";
  /** Qloo entity type (urn:entity:brand) or tag type. */
  type?: string;
  popularity?: number;
  disambiguation?: string;
  /** The text the user typed that produced this signal. */
  from: string;
}

export interface HeatCell extends GeoPoint {
  geohash: string;
  affinity: number;
  popularity: number;
}

/** A gazetteer neighbourhood with the Qloo heat that snapped to it. */
export interface NeighborhoodHeat extends GeoPoint {
  id: string;
  name: string;
  metroId: string;
  /** Aggregated heatmap affinity of the cells that snap here, 0..1. */
  heat: number;
  /** Number of heatmap cells that snapped here. */
  cells: number;
  /**
   * 1 = best neighbourhood for this audience. With a baseline, the order is by lift
   * (neighbourhoods with heat >= LIFT_MIN_HEAT first); without one, by raw heat.
   */
  rank: number;
  /** 1 = highest raw heat. Raw heat follows general activity, so busy centres rank high here. */
  heatRank: number;
  /** Same aggregate over the going-out baseline heatmap (fans of restaurants), on the same cells. 0..1. */
  baseHeat?: number;
  /**
   * Over-index: mean audience heat / mean baseline heat over the cells both heatmaps
   * share (each re-ranked 0..1 on those cells). 1.0 = same as the general going-out crowd of the metro.
   */
  lift?: number;
}

export interface AnchorPick extends GeoPoint {
  id: string;
  name: string;
  address?: string;
  /** Qloo query.affinity of the audience for this place, 0..1. */
  affinity: number;
  tags: string[];
  /** Metres from the neighbourhood centre. */
  distanceM: number;
  why: WhyChip[];
}

export interface BrandPick {
  id: string;
  name: string;
  affinity: number;
  tags: string[];
  why: WhyChip[];
}

export interface AudienceProfile {
  /** Age bucket with the strongest positive skew, for example "25_to_29". */
  topAge?: string;
  /** Map of age bucket to Qloo's demographic value. */
  age: Record<string, number>;
  /** Map of gender to Qloo's demographic value. Aggregate only, never per person. */
  gender: Record<string, number>;
}

export interface SiteRec {
  rank: number;
  neighborhood: NeighborhoodHeat;
  /** Site score: 0.6 x heat + 0.4 x mean affinity of the top 3 anchors (code, not the LLM). */
  score: number;
  anchors: AnchorPick[];
  brands: BrandPick[];
  /** One-line rationale written by the agent from the data. */
  angle: string;
  why: WhyChip[];
}

export interface MetroFit {
  metroId: string;
  name: string;
  /** Mean heat of the top 3 neighbourhoods. */
  topHeat: number;
  /** Share of heat cells at 0.5 affinity or more. */
  hotShare: number;
  top: { name: string; heat: number }[];
}

export interface MetroComparison {
  a: MetroFit;
  b: MetroFit;
  /** Metro id with the higher topHeat. */
  winner: string;
}

export interface AudienceComparison {
  a: SignalRef[];
  b: SignalRef[];
  /** Tags Qloo lists for the comparison, with the side they lean to. */
  tags: { name: string; lean: "a" | "b" | "shared"; score?: number }[];
  /** 0..1 overlap of the two tag sets, computed by code from the compare result. */
  overlap?: number;
}

export interface SitePlan {
  brand: string;
  request: SiteRequest;
  metro: { id: string; name: string; lat: number; lon: number };
  signals: SignalRef[];
  audience?: AudienceProfile;
  sites: SiteRec[];
  summary: string;
  memoMarkdown: string;
  heatmap: HeatCell[];
  neighborhoods: NeighborhoodHeat[];
  metroCompare?: MetroComparison;
  audienceCompare?: AudienceComparison;
  provenance: Provenance;
}

export interface Provenance {
  qloo: "fixtures" | "live";
  llm: string;
  qlooCalls: number;
  llmTurns: number;
  ms: number;
  /** Warnings collected during the run (empty results, ignored params, etc.). */
  warnings: string[];
}

/** One step in the live trace panel. */
export interface TraceStep {
  id: string;
  tool: string;
  label: string;
  status: "running" | "done" | "error";
  summary?: string;
  /** Redacted Qloo requests made by this step (path + params, never the key). */
  qloo: { path: string; params: Record<string, string>; ms: number; cached: boolean; count: number }[];
  ms?: number;
}

export interface SeedCandidate {
  id: string;
  name: string;
  type?: string;
  disambiguation?: string;
  popularity?: number;
}

/** Fresh Qloo calls left for the public demo. Cached calls and sample plans cost nothing. */
export interface QuotaInfo {
  /** UTC day the counter belongs to, YYYY-MM-DD. */
  day: string;
  /** Fresh (uncached) Qloo calls made today by this deployment. */
  used: number;
  /** Daily cap on fresh calls (DAILY_QLOO_CAP). */
  cap: number;
  remaining: number;
  /** Qloo's own x-month-ratelimit-remaining, from the last fresh call. */
  monthRemaining?: number;
  /** True when no new plan can start today. */
  exhausted: boolean;
}

export type AgentEvent =
  | { type: "start"; request: SiteRequest; mode: { qloo: string; llm: string } }
  | { type: "quota"; quota: QuotaInfo; note?: string; source?: "fresh" | "cache" | "sample" }
  | { type: "thought"; text: string }
  | { type: "step"; step: TraceStep }
  | { type: "needs_input"; question: string; seed: string; candidates: SeedCandidate[] }
  | { type: "heatmap"; metroId: string; cells: HeatCell[]; neighborhoods: NeighborhoodHeat[] }
  | { type: "plan"; plan: SitePlan }
  | { type: "error"; message: string }
  | { type: "done"; provenance: Provenance };

// ---- LLM-only baseline ---------------------------------------------------

/** hot = in the top half of Qloo heat for this audience; cold = bottom half; unknown = not a neighbourhood we can check. */
export type AreaVerdict = "hot" | "cold" | "unknown";
/** verified = a Qloo place with this name inside the named neighbourhood; wrong_area = elsewhere; not_found = no Qloo place with this name. */
export type AnchorVerdict = "verified" | "wrong_area" | "not_found";

export interface BaselineSite {
  neighborhood: string;
  anchors: string[];
  reason?: string;
}

export interface BaselineCheckedSite extends BaselineSite {
  areaVerdict: AreaVerdict;
  heatRank?: number;
  heat?: number;
  checkedAnchors: { name: string; verdict: AnchorVerdict; match?: string }[];
}

export interface BaselineReport {
  brand: string;
  /** "unavailable": the $0 demo has no LLM and no recorded answer for this brief. No Qloo call is made. */
  source: "recorded" | "illustrative-fixture" | "live" | "unavailable";
  /** Shown instead of the comparison when source is "unavailable". */
  note?: string;
  model: string;
  sites: BaselineCheckedSite[];
  score: {
    areas: number;
    areasHot: number;
    anchors: number;
    anchorsVerified: number;
    anchorsWrongArea: number;
    anchorsNotFound: number;
  };
}
