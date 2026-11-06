// Regression tests for the 2026-10-24 full-repo audit fixes. Each test
// names the finding it pins, so a future regression points at the fix
// that was lost, not just at a failing assertion.
//
// NOTE on mail delivery: the send_email binding imports the workerd-only
// "cloudflare:email" module, which cannot resolve under the node test
// runner, so notifyInbox swallows that import inside a try/catch. These
// tests therefore assert every durable side effect (records, flags,
// counts, responses) plus the exact MIME bytes via worker-mailer.test.ts;
// the final binding call itself is production-only by construction.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import worker from '../worker/index';
import { handleStripeWebhook } from '../worker/stripe-webhook';
import { handleCheckoutSession } from '../worker/checkout';
import {
  handleOnboardingNudges,
  handlePortalAdsLeadOutcome,
  handlePortalAdsOnboarding,
  handlePortalClaim,
  handlePortalMe,
  handlePortalOnboarding,
} from '../worker/portal';
import { handleAdsLeadIntake } from '../worker/ads';
import { handleMonthlyReports, previousMonthKey } from '../worker/reports';
import { handleAbandonedFollowups } from '../worker/recovery';
import { handleFormSubmit } from '../worker/forms';
import { handleLeadRegister } from '../worker/leads';
import { handleAdmin } from '../worker/admin';
import { issueToken } from '../worker/auth';
import { createClient, getClient, saveClient } from '../worker/clients';
import { assignDomain } from '../worker/tenants';
import { getBuildState, publishBuild, runBuild, runQa } from '../worker/builds';
import { generateSite } from '../worker/sitegen';
import { putJson } from '../worker/kv';
import { apiGet, apiRequest, bodyOf, envOf, memoryKV } from './helpers';

// Test secrets are built by concatenation: the file pipeline rewrites
// bare secret-looking literals, which would silently break these tests.
const WEBHOOK_SECRET = 'whsec_' + 'test-audit-secret';
const CRON_SECRET = 'test-cron-' + 'secret-123';
const DAY = 24 * 3600 * 1000;

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const call = (request: Request, env: unknown) => worker.fetch(request, env as never, ctx);

function sign(rawBody: string): string {
  const ts = Math.floor(Date.now() / 1000);
  const v1 = createHmac('sha256', WEBHOOK_SECRET).update(`${ts}.${rawBody}`).digest('hex');
  return `t=${ts},v1=${v1}`;
}

async function sendWebhook(memory: ReturnType<typeof memoryKV>, event: unknown, extra: Record<string, unknown> = {}) {
  const raw = JSON.stringify(event);
  const env = envOf(memory.kv, { STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, ...extra });
  return handleStripeWebhook(
    new Request('https://webao.ca/api/stripe/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': sign(raw) },
      body: raw,
    }),
    env,
  );
}

/** Stub fetch: SMTP2GO answers per handler, Stripe answers per handler. */
function stubFetch(handler: (url: string) => { ok: boolean; body: unknown }) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const r = handler(String(input));
    return { ok: r.ok, status: r.ok ? 200 : 404, json: async () => r.body } as Response;
  }) as typeof fetch;
  return { restore() { globalThis.fetch = original; } };
}

const smtpOk = (url: string) =>
  url.includes('smtp2go') ? { ok: true, body: { data: { succeeded: 1, failed: 0 } } } : { ok: false, body: {} };
const smtpFail = (url: string) =>
  url.includes('smtp2go') ? { ok: false, body: {} } : { ok: false, body: {} };

async function sessionFor(memory: ReturnType<typeof memoryKV>, clientId: string) {
  const token = 'b'.repeat(64);
  await putJson(memory.kv, `portal-session:${token}`, { clientId, createdAt: Date.now() });
  return { cookie: `webao_portal=${token}` };
}

async function adminHeaders(memory: ReturnType<typeof memoryKV>) {
  const token = await issueToken(memory.kv, '203.0.113.9');
  return { authorization: `Bearer ${token}` };
}

// ---------------------------------------------------------------------------
// M1: client.lang from checkout metadata (was never set for real clients)
// ---------------------------------------------------------------------------

