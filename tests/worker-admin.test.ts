// Admin API: login, stats aggregation, form moderation, config and the
// password-change flow that logs other sessions out.
import assert from 'node:assert/strict';
import test from 'node:test';
import { handleAdmin } from '../worker/admin';
import { issueToken, setPasswordHash } from '../worker/auth';
import { addDays, dayKey, sha256Hex } from '../worker/util';
import { apiGet, apiRequest, bodyOf, envOf, memoryKV, type MemoryKV } from './helpers';

const url = (path: string) => new URL(`https://webao.ca${path}`);

async function authed(memory: MemoryKV): Promise<string> {
  return issueToken(memory.kv, '203.0.113.9');
}

const adminGet = (path: string, token?: string) =>
  apiGet(path, token ? { headers: { authorization: `Bearer ${token}` } } : {});
const adminPost = (path: string, body: unknown, token?: string) =>
  apiRequest(path, body, token ? { headers: { authorization: `Bearer ${token}` } } : {});
const adminDelete = (path: string, token: string) =>
  apiRequest(path, undefined, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });

const session = (device: string, country: string, startedAt = Date.now()) =>
  JSON.stringify({ ip: '1.2.3.4', country, ua: '', device, browser: 'other', startedAt, lastSeenAt: startedAt, pages: [], clicks: [] });

test('login issues a token for the right password and rejects the rest', async () => {
  const memory = memoryKV();
  await setPasswordHash(memory.kv, await sha256Hex('a-good-admin-password'));

  const bad = await handleAdmin(adminPost('/api/admin/login', { password: 'wrong-password!!' }), envOf(memory.kv), url('/api/admin/login'));
  assert.equal(bad.status, 401);
  assert.deepEqual(await bodyOf(bad), { ok: false, error: 'Invalid credentials' });

  const good = await handleAdmin(adminPost('/api/admin/login', { password: 'a-good-admin-password' }), envOf(memory.kv), url('/api/admin/login'));
  assert.equal(good.status, 200);
  const body = await bodyOf(good);
  assert.equal(body.ok, true);
  assert.match(body.token, /^[a-f0-9]{64}$/);
  assert.equal(memory.store.has(`admin:token:${body.token}`), true);
});

test('login is origin-gated and throttled per IP', async () => {
  const memory = memoryKV();
  const foreign = await handleAdmin(
    apiRequest('/api/admin/login', { password: 'x' }, { origin: null }),
    envOf(memory.kv),
    url('/api/admin/login'),
  );
  assert.equal(foreign.status, 403, 'a same-origin header is required');

  const throttled = memoryKV({ 'rl:login:203.0.113.9': { c: 10, r: Date.now() + 60_000 } });
  const response = await handleAdmin(
    adminPost('/api/admin/login', { password: 'x' }),
    envOf(throttled.kv),
    url('/api/admin/login'),
  );
  assert.equal(response.status, 429);
  assert.deepEqual(await bodyOf(response), { ok: false, error: 'Too many attempts' });
});

test('every admin route except login requires a Bearer token', async () => {
  const memory = memoryKV();
  for (const [method, path] of [
    ['GET', '/api/admin/stats'],
    ['GET', '/api/admin/forms'],
    ['GET', '/api/admin/config'],
    ['POST', '/api/admin/config'],
    ['POST', '/api/admin/password'],
    ['DELETE', '/api/admin/forms/1:a'],
  ] as const) {
    const request =
      method === 'GET' ? adminGet(path) : apiRequest(path, {}, { method });
    const response = await handleAdmin(request, envOf(memory.kv), url(path));
    assert.equal(response.status, 401, `${method} ${path}`);
  }
  // Token-authed GETs still reject a foreign Origin header.
  const token = await authed(memory);
  const evil = await handleAdmin(
    apiGet('/api/admin/stats', { origin: 'https://evil.example', headers: { authorization: `Bearer ${token}` } }),
    envOf(memory.kv),
    url('/api/admin/stats'),
  );
  assert.equal(evil.status, 403);
});

