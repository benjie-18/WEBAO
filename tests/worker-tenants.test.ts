// Multi-tenant domains: normalization, tenant host routing, admin domain
// assignment, onboarding auto-claim, and the DNS verification sweep.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assignDomain,
  handleDomainChecks,
  handleTenantRequest,
} from '../worker/tenants';
import { handleAdmin } from '../worker/admin';
import {
  handlePortalExchange,
  handlePortalOnboarding,
  handlePortalRequestLink,
} from '../worker/portal';
import {
  createClient,
  getClient,
  normalizeDomain,
  saveClient,
} from '../worker/clients';
import { apiGet, apiRequest, bodyOf, envOf, memoryKV } from './helpers';

test('normalizeDomain: canonicalizes input and rejects junk and the main domain', () => {
  assert.equal(normalizeDomain('https://www.PatPlumbing.ca/'), 'patplumbing.ca');
  assert.equal(normalizeDomain('shop.example.ca/path?x=1'), 'shop.example.ca');
  assert.equal(normalizeDomain('EXAMPLE.CA'), 'example.ca');
  assert.equal(normalizeDomain('webao.ca'), null);
  assert.equal(normalizeDomain('app.webao.ca'), null);
  assert.equal(normalizeDomain('not a domain'), null);
  assert.equal(normalizeDomain('localhost'), null);
  assert.equal(normalizeDomain(''), null);
  assert.equal(normalizeDomain(undefined), null);
});

async function tenantClient(
  memory: ReturnType<typeof memoryKV>,
  email: string,
  host: string,
  stage: 'build' | 'paused' = 'build',
) {
  const client = await createClient(memory.kv, {
    email,
    business: 'Pat Plumbing',
    items: ['launch-month'],
    source: 'stripe',
  });
  client.stage = stage;
  const res = await assignDomain(memory.kv, client, host, 'pending-dns');
  assert.equal(res.ok, true);
  await saveClient(memory.kv, client);
  return client;
}

test('tenant routing: mapped host serves the client page, www alias works, unknown 404s', async () => {
  const memory = memoryKV();
  await tenantClient(memory, 'a@example.ca', 'patplumbing.ca');
  const env = envOf(memory.kv, {});

  const res = await handleTenantRequest(
    new Request('https://patplumbing.ca/'),
    env,
    new URL('https://patplumbing.ca/'),
  );
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Pat Plumbing/);
  assert.match(html, /coming soon/i);
  assert.equal(res.headers.get('x-robots-tag'), 'noindex');

  const www = await handleTenantRequest(
    new Request('https://www.patplumbing.ca/plans'),
    env,
    new URL('https://www.patplumbing.ca/plans'),
  );
  assert.equal(www.status, 200);

  const unknown = await handleTenantRequest(
    new Request('https://stranger.ca/'),
    env,
    new URL('https://stranger.ca/'),
  );
  assert.equal(unknown.status, 404);

  const post = await handleTenantRequest(
    new Request('https://patplumbing.ca/', { method: 'POST' }),
    env,
    new URL('https://patplumbing.ca/'),
  );
  assert.equal(post.status, 405);
});

test('tenant routing: a paused client serves the unavailable page', async () => {
  const memory = memoryKV();
  await tenantClient(memory, 'p@example.ca', 'pausedshop.ca', 'paused');
  const env = envOf(memory.kv, {});
  const res = await handleTenantRequest(
    new Request('https://pausedshop.ca/'),
    env,
    new URL('https://pausedshop.ca/'),
  );
  assert.equal(res.status, 200);
  assert.match(await res.text(), /temporarily unavailable/i);
});

test('admin domain assignment: assign, conflict, invalid, clear', async () => {
  const token = 'b'.repeat(64);
  const memory = memoryKV({
    [`admin:token:${token}`]: { createdAt: Date.now(), ip: '203.0.113.9' },
  });
  const one = await createClient(memory.kv, { email: 'one@example.ca', source: 'stripe' });
  const two = await createClient(memory.kv, { email: 'two@example.ca', source: 'stripe' });
  const env = envOf(memory.kv, {});
  const headers = { authorization: `Bearer ${token}` };
  const url = new URL('https://webao.ca/api/admin/clients/update');

  const assigned = await handleAdmin(
    apiRequest('/api/admin/clients/update', { id: one.id, domain: 'https://www.ShopOne.ca/' }, { headers }),
    env,
    url,
  );
  assert.equal(assigned.status, 200);
  assert.equal(memory.store.get('domain:shopone.ca'), JSON.stringify('client:' + one.id));
  assert.equal((await getClient(memory.kv, one.id))!.domainStatus, 'pending-dns');

  const conflict = await handleAdmin(
    apiRequest('/api/admin/clients/update', { id: two.id, domain: 'shopone.ca' }, { headers }),
    env,
    url,
  );
  assert.equal(conflict.status, 409);

  const invalid = await handleAdmin(
    apiRequest('/api/admin/clients/update', { id: two.id, domain: 'webao.ca' }, { headers }),
    env,
    url,
  );
  assert.equal(invalid.status, 400);

  const cleared = await handleAdmin(
    apiRequest('/api/admin/clients/update', { id: one.id, domain: '' }, { headers }),
    env,
    url,
  );
  assert.equal(cleared.status, 200);
  assert.equal(memory.store.has('domain:shopone.ca'), false);
  const after = await getClient(memory.kv, one.id);
  assert.equal(after!.domain, undefined);
  assert.equal(after!.domainStatus, 'none');
});

