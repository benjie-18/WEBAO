// Phase-2 audit round-2 regressions: fixes for the incompletenesses and
// missed defects the phase-2 re-scan found (backend m13/M2/m22 residuals,
// UI/UX N1-N4 contrast, QA test/doc gaps). Each test pins the new behavior
// and would fail with the round-1 code.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runQa } from '../worker/builds';
import { generateSite } from '../worker/sitegen';
import { createClient, getClient, saveClient } from '../worker/clients';
import { assignDomain } from '../worker/tenants';
import { getJson } from '../worker/kv';
import { handleStripeWebhook } from '../worker/stripe-webhook';
import worker from '../worker/index';
import {
  handleOnboardingNudges,
  handlePortalExchange,
  handlePortalLogout,
  handlePortalMe,
  handlePortalRequestLink,
} from '../worker/portal';
import { sendClientEmail } from '../worker/mailer';
import { apiGet, apiRequest, bodyOf, envOf, memoryKV } from './helpers';

const DAY = 24 * 3600 * 1000;
const CRON_SECRET = 'test-cron-' + 'secret-123';
const WEBHOOK_SECRET = 'whsec_' + 'test-audit-secret';

function stubFetch(handler: (url: string) => { ok: boolean; body: unknown }) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const r = handler(String(input));
    return { ok: r.ok, status: r.ok ? 200 : 404, json: async () => r.body } as Response;
  }) as typeof fetch;
  return {
    restore() {
      globalThis.fetch = original;
    },
  };
}

const smtpOk = (url: string) =>
  url.includes('smtp2go')
    ? { ok: true, body: { data: { succeeded: 1, failed: 0 } } }
    : { ok: false, body: {} };

function cookieOf(res: Response): string {
  const set = res.headers.get('set-cookie') || '';
  const m = /webao_portal=([a-f0-9]+)/.exec(set);
  assert.ok(m, 'session cookie issued');
  return `webao_portal=${m![1]}`;
}

async function signedInCookie(memory: ReturnType<typeof memoryKV>, email = 'owner@example.ca') {
  const client = await createClient(memory.kv, { email, name: 'Pat', items: ['launch-month'], source: 'stripe' });
  const stub = stubFetch(smtpOk);
  try {
    const env = envOf(memory.kv, { SMTP2GO_API_KEY: 'test-key' });
    await handlePortalRequestLink(apiRequest('/api/portal/request-link', { email }), env);
    const token = [...memory.store.keys()].find((k) => k.startsWith('portal-login:'))!.slice('portal-login:'.length);
    const exchanged = await handlePortalExchange(apiRequest('/api/portal/exchange', { token }), env);
    return { client, cookie: cookieOf(exchanged), env };
  } finally {
    stub.restore();
  }
}

function qaClient(memory: ReturnType<typeof memoryKV>, overrides: Record<string, string>) {
  return createClient(memory.kv, { email: 'owner@example.ca', source: 'stripe' }).then(async (client) => {
    client.business = overrides.businessName || 'Pat Plumbing';
    client.stage = 'build';
    client.onboarding = {
      businessName: overrides.businessName || 'Pat Plumbing',
      contactName: 'Pat',
      phone: '514-555-0100',
      services: overrides.services || 'Plumbing, Drain cleaning\nWater heaters',
      serviceArea: overrides.serviceArea || 'Montreal and the South Shore',
      hours: 'Mon to Fri, 8 am to 5 pm',
      about: overrides.about || 'Family plumbing company since 2009.',
    };
    await saveClient(memory.kv, client);
    return client;
  });
}

// ---------------------------------------------------------------------------
// m13 completion: services + escaped names must not trip the QA check
// ---------------------------------------------------------------------------

test('round2 m13: a service literally named "Todo list coaching" passes no-placeholder', async () => {
  const memory = memoryKV();
  const client = await qaClient(memory, { services: 'Todo list coaching, Plumbing' });
  const qa = runQa(client, generateSite(client));
  assert.equal(qa.checks.find((c) => c.id === 'no-placeholder')!.ok, true);
  assert.equal(qa.passed, true);
});

test('round2 m13: a business named "Todo & Sons" passes (escaped rendering)', async () => {
  const memory = memoryKV();
  const client = await qaClient(memory, { businessName: 'Todo & Sons' });
  const qa = runQa(client, generateSite(client));
  assert.equal(qa.checks.find((c) => c.id === 'no-placeholder')!.ok, true);
  assert.equal(qa.passed, true);
});

test('round2 QA: escaped service and area still count as present', async () => {
  const memory = memoryKV();
  const client = await qaClient(memory, {
    services: 'A & B Plumbing',
    serviceArea: 'Montreal & Laval',
  });
  const qa = runQa(client, generateSite(client));
  assert.equal(qa.checks.find((c) => c.id === 'services-present')!.ok, true);
  assert.equal(qa.checks.find((c) => c.id === 'area-present')!.ok, true);
  assert.equal(qa.passed, true);
});

