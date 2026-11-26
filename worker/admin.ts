// Admin API: login, stats, form submissions, config, password change.
// Every route below (except /api/admin/login) requires a valid Bearer token.

import { getJson, putJson, deleteKey, listAllKeys } from "./kv";
import {
  getSettings,
  setPasswordHash,
  verifyPassword,
  issueToken,
  requireAdmin,
  currentToken,
  revokeOtherTokens,
  throttle,
  SETTINGS_KEY,
  type Settings,
} from "./auth";
import {
  json,
  err,
  readJson,
  originAllowed,
  clientIp,
  dayKey,
  sanitizePath,
  sha256Hex,
  batch,
  isMonthKey,
} from "./util";
import type { Session } from "./track";
import {
  listSessionKeys,
  loadAllSessionsScan,
  loadSessionSlice,
  loadSessionsFromBundles,
} from "./sessions";
import {
  aggregateCharts,
  aggregateStats,
  chartsAggregateKey,
  isFreshAggregate,
  statsAggregateKey,
  type RangeName,
} from "./aggregates";
import { handleLeadsList, handleLeadDelete, LEADS_INDEX_KEY, type Lead } from "./leads";
import {
  CLIENTS_INDEX,
  createClient,
  findClientByEmail,
  getClient,
  hasAdsPack,
  normalizeDomain,
  onboardingComplete,
  saveClient,
  type AdsStatus,
  type Client,
  type ClientStage,
} from "./clients";
import { startAdminViewSession } from "./portal";
import { assignDomain } from "./tenants";
import { getBuildState, publishBuild, runBuild, type BuildState } from "./builds";
import { listAbandoned } from "./recovery";
import { buildLaunchPacket, recordAdsSpend } from "./ads";
import { clampStr } from "./util";

