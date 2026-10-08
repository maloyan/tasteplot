import { afterEach, describe, expect, it, vi } from "vitest";
import { ipLimited, MIN_CALLS_FOR_PLAN, Quota } from "../src/server/quota";
import { memoryStore } from "../src/qloo/transport";
import { fixtureTransport } from "../src/qloo/fixtures/transport";
import { makeApp, sampleId, readRequest } from "../src/server/app";
import type { AgentEvent } from "../src/shared/types";

const day = () => new Date("2026-10-06T12:00:00Z");

describe("daily quota", () => {
  it("counts fresh calls per UTC day and reports what is left", async () => {
    const q = new Quota(memoryStore(), 250, day);
    expect(await q.read()).toMatchObject({ day: "2026-10-06", used: 0, cap: 250, remaining: 250, exhausted: false });
    await q.add(21, 9700);
    expect(await q.read()).toMatchObject({ used: 21, remaining: 229, monthRemaining: 9700, exhausted: false });
    const tomorrow = new Quota((q as any).store, 250, () => new Date("2026-10-07T00:00:01Z"));
    expect((await tomorrow.read()).used).toBe(0);
  });

  it("is exhausted when less than one plan's worth of calls is left", async () => {
    const q = new Quota(memoryStore(), 250, day);
    await q.add(250 - MIN_CALLS_FOR_PLAN + 1);
    expect((await q.read()).exhausted).toBe(true);
  });

  it("is exhausted when Qloo's own monthly counter runs low", async () => {
    const q = new Quota(memoryStore(), 250, day);
    await q.add(1, 120);
    expect((await q.read()).exhausted).toBe(true);
  });
});

describe("per-IP limit", () => {
  it("allows N new plans an hour per address", async () => {
    const s = memoryStore();
    const now = new Date("2026-10-06T12:30:00Z");
    for (let i = 0; i < 10; i++) expect(await ipLimited(s, "1.2.3.4", 10, now)).toBe(false);
    expect(await ipLimited(s, "1.2.3.4", 10, now)).toBe(true);
    expect(await ipLimited(s, "5.6.7.8", 10, now)).toBe(false);
    expect(await ipLimited(s, "1.2.3.4", 10, new Date("2026-10-06T13:00:00Z"))).toBe(false);
  });
});

// ---- Server in live mode, with the HTTP layer answered by the fixture world ----

function fakeKV() {
  const m = new Map<string, string>();
  return { m, kv: { get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: string) => void m.set(k, v) } as unknown as KVNamespace };
}

let upstream = 0;
function stubQlooFetch(monthRemaining = 9000) {
  const fx = fixtureTransport();
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    upstream++;
    const res = await fx({ path: url.pathname, params: Object.fromEntries(url.searchParams) });
    return new Response(JSON.stringify(res.body), { status: 200, headers: { "x-month-ratelimit-remaining": String(monthRemaining - upstream) } });
  });
}
afterEach(() => { vi.unstubAllGlobals(); upstream = 0; });

function parseSSE(text: string): AgentEvent[] {
  return text.split("\n\n").filter(Boolean).map((b) => JSON.parse(b.match(/^data: (.*)$/m)![1]!) as AgentEvent);
}

const Q = "brand=Lowtide&audience=streetwear%2C%20sneakers&seeds=St%C3%BCssy%3BSupreme&metro=la&format=popup&sites=2";
const Q2 = "brand=Other&audience=literary%20fiction&seeds=Sally%20Rooney&metro=lon&sites=1";
const env = (kv: KVNamespace, extra: Record<string, string> = {}) => ({ QLOO_API_KEY: "test-key-not-real", LLM_PROVIDER: "scripted", CACHE: kv, ...extra });
const ip = (n: string) => ({ headers: { "cf-connecting-ip": n } });

