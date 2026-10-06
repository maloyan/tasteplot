// One Hono app for both runtimes: the Node dev server and the Cloudflare Worker.
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { makeQlooClient, qlooMode, type QlooConfig } from "../qloo";
import { kvStore, memoryStore, type KeyValueStore, type QlooRequest, type QlooResponse } from "../qloo/transport";
import { createProvider, type LLMConfig } from "../llm";
import { RecordingProvider, type Transcript } from "../llm/replay";
import { runAgent, validateRequest } from "../agent/loop";
import { baselineFixture, runBaseline, unavailableBaseline } from "../agent/baseline";
import { SEED_NAMES } from "../qloo/fixtures/world";
import { hash32 } from "../qloo/fixtures/util";
import { METROS } from "../shared/metros";
import type { AgentEvent, BaselineReport, QuotaInfo, SiteRequest } from "../shared/types";
import { DEFAULT_DAILY_CAP, DEFAULT_PLANS_PER_HOUR, envInt, ipLimited, MONTH_RESERVE, Quota } from "./quota";

export interface Env extends QlooConfig, LLMConfig {
  LLM_MAX_TURNS?: string;
  /** Daily cap on fresh (uncached) Qloo calls for the whole deployment. Default 250. */
  DAILY_QLOO_CAP?: string;
  /** New (uncached) plans per IP address per hour. Default 10. */
  PLANS_PER_HOUR?: string;
  /** Workers KV namespace for Qloo responses, finished plans and the quota counters. Optional. */
  CACHE?: KVNamespace;
  ASSETS?: { fetch: (req: Request) => Promise<Response> };
}

export interface AppHooks {
  /** Called for each live Qloo response (Node dev server: writes fixtures). */
  recordQloo?: (req: QlooRequest, res: QlooResponse) => void | Promise<void>;
  /** Called with the LLM transcript after a live run (Node dev server: writes fixtures). */
  onTranscript?: (req: SiteRequest, t: Transcript) => void | Promise<void>;
  /** Fixture latency so the trace animates in dry-run. */
  fixtureLatencyMs?: number;
  /** Delay between replayed cached events, in ms. */
  replayDelayMs?: number;
  /**
   * Read a recorded sample file (public/samples/*.json) by path. The Worker reads
   * them from its static assets; the Node dev server reads them from disk.
   */
  loadSample?: (path: string) => Promise<string | null>;
}

const PLAN_TTL = 60 * 60 * 24 * 30;
const memCache = memoryStore();

function cacheFor(env: Env): KeyValueStore {
  return env.CACHE ? kvStore(env.CACHE) : memCache;
}

export function readRequest(url: string): SiteRequest {
  const p = new URL(url).searchParams;
  const picks: Record<string, string> = {};
  for (const [k, v] of p.entries()) if (k.startsWith("pick.")) picks[k.slice(5)] = v;
  return validateRequest({
    brand: p.get("brand") ?? undefined,
    audience: p.get("audience") ?? undefined,
    seeds: p.get("seeds") ?? "",
    metro: p.get("metro") ?? undefined,
    compareMetro: p.get("compareMetro") ?? undefined,
    compareSeeds: p.get("compareSeeds") ?? "",
    format: p.get("format") === "popup" ? "popup" : "store",
    sites: Number(p.get("sites") ?? 3),
    picks,
  });
}

/** The sample briefs. Brand names are fictional. */
export const EXAMPLES: (SiteRequest & { label: string })[] = [
  { label: "Coffee roaster · Chicago", brand: "Quietcup Coffee Roasters", audience: "specialty coffee, cycling, record stores", seeds: ["Blue Bottle Coffee", "Rapha", "Kinfolk"], metro: "chi", compareMetro: "nyc", compareSeeds: ["Starbucks"], format: "store", sites: 3 },
  { label: "Streetwear pop-up · LA", brand: "Lowtide Supply Co.", audience: "streetwear, sneakers, skateboarding", seeds: ["Stüssy", "Supreme", "Tyler, the Creator"], metro: "la", compareSeeds: ["Nike"], format: "popup", sites: 3 },
  { label: "Indie bookshop · London", brand: "Folio & Fern Books", audience: "literary fiction, bookstores, natural wine", seeds: ["Sally Rooney", "The Paris Review", "Haruki Murakami"], metro: "lon", compareSeeds: ["Waterstones"], format: "store", sites: 3 },
  { label: "Ambiguous seed", brand: "Switchback Outfitters", audience: "outdoors, cycling", seeds: ["Patagonia", "Rapha"], metro: "chi", format: "store", sites: 2 },
];

/**
 * Recorded sample plans ship as static files, so the sample briefs work for every
 * judge at 0 Qloo calls, even when the KV cache expired or the daily quota is used up.
 * File name = hash of the validated request. `scripts/live-demo.ts --samples` writes them.
 */
export function sampleId(req: SiteRequest): string {
  return hash32(JSON.stringify(req)).toString(16);
}

