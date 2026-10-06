import type { AgentEvent, BaselineReport, SiteRequest } from "../shared/types";

export interface MetroOption {
  id: string;
  name: string;
  lat: number;
  lon: number;
}

export interface AppConfig {
  qloo: "fixtures" | "live";
  metros: MetroOption[];
  fixtureSeeds: string[];
  examples: (SiteRequest & { label: string })[];
}

export async function getConfig(): Promise<AppConfig> {
  const r = await fetch("/api/config");
  return r.json();
}

/** Query string for a request. Lists are comma separated; picks are `pick.<seed>=<id>`. */
export function toQuery(req: SiteRequest): string {
  const p = new URLSearchParams({
    brand: req.brand,
    audience: req.audience,
    seeds: req.seeds.join(";"),
    metro: req.metro,
    format: req.format,
    sites: String(req.sites),
  });
  if (req.compareMetro) p.set("compareMetro", req.compareMetro);
  if (req.compareSeeds?.length) p.set("compareSeeds", req.compareSeeds.join(";"));
  for (const [seed, id] of Object.entries(req.picks ?? {})) p.set(`pick.${seed}`, id);
  return p.toString();
}

const EVENT_TYPES: AgentEvent["type"][] = ["start", "quota", "thought", "step", "needs_input", "heatmap", "plan", "error", "done"];

/** Stream one run. Returns a function that cancels the stream. */
export function streamPlan(req: SiteRequest, onEvent: (e: AgentEvent) => void): () => void {
  const es = new EventSource(`/api/plan?${toQuery(req)}`);
  let closed = false;
  const close = () => { closed = true; es.close(); };
  for (const t of EVENT_TYPES) {
    es.addEventListener(t, (m) => {
      const e = JSON.parse((m as MessageEvent).data) as AgentEvent;
      onEvent(e);
      if (e.type === "done" || e.type === "needs_input") close();
    });
  }
  es.onerror = () => {
    if (!closed) onEvent({ type: "error", message: "Connection to the agent was lost." });
    close();
  };
  return close;
}

export async function getBaseline(req: SiteRequest): Promise<BaselineReport> {
  const r = await fetch(`/api/baseline?${toQuery(req)}`);
  const body = (await r.json()) as BaselineReport & { error?: string };
  if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
  return body as BaselineReport;
}
