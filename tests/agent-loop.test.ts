import { describe, expect, it } from "vitest";
import { runAgent, validateRequest } from "../src/agent/loop";
import { BASELINE_TAG, QlooClient } from "../src/qloo/client";
import { fixtureTransport } from "../src/qloo/fixtures/transport";
import { ScriptedProvider } from "../src/llm/scripted";
import { ReplayProvider, RecordingProvider } from "../src/llm/replay";
import { rankNeighborhoods, siteScore, tasteFit, toolSpecs } from "../src/agent/tools";
import { EXAMPLES } from "../src/server/app";
import { findMetro } from "../src/shared/metros";
import type { SiteRequest } from "../src/shared/types";
import { collect, resultOf, ScriptProvider, tc, turn } from "./helpers";

const [COFFEE, STREET, BOOKS, AMBIG] = [EXAMPLES[0]!, EXAMPLES[1]!, EXAMPLES[2]!, EXAMPLES[3]!] as SiteRequest[] as [SiteRequest, SiteRequest, SiteRequest, SiteRequest];
const qloo = (maxCalls?: number) => new QlooClient({ transport: fixtureTransport(), paramMode: "strict", maxCalls });
const run = (req: SiteRequest, llm = new ScriptedProvider() as any, q = qloo()) => {
  const c = collect();
  return runAgent(req, { qloo: q, qlooMode: "fixtures", llm, emit: c.emit }).then((out) => ({ out, events: c.events, q }));
};

describe("agent loop (scripted dry-run policy)", () => {
  it.each([COFFEE, STREET, BOOKS])("plans $label end to end with every pick grounded in Qloo results", async (req) => {
    const { out, events, q } = await run(req);
    expect(out.stoppedBy).toBe("plan");
    const plan = out.plan!;
    expect(plan.sites).toHaveLength(req.sites);
    for (const s of plan.sites) {
      expect(out.state.hood(s.neighborhood.id)).toBeDefined();
      const seen = out.state.anchors.get(s.neighborhood.id)!.map((a) => a.id);
      for (const a of s.anchors) expect(seen).toContain(a.id);
      for (const b of s.brands) expect(out.state.brands.get(s.neighborhood.id)!.map((x) => x.id)).toContain(b.id);
      expect(s.score).toBe(siteScore(tasteFit(s.neighborhood), s.anchors));
      expect(s.neighborhood.lift).toBeGreaterThan(0);
      expect(s.why.map((w) => w.label)).toEqual(expect.arrayContaining(["Taste heat (raw)", "Lift vs baseline"]));
      expect(s.why.length).toBeGreaterThanOrEqual(2);
    }
    // Sites are ordered by the code score, not by the LLM.
    expect(plan.sites.map((s) => s.score)).toEqual([...plan.sites.map((s) => s.score)].sort((a, b) => b - a));
    expect(plan.memoMarkdown).toContain("FIXTURE DATA");
    expect(plan.memoMarkdown).toContain(plan.sites[0]!.neighborhood.name);
    expect(plan.audienceCompare?.tags.length).toBeGreaterThan(0);
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(["start", "thought", "step", "heatmap", "plan", "done"]));
    expect(events.at(-1)!.type).toBe("done");
    // Fits the Workers Free subrequest budget.
    expect(q.upstreamCalls).toBeLessThanOrEqual(48);
  });

  it("is deterministic: the same brief gives the same plan", async () => {
    const a = await run(COFFEE);
    const b = await run(COFFEE);
    expect(b.out.plan!.sites).toEqual(a.out.plan!.sites);
    expect(b.out.plan!.memoMarkdown).toEqual(a.out.plan!.memoMarkdown);
  });

  it("uses search, tags, heatmap, places, brands, demographics and compare", async () => {
    const { q } = await run(COFFEE);
    const kinds = new Set(q.calls.map((c) => `${c.path} ${c.params["filter.type"] ?? ""}`.trim()));
    for (const k of ["/search", "/v2/tags", "/v2/insights urn:heatmap", "/v2/insights urn:entity:place", "/v2/insights urn:entity:brand", "/v2/insights urn:demographics", "/v2/analysis/compare"]) {
      expect(kinds).toContain(k);
    }
  });

  it("compares two metros with one heatmap call each, plus one baseline for the main metro", async () => {
    const { out, events, q } = await run(COFFEE);
    const heatCalls = q.calls.filter((c) => c.params["filter.type"] === "urn:heatmap");
    expect(heatCalls.map((c) => [c.params["filter.location.query"], c.params["signal.interests.tags"] === BASELINE_TAG ? "baseline" : "audience"]).sort()).toEqual([["Chicago", "audience"], ["Chicago", "baseline"], ["New York", "audience"]]);
    const m = out.plan!.metroCompare!;
    expect([m.a.metroId, m.b.metroId]).toEqual(["chi", "nyc"]);
    expect(m.b.top.length).toBeGreaterThan(0);
    expect(events.filter((e) => e.type === "heatmap").map((e) => (e as { metroId: string }).metroId).sort()).toEqual(["chi", "nyc"]);
  });

  it("stops and asks on an ambiguous seed", async () => {
    const { out, events } = await run(AMBIG);
    expect(out.stoppedBy).toBe("needs_input");
    const ev = events.find((e) => e.type === "needs_input");
    expect(ev && ev.type === "needs_input" && ev.seed).toBe("Patagonia");
    expect(ev && ev.type === "needs_input" && ev.candidates.map((c) => c.type)).toEqual(["urn:entity:brand", "urn:entity:locality"]);
    expect(out.plan).toBeUndefined();
  });

  it("continues with the entity the user picked", async () => {
    const { out } = await run({ ...AMBIG, picks: { Patagonia: "fx:brand:patagonia-brand" } });
    expect(out.stoppedBy).toBe("plan");
    expect(out.plan!.signals.map((s) => s.id)).toContain("fx:brand:patagonia-brand");
  });

  it("does not invent a plan when nothing resolves", async () => {
    const { out, events } = await run({ ...COFFEE, seeds: ["Nobody Knows This Brand"], audience: "zzqx", compareSeeds: undefined });
    expect(out.plan).toBeUndefined();
    const err = events.find((e) => e.type === "error") as { message: string } | undefined;
    expect(err?.message).toMatch(/no entity or tag/);
  });
});

