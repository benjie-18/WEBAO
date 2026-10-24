// Client records: the data foundation of the WEBAO delivery pipeline.
//
// A record is created (or updated) by the Stripe webhook when a checkout
// completes, and then follows the client through onboarding, build, review
// and live stages. Later backbone steps (onboarding form, client portal,
// build pipeline, reporting) read and advance the same record, so the shape
// here is deliberately the single source of truth for "who is a client and
// where are they".
//
// Storage follows the leads pattern (see leads.ts): records at client:<id>,
// a newest-first clients:index capped at 1000, plus a stripe customer
// mapping client-customer:<cus_id> -> client key so webhook events for
// invoices and subscriptions resolve in one read.

import { getJson, getJsonStrict, putJson } from "./kv";
import { batch, randomHex } from "./util";

export const CLIENTS_INDEX = "clients:index";
const MAX_INDEX = 1000;

export const CLIENT_ID_RE = /^cl_[a-f0-9]{24}$/;

/** Delivery pipeline stages. New clients start at "onboarding". */
export type ClientStage = "onboarding" | "build" | "review" | "live" | "paused";

/** Subscription state, mirrored from Stripe events. */
export type BillingStatus =
  | "active"
  | "past_due"
  | "canceled"
  | "incomplete"
  | "one-time"
  | "none";

/** What the client tells us in the portal before the build starts. */
export interface OnboardingData {
  businessName?: string;
  contactName?: string;
  phone?: string;
  /** What the business sells / does, in the client's words. */
  services?: string;
  /** Cities or area served. */
  serviceArea?: string;
  hours?: string;
  /** Key facts for the site copy (the build writes the words). */
  about?: string;
  hasLogo?: boolean;
  brandNotes?: string;
  photosReady?: boolean;
  /** "new": WEBAO registers/manages a domain. "existing": client brings one. */
  domainMode?: "new" | "existing";
  domainValue?: string;
  /** Optional style direction: demo ids the client liked (never a template). */
  styleDemos?: string[];
  styleNotes?: string;
  extraNotes?: string;
}

export interface Client {
  id: string;
  createdAt: number;
  updatedAt: number;
  email: string;
  name?: string;
  business?: string;
  lang?: string;
  stage: ClientStage;
  billingStatus: BillingStatus;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  /** Cart keys ever purchased (see checkout.ts PRICE_MAP), oldest first. */
  items: string[];
  lastCheckoutAt?: number;
  lastInvoicePaidAt?: number;
  paymentFailedAt?: number;
  /** Set by invoice.payment_action_required: the client must confirm their
   *  card (3D Secure) on Stripe's hosted invoice page to rescue the payment.
   *  The portal banners it; the next invoice.paid clears it. */
  paymentActionRequired?: { invoiceId: string; url: string; at: number };
  /** Latest Stripe dispute opened against this client (charge.dispute.created). */
  disputeFlag?: { disputeId: string; at: number };
  canceledAt?: number;
  /**
   * Stripe `event.created` (ms) of the newest billing event applied to this
   * record. Billing handlers ignore older events, so a redelivered stale
   * invoice/subscription event can never resurrect a canceled status.
   */
  lastBillingEventAt?: number;
  /** How this record came to exist, e.g. "stripe". */
  source: string;
  /** Admin-created test record: excluded from nudges and monthly reports. */
  test?: boolean;
  /** Portal onboarding answers; absent until the client starts the form. */
  onboarding?: OnboardingData;
  /** Set when the onboarding form first reaches completeness. */
  onboardingCompletedAt?: number;
  /** Preview URL shown to the client while the stage is "review". */
  previewUrl?: string;
  /** Onboarding nudge bookkeeping (see portal.ts nudges). */
  nudgeCount?: number;
  lastNudgeAt?: number;
  nudgesEscalatedAt?: number;
  /** Canonical bare hostname of the client's site, e.g. "patplumbing.ca". */
  domain?: string;
  /**
   * Domain lifecycle: "to-register" (WEBAO registers a managed domain),
   * "pending-dns" (waiting on a CNAME to hosting.webao.ca), "connected"
   * (DNS verified by the sweep), "live" (a build is published on it).
   */
  domainStatus?: "none" | "to-register" | "pending-dns" | "connected" | "live";
  domainAssignedAt?: number;
  domainCheckedAt?: number;
  /** The client's latest decision on the build in review. */
  reviewDecision?: {
    decision: "approved" | "changes";
    note?: string;
    at: number;
    buildId?: string;
  };
  /** How many times the client has sent a build back with changes. */
  revisionCount?: number;
  /** Ads Pack engagement, present once the client buys ads (or is set up). */
  ads?: AdsState;
}

