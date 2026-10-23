// Stripe webhook: signature verification, checkout -> client record,
// idempotent redelivery, and billing status mirroring from later events.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHmac } from 'node:crypto';
import { handleStripeWebhook, verifyStripeSignature } from '../worker/stripe-webhook';
import { bodyOf, envOf, memoryKV } from './helpers';

const SECRET = 'whsec_test_secret_for_unit_tests';

function sign(rawBody: string, ts: number = Math.floor(Date.now() / 1000)): string {
  const v1 = createHmac('sha256', SECRET).update(`${ts}.${rawBody}`).digest('hex');
  return `t=${ts},v1=${v1}`;
}

function webhookRequest(rawBody: string, signature?: string): Request {
  return new Request('https://webao.ca/api/stripe/webhook', {
    method: 'POST',
    headers: signature ? { 'stripe-signature': signature } : {},
    body: rawBody,
  });
}

async function send(memory: ReturnType<typeof memoryKV>, event: unknown, secret: string | null = SECRET) {
  const raw = JSON.stringify(event);
  const env = envOf(memory.kv, secret === null ? {} : { STRIPE_WEBHOOK_SECRET: secret });
  return handleStripeWebhook(webhookRequest(raw, sign(raw)), env);
}

const checkoutEvent = {
  id: 'evt_checkout_1',
  type: 'checkout.session.completed',
  created: 1792800000,
  data: {
    object: {
      customer: 'cus_123',
      subscription: 'sub_123',
      customer_email: 'Owner@Example.ca',
      customer_details: { email: 'owner@example.ca', name: 'Pat Proprio' },
      metadata: { items: 'grow-month,localseo-month' },
    },
  },
};

function clientsIn(memory: ReturnType<typeof memoryKV>) {
  return [...memory.store.keys()].filter((k) => k.startsWith('client:') && !k.startsWith('client-customer:'));
}

test('signature: valid header verifies, tampering and staleness fail', async () => {
  const raw = '{"id":"evt_x"}';
  const now = Math.floor(Date.now() / 1000);
  assert.equal(await verifyStripeSignature(raw, sign(raw, now), SECRET, now), true);
  assert.equal(await verifyStripeSignature(raw + ' ', sign(raw, now), SECRET, now), false);
  assert.equal(await verifyStripeSignature(raw, sign(raw, now - 3600), SECRET, now), false);
  assert.equal(await verifyStripeSignature(raw, null, SECRET, now), false);
  assert.equal(await verifyStripeSignature(raw, 't=1,v1=deadbeef', SECRET, now), false);
});

test('unconfigured secret answers 503, bad signature answers 400', async () => {
  const memory = memoryKV();
  const raw = JSON.stringify(checkoutEvent);
  const unconfigured = await handleStripeWebhook(
    webhookRequest(raw, sign(raw)),
    envOf(memory.kv, {}),
  );
  assert.equal(unconfigured.status, 503);

  const bad = await handleStripeWebhook(
    webhookRequest(raw, 't=1,v1=nope'),
    envOf(memory.kv, { STRIPE_WEBHOOK_SECRET: SECRET }),
  );
  assert.equal(bad.status, 400);
  assert.equal(clientsIn(memory).length, 0);
});

test('checkout.session.completed creates an onboarding client with mapping + index', async () => {
  const memory = memoryKV();
  const res = await send(memory, checkoutEvent);
  assert.equal(res.status, 200);
  assert.deepEqual(await bodyOf(res), { ok: true, received: true });

  const keys = clientsIn(memory);
  assert.equal(keys.length, 1);
  const client = JSON.parse(memory.store.get(keys[0])!);
  assert.match(client.id, /^cl_[a-f0-9]{24}$/);
  assert.equal(client.email, 'owner@example.ca');
  assert.equal(client.name, 'Pat Proprio');
  assert.equal(client.stage, 'onboarding');
  assert.equal(client.billingStatus, 'active');
  assert.equal(client.stripeCustomerId, 'cus_123');
  assert.equal(client.stripeSubscriptionId, 'sub_123');
  assert.deepEqual(client.items, ['grow-month', 'localseo-month']);
  assert.equal(client.lastCheckoutAt, 1792800000 * 1000);

  assert.equal(JSON.parse(memory.store.get('client-customer:cus_123')!), keys[0]);
  const index = JSON.parse(memory.store.get('clients:index')!);
  assert.deepEqual(index, [keys[0]]);
  assert.ok(memory.store.has('stripe-event:evt_checkout_1'));
});

