// Outreach lead tracking: registration, tracked-link clicks (/go/:id),
// reply matching, ingest-key hardening and the admin list/delete endpoints.
import assert from 'node:assert/strict';
import test from 'node:test';
import { handleLeadRegister, handleLeadReply, handleGo } from '../worker/leads';
import { handleAdmin } from '../worker/admin';
import { issueToken } from '../worker/auth';
import { apiGet, apiRequest, bodyOf, envOf, memoryKV } from './helpers';

const register = (body: unknown, options: Parameters<typeof apiRequest>[2] = {}) =>
  apiRequest('/api/leads/register', body, options);
const reply = (body: unknown, options: Parameters<typeof apiRequest>[2] = {}) =>
  apiRequest('/api/leads/reply', body, options);

const leadBody = {
  business: 'Climatisation Plein Air Inc',
  email: 'Info@PleinAir.example.ca',
  city: 'Varennes',
  trade: 'HVAC',
  subject: 'Quick question about Climatisation Plein Air Inc',
  lang: 'en',
  source: 'outreach',
};

const HUMAN_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15';

async function registerOne(memory: ReturnType<typeof memoryKV>, body: Record<string, unknown> = leadBody) {
  const res = await handleLeadRegister(register(body), envOf(memory.kv));
  assert.equal(res.status, 200);
  return bodyOf(res);
}

test('register stores the lead and returns tracked links (plus one index write)', async () => {
  const memory = memoryKV();
  const body = await registerOne(memory);
  assert.match(body.id, /^ld_[a-f0-9]{24}$/);
  assert.equal(body.links.demos, `https://webao.ca/go/${body.id}?d=demos`);
  assert.equal(body.links.home, `https://webao.ca/go/${body.id}?d=home`);
  assert.equal(body.replyTo, `contact+${body.id}@webao.ca`);

  const stored = JSON.parse(memory.store.get(`lead:${body.id}`) ?? 'null');
  assert.equal(stored.business, leadBody.business);
  assert.equal(stored.email, 'info@pleinair.example.ca', 'email is normalized to lowercase');
  assert.equal(stored.city, 'Varennes');
  assert.equal(stored.clickCount, 0);
  assert.deepEqual(stored.clicks, []);
  // One extra write per new register keeps the admin list fast (the list
  // fetches one page via the index instead of every record); at ~150
  // sends/day it is far under the 1,000/day KV write cap.
  assert.deepEqual(JSON.parse(memory.store.get('leads:index') ?? 'null'), [`lead:${body.id}`]);
  assert.deepEqual(memory.puts, [`lead:${body.id}`, 'leads:index']);
});

test('register is idempotent for a caller-supplied id', async () => {
  const memory = memoryKV();
  const id = 'ld_' + 'a'.repeat(24);
  const first = await registerOne(memory, { ...leadBody, id });
  assert.equal(first.id, id);
  const second = await bodyOf(await handleLeadRegister(register({ ...leadBody, id }), envOf(memory.kv)));
  assert.equal(second.existing, true);
  // Idempotent re-register writes nothing new and keeps one record; the
  // index still holds the single entry from the first register.
  assert.deepEqual(JSON.parse(memory.store.get('leads:index') ?? 'null'), [`lead:${id}`]);
  assert.deepEqual(memory.puts, [`lead:${id}`, 'leads:index']);
});

test('register validates business, email and id', async () => {
  const cases: Array<[unknown, string]> = [
    [{ email: 'a@b.ca' }, 'Business is required'],
    [{ business: 'X' }, 'Valid email is required'],
    [{ business: 'X', email: 'nope' }, 'Valid email is required'],
    [{ ...leadBody, id: 'ld_short' }, 'Invalid id'],
    [{ ...leadBody, id: 'not-a-lead' }, 'Invalid id'],
  ];
  for (const [body, message] of cases) {
    const memory = memoryKV();
    const res = await handleLeadRegister(register(body), envOf(memory.kv));
    assert.equal(res.status, 400, message);
    assert.deepEqual(await bodyOf(res), { ok: false, error: message });
    assert.equal(memory.store.has('leads:index'), false);
  }
});

test('register is origin-gated when no ingest key is configured', async () => {
  const memory = memoryKV();
  const res = await handleLeadRegister(register(leadBody, { origin: 'https://evil.example' }), envOf(memory.kv));
  assert.equal(res.status, 403);
  assert.equal(memory.store.size, 0);
});

