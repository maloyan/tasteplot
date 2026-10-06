// Contract tests on curated LIVE Qloo responses (fixtures/qloo/recorded/<brief>/).
// They were recorded from the hackathon API on 2026-10-06 with
// `npx tsx --env-file=.env scripts/live-demo.ts --record` and trimmed to a few items.
// If Qloo changes a response shape, re-record and these tests show what broke.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { adaptCompare, adaptDemographics, adaptHeatmap, adaptInsightsEntities, adaptSearch, adaptTags } from "../src/qloo/types";
import { pickEntity, pickTag } from "../src/agent/tools";
import { haversineKm } from "../src/qloo/fixtures/util";

const ROOT = join(__dirname, "../fixtures/qloo/recorded");
const BRIEFS = readdirSync(ROOT).filter((d) => d !== "raw");
type Rec = { request: { path: string; params: Record<string, string> }; body: unknown };
const load = (brief: string, file: string): Rec => JSON.parse(readFileSync(join(ROOT, brief, file), "utf8"));
const files = (kind: string) => BRIEFS.flatMap((b) => readdirSync(join(ROOT, b)).filter((f) => f.startsWith(kind)).map((f) => ({ brief: b, rec: load(b, f) })));

describe("recorded live responses", () => {
  it("cover the three sample briefs and the ambiguous seed", () => {
    expect(BRIEFS).toEqual(expect.arrayContaining(["quietcup-coffee-roasters", "lowtide-supply-co", "folio-and-fern-books", "switchback-outfitters"]));
  });

  it("never contain an API key (requests hold only path and params)", () => {
    for (const b of BRIEFS) for (const f of readdirSync(join(ROOT, b))) {
      const text = readFileSync(join(ROOT, b, f), "utf8");
      expect(text).not.toMatch(/x-api-key|apikey|api_key/i);
    }
  });

  it("search: seeds resolve to one taste entity, and Patagonia stays ambiguous", () => {
    for (const { brief, rec } of files("search-")) {
      const hits = adaptSearch(rec.body);
      expect(hits.length).toBeGreaterThan(0);
      const { pick, ambiguous } = pickEntity(hits, rec.request.params.query!);
      if (brief === "switchback-outfitters") expect(ambiguous!.map((e) => e.type).sort()).toEqual(["urn:entity:brand", "urn:entity:locality"]);
      else expect(pick?.type).not.toBe("urn:entity:place");
    }
  });

  it("tags: the picked tag contains every word of the keyword", () => {
    for (const { rec } of files("v2-tags-")) {
      const kw = rec.request.params["filter.query"]!;
      const t = pickTag(adaptTags(rec.body), kw);
      expect(t, kw).toBeDefined();
      expect(t!.id).toMatch(/^urn:tag:/);
    }
  });

  it("heatmap: geohash-6 or -7 cells with a 0..1 affinity, sorted from hot to cold", () => {
    for (const { rec } of files("v2-insights-urn-heatmap-")) {
      const cells = adaptHeatmap(rec.body);
      expect(cells.length).toBeGreaterThan(5);
      for (const c of cells) {
        expect([6, 7]).toContain(c.geohash.length); // 7 in Chicago, 6 in Los Angeles and London
        expect(c.affinity).toBeGreaterThanOrEqual(0);
        expect(c.affinity).toBeLessThanOrEqual(1);
      }
      expect(cells.map((c) => c.affinity)).toEqual([...cells.map((c) => c.affinity)].sort((a, b) => b - a));
    }
  });

  it("places: coordinates inside the radius, subtype place, explainability per seed", () => {
    for (const { rec } of files("v2-insights-urn-entity-place-")) {
      const [lon, lat] = rec.request.params["filter.location"]!.match(/-?[\d.]+/g)!.map(Number);
      const radiusKm = Number(rec.request.params["filter.location.radius"]) / 1000;
      const seeds = rec.request.params["signal.interests.entities"]!.split(",");
      const places = adaptInsightsEntities(rec.body);
      expect(places.length).toBeGreaterThan(0);
      for (const p of places) {
        expect(p.type).toBe("urn:entity:place");
        expect(haversineKm(p.location!, { lat: lat!, lon: lon! })).toBeLessThanOrEqual(radiusKm * 1.01);
        expect(p.affinity).toBeGreaterThan(0);
        expect(p.explain.length).toBeGreaterThan(0);
        for (const x of p.explain) expect(seeds).toContain(x.entityId);
      }
    }
  });

  it("brands: subtype brand with affinity and explainability", () => {
    for (const { rec } of files("v2-insights-urn-entity-brand-")) {
      const brands = adaptInsightsEntities(rec.body);
      expect(brands.length).toBeGreaterThan(0);
      for (const b of brands) {
        expect(b.type).toBe("urn:entity:brand");
        expect(b.affinity).toBeGreaterThan(0);
        expect(b.explain.length).toBeGreaterThan(0);
      }
    }
  });

  it("demographics: one item per signal, averaged into six age buckets and two genders", () => {
    for (const { rec } of files("v2-insights-urn-demographics-")) {
      const d = adaptDemographics(rec.body)!;
      expect(Object.keys(d.age)).toHaveLength(6);
      expect(Object.keys(d.gender).sort()).toEqual(["female", "male"]);
    }
  });

  it("compare: shared tags plus each side's own tags", () => {
    for (const { rec } of files("v2-analysis-compare-")) {
      const c = adaptCompare(rec.body);
      expect(c.a.length + c.b.length).toBeGreaterThan(0);
      for (const t of c.shared) expect(t.score).toBeGreaterThan(0);
      for (const t of [...c.a, ...c.b]) expect(t.count).toBeGreaterThan(0);
    }
  });
});
