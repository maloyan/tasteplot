import { describe, expect, it, vi } from "vitest";
import { QlooBudgetError, QlooClient } from "../src/qloo/client";
import { QlooParamError, checkInsightsParams } from "../src/qloo/params";
import { budgetTransport, cacheKey, cachingTransport, httpTransport, KV_KEY_MAX_BYTES, memoryStore, QlooHttpError, requestKey, type KeyValueStore, type Transport } from "../src/qloo/transport";
import { adaptHeatmap, adaptInsightsEntities, adaptSearch, adaptTags, adaptDemographics, adaptCompare, QlooShapeError } from "../src/qloo/types";
import { makeQlooClient, qlooMode } from "../src/qloo";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("httpTransport", () => {
  it("sends GET with X-Api-Key to the hackathon host and query-string params", async () => {
    const f = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => json({ results: [] }));
    const t = httpTransport({ apiKey: "k-123", fetchImpl: f as unknown as typeof fetch });
    await t({ path: "/v2/insights", params: { "filter.type": "urn:entity:place", "signal.interests.entities": "abc" } });
    const [url, init] = f.mock.calls[0]!;
    expect(String(url)).toBe("https://hackathon.api.qloo.com/v2/insights?filter.type=urn%3Aentity%3Aplace&signal.interests.entities=abc");
    expect(init!.method).toBe("GET");
    expect((init!.headers as Record<string, string>)["X-Api-Key"]).toBe("k-123");
    expect(init!.body).toBeUndefined();
  });

  it("retries 429 and 5xx, then succeeds", async () => {
    const f = vi.fn().mockResolvedValueOnce(json({}, 429, { "retry-after": "0" })).mockResolvedValueOnce(json({}, 503)).mockResolvedValueOnce(json({ results: [] }));
    const t = httpTransport({ apiKey: "k", fetchImpl: f as unknown as typeof fetch, sleep: async () => {} });
    const r = await t({ path: "/search", params: { query: "x" } });
    expect(r.status).toBe(200);
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("starts at most maxPerSecond requests in any 1-second window", async () => {
    const waits: number[] = [];
    const f = vi.fn(async () => json({ results: [] }));
    const t = httpTransport({ apiKey: "k", fetchImpl: f as unknown as typeof fetch, maxPerSecond: 2, sleep: async (ms) => { waits.push(ms); } });
    await Promise.all([1, 2, 3, 4, 5].map((i) => t({ path: "/search", params: { query: `q${i}` } })));
    expect(f).toHaveBeenCalledTimes(5);
    expect(waits.length).toBe(3);
    expect(Math.min(...waits)).toBeGreaterThan(900);
  });
  it("explains a 401 on a non-hackathon host", async () => {
    const f = vi.fn(async () => json({ error: "unauthorized" }, 401));
    const t = httpTransport({ apiKey: "k", baseUrl: "https://api.qloo.com", fetchImpl: f as unknown as typeof fetch });
    await expect(t({ path: "/search", params: {} })).rejects.toThrow(/hackathon keys only work on/);
  });

  it("throws QlooHttpError on a 400 without retry", async () => {
    const f = vi.fn(async () => json({ error: "bad" }, 400));
    const t = httpTransport({ apiKey: "k", fetchImpl: f as unknown as typeof fetch, sleep: async () => {} });
    await expect(t({ path: "/search", params: {} })).rejects.toBeInstanceOf(QlooHttpError);
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe("cache", () => {
  it("keys requests by sorted params and never by API key", () => {
    expect(requestKey({ path: "/a", params: { b: "2", a: "1" } })).toBe(requestKey({ path: "/a", params: { a: "1", b: "2" } }));
  });
  // Regression: a partner-brands request (many entity IDs plus a location) made a
  // 603-byte key, and Workers KV answered "414 ... exceeds key length limit of 512".
  it("keeps the KV key under 512 bytes for a param set over 600 bytes", async () => {
    const ids = Array.from({ length: 16 }, (_, i) => `${"0123abcd".repeat(4)}-${i}`).join(",");
    const req = { path: "/v2/insights", params: { "filter.type": "urn:entity:brand", "signal.interests.entities": ids, "signal.location": "POINT(-118.2437 34.0522)", "signal.location.radius": "1200", take: "8" } };
    expect(new TextEncoder().encode(requestKey(req)).length).toBeGreaterThan(600);
    const key = await cacheKey(req);
    expect(new TextEncoder().encode(key).length).toBeLessThanOrEqual(KV_KEY_MAX_BYTES);
    expect(key).toMatch(/^qloo:v2:v2_insights:[0-9a-f]{64}$/);
  });
  it("maps identical requests to the same key and different requests to different keys", async () => {
    const a = await cacheKey({ path: "/v2/insights", params: { b: "2", a: "1" } });
    expect(a).toBe(await cacheKey({ path: "/v2/insights", params: { a: "1", b: "2" } }));
    expect(a).not.toBe(await cacheKey({ path: "/v2/insights", params: { a: "1", b: "3" } }));
    expect(a).not.toBe(await cacheKey({ path: "/v2/tags", params: { a: "1", b: "2" } }));
  });
  it("falls through to the live call when the cache store fails", async () => {
    const broken: KeyValueStore = {
      get: async () => { throw new Error("KV GET failed: 414 UTF-8 encoded length of 603 exceeds key length limit of 512."); },
      put: async () => { throw new Error("KV PUT failed: 429 Too Many Requests"); },
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const inner = vi.fn<Transport>(async () => ({ status: 200, body: { results: { entities: [{ entity_id: "b1", name: "Brand" }] } } }));
    const c = new QlooClient({ transport: cachingTransport(inner, broken), paramMode: "warn" });
    const out = await c.insights("urn:entity:brand", { "signal.interests.entities": ["e1"] });
    expect(out.map((e) => e.name)).toEqual(["Brand"]);
    expect(inner).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
  it("serves the second identical request from cache", async () => {
    const inner = vi.fn<Transport>(async () => ({ status: 200, body: { results: [{ entity_id: "x", name: "X" }] } }));
    const t = cachingTransport(inner, memoryStore());
    await t({ path: "/search", params: { query: "x" } });
    const r = await t({ path: "/search", params: { query: "x" } });
    expect(r.cached).toBe(true);
    expect(inner).toHaveBeenCalledTimes(1);
  });
});

describe("parameter check", () => {
  it("accepts location filters on places and heatmaps and rejects them on brands", () => {
    expect(checkInsightsParams({ "filter.type": "urn:entity:place", "filter.location": "POINT(-87.6 41.9)", "filter.location.radius": "1200" }).ok).toBe(true);
    expect(checkInsightsParams({ "filter.type": "urn:heatmap", "filter.location.query": "Chicago", "signal.interests.tags": "t" }).ok).toBe(true);
    const bad = checkInsightsParams({ "filter.type": "urn:entity:brand", "filter.location": "POINT(-87.6 41.9)" });
    expect(bad.ok).toBe(false);
    expect(bad.invalid).toEqual(["filter.location"]);
    // [LIVE] signal.location does change brand results, so it is allowed.
    expect(checkInsightsParams({ "filter.type": "urn:entity:brand", "signal.location": "POINT(-87.6 41.9)", "signal.location.radius": "1200" }).ok).toBe(true);
  });
  it("strict client throws before sending a param Qloo would ignore", async () => {
    const transport = vi.fn<Transport>();
    const c = new QlooClient({ transport, paramMode: "strict" });
    await expect(c.insights("urn:entity:artist", { "filter.price_level.min": 2 })).rejects.toBeInstanceOf(QlooParamError);
    expect(transport).not.toHaveBeenCalled();
  });
  it("warn client sends and records a warning", async () => {
    const c = new QlooClient({ transport: async () => ({ status: 200, body: { results: { entities: [] } } }), paramMode: "warn" });
    await c.insights("urn:entity:artist", { "filter.price_level.min": 2 });
    expect(c.warnings.join(" ")).toMatch(/ignored-param risk/);
    expect(c.warnings.join(" ")).toMatch(/empty result/);
  });
});

describe("QlooClient", () => {
  it("enforces the upstream call budget, also for parallel calls", async () => {
    const c = new QlooClient({ transport: async () => ({ status: 200, body: { results: [] } }), maxCalls: 3 });
    const all = await Promise.allSettled([1, 2, 3, 4, 5].map((i) => c.search(`q${i}`)));
    expect(all.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    expect(all.filter((r) => r.status === "rejected").every((r) => (r as PromiseRejectedResult).reason instanceof QlooBudgetError)).toBe(true);
  });
  it("cached responses do not count against the budget", async () => {
    const budget = { max: 1, used: 0 };
    const t = cachingTransport(budgetTransport(async () => ({ status: 200, body: { results: [] } }), budget), memoryStore());
    const c = new QlooClient({ transport: t, budget });
    await c.search("same");
    await c.search("same");
    expect(c.upstreamCalls).toBe(1);
  });
  it("scoped children share the log and report their own calls", async () => {
    const c = new QlooClient({ transport: async () => ({ status: 200, body: { results: [{ entity_id: "a", name: "A" }] } }) });
    const seen: string[] = [];
    await c.scoped((r) => seen.push(r.params.query!)).search("one");
    await c.search("two");
    expect(seen).toEqual(["one"]);
    expect(c.calls.map((x) => x.params.query)).toEqual(["one", "two"]);
  });
  it("builds the documented heatmap request", async () => {
    const t = vi.fn<Transport>(async () => ({ status: 200, body: { results: { heatmap: [] } } }));
    await new QlooClient({ transport: t, paramMode: "strict" }).heatmap({ entities: ["E1", "E2"], tags: ["urn:tag:x"] }, "Chicago");
    expect(t.mock.calls[0]![0]).toEqual({
      path: "/v2/insights",
      params: { "filter.type": "urn:heatmap", "signal.interests.entities": "E1,E2", "signal.interests.tags": "urn:tag:x", "filter.location.query": "Chicago" },
    });
  });
  it("builds the place request with a WKT point, longitude first, and a radius in metres", async () => {
    const t = vi.fn<Transport>(async () => ({ status: 200, body: { results: { entities: [] } } }));
    await new QlooClient({ transport: t, paramMode: "strict" }).placesNear({ signal: { entities: ["E1"], tags: [] }, at: { lat: 41.9088, lon: -87.6776 }, radiusM: 1200.4, explain: true });
    expect(t.mock.calls[0]![0].params).toEqual({
      "filter.type": "urn:entity:place", "signal.interests.entities": "E1", "filter.location": "POINT(-87.6776 41.9088)",
      "filter.location.radius": "1200", "feature.explainability": "true", take: "6",
    });
  });
  it("calls compare on the documented path", async () => {
    const t = vi.fn<Transport>(async () => ({ status: 200, body: { results: { tags: [] } } }));
    await new QlooClient({ transport: t }).compare(["A"], ["B"]);
    expect(t.mock.calls[0]![0]).toEqual({ path: "/v2/analysis/compare", params: { "a.signal.interests.entities": "A", "b.signal.interests.entities": "B", take: "20" } });
  });
});

describe("adapters", () => {
  it("normalise search results with `types` and location", () => {
    const [e] = adaptSearch({ results: [{ entity_id: "1", name: "Metro", types: ["urn:entity:place"], location: { lat: 41.9, lon: -87.6 } }] });
    expect(e).toMatchObject({ id: "1", name: "Metro", type: "urn:entity:place", location: { lat: 41.9, lon: -87.6 } });
  });
  it("read place coordinates from properties.geocode as a fallback", () => {
    const [e] = adaptInsightsEntities({ results: { entities: [{ entity_id: "1", name: "X", properties: { geocode: { latitude: 1, longitude: 2 } }, query: { affinity: 0.7 } }] } });
    expect(e!.location).toEqual({ lat: 1, lon: 2 });
    expect(e!.affinity).toBe(0.7);
  });
  it("accept explainability as a list or a map", () => {
    const list = adaptInsightsEntities({ results: { entities: [{ entity_id: "1", name: "X", query: { explainability: { "signal.interests.entities": [{ entity_id: "ART-ID-123", score: 0.8 }] } } }] } });
    const map = adaptInsightsEntities({ results: { entities: [{ entity_id: "1", name: "X", query: { explainability: { "ART-ID-123": 0.6 } } }] } });
    expect(list[0]!.explain).toEqual([{ entityId: "ART-ID-123", score: 0.8 }]);
    expect(map[0]!.explain).toEqual([{ entityId: "ART-ID-123", score: 0.6 }]);
  });
  it("drop entities with no id, keep going", () => {
    expect(adaptSearch({ results: [{ name: "no id" }, { entity_id: "2", name: "ok" }] }).map((e) => e.id)).toEqual(["2"]);
  });
  it("throw a shape error with the path when a field has the wrong type", () => {
    expect(() => adaptSearch({ results: "nope" })).toThrow(QlooShapeError);
  });
  it("parse the documented heatmap example", () => {
    const body = { success: true, results: { heatmap: [{ location: { latitude: 40.591736, longitude: -73.756714, geohash: "dr5wct" }, query: { affinity: 1, affinity_rank: 0.9976, popularity: 0.9717 } }] } };
    expect(adaptHeatmap(body)).toEqual([{ lat: 40.591736, lon: -73.756714, geohash: "dr5wct", affinity: 1, popularity: 0.9717 }]);
  });
  it("parse the documented demographics example", () => {
    const body = { results: { demographics: [{ entity_id: "E", query: { age: { "24_and_younger": 0, "25_to_29": 0.43 }, gender: { male: 0.08, female: -0.08 } } }] } };
    expect(adaptDemographics(body)).toEqual({ age: { "24_and_younger": 0, "25_to_29": 0.43 }, gender: { male: 0.08, female: -0.08 } });
  });
  it("parse tags in both documented item shapes", () => {
    expect(adaptTags({ results: { tags: [{ tag_id: "t1", name: "Bar", types: ["urn:tag:category:place"], subtype: "urn:tag:category:place" }] } })).toEqual([{ id: "t1", name: "Bar", type: "urn:tag:category:place" }]);
    expect(adaptTags({ results: { tags: [{ id: "t2", name: "Jazz", type: "urn:tag:genre" }] } })).toEqual([{ id: "t2", name: "Jazz", type: "urn:tag:genre" }]);
  });
  it("parse the live compare shape: shared tags with a score, and each side's tags with a count", () => {
    const body = { duration: 57, results: {
      tags: [{ tag_id: "g", name: "Dining", type: "urn:tag", subtype: "urn:tag:genre:brand", query: { score: 0.73, "a.signal.interests.entities": [] } }],
      a: [{ tag_id: "g", name: "Dining", query: { count: "1" } }],
      b: [{ tag_id: "d", name: "Drinks", query: { count: "2" } }],
      matchEntities: [],
    } };
    expect(adaptCompare(body)).toEqual({
      shared: [{ id: "g", name: "Dining", score: 0.73, count: undefined }],
      a: [{ id: "g", name: "Dining", score: undefined, count: 1 }],
      b: [{ id: "d", name: "Drinks", score: undefined, count: 2 }],
    });
  });
  it("average live demographics, which come as one item per signal", () => {
    const body = { results: { demographics: [
      { entity_id: "E", query: { age: { "25_to_29": 0.4 }, gender: { male: 0.2, female: -0.2 } } },
      { entity_id: "urn:tag:x", query: { age: { "25_to_29": -0.2 }, gender: { male: -0.4, female: 0.4 } } },
    ] } };
    expect(adaptDemographics(body)).toEqual({ age: { "25_to_29": 0.1 }, gender: { male: -0.1, female: 0.1 } });
  });
  it("take the entity type from subtype in insights results (type is just urn:entity)", () => {
    const [e] = adaptInsightsEntities({ results: { entities: [{ entity_id: "1", name: "X", type: "urn:entity", subtype: "urn:entity:place", location: { lat: 41.9, lon: -87.67, geohash: "dp3wkuz6" }, query: { affinity: 0.85, distance: 560 } }] } });
    expect(e).toMatchObject({ type: "urn:entity:place", location: { lat: 41.9, lon: -87.67 }, affinity: 0.85 });
  });
});

describe("mode switch", () => {
  it("uses fixtures without a key and live with a key", () => {
    expect(qlooMode({})).toBe("fixtures");
    expect(qlooMode({ QLOO_API_KEY: "k" })).toBe("live");
    expect(qlooMode({ QLOO_API_KEY: "k", QLOO_MODE: "fixtures" })).toBe("fixtures");
  });
  it("a key routes calls to the hackathon host", async () => {
    const f = vi.fn(async () => json({ results: [] }));
    const { client, mode } = makeQlooClient({ QLOO_API_KEY: "secret" }, { fetchImpl: f as unknown as typeof fetch });
    await client.search("x");
    expect(mode).toBe("live");
    expect(String((f.mock.calls[0] as unknown[])[0])).toMatch(/^https:\/\/hackathon\.api\.qloo\.com\/search\?/);
  });
});
