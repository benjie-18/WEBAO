// The worker entrypoint: subdomain redirect, /api dispatch, image fallback to
// KV and the top-level error mapping (typed KV failures → 503, anything else
// → a generic 500 that leaks nothing).
import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../worker/index';
import { issueToken } from '../worker/auth';
import { apiGet, apiRequest, bodyOf, envOf, memoryKV } from './helpers';

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

const assetsReturning = (status: number, body = 'asset', headers: Record<string, string> = {}) =>
  ({ fetch: async () => new Response(status === 404 ? 'Not found' : body, { status, headers }) }) as unknown as Fetcher;

const call = (request: Request, env: unknown) => worker.fetch(request, env as never, ctx);

test('the old subdomain redirects permanently to the canonical domain', async () => {
  const memory = memoryKV();
  const response = await call(
    new Request('https://webao.bnji.net/pricing?utm=x', { headers: { origin: 'https://webao.bnji.net' } }),
    envOf(memory.kv, { ASSETS: assetsReturning(200) }),
  );
  assert.equal(response.status, 301);
  assert.equal(response.headers.get('location'), 'https://webao.ca/pricing?utm=x');
});

test('API calls reach the right handler and unknown routes are a JSON 404', async () => {
  const memory = memoryKV();
  const env = envOf(memory.kv, { ASSETS: assetsReturning(200) });

  const missing = await call(new Request('https://webao.ca/api/nope'), env);
  assert.equal(missing.status, 404);
  assert.deepEqual(await bodyOf(missing), { ok: false, error: 'Not found' });

  // GET on a POST-only route falls through to the same 404.
  const wrongMethod = await call(new Request('https://webao.ca/api/track/pageview'), env);
  assert.equal(wrongMethod.status, 404);

  // The tracking gate runs inside the dispatched handler: no origin, no entry.
  const noOrigin = await call(
    new Request('https://webao.ca/api/track/pageview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sid: 'sess-0001', path: '/pricing' }),
    }),
    env,
  );
  assert.equal(noOrigin.status, 403);
  assert.equal(memory.store.has('session:sess-0001'), false);
});

test('a KV write outage becomes an honest 503, not a 500', async () => {
  const memory = memoryKV();
  memory.failWrites(true);
  const response = await call(
    apiRequest('/api/forms/submit', {
      form: 'contact',
      fields: { name: 'Sam', message: 'Bonjour' },
    }),
    envOf(memory.kv, { ASSETS: assetsReturning(200) }),
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await bodyOf(response), {
    ok: false,
    error: 'Storage is temporarily unavailable. Please try again shortly.',
  });
});

test('unexpected errors are a generic 500 that never leak internals', async () => {
  const memory = memoryKV();
  const token = await issueToken(memory.kv, '203.0.113.9');
  memory.failList(new Error('boom: secret detail'));
  const response = await call(
    apiGet('/api/admin/stats', { headers: { authorization: `Bearer ${token}` } }),
    envOf(memory.kv, { ASSETS: assetsReturning(200) }),
  );
  assert.equal(response.status, 500);
  assert.deepEqual(await bodyOf(response), { ok: false, error: 'Internal error' });
});

test('images fall back to KV when the asset is missing, with the right type', async () => {
  const image = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]).buffer;
  const cases: Array<[string, string]> = [
    ['/demos/tactile/01.jpg', 'image/jpeg'],
    ['/demos/aeris/hero.png', 'image/png'],
    ['/carousel/brume.webp', 'image/webp'],
  ];
  for (const [path, type] of cases) {
    const memory = memoryKV({ [`img:${path}`]: 'binary' });
    // Serve raw bytes rather than the string stub for this case.
    memory.kv.get = async (key: string, options?: { type?: string } | string) => {
      const type = typeof options === 'string' ? options : options?.type;
      return type === 'arrayBuffer' && key === `img:${path}` ? image : null;
    };
    const response = await call(
      new Request(`https://webao.ca${path}`),
      envOf(memory.kv, { ASSETS: assetsReturning(404) }),
    );
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get('content-type'), type, path);
    assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal((await response.arrayBuffer()).byteLength, image.byteLength, path);
  }
});

test('a throwing assets binding still lets KV answer image requests', async () => {
  const memory = memoryKV();
  memory.kv.get = async (key: string, options?: { type?: string } | string) => {
    const type = typeof options === 'string' ? options : options?.type;
    return type === 'arrayBuffer' && key === 'img:/demos/x.jpg' ? new Uint8Array([1]).buffer : null;
  };
  const throwing = { fetch: async () => { throw new Error('no asset manifest'); } } as unknown as Fetcher;
  const response = await call(new Request('https://webao.ca/demos/x.jpg'), envOf(memory.kv, { ASSETS: throwing }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/jpeg');
});

test('images missing from both asset and KV are a plain 404', async () => {
  const memory = memoryKV();
  const response = await call(
    new Request('https://webao.ca/demos/ghost.jpg'),
    envOf(memory.kv, { ASSETS: assetsReturning(404) }),
  );
  assert.equal(response.status, 404);
  assert.equal(await response.text(), 'Not found');
});

test('everything else is served straight from the assets binding', async () => {
  const memory = memoryKV();
  const html = '<!doctype html><title>WEBAO</title>';
  const response = await call(
    new Request('https://webao.ca/pricing'),
    envOf(memory.kv, { ASSETS: assetsReturning(200, html, { 'content-type': 'text/html' }) }),
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/html');
  assert.equal(await response.text(), html);
});
