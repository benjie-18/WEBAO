// Admin charts endpoint: per-day form + outreach series, exclusive lead
// outcome stages, and human-only click destination counts.
import assert from 'node:assert/strict';
import test from 'node:test';
import { handleAdmin } from '../worker/admin';
import { issueToken } from '../worker/auth';
import { dayKey } from '../worker/util';
import { apiGet, bodyOf, envOf, memoryKV, type MemoryKV } from './helpers';

const url = (path: string) => new URL(`https://webao.ca${path}`);
const DAY = 24 * 3600 * 1000;
const now = Date.now();
const todayStart = Date.parse(dayKey(now) + 'T00:00:00Z');
const tToday = todayStart + 3600 * 1000; // 01:00 UTC today
const tYesterday = tToday - DAY;

const form = (type: string, at: number) =>
  JSON.stringify({ form: type, fields: { name: 'X' }, ip: '1.2.3.4', country: 'CA', ua: '', at });

const lead = (over: Record<string, unknown>) =>
  JSON.stringify({
    id: 'ld_0000000000000000000000aa',
    business: 'Test',
    email: 't@example.com',
    sentAt: tToday,
    clicks: [],
    replies: [],
    clickCount: 0,
    ...over,
  });

async function seeded(): Promise<{ memory: MemoryKV; token: string }> {
  const memory = memoryKV({
    'forms:index': ['form:1:a', 'form:2:b', 'form:3:c', 'form:4:d'],
    'form:1:a': form('contact', tToday),
    'form:2:b': form('contact', tYesterday),
    'form:3:c': form('support', tToday),
    'form:4:d': form('pricing', tToday - 40 * DAY), // outside a week range
    'leads:index': ['lead:ld_a', 'lead:ld_b', 'lead:ld_c'],
    // Replied (also clicked) — counts once, as replied.
    'lead:ld_a': lead({
      id: 'ld_a',
      sentAt: tToday,
      clickCount: 2,
      firstClickAt: tToday + 60_000,
      repliedAt: tToday + 120_000,
      clicks: [
        { at: tToday + 60_000, dest: 'demos', country: 'CA', suspect: false },
        { at: tToday + 90_000, dest: 'demos', country: 'CA', suspect: true }, // scanner: excluded
      ],
    }),
    // Clicked only, yesterday.
    'lead:ld_b': lead({
      id: 'ld_b',
      sentAt: tYesterday,
      clickCount: 1,
      firstClickAt: tYesterday + 60_000,
      clicks: [{ at: tYesterday + 60_000, dest: 'home', country: 'CA', suspect: false }],
    }),
    // Bounced today.
    'lead:ld_c': lead({ id: 'ld_c', sentAt: tToday, bouncedAt: tToday + 30_000 }),
  });
  const token = await issueToken(memory.kv, '203.0.113.9');
  return { memory, token };
}

const get = (path: string, token?: string) =>
  apiGet(path, token ? { headers: { authorization: `Bearer ${token}` } } : {});

test('charts requires admin auth and a valid range', async () => {
  const { memory, token } = await seeded();
  const anon = await handleAdmin(get('/api/admin/charts?range=week'), envOf(memory.kv), url('/api/admin/charts?range=week'));
  assert.equal(anon.status, 401);

  const bad = await handleAdmin(get('/api/admin/charts?range=decade', token), envOf(memory.kv), url('/api/admin/charts?range=decade'));
  assert.equal(bad.status, 400);
});

test('charts buckets forms and leads per day for the week range', async () => {
  const { memory, token } = await seeded();
  const res = await handleAdmin(get('/api/admin/charts?range=week', token), envOf(memory.kv), url('/api/admin/charts?range=week'));
  assert.equal(res.status, 200);
  const body = await bodyOf(res);
  assert.equal(body.ok, true);
  assert.equal(body.labels.length, 7);
  assert.equal(body.labels[6], dayKey(now));
  assert.equal(body.labels[5], dayKey(now - DAY));

  // Forms: contact today 1 + yesterday 1; support today 1; pricing is 40d out.
  assert.equal(body.forms.total[6], 2);
  assert.equal(body.forms.total[5], 1);
  assert.equal(body.forms.byType.contact[6], 1);
  assert.equal(body.forms.byType.contact[5], 1);
  assert.equal(body.forms.byType.support[6], 1);
  assert.equal(body.forms.byType.pricing.reduce((s: number, v: number) => s + v, 0), 0);

  // Leads: sent today 2, yesterday 1; first clicks today 1, yesterday 1; replies today 1.
  assert.equal(body.leads.sent[6], 2);
  assert.equal(body.leads.sent[5], 1);
  assert.equal(body.leads.clicked[6], 1);
  assert.equal(body.leads.clicked[5], 1);
  assert.equal(body.leads.replied[6], 1);

  // Stages are exclusive: replied 1, clicked-only 1, bounced 1, none/optout 0.
  assert.deepEqual(body.leadStages, { replied: 1, clicked: 1, none: 0, optout: 0, bounced: 1 });

  // Click destinations: scanner click excluded; demos 1 (human), home 1.
  assert.equal(body.clickDests.demos, 1);
  assert.equal(body.clickDests.home, 1);
  assert.equal(body.clickDests.pricing, 0);
  assert.equal(body.clickDests.start, 0);
});

