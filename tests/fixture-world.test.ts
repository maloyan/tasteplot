import { describe, expect, it } from "vitest";
import { QlooClient } from "../src/qloo/client";
import { fixtureTransport } from "../src/qloo/fixtures/transport";
import { QlooHttpError } from "../src/qloo/transport";
import { geohashEncode, haversineKm, nameSimilarity } from "../src/qloo/fixtures/util";
import { TAGS, WORLD } from "../src/qloo/fixtures/world";
import { findMetro, findNeighborhoodByName, METROS } from "../src/shared/metros";

const client = () => new QlooClient({ transport: fixtureTransport(), paramMode: "strict" });
const COFFEE = { entities: ["fx:brand:blue-bottle-coffee", "fx:brand:rapha"], tags: [] as string[] };

describe("fixture world", () => {
  it("is deterministic", async () => {
    const a = await client().heatmap(COFFEE, "Chicago");
    const b = await client().heatmap(COFFEE, "Chicago");
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(20);
  });

  it("has unique entity ids and unique tag ids", () => {
    expect(new Set(WORLD.map((e) => e.id)).size).toBe(WORLD.length);
    expect(new Set(TAGS.map((t) => t.id)).size).toBe(TAGS.length);
  });

  it("keeps heat cells inside the metro asked for", async () => {
    const la = findMetro("Los Angeles")!;
    const cells = await client().heatmap(COFFEE, "Los Angeles");
    expect(cells.every((c) => haversineKm(c, la) < 25)).toBe(true);
  });

  it("returns 400 for an unknown locality, like the docs say", async () => {
    await expect(client().heatmap(COFFEE, "Atlantis")).rejects.toBeInstanceOf(QlooHttpError);
  });

  it("places respect the WKT point and radius", async () => {
    const wp = findNeighborhoodByName(findMetro("chi")!, "Wicker Park")!;
    const places = await client().placesNear({ signal: COFFEE, at: wp, radiusM: 1200, take: 50, explain: true });
    expect(places.length).toBeGreaterThan(3);
    for (const p of places) expect(haversineKm(p.location!, wp)).toBeLessThanOrEqual(1.2);
    expect(places.map((p) => p.name)).toContain("Reckless Records");
    expect(places[0]!.explain.length).toBeGreaterThan(0);
  });

  it("finds tags by keyword and returns them in the documented item shape", async () => {
    const [t] = await client().findTags("specialty coffee");
    expect(t).toMatchObject({ name: "Specialty Coffee" });
    expect(t!.id).toMatch(/^urn:tag:/);
  });

  it("returns two candidates for an ambiguous name", async () => {
    const hits = await client().search("Patagonia");
    expect(hits.filter((h) => h.name === "Patagonia").map((h) => h.type)).toEqual(["urn:entity:brand", "urn:entity:locality"]);
  });

  it("partner brands are fictional and exclude the seeds", async () => {
    const brands = await client().brands(COFFEE, { exclude: COFFEE.entities, take: 10 });
    expect(brands.length).toBeGreaterThan(0);
    expect(brands.every((b) => b.name.endsWith("(fixture)"))).toBe(true);
  });

  it("has no entity for an unknown name", async () => {
    expect(await client().search("Definitely Not A Brand")).toEqual([]);
  });

  it("gives every neighbourhood fictional anchor places", () => {
    for (const m of METROS) for (const n of m.neighborhoods) expect(WORLD.filter((e) => e.neighborhoodId === n.id).length).toBeGreaterThanOrEqual(7);
  });
});

describe("utils", () => {
  it("encodes geohash like the reference implementation", () => {
    expect(geohashEncode(57.64911, 10.40744, 11)).toBe("u4pruydqqvj");
  });
  it("name similarity does not match short fragments inside words", () => {
    expect(nameSimilarity("The Velvet Bayou Ballroom", "El Club")).toBeLessThan(0.6);
    expect(nameSimilarity("Daunt Books Marylebone", "Daunt Books")).toBeGreaterThanOrEqual(0.6);
  });
  it("finds metros and neighbourhoods by name", () => {
    expect(findMetro("chicago, IL")?.id).toBe("chi");
    expect(findNeighborhoodByName(findMetro("lon")!, "the Shoreditch")?.id).toBe("lon:shoreditch");
  });
});
