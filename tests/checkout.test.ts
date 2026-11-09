// Checkout API: the cart must become a correct Stripe Checkout Session.
// The Stripe call is stubbed, so these tests assert the exact parameters the
// Worker would send — including the yearly/monthly rules Stripe enforces.
import assert from 'node:assert/strict';
import test from 'node:test';
import { handleCheckoutSession, PRICE_MAP } from '../worker/checkout';

const SECRET = 'sk_test_123';
const PRICE_ID = 'price_legacy_149';

interface Captured {
  url: string;
  params: URLSearchParams;
  authorization: string | null;
}

/** Run the handler with a stubbed Stripe API that echoes priced line items. */
async function call(
  body: unknown,
  options: { env?: Record<string, unknown>; origin?: string | null; lineItems?: unknown[] } = {},
) {
  const calls: Captured[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const params = new URLSearchParams(String(init?.body ?? ''));
    calls.push({
      url: String(input),
      params,
      authorization: new Headers(init?.headers).get('authorization'),
    });
    const keys = [...params.keys()]
      .filter((key) => /^line_items\[\d+\]\[price\]$/.test(key))
      .sort()
      .map((key) => params.get(key) as string);
    return new Response(
      JSON.stringify({
        client_secret: 'cs_test_secret',
        line_items: {
          data:
            options.lineItems ??
            keys.map((priceId, index) => ({
              description: `Item ${index}`,
              amount_subtotal: 1000 * (index + 1),
              currency: 'cad',
              price: { recurring: priceId.includes('year') ? { interval: 'year' } : { interval: 'month' } },
            })),
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;

  try {
    const request = new Request('https://webao.ca/api/checkout/session', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(options.origin === null ? {} : { origin: options.origin ?? 'https://webao.ca' }),
      },
      body: JSON.stringify(body),
    });
    const response = await handleCheckoutSession(request, {
      STRIPE_SECRET_KEY: SECRET,
      STRIPE_PRICE_ID: PRICE_ID,
      ...options.env,
    } as never);
    return { response, status: response.status, json: (await response.json()) as Record<string, unknown>, calls };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const linePrices = (params: URLSearchParams) =>
  [...params.keys()]
    .filter((key) => /^line_items\[\d+\]\[price\]$/.test(key))
    .sort()
    .map((key) => params.get(key) as string);

test('a cart becomes one Stripe line item per product', async () => {
  const { status, json, calls } = await call({
    email: 'client@example.ca',
    business: 'Acme Plumbing',
    items: [{ key: 'launch-month' }, { key: 'localseo-month' }, { key: 'extrapage-one-time' }],
  });

  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.clientSecret, 'cs_test_secret');
  assert.equal(json.mode, 'subscription', 'recurring + one-time items use subscription mode');

  const [call1] = calls;
  assert.equal(call1.url, 'https://api.stripe.com/v1/checkout/sessions');
  assert.equal(call1.authorization, `Bearer ${SECRET}`);
  assert.deepEqual(linePrices(call1.params), [
    PRICE_MAP['launch-month'],
    PRICE_MAP['localseo-month'],
    PRICE_MAP['extrapage-onetime'],
  ]);
  assert.equal(call1.params.get('ui_mode'), 'embedded_page');
  assert.equal(call1.params.get('mode'), 'subscription');
  assert.equal(call1.params.get('line_items[0][quantity]'), '1');
  assert.equal(call1.params.get('line_items[2][quantity]'), '1');
  assert.equal(call1.params.get('customer_email'), 'client@example.ca');
  assert.equal(call1.params.get('subscription_data[description]'), 'WEBAO site for Acme Plumbing');
  assert.equal(call1.params.get('payment_intent_data[description]'), null);
  assert.equal(call1.params.get('return_url'), 'https://webao.ca/checkout/success?session_id={CHECKOUT_SESSION_ID}');
  assert.ok(call1.params.getAll('expand[]').includes('line_items'), 'line items are expanded for display');
  assert.equal(call1.params.get('metadata[items]'), 'launch-month,localseo-month,extrapage-onetime');
  // The response reports what Stripe will charge.
  assert.deepEqual((json.lineItems as unknown[]).length, 3);
  assert.deepEqual((json.lineItems as Array<{ amount: number }>)[0].amount, 1000);
});

test('yearly items resolve to their own prices', async () => {
  const { json, calls } = await call({
    items: [{ key: 'grow-year' }, { key: 'review-year' }, { key: 'extrapage-one-time' }],
  });
  assert.equal(json.mode, 'subscription');
  assert.deepEqual(linePrices(calls[0].params), [
    PRICE_MAP['grow-year'],
    PRICE_MAP['review-year'],
    PRICE_MAP['extrapage-onetime'],
  ]);
});

test('a yearly plan replaces the monthly one, never mixed', async () => {
  // The cart cannot hold both (the client converts on toggle); if a client
  // still sends both, the API refuses instead of letting Stripe fail. The
  // same plan twice is caught as two plans before the interval check.
  const { status, json, calls } = await call({ items: [{ key: 'launch-month' }, { key: 'launch-year' }] });
  assert.equal(status, 400);
  assert.match(String(json.error), /Only one website plan/);
  assert.equal(calls.length, 0, 'Stripe is not called with an impossible cart');
});

test('a one-time-only cart uses payment mode', async () => {
  const { status, json, calls } = await call({
    name: 'Dana',
    items: [{ key: 'extrapage-one-time' }],
  });
  assert.equal(status, 200);
  assert.equal(json.mode, 'payment');
  assert.equal(calls[0].params.get('mode'), 'payment');
  assert.deepEqual(linePrices(calls[0].params), [PRICE_MAP['extrapage-onetime']]);
  assert.equal(calls[0].params.get('subscription_data[description]'), null, 'payment sessions cannot carry subscription_data');
  assert.equal(calls[0].params.get('payment_intent_data[description]'), 'WEBAO site for Dana');
});

test('the cart spelling of one-time keys is accepted', async () => {
  const { status, calls } = await call({ items: [{ key: 'extrapage-one-time' }] });
  assert.equal(status, 200);
  assert.deepEqual(linePrices(calls[0].params), [PRICE_MAP['extrapage-onetime']]);
});

test('unknown or duplicated keys', async () => {
  const unknown = await call({ items: [{ key: 'launch-month' }, { key: 'mystery-month' }] });
  assert.equal(unknown.status, 400);
  assert.match(String(unknown.json.error), /mystery-month/);
  assert.equal(unknown.calls.length, 0, 'never charge less than the cart showed');

  const duplicated = await call({ items: [{ key: 'review-month' }, { key: 'review-month' }] });
  assert.equal(duplicated.status, 200);
  assert.deepEqual(linePrices(duplicated.calls[0].params), [PRICE_MAP['review-month']]);

  const empty = await call({ items: [] });
  assert.equal(empty.status, 200, 'an empty items list falls back to the legacy flow');
  assert.deepEqual(linePrices(empty.calls[0].params), [PRICE_ID]);
});

test('requests without a cart keep using STRIPE_PRICE_ID (/start flow)', async () => {
  const { status, json, calls } = await call({ email: 'a@b.ca', name: 'Sam', business: 'Sam & Co' });
  assert.equal(status, 200);
  assert.equal(json.mode, 'subscription');
  assert.deepEqual(linePrices(calls[0].params), [PRICE_ID]);
  assert.equal(calls[0].params.get('subscription_data[description]'), 'WEBAO site for Sam & Co');
  assert.equal(calls[0].params.get('metadata[items]'), '__legacy__');
});

test('configuration, validation and origin guards', async () => {
  const notConfigured = await call({ items: [{ key: 'launch-month' }] }, { env: { STRIPE_SECRET_KEY: undefined } });
  assert.equal(notConfigured.status, 503);
  assert.equal(notConfigured.calls.length, 0);

  const noLegacyPrice = await call({}, { env: { STRIPE_PRICE_ID: undefined } });
  assert.equal(noLegacyPrice.status, 503, 'legacy flow needs the env price id');
  const cartWithoutLegacyPrice = await call({ items: [{ key: 'launch-month' }] }, { env: { STRIPE_PRICE_ID: undefined } });
  assert.equal(cartWithoutLegacyPrice.status, 200, 'cart checkout does not depend on the env price id');

  const badEmail = await call({ email: 'nope', items: [{ key: 'launch-month' }] });
  assert.equal(badEmail.status, 400);
  assert.equal(badEmail.calls.length, 0);

  const foreignOrigin = await call({ items: [{ key: 'launch-month' }] }, { origin: 'https://evil.example' });
  assert.equal(foreignOrigin.status, 403);
  assert.equal(foreignOrigin.calls.length, 0);

  const localhost = await call({ items: [{ key: 'launch-month' }] }, { origin: 'http://localhost:4321' });
  assert.equal(localhost.status, 200, 'local development is allowed');
});

test('French checkout returns to the French success page', async () => {
  const { calls } = await call({ locale: 'fr', items: [{ key: 'launch-year' }] });
  assert.equal(calls[0].params.get('return_url'), 'https://webao.ca/fr/checkout/success?session_id={CHECKOUT_SESSION_ID}');
});

test('Stripe errors are surfaced, not swallowed', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: { message: 'No such price: price_x' } }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
  try {
    const response = await handleCheckoutSession(
      new Request('https://webao.ca/api/checkout/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://webao.ca' },
        body: JSON.stringify({ items: [{ key: 'launch-month' }] }),
      }),
      { STRIPE_SECRET_KEY: SECRET, STRIPE_PRICE_ID: PRICE_ID } as never,
    );
    assert.equal(response.status, 502);
    assert.match(String(((await response.json()) as { error: string }).error), /No such price/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('checkout is not throttled in-worker (edge rule owns it)', async () => {
  const puts: string[] = [];
  const kv = {
    get: async () => null,
    put: async (key: string) => void puts.push(key),
    delete: async () => {},
    list: async () => ({ keys: [], list_complete: true }),
  };
  const allowed = await call({ items: [{ key: 'launch-month' }] }, { env: { WEBAO_KV: kv } });
  assert.equal(allowed.status, 200);
  // No KV throttle write: every check was a KV write per request, and the
  // edge rate-limit rule on /api/checkout/* is the per-IP cap now.
  assert.equal(puts.length, 0);

  const saturated = await call({ items: [{ key: 'launch-month' }] }, {
    // A saturated rl: record must not 429 a checkout: the KV throttle is gone.
    env: { WEBAO_KV: { ...kv, get: async () => ({ c: 10, r: Date.now() + 30_000 }) } },
  });
  assert.equal(saturated.status, 200);
  assert.equal(saturated.calls.length, 1);
});

// ---------------------------------------------------------------------------
// Cart conflicts: the server is the backstop for crafted requests — the UI
// guards stop these combinations from being added, but a request sent
// directly must be rejected before Stripe is ever called.
// ---------------------------------------------------------------------------

const CONFLICT_CARTS: Array<{ items: string[]; error: string }> = [
  {
    items: ['grow-month', 'quotephoto-month'],
    error: 'Quote Photo Upload is already included in Grow.',
  },
  {
    items: ['launch-month', 'admin-month'],
    error: "Advanced Admin Panel isn't available with Launch.",
  },
  {
    items: ['scale-month', 'lead-pack-month'],
    error: "Lead Pack isn't available with Scale.",
  },
  {
    items: ['grow-month', 'lead-pack-month', 'review-month'],
    error: 'Lead Pack already includes Review Generation Engine.',
  },
  {
    items: ['grow-month', 'lead-pack-month', 'localseo-month', 'review-month', 'aichat-month'],
    error: 'Lead Pack already includes Local SEO Management, Review Generation Engine, Trained AI Chat Assistant.',
  },
  {
    items: ['grow-month', 'lead-pack-month', 'visibility-pack-month'],
    error: 'Lead Pack and Visibility Pack both include the Review Generation Engine.',
  },
  {
    items: ['launch-month', 'grow-month'],
    error: 'Only one website plan can be bought at a time.',
  },
  {
    items: ['ads-starter-month', 'ads-meta-month'],
    error: 'Choose one Ads Pack option: Meta, Google, both together, or the Starter test. Buying two Ads options together is not allowed.',
  },
  {
    items: ['ai-pack-month', 'aichat-month'],
    error: 'The AI Pack already includes AI Receptionist, Trained AI Chat Assistant and AI Follow-up. Buy the pack on its own, or the individual services on their own.',
  },
  {
    items: ['grow-year', 'ads-meta-month'],
    error: "Monthly and yearly items can't be paid in the same checkout. Choose one billing term in your cart.",
  },
];

for (const { items, error } of CONFLICT_CARTS) {
  test(`checkout rejects a conflicting cart: ${items.join(' + ')}`, async () => {
    const { status, json, calls } = await call({
      email: 'client@example.ca',
      items: items.map((key) => ({ key })),
    });
    assert.equal(status, 400);
    assert.equal(json.error, error);
    assert.equal(calls.length, 0, 'no Stripe call is made for a rejected cart');
  });
}

test('checkout applies the touchup discount automatically when touchup shares a cart with a subscription', async () => {
  const { status, calls } = await call({
    email: 'client@example.ca',
    items: [{ key: 'website-touchup-onetime' }, { key: 'grow-month' }],
  });
  assert.equal(status, 200);
  const [session] = calls;
  assert.equal(session.params.get('discounts[0][coupon]'), 'WEBAOFIXIT3256');
  assert.equal(session.params.get('allow_promotion_codes'), 'false');
  assert.equal(session.params.get('metadata[touchup_discount]'), 'auto');
});

test('checkout does not apply the touchup discount without a subscription in the cart', async () => {
  const { status, calls } = await call({
    email: 'client@example.ca',
    items: [{ key: 'website-touchup-onetime' }],
  });
  assert.equal(status, 200);
  const [session] = calls;
  assert.equal(session.params.get('discounts[0][coupon]'), null);
  assert.equal(session.params.get('allow_promotion_codes'), 'true');
  assert.equal(session.params.get('metadata[touchup_discount]'), null);
});