/** What an Ads Pack client tells us before a campaign can be built. */
export interface AdsOnboarding {
  trade?: string;
  services?: string;
  serviceArea?: string;
  radiusKm?: number;
  /** The client's own monthly ad spend, in dollars (minimum 1500). */
  monthlyBudget?: number;
  /** Their existing website when WEBAO does not host it. */
  websiteUrl?: string;
  leadEmail?: string;
  leadPhone?: string;
  notes?: string;
}

export type AdsStatus = "onboarding" | "setup" | "ready" | "live" | "paused";

export interface AdsState {
  status: AdsStatus;
  platform: "meta";
  onboarding?: AdsOnboarding;
  onboardingCompletedAt?: number;
  /** The client's own Meta ad account id (act_...), never WEBAO's. */
  adAccountId?: string;
  updatedAt: number;
}

/** True when the client's purchases include the Ads Pack. */
export function hasAdsPack(client: Client): boolean {
  return (client.items || []).some((k) => k.startsWith("ads-pack"));
}

/** Minimum monthly ad spend (client's own card) for the Ads Pack. */
export const ADS_MIN_MONTHLY_BUDGET = 1500;

/** An ads onboarding form counts as complete with trade, area, a budget at
 *  or above the minimum, and somewhere to send leads. */
export function adsOnboardingComplete(client: Client): boolean {
  const o = client.ads?.onboarding;
  if (!o) return false;
  return Boolean(
    o.trade?.trim() &&
      o.serviceArea?.trim() &&
      typeof o.monthlyBudget === "number" &&
      o.monthlyBudget >= ADS_MIN_MONTHLY_BUDGET &&
      (o.leadEmail?.trim() || o.leadPhone?.trim()) &&
      (o.websiteUrl?.trim() || client.domain),
  );
}

/** KV key that maps a hostname to its owning client's record key. */
export const domainKey = (host: string): string => "domain:" + host;

const HOSTNAME_RE =
  /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * Normalize free-form domain input ("https://www.PatPlumbing.ca/") to a
 * canonical bare hostname, or null when it is not a usable public hostname.
 * The main site's own domain is never a tenant domain.
 */
