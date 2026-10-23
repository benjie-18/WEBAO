// Client portal: magic-link sign-in, checkout claim, onboarding save and
// stage advance, admin client management, and the onboarding nudge job.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  handleOnboardingNudges,
  handlePortalClaim,
  handlePortalExchange,
  handlePortalMe,
  handlePortalOnboarding,
  handlePortalRequestLink,
} from '../worker/portal';
import { handleAdmin } from '../worker/admin';
import { createClient, getClient, saveClient } from '../worker/clients';
import { apiGet, apiRequest, bodyOf, envOf, memoryKV } from './helpers';

const DAY = 24 * 3600 * 1000;

/** Stub fetch for SMTP2GO / Stripe calls; records URLs, restores nothing. */
function stubFetch(handler: (url: string) => { ok: boolean; body: unknown }) {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    calls.push(url);
    const r = handler(url);
    return { ok: r.ok, status: r.ok ? 200 : 404, json: async () => r.body } as Response;
  }) as typeof fetch;
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

const smtpOk = (url: string) =>
  url.includes('smtp2go')
    ? { ok: true, body: { data: { succeeded: 1, failed: 0 } } }
    : { ok: false, body: {} };

async function seedClient(memory: ReturnType<typeof memoryKV>, email = 'owner@example.ca') {
  return createClient(memory.kv, { email, name: 'Pat', items: ['launch-month'], source: 'stripe' });
}

function cookieOf(res: Response): string {
  const set = res.headers.get('set-cookie') || '';
  const m = /webao_portal=([a-f0-9]+)/.exec(set);
  assert.ok(m, 'session cookie issued');
  return `webao_portal=${m![1]}`;
}

test('request-link: unknown email is a silent ok, known email without mail config is 503', async () => {
  const memory = memoryKV();
  await seedClient(memory);
  const env = envOf(memory.kv, {});

  const unknown = await handlePortalRequestLink(apiRequest('/api/portal/request-link', { email: 'nobody@example.ca' }), env);
  assert.equal(unknown.status, 200);
  assert.equal([...memory.store.keys()].some((k) => k.startsWith('portal-login:')), false);

  const known = await handlePortalRequestLink(apiRequest('/api/portal/request-link', { email: 'owner@example.ca' }), env);
  assert.equal(known.status, 503);
});

test('magic link: request, exchange once, session reads me, token cannot be reused', async () => {
  const memory = memoryKV();
  const client = await seedClient(memory);
  const stub = stubFetch(smtpOk);
  try {
    const env = envOf(memory.kv, { SMTP2GO_API_KEY: 'test-key' });
    const res = await handlePortalRequestLink(apiRequest('/api/portal/request-link', { email: 'Owner@Example.ca' }), env);
    assert.equal(res.status, 200);
    assert.ok(stub.calls.some((u) => u.includes('smtp2go')), 'sign-in mail sent');

    const tokenKey = [...memory.store.keys()].find((k) => k.startsWith('portal-login:'));
    assert.ok(tokenKey);
    const token = tokenKey!.slice('portal-login:'.length);

    const exchanged = await handlePortalExchange(apiRequest('/api/portal/exchange', { token }), env);
    assert.equal(exchanged.status, 200);
    const cookie = cookieOf(exchanged);
    assert.equal(memory.store.has(tokenKey!), false, 'one-time token consumed');

    const replay = await handlePortalExchange(apiRequest('/api/portal/exchange', { token }), env);
    assert.equal(replay.status, 401);

    const me = await handlePortalMe(apiGet('/api/portal/me', { headers: { cookie } }), env);
    assert.equal(me.status, 200);
    const view = (await bodyOf(me)).client;
    assert.equal(view.email, 'owner@example.ca');
    assert.equal(view.stage, 'onboarding');
    assert.equal(view.onboardingComplete, false);
    assert.equal(client.id.startsWith('cl_'), true);

    const anon = await handlePortalMe(apiGet('/api/portal/me'), env);
    assert.equal(anon.status, 401);
  } finally {
    stub.restore();
  }
});

test('onboarding: partial save keeps stage, complete save advances to build', async () => {
  const memory = memoryKV();
  const client = await seedClient(memory);
  const stub = stubFetch(smtpOk);
  try {
    const env = envOf(memory.kv, { SMTP2GO_API_KEY: 'test-key' });
    await handlePortalRequestLink(apiRequest('/api/portal/request-link', { email: 'owner@example.ca' }), env);
    const token = [...memory.store.keys()].find((k) => k.startsWith('portal-login:'))!.slice('portal-login:'.length);
    const exchanged = await handlePortalExchange(apiRequest('/api/portal/exchange', { token }), env);
    const cookie = cookieOf(exchanged);
    const headers = { cookie };

    const partial = await handlePortalOnboarding(
      apiRequest('/api/portal/onboarding', { businessName: 'Pat Plumbing' }, { headers }),
      env,
    );
    assert.equal(partial.status, 200);
    assert.equal((await bodyOf(partial)).client.onboardingComplete, false);
    assert.equal((await getClient(memory.kv, client.id))!.stage, 'onboarding');

    const full = await handlePortalOnboarding(
      apiRequest(
        '/api/portal/onboarding',
        {
          businessName: 'Pat Plumbing',
          contactName: 'Pat Proprio',
          phone: '514-555-0100',
          services: 'Plumbing, drains',
          serviceArea: 'Montreal',
          domainMode: 'new',
          domainValue: 'patplumbing.ca',
          styleDemos: ['brume', 'not a demo!', 'nora'],
          hasLogo: true,
        },
        { headers },
      ),
      env,
    );
    const view = (await bodyOf(full)).client;
    assert.equal(view.onboardingComplete, true);
    assert.equal(view.stage, 'build');
    assert.deepEqual(view.onboarding.styleDemos, ['brume', 'nora'], 'demo ids sanitized');
    const stored = await getClient(memory.kv, client.id);
    assert.ok(stored!.onboardingCompletedAt);
    assert.equal(stored!.business, 'Pat Plumbing');

    const noAuth = await handlePortalOnboarding(apiRequest('/api/portal/onboarding', {}), env);
    assert.equal(noAuth.status, 401);
  } finally {
    stub.restore();
  }
});

