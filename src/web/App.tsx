import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentEvent, BaselineReport, HeatCell, NeighborhoodHeat, Provenance, QuotaInfo, SeedCandidate, SitePlan, SiteRequest } from "../shared/types";
import { getBaseline, getConfig, streamPlan, toQuery, type AppConfig } from "./api";
import { MapView } from "./components/MapView";
import { Trace, type TraceItem } from "./components/Trace";
import { SiteCards } from "./components/SiteCards";
import { Compare } from "./components/Compare";
import { Checks } from "./components/Checks";
import { splitNames } from "../shared/names";
import { mdToHtml } from "./md";

type Status = "idle" | "running" | "needs_input" | "done" | "error";
type Tab = "plan" | "checks" | "compare" | "memo";

const DEFAULT: SiteRequest = {
  brand: "Fieldwork Coffee",
  audience: "specialty coffee, cycling, record stores",
  seeds: ["Blue Bottle Coffee", "Rapha", "Kinfolk"],
  metro: "chi",
  compareMetro: "nyc",
  format: "store",
  sites: 3,
};

const list = splitNames;

function fromUrl(): SiteRequest | undefined {
  const p = new URLSearchParams(location.search);
  if (!p.get("brand") || !p.get("metro")) return undefined;
  const picks: Record<string, string> = {};
  for (const [k, v] of p.entries()) if (k.startsWith("pick.")) picks[k.slice(5)] = v;
  return {
    brand: p.get("brand")!,
    audience: p.get("audience") ?? "",
    seeds: list(p.get("seeds") ?? ""),
    metro: p.get("metro")!,
    compareMetro: p.get("compareMetro") ?? undefined,
    compareSeeds: p.get("compareSeeds") ? list(p.get("compareSeeds")!) : undefined,
    format: p.get("format") === "popup" ? "popup" : "store",
    sites: Number(p.get("sites") ?? 3) || 3,
    picks: Object.keys(picks).length ? picks : undefined,
  };
}

