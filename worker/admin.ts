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
  addDays,
  sanitizePath,
  sha256Hex,
  batch,
} from "./util";
import type { Session } from "./track";
import { handleLeadsList, handleLeadDelete, LEADS_INDEX, type Lead } from "./leads";

const FORMS_INDEX = "forms:index";

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
  if (path === "/api/admin/forms" && req.method === "GET") return handleFormsList(kv, url);
  if (path.startsWith("/api/admin/forms/") && req.method === "DELETE")
    return handleFormDelete(kv, path);
  if (path === "/api/admin/charts" && req.method === "GET") return handleCharts(kv, url);
  if (path === "/api/admin/leads" && req.method === "GET") return handleLeadsList(kv, url);
  if (path.startsWith("/api/admin/leads/") && req.method === "DELETE")
    return handleLeadDelete(kv, path);
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

type RangeName = "day" | "week" | "month" | "year";

function rangeDays(range: RangeName, today: string): string[] {
  const n = range === "day" ? 1 : range === "week" ? 7 : range === "month" ? 30 : 365;
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(addDays(today, -i));
  return out;
}

interface DayCounts {
  day: string;
  counts: { path: string; n: number }[];
}

/**
 * GET /api/admin/stats?range=day|week|month|year&page=<path|all>
 * views/visitors series, top pages, device + country breakdowns.
 * Correct for the expected scale; sessions are scanned from KV (capped).
 */
