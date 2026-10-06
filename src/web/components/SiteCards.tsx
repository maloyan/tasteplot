import type { SitePlan, SiteRec, WhyChip } from "../../shared/types";

function Chip({ w }: { w: WhyChip }) {
  return (
    <span className="why" title={`Source: ${w.source}`}>
      <span className="why-bar" style={{ width: `${Math.round(Math.max(0, Math.min(1, w.score)) * 100)}%` }} />
      <span className="why-txt">{w.label}</span>
      <b>{w.display ?? w.score.toFixed(2)}</b>
    </span>
  );
}

function Card({ s, on, onSelect }: { s: SiteRec; on: boolean; onSelect: () => void }) {
  return (
    <article className={`card${on ? " card-on" : ""}`} onClick={onSelect}>
      <header className="card-head">
        <span className="card-n">{s.rank}</span>
        <div>
          <h3>{s.neighborhood.name}</h3>
          <span className="muted">
            {s.neighborhood.lift !== undefined
              ? <>lift rank {s.neighborhood.rank} · raw heat rank {s.neighborhood.heatRank} · {s.neighborhood.cells} heat cells</>
              : <>heat rank {s.neighborhood.heatRank} · {s.neighborhood.cells} heat cells</>}
          </span>
        </div>
        <span className="fan" title="Site score: 0.6 x taste fit (lift ÷ 2, capped at 1; raw heat if no baseline) + 0.4 x mean anchor affinity">
          <b>{Math.round(s.score * 100)}</b>
          <small>site score</small>
        </span>
      </header>

      <div className="whys">{s.why.map((w, i) => <Chip key={i} w={w} />)}</div>

      <section className="slot">
        <div className="slot-k">Anchor places the audience already loves</div>
        <ul className="anchors">
          {s.anchors.slice(0, 4).map((a) => (
            <li key={a.id}>
              <strong>{a.name}</strong>
              <span className="muted"> · {a.tags.slice(0, 2).join(", ") || "place"} · {a.distanceM} m</span>
              <b className="aff" title="Qloo query.affinity">{a.affinity.toFixed(2)}</b>
            </li>
          ))}
          {s.anchors.length === 0 && <li className="muted">No anchor places returned.</li>}
        </ul>
      </section>

      {s.brands.length > 0 && (
        <section className="slot">
          <div className="slot-k">Partner brands</div>
          <div className="slot-v">
            {s.brands.slice(0, 3).map((b, i) => (
              <span key={b.id}>{i > 0 && ", "}<strong>{b.name}</strong> <span className="muted">{b.affinity.toFixed(2)}</span></span>
            ))}
          </div>
        </section>
      )}

      <p className="angle">{s.angle}</p>
    </article>
  );
}

const bucket = (b: string) => b.replace(/_/g, " ").replace("and younger", "& under");

export function SiteCards({ plan, selected, onSelect }: { plan: SitePlan; selected?: number; onSelect: (n: number) => void }) {
  const aud = plan.audience;
  return (
    <div>
      <div className="plan-sum">
        <p>{plan.summary}</p>
        <div className="kpis">
          <div><b>{plan.sites.length}</b><span>sites</span></div>
          <div><b>{plan.signals.length}</b><span>taste signals</span></div>
          <div><b>{plan.provenance.qlooCalls}</b><span>Qloo calls</span></div>
          {aud?.topAge && <div><b>{bucket(aud.topAge)}</b><span>age skew</span></div>}
        </div>
      </div>
      <div className="signals">
        {plan.signals.map((s) => (
          <span key={s.id} className={`sig sig-${s.kind}`} title={`${s.kind === "tag" ? "Qloo tag" : "Qloo entity"} ${s.id}, from "${s.from}"`}>
            {s.name}
          </span>
        ))}
      </div>
      <div className="cards">
        {plan.sites.map((s) => <Card key={s.rank} s={s} on={selected === s.rank} onSelect={() => onSelect(s.rank)} />)}
      </div>
    </div>
  );
}
