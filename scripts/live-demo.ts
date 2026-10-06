// Live demo check: run every sample brief through the real server route
// (/api/plan, SSE) against the LIVE Qloo API with the scripted planner ($0 LLM).
// For each brief it checks that the server accepted the plan, and then checks
// grounding a second time, independently: every neighbourhood must have heat
// cells, and every anchor and brand ID in the plan must appear in a raw Qloo
// response recorded in this run.
//   npx tsx --env-file=.env scripts/live-demo.ts            (check only)
//   npx tsx --env-file=.env scripts/live-demo.ts --record   (also refresh fixtures/qloo/recorded/)
//   npx tsx --env-file=.env scripts/live-demo.ts --samples  (also write public/samples/: the recorded
//     sample plans the server replays at 0 Qloo calls, see sampleId in src/server/app.ts)
// --record writes full responses to fixtures/qloo/recorded/raw/ (gitignored) and small
// curated copies to fixtures/qloo/recorded/<brief>/ (committed, used by the tests).
// The API key is only ever a request header, so it never reaches a recorded file.
// About 22 Qloo calls per brief.
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EXAMPLES, makeApp, readRequest, sampleId, type SampleIndexEntry } from "../src/server/app";
import { hash32, slug } from "../src/qloo/fixtures/util";
import { requestKey, type QlooRequest, type QlooResponse } from "../src/qloo/transport";
import type { SitePlan } from "../src/shared/types";

const RECORD = process.argv.includes("--record");
const SAMPLES = process.argv.includes("--samples");
const SAMPLE_DIR = join(process.cwd(), "public/samples");
const sampleIndex: SampleIndexEntry[] = [];

/** Save one recorded stream as a sample. Quota lines are dropped: the server adds a fresh one. */
async function saveSample(app: ReturnType<typeof makeApp>, env: Record<string, string | undefined>, query: URLSearchParams, events: { ev?: string; data: Json }[], brand: string) {
  const req = readRequest(`http://local/api/plan?${query}`);
  const id = sampleId(req);
  const plan = events.some((e) => e.ev === "plan");
  await mkdir(SAMPLE_DIR, { recursive: true });
  await writeFile(join(SAMPLE_DIR, `${id}.json`), JSON.stringify(events.filter((e) => e.ev !== "quota").map((e) => e.data)));
  if (plan) {
    const r = await app.request(`/api/baseline?${query}`, {}, env);
    if (r.ok) await writeFile(join(SAMPLE_DIR, `${id}.baseline.json`), await r.text());
    else console.log(`(no baseline sample: ${(await r.json() as Json).error})`);
  }
  sampleIndex.push({ id, brand, metro: req.metro, plan });
}
const ROOT = join(process.cwd(), "fixtures/qloo/recorded");

type Json = Record<string, any>;
let current = "";
const recorded: { brief: string; req: QlooRequest; body: unknown }[] = [];

async function onQloo(req: QlooRequest, res: QlooResponse) {
  recorded.push({ brief: current, req, body: res.body });
  if (RECORD) {
    await mkdir(join(ROOT, "raw"), { recursive: true });
    await writeFile(join(ROOT, "raw", `${req.path.replace(/\W+/g, "_")}-${hash32(requestKey(req)).toString(16)}.json`), JSON.stringify({ request: req, status: res.status, body: res.body }, null, 1));
  }
}

function parseSSE(text: string) {
  return text.split("\n\n").filter(Boolean).map((b) => ({ ev: b.match(/^event: (.*)$/m)?.[1], data: JSON.parse(b.match(/^data: (.*)$/m)?.[1] ?? "null") as Json }));
}

// ---- Curated copies: same shape as live, trimmed to a few KB ----------------
const keepProps = (p: Json | undefined) => (p ? Object.fromEntries(Object.entries(p).filter(([k]) => ["address", "short_description", "geocode", "business_rating", "price_level"].includes(k))) : p);
const trimEntity = (e: Json) => ({ ...e, properties: keepProps(e.properties), tags: (e.tags ?? []).slice(0, 3), external: undefined, references: undefined });
function curate(body: Json): Json {
  const r = body.results;
  if (Array.isArray(r)) return { ...body, results: r.slice(0, 3).map(trimEntity) };
  if (!r) return body;
  const out: Json = { ...r };
  if (r.entities) out.entities = r.entities.slice(0, 3).map(trimEntity);
  if (r.heatmap) out.heatmap = r.heatmap.slice(0, 12);
  if (r.tags) out.tags = r.tags.slice(0, 6);
  if (r.a) out.a = r.a.slice(0, 6);
  if (r.b) out.b = r.b.slice(0, 6);
  return { ...body, results: out, ...(r.heatmap ? { _curated_note: `first 12 of ${r.heatmap.length} cells` } : {}) };
}

async function writeCurated(brief: string) {
  const dir = join(ROOT, brief);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const seen = new Map<string, number>();
  for (const { req, body } of recorded.filter((r) => r.brief === brief)) {
    const kind = `${req.path}${req.params["filter.type"] ? `-${req.params["filter.type"]}` : ""}`.replace(/^\//, "").replace(/\W+/g, "-");
    const n = (seen.get(kind) ?? 0) + 1;
    seen.set(kind, n);
    if (n > 1) continue; // one of each kind is enough for a contract test
    await writeFile(join(dir, `${kind}-${n}.json`), JSON.stringify({ request: req, body: curate(body as Json) }, null, 1) + "\n");
  }
}

// ---- Independent grounding check -------------------------------------------
function idsInResponses(): Set<string> {
  const ids = new Set<string>();
  const visit = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) (k === "entity_id" && typeof x === "string" ? ids.add(x) : visit(x));
  };
  recorded.forEach((r) => visit(r.body));
  return ids;
}

