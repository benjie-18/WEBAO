// Outreach lead tracking: who was emailed, who clicked, who replied.
//
// Flow: the sender (daily outreach job, or a manual send) first registers the
// lead with POST /api/leads/register, which returns per-lead tracked links of
// the form https://webao.ca/go/<id>?d=<dest>. The /go/ route logs the click
// to KV and 302-redirects to the real page, so a click is a first-party event
// in the admin panel, not a third-party tracker stat. Replies are matched
// back with POST /api/leads/reply (by lead id, else by sender email) by
// whatever reads the WEBAO inbox, e.g. the daily inbox report job.
//
// Records live in KV as lead:<id>; the admin lists them by the "lead:"
// prefix (newest first by sentAt, capped at 5000). No index key is kept:
// rewriting one on every register cost a KV write per send. Lead ids are 24
// random hex chars minted by the sender (or here, when omitted), so a
// tracked link is unguessable and only the recipient and the sender know it.
//
// Ingest posture matches /api/forms/submit (same-origin gate + the edge
// rate-limit rule on /api/leads/*, /go/*, /api/forms/* and
// /api/checkout/*). When the LEADS_INGEST_KEY secret is set on the worker, register
// and reply additionally require it in the x-ingest-key header; set the same
// key on the sender side to harden the endpoints.

import { getJson, putJson, deleteKey, listAllKeys } from "./kv";
import {
  clientCountry,
  clampStr,
  readJson,
  json,
  err,
  originAllowed,
  randomHex,
  timingSafeEqual,
  batch,
  EMAIL_RE,
} from "./util";

const MAX_LISTED = 5000;
const MAX_CLICKS = 100;
const MAX_REPLIES = 50;

export type LeadDest = "demos" | "home" | "pricing" | "start";
const DEST_PATHS: Record<LeadDest, string> = {
  demos: "/demos",
  home: "/",
  pricing: "/pricing",
  start: "/start",
};

export interface LeadClick {
  at: number;
  dest: LeadDest;
  country: string;
  /** True when the user agent looks like a mail scanner / link unfurler. */
  suspect: boolean;
}

export type LeadReplyKind = "reply" | "optout" | "bounce";

export interface LeadReply {
  at: number;
  kind: LeadReplyKind;
  from?: string;
  subject?: string;
}

export interface Lead {
  id: string;
  business: string;
  email: string;
  city?: string;
  trade?: string;
  subject?: string;
  lang?: string;
  source?: string;
  sentAt: number;
  clicks: LeadClick[];
  replies: LeadReply[];
  /** Human (non-suspect) click count; suspect clicks stay in `clicks` only. */
  clickCount: number;
  firstClickAt?: number;
  lastClickAt?: number;
  repliedAt?: number;
  optOutAt?: number;
  bouncedAt?: number;
}

const LEAD_ID_RE = /^ld_[a-f0-9]{24}$/;

/** User-agent fragments that mean "a machine fetched this link, not a human". */
const SCANNER_UA =
  /bot|crawler|spider|scanner|preview|headless|safelinks|urldefense|proofpoint|mimecast|barracuda|facebookexternalhit|slackbot|telegrambot|whatsapp|skypeuripreview|googleimageproxy/i;

function isDest(v: string | null): v is LeadDest {
  return v === "demos" || v === "home" || v === "pricing" || v === "start";
}

/**
 * Shared ingest gate for register/reply. Returns a Response to send back when
 * the request is denied, or null when it may proceed.
 */
async function ingestGate(req: Request, env: Env): Promise<Response | null> {
  const ingestKey = env.LEADS_INGEST_KEY;
  if (ingestKey) {
    const given = req.headers.get("x-ingest-key") || "";
    if (!timingSafeEqual(given, ingestKey)) return err("Unauthorized", 401);
  } else if (!originAllowed(req, true, env)) {
    return err("Forbidden origin", 403);
  }
  // No in-worker throttle here: every throttle check is a KV write, and
  // register/reply are hit on every outreach send. The edge rate-limit
  // rule ("WEBAO track rate limit") covers /api/leads/* at 20 requests
  // per 10 s per IP, which is the per-IP cap for these endpoints.
  return null;
}

function trackedLinks(origin: string, id: string): Record<LeadDest, string> {
  return {
    demos: `${origin}/go/${id}?d=demos`,
    home: `${origin}/go/${id}?d=home`,
    pricing: `${origin}/go/${id}?d=pricing`,
    start: `${origin}/go/${id}?d=start`,
  };
}

