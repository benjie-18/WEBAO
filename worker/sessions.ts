// Visitor sessions, read at admin scale.
//
// The admin stats and visitors tabs used to read every session record on
// every load (636 GETs today, ~17 new sessions a day). A worker invocation
// is capped at 1,000 subrequests, so that scan silently drops sessions
// once the store passes ~990 — mid-December 2026 at the current growth
// rate. This module replaces the scan with two cheaper structures:
//
// 1. Day-bundles (`session-bundle:<yyyy-mm-dd>`): one key per day holding
//    the full session records for sessions that STARTED that day. A stats
//    or visitors load reads ~30 bundle keys today (at most 365, one per
//    day in the 365-day TTL window) instead of one GET per session, so
//    the read cost scales with days, not sessions. Bundles are a derived
//    cache: the session records stay the only source of truth, a daily
//    rebuild keeps them fresh, and any missing, malformed or stale
//    bundle set falls back to the session scan (sliced for stats, full
//    for visitors — see loadSessionsFromBundles).
// 2. Active markers (`sessions:active:<yyyy-mm-dd>:<sid>`, TTL 3 days):
//    a bundle rebuilt once a day goes stale intraday — a visitor seen 5
//    minutes ago must still sort first. The touch path therefore marks
//    a session active on its first touch of the day (detected from the
//    session's own lastSeenAt, so no extra read), and the admin read
//    path fetches the marked sessions fresh and overlays them on the
//    bundles. At most one marker write per session per day.
//
// 3. Day registry (`sessions:day:<yyyy-mm-dd>`): one tiny key per day
//    that holds sessions, written when a session is created and pruned
//    by the full rebuild. The loader needs it to prove completeness: a
//    day with sessions but no bundle must fall back to the scan, and
//    without the registry a missing bundle for an old quiet day would
//    silently drop those sessions. Today and yesterday need no bundle —
//    every session touched on those days carries an active marker, so
//    the overlay covers them exactly.
//
// 4. Precomputed aggregates (`stats:agg:<range>`, `charts:agg:<range>`):
//    the admin stats/charts handlers serve these instead of re-reading
//    every session/lead and aggregating, which is what keeps a
//    cold-isolate first call cheap (a stored read is ~1 ms even cold).
//    Stats aggregates are recomputed from the bundles at the end of
//    every rebuild (incremental and full); charts aggregates are built
//    by a separate sliced "charts" mode of the same endpoint, because
//    they need the lead/form stores too. An aggregate is fresh for
//    36 h; a missing or stale one never fails a load — the handler
//    falls back to live aggregation (see worker/aggregates.ts).
//
// No compression: the ceiling is the subrequest count, not the bytes —
// a session record is a few hundred bytes and Cloudflare already gzips
// the HTTP response — so stored values stay plain JSON.
//
// Write budget (worst case): markers <= 1 per session per day (first
// touch), one day-registry write per NEW session, incremental rebuild
// ~1 bundle write per active day, weekly full rebuild ~3 writes per day
// (staging + live + deletes). At current volume that is roughly 150
// writes/day, far inside the 1,000/day free KV cap and trivial against
// the 1M/month paid cap (the worker runs on the Paid usage model — see
// Step 0 in the deploy notes).

import { getJson, putJson, deleteKey, listAllKeys } from "./kv";
import { batch, dayKey, addDays, err, json, readJson, timingSafeEqual } from "./util";
import type { Session } from "./track";
import {
  aggregateCharts,
  aggregateStats,
  chartsAggregateKey,
  mergeChartsAggregates,
  statsAggregateKey,
  AGG_RANGES,
  CHARTS_AGG_STAGING_KEY,
  type ChartsAggregate,
  type RangeName,
} from "./aggregates";
import { LEADS_INDEX_KEY, type Lead } from "./leads";

