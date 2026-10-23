// Build pipeline: generate, verify, publish.
//
// A build renders the client's site with sitegen.ts, runs the QA suite,
// and stores the result as a draft. QA is the launch gate (Benji's rule:
// approve-by-exception, verification extensive and thorough). A clean QA
// report moves the client to review with a live preview; any failure
// leaves the build in the exception queue (the admin Clients tab plus an
// inbox notification) with the failing checks spelled out. Publishing is
// what points the tenant host at the build.

import {
  getClient,
  saveClient,
  type Client,
} from "./clients";
import { getJson, putJson } from "./kv";
import { notifyInbox, sendClientEmail } from "./mailer";
import { generateSite, parseServices, type SiteFile } from "./sitegen";
import { err, json, randomHex, readJson, timingSafeEqual } from "./util";

export interface BuildEnv {
  WEBAO_KV: KVNamespace;
  SMTP2GO_API_KEY?: string;
  EMAIL?: SendEmailBinding;
  INTERNAL_CRON_SECRET?: string;
}

export interface QaCheck {
  id: string;
  ok: boolean;
  detail: string;
}

export interface QaReport {
  passed: boolean;
  checks: QaCheck[];
}

export interface BuildMeta {
  buildId: string;
  clientId: string;
  builtAt: number;
  fileCount: number;
  qa: QaReport;
}

export const siteFileKey = (clientId: string, buildId: string, path: string): string =>
  `site:${clientId}:${buildId}:${path}`;
export const buildMetaKey = (clientId: string, buildId: string): string =>
  `build:${clientId}:${buildId}`;
export const latestBuildKey = (clientId: string): string => `build:${clientId}:latest`;
export const draftKey = (clientId: string): string => `site:${clientId}:draft`;
export const publishedKey = (clientId: string): string => `site:${clientId}:published`;

// ---------------------------------------------------------------------------
// QA suite
// ---------------------------------------------------------------------------

