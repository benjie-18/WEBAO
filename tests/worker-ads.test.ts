// Step 6: Ads Pack backbone — checkout setup fee, webhook ads track,
// portal ads onboarding, lead intake + outcomes, launch packet, reporting.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHmac } from 'node:crypto';
import { handleCheckoutSession, PRICE_MAP } from '../worker/checkout';
import { handleStripeWebhook } from '../worker/stripe-webhook';
import { handlePortalAdsOnboarding, handlePortalAdsLeadOutcome } from '../worker/portal';
import {
  adsReadiness,
  buildLaunchPacket,
  handleAdsLeadIntake,
  listAdsLeads,
  recordAdsLead,
  recordAdsSpend,
} from '../worker/ads';
import { handleMonthlyReports } from '../worker/reports';
import { createClient, getClient, saveClient, type Client } from '../worker/clients';
import { putJson } from '../worker/kv';
import { apiRequest, bodyOf, envOf, memoryKV } from './helpers';

function stubSmtpCapture() {
  const bodies: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_input: unknown, init?: { body?: unknown }) => {
    if (typeof init?.body === 'string') bodies.push(init.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: { succeeded: 1, failed: 0 } }),
    } as Response;
  }) as typeof fetch;
  return {
    bodies,
    restore() {
      globalThis.fetch = original;
    },
  };
}

async function sessionFor(memory: ReturnType<typeof memoryKV>, clientId: string) {
  const token = 'a'.repeat(64);
  await putJson(memory.kv, `portal-session:${token}`, { clientId, createdAt: Date.now() });
  return { cookie: `webao_portal=${token}` };
}

async function adsClient(memory: ReturnType<typeof memoryKV>): Promise<Client> {
  const client = await createClient(memory.kv, {
    email: 'ads@example.ca',
    source: 'stripe',
    items: ['launch-month', 'ads-pack-month'],
  });
  client.business = 'Pat Plumbing';
  await saveClient(memory.kv, client);
  return (await getClient(memory.kv, client.id))!;
}

test('checkout: ads pack monthly price comes from the price map and the setup fee rides along', async () => {
  const original = globalThis.fetch;
  let captured = '';
  globalThis.fetch = (async (_input: unknown, init?: { body?: unknown }) => {
    captured = typeof init?.body === 'string' ? init.body : '';
    return {
      ok: true,
      status: 200,
      json: async () => ({ client_secret: 'cs_test_x', line_items: { data: [] } }),
    } as Response;
  }) as typeof fetch;
  try {
    const env = {
      STRIPE_SECRET_KEY: 'sk_test',
      STRIPE_PRICE_ADS_SETUP: 'price_ads_setup',
    };
    const res = await handleCheckoutSession(
      new Request('https://webao.ca/api/checkout/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://webao.ca' },
        body: JSON.stringify({ email: 'a@b.ca', items: [{ key: 'ads-pack-month' }] }),
      }),
      env,
    );
    assert.equal(res.status, 200);
    const params = new URLSearchParams(captured);
    const prices = [...params.entries()]
      .filter(([k]) => /^line_items\[\d+\]\[price\]$/.test(k))
      .map(([, v]) => v);
    assert.deepEqual(prices.sort(), [PRICE_MAP['ads-pack-month'], 'price_ads_setup']);
    assert.ok((params.get('metadata[items]') || '').includes('ads-setup-onetime'));

    // Without the setup secret the pack still checks out, monthly price
    // only: the setup fee is added only when its secret is configured.
    const noSetup = await handleCheckoutSession(
      new Request('https://webao.ca/api/checkout/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://webao.ca' },
        body: JSON.stringify({ email: 'a@b.ca', items: [{ key: 'ads-pack-month' }] }),
      }),
      { STRIPE_SECRET_KEY: 'sk_test' },
    );
    assert.equal(noSetup.status, 200);
    const noSetupParams = new URLSearchParams(captured);
    const noSetupPrices = [...noSetupParams.entries()]
      .filter(([k]) => /^line_items\[\d+\]\[price\]$/.test(k))
      .map(([, v]) => v);
    assert.deepEqual(noSetupPrices, [PRICE_MAP['ads-pack-month']]);
  } finally {
    globalThis.fetch = original;
  }
});

