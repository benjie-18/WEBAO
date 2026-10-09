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

import { json, err, originAllowed, clientIp } from "./util";
import { throttle } from "./auth";

type Env = {
  STRIPE_SECRET_KEY?: string;
  STRIPE_PRICE_ID?: string;
  WEBAO_KV?: KVNamespace;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Stripe Price IDs for cart items.
 * Key format: "{product}-{interval}", e.g. "launch-month", "grow-year",
 * "extrapage-onetime" (the cart also produces "extrapage-one-time"; both
 * spellings resolve here, see `normalizeKey`).
 */
export const PRICE_MAP: Record<string, string> = {
  "admin-month": "price_1UO3EeE57vVzxI41Vv1DW6l5",
  "admin-year": "price_1UORSCE57vVzxI4182C4kxPY",
  "aichat-month": "price_1UO3E9E57vVzxI41BTXxcMD6",
  "aichat-year": "price_1UORS1E57vVzxI41852FAJaZ",
  "bilingual-month": "price_1UO3ELE57vVzxI41ULR08WMo",
  "bilingual-year": "price_1UORS0E57vVzxI416ovrRT8G",
  "blog-month": "price_1UO3EGE57vVzxI41cXVWgJ1y",
  "blog-year": "price_1UORS3E57vVzxI41kUmsBh6T",
  "booking-month": "price_1UO3EDE57vVzxI41DW2cPjrK",
  "booking-year": "price_1UORRuE57vVzxI41LYVqAv9t",
  "ecommerce-month": "price_1UO3EOE57vVzxI415R4cIVHK",
  "ecommerce-year": "price_1UORRyE57vVzxI41y92Z2WcT",
  "email-month": "price_1UO3ESE57vVzxI41ECsPlnDX",
  "email-year": "price_1UORS6E57vVzxI41jw4erVLl",
  "extrapage-onetime": "price_1UO3EZE57vVzxI41D69ub1aS",
  "grow-month": "price_1UO3EqE57vVzxI41zCNE535n",
  "grow-year": "price_1UORRkE57vVzxI41B37kz7ug",
  "launch-month": "price_1UO3NhE57vVzxI41BeElAQVZ",
  "launch-year": "price_1UORRiE57vVzxI41vcoZT3Zl",
  "lead-pack-month": "price_1UO3DwE57vVzxI41q2jb3Rxo",
  "lead-pack-year": "price_1UORRoE57vVzxI41BenDkCDZ",
  "localseo-month": "price_1UO3E2E57vVzxI41T6FkSLJp",
  "localseo-year": "price_1UORRsE57vVzxI41DIqBnkzB",
  "priority-month": "price_1UO3EbE57vVzxI41kSjNOFtX",
  "priority-year": "price_1UORSAE57vVzxI41D9kbp8qX",
  "quotephoto-month": "price_1UO3EiE57vVzxI41L9XusxPa",
  "quotephoto-year": "price_1UORSEE57vVzxI41fZMW2qXR",
  "report-month": "price_1UO3EVE57vVzxI41eNT4NoDf",
  "report-year": "price_1UORS8E57vVzxI417LKUJ98z",
  "review-month": "price_1UO3E6E57vVzxI41JJ7znxzO",
  "review-year": "price_1UORRwE57vVzxI41ubO4Q6qM",
  "scale-month": "price_1UO3DtE57vVzxI41h8bSDqZd",
  "scale-year": "price_1UORRmE57vVzxI41XxRs6AT2",
  "visibility-pack-month": "price_1UO3DzE57vVzxI4199bDK2uj",
  "visibility-pack-year": "price_1UORRqE57vVzxI41BDPCliaR",
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

  // Checkout refuses sessions mixing several billing intervals, so reject
  // instead of letting Stripe return an opaque error.
  const recurring = lineItems.filter((item) => item.interval !== "one-time");
  const oneTime = lineItems.filter((item) => item.interval === "one-time");
  if (new Set(recurring.map((item) => item.interval)).size > 1) {
    return err(
      "Monthly and yearly items can't be paid in the same checkout. Choose one billing term in your cart.",
      400,
    );
  }
  if (recurring.length > MAX_RECURRING_ITEMS || oneTime.length > MAX_ONE_TIME_ITEMS) {
    return err("Too many items in one checkout", 400);
  }

  if (!secretKey) {
    return json({ ok: false, error: "Checkout not configured" }, 503);
  }

  // Rate-limit session creation per IP (abuse would clutter the Stripe dashboard).
  if (env.WEBAO_KV) {
    const ip = clientIp(req);
    if (!(await throttle(env.WEBAO_KV, "checkout", ip, 10))) {
      return err("Too many requests", 429);
    }
  }

  const url = new URL(req.url);
  const origin = `${url.protocol}//${url.host}`;
  const isFr = url.pathname.startsWith("/fr/") || body.locale === "fr";
  const returnPath = isFr ? "/fr/checkout/success" : "/checkout/success";
  const mode = recurring.length > 0 ? "subscription" : "payment";

  // Build form-encoded body for Stripe API
  const params = new URLSearchParams();
  params.set("ui_mode", "embedded_page");
  params.set("mode", mode);

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

  const pricedItems = (data.line_items?.data ?? []).map((item) => ({
    description: item.description ?? "",
    amount:
      typeof item.amount_subtotal === "number"
        ? item.amount_subtotal
        : typeof item.amount_total === "number"
          ? item.amount_total
          : null,
    currency: item.currency ?? "cad",
    interval: item.price?.recurring?.interval ?? "one-time",
  }));

  return json({ ok: true, clientSecret: data.client_secret, mode, lineItems: pricedItems });
}