// ---------------------------------------------------------------------------
// M2 completion: new mapping written before the old one is deleted
// ---------------------------------------------------------------------------

test('round2 M2: a domain change moves the mapping old -> new', async () => {
  const memory = memoryKV();
  const client = await createClient(memory.kv, { email: 'owner@example.ca', source: 'stripe' });
  await assignDomain(memory.kv, client, 'old.ca', 'pending-dns');
  await saveClient(memory.kv, client);
  assert.equal(JSON.parse(memory.store.get('domain:old.ca')!), 'client:' + client.id);

  await assignDomain(memory.kv, client, 'new.ca', 'pending-dns');
  await saveClient(memory.kv, client);
  assert.equal(memory.store.get('domain:old.ca'), undefined, 'old mapping removed');
  assert.equal(JSON.parse(memory.store.get('domain:new.ca')!), 'client:' + client.id);
  assert.equal((await getClient(memory.kv, client.id))!.domain, 'new.ca');
});

test('round2 M2: a failing old-mapping delete leaves BOTH mappings (site not broken)', async () => {
  const memory = memoryKV();
  const client = await createClient(memory.kv, { email: 'owner@example.ca', source: 'stripe' });
  await assignDomain(memory.kv, client, 'old.ca', 'pending-dns');
  await saveClient(memory.kv, client);

  const origDelete = memory.kv.delete.bind(memory.kv);
  memory.kv.delete = (async (key: string) => {
    if (key === 'domain:old.ca') throw new Error('KV delete outage');
    return origDelete(key);
  }) as typeof memory.kv.delete;

  // deleteKey wraps write failures in KvWriteError; the message is the
  // wrapper's, the cause is the outage. The mapping assertions below are
  // the real discriminator against the old delete-first order.
  await assert.rejects(assignDomain(memory.kv, client, 'new.ca', 'pending-dns'), (e: unknown) => {
    assert.ok(e instanceof Error && e.message === 'KV write failed');
    assert.ok((e as { cause?: unknown }).cause instanceof Error);
    return true;
  });
  assert.equal(JSON.parse(memory.store.get('domain:new.ca')!), 'client:' + client.id, 'new mapping written first');
  assert.equal(JSON.parse(memory.store.get('domain:old.ca')!), 'client:' + client.id, 'old mapping survives the failed delete');
});

// ---------------------------------------------------------------------------
// m22 completion: the webhook email path fails closed, portal stays silent
// ---------------------------------------------------------------------------

function sign(rawBody: string, ts: number = Math.floor(Date.now() / 1000)): string {
  const v1 = createHmac('sha256', WEBHOOK_SECRET).update(`${ts}.${rawBody}`).digest('hex');
  return `t=${ts},v1=${v1}`;
}

test('round2 m22: webhook with a throwing email-path read answers 500, no duplicate client', async () => {
  const memory = memoryKV();
  const client = await createClient(memory.kv, { email: 'owner@example.ca', source: 'stripe' });
  await saveClient(memory.kv, client);

  // Record reads throw; mapping + index reads behave normally. Forward
  // all arguments: kv.get(key, { type: 'json' }) must keep parsing.
  const origGet = memory.kv.get.bind(memory.kv);
  memory.kv.get = (async (...args: [string, ...unknown[]]) => {
    if (args[0].startsWith('client:')) throw new Error('KV read outage');
    return (origGet as (...a: unknown[]) => unknown)(...args);
  }) as typeof memory.kv.get;

  const event = {
    id: 'evt_m22b_1',
    type: 'checkout.session.completed',
    created: 1792800000,
    data: {
      object: {
        customer: 'cus_missing',
        customer_email: 'owner@example.ca',
        customer_details: { email: 'owner@example.ca', name: 'Pat Proprio' },
        metadata: { items: 'launch-month' },
      },
    },
  };
  const raw = JSON.stringify(event);
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
  const res = await worker.fetch(
    new Request('https://webao.ca/api/stripe/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': sign(raw) },
      body: raw,
    }),
    envOf(memory.kv, { STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET }) as never,
    ctx,
  );
  assert.equal(res.status, 500);
  assert.deepEqual(await bodyOf(res), { ok: false, error: 'Internal error' });
  const clients = [...memory.store.keys()].filter((k) => k.startsWith('client:') && !k.startsWith('client-customer:') && !k.startsWith('client-email:'));
  assert.equal(clients.length, 1, 'no duplicate client created');
});