export interface SampleIndexEntry {
  id: string;
  brand: string;
  metro: string;
  /** False for a recorded "which X do you mean?" stop. */
  plan: boolean;
}

type Loader = (path: string) => Promise<string | null>;

function sampleLoader(env: Env, hooks: AppHooks): Loader | undefined {
  if (hooks.loadSample) return hooks.loadSample;
  const assets = env.ASSETS;
  if (!assets) return undefined;
  return async (path) => {
    const r = await assets.fetch(new Request(`https://assets.local/${path}`));
    const text = r.ok ? await r.text() : "";
    // The asset router answers unknown paths with index.html (single-page app), so check the body.
    return /^\s*[[{]/.test(text) ? text : null;
  };
}

async function loadJson<T>(load: Loader | undefined, path: string): Promise<T | undefined> {
  if (!load) return undefined;
  try {
    const t = await load(path);
    return t ? (JSON.parse(t) as T) : undefined;
  } catch {
    return undefined;
  }
}

const clientIp = (h: (k: string) => string | undefined) => h("cf-connecting-ip") ?? h("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";

export function makeApp(hooks: AppHooks = {}) {
  const app = new Hono<{ Bindings: Env }>();
  const quotaFor = (env: Env) => new Quota(cacheFor(env), envInt(env.DAILY_QLOO_CAP, DEFAULT_DAILY_CAP));
  const perHour = (env: Env) => envInt(env.PLANS_PER_HOUR, DEFAULT_PLANS_PER_HOUR);

  app.get("/api/health", async (c) => {
    const env = c.env ?? {};
    let llm = "scripted (dry-run)";
    try { llm = createProvider(env).id; } catch (e) { llm = `misconfigured: ${(e as Error).message}`; }
    const mode = qlooMode(env);
    return c.json({ ok: true, qloo: mode, llm, ...(mode === "live" ? { quota: await quotaFor(env).read() } : {}) });
  });

  app.get("/api/config", (c) => {
    const env = c.env ?? {};
    return c.json({
      qloo: qlooMode(env),
      metros: METROS.map((m) => ({ id: m.id, name: m.name, lat: m.lat, lon: m.lon })),
      fixtureSeeds: SEED_NAMES,
      examples: EXAMPLES,
    });
  });

  app.get("/api/plan", (c) => {
    const env = c.env ?? {};
    let req: SiteRequest;
    try { req = readRequest(c.req.url); } catch (e) { return c.json({ error: (e as Error).message }, 400); }
    const mode = qlooMode(env);
    const ip = clientIp((k) => c.req.header(k));

    return streamSSE(c, async (stream) => {
      let chain = Promise.resolve();
      const events: AgentEvent[] = [];
      let held: AgentEvent | undefined; // "done" waits until the final quota line is sent
      const send = (e: AgentEvent) => {
        if (e.type === "done") { held = e; return; }
        events.push(e);
        chain = chain.then(() => stream.writeSSE({ event: e.type, data: JSON.stringify(e) }));
      };
      const replay = async (list: AgentEvent[]) => {
        for (const e of list) {
          if (e.type === "quota") continue;
          await stream.writeSSE({ event: e.type, data: JSON.stringify(e) });
          if (hooks.replayDelayMs) await stream.sleep(hooks.replayDelayMs);
        }
      };
      const quotaLine = (quota: QuotaInfo, source: "fresh" | "cache" | "sample", note?: string) => {
        const e: AgentEvent = { type: "quota", quota, source, ...(note ? { note } : {}) };
        return stream.writeSSE({ event: e.type, data: JSON.stringify(e) });
      };

      let llm;
      try { llm = createProvider(env); } catch (e) { send({ type: "error", message: (e as Error).message }); await chain; return; }
      const live = mode === "live" || !llm.dryRun;
      const store = cacheFor(env);
      const planKey = `plan:v4:${mode}:${llm.id}:${JSON.stringify(req)}`;
      const quota = quotaFor(env);
      const load = mode === "live" && llm.dryRun ? sampleLoader(env, hooks) : undefined;

      if (live) {
        // 1. A recorded sample: 0 Qloo calls, never expires.
        const sample = await loadJson<AgentEvent[]>(load, `samples/${sampleId(req)}.json`);
        if (sample) {
          await quotaLine(await quota.read(), "sample", "Recorded sample plan from the live Qloo API. It costs 0 Qloo calls.");
          await replay(sample);
          return;
        }
        // 2. A finished plan from the KV cache: fast for judges, $0, no Qloo load.
        const cached = await store.get(planKey);
        if (cached) {
          await quotaLine(await quota.read(), "cache", "Cached plan. It costs 0 Qloo calls.");
          await replay(JSON.parse(cached) as AgentEvent[]);
          return;
        }
      }

      let maxCalls: number | undefined;
      if (mode === "live") {
        // 3. The daily quota. When it is used up, show a recorded sample instead of failing.
        const q = await quota.read();
        if (q.exhausted) {
          const index = (await loadJson<SampleIndexEntry[]>(load, "samples/index.json")) ?? [];
          const pick = index.find((x) => x.plan && x.metro === req.metro) ?? index.find((x) => x.plan);
          const fallback = pick ? await loadJson<AgentEvent[]>(load, `samples/${pick.id}.json`) : undefined;
          const why = q.monthRemaining !== undefined && q.monthRemaining < MONTH_RESERVE
            ? "The monthly Qloo quota is almost used up"
            : `Today's demo quota is used up (${q.used} of ${q.cap} fresh Qloo calls)`;
          if (fallback && pick) {
            await quotaLine(q, "sample", `${why}. Here is a recorded sample plan (${pick.brand}) instead. The sample briefs always work; new briefs work again tomorrow (UTC).`);
            await replay(fallback);
          } else {
            await quotaLine(q, "sample", `${why}. New briefs work again tomorrow (UTC).`);
            await stream.writeSSE({ event: "error", data: JSON.stringify({ type: "error", message: `${why}. Try a sample brief.` }) });
          }
          return;
        }
        maxCalls = q.remaining;
      }
      // 4. Per-address limit on new plans. Samples and cached plans never count.
      if (live && (await ipLimited(store, `plan:${ip}`, perHour(env)))) {
        send({ type: "error", message: `Too many new plans from this address (${perHour(env)} an hour). The sample briefs always work.` });
        await chain;
        return;
      }
      if (mode === "live") await quotaLine(await quota.read(), "fresh");

      let monthRemaining: number | undefined;
      const { client } = makeQlooClient(env, {
        cache: mode === "live" ? store : undefined,
        record: hooks.recordQloo,
        fixtureLatencyMs: hooks.fixtureLatencyMs,
        maxCalls,
        onRateLimit: (r) => { if (r.monthRemaining !== undefined) monthRemaining = r.monthRemaining; },
      });
      const rec = !llm.dryRun && hooks.onTranscript ? new RecordingProvider(llm) : undefined;
      const out = await runAgent(req, {
        qloo: client,
        qlooMode: mode,
        llm: rec ?? llm,
        emit: send,
        maxTurns: Number(env.LLM_MAX_TURNS ?? 24),
      });
      await chain;
      if (mode === "live") await quotaLine(await quota.add(client.upstreamCalls, monthRemaining), "fresh");
      if (held) await stream.writeSSE({ event: held.type, data: JSON.stringify(held) });
      if (rec && hooks.onTranscript) await hooks.onTranscript(req, rec.transcript);
      if (live && out.plan && held) await store.put(planKey, JSON.stringify([...events, held]), PLAN_TTL);
    });
  });

  app.get("/api/baseline", async (c) => {
    const env = c.env ?? {};
    let req: SiteRequest;
    try { req = readRequest(c.req.url); } catch (e) { return c.json({ error: (e as Error).message }, 400); }
    try {
      const llm = createProvider(env);
      const mode = qlooMode(env);
      const live = !llm.dryRun || mode === "live";
      const store = cacheFor(env);
      const load = mode === "live" && llm.dryRun ? sampleLoader(env, hooks) : undefined;
      const sample = await loadJson<BaselineReport>(load, `samples/${sampleId(req)}.baseline.json`);
      if (sample) return c.json(sample);
      // No LLM and no recorded answer: say so, at 0 Qloo calls, before any limit or quota.
      if (llm.dryRun && !baselineFixture(req.brand)?.completions[0]) return c.json(unavailableBaseline(req, llm.id));
      const key = `baseline:v4:${mode}:${llm.id}:${JSON.stringify(req)}`;
      const hit = await store.get(key);
      if (hit) return c.json(JSON.parse(hit));
      const quota = quotaFor(env);
      let maxCalls: number | undefined;
      if (mode === "live") {
        const q = await quota.read();
        if (q.exhausted) return c.json({ error: `Today's demo quota is used up (${q.used} of ${q.cap} fresh Qloo calls). The sample briefs always work.` }, 429);
        maxCalls = q.remaining;
      }
      if (live && (await ipLimited(store, `baseline:${clientIp((k) => c.req.header(k))}`, perHour(env)))) {
        return c.json({ error: "Too many requests from this address. Wait an hour, or try a sample brief." }, 429);
      }
      let monthRemaining: number | undefined;
      const { client } = makeQlooClient(env, {
        cache: mode === "live" ? store : undefined,
        maxCalls,
        onRateLimit: (r) => { if (r.monthRemaining !== undefined) monthRemaining = r.monthRemaining; },
      });
      try {
        const report = await runBaseline(req, { llm, qloo: client });
        if (live) await store.put(key, JSON.stringify(report), PLAN_TTL);
        return c.json(report);
      } finally {
        if (mode === "live") await quota.add(client.upstreamCalls, monthRemaining);
      }
    } catch (e) {
      return c.json({ error: (e as Error).message }, 422);
    }
  });

  app.notFound((c) => (c.req.path.startsWith("/api/") ? c.json({ error: "not found" }, 404) : c.text("Not found", 404)));
  return app;
}
