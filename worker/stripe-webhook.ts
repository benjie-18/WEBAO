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
//   checkout.session.expired    -> store an abandoned checkout (see
//                                  recovery.ts; one follow-up email later)
//   charge.dispute.created      -> record the dispute, flag the client, and
//                                  alert the WEBAO inbox immediately
//   invoice.payment_action_required -> flag the client (the portal banners
//                                  it) and email Stripe's confirmation link
// Anything else is acknowledged and ignored.

import { putJson } from "./kv";
import { json, err, timingSafeEqual, clampStr } from "./util";
import { notifyInbox, sendClientEmail } from "./mailer";
import { storeAbandonedCheckout } from "./recovery";
import {
  createClient,
  findClientByCustomer,
  findClientByEmail,
  hasAdsPack,
  mergeItems,
  saveClient,
  type BillingStatus,
  type Client,
} from "./clients";

/** Buying the Ads Pack opens its onboarding track on the client record. */
function ensureAdsState(client: Client): void {
  if (hasAdsPack(client) && !client.ads) {
    client.ads = { status: "onboarding", platform: "meta", updatedAt: Date.now() };
  }
}

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
    ensureAdsState(client);
    await saveClient(kv, client);
    await notifyNewClient(env, client);
    await sendWelcomeEmail(env, client);
    return;
  }

  // Repeat purchase: enrich the same record, never duplicate the client.
  if (customerId && !existing.stripeCustomerId) existing.stripeCustomerId = customerId;
  if (subscriptionId) existing.stripeSubscriptionId = subscriptionId;
  if (name && !existing.name) existing.name = name;
  if (email && existing.email !== email) existing.email = email;
  mergeItems(existing, items);
  if (existing.test) existing.test = undefined; // a real purchase graduates a test record
  ensureAdsState(existing);
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
    client.paymentActionRequired = undefined;
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

async function onCheckoutExpired(kv: KVNamespace, event: StripeEvent): Promise<void> {
  const s = event.data.object;
  const details = (s.customer_details || {}) as Record<string, unknown>;
  const email = (str(details.email) || str(s.customer_email)).trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return; // nobody to follow up with
  const metadata = (s.metadata || {}) as Record<string, unknown>;
  const items = str(metadata.items)
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  await storeAbandonedCheckout(kv, {
    sessionId: str(s.id),
    email,
    name: clampStr(details.name, 120).trim() || undefined,
    items,
    amountTotal: typeof s.amount_total === "number" ? s.amount_total : undefined,
    currency: str(s.currency) || undefined,
    lang: str(metadata.lang) === "fr" ? "fr" : "en",
    createdAt: event.created > 0 ? event.created * 1000 : Date.now(),
    status: "pending",
  });
}

async function onDisputeCreated(
  kv: KVNamespace,
  env: Env,
  event: StripeEvent,
): Promise<void> {
  const d = event.data.object;
  const disputeId = str(d.id);
  if (!disputeId) return;
  const chargeId = str(d.charge);
  const at = event.created > 0 ? event.created * 1000 : Date.now();
  const evidence = (d.evidence_details || {}) as Record<string, unknown>;
  const dueBySec = typeof evidence.due_by === "number" ? evidence.due_by : 0;

  // Best effort: resolve the client through the charge's customer (the
  // dispute object itself carries no customer id).
  let client: Client | null = null;
  if (chargeId && env.STRIPE_SECRET_KEY) {
    try {
      const res = await fetch(`https://api.stripe.com/v1/charges/${chargeId}`, {
        headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
      });
      if (res.ok) {
        const charge = (await res.json()) as Record<string, unknown>;
        client = await findClientByCustomer(kv, str(charge.customer));
      }
    } catch {
      // The record and the alert below still go out without the match.
    }
  }
  if (client) {
    client.disputeFlag = { disputeId, at };
    await saveClient(kv, client);
  }
  const amount = typeof d.amount === "number" ? d.amount : 0;
  const currency = (str(d.currency) || "cad").toUpperCase();
  const money = `${(amount / 100).toFixed(2)} ${currency}`;
  await putJson(kv, "dispute:" + disputeId, {
    id: disputeId,
    chargeId,
    amount,
    currency: currency.toLowerCase(),
    reason: str(d.reason),
    status: str(d.status),
    dueBy: dueBySec ? dueBySec * 1000 : undefined,
    clientId: client?.id,
    email: client?.email,
    at,
  });
  await notifyInbox(env, `Stripe dispute opened: ${money}`, [
    "A charge dispute (chargeback) was opened in Stripe.",
    "",
    `Dispute: ${disputeId}`,
    `Amount: ${money}`,
    `Reason: ${str(d.reason) || "(not given)"}`,
    dueBySec
      ? `Evidence due by: ${new Date(dueBySec * 1000).toISOString()}`
      : "Evidence due by: see Stripe",
    client ? `Client: ${client.email} (${client.id})` : "Client: not matched to a record",
    "",
    "Respond in the Stripe Dashboard (Payments, then Disputes) before the deadline; an unanswered dispute is lost automatically.",
  ]);
}

