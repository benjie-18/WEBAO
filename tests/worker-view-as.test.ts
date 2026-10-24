// Admin test clients + "view as client": creation, admin-flagged portal
// sessions, and the guards keeping test records out of nudges and reports.
import assert from 'node:assert/strict';
import test from 'node:test';
import { handleAdmin } from '../worker/admin';
import { issueToken } from '../worker/auth';
import { createClient, getClient, saveClient } from '../worker/clients';
import { putJson } from '../worker/kv';
import { handleOnboardingNudges, handlePortalMe } from '../worker/portal';
import { handleMonthlyReports } from '../worker/reports';
import { apiGet, apiRequest, bodyOf, envOf, memoryKV, type MemoryKV } from './helpers';

const DAY = 24 * 3600 * 1000;
const CRON_SECRET = 'test-cron-' + 'secret-123';
const SMTP_KEY = 'test-smtp-' + 'key-123';

const url = (path: string) => new URL(`https://webao.ca${path}`);

/** SMTP2GO succeeds; everything else 404s. */
function stubFetchOk() {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const u = String(input);
    if (u.includes('smtp2go')) {
      return { ok: true, status: 200, json: async () => ({ data: { succeeded: 1, failed: 0 } }) } as Response;
    }
    return { ok: false, status: 404, json: async () => ({}) } as Response;
  }) as typeof fetch;
  return {
    restore() {
      globalThis.fetch = original;
    },
  };
}

async function admin(memory: MemoryKV) {
  const token = await issueToken(memory.kv, '203.0.113.9');
  const headers = { authorization: `Bearer ${token}` };
  return {
    get: (path: string) => handleAdmin(apiGet(path, { headers }), envOf(memory.kv), url(path)),
    post: (path: string, body: unknown) =>
      handleAdmin(apiRequest(path, body, { headers }), envOf(memory.kv), url(path)),
  };
}

test('create-test: auth required, validates email, creates a flagged test client', async () => {
  const memory = memoryKV();
  const a = await admin(memory);

  const anon = await handleAdmin(
    apiRequest('/api/admin/clients/create-test', { email: 'me@example.ca' }),
    envOf(memory.kv),
    url('/api/admin/clients/create-test'),
  );
  assert.equal(anon.status, 401);

  const bad = await a.post('/api/admin/clients/create-test', { email: 'not-an-email' });
  assert.equal(bad.status, 400);

  const res = await a.post('/api/admin/clients/create-test', { email: 'Me@Example.ca', lang: 'fr' });
  assert.equal(res.status, 200);
  const out = await bodyOf(res);
  assert.equal(out.client.test, true);
  assert.equal(out.client.lang, 'fr');
  assert.equal(out.client.hasAds, true);

  const stored = await getClient(memory.kv, out.client.id);
  assert.ok(stored);
  assert.equal(stored.test, true);
  assert.equal(stored.source, 'admin-test');
  assert.equal(stored.email, 'me@example.ca');
  assert.deepEqual(stored.items, ['launch-month', 'ads-pack-month']);
  assert.equal(stored.ads?.status, 'onboarding');

  const dup = await a.post('/api/admin/clients/create-test', { email: 'me@example.ca' });
  assert.equal(dup.status, 409);

  const list = await a.get('/api/admin/clients');
  const items = (await bodyOf(list)).items;
  assert.equal(items.length, 1);
  assert.equal(items[0].test, true);
});

