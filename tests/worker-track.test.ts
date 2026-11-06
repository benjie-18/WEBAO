// Visitor tracking endpoints: session lifecycle, input validation, the
// same-origin + rate-limit gate (pageview/click), origin-only heartbeats,
// coalesced heartbeats and tracking opt-out.
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

test('a pageview creates the session and appends the visit (no counter write)', async () => {
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

  // No per-path counter write: views are derived from the sessions, so a
  // pageview writes the session only.
  assert.equal(memory.store.get(viewKey('/pricing')), undefined, 'no views: counter is written');
  assert.equal(memory.puts.filter((k) => k.startsWith('views:')).length, 0);
  assert.equal(memory.ttls.get(`session:${SID}`), 365 * 24 * 3600);
  // No KV throttle write on a tracking call: rate limiting lives at
  // the edge, so a pageview writes no rl: record.
  assert.equal([...memory.store.keys()].filter((k) => k.startsWith('rl:')).length, 0);
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
  // No per-path counter writes on repeat pageviews either.
  assert.equal(memory.store.get(viewKey('/')), undefined);
  assert.equal(memory.store.get(viewKey('/pricing')), undefined);
  assert.equal(memory.puts.filter((k) => k.startsWith('views:')).length, 0);
});

test('a pageview records the previous page duration and flushed clicks', async () => {
  const memory = memoryKV();
  await handlePageview(pageview({ sid: SID, path: '/pricing' }), envOf(memory.kv));
  const putsAfterFirst = memory.puts.filter((k) => k.startsWith('session:')).length;

  // Client-router navigation: the next pageview carries the previous
  // page's duration plus the clicks buffered since the last flush.
  const response = await handlePageview(
    pageview({
      sid: SID,
      path: '/contact',
      prevPath: '/pricing',
      prevDurationMs: 7_000,
      clicks: [
        { path: '/pricing', kind: 'cta', label: 'Get started' },
        { path: '/pricing', kind: 'link', label: 'x'.repeat(300) },
        { path: 'not-a-path', kind: 'click', label: 'dropped' },
      ],
    }),
    envOf(memory.kv),
  );
  assert.equal(response.status, 200);
  const session = sessionOf(memory.store);
  assert.equal(session.pages[0].durationMs, 7_000, 'previous page duration recorded');
  assert.equal(session.pages[1].path, '/contact');
  assert.equal(session.clicks.length, 2, 'invalid click dropped, valid ones kept');
  assert.equal(session.clicks[0].kind, 'cta');
  assert.equal(session.clicks[1].label.length, 120, 'label clamped');
  assert.equal(
    memory.puts.filter((k) => k.startsWith('session:')).length,
    putsAfterFirst + 1,
    'one session write for the whole piggyback',
  );
});

test('a final heartbeat flushes buffered clicks in the same write', async () => {
  const memory = memoryKV();
  await handlePageview(pageview({ sid: SID, path: '/pricing' }), envOf(memory.kv));
  const putsAfterPageview = memory.puts.filter((k) => k.startsWith('session:')).length;

  const response = await handleHeartbeat(
    heartbeat({
      sid: SID,
      path: '/pricing',
      durationMs: 12_000,
      final: true,
      clicks: [{ path: '/pricing', kind: 'cta', label: 'Buy' }],
    }),
    envOf(memory.kv),
  );
  assert.equal(response.status, 200);
  const session = sessionOf(memory.store);
  assert.equal(session.pages[0].durationMs, 12_000);
  assert.equal(session.clicks.length, 1);
  assert.equal(session.clicks[0].label, 'Buy');
  assert.equal(
    memory.puts.filter((k) => k.startsWith('session:')).length,
    putsAfterPageview + 1,
    'one session write for duration + clicks',
  );
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

test('pageview, click and heartbeat share the origin-only gate; no KV throttle write', async () => {
  const handlers = [
    [handlePageview, pageview],
    [handleClick, click],
    [handleHeartbeat, heartbeat],
  ] as const;
  for (const [handler, makeRequest] of handlers) {
    const memory = memoryKV();
    const body = { sid: SID, path: '/pricing' };
    const response = await handler(makeRequest(body, { origin: null }), envOf(memory.kv));
    assert.equal(response.status, 403);
    assert.deepEqual(await bodyOf(response), { ok: false, error: 'Forbidden origin' });

    const evil = await handler(makeRequest(body, { origin: 'https://evil.example' }), envOf(memory.kv));
    assert.equal(evil.status, 403);
  }

  // The KV throttle is gone (every check was a KV write per request):
  // a saturated rate-limit record must not 429 a pageview, and no
  // throttle record is written. Rate limiting belongs at the edge.
  const memory = memoryKV({ 'rl:track:203.0.113.9': { c: 120, r: Date.now() + 60_000 } });
  const before = memory.store.get('rl:track:203.0.113.9');
  const allowed = await handlePageview(pageview({ sid: SID, path: '/pricing' }), envOf(memory.kv));
  assert.equal(allowed.status, 200);
  assert.equal(memory.store.get('rl:track:203.0.113.9'), before, 'record untouched');
  assert.equal([...memory.store.keys()].filter((k) => k.startsWith('rl:track:')).length, 1, 'no new throttle record');
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

  // A periodic heartbeat within 300 s of the last write is acknowledged but
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
  session.lastSeenAt = Date.now() - 301_000;
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