/** One bundle per startedAt day; a day's sessions ride in one KV value. */
export const SESSION_BUNDLE_PREFIX = "session-bundle:";
/** Staging keys for the sliced full rebuild; deliberately outside the live prefix. */
const SESSION_BUNDLE_STAGING_PREFIX = "session-bundle-staging:";
/** First-touch-of-the-day markers; the day is in the key, the sid after it. */
export const ACTIVE_MARKER_PREFIX = "sessions:active:";
/** One key per day that holds sessions; see the header note (item 3). */
export const SESSION_DAY_PREFIX = "sessions:day:";
/** Day entries outlive the 365-day session TTL, then expire on their own. */
const SESSION_DAY_TTL_SECONDS = 400 * 24 * 3600;
/** Markers outlive the two days the read path consults, then expire on their own. */
const ACTIVE_MARKER_TTL_SECONDS = 3 * 24 * 3600;
/** Sessions per slice: one slice call stays far inside the subrequest budget. */
export const SESSION_SLICE = 500;
/** A bundle set older than this is treated as missing: fall back to the scan. */
const BUNDLE_STALE_MS = 36 * 3600 * 1000;
/** A bundle set is rebuilt from scratch on this schedule (weekly full). */

export interface BundledSession extends Session {
  sid: string;
}

export interface SessionBundle {
  day: string;
  builtAt: number;
  sessions: BundledSession[];
}

export interface LoadedSession {
  sid: string;
  s: Session;
}

const bundleKey = (day: string): string => SESSION_BUNDLE_PREFIX + day;
const stagingKey = (day: string): string => SESSION_BUNDLE_STAGING_PREFIX + day;
const markerKey = (day: string, sid: string): string =>
  `${ACTIVE_MARKER_PREFIX}${day}:${sid}`;

/**
 * Mark a session active for today, best-effort. Call after a session
 * write with the session's lastSeenAt from BEFORE the write (null when
 * the session was just created). A marker is written only when this is
 * the session's first touch of the day — a later touch the same day
 * finds lastSeenAt already today and skips — so the touch path costs
 * at most one extra write per session per day, and no extra read at
 * all. A failed marker write is swallowed: the session record itself
 * is already stored, the marker only affects how fresh the admin tabs
 * look until the next rebuild.
 */
export async function noteSessionTouch(
  kv: KVNamespace,
  sid: string,
  prevLastSeenAt: number | null,
): Promise<void> {
  const today = dayKey();
  if (prevLastSeenAt !== null && dayKey(prevLastSeenAt) === today) return;
  try {
    await putJson(kv, markerKey(today, sid), "1", ACTIVE_MARKER_TTL_SECONDS);
  } catch {
    // Best-effort only: tracking must never break over a marker.
  }
}

/**
 * Register a day as holding sessions, best-effort. Call once when a
 * session is created (one write per new session, ~17/day). The value
 * is idempotent — concurrent creations the same day write the same
 * "1" — so no read-modify-write and no contention. The loader uses
 * these keys to prove the bundle set is complete; the full rebuild
 * prunes entries for days with no sessions left.
 */
export async function noteSessionCreated(kv: KVNamespace, day: string): Promise<void> {
  try {
    await putJson(kv, SESSION_DAY_PREFIX + day, "1", SESSION_DAY_TTL_SECONDS);
  } catch {
    // Best-effort only: tracking must never break over the registry.
  }
}

// ---------------------------------------------------------------------------
// Admin read path: bundles + fresh active overlay, else the session scan
// ---------------------------------------------------------------------------

/**
 * Load every session from the day-bundles, overlaid with the sessions
 * touched today and yesterday fetched fresh. Returns null when the
 * bundle set cannot be trusted (no bundles, a malformed bundle, a
 * newest build older than BUNDLE_STALE_MS, or a day in the day
 * registry with no bundle — today and yesterday excepted, the active
 * overlay covers them) so the caller falls back to the session scan.
 * Fresh records always win over bundle copies of the same session,
 * and a session the overlay fetches that no bundle holds (started
 * after the last rebuild) is added.
 */