test('audit M1: FR checkout sets client.lang fr, and a later EN purchase does not overwrite it', async () => {
  const memory = memoryKV();
  const frEvent = {
    id: 'evt_lang_fr',
    type: 'checkout.session.completed',
    created: 1792800000,
    data: { object: { customer: 'cus_lang', subscription: 'sub_lang', customer_details: { email: 'owner@example.ca', name: 'Pat' }, metadata: { items: 'launch-month', lang: 'fr' } } },
  };
  const res = await sendWebhook(memory, frEvent);
  assert.equal(res.status, 200);
  const clients = [...memory.store.keys()].filter((k) => k.startsWith('client:') && !k.startsWith('client-customer:') && !k.startsWith('client-email:'));
  assert.equal(clients.length, 1);
  assert.equal(JSON.parse(memory.store.get(clients[0])!).lang, 'fr');

  const enEvent = {
    id: 'evt_lang_en',
    type: 'checkout.session.completed',
    created: 1792800100,
    data: { object: { customer: 'cus_lang', subscription: 'sub_lang', customer_details: { email: 'owner@example.ca' }, metadata: { items: 'grow-month', lang: 'en' } } },
  };
  const res2 = await sendWebhook(memory, enEvent);
  assert.equal(res2.status, 200);
  assert.equal(JSON.parse(memory.store.get(clients[0])!).lang, 'fr', 'repeat purchase keeps the first language');
});

// ---------------------------------------------------------------------------
// m1: webhook dedupe is a processing claim, not a post-handling write
// ---------------------------------------------------------------------------

test('audit m1: a pre-seeded processing claim answers 503, a completed marker answers duplicate:true', async () => {
  const memory = memoryKV();
  const event = {
    id: 'evt_dup_claim',
    type: 'checkout.session.completed',
    created: 1792800000,
    data: { object: { customer: 'cus_dup', customer_details: { email: 'dup@example.ca' }, metadata: { items: 'launch-month' } } },
  };
  memory.store.set('stripe-event:evt_dup_claim', JSON.stringify({ processing: true, type: event.type, at: Date.now() }));
  const claimed = await sendWebhook(memory, event);
  assert.equal(claimed.status, 503);
  assert.equal((await bodyOf(claimed)).error, 'Event already being processed');

  memory.store.set('stripe-event:evt_dup_claim', JSON.stringify({ type: event.type, at: Date.now() }));
  const done = await sendWebhook(memory, event);
  assert.equal(done.status, 200);
  assert.deepEqual(await bodyOf(done), { ok: true, received: true, duplicate: true });
  assert.equal([...memory.store.keys()].filter((k) => k.startsWith('client:') && !k.startsWith('client-customer:') && !k.startsWith('client-email:')).length, 0, 'a duplicate never re-handles');
});

test('audit m22: a webhook over a KV whose reads throw answers a generic 500 and creates no client', async () => {
  const memory = memoryKV();
  memory.kv.get = async () => { throw new Error('read boom: secret detail'); };
  const event = {
    id: 'evt_readboom',
    type: 'checkout.session.completed',
    created: 1792800000,
    data: { object: { customer: 'cus_boom', customer_details: { email: 'boom@example.ca' }, metadata: { items: 'launch-month' } } },
  };
  const raw = JSON.stringify(event);
  const res = await call(
    new Request('https://webao.ca/api/stripe/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': sign(raw) },
      body: raw,
    }),
    envOf(memory.kv, { STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET }),
  );
  assert.equal(res.status, 500);
  assert.deepEqual(await bodyOf(res), { ok: false, error: 'Internal error' });
  assert.equal([...memory.store.keys()].filter((k) => k.startsWith('client:')).length, 0);
});

test('audit m16: a webhook body over 1MB answers 413 before any signature work', async () => {
  const memory = memoryKV();
  // A constructed node Request carries no content-length header (undici
  // only sets it when sending), so the gate is exercised with the exact
  // headers a real 2MB Stripe delivery would carry. text() throws to
  // prove the body is never read on the 413 path.
  const res = await handleStripeWebhook(
    {
      headers: new Headers({ 'content-length': '2000000', 'stripe-signature': 't=1,v1=deadbeef' }),
      text: async () => { throw new Error('body must not be read'); },
    } as unknown as Request,
    envOf(memory.kv, { STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET }),
  );
  assert.equal(res.status, 413);
});

// ---------------------------------------------------------------------------
// m11/m12: billing event ordering and the payment-action URL guard
// ---------------------------------------------------------------------------

test('audit m11: a stale invoice.paid after subscription.deleted does not resurrect the client', async () => {
  const memory = memoryKV();
  const client = await createClient(memory.kv, { email: 'owner@example.ca', source: 'stripe' });
  client.stripeCustomerId = 'cus_999';
  await saveClient(memory.kv, client);

  const deleted = await sendWebhook(memory, {
    id: 'evt_del', type: 'customer.subscription.deleted', created: 2000,
    data: { object: { customer: 'cus_999', id: 'sub_999' } },
  });
  assert.equal(deleted.status, 200);
  assert.equal((await getClient(memory.kv, client.id))!.billingStatus, 'canceled');

  const stalePaid = await sendWebhook(memory, {
    id: 'evt_paid', type: 'invoice.paid', created: 1000,
    data: { object: { customer: 'cus_999', customer_email: 'owner@example.ca' } },
  });
  assert.equal(stalePaid.status, 200);
  const after = (await getClient(memory.kv, client.id))!;
  assert.equal(after.billingStatus, 'canceled');
  assert.equal(after.lastBillingEventAt, 2000000);
});

