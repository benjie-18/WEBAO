// Worker shared helpers: origin gate, Cloudflare header parsing, hashing,
// path sanitisation, JSON request parsing and KV batching.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ALLOWED_HOSTS,
  addDays,
  batch,
  clampStr,
  clientCity,
  clientCountry,
  clientIp,
  dayKey,
  err,
  json,
  originAllowed,
  parseUserAgent,
  randomHex,
  readJson,
  sanitizePath,
  sha256Hex,
  timingSafeEqual,
  uuid,
} from '../worker/util';
import { apiRequest } from './helpers';

const req = (init: RequestInit = {}) => new Request('https://webao.ca/api/x', init);

test('the origin gate accepts every production host and rejects the rest', () => {
  for (const host of ALLOWED_HOSTS) {
    assert.equal(originAllowed(req({ headers: { origin: `https://${host}` } }), true), true, host);
  }
  assert.equal(originAllowed(req({ headers: { origin: 'HTTPS://WEBAO.CA' } }), true), true, 'host case is ignored');
  assert.equal(originAllowed(req({ headers: { referer: 'https://webao.ca/pricing' } }), true), true, 'referer works alone');
  assert.equal(originAllowed(req({ headers: { origin: 'https://evil.example' } }), true), false);
  assert.equal(originAllowed(req({ headers: { origin: 'webao.ca' } }), true), false, 'a bare host is not an origin');
  assert.equal(originAllowed(req({ headers: { origin: 'https://webao.ca.evil.example' } }), true), false);
  // Bearer-authed GETs tolerate missing headers; writes do not.
  assert.equal(originAllowed(req(), false), true);
  assert.equal(originAllowed(req(), true), false);
  assert.equal(originAllowed(req({ headers: { origin: 'https://evil.example' } }), false), false);
});

test('ALLOWED_ORIGINS extends the gate for local and preview hosts', () => {
  const preview = req({ headers: { origin: 'https://3000-abc.e2b.app' } });
  assert.equal(originAllowed(preview, true), false, 'off unless the binding is set');
  assert.equal(originAllowed(preview, true, { ALLOWED_ORIGINS: '*.e2b.app' }), true);
  assert.equal(
    originAllowed(preview, true, { ALLOWED_ORIGINS: ' example.com , *.e2b.app ,' }),
    true,
    'commas and spaces are tolerated',
  );
  assert.equal(originAllowed(preview, true, { ALLOWED_ORIGINS: 'example.com' }), false);
  const bare = req({ headers: { origin: 'https://e2b.app' } });
  assert.equal(originAllowed(bare, true, { ALLOWED_ORIGINS: '*.e2b.app' }), false, 'the wildcard needs a subdomain');
  const local = req({ headers: { origin: 'http://localhost:4321' } });
  assert.equal(originAllowed(local, true, { ALLOWED_ORIGINS: 'localhost' }), true, 'port does not matter');
});

test('client IP, country and city come from Cloudflare, never X-Forwarded-For', () => {
  const request = new Request('https://webao.ca/', {
    headers: { 'CF-Connecting-IP': ' 203.0.113.7 ', 'cf-ipcountry': 'ca', 'x-forwarded-for': '10.0.0.1' },
  });
  assert.equal(clientIp(request), '203.0.113.7', 'trimmed');
  assert.equal(clientCountry(request), 'CA', 'uppercased');
  assert.equal(clientIp(new Request('https://webao.ca/')), 'unknown');
  assert.equal(clientCountry(new Request('https://webao.ca/')), 'XX');

  const withCf = new Request('https://webao.ca/') as Request & { cf?: { country?: string; city?: string } };
  withCf.cf = { country: 'fr', city: 'Montréal' };
  assert.equal(clientCountry(withCf), 'FR');
  assert.equal(clientCity(withCf), 'Montréal');
  assert.equal(clientCity(new Request('https://webao.ca/')), undefined);
});