test('a configured ingest key replaces the origin gate', async () => {
  const memory = memoryKV();
  const env = envOf(memory.kv, { LEADS_INGEST_KEY: 'test-key-123' });
  const noKey = await handleLeadRegister(register(leadBody), env);
  assert.equal(noKey.status, 401);
  const wrongKey = await handleLeadRegister(
    register(leadBody, { origin: null, headers: { 'x-ingest-key': 'nope' } }),
    env,
  );
  assert.equal(wrongKey.status, 401);
  // With the right key, no Origin header is needed (server-to-server sender).
  const ok = await handleLeadRegister(
    register(leadBody, { origin: null, headers: { 'x-ingest-key': 'test-key-123' } }),
    env,
  );
  assert.equal(ok.status, 200);
});

test('a human click is logged with its destination and redirects', async () => {
  const memory = memoryKV();
  const { id } = await registerOne(memory);
  const url = new URL(`https://webao.ca/go/${id}?d=demos`);
  const res = await handleGo(
    new Request(url, { headers: { 'user-agent': HUMAN_UA, 'cf-ipcountry': 'ca', 'CF-Connecting-IP': '203.0.113.9' } }),
    envOf(memory.kv),
    url,
  );
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), 'https://webao.ca/demos');

  const stored = JSON.parse(memory.store.get(`lead:${id}`) ?? 'null');
  assert.equal(stored.clickCount, 1);
  assert.equal(stored.clicks.length, 1);
  assert.equal(stored.clicks[0].dest, 'demos');
  assert.equal(stored.clicks[0].country, 'CA');
  assert.equal(stored.clicks[0].suspect, false);
  assert.equal(stored.firstClickAt, stored.clicks[0].at);
  assert.equal(stored.lastClickAt, stored.clicks[0].at);
});

test('scanner clicks are recorded but never counted as human clicks', async () => {
  const memory = memoryKV();
  const { id } = await registerOne(memory);
  const url = new URL(`https://webao.ca/go/${id}?d=home`);
  const res = await handleGo(
    new Request(url, { headers: { 'user-agent': 'Microsoft SafeLinks Scanner', 'CF-Connecting-IP': '203.0.113.9' } }),
    envOf(memory.kv),
    url,
  );
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), 'https://webao.ca/');
  const stored = JSON.parse(memory.store.get(`lead:${id}`) ?? 'null');
  assert.equal(stored.clicks.length, 1);
  assert.equal(stored.clicks[0].suspect, true);
  assert.equal(stored.clickCount, 0);
  assert.equal(stored.firstClickAt, undefined);
});

test('unknown ids and bad destinations still redirect safely', async () => {
  const memory = memoryKV();
  const unknown = new URL('https://webao.ca/go/ld_' + 'f'.repeat(24));
  const res = await handleGo(new Request(unknown), envOf(memory.kv), unknown);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), 'https://webao.ca/demos', 'default destination');

  const { id } = await registerOne(memory);
  const evil = new URL(`https://webao.ca/go/${id}?d=https://evil.example`);
  const res2 = await handleGo(new Request(evil, { headers: { 'user-agent': HUMAN_UA } }), envOf(memory.kv), evil);
  assert.equal(res2.headers.get('location'), 'https://webao.ca/demos', 'destinations are whitelisted, never open redirects');

  const garbage = new URL('https://webao.ca/go/not-an-id');
  const res3 = await handleGo(new Request(garbage), envOf(memory.kv), garbage);
  assert.equal(res3.status, 302);
});

test('a reply matches by lead id, then falls back to sender email', async () => {
  const memory = memoryKV();
  const { id } = await registerOne(memory);

  const byId = await bodyOf(
    await handleLeadReply(reply({ leadId: id, kind: 'reply', subject: 'Re: Quick question' }), envOf(memory.kv)),
  );
  assert.deepEqual(byId, { ok: true, matched: true, id, kind: 'reply' });
  let stored = JSON.parse(memory.store.get(`lead:${id}`) ?? 'null');
  assert.equal(typeof stored.repliedAt, 'number');
  assert.equal(stored.replies.length, 1);
  assert.equal(stored.replies[0].subject, 'Re: Quick question');

  const byEmail = await bodyOf(
    await handleLeadReply(reply({ email: 'INFO@pleinair.example.ca', kind: 'optout' }), envOf(memory.kv)),
  );
  assert.equal(byEmail.matched, true);
  stored = JSON.parse(memory.store.get(`lead:${id}`) ?? 'null');
  assert.equal(typeof stored.optOutAt, 'number');
  assert.equal(stored.replies.length, 2);
});