export async function loadSessionsFromBundles(
  kv: KVNamespace,
): Promise<{ sessions: LoadedSession[]; builtAt: number } | null> {
  const keys = await listAllKeys(kv, SESSION_BUNDLE_PREFIX, 400);
  if (keys.length === 0) return null;
  const bundles = (
    await batch(keys, 50, (k) => getJson<SessionBundle>(kv, k))
  ).filter(
    (b): b is SessionBundle => !!b && typeof b.day === "string" && Array.isArray(b.sessions),
  );
  if (bundles.length === 0) return null;
  const builtAt = Math.max(...bundles.map((b) => b.builtAt || 0));
  if (!builtAt || Date.now() - builtAt > BUNDLE_STALE_MS) return null;

  // Completeness: every day that holds sessions needs its bundle,
  // except today and yesterday, whose sessions all carry an active
  // marker and are fetched fresh below. Without this a missing bundle
  // for an old quiet day would silently drop its sessions instead of
  // falling back. An empty registry means the day entries were never
  // written (sessions predate this change and no full rebuild has run
  // yet); the bundles can only exist after a rebuild, and rebuilds
  // write the registry, so an empty registry with bundles present is
  // treated as complete.
  const today = dayKey();
  const yesterday = addDays(today, -1);
  const oldest = addDays(today, -365);
  const bundledDays = new Set(bundles.map((b) => b.day));
  const dayKeys = await listAllKeys(kv, SESSION_DAY_PREFIX, 400);
  for (const k of dayKeys) {
    const day = k.slice(SESSION_DAY_PREFIX.length);
    if (day === today || day === yesterday) continue;
    if (day < oldest) continue;
    if (!bundledDays.has(day)) return null;
  }

  const bySid = new Map<string, Session>();
  for (const b of bundles) {
    for (const s of b.sessions) {
      if (s && typeof s.sid === "string" && typeof s.startedAt === "number")
        bySid.set(s.sid, s);
    }
  }

  // Fresh overlay: sessions touched today or yesterday may have moved
  // since the last rebuild. Their markers are per-(day, sid) keys, so
  // listing them is two cheap prefix lists; each marked session is
  // fetched live and overwrites its bundle copy (or adds a session the
  // bundles do not hold yet).
  const overlayDays = [today, addDays(today, -1)];
  for (const day of overlayDays) {
    const markerKeys = await listAllKeys(kv, ACTIVE_MARKER_PREFIX + day + ":", 5000);
    const sids = markerKeys.map((k) => k.slice((ACTIVE_MARKER_PREFIX + day + ":").length));
    const fresh = await batch(sids, 50, (sid) => getJson<Session>(kv, "session:" + sid));
    fresh.forEach((s, i) => {
      if (s && typeof s.startedAt === "number") bySid.set(sids[i], s);
    });
  }

  return {
    sessions: [...bySid.entries()].map(([sid, s]) => ({ sid, s })),
    builtAt,
  };
}

/** Every `session:` key, newest-independent (lexicographic) order. */
export async function listSessionKeys(kv: KVNamespace): Promise<string[]> {
  return listAllKeys(kv, "session:", 20000);
}

/**
 * One slice of the session scan: the sessions at [offset, offset +
 * SESSION_SLICE) of the key list, plus the total and the next offset
 * (null when done). Slices are disjoint, so a caller looping them
 * counts every session exactly once.
 */
export async function loadSessionSlice(
  kv: KVNamespace,
  keys: string[],
  offset: number,
): Promise<{ sessions: LoadedSession[]; total: number; nextOffset: number | null }> {
  const slice = keys.slice(offset, offset + SESSION_SLICE);
  const sessions = (
    await batch(slice, 50, async (k) => {
      const s = await getJson<Session>(kv, k);
      return s && typeof s.startedAt === "number"
        ? { sid: k.slice("session:".length), s }
        : null;
    })
  ).filter((x): x is LoadedSession => x !== null);
  return {
    sessions,
    total: keys.length,
    nextOffset: offset + SESSION_SLICE < keys.length ? offset + SESSION_SLICE : null,
  };
}

/**
 * The whole session scan in one call (visitors fallback only). Stats
 * uses loadSessionSlice so it can never breach the subrequest budget;
 * visitors needs the global lastSeenAt order, which a slice cannot
 * give, so its fallback is the full scan.
 */