test('redelivered event is a no-op duplicate; a second purchase enriches the same client', async () => {
  const memory = memoryKV();
  await send(memory, checkoutEvent);
  const dup = await send(memory, checkoutEvent);
  assert.deepEqual(await bodyOf(dup), { ok: true, received: true, duplicate: true });
  assert.equal(clientsIn(memory).length, 1);

  const second = {
    ...checkoutEvent,
    id: 'evt_checkout_2',
    data: {
      object: {
        ...checkoutEvent.data.object,
        subscription: '',
        metadata: { items: 'extrapage-onetime,localseo-month' },
      },
    },
  };
  const res = await send(memory, second);
  assert.equal(res.status, 200);
  const keys = clientsIn(memory);
  assert.equal(keys.length, 1);
  const client = JSON.parse(memory.store.get(keys[0])!);
  assert.deepEqual(client.items, ['grow-month', 'localseo-month', 'extrapage-onetime']);
  assert.equal(client.billingStatus, 'active');
});

test('invoice and subscription events mirror billing status onto the client', async () => {
  const memory = memoryKV();
  await send(memory, checkoutEvent);
  const key = clientsIn(memory)[0];
  const read = () => JSON.parse(memory.store.get(key)!);

  const failed = {
    id: 'evt_inv_fail',
    type: 'invoice.payment_failed',
    created: 1792900000,
    data: { object: { customer: 'cus_123', customer_email: 'owner@example.ca' } },
  };
  await send(memory, failed);
  assert.equal(read().billingStatus, 'past_due');
  assert.equal(read().paymentFailedAt, 1792900000 * 1000);

  const paid = {
    id: 'evt_inv_paid',
    type: 'invoice.paid',
    created: 1793000000,
    data: { object: { customer: 'cus_123', customer_email: 'owner@example.ca' } },
  };
  await send(memory, paid);
  assert.equal(read().billingStatus, 'active');
  assert.equal(read().lastInvoicePaidAt, 1793000000 * 1000);
  assert.equal(read().paymentFailedAt, undefined);

  const deleted = {
    id: 'evt_sub_del',
    type: 'customer.subscription.deleted',
    created: 1793100000,
    data: { object: { id: 'sub_123', customer: 'cus_123', status: 'canceled' } },
  };
  await send(memory, deleted);
  assert.equal(read().billingStatus, 'canceled');
  assert.equal(read().canceledAt, 1793100000 * 1000);
});

test('events for unknown customers and unknown types are acknowledged no-ops', async () => {
  const memory = memoryKV();
  const unknown = {
    id: 'evt_other',
    type: 'payment_intent.succeeded',
    created: 1792800000,
    data: { object: { customer: 'cus_nobody' } },
  };
  const res = await send(memory, unknown);
  assert.equal(res.status, 200);
  assert.equal(clientsIn(memory).length, 0);

  const orphanInvoice = {
    id: 'evt_orphan',
    type: 'invoice.paid',
    created: 1792800000,
    data: { object: { customer: 'cus_nobody', customer_email: 'nobody@example.ca' } },
  };
  const res2 = await send(memory, orphanInvoice);
  assert.equal(res2.status, 200);
  assert.equal(clientsIn(memory).length, 0);
});

test('one-time-only checkout creates a one-time client; failed handling leaves no dedupe key', async () => {
  const memory = memoryKV();
  const oneTime = {
    id: 'evt_onetime',
    type: 'checkout.session.completed',
    created: 1792800000,
    data: {
      object: {
        customer: 'cus_9',
        subscription: null,
        customer_details: { email: 'solo@example.ca', name: '' },
        metadata: { items: 'extrapage-onetime' },
      },
    },
  };
  const res = await send(memory, oneTime);
  assert.equal(res.status, 200);
  const client = JSON.parse(memory.store.get(clientsIn(memory)[0])!);
  assert.equal(client.billingStatus, 'one-time');

  // A KV write failure must surface (Stripe will retry) and must not record
  // the event as handled.
  const failing = memoryKV();
  failing.failWrites(true);
  await assert.rejects(() => send(failing, checkoutEvent));
  assert.equal(failing.store.has('stripe-event:evt_checkout_1'), false);
});
