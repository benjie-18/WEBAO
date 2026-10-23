// Build pipeline: site generation, the QA gate, draft/preview/publish
// serving, and the admin + internal triggers.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getBuildState,
  handleInternalBuild,
  publishBuild,
  runBuild,
  runQa,
  servePreviewSite,
  servePublishedSite,
} from '../worker/builds';
import { generateSite, parseServices } from '../worker/sitegen';
import { handleAdmin } from '../worker/admin';
import { assignDomain } from '../worker/tenants';
import {
  createClient,
  getClient,
  saveClient,
  type Client,
} from '../worker/clients';
import { apiGet, apiRequest, bodyOf, envOf, memoryKV } from './helpers';

async function buildableClient(
  memory: ReturnType<typeof memoryKV>,
  email = 'owner@example.ca',
): Promise<Client> {
  const client = await createClient(memory.kv, { email, source: 'stripe' });
  client.business = 'Pat Plumbing';
  client.stage = 'build';
  client.onboarding = {
    businessName: 'Pat Plumbing',
    contactName: 'Pat',
    phone: '514-555-0100',
    services: 'Plumbing, Drain cleaning\nWater heaters',
    serviceArea: 'Montreal and the South Shore',
    hours: 'Mon to Fri, 8 am to 5 pm',
    about: 'Family plumbing company since 2009.',
    domainMode: 'existing',
    domainValue: 'patplumbing.ca',
  };
  client.onboardingCompletedAt = Date.now();
  await saveClient(memory.kv, client);
  return client;
}

test('parseServices splits lines, commas and semicolons, dedupes and caps', () => {
  assert.deepEqual(parseServices('Plumbing, Drain cleaning\nWater heaters; Plumbing'), [
    'Plumbing',
    'Drain cleaning',
    'Water heaters',
  ]);
  assert.deepEqual(parseServices(''), []);
  assert.deepEqual(parseServices(undefined), []);
});

test('generateSite renders the client data into one valid page', async () => {
  const memory = memoryKV();
  const client = await buildableClient(memory);
  const files = generateSite(client);
  assert.equal(files.length, 1);
  const html = files[0].content;
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<title>Pat Plumbing/);
  assert.equal((html.match(/<h1[\s>]/g) || []).length, 1);
  assert.ok(html.includes('href="tel:+15145550100"'));
  assert.ok(html.includes('Drain cleaning'));
  assert.ok(html.includes('Montreal and the South Shore'));
  assert.ok(!html.includes('—'), 'no em dashes');
});

test('runQa passes a generated site and catches tampering', async () => {
  const memory = memoryKV();
  const client = await buildableClient(memory);
  const files = generateSite(client);
  const good = runQa(client, files);
  assert.equal(good.passed, true, JSON.stringify(good.checks.filter((c) => !c.ok)));

  const tampered = [
    {
      ...files[0],
      content: files[0].content
        .split('514-555-0100')
        .join('514-555-9999')
        .replace('</body>', '<p>Something — with an em dash</p></body>'),
    },
  ];
  const bad = runQa(client, tampered);
  assert.equal(bad.passed, false);
  const failedIds = bad.checks.filter((c) => !c.ok).map((c) => c.id);
  assert.ok(failedIds.includes('phone-link'));
  assert.ok(failedIds.includes('no-em-dash'));
});

test('runBuild: QA pass stores a draft, advances to review, sets the preview URL', async () => {
  const memory = memoryKV();
  const client = await buildableClient(memory);
  const env = envOf(memory.kv, {});
  const result = await runBuild(env, client);
  assert.equal(result.qa.passed, true);

  const state = await getBuildState(memory.kv, client.id);
  assert.equal(state.draftBuildId, result.buildId);
  assert.equal(state.publishedBuildId, null);
  assert.equal(state.latest?.qa.passed, true);

  const after = await getClient(memory.kv, client.id);
  assert.equal(after!.stage, 'review');
  assert.equal(after!.previewUrl, `https://webao.ca/preview/${client.id}/`);

  const preview = await servePreviewSite(env, client.id, 'index.html');
  assert.equal(preview.status, 200);
  assert.match(await preview.text(), /Pat Plumbing/);
  assert.equal(preview.headers.get('x-robots-tag'), 'noindex');

  // Nothing is live on the tenant host yet.
  const live = await servePublishedSite(env, after!, new URL('https://patplumbing.ca/'));
  assert.equal(live, null);
});

