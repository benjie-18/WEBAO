// Stripe Embedded Checkout session creation.
// POST /api/checkout/session
// Body: { email?: string, name?: string, business?: string, locale?: "fr",
//         items?: Array<{ key: string }> }
// Returns: { ok: true, clientSecret, mode, lineItems } or { ok: false, error }
//
// The cart (src/lib/cart-catalog.ts) sends one key per selected product:
// `${product}-${interval}` with interval = month | year | one-time.
// Two Stripe rules shape this handler:
//  1. a session can mix recurring and one-time prices (mixed cart), but every
//     recurring price must share the same billing interval, so monthly and
//     yearly items can never be combined;
//  2. mode must be "subscription" as soon as one recurring price is present,
//     and "payment" when the cart is one-time only.

import { EMAIL_RE, isTestMode, json, err, originAllowed } from "./util";
import { findConflicts, type CartConflict, type RuleItem } from "../src/lib/cart-rules";

/** Website plans, the only products with type "plan" for the rules. */
const PLAN_PRODUCTS = new Set(["launch", "grow", "scale"]);

/**
 * Stripe coupon for the Website touchup discount: 15% off any
 * subscription for the first 3 months, one use only. The coupon's Stripe
 * id IS the code, and it is applied directly by coupon id below: no
 * promotion-code object exists in Stripe, so a buyer typing the code
 * could not redeem it.
 */
const TOUCHUP_COUPON_ID = "WEBAOFIXIT15";

/** Display names for the products the cart rules can mention. */
const PRODUCT_NAMES: Record<string, string> = {
  launch: "Launch",
  grow: "Grow",
  scale: "Scale",
  quotephoto: "Quote Photo Upload",
  review: "Review Generation Engine",
  booking: "Online Booking",
  report: "Monthly Growth Report",
  admin: "Advanced Admin Panel",
  "lead-pack": "Lead Pack",
  "visibility-pack": "Visibility Pack",
  "growth-bundle": "Growth Bundle",
  "growth-engine": "Growth Engine",
  "seo-blog": "Weekly SEO Blog",
  localseo: "Local SEO Management",
  aichat: "Online Receptionist",
  "ai-pack": "AI Pack",
  "ai-receptionist": "AI Receptionist",
  "ai-followup": "AI Follow-up",
  "ads-pack": "Ads Pack",
  "ads-meta": "Meta",
  "ads-google": "Google",
  "ads-both": "Meta and Google",
  "ads-starter": "Starter test",
};

function productName(product: string): string {
  return PRODUCT_NAMES[product] ?? product;
}

/** Cart keys to the rule engine's items. */
function toRuleItems(items: ResolvedItem[]): RuleItem[] {
  return items
    .filter((item) => item.key !== LEGACY_KEY)
    .map((item) => {
      const product = item.key.replace(/-(month|year|onetime)$/, "");
      return {
        product,
        interval: item.interval,
        type: PLAN_PRODUCTS.has(product) ? ("plan" as const) : ("addon" as const),
      };
    });
}

/** One short error for a cart conflict (the UI guards prevent these, so this is the backstop for crafted requests). */
function conflictError(conflict: CartConflict): string {
  switch (conflict.kind) {
    case "ads-two":
      return "Choose one Ads Pack option: Meta, Google, both together, or the Starter test. Buying two Ads options together is not allowed.";
    case "ai-pack":
      return "The AI Pack already includes AI Receptionist, Online Receptionist and AI Follow-up. Buy the pack on its own, or the individual services on their own.";
    case "mixed-intervals":
      return "Monthly and yearly items can't be paid in the same checkout. Choose one billing term in your cart.";
    case "two-plans":
      return "Only one website plan can be bought at a time.";
    case "included":
      return `${productName(conflict.component ?? "")} is already included in ${productName(conflict.plan ?? "")}.`;
    case "not-available":
      return `${productName(conflict.component ?? "")} isn't available with ${productName(conflict.plan ?? "")}.`;
    case "bundle-component":
      return `${productName(conflict.bundle ?? "")} already includes ${(conflict.components ?? [conflict.component ?? ""]).map((c) => productName(c)).join(", ")}.`;
    case "bundle-overlap":
      return `${conflict.products.map((p) => productName(p)).join(" and ")} both include the Review Generation Engine.`;
  }
}

