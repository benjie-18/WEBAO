// Session day-bundles: the rebuild endpoint's auth gate, the
// incremental rebuild from active markers, and the sliced full rebuild
// with its staging swap and empty-day pruning. The bundle read path
// itself is covered in tests/worker-admin.test.ts.
import assert from 'node:assert/strict';
import test from 'node:test';
import { handleSessionBundlesRebuild } from '../worker/sessions';
import { handleAdmin } from '../worker/admin';
import { issueToken } from '../worker/auth';
import { mergeChartsAggregates } from '../worker/aggregates';
import { addDays, dayKey } from '../worker/util';
import { apiGet, apiRequest, bodyOf, envOf, memoryKV } from './helpers';

const SECRET = 'cron-secret';
const rebuild = (body: unknown, secret: string | null = SECRET) =>
  apiRequest('/api/internal/session-bundles/rebuild', body, {
    headers: secret === null ? {} : { authorization: `Bearer ${secret}` },
  });
const env = (memory: ReturnType<typeof memoryKV>, secret: string | null = SECRET) =>
  envOf(memory.kv, secret === null ? {} : { INTERNAL_CRON_SECRET: secret });

const mkSession = (startedAt: number, lastSeenAt = startedAt) => ({
  ip: '1.2.3.4', country: 'CA', ua: '', device: 'desktop', browser: 'other',
  startedAt, lastSeenAt, pages: [], clicks: [],
});
const bundleOf = (store: Map<string, string>, day: string) =>
  JSON.parse(store.get(`session-bundle:${day}`) ?? 'null');

test('the rebuild endpoint requires the shared secret (503 unset, 401 wrong)', async () => {
  const memory = memoryKV();
  const unset = await handleSessionBundlesRebuild(rebuild({}, null), env(memory, null));
  assert.equal(unset.status, 503);
  const wrong = await handleSessionBundlesRebuild(rebuild({}, 'nope'), env(memory));
  assert.equal(wrong.status, 401);
  const ok = await handleSessionBundlesRebuild(rebuild({}), env(memory));
  assert.equal(ok.status, 200);
  const okBody = await bodyOf(ok);
  assert.equal(okBody.ok, true);
  assert.equal(okBody.mode, 'incremental');
  assert.deepEqual(okBody.days, []);
  assert.equal(okBody.sessions, 0);
  assert.equal(typeof okBody.builtAt, 'number');
});

test('incremental rebuild freshens bundles from the last 3 days of markers only', async () => {
  const memory = memoryKV();
  const today = dayKey();
  const yesterday = addDays(today, -1);
  const twoDaysAgo = addDays(today, -2);
  const mk = (day: string, sid: string) => {
    const ts = Date.parse(day + 'T12:00:00Z');
    memory.store.set(`session:${sid}`, JSON.stringify(mkSession(ts, ts)));
    memory.store.set(`sessions:active:${day}:${sid}`, '1');
    return ts;
  };
  mk(today, 'new-today');
  mk(yesterday, 'back-yesterday');
  mk(twoDaysAgo, 'old-two-days');
  // A session with no marker is untouched for 3 days: not rebuilt.
  const quietTs = Date.parse(twoDaysAgo + 'T09:00:00Z');
  memory.store.set('session:quiet', JSON.stringify(mkSession(quietTs, quietTs)));

  const response = await handleSessionBundlesRebuild(rebuild({ mode: 'incremental' }), env(memory));
  const body = await bodyOf(response);
  assert.equal(body.mode, 'incremental');
  assert.deepEqual(body.days, [twoDaysAgo, yesterday, today]);
  assert.equal(body.sessions, 3);
  assert.deepEqual(
    bundleOf(memory.store, today).sessions.map((s: any) => s.sid),
    ['new-today'],
  );
  assert.deepEqual(
    bundleOf(memory.store, yesterday).sessions.map((s: any) => s.sid),
    ['back-yesterday'],
  );
  assert.deepEqual(
    bundleOf(memory.store, twoDaysAgo).sessions.map((s: any) => s.sid),
    ['old-two-days'],
    'the quiet session on the same day is not in the bundle yet — the full rebuild adds it',
  );
  assert.equal(memory.store.get(`session-bundle:${twoDaysAgo}`) !== undefined, true);
  assert.equal(memory.store.get(`sessions:day:${today}`), '"1"', 'rebuilt days are registered');
});

