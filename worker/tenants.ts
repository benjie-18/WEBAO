// Multi-tenant serving: client sites live on their own domains, and any
// hostname that reaches this worker other than the main site's is a tenant
// host. The hostname resolves through a KV mapping (domain:<host> -> client
// key, see clients.ts) written when a domain is assigned.
//
// Step 3 scope: routing, assignment, and DNS verification. Published builds
// are served from the same resolution path once the build pipeline (step 4)
// writes site content; until then a mapped host serves a per-client
// "coming soon" page. Unmapped non-main hosts fall through to the main site
// at the worker level; Cloudflare for SaaS custom-hostname verification is
// what rejects them at the edge once enabled.

import {
  CLIENTS_INDEX,
  domainKey,
  normalizeDomain,
  saveClient,
  type Client,
} from "./clients";
import { deleteKey, getJson, putJson } from "./kv";
import { batch, err, json, timingSafeEqual } from "./util";

export interface TenantEnv {
  WEBAO_KV: KVNamespace;
  INTERNAL_CRON_SECRET?: string;
}

export const MAIN_HOSTS = new Set(["webao.ca", "www.webao.ca", "webao.bnji.net"]);

/** Hosts that belong to the main WEBAO site (never treated as tenants). */
export function isMainHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return MAIN_HOSTS.has(host) || host === "localhost" || host.endsWith(".workers.dev");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function tenantPage(client: Client, host: string): Response {
  const fr = client.lang === "fr";
  const paused = client.stage === "paused";
  const name = escapeHtml(client.business || client.domain || host);
  const title = paused
    ? fr
      ? "Site temporairement indisponible"
      : "Website temporarily unavailable"
    : fr
      ? "Site web bientôt en ligne"
      : "Website coming soon";
  const sub = paused
    ? fr
      ? "Merci de repasser un peu plus tard."
      : "Please check back a little later."
    : fr
      ? "Ce site est en création par Webao."
      : "This website is being built by Webao.";
  const html =
    `<!doctype html><html lang="${fr ? "fr" : "en"}"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta name="robots" content="noindex"><title>${name} · ${title}</title>` +
    `<style>body{margin:0;min-height:100vh;display:grid;place-items:center;` +
    `background:#F8F5EF;color:#0A0F1C;font-family:Georgia,'Times New Roman',serif;}` +
    `main{text-align:center;padding:24px;max-width:34rem}` +
    `h1{font-size:clamp(1.8rem,5vw,2.8rem);margin:0 0 .5rem;font-weight:600}` +
    `p{margin:0;font-family:Inter,system-ui,sans-serif;color:#4A4A44}</style></head>` +
    `<body><main><h1>${name}</h1><p>${title}. ${sub}</p></main></body></html>`;
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "x-robots-tag": "noindex",
      "cache-control": "no-store",
    },
  });
}

/** Resolve a hostname to its client, tolerating a www/bare mismatch. */
export async function resolveTenant(
  kv: KVNamespace,
  hostname: string,
): Promise<Client | null> {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  const candidates = host.startsWith("www.")
    ? [host, host.slice(4)]
    : [host, "www." + host];
  for (const candidate of candidates) {
    const key = await getJson<string>(kv, domainKey(candidate));
    if (key) {
      const client = await getJson<Client>(kv, key);
      if (client) return client;
    }
  }
  return null;
}

/** The page a resolved tenant host serves (HEAD gets headers only). */
export function tenantPageResponse(client: Client, req: Request, host: string): Response {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405 });
  }
  const page = tenantPage(client, host);
  if (req.method === "HEAD") {
    return new Response(null, { status: page.status, headers: page.headers });
  }
  return page;
}

/** Serve a request that arrived on a tenant hostname (404 when unmapped). */
export async function handleTenantRequest(
  req: Request,
  env: TenantEnv,
  url: URL,
): Promise<Response> {
  const client = await resolveTenant(env.WEBAO_KV, url.hostname);
  if (!client) return new Response("Not found", { status: 404 });
  return tenantPageResponse(client, req, url.hostname);
}

export interface AssignResult {
  ok: boolean;
  conflict?: boolean;
}

/**
 * Assign (or clear, with host = null) a client's canonical domain: keeps
 * the domain:<host> mapping and the client record in step. The caller
 * picks the lifecycle status; an already-live domain keeps "live".
 */
export async function assignDomain(
  kv: KVNamespace,
  client: Client,
  host: string | null,
  status: NonNullable<Client["domainStatus"]>,
): Promise<AssignResult> {
  if (client.domain && client.domain !== host) {
    const old = await getJson<string>(kv, domainKey(client.domain));
    if (old === "client:" + client.id) await deleteKey(kv, domainKey(client.domain));
  }
  if (!host) {
    delete client.domain;
    client.domainStatus = "none";
    delete client.domainAssignedAt;
    return { ok: true };
  }
  const owner = await getJson<string>(kv, domainKey(host));
  if (owner && owner !== "client:" + client.id) return { ok: false, conflict: true };
  await putJson(kv, domainKey(host), "client:" + client.id);
  if (client.domain !== host) {
    client.domain = host;
    client.domainAssignedAt = Date.now();
    if (client.domainStatus !== "live") client.domainStatus = status;
  }
  return { ok: true };
}

/** Sweep result for one domain-check run. */
export interface DomainCheckResult {
  checked: number;
  connected: number;
  stillPending: number;
}

/**
 * DNS verification sweep: a domain counts as connected when its CNAME
 * points into webao.ca (the instructed target is hosting.webao.ca). Runs
 * under the same shared-secret gate as the onboarding nudges.
 */
export async function handleDomainChecks(req: Request, env: TenantEnv): Promise<Response> {
  if (!env.INTERNAL_CRON_SECRET) return err("Domain checks are not configured", 503);
  const auth = req.headers.get("authorization") || "";
  if (!timingSafeEqual(auth, "Bearer " + env.INTERNAL_CRON_SECRET)) {
    return err("Unauthorized", 401);
  }

  const kv = env.WEBAO_KV;
  const index = (await getJson<string[]>(kv, CLIENTS_INDEX)) || [];
  const records = await batch(index.slice(0, 200), 25, (k) => getJson<Client>(kv, k));
  const result: DomainCheckResult = { checked: 0, connected: 0, stillPending: 0 };

  for (const client of records) {
    if (!client || !client.domain) continue;
    if (client.domainStatus !== "pending-dns" && client.domainStatus !== "to-register") {
      continue;
    }
    result.checked++;
    client.domainCheckedAt = Date.now();
    let connected = false;
    try {
      const res = await fetch(
        `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(client.domain)}&type=CNAME`,
        { headers: { accept: "application/dns-json" } },
      );
      if (res.ok) {
        const data = (await res.json()) as {
          Answer?: { type: number; data: string }[];
        };
        for (const answer of data.Answer || []) {
          if (answer.type !== 5) continue;
          const target = answer.data.toLowerCase().replace(/\.$/, "");
          if (target === "webao.ca" || target.endsWith(".webao.ca")) {
            connected = true;
            break;
          }
        }
      }
    } catch {
      /* DNS lookup problems leave the domain pending; the sweep retries. */
    }
    if (connected) {
      // A client whose build is already published goes straight to live
      // (the published pointer key format is owned by builds.ts).
      const published = await getJson<string>(kv, `site:${client.id}:published`);
      client.domainStatus = published ? "live" : "connected";
      result.connected++;
    } else {
      result.stillPending++;
    }
    await saveClient(kv, client);
  }
  return json({ ok: true, ...result });
}

export { normalizeDomain };
