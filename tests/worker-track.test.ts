// Visitor tracking endpoints: session lifecycle, input validation, the
// same-origin + rate-limit gate, coalesced heartbeats and tracking opt-out.
import assert from 'node:assert/strict';
import test from 'node:test';
import { handleClick, handleHeartbeat, handlePageview } from '../worker/track';
import { dayKey } from '../worker/util';
import { apiRequest, bodyOf, envOf, memoryKV } from './helpers';

const SID = 'sess-0001';
const DAY = dayKey();
const viewKey = (path: string) => `views:${DAY}:${encodeURIComponent(path)}`;

const pageview = (body: unknown, options: Parameters<typeof apiRequest>[2] = {}) =>
  apiRequest('/api/track/pageview', body, options);
const click = (body: unknown, options: Parameters<typeof apiRequest>[2] = {}) =>
  apiRequest('/api/track/click', body, options);
const heartbeat = (body: unknown, options: Parameters<typeof apiRequest>[2] = {}) =>
  apiRequest('/api/track/heartbeat', body, options);

type Session = {
  ip: string;
  country: string;
  ua: string;
  device: string;
  browser: string;
  startedAt: number;
  lastSeenAt: number;
  locale?: string;
  theme?: string;
  pages: Array<{ path: string; at: number; durationMs: number; referrer?: string }>;
  clicks: Array<{ path: string; kind: string; label: string; at: number }>;
};

const sessionOf = (store: Map<string, string>, sid = SID): Session =>
  JSON.parse(store.get(`session:${sid}`) ?? 'null');

