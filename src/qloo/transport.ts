// Transports move one Qloo request to a response. The client does not know
// whether it talks to the live API, the fixture world, or a cache.

export interface QlooRequest {
  path: string;
  params: Record<string, string>;
}

export interface QlooResponse {
  status: number;
  body: unknown;
  cached?: boolean;
}

export type Transport = (req: QlooRequest) => Promise<QlooResponse>;

export class QlooHttpError extends Error {
  constructor(public status: number, public path: string, public detail: string) {
    super(`Qloo ${path} returned HTTP ${status}${detail ? `: ${detail}` : ""}`);
    this.name = "QlooHttpError";
  }
}

export class QlooBudgetError extends Error {
  constructor(public max: number) {
    super(`Qloo call budget reached (${max} calls). Raise MAX_QLOO_CALLS or plan fewer dates.`);
    this.name = "QlooBudgetError";
  }
}

/** Upstream call budget for one run. `used` counts calls that reached the upstream transport. */
export interface Budget {
  max?: number;
  used: number;
}

/**
 * Enforce the budget on the upstream side of the cache, so cache hits are free.
 * The slot is taken before the await, so parallel calls cannot overshoot.
 * Why: Workers Free allows 50 subrequests per request (UNVERIFIED for 2026).
 */
export function budgetTransport(inner: Transport, budget: Budget): Transport {
  return async (req) => {
    if (budget.max !== undefined && budget.used >= budget.max) throw new QlooBudgetError(budget.max);
    budget.used++;
    return inner(req);
  };
}

export const DEFAULT_BASE_URL = "https://hackathon.api.qloo.com";

export interface HttpTransportOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  retries?: number;
  /** Injected for tests so backoff does not slow them down. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Client-side pace. [LIVE] The hackathon key allows 5 requests per second
   * (x-second-ratelimit-limit: 5) and 10,000 per month (x-month-ratelimit-limit).
   * A plan fires up to 5 calls in parallel, so the transport starts at most this
   * many requests in any 1-second window. Default 4.
   */
  maxPerSecond?: number;
  /**
   * Called with Qloo's own quota headers after each response. [LIVE] The hackathon
   * host sends x-month-ratelimit-remaining on every reply, so the server can show
   * the real monthly quota left and stop before it runs out.
   */
  onRateLimit?: (r: { monthRemaining?: number; monthLimit?: number }) => void;
}

/**
 * Live transport. GET with query-string params and the X-Api-Key header.
 * [DOC] /v2/insights is GET only: a POST with a JSON body fails.
 * [DOC] Hackathon keys return 401 on api.qloo.com and staging.api.qloo.com.
 */
