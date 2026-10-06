import type { AnchorVerdict, AreaVerdict, BaselineReport, SitePlan } from "../../shared/types";

const A_LABEL: Record<AreaVerdict, string> = { hot: "hot in Qloo", cold: "cold in Qloo", unknown: "not checkable" };
const P_LABEL: Record<AnchorVerdict, string> = { verified: "in Qloo, right area", wrong_area: "in Qloo, other area", not_found: "not in Qloo" };

export function Compare({ plan, baseline, error, loading }: { plan: SitePlan; baseline?: BaselineReport; error?: string; loading: boolean }) {
  return (
    <div className="compare">
      <div className="compare-intro">
        <p>
          The same brief, sent to an LLM <strong>with no tools</strong>. Each neighbourhood it names is checked against the Qloo heat for this audience,
          and each anchor place it names is looked up in Qloo (<code>/search</code>, then distance to the neighbourhood). Tasteplot cannot fail these checks:
          the server rejects a plan that cites an ID no Qloo call returned.
        </p>
      </div>
      {loading && <p className="muted"><i className="spin" /> Checking the LLM-only answer against Qloo…</p>}
      {error && <p className="note">{error}</p>}
      {baseline?.source === "unavailable" && <p className="note">{baseline.note}</p>}
      {baseline && baseline.source !== "unavailable" && (
        <>
          {baseline.source !== "live" && (
            <p className="note">
              {baseline.source === "illustrative-fixture"
                ? "Dry-run: this LLM-only answer is an illustrative fixture written to show typical failure modes, not a measured model output. Run with an LLM key for the real comparison."
                : `Replayed from a recorded run of ${baseline.model}.`}
            </p>
          )}
          <div className="score-row">
            <div className="score bad">
              <b>{baseline.score.areasHot}/{baseline.score.areas}</b>
              <span>LLM-only neighbourhoods in the hot half of the Qloo heat</span>
            </div>
            <div className="score bad">
              <b>{baseline.score.anchorsVerified}/{baseline.score.anchors}</b>
              <span>LLM-only anchor places found in Qloo in the named area</span>
            </div>
            <div className="score good">
              <b>{plan.sites.reduce((n, s) => n + s.anchors.length, 0)}/{plan.sites.reduce((n, s) => n + s.anchors.length, 0)}</b>
              <span>Tasteplot anchors that are Qloo results in this run</span>
            </div>
          </div>
          <div className="cols">
            <section>
              <h4>LLM only <small>{baseline.model}</small></h4>
              <ul className="cmp-list">
                {baseline.sites.map((s, i) => (
                  <li key={i}>
                    <span className="cmp-city">
                      {s.neighborhood} <span className={`verdict v-${s.areaVerdict}`}>{A_LABEL[s.areaVerdict]}{s.heatRank ? ` · rank ${s.heatRank}` : ""}</span>
                    </span>
                    {s.checkedAnchors.map((a, j) => (
                      <span key={j} className="cmp-line">
                        {a.name} <span className={`verdict v-${a.verdict}`}>{P_LABEL[a.verdict]}</span>
                      </span>
                    ))}
                  </li>
                ))}
              </ul>
            </section>
            <section>
              <h4>Tasteplot <small>{plan.provenance.llm} + Qloo</small></h4>
              <ul className="cmp-list">
                {plan.sites.map((s) => (
                  <li key={s.rank}>
                    <span className="cmp-city">
                      {s.neighborhood.name} <span className="verdict v-hot">heat {Math.round(s.neighborhood.heat * 100)} · rank {s.neighborhood.rank}</span>
                    </span>
                    {s.anchors.slice(0, 3).map((a) => (
                      <span key={a.id} className="cmp-line">
                        {a.name} <span className="verdict v-verified">affinity {a.affinity.toFixed(2)}</span>
                      </span>
                    ))}
                  </li>
                ))}
              </ul>
            </section>
          </div>
        </>
      )}
    </div>
  );
}