test('stats validate their inputs and aggregate the seeded KV', async () => {
  const memory = memoryKV();
  const token = await authed(memory);

  const invalid = await handleAdmin(adminGet('/api/admin/stats?range=hour', token), envOf(memory.kv), url('/api/admin/stats?range=hour'));
  assert.equal(invalid.status, 400);
  assert.deepEqual(await bodyOf(invalid), { ok: false, error: 'Invalid range' });
  const badPage = await handleAdmin(adminGet('/api/admin/stats?page=pricing', token), envOf(memory.kv), url('/api/admin/stats?page=pricing'));
  assert.equal(badPage.status, 400);
  assert.deepEqual(await bodyOf(badPage), { ok: false, error: 'Invalid page' });

  const today = dayKey();
  const yesterday = addDays(today, -1);
  memory.store.set(`views:${today}:${encodeURIComponent('/pricing')}`, '5');
  memory.store.set(`views:${today}:${encodeURIComponent('/contact')}`, '2');
  memory.store.set(`views:${today}:__all`, '999', );
  memory.store.set(`views:${yesterday}:${encodeURIComponent('/contact')}`, '1');
  memory.store.set(`views:${yesterday}:__all`, '1');
  memory.store.set('session:one', session('mobile', 'ca'));
  memory.store.set('session:two', session('desktop', 'US'));

  const response = await handleAdmin(adminGet('/api/admin/stats?range=week', token), envOf(memory.kv), url('/api/admin/stats?range=week'));
  assert.equal(response.status, 200);
  const stats = await bodyOf(response);
  assert.equal(stats.ok, true);
  assert.equal(stats.range, 'week');
  assert.equal(stats.labels.length, 7);
  assert.equal(stats.labels.at(-1), today);
  assert.equal(stats.views.at(-1), 7, 'today = all path counters, the __all key is not double counted');
  assert.equal(stats.views.at(-2), 1, 'yesterday');
  assert.equal(stats.visitors.at(-1), 2);
  assert.deepEqual(stats.topPages, [
    { path: '/pricing', views: 5 },
    { path: '/contact', views: 3 },
  ]);
  assert.deepEqual(stats.devices, { mobile: 1, tablet: 0, desktop: 1 });
  assert.deepEqual(stats.countries, [
    { code: 'CA', count: 1 },
    { code: 'US', count: 1 },
  ]);

  const filtered = await handleAdmin(adminGet('/api/admin/stats?range=week&page=/pricing', token), envOf(memory.kv), url('/api/admin/stats?range=week&page=/pricing'));
  const filteredStats = await bodyOf(filtered);
  assert.equal(filteredStats.page, '/pricing');
  assert.equal(filteredStats.views.at(-1), 5, 'only the chosen path counts');
});

test('the year range rolls the series up into months', async () => {
  const memory = memoryKV();
  const token = await authed(memory);
  const today = dayKey();
  memory.store.set(`views:${today}:${encodeURIComponent('/pricing')}`, '4');

  const response = await handleAdmin(adminGet('/api/admin/stats?range=year', token), envOf(memory.kv), url('/api/admin/stats?range=year'));
  const stats = await bodyOf(response);
  // 365 days end-to-end roll up into one bucket per calendar month; the count
  // depends on where the window sits (12 on a month boundary, 13 otherwise).
  let expectedMonths = 1;
  for (let d = addDays(today, -364); d < today; d = addDays(d, 1)) {
    if (d.slice(0, 7) !== addDays(d, 1).slice(0, 7)) expectedMonths++;
  }
  assert.equal(stats.labels.length, expectedMonths, '365 days roll up into one bucket per calendar month');
  assert.equal(stats.labels.at(-1), today.slice(0, 7));
  assert.equal(stats.views.length, expectedMonths, 'one view bucket per month');
  assert.equal(stats.views.at(-1), 4);
  assert.equal(stats.visitors.at(-1), 0);
});

test('a malformed view key does not take stats down', async () => {
  const memory = memoryKV();
  const token = await authed(memory);
  const today = dayKey();
  memory.store.set(`views:${today}:%E0%A4%A`, '2');
  memory.store.set(`views:${today}:${encodeURIComponent('/pricing')}`, '1');

  const response = await handleAdmin(adminGet('/api/admin/stats?range=day', token), envOf(memory.kv), url('/api/admin/stats?range=day'));
  assert.equal(response.status, 200);
  const stats = await bodyOf(response);
  assert.deepEqual(stats.views, [3]);
  assert.deepEqual(stats.topPages, [
    { path: '%E0%A4%A', views: 2 },
    { path: '/pricing', views: 1 },
  ]);
});

