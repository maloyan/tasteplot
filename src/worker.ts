// Cloudflare Worker entry. /api/* goes to the Hono app; everything else is the
// built web app from dist/ (Workers Static Assets, see wrangler.toml).
import { makeApp, type Env } from "./server/app";

const app = makeApp();

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return app.fetch(request, env, ctx);
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