test('charts year range aggregates into monthly buckets', async () => {
  const { memory, token } = await seeded();
  const res = await handleAdmin(get('/api/admin/charts?range=year', token), envOf(memory.kv), url('/api/admin/charts?range=year'));
  assert.equal(res.status, 200);
  const body = await bodyOf(res);
  // 365 days back touches 12 or 13 calendar months depending on the day.
  assert.ok(body.labels.length === 12 || body.labels.length === 13);
  assert.equal(body.labels[body.labels.length - 1], dayKey(now).slice(0, 7));
  // All four forms fall inside the year (the pricing one is 40 days old).
  assert.equal(body.forms.total.reduce((s: number, v: number) => s + v, 0), 4);
});

test('charts reads lead keys from leads:index instead of scanning', async () => {
  // Index lists only ld_a + ld_b plus a stale key for a deleted lead;
  // ld_c is in the store but NOT in the index, so it must not be counted.
  const memory = memoryKV({
    'form:1:a': form('contact', tToday),
    'leads:index': ['lead:ld_a', 'lead:ld_b', 'lead:ld_deleted'],
    'lead:ld_a': lead({
      id: 'ld_a',
      sentAt: tToday,
      clickCount: 2,
      firstClickAt: tToday + 60_000,
      repliedAt: tToday + 120_000,
      clicks: [{ at: tToday + 60_000, dest: 'demos', country: 'CA', suspect: false }],
    }),
    'lead:ld_b': lead({
      id: 'ld_b',
      sentAt: tYesterday,
      clickCount: 1,
      firstClickAt: tYesterday + 60_000,
      clicks: [{ at: tYesterday + 60_000, dest: 'home', country: 'CA', suspect: false }],
    }),
    'lead:ld_c': lead({ id: 'ld_c', sentAt: tToday, bouncedAt: tToday + 30_000 }),
  });
  const token = await issueToken(memory.kv, '203.0.113.9');
  const res = await handleAdmin(get('/api/admin/charts?range=week', token), envOf(memory.kv), url('/api/admin/charts?range=week'));
  assert.equal(res.status, 200);
  const body = await bodyOf(res);
  // ld_c (bounced today) is not counted: the index, not the scan, decides.
  assert.deepEqual(body.leadStages, { replied: 1, clicked: 1, none: 0, optout: 0, bounced: 0 });
  assert.equal(body.leads.sent[6], 1);
  assert.equal(body.leads.sent[5], 1);
  // Read fan-out: the index once, then exactly the indexed keys — the
  // stale key is fetched (null, filtered) but no other lead: key is read.
  assert.equal(memory.gets.filter((k: string) => k === 'leads:index').length, 1);
  assert.deepEqual(
    memory.gets.filter((k: string) => k.startsWith('lead:')),
    ['lead:ld_a', 'lead:ld_b', 'lead:ld_deleted'],
  );
});