test('full rebuild slices over all sessions, swaps staging into live, and prunes empty days', async () => {
  const memory = memoryKV();
  const today = dayKey();
  const days = [addDays(today, -2), addDays(today, -1), today];
  let n = 0;
  for (const day of days) {
    const ts = Date.parse(day + 'T12:00:00Z');
    for (let i = 0; i < 450; i++, n++) {
      memory.store.set(`session:s-${n}`, JSON.stringify(mkSession(ts, ts)));
    }
  }
  // A stale live bundle and a stale day entry for a day with no sessions.
  const emptyDay = addDays(today, -9);
  memory.store.set(`session-bundle:${emptyDay}`, JSON.stringify({ day: emptyDay, builtAt: 1, sessions: [] }));
  memory.store.set(`sessions:day:${emptyDay}`, '"1"');
  // Leftover staging from a run that died mid-way.
  memory.store.set('session-bundle-staging:2099-01-01', JSON.stringify({ day: '2099-01-01', builtAt: 1, sessions: [] }));

  const call = (offset: number) =>
    handleSessionBundlesRebuild(rebuild({ mode: 'full', offset }), env(memory));
  const first = await bodyOf(await call(0));
  assert.equal(first.done, false);
  assert.equal(first.nextOffset, 500);
  assert.equal(first.total, 1350);
  assert.equal(
    memory.store.get('session-bundle-staging:2099-01-01'),
    undefined,
    'offset 0 clears stale staging first',
  );
  const second = await bodyOf(await call(500));
  assert.equal(second.done, false);
  assert.equal(second.nextOffset, 1000);
  const third = await bodyOf(await call(1000));
  assert.equal(third.done, true);
  assert.equal(third.nextOffset, null);
  assert.deepEqual(third.days, days);
  assert.equal(third.sessions, 1350);
  for (const day of days) {
    assert.equal(bundleOf(memory.store, day).sessions.length, 450, `bundle ${day} holds its day`);
  }
  assert.equal(memory.store.get(`session-bundle:${emptyDay}`), undefined, 'empty-day bundle deleted');
  assert.equal(memory.store.get(`sessions:day:${emptyDay}`), undefined, 'empty-day entry pruned');
  assert.equal(
    [...memory.store.keys()].filter((k) => k.startsWith('session-bundle-staging:')).length,
    0,
    'no staging keys left after the swap',
  );
  assert.equal(memory.store.get(`sessions:day:${today}`), '"1"', 'rebuilt days are registered');
});

test('incremental rebuild upserts into an existing bundle without dropping its sessions', async () => {
  const memory = memoryKV();
  const today = dayKey();
  const yesterday = addDays(today, -1);
  const yTs = Date.parse(yesterday + 'T12:00:00Z');
  const old = mkSession(yTs, yTs);
  memory.store.set(`session-bundle:${yesterday}`, JSON.stringify({
    day: yesterday, builtAt: Date.now() - 3600_000, sessions: [{ sid: 'kept', ...old }],
  }));
  // The kept session returns today: fresh record + marker.
  const fresh = mkSession(yTs, Date.parse(today + 'T09:00:00Z'));
  memory.store.set('session:kept', JSON.stringify(fresh));
  memory.store.set(`sessions:active:${today}:kept`, '1');
  // And a brand-new session started yesterday, first seen today.
  const brandNew = mkSession(yTs, Date.parse(today + 'T09:30:00Z'));
  memory.store.set('session:brand-new', JSON.stringify(brandNew));
  memory.store.set(`sessions:active:${today}:brand-new`, '1');

  const body = await bodyOf(await handleSessionBundlesRebuild(rebuild({ mode: 'incremental' }), env(memory)));
  assert.equal(body.sessions, 2);
  const bundle = bundleOf(memory.store, yesterday);
  assert.deepEqual(bundle.sessions.map((s: any) => s.sid).sort(), ['brand-new', 'kept']);
  assert.equal(
    bundle.sessions.find((s: any) => s.sid === 'kept').lastSeenAt,
    Date.parse(today + 'T09:00:00Z'),
    'the fresh record overwrites the stale bundle copy',
  );
});

const adminUrl = (path: string) => new URL(`https://webao.ca${path}`);
const adminGet = (path: string, token: string) =>
  apiGet(path, { headers: { authorization: `Bearer ${token}` } });