test('round2 m22: webhook with a failing index-list read answers 500, no duplicate client', async () => {
  const memory = memoryKV();
  const client = await createClient(memory.kv, { email: 'owner@example.ca', source: 'stripe' });
  await saveClient(memory.kv, client);
  // Pre-fix client: reachable only via the index scan, not the mapping.
  memory.store.delete('client-email:owner@example.ca');

  const origGet = memory.kv.get.bind(memory.kv);
  memory.kv.get = (async (...args: [string, ...unknown[]]) => {
    if (args[0] === 'clients:index') throw new Error('KV read outage');
    return (origGet as (...a: unknown[]) => unknown)(...args);
  }) as typeof memory.kv.get;

  const event = {
    id: 'evt_m22c_1',
    type: 'checkout.session.completed',
    created: 1792800000,
    data: {
      object: {
        customer: 'cus_missing',
        customer_email: 'owner@example.ca',
        customer_details: { email: 'owner@example.ca', name: 'Pat Proprio' },
        metadata: { items: 'launch-month' },
      },
    },
  };
  const raw = JSON.stringify(event);
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
  const res = await worker.fetch(
    new Request('https://webao.ca/api/stripe/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': sign(raw) },
      body: raw,
    }),
    envOf(memory.kv, { STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET }) as never,
    ctx,
  );
  assert.equal(res.status, 500);
  const clients = [...memory.store.keys()].filter((k) => k.startsWith('client:') && !k.startsWith('client-customer:') && !k.startsWith('client-email:'));
  assert.equal(clients.length, 1, 'no duplicate client created');
});

test('round2 m22: portal request-link stays silent when the record read fails', async () => {
  const memory = memoryKV();
  const client = await createClient(memory.kv, { email: 'owner@example.ca', source: 'stripe' });
  await saveClient(memory.kv, client);

  const origGet = memory.kv.get.bind(memory.kv);
  memory.kv.get = (async (...args: [string, ...unknown[]]) => {
    if (args[0].startsWith('client:')) throw new Error('KV read outage');
    return (origGet as (...a: unknown[]) => unknown)(...args);
  }) as typeof memory.kv.get;

  const res = await handlePortalRequestLink(
    apiRequest('/api/portal/request-link', { email: 'owner@example.ca' }),
    envOf(memory.kv, {}),
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await bodyOf(res), { ok: true });
  assert.equal([...memory.store.keys()].some((k) => k.startsWith('portal-login:')), false, 'no token minted');
});

// ---------------------------------------------------------------------------
// QA gaps: logout, /me null flag, mailer tally, request-link send failure,
// sweep size, canonical + size-budget failing fixtures
// ---------------------------------------------------------------------------

test('round2 QA: portal logout drops the session and clears the cookie', async () => {
  const memory = memoryKV();
  const { cookie, env } = await signedInCookie(memory);
  assert.equal([...memory.store.keys()].some((k) => k.startsWith('portal-session:')), true);

  const res = await handlePortalLogout(apiGet('/api/portal/logout', { headers: { cookie } }), env);
  assert.equal(res.status, 200);
  assert.equal([...memory.store.keys()].some((k) => k.startsWith('portal-session:')), false);
  assert.match(res.headers.get('set-cookie') || '', /webao_portal=;.*Max-Age=0/);
});

test('round2 QA: /me carries paymentActionRequired null when no action is pending', async () => {
  const memory = memoryKV();
  const { cookie, env } = await signedInCookie(memory);
  const me = await handlePortalMe(apiGet('/api/portal/me', { headers: { cookie } }), env);
  assert.equal(me.status, 200);
  assert.equal((await bodyOf(me)).client.paymentActionRequired, null);
});

test('round2 QA: sendClientEmail treats a 200 with succeeded: 0 as failure', async () => {
  const stub = stubFetch((url) =>
    url.includes('smtp2go')
      ? { ok: true, body: { data: { succeeded: 0, failed: 1 } } }
      : { ok: false, body: {} },
  );
  try {
    assert.equal(
      await sendClientEmail({ SMTP2GO_API_KEY: 'test-key' }, { to: 'a@b.ca', subject: 'Hi', text: 'Hello' }),
      false,
    );
  } finally {
    stub.restore();
  }
});

test('round2 QA: request-link send failure mints no token and stays silent', async () => {
  const memory = memoryKV();
  await createClient(memory.kv, { email: 'owner@example.ca', source: 'stripe' });
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('smtp down');
  }) as typeof fetch;
  try {
    const res = await handlePortalRequestLink(
      apiRequest('/api/portal/request-link', { email: 'owner@example.ca' }),
      envOf(memory.kv, { SMTP2GO_API_KEY: 'test-key' }),
    );
    assert.equal(res.status, 200);
    assert.deepEqual(await bodyOf(res), { ok: true });
    assert.equal([...memory.store.keys()].some((k) => k.startsWith('portal-login:')), false);
  } finally {
    globalThis.fetch = original;
  }
});

