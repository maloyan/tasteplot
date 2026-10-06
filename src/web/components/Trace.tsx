import { useEffect, useRef, useState } from "react";
import type { TraceStep } from "../../shared/types";

export type TraceItem = { kind: "thought"; id: string; text: string } | { kind: "step"; id: string; step: TraceStep };

const TOOL_ICON: Record<string, string> = {
  resolve_audience: "◎", map_taste_heat: "◉", audience_profile: "◐", find_anchor_places: "▣",
  find_partner_brands: "◇", compare_audiences: "⇋", submit_site_plan: "✓",
};

function StepRow({ step }: { step: TraceStep }) {
  const [open, setOpen] = useState(false);
  return (
    <li className={`step step-${step.status}`}>
      <button className="step-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="step-icon" aria-hidden>{step.status === "running" ? <i className="spin" /> : TOOL_ICON[step.tool] ?? "•"}</span>
        <span className="step-label">{step.label}</span>
        <span className="step-meta">
          {step.qloo.length > 0 && <span className="chip-q">{step.qloo.length}× Qloo</span>}
          {step.ms !== undefined && <span>{step.ms} ms</span>}
        </span>
      </button>
      {step.summary && <div className="step-sum">{step.summary}</div>}
      {open && step.qloo.length > 0 && (
        <div className="step-req">
          {step.qloo.map((q, i) => (
            <code key={i}>
              GET {q.path}?{Object.entries(q.params).map(([k, v]) => `${k}=${v}`).join("&")}
              <em> → {q.count} result{q.count === 1 ? "" : "s"}{q.cached ? ", cached" : ""}</em>
            </code>
          ))}
        </div>
      )}
    </li>
  );
}

export function Trace({ items, running }: { items: TraceItem[]; running: boolean }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }); }, [items.length]);
  if (!items.length) {
    return (
      <div className="trace-empty">
        The agent's live trace shows here: each tool call, the Qloo requests behind it, and the agent's reasoning between steps.
      </div>
    );
  }
  return (
    <ol className="trace" aria-live="polite">
      {items.map((it) =>
        it.kind === "thought" ? <li key={it.id} className="thought">{it.text}</li> : <StepRow key={it.id} step={it.step} />,
      )}
      {running && <li className="thought thinking"><i className="spin" /> working…</li>}
      <div ref={end} />
    </ol>
  );
}