interface RegisterBody {
  id?: unknown;
  business?: unknown;
  email?: unknown;
  city?: unknown;
  trade?: unknown;
  subject?: unknown;
  lang?: unknown;
  source?: unknown;
  sentAt?: unknown;
}

/** POST /api/leads/register — record a sent outreach email, mint its links. */
export async function handleLeadRegister(req: Request, env: Env): Promise<Response> {
  const denied = await ingestGate(req, env);
  if (denied) return denied;
  const kv = env.WEBAO_KV;

  let body: RegisterBody;
  try {
    body = (await readJson(req)) as RegisterBody;
  } catch (e) {
    return err((e as Error).message);
  }

  const business = clampStr(body.business, 120).trim();
  if (!business) return err("Business is required");
  const email = clampStr(body.email, 160).trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return err("Valid email is required");

  let id = clampStr(body.id, 40);
  if (id && !LEAD_ID_RE.test(id)) return err("Invalid id");
  if (!id) id = "ld_" + randomHex(12);

  const origin = new URL(req.url).origin;
  const links = trackedLinks(origin, id);
  const replyTo = `contact+${id}@webao.ca`;

  // Idempotent: re-registering the same id (a retried send job) returns the
  // existing record's links without touching its click/reply history.
  const existing = await getJson<Lead>(kv, "lead:" + id);
  if (existing) return json({ ok: true, id, links, replyTo, existing: true });

  const sentAt =
    typeof body.sentAt === "number" && body.sentAt > 0 ? Math.floor(body.sentAt) : Date.now();
  const lead: Lead = {
    id,
    business,
    email,
    city: clampStr(body.city, 80).trim() || undefined,
    trade: clampStr(body.trade, 80).trim() || undefined,
    subject: clampStr(body.subject, 200).trim() || undefined,
    lang: clampStr(body.lang, 8).trim() || undefined,
    source: clampStr(body.source, 40).trim() || undefined,
    sentAt,
    clicks: [],
    replies: [],
    clickCount: 0,
  };
  const key = "lead:" + id;
  await putJson(kv, key, lead);

  // No index key: the admin Leads tab lists records by the "lead:"
  // prefix instead, so registering a send costs exactly one write.
  // (The old leads:index key is an inert leftover.)
  return json({ ok: true, id, links, replyTo });
}

/** GET /go/:id?d=<dest> — log the click, then redirect to the real page. */
export async function handleGo(req: Request, env: Env, url: URL): Promise<Response> {
  const dest: LeadDest = isDest(url.searchParams.get("d")) ? (url.searchParams.get("d") as LeadDest) : "demos";
  const target = new URL(DEST_PATHS[dest], url.origin).toString();
  const redirect = (): Response =>
    new Response(null, {
      status: 302,
      headers: { location: target, "cache-control": "private, no-store" },
    });

  const m = /^\/go\/(ld_[a-f0-9]{24})\/?$/.exec(url.pathname);
  if (!m) return redirect();

  // Logging is best-effort: a KV problem must never break a link that is
  // already sitting in someone's inbox. No in-worker throttle here:
  // every throttle check is a KV write, doubling the cost of a click.
  // The edge rate-limit rule ("WEBAO track rate limit") covers /go/*
  // at 20 requests per 10 s per IP, which is the per-IP cap here.
  try {
    const kv = env.WEBAO_KV;
    const key = "lead:" + m[1];
    const lead = await getJson<Lead>(kv, key);
    if (!lead) return redirect();

    const ua = req.headers.get("user-agent") || "";
    const suspect = ua.length === 0 || SCANNER_UA.test(ua);
    const now = Date.now();
    lead.clicks.push({ at: now, dest, country: clientCountry(req), suspect });
    if (lead.clicks.length > MAX_CLICKS) lead.clicks = lead.clicks.slice(-MAX_CLICKS);
    if (!suspect) {
      lead.clickCount += 1;
      if (!lead.firstClickAt) lead.firstClickAt = now;
      lead.lastClickAt = now;
    }
    await putJson(kv, key, lead);
  } catch (e) {
    console.error("go: click logging failed", (e as Error)?.message);
  }
  return redirect();
}

interface ReplyBody {
  leadId?: unknown;
  email?: unknown;
  from?: unknown;
  kind?: unknown;
  subject?: unknown;
  at?: unknown;
}