type Env = {
  STRIPE_SECRET_KEY?: string;
  /** "1" on the test worker: checkout is disabled. */
  TEST_MODE?: string;
  STRIPE_PRICE_ID?: string;
  WEBAO_KV?: KVNamespace;
  ALLOWED_ORIGINS?: string;
};

/**
 * Stripe Price IDs for cart items.
 * Key format: "{product}-{interval}", e.g. "launch-month", "grow-year",
 * "extrapage-onetime" (the cart also produces "extrapage-one-time"; both
 * spellings resolve here, see `normalizeKey`).
 */
export const PRICE_MAP: Record<string, string> = {
  "admin-month": "price_1UO3EeE57vVzxI41Vv1DW6l5",
  "admin-year": "price_1UORSCE57vVzxI4182C4kxPY",
  "ads-pack-month": "price_1UehSsE57vVzxI41YRVxMPDX", // C$649.99 (was price_1UTsvJE57vVzxI41esicPXuU at C$899.99; left active for existing subscribers)
  // Revamped Ads Pack: one channel (Meta or Google) shares the single price;
  // both channels together use the bundle price. The cart key, not the
  // Stripe price, records which channel was bought (see metadata[items]).
  "ads-meta-month": "price_1UehSsE57vVzxI41YRVxMPDX",
  "ads-google-month": "price_1UehSsE57vVzxI41YRVxMPDX",
  "ads-both-month": "price_1UehSxE57vVzxI41pWl9IpPw", // C$999.99 (was price_1UWkEsE57vVzxI41TxD7CIV8 at C$1,349.99; left active for existing subscribers)
  // Starter test, Meta only, monthly only (no yearly price exists).
  "ads-starter-month": "price_1UehSxE57vVzxI41pKmaaoX3", // C$399.99 (was price_1UZeIQE57vVzxI41l33CkUsv at C$499.99; left active for existing subscribers)
  "gbp-revamp-onetime": "price_1UWkF9E57vVzxI41yOVeWE6d",
  "website-touchup-onetime": "price_1UYeOrE57vVzxI41H43kyjyk",
  "aichat-month": "price_1UeyzgE57vVzxI41H7auoA46", // C$149.99 (was price_1UO3E9E57vVzxI41BTXxcMD6 at C$99.99; left active for existing subscribers)
  "aichat-year": "price_1UeyzjE57vVzxI41rrQlSEr0", // C$1,499.90/yr (10x monthly, 2 months free; was price_1UORS1E57vVzxI41852FAJaZ at C$999.90)
  "blog-month": "price_1UeyfRE57vVzxI417Z4rUdQ7", // C$19.99 (was price_1UO3EGE57vVzxI41cXVWgJ1y at C$34.99; left active for existing subscribers)
  "blog-year": "price_1UeyfUE57vVzxI41BTfeA7w1", // C$199.90/yr (10x monthly, 2 months free; was price_1UORS3E57vVzxI41kUmsBh6T at C$349.90)
  "booking-month": "price_1UO3EDE57vVzxI41DW2cPjrK",
  "booking-year": "price_1UORRuE57vVzxI41LYVqAv9t",
  "ecommerce-month": "price_1UO3EOE57vVzxI415R4cIVHK",
  "ecommerce-year": "price_1UORRyE57vVzxI41y92Z2WcT",
  "email-month": "price_1UO3ESE57vVzxI41ECsPlnDX",
  "email-year": "price_1UORS6E57vVzxI41jw4erVLl",
  "extrapage-onetime": "price_1UeyfME57vVzxI410VF1wMZl", // C$14.99 (was price_1UO3EZE57vVzxI41D69ub1aS at C$44.99; left active for existing subscribers)
  "grow-month": "price_1UO3EqE57vVzxI41zCNE535n",
  "grow-year": "price_1UU1M7E57vVzxI41S5AANteS",
  "launch-month": "price_1UO3NhE57vVzxI41BeElAQVZ",
  "launch-year": "price_1UU1M4E57vVzxI41E0mPbwdV",
  "lead-pack-month": "price_1UehJmE57vVzxI41lySHr788", // C$499.99 (was price_1UO3DwE57vVzxI41q2jb3Rxo at C$239.99; left active for existing subscribers)
  "lead-pack-year": "price_1UehJsE57vVzxI41aj155qlY", // C$4,999.90/yr (10x monthly, 2 months free)
  // Growth bundles. The Growth Bundle is yearly available too; the Growth
  // Engine is monthly only (it contains the monthly-only Ads Starter test).
  "growth-bundle-month": "price_1UehYmE57vVzxI41QKo59uIY", // C$549.99
  "growth-bundle-year": "price_1UehYtE57vVzxI41YXqOH5JL", // C$5,499.90/yr (10x monthly, 2 months free)
  "growth-engine-month": "price_1UehYuE57vVzxI41pE84Almc", // C$899.99, monthly only
  "localseo-month": "price_1UO3E2E57vVzxI41T6FkSLJp",
  "localseo-year": "price_1UORRsE57vVzxI41DIqBnkzB",
  "priority-month": "price_1UO3EbE57vVzxI41kSjNOFtX",
  "priority-year": "price_1UORSAE57vVzxI41D9kbp8qX",
  "quotephoto-month": "price_1UO3EiE57vVzxI41L9XusxPa",
  "quotephoto-year": "price_1UORSEE57vVzxI41fZMW2qXR",
  "report-month": "price_1UO3EVE57vVzxI41eNT4NoDf",
  "report-year": "price_1UORS8E57vVzxI417LKUJ98z",
  "review-month": "price_1UeyzYE57vVzxI41WishPNJs", // C$349.99 (was price_1UehJbE57vVzxI41rOygD4gP at C$399.99; left active for existing subscribers)
  "review-year": "price_1UeyzbE57vVzxI41KAllDjkX", // C$3,499.90/yr (10x monthly, 2 months free; was price_1UehJmE57vVzxI41vNPEBtnH at C$3,999.90)
  // Weekly SEO Blog: a new SEO post every week, written for the business.
  "seo-blog-month": "price_1UeyfZE57vVzxI41sCSUZlIv", // C$29.99 (was price_1UehYnE57vVzxI41lnpsdwJW at C$39.99; left active for existing subscribers)
  "seo-blog-year": "price_1UeyfcE57vVzxI41vYgSKqvS", // C$299.90/yr (10x monthly, 2 months free; was price_1UehYtE57vVzxI41Zz97BMiE at C$399.90)
  "scale-month": "price_1UO3DtE57vVzxI41h8bSDqZd",
  "scale-year": "price_1UU1M8E57vVzxI419tR3a3Gy",
  "visibility-pack-month": "price_1UehJsE57vVzxI41zns1Z4ma", // C$349.99 (was price_1UO3DzE57vVzxI4199bDK2uj at C$99.99; left active for existing subscribers)
  // AI services. All three are yearly available too (10x monthly,
  // 2 months free), like the AI Pack. No setup fee on any AI service.
  "ai-receptionist-month": "price_1UYFX9E57vVzxI41tORfQmiE",
  "ai-receptionist-year": "price_1UezyQE57vVzxI41nUaR5c5W", // C$2,999.90/yr (10x monthly, 2 months free)
  "ai-followup-month": "price_1UYFXJE57vVzxI41rtocXmsu",
  "ai-followup-year": "price_1UezyUE57vVzxI41x4ty5TIo", // C$999.90/yr (10x monthly, 2 months free)
  "ai-pack-month": "price_1UZg5vE57vVzxI41U5J4rBPd", // C$399.99 (was price_1UYFXOE57vVzxI41aR00rKZe at C$449.99; left active for existing subscribers)
  "ai-pack-year": "price_1UZhOPE57vVzxI41KxH5xHzf", // C$3,999.90/yr (10x monthly, 2 months free)
  "visibility-pack-year": "price_1UehJwE57vVzxI41unkN2eaa", // C$3,499.90/yr (10x monthly, 2 months free)
};