test('the visitors list returns each session with its pages and clicks, newest first', async () => {
  const memory = memoryKV();
  const token = await authed(memory);
  const now = Date.now();
  const older = JSON.stringify({
    ip: '203.0.113.1', country: 'CA', city: 'Montreal', ua: '', device: 'mobile', browser: 'safari',
    startedAt: now - 3600_000, lastSeenAt: now - 1800_000,
    pages: [{ path: '/', at: now - 3600_000, durationMs: 5000 }],
    clicks: [{ path: '/', kind: 'link', label: 'Pricing', at: now - 3500_000 }],
  });
  const newer = JSON.stringify({
    ip: '198.51.100.2', country: 'US', ua: '', device: 'desktop', browser: 'chrome',
    startedAt: now - 600_000, lastSeenAt: now - 60_000,
    pages: [
      { path: '/', at: now - 600_000, durationMs: 30000 },
      { path: '/pricing', at: now - 570_000, durationMs: 120000, referrer: 'https://google.com/' },
    ],
    clicks: [],
  });
  memory.store.set('session:aaa-older', older);
  memory.store.set('session:zzz-newer', newer);
  memory.store.set('session:broken', 'not-json');

  const denied = await handleAdmin(adminGet('/api/admin/visitors'), envOf(memory.kv), url('/api/admin/visitors'));
  assert.equal(denied.status, 401, 'Bearer <redacted> required');

  const response = await handleAdmin(adminGet('/api/admin/visitors', token), envOf(memory.kv), url('/api/admin/visitors'));
  assert.equal(response.status, 200);
  const body = await bodyOf(response);
  assert.equal(body.ok, true);
  assert.equal(body.items.length, 2, 'the broken session value is skipped');
  assert.equal(body.items[0].sid, 'zzz-newer', 'most recently active first');
  assert.equal(body.items[0].pages.length, 2);
  assert.equal(body.items[0].pages[1].path, '/pricing');
  assert.equal(body.items[0].pages[1].referrer, 'https://google.com/');
  assert.equal(body.items[1].sid, 'aaa-older');
  assert.equal(body.items[1].clicks.length, 1);
  assert.equal(body.items[1].clicks[0].label, 'Pricing');

  const one = await handleAdmin(adminGet('/api/admin/visitors?limit=1', token), envOf(memory.kv), url('/api/admin/visitors?limit=1'));
  assert.equal((await bodyOf(one)).items.length, 1, 'limit is honoured');
});

test('the forms list clamps its limit, paginates and filters by type', async () => {
  const memory = memoryKV();
  const token = await authed(memory);
  const keys = ['form:1:a', 'form:2:b', 'form:3:c', 'form:4:missing'];
  memory.store.set('forms:index', JSON.stringify(keys));
  memory.store.set('form:1:a', JSON.stringify({ form: 'pricing', fields: { name: 'A' }, at: 1 }));
  memory.store.set('form:2:b', JSON.stringify({ form: 'contact', fields: { name: 'B' }, at: 2 }));
  memory.store.set('form:3:c', JSON.stringify({ form: 'contact', fields: { name: 'C' }, at: 3 }));

  const first = await bodyOf(await handleAdmin(adminGet('/api/admin/forms?limit=2', token), envOf(memory.kv), url('/api/admin/forms?limit=2')));
  assert.deepEqual(first.items.map((item: { id: string }) => item.id), ['1:a', '2:b']);
  assert.equal(first.nextCursor, '2');

  const second = await bodyOf(await handleAdmin(adminGet('/api/admin/forms?limit=2&cursor=2', token), envOf(memory.kv), url('/api/admin/forms?limit=2&cursor=2')));
  assert.deepEqual(second.items.map((item: { id: string }) => item.id), ['3:c'], 'missing records are skipped');
  assert.equal(second.nextCursor, null);

  const contacts = await bodyOf(await handleAdmin(adminGet('/api/admin/forms?type=contact', token), envOf(memory.kv), url('/api/admin/forms?type=contact')));
  assert.deepEqual(contacts.items.map((item: { id: string }) => item.id), ['2:b', '3:c']);

  const clamped = await bodyOf(await handleAdmin(adminGet('/api/admin/forms?limit=500', token), envOf(memory.kv), url('/api/admin/forms?limit=500')));
  assert.equal(clamped.items.length, 3, 'limit is clamped but harmless here');
});

