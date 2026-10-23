// Stripe webhook: payment events become client records.
//
// POST /api/stripe/webhook — registered in the Stripe dashboard, signed with
// the STRIPE_WEBHOOK_SECRET worker secret. Until that secret is set the
// endpoint answers 503, so deploying this code before the dashboard setup is
// harmless. Stripe retries any non-2xx, and every handler here is an
// idempotent upsert, so retries and duplicate deliveries are safe: the
// event-id dedupe key is written only AFTER successful handling.
//
// Events handled:
//   checkout.session.completed  -> create/update the client (stage onboarding)
//   invoice.paid                -> billingStatus active, stamp lastInvoicePaidAt
//   invoice.payment_failed      -> billingStatus past_due, stamp paymentFailedAt
//   customer.subscription.updated -> mirror the subscription status
//   customer.subscription.deleted -> billingStatus canceled, stamp canceledAt
// Anything else is acknowledged and ignored.

import { putJson } from "./kv";
import { json, err, timingSafeEqual, clampStr } from "./util";
import {
  createClient,
  findClientByCustomer,
  findClientByEmail,
  mergeItems,
  saveClient,
  type BillingStatus,
  type Client,
} from "./clients";

const SIGNATURE_TOLERANCE_SEC = 300;
const EVENT_TTL_SEC = 30 * 24 * 60 * 60;
const NOTIFY_INBOX = "webao.ca@gmail.com";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// ---------------------------------------------------------------------------
// Signature verification (Stripe's v1 scheme: HMAC-SHA256 of "<t>.<payload>")
// ---------------------------------------------------------------------------

async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Verify a Stripe-Signature header against the raw request body.
 * Exported for tests. `nowSec` is injectable for deterministic tests.
 */
export async function verifyStripeSignature(
  rawBody: string,
  header: string | null,
  secret: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (!header) return false;
  let timestamp = "";
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === "t") timestamp = v;
    if (k === "v1") signatures.push(v);
  }
  const ts = parseInt(timestamp, 10);
  if (!timestamp || isNaN(ts) || signatures.length === 0) return false;
  if (Math.abs(nowSec - ts) > SIGNATURE_TOLERANCE_SEC) return false;
  const expected = await hmacSha256Hex(secret, `${ts}.${rawBody}`);
  return signatures.some((sig) => timingSafeEqual(sig, expected));
}

// ---------------------------------------------------------------------------
// Event shapes (only the fields this handler reads)
// ---------------------------------------------------------------------------

