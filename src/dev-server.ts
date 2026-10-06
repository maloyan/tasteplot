// Local dev API server (Node). Same Hono app as the Worker.
// Reads .env through `tsx --env-file-if-exists=.env` (see package.json).
import { serve } from "@hono/node-server";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeApp, type Env } from "./server/app";
import { requestKey } from "./qloo/transport";
import { hash32, slug } from "./qloo/fixtures/util";

const env: Env = {
  QLOO_API_KEY: process.env.QLOO_API_KEY || undefined,
  QLOO_BASE_URL: process.env.QLOO_BASE_URL || undefined,
  QLOO_MODE: process.env.QLOO_MODE || undefined,
  MAX_QLOO_CALLS: process.env.MAX_QLOO_CALLS || undefined,
  LLM_PROVIDER: process.env.LLM_PROVIDER || undefined,
  LLM_MODEL: process.env.LLM_MODEL || undefined,
  LLM_EFFORT: process.env.LLM_EFFORT || undefined,
  LLM_MAX_TURNS: process.env.LLM_MAX_TURNS || undefined,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || undefined,
  LLM_BASE_URL: process.env.LLM_BASE_URL || undefined,
  LLM_API_KEY: process.env.LLM_API_KEY || undefined,
  DAILY_QLOO_CAP: process.env.DAILY_QLOO_CAP || undefined,
  PLANS_PER_HOUR: process.env.PLANS_PER_HOUR || undefined,
};

const root = process.cwd();
const app = makeApp({
  fixtureLatencyMs: Number(process.env.FIXTURE_LATENCY_MS ?? 120),
  replayDelayMs: 40,
  // Same recorded sample plans the Worker serves from its static assets.
  loadSample: (path) => readFile(join(root, "public", path), "utf8").catch(() => null),
  recordQloo: process.env.QLOO_RECORD === "1"
    ? async (req, res) => {
        const dir = join(root, "fixtures/qloo/recorded/raw");
        await mkdir(dir, { recursive: true });
        const name = `${req.path.replace(/\W+/g, "_")}-${hash32(requestKey(req)).toString(16)}.json`;
        await writeFile(join(dir, name), JSON.stringify({ request: req, status: res.status, body: res.body }, null, 2));
      }
    : undefined,
  onTranscript: process.env.LLM_RECORD === "1"
    ? async (req, t) => {
        const dir = join(root, "fixtures/llm/agent");
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, `${slug(req.brand)}-${Date.now()}.json`), JSON.stringify({ request: req, ...t }, null, 2));
      }
    : undefined,
});

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: (req) => app.fetch(req, env), port }, () => {
  const mode = env.QLOO_MODE === "fixtures" || !env.QLOO_API_KEY ? "fixtures (dry-run)" : "LIVE hackathon API";
  console.log(`Tasteplot API on http://localhost:${port}  qloo=${mode}  llm=${env.LLM_PROVIDER ?? "scripted"}`);
});