test('deleting a form decodes the id and updates the index', async () => {
  const memory = memoryKV();
  const token = await authed(memory);
  memory.store.set('forms:index', JSON.stringify(['form:1:a', 'form:2:b']));
  memory.store.set('form:1:a', JSON.stringify({ form: 'contact', fields: { name: 'A' } }));

  const response = await handleAdmin(
    adminDelete(`/api/admin/forms/${encodeURIComponent('1:a')}`, token),
    envOf(memory.kv),
    url(`/api/admin/forms/${encodeURIComponent('1:a')}`),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await bodyOf(response), { ok: true });
  assert.equal(memory.store.has('form:1:a'), false);
  assert.deepEqual(JSON.parse(memory.store.get('forms:index') ?? '[]'), ['form:2:b']);

  for (const bad of ['%3Cscript%3E', 'a'.repeat(65), 'has%20space']) {
    const rejected = await handleAdmin(adminDelete(`/api/admin/forms/${bad}`, token), envOf(memory.kv), url(`/api/admin/forms/${bad}`));
    assert.equal(rejected.status, 400, bad);
    assert.deepEqual(await bodyOf(rejected), { ok: false, error: 'Invalid id' });
  }
});

test('config only accepts the whitelisted values', async () => {
  const memory = memoryKV();
  const token = await authed(memory);

  const badTheme = await handleAdmin(adminPost('/api/admin/config', { defaultTheme: 'sepia' }, token), envOf(memory.kv), url('/api/admin/config'));
  assert.equal(badTheme.status, 400);
  assert.deepEqual(await bodyOf(badTheme), { ok: false, error: 'Invalid defaultTheme' });

  const badTracking = await handleAdmin(adminPost('/api/admin/config', { trackingEnabled: 'yes' }, token), envOf(memory.kv), url('/api/admin/config'));
  assert.equal(badTracking.status, 400);
  assert.deepEqual(await bodyOf(badTracking), { ok: false, error: 'Invalid trackingEnabled' });

  const saved = await handleAdmin(
    adminPost('/api/admin/config', { defaultTheme: 'dark', trackingEnabled: false }, token),
    envOf(memory.kv),
    url('/api/admin/config'),
  );
  assert.deepEqual(await bodyOf(saved), { ok: true, settings: { defaultTheme: 'dark', trackingEnabled: false } });

  const read = await bodyOf(await handleAdmin(adminGet('/api/admin/config', token), envOf(memory.kv), url('/api/admin/config')));
  assert.deepEqual(read.settings, { defaultTheme: 'dark', trackingEnabled: false });
});

test('changing the password verifies the old one, enforces length and logs others out', async () => {
  const memory = memoryKV();
  await setPasswordHash(memory.kv, await sha256Hex('original-password-1'));
  const mine = await issueToken(memory.kv, '203.0.113.9');
  const other = await issueToken(memory.kv, '198.51.100.4');

  const short = await handleAdmin(adminPost('/api/admin/password', { current: 'original-password-1', next: 'short' }, mine), envOf(memory.kv), url('/api/admin/password'));
  assert.equal(short.status, 400);
  assert.deepEqual(await bodyOf(short), { ok: false, error: 'New password must be at least 12 characters' });

  const wrong = await handleAdmin(
    adminPost('/api/admin/password', { current: 'not-the-password', next: 'a-brand-new-password' }, mine),
    envOf(memory.kv),
    url('/api/admin/password'),
  );
  assert.equal(wrong.status, 401);
  assert.deepEqual(await bodyOf(wrong), { ok: false, error: 'Current password incorrect' });

  const changed = await handleAdmin(
    adminPost('/api/admin/password', { current: 'original-password-1', next: 'a-brand-new-password' }, mine),
    envOf(memory.kv),
    url('/api/admin/password'),
  );
  assert.equal(changed.status, 200);
  assert.deepEqual(await bodyOf(changed), { ok: true });
  assert.equal(memory.store.has(`admin:token:${mine}`), true, 'the caller keeps its session');
  assert.equal(memory.store.has(`admin:token:${other}`), false, 'other sessions are revoked');

  const login = await handleAdmin(
    adminPost('/api/admin/login', { password: 'a-brand-new-password' }),
    envOf(memory.kv),
    url('/api/admin/login'),
  );
  assert.equal(login.status, 200, 'the new password works');
});

test('unknown admin routes are a clean 404 for authenticated callers', async () => {
  const memory = memoryKV();
  const token = await authed(memory);
  const response = await handleAdmin(adminGet('/api/admin/nope', token), envOf(memory.kv), url('/api/admin/nope'));
  assert.equal(response.status, 404);
  assert.deepEqual(await bodyOf(response), { ok: false, error: 'Not found' });
});