export async function handleAdmin(req: Request, env: Env, url: URL): Promise<Response> {
  const kv = env.WEBAO_KV;
  const path = url.pathname;

  // --- Public: login (heavily throttled) ---
  if (path === "/api/admin/login" && req.method === "POST") {
    if (!originAllowed(req, true, env)) return err("Forbidden origin", 403);
    if (!(await throttle(kv, "login", clientIp(req), 10))) return err("Too many attempts", 429);
    let body: { password?: unknown };
    try {
      body = (await readJson(req)) as { password?: unknown };
    } catch (e) {
      return err((e as Error).message);
    }
    if (!(await verifyPassword(kv, body.password))) return err("Invalid credentials", 401);
    const token = await issueToken(kv, clientIp(req));
    return json({ ok: true, token });
  }

  // --- Everything else needs a valid Bearer token ---
  const authed = await requireAdmin(req, kv);
  if (authed) return authed;

  // Defense in depth: state-changing admin calls must be same-origin.
  if (req.method !== "GET" && !originAllowed(req, true, env)) return err("Forbidden origin", 403);
  // GETs: Bearer is the auth; only enforce origin when headers are present.
  if (req.method === "GET" && !originAllowed(req, false, env)) return err("Forbidden origin", 403);

  if (path === "/api/admin/stats" && req.method === "GET") return handleStats(kv, url);
  if (path === "/api/admin/visitors" && req.method === "GET") return handleVisitorsList(kv, url);
  if (path === "/api/admin/forms" && req.method === "GET") return handleFormsList(kv, url);
  if (path.startsWith("/api/admin/forms/") && req.method === "DELETE")
    return handleFormDelete(kv, path);
  if (path === "/api/admin/audits" && req.method === "GET") return handleAuditsList(kv, url);
  if (path.startsWith("/api/admin/audits/") && req.method === "DELETE")
    return handleAuditDelete(kv, path);
  if (path === "/api/admin/charts" && req.method === "GET") return handleCharts(kv, url);
  if (path === "/api/admin/leads" && req.method === "GET") return handleLeadsList(kv, url);
  if (path.startsWith("/api/admin/leads/") && req.method === "DELETE")
    return handleLeadDelete(kv, path);
  if (path === "/api/admin/clients" && req.method === "GET") return handleClientsList(kv, url);
  if (path === "/api/admin/clients/update" && req.method === "POST")
    return handleClientUpdate(req, kv);
  if (path === "/api/admin/clients/build" && req.method === "POST")
    return handleClientBuild(req, env);
  if (path === "/api/admin/clients/publish" && req.method === "POST")
    return handleClientPublish(req, env);
  if (path === "/api/admin/clients/ads-packet" && req.method === "GET")
    return handleClientAdsPacket(kv, url);
  if (path === "/api/admin/clients/ads-spend" && req.method === "POST")
    return handleClientAdsSpend(req, kv);
  if (path === "/api/admin/clients/create-test" && req.method === "POST")
    return handleClientCreateTest(req, kv);
  if (path === "/api/admin/clients/view-as" && req.method === "POST")
    return handleClientViewAs(req, env);
  if (path === "/api/admin/config" && req.method === "GET")
    return json({ ok: true, settings: await getSettings(kv) });
  if (path === "/api/admin/config" && req.method === "POST") return handleConfigSet(req, kv);
  if (path === "/api/admin/password" && req.method === "POST")
    return handlePasswordChange(req, kv);

  return err("Not found", 404);
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

/** 60 s response cache for the heavy admin reads (stats/charts/visitors). */
const ADMIN_CACHE_TTL_SECONDS = 60;

/**
 * Serve a heavy admin response from a 60 s KV cache when present, else
 * compute it and store it best-effort. The cache key must capture every
 * query param that changes the body. A cache failure (read or write)
 * never fails the request: a missed read computes live, a failed write
 * is swallowed. Responses are at most a minute stale, which is fine for
 * an admin dashboard — and a repeat visit inside the minute answers
 * from one cached read instead of re-reading every session or lead.
 */
async function cachedJson<T extends object>(
  kv: KVNamespace,
  key: string,
  compute: () => Promise<T>,
): Promise<Response> {
  const hit = await getJson<T>(kv, key);
  if (hit) return json(hit);
  const body = await compute();
  try {
    await putJson(kv, key, body, ADMIN_CACHE_TTL_SECONDS);
  } catch {
    // Best-effort only: the response is already computed.
  }
  return json(body);
}

/**
 * GET /api/admin/stats?range=day|week|month|year|all&page=<path|all>&sessionOffset=0
 * views/visitors series, top pages, device + country breakdowns.
 *
 * Two read paths. The normal one is the day-bundles (see
 * worker/sessions.ts): one GET per day in the store instead of one per
 * session, fresh to the minute through the active-session overlay, so
 * a first load costs ~85 reads today and at most ~420 at a full year
 * of data. When the bundles are missing, malformed or stale the call
 * falls back to the session scan in slices of SESSION_SLICE — the
 * panel loops `sessionOffset` and merges the partials, exactly like
 * the charts tab loops its lead slices — so stats can never breach
 * the worker subrequest budget however many sessions the store holds.
 *
 * Above both sits the precomputed aggregate (`stats:agg:<range>`,
 * written by the rebuild job): one KV read and no aggregation at all,
 * which is what keeps a cold-isolate first call cheap. It covers
 * page=all only; a page filter or a slice loop still goes live.
 */
async function handleStats(kv: KVNamespace, url: URL): Promise<Response> {
  const rangeParam = url.searchParams.get("range") || "week";
  if (
    rangeParam !== "day" &&
    rangeParam !== "week" &&
    rangeParam !== "month" &&
    rangeParam !== "year" &&
    rangeParam !== "all"
  )
    return err("Invalid range");
  const range = rangeParam as RangeName;

  const pageParam = url.searchParams.get("page") || "all";
  let pageFilter: string | null = null;
  if (pageParam !== "all") {
    pageFilter = sanitizePath(pageParam);
    if (!pageFilter) return err("Invalid page");
  }

  const rawOffset = parseInt(url.searchParams.get("sessionOffset") || "0", 10);
  const sessionOffset = Math.max(isNaN(rawOffset) ? 0 : rawOffset, 0);

  // Precomputed aggregate (page=all, first call only): one KV read
  // instead of re-reading every session and aggregating. Fresh for
  // 36 h after the rebuild writes it; a missing, malformed or stale
  // aggregate falls through to the live bundle/slice paths below.
  if (sessionOffset === 0 && pageFilter === null) {
    const agg = await getJson<{ ok?: unknown; builtAt?: unknown }>(
      kv,
      statsAggregateKey(range),
    );
    if (agg && agg.ok === true && isFreshAggregate(agg.builtAt)) return json(agg);
  }

  return cachedJson(
    kv,
    `admin:cache:stats:${range}:${pageFilter || "all"}:${sessionOffset}`,
    async () => {
      const today = dayKey();

      // Bundle path (offset 0 only — a looping caller is already on
      // the slice path): complete aggregates in one call.
      if (sessionOffset === 0) {
        const bundled = await loadSessionsFromBundles(kv);
        if (bundled) {
          return {
            ok: true,
            range,
            page: pageFilter || "all",
            ...aggregateStats(
              bundled.sessions.map(({ s }) => s),
              range,
              pageFilter,
              today,
            ),
            sessionsTotal: bundled.sessions.length,
            sessionsNextOffset: null,
            source: "bundles",
          };
        }
      }

      // Slice path: one slice of the session scan; the panel loops
      // sessionOffset until sessionsNextOffset is null.
      const keys = await listSessionKeys(kv);
      const slice = await loadSessionSlice(kv, keys, sessionOffset);
      return {
        ok: true,
        range,
        page: pageFilter || "all",
        ...aggregateStats(
          slice.sessions.map(({ s }) => s),
          range,
          pageFilter,
          today,
        ),
        sessionsTotal: keys.length,
        sessionsNextOffset: slice.nextOffset,
        source: "slice",
      };
    },
  );
}

// ---------------------------------------------------------------------------
// Visitors — per-visitor pageviews + clicks, newest first
// ---------------------------------------------------------------------------

export interface VisitorItem {
  sid: string;
  startedAt: number;
  lastSeenAt: number;
  device: Session["device"];
  browser: string;
  country: string;
  city?: string;
  ip: string;
  pages: { path: string; at: number; durationMs: number; referrer?: string }[];
  clicks: { path: string; kind: string; label: string; at: number }[];
}

/** GET /api/admin/visitors?limit=50&cursor= — most recently active sessions first. */
async function handleVisitorsList(kv: KVNamespace, url: URL): Promise<Response> {
  const rawLimit = parseInt(url.searchParams.get("limit") || "50", 10);
  const limit = Math.min(Math.max(isNaN(rawLimit) ? 50 : rawLimit, 1), 100);
  const rawCursor = parseInt(url.searchParams.get("cursor") || "0", 10);
  const cursor = Math.max(isNaN(rawCursor) ? 0 : rawCursor, 0);

  // Cursor-paginated like the other lists, so every session is reachable:
  // the tab used to return only the first page of all sessions.
  // Sessions normally come from the day-bundles (one GET per day plus
  // the fresh active overlay) instead of one GET per session. The
  // fallback is the full scan: visitors needs the global lastSeenAt
  // order, which a slice cannot give, so unlike stats it has no slice
  // mode — the fallback only runs while the bundles are missing or
  // stale, and it is bounded by the same ~990-session ceiling the
  // bundles exist to avoid.
  return cachedJson(kv, `admin:cache:visitors:${limit}:${cursor}`, async () => {
    const bundled = await loadSessionsFromBundles(kv);
    const sessions = bundled ? bundled.sessions : await loadAllSessionsScan(kv);
    const source = bundled ? "bundles" : "scan";
    const usable = sessions.filter(
      (x): x is { sid: string; s: Session } => !!x && typeof x.s.startedAt === "number",
    );
    usable.sort((a, b) => (b.s.lastSeenAt || b.s.startedAt) - (a.s.lastSeenAt || a.s.startedAt));

    const items: VisitorItem[] = usable.slice(cursor, cursor + limit).map(({ sid, s }) => ({
      sid,
      startedAt: s.startedAt,
      lastSeenAt: s.lastSeenAt || s.startedAt,
      device: s.device,
      browser: s.browser,
      country: s.country,
      city: s.city,
      ip: s.ip,
      pages: s.pages || [],
      clicks: s.clicks || [],
    }));
    return {
      ok: true,
      items,
      nextCursor: cursor + limit < usable.length ? String(cursor + limit) : null,
      source,
    };
  });
}

// ---------------------------------------------------------------------------
// Form submissions
// ---------------------------------------------------------------------------

/** GET /api/admin/forms?limit=50&cursor=&type= — newest-first, cursor-paginated. */
async function handleFormsList(kv: KVNamespace, url: URL): Promise<Response> {
  const rawLimit = parseInt(url.searchParams.get("limit") || "50", 10);
  const limit = Math.min(Math.max(isNaN(rawLimit) ? 50 : rawLimit, 1), 100);
  const rawCursor = parseInt(url.searchParams.get("cursor") || "0", 10);
  const cursor = Math.max(isNaN(rawCursor) ? 0 : rawCursor, 0);
  const typeFilter = url.searchParams.get("type");

  // No index key: list the form: records and sort newest-first by `at`
  // (form ids start with the submission timestamp, so key order is
  // chronological too, but the record timestamp is the authority).
  const keys = await listAllKeys(kv, "form:", 1000);
  let items = (
    await batch(keys, 25, async (key) => {
      const rec = await getJson<Record<string, unknown>>(kv, key);
      return rec ? { id: key.slice("form:".length), ...rec } : null;
    })
  ).filter((x): x is Record<string, unknown> & { id: string } => x !== null);
  items.sort(
    (a, b) =>
      (Number(b.at) || 0) - (Number(a.at) || 0) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
  );

  if (typeFilter) {
    items = items.filter((item) => (item as { form?: string }).form === typeFilter);
  }

  return json({
    ok: true,
    items: items.slice(cursor, cursor + limit),
    nextCursor: cursor + limit < items.length ? String(cursor + limit) : null,
  });
}

/** DELETE /api/admin/forms/:id — id is "<ts>:<rand>" (the part after "form:"). */
async function handleFormDelete(kv: KVNamespace, path: string): Promise<Response> {
  const m = /^\/api\/admin\/forms\/([^/]+)$/.exec(path);
  if (!m) return err("Invalid id", 400);
  // The frontend sends encodeURIComponent(id), so the captured id is still
  // percent-encoded here (URL.pathname does not decode %3A). Decode it before
  // rebuilding the KV key; otherwise we delete a non-existent key, drop
  // nothing from the index, and the submission silently survives.
  let id: string;
  try {
    id = decodeURIComponent(m[1]);
  } catch {
    return err("Invalid id", 400);
  }
  if (!/^[\w:.-]+$/.test(id) || id.length > 64) return err("Invalid id", 400);
  const key = "form:" + id;
  await deleteKey(kv, key);
  return json({ ok: true });
}

// Audits: free-audit results stored by worker/audit.ts
// ---------------------------------------------------------------------------

/** GET /api/admin/audits?limit=50&cursor= — newest-first, cursor-paginated. */
async function handleAuditsList(kv: KVNamespace, url: URL): Promise<Response> {
  const rawLimit = parseInt(url.searchParams.get("limit") || "50", 10);
  const limit = Math.min(Math.max(isNaN(rawLimit) ? 50 : rawLimit, 1), 100);
  const rawCursor = parseInt(url.searchParams.get("cursor") || "0", 10);
  const cursor = Math.max(isNaN(rawCursor) ? 0 : rawCursor, 0);

  // No index key: list the audit: records and sort newest-first by `at`.
  // Only record keys match /^audit:\d+:/ — the ratelimit counters
  // (audit:ratelimit:<ip>), the /full lock keys (audit:full:<id>) and the
  // old audit:index key are excluded by the pattern.
  const keys = (await listAllKeys(kv, "audit:", 1000)).filter((k) => /^audit:\d+:/.test(k));
  const items = (
    await batch(keys, 25, async (key) => {
      const rec = await getJson<Record<string, unknown>>(kv, key);
      return rec ? { id: key.slice("audit:".length), ...rec } : null;
    })
  )
    .filter((x): x is Record<string, unknown> & { id: string } => x !== null)
    .sort(
      (a, b) =>
        (Number(b.at) || 0) - (Number(a.at) || 0) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
    );

  return json({
    ok: true,
    items: items.slice(cursor, cursor + limit),
    nextCursor: cursor + limit < items.length ? String(cursor + limit) : null,
  });
}

/** DELETE /api/admin/audits/:id — id is "<ts>:<rand>" (the part after "audit:"). */
async function handleAuditDelete(kv: KVNamespace, path: string): Promise<Response> {
  const m = /^\/api\/admin\/audits\/([^/]+)$/.exec(path);
  if (!m) return err("Invalid id", 400);
  // The frontend sends encodeURIComponent(id), so the captured id is still
  // percent-encoded here (URL.pathname does not decode %3A). Decode it before
  // rebuilding the KV key; otherwise we delete a non-existent key, drop
  // nothing from the index, and the audit silently survives.
  let id: string;
  try {
    id = decodeURIComponent(m[1]);
  } catch {
    return err("Invalid id", 400);
  }
  if (!/^[\w:.-]+$/.test(id) || id.length > 64) return err("Invalid id", 400);
  const key = "audit:" + id;
  await deleteKey(kv, key);
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Charts: per-day form + outreach series for the admin chart cards
// ---------------------------------------------------------------------------

/**
 * GET /api/admin/charts?range=day|week|month|year|all&leadOffset=0
 * Buckets form submissions and outreach lead events into the same label
 * shape as /api/admin/stats (daily buckets, monthly for the year and
 * all-time ranges) so the admin charts share one axis format. Lead
 * stages are mutually exclusive (a lead counts once, at its furthest
 * outcome) so they can be drawn as a donut: bounced > opted out >
 * replied > clicked > no response.
 *
 * Above the live paths sits the precomputed aggregate
 * (`charts:agg:<range>`, written by the rebuild job): one KV read and
 * no aggregation, which is what keeps a cold-isolate first call cheap.
 * It covers the whole store (no 1,000 cap) and the first call only; a
 * missing or stale aggregate falls through to the live slices below.
 *
 * The "all" range returns every entry to date: the 1,000-lead cap is
 * lifted and the forms cap with it. One call cannot fetch that many
 * leads — a worker invocation is capped at 1,000 subrequests and one
 * lead costs one — so for "all" the leads arrive in slices of 850
 * (LEAD_SLICE leaves headroom for auth, the index and the forms) and
 * the panel fetches slice after slice via leadOffset, merging them by
 * month label. leadsTotal / leadsNextOffset (null when done) drive
 * that loop; both fields are also present for the other ranges, where
 * leadsNextOffset is always null. Forms are sliced the same way (100
 * per call) so a slice stays inside the budget however many
 * submissions the store holds; formsTotal / formsNextOffset drive it.
 */
async function handleCharts(kv: KVNamespace, url: URL): Promise<Response> {
  const rangeParam = url.searchParams.get("range") || "week";
  if (
    rangeParam !== "day" &&
    rangeParam !== "week" &&
    rangeParam !== "month" &&
    rangeParam !== "year" &&
    rangeParam !== "all"
  )
    return err("Invalid range");
  const range = rangeParam as RangeName;

  const LEAD_SLICE = 850;
  const FORM_SLICE = 100;
  const rawOffset = parseInt(url.searchParams.get("leadOffset") || "0", 10);
  const leadOffset = range === "all" ? Math.max(isNaN(rawOffset) ? 0 : rawOffset, 0) : 0;
  const rawFormOffset = parseInt(url.searchParams.get("formOffset") || "0", 10);
  const formOffset = range === "all" ? Math.max(isNaN(rawFormOffset) ? 0 : rawFormOffset, 0) : 0;

  // Precomputed aggregate (first call only): one KV read instead of
  // re-reading every lead and form and aggregating. Fresh for 36 h
  // after the rebuild writes it; a missing, malformed or stale
  // aggregate falls through to the live sliced paths below.
  if (leadOffset === 0 && formOffset === 0) {
    const agg = await getJson<{ ok?: unknown; builtAt?: unknown }>(
      kv,
      chartsAggregateKey(range),
    );
    if (agg && agg.ok === true && isFreshAggregate(agg.builtAt)) return json(agg);
  }

  return cachedJson(kv, `admin:cache:charts:${range}:${leadOffset}:${formOffset}`, async () => {
    const today = dayKey();

    // --- Forms: totals + per-type series from the submissions ---
    // Sliced like the leads (100 per call) so a slice stays inside the
    // subrequest budget however many submissions the store holds.
    const allFormKeys = await listAllKeys(kv, "form:", range === "all" ? 5000 : 1000);
    const formsCount = allFormKeys.length;
    const formKeys =
      range === "all"
        ? allFormKeys.slice(formOffset, formOffset + FORM_SLICE)
        : allFormKeys.slice(0, 1000);
    const formRecs = await batch(formKeys, 25, (k) =>
      getJson<{ form?: string; at?: number }>(kv, k),
    );
    const formsNextOffset =
      range === "all" && formOffset + FORM_SLICE < formsCount
        ? formOffset + FORM_SLICE
        : null;

    // --- Leads: activity series, exclusive outcome stages, click targets ---
    // Lead keys come from `leads:index` (newest-first, maintained on register/
    // delete; see worker/leads.ts) instead of a full prefix scan: the charts
    // tab loads on every admin visit and the scan cost a key list plus one
    // read per lead (~1,000 today, in 40 sequential batches of 25). The index
    // is a best-effort cache, so a missing, empty or malformed index falls
    // back to the full scan; a drifted index (a failed index update on
    // register) self-heals on the next Outreach-tab load, which rebuilds it
    // on count mismatch (see handleLeadsList). For the fixed ranges the
    // 1,000 cap is unchanged, but it now takes the newest 1,000 leads
    // instead of an arbitrary 1,000: key order is random hex, so the scan
    // used to drop a random slice once the store passed 1,000 leads
    // (1,172 today). Fetch batch is 50, matching the session handlers,
    // so the fetch is 20 sequential batches, not 40.
    const leadsIndex = await getJson<string[]>(kv, LEADS_INDEX_KEY);
    const allLeadKeys =
      Array.isArray(leadsIndex) && leadsIndex.length > 0
        ? leadsIndex
        : await listAllKeys(kv, "lead:", 5000);
    const leadsTotal = allLeadKeys.length;
    const leadKeys =
      range === "all"
        ? allLeadKeys.slice(leadOffset, leadOffset + LEAD_SLICE)
        : allLeadKeys.slice(0, 1000);
    const leadRecs = await batch(leadKeys, 50, (k) => getJson<Lead>(kv, k));
    const leadsNextOffset =
      range === "all" && leadOffset + LEAD_SLICE < leadsTotal
        ? leadOffset + LEAD_SLICE
        : null;

    // One pure aggregation over this slice's records, shared with the
    // rebuild job (worker/aggregates.ts) so precomputed aggregates match
    // live numbers exactly.
    const agg = aggregateCharts(formRecs, leadRecs, range, today, {
      leadsTotal,
      formsTotal: formsCount,
    });

    return {
      ...agg,
      leadsNextOffset,
      formsNextOffset,
    };
  });
}

// ---------------------------------------------------------------------------
// Config + password
// ---------------------------------------------------------------------------

const THEME_VALUES = ["system", "light", "dark"] as const;

/** POST /api/admin/config — update whitelisted settings keys. */
async function handleConfigSet(req: Request, kv: KVNamespace): Promise<Response> {
  let body: Partial<Settings>;
  try {
    body = (await readJson(req)) as Partial<Settings>;
  } catch (e) {
    return err((e as Error).message);
  }
  const next: Settings = { ...(await getSettings(kv)) };
  if (body.defaultTheme !== undefined) {
    if (!(THEME_VALUES as readonly string[]).includes(body.defaultTheme))
      return err("Invalid defaultTheme");
    next.defaultTheme = body.defaultTheme;
  }
  if (body.trackingEnabled !== undefined) {
    if (typeof body.trackingEnabled !== "boolean") return err("Invalid trackingEnabled");
    next.trackingEnabled = body.trackingEnabled;
  }
  await putJson(kv, SETTINGS_KEY, next);
  return json({ ok: true, settings: next });
}

/** POST /api/admin/password — verify current, store SHA-256 of next (>= 5 chars). */
async function handlePasswordChange(req: Request, kv: KVNamespace): Promise<Response> {
  let body: { current?: unknown; next?: unknown };
  try {
    body = (await readJson(req)) as { current?: unknown; next?: unknown };
  } catch (e) {
    return err((e as Error).message);
  }
  if (!(await verifyPassword(kv, body.current))) return err("Current password incorrect", 401);
  if (typeof body.next !== "string" || body.next.length < 12)
    return err("New password must be at least 12 characters");
  if (typeof body.next !== "string" || body.next.length > 256) return err("New password too long");
  await setPasswordHash(kv, await sha256Hex(body.next));
  // Log out every other session; the caller keeps its own token.
  await revokeOtherTokens(kv, currentToken(req));
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Clients (backbone records; see worker/clients.ts)
// ---------------------------------------------------------------------------

function clientSummary(client: Client, build?: BuildState) {
  const qa = build?.latest?.qa;
  return {
    id: client.id,
    email: client.email,
    lang: client.lang,
    test: client.test === true,
    name: client.name,
    business: client.business || client.onboarding?.businessName,
    stage: client.stage,
    billingStatus: client.billingStatus,
    items: client.items,
    createdAt: client.createdAt,
    updatedAt: client.updatedAt,
    onboardingComplete: onboardingComplete(client),
    onboarding: client.onboarding || {},
    onboardingCompletedAt: client.onboardingCompletedAt,
    previewUrl: client.previewUrl,
    domain: client.domain,
    domainStatus: client.domainStatus || "none",
    domainCheckedAt: client.domainCheckedAt,
    reviewDecision: client.reviewDecision,
    revisionCount: client.revisionCount || 0,
    hasAds: hasAdsPack(client),
    adsStatus: client.ads?.status,
    adsTrade: client.ads?.onboarding?.trade,
    adsBudget: client.ads?.onboarding?.monthlyBudget,
    adAccountId: client.ads?.adAccountId,
    nudgeCount: client.nudgeCount || 0,
    nudgesEscalatedAt: client.nudgesEscalatedAt,
    paymentActionRequired: client.paymentActionRequired || null,
    disputeFlag: client.disputeFlag || null,
    stripeCustomerId: client.stripeCustomerId,
    stripeSubscriptionId: client.stripeSubscriptionId,
    buildAt: build?.latest?.builtAt,
    buildQaPassed: qa ? qa.passed : undefined,
    buildQaFailedChecks: qa
      ? qa.checks.filter((c) => !c.ok).map((c) => ({ id: c.id, detail: c.detail }))
      : undefined,
    hasDraft: !!build?.draftBuildId,
    isPublished: !!build?.publishedBuildId,
    publishPending:
      !!build?.draftBuildId && build.draftBuildId !== build.publishedBuildId,
  };
}

/** GET /api/admin/clients?limit=50&cursor=0 — newest first. */
async function handleClientsList(kv: KVNamespace, url: URL): Promise<Response> {
  const rawLimit = parseInt(url.searchParams.get("limit") || "50", 10);
  const limit = Math.min(Math.max(isNaN(rawLimit) ? 50 : rawLimit, 1), 100);
  const rawCursor = parseInt(url.searchParams.get("cursor") || "0", 10);
  const cursor = Math.max(isNaN(rawCursor) ? 0 : rawCursor, 0);

  const index = (await getJson<string[]>(kv, CLIENTS_INDEX)) || [];
  const slice = index.slice(cursor, cursor + limit);
  const items = (
    await batch(slice, 25, async (key) => {
      const rec = await getJson<Client>(kv, key);
      if (!rec) return null;
      const build = await getBuildState(kv, rec.id);
      return clientSummary(rec, build);
    })
  ).filter((x): x is ReturnType<typeof clientSummary> => x !== null);

  // Abandoned checkouts ride the first page only (warm leads, see recovery.ts).
  // The whole abandoned index, not just the first 50: the index itself
  // keeps at most 500 newest, so this is every abandoned checkout on file.
  const abandoned = cursor === 0 ? await listAbandoned(kv) : [];

  return json({
    ok: true,
    items,
    abandoned,
    nextCursor: cursor + limit < index.length ? String(cursor + limit) : null,
  });
}

const STAGES: ClientStage[] = ["onboarding", "build", "review", "live", "paused"];

const ADS_STATUSES: AdsStatus[] = ["onboarding", "setup", "ready", "live", "paused"];

/** POST /api/admin/clients/update { id, stage?, previewUrl?, domain?, adsStatus?, adAccountId? } */
async function handleClientUpdate(req: Request, kv: KVNamespace): Promise<Response> {
  let body: {
    id?: unknown;
    stage?: unknown;
    previewUrl?: unknown;
    domain?: unknown;
    adsStatus?: unknown;
    adAccountId?: unknown;
  };
  try {
    body = (await readJson(req)) as typeof body;
  } catch (e) {
    return err((e as Error).message);
  }
  if (typeof body.id !== "string") return err("Client id is required");
  const client = await getClient(kv, body.id);
  if (!client) return err("Client not found", 404);
  if (body.stage !== undefined) {
    if (!STAGES.includes(body.stage as ClientStage)) return err("Invalid stage");
    client.stage = body.stage as ClientStage;
  }
  if (body.previewUrl !== undefined) {
    const value = clampStr(body.previewUrl, 500).trim();
    if (value && !/^https:\/\/[^\s]+$/.test(value)) return err("Preview URL must be an https URL");
    client.previewUrl = value || undefined;
  }
  if (body.domain !== undefined) {
    if (typeof body.domain !== "string") return err("Invalid domain");
    if (!body.domain.trim()) {
      await assignDomain(kv, client, null, "none");
    } else {
      const host = normalizeDomain(body.domain);
      if (!host) return err("Invalid domain");
      const result = await assignDomain(
        kv,
        client,
        host,
        client.onboarding?.domainMode === "new" ? "to-register" : "pending-dns",
      );
      if (!result.ok) return err("That domain is assigned to another client", 409);
    }
  }
  if (body.adsStatus !== undefined || body.adAccountId !== undefined) {
    if (!client.ads) {
      if (!hasAdsPack(client)) return err("Client has no Ads Pack");
      client.ads = { status: "onboarding", platform: "meta", updatedAt: Date.now() };
    }
    if (body.adsStatus !== undefined) {
      if (!ADS_STATUSES.includes(body.adsStatus as AdsStatus)) return err("Invalid ads status");
      client.ads.status = body.adsStatus as AdsStatus;
    }
    if (body.adAccountId !== undefined) {
      if (typeof body.adAccountId !== "string") return err("Invalid ad account id");
      client.ads.adAccountId = clampStr(body.adAccountId, 64).trim() || undefined;
    }
    client.ads.updatedAt = Date.now();
  }
  await saveClient(kv, client);
  const build = await getBuildState(kv, client.id);
  return json({ ok: true, client: clientSummary(client, build) });
}

/** POST /api/admin/clients/build { id } — generate + QA a draft build. */
async function handleClientBuild(req: Request, env: Env): Promise<Response> {
  let body: { id?: unknown };
  try {
    body = (await readJson(req)) as typeof body;
  } catch (e) {
    return err((e as Error).message);
  }
  if (typeof body.id !== "string") return err("Client id is required");
  const client = await getClient(env.WEBAO_KV, body.id);
  if (!client) return err("Client not found", 404);
  const result = await runBuild(env, client);
  return json({ ok: true, buildId: result.buildId, qaPassed: result.qa.passed, checks: result.qa.checks });
}

/** GET /api/admin/clients/ads-packet?id= — the launch packet for a client. */
async function handleClientAdsPacket(kv: KVNamespace, url: URL): Promise<Response> {
  const id = url.searchParams.get("id") || "";
  const client = await getClient(kv, id);
  if (!client) return err("Client not found", 404);
  return json({ ok: true, packet: buildLaunchPacket(client) });
}

/** POST /api/admin/clients/ads-spend { id, month: "yyyy-mm", amountCents } */
async function handleClientAdsSpend(req: Request, kv: KVNamespace): Promise<Response> {
  let body: { id?: unknown; month?: unknown; amountCents?: unknown };
  try {
    body = (await readJson(req)) as typeof body;
  } catch (e) {
    return err((e as Error).message);
  }
  if (typeof body.id !== "string") return err("Client id is required");
  if (!isMonthKey(body.month)) {
    return err("Month must be yyyy-mm");
  }
  if (typeof body.amountCents !== "number" || !(body.amountCents >= 0)) {
    return err("amountCents must be a non-negative number");
  }
  const client = await getClient(kv, body.id);
  if (!client) return err("Client not found", 404);
  await recordAdsSpend(kv, client.id, body.month, Math.round(body.amountCents));
  return json({ ok: true });
}

/**
 * POST /api/admin/clients/create-test { email, business?, lang? } — create a
 * test client record (Launch plan + Ads Pack) for walking the portal as a
 * customer. Flagged test: no onboarding nudges, no monthly reports. A real
 * checkout with the same email graduates it into a real record.
 */
async function handleClientCreateTest(req: Request, kv: KVNamespace): Promise<Response> {
  let body: { email?: unknown; business?: unknown; lang?: unknown };
  try {
    body = (await readJson(req)) as typeof body;
  } catch (e) {
    return err((e as Error).message);
  }
  const email = clampStr(body.email, 200).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return err("A valid email is required");
  if (await findClientByEmail(kv, email)) {
    return err("A client with that email already exists", 409);
  }
  const business = clampStr(body.business, 120).trim() || "TEST Client";
  const client = await createClient(kv, {
    email,
    name: "Test client",
    business,
    lang: body.lang === "fr" ? "fr" : "en",
    items: ["launch-month", "ads-pack-month"],
    source: "admin-test",
    test: true,
  });
  client.ads = { status: "onboarding", platform: "meta", updatedAt: Date.now() };
  await saveClient(kv, client);
  return json({ ok: true, client: clientSummary(client) });
}

/**
 * POST /api/admin/clients/view-as { id } — mint an admin-flagged portal
 * session for this client and set it as the portal cookie, so the admin's
 * browser opens the portal exactly as the client sees it.
 */
async function handleClientViewAs(req: Request, env: Env): Promise<Response> {
  let body: { id?: unknown };
  try {
    body = (await readJson(req)) as typeof body;
  } catch (e) {
    return err((e as Error).message);
  }
  if (typeof body.id !== "string") return err("Client id is required");
  const client = await getClient(env.WEBAO_KV, body.id);
  if (!client) return err("Client not found", 404);
  return startAdminViewSession(env, client);
}

/** POST /api/admin/clients/publish { id } — point the tenant host at the draft. */
async function handleClientPublish(req: Request, env: Env): Promise<Response> {
  let body: { id?: unknown };
  try {
    body = (await readJson(req)) as typeof body;
  } catch (e) {
    return err((e as Error).message);
  }
  if (typeof body.id !== "string") return err("Client id is required");
  const client = await getClient(env.WEBAO_KV, body.id);
  if (!client) return err("Client not found", 404);
  const result = await publishBuild(env, client);
  if (!result.ok) return err(result.error || "Publish failed", 400);
  return json({ ok: true, buildId: result.buildId });
}