async function handleStats(kv: KVNamespace, url: URL): Promise<Response> {
  const rangeParam = url.searchParams.get("range") || "week";
  if (rangeParam !== "day" && rangeParam !== "week" && rangeParam !== "month" && rangeParam !== "year")
    return err("Invalid range");
  const range = rangeParam as RangeName;

  const pageParam = url.searchParams.get("page") || "all";
  let pageFilter: string | null = null;
  if (pageParam !== "all") {
    pageFilter = sanitizePath(pageParam);
    if (!pageFilter) return err("Invalid page");
  }

  const today = dayKey();
  const days = rangeDays(range, today);

  // --- 1. Views: per-day per-path counts from the daily view keys ---
  const dayData: DayCounts[] = await batch(days, 25, async (day) => {
    const keys = await listAllKeys(kv, `views:${day}:`, 5000);
    const counts = await batch(keys, 50, async (k) => {
      const encPath = k.slice(`views:${day}:`.length);
      if (encPath === "__all") return { path: "__all", n: 0 };
      // A malformed escape in a stored key must not take the whole stats
      // endpoint down; fall back to the raw key segment.
      let path = encPath;
      try {
        path = decodeURIComponent(encPath);
      } catch {
        /* keep the raw segment */
      }
      const v = await kv.get(k);
      return { path, n: v ? parseInt(v, 10) || 0 : 0 };
    });
    return { day, counts: counts.filter((c) => c.path !== "__all") };
  });

  const perPath = new Map<string, number>();
  const viewsByDay = new Map<string, number>();
  for (const { day, counts } of dayData) {
    let dayTotal = 0;
    for (const { path, n } of counts) {
      perPath.set(path, (perPath.get(path) || 0) + n);
      if (!pageFilter || path === pageFilter) dayTotal += n;
    }
    viewsByDay.set(day, dayTotal);
  }

  // --- 2. Visitors/devices/countries: scan sessions by startedAt ---
  const startTs = Date.parse(days[0] + "T00:00:00Z");
  const endTs = Date.parse(today + "T00:00:00Z") + 24 * 3600 * 1000;
  const sessionKeys = await listAllKeys(kv, "session:", 20000);
  const sessions = (
    await batch(sessionKeys, 50, (k) => getJson<Session>(kv, k))
  ).filter((s): s is Session => !!s && s.startedAt >= startTs && s.startedAt < endTs);

  const visitorsByDay = new Map<string, number>();
  const devices = { mobile: 0, tablet: 0, desktop: 0 };
  const countryCounts = new Map<string, number>();
  for (const s of sessions) {
    const d = dayKey(s.startedAt);
    visitorsByDay.set(d, (visitorsByDay.get(d) || 0) + 1);
    devices[s.device] = (devices[s.device] || 0) + 1;
    const cc = (s.country || "XX").toUpperCase();
    countryCounts.set(cc, (countryCounts.get(cc) || 0) + 1);
  }

  // --- 3. Shape the response (day/week/month => daily buckets, year => monthly) ---
  let labels: string[];
  let views: number[];
  let visitors: number[];
  if (range === "year") {
    const months: string[] = [];
    for (const d of days) {
      const m = d.slice(0, 7);
      if (months[months.length - 1] !== m) months.push(m);
    }
    labels = months;
    views = months.map((m) =>
      days.filter((d) => d.startsWith(m)).reduce((a, d) => a + (viewsByDay.get(d) || 0), 0),
    );
    visitors = months.map((m) =>
      days.filter((d) => d.startsWith(m)).reduce((a, d) => a + (visitorsByDay.get(d) || 0), 0),
    );
  } else {
    labels = days;
    views = days.map((d) => viewsByDay.get(d) || 0);
    visitors = days.map((d) => visitorsByDay.get(d) || 0);
  }

  const topPages = [...perPath.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([path, v]) => ({ path, views: v }));

  const countries = [...countryCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([code, count]) => ({ code, count }));

  return json({
    ok: true,
    range,
    page: pageFilter || "all",
    labels,
    views,
    visitors,
    topPages,
    devices,
    countries,
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

  const index = (await getJson<string[]>(kv, FORMS_INDEX)) || [];
  // Fetch a wider slice when filtering, since we filter after fetch
  const fetchLimit = typeFilter ? limit * 4 : limit;
  const slice = index.slice(cursor, cursor + fetchLimit);
  let items = (
    await batch(slice, 25, async (key) => {
      const rec = await getJson<Record<string, unknown>>(kv, key);
      return rec ? { id: key.slice("form:".length), ...rec } : null;
    })
  ).filter((x): x is Record<string, unknown> & { id: string } => x !== null);

  if (typeFilter) {
    items = items.filter((item) => (item as { form?: string }).form === typeFilter);
    items = items.slice(0, limit);
  }

  return json({
    ok: true,
    items,
    nextCursor: cursor + fetchLimit < index.length ? String(cursor + fetchLimit) : null,
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
  const index = (await getJson<string[]>(kv, FORMS_INDEX)) || [];
  const next = index.filter((k) => k !== key);
  if (next.length !== index.length) await putJson(kv, FORMS_INDEX, next);
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Charts: per-day form + outreach series for the admin chart cards
// ---------------------------------------------------------------------------

/**
 * GET /api/admin/charts?range=day|week|month|year
 * Buckets form submissions and outreach lead events into the same label
 * shape as /api/admin/stats (daily buckets, monthly for the year range) so
 * the admin charts share one axis format. Lead stages are mutually
 * exclusive (a lead counts once, at its furthest outcome) so they can be
 * drawn as a donut: bounced > opted out > replied > clicked > no response.
 */
async function handleCharts(kv: KVNamespace, url: URL): Promise<Response> {
  const rangeParam = url.searchParams.get("range") || "week";
  if (rangeParam !== "day" && rangeParam !== "week" && rangeParam !== "month" && rangeParam !== "year")
    return err("Invalid range");
  const range = rangeParam as RangeName;

  const today = dayKey();
  const days = rangeDays(range, today);
  const startTs = Date.parse(days[0] + "T00:00:00Z");
  const endTs = Date.parse(today + "T00:00:00Z") + 24 * 3600 * 1000;

  // Label positions: daily buckets, or one bucket per month for the year.
  let labels: string[];
  const bucketOf = new Map<string, number>();
  if (range === "year") {
    const months: string[] = [];
    for (const d of days) {
      const m = d.slice(0, 7);
      if (months[months.length - 1] !== m) months.push(m);
    }
    labels = months;
    months.forEach((m, i) => bucketOf.set(m, i));
  } else {
    labels = days;
    days.forEach((d, i) => bucketOf.set(d, i));
  }
  const series = (): number[] => labels.map(() => 0);
  const bump = (arr: number[], ts: number | undefined): void => {
    if (typeof ts !== "number" || ts < startTs || ts >= endTs) return;
    const key = range === "year" ? dayKey(ts).slice(0, 7) : dayKey(ts);
    const i = bucketOf.get(key);
    if (i !== undefined) arr[i] += 1;
  };

  // --- Forms: totals + per-type series from the submissions index ---
  const formsTotal = series();
  const formsByType = { contact: series(), support: series(), pricing: series() };
  const formKeys = (await getJson<string[]>(kv, FORMS_INDEX)) || [];
  const formRecs = await batch(formKeys.slice(0, 1000), 25, (k) =>
    getJson<{ form?: string; at?: number }>(kv, k),
  );
  for (const rec of formRecs) {
    if (!rec || typeof rec.at !== "number") continue;
    bump(formsTotal, rec.at);
    if (rec.form === "contact" || rec.form === "support" || rec.form === "pricing")
      bump(formsByType[rec.form], rec.at);
  }

  // --- Leads: activity series, exclusive outcome stages, click targets ---
  const leadsSent = series();
  const leadsClicked = series();
  const leadsReplied = series();
  const leadStages = { replied: 0, clicked: 0, none: 0, optout: 0, bounced: 0 };
  const clickDests = { demos: 0, home: 0, pricing: 0, start: 0 };
  const leadKeys = (await getJson<string[]>(kv, LEADS_INDEX)) || [];
  const leadRecs = await batch(leadKeys.slice(0, 1000), 25, (k) => getJson<Lead>(kv, k));
  for (const lead of leadRecs) {
    if (!lead) continue;
    bump(leadsSent, lead.sentAt);
    bump(leadsClicked, lead.firstClickAt);
    bump(leadsReplied, lead.repliedAt);
    if (lead.sentAt >= startTs && lead.sentAt < endTs) {
      if (lead.bouncedAt) leadStages.bounced += 1;
      else if (lead.optOutAt) leadStages.optout += 1;
      else if (lead.repliedAt) leadStages.replied += 1;
      else if ((lead.clickCount || 0) > 0) leadStages.clicked += 1;
      else leadStages.none += 1;
    }
    for (const c of lead.clicks || []) {
      if (c.suspect || c.at < startTs || c.at >= endTs) continue;
      if (c.dest === "demos" || c.dest === "home" || c.dest === "pricing" || c.dest === "start")
        clickDests[c.dest] += 1;
    }
  }

  return json({
    ok: true,
    range,
    labels,
    forms: { total: formsTotal, byType: formsByType },
    leads: { sent: leadsSent, clicked: leadsClicked, replied: leadsReplied },
    leadStages,
    clickDests,
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