// The live HTTP transport paces itself at 4 requests a second, so a full plan takes a few seconds.
describe("server quota protection (live mode)", { timeout: 30_000 }, () => {
  it("counts a fresh plan's upstream calls, then replays it from cache for free", async () => {
    stubQlooFetch();
    const { kv } = fakeKV();
    const app = makeApp();
    const first = parseSSE(await (await app.request(`/api/plan?${Q}`, ip("1.1.1.1"), env(kv))).text());
    expect(first.some((e) => e.type === "plan")).toBe(true);
    const quotas = first.filter((e): e is Extract<AgentEvent, { type: "quota" }> => e.type === "quota");
    expect(quotas.at(-1)!.quota.used).toBe(upstream);
    expect(quotas.at(-1)!.quota.monthRemaining).toBe(9000 - upstream);
    expect(first.at(-1)!.type).toBe("done");
    const before = upstream;
    const again = parseSSE(await (await app.request(`/api/plan?${Q}`, ip("1.1.1.1"), env(kv))).text());
    expect(upstream).toBe(before);
    expect(again.find((e) => e.type === "quota")).toMatchObject({ source: "cache" });
    expect(again.some((e) => e.type === "plan")).toBe(true);
  });

  it("serves identical Qloo requests from the cache across plans", async () => {
    stubQlooFetch();
    const { kv } = fakeKV();
    const app = makeApp();
    await (await app.request(`/api/plan?${Q}`, ip("1.1.1.1"), env(kv))).text();
    const one = upstream;
    // Same audience, one more site: most Qloo requests repeat, so few new upstream calls.
    await (await app.request(`/api/plan?${Q.replace("sites=2", "sites=3")}`, ip("1.1.1.1"), env(kv))).text();
    expect(upstream - one).toBeLessThan(one / 2);
  });

  it("limits new plans per address", async () => {
    stubQlooFetch();
    const { kv } = fakeKV();
    const app = makeApp();
    await (await app.request(`/api/plan?${Q}`, ip("2.2.2.2"), env(kv, { PLANS_PER_HOUR: "1" }))).text();
    const second = parseSSE(await (await app.request(`/api/plan?${Q2}`, ip("2.2.2.2"), env(kv, { PLANS_PER_HOUR: "1" }))).text());
    expect(second.find((e) => e.type === "error")).toMatchObject({ message: expect.stringMatching(/Too many new plans/) });
    const other = parseSSE(await (await app.request(`/api/plan?${Q2}`, ip("3.3.3.3"), env(kv, { PLANS_PER_HOUR: "1" }))).text());
    expect(other.some((e) => e.type === "plan")).toBe(true);
  });

  it("shows a recorded sample when the daily cap is used up, with no Qloo call", async () => {
    stubQlooFetch();
    const { kv } = fakeKV();
    const sampleEvents: AgentEvent[] = [{ type: "thought", text: "recorded" }, { type: "done", provenance: { qloo: "live", llm: "scripted (dry-run)", qlooCalls: 20, llmTurns: 5, ms: 1, warnings: [] } }];
    const files: Record<string, string> = {
      "samples/index.json": JSON.stringify([{ id: "abc", brand: "Folio & Fern Books", metro: "lon", plan: true }]),
      "samples/abc.json": JSON.stringify(sampleEvents),
    };
    const app = makeApp({ loadSample: async (p) => files[p] ?? null });
    const e = env(kv, { DAILY_QLOO_CAP: "30" });
    await (await app.request(`/api/plan?${Q}`, ip("4.4.4.4"), e)).text(); // uses about 20 of 30
    expect(upstream).toBeGreaterThan(5);
    const used = upstream;
    const out = parseSSE(await (await app.request(`/api/plan?${Q2}`, ip("4.4.4.4"), e)).text());
    expect(upstream).toBe(used);
    const q = out.find((x) => x.type === "quota") as Extract<AgentEvent, { type: "quota" }>;
    expect(q.quota.exhausted).toBe(true);
    expect(q.note).toMatch(/demo quota is used up.*recorded sample plan \(Folio & Fern Books\)/);
    expect(out.map((x) => x.type)).toEqual(["quota", "thought", "done"]);
  });

  it("serves a recorded sample for its exact request at 0 calls", async () => {
    stubQlooFetch();
    const { kv } = fakeKV();
    const id = sampleId(readRequest(`http://x/api/plan?${Q2}`));
    const app = makeApp({ loadSample: async (p) => (p === `samples/${id}.json` ? JSON.stringify([{ type: "thought", text: "sample" }]) : null) });
    const out = parseSSE(await (await app.request(`/api/plan?${Q2}`, ip("5.5.5.5"), env(kv))).text());
    expect(upstream).toBe(0);
    expect(out[0]).toMatchObject({ type: "quota", source: "sample" });
    expect(out[1]).toMatchObject({ type: "thought", text: "sample" });
  });

  // Regression: Workers KV refuses keys over 512 bytes. The fake KV here refuses them
  // the same way, so a long Qloo or plan key fails the test like it failed live.
  it("runs a full plan with every KV key under 512 bytes", async () => {
    stubQlooFetch();
    const m = new Map<string, string>();
    const check = (k: string) => { const n = new TextEncoder().encode(k).length; if (n > 512) throw new Error(`KV GET failed: 414 UTF-8 encoded length of ${n} exceeds key length limit of 512.`); };
    const kv = { get: async (k: string) => (check(k), m.get(k) ?? null), put: async (k: string, v: string) => (check(k), void m.set(k, v)) } as unknown as KVNamespace;
    const warn = vi.spyOn(console, "warn");
    const out = parseSSE(await (await makeApp().request(`/api/plan?${Q}`, ip("6.6.6.6"), env(kv))).text());
    const steps = out.filter((e): e is Extract<AgentEvent, { type: "step" }> => e.type === "step").map((e) => e.step);
    expect(steps.some((s) => s.label.startsWith("Partner brands") && s.status === "done")).toBe(true);
    expect(steps.some((s) => s.status === "error")).toBe(false);
    expect(out.some((e) => e.type === "plan")).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    expect([...m.keys()].some((k) => k.startsWith("qloo:v2:v2_insights:"))).toBe(true);
    warn.mockRestore();
  });

  it("shows a sample, not an error, when every KV call fails (the quota fails closed)", async () => {
    stubQlooFetch();
    const kv = { get: async () => { throw new Error("KV GET failed: 503"); }, put: async () => { throw new Error("KV PUT failed: 429"); } } as unknown as KVNamespace;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // The quota cannot be read, so it fails closed: no fresh Qloo call, a recorded sample instead.
    const files: Record<string, string> = {
      "samples/index.json": JSON.stringify([{ id: "abc", brand: "Folio & Fern Books", metro: "lon", plan: true }]),
      "samples/abc.json": JSON.stringify([{ type: "thought", text: "recorded" }]),
    };
    const out = parseSSE(await (await makeApp({ loadSample: async (p) => files[p] ?? null }).request(`/api/plan?${Q}`, ip("7.7.7.7"), env(kv))).text());
    expect(upstream).toBe(0);
    expect(out.find((e) => e.type === "quota")).toMatchObject({ source: "sample", quota: { exhausted: true } });
    expect(out.some((e) => e.type === "error")).toBe(false);
    warn.mockRestore();
  });

  it("finishes the plan when only the cache keys fail in KV", async () => {
    stubQlooFetch();
    const m = new Map<string, string>();
    const quotaOnly = (k: string) => { if (!k.startsWith("quota:")) throw new Error("KV PUT failed: 429 Too Many Requests"); };
    const kv = { get: async (k: string) => (quotaOnly(k), m.get(k) ?? null), put: async (k: string, v: string) => (quotaOnly(k), void m.set(k, v)) } as unknown as KVNamespace;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = parseSSE(await (await makeApp().request(`/api/plan?${Q}`, ip("8.8.8.8"), env(kv))).text());
    const steps = out.filter((e): e is Extract<AgentEvent, { type: "step" }> => e.type === "step").map((e) => e.step);
    expect(steps.some((s) => s.label.startsWith("Partner brands") && s.status === "done")).toBe(true);
    expect(steps.some((s) => s.status === "error")).toBe(false);
    expect(out.some((e) => e.type === "plan")).toBe(true);
    const quotas = out.filter((e): e is Extract<AgentEvent, { type: "quota" }> => e.type === "quota");
    expect(quotas.at(-1)!.quota.used).toBe(upstream);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("reports the quota in /api/health without exposing the key", async () => {
    const { kv } = fakeKV();
    const r = await makeApp().request("/api/health", {}, env(kv));
    const text = await r.text();
    expect(JSON.parse(text)).toMatchObject({ qloo: "live", quota: { cap: 250, remaining: 250 } });
    expect(text).not.toContain("test-key-not-real");
  });
});