test('an unmatched reply is a calm 200, and bad input is a 400', async () => {
  const memory = memoryKV();
  await registerOne(memory);
  const miss = await handleLeadReply(reply({ email: 'someone@else.ca' }), envOf(memory.kv));
  assert.equal(miss.status, 200);
  assert.deepEqual(await bodyOf(miss), { ok: true, matched: false });

  const bad = await handleLeadReply(reply({}), envOf(memory.kv));
  assert.equal(bad.status, 400);
});

test('admin leads list needs auth and delete removes record + index entry', async () => {
  const memory = memoryKV();
  const { id } = await registerOne(memory);
  const url = new URL('https://webao.ca/api/admin/leads');

  const anon = await handleAdmin(apiGet('/api/admin/leads'), envOf(memory.kv), url);
  assert.equal(anon.status, 401);

  const token = await issueToken(memory.kv, '203.0.113.9');
  const auth = { headers: { authorization: `Bearer ${token}` } };
  const list = await bodyOf(await handleAdmin(apiGet('/api/admin/leads', auth), envOf(memory.kv), url));
  assert.equal(list.ok, true);
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].id, id);
  assert.equal(list.nextCursor, null);

  const delUrl = new URL(`https://webao.ca/api/admin/leads/${id}`);
  const del = await handleAdmin(
    apiRequest(`/api/admin/leads/${id}`, undefined, { method: 'DELETE', ...auth }),
    envOf(memory.kv),
    delUrl,
  );
  assert.equal(del.status, 200);
  assert.equal(memory.store.has(`lead:${id}`), false);
  assert.deepEqual(JSON.parse(memory.store.get('leads:index') ?? '[]'), []);

  const badDel = await handleAdmin(
    apiRequest('/api/admin/leads/nope', undefined, { method: 'DELETE', ...auth }),
    envOf(memory.kv),
    new URL('https://webao.ca/api/admin/leads/nope'),
  );
  assert.equal(badDel.status, 400);
});

/** Make the next kv.put throw once, then behave normally; returns attempts. */
function failNextPut(memory: ReturnType<typeof memoryKV>): () => number {
  const origPut = memory.kv.put.bind(memory.kv);
  let attempts = 0;
  memory.kv.put = async (...args: any[]) => {
    attempts += 1;
    if (attempts === 1) throw new Error('KV write failed (test)');
    return origPut(...args);
  };
  return () => attempts;
}

test('register retries a transient KV failure once instead of 503ing', async () => {
  const memory = memoryKV();
  const attempts = failNextPut(memory);
  const body = await registerOne(memory);
  assert.equal(attempts(), 3, 'lead put retried once, index put first try');
  assert.equal(memory.store.has(`lead:${body.id}`), true);
  assert.deepEqual(JSON.parse(memory.store.get('leads:index') ?? 'null'), [`lead:${body.id}`]);
});

test('reply retries a transient KV failure once and records the reply', async () => {
  const memory = memoryKV();
  const { id } = await registerOne(memory);
  const attempts = failNextPut(memory);
  const res = await bodyOf(
    await handleLeadReply(reply({ leadId: id, kind: 'reply', subject: 'Re: Quick question' }), envOf(memory.kv)),
  );
  assert.deepEqual(res, { ok: true, matched: true, id, kind: 'reply' });
  assert.equal(attempts(), 2, 'lead put retried once');
  const stored = JSON.parse(memory.store.get(`lead:${id}`) ?? 'null');
  assert.equal(stored.replies.length, 1);
});

test('a sustained KV outage still surfaces as a write error (honest 503 upstream)', async () => {
  const memory = memoryKV();
  memory.failWrites(true);
  await assert.rejects(handleLeadRegister(register(leadBody), envOf(memory.kv)), /KV write failed/);
});