test('charts all-time pages leads in slices and counts every form once', async () => {
  // 900 leads: 450 sent today, 450 sent 40 days ago; 2 forms today.
  // One call cannot fetch 900 leads (worker subrequest budget), so the
  // panel fetches slice after slice via leadOffset; the slices are
  // disjoint and together cover every lead, forms only on slice one.
  const seed: Record<string, unknown> = {
    'form:1:a': form('contact', tToday),
    'form:2:b': form('contact', tYesterday),
  };
  const keys: string[] = [];
  for (let i = 0; i < 900; i++) {
    const id = `ld_${String(i).padStart(24, '0')}`;
    keys.push('lead:' + id);
    seed['lead:' + id] = lead({ id, sentAt: i < 450 ? tToday : tToday - 40 * DAY });
  }
  seed['leads:index'] = keys;
  const memory = memoryKV(seed);
  const token = await issueToken(memory.kv, '203.0.113.9');

  const first = await bodyOf(await handleAdmin(get('/api/admin/charts?range=all', token), envOf(memory.kv), url('/api/admin/charts?range=all')));
  assert.equal(first.range, 'all');
  assert.equal(first.leadsTotal, 900);
  assert.equal(first.leadsNextOffset, 850, 'first slice stops inside the subrequest budget');
  assert.equal(first.formsTotal, 2);
  assert.equal(first.formsNextOffset, null);
  assert.equal(first.forms.total.reduce((s: number, v: number) => s + v, 0), 2, 'forms arrive on slice one');
  assert.equal(first.leads.sent.reduce((s: number, v: number) => s + v, 0), 850);
  assert.ok(first.labels.includes(dayKey(tToday - 40 * DAY).slice(0, 7)), 'labels reach the oldest month');

  const second = await bodyOf(await handleAdmin(get('/api/admin/charts?range=all&leadOffset=850&formOffset=100', token), envOf(memory.kv), url('/api/admin/charts?range=all&leadOffset=850&formOffset=100')));
  assert.equal(second.leadsNextOffset, null, 'no third slice');
  assert.equal(second.formsNextOffset, null);
  assert.equal(second.forms.total.reduce((s: number, v: number) => s + v, 0), 0, 'forms are not counted twice');
  assert.equal(second.leads.sent.reduce((s: number, v: number) => s + v, 0), 50);

  const sentTotal =
    first.leads.sent.reduce((s: number, v: number) => s + v, 0) +
    second.leads.sent.reduce((s: number, v: number) => s + v, 0);
  assert.equal(sentTotal, 900, 'both slices together count every lead');
});

test('charts all-time pages forms in slices of 100', async () => {
  const seed: Record<string, unknown> = { 'leads:index': [] };
  for (let i = 0; i < 150; i++) seed[`form:${i}:x`] = form('contact', tToday);
  const memory = memoryKV(seed);
  const token = await issueToken(memory.kv, '203.0.113.9');

  const first = await bodyOf(await handleAdmin(get('/api/admin/charts?range=all', token), envOf(memory.kv), url('/api/admin/charts?range=all')));
  assert.equal(first.formsTotal, 150);
  assert.equal(first.formsNextOffset, 100);
  assert.equal(first.forms.total.reduce((s: number, v: number) => s + v, 0), 100);

  const second = await bodyOf(await handleAdmin(get('/api/admin/charts?range=all&leadOffset=0&formOffset=100', token), envOf(memory.kv), url('/api/admin/charts?range=all&leadOffset=0&formOffset=100')));
  assert.equal(second.formsNextOffset, null);
  assert.equal(second.forms.total.reduce((s: number, v: number) => s + v, 0), 50);
  assert.equal(second.leads.sent.reduce((s: number, v: number) => s + v, 0), 0, 'no leads, no double count');
});

test('charts falls back to the full scan when leads:index is missing or empty', async () => {
  for (const index of [undefined, []]) {
    const seed: Record<string, unknown> = {
      'form:1:a': form('contact', tToday),
      'lead:ld_a': lead({ id: 'ld_a', sentAt: tToday, repliedAt: tToday + 120_000 }),
      'lead:ld_b': lead({ id: 'ld_b', sentAt: tYesterday }),
      'lead:ld_c': lead({ id: 'ld_c', sentAt: tToday, bouncedAt: tToday + 30_000 }),
    };
    if (index !== undefined) seed['leads:index'] = index;
    const memory = memoryKV(seed);
    const token = await issueToken(memory.kv, '203.0.113.9');
    const res = await handleAdmin(get('/api/admin/charts?range=week', token), envOf(memory.kv), url('/api/admin/charts?range=week'));
    assert.equal(res.status, 200);
    const body = await bodyOf(res);
    // Without a usable index the scan sees all three leads, ld_c included.
    assert.deepEqual(body.leadStages, { replied: 1, clicked: 0, none: 1, optout: 0, bounced: 1 });
    assert.equal(body.leads.sent[6], 2);
  }
});
