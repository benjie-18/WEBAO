// Stripe Embedded Checkout session creation.
// POST /api/checkout/session
// Body: { email?: string, name?: string, business?: string }
// Returns: { ok: true, clientSecret } or { ok: false, error }

import { json } from "./util";

type Env = {
  STRIPE_SECRET_KEY?: string;
  STRIPE_PRICE_ID?: string;
};

export async function handleCheckoutSession(req: Request, env: Env): Promise<Response> {
  const secretKey = env.STRIPE_SECRET_KEY;
  const priceId = env.STRIPE_PRICE_ID;

  if (!secretKey || !priceId) {
    return json({ ok: false, error: "Checkout not configured" }, 503);
  }

  let body: { email?: string; name?: string; business?: string } = {};
  try {
    body = await req.json();
  } catch {
    // empty body is fine
  }

  const url = new URL(req.url);
  const origin = `${url.protocol}//${url.host}`;
  const isFr = url.pathname.startsWith("/fr/") || (body as { locale?: string }).locale === "fr";
  const returnPath = isFr ? "/fr/checkout/success" : "/checkout/success";

  // Build form-encoded body for Stripe API
  const params = new URLSearchParams();
  params.set("ui_mode", "embedded");
  params.set("mode", "subscription");
  params.set("line_items[0][price]", priceId);
  params.set("line_items[0][quantity]", "1");
  params.set("return_url", `${origin}${returnPath}?session_id={CHECKOUT_SESSION_ID}`);
  if (body.email) params.set("customer_email", body.email);
  if (body.business || body.name) {
    // Store for reference in the Stripe dashboard
    params.set("subscription_data[description]", `WEBAO site for ${body.business || body.name || "new client"}`);
  }

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

  const data = (await stripeRes.json()) as { client_secret?: string; error?: { message?: string } };
  if (!stripeRes.ok || !data.client_secret) {
    const msg = data?.error?.message || "Could not start checkout";
    return json({ ok: false, error: msg }, 502);
  }

  return json({ ok: true, clientSecret: data.client_secret });
}
