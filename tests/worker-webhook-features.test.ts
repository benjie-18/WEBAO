// Webhook feature events (2026-10-24): checkout.session.expired stores an
// abandoned checkout, charge.dispute.created records + flags + alerts,
// invoice.payment_action_required flags the client until invoice.paid, and
// the internal follow-ups endpoint drives the recovery state machine.
// Also: checkout sessions carry metadata[lang] from the referer locale.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHmac } from 'node:crypto';
import { handleStripeWebhook } from '../worker/stripe-webhook';
import { handleAbandonedFollowups, storeAbandonedCheckout } from '../worker/recovery';
import { handleCheckoutSession } from '../worker/checkout';
import { createClient, getClient } from '../worker/clients';
import { bodyOf, envOf, memoryKV } from './helpers';

const SECRET = 'whsec_test_secret_for_unit_tests';
const CRON_SECRET = 'test-cron-' + 'secret-123';

function sign(rawBody: string, ts: number = Math.floor(Date.now() / 1000)): string {
  const v1 = createHmac('sha256', SECRET).update(`${ts}.${rawBody}`).digest('hex');
  return `t=${ts},v1=${v1}`;
}

async function sendEvent(memory: ReturnType<typeof memoryKV>, event: unknown) {
  const raw = JSON.stringify(event);
  const env = envOf(memory.kv, { STRIPE_WEBHOOK_SECRET: SECRET, STRIPE_SECRET_KEY: 'sk_test_dummy' });
  return handleStripeWebhook(
    new Request('https://webao.ca/api/stripe/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': sign(raw) },
      body: raw,
    }),
    env,
  );
}

async function readJson(memory: ReturnType<typeof memoryKV>, key: string) {
  const raw = await memory.kv.get(key);
  return raw ? JSON.parse(raw) : null;
}

const expiredEvent = {
  id: 'evt_expired_1',
  type: 'checkout.session.expired',
  created: 1792800000,
  data: {
    object: {
      id: 'cs_expired_1',
      customer_email: 'Almost@Example.ca',
      customer_details: { email: 'almost@example.ca', name: 'Al Almost' },
      metadata: { items: 'launch-month', lang: 'fr' },
      amount_total: 10399,
      currency: 'cad',
    },
  },
};

test('checkout.session.expired stores a pending abandoned checkout', async () => {
  const memory = memoryKV();
  const res = await sendEvent(memory, expiredEvent);
  assert.equal(res.status, 200);
  const rec = await readJson(memory, 'abandoned:cs_expired_1');
  assert.ok(rec, 'record stored');
  assert.equal(rec.email, 'almost@example.ca');
  assert.equal(rec.name, 'Al Almost');
  assert.deepEqual(rec.items, ['launch-month']);
  assert.equal(rec.lang, 'fr');
  assert.equal(rec.amountTotal, 10399);
  assert.equal(rec.status, 'pending');
  const index = await readJson(memory, 'abandoned:index');
  assert.deepEqual(index, ['abandoned:cs_expired_1']);
});

test('checkout.session.expired without an email stores nothing', async () => {
  const memory = memoryKV();
  const res = await sendEvent(memory, {
    id: 'evt_expired_2',
    type: 'checkout.session.expired',
    created: 1792800000,
    data: { object: { id: 'cs_expired_2', metadata: { items: 'grow-month' } } },
  });
  assert.equal(res.status, 200);
  assert.equal(await memory.kv.get('abandoned:cs_expired_2'), null);
  assert.equal(await memory.kv.get('abandoned:index'), null);
});