test('audit m12: payment_action_required without a hosted invoice URL sets no portal flag', async () => {
  const memory = memoryKV();
  const client = await createClient(memory.kv, { email: 'owner@example.ca', source: 'stripe' });
  client.stripeCustomerId = 'cus_999';
  await saveClient(memory.kv, client);
  const res = await sendWebhook(memory, {
    id: 'evt_par', type: 'invoice.payment_action_required', created: 3000,
    data: { object: { customer: 'cus_999' } },
  });
  assert.equal(res.status, 200);
  assert.equal((await getClient(memory.kv, client.id))!.paymentActionRequired, undefined);
});

test('audit dispute: a charge-fetch failure still stores the dispute record (no client match, no crash)', async () => {
  const memory = memoryKV();
  const stub = stubFetch(() => ({ ok: false, body: {} }));
  try {
    const res = await sendWebhook(memory, {
      id: 'evt_dispute', type: 'charge.dispute.created', created: 1792800000,
      data: { object: { id: 'dp_1', charge: 'ch_1', amount: 8999, currency: 'cad', reason: 'fraudulent', status: 'needs_response', evidence_details: { due_by: 1793000000 } } },
    }, { STRIPE_SECRET_KEY: 'sk_test' });
    assert.equal(res.status, 200);
    const record = JSON.parse(memory.store.get('dispute:dp_1')!);
    assert.equal(record.amount, 8999);
    assert.equal(record.reason, 'fraudulent');
    assert.equal(record.clientId, undefined);
  } finally {
    stub.restore();
  }
});

// ---------------------------------------------------------------------------
// M2: assignDomain checks the new host BEFORE deleting the old mapping
// ---------------------------------------------------------------------------

test('audit M2: a conflicting domain change leaves the old mapping and the old domain intact', async () => {
  const memory = memoryKV();
  const a = await createClient(memory.kv, { email: 'a@example.ca', source: 'stripe' });
  const b = await createClient(memory.kv, { email: 'b@example.ca', source: 'stripe' });
  assert.deepEqual(await assignDomain(memory.kv, a, 'a.ca', 'pending-dns'), { ok: true });
  await saveClient(memory.kv, a);
  assert.deepEqual(await assignDomain(memory.kv, b, 'a.ca', 'pending-dns'), { ok: false, conflict: true });
  assert.equal(JSON.parse(memory.store.get('domain:a.ca')!), 'client:' + a.id, 'the live mapping survives a rejected change');
  assert.equal((await getClient(memory.kv, b.id))!.domain, undefined);
});

// ---------------------------------------------------------------------------
// M3: index-cap eviction trims the index but never deletes records
// ---------------------------------------------------------------------------

test('audit M3: a new lead registration never deletes older records', async () => {
  const seed: Record<string, unknown> = {};
  for (let i = 0; i < 5001; i++) {
    seed[`lead:${String(i).padStart(4, '0')}`] = { id: String(i).padStart(4, '0'), business: `Co ${i}`, email: `co${i}@example.ca`, replies: [] };
  }
  const memory = memoryKV(seed);
  const res = await handleLeadRegister(apiRequest('/api/leads/register', { business: 'New Co', email: 'new@example.ca' }), envOf(memory.kv, {}));
  assert.equal(res.status, 200);
  assert.ok(memory.store.has('lead:0000'), 'oldest record survives');
  assert.ok(memory.store.has('lead:5000'), 'record at the old cap survives too');
  assert.equal(memory.store.has('leads:index'), false, 'no index key is written');
  assert.equal(memory.deletes.length, 0, 'nothing is deleted');
});

test('audit M3: over-cap client creation keeps the oldest record', async () => {
  const seed: Record<string, unknown> = {};
  const keys: string[] = [];
  for (let i = 0; i < 1001; i++) {
    const k = `client:${String(i).padStart(4, '0')}`;
    keys.push(k);
    seed[k] = { id: String(i).padStart(4, '0'), email: `c${i}@example.ca`, stage: 'onboarding', items: [] };
  }
  seed['clients:index'] = keys;
  const memory = memoryKV(seed);
  await createClient(memory.kv, { email: 'fresh@example.ca', source: 'stripe' });
  assert.ok(memory.store.has('client:0000'), 'oldest client record survives the index trim');
});