export function runQa(client: Client, files: SiteFile[]): QaReport {
  const checks: QaCheck[] = [];
  const add = (id: string, ok: boolean, detail: string): void => {
    checks.push({ id, ok, detail });
  };
  const index = files.find((f) => f.path === "index.html");
  const html = index?.content || "";
  const o = client.onboarding || {};
  const business = o.businessName || client.business || "";

  add("files-present", files.length > 0 && !!index, `${files.length} file(s), index.html ${index ? "present" : "missing"}`);
  add("doctype", /^<!doctype html>/i.test(html.trim()), "document starts with a doctype");
  add(
    "title",
    !!business && new RegExp(`<title>[^<]*${business.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i").test(html),
    "title carries the business name",
  );
  const desc = /<meta name="description" content="([^"]*)"/.exec(html)?.[1] || "";
  add("meta-description", desc.length >= 30, `description is ${desc.length} chars`);
  add(
    "lang",
    html.includes(`<html lang="${client.lang === "fr" ? "fr" : "en"}"`),
    "html lang matches the client language",
  );
  add("single-h1", (html.match(/<h1[\s>]/g) || []).length === 1, "exactly one h1");
  const tel = /href="tel:\+?([\d]+)"/.exec(html);
  add(
    "phone-link",
    !!tel && tel[1].replace(/^1/, "").length === 10 && !!o.phone && html.includes(o.phone),
    "a tappable phone link with the onboarding number",
  );
  const services = parseServices(o.services);
  const missing = services.filter((s) => !html.includes(s));
  add(
    "services-present",
    services.length > 0 && missing.length === 0,
    missing.length ? `missing: ${missing.join(", ")}` : `${services.length} service(s) rendered`,
  );
  add(
    "area-present",
    !o.serviceArea || html.includes(o.serviceArea),
    o.serviceArea ? "service area rendered" : "no service area provided",
  );
  add("no-em-dash", !html.includes("—"), "no em dashes in generated copy");
  add(
    "no-placeholder",
    !/lorem|placeholder|coming soon|todo/i.test(html),
    "no placeholder or draft text",
  );
  const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
  const paths = new Set(files.map((f) => f.path));
  const badLinks = hrefs.filter((h) => {
    if (h.startsWith("tel:") || h.startsWith("mailto:") || h.startsWith("#")) return false;
    if (h.startsWith("https://") || h.startsWith("http://")) return false;
    return !paths.has(h.replace(/^\//, "") || "index.html");
  });
  add("links-resolve", badLinks.length === 0, badLinks.length ? `unresolved: ${badLinks.join(", ")}` : "all links resolve");
  add("contact-section", html.includes('id="contact"'), "contact section present");
  add(
    "canonical",
    !client.domain || html.includes(`<link rel="canonical" href="https://${client.domain}/">`),
    client.domain ? "canonical points at the client domain" : "no domain assigned yet",
  );
  const total = files.reduce((n, f) => n + f.content.length, 0);
  add("size-budget", total <= 200_000, `site is ${total} bytes of text`);

  return { passed: checks.every((c) => c.ok), checks };
}

// ---------------------------------------------------------------------------
// Build + publish
// ---------------------------------------------------------------------------

export interface BuildResult {
  buildId: string;
  qa: QaReport;
}

export async function runBuild(
  env: BuildEnv,
  client: Client,
  gen: (c: Client) => SiteFile[] = generateSite,
): Promise<BuildResult> {
  const kv = env.WEBAO_KV;
  const files = gen(client);
  const qa = runQa(client, files);
  const buildId = "b_" + randomHex(8);
  for (const file of files) {
    await putJson(kv, siteFileKey(client.id, buildId, file.path), {
      contentType: file.contentType,
      content: file.content,
    });
  }
  const meta: BuildMeta = {
    buildId,
    clientId: client.id,
    builtAt: Date.now(),
    fileCount: files.length,
    qa,
  };
  await putJson(kv, buildMetaKey(client.id, buildId), meta);
  await putJson(kv, latestBuildKey(client.id), buildId);
  await putJson(kv, draftKey(client.id), buildId);

  const name = client.business || client.email;
  const passedCount = qa.checks.filter((c) => c.ok).length;
  if (qa.passed) {
    if (client.stage === "build" || client.stage === "review") {
      client.stage = "review";
      client.previewUrl = `https://webao.ca/preview/${client.id}/`;
      await saveClient(kv, client);
      await sendClientEmail(env, {
        to: client.email,
        subject:
          client.lang === "fr"
            ? "Votre site web est prêt à réviser"
            : "Your website is ready for review",
        text:
          client.lang === "fr"
            ? `Bonjour,\n\nVotre site web est prêt. Vous pouvez le voir ici :\n${client.previewUrl}\n\nDites-nous ce que vous en pensez en écrivant à support@webao.ca.\n\nWebao`
            : `Hello,\n\nYour website is ready for a first look:\n${client.previewUrl}\n\nTell us what you think at support@webao.ca.\n\nWebao`,
      });
    }
    await notifyInbox(env, `Build ready for review: ${name}`, [
      `QA passed ${passedCount}/${qa.checks.length}.`,
      `Client: ${name} <${client.email}>`,
      `Stage: ${client.stage}. Preview: ${client.previewUrl || "(not set)"}`,
      `Build: ${buildId}`,
    ]);
  } else {
    const failed = qa.checks.filter((c) => !c.ok);
    await notifyInbox(env, `Build QA failed: ${name}`, [
      `QA passed ${passedCount}/${qa.checks.length}. The build sits in the exception queue.`,
      `Client: ${name} <${client.email}>`,
      `Build: ${buildId}`,
      ``,
      ...failed.map((c) => `- ${c.id}: ${c.detail}`),
    ]);
  }
  return { buildId, qa };
}