test('charge.dispute.created records the dispute and flags the client', async () => {
  const memory = memoryKV();
  const client = await createClient(memory.kv, {
    email: 'owner@example.ca',
    stripeCustomerId: 'cus_123',
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/v1/charges/')) {
      return new Response(JSON.stringify({ id: 'ch_123', customer: 'cus_123' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error('unexpected fetch ' + url);
  }) as typeof fetch;
  try {
    const res = await sendEvent(memory, {
      id: 'evt_dispute_1',
      type: 'charge.dispute.created',
      created: 1792800000,
      data: {
        object: {
          id: 'dp_123',
          charge: 'ch_123',
          amount: 8999,
          currency: 'cad',
          reason: 'fraudulent',
          status: 'warning_needs_response',
          evidence_details: { due_by: 1795000000 },
        },
      },
    });
    assert.equal(res.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }
  const dispute = await readJson(memory, 'dispute:dp_123');
  assert.ok(dispute, 'dispute record stored');
  assert.equal(dispute.clientId, client.id);
  assert.equal(dispute.amount, 8999);
  assert.equal(dispute.dueBy, 1795000000000);
  const after = await getClient(memory.kv, client.id);
  assert.equal(after?.disputeFlag?.disputeId, 'dp_123');
});

test('invoice.payment_action_required flags the client; invoice.paid clears it', async () => {
  const memory = memoryKV();
  const client = await createClient(memory.kv, {
    email: 'owner@example.ca',
    stripeCustomerId: 'cus_123',
    billingStatus: 'active',
  });
  const actionRes = await sendEvent(memory, {
    id: 'evt_action_1',
    type: 'invoice.payment_action_required',
    created: 1792800000,
    data: {
      object: {
        id: 'in_123',
        customer: 'cus_123',
        customer_email: 'owner@example.ca',
        hosted_invoice_url: 'https://invoice.stripe.com/i/in_123',
      },
    },
  });
  assert.equal(actionRes.status, 200);
  const flagged = await getClient(memory.kv, client.id);
  assert.equal(flagged?.paymentActionRequired?.invoiceId, 'in_123');
  assert.equal(
    flagged?.paymentActionRequired?.url,
    'https://invoice.stripe.com/i/in_123',
  );

  const paidRes = await sendEvent(memory, {
    id: 'evt_paid_1',
    type: 'invoice.paid',
    created: 1792800100,
    data: {
      object: { id: 'in_123', customer: 'cus_123', customer_email: 'owner@example.ca' },
    },
  });
  assert.equal(paidRes.status, 200);
  const cleared = await getClient(memory.kv, client.id);
  assert.equal(cleared?.paymentActionRequired, undefined);
  assert.equal(cleared?.billingStatus, 'active');
});

function followupsRequest(secret: string | null): Request {
  return new Request('https://webao.ca/api/internal/abandoned-followups', {
    method: 'POST',
    headers: secret === null ? {} : { authorization: `Bearer ${secret}` },
    body: '{}',
  });
}

test('abandoned follow-ups: secret gates and the record state machine', async () => {
  const memory = memoryKV();

  // No secret configured on the worker: 503.
  let res = await handleAbandonedFollowups(
    followupsRequest(CRON_SECRET),
    envOf(memory.kv, {}),
  );
  assert.equal(res.status, 503);

  const env = envOf(memory.kv, { INTERNAL_CRON_SECRET: CRON_SECRET });

  // Wrong secret: 401.
  res = await handleAbandonedFollowups(followupsRequest('nope'), env);
  assert.equal(res.status, 401);

  const now = Date.now();
  // Too young: stays pending, untouched.
  await storeAbandonedCheckout(memory.kv, {
    sessionId: 'cs_young',
    email: 'young@example.ca',
    items: ['launch-month'],
    lang: 'en',
    createdAt: now - 60 * 60 * 1000,
    status: 'pending',
  });
  // Old enough, but the mailer is not configured in this env: stays pending.
  await storeAbandonedCheckout(memory.kv, {
    sessionId: 'cs_old',
    email: 'old@example.ca',
    items: ['grow-month'],
    lang: 'en',
    createdAt: now - 36 * 60 * 60 * 1000,
    status: 'pending',
  });
  // Old enough, and the email now belongs to a client: converted, unemailed.
  await storeAbandonedCheckout(memory.kv, {
    sessionId: 'cs_conv',
    email: 'conv@example.ca',
    items: ['launch-month'],
    lang: 'fr',
    createdAt: now - 36 * 60 * 60 * 1000,
    status: 'pending',
  });
  await createClient(memory.kv, { email: 'conv@example.ca' });

  res = await handleAbandonedFollowups(followupsRequest(CRON_SECRET), env);
  assert.equal(res.status, 200);
  const body = await bodyOf(res);
  assert.equal(body.converted, 1);
  assert.equal(body.emailed, 0);
  assert.equal(body.pending, 2);
  assert.equal((await readJson(memory, 'abandoned:cs_conv'))?.status, 'converted');
  assert.equal((await readJson(memory, 'abandoned:cs_old'))?.status, 'pending');
  assert.equal((await readJson(memory, 'abandoned:cs_young'))?.status, 'pending');
});

test('checkout session carries metadata[lang] from the referer locale', async () => {
  const memory = memoryKV();
  const originalFetch = globalThis.fetch;
  let captured: URLSearchParams | null = null;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    captured = new URLSearchParams(String(init?.body ?? ''));
    return new Response(
      JSON.stringify({ id: 'cs_test_lang', client_secret: 'cs_test_lang_secret' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as typeof fetch;
  try {
    const env = envOf(memory.kv, { STRIPE_SECRET_KEY: 'sk_test_dummy' });
    const res = await handleCheckoutSession(
      new Request('https://webao.ca/api/checkout/session', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://webao.ca',
          Referer: 'https://webao.ca/fr/tarifs/',
        },
        body: JSON.stringify({ items: [{ key: 'launch-month' }] }),
      }),
      env,
    );
    assert.equal(res.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.ok(captured, 'stripe call captured');
  assert.equal((captured as URLSearchParams).get('metadata[lang]'), 'fr');
  assert.equal((captured as URLSearchParams).get('metadata[items]'), 'launch-month');
});