test('webhook: buying the pack opens the ads onboarding track', async () => {
  const WH_SECRET = ['whsec', 'ads', 'test'].join('_');
  const memory = memoryKV();
  const event = {
    id: 'evt_ads_1',
    type: 'checkout.session.completed',
    created: 1792800000,
    data: {
      object: {
        customer: 'cus_ads',
        subscription: 'sub_ads',
        customer_details: { email: 'buyer@example.ca', name: 'Buyer' },
        metadata: { items: 'launch-month,ads-pack-month,ads-setup-onetime' },
      },
    },
  };
  const raw = JSON.stringify(event);
  const ts = Math.floor(Date.now() / 1000);
  const v1 = createHmac('sha256', WH_SECRET).update(`${ts}.${raw}`).digest('hex');
  const res = await handleStripeWebhook(
    new Request('https://webao.ca/api/stripe/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': `t=${ts},v1=${v1}` },
      body: raw,
    }),
    envOf(memory.kv, { STRIPE_WEBHOOK_SECRET: WH_SECRET }),
  );
  assert.equal(res.status, 200);
  const keys = [...memory.store.keys()].filter(
    (k) => k.startsWith('client:') && !k.startsWith('client-customer:'),
  );
  assert.equal(keys.length, 1);
  const client = await getClient(memory.kv, keys[0].slice('client:'.length));
  assert.equal(client!.ads?.status, 'onboarding');
  assert.equal(client!.ads?.platform, 'meta');
});

test('portal ads onboarding: the budget floor and completeness gate hold', async () => {
  const memory = memoryKV();
  const client = await adsClient(memory);
  client.ads = { status: 'onboarding', platform: 'meta', updatedAt: Date.now() };
  await saveClient(memory.kv, client);
  const headers = await sessionFor(memory, client.id);
  const env = envOf(memory.kv, {});

  const low = await handlePortalAdsOnboarding(
    apiRequest('/api/portal/ads-onboarding', {
      trade: 'plumbing',
      serviceArea: 'Montreal',
      monthlyBudget: 1000,
      leadEmail: 'leads@patplumbing.ca',
      websiteUrl: 'https://patplumbing.ca',
    }, { headers }),
    env,
  );
  const lowOut = await bodyOf(low);
  assert.equal(lowOut.ads.complete, false, 'budget below the $1,500 floor is not complete');
  assert.equal(lowOut.ads.status, 'onboarding');

  const full = await handlePortalAdsOnboarding(
    apiRequest('/api/portal/ads-onboarding', { monthlyBudget: 1500 }, { headers }),
    env,
  );
  const fullOut = await bodyOf(full);
  assert.equal(fullOut.ads.complete, true);
  assert.equal(fullOut.ads.status, 'setup');
  const stored = await getClient(memory.kv, client.id);
  assert.ok(stored!.ads?.onboardingCompletedAt);
});