test('view-as: mints an admin-flagged portal session; a normal session is not flagged', async () => {
  const memory = memoryKV();
  const a = await admin(memory);
  const created = await a.post('/api/admin/clients/create-test', { email: 'view@example.ca' });
  const id = (await bodyOf(created)).client.id;

  const anon = await handleAdmin(
    apiRequest('/api/admin/clients/view-as', { id }),
    envOf(memory.kv),
    url('/api/admin/clients/view-as'),
  );
  assert.equal(anon.status, 401);

  const missing = await a.post('/api/admin/clients/view-as', { id: 'cl_nope' });
  assert.equal(missing.status, 404);

  const res = await a.post('/api/admin/clients/view-as', { id });
  assert.equal(res.status, 200);
  const set = res.headers.get('set-cookie') || '';
  const m = /webao_portal=([a-f0-9]+)/.exec(set);
  assert.ok(m, 'portal cookie issued');
  const cookie = `webao_portal=${m[1]}`;

  const me = await handlePortalMe(apiGet('/api/portal/me', { headers: { cookie } }), envOf(memory.kv));
  assert.equal(me.status, 200);
  const meBody = await bodyOf(me);
  assert.equal(meBody.client.email, 'view@example.ca');
  assert.equal(meBody.client.viaAdmin, true);

  // A plain client-style session record carries no admin flag.
  const plainToken = 'f'.repeat(64);
  await putJson(memory.kv, 'portal-session:' + plainToken, { clientId: id, createdAt: Date.now() }, 3600);
  const me2 = await handlePortalMe(
    apiGet('/api/portal/me', { headers: { cookie: `webao_portal=${plainToken}` } }),
    envOf(memory.kv),
  );
  assert.equal(me2.status, 200);
  assert.equal((await bodyOf(me2)).client.viaAdmin, undefined);
});

test('test clients are skipped by onboarding nudges and monthly reports', async () => {
  const memory = memoryKV();
  const a = await admin(memory);
  const created = await a.post('/api/admin/clients/create-test', { email: 'quiet@example.ca' });
  const testClient = await getClient(memory.kv, (await bodyOf(created)).client.id);
  assert.ok(testClient);
  testClient.createdAt = Date.now() - 3 * DAY; // nudge-due age
  await saveClient(memory.kv, testClient);

  const realNudge = await createClient(memory.kv, {
    email: 'real-nudge@example.ca',
    items: ['launch-month'],
    source: 'stripe',
  });
  realNudge.createdAt = Date.now() - 3 * DAY;
  await saveClient(memory.kv, realNudge);

  const realLive = await createClient(memory.kv, {
    email: 'real-live@example.ca',
    items: ['launch-month'],
    source: 'stripe',
  });
  realLive.stage = 'live';
  await saveClient(memory.kv, realLive);

  const env = envOf(memory.kv, { INTERNAL_CRON_SECRET: CRON_SECRET, SMTP2GO_API_KEY: SMTP_KEY });
  const stub = stubFetchOk();
  try {
    const nudgeRes = await handleOnboardingNudges(
      apiRequest('/api/internal/onboarding-nudges', {}, { headers: { authorization: `Bearer ${CRON_SECRET}` } }),
      env,
    );
    assert.equal(nudgeRes.status, 200);
    assert.equal((await bodyOf(nudgeRes)).nudged, 1, 'only the real onboarding client is nudged');
    assert.equal((await getClient(memory.kv, testClient.id))!.nudgeCount, undefined);
    assert.equal((await getClient(memory.kv, realNudge.id))!.nudgeCount, 1);

    // Flip the test client live: the monthly report must still skip it.
    const tc = await getClient(memory.kv, testClient.id);
    tc!.stage = 'live';
    await saveClient(memory.kv, tc!);

    const now = new Date();
    const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const month = `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}`;
    const repRes = await handleMonthlyReports(
      apiRequest('/api/internal/monthly-reports', { month }, { headers: { authorization: `Bearer ${CRON_SECRET}` } }),
      env,
    );
    assert.equal(repRes.status, 200);
    assert.equal((await bodyOf(repRes)).sent, 1, 'only the real live client gets a report');
    const reportKeys = [...memory.store.keys()].filter((k) => k.startsWith('report:'));
    assert.ok(reportKeys.some((k) => k.includes(realLive.id)), 'real client report recorded');
    assert.equal(reportKeys.some((k) => k.includes(testClient.id)), false, 'no report for the test client');
  } finally {
    stub.restore();
  }
});
