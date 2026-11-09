/**
 * WEBAO cart catalog — every purchasable product, its type and its price in
 * cents for each billing interval.
 *
 * This is the single source of truth used by:
 * - the pricing components (`PlanCards`, `BundleCard`, `AddonList`) to render
 *   the "add to cart" buttons,
 * - the cart drawer / checkout page to display and re-price items,
 * - `tests/cart.test.ts`, which checks that `worker/checkout.ts` still maps
 *   every key this catalog can produce to a Stripe Price ID.
 *
 * Rules taken from "WEBAO PRICING PLAN (FINAL).txt":
 * - recurring products are billed monthly, or annually in advance
 *   (2 months free → the annual price is 10 months),
 * - the Extra Page add-on is one-time.
 *
 * Plans use the annual figures already shown on the pricing page
 * (`t.pricing.plans.*.annual`): exactly 10 monthly payments, as for
 * bundles and add-ons.
 */

import { cartKey, type CartInterval } from "./cart";

/** Billing term for recurring products. One-time products ignore it. */
export type Billing = "month" | "year";

export interface CartProduct {
  /** Product key; cart keys are `${product}-${interval}`. */
  product: string;
  /** Grouping used by the cart (one plan at a time, add-ons, bundles). */
  type: "plan" | "bundle" | "addon";
  /** Monthly price in cents, for recurring products. */
  monthCents?: number;
  /** Annual price in cents (charged once a year), for recurring products. */
  yearCents?: number;
  /** One-time price in cents, for one-time products. */
  oneTimeCents?: number;
}

/** Annual price = 10 monthly payments ("2 months free", plan note [3]). */
const TEN_MONTHS = 10;

const catalog = {
  /* ── Plans ───────────────────────────────────────────────────────────── */
  launch: { product: "launch", type: "plan", monthCents: 8999, yearCents: 8999 * TEN_MONTHS },
  grow: { product: "grow", type: "plan", monthCents: 14999, yearCents: 14999 * TEN_MONTHS },
  scale: { product: "scale", type: "plan", monthCents: 34999, yearCents: 34999 * TEN_MONTHS },

  /* ── Bundles ─────────────────────────────────────────────────────────── */
  "lead-pack": { product: "lead-pack", type: "bundle", monthCents: 23999, yearCents: 23999 * TEN_MONTHS },
  "visibility-pack": {
    product: "visibility-pack",
    type: "bundle",
    monthCents: 9999,
    yearCents: 9999 * TEN_MONTHS,
  },
  // Monthly only (no annual term). The one-time setup fee is not sold here:
  // checkout adds it server-side from the STRIPE_PRICE_ADS_SETUP secret.
  // Legacy key, kept so old carts and tests still resolve: same single-channel
  // price as ads-meta / ads-google below.
  "ads-pack": { product: "ads-pack", type: "bundle", monthCents: 89999 },
  // Revamped Ads Pack, monthly only. One channel (Meta or Google) is the
  // single price; both channels together are the bundle price. The setup
  // fee is added server-side by checkout (single: STRIPE_PRICE_ADS_SETUP
  // secret; both: the bundle setup price, see worker/checkout.ts).
  "ads-meta": { product: "ads-meta", type: "bundle", monthCents: 89999 },
  "ads-google": { product: "ads-google", type: "bundle", monthCents: 89999 },
  "ads-both": { product: "ads-both", type: "bundle", monthCents: 134999 },
  // Starter test, Meta only, monthly only (no annual price, so it can
  // never be bought yearly). One campaign, 90 days, then step up or stop.
  // Setup is C$349.99, added server-side by checkout (see
  // worker/checkout.ts), never the C$499.99 Core setup.
  "ads-starter": { product: "ads-starter", type: "bundle", monthCents: 49999 },
  // Google Business Profile revamp: one-time, sold on its own or with a pack.
  "gbp-revamp": { product: "gbp-revamp", type: "addon", oneTimeCents: 14999 },
  // Website touchup: one-time, we fix what the free audit found on the
  // buyer's site. Buying it unlocks 10% off any subscription for the
  // first 3 months, one use only (see terms; the code lives in the
  // admin panel, Coupons tab, and is never shown on the site).
  "website-touchup": { product: "website-touchup", type: "addon", oneTimeCents: 19999 },

  /* ── AI services (monthly only, like the Ads Pack), except the AI Pack,
     which is yearly available too (2 months free, like the plans). The
     one-time setup fee is not sold here: checkout adds it server-side,
     see worker/checkout.ts, following the Ads Pack setup pattern. The
     chat service is the Trained AI Chat Assistant (aichat, in the
     add-ons below): one product, C$99.99/mo, yearly available, no setup
     fee. */
  "ai-receptionist": { product: "ai-receptionist", type: "addon", monthCents: 29999 },
  "ai-followup": { product: "ai-followup", type: "addon", monthCents: 9999 },
  "ai-pack": { product: "ai-pack", type: "bundle", monthCents: 39999, yearCents: 39999 * TEN_MONTHS },

  /* ── Add-ons (featured group first, then the rest) ───────────────────── */
  localseo: { product: "localseo", type: "addon", monthCents: 15999, yearCents: 15999 * TEN_MONTHS },
  booking: { product: "booking", type: "addon", monthCents: 4999, yearCents: 4999 * TEN_MONTHS },
  review: { product: "review", type: "addon", monthCents: 9999, yearCents: 9999 * TEN_MONTHS },
  ecommerce: { product: "ecommerce", type: "addon", monthCents: 5999, yearCents: 5999 * TEN_MONTHS },
  aichat: { product: "aichat", type: "addon", monthCents: 9999, yearCents: 9999 * TEN_MONTHS },
  blog: { product: "blog", type: "addon", monthCents: 3499, yearCents: 3499 * TEN_MONTHS },
  email: { product: "email", type: "addon", monthCents: 2999, yearCents: 2999 * TEN_MONTHS },
  report: { product: "report", type: "addon", monthCents: 2999, yearCents: 2999 * TEN_MONTHS },
  extrapage: { product: "extrapage", type: "addon", oneTimeCents: 4499 },
  priority: { product: "priority", type: "addon", monthCents: 5999, yearCents: 5999 * TEN_MONTHS },
  admin: { product: "admin", type: "addon", monthCents: 3999, yearCents: 3999 * TEN_MONTHS },
  quotephoto: { product: "quotephoto", type: "addon", monthCents: 999, yearCents: 999 * TEN_MONTHS },
} satisfies Record<string, CartProduct>;

