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

import { getJson, putJson, deleteKey } from "./kv";
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
  canceledAt?: number;
  /** How this record came to exist, e.g. "stripe". */
  source: string;
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

/** Load a client by its cl_ id. */
export async function getClient(kv: KVNamespace, id: string): Promise<Client | null> {
  if (!CLIENT_ID_RE.test(id)) return null;
  return getJson<Client>(kv, "client:" + id);
}

/** Resolve a client from a Stripe customer id in one mapping read. */
export async function findClientByCustomer(
  kv: KVNamespace,
  customerId: string,
): Promise<Client | null> {
  if (!customerId) return null;
  const key = await getJson<string>(kv, customerKey(customerId));
  if (!key) return null;
  return getJson<Client>(kv, key);
}

/** Newest client with this email (repeat buyers keep a single record). */
export async function findClientByEmail(
  kv: KVNamespace,
  email: string,
): Promise<Client | null> {
  const target = email.trim().toLowerCase();
  if (!target) return null;
  const index = (await getJson<string[]>(kv, CLIENTS_INDEX)) || [];
  const records = await batch(index.slice(0, MAX_INDEX), 25, (k) => getJson<Client>(kv, k));
  return records.find((r): r is Client => !!r && r.email === target) || null;
}

/** Persist a client and its stripe customer mapping. */
export async function saveClient(kv: KVNamespace, client: Client): Promise<void> {
  client.updatedAt = Date.now();
  await putJson(kv, "client:" + client.id, client);
  if (client.stripeCustomerId) {
    await putJson(kv, customerKey(client.stripeCustomerId), "client:" + client.id);
  }
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
  };
  await saveClient(kv, client);

  const index = (await getJson<string[]>(kv, CLIENTS_INDEX)) || [];
  index.unshift("client:" + client.id);
  let overflow: string[] = [];
  if (index.length > MAX_INDEX) overflow = index.splice(MAX_INDEX);
  await putJson(kv, CLIENTS_INDEX, index);
  for (const old of overflow) {
    try {
      await deleteKey(kv, old);
    } catch {
      /* best effort */
    }
  }
  return client;
}

/** Merge cart keys into a client's purchase history (order-stable, deduped). */
export function mergeItems(client: Client, keys: string[]): void {
  for (const key of keys) {
    if (key && !client.items.includes(key)) client.items.push(key);
  }
}
