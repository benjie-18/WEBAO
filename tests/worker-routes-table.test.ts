// Route-dispatch table: every /api route entry in worker/index.ts must
// reach its handler instead of falling through to the JSON 404. This pins
// the dispatch table itself; each handler's behavior is covered by its own
// test file. (24 route entries, 25 cases: the admin prefix is tested
// twice. An earlier comment said "25 routes"; that was a miscount.)
import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../worker/index';
import { issueToken } from '../worker/auth';
import { createClient } from '../worker/clients';
import { apiGet, apiRequest, bodyOf, envOf, memoryKV } from './helpers';

const CRON_SECRET = 'test-cron-' + 'secret-123';
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const call = (request: Request, env: unknown) => worker.fetch(request, env as never, ctx);

test('route table: every API route dispatches (no fall-through 404)', async () => {
  const memory = memoryKV();
  await createClient(memory.kv, { email: 'owner@example.ca', source: 'stripe' });
  const adminToken = await issueToken(memory.kv, '203.0.113.9');
  const adminHeaders = { authorization: `Bearer ${adminToken}` };
  // Deliberately wrong: the gate must answer 401, proving dispatch, without
  // running the job itself.
  const wrongHeaders = { authorization: 'Bearer ' + 'wrong-' + 'secret' };
  const env = envOf(memory.kv, { INTERNAL_CRON_SECRET: CRON_SECRET });

  // The track gates reject a missing Origin; apiRequest sets one by
  // default, so these three pass origin: null to reach the gate.
  const trackCases: Array<[string, unknown, number]> = [
    ['/api/track/pageview', { sid: 's1', path: '/pricing' }, 403],
    ['/api/track/click', { sid: 's1', path: '/pricing' }, 403],
    ['/api/track/heartbeat', { sid: 's1' }, 403],
  ];
  for (const [path, body, expected] of trackCases) {
    const res = await call(apiRequest(path, body, { origin: null }), env);
    assert.notEqual(res.status, 404, `POST ${path} fell through to the 404`);
    assert.equal(res.status, expected, `POST ${path}`);
  }

  // [method, path, body-or-null, headers, expected status]
  // A wrong-method or unknown route answers 404; a dispatched route never
  // does, whatever its auth/validation outcome is.
  const cases: Array<[string, string, unknown, Record<string, string>, number]> = [
    ['POST', '/api/forms/submit', { form: 'contact', fields: { name: 'Sam', message: 'hi' } }, {}, 200],
    ['POST', '/api/leads/register', { business: 'Co', email: 'co@example.ca' }, {}, 200],
    ['POST', '/api/leads/reply', {}, {}, 400],
    ['POST', '/api/checkout/session', {}, {}, 503],
    ['POST', '/api/stripe/webhook', {}, {}, 503],
    ['POST', '/api/portal/request-link', { email: 'nobody@example.ca' }, {}, 200],
    ['POST', '/api/portal/exchange', { token: 'bad' }, {}, 401],
    ['POST', '/api/portal/claim', { sessionId: 'cs_x' }, {}, 503],
    // Signed-out /me is a clean 200 { authenticated: false } (no console
    // 401 for a visitor who simply isn't signed in); the signed-in path
    // is covered in worker-portal.test.ts.
    ['GET', '/api/portal/me', null, {}, 200],
    ['POST', '/api/portal/onboarding', {}, {}, 401],
    ['POST', '/api/portal/review', {}, {}, 401],
    ['POST', '/api/portal/ads-onboarding', {}, {}, 401],
    ['POST', '/api/portal/ads-lead-outcome', {}, {}, 401],
    ['POST', '/api/portal/logout', {}, {}, 200],
    ['POST', '/api/internal/onboarding-nudges', {}, wrongHeaders, 401], // wrong secret on purpose: gate reached
    ['POST', '/api/internal/domain-checks', {}, wrongHeaders, 401],
    ['POST', '/api/internal/build', {}, wrongHeaders, 401],
    ['POST', '/api/internal/monthly-reports', {}, wrongHeaders, 401],
    ['POST', '/api/internal/abandoned-followups', {}, wrongHeaders, 401],
    ['POST', '/api/internal/ads-lead', {}, wrongHeaders, 401],
    ['GET', '/api/admin/stats', null, adminHeaders, 200],
    ['GET', '/api/admin/clients', null, adminHeaders, 200],
  ];
  for (const [method, path, body, headers, expected] of cases) {
    const req =
      method === 'GET'
        ? apiGet(path, { headers })
        : apiRequest(path, body, { headers });
    const res = await call(req, env);
    assert.notEqual(res.status, 404, `${method} ${path} fell through to the 404`);
    assert.equal(res.status, expected, `${method} ${path}`);
  }

  // And the negative control: a genuinely unknown route still 404s.
  const missing = await call(apiGet('/api/nope'), env);
  assert.equal(missing.status, 404);
  assert.deepEqual(await bodyOf(missing), { ok: false, error: 'Not found' });
});