export async function publishBuild(
  env: BuildEnv,
  client: Client,
): Promise<{ ok: boolean; error?: string; buildId?: string }> {
  const kv = env.WEBAO_KV;
  const draft = await getJson<string>(kv, draftKey(client.id));
  if (!draft) return { ok: false, error: "No draft build to publish" };
  const meta = await getJson<BuildMeta>(kv, buildMetaKey(client.id, draft));
  if (!meta) return { ok: false, error: "Draft build record is missing" };
  if (!meta.qa.passed) return { ok: false, error: "The draft has not passed QA" };
  await putJson(kv, publishedKey(client.id), draft);
  client.stage = "live";
  if (client.domain && client.domainStatus === "connected") client.domainStatus = "live";
  await saveClient(kv, client);
  if (client.domain) {
    await sendClientEmail(env, {
      to: client.email,
      subject: client.lang === "fr" ? "Votre site web est en ligne" : "Your website is live",
      text:
        client.lang === "fr"
          ? `Bonne nouvelle, votre site web est en ligne :\nhttps://${client.domain}/\n\nWebao`
          : `Good news, your website is live:\nhttps://${client.domain}/\n\nWebao`,
    });
  }
  await notifyInbox(env, `Site published: ${client.business || client.email}`, [
    `Build ${draft} is live${client.domain ? ` on ${client.domain}` : ""}.`,
    `Client: ${client.business || client.email} <${client.email}>`,
  ]);
  return { ok: true, buildId: draft };
}

export interface BuildState {
  latest: BuildMeta | null;
  draftBuildId: string | null;
  publishedBuildId: string | null;
}

export async function getBuildState(kv: KVNamespace, clientId: string): Promise<BuildState> {
  const latestId = await getJson<string>(kv, latestBuildKey(clientId));
  const latest = latestId ? await getJson<BuildMeta>(kv, buildMetaKey(clientId, latestId)) : null;
  return {
    latest,
    draftBuildId: await getJson<string>(kv, draftKey(clientId)),
    publishedBuildId: await getJson<string>(kv, publishedKey(clientId)),
  };
}

// ---------------------------------------------------------------------------
// Serving stored builds
// ---------------------------------------------------------------------------

async function serveFile(
  kv: KVNamespace,
  clientId: string,
  buildId: string,
  rawPath: string,
  preview: boolean,
): Promise<Response | null> {
  const path = (rawPath || "").replace(/^\/+/, "") || "index.html";
  const file = await getJson<{ contentType: string; content: string }>(
    kv,
    siteFileKey(clientId, buildId, path),
  );
  if (!file) return null;
  return new Response(file.content, {
    status: 200,
    headers: {
      "content-type": file.contentType,
      ...(preview
        ? { "x-robots-tag": "noindex", "cache-control": "no-store" }
        : { "cache-control": "public, max-age=300" }),
    },
  });
}

/** The published build on the tenant host, or null when nothing is live. */
export async function servePublishedSite(
  env: BuildEnv,
  client: Client,
  url: URL,
): Promise<Response | null> {
  const published = await getJson<string>(env.WEBAO_KV, publishedKey(client.id));
  if (!published) return null;
  return serveFile(env.WEBAO_KV, client.id, published, url.pathname, false);
}

/** The draft (or published) build under /preview/<clientId>/ on the main site. */
export async function servePreviewSite(
  env: BuildEnv,
  clientId: string,
  path: string,
): Promise<Response> {
  const draft = await getJson<string>(env.WEBAO_KV, draftKey(clientId));
  const published = await getJson<string>(env.WEBAO_KV, publishedKey(clientId));
  const buildId = draft || published;
  if (!buildId) return new Response("Not found", { status: 404 });
  const res = await serveFile(env.WEBAO_KV, clientId, buildId, path, true);
  return res || new Response("Not found", { status: 404 });
}

// ---------------------------------------------------------------------------
// Internal trigger (cron / agent jobs)
// ---------------------------------------------------------------------------

/** POST /api/internal/build { clientId } — same secret gate as the sweeps. */
export async function handleInternalBuild(req: Request, env: BuildEnv): Promise<Response> {
  if (!env.INTERNAL_CRON_SECRET) return err("Build trigger is not configured", 503);
  const auth = req.headers.get("authorization") || "";
  if (!timingSafeEqual(auth, "Bearer " + env.INTERNAL_CRON_SECRET)) {
    return err("Unauthorized", 401);
  }
  let body: { clientId?: unknown };
  try {
    body = (await readJson(req)) as typeof body;
  } catch (e) {
    return err((e as Error).message);
  }
  if (typeof body.clientId !== "string") return err("clientId is required");
  const client = await getClient(env.WEBAO_KV, body.clientId);
  if (!client) return err("Client not found", 404);
  const result = await runBuild(env, client);
  return json({ ok: true, buildId: result.buildId, qaPassed: result.qa.passed, checks: result.qa.checks });
}