test('hashing and id helpers are correct and unpredictable', async () => {
  assert.equal(await sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(await sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(timingSafeEqual('abcd', 'abcd'), true);
  assert.equal(timingSafeEqual('abcd', 'abce'), false);
  assert.equal(timingSafeEqual('abcd', 'abc'), false, 'length mismatch is rejected outright');
  assert.equal(timingSafeEqual('', ''), true);
  const hex = randomHex(32);
  assert.match(hex, /^[a-f0-9]{64}$/);
  assert.notEqual(hex, randomHex(32));
  assert.match(uuid(), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test('dayKey and addDays are UTC-stable across month and year boundaries', () => {
  assert.equal(dayKey(Date.UTC(2026, 9, 7, 23, 59)), '2026-10-07');
  assert.equal(dayKey(Date.UTC(2026, 0, 1, 0, 0)), '2026-01-01');
  assert.equal(addDays('2026-10-07', 1), '2026-10-08');
  assert.equal(addDays('2024-02-28', 1), '2024-02-29', 'leap year');
  assert.equal(addDays('2023-02-28', 1), '2023-03-01');
  assert.equal(addDays('2024-12-31', 1), '2025-01-01');
  assert.equal(addDays('2025-03-01', -1), '2025-02-28');
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
  assert.equal(addDays('2026-10-07', 0), '2026-10-07');
});

test('user-agent parsing picks the device and browser families the dashboard reports', () => {
  const cases: Array<[string, string, string]> = [
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1', 'mobile', 'safari'],
    ['Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) AppleWebKit/605.1.15 Version/16.0 Safari/604.1', 'tablet', 'safari'],
    ['Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 Chrome/120 Safari/537.36', 'mobile', 'chrome'],
    ['Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36', 'mobile', 'chrome'],
    ['Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/120 Safari/537.36 Edg/120', 'desktop', 'edge'],
    ['Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/120 Safari/537.36 OPR/105', 'desktop', 'opera'],
    ['Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/120 Safari/537.36 Opera/9.80', 'desktop', 'opera'],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0', 'desktop', 'firefox'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15', 'desktop', 'safari'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 CriOS/120 Mobile/15E148 Safari/604.1', 'mobile', 'chrome'],
    ['curl/8.0', 'desktop', 'other'],
    ['', 'desktop', 'other'],
  ];
  for (const [ua, device, browser] of cases) {
    const info = parseUserAgent(ua);
    assert.equal(info.device, device, ua);
    assert.equal(info.browser, browser, ua);
  }
});

test('sanitizePath produces safe KV key segments and rejects junk', () => {
  assert.equal(sanitizePath('/Pricing?utm=x#frag'), '/pricing');
  assert.equal(sanitizePath('/a b/../c'), '/a_b/../c', 'characters outside [a-z0-9/_.-] become underscores');
  assert.equal(sanitizePath('/fr/démos'), '/fr/d_mos');
  assert.equal(sanitizePath('/%E0%A4%A'), '/_e0_a4_a', 'percent escapes never survive into a key');
  assert.equal(sanitizePath('/'), '/');
  assert.equal(sanitizePath('/a//b'), '/a//b');
  assert.equal(sanitizePath('/' + 'x'.repeat(300)).length, 160, 'paths are capped');
  assert.equal(sanitizePath('pricing'), null, 'must be root-relative');
  assert.equal(sanitizePath(''), null);
  assert.equal(sanitizePath(42), null);
  assert.equal(sanitizePath(null), null);
});

test('clampStr keeps only strings and bounds them', () => {
  assert.equal(clampStr(' abcdef ', 3), ' ab', 'a slice, not a trim');
  assert.equal(clampStr('abc', 10), 'abc');
  assert.equal(clampStr(7, 3), '');
  assert.equal(clampStr(undefined, 3), '');
  assert.equal(clampStr(null, 3), '');
});

test('readJson enforces the JSON content type, size limit and syntax', async () => {
  const ok = await readJson(
    new Request('https://webao.ca/api', {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ a: 1 }),
    }),
  );
  assert.deepEqual(ok, { a: 1 });

  await assert.rejects(
    readJson(new Request('https://webao.ca/api', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })),
    /Expected application\/json/,
  );
  await assert.rejects(
    readJson(new Request('https://webao.ca/api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' })),
    /Invalid JSON/,
  );
  await assert.rejects(
    readJson(
      new Request('https://webao.ca/api', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pad: 'x'.repeat(200) }),
      }),
      16,
    ),
    /Body too large/,
  );
});

test('batch preserves order and never runs more than `size` tasks at once', async () => {
  let inFlight = 0;
  let peak = 0;
  const out = await batch([1, 2, 3, 4, 5, 6, 7], 3, async (n, index) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 1));
    inFlight--;
    return `${index}:${n * 2}`;
  });
  assert.deepEqual(out, ['0:2', '1:4', '2:6', '3:8', '4:10', '5:12', '6:14']);
  assert.equal(peak, 3);
  assert.deepEqual(await batch([], 3, async () => 1), []);
});

test('json() and err() set the house style for API responses', async () => {
  const ok = json({ ok: true });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await ok.json(), { ok: true });

  const created = json({ ok: true }, 201, { 'x-extra': '1' });
  assert.equal(created.status, 201);
  assert.equal(created.headers.get('x-extra'), '1');

  const bad = err('Nope');
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { ok: false, error: 'Nope' });
  assert.equal(err('Unauthorized', 401).status, 401);
});

test('the request helper used by the worker tests posts a same-origin JSON body', async () => {
  const request = apiRequest('/api/forms/submit', { form: 'contact' });
  assert.equal(request.headers.get('origin'), 'https://webao.ca');
  assert.equal(request.headers.get('CF-Connecting-IP'), '203.0.113.9');
  assert.deepEqual(await request.json(), { form: 'contact' });
});