test('lead intake: stored, gated to pack clients, outcomes mark from the portal', async () => {
  const memory = memoryKV();
  const client = await adsClient(memory);
  client.ads = { status: 'live', platform: 'meta', updatedAt: Date.now() };
  await saveClient(memory.kv, client);
  const plain = await createClient(memory.kv, { email: 'plain@example.ca', source: 'stripe' });
  const stub = stubSmtpCapture();
  try {
    const env = envOf(memory.kv, { INTERNAL_CRON_SECRET: 'sek', SMTP2GO_API_KEY: 'k' });
    const headers = { authorization: 'Bearer sek' };

    const wrongSecret = await handleAdsLeadIntake(
      apiRequest('/api/internal/ads-lead', { clientId: client.id, name: 'X' }, { headers: { authorization: 'Bearer no' } }),
      env,
    );
    assert.equal(wrongSecret.status, 401);

    const noPack = await handleAdsLeadIntake(
      apiRequest('/api/internal/ads-lead', { clientId: plain.id, name: 'X' }, { headers }),
      env,
    );
    assert.equal(noPack.status, 409);

    const ok = await handleAdsLeadIntake(
      apiRequest('/api/internal/ads-lead', {
        clientId: client.id,
        name: 'Marie',
        phone: '514-555-0199',
        service: 'Drain cleaning',
      }, { headers }),
      env,
    );
    assert.equal(ok.status, 200);
    const leads = await listAdsLeads(memory.kv, client.id);
    assert.equal(leads.length, 1);
    assert.equal(leads[0].name, 'Marie');
    assert.ok(stub.bodies.some((b) => b.includes('Marie')), 'lead emailed to the client');

    const session = await sessionFor(memory, client.id);
    const marked = await handlePortalAdsLeadOutcome(
      apiRequest('/api/portal/ads-lead-outcome', { leadId: leads[0].id, outcome: 'booked' }, { headers: session }),
      envOf(memory.kv, {}),
    );
    assert.equal(marked.status, 200);
    assert.equal((await listAdsLeads(memory.kv, client.id))[0].outcome, 'booked');

    // Another client cannot touch this lead.
    const other = await sessionFor(memory, plain.id);
    const foreign = await handlePortalAdsLeadOutcome(
      apiRequest('/api/portal/ads-lead-outcome', { leadId: leads[0].id, outcome: 'not-fit' }, { headers: other }),
      envOf(memory.kv, {}),
    );
    assert.equal(foreign.status, 404);
  } finally {
    stub.restore();
  }
});

test('launch packet: template filled from onboarding, readiness gates on the account', async () => {
  const memory = memoryKV();
  const client = await adsClient(memory);
  client.ads = {
    status: 'setup',
    platform: 'meta',
    updatedAt: Date.now(),
    onboarding: {
      trade: 'plumbing',
      serviceArea: 'Montreal',
      monthlyBudget: 1500,
      leadEmail: 'leads@patplumbing.ca',
      websiteUrl: 'https://patplumbing.ca',
    },
  };
  const packet = buildLaunchPacket(client);
  assert.equal(packet.dailyBudget, 50);
  assert.equal(packet.landingPage, 'https://patplumbing.ca');
  assert.ok(packet.headlines.some((h) => h.includes('Montreal')));
  assert.ok(packet.primaryTexts.some((t) => t.includes('Pat Plumbing')));
  assert.equal(packet.ready, false, 'no ad account connected yet');
  assert.equal(adsReadiness(client).find((c) => c.id === 'account')?.ok, false);

  client.ads.adAccountId = 'act_123';
  assert.equal(buildLaunchPacket(client).ready, true);
});

test('monthly report: standalone ads clients get leads, booked and cost numbers', async () => {
  const memory = memoryKV();
  const client = await adsClient(memory);
  client.stage = 'onboarding'; // no website: ads only
  client.ads = { status: 'live', platform: 'meta', updatedAt: Date.now() };
  await saveClient(memory.kv, client);
  const sep = Date.UTC(2026, 8, 10);
  const l1 = await recordAdsLead(memory.kv, client.id, { name: 'A', at: sep });
  await recordAdsLead(memory.kv, client.id, { name: 'B', at: sep + 1000 });
  const { getJson, putJson: pj } = await import('../worker/kv');
  const lead1 = await getJson<Record<string, unknown>>(memory.kv, `adslead:${l1.id}`);
  lead1!.outcome = 'booked';
  await pj(memory.kv, `adslead:${l1.id}`, lead1);
  await recordAdsSpend(memory.kv, client.id, '2026-09', 90000);

  const stub = stubSmtpCapture();
  try {
    const env = envOf(memory.kv, { INTERNAL_CRON_SECRET: 's', SMTP2GO_API_KEY: 'k' });
    const res = await handleMonthlyReports(
      apiRequest('/api/internal/monthly-reports', { month: '2026-09' }, { headers: { authorization: 'Bearer s' } }),
      env,
    );
    const out = await bodyOf(res);
    assert.equal(out.sent, 1);
    const mail = stub.bodies.join('\n');
    assert.ok(mail.includes('Leads received: 2'), 'lead count in the report');
    assert.ok(mail.includes('Jobs booked'), 'booked count in the report');
    assert.ok(mail.includes('Cost per lead: $450.00'), 'cost per lead from the spend record');
    assert.ok(mail.includes('Cost per booked job: $900.00'), 'cost per booked job');
  } finally {
    stub.restore();
  }
});

