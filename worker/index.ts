// WEBAO worker entry: JSON API under /api/*, static-asset fallthrough otherwise.
// The site itself is a static Astro build (dist/client); this handler preserves
// its behavior exactly and only intercepts /api/* requests.

import { handlePageview, handleClick, handleHeartbeat } from "./track";
import { handleFormSubmit } from "./forms";
import { handleAdmin } from "./admin";
import { json } from "./util";

async function routeApi(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const p = url.pathname;

  if (p === "/api/track/pageview" && req.method === "POST") return handlePageview(req, env);
  if (p === "/api/track/click" && req.method === "POST") return handleClick(req, env);
  if (p === "/api/track/heartbeat" && req.method === "POST") return handleHeartbeat(req, env);
  if (p === "/api/forms/submit" && req.method === "POST") return handleFormSubmit(req, env);
  if (p.startsWith("/api/admin/")) return handleAdmin(req, env, url);

  return json({ ok: false, error: "Not found" }, 404);
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      try {
        return await routeApi(request, env);
      } catch (e) {
        // Never leak internals; log via observability.
        console.error("api error", (e as Error)?.message);
        return json({ ok: false, error: "Internal error" }, 500);
      }
    }

    // Everything else: the static site, served by the assets binding.
    return env.ASSETS.fetch(request);
  },
};