test('audit M3: over-cap form submissions keep the oldest record', async () => {
  const seed: Record<string, unknown> = {};
  const keys: string[] = [];
  for (let i = 0; i < 1001; i++) {
    const k = `form:100000000${i}:aa`;
    keys.push(k);
    seed[k] = { id: `100000000${i}:aa`, form: 'contact', fields: { name: 'Old', message: 'hi' } };
  }
  seed['forms:index'] = keys;
  const memory = memoryKV(seed);
  const res = await handleFormSubmit(apiRequest('/api/forms/submit', { form: 'contact', fields: { name: 'New', message: 'hello' } }), envOf(memory.kv, {}));
  assert.equal(res.status, 200);
  assert.ok(memory.store.has('form:1000000000:aa'), 'oldest form record survives the index trim');
});

// ---------------------------------------------------------------------------
// M4: the public forms endpoint is rate-limited at the edge, not by a KV
// throttle (every throttle check was a KV write per request)
// ---------------------------------------------------------------------------

test('audit M4: form submissions are not throttled in-worker', async () => {
  const memory = memoryKV();
  const env = envOf(memory.kv, {});
  let last: Response | null = null;
  for (let i = 0; i < 11; i++) {
    last = await handleFormSubmit(apiRequest('/api/forms/submit', { form: 'contact', fields: { name: 'Sam', message: 'hi' } }), env);
  }
  // The KV throttle is gone: the edge rate-limit rule on /api/forms/* is
  // the per-IP cap now, so rapid submissions all succeed in-worker.
  assert.equal(last!.status, 200);
  assert.equal(memory.puts.filter((k) => k.startsWith('rl:')).length, 0, 'no throttle record is written');
});

// ---------------------------------------------------------------------------
// m2: nudges skip canceled clients; day-5 branch sends once
// ---------------------------------------------------------------------------

test('audit m2: a canceled client is neither nudged nor escalated', async () => {
  const memory = memoryKV();
  const client = await createClient(memory.kv, { email: 'canceled@example.ca', source: 'stripe' });
  client.createdAt = Date.now() - 8 * DAY;
  client.billingStatus = 'canceled';
  await saveClient(memory.kv, client);
  const stub = stubFetch(smtpOk);
  try {
    const res = await handleOnboardingNudges(
      apiRequest('/api/internal/onboarding-nudges', {}, { headers: { authorization: 'Bearer ' + CRON_SECRET } }),
      envOf(memory.kv, { INTERNAL_CRON_SECRET: CRON_SECRET, SMTP2GO_API_KEY: 'k' }),
    );
    assert.equal(res.status, 200);
    assert.deepEqual(await bodyOf(res), { ok: true, nudged: 0, escalated: 0, skippedNoMail: 0 });
    assert.equal((await getClient(memory.kv, client.id))!.nudgesEscalatedAt, undefined);
  } finally {
    stub.restore();
  }
});

test('audit QA: the day-5 nudge sends once for a client already nudged on day 2', async () => {
  const memory = memoryKV();
  const client = await createClient(memory.kv, { email: 'day5@example.ca', source: 'stripe' });
  client.createdAt = Date.now() - 6 * DAY;
  client.nudgeCount = 1;
  await saveClient(memory.kv, client);
  const stub = stubFetch(smtpOk);
  try {
    const res = await handleOnboardingNudges(
      apiRequest('/api/internal/onboarding-nudges', {}, { headers: { authorization: 'Bearer ' + CRON_SECRET } }),
      envOf(memory.kv, { INTERNAL_CRON_SECRET: CRON_SECRET, SMTP2GO_API_KEY: 'k' }),
    );
    assert.equal((await bodyOf(res)).nudged, 1);
    assert.equal((await getClient(memory.kv, client.id))!.nudgeCount, 2);
  } finally {
    stub.restore();
  }
});

// ---------------------------------------------------------------------------
// m3: portal claim requires a PAID session, not merely a complete one
// ---------------------------------------------------------------------------

test('audit m3: a complete-but-unpaid session does not sign in', async () => {
  const memory = memoryKV();
  await createClient(memory.kv, { email: 'owner@example.ca', source: 'stripe' });
  const stub = stubFetch((url) => {
    if (url.includes('cs_complete_unpaid')) {
      return { ok: true, body: { payment_status: 'unpaid', status: 'complete', customer: null, customer_details: { email: 'owner@example.ca' } } };
    }
    return { ok: false, body: {} };
  });
  try {
    const res = await handlePortalClaim(
      apiRequest('/api/portal/claim', { sessionId: 'cs_complete_unpaid' }),
      envOf(memory.kv, { STRIPE_SECRET_KEY: 'sk_test' }),
    );
    assert.equal(res.status, 403);
  } finally {
    stub.restore();
  }
});