test('an identical reply posted twice is recorded once', async () => {
  const memory = memoryKV();
  const { id } = await registerOne(memory);
  const first = await bodyOf(
    await handleLeadReply(
      reply({ leadId: id, kind: 'reply', from: 'a@example.ca', subject: 'Re: Quick question' }),
      envOf(memory.kv),
    ),
  );
  assert.deepEqual(first, { ok: true, matched: true, id, kind: 'reply' });
  const second = await bodyOf(
    await handleLeadReply(
      reply({ leadId: id, kind: 'reply', from: 'a@example.ca', subject: 'Re: Quick question' }),
      envOf(memory.kv),
    ),
  );
  assert.deepEqual(second, { ok: true, matched: true, id, kind: 'reply', duplicate: true });
  let stored = JSON.parse(memory.store.get(`lead:${id}`) ?? 'null');
  assert.equal(stored.replies.length, 1, 'retry did not duplicate the reply');
  // A different kind with the same subject is a genuinely new event.
  await handleLeadReply(
    reply({ leadId: id, kind: 'optout', from: 'a@example.ca', subject: 'Re: Quick question' }),
    envOf(memory.kv),
  );
  stored = JSON.parse(memory.store.get(`lead:${id}`) ?? 'null');
  assert.equal(stored.replies.length, 2);
});

/** Admin list call with a fresh token; clears the read log first. */
async function listLeads(memory: ReturnType<typeof memoryKV>, query = '') {
  const token = await issueToken(memory.kv, '203.0.113.9');
  const url = new URL(`https://webao.ca/api/admin/leads${query}`);
  memory.gets.length = 0;
  return bodyOf(
    await handleAdmin(
      apiGet(`/api/admin/leads${query}`, { headers: { authorization: `Bearer ${token}` } }),
      envOf(memory.kv),
      url,
    ),
  );
}

function seededLead(id: string, sentAt: number): Record<string, unknown> {
  return {
    [`lead:${id}`]: {
      id,
      business: `Co ${id}`,
      email: `${id}@example.ca`,
      sentAt,
      clicks: [],
      replies: [],
      clickCount: 0,
    },
  };
}

test('admin list uses the index: one page costs one page of reads', async () => {
  const a = 'ld_' + 'a'.repeat(24);
  const b = 'ld_' + 'b'.repeat(24);
  const c = 'ld_' + 'c'.repeat(24);
  const memory = memoryKV({
    'leads:index': [`lead:${c}`, `lead:${b}`, `lead:${a}`],
    ...seededLead(a, 1000),
    ...seededLead(b, 2000),
    ...seededLead(c, 3000),
  });
  const page1 = await listLeads(memory, '?limit=2');
  assert.deepEqual(
    page1.items.map((i: { id: string }) => i.id),
    [c, b],
  );
  assert.equal(page1.nextCursor, '2');
  // Index read + 2 page records (plus the session read); the third record
  // was never fetched.
  assert.ok(memory.gets.includes('leads:index'));
  assert.equal(memory.gets.filter((g) => g.startsWith('lead:')).length, 2);
  assert.ok(!memory.gets.includes(`lead:${a}`));
  const page2 = await listLeads(memory, '?limit=2&cursor=2');
  assert.deepEqual(
    page2.items.map((i: { id: string }) => i.id),
    [a],
  );
  assert.equal(page2.nextCursor, null);
});

test('admin list rebuilds a missing or drifted index from a full scan', async () => {
  const a = 'ld_' + 'a'.repeat(24);
  const b = 'ld_' + 'b'.repeat(24);
  const memory = memoryKV({
    // No index: first list falls back to the full scan and rebuilds it.
    ...seededLead(a, 1000),
    ...seededLead(b, 2000),
  });
  const list = await listLeads(memory, '?limit=50');
  assert.deepEqual(
    list.items.map((i: { id: string }) => i.id),
    [b, a],
  );
  assert.deepEqual(JSON.parse(memory.store.get('leads:index') ?? 'null'), [`lead:${b}`, `lead:${a}`]);

  // Drift: a record the index does not know about triggers a rebuild too.
  const d = 'ld_' + 'd'.repeat(24);
  memory.store.set(
    `lead:${d}`,
    JSON.stringify({ id: d, business: 'Co d', email: 'd@example.ca', sentAt: 4000, clicks: [], replies: [], clickCount: 0 }),
  );
  const relist = await listLeads(memory, '?limit=50');
  assert.deepEqual(
    relist.items.map((i: { id: string }) => i.id),
    [d, b, a],
  );
  assert.deepEqual(JSON.parse(memory.store.get('leads:index') ?? 'null'), [
    `lead:${d}`,
    `lead:${b}`,
    `lead:${a}`,
  ]);
});