export async function loadAllSessionsScan(kv: KVNamespace): Promise<LoadedSession[]> {
  const keys = await listSessionKeys(kv);
  const sessions = (
    await batch(keys, 50, async (k) => {
      const s = await getJson<Session>(kv, k);
      return s && typeof s.startedAt === "number"
        ? { sid: k.slice("session:".length), s }
        : null;
    })
  ).filter((x): x is LoadedSession => x !== null);
  return sessions;
}

// ---------------------------------------------------------------------------
// Rebuild: POST /api/internal/session-bundles/rebuild (shared secret)
// ---------------------------------------------------------------------------

interface RebuildBody {
  mode?: unknown;
  offset?: unknown;
  leadOffset?: unknown;
  formOffset?: unknown;
}

function upsertInto(
  bundle: SessionBundle | null,
  day: string,
  sessions: BundledSession[],
): SessionBundle {
  const bySid = new Map<string, BundledSession>();
  for (const s of bundle?.sessions || []) bySid.set(s.sid, s);
  for (const s of sessions) bySid.set(s.sid, s);
  return { day, builtAt: Date.now(), sessions: [...bySid.values()] };
}

/**
 * Recompute the stats aggregates (page=all, every range) from the
 * day-bundles and write one `stats:agg:<range>` key each. The bundles
 * are the same data the live handler aggregates, plus the fresh
 * active-session overlay, so the stored numbers match the live
 * bundle-path response exactly. Returns false when the bundle set
 * cannot be trusted (missing/stale/incomplete) — the caller then
 * leaves the previous aggregates in place and the handlers fall back
 * to live aggregation. Costs ~one GET per bundle day plus the
 * aggregation itself; it runs inside the rebuild invocation, never on
 * an admin first call.
 */
async function refreshStatsAggregates(kv: KVNamespace): Promise<boolean> {
  const bundled = await loadSessionsFromBundles(kv);
  if (!bundled) return false;
  const sessions = bundled.sessions.map(({ s }) => s);
  const today = dayKey();
  const builtAt = Date.now();
  for (const range of AGG_RANGES) {
    await putJson(kv, statsAggregateKey(range), {
      ok: true,
      range,
      page: "all",
      ...aggregateStats(sessions, range, null, today),
      sessionsTotal: sessions.length,
      sessionsNextOffset: null,
      source: "precomputed",
      builtAt,
    });
  }
  return true;
}

/**
 * Incremental rebuild (default, daily): take the sessions touched in
 * the last 3 days — the active markers say exactly which — fetch them
 * fresh and upsert them into their startedAt-day bundles. Sessions
 * untouched for 3 days are already correct in the bundles, so they
 * cost no reads at all. A marked session that no longer exists is
 * skipped; the weekly full rebuild drops such expired entries.
 */
async function rebuildIncremental(
  kv: KVNamespace,
): Promise<{
  mode: string;
  days: string[];
  sessions: number;
  builtAt: number;
  statsAggregates: boolean;
}> {
  const markerKeys = await listAllKeys(kv, ACTIVE_MARKER_PREFIX, 20000);
  const sids = [...new Set(markerKeys.map((k) => k.slice(k.lastIndexOf(":") + 1)))];
  const fresh = await batch(sids, 50, (sid) => getJson<Session>(kv, "session:" + sid));
  const byDay = new Map<string, BundledSession[]>();
  let count = 0;
  fresh.forEach((s, i) => {
    if (!s || typeof s.startedAt !== "number") return;
    const day = dayKey(s.startedAt);
    const list = byDay.get(day) || [];
    list.push({ sid: sids[i], ...s });
    byDay.set(day, list);
    count += 1;
  });
  const builtAt = Date.now();
  const days = [...byDay.keys()].sort();
  for (const day of days) {
    const existing = await getJson<SessionBundle>(kv, bundleKey(day));
    const next = upsertInto(existing, day, byDay.get(day) || []);
    next.builtAt = builtAt;
    await putJson(kv, bundleKey(day), next);
    // Register the day as holding sessions (idempotent; see header).
    await putJson(kv, SESSION_DAY_PREFIX + day, "1", SESSION_DAY_TTL_SECONDS);
  }
  const statsAggregates = await refreshStatsAggregates(kv);
  return { mode: "incremental", days, sessions: count, builtAt, statsAggregates };
}

