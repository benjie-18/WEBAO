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

test('register stores the lead and returns tracked links (no index write)', async () => {
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
  // No index key: the admin list derives from the lead: prefix, so a
  // register costs exactly one write.
  assert.equal(memory.store.has('leads:index'), false);
  assert.deepEqual(memory.puts, [`lead:${body.id}`]);
});

test('register is idempotent for a caller-supplied id', async () => {
  const memory = memoryKV();
  const id = 'ld_' + 'a'.repeat(24);
  const first = await registerOne(memory, { ...leadBody, id });
  assert.equal(first.id, id);
  const second = await bodyOf(await handleLeadRegister(register({ ...leadBody, id }), envOf(memory.kv)));
  assert.equal(second.existing, true);
  // Idempotent re-register writes nothing new and keeps one record.
  assert.equal(memory.store.has('leads:index'), false);
  assert.deepEqual(memory.puts, [`lead:${id}`]);
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