export function normalizeDomain(raw?: string | null): string | null {
  if (!raw) return null;
  let host = raw.trim().toLowerCase();
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  host = host.split(/[/?#]/)[0];
  host = host.replace(/:\d+$/, "").replace(/\.$/, "");
  if (host.startsWith("www.")) host = host.slice(4);
  if (!host || host.length > 253) return null;
  if (host === "webao.ca" || host.endsWith(".webao.ca")) return null;
  if (!HOSTNAME_RE.test(host)) return null;
  return host;
}

/** The fields a build cannot start without. */
export function onboardingComplete(client: Client): boolean {
  const o = client.onboarding;
  if (!o) return false;
  const filled = (v?: string): boolean => !!v && v.trim().length > 0;
  return (
    filled(o.businessName) &&
    filled(o.contactName) &&
    filled(o.phone) &&
    filled(o.services) &&
    filled(o.serviceArea) &&
    (o.domainMode === "new" || o.domainMode === "existing") &&
    filled(o.domainValue)
  );
}

const customerKey = (customerId: string): string => "client-customer:" + customerId;
const emailKey = (email: string): string => "client-email:" + email.trim().toLowerCase();

/** Load a client by its cl_ id. */
export async function getClient(kv: KVNamespace, id: string): Promise<Client | null> {
  if (!CLIENT_ID_RE.test(id)) return null;
  return getJson<Client>(kv, "client:" + id);
}

/**
 * Resolve a client from a Stripe customer id in one mapping read.
 * Strict reads: a KV outage throws (the webhook answers 5xx and Stripe
 * retries) instead of resolving to null and minting a duplicate record.
 */
export async function findClientByCustomer(
  kv: KVNamespace,
  customerId: string,
): Promise<Client | null> {
  if (!customerId) return null;
  const key = await getJsonStrict<string>(kv, customerKey(customerId));
  if (!key) return null;
  return getJsonStrict<Client>(kv, key);
}

/**
 * Newest client with this email (repeat buyers keep a single record).
 * The email mapping is tried first so clients that rolled off the
 * newest-1000 index still resolve; the index scan stays as fallback.
 * The mapping read is always strict; the record + scan reads are
 * lenient by default (a read outage resolves to "not found", which is
 * what the portal request-link path needs to stay silent). Pass
 * { strict: true } for the webhook path, where a read outage must
 * fail closed (500, Stripe retries) instead of creating a duplicate
 * client.
 */
export async function findClientByEmail(
  kv: KVNamespace,
  email: string,
  opts?: { strict?: boolean },
): Promise<Client | null> {
  const target = email.trim().toLowerCase();
  if (!target) return null;
  const mapped = await getJsonStrict<string>(kv, emailKey(target));
  if (mapped) {
    const rec = opts?.strict
      ? await getJsonStrict<Client>(kv, mapped)
      : await getJson<Client>(kv, mapped);
    if (rec) return rec;
  }
  const index = opts?.strict
    ? (await getJsonStrict<string[]>(kv, CLIENTS_INDEX)) || []
    : (await getJson<string[]>(kv, CLIENTS_INDEX)) || [];
  const read = opts?.strict
    ? (k: string) => getJsonStrict<Client>(kv, k)
    : (k: string) => getJson<Client>(kv, k);
  const records = await batch(index.slice(0, MAX_INDEX), 25, read);
  return records.find((r): r is Client => !!r && r.email === target) || null;
}

/**
 * Persist a client and its mappings. Mappings are written BEFORE the
 * record: if the record write then fails, the mappings dangle to a
 * missing record and the next webhook event recreates it (self-healing),
 * whereas the old record-first order left a live record unreachable by
 * customer id, silently dropping subscription events for it.
 */
export async function saveClient(kv: KVNamespace, client: Client): Promise<void> {
  client.updatedAt = Date.now();
  await putJson(kv, emailKey(client.email), "client:" + client.id);
  if (client.stripeCustomerId) {
    await putJson(kv, customerKey(client.stripeCustomerId), "client:" + client.id);
  }
  await putJson(kv, "client:" + client.id, client);
}

/** Create a fresh client record (stage "onboarding") and index it. */
export async function createClient(
  kv: KVNamespace,
  init: {
    email: string;
    name?: string;
    business?: string;
    lang?: string;
    items?: string[];
    stripeCustomerId?: string;
    stripeSubscriptionId?: string;
    billingStatus?: BillingStatus;
    source?: string;
    test?: boolean;
  },
): Promise<Client> {
  const now = Date.now();
  const client: Client = {
    id: "cl_" + randomHex(12),
    createdAt: now,
    updatedAt: now,
    email: init.email.trim().toLowerCase(),
    name: init.name,
    business: init.business,
    lang: init.lang,
    stage: "onboarding",
    billingStatus: init.billingStatus ?? "none",
    stripeCustomerId: init.stripeCustomerId,
    stripeSubscriptionId: init.stripeSubscriptionId,
    items: init.items ? [...init.items] : [],
    source: init.source || "stripe",
    test: init.test || undefined,
  };
  await saveClient(kv, client);

  // Newest-first index; trimming it only bounds listings. Records are
  // NEVER deleted on eviction: the old code destroyed the oldest client
  // (with its domain mapping and ads state) once 1000 clients existed.
  const index = (await getJson<string[]>(kv, CLIENTS_INDEX)) || [];
  index.unshift("client:" + client.id);
  if (index.length > MAX_INDEX) index.splice(MAX_INDEX);
  await putJson(kv, CLIENTS_INDEX, index);
  return client;
}

/** Merge cart keys into a client's purchase history (order-stable, deduped). */
export function mergeItems(client: Client, keys: string[]): void {
  for (const key of keys) {
    if (key && !client.items.includes(key)) client.items.push(key);
  }
}