/** Seed live-shaped data: 636 sessions, 1,172 leads, 300 forms. */
function seedLiveStore(memory: ReturnType<typeof memoryKV>) {
  const DAY = 24 * 3600 * 1000;
  const today = dayKey();
  const todayStart = Date.parse(today + 'T00:00:00Z');
  let n = 0;
  for (let d = 37; d >= 0; d--) {
    const day = addDays(today, -d);
    for (let i = 0; i < 17 && n < 636; i++, n++) {
      const startedAt = Date.parse(day + 'T12:00:00Z') + i * 1000;
      const pages = [{ path: '/', at: startedAt, durationMs: 0 }];
      if (i % 2 === 0) pages.push({ path: '/pricing', at: startedAt + 5000, durationMs: 0 });
      memory.store.set(`session:s-${n}`, JSON.stringify({
        ip: '1.2.3.4', country: n % 3 === 0 ? 'US' : 'CA', ua: '',
        device: n % 4 === 0 ? 'mobile' : 'desktop', browser: 'other',
        startedAt, lastSeenAt: startedAt + 8000, pages, clicks: [],
      }));
    }
  }
  const leadKeys: string[] = [];
  for (let i = 0; i < 1172; i++) {
    const sentAt = todayStart - (i % 60) * DAY + 3600_000;
    const id = `ld_${String(i).padStart(4, '0')}`;
    leadKeys.push(`lead:${id}`);
    memory.store.set(`lead:${id}`, JSON.stringify({
      id, business: `Biz ${i}`, email: `b${i}@example.com`, sentAt,
      clicks: i % 5 === 0 ? [{ at: sentAt + 60000, dest: 'demos', country: 'CA', suspect: false }] : [],
      replies: [], clickCount: i % 5 === 0 ? 1 : 0,
      firstClickAt: i % 5 === 0 ? sentAt + 60000 : undefined,
      repliedAt: i % 7 === 0 ? sentAt + 120000 : undefined,
      bouncedAt: i % 11 === 0 ? sentAt + 30000 : undefined,
    }));
  }
  memory.store.set('leads:index', JSON.stringify(leadKeys));
  for (let i = 0; i < 300; i++) {
    const at = todayStart - (i % 30) * DAY + 3600_000;
    memory.store.set(`form:${at}:${String(i).padStart(3, '0')}`, JSON.stringify({
      form: ['contact', 'support', 'pricing'][i % 3], fields: {}, ip: '1.2.3.4', country: 'CA', ua: '', at,
    }));
  }
}

test('incremental rebuild refreshes the stats aggregates', async () => {
  const memory = memoryKV();
  const today = dayKey();
  const ts = Date.parse(today + 'T12:00:00Z');
  memory.store.set('session:one', JSON.stringify(mkSession(ts, ts)));
  memory.store.set(`sessions:active:${today}:one`, '1');
  const body = await bodyOf(await handleSessionBundlesRebuild(rebuild({ mode: 'incremental' }), env(memory)));
  assert.equal(body.statsAggregates, true);
  const agg = JSON.parse(memory.store.get('stats:agg:week') ?? 'null');
  assert.equal(agg.ok, true);
  assert.equal(agg.source, 'precomputed');
  assert.equal(agg.sessionsTotal, 1);
  assert.equal(agg.visitors.at(-1), 1);
  assert.equal(typeof agg.builtAt, 'number');
});