describe("agent loop (grounding and robustness)", () => {
  const BRIEF: SiteRequest = { ...COFFEE, compareMetro: undefined, compareSeeds: undefined, sites: 1 };
  const resolve = () => turn(tc("resolve_audience", { seeds: ["Blue Bottle Coffee"], keywords: ["specialty coffee"] }));

  it("rejects a plan that cites an invented place, and accepts the corrected plan", async () => {
    let placeId = "";
    const llm = new ScriptProvider([
      resolve,
      () => turn(tc("map_taste_heat", { metro_id: "chi" })),
      () => turn(tc("find_anchor_places", { neighborhood_id: "chi:wicker-park" })),
      (input) => {
        placeId = resultOf(input).places[0].place_id;
        return turn(tc("submit_site_plan", { sites: [{ neighborhood_id: "chi:wicker-park", anchor_ids: ["invented:the-velvet-cafe"], angle: "x" }], summary: "s" }));
      },
      (input) => {
        const r = resultOf(input);
        expect(r.status).toBe("rejected");
        expect(r.errors[0]).toMatch(/was not returned by find_anchor_places/);
        return turn(tc("submit_site_plan", { sites: [{ neighborhood_id: "chi:wicker-park", anchor_ids: [placeId], angle: "Coffee taste is hot here." }], summary: "One site." }));
      },
    ]);
    const { out } = await run(BRIEF, llm);
    expect(out.stoppedBy).toBe("plan");
    expect(out.plan!.sites[0]!.anchors[0]!.id).toBe(placeId);
  });

  it("rejects a brand that was found for another neighbourhood", async () => {
    let brandId = "";
    const llm = new ScriptProvider([
      resolve,
      () => turn(tc("map_taste_heat", { metro_id: "chi" })),
      () => turn(tc("find_anchor_places", { neighborhood_id: "chi:wicker-park" }), tc("find_anchor_places", { neighborhood_id: "chi:logan-square" })),
      () => turn(tc("find_partner_brands", { neighborhood_id: "chi:logan-square" })),
      (input) => {
        brandId = resultOf(input).brands[0].brand_id;
        return turn(tc("submit_site_plan", { sites: [{ neighborhood_id: "chi:wicker-park", anchor_ids: ["x"], brand_ids: [brandId], angle: "x" }], summary: "s" }));
      },
    ]);
    await run(BRIEF, llm);
    const r = resultOf(llm.inputs[5]!);
    expect(r.status).toBe("rejected");
    expect(r.errors.join(" ")).toMatch(/brand_id .* was not returned by find_partner_brands for this neighbourhood/);
  });

  it("rejects a neighbourhood that no heatmap call returned", async () => {
    const llm = new ScriptProvider([resolve, () => turn(tc("find_anchor_places", { neighborhood_id: "chi:wicker-park" }))]);
    await run(BRIEF, llm);
    const res = llm.inputs[2]!.toolResults![0]!;
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/Call map_taste_heat/);
  });

  it("rejects a metro that is not in the request", async () => {
    const llm = new ScriptProvider([resolve, () => turn(tc("map_taste_heat", { metro_id: "lon" }))]);
    await run(BRIEF, llm);
    expect(llm.inputs[2]!.toolResults![0]!.content).toMatch(/not in this request/);
  });

  it("returns invalid tool input and unknown tools as errors, not crashes", async () => {
    const llm = new ScriptProvider([() => turn(tc("resolve_audience", { seed: "typo" }), tc("book_a_lease", {}))]);
    await run(BRIEF, llm);
    const results = llm.inputs[1]!.toolResults!;
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.isError)).toBe(true);
    expect(results[0]!.content).toMatch(/Invalid input for resolve_audience/);
    expect(results[1]!.content).toMatch(/Unknown tool/);
  });

  it("sends all parallel tool results back in one turn", async () => {
    const llm = new ScriptProvider([resolve, () => turn(tc("map_taste_heat", { metro_id: "chi" }), tc("audience_profile", {}))]);
    await run(BRIEF, llm);
    expect(llm.inputs[2]!.toolResults).toHaveLength(2);
  });

  it("turns a Qloo budget hit into a tool error that tells the agent to submit", async () => {
    const llm = new ScriptProvider([resolve, () => turn(tc("map_taste_heat", { metro_id: "chi" }))]);
    await run(BRIEF, llm, qloo(2));
    const r = llm.inputs[2]!.toolResults![0]!;
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/budget reached.*Submit the site plan now/s);
  });

  it("stops at the turn cap", async () => {
    const llm = new ScriptProvider(Array.from({ length: 50 }, () => () => turn(tc("audience_profile", {}))));
    const c = collect();
    const out = await runAgent(BRIEF, { qloo: qloo(), qlooMode: "fixtures", llm, emit: c.emit, maxTurns: 3 });
    expect(out.turns).toBe(3);
    expect(out.stoppedBy).toBe("max_turns");
  });

  it("nudges a model that stops talking without a plan, then gives up", async () => {
    const llm = new ScriptProvider([() => turn(), () => turn(), () => turn()]);
    const { out } = await run(BRIEF, llm);
    expect(out.stoppedBy).toBe("no_progress");
    expect(llm.inputs[1]!.userText).toMatch(/not submitted a site plan/);
  });

  it("stops on a refusal", async () => {
    const llm = new ScriptProvider([() => ({ text: "", toolCalls: [], stop: "refusal" })]);
    const { out, events } = await run(BRIEF, llm);
    expect(out.stoppedBy).toBe("refusal");
    expect(events.some((e) => e.type === "error")).toBe(true);
  });
});

