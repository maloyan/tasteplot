// Coverage spike: run each Qloo workflow Tasteplot uses for the sample briefs
// against the LIVE hackathon API, and print a coverage table. It answers the
// go/no-go question: does the hackathon data have enough heat cells, places and
// brands in each demo metro? It also prints one raw item per endpoint so the
// UNVERIFIED response shapes in docs/QLOO_API_ASSUMPTIONS.md can be checked.
//   QLOO_API_KEY=... npm run spike            (prints a markdown table)
//   QLOO_RECORD=1 to also save raw responses to fixtures/qloo/recorded/raw/
// No LLM calls. About 4 x 11 = 44 Qloo calls.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeQlooClient } from "../src/qloo";
import { hash32 } from "../src/qloo/fixtures/util";
import { requestKey, type QlooResponse } from "../src/qloo/transport";
import { EXAMPLES } from "../src/server/app";
import { findMetro } from "../src/shared/metros";
import { pickEntity, pickTag, rankNeighborhoods } from "../src/agent/tools";
import { SEED_TYPES } from "../src/qloo/client";

async function main() {
  if (!process.env.QLOO_API_KEY) throw new Error("Set QLOO_API_KEY first. This script only runs against the live API.");
  const rec = process.env.QLOO_RECORD === "1";
  const dir = join(process.cwd(), "fixtures/qloo/recorded/raw");
  if (rec) await mkdir(dir, { recursive: true });
  const firstRaw = new Map<string, unknown>();
  const { client } = makeQlooClient(process.env, {
    record: async (req, res: QlooResponse) => {
      const key = `${req.path} ${req.params["filter.type"] ?? ""}`.trim();
      if (!firstRaw.has(key)) firstRaw.set(key, res.body);
      if (rec) await writeFile(join(dir, `${req.path.replace(/\W+/g, "_")}-${hash32(requestKey(req)).toString(16)}.json`), JSON.stringify({ request: req, body: res.body }, null, 2));
    },
  });
  console.log("| Brief | seeds found | tags found | heat cells | hoods with heat | places (top hood) | with coords | brands | demographics | compare tags |");
  console.log("|---|---|---|---|---|---|---|---|---|---|");
  for (const ex of EXAMPLES) {
    const row: (string | number)[] = [ex.label];
    try {
      const metro = findMetro(ex.metro)!;
      const ents = (await Promise.all(ex.seeds.map(async (s) => pickEntity(await client.search(s, SEED_TYPES, 8), s)))).map((r) => r.pick?.id ?? r.ambiguous?.[0]?.id).filter((x): x is string => !!x);
      const tags = (await Promise.all(ex.audience.split(",").map(async (k) => pickTag(await client.findTags(k.trim(), 8), k.trim())))).map((t) => t?.id).filter((x): x is string => !!x);
      row.push(`${ents.length}/${ex.seeds.length}`, tags.length);
      const signal = { entities: ents, tags };
      const cells = await client.heatmap(signal, metro.query);
      const hoods = rankNeighborhoods(cells, metro).filter((h) => h.cells > 0);
      row.push(cells.length, hoods.length);
      const top = hoods[0] ? metro.neighborhoods.find((n) => n.id === hoods[0]!.id)! : metro;
      const places = await client.placesNear({ signal, at: top, radiusM: 1500, take: 10, explain: true });
      row.push(places.length, places.filter((p) => p.location).length);
      const brands = await client.brands(signal, { exclude: ents, take: 5 });
      const demo = await client.demographics(signal);
      row.push(brands.length, demo ? Object.keys(demo.age).length : 0);
      const cmpSeeds = (await Promise.all((ex.compareSeeds ?? []).map(async (s) => pickEntity(await client.search(s, SEED_TYPES, 8), s).pick))).map((e) => e?.id).filter((x): x is string => !!x);
      const cmp = ents.length && cmpSeeds.length ? await client.compare(ents, cmpSeeds) : { shared: [], a: [], b: [] };
      row.push(`${cmp.shared.length} shared / ${cmp.a.length} a / ${cmp.b.length} b`);
    } catch (e) {
      row.push(`error: ${(e as Error).message.slice(0, 100)}`);
    }
    console.log(`| ${row.join(" | ")} |`);
  }
  console.log(`\nQloo calls: ${client.calls.length}. Warnings:\n${[...new Set(client.warnings)].map((w) => `- ${w}`).join("\n") || "- none"}`);
  console.log("\n## One raw response per endpoint (first 1500 chars)\n");
  for (const [k, body] of firstRaw) console.log(`### ${k}\n\`\`\`json\n${JSON.stringify(body, null, 1).slice(0, 1500)}\n\`\`\`\n`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