test('checkout: revamped ads variants map to the right Stripe prices and setup fees', async () => {
  const original = globalThis.fetch;
  let captured = '';
  globalThis.fetch = (async (_input: unknown, init?: { body?: unknown }) => {
    captured = typeof init?.body === 'string' ? init.body : '';
    return {
      ok: true,
      status: 200,
      json: async () => ({ client_secret: 'cs_test_x', line_items: { data: [] } }),
    } as Response;
  }) as typeof fetch;
  try {
    const prices = () =>
      [...new URLSearchParams(captured).entries()]
        .filter(([k]) => /^line_items\[\d+\]\[price\]$/.test(k))
        .map(([, v]) => v);
    const call = (items: Array<{ key: string }>, env: Record<string, unknown>) =>
      handleCheckoutSession(
        new Request('https://webao.ca/api/checkout/session', {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: 'https://webao.ca' },
          body: JSON.stringify({ email: 'a@b.ca', items }),
        }),
        env,
      );

    // Both channels: bundle monthly plus bundle setup, even with no setup secret.
    let res = await call([{ key: 'ads-both-month' }], { STRIPE_SECRET_KEY: 'sk_test' });
    assert.equal(res.status, 200);
    assert.deepEqual(prices().sort(), [PRICE_MAP['ads-both-month'], 'price_1UWkEvE57vVzxI41jrWbtpuZ'].sort());

    // Single Google channel: single monthly plus the single setup secret.
    res = await call([{ key: 'ads-google-month' }], {
      STRIPE_SECRET_KEY: 'sk_test',
      STRIPE_PRICE_ADS_SETUP: 'price_ads_setup',
    });
    assert.equal(res.status, 200);
    assert.deepEqual(prices().sort(), [PRICE_MAP['ads-google-month'], 'price_ads_setup'].sort());

    // GBP revamp alone: one-time only, no setup fee attached.
    res = await call([{ key: 'gbp-revamp-one-time' }], { STRIPE_SECRET_KEY: 'sk_test' });
    assert.equal(res.status, 200);
    assert.deepEqual(prices(), [PRICE_MAP['gbp-revamp-onetime']]);

    // Two Ads Pack variants in one cart are rejected, not double-billed.
    res = await call([{ key: 'ads-meta-month' }, { key: 'ads-both-month' }], { STRIPE_SECRET_KEY: 'sk_test' });
    assert.equal(res.status, 400);
  } finally {
    globalThis.fetch = original;
  }
});

test('ads platform and minimum budget follow the purchased variant', async () => {
  const { adsMinMonthlyBudget, adsPlatformFromItems, hasAdsPack } = await import('../worker/clients');
  assert.equal(adsPlatformFromItems(['ads-meta-month']), 'meta');
  assert.equal(adsPlatformFromItems(['ads-google-month']), 'google');
  assert.equal(adsPlatformFromItems(['ads-both-month']), 'both');
  assert.equal(adsPlatformFromItems(['ads-pack-month']), 'meta');
  assert.equal(adsPlatformFromItems(['launch-month']), undefined);
  assert.equal(hasAdsPack({ items: ['ads-google-month'] } as never), true);
  assert.equal(hasAdsPack({ items: ['gbp-revamp-one-time'] } as never), false);
  const memory = memoryKV();
  const both = await createClient(memory.kv, { email: 'both@example.ca', source: 'stripe', items: ['ads-both-month'] });
  assert.equal(adsMinMonthlyBudget(both), 2500);
  const single = await createClient(memory.kv, { email: 'single@example.ca', source: 'stripe', items: ['ads-google-month'] });
  assert.equal(adsMinMonthlyBudget(single), 1500);
});
