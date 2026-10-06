// Everything the agent has observed from Qloo in one run. The grounding check
// in submit_site_plan accepts only IDs that are in this state: the LLM cannot
// cite a neighbourhood, a place or a brand that no Qloo call returned.
import type { Signal } from "../qloo/client";
import type { AnchorPick, AudienceComparison, AudienceProfile, BrandPick, HeatCell, MetroComparison, NeighborhoodHeat, SeedCandidate, SignalRef, SitePlan, SiteRequest } from "../shared/types";
import type { Metro } from "../shared/metros";

export interface MetroHeat {
  metro: Metro;
  cells: HeatCell[];
  /** All gazetteer neighbourhoods, ranked by heat (cold ones last, heat 0). */
  hoods: NeighborhoodHeat[];
}

export class AgentState {
  signals: SignalRef[] = [];
  compareSignals: SignalRef[] = [];
  unresolved: string[] = [];
  needsInput?: { seed: string; candidates: SeedCandidate[] };
  heat = new Map<string, MetroHeat>();
  anchors = new Map<string, AnchorPick[]>();
  brands = new Map<string, BrandPick[]>();
  audience?: AudienceProfile;
  audienceCompare?: AudienceComparison;
  plan?: SitePlan;

  constructor(public request: SiteRequest, public metro: Metro, public compareMetro?: Metro) {}

  /** The audience as a Qloo signal: entity IDs plus tag IDs. */
  signal(): Signal {
    return {
      entities: this.signals.filter((s) => s.kind === "entity").map((s) => s.id),
      tags: this.signals.filter((s) => s.kind === "tag").map((s) => s.id),
    };
  }

  primaryHeat(): MetroHeat | undefined {
    return this.heat.get(this.metro.id);
  }

  hood(id: string): NeighborhoodHeat | undefined {
    return this.primaryHeat()?.hoods.find((h) => h.id === id && h.cells > 0);
  }

  metroCompare(): MetroComparison | undefined {
    const b = this.compareMetro && this.heat.get(this.compareMetro.id);
    const a = this.primaryHeat();
    if (!a || !b) return undefined;
    const fit = (m: MetroHeat) => {
      const top = m.hoods.filter((h) => h.cells > 0).sort((x, y) => x.heatRank - y.heatRank).slice(0, 3);
      const topHeat = top.length ? top.reduce((s, h) => s + h.heat, 0) / top.length : 0;
      const hotShare = m.cells.length ? m.cells.filter((c) => c.affinity >= 0.5).length / m.cells.length : 0;
      return { metroId: m.metro.id, name: m.metro.name, topHeat: Math.round(topHeat * 1000) / 1000, hotShare: Math.round(hotShare * 1000) / 1000, top: top.map((h) => ({ name: h.name, heat: h.heat })) };
    };
    const fa = fit(a), fb = fit(b);
    return { a: fa, b: fb, winner: fa.topHeat >= fb.topHeat ? fa.metroId : fb.metroId };
  }
}