function check(plan: SitePlan): string[] {
  const ids = idsInResponses();
  const errs: string[] = [];
  for (const s of plan.sites) {
    if (!(s.neighborhood.cells > 0)) errs.push(`${s.neighborhood.name}: no heat cells`);
    for (const a of s.anchors) if (!ids.has(a.id)) errs.push(`anchor ${a.name} (${a.id}) not in any Qloo response`);
    for (const b of s.brands) if (!ids.has(b.id)) errs.push(`brand ${b.name} (${b.id}) not in any Qloo response`);
  }
  return errs;
}

async function main() {
  if (!process.env.QLOO_API_KEY) throw new Error("Set QLOO_API_KEY (npx tsx --env-file=.env ...). This script only runs live.");
  // Scripted planner only: no LLM key reaches the app, so LLM spend is $0.
  const env = { QLOO_API_KEY: process.env.QLOO_API_KEY, QLOO_BASE_URL: process.env.QLOO_BASE_URL || undefined, LLM_PROVIDER: "scripted", MAX_QLOO_CALLS: "48" };
  const app = makeApp({ recordQloo: onQloo });
  let failed = 0;
  for (const ex of EXAMPLES) {
    current = slug(ex.brand);
    const q = new URLSearchParams({ brand: ex.brand, audience: ex.audience, seeds: ex.seeds.join(";"), metro: ex.metro, format: ex.format ?? "store", sites: String(ex.sites) });
    if (ex.compareMetro) q.set("compareMetro", ex.compareMetro);
    if (ex.compareSeeds?.length) q.set("compareSeeds", ex.compareSeeds.join(";"));
    let events = parseSSE(await (await app.request(`/api/plan?${q}`, {}, env)).text());
    const ask = events.find((e) => e.ev === "needs_input")?.data;
    if (SAMPLES) await saveSample(app, env, q, events, ex.brand);
    if (ask) {
      console.log(`\n## ${ex.label}: asks "Which ${ask.seed}?" -> ${ask.candidates.map((c: Json) => `${c.name} [${c.type}] p=${c.popularity?.toFixed(3)}`).join(" | ")}`);
      const brand = ask.candidates.find((c: Json) => c.type === "urn:entity:brand") ?? ask.candidates[0];
      q.set(`pick.${ask.seed}`, brand.id);
      events = parseSSE(await (await app.request(`/api/plan?${q}`, {}, env)).text());
      if (SAMPLES) await saveSample(app, env, q, events, ex.brand);
    }
    const plan = events.find((e) => e.ev === "plan")?.data.plan as SitePlan | undefined;
    const err = events.find((e) => e.ev === "error")?.data.message;
    console.log(`\n## ${ex.label}${ask ? ` (picked ${ask.seed} = brand)` : ""}`);
    if (!plan) { failed++; console.log(`NO PLAN. ${err ?? ""}`); continue; }
    console.log(`signals: ${plan.signals.map((s) => `${s.name} [${s.kind === "tag" ? s.id : s.type}]`).join("; ")}`);
    console.log(`audience: top age ${plan.audience?.topAge ?? "-"}; gender ${JSON.stringify(plan.audience?.gender ?? {})}`);
    const hot = plan.neighborhoods.filter((h) => h.cells);
    console.log(`by raw heat: ${[...hot].sort((a, b) => a.heatRank - b.heatRank).slice(0, 5).map((h) => `${h.name} ${h.heat}`).join(", ")}`);
    console.log(`by lift:     ${hot.slice(0, 5).map((h) => `${h.name} ${h.lift !== undefined ? `${h.lift}x (heat ${h.heat}, base ${h.baseHeat})` : h.heat}`).join(", ")}; map cells ${plan.heatmap.length}`);
    for (const s of plan.sites) {
      console.log(`  #${s.rank} ${s.neighborhood.name} score ${s.score} | anchors: ${s.anchors.map((a) => `${a.name} ${a.affinity} ${a.distanceM}m`).join(", ")} | brands: ${s.brands.map((b) => `${b.name} ${b.affinity}`).join(", ") || "-"} | why: ${s.why.map((w) => `${w.label} ${w.score}`).join(", ")}`);
    }
    if (plan.metroCompare) console.log(`metro compare: ${plan.metroCompare.a.metroId} vs ${plan.metroCompare.b.metroId}, top b: ${plan.metroCompare.b.top.slice(0, 3).map((h) => h.name).join(", ")}`);
    if (plan.audienceCompare) console.log(`audience compare: ${plan.audienceCompare.tags.length} tags, overlap ${plan.audienceCompare.overlap}; shared ${plan.audienceCompare.tags.filter((t) => t.lean === "shared").map((t) => t.name).slice(0, 4).join(", ")}`);
    console.log(`qloo calls ${plan.provenance.qlooCalls}; warnings: ${plan.provenance.warnings.join(" | ") || "none"}`);
    const errs = check(plan);
    console.log(errs.length ? `GROUNDING FAILED:\n- ${errs.join("\n- ")}` : "grounding: server accepted, and every anchor and brand ID is in a recorded Qloo response");
    if (errs.length) failed++;
    if (RECORD) await writeCurated(current);
  }
  if (SAMPLES) {
    await writeFile(join(SAMPLE_DIR, "index.json"), JSON.stringify(sampleIndex, null, 1) + "\n");
    console.log(`\nWrote ${sampleIndex.length} sample streams to public/samples/.`);
  }
  console.log(`\nUpstream Qloo calls this run: ${recorded.length}`);
  if (failed) process.exit(1);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