function stubFetch(handler: (url: string) => { ok: boolean; body: unknown }) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const r = handler(String(input));
    return { ok: r.ok, status: r.ok ? 200 : 404, json: async () => r.body } as Response;
  }) as typeof fetch;
  return {
    restore() {
      globalThis.fetch = original;
    },
  };
}

async function signIn(
  memory: ReturnType<typeof memoryKV>,
  env: ReturnType<typeof envOf>,
  email: string,
): Promise<{ cookie: string }> {
  await handlePortalRequestLink(apiRequest('/api/portal/request-link', { email }), env);
  const token = [...memory.store.keys()]
    .filter((k) => k.startsWith('portal-login:'))
    .map((k) => k.slice('portal-login:'.length))
    .pop()!;
  const exchanged = await handlePortalExchange(apiRequest('/api/portal/exchange', { token }), env);
  const m = /webao_portal=([a-f0-9]+)/.exec(exchanged.headers.get('set-cookie') || '');
  assert.ok(m);
  return { cookie: `webao_portal=${m![1]}` };
}

const FULL_FORM = {
  businessName: 'Pat Plumbing',
  contactName: 'Pat',
  phone: '514-555-0100',
  services: 'Plumbing',
  serviceArea: 'Montreal',
};

test('onboarding completion claims the domain: existing waits on DNS, new queues registration', async () => {
  const memory = memoryKV();
  const existing = await createClient(memory.kv, { email: 'ex@example.ca', source: 'stripe' });
  const fresh = await createClient(memory.kv, { email: 'new@example.ca', source: 'stripe' });
  const stub = stubFetch((url) =>
    url.includes('smtp2go')
      ? { ok: true, body: { data: { succeeded: 1, failed: 0 } } }
      : { ok: false, body: {} },
  );
  try {
    const env = envOf(memory.kv, { SMTP2GO_API_KEY: 'k' });
    const s1 = await signIn(memory, env, 'ex@example.ca');
    const r1 = await handlePortalOnboarding(
      apiRequest(
        '/api/portal/onboarding',
        { ...FULL_FORM, domainMode: 'existing', domainValue: 'https://www.ExistingShop.ca' },
        { headers: s1 },
      ),
      env,
    );
    assert.equal(r1.status, 200);
    const view1 = (await bodyOf(r1)).client;
    assert.equal(view1.domain, 'existingshop.ca');
    assert.equal(view1.domainStatus, 'pending-dns');
    assert.equal(memory.store.get('domain:existingshop.ca'), JSON.stringify('client:' + existing.id));

    const s2 = await signIn(memory, env, 'new@example.ca');
    const r2 = await handlePortalOnboarding(
      apiRequest(
        '/api/portal/onboarding',
        { ...FULL_FORM, domainMode: 'new', domainValue: 'brandnewshop.ca' },
        { headers: s2 },
      ),
      env,
    );
    const view2 = (await bodyOf(r2)).client;
    assert.equal(view2.domain, 'brandnewshop.ca');
    assert.equal(view2.domainStatus, 'to-register');
    assert.equal(memory.store.get('domain:brandnewshop.ca'), JSON.stringify('client:' + fresh.id));
  } finally {
    stub.restore();
  }
});

test('domain sweep: a CNAME into webao.ca connects, anything else stays pending', async () => {
  const memory = memoryKV();
  const linked = await tenantClient(memory, 'l@example.ca', 'linked.ca');
  const stray = await tenantClient(memory, 's@example.ca', 'stray.ca');
  const stub = stubFetch((url) => {
    if (url.includes('name=linked.ca')) {
      return { ok: true, body: { Answer: [{ type: 5, data: 'hosting.webao.ca.' }] } };
    }
    if (url.includes('dns-query')) return { ok: true, body: { Answer: [] } };
    return { ok: false, body: {} };
  });
  try {
    const env = envOf(memory.kv, { INTERNAL_CRON_SECRET: 's3cret' });
    const noSecret = await handleDomainChecks(
      apiRequest('/api/internal/domain-checks', {}),
      envOf(memory.kv, {}),
    );
    assert.equal(noSecret.status, 503);
    const wrong = await handleDomainChecks(
      apiRequest('/api/internal/domain-checks', {}, { headers: { authorization: 'Bearer nope' } }),
      env,
    );
    assert.equal(wrong.status, 401);

    const res = await handleDomainChecks(
      apiRequest('/api/internal/domain-checks', {}, { headers: { authorization: 'Bearer s3cret' } }),
      env,
    );
    assert.equal(res.status, 200);
    const out = await bodyOf(res);
    assert.equal(out.checked, 2);
    assert.equal(out.connected, 1);
    assert.equal(out.stillPending, 1);
    assert.equal((await getClient(memory.kv, linked.id))!.domainStatus, 'connected');
    const strayAfter = await getClient(memory.kv, stray.id);
    assert.equal(strayAfter!.domainStatus, 'pending-dns');
    assert.ok(strayAfter!.domainCheckedAt);
  } finally {
    stub.restore();
  }
});