async function onPaymentActionRequired(
  kv: KVNamespace,
  env: Env,
  event: StripeEvent,
): Promise<void> {
  const inv = event.data.object;
  const customerId = str(inv.customer);
  const email = str(inv.customer_email).trim().toLowerCase();
  const client = await resolveClient(kv, customerId, email);
  if (!client) return;
  const url = str(inv.hosted_invoice_url);
  const at = event.created > 0 ? event.created * 1000 : Date.now();
  client.paymentActionRequired = { invoiceId: str(inv.id), url, at };
  await saveClient(kv, client);
  if (!url) return;
  const fr = client.lang === "fr";
  await sendClientEmail(env, {
    to: client.email,
    subject: fr
      ? "Action requise : confirmez votre carte pour garder votre service actif"
      : "Action needed: confirm your card to keep your service active",
    text: fr
      ? [
          "Bonjour,",
          "",
          "Votre banque demande une confirmation rapide avant que votre dernier paiement WEBAO puisse passer. Rien n'est brisé et aucun frais supplémentaire ne s'applique : Stripe doit simplement confirmer que la carte est bien la vôtre.",
          "",
          `Confirmez ici : ${url}`,
          "",
          "Tant que ce n'est pas confirmé, votre abonnement ne peut pas se renouveler. Merci de le faire dès que possible pour éviter une interruption de service.",
          "",
          "Des questions ? Répondez à ce courriel ou écrivez à support@webao.ca.",
          "",
          "L'équipe Webao",
        ].join("\n")
      : [
          "Hi,",
          "",
          "Your bank asked for a quick confirmation before your latest WEBAO payment can go through. Nothing is broken and no extra charge applies: Stripe just needs to confirm the card is yours.",
          "",
          `Confirm here: ${url}`,
          "",
          "Until it is confirmed, your subscription cannot renew. Please do it as soon as you can so your service continues without interruption.",
          "",
          "Questions? Reply to this email or write to support@webao.ca.",
          "",
          "The Webao team",
        ].join("\n"),
  });
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

/**
 * Welcome email to the new client (best effort, via SMTP2GO; a no-op until
 * SMTP2GO_API_KEY is set). Points at the portal, which is where onboarding
 * happens; the client signs in with this same email address.
 */
async function sendWelcomeEmail(env: Env, client: Client): Promise<void> {
  const fr = client.lang === "fr";
  const link = `https://webao.ca${fr ? "/fr/portail" : "/portal"}`;
  await sendClientEmail(env, {
    to: client.email,
    subject: fr ? "Bienvenue chez WEBAO, voici la suite" : "Welcome to WEBAO, here is what happens next",
    text: fr
      ? [
          "Bonjour,",
          "",
          "Merci pour votre commande. Votre site est maintenant dans notre file de production.",
          "",
          "La prochaine étape est courte : ouvrez votre portail client et remplissez le formulaire de démarrage (vos services, votre secteur, vos heures, votre nom de domaine). La conception commence dès que le formulaire est complet.",
          "",
          `Portail : ${link}`,
          "Entrez l'adresse courriel de votre commande et nous vous enverrons un lien d'accès.",
          "",
          "Des questions ? Répondez à ce courriel ou écrivez à support@webao.ca.",
          "",
          "L'équipe Webao",
        ].join("\n")
      : [
          "Hi,",
          "",
          "Thanks for your order. Your website is now in our production queue.",
          "",
          "The next step is short: open your client portal and fill in the start-up form (your services, your service area, your hours, your domain name). The build starts as soon as the form is complete.",
          "",
          `Portal: ${link}`,
          "Enter the email address from your order and we will send you a sign-in link.",
          "",
          "Questions? Reply to this email or write to support@webao.ca.",
          "",
          "The Webao team",
        ].join("\n"),
  });
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
    case "checkout.session.expired":
      await onCheckoutExpired(kv, event);
      break;
    case "charge.dispute.created":
      await onDisputeCreated(kv, env, event);
      break;
    case "invoice.payment_action_required":
      await onPaymentActionRequired(kv, env, event);
      break;
    default:
      break; // Acknowledged, nothing to mirror.
  }

  await putJson(kv, dedupeKey, { type: event.type, at: Date.now() }, EVENT_TTL_SEC);
  return json({ ok: true, received: true });
}