/**
 * Full rebuild (weekly, sliced): walk every session key in slices of
 * SESSION_SLICE, upserting each slice into STAGING bundles. The final
 * slice swaps staging into live (one atomic PUT per day) and deletes
 * live bundles for days that hold no sessions anymore, so a reader
 * never sees a half-rebuilt day. The caller loops `offset` until
 * `done` is true. A run that dies mid-way leaves staging keys behind;
 * the next run clears them first (offset 0) and starts clean.
 */
async function rebuildFull(
  kv: KVNamespace,
  offset: number,
): Promise<{
  mode: string;
  done: boolean;
  offset: number;
  nextOffset: number | null;
  total: number;
  days?: string[];
  sessions?: number;
  statsAggregates?: boolean;
}> {
  if (offset === 0) {
    const stale = await listAllKeys(kv, SESSION_BUNDLE_STAGING_PREFIX, 400);
    for (const k of stale) await deleteKey(kv, k);
  }
  const keys = await listSessionKeys(kv);
  const slice = await loadSessionSlice(kv, keys, offset);
  const byDay = new Map<string, BundledSession[]>();
  for (const { sid, s } of slice.sessions) {
    const day = dayKey(s.startedAt);
    const list = byDay.get(day) || [];
    list.push({ sid, ...s });
    byDay.set(day, list);
  }
  for (const day of [...byDay.keys()].sort()) {
    const existing = await getJson<SessionBundle>(kv, stagingKey(day));
    await putJson(kv, stagingKey(day), upsertInto(existing, day, byDay.get(day) || []));
  }
  const nextOffset = slice.nextOffset;
  if (nextOffset !== null) {
    return { mode: "full", done: false, offset, nextOffset, total: keys.length };
  }

  // Final slice: swap staging into live, then drop live bundles for
  // days that no longer hold any session.
  const stagingKeys = await listAllKeys(kv, SESSION_BUNDLE_STAGING_PREFIX, 400);
  const builtAt = Date.now();
  const days: string[] = [];
  for (const k of stagingKeys.sort()) {
    const day = k.slice(SESSION_BUNDLE_STAGING_PREFIX.length);
    const staged = await getJson<SessionBundle>(kv, k);
    if (!staged || !Array.isArray(staged.sessions)) continue;
    await putJson(kv, bundleKey(day), { day, builtAt, sessions: staged.sessions });
    await deleteKey(kv, k);
    await putJson(kv, SESSION_DAY_PREFIX + day, "1", SESSION_DAY_TTL_SECONDS);
    days.push(day);
  }
  const liveKeys = await listAllKeys(kv, SESSION_BUNDLE_PREFIX, 400);
  for (const k of liveKeys) {
    const day = k.slice(SESSION_BUNDLE_PREFIX.length);
    if (!days.includes(day)) await deleteKey(kv, k);
  }
  // Prune day entries for days with no sessions left, so the loader
  // never demands a bundle for a day whose sessions all expired.
  const dayKeys = await listAllKeys(kv, SESSION_DAY_PREFIX, 400);
  for (const k of dayKeys) {
    const day = k.slice(SESSION_DAY_PREFIX.length);
    if (!days.includes(day)) await deleteKey(kv, k);
  }
  return {
    mode: "full",
    done: true,
    offset,
    nextOffset: null,
    total: keys.length,
    days: days.sort(),
    sessions: keys.length,
    statsAggregates: await refreshStatsAggregates(kv),
  };
}

/** One charts slice: 850 leads + 100 forms, mirroring the panel's loop. */
const CHARTS_LEAD_SLICE = 850;
const CHARTS_FORM_SLICE = 100;
/** Fixed ranges keep the live handler's cap: newest 1,000 leads / first 1,000 forms. */
const CHARTS_FIXED_CAP = 1000;