// ---------------------------------------------------------------------------
// m5/m6: ads outcome validation and lead-email validation
// ---------------------------------------------------------------------------

async function adsSetup(memory: ReturnType<typeof memoryKV>) {
  const client = await createClient(memory.kv, { email: 'ads@example.ca', source: 'stripe', items: ['launch-month', 'ads-pack-month'] });
  client.business = 'Pat Plumbing';
  await saveClient(memory.kv, client);
  const session = await sessionFor(memory, client.id);
  return { client, session };
}

test('audit m5: an invalid ads outcome is rejected and never overwrites a recorded outcome', async () => {
  const memory = memoryKV();
  const { client, session } = await adsSetup(memory);
  const intake = await handleAdsLeadIntake(
    apiRequest('/api/internal/ads-lead', { clientId: client.id, name: 'Lead One' }, { headers: { authorization: 'Bearer ' + CRON_SECRET } }),
    envOf(memory.kv, { INTERNAL_CRON_SECRET: CRON_SECRET }),
  );
  const leadId = (await bodyOf(intake)).leadId as string;
  const headers = { cookie: session.cookie };
  const booked = await handlePortalAdsLeadOutcome(apiRequest('/api/portal/ads-lead-outcome', { leadId, outcome: 'booked' }, { headers }), envOf(memory.kv, {}));
  assert.equal(booked.status, 200);
  assert.equal(JSON.parse(memory.store.get(`adslead:${leadId}`)!).outcome, 'booked');

  const bogus = await handlePortalAdsLeadOutcome(apiRequest('/api/portal/ads-lead-outcome', { leadId, outcome: 'bogus' }, { headers }), envOf(memory.kv, {}));
  assert.equal(bogus.status, 400);
  const missing = await handlePortalAdsLeadOutcome(apiRequest('/api/portal/ads-lead-outcome', { leadId }, { headers }), envOf(memory.kv, {}));
  assert.equal(missing.status, 400);
  assert.equal(JSON.parse(memory.store.get(`adslead:${leadId}`)!).outcome, 'booked', 'malformed requests leave the outcome alone');

  const cleared = await handlePortalAdsLeadOutcome(apiRequest('/api/portal/ads-lead-outcome', { leadId, outcome: '' }, { headers }), envOf(memory.kv, {}));
  assert.equal(cleared.status, 200, 'the portal clear button still works');
  assert.equal(JSON.parse(memory.store.get(`adslead:${leadId}`)!).outcome, null);
});

test('audit m6: ads onboarding rejects an invalid lead email', async () => {
  const memory = memoryKV();
  const { session } = await adsSetup(memory);
  const bad = await handlePortalAdsOnboarding(
    apiRequest('/api/portal/ads-onboarding', { leadEmail: 'not-an-email' }, { headers: { cookie: session.cookie } }),
    envOf(memory.kv, {}),
  );
  assert.equal(bad.status, 400);
  const good = await handlePortalAdsOnboarding(
    apiRequest('/api/portal/ads-onboarding', { leadEmail: 'leads@example.ca' }, { headers: { cookie: session.cookie } }),
    envOf(memory.kv, {}),
  );
  assert.equal(good.status, 200);
});

test('audit m6: ads intake surfaces a failed instant email instead of answering a silent ok', async () => {
  const memory = memoryKV();
  const { client } = await adsSetup(memory);
  const stub = stubFetch(smtpFail);
  try {
    const res = await handleAdsLeadIntake(
      apiRequest('/api/internal/ads-lead', { clientId: client.id, name: 'Lead Two' }, { headers: { authorization: 'Bearer ' + CRON_SECRET } }),
      envOf(memory.kv, { INTERNAL_CRON_SECRET: CRON_SECRET, SMTP2GO_API_KEY: 'k' }),
    );
    assert.equal(res.status, 200);
    const body = await bodyOf(res);
    assert.equal(body.emailed, false);
    assert.ok(memory.store.has(`adslead:${body.leadId}`), 'the lead itself is still recorded');
  } finally {
    stub.restore();
  }
});

// ---------------------------------------------------------------------------
// m7: month keys are validated (admin 400s, reports falls back to last month)
// ---------------------------------------------------------------------------

