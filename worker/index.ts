// WEBAO worker entry: JSON API under /api/*, static-asset fallthrough otherwise.
// The site itself is a static Astro build (dist/client); this handler preserves
// its behavior exactly and only intercepts /api/* requests.

import { handlePageview, handleClick, handleHeartbeat } from "./track";
import { handleFormSubmit } from "./forms";
import { handleGo, handleLeadRegister, handleLeadReply } from "./leads";
import { handleAdmin } from "./admin";
import { handleCheckoutSession } from "./checkout";
import { handleStripeWebhook } from "./stripe-webhook";
import {
  handleOnboardingNudges,
  handlePortalClaim,
  handlePortalExchange,
  handlePortalAdsLeadOutcome,
  handlePortalAdsOnboarding,
  handlePortalLogout,
  handlePortalReview,
  handlePortalMe,
  handlePortalOnboarding,
  handlePortalRequestLink,
} from "./portal";
import { handleDomainChecks, isMainHost, resolveTenant, tenantPageResponse } from "./tenants";
import { handleInternalBuild, servePreviewSite, servePublishedSite } from "./builds";
import { handleMonthlyReports, recordTenantView } from "./reports";
import { handleAdsLeadIntake } from "./ads";
import { json } from "./util";
import { KvWriteError } from "./kv";

async function routeApi(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const p = url.pathname;

  if (p === "/api/track/pageview" && req.method === "POST") return handlePageview(req, env);
  if (p === "/api/track/click" && req.method === "POST") return handleClick(req, env);
  if (p === "/api/track/heartbeat" && req.method === "POST") return handleHeartbeat(req, env);
  if (p === "/api/forms/submit" && req.method === "POST") return handleFormSubmit(req, env);
  if (p === "/api/leads/register" && req.method === "POST") return handleLeadRegister(req, env);
  if (p === "/api/leads/reply" && req.method === "POST") return handleLeadReply(req, env);
  if (p === "/api/checkout/session" && req.method === "POST") return handleCheckoutSession(req, env);
  if (p === "/api/stripe/webhook" && req.method === "POST") return handleStripeWebhook(req, env);
  if (p === "/api/portal/request-link" && req.method === "POST") return handlePortalRequestLink(req, env);
  if (p === "/api/portal/exchange" && req.method === "POST") return handlePortalExchange(req, env);
  if (p === "/api/portal/claim" && req.method === "POST") return handlePortalClaim(req, env);
  if (p === "/api/portal/me" && req.method === "GET") return handlePortalMe(req, env);
  if (p === "/api/portal/onboarding" && req.method === "POST") return handlePortalOnboarding(req, env);
  if (p === "/api/portal/review" && req.method === "POST") return handlePortalReview(req, env);
  if (p === "/api/portal/ads-onboarding" && req.method === "POST") return handlePortalAdsOnboarding(req, env);
  if (p === "/api/portal/ads-lead-outcome" && req.method === "POST") return handlePortalAdsLeadOutcome(req, env);
  if (p === "/api/portal/logout" && req.method === "POST") return handlePortalLogout(req, env);
  if (p === "/api/internal/onboarding-nudges" && req.method === "POST") return handleOnboardingNudges(req, env);
  if (p === "/api/internal/domain-checks" && req.method === "POST") return handleDomainChecks(req, env);
  if (p === "/api/internal/build" && req.method === "POST") return handleInternalBuild(req, env);
  if (p === "/api/internal/monthly-reports" && req.method === "POST") return handleMonthlyReports(req, env);
  if (p === "/api/internal/ads-lead" && req.method === "POST") return handleAdsLeadIntake(req, env);
  if (p.startsWith("/api/admin/")) return handleAdmin(req, env, url);

  return json({ ok: false, error: "Not found" }, 404);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Tenant hosts: a non-main hostname with a domain mapping resolves to
    // its client and serves only that client's space. Unmapped hosts fall
    // through to the main site for now; once Cloudflare for SaaS custom
    // hostnames are enabled, unverified hosts are rejected at the edge
    // before they ever reach this worker.
    if (!isMainHost(url.hostname)) {
      try {
        const tenant = await resolveTenant(env.WEBAO_KV, url.hostname);
        if (tenant) {
          if (request.method !== "GET" && request.method !== "HEAD") {
            return tenantPageResponse(tenant, request, url.hostname);
          }
          const site = await servePublishedSite(env, tenant, url);
          if (site) {
            if (request.method === "GET" && ctx && typeof ctx.waitUntil === "function") {
              ctx.waitUntil(recordTenantView(env.WEBAO_KV, tenant.id));
            }
            if (request.method === "HEAD") {
              return new Response(null, { status: site.status, headers: site.headers });
            }
            return site;
          }
          return tenantPageResponse(tenant, request, url.hostname);
        }
      } catch (e) {
        console.error("tenant error", (e as Error)?.message);
        return new Response("Internal error", { status: 500 });
      }
    }

    // Client build previews: the draft (or published) site under
    // /preview/<clientId>/, linked from the portal review card.
    const previewMatch = /^\/preview\/(cl_[a-f0-9]{24})(?:\/(.*))?$/.exec(url.pathname);
    if (previewMatch && (request.method === "GET" || request.method === "HEAD")) {
      try {
        const res = await servePreviewSite(env, previewMatch[1], previewMatch[2] || "index.html");
        if (request.method === "HEAD") {
          return new Response(null, { status: res.status, headers: res.headers });
        }
        return res;
      } catch (e) {
        console.error("preview error", (e as Error)?.message);
        return new Response("Internal error", { status: 500 });
      }
    }

    // Redirect old subdomain to the canonical domain.
    if (url.hostname === "webao.bnji.net") {
      url.hostname = "webao.ca";
      url.protocol = "https:";
      return Response.redirect(url.toString(), 301);
    }

    // Tracked outreach links: log the click, redirect to the real page.
    // handleGo never throws for logging problems, a sent link must not break.
    if (url.pathname.startsWith("/go/")) {
      return handleGo(request, env, url);
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
