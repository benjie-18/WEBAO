// Public form submissions (pricing + contact).
// Stored as form:<ts>:<rand> with a newest-first index capped at 1000 entries.

import { getJson, putJson } from "./kv";
import { clientIp, clientCountry, readJson, json, err, originAllowed, uuid } from "./util";

const INDEX_KEY = "forms:index";
const MAX_INDEX = 1000;

export interface FormSubmission {
  form: "pricing" | "contact";
  fields: Record<string, string>;
  ip: string;
  country: string;
  ua: string;
  at: number;
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
  if (!originAllowed(req, true)) return err("Forbidden origin", 403);
  const kv = env.WEBAO_KV;

  let body: SubmitBody;
  try {
    body = (await readJson(req)) as SubmitBody;
  } catch (e) {
    return err((e as Error).message);
  }
  if (body.form !== "pricing" && body.form !== "contact") return err("Invalid form");
  const fields = sanitizeFields(body.fields);
  if (!fields) return err("Invalid fields");

  const name = (fields.name || "").trim();
  const email = (fields.email || "").trim();
  const message = (fields.message || "").trim();
  if (!name) return err("Name is required");
  if (body.form === "pricing" && !EMAIL_RE.test(email)) return err("Valid email is required");
  if (email && !EMAIL_RE.test(email)) return err("Invalid email");
  if (body.form === "contact" && !email && !message) return err("Email or message is required");

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
      await kv.delete(old);
    } catch {
      /* best effort */
    }
  }

  return json({ ok: true, id });
}
