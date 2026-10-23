// Step 5: portal review decisions (approve publishes, changes loop back)
// and automated monthly reporting on real tenant view counts.
import assert from 'node:assert/strict';
import test from 'node:test';
import { handlePortalReview, handlePortalMe } from '../worker/portal';
import { runBuild } from '../worker/builds';
import {
  handleMonthlyReports,
  monthKey,
  previousMonthKey,
  recordTenantView,
  tenantViews,
} from '../worker/reports';
import {
  createClient,
  getClient,
  saveClient,
  type Client,
} from '../worker/clients';
import { putJson } from '../worker/kv';
import { apiRequest, bodyOf, envOf, memoryKV } from './helpers';

function stubSmtp() {
  const sent: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    sent.push(String(input));
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: { succeeded: 1, failed: 0 } }),
    } as Response;
  }) as typeof fetch;
  return {
    sent,
    restore() {
      globalThis.fetch = original;
    },
  };
}

async function reviewReadyClient(
  memory: ReturnType<typeof memoryKV>,
  email = 'rev@example.ca',
): Promise<Client> {
  const client = await createClient(memory.kv, { email, source: 'stripe' });
  client.business = 'Pat Plumbing';
  client.stage = 'build';
  client.onboarding = {
    businessName: 'Pat Plumbing',
    contactName: 'Pat',
    phone: '514-555-0100',
    services: 'Plumbing',
    serviceArea: 'Montreal',
    domainMode: 'new',
    domainValue: 'patplumbing.ca',
  };
  await saveClient(memory.kv, client);
  const env = envOf(memory.kv, {});
  await runBuild(env, await getClient(memory.kv, client.id).then((c) => c!));
  const ready = await getClient(memory.kv, client.id);
  assert.equal(ready!.stage, 'review');
  return ready!;
}

/** Put a portal session for the client directly in KV. */
async function sessionFor(memory: ReturnType<typeof memoryKV>, clientId: string) {
  const token = 'f'.repeat(64);
  await putJson(memory.kv, `portal-session:${token}`, { clientId, createdAt: Date.now() });
  return { cookie: `webao_portal=${token}` };
}

test('review approve: publishes the site and records the decision', async () => {
  const memory = memoryKV();
  const client = await reviewReadyClient(memory);
  const headers = await sessionFor(memory, client.id);
  const env = envOf(memory.kv, {});

  const res = await handlePortalReview(
    apiRequest('/api/portal/review', { decision: 'approved' }, { headers }),
    env,
  );
  assert.equal(res.status, 200);
  const after = await getClient(memory.kv, client.id);
  assert.equal(after!.stage, 'live');
  assert.equal(after!.reviewDecision?.decision, 'approved');
  assert.ok(after!.reviewDecision?.buildId);
});

test('review changes: a note is required, the record loops back to build', async () => {
  const memory = memoryKV();
  const client = await reviewReadyClient(memory);
  const headers = await sessionFor(memory, client.id);
  const stub = stubSmtp();
  try {
    const env = envOf(memory.kv, { SMTP2GO_API_KEY: 'k' });
    const noNote = await handlePortalReview(
      apiRequest('/api/portal/review', { decision: 'changes', note: '  ' }, { headers }),
      env,
    );
    assert.equal(noNote.status, 400);

    const res = await handlePortalReview(
      apiRequest(
        '/api/portal/review',
        { decision: 'changes', note: 'Make the phone number bigger' },
        { headers },
      ),
      env,
    );
    assert.equal(res.status, 200);
    const after = await getClient(memory.kv, client.id);
    assert.equal(after!.stage, 'build');
    assert.equal(after!.revisionCount, 1);
    assert.equal(after!.reviewDecision?.note, 'Make the phone number bigger');
    assert.ok(stub.sent.length >= 1, 'client got the confirmation email');

    // Out of review now: a second decision is refused.
    const again = await handlePortalReview(
      apiRequest('/api/portal/review', { decision: 'approved' }, { headers }),
      env,
    );
    assert.equal(again.status, 409);

    const anon = await handlePortalReview(
      apiRequest('/api/portal/review', { decision: 'approved' }),
      env,
    );
    assert.equal(anon.status, 401);
  } finally {
    stub.restore();
  }
});

test('tenant views accumulate per month and per day', async () => {
  const memory = memoryKV();
  const at = Date.UTC(2026, 9, 14, 12, 0, 0); // 2026-10-14
  await recordTenantView(memory.kv, 'cl_x', at);
  await recordTenantView(memory.kv, 'cl_x', at + 3600_000);
  await recordTenantView(memory.kv, 'cl_x', Date.UTC(2026, 9, 15));
  const stats = await tenantViews(memory.kv, 'cl_x', '2026-10');
  assert.equal(stats.views, 3);
  assert.equal(stats.byDay['14'], 2);
  assert.equal(stats.byDay['15'], 1);
  assert.equal(monthKey(at), '2026-10');
  assert.equal(previousMonthKey(Date.UTC(2026, 10, 1)), '2026-10');
  assert.equal(previousMonthKey(Date.UTC(2027, 0, 5)), '2026-12');
});

test('monthly reports: live clients get real numbers once, failures retry', async () => {
  const memory = memoryKV();
  const live = await createClient(memory.kv, { email: 'live@example.ca', source: 'stripe' });
  live.stage = 'live';
  live.domain = 'patplumbing.ca';
  live.domainStatus = 'live';
  await saveClient(memory.kv, live);
  const building = await createClient(memory.kv, { email: 'b@example.ca', source: 'stripe' });
  building.stage = 'build';
  await saveClient(memory.kv, building);
  await putJson(memory.kv, `tstats:${live.id}:2026-09`, { views: 42, byDay: { '3': 20, '9': 22 } });

  const envNoKey = envOf(memory.kv, { INTERNAL_CRON_SECRET: 's3cret' });
  const headers = { authorization: 'Bearer s3cret' };
  const failedRun = await handleMonthlyReports(
    apiRequest('/api/internal/monthly-reports', { month: '2026-09' }, { headers }),
    envNoKey,
  );
  const failedOut = await bodyOf(failedRun);
  assert.equal(failedOut.failed, 1, 'no SMTP2GO key: send fails and stays retryable');
  assert.equal(failedOut.sent, 0);

  const stub = stubSmtp();
  try {
    const env = envOf(memory.kv, { INTERNAL_CRON_SECRET: 's3cret', SMTP2GO_API_KEY: 'k' });
    const run = await handleMonthlyReports(
      apiRequest('/api/internal/monthly-reports', { month: '2026-09' }, { headers }),
      env,
    );
    const out = await bodyOf(run);
    assert.equal(out.sent, 1);
    assert.equal(out.failed, 0);

    const again = await handleMonthlyReports(
      apiRequest('/api/internal/monthly-reports', { month: '2026-09' }, { headers }),
      env,
    );
    const out2 = await bodyOf(again);
    assert.equal(out2.sent, 0);
    assert.equal(out2.skipped, 1, 'idempotent: never reported twice');

    // The portal /me view carries the current month's views for live clients.
    const headers2 = await sessionFor(memory, live.id);
    const me = await handlePortalMe(
      new Request('https://webao.ca/api/portal/me', { headers: headers2 }),
      env,
    );
    assert.equal(me.status, 200);
    assert.equal((await bodyOf(me)).client.siteViewsThisMonth, 0);
  } finally {
    stub.restore();
  }

  const noSecret = await handleMonthlyReports(
    apiRequest('/api/internal/monthly-reports', {}),
    envOf(memory.kv, {}),
  );
  assert.equal(noSecret.status, 503);
});