test('rebuild writes stats and charts aggregates matching live aggregation exactly', async () => {
  const memory = memoryKV();
  seedLiveStore(memory);

  let offset = 0;
  for (;;) {
    const b = await bodyOf(await handleSessionBundlesRebuild(rebuild({ mode: 'full', offset }), env(memory)));
    if (b.done) {
      assert.equal(b.statsAggregates, true, 'the full rebuild recomputes the stats aggregates');
      break;
    }
    offset = b.nextOffset;
  }
  let lo = 0;
  let fo = 0;
  for (;;) {
    const b = await bodyOf(await handleSessionBundlesRebuild(rebuild({ mode: 'charts', leadOffset: lo, formOffset: fo }), env(memory)));
    if (b.done) break;
    lo = b.nextLeadOffset ?? Number.MAX_SAFE_INTEGER;
    fo = b.nextFormOffset ?? Number.MAX_SAFE_INTEGER;
  }
  for (const range of ['day', 'week', 'month', 'year', 'all']) {
    assert.ok(memory.store.has(`stats:agg:${range}`), `stats aggregate ${range} written`);
    assert.ok(memory.store.has(`charts:agg:${range}`), `charts aggregate ${range} written`);
  }

  const token = await issueToken(memory.kv, '203.0.113.9');
  const strip = (b: any) => {
    const { source, builtAt, leadsNextOffset, formsNextOffset, ...rest } = b;
    return rest;
  };
  const clearCache = () => {
    for (const k of [...memory.store.keys()]) if (k.startsWith('admin:cache:')) memory.store.delete(k);
  };

  for (const range of ['day', 'week', 'month', 'year', 'all']) {
    // Stats: aggregate-served vs live (aggregates deleted, cache cleared).
    const aggBody = await bodyOf(await handleAdmin(adminGet(`/api/admin/stats?range=${range}`, token), envOf(memory.kv), adminUrl(`/api/admin/stats?range=${range}`)));
    assert.equal(aggBody.source, 'precomputed', `stats ${range} served from the aggregate`);
    const storedAgg = memory.store.get(`stats:agg:${range}`);
    memory.store.delete(`stats:agg:${range}`);
    clearCache();
    const liveBody = await bodyOf(await handleAdmin(adminGet(`/api/admin/stats?range=${range}`, token), envOf(memory.kv), adminUrl(`/api/admin/stats?range=${range}`)));
    assert.notEqual(liveBody.source, 'precomputed');
    assert.deepEqual(strip(aggBody), strip(liveBody), `stats ${range}: aggregate matches live exactly`);
    memory.store.set(`stats:agg:${range}`, storedAgg!);
    clearCache();

    // Charts: aggregate-served vs live slices merged the way the panel merges them.
    const cAggBody = await bodyOf(await handleAdmin(adminGet(`/api/admin/charts?range=${range}`, token), envOf(memory.kv), adminUrl(`/api/admin/charts?range=${range}`)));
    assert.equal(cAggBody.source, 'precomputed', `charts ${range} served from the aggregate`);
    const storedCAgg = memory.store.get(`charts:agg:${range}`);
    memory.store.delete(`charts:agg:${range}`);
    clearCache();
    let merged: any = null;
    let clo = 0;
    let cfo = 0;
    for (;;) {
      const slice = await bodyOf(await handleAdmin(adminGet(`/api/admin/charts?range=${range}&leadOffset=${clo}&formOffset=${cfo}`, token), envOf(memory.kv), adminUrl(`/api/admin/charts?range=${range}&leadOffset=${clo}&formOffset=${cfo}`)));
      const { leadsNextOffset, formsNextOffset, ...core } = slice;
      merged = merged ? mergeChartsAggregates(merged, core) : core;
      if ((leadsNextOffset === null || leadsNextOffset === undefined) && (formsNextOffset === null || formsNextOffset === undefined)) break;
      clo = leadsNextOffset ?? Number.MAX_SAFE_INTEGER;
      cfo = formsNextOffset ?? Number.MAX_SAFE_INTEGER;
    }
    assert.deepEqual(strip(cAggBody), strip(merged), `charts ${range}: aggregate matches live exactly`);
    memory.store.set(`charts:agg:${range}`, storedCAgg!);
    clearCache();
  }
});

test('charts mode replaying a finished call does not double-count', async () => {
  const memory = memoryKV();
  const DAY = 24 * 3600 * 1000;
  const today = dayKey();
  const todayStart = Date.parse(today + 'T00:00:00Z');
  // 900 leads + 150 forms: two charts calls (850/100, then the rest).
  const leadKeys: string[] = [];
  for (let i = 0; i < 900; i++) {
    const sentAt = todayStart - (i % 60) * DAY + 3600_000;
    const id = `ld_${String(i).padStart(4, '0')}`;
    leadKeys.push(`lead:${id}`);
    memory.store.set(`lead:${id}`, JSON.stringify({
      id, business: `Biz ${i}`, email: `b${i}@example.com`, sentAt,
      clicks: [], replies: [], clickCount: 0,
    }));
  }
  memory.store.set('leads:index', JSON.stringify(leadKeys));
  for (let i = 0; i < 150; i++) {
    const at = todayStart - (i % 30) * DAY + 3600_000;
    memory.store.set(`form:${at}:${String(i).padStart(3, '0')}`, JSON.stringify({
      form: 'contact', fields: {}, ip: '1.2.3.4', country: 'CA', ua: '', at,
    }));
  }
  const call = async (lo: number, fo: number) =>
    bodyOf(await handleSessionBundlesRebuild(rebuild({ mode: 'charts', leadOffset: lo, formOffset: fo }), env(memory)));
  const first = await call(0, 0);
  assert.equal(first.done, false);
  assert.equal(first.nextLeadOffset, 850);
  assert.equal(first.nextFormOffset, 100);
  const second = await call(850, 100);
  assert.equal(second.done, true);
  const written = memory.store.get('charts:agg:all');
  // Replay the finished call: same offsets, already merged.
  const replay = await call(850, 100);
  assert.equal(replay.done, true);
  assert.equal(replay.nextLeadOffset, null);
  assert.equal(replay.nextFormOffset, null);
  assert.equal(memory.store.get('charts:agg:all'), written, 'the replay leaves the live keys untouched');
  const agg = JSON.parse(written ?? 'null');
  assert.equal(agg.leads.sent.reduce((a: number, v: number) => a + v, 0), 900, 'every lead counted once');
  assert.equal(agg.forms.total.reduce((a: number, v: number) => a + v, 0), 150, 'every form counted once');
});