export function App() {
  const [cfg, setCfg] = useState<AppConfig>();
  const [req, setReq] = useState<SiteRequest>(DEFAULT);
  const [seedText, setSeedText] = useState(DEFAULT.seeds.join(", "));
  const [cmpSeedText, setCmpSeedText] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [items, setItems] = useState<TraceItem[]>([]);
  const [heat, setHeat] = useState<HeatCell[]>([]);
  const [hoods, setHoods] = useState<NeighborhoodHeat[]>([]);
  const [plan, setPlan] = useState<SitePlan>();
  const [prov, setProv] = useState<Provenance>();
  const [mode, setMode] = useState<{ qloo: string; llm: string }>();
  const [error, setError] = useState<string>();
  const [quota, setQuota] = useState<{ quota: QuotaInfo; note?: string; source?: string }>();
  const [ask, setAsk] = useState<{ seed: string; candidates: SeedCandidate[] }>();
  const [tab, setTab] = useState<Tab>("plan");
  const [selected, setSelected] = useState<number>();
  const [baseline, setBaseline] = useState<BaselineReport>();
  const [baselineErr, setBaselineErr] = useState<string>();
  const [baselineLoading, setBaselineLoading] = useState(false);
  const cancel = useRef<() => void>(() => {});
  const activeMetro = useRef<string>(DEFAULT.metro);

  useEffect(() => { getConfig().then(setCfg).catch(() => {}); }, []);

  const onEvent = useCallback((e: AgentEvent) => {
    switch (e.type) {
      case "start": setMode(e.mode); break;
      case "quota": setQuota((q) => ({ quota: e.quota, source: e.source, note: e.note ?? (e.source === q?.source ? q?.note : undefined) })); break;
      case "thought": setItems((xs) => [...xs, { kind: "thought", id: `t${xs.length}`, text: e.text }]); break;
      case "step":
        setItems((xs) => {
          const i = xs.findIndex((x) => x.kind === "step" && x.id === e.step.id);
          if (i < 0) return [...xs, { kind: "step", id: e.step.id, step: e.step }];
          const copy = xs.slice();
          copy[i] = { kind: "step", id: e.step.id, step: e.step };
          return copy;
        });
        break;
      case "heatmap":
        // Only the primary metro paints the map; the compare metro shows in the Checks tab.
        if (e.metroId === activeMetro.current) { setHeat(e.cells); setHoods(e.neighborhoods); }
        break;
      case "plan": setPlan(e.plan); setSelected(undefined); break;
      case "needs_input": setAsk({ seed: e.seed, candidates: e.candidates }); setStatus("needs_input"); break;
      case "error": setError(e.message); setStatus("error"); break;
      case "done": setProv(e.provenance); setStatus((s) => (s === "running" ? "done" : s)); break;
    }
  }, []);

  const run = useCallback((r: SiteRequest) => {
    cancel.current();
    setReq(r);
    setSeedText(r.seeds.join(", "));
    setCmpSeedText(r.compareSeeds?.join(", ") ?? "");
    activeMetro.current = r.metro;
    setStatus("running");
    setItems([]); setHeat([]); setHoods([]); setPlan(undefined); setProv(undefined);
    setError(undefined); setAsk(undefined); setBaseline(undefined); setBaselineErr(undefined); setQuota(undefined);
    setTab("plan");
    history.replaceState(null, "", `?${toQuery(r)}`);
    cancel.current = streamPlan(r, onEvent);
  }, [onEvent]);

  // Deep link: a URL with brand and metro runs the brief on load.
  useEffect(() => {
    const r = fromUrl();
    if (r) run(r);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load the LLM-only comparison once a plan exists.
  useEffect(() => {
    if (!plan) return;
    setBaselineLoading(true);
    getBaseline(plan.request)
      .then(setBaseline)
      .catch((e: Error) => setBaselineErr(e.message))
      .finally(() => setBaselineLoading(false));
  }, [plan]);

  const isFixture = (mode?.qloo ?? cfg?.qloo) !== "live";
  const memoHtml = useMemo(() => (plan ? mdToHtml(plan.memoMarkdown) : ""), [plan]);
  const metro = cfg?.metros.find((m) => m.id === req.metro);
  const center = metro ? ([metro.lon, metro.lat] as [number, number]) : undefined;

  const download = () => {
    if (!plan) return;
    const blob = new Blob([plan.memoMarkdown], { type: "text/markdown" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${plan.brand.replace(/\W+/g, "-").toLowerCase()}-${plan.metro.id}-site-memo.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const cs = list(cmpSeedText);
    run({ ...req, seeds: list(seedText), compareSeeds: cs.length ? cs : undefined, picks: undefined });
  };

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <svg viewBox="0 0 64 64" width="28" height="28" aria-hidden><circle cx="32" cy="32" r="24" fill="none" stroke="var(--violet)" strokeWidth="3" opacity="0.6" /><circle cx="32" cy="32" r="14" fill="none" stroke="var(--pink)" strokeWidth="3" opacity="0.8" /><path d="M32 14 C24 14 19 20 19 27 C19 37 32 50 32 50 C32 50 45 37 45 27 C45 20 40 14 32 14 Z" fill="var(--amber)" /><circle cx="32" cy="27" r="5" fill="#1b1000" /></svg>
          <div>
            <h1>Tasteplot</h1>
            <p>Open where your customers' taste already lives.</p>
          </div>
        </div>
        <div className="badges">
          <span className={`badge ${isFixture ? "badge-warn" : "badge-live"}`} title={isFixture ? "Synthetic fixture world. Not Qloo data." : "Live Qloo hackathon API"}>
            {isFixture ? "FIXTURE DATA" : "LIVE QLOO"}
          </span>
          <span className="badge">planner: {mode?.llm ?? "…"}</span>
        </div>
      </header>

      <div className="layout">
        <aside className="side">
          <form className="form" onSubmit={submit}>
            <label>
              <span>Brand</span>
              <input value={req.brand} onChange={(e) => setReq({ ...req, brand: e.target.value })} placeholder="e.g. Fieldwork Coffee" required />
            </label>
            <label>
              <span>Your customer, in plain words</span>
              <input value={req.audience} onChange={(e) => setReq({ ...req, audience: e.target.value })} placeholder="specialty coffee, cycling, vinyl" />
            </label>
            <label>
              <span>They love (brands, artists, places, books)</span>
              <input value={seedText} onChange={(e) => setSeedText(e.target.value)} placeholder="Blue Bottle Coffee, Rapha, Kinfolk" />
            </label>
            <div className="row2">
              <label>
                <span>Metro</span>
                <select value={req.metro} onChange={(e) => setReq({ ...req, metro: e.target.value, compareMetro: req.compareMetro === e.target.value ? undefined : req.compareMetro })}>
                  {(cfg?.metros ?? [{ id: "chi", name: "Chicago" }]).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              </label>
              <label>
                <span>Format</span>
                <select value={req.format} onChange={(e) => setReq({ ...req, format: e.target.value === "popup" ? "popup" : "store" })}>
                  <option value="store">Store</option>
                  <option value="popup">Pop-up</option>
                </select>
              </label>
            </div>
            <label>
              <span>Sites <b>{req.sites}</b></span>
              <input type="range" min={1} max={5} value={req.sites} onChange={(e) => setReq({ ...req, sites: Number(e.target.value) })} />
            </label>
            <details className="more">
              <summary>Compare (optional)</summary>
              <div className="row2">
                <label>
                  <span>Second metro</span>
                  <select value={req.compareMetro ?? ""} onChange={(e) => setReq({ ...req, compareMetro: e.target.value || undefined })}>
                    <option value="">none</option>
                    {(cfg?.metros ?? []).filter((m) => m.id !== req.metro).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </select>
                </label>
                <label>
                  <span>Second audience</span>
                  <input value={cmpSeedText} onChange={(e) => setCmpSeedText(e.target.value)} placeholder="e.g. Starbucks" />
                </label>
              </div>
            </details>
            <button className="go" type="submit" disabled={status === "running"}>
              {status === "running" ? "Scouting…" : "Find my sites"}
            </button>
            {cfg && (
              <div className="examples">
                {cfg.examples.map((x) => (
                  <button type="button" key={x.label} onClick={() => run(x)} disabled={status === "running"}>{x.label}</button>
                ))}
              </div>
            )}
            {isFixture && cfg && (
              <p className="fineprint">Fixture world knows: {cfg.fixtureSeeds.join(", ")}.</p>
            )}
          </form>

          <div className="trace-wrap">
            <h2>Agent trace {prov && <small>{prov.llmTurns} turns · {prov.qlooCalls} Qloo calls · {(prov.ms / 1000).toFixed(1)} s</small>}</h2>
            {quota && (
              <div className={`quota${quota.quota.exhausted ? " quota-out" : ""}`} title="Fresh Qloo calls left today for this public demo. Cached calls, cached plans and sample plans cost 0.">
                Qloo demo quota: <b>{quota.quota.remaining}</b> of {quota.quota.cap} fresh calls left today
                {quota.quota.monthRemaining !== undefined && <> · {quota.quota.monthRemaining.toLocaleString("en-US")} left this month (Qloo)</>}
                {quota.note && <div className="quota-note">{quota.note}</div>}
              </div>
            )}
            <Trace items={items} running={status === "running"} />
            {error && <p className="err">{error}</p>}
            {prov && prov.warnings.length > 0 && (
              <details className="warns"><summary>{prov.warnings.length} data warning(s)</summary><ul>{prov.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul></details>
            )}
          </div>
        </aside>

        <main className="main">
          <div className="map-wrap">
            <MapView heat={heat} neighborhoods={hoods} center={status === "idle" ? undefined : center} plan={plan} selected={selected} onSelect={setSelected} />
            <div className="legend">
              <span className="legend-heat" /> taste heat (Qloo heatmap; labels show lift vs the going-out baseline)
              <span className="legend-anchor" /> anchor places
            </div>
            {status === "idle" && (
              <div className="map-hint">
                <h2>Where does your customer already hang out?</h2>
                <p>Describe your customer. The agent maps where that taste lives in a city with Qloo, ranks neighbourhoods, and names the places and brands your audience already loves, with the why for each pick.</p>
              </div>
            )}
          </div>

          {plan && (
            <section className="results">
              <nav className="tabs" role="tablist">
                <button role="tab" aria-selected={tab === "plan"} onClick={() => setTab("plan")}>Site plan</button>
                <button role="tab" aria-selected={tab === "checks"} onClick={() => setTab("checks")}>Compare</button>
                <button role="tab" aria-selected={tab === "compare"} onClick={() => setTab("compare")}>
                  Without Qloo {baseline && baseline.source !== "unavailable" && <span className="tab-badge">{baseline.score.anchors - baseline.score.anchorsVerified} bad anchors</span>}
                </button>
                <button role="tab" aria-selected={tab === "memo"} onClick={() => setTab("memo")}>Site memo</button>
              </nav>
              {tab === "plan" && <SiteCards plan={plan} selected={selected} onSelect={setSelected} />}
              {tab === "checks" && <Checks plan={plan} />}
              {tab === "compare" && <Compare plan={plan} baseline={baseline} error={baselineErr} loading={baselineLoading} />}
              {tab === "memo" && (
                <div className="pitch">
                  <div className="pitch-actions">
                    <button onClick={download}>Download .md</button>
                    <button onClick={() => window.print()}>Print / PDF</button>
                    <button onClick={() => navigator.clipboard?.writeText(plan.memoMarkdown)}>Copy</button>
                  </div>
                  <div className="pitch-doc" dangerouslySetInnerHTML={{ __html: memoHtml }} />
                </div>
              )}
            </section>
          )}
        </main>
      </div>

      {status === "needs_input" && ask && (
        <div className="modal" role="dialog" aria-modal="true" aria-labelledby="dis-title">
          <div className="modal-box">
            <h2 id="dis-title">Which “{ask.seed}”?</h2>
            <p className="muted">Qloo has more than one entity with this name. The agent stops instead of guessing.</p>
            <div className="cands">
              {ask.candidates.map((c) => (
                <button key={c.id} className="cand" onClick={() => run({ ...req, picks: { ...(req.picks ?? {}), [ask.seed]: c.id } })}>
                  <strong>{c.name}</strong>
                  <span>{c.disambiguation ?? c.type ?? ""}</span>
                  {c.type && <small>{c.type}{c.popularity !== undefined ? ` · popularity ${c.popularity.toFixed(2)}` : ""}</small>}
                </button>
              ))}
            </div>
            <button className="link" onClick={() => setStatus("idle")}>Cancel</button>
          </div>
        </div>
      )}

      <footer className="foot">
        Taste data: Qloo Taste AI {isFixture ? "(here: synthetic fixtures, not Qloo output)" : "hackathon API"}. Map: OpenFreeMap, OpenStreetMap contributors. MIT licensed.
      </footer>
    </div>
  );
}