/** Catalog keyed by product id (matches `t.pricing` ids and `pricing.ts`). */
export const cartProducts: Record<string, CartProduct> = catalog;

export type CartProductId = keyof typeof catalog;

/** True when the product can be billed on the given term. */
export function supportsBilling(product: CartProduct, billing: Billing): boolean {
  return billing === "year" ? typeof product.yearCents === "number" : typeof product.monthCents === "number";
}

/** Base (non-yearly) interval for a product, as rendered on the pricing page. */
export function baseInterval(product: CartProduct): "month" | "one-time" {
  return product.oneTimeCents !== undefined && product.monthCents === undefined ? "one-time" : "month";
}

/**
 * Interval a product is purchased on given the active billing term. One-time
 * products stay one-time; recurring products follow the term.
 */
export function intervalFor(productId: string, billing: Billing): CartInterval {
  const product = cartProducts[productId];
  if (!product) return billing; // unknown product: still produce a valid key
  if (baseInterval(product) === "one-time") return "one-time";
  return billing;
}

/** Price in cents for a product on an interval, or undefined if unavailable. */
export function priceCentsFor(productId: string, interval: CartInterval): number | undefined {
  const product = cartProducts[productId];
  if (!product) return undefined;
  if (interval === "one-time") return product.oneTimeCents;
  if (interval === "year") return product.yearCents;
  return product.monthCents;
}

/** Price in cents for a product on a billing term (one-time stays one-time). */
export function priceCentsForBilling(productId: string, billing: Billing): number | undefined {
  return priceCentsFor(productId, intervalFor(productId, billing));
}

/**
 * Every `{product}-{interval}` key this catalog can put in a cart. Used by the
 * parity test against the Stripe price map.
 */
export function cartCatalogKeys(): string[] {
  const keys: string[] = [];
  for (const product of Object.values(cartProducts)) {
    if (product.monthCents !== undefined) keys.push(cartKey(product.product, "month"));
    if (product.yearCents !== undefined) keys.push(cartKey(product.product, "year"));
    if (product.oneTimeCents !== undefined) keys.push(cartKey(product.product, "one-time"));
  }
  return keys;
}

/**
 * Re-price recurring items onto `billing`.
 *
 * Stripe Checkout refuses to mix monthly and yearly recurring prices in one
 * session ("Checkout does not support multiple prices with different billing
 * intervals"), so a cart always carries a single term. Switching the term
 * converts whatever is already in the cart instead of breaking checkout.
 */
export function convertItemsToBilling<T extends { product: string; key: string; interval: CartInterval; priceCents: number }>(
  items: T[],
  billing: Billing,
): T[] {
  return items.map((item) => {
    if (item.interval === "one-time") return item;
    const interval = intervalFor(item.product, billing);
    const priceCents = priceCentsFor(item.product, interval);
    // A product with no price on the target term (e.g. the monthly-only
    // Ads Pack on a yearly cart) keeps its current interval and price.
    if (priceCents === undefined) return item;
    if (interval === item.interval && (priceCents === undefined || priceCents === item.priceCents)) return item;
    return {
      ...item,
      key: cartKey(item.product, interval),
      interval,
      priceCents: priceCents ?? item.priceCents,
    };
  });
}
