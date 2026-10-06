// Pick the Qloo transport from config. Setting QLOO_API_KEY is the one-line
// switch from fixtures to the live hackathon API.
import { QlooClient, type CallRecord } from "./client";
import { fixtureTransport } from "./fixtures/transport";
import { budgetTransport, cachingTransport, DEFAULT_BASE_URL, httpTransport, slimTransport, tapTransport, type Budget, type KeyValueStore, type QlooRequest, type QlooResponse, type Transport } from "./transport";

export interface QlooConfig {
  QLOO_API_KEY?: string;
  QLOO_BASE_URL?: string;
  QLOO_MODE?: string;
  MAX_QLOO_CALLS?: string | number;
}

export type QlooMode = "live" | "fixtures";

export function qlooMode(cfg: QlooConfig): QlooMode {
  if (cfg.QLOO_MODE === "fixtures") return "fixtures";
  return cfg.QLOO_API_KEY ? "live" : "fixtures";
}

export interface MakeClientOptions {
  cache?: KeyValueStore;
  record?: (req: QlooRequest, res: QlooResponse) => void | Promise<void>;
  onCall?: (rec: CallRecord) => void;
  fixtureLatencyMs?: number;
  fetchImpl?: typeof fetch;
  /** Upstream call limit for this run. Overrides MAX_QLOO_CALLS when it is lower (daily quota). */
  maxCalls?: number;
  /** Qloo's own monthly quota headers, live mode only. */
  onRateLimit?: (r: { monthRemaining?: number; monthLimit?: number }) => void;
}

export function makeQlooClient(cfg: QlooConfig, o: MakeClientOptions = {}): { client: QlooClient; mode: QlooMode } {
  const mode = qlooMode(cfg);
  let t: Transport =
    mode === "live"
      ? httpTransport({ apiKey: cfg.QLOO_API_KEY!, baseUrl: cfg.QLOO_BASE_URL || DEFAULT_BASE_URL, fetchImpl: o.fetchImpl, onRateLimit: o.onRateLimit })
      : fixtureTransport({ latencyMs: o.fixtureLatencyMs });
  if (o.record && mode === "live") t = tapTransport(t, o.record);
  const cfgMax = cfg.MAX_QLOO_CALLS !== undefined && cfg.MAX_QLOO_CALLS !== "" ? Number(cfg.MAX_QLOO_CALLS) : undefined;
  const limits = [cfgMax, o.maxCalls].filter((x): x is number => x !== undefined && Number.isFinite(x));
  const budget: Budget = { max: limits.length ? Math.min(...limits) : undefined, used: 0 };
  // Order: client -> cache -> slim -> budget -> (record) -> http. Cache hits cost no budget.
  t = budgetTransport(t, budget);
  t = slimTransport(t);
  if (o.cache) t = cachingTransport(t, o.cache);
  const client = new QlooClient({
    transport: t,
    paramMode: mode === "live" ? "warn" : "strict",
    budget,
    onCall: o.onCall,
  });
  return { client, mode };
}

export { QlooClient } from "./client";
