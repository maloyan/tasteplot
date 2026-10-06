import { describe, expect, it } from "vitest";
import { makeApp } from "../src/server/app";

const app = makeApp();

function parseSSE(text: string) {
  return text.split("\n\n").filter(Boolean).map((block) => {
    const ev = block.match(/^event: (.*)$/m)?.[1];
    const data = block.match(/^data: (.*)$/m)?.[1];
    return { ev, data: data ? JSON.parse(data) : undefined };
  });
}

const Q = "brand=Lowtide%20Supply%20Co.&audience=streetwear%2C%20sneakers&seeds=St%C3%BCssy%2CSupreme&metro=la&format=popup&sites=2";

describe("server", () => {
  it("reports fixture mode with no keys", async () => {
    const r = await app.request("/api/health", {}, {});
    expect(await r.json()).toEqual({ ok: true, qloo: "fixtures", llm: "scripted (dry-run)" });
  });

  it("lists metros and sample briefs", async () => {
    const body = (await (await app.request("/api/config", {}, {})).json()) as { metros: { id: string }[]; examples: unknown[] };
    expect(body.metros.map((m) => m.id)).toEqual(["chi", "nyc", "la", "lon"]);
    expect(body.examples.length).toBeGreaterThanOrEqual(3);
  });

  it("streams a site plan over SSE", async () => {
    const r = await app.request(`/api/plan?${Q}`, {}, {});
    expect(r.headers.get("content-type")).toMatch(/text\/event-stream/);
    const events = parseSSE(await r.text());
    const plan = events.find((e) => e.ev === "plan")!.data.plan;
    expect(plan.sites).toHaveLength(2);
    expect(plan.provenance.qloo).toBe("fixtures");
    expect(events.some((e) => e.ev === "heatmap")).toBe(true);
    expect(events.at(-1)!.ev).toBe("done");
  });

  it("passes a disambiguation pick through the query string", async () => {
    const r = await app.request("/api/plan?brand=X&audience=outdoors&seeds=Patagonia&metro=chi&sites=1&pick.Patagonia=fx%3Abrand%3Apatagonia-brand", {}, {});
    const events = parseSSE(await r.text());
    expect(events.some((e) => e.ev === "needs_input")).toBe(false);
    expect(events.find((e) => e.ev === "plan")!.data.plan.signals[0].id).toBe("fx:brand:patagonia-brand");
  });

  it("rejects a request with no brand or an unknown metro", async () => {
    expect((await app.request("/api/plan?metro=chi&seeds=Rapha", {}, {})).status).toBe(400);
    expect((await app.request("/api/plan?brand=X&metro=Atlantis&seeds=Rapha", {}, {})).status).toBe(400);
  });

  it("serves the LLM-only baseline check", async () => {
    const r = await app.request("/api/baseline?brand=Lowtide%20Supply%20Co.&audience=streetwear%2C%20sneakers%2C%20skateboarding&seeds=St%C3%BCssy%2CSupreme%2CTyler%2C%20the%20Creator&metro=la&format=popup&sites=3", {}, {});
    const body = (await r.json()) as { source: string; score: { areas: number; anchors: number } };
    expect(body.source).toBe("illustrative-fixture");
    expect(body.score).toMatchObject({ areas: 3, anchors: 6 });
  });

  it("answers the LLM-only check for a brief with no recorded answer, without an error", async () => {
    for (const q of [
      "brand=Switchback%20Outfitters&audience=outdoors%2C%20cycling&seeds=Patagonia%3BRapha&metro=chi&sites=2&pick.Patagonia=fx%3Abrand%3Apatagonia-brand",
      "brand=Brand%20New&audience=running&seeds=Rapha&metro=chi&sites=1",
    ]) {
      const r = await app.request(`/api/baseline?${q}`, {}, {});
      expect(r.status).toBe(200);
      const body = (await r.json()) as { source: string; sites: unknown[]; note: string; score: { anchors: number } };
      expect(body).toMatchObject({ source: "unavailable", sites: [], score: { anchors: 0 } });
      expect(body.note).toMatch(/Quietcup Coffee Roasters/);
    }
  });

  it("returns 404 JSON for unknown API paths", async () => {
    const r = await app.request("/api/nope", {}, {});
    expect(r.status).toBe(404);
  });
});
