// Uses real Workerd assets + local KV, never a Cloudflare account or remote data.
// Run after an Astro build, so its deployment-config redirect is present.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { unstable_dev } from 'wrangler';

const image = Buffer.from(readFileSync(new URL('./fixtures/image.jpg.b64', import.meta.url), 'utf8'), 'base64');
const paths = ['/demos/tactile/01.jpg', '/carousel/tactile.jpg'];

test('built site serves static pages and KV-only images through the custom Worker', { timeout: 60000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'webao-images-'));
  const persistTo = join(dir, 'state');
  const fixture = join(dir, 'image.jpg');
  let server: Awaited<ReturnType<typeof unstable_dev>> | undefined;
  try {
    // Reproduce the environment created by the build; don't delete the redirect
    // as a workaround. Our explicit --config must bypass it.
    readFileSync('.wrangler/deploy/config.json');
    writeFileSync(fixture, image);
    for (const path of paths) {
      execFileSync(process.execPath, [
        'node_modules/wrangler/bin/wrangler.js', 'kv', 'key', 'put', `img:${path}`,
        '--path', fixture, '--binding', 'WEBAO_KV', '--local',
        '--config', 'wrangler.jsonc', '--persist-to', persistTo,
      ], { stdio: 'pipe', timeout: 20000 });
    }
    server = await unstable_dev('worker/index.ts', {
      config: 'wrangler.jsonc', local: true, ip: '127.0.0.1', port: 0,
      persistTo, logLevel: 'error',
      experimental: { disableExperimentalWarning: true, disableDevRegistry: true, watch: false },
    });
    const request = (path: string, init?: RequestInit) =>
      fetch(`http://${server!.address}:${server!.port}${path}`, init);
    for (const path of paths) {
      const response = await request(path);
      assert.equal(response.status, 200, path);
      assert.equal(response.headers.get('content-type'), 'image/jpeg');
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), image, path);
      const head = await request(path, { method: 'HEAD' });
      assert.equal(head.status, 200);
      assert.equal((await head.arrayBuffer()).byteLength, 0);
    }
    for (const path of ['/', '/demos/tactile', '/fr/demos/tactile']) {
      const response = await request(path);
      assert.equal(response.status, 200, path);
      assert.match(response.headers.get('content-type') ?? '', /text\/html/);
      assert.match(await response.text(), /<!doctype html>/i);
    }
    const staticImage = await request('/qc-flag.png');
    assert.equal(staticImage.status, 200);
    assert.deepEqual(Buffer.from(await staticImage.arrayBuffer()), readFileSync('public/qc-flag.png'));
    const missing = await request('/demos/not-seeded.jpg');
    assert.equal(missing.status, 404);
    // Proves /api also reaches our entrypoint, rather than the assets-only Worker.
    const api = await request('/api/not-a-route');
    assert.equal(api.status, 404);
    assert.deepEqual(await api.json(), { ok: false, error: 'Not found' });
  } finally {
    await server?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