interface StripeEvent {
  id: string;
  type: string;
  created: number;
  data: { object: Record<string, unknown> };
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

async function resolveClient(
  kv: KVNamespace,
  customerId: string,
  email: string,
): Promise<Client | null> {
  if (customerId) {
    const byCustomer = await findClientByCustomer(kv, customerId);
    if (byCustomer) return byCustomer;
  }
  if (email) return findClientByEmail(kv, email);
  return null;
}

async function onCheckoutCompleted(
  kv: KVNamespace,
  env: Env,
  event: StripeEvent,
): Promise<void> {
  const s = event.data.object;
  const details = (s.customer_details || {}) as Record<string, unknown>;
  const email = (str(details.email) || str(s.customer_email)).trim().toLowerCase();
  const customerId = str(s.customer);
  const subscriptionId = str(s.subscription);
  const metadata = (s.metadata || {}) as Record<string, unknown>;
  const items = str(metadata.items)
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  const name = clampStr(details.name, 120).trim() || undefined;
  const at = event.created > 0 ? event.created * 1000 : Date.now();

  if (!email && !customerId) {
    console.error("stripe webhook: checkout session without email or customer", event.id);
    return;
  }

  const existing = await resolveClient(kv, customerId, email);
  if (!existing) {
    if (!EMAIL_RE.test(email)) {
      console.error("stripe webhook: checkout session with unusable email", event.id);
      return;
    }
    const client = await createClient(kv, {
      email,
      name,
      items,
      stripeCustomerId: customerId || undefined,
      stripeSubscriptionId: subscriptionId || undefined,
      billingStatus: subscriptionId ? "active" : "one-time",
    });
    client.lastCheckoutAt = at;
    await saveClient(kv, client);
    await notifyNewClient(env, client);
    return;
  }

  // Repeat purchase: enrich the same record, never duplicate the client.
  if (customerId && !existing.stripeCustomerId) existing.stripeCustomerId = customerId;
  if (subscriptionId) existing.stripeSubscriptionId = subscriptionId;
  if (name && !existing.name) existing.name = name;
  if (email && existing.email !== email) existing.email = email;
  mergeItems(existing, items);
  existing.lastCheckoutAt = at;
  if (subscriptionId && (existing.billingStatus === "none" || existing.billingStatus === "one-time")) {
    existing.billingStatus = "active";
  }
  await saveClient(kv, existing);
}

async function onInvoice(
  kv: KVNamespace,
  event: StripeEvent,
  paid: boolean,
): Promise<void> {
  const inv = event.data.object;
  const customerId = str(inv.customer);
  const email = str(inv.customer_email).trim().toLowerCase();
  const client = await resolveClient(kv, customerId, email);
  if (!client) return; // Pre-webhook customer or unrelated account: nothing to mirror.
  const at = event.created > 0 ? event.created * 1000 : Date.now();
  if (paid) {
    client.billingStatus = "active";
    client.lastInvoicePaidAt = at;
    client.paymentFailedAt = undefined;
  } else {
    client.billingStatus = "past_due";
    client.paymentFailedAt = at;
  }
  if (customerId && !client.stripeCustomerId) client.stripeCustomerId = customerId;
  await saveClient(kv, client);
}

function mapSubscriptionStatus(status: string): BillingStatus | null {
  switch (status) {
    case "active":
    case "trialing":
      return "active";
    case "past_due":
    case "unpaid":
      return "past_due";
    case "canceled":
      return "canceled";
    case "incomplete":
    case "incomplete_expired":
      return "incomplete";
    default:
      return null;
  }
}

async function onSubscription(
  kv: KVNamespace,
  event: StripeEvent,
  deleted: boolean,
): Promise<void> {
  const sub = event.data.object;
  const customerId = str(sub.customer);
  const client = await resolveClient(kv, customerId, "");
  if (!client) return;
  if (str(sub.id)) client.stripeSubscriptionId = str(sub.id);
  if (deleted) {
    client.billingStatus = "canceled";
    client.canceledAt = event.created > 0 ? event.created * 1000 : Date.now();
  } else {
    const mapped = mapSubscriptionStatus(str(sub.status));
    if (mapped) client.billingStatus = mapped;
    if (mapped === "canceled" && !client.canceledAt) {
      client.canceledAt = event.created > 0 ? event.created * 1000 : Date.now();
    }
  }
  await saveClient(kv, client);
}

// ---------------------------------------------------------------------------
// Internal notification (best effort, same pattern as form email copies)
// ---------------------------------------------------------------------------

function base64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function encodeHeader(text: string): string {
  return "=?UTF-8?B?" + base64Utf8(text) + "?=";
}

async function notifyNewClient(env: Env, client: Client): Promise<void> {
  if (!env.EMAIL) return;
  try {
    const lines = [
      `New WEBAO client (created by Stripe checkout).`,
      ``,
      `Email: ${client.email}`,
      client.name ? `Name: ${client.name}` : null,
      `Items: ${client.items.join(", ") || "(none recorded)"}`,
      `Billing: ${client.billingStatus}`,
      client.stripeCustomerId ? `Stripe customer: ${client.stripeCustomerId}` : null,
      client.stripeSubscriptionId ? `Stripe subscription: ${client.stripeSubscriptionId}` : null,
      ``,
      `Record: client:${client.id}, stage: onboarding.`,
    ].filter((l): l is string => l !== null);
    const raw = [
      `From: "WEBAO" <start@webao.ca>`,
      `To: ${NOTIFY_INBOX}`,
      `Subject: ${encodeHeader(`New client: ${client.email}`)}`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      base64Utf8(lines.join("\n")),
    ].join("\r\n");
    const { EmailMessage } = await import("cloudflare:email");
    await env.EMAIL.send(new EmailMessage("start@webao.ca", NOTIFY_INBOX, raw));
  } catch (e) {
    console.error("stripe webhook: new-client notification failed", e);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function handleStripeWebhook(req: Request, env: Env): Promise<Response> {
  const secret = env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return json({ ok: false, error: "Webhook not configured" }, 503);
  const kv = env.WEBAO_KV;

  const rawBody = await req.text();
  const ok = await verifyStripeSignature(rawBody, req.headers.get("stripe-signature"), secret);
  if (!ok) return err("Invalid signature", 400);

  let event: StripeEvent;
  try {
    event = JSON.parse(rawBody) as StripeEvent;
  } catch {
    return err("Invalid payload", 400);
  }
  if (!event.id || !event.type || !event.data?.object) return err("Invalid event", 400);

  // Idempotency: Stripe delivers at least once. The dedupe key is written
  // only after handling succeeds, so a failed run is retried by Stripe and
  // reprocessed (all handlers above are upserts, so reprocessing is safe).
  const dedupeKey = "stripe-event:" + event.id;
  if ((await kv.get(dedupeKey)) !== null) {
    return json({ ok: true, received: true, duplicate: true });
  }

  switch (event.type) {
    case "checkout.session.completed":
      await onCheckoutCompleted(kv, env, event);
      break;
    case "invoice.paid":
      await onInvoice(kv, event, true);
      break;
    case "invoice.payment_failed":
      await onInvoice(kv, event, false);
      break;
    case "customer.subscription.updated":
      await onSubscription(kv, event, false);
      break;
    case "customer.subscription.deleted":
      await onSubscription(kv, event, true);
      break;
    default:
      break; // Acknowledged, nothing to mirror.
  }

  await putJson(kv, dedupeKey, { type: event.type, at: Date.now() }, EVENT_TTL_SEC);
  return json({ ok: true, received: true });
}
