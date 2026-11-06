// Public form submissions (pricing + contact + support).
// Stored as form:<ts>:<rand>; the admin Forms tab lists them by the
// "form:" prefix (newest first, by the timestamp in the key).
// Support and contact submissions also send a best-effort email copy to the
// WEBAO inbox via the send_email binding; the KV record stays the source of truth.

import { putJson } from "./kv";
import { buildInboxEmail, INBOX_ADDRESS } from "./mailer";
import { EMAIL_RE, clientIp, clientCountry, readJson, json, err, originAllowed, uuid } from "./util";

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
    const raw = buildInboxEmail({
      from: spec.from,
      fromName: spec.fromName,
      subject: spec.subject,
      body: spec.body,
      replyTo: (submission.fields.email || "").trim() || undefined,
    });
    const { EmailMessage } = await import("cloudflare:email");
    await env.EMAIL.send(new EmailMessage(spec.from, INBOX_ADDRESS, raw));
  } catch (e) {
    console.error("form email notification failed", e);
  }
}



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
  // No in-worker throttle here: every throttle check is a KV write, and
  // this endpoint is public. The edge rate-limit rule ("WEBAO track rate
  // limit") covers /api/forms/* at 20 requests per 10 s per IP, which is
  // the per-IP cap for form submissions.
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

  // No index key: the admin Forms tab lists submissions by the "form:"
  // prefix instead, so storing a submission costs exactly one write.
  // (The old forms:index key is an inert leftover.)

  if (body.form === "support" || body.form === "contact") await notifyByEmail(env, submission);

  return json({ ok: true, id });
}
