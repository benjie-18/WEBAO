// Visitor tracking: pageviews, clicks, heartbeats.
// Sessions live 365 days in KV; the admin stats endpoint derives views
// from the sessions themselves (path + timestamp per page).

import { getJson, putJson } from "./kv";
import { getSettings } from "./auth";
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
} from "./util";

const SESSION_TTL = 365 * 24 * 3600; // 365 days, in seconds
const MAX_PAGES = 100; // cap stored page visits per session
const MAX_CLICKS = 200; // cap stored click events per session
// Only final heartbeats arrive now (the client sends one on hide /
// close / navigation, never periodically): each carries the total
// time on the page since the pageview, and the server keeps the
// largest value, so time-on-page stays exact with one write per
// visit. The client dedupes its own final beats (hide + pagehide
// can both fire for one close); the coalesce window below is kept
// for non-final beats and still lets every final beat persist.
const HEARTBEAT_COALESCE_MS = 300_000; // 5 min

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

/**
 * Shared gate for pageview/click/heartbeat: same-origin only, no
 * rate-limit write. Every throttle check is a KV write, and these
 * endpoints are hit on every pageview and click — throttling them
 * burned the daily KV write budget (1,000/day on the free plan).
 * Rate limiting lives at the edge (the Cloudflare rate-limit rule
 * "WEBAO track rate limit" on /api/track/*, 20 requests per 10 s
 * per IP); the in-worker KV throttle was removed so a tracking call
 * costs no write of its own. Note the trade-off: a pageview still
 * mints a session for any valid-format sid, so a determined flood
 * could burn session writes — the edge rule is the per-IP cap that
 * keeps that in check. The heartbeat cannot mint a write on its own
 * (unknown session 404s), and the session id is an unguessable uuid,
 * so a blind flood of heartbeats costs reads only (100k/day) and
 * writes nothing.
 */
function originGate(req: Request, env: Env): Response | null {
  if (!originAllowed(req, true, env)) return err("Forbidden origin", 403);
  return null;
}

interface PageviewBody {
  sid?: unknown;
  path?: unknown;
  referrer?: unknown;
  screen?: unknown;
  locale?: unknown;
  theme?: unknown;
  /** Page just left (client-router nav): its final time-on-page rides along. */
  prevPath?: unknown;
  prevDurationMs?: unknown;
  /** Clicks buffered since the last flush; ride along, no extra write. */
  clicks?: unknown;
}

/** Append buffered click events (from a pageview or heartbeat flush). */
function appendClicks(s: Session, raw: unknown): void {
  if (!Array.isArray(raw)) return;
  for (const c of raw) {
    if (!c || typeof c !== "object") continue;
    const path = sanitizePath((c as { path?: unknown }).path);
    if (!path) continue;
    const at =
      typeof (c as { at?: unknown }).at === "number"
        ? Math.floor((c as { at: number }).at)
        : Date.now();
    s.clicks.push({
      path,
      kind: clampStr((c as { kind?: unknown }).kind, 32) || "click",
      label: clampStr((c as { label?: unknown }).label, 120),
      at,
    });
  }
  if (s.clicks.length > MAX_CLICKS) s.clicks = s.clicks.slice(-MAX_CLICKS);
}

/** POST /api/track/pageview — create/touch a session, count the view. */
export async function handlePageview(req: Request, env: Env): Promise<Response> {
  const kv = env.WEBAO_KV;
  const denied = originGate(req, env);
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
  // Piggybacked from the page just left (client-router navigation):
  // record its final time-on-page, and flush any clicks buffered
  // since the last write. All of it rides on this pageview's single
  // session rewrite — no extra write.
  if (typeof body.prevPath === "string" && typeof body.prevDurationMs === "number") {
    const prevPath = sanitizePath(body.prevPath);
    const prevMs = Math.min(Math.max(Math.floor(body.prevDurationMs), 0), 24 * 3600 * 1000);
    if (prevPath) {
      for (let i = s.pages.length - 1; i >= 0; i--) {
        if (s.pages[i].path === prevPath) {
          s.pages[i].durationMs = Math.max(s.pages[i].durationMs, prevMs);
          break;
        }
      }
    }
  }
  appendClicks(s, body.clicks);
  s.pages.push({
    path,
    at: now,
    durationMs: 0,
    referrer: clampStr(body.referrer, 300) || undefined,
  });
  if (s.pages.length > MAX_PAGES) s.pages = s.pages.slice(-MAX_PAGES);
  await putJson(kv, key, s, SESSION_TTL);

  // No per-path counter write: the admin stats endpoint derives views
  // from the sessions themselves (each page carries its path and
  // timestamp), so a pageview costs exactly one write — the session
  // rewrite above. The old views:<day>:<path> keys are inert leftovers;
  // deleting them would cost a write per key, so they stay until they
  // are cleaned up out of band, if ever.
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
  const denied = originGate(req, env);
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
  /** Clicks buffered since the last flush; ride along, no extra write. */
  clicks?: unknown;
}

/** POST /api/track/heartbeat — record time spent on the current page. */
export async function handleHeartbeat(req: Request, env: Env): Promise<Response> {
  const kv = env.WEBAO_KV;
  const denied = originGate(req, env);
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
  // Coalesce periodic heartbeats: a write every few minutes per open tab
  // burns the KV daily write budget fast (1,000 writes/day on the free
  // plan). Persist at most once per HEARTBEAT_COALESCE_MS; the final
  // heartbeat (pagehide / tab hidden) always persists so durations stay exact.
  // A beat carrying flushed clicks always persists — dropping it would
  // lose the clicks the client already cleared from its buffer.
  const isFinal = body.final === true;
  const hasClicks = Array.isArray(body.clicks) && body.clicks.length > 0;
  if (!isFinal && !hasClicks && now - s.lastSeenAt < HEARTBEAT_COALESCE_MS)
    return json({ ok: true });

  // Update the most recent visit of this path (monotonic — never shrink).
  for (let i = s.pages.length - 1; i >= 0; i--) {
    if (s.pages[i].path === path) {
      s.pages[i].durationMs = Math.max(s.pages[i].durationMs, durationMs);
      break;
    }
  }
  appendClicks(s, body.clicks);
  s.lastSeenAt = now;
  await putJson(kv, key, s, SESSION_TTL);
  return json({ ok: true });
}
