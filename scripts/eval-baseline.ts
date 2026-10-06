// Eval: how often does an LLM with no tools name neighbourhoods that do not fit
// the audience, and anchor places that Qloo cannot find in that neighbourhood?
// Runs the LLM-only baseline for a list of briefs and checks each answer
// against Qloo (see src/agent/baseline.ts).
//
// Dry-run (default): the illustrative fixtures on the fixture world. $0. The
// output is labelled; it is NOT a measurement.
// Live: needs LLM_PROVIDER + key AND QLOO_API_KEY, plus --confirm-spend.
//   npm run eval -- --live --confirm-spend [--record] [--limit 5]
// --record writes each live answer to fixtures/llm/baseline/<brand>.json so the
// dry-run demo replays real model output afterwards.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runBaseline } from "../src/agent/baseline";
import { makeQlooClient } from "../src/qloo";
import { createProvider } from "../src/llm";
import { RecordingProvider } from "../src/llm/replay";
import { slug } from "../src/qloo/fixtures/util";
import { EXAMPLES } from "../src/server/app";
import type { BaselineReport, SiteRequest } from "../src/shared/types";

const args = process.argv.slice(2);
const live = args.includes("--live");
const record = args.includes("--record");
const limitArg = args.indexOf("--limit");
const limit = limitArg >= 0 ? Number(args[limitArg + 1]) : Infinity;

// The live eval set: the 3 sample briefs plus 9 more across the 4 metros. Brand names are fictional.
const b = (brand: string, metro: string, audience: string, seeds: string[]): SiteRequest => ({ brand, metro, audience, seeds, format: "store", sites: 3 });
const LIVE_SET: SiteRequest[] = [
  ...EXAMPLES.slice(0, 3),
  b("Kettle & Crate", "nyc", "specialty coffee, vinyl records", ["Blue Bottle Coffee", "Kinfolk"]),
  b("Ridgeline Cycles", "nyc", "cycling, outdoors", ["Rapha", "Patagonia"]),
  b("Page Two Books", "nyc", "literary fiction, poetry", ["Sally Rooney", "The Paris Review"]),
  b("Courtside Kicks", "chi", "sneakers, hip hop", ["Nike", "Tyler, the Creator"]),
  b("Second Draft Books", "chi", "literary fiction, independent bookstores", ["Haruki Murakami"]),
  b("Lowlight Wine Bar", "la", "natural wine, indie music", ["Kinfolk"]),
  b("Stillwater Roasters", "la", "specialty coffee, minimalist design", ["Blue Bottle Coffee", "Kinfolk"]),
  b("Boardroom Skate", "lon", "skateboarding, streetwear", ["Supreme", "Stüssy"]),
  b("Crema & Co.", "lon", "specialty coffee, cycling", ["Rapha", "Blue Bottle Coffee"]),
];

async function main() {
  const env = process.env as Record<string, string | undefined>;
  const llm = createProvider(live ? env : {});
  if (live) {
    if (llm.dryRun) throw new Error("--live needs LLM_PROVIDER=anthropic (or openai-compatible) and its key.");
    if (!env.QLOO_API_KEY) throw new Error("--live needs QLOO_API_KEY.");
    if (!args.includes("--confirm-spend")) throw new Error("--live calls a paid LLM API. Re-run with --confirm-spend after the spend is approved.");
  }
  const set = (live ? LIVE_SET : EXAMPLES.slice(0, 3)).slice(0, limit);
  console.log(live ? `LIVE eval on ${set.length} briefs with ${llm.id}` : "DRY RUN on illustrative fixtures. Not a measurement.");
  const reports: BaselineReport[] = [];
  for (const req of set) {
    const rec = record && live ? new RecordingProvider(llm) : undefined;
    const { client } = makeQlooClient(live ? env : {});
    try {
      const r = await runBaseline(req, { llm: rec ?? llm, qloo: client });
      reports.push(r);
      const s = r.score;
      console.log(`${req.brand.padEnd(26)} areas hot ${s.areasHot}/${s.areas}   anchors verified ${s.anchorsVerified}/${s.anchors}`);
      if (rec) {
        const dir = join(process.cwd(), "fixtures/llm/baseline");
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, `${slug(req.brand)}.json`), JSON.stringify({ ...rec.transcript, request: req }, null, 2));
      }
    } catch (e) {
      console.log(`${req.brand.padEnd(26)} skipped: ${(e as Error).message}`);
    }
  }
  const sum = (k: keyof BaselineReport["score"]) => reports.reduce((a, r) => a + r.score[k], 0);
  const pct = (n: number, d: number) => (d ? Math.round((n / d) * 100) : 0);
  console.log("-".repeat(72));
  console.log(`LLM-only neighbourhoods in the cold half of Qloo heat: ${sum("areas") - sum("areasHot")}/${sum("areas")} (${pct(sum("areas") - sum("areasHot"), sum("areas"))}%)`);
  console.log(`LLM-only anchors not found in Qloo:                  ${sum("anchorsNotFound")}/${sum("anchors")} (${pct(sum("anchorsNotFound"), sum("anchors"))}%)`);
  console.log(`LLM-only anchors found in another neighbourhood:     ${sum("anchorsWrongArea")}/${sum("anchors")}`);
  console.log("Tasteplot: 100% of anchors and brands are Qloo entities by construction (submit_site_plan grounding check).");
  if (!live) console.log("These numbers come from hand-written fixtures. Do not quote them. Run --live for the real number.");
}

main().catch((e) => { console.error(e.message); process.exit(1); });
