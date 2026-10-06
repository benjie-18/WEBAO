// WEBAO worker entry: JSON API under /api/*, static-asset fallthrough otherwise.
// The site itself is a static Astro build (dist/client); this handler preserves
// its behavior exactly and only intercepts /api/* requests.

import { handlePageview, handleClick, handleHeartbeat } from "./track";
import { handleFormSubmit } from "./forms";
import { handleAdmin } from "./admin";
import { handleCheckoutSession } from "./checkout";
import { json } from "./util";
import { KvWriteError } from "./kv";

async function routeApi(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const p = url.pathname;

  if (p === "/api/track/pageview" && req.method === "POST") return handlePageview(req, env);
  if (p === "/api/track/click" && req.method === "POST") return handleClick(req, env);
  if (p === "/api/track/heartbeat" && req.method === "POST") return handleHeartbeat(req, env);
  if (p === "/api/forms/submit" && req.method === "POST") return handleFormSubmit(req, env);
  if (p === "/api/checkout/session" && req.method === "POST") return handleCheckoutSession(req, env);
  if (p.startsWith("/api/admin/")) return handleAdmin(req, env, url);

  return json({ ok: false, error: "Not found" }, 404);
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Redirect old subdomain to the canonical domain.
    if (url.hostname === "webao.bnji.net") {
      url.hostname = "webao.ca";
      url.protocol = "https:";
      return Response.redirect(url.toString(), 301);
    }

    if (url.pathname.startsWith("/api/")) {
      try {
        return await routeApi(request, env);
      } catch (e) {
        if (e instanceof KvWriteError) {
          // Storage writes are unavailable (e.g. the daily KV write quota is
          // exhausted). Say so honestly instead of a cryptic 500; the quota
          // resets daily and nothing the user did caused this.
          console.error("api KV write unavailable", (e as Error)?.cause);
          return json(
            { ok: false, error: "Storage is temporarily unavailable. Please try again shortly." },
            503,
          );
        }
        // Never leak internals; log via observability.
        console.error("api error", (e as Error)?.message);
        return json({ ok: false, error: "Internal error" }, 500);
      }
    }

    // Demo/carousel imagery: served from static assets when present,
    // otherwise from KV (images are stored as base64 in the repo and
    // restored at build time, but KV is the durable fallback).
    // NOTE: env.ASSETS.fetch() throws (rather than returning 404) for paths
    // absent from the asset manifest, so it must stay inside try/catch.
    if (url.pathname.startsWith("/demos/") || url.pathname.startsWith("/carousel/")) {
      try {
        const asset = await env.ASSETS.fetch(request);
        if (asset.status !== 404) return asset;
      } catch (e) {
        console.error("asset fetch error", (e as Error)?.message);
      }
      try {
        const data = await env.WEBAO_KV.get("img:" + url.pathname, "arrayBuffer");
        if (data) {
          const ct = url.pathname.endsWith(".png") ? "image/png"
            : url.pathname.endsWith(".webp") ? "image/webp"
            : "image/jpeg";
          return new Response(data, {
            headers: {
              "content-type": ct,
              "cache-control": "public, max-age=31536000, immutable",
            },
          });
        }
      } catch (e) {
        console.error("kv image error", (e as Error)?.message);
      }
      return new Response("Not found", { status: 404 });
    }

    // Everything else: the static site, served by the assets binding.
    return env.ASSETS.fetch(request);
  },
};