/** Key used by flows that have no cart (the /start form): the $149 plan. */
const LEGACY_KEY = "__legacy__";

/** Stripe Checkout limits for subscription mode. */
const MAX_RECURRING_ITEMS = 20;
const MAX_ONE_TIME_ITEMS = 20;
/** Hard cap on keys accepted from a request. */
const MAX_REQUESTED_ITEMS = 40;

type LineInterval = "month" | "year" | "one-time";

interface ResolvedItem {
  key: string;
  priceId: string;
  interval: LineInterval;
}

/** Cart keys are `${product}-${interval}`; "one-time" and "onetime" are equal. */
export function normalizeKey(key: string): string {
  return key.trim().toLowerCase().replace(/-one-time$/, "-onetime");
}

/** Interval encoded in a cart key. */
export function intervalOf(key: string): LineInterval {
  if (key.endsWith("-year")) return "year";
  if (key.endsWith("-month")) return "month";
  return "one-time";
}


export async function handleCheckoutSession(req: Request, env: Env): Promise<Response> {
  if (!originAllowed(req, true, env)) return err("Forbidden origin", 403);
  if (isTestMode(env)) return err("Checkout is disabled on the test site", 503);

  let body: {
    email?: string;
    name?: string;
    business?: string;
    locale?: string;
    items?: Array<{ key?: string }>;
  } = {};
  try {
    body = await req.json();
  } catch {
    // empty body is fine (legacy /start flow)
  }

  if (body.email && !EMAIL_RE.test(body.email.trim())) {
    return err("Invalid email");
  }

  const secretKey = env.STRIPE_SECRET_KEY;
  const legacyPriceId = env.STRIPE_PRICE_ID;
  const sentItems = Array.isArray(body.items) && body.items.length > 0;

  // ── Resolve the cart into Stripe line items ────────────────────────────
  let lineItems: ResolvedItem[] = [];
  if (sentItems) {
    const keys = [
      ...new Set(
        (body.items as Array<{ key?: string }>)
          .slice(0, MAX_REQUESTED_ITEMS)
          .map((item) => (typeof item?.key === "string" ? normalizeKey(item.key) : ""))
          .filter((key) => key !== ""),
      ),
    ];

    const unknown: string[] = [];
    for (const key of keys) {
      const priceId = key === LEGACY_KEY ? legacyPriceId : PRICE_MAP[key];
      if (!priceId) {
        unknown.push(key);
        continue;
      }
      lineItems.push({ key, priceId, interval: intervalOf(key) });
    }

    // Never silently drop a paid item: the customer would be charged less than
    // the cart showed.
    if (unknown.length > 0) {
      return err(
        `Some items are no longer available (${unknown.slice(0, 5).join(", ")}). Refresh the pricing page and try again.`,
        400,
      );
    }
    if (lineItems.length === 0) {
      return json({ ok: false, error: "No valid items in cart" }, 400);
    }
    if (lineItems.length > MAX_RECURRING_ITEMS + MAX_ONE_TIME_ITEMS) {
      return err(`Too many items (max ${MAX_RECURRING_ITEMS + MAX_ONE_TIME_ITEMS})`, 400);
    }
  } else {
    // Legacy path: /start and /fr/commencer post customer details only.
    if (!legacyPriceId) {
      return json({ ok: false, error: "Checkout not configured" }, 503);
    }
    lineItems = [{ key: LEGACY_KEY, priceId: legacyPriceId, interval: "month" }];
  }

  // Cart conflicts, same rules as the UI guards (src/lib/cart-rules.ts):
  // the UI stops these combinations from being added, but a crafted
  // request could still send them, so the server rejects them too.
  // The old per-rule checks (two Ads options, AI Pack + individual,
  // mixed intervals) are the same rules, now in one place.
  const conflicts = findConflicts(toRuleItems(lineItems));
  if (conflicts.length > 0) {
    return err(conflictError(conflicts[0]), 400);
  }

  const recurring = lineItems.filter((item) => item.interval !== "one-time");

  if (
    lineItems.filter((item) => item.interval !== "one-time").length > MAX_RECURRING_ITEMS ||
    lineItems.filter((item) => item.interval === "one-time").length > MAX_ONE_TIME_ITEMS
  ) {
    return err("Too many items in one checkout", 400);
  }

  if (!secretKey) {
    return json({ ok: false, error: "Checkout not configured" }, 503);
  }

  // No in-worker throttle here: every throttle check is a KV write.
  // The edge rate-limit rule ("WEBAO track rate limit") covers
  // /api/checkout/* at 20 requests per 10 s per IP, which is the
  // per-IP cap for session creation (abuse would otherwise clutter
  // the Stripe dashboard).

  const url = new URL(req.url);
  const origin = `${url.protocol}//${url.host}`;
  const isFr = url.pathname.startsWith("/fr/") || body.locale === "fr";
  const returnPath = isFr ? "/fr/checkout/success" : "/checkout/success";
  const mode = recurring.length > 0 ? "subscription" : "payment";

  // Build form-encoded body for Stripe API
  const params = new URLSearchParams();
  params.set("ui_mode", "embedded_page");
  params.set("mode", mode);
  // Let the buyer enter a coupon code at checkout. The touchup coupon is
  // NOT entered this way: when the cart holds a Website touchup and a
  // subscription, it is applied automatically below (no promotion-code
  // object exists in Stripe for it, so typing the code would fail).
  params.set("allow_promotion_codes", "true");

  // Website touchup + subscription in the same cart: the 15% off the
  // touchup unlocks is applied automatically, no code needed. The discount
  // cannot be combined with other offers, so promotion codes are disabled
  // for this session, and metadata records it so the code is not also
  // sent to the buyer afterwards (they already got the discount).
  if (lineItems.some((item) => item.key === "website-touchup-onetime") && mode === "subscription") {
    params.set("discounts[0][coupon]", TOUCHUP_COUPON_ID);
    params.set("allow_promotion_codes", "false");
    params.set("metadata[touchup_discount]", "auto");
  }

  lineItems.forEach((item, index) => {
    params.set(`line_items[${index}][price]`, item.priceId);
    params.set(`line_items[${index}][quantity]`, "1");
  });
  // Ask Stripe for the priced line items so the checkout page can show the
  // amounts that will actually be charged.
  params.append("expand[]", "line_items");

  params.set("return_url", `${origin}${returnPath}?session_id={CHECKOUT_SESSION_ID}`);
  if (body.email) params.set("customer_email", body.email);
  const reference = body.business || body.name;
  if (reference) {
    // Store for reference in the Stripe dashboard (subscription_data only
    // exists for subscriptions; payment sessions carry a PaymentIntent).
    const description = `WEBAO site for ${reference}`;
    if (mode === "subscription") params.set("subscription_data[description]", description);
    else params.set("payment_intent_data[description]", description);
  }
  // Which products this session was built from, for the Stripe dashboard.
  params.set("metadata[items]", lineItems.map((item) => item.key).join(",").slice(0, 480));
  // The buyer's language, read back by the webhook (welcome email, and the
  // abandoned-checkout follow-up if the session expires): the checkout page
  // posts its locale directly, so prefer it; the referer is the fallback
  // for callers that do not send one. A stripped referer used to default
  // a French buyer to English mail.
  const referer = req.headers.get("referer") || "";
  params.set("metadata[lang]", body.locale === "fr" || referer.includes("/fr/") ? "fr" : "en");

  let stripeRes: Response;
  try {
    stripeRes = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });
  } catch (e) {
    return json({ ok: false, error: "Payment service unreachable" }, 502);
  }

  const data = (await stripeRes.json()) as {
    client_secret?: string;
    line_items?: {
      data?: Array<{
        description?: string | null;
        amount_subtotal?: number | null;
        amount_total?: number | null;
        currency?: string | null;
        price?: { recurring?: { interval?: string } | null } | null;
      }>;
    };
    error?: { message?: string };
  };
  if (!stripeRes.ok || !data.client_secret) {
    const msg = data?.error?.message || "Could not start checkout";
    return json({ ok: false, error: msg }, 502);
  }

  // The post-discount total is what will actually be charged: the
  // subtotal is pre-discount, so a session with a coupon (the touchup
  // auto-discount, or a buyer-entered promotion code) would otherwise
  // show the full price on the checkout page while Stripe charges less.
  const pricedItems = (data.line_items?.data ?? []).map((item) => ({
    description: item.description ?? "",
    amount:
      typeof item.amount_total === "number"
        ? item.amount_total
        : typeof item.amount_subtotal === "number"
          ? item.amount_subtotal
          : null,
    currency: item.currency ?? "cad",
    interval: item.price?.recurring?.interval ?? "one-time",
  }));

  return json({ ok: true, clientSecret: data.client_secret, mode, lineItems: pricedItems });
}