export function httpTransport(opts: HttpTransportOptions): Transport {
  const base = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const f = opts.fetchImpl ?? fetch;
  const retries = opts.retries ?? 2;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const perSecond = Math.max(1, opts.maxPerSecond ?? 4);
  const starts: number[] = [];
  // Reserve a start time synchronously, so parallel callers queue up in order.
  const pace = async () => {
    const now = Date.now();
    const prev = starts.length >= perSecond ? starts[starts.length - perSecond]! : -Infinity;
    const at = Math.max(now, prev + 1000);
    starts.push(at);
    if (starts.length > perSecond * 4) starts.splice(0, starts.length - perSecond);
    if (at > now) await sleep(at - now);
  };
  return async ({ path, params }) => {
    const url = `${base}${path}?${new URLSearchParams(params).toString()}`;
    for (let attempt = 0; ; attempt++) {
      await pace();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 15000);
      let res: Response;
      try {
        res = await f(url, {
          method: "GET",
          headers: { "X-Api-Key": opts.apiKey, Accept: "application/json" },
          signal: ctrl.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        if (attempt < retries) { await sleep(300 * 2 ** attempt); continue; }
        throw new QlooHttpError(0, path, `network error: ${(err as Error).message}`);
      } finally {
        clearTimeout(timer);
      }
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        const ra = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 400 * 2 ** attempt);
        continue;
      }
      if (opts.onRateLimit) {
        const n = (h: string) => { const v = res.headers.get(h); return v !== null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined; };
        opts.onRateLimit({ monthRemaining: n("x-month-ratelimit-remaining"), monthLimit: n("x-month-ratelimit-limit") });
      }
      const text = await res.text();
      if (!res.ok) {
        const hint = res.status === 401 && !base.includes("hackathon")
          ? " (hackathon keys only work on https://hackathon.api.qloo.com)"
          : res.status === 401 ? " (check QLOO_API_KEY)" : "";
        throw new QlooHttpError(res.status, path, text.slice(0, 300) + hint);
      }
      try {
        return { status: res.status, body: JSON.parse(text) };
      } catch {
        throw new QlooHttpError(res.status, path, "response is not JSON");
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, ttlSeconds?: number): Promise<void>;
}

export function memoryStore(): KeyValueStore & { size(): number } {
  const m = new Map<string, { v: string; exp: number }>();
  return {
    async get(k) {
      const e = m.get(k);
      if (!e) return null;
      if (e.exp && e.exp < Date.now()) { m.delete(k); return null; }
      return e.v;
    },
    async put(k, v, ttl) {
      m.set(k, { v, exp: ttl ? Date.now() + ttl * 1000 : 0 });
    },
    size: () => m.size,
  };
}

/** Workers KV adapter. KV needs ttl >= 60 s. */
export function kvStore(kv: KVNamespace): KeyValueStore {
  return {
    get: (k) => kv.get(k),
    put: (k, v, ttl) => kv.put(k, v, ttl ? { expirationTtl: Math.max(60, ttl) } : undefined),
  };
}

/**
 * A cache must never break a plan. A failed get is a miss, a failed put is skipped.
 * Both are logged. Why: Workers KV can refuse a call (a key over 512 bytes, the
 * Workers Free limit of 1,000 writes a day), and a miss only costs one live call,
 * which the call budget still limits.
 */
export function safeStore(store: KeyValueStore, log: (msg: string) => void = (m) => console.warn(m)): KeyValueStore {
  return {
    async get(k) {
      try { return await store.get(k); } catch (e) { log(`cache get failed, treated as a miss (${k.slice(0, 40)}): ${(e as Error).message}`); return null; }
    },
    async put(k, v, ttl) {
      try { await store.put(k, v, ttl); } catch (e) { log(`cache put failed, skipped (${k.slice(0, 40)}): ${(e as Error).message}`); }
    },
  };
}

/** Workers KV refuses keys over 512 bytes (UTF-8). */
export const KV_KEY_MAX_BYTES = 512;

/** Canonical form of a request: method, path, sorted params. The API key is never part of it. */
export function requestKey(req: QlooRequest): string {
  const sorted = Object.keys(req.params).sort().map((k) => `${k}=${req.params[k]}`).join("&");
  return `qloo:v1:${req.path}?${sorted}`;
}

/** SHA-256 hex digest (Web Crypto: Workers and Node 20+). */
export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * KV key for a Qloo request: a short readable prefix plus the SHA-256 of the
 * canonical request. The length is fixed (under 100 bytes) whatever the params are.
 */
export async function cacheKey(req: QlooRequest): Promise<string> {
  const endpoint = req.path.replace(/^\/+/, "").replace(/[^A-Za-z0-9]+/g, "_").slice(0, 32) || "root";
  return `qloo:v2:${endpoint}:${await sha256Hex(`GET ${requestKey(req)}`)}`;
}

/** Cache 2xx responses. Responses with an empty result are cached too: they are real answers. */
export function cachingTransport(inner: Transport, store: KeyValueStore, ttlSeconds = 60 * 60 * 24 * 7): Transport {
  const safe = safeStore(store);
  return async (req) => {
    const key = await cacheKey(req);
    const hit = await safe.get(key);
    if (hit) return { status: 200, body: JSON.parse(hit), cached: true };
    const res = await inner(req);
    if (res.status >= 200 && res.status < 300) await safe.put(key, JSON.stringify(res.body), ttlSeconds);
    return res;
  };
}

/**
 * Keep only the heatmap fields Tasteplot reads (coordinates, geohash, affinity,
 * popularity), rounded. [LIVE] A metro heatmap is 0.5 to 2.2 MB of JSON with 7 to 11
 * fields per cell; the slim copy is about 4x smaller, so the KV cache and the Worker's
 * JSON parse stay cheap. Other responses pass through unchanged.
 */
export function slimHeatmapBody(body: unknown): unknown {
  const r = (body as { results?: { heatmap?: unknown } } | undefined)?.results;
  if (!r || !Array.isArray(r.heatmap)) return body;
  const q4 = (x: unknown) => (typeof x === "number" ? Math.round(x * 1e4) / 1e4 : x);
  const heatmap = (r.heatmap as { location?: Record<string, unknown>; query?: Record<string, unknown> }[]).map((c) => ({
    location: { latitude: c.location?.latitude ?? c.location?.lat, longitude: c.location?.longitude ?? c.location?.lon, geohash: c.location?.geohash },
    query: { affinity: q4(c.query?.affinity), popularity: q4(c.query?.popularity) },
  }));
  return { ...(body as object), results: { ...r, heatmap } };
}

export function slimTransport(inner: Transport): Transport {
  return async (req) => {
    const res = await inner(req);
    return req.params["filter.type"] === "urn:heatmap" ? { ...res, body: slimHeatmapBody(res.body) } : res;
  };
}

/** Wrap a transport and call `onResponse` for each live response (used to record fixtures). */
export function tapTransport(inner: Transport, onResponse: (req: QlooRequest, res: QlooResponse) => void | Promise<void>): Transport {
  return async (req) => {
    const res = await inner(req);
    if (!res.cached) await onResponse(req, res);
    return res;
  };
}
