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

import { EMAIL_RE, json, err, originAllowed } from "./util";
import { findConflicts, type CartConflict, type RuleItem } from "../src/lib/cart-rules";

/** Website plans, the only products with type "plan" for the rules. */
const PLAN_PRODUCTS = new Set(["launch", "grow", "scale"]);

/**
 * Stripe coupon for the Website touchup discount: 10% off any
 * subscription for the first 3 months, one use only. The coupon's Stripe
 * id IS the code, and it is applied directly by coupon id below: no
 * promotion-code object exists in Stripe, so a buyer typing the code
 * could not redeem it.
 */
const TOUCHUP_COUPON_ID = "WEBAOFIXIT3256";

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
  localseo: "Local SEO Management",
  aichat: "Trained AI Chat Assistant",
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

/** Cart keys to the rule engine's items (setup keys pass through: no rule fires on them). */
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
      return "The AI Pack already includes AI Receptionist, Trained AI Chat Assistant and AI Follow-up. Buy the pack on its own, or the individual services on their own.";
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
      return "Lead Pack and Visibility Pack both include the Review Generation Engine.";
  }
}

type Env = {
  STRIPE_SECRET_KEY?: string;
  STRIPE_PRICE_ID?: string;
  /** Ads Pack: the monthly price is in PRICE_MAP below. The one-time setup
   *  price stays a secret because it is not a catalog item: checkout adds it
   *  server-side and it cannot be bought on its own. STRIPE_PRICE_ADS_PACK
   *  remains only as a fallback if the price-map entry is ever removed. */
  STRIPE_PRICE_ADS_PACK?: string;
  STRIPE_PRICE_ADS_SETUP?: string;
  /** Both-channels setup price. Falls back to the bundle setup price in
   *  code when unset, so a missing secret never silently drops the fee. */
  STRIPE_PRICE_ADS_BUNDLE_SETUP?: string;
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
  "ads-pack-month": "price_1UTsvJE57vVzxI41esicPXuU",
  // Revamped Ads Pack: one channel (Meta or Google) shares the single price;
  // both channels together use the bundle price. The cart key, not the
  // Stripe price, records which channel was bought (see metadata[items]).
  "ads-meta-month": "price_1UTsvJE57vVzxI41esicPXuU",
  "ads-google-month": "price_1UTsvJE57vVzxI41esicPXuU",
  "ads-both-month": "price_1UWkEsE57vVzxI41TxD7CIV8",
  // Starter test, Meta only, monthly only (no yearly price exists).
  "ads-starter-month": "price_1UZeIQE57vVzxI41l33CkUsv",
  "gbp-revamp-onetime": "price_1UWkF9E57vVzxI41yOVeWE6d",
  "website-touchup-onetime": "price_1UYeOrE57vVzxI41H43kyjyk",
  "aichat-month": "price_1UO3E9E57vVzxI41BTXxcMD6",
  "aichat-year": "price_1UORS1E57vVzxI41852FAJaZ",
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
  "grow-year": "price_1UU1M7E57vVzxI41S5AANteS",
  "launch-month": "price_1UO3NhE57vVzxI41BeElAQVZ",
  "launch-year": "price_1UU1M4E57vVzxI41E0mPbwdV",
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
  "scale-year": "price_1UU1M8E57vVzxI419tR3a3Gy",
  "visibility-pack-month": "price_1UO3DzE57vVzxI4199bDK2uj",
  // AI services, monthly only. Setup fees are NOT in this map: the
  // parity test requires every map key to be a catalog key, and setups
  // are not catalog items. They ride along server-side below, following
  // the Ads Pack setup pattern.
  "ai-receptionist-month": "price_1UYFX9E57vVzxI41tORfQmiE",
  "ai-followup-month": "price_1UYFXJE57vVzxI41rtocXmsu",
  "ai-pack-month": "price_1UZg5vE57vVzxI41U5J4rBPd", // C$399.99 (was price_1UYFXOE57vVzxI41aR00rKZe at C$449.99; left active for existing subscribers)
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

/** Cart keys for a monthly Ads Pack, single channel or both together. */
const ADS_MONTHLY_KEYS = ["ads-pack-month", "ads-meta-month", "ads-google-month", "ads-both-month"];
/** Starter test monthly key: a separate Ads option, never a second pack. */
const ADS_STARTER_MONTHLY_KEY = "ads-starter-month";
/** Both-channels setup price (Stripe), used when no bundle-setup secret is set. */
const ADS_BUNDLE_SETUP_PRICE = "price_1UWkEvE57vVzxI41jrWbtpuZ";
/** Starter test setup price (Stripe): C$349.99 one-time, not the C$499.99
 *  Core setup. Hard-coded like the AI setup prices so a missing secret
 *  cannot silently undercharge. */
const ADS_STARTER_SETUP_PRICE = "price_1UZeIVE57vVzxI41VXckzjG2";
/** AI services: monthly cart key -> one-time setup price (Stripe).
 *  Kept out of PRICE_MAP on purpose (see the comment above): setups are
 *  added server-side and can never be bought on their own. */
const AI_SETUPS: Array<{ monthly: string; setupKey: string; setupPriceId: string }> = [
  { monthly: "ai-receptionist-month", setupKey: "ai-receptionist-setup-onetime", setupPriceId: "price_1UYFXDE57vVzxI41cwShDW7k" },
  { monthly: "ai-followup-month", setupKey: "ai-followup-setup-onetime", setupPriceId: "price_1UYFXNE57vVzxI417TlokH2v" },
  { monthly: "ai-pack-month", setupKey: "ai-pack-setup-onetime", setupPriceId: "price_1UYFXSE57vVzxI41Qx20HwYn" },
];

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
      const priceId =
        key === LEGACY_KEY
          ? legacyPriceId
          : PRICE_MAP[key] ??
            (key === "ads-pack-month"
              ? env.STRIPE_PRICE_ADS_PACK
              : key === "ads-setup-onetime"
                ? env.STRIPE_PRICE_ADS_SETUP
                : undefined);
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

  // The setup fee cannot be bought on its own: a crafted request with only
  // ads-setup-onetime used to create a checkout for a setup with no pack
  // attached (and no ads state, since hasAdsPack matches ads-pack*).
  if (
    lineItems.some((item) => item.key === "ads-setup-onetime") &&
    !lineItems.some((item) => ADS_MONTHLY_KEYS.includes(item.key))
  ) {
    return err("The Ads Pack setup fee cannot be bought on its own", 400);
  }

  if (
    lineItems.some((item) => item.key === "ads-starter-setup-onetime") &&
    !lineItems.some((item) => item.key === ADS_STARTER_MONTHLY_KEY)
  ) {
    return err("The Starter test setup fee cannot be bought on its own", 400);
  }

  // An AI setup fee cannot be bought on its own, same rule as Ads.
  for (const setup of AI_SETUPS) {
    if (
      lineItems.some((item) => item.key === setup.setupKey) &&
      !lineItems.some((item) => item.key === setup.monthly)
    ) {
      return err("An AI setup fee cannot be bought on its own", 400);
    }
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

  // Ads Pack: the one-time setup fee rides along automatically, added
  // server-side so it cannot be removed from the cart (single: the setup
  // secret; both: the bundle setup price). This runs BEFORE
  // the cap check, so a cart already at the one-time cap plus the pack is
  // rejected instead of leaving with 21 one-time items.
  // Both channels carry the bundle setup fee, never the single fee: the
  // bundle setup price is hard-coded as a fallback so a missing secret
  // cannot silently undercharge, matching how PRICE_MAP holds price ids.
  // Starter test: its own C$349.99 setup rides along automatically, added
  // server-side so it cannot be removed from the cart, following the Ads
  // Pack pattern. It never takes the C$499.99 Core setup below.
  if (
    lineItems.some((item) => item.key === ADS_STARTER_MONTHLY_KEY) &&
    !lineItems.some((item) => item.key === "ads-starter-setup-onetime")
  ) {
    lineItems.push({
      key: "ads-starter-setup-onetime",
      priceId: ADS_STARTER_SETUP_PRICE,
      interval: "one-time",
    });
  }
  if (
    lineItems.some((item) => item.key === "ads-both-month") &&
    !lineItems.some((item) => item.key === "ads-bundle-setup-onetime")
  ) {
    lineItems.push({
      key: "ads-bundle-setup-onetime",
      priceId: env.STRIPE_PRICE_ADS_BUNDLE_SETUP ?? ADS_BUNDLE_SETUP_PRICE,
      interval: "one-time",
    });
  } else if (
    env.STRIPE_PRICE_ADS_SETUP &&
    lineItems.some((item) => ADS_MONTHLY_KEYS.includes(item.key)) &&
    !lineItems.some((item) => item.key === "ads-setup-onetime")
  ) {
    lineItems.push({
      key: "ads-setup-onetime",
      priceId: env.STRIPE_PRICE_ADS_SETUP,
      interval: "one-time",
    });
  }
  // AI services: the one-time setup fee rides along automatically,
  // added server-side so it cannot be removed from the cart, following
  // the Ads Pack pattern. The pack carries the bundle setup fee, never
  // the three individual setup fees.
  for (const setup of AI_SETUPS) {
    if (
      lineItems.some((item) => item.key === setup.monthly) &&
      !lineItems.some((item) => item.key === setup.setupKey)
    ) {
      lineItems.push({
        key: setup.setupKey,
        priceId: setup.setupPriceId,
        interval: "one-time",
      });
    }
  }
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

  // Website touchup + subscription in the same cart: the 10% off the
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
  // abandoned-checkout follow-up if the session expires): the checkout POST
  // comes from the EN or FR pricing page, so the referer carries the locale.
  const referer = req.headers.get("referer") || "";
  params.set("metadata[lang]", referer.includes("/fr/") ? "fr" : "en");

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
