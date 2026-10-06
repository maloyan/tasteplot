import type { MetroFit, SitePlan } from "../../shared/types";

function Fit({ f, win }: { f: MetroFit; win: boolean }) {
  return (
    <section className={`fit${win ? " fit-win" : ""}`}>
      <h4>{f.name} {win && <span className="verdict v-verified">stronger fit</span>}</h4>
      <div className="kpis">
        <div><b>{Math.round(f.topHeat * 100)}</b><span>top-3 heat</span></div>
        <div><b>{Math.round(f.hotShare * 100)}%</b><span>hot cells</span></div>
      </div>
      <ol className="fit-list">
        {f.top.map((t) => <li key={t.name}>{t.name} <b>{Math.round(t.heat * 100)}</b></li>)}
      </ol>
    </section>
  );
}

export function Checks({ plan }: { plan: SitePlan }) {
  const m = plan.metroCompare;
  const c = plan.audienceCompare;
  if (!m && !c) {
    return <p className="muted">No comparison in this brief. Add a second metro or a second audience in the form to compare.</p>;
  }
  return (
    <div className="checks">
      {m && (
        <>
          <p className="compare-intro">Same audience signal, two metros. Each side is one Qloo heatmap call (<code>filter.type=urn:heatmap</code>), snapped to neighbourhoods by code.</p>
          <div className="cols">
            <Fit f={m.a} win={m.winner === m.a.metroId} />
            <Fit f={m.b} win={m.winner === m.b.metroId} />
          </div>
        </>
      )}
      {c && (
        <>
          <p className="compare-intro">
            Two audiences, one call to <code>/v2/analysis/compare</code>: <strong>{c.a.map((s) => s.name).join(", ")}</strong> vs <strong>{c.b.map((s) => s.name).join(", ")}</strong>.
            {c.overlap !== undefined && <> Tag overlap <b>{Math.round(c.overlap * 100)}%</b>.</>}
          </p>
          <div className="cols cols-3">
            {(["a", "shared", "b"] as const).map((side) => (
              <section key={side}>
                <h4>{side === "shared" ? "Shared taste" : `Leans to ${(side === "a" ? c.a : c.b).map((s) => s.name).join(", ")}`}</h4>
                <ul className="tag-list">
                  {c.tags.filter((t) => t.lean === side).slice(0, 8).map((t) => <li key={t.name}>{t.name}{t.score !== undefined && <small> {t.score.toFixed(2)}</small>}</li>)}
                </ul>
              </section>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
