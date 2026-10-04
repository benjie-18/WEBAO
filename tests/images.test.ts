import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import worker from '../worker/index';

const fixture = Buffer.from(readFileSync(new URL('./fixtures/image.jpg.b64', import.meta.url), 'utf8'), 'base64');
const bytes = new Uint8Array(fixture).buffer;
function environment(asset: () => Promise<Response>, image: ArrayBuffer | null = bytes) {
  const keys: string[] = [];
  return {
    keys,
    env: {
      ASSETS: { fetch: asset },
      WEBAO_KV: { get: async (key: string, type: string) => {
        keys.push(key);
        assert.equal(type, 'arrayBuffer');
        return image;
      } },
    } as unknown as Env,
  };
}
const ctx = {} as ExecutionContext;

test('deployment explicitly binds the static asset fetcher', () => {
  const config = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  assert.equal(config.assets.binding, 'ASSETS');
  assert.ok(config.kv_namespaces.some((kv: { binding: string }) => kv.binding === 'WEBAO_KV'));
});

test('existing static images bypass KV', async () => {
  const { env, keys } = environment(async () => new Response(bytes));
  const response = await worker.fetch(new Request('https://example.com/demos/tactile/01.jpg'), env, ctx);
  assert.deepEqual(await response.arrayBuffer(), bytes);
  assert.deepEqual(keys, []);
});

for (const path of ['/demos/tactile/01.jpg', '/carousel/tactile.jpg']) {
  for (const failure of ['404', 'throw']) {
    test(`${path}: KV fallback after asset ${failure}`, async () => {
      const { env, keys } = environment(async () => {
        if (failure === 'throw') throw new Error('asset unavailable');
        return new Response('Not found', { status: 404 });
      });
      const response = await worker.fetch(new Request(`https://example.com${path}`), env, ctx);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'image/jpeg');
      assert.deepEqual(await response.arrayBuffer(), bytes);
      assert.deepEqual(keys, [`img:${path}`]);
    });
  }
}

test('missing KV images return 404, not a successful image response', async () => {
  const { env } = environment(async () => new Response(null, { status: 404 }), null);
  const response = await worker.fetch(new Request('https://example.com/demos/missing.jpg'), env, ctx);
  assert.equal(response.status, 404);
});

// Astro's static build generates an assets-only redirect that omits worker/index.ts.
// Checking only wrangler.jsonc cannot catch deploying that wrong configuration.
test('deploy and local-preview commands bypass Astro’s assets-only config redirect', () => {
  const { scripts } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(scripts['cf:deploy'], /wrangler deploy --config wrangler\.jsonc/);
  assert.match(scripts['cf:dev'], /wrangler dev --config wrangler\.jsonc/);
  const workflow = readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  assert.match(workflow, /run: npx wrangler deploy --config wrangler\.jsonc/);
  assert.match(workflow, /run: npm run test:integration/);
});
