// Visitor tracking: pageviews, clicks, heartbeats.
// Sessions live 90 days in KV; per-day pageview counters aggregate into stats.

import { getJson, putJson, incrCounter } from "./kv";
import { getSettings, throttle } from "./auth";
import {
  clientIp,
  clientCountry,
  clientCity,
  parseUserAgent,
  sanitizePath,
  clampStr,
  readJson,
  json,
  err,
  originAllowed,
  dayKey,
} from "./util";

const SESSION_TTL = 90 * 24 * 3600; // 90 days, in seconds
const MAX_PAGES = 100; // cap stored page visits per session
const MAX_CLICKS = 200; // cap stored click events per session

export interface PageVisit {
  path: string;
  at: number;
  durationMs: number;
  referrer?: string;
}

export interface ClickEvent {
  path: string;
  kind: string;
  label: string;
  at: number;
}

export interface Session {
  ip: string;
  country: string;
  city?: string;
  ua: string;
  device: "mobile" | "tablet" | "desktop";
  browser: string;
  startedAt: number;
  lastSeenAt: number;
  locale?: string;
  theme?: string;
  pages: PageVisit[];
  clicks: ClickEvent[];
}

function validSid(sid: unknown): sid is string {
  return typeof sid === "string" && /^[A-Za-z0-9-]{8,64}$/.test(sid);
}

/** Shared gate: same-origin + 120 req/min per IP. */
async function gate(req: Request, env: Env): Promise<Response | null> {
  if (!originAllowed(req, true, env)) return err("Forbidden origin", 403);
  if (!(await throttle(env.WEBAO_KV, "track", clientIp(req), 120))) return err("Rate limited", 429);
  return null;
}

interface PageviewBody {
  sid?: unknown;
  path?: unknown;
  referrer?: unknown;
  screen?: unknown;
  locale?: unknown;
  theme?: unknown;
}

/** POST /api/track/pageview — create/touch a session, count the view. */
export async function handlePageview(req: Request, env: Env): Promise<Response> {
  const kv = env.WEBAO_KV;
  const denied = await gate(req, env);
  if (denied) return denied;

  let body: PageviewBody;
  try {
    body = (await readJson(req)) as PageviewBody;
  } catch (e) {
    return err((e as Error).message);
  }
  if (!validSid(body.sid)) return err("Invalid sid");
  const path = sanitizePath(body.path);
  if (!path) return err("Invalid path");

  // Admin can pause tracking entirely from the config tab.
  if (!(await getSettings(kv)).trackingEnabled) return json({ ok: true, tracking: false });

  const now = Date.now();
  const ua = req.headers.get("user-agent") || "";
  const key = "session:" + body.sid;
  let s = await getJson<Session>(kv, key);
  if (!s) {
    const { device, browser } = parseUserAgent(ua);
    s = {
      ip: clientIp(req),
      country: clientCountry(req),
      city: clientCity(req),
      ua: ua.slice(0, 300),
      device,
      browser,
      startedAt: now,
      lastSeenAt: now,
      locale: clampStr(body.locale, 8) || undefined,
      theme: clampStr(body.theme, 8) || undefined,
      pages: [],
      clicks: [],
    };
  }
  s.lastSeenAt = now;
  if (body.locale) s.locale = clampStr(body.locale, 8);
  if (body.theme) s.theme = clampStr(body.theme, 8);
  s.pages.push({
    path,
    at: now,
    durationMs: 0,
    referrer: clampStr(body.referrer, 300) || undefined,
  });
  if (s.pages.length > MAX_PAGES) s.pages = s.pages.slice(-MAX_PAGES);
  await putJson(kv, key, s, SESSION_TTL);

  // Per-day counters; the stats endpoint aggregates these for week/month/year.
  const day = dayKey(now);
  const enc = encodeURIComponent(path);
  await incrCounter(kv, `views:${day}:${enc}`);
  await incrCounter(kv, `views:${day}:__all`);

  return json({ ok: true });
}

interface ClickBody {
  sid?: unknown;
  path?: unknown;
  kind?: unknown;
  label?: unknown;
}

/** POST /api/track/click — append a click event to the session. */
export async function handleClick(req: Request, env: Env): Promise<Response> {
  const kv = env.WEBAO_KV;
  const denied = await gate(req, env);
  if (denied) return denied;

  let body: ClickBody;
  try {
    body = (await readJson(req)) as ClickBody;
  } catch (e) {
    return err((e as Error).message);
  }
  if (!validSid(body.sid)) return err("Invalid sid");
  const path = sanitizePath(body.path);
  if (!path) return err("Invalid path");
  if (!(await getSettings(kv)).trackingEnabled) return json({ ok: true, tracking: false });

  const key = "session:" + body.sid;
  const s = await getJson<Session>(kv, key);
  if (!s) return err("Unknown session", 404);

  s.lastSeenAt = Date.now();
  s.clicks.push({
    path,
    kind: clampStr(body.kind, 32) || "click",
    label: clampStr(body.label, 120),
    at: Date.now(),
  });
  if (s.clicks.length > MAX_CLICKS) s.clicks = s.clicks.slice(-MAX_CLICKS);
  await putJson(kv, key, s, SESSION_TTL);
  return json({ ok: true });
}

interface HeartbeatBody {
  sid?: unknown;
  path?: unknown;
  durationMs?: unknown;
  /** True for the final heartbeat (pagehide / tab hidden / navigation away). */
  final?: unknown;
}

/** POST /api/track/heartbeat — record time spent on the current page. */
export async function handleHeartbeat(req: Request, env: Env): Promise<Response> {
  const kv = env.WEBAO_KV;
  const denied = await gate(req, env);
  if (denied) return denied;

  let body: HeartbeatBody;
  try {
    body = (await readJson(req)) as HeartbeatBody;
  } catch (e) {
    return err((e as Error).message);
  }
  if (!validSid(body.sid)) return err("Invalid sid");
  const path = sanitizePath(body.path);
  if (!path) return err("Invalid path");
  const durationMs =
    typeof body.durationMs === "number" && body.durationMs >= 0
      ? Math.min(Math.floor(body.durationMs), 24 * 3600 * 1000)
      : 0;
  if (!(await getSettings(kv)).trackingEnabled) return json({ ok: true, tracking: false });

  const key = "session:" + body.sid;
  const s = await getJson<Session>(kv, key);
  if (!s) return err("Unknown session", 404);

  const now = Date.now();
  // Coalesce periodic heartbeats: a write every minute per open tab burns the
  // KV daily write budget fast. Persist at most once per 2 minutes; the final
  // heartbeat (pagehide / tab hidden) always persists so durations stay exact.
  const isFinal = body.final === true;
  if (!isFinal && now - s.lastSeenAt < 120_000) return json({ ok: true });

  // Update the most recent visit of this path (monotonic — never shrink).
  for (let i = s.pages.length - 1; i >= 0; i--) {
    if (s.pages[i].path === path) {
      s.pages[i].durationMs = Math.max(s.pages[i].durationMs, durationMs);
      break;
    }
  }
  s.lastSeenAt = now;
  await putJson(kv, key, s, SESSION_TTL);
  return json({ ok: true });
}