test('audit m7: admin ads-spend rejects month 2026-13', async () => {
  const memory = memoryKV();
  const client = await createClient(memory.kv, { email: 'owner@example.ca', source: 'stripe' });
  const headers = await adminHeaders(memory);
  const res = await handleAdmin(
    apiRequest('/api/admin/clients/ads-spend', { id: client.id, month: '2026-13', amountCents: 100 }, { headers }),
    envOf(memory.kv, {}),
    new URL('https://webao.ca/api/admin/clients/ads-spend'),
  );
  assert.equal(res.status, 400);
});

test('audit m7: monthly-reports ignores an invalid month and reports the previous month', async () => {
  const memory = memoryKV();
  const client = await createClient(memory.kv, { email: 'owner@example.ca', source: 'stripe' });
  client.stage = 'live';
  await saveClient(memory.kv, client);
  const stub = stubFetch(smtpOk);
  try {
    const res = await handleMonthlyReports(
      apiRequest('/api/internal/monthly-reports', { month: '2026-13' }, { headers: { authorization: 'Bearer ' + CRON_SECRET } }),
      envOf(memory.kv, { INTERNAL_CRON_SECRET: CRON_SECRET, SMTP2GO_API_KEY: 'k' }),
    );
    assert.equal(res.status, 200);
    assert.equal((await bodyOf(res)).sent, 1);
    const prev = previousMonthKey(Date.now());
    assert.ok(memory.store.has(`report:${client.id}:${prev}`), 'report written for the previous month');
    assert.ok(!memory.store.has(`report:${client.id}:2026-13`), 'nothing written for the invalid month');
  } finally {
    stub.restore();
  }
});

// ---------------------------------------------------------------------------
// m9/m21: follow-up cap and the index-independent sweep
// ---------------------------------------------------------------------------

test('audit m9/m21: 25 due abandoned checkouts email exactly 20, and records past the index are still swept', async () => {
  const memory = memoryKV();
  for (let i = 0; i < 25; i++) {
    const sid = `sess-${String(i).padStart(2, '0')}`;
    memory.store.set(`abandoned:${sid}`, JSON.stringify({
      sessionId: sid, email: `buyer${i}@example.ca`, items: ['launch-month'], lang: 'en',
      createdAt: Date.now() - 13 * 3600 * 1000, status: 'pending',
    }));
  }
  const stub = stubFetch(smtpOk);
  try {
    const res = await handleAbandonedFollowups(
      apiRequest('/api/internal/abandoned-followups', {}, { headers: { authorization: 'Bearer ' + CRON_SECRET } }),
      envOf(memory.kv, { INTERNAL_CRON_SECRET: CRON_SECRET, SMTP2GO_API_KEY: 'k' }),
    );
    assert.equal(res.status, 200);
    assert.deepEqual(await bodyOf(res), { ok: true, emailed: 20, converted: 0, stale: 0, pending: 5 });
    const emailed = [...memory.store.values()].filter((v) => JSON.parse(v).status === 'emailed').length;
    assert.equal(emailed, 20);
  } finally {
    stub.restore();
  }
});

// ---------------------------------------------------------------------------
// m17 + QA: checkout setup-fee rules and the auto-add ordering
// ---------------------------------------------------------------------------

test('audit m17: the Ads Pack setup fee cannot be bought on its own', async () => {
  const res = await handleCheckoutSession(
    apiRequest('/api/checkout/session', { email: 'buyer@example.ca', items: [{ key: 'ads-setup-onetime' }] }),
    envOf(memoryKV().kv, { STRIPE_PRICE_ADS_SETUP: 'price_setup' }),
  );
  assert.equal(res.status, 400);
});

test('audit checkout: pack + setup secret passes validation (blocked only at the missing Stripe secret)', async () => {
  const env = envOf(memoryKV().kv, { STRIPE_PRICE_ADS_SETUP: 'price_setup' });
  const packOnly = await handleCheckoutSession(
    apiRequest('/api/checkout/session', { email: 'buyer@example.ca', items: [{ key: 'ads-pack-month' }] }),
    env,
  );
  assert.equal(packOnly.status, 503, 'auto-added setup fee does not trip the caps');
  const packPlusSetup = await handleCheckoutSession(
    apiRequest('/api/checkout/session', { email: 'buyer@example.ca', items: [{ key: 'ads-pack-month' }, { key: 'ads-setup-onetime' }] }),
    env,
  );
  assert.equal(packPlusSetup.status, 503, 'an explicitly present setup fee is not added twice');
});

// ---------------------------------------------------------------------------
// m18: a domain change after first completion re-assigns, conflicts flagged
// ---------------------------------------------------------------------------