interface ChartsStaging {
  builtAt: number;
  ranges: Partial<Record<RangeName, ChartsAggregate>>;
  lastLeadOffset: number;
  lastFormOffset: number;
  nextLeadOffset: number | null;
  nextFormOffset: number | null;
  leadsTotal: number;
  formsTotal: number;
}

/**
 * Charts rebuild (daily, sliced): one call processes one lead slice
 * (850) and one form slice (100), aggregating them per range and
 * merging the partials into the staging key. The caller loops
 * leadOffset/formOffset from the returned next offsets until done is
 * true, when the merged aggregates are written to the live
 * `charts:agg:<range>` keys. The "all" range covers every record;
 * the fixed ranges keep the live handler's 1,000 cap (newest 1,000
 * leads, first 1,000 forms in list order), so a precomputed aggregate
 * matches the live response exactly. A call that replays the offsets
 * of the last merged call — a retry after a lost response — returns
 * the same next offsets without merging twice; staging is cleared by
 * the next run that starts at (0, 0).
 */
async function rebuildCharts(
  kv: KVNamespace,
  leadOffset: number,
  formOffset: number,
): Promise<{
  mode: string;
  done: boolean;
  leadOffset: number;
  formOffset: number;
  nextLeadOffset: number | null;
  nextFormOffset: number | null;
  leadsTotal: number;
  formsTotal: number;
  builtAt?: number;
}> {
  if (leadOffset === 0 && formOffset === 0) {
    await deleteKey(kv, CHARTS_AGG_STAGING_KEY);
  }
  const leadsIndex = await getJson<string[]>(kv, LEADS_INDEX_KEY);
  const allLeadKeys =
    Array.isArray(leadsIndex) && leadsIndex.length > 0
      ? leadsIndex
      : await listAllKeys(kv, "lead:", 5000);
  const leadsTotal = allLeadKeys.length;
  const allFormKeys = await listAllKeys(kv, "form:", 5000);
  const formsTotal = allFormKeys.length;

  const nextLeadOffset =
    leadOffset + CHARTS_LEAD_SLICE < leadsTotal ? leadOffset + CHARTS_LEAD_SLICE : null;
  const nextFormOffset =
    formOffset + CHARTS_FORM_SLICE < formsTotal ? formOffset + CHARTS_FORM_SLICE : null;

  const rawStaging = await getJson<ChartsStaging>(kv, CHARTS_AGG_STAGING_KEY);
  const staging =
    rawStaging && typeof rawStaging === "object" && rawStaging.ranges ? rawStaging : null;
  if (
    staging &&
    staging.lastLeadOffset === leadOffset &&
    staging.lastFormOffset === formOffset
  ) {
    const done = staging.nextLeadOffset === null && staging.nextFormOffset === null;
    return {
      mode: "charts",
      done,
      leadOffset,
      formOffset,
      nextLeadOffset: staging.nextLeadOffset,
      nextFormOffset: staging.nextFormOffset,
      leadsTotal,
      formsTotal,
      ...(done ? { builtAt: staging.builtAt } : {}),
    };
  }

  const leadKeys = allLeadKeys.slice(leadOffset, leadOffset + CHARTS_LEAD_SLICE);
  const formKeys = allFormKeys.slice(formOffset, formOffset + CHARTS_FORM_SLICE);
  const leadRecs = await batch(leadKeys, 50, (k) => getJson<Lead>(kv, k));
  const formRecs = await batch(formKeys, 25, (k) =>
    getJson<{ form?: string; at?: number }>(kv, k),
  );
  const today = dayKey();
  const totals = { leadsTotal, formsTotal };
  // Rank within the store, for the fixed-range cap (live parity).
  const fixedLeadRecs = leadRecs.filter((_, i) => leadOffset + i < CHARTS_FIXED_CAP);
  const fixedFormRecs = formRecs.filter((_, i) => formOffset + i < CHARTS_FIXED_CAP);
  const ranges: Partial<Record<RangeName, ChartsAggregate>> = { ...(staging?.ranges || {}) };
  for (const range of AGG_RANGES) {
    const partial =
      range === "all"
        ? aggregateCharts(formRecs, leadRecs, range, today, totals)
        : aggregateCharts(fixedFormRecs, fixedLeadRecs, range, today, totals);
    ranges[range] = ranges[range] ? mergeChartsAggregates(ranges[range], partial) : partial;
  }
  const builtAt = Date.now();
  const done = nextLeadOffset === null && nextFormOffset === null;
  await putJson(kv, CHARTS_AGG_STAGING_KEY, {
    builtAt,
    ranges,
    lastLeadOffset: leadOffset,
    lastFormOffset: formOffset,
    nextLeadOffset,
    nextFormOffset,
    leadsTotal,
    formsTotal,
  });
  if (done) {
    for (const range of AGG_RANGES) {
      const agg = ranges[range];
      if (!agg) continue;
      await putJson(kv, chartsAggregateKey(range), {
        ...agg,
        leadsNextOffset: null,
        formsNextOffset: null,
        source: "precomputed",
        builtAt,
      });
    }
  }
  return {
    mode: "charts",
    done,
    leadOffset,
    formOffset,
    nextLeadOffset,
    nextFormOffset,
    leadsTotal,
    formsTotal,
    ...(done ? { builtAt } : {}),
  };
}