test('claim: a paid Stripe session signs in, an unpaid one does not', async () => {
  const memory = memoryKV();
  await seedClient(memory);
  const stub = stubFetch((url) => {
    if (url.includes('smtp2go')) return smtpOk(url);
    if (url.includes('cs_paid')) return { ok: true, body: { payment_status: 'paid', status: 'complete', customer: null, customer_details: { email: 'owner@example.ca' } } };
    if (url.includes('cs_open')) return { ok: true, body: { payment_status: 'unpaid', status: 'open', customer: null, customer_details: { email: 'owner@example.ca' } } };
    return { ok: false, body: {} };
  });
  try {
    const env = envOf(memory.kv, { STRIPE_SECRET_KEY: 'sk_test' });
    const paid = await handlePortalClaim(apiRequest('/api/portal/claim', { sessionId: 'cs_paid_123' }), env);
    assert.equal(paid.status, 200);
    cookieOf(paid);

    const open = await handlePortalClaim(apiRequest('/api/portal/claim', { sessionId: 'cs_open_123' }), env);
    assert.equal(open.status, 403);

    const junk = await handlePortalClaim(apiRequest('/api/portal/claim', { sessionId: 'nope' }), env);
    assert.equal(junk.status, 400);
  } finally {
    stub.restore();
  }
});

test('nudges: auth required, day-2 reminder sends once, day-7 escalates to the inbox', async () => {
  const memory = memoryKV();
  const young = await seedClient(memory, 'young@example.ca');
  const old = await seedClient(memory, 'old@example.ca');
  // Age the records: young is 3 days old, old is 8 days old.
  young.createdAt = Date.now() - 3 * DAY;
  await saveClient(memory.kv, young);
  old.createdAt = Date.now() - 8 * DAY;
  await saveClient(memory.kv, old);

  const env = envOf(memory.kv, { SMTP2GO_API_KEY: 'k', INTERNAL_CRON_SECRET: 's3cret' });
  const noAuth = await handleOnboardingNudges(apiRequest('/api/internal/onboarding-nudges', {}), env);
  assert.equal(noAuth.status, 401);

  const stub = stubFetch(smtpOk);
  try {
    const res = await handleOnboardingNudges(
      apiRequest('/api/internal/onboarding-nudges', {}, { headers: { authorization: 'Bearer s3cret' } }),
      env,
    );
    assert.equal(res.status, 200);
    const out = await bodyOf(res);
    assert.equal(out.nudged, 1);
    assert.equal(out.escalated, 1);
    assert.equal((await getClient(memory.kv, young.id))!.nudgeCount, 1);
    assert.ok((await getClient(memory.kv, old.id))!.nudgesEscalatedAt);

    // Second run the same day: nothing new is due.
    const again = await handleOnboardingNudges(
      apiRequest('/api/internal/onboarding-nudges', {}, { headers: { authorization: 'Bearer s3cret' } }),
      env,
    );
    const out2 = await bodyOf(again);
    assert.equal(out2.nudged, 0);
    assert.equal(out2.escalated, 0);
  } finally {
    stub.restore();
  }
});

test('admin clients: list shows the record, update moves the stage and sets a preview', async () => {
  const token = 'a'.repeat(64);
  const memory = memoryKV({
    [`admin:token:${token}`]: { createdAt: Date.now(), ip: '203.0.113.9' },
  });
  const client = await seedClient(memory);
  const env = envOf(memory.kv, {});
  const headers = { authorization: `Bearer ${token}` };

  const list = await handleAdmin(apiGet('/api/admin/clients', { headers }), env, new URL('https://webao.ca/api/admin/clients'));
  assert.equal(list.status, 200);
  const items = (await bodyOf(list)).items;
  assert.equal(items.length, 1);
  assert.equal(items[0].id, client.id);
  assert.equal(items[0].onboardingComplete, false);

  const updated = await handleAdmin(
    apiRequest('/api/admin/clients/update', { id: client.id, stage: 'review', previewUrl: 'https://preview.example.ca/x' }, { headers }),
    env,
    new URL('https://webao.ca/api/admin/clients/update'),
  );
  assert.equal(updated.status, 200);
  const stored = await getClient(memory.kv, client.id);
  assert.equal(stored!.stage, 'review');
  assert.equal(stored!.previewUrl, 'https://preview.example.ca/x');

  const badStage = await handleAdmin(
    apiRequest('/api/admin/clients/update', { id: client.id, stage: 'shipped' }, { headers }),
    env,
    new URL('https://webao.ca/api/admin/clients/update'),
  );
  assert.equal(badStage.status, 400);

  const anon = await handleAdmin(apiGet('/api/admin/clients'), env, new URL('https://webao.ca/api/admin/clients'));
  assert.equal(anon.status, 401);
});