test('audit m18: post-completion domain change re-assigns; a conflict returns domainConflict and keeps the old domain', async () => {
  const memory = memoryKV();
  const client = await createClient(memory.kv, { email: 'owner@example.ca', source: 'stripe' });
  const session = await sessionFor(memory, client.id);
  const headers = { cookie: session.cookie };
  const env = envOf(memory.kv, {});
  const full = {
    businessName: 'Pat Plumbing', contactName: 'Pat', phone: '514-555-0100',
    services: 'Plumbing', serviceArea: 'Montreal', domainMode: 'new', domainValue: 'patplumbing.ca',
  };
  const first = await handlePortalOnboarding(apiRequest('/api/portal/onboarding', full, { headers }), env);
  assert.equal(first.status, 200);
  assert.equal((await getClient(memory.kv, client.id))!.domain, 'patplumbing.ca');

  const moved = await handlePortalOnboarding(apiRequest('/api/portal/onboarding', { domainValue: 'newdomain.ca' }, { headers }), env);
  assert.equal(moved.status, 200);
  assert.equal((await bodyOf(moved)).domainConflict, undefined);
  assert.equal((await getClient(memory.kv, client.id))!.domain, 'newdomain.ca');
  assert.equal(JSON.parse(memory.store.get('domain:newdomain.ca')!), 'client:' + client.id);

  const other = await createClient(memory.kv, { email: 'other@example.ca', source: 'stripe' });
  assert.deepEqual(await assignDomain(memory.kv, other, 'taken.ca', 'pending-dns'), { ok: true });
  await saveClient(memory.kv, other);

  const conflict = await handlePortalOnboarding(apiRequest('/api/portal/onboarding', { domainValue: 'taken.ca' }, { headers }), env);
  assert.equal(conflict.status, 200);
  assert.equal((await bodyOf(conflict)).domainConflict, true);
  assert.equal((await getClient(memory.kv, client.id))!.domain, 'newdomain.ca', 'conflict keeps the old domain');
  assert.equal(JSON.parse(memory.store.get('domain:newdomain.ca')!), 'client:' + client.id);
  assert.equal(JSON.parse(memory.store.get('domain:taken.ca')!), 'client:' + other.id);
});

// ---------------------------------------------------------------------------
// m13/m14/m15: QA word-boundary check, non-advancing notice, publish GC
// ---------------------------------------------------------------------------

function qaClient(memory: ReturnType<typeof memoryKV>, business: string) {
  return createClient(memory.kv, { email: 'owner@example.ca', source: 'stripe' }).then(async (client) => {
    client.business = business;
    client.stage = 'build';
    client.onboarding = {
      businessName: business,
      contactName: 'Pat',
      phone: '514-555-0100',
      services: 'Plumbing, Drain cleaning\nWater heaters',
      serviceArea: 'Montreal and the South Shore',
      hours: 'Mon to Fri, 8 am to 5 pm',
      about: 'Family plumbing company since 2009.',
      domainMode: 'existing',
      domainValue: 'patplumbing.ca',
    };
    client.onboardingCompletedAt = Date.now();
    await saveClient(memory.kv, client);
    return client;
  });
}

test('audit m13: a business literally named Todo Renovations passes the no-placeholder QA check', async () => {
  const memory = memoryKV();
  const client = await qaClient(memory, 'Todo Renovations');
  const files = generateSite(client);
  const qa = runQa(client, files);
  assert.equal(qa.checks.find((c) => c.id === 'no-placeholder')!.ok, true);
  assert.equal(qa.passed, true);

  // ...while genuine draft text still fails the same check.
  const draft = runQa(client, [{
    path: 'index.html',
    contentType: 'text/html',
    content: '<!doctype html><html lang="en"><head><title>Todo Renovations</title></head><body><h1>Todo Renovations</h1><p>TODO: write this section</p></body></html>',
  }]);
  assert.equal(draft.checks.find((c) => c.id === 'no-placeholder')!.ok, false);
});

test('audit QA: runQa enumerates exactly the 15 documented checks', async () => {
  const memory = memoryKV();
  const client = await qaClient(memory, 'Pat Plumbing');
  const qa = runQa(client, generateSite(client));
  assert.deepEqual(qa.checks.map((c) => c.id), [
    'files-present', 'doctype', 'title', 'meta-description', 'lang', 'single-h1',
    'phone-link', 'services-present', 'area-present', 'no-em-dash', 'no-placeholder',
    'links-resolve', 'contact-section', 'canonical', 'size-budget',
  ]);
});

test('audit QA: sitegen is deterministic for the same client', async () => {
  const memory = memoryKV();
  const client = await qaClient(memory, 'Pat Plumbing');
  assert.deepEqual(generateSite(client), generateSite(client));
});

