// Public form submissions (pricing + contact + support).
// Stored as form:<ts>:<rand> with a newest-first index capped at 1000 entries.
// Support and contact submissions also send a best-effort email copy to the
// WEBAO inbox via the send_email binding; the KV record stays the source of truth.

import { getJson, putJson, deleteKey } from "./kv";
import { clientIp, clientCountry, readJson, json, err, originAllowed, uuid } from "./util";

const INDEX_KEY = "forms:index";
const MAX_INDEX = 1000;

export interface FormSubmission {
  form: "pricing" | "contact" | "support";
  fields: Record<string, string>;
  ip: string;
  country: string;
  ua: string;
  at: number;
}

const SUPPORT_CATEGORIES: Record<string, string> = {
  billing: "Billing",
  changes: "Changes to my site",
  addons: "Add a feature or add-on",
  issue: "Something isn't working",
  other: "Other",
};

const NOTIFY_INBOX = "webao.ca@gmail.com";

/** Strip CR/LF so a field can never inject extra MIME headers. */
function headerSafe(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function base64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Plain-ASCII headers pass through; anything else is RFC 2047 encoded. */
function encodeHeader(value: string): string {
  const safe = headerSafe(value);
  if (/^[\x20-\x7e]*$/.test(safe)) return safe;
  return `=?UTF-8?B?${base64Utf8(safe)}?=`;
}

/** The email copy for a stored submission, or null for forms without one. */
function notifySpec(submission: FormSubmission): { from: string; fromName: string; subject: string; body: string } | null {
  const f = submission.fields;
  const name = (f.name || "").trim();
  const email = (f.email || "").trim();
  const page = (f.page || "").trim();
  const message = (f.message || "").trim();
  if (submission.form === "support") {
    const category = SUPPORT_CATEGORIES[(f.category || "").trim()] || "Other";
    return {
      from: "support@webao.ca",
      fromName: "WEBAO Support",
      subject: `[Support · ${category}] ${(f.subject || "").trim()}`,
      body: [
        "New support request from the website form.",
        "",
        `Category: ${category}`,
        `From: ${name} <${email}>`,
        `Page: ${page}`,
        "",
        message,
      ].join("\n"),
    };
  }
  if (submission.form === "contact") {
    return {
      from: "contact@webao.ca",
      fromName: "WEBAO Contact",
      subject: `[Contact] Message from ${name}`,
      body: [
        "New contact message from the website form.",
        "",
        `From: ${name} <${email}>`,
        `Page: ${page}`,
        "",
        message,
      ].join("\n"),
    };
  }
  return null;
}

/**
 * Best-effort email copy of a support or contact submission, via the
 * send_email binding (its destination is pinned to the WEBAO inbox in
 * wrangler.jsonc). A mail failure is logged, never surfaced to the visitor,
 * and never fails the submission — the admin panel record is what counts.
 */
async function notifyByEmail(env: Env, submission: FormSubmission): Promise<void> {
  if (!env.EMAIL) return;
  const spec = notifySpec(submission);
  if (!spec) return;
  try {
    const raw = [
      `From: "${spec.fromName}" <${spec.from}>`,
      `To: ${NOTIFY_INBOX}`,
      `Reply-To: ${headerSafe((submission.fields.email || "").trim())}`,
      `Subject: ${encodeHeader(spec.subject)}`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      base64Utf8(spec.body),
    ].join("\r\n");
    const { EmailMessage } = await import("cloudflare:email");
    await env.EMAIL.send(new EmailMessage(spec.from, NOTIFY_INBOX, raw));
  } catch (e) {
    console.error("form email notification failed", e);
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Keep only string values, bounded in size and count. */
function sanitizeFields(fields: unknown): Record<string, string> | null {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(fields as Record<string, unknown>)) {
    if (typeof v !== "string") continue;
    out[k.slice(0, 40)] = v.slice(0, 5000);
    if (Object.keys(out).length >= 40) break;
  }
  return out;
}

interface SubmitBody {
  form?: unknown;
  fields?: unknown;
}

/** POST /api/forms/submit — validate and store a form submission. */
export async function handleFormSubmit(req: Request, env: Env): Promise<Response> {
  if (!originAllowed(req, true, env)) return err("Forbidden origin", 403);
  const kv = env.WEBAO_KV;

  let body: SubmitBody;
  try {
    body = (await readJson(req)) as SubmitBody;
  } catch (e) {
    return err((e as Error).message);
  }
  if (body.form !== "pricing" && body.form !== "contact" && body.form !== "support") return err("Invalid form");
  const fields = sanitizeFields(body.fields);
  if (!fields) return err("Invalid fields");

  const name = (fields.name || "").trim();
  const email = (fields.email || "").trim();
  const message = (fields.message || "").trim();
  if (!name) return err("Name is required");
  if (body.form === "pricing" && !EMAIL_RE.test(email)) return err("Valid email is required");
  if (email && !EMAIL_RE.test(email)) return err("Invalid email");
  if (body.form === "contact" && !email && !message) return err("Email or message is required");
  if (body.form === "support") {
    if (!((fields.category || "").trim() in SUPPORT_CATEGORIES)) return err("Category is required");
    if (!EMAIL_RE.test(email)) return err("Valid email is required");
    if (!(fields.subject || "").trim()) return err("Subject is required");
    if (!message) return err("Description is required");
  }

  const now = Date.now();
  const id = `${now}:${uuid().replace(/-/g, "").slice(0, 16)}`;
  const key = "form:" + id;
  const ua = req.headers.get("user-agent") || "";
  const submission: FormSubmission = {
    form: body.form,
    fields,
    ip: clientIp(req),
    country: clientCountry(req),
    ua: ua.slice(0, 300),
    at: now,
  };
  await putJson(kv, key, submission);

  // Newest-first index; trim overflow and delete the evicted submissions.
  const index = (await getJson<string[]>(kv, INDEX_KEY)) || [];
  index.unshift(key);
  let overflow: string[] = [];
  if (index.length > MAX_INDEX) overflow = index.splice(MAX_INDEX);
  await putJson(kv, INDEX_KEY, index);
  for (const old of overflow) {
    try {
      await deleteKey(kv, old);
    } catch {
      /* best effort */
    }
  }

  if (body.form === "support" || body.form === "contact") await notifyByEmail(env, submission);

  return json({ ok: true, id });
}