test('round2 QA: the nudge sweep covers more than 200 clients', async () => {
  const memory = memoryKV();
  for (let i = 0; i < 201; i++) {
    const client = await createClient(memory.kv, { email: `c${i}@example.ca`, source: 'stripe' });
    client.createdAt = Date.now() - 3 * DAY;
    await saveClient(memory.kv, client);
  }
  const stub = stubFetch(smtpOk);
  try {
    const res = await handleOnboardingNudges(
      apiRequest('/api/internal/onboarding-nudges', {}, { headers: { authorization: 'Bearer ' + CRON_SECRET } }),
      envOf(memory.kv, { INTERNAL_CRON_SECRET: CRON_SECRET, SMTP2GO_API_KEY: 'test-key' }),
    );
    assert.equal(res.status, 200);
    assert.equal((await bodyOf(res)).nudged, 201);
  } finally {
    stub.restore();
  }
});

test('round2 QA: canonical fails when the domain is set but the link is missing', async () => {
  const memory = memoryKV();
  const client = await qaClient(memory, {});
  client.domain = 'patplumbing.ca';
  await saveClient(memory.kv, client);
  const files = generateSite(client);
  assert.equal(runQa(client, files).checks.find((c) => c.id === 'canonical')!.ok, true, 'control: generated site passes');
  const stripped = files.map((f) =>
    f.path === 'index.html'
      ? { ...f, content: f.content.replace(/<link rel="canonical"[^>]*>\n?/, '') }
      : f,
  );
  assert.equal(runQa(client, stripped).checks.find((c) => c.id === 'canonical')!.ok, false);
});

test('round2 QA: size-budget fails past 200000 bytes', async () => {
  const memory = memoryKV();
  const client = await qaClient(memory, {});
  const big = runQa(client, [{ path: 'index.html', contentType: 'text/html', content: 'x'.repeat(200_001) }]);
  assert.equal(big.checks.find((c) => c.id === 'size-budget')!.ok, false);
  const atCap = runQa(client, [{ path: 'index.html', contentType: 'text/html', content: 'x'.repeat(200_000) }]);
  assert.equal(atCap.checks.find((c) => c.id === 'size-budget')!.ok, true, 'exactly at budget passes');
});

// ---------------------------------------------------------------------------
// Source pins: round-2 contrast + doc fixes exist in source
// ---------------------------------------------------------------------------

test('round2 pins: contrast fixes and doc corrections exist in source', () => {
  const css = readFileSync(new URL('../src/styles/global.css', import.meta.url), 'utf-8');
  assert.ok(css.includes('.sticky-cta-btn {') && /background: var\(--btn-primary-bg\);/.test(css), 'sticky CTA uses the primary token');
  const intro = readFileSync(new URL('../src/components/anim/IntroSequence.astro', import.meta.url), 'utf-8');
  assert.ok(intro.includes('background: var(--btn-primary-bg);'), 'reduced-motion intro button uses the primary token');
  assert.ok(intro.includes('background: var(--btn-primary-hover-bg);'), 'reduced-motion intro hover uses the primary hover token');
  const home = readFileSync(new URL('../src/components/pages/HomePage.astro', import.meta.url), 'utf-8');
  assert.ok(home.includes('.margin-note-tag { font-size: 10px; letter-spacing: .14em; color: var(--accent-text); }'), 'margin tag uses accent-text');
  assert.ok(home.includes('.process { --journey-accent: var(--btn-primary-bg); }'), 'journey accent uses the primary token');
  assert.ok(home.includes('html[data-theme="dark"] .hero-title .hero-italic { color: var(--accent-text); }'), 'dark hero italic override');
  assert.ok(home.includes('html[data-theme="dark"] .cta-statement-title span { color: var(--accent-text); }'), 'dark final-CTA override');
  assert.ok(home.includes('html[data-theme="dark"] .offer-link:hover .offer-link-cta { color: var(--accent-text);'), 'dark offer-link hover override');
  assert.ok(home.includes("onHomeDispose(() => narrow.removeEventListener('change', onNarrow));"), 'narrow listener disposed');
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf-8');
  assert.equal(readme.includes('CursorJourney'), false, 'no CursorJourney mention left in README');
  const i18n = readFileSync(new URL('../src/lib/i18n/index.ts', import.meta.url), 'utf-8');
  assert.ok(i18n.includes('It does NOT guard call-site typos'), 'i18n comment no longer overclaims');
  const api = readFileSync(new URL('../worker/API.md', import.meta.url), 'utf-8');
  assert.ok(api.includes('domainConflict: true'), 'domainConflict documented');
  assert.ok(api.includes('At most 20 follow-ups per run'), 'follow-up cap documented');
  assert.ok(api.includes('domainStatus, domainCheckedAt, reviewDecision, revisionCount'), 'clients list shape completed');
});