test('audit m14: a QA pass for an onboarding-stage client does not advance the stage or set a preview URL', async () => {
  const memory = memoryKV();
  const client = await qaClient(memory, 'Pat Plumbing');
  client.stage = 'onboarding';
  await saveClient(memory.kv, client);
  const env = envOf(memory.kv, {});
  const result = await runBuild(env, client);
  assert.equal(result.qa.passed, true);
  const after = (await getClient(memory.kv, client.id))!;
  assert.equal(after.stage, 'onboarding');
  assert.equal(after.previewUrl, undefined);
  // The inbox notice wording ("Build passed QA", not "ready for review")
  // cannot be observed under node: notifyInbox imports the workerd-only
  // cloudflare:email module. The stage/preview assertions above are the
  // durable half of the fix; the wording is pinned in builds.ts.
});

test('audit m15: publishing twice garbage-collects the first build files', async () => {
  const memory = memoryKV();
  const client = await qaClient(memory, 'Pat Plumbing');
  const env = envOf(memory.kv, {});
  const first = await runBuild(env, client);
  const pub1 = await publishBuild(env, (await getClient(memory.kv, client.id))!);
  assert.equal(pub1.ok, true);
  const firstFileKeys = [...memory.store.keys()].filter((k) => k.startsWith(`site:${client.id}:${first.buildId}:`));
  assert.ok(firstFileKeys.length > 0, 'first build files exist before the second publish');

  const second = await runBuild(env, (await getClient(memory.kv, client.id))!);
  const pub2 = await publishBuild(env, (await getClient(memory.kv, client.id))!);
  assert.equal(pub2.ok, true);
  assert.equal([...memory.store.keys()].filter((k) => k.startsWith(`site:${client.id}:${first.buildId}:`)).length, 0, 'first build files are gone');
  assert.equal(memory.store.has(`build:${client.id}:${first.buildId}`), false, 'first build meta is gone');
  assert.ok([...memory.store.keys()].some((k) => k.startsWith(`site:${client.id}:${second.buildId}:`)), 'second build files remain');
  const state = await getBuildState(memory.kv, client.id);
  assert.equal(state.publishedBuildId, second.buildId);
});

// ---------------------------------------------------------------------------
// Portal/admin payload pins (QA M3): /me and the admin clients list
// ---------------------------------------------------------------------------

test('audit payload: /me carries paymentActionRequired and admin clients carries abandoned', async () => {
  const memory = memoryKV();
  const client = await createClient(memory.kv, { email: 'owner@example.ca', source: 'stripe' });
  client.paymentActionRequired = { invoiceId: 'in_1', url: 'https://pay.stripe.com/x', at: Date.now() };
  await saveClient(memory.kv, client);
  const session = await sessionFor(memory, client.id);
  const me = await handlePortalMe(apiGet('/api/portal/me', { headers: { cookie: session.cookie } }), envOf(memory.kv, {}));
  assert.equal(me.status, 200);
  assert.equal((await bodyOf(me)).client.paymentActionRequired.url, 'https://pay.stripe.com/x');

  memory.store.set('abandoned:sess_ab', JSON.stringify({
    sessionId: 'sess_ab', email: 'buyer@example.ca', items: ['launch-month'], lang: 'en',
    createdAt: Date.now() - 90000000, status: 'pending',
  }));
  memory.store.set('abandoned:index', JSON.stringify(['abandoned:sess_ab']));
  const headers = await adminHeaders(memory);
  const list = await handleAdmin(apiGet('/api/admin/clients', { headers }), envOf(memory.kv, {}), new URL('https://webao.ca/api/admin/clients'));
  assert.equal(list.status, 200);
  const body = await bodyOf(list);
  assert.equal(body.abandoned.length, 1);
  assert.equal(body.abandoned[0].email, 'buyer@example.ca');
});

// ---------------------------------------------------------------------------
// Source pins: frontend wiring the tests cannot execute under jsdom
// ---------------------------------------------------------------------------

test('audit pins: portal banner wiring and admin abandoned i18n exist in source', () => {
  const portal = readFileSync(new URL('../src/components/pages/PortalPage.astro', import.meta.url), 'utf-8');
  assert.ok(portal.includes('data-portal-payment-banner'), 'portal banner element');
  assert.ok(portal.includes('paymentActionRequired'), 'banner reads the client field');
  assert.ok(portal.includes('data-portal-msg-domain-conflict'), 'domain conflict note exists');
  const adminApp = readFileSync(new URL('../src/components/admin/admin-app.ts', import.meta.url), 'utf-8');
  assert.ok(adminApp.includes('abandonedTitle'), 'abandoned card uses the i18n key, not a literal');
  assert.ok(adminApp.includes('abandonedStatuses'), 'abandoned statuses are localized');
});