/** POST /api/leads/reply — match an inbox reply/opt-out/bounce to its lead. */
export async function handleLeadReply(req: Request, env: Env): Promise<Response> {
  const denied = await ingestGate(req, env);
  if (denied) return denied;
  const kv = env.WEBAO_KV;

  let body: ReplyBody;
  try {
    body = (await readJson(req)) as ReplyBody;
  } catch (e) {
    return err((e as Error).message);
  }

  const kind: LeadReplyKind =
    body.kind === "optout" || body.kind === "bounce" ? body.kind : "reply";
  const at = typeof body.at === "number" && body.at > 0 ? Math.floor(body.at) : Date.now();

  // Resolve the lead: exact id first (from the plus-addressed Reply-To or the
  // sender's own ledger), else the newest lead sent to that email address.
  let lead: Lead | null = null;
  const leadId = clampStr(body.leadId, 40);
  if (leadId && LEAD_ID_RE.test(leadId)) lead = await getJson<Lead>(kv, "lead:" + leadId);
  if (!lead) {
    const email = clampStr(body.email || body.from, 160).trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return err("leadId or a valid email is required");
    // No index key: list the lead: records (newest first) and match by email.
    const keys = await listAllKeys(kv, "lead:", MAX_LISTED);
    const records = await batch(keys, 25, (k) => getJson<Lead>(kv, k));
    records.sort((a, b) => (b?.sentAt || 0) - (a?.sentAt || 0));
    lead = records.find((r): r is Lead => !!r && r.email === email) || null;
  }
  if (!lead) return json({ ok: true, matched: false });

  lead.replies.push({
    at,
    kind,
    from: clampStr(body.from || body.email, 160).trim() || undefined,
    subject: clampStr(body.subject, 200).trim() || undefined,
  });
  if (lead.replies.length > MAX_REPLIES) lead.replies = lead.replies.slice(-MAX_REPLIES);
  if (kind === "reply" && !lead.repliedAt) lead.repliedAt = at;
  if (kind === "optout" && !lead.optOutAt) lead.optOutAt = at;
  if (kind === "bounce" && !lead.bouncedAt) lead.bouncedAt = at;
  await putJson(kv, "lead:" + lead.id, lead);

  return json({ ok: true, matched: true, id: lead.id, kind });
}

// ---------------------------------------------------------------------------
// Admin (called from admin.ts, after its Bearer auth)
// ---------------------------------------------------------------------------

/** GET /api/admin/leads?limit=50&cursor= — newest-first, cursor-paginated. */
export async function handleLeadsList(kv: KVNamespace, url: URL): Promise<Response> {
  const rawLimit = parseInt(url.searchParams.get("limit") || "50", 10);
  const limit = Math.min(Math.max(isNaN(rawLimit) ? 50 : rawLimit, 1), 100);
  const rawCursor = parseInt(url.searchParams.get("cursor") || "0", 10);
  const cursor = Math.max(isNaN(rawCursor) ? 0 : rawCursor, 0);

  // No index key: list the lead: records and sort newest-first by sentAt
  // (lead ids are random hex, so key order is not chronological).
  const keys = await listAllKeys(kv, "lead:", MAX_LISTED);
  const records = (
    await batch(keys, 25, async (key) => {
      const rec = await getJson<Lead>(kv, key);
      return rec ? { ...rec } : null;
    })
  ).filter((x): x is Lead => x !== null);
  records.sort(
    (a, b) => (b.sentAt || 0) - (a.sentAt || 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const items = records.slice(cursor, cursor + limit);

  return json({
    ok: true,
    items,
    nextCursor: cursor + limit < records.length ? String(cursor + limit) : null,
  });
}

/** DELETE /api/admin/leads/:id — id is the "ld_…" part after "lead:". */
export async function handleLeadDelete(kv: KVNamespace, path: string): Promise<Response> {
  const m = /^\/api\/admin\/leads\/([^/]+)$/.exec(path);
  if (!m) return err("Invalid id", 400);
  let id: string;
  try {
    id = decodeURIComponent(m[1]);
  } catch {
    return err("Invalid id", 400);
  }
  if (!LEAD_ID_RE.test(id)) return err("Invalid id", 400);
  const key = "lead:" + id;
  await deleteKey(kv, key);
  return json({ ok: true });
}