test('publishBuild: the tenant host serves the site, the stage goes live', async () => {
  const memory = memoryKV();
  const client = await buildableClient(memory);
  await assignDomain(memory.kv, client, 'patplumbing.ca', 'pending-dns');
  client.domainStatus = 'connected';
  await saveClient(memory.kv, client);
  const env = envOf(memory.kv, {});

  const refused = await publishBuild(env, await getClient(memory.kv, client.id).then((c) => c!));
  assert.equal(refused.ok, false, 'no draft yet');

  await runBuild(env, await getClient(memory.kv, client.id).then((c) => c!));
  const done = await publishBuild(env, await getClient(memory.kv, client.id).then((c) => c!));
  assert.equal(done.ok, true);

  const after = await getClient(memory.kv, client.id);
  assert.equal(after!.stage, 'live');
  assert.equal(after!.domainStatus, 'live');

  const res = await servePublishedSite(env, after!, new URL('https://patplumbing.ca/'));
  assert.ok(res);
  assert.equal(res!.status, 200);
  assert.match(await res!.text(), /Water heaters/);
});

test('runBuild: a QA failure stays in build and records the failures (exception queue)', async () => {
  const memory = memoryKV();
  const client = await buildableClient(memory);
  const env = envOf(memory.kv, {});
  const broken = () => [
    { path: 'index.html', contentType: 'text/html', content: '<html><body>lorem ipsum</body></html>' },
  ];
  const result = await runBuild(env, client, broken);
  assert.equal(result.qa.passed, false);
  const after = await getClient(memory.kv, client.id);
  assert.equal(after!.stage, 'build');
  assert.equal(after!.previewUrl, undefined);
  const state = await getBuildState(memory.kv, client.id);
  assert.ok(state.latest!.qa.checks.some((c) => !c.ok && c.id === 'no-placeholder'));
});

test('admin build + publish endpoints and the internal trigger enforce their gates', async () => {
  const token = 'c'.repeat(64);
  const memory = memoryKV({
    [`admin:token:${token}`]: { createdAt: Date.now(), ip: '203.0.113.9' },
  });
  const client = await buildableClient(memory);
  const env = envOf(memory.kv, { INTERNAL_CRON_SECRET: 's3cret' });
  const headers = { authorization: `Bearer ${token}` };

  const built = await handleAdmin(
    apiRequest('/api/admin/clients/build', { id: client.id }, { headers }),
    env,
    new URL('https://webao.ca/api/admin/clients/build'),
  );
  assert.equal(built.status, 200);
  assert.equal((await bodyOf(built)).qaPassed, true);

  const listed = await handleAdmin(
    apiGet('/api/admin/clients', { headers }),
    env,
    new URL('https://webao.ca/api/admin/clients'),
  );
  const item = (await bodyOf(listed)).items[0];
  assert.equal(item.buildQaPassed, true);
  assert.equal(item.publishPending, true);
  assert.equal(item.isPublished, false);

  const published = await handleAdmin(
    apiRequest('/api/admin/clients/publish', { id: client.id }, { headers }),
    env,
    new URL('https://webao.ca/api/admin/clients/publish'),
  );
  assert.equal(published.status, 200);

  const noSecret = await handleInternalBuild(
    apiRequest('/api/internal/build', { clientId: client.id }),
    envOf(memory.kv, {}),
  );
  assert.equal(noSecret.status, 503);
  const wrongSecret = await handleInternalBuild(
    apiRequest('/api/internal/build', { clientId: client.id }, { headers: { authorization: 'Bearer nope' } }),
    env,
  );
  assert.equal(wrongSecret.status, 401);
  const internal = await handleInternalBuild(
    apiRequest('/api/internal/build', { clientId: client.id }, { headers: { authorization: 'Bearer s3cret' } }),
    env,
  );
  assert.equal(internal.status, 200);
  assert.equal((await bodyOf(internal)).qaPassed, true);
});