/**
 * POST /api/internal/session-bundles/rebuild — same shared-secret gate
 * as the other internal sweeps (INTERNAL_CRON_SECRET). Body
 * `{ mode?: "incremental" | "full" | "charts", offset?: number,
 *    leadOffset?: number, formOffset?: number }`:
 * - incremental is the daily run (freshens the bundles from the last
 *   3 days of active markers, then recomputes the stats aggregates);
 * - full is the weekly run (rebuilds every bundle from the session
 *   records, sliced — call with offset 0, then with each returned
 *   nextOffset until done is true — then recomputes the stats
 *   aggregates);
 * - charts rebuilds the charts aggregates from the lead/form stores,
 *   sliced — call with leadOffset 0 and formOffset 0, then with each
 *   returned nextLeadOffset/nextFormOffset until done is true.
 * Answers the rebuild stats; a failed bundle write surfaces as a 500
 * instead of a silent partial rebuild, so the cron run visibly fails
 * and retries next time.
 */
export async function handleSessionBundlesRebuild(
  req: Request,
  env: Env,
): Promise<Response> {
  if (!env.INTERNAL_CRON_SECRET) return err("Session bundles are not configured", 503);
  const auth = req.headers.get("authorization") || "";
  if (!timingSafeEqual(auth, "Bearer " + env.INTERNAL_CRON_SECRET)) {
    return err("Unauthorized", 401);
  }
  let body: RebuildBody = {};
  try {
    body = (await readJson(req)) as RebuildBody;
  } catch {
    /* empty body is fine: incremental from offset 0 */
  }
  const mode = body.mode === "full" ? "full" : body.mode === "charts" ? "charts" : "incremental";
  const rawOffset = typeof body.offset === "number" ? Math.floor(body.offset) : 0;
  const offset = Math.max(isNaN(rawOffset) ? 0 : rawOffset, 0);
  const kv = env.WEBAO_KV;
  if (mode === "incremental") {
    return json({ ok: true, ...(await rebuildIncremental(kv)) });
  }
  if (mode === "charts") {
    const rawLead = typeof body.leadOffset === "number" ? Math.floor(body.leadOffset) : 0;
    const rawForm = typeof body.formOffset === "number" ? Math.floor(body.formOffset) : 0;
    return json({
      ok: true,
      ...(await rebuildCharts(
        kv,
        Math.max(isNaN(rawLead) ? 0 : rawLead, 0),
        Math.max(isNaN(rawForm) ? 0 : rawForm, 0),
      )),
    });
  }
  return json({ ok: true, ...(await rebuildFull(kv, offset)) });
}
