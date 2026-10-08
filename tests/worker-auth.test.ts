// Admin auth: password hashing, login throttling, token issue/verify and the
// KV-outage fallbacks that keep the admin reachable when writes are down.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AUTH_KEY,
  DEFAULT_PASSWORD_HASH,
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
  currentToken,
  getPasswordHash,
  getSettings,
  issueToken,
  requireAdmin,
  revokeOtherTokens,
  setPasswordHash,
  throttle,
  verifyPassword,
} from '../worker/auth';
import { sha256Hex, dayKey } from '../worker/util';
import { apiGet, memoryKV } from './helpers';

const bearer = (token: string) =>
  new Request('https://webao.ca/api/admin/stats', { headers: { authorization: `Bearer ${token}` } });

test('a fresh namespace is seeded with the documented default password hash', async () => {
  const { kv, store } = memoryKV();
  assert.equal(await getPasswordHash(kv), DEFAULT_PASSWORD_HASH);
  assert.deepEqual(JSON.parse(store.get(AUTH_KEY) ?? '{}'), { passwordHash: DEFAULT_PASSWORD_HASH });
  // A second call reads the stored value instead of rewriting it.
  await setPasswordHash(kv, 'a'.repeat(64));
  assert.equal(await getPasswordHash(kv), 'a'.repeat(64));
});

test('verifyPassword compares SHA-256 hashes and rejects junk without touching KV', async () => {
  const { kv } = memoryKV();
  await setPasswordHash(kv, await sha256Hex('correct horse battery staple'));
  assert.equal(await verifyPassword(kv, 'correct horse battery staple'), true);
  assert.equal(await verifyPassword(kv, 'Correct Horse Battery Staple'), false);
  assert.equal(await verifyPassword(kv, ''), false);
  assert.equal(await verifyPassword(kv, null), false);
  assert.equal(await verifyPassword(kv, 42), false);
  assert.equal(await verifyPassword(kv, 'x'.repeat(257)), false, 'oversized guesses are rejected early');
});

test('throttle is a fixed window per scope + IP', async () => {
  const { kv, store } = memoryKV();
  for (let i = 0; i < 3; i++) assert.equal(await throttle(kv, 'login', '1.2.3.4', 3), true, `attempt ${i + 1}`);
  assert.equal(await throttle(kv, 'login', '1.2.3.4', 3), false, 'the 4th attempt is blocked');
  assert.equal(await throttle(kv, 'login', '5.6.7.8', 3), true, 'a different IP has its own window');
  assert.equal(await throttle(kv, 'track', '1.2.3.4', 3), true, 'a different scope has its own window');
  assert.deepEqual(JSON.parse(store.get('rl:login:1.2.3.4') ?? '{}').c, 3);

  // Once the window has elapsed the counter restarts.
  store.set('rl:login:1.2.3.4', JSON.stringify({ c: 3, r: Date.now() - 1 }));
  assert.equal(await throttle(kv, 'login', '1.2.3.4', 3), true);
  assert.deepEqual(JSON.parse(store.get('rl:login:1.2.3.4') ?? '{}').c, 1);
});

test('throttle fails open when KV writes are unavailable', async () => {
  const { kv, failWrites } = memoryKV();
  failWrites(true);
  assert.equal(await throttle(kv, 'login', '1.2.3.4', 1), true, 'an outage degrades protection, never locks everyone out');
  failWrites(false);
  assert.equal(await throttle(kv, 'login', '1.2.3.4', 1), true);
});

test('issueToken stores a 64-hex token with a 7-day TTL that requireAdmin accepts', async () => {
  const { kv, store, ttls } = memoryKV();
  const token = await issueToken(kv, '1.2.3.4');
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.deepEqual(JSON.parse(store.get(`admin:token:${token}`) ?? '{}').ip, '1.2.3.4');
  assert.equal(ttls.get(`admin:token:${token}`), 7 * 24 * 3600);

  assert.equal(await requireAdmin(bearer(token), kv), null, 'valid token authorizes');
  assert.equal(currentToken(bearer(token)), token, 'and can be re-read for "keep my session" logic');
});

test('requireAdmin rejects missing, malformed and unknown tokens', async () => {
  const { kv } = memoryKV();
  const cases: Request[] = [
    new Request('https://webao.ca/api/admin/stats'),
    new Request('https://webao.ca/api/admin/stats', { headers: { authorization: 'Token abc' } }),
    new Request('https://webao.ca/api/admin/stats', { headers: { authorization: 'Bearer' } }),
    new Request('https://webao.ca/api/admin/stats', { headers: { authorization: 'Bearer short' } }),
    new Request('https://webao.ca/api/admin/stats', { headers: { authorization: `Bearer ${'a'.repeat(64)}` } }),
    new Request('https://webao.ca/api/admin/stats', { headers: { authorization: `Bearer ${'z'.repeat(64)}` } }),
    bearer('fb1.1999-01-01.' + 'a'.repeat(64)),
  ];
  for (const request of cases) {
    const denied = await requireAdmin(request, kv);
    assert.ok(denied, `expected a rejection for ${request.headers.get('authorization')}`);
    assert.equal(denied.status, 401);
    assert.deepEqual(await denied.json(), { ok: false, error: 'Unauthorized' });
  }
  assert.equal(currentToken(new Request('https://webao.ca/')), null);
});

test('fallback tokens keep login working while KV writes are down', async () => {
  const { kv, failWrites } = memoryKV();
  failWrites(true);
  const token = await issueToken(kv, '1.2.3.4');
  assert.match(token, new RegExp(`^fb1\\.${dayKey()}\\.[a-f0-9]{64}$`), 'day-bound HMAC instead of a KV record');
  assert.equal(await requireAdmin(bearer(token), kv), null);

  // Writing the token through does not work while writes fail …
  failWrites(false);
  assert.equal(await requireAdmin(bearer(token), kv), null, '… but the HMAC still verifies');

  // … and changing the password invalidates outstanding fallback tokens.
  await setPasswordHash(kv, await sha256Hex('a brand new password'));
  const stale = await requireAdmin(bearer(token), kv);
  assert.equal(stale?.status, 401);
});

test('revokeOtherTokens deletes every session except the caller’s', async () => {
  const { kv, store } = memoryKV();
  const mine = await issueToken(kv, '1.2.3.4');
  const other = await issueToken(kv, '5.6.7.8');
  const third = await issueToken(kv, '9.9.9.9');
  await revokeOtherTokens(kv, mine);
  assert.equal(store.has(`admin:token:${mine}`), true);
  assert.equal(store.has(`admin:token:${other}`), false);
  assert.equal(store.has(`admin:token:${third}`), false);
  // With no token to keep, everything goes.
  await revokeOtherTokens(kv, null);
  assert.equal(store.has(`admin:token:${mine}`), false);
});

test('getSettings merges stored values over the defaults', async () => {
  const { kv } = memoryKV();
  assert.deepEqual(await getSettings(kv), DEFAULT_SETTINGS);
  assert.deepEqual(DEFAULT_SETTINGS, { defaultTheme: 'system', trackingEnabled: true });
  const seeded = memoryKV({ [SETTINGS_KEY]: { trackingEnabled: false } });
  assert.deepEqual(await getSettings(seeded.kv), { defaultTheme: 'system', trackingEnabled: false }, 'partial records keep defaults');
});

test('an admin GET without a token never reaches the route handler', async () => {
  const { kv } = memoryKV();
  const request = apiGet('/api/admin/config', { origin: null });
  const denied = await requireAdmin(request, kv);
  assert.equal(denied?.status, 401);
});