test('a pageview creates the session, appends the visit and counts the view', async () => {
  const memory = memoryKV();
  const response = await handlePageview(
    pageview(
      { sid: SID, path: '/pricing', referrer: 'https://google.com/search', locale: 'en-CA', theme: 'dark' },
      { ip: '203.0.113.7', headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/120 Safari/537.36', 'cf-ipcountry': 'ca' } },
    ),
    envOf(memory.kv),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await bodyOf(response), { ok: true });

  const session = sessionOf(memory.store);
  assert.equal(session.ip, '203.0.113.7');
  assert.equal(session.country, 'CA');
  assert.equal(session.device, 'desktop');
  assert.equal(session.browser, 'chrome');
  assert.equal(session.locale, 'en-CA');
  assert.equal(session.theme, 'dark');
  assert.equal(session.pages.length, 1);
  assert.deepEqual(
    { path: session.pages[0].path, durationMs: session.pages[0].durationMs, referrer: session.pages[0].referrer },
    { path: '/pricing', durationMs: 0, referrer: 'https://google.com/search' },
  );
  assert.ok(session.startedAt <= session.lastSeenAt);

  assert.equal(memory.store.get(viewKey('/pricing')), '1');
  assert.equal(memory.store.get(`views:${DAY}:__all`), '1');
  assert.equal(memory.ttls.get(`session:${SID}`), 90 * 24 * 3600);
  // The gate used the KV binding it was handed (regression: it once referenced
  // a free `env` variable, which crashed every tracking call at runtime).
  assert.equal(JSON.parse(memory.store.get('rl:track:203.0.113.7') ?? '{}').c, 1);
});

test('repeat pageviews append and update without resetting the session', async () => {
  const memory = memoryKV();
  await handlePageview(pageview({ sid: SID, path: '/', theme: 'light' }), envOf(memory.kv));
  const first = sessionOf(memory.store);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await handlePageview(
    pageview({ sid: SID, path: '/pricing', locale: 'french-too-long', theme: 'system' }),
    envOf(memory.kv),
  );
  const second = sessionOf(memory.store);
  assert.equal(second.startedAt, first.startedAt, 'startedAt is preserved');
  assert.deepEqual(second.pages.map((p) => p.path), ['/', '/pricing']);
  assert.equal(second.locale, 'french-t', 'clamped to 8 chars');
  assert.equal(second.theme, 'system');
  assert.equal(memory.store.get(viewKey('/')), '1');
  assert.equal(memory.store.get(viewKey('/pricing')), '1');
  assert.equal(memory.store.get(`views:${DAY}:__all`), '2');
});

test('pageview validation rejects bad sessions and paths before writing', async () => {
  const badSids = [undefined, '', 'short', 'has space', 'x'.repeat(65), 42, null];
  for (const sid of badSids) {
    const memory = memoryKV();
    const response = await handlePageview(pageview({ sid, path: '/pricing' }), envOf(memory.kv));
    assert.equal(response.status, 400, String(sid));
    assert.deepEqual(await bodyOf(response), { ok: false, error: 'Invalid sid' });
    assert.deepEqual([...memory.store.keys()].filter((k) => !k.startsWith('rl:')), [], 'no session or view keys');
  }
  const badPaths = [undefined, '', 'pricing', 42, null];
  for (const path of badPaths) {
    const memory = memoryKV();
    const response = await handlePageview(pageview({ sid: SID, path }), envOf(memory.kv));
    assert.equal(response.status, 400, String(path));
    assert.deepEqual(await bodyOf(response), { ok: false, error: 'Invalid path' });
    assert.deepEqual([...memory.store.keys()].filter((k) => !k.startsWith('rl:')), [], 'no session or view keys');
  }
});

test('pageviews are capped at the last 100 visits per session', async () => {
  const memory = memoryKV();
  const pages = Array.from({ length: 100 }, (_, i) => ({
    path: `/page-${i}`,
    at: Date.now() - 1000 + i,
    durationMs: 0,
  }));
  memory.store.set(
    `session:${SID}`,
    JSON.stringify({
      ip: '203.0.113.9',
      country: 'CA',
      ua: '',
      device: 'desktop',
      browser: 'other',
      startedAt: Date.now() - 10_000,
      lastSeenAt: Date.now() - 1000,
      pages,
      clicks: [],
    }),
  );
  await handlePageview(pageview({ sid: SID, path: '/newest' }), envOf(memory.kv));
  const session = sessionOf(memory.store);
  assert.equal(session.pages.length, 100);
  assert.equal(session.pages[0].path, '/page-1', 'the oldest visit is dropped');
  assert.equal(session.pages[99].path, '/newest');
});

test('tracking can be switched off from the admin config', async () => {
  const memory = memoryKV({ 'config:settings': { defaultTheme: 'system', trackingEnabled: false } });
  for (const [handler, request] of [
    [handlePageview, pageview({ sid: SID, path: '/pricing' })],
    [handleClick, click({ sid: SID, path: '/pricing' })],
    [handleHeartbeat, heartbeat({ sid: SID, path: '/pricing', durationMs: 1000 })],
  ] as const) {
    const response = await handler(request, envOf(memory.kv));
    assert.equal(response.status, 200);
    assert.deepEqual(await bodyOf(response), { ok: true, tracking: false });
  }
  assert.equal(memory.store.has(`session:${SID}`), false);
  assert.equal(memory.store.has(viewKey('/pricing')), false);
});

test('the shared gate requires a same-origin request and throttles per IP', async () => {
  for (const path of ['/api/track/pageview', '/api/track/click', '/api/track/heartbeat']) {
    const memory = memoryKV();
    const body = { sid: SID, path: '/pricing' };
    const request = apiRequest(path, body, { origin: null });
    const response = await handlePageview(request, envOf(memory.kv));
    assert.equal(response.status, 403, path);
    assert.deepEqual(await bodyOf(response), { ok: false, error: 'Forbidden origin' });

    const evil = await handlePageview(apiRequest(path, body, { origin: 'https://evil.example' }), envOf(memory.kv));
    assert.equal(evil.status, 403, path);
  }

  const memory = memoryKV({ 'rl:track:203.0.113.9': { c: 120, r: Date.now() + 60_000 } });
  const limited = await handlePageview(pageview({ sid: SID, path: '/pricing' }), envOf(memory.kv));
  assert.equal(limited.status, 429);
  assert.deepEqual(await bodyOf(limited), { ok: false, error: 'Rate limited' });
  assert.equal(memory.store.has(`session:${SID}`), false);

  // A different IP is unaffected.
  const other = memoryKV({ 'rl:track:203.0.113.9': { c: 120, r: Date.now() + 60_000 } });
  const allowed = await handlePageview(pageview({ sid: SID, path: '/pricing' }, { ip: '198.51.100.4' }), envOf(other.kv));
  assert.equal(allowed.status, 200);
});

test('clicks attach to an existing session only, with clamped labels', async () => {
  const memory = memoryKV();
  const unknown = await handleClick(click({ sid: SID, path: '/pricing' }), envOf(memory.kv));
  assert.equal(unknown.status, 404);
  assert.deepEqual(await bodyOf(unknown), { ok: false, error: 'Unknown session' });

  await handlePageview(pageview({ sid: SID, path: '/pricing' }), envOf(memory.kv));
  const first = await handleClick(click({ sid: SID, path: '/pricing', kind: 'cta', label: 'x'.repeat(300) }), envOf(memory.kv));
  assert.equal(first.status, 200);
  const clickEvent = sessionOf(memory.store).clicks[0];
  assert.equal(clickEvent.kind, 'cta');
  assert.equal(clickEvent.label.length, 120);
  assert.equal(clickEvent.path, '/pricing');

  const defaulted = await handleClick(click({ sid: SID, path: '/pricing' }), envOf(memory.kv));
  assert.equal(defaulted.status, 200);
  assert.equal(sessionOf(memory.store).clicks[1].kind, 'click', 'kind defaults to "click"');

  // Invalid input still 400s before the 404 session lookup.
  const bad = await handleClick(click({ sid: 'nope', path: '/pricing' }), envOf(memory.kv));
  assert.equal(bad.status, 400);
});

test('clicks are capped at the last 200 per session', async () => {
  const memory = memoryKV();
  await handlePageview(pageview({ sid: SID, path: '/pricing' }), envOf(memory.kv));
  const session = sessionOf(memory.store);
  session.clicks = Array.from({ length: 200 }, (_, i) => ({
    path: '/pricing',
    kind: 'click',
    label: `old-${i}`,
    at: Date.now() - 200 + i,
  }));
  memory.store.set(`session:${SID}`, JSON.stringify(session));

  await handleClick(click({ sid: SID, path: '/pricing', label: 'newest' }), envOf(memory.kv));
  const clicks = sessionOf(memory.store).clicks;
  assert.equal(clicks.length, 200);
  assert.equal(clicks[0].label, 'old-1', 'the oldest click is dropped');
  assert.equal(clicks[199].label, 'newest');
});

test('heartbeats coalesce, persist on final, and never shrink a duration', async () => {
  const memory = memoryKV();
  const unknown = await handleHeartbeat(heartbeat({ sid: SID, path: '/pricing', durationMs: 1000 }), envOf(memory.kv));
  assert.equal(unknown.status, 404);

  await handlePageview(pageview({ sid: SID, path: '/pricing' }), envOf(memory.kv));
  const sessionWrites = () => memory.puts.filter((key) => key.startsWith('session:')).length;
  const putsAfterPageview = sessionWrites();

  // A periodic heartbeat within 120 s of the last write is acknowledged but
  // not persisted (the KV write budget is the reason).
  const coalesced = await handleHeartbeat(heartbeat({ sid: SID, path: '/pricing', durationMs: 30_000 }), envOf(memory.kv));
  assert.equal(coalesced.status, 200);
  assert.deepEqual(await bodyOf(coalesced), { ok: true });
  assert.equal(sessionWrites(), putsAfterPageview, 'no session write');
  assert.equal(sessionOf(memory.store).pages[0].durationMs, 0);

  // A final heartbeat always persists.
  const final = await handleHeartbeat(
    heartbeat({ sid: SID, path: '/pricing', durationMs: 45_000, final: true }),
    envOf(memory.kv),
  );
  assert.equal(final.status, 200);
  assert.equal(sessionOf(memory.store).pages[0].durationMs, 45_000);

  // Monotonic: a smaller later value does not shrink the recorded duration.
  await handleHeartbeat(heartbeat({ sid: SID, path: '/pricing', durationMs: 2_000, final: true }), envOf(memory.kv));
  assert.equal(sessionOf(memory.store).pages[0].durationMs, 45_000);

  // Non-final persists once the coalescing window has passed.
  const session = sessionOf(memory.store);
  session.lastSeenAt = Date.now() - 121_000;
  memory.store.set(`session:${SID}`, JSON.stringify(session));
  await handleHeartbeat(heartbeat({ sid: SID, path: '/pricing', durationMs: 90_000 }), envOf(memory.kv));
  assert.equal(sessionOf(memory.store).pages[0].durationMs, 90_000);
});

test('heartbeat durations are sanitized and capped at 24 hours', async () => {
  const cases: Array<[unknown, number]> = [
    [-5, 0],
    ['1000', 0],
    [undefined, 0],
    [1e12, 24 * 3600 * 1000],
    [1234.9, 1234],
  ];
  for (const [durationMs, expected] of cases) {
    // Fresh session per case: durations are monotonic by design.
    const memory = memoryKV();
    await handlePageview(pageview({ sid: SID, path: '/pricing' }), envOf(memory.kv));
    await handleHeartbeat(heartbeat({ sid: SID, path: '/pricing', durationMs, final: true }), envOf(memory.kv));
    assert.equal(sessionOf(memory.store).pages[0].durationMs, expected, String(durationMs));
  }
});

test('heartbeats only touch the most recent visit of the given path', async () => {
  const memory = memoryKV();
  await handlePageview(pageview({ sid: SID, path: '/pricing' }), envOf(memory.kv));
  await handlePageview(pageview({ sid: SID, path: '/contact' }), envOf(memory.kv));
  await handlePageview(pageview({ sid: SID, path: '/pricing' }), envOf(memory.kv));

  await handleHeartbeat(heartbeat({ sid: SID, path: '/pricing', durationMs: 7_000, final: true }), envOf(memory.kv));
  const pages = sessionOf(memory.store).pages;
  assert.deepEqual(pages.map((p) => p.durationMs), [0, 0, 7_000]);

  await handleHeartbeat(heartbeat({ sid: SID, path: '/unknown', durationMs: 9_000, final: true }), envOf(memory.kv));
  assert.deepEqual(sessionOf(memory.store).pages.map((p) => p.durationMs), [0, 0, 7_000], 'unknown paths change nothing');
});