describe("neighbourhood ranking", () => {
  it("snaps cells to the nearest neighbourhood and ranks by heat", () => {
    const chi = findMetro("Chicago")!;
    const ranked = rankNeighborhoods(
      [
        { lat: 41.9088, lon: -87.6776, geohash: "a", affinity: 0.9, popularity: 0.5 },
        { lat: 41.909, lon: -87.678, geohash: "b", affinity: 0.7, popularity: 0.5 },
        { lat: 41.8556, lon: -87.6566, geohash: "c", affinity: 0.4, popularity: 0.5 },
        { lat: 42.5, lon: -88.5, geohash: "far", affinity: 1, popularity: 0.5 },
      ],
      chi,
    );
    expect(ranked[0]).toMatchObject({ name: "Wicker Park", cells: 2, rank: 1, heat: 0.86 });
    expect(ranked[1]).toMatchObject({ name: "Pilsen", cells: 1 });
    expect(ranked.filter((h) => h.cells > 0)).toHaveLength(2);
  });
});

describe("lift vs a going-out baseline", () => {
  const chi = findMetro("Chicago")!;
  const cell = (lat: number, lon: number, geohash: string, affinity: number) => ({ lat, lon, geohash, affinity, popularity: affinity });
  // River North is busy for everyone; Wicker Park is hot for this audience only; Hyde Park is
  // cold for it. Lift compares ranks on the shared cells, so the baseline order must differ.
  const audience = [
    cell(41.8924, -87.6341, "rn1", 1.0), cell(41.8925, -87.6342, "rn2", 0.95),
    cell(41.9088, -87.6776, "wp1", 0.9), cell(41.909, -87.678, "wp2", 0.85),
    cell(41.7943, -87.5907, "hp1", 0.2),
  ];
  const baseline = [
    cell(41.8924, -87.6341, "rn1", 1.0), cell(41.8925, -87.6342, "rn2", 0.98),
    cell(41.9088, -87.6776, "wp1", 0.05), cell(41.909, -87.678, "wp2", 0.04),
    cell(41.7943, -87.5907, "hp1", 0.3),
  ];

  it("ranks by lift, keeps the raw heat rank, and shows the baseline heat", () => {
    const ranked = rankNeighborhoods(audience, chi, baseline).filter((h) => h.cells > 0);
    expect(ranked.map((h) => h.name)).toEqual(["Wicker Park", "River North", "Hyde Park"]);
    const wp = ranked[0]!, rn = ranked[1]!;
    expect(wp).toMatchObject({ rank: 1, heatRank: 2 });
    expect(rn).toMatchObject({ rank: 2, heatRank: 1 });
    expect(wp.lift!).toBeGreaterThan(1);
    expect(rn.lift!).toBeLessThan(wp.lift!);
    expect(wp.baseHeat!).toBeLessThan(rn.baseHeat!);
  });

  it("does not let a cold neighbourhood win on a noisy lift", () => {
    const hp = rankNeighborhoods(audience, chi, baseline).find((h) => h.name === "Hyde Park")!;
    expect(hp.heat).toBeLessThan(0.5);
    expect(hp.rank).toBe(3);
  });

  it("falls back to raw heat without a baseline", () => {
    const ranked = rankNeighborhoods(audience, chi).filter((h) => h.cells > 0);
    expect(ranked.map((h) => h.name)).toEqual(["River North", "Wicker Park", "Hyde Park"]);
    expect(ranked.every((h) => h.lift === undefined && h.rank === h.heatRank)).toBe(true);
    expect(tasteFit(ranked[0]!)).toBe(ranked[0]!.heat);
  });

  it("maps lift to a 0..1 taste fit: 1.0x = 0.5, 2x and up = 1", () => {
    expect(tasteFit({ heat: 0.9, lift: 1 })).toBe(0.5);
    expect(tasteFit({ heat: 0.9, lift: 3 })).toBe(1);
  });

  it("keeps working when the baseline call fails", async () => {
    const failing = new QlooClient({
      paramMode: "strict",
      transport: async (req) => {
        if (req.params["signal.interests.tags"] === BASELINE_TAG) throw new Error("HTTP 429");
        return fixtureTransport()(req);
      },
    });
    const { out } = await run(BOOKS, new ScriptedProvider(), failing);
    expect(out.stoppedBy).toBe("plan");
    expect(out.plan!.sites.every((s) => s.neighborhood.lift === undefined)).toBe(true);
    expect(out.plan!.provenance.warnings.join(" ")).toMatch(/baseline heatmap failed/);
  });
});

describe("request validation", () => {
  it("accepts comma lists, clamps sites and drops a compare metro equal to the main one", () => {
    const r = validateRequest({ brand: " X ", audience: "coffee", seeds: "A, B,,C", metro: "Chicago", compareMetro: "chi", sites: 9, format: "popup" as const });
    expect(r).toMatchObject({ brand: "X", seeds: ["A", "B", "C"], metro: "chi", compareMetro: undefined, sites: 5, format: "popup" });
  });
  it("rejects an unknown metro and an empty audience", () => {
    expect(() => validateRequest({ brand: "X", seeds: ["A"], metro: "Atlantis" })).toThrow(/metro/);
    expect(() => validateRequest({ brand: "X", metro: "chi" })).toThrow(/audience/);
  });
});

describe("record and replay", () => {
  it("a recorded run replays to the same plan at $0", async () => {
    const rec = new RecordingProvider(new ScriptedProvider(), "2026-10-05T00:00:00Z");
    const first = await run(BOOKS, rec);
    expect(rec.transcript.turns.length).toBe(first.out.turns);
    const second = await run(BOOKS, new ReplayProvider(rec.transcript));
    expect(second.out.plan!.sites.map((s) => s.neighborhood.id)).toEqual(first.out.plan!.sites.map((s) => s.neighborhood.id));
  });
});

describe("tool specs", () => {
  it("exposes JSON Schema object inputs for every tool", () => {
    const specs = toolSpecs();
    expect(specs.map((s) => s.name)).toEqual(["resolve_audience", "map_taste_heat", "audience_profile", "find_anchor_places", "find_partner_brands", "compare_audiences", "submit_site_plan"]);
    for (const s of specs) expect(s.input_schema.type).toBe("object");
  });
});

describe("name lists", () => {
  it("keep a comma inside a name like Tyler, the Creator", async () => {
    const { splitNames } = await import("../src/shared/names");
    expect(splitNames("Stüssy, Supreme, Tyler, the Creator")).toEqual(["Stüssy", "Supreme", "Tyler, the Creator"]);
    expect(splitNames("Stüssy;Tyler, the Creator")).toEqual(["Stüssy", "Tyler, the Creator"]);
    expect(validateRequest({ brand: "X", seeds: "Stüssy, Tyler, the Creator", metro: "la" }).seeds).toEqual(["Stüssy", "Tyler, the Creator"]);
  });
});
