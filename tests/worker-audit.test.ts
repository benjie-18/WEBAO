// Free audit funnel: scoring, basic checks, audit/report endpoints,
// rate limit, and result lookup. PageSpeed is not stubbed here: with no
// PAGESPEED_API_KEY in env the handler takes the hand-rolled fallback
// path, and the homepage fetch is stubbed per test.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  handleAudit,
  handleAuditGet,
  handleAuditReport,
  normalizeAuditUrl,
  runBasicChecks,
  scoreFromCategories,
  type AuditRecord,
} from '../worker/audit';
import { apiGet, apiRequest, bodyOf, envOf, memoryKV } from './helpers';

const GOOD_HTML =
  '<!doctype html><html><head><title>Example Plumbing</title>' +
  '<meta name="description" content="Plumber in Montreal.">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1">' +
  '</head><body><footer>© 2026 Example Plumbing</footer></body></html>';

function stubHomepage(html: string, finalUrl = 'https://example.com/'): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    return {
      ok: true,
      status: 200,
      url: finalUrl,
      text: async () => html,
    } as unknown as Response;
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

test('scoreFromCategories weights performance most and renormalizes', () => {
  assert.equal(
    scoreFromCategories({ performance: 0.7, accessibility: 0.9, 'best-practices': 1.0, seo: 0.8 }),
    80,
  );
  assert.equal(scoreFromCategories({ performance: 0.8 }), 80);
  assert.equal(scoreFromCategories({}), 0);
  assert.equal(
    scoreFromCategories({ performance: 1, accessibility: 1, 'best-practices': 1, seo: 1 }),
    100,
  );
});

test('runBasicChecks scores a good page 100 and deducts for missing basics', () => {
  const good = runBasicChecks(GOOD_HTML, 'https://example.com/', 1200, 'en');
  assert.equal(good.score, 100);
  assert.equal(good.findings.length, 1);

  const bad = runBasicChecks(
    '<html><head></head><body><footer>© 2019 Old Site</footer></body></html>',
    'http://example.com/',
    4000,
    'en',
  );
  // -20 http, -15 title, -10 description, -15 viewport, -10 old year, -10 slow
  assert.equal(bad.score, 20);
  assert.ok(bad.findings.some((f) => f.includes('HTTPS')));
  assert.ok(bad.findings.some((f) => f.includes('2019')));
});

test('runBasicChecks renders findings in French', () => {
  const bad = runBasicChecks('<html><head></head><body></body></html>', 'http://example.com/', 100, 'fr');
  assert.ok(bad.findings.some((f) => f.includes('HTTPS')));
  assert.ok(!bad.findings.some((f) => f.includes('does not use')));
});

test('POST /api/audit rejects bad input', async () => {
  const memory = memoryKV();
  const kv = memory.kv;
  const env = envOf(kv);
  const invalid = await handleAudit(apiRequest('/api/audit', null, { body: 'not json{' }), env);
  assert.equal(invalid.status, 400);
  const noUrl = await handleAudit(apiRequest('/api/audit', {}), env);
  assert.equal(noUrl.status, 400);
  const local = await handleAudit(apiRequest('/api/audit', { url: 'http://localhost:3000/' }), env);
  assert.equal(local.status, 400);
  const privateIp = await handleAudit(apiRequest('/api/audit', { url: 'http://192.168.1.1/' }), env);
  assert.equal(privateIp.status, 400);
});

test('normalizeAuditUrl accepts bare domains and keeps explicit schemes', () => {
  assert.equal(normalizeAuditUrl('webao.ca'), 'https://webao.ca');
  assert.equal(normalizeAuditUrl('www.webao.ca'), 'https://www.webao.ca');
  assert.equal(normalizeAuditUrl('webao.ca/pricing?x=1'), 'https://webao.ca/pricing?x=1');
  assert.equal(normalizeAuditUrl('//webao.ca'), 'https://webao.ca');
  assert.equal(normalizeAuditUrl('https://webao.ca'), 'https://webao.ca');
  assert.equal(normalizeAuditUrl('http://example.com'), 'http://example.com');
  assert.equal(normalizeAuditUrl('  webao.ca  '), 'https://webao.ca');
  assert.equal(normalizeAuditUrl(''), null);
  assert.equal(normalizeAuditUrl('   '), null);
  assert.equal(normalizeAuditUrl('localhost'), null);
  assert.equal(normalizeAuditUrl('192.168.1.1'), null);
  assert.equal(normalizeAuditUrl('ftp://example.com'), null);
  assert.equal(normalizeAuditUrl('https://user:pass@example.com'), null);
});

test('POST /api/audit accepts a bare domain and stores the normalized URL', async () => {
  const restore = stubHomepage(GOOD_HTML);
  try {
    const memory = memoryKV();
    const env = envOf(memory.kv);
    const res = await handleAudit(apiRequest('/api/audit', { url: 'example.com', lang: 'en' }), env);
    assert.equal(res.status, 200);
    const data = await bodyOf(res) as { ok: boolean; id: string; url: string; score: number; partial: boolean };
    assert.equal(data.ok, true);
    assert.equal(data.url, 'https://example.com');
    assert.equal(data.score, 100);
    assert.equal(data.partial, true);
    const stored = await memory.kv.get(`audit:${data.id}`, { type: 'json' }) as AuditRecord | null;
    assert.ok(stored);
    assert.equal(stored.url, 'https://example.com');
  } finally {
    restore();
  }
});

test('POST /api/audit scores a good page and stores the result', async () => {
  const memory = memoryKV();
  const kv = memory.kv;
  const env = envOf(kv);
  const restore = stubHomepage(GOOD_HTML);
  try {
    const res = await handleAudit(apiRequest('/api/audit', { url: 'https://example.com/', lang: 'en' }), env);
    assert.equal(res.status, 200);
    const data = await bodyOf(res) as { ok: boolean; id: string; score: number; resultUrl: string; partial: boolean };
    assert.equal(data.ok, true);
    assert.equal(data.score, 100);
    assert.equal(data.partial, true); // no PageSpeed key, fallback path
    assert.equal(data.resultUrl, `/audits/${data.id}`);
    const stored = await kv.get(`audit:${data.id}`, { type: 'json' }) as AuditRecord | null;
    assert.ok(stored);
    assert.equal(stored.url, 'https://example.com/');
    assert.equal(stored.score, 100);
    const index = await kv.get('audit:index', { type: 'json' }) as string[] | null;
    assert.deepEqual(index, [`audit:${data.id}`]);
  } finally {
    restore();
  }
});

test('POST /api/audit returns the French results URL for a French audit', async () => {
  const memory = memoryKV();
  const kv = memory.kv;
  const env = envOf(kv);
  const restore = stubHomepage(GOOD_HTML);
  try {
    const res = await handleAudit(apiRequest('/api/audit', { url: 'https://example.com/', lang: 'fr' }), env);
    assert.equal(res.status, 200);
    const data = await bodyOf(res) as { ok: boolean; id: string; resultUrl: string };
    assert.equal(data.ok, true);
    assert.equal(data.resultUrl, `/fr/audits/${data.id}`);
    const stored = await kv.get(`audit:${data.id}`, { type: 'json' }) as AuditRecord | null;
    assert.ok(stored);
    assert.equal(stored.lang, 'fr');
  } finally {
    restore();
  }
});

test('POST /api/audit serves our own site from ASSETS, not the network', async () => {
  // A Worker cannot fetch its own origin: the subrequest routes back into
  // this worker and never returns, so the fallback must use env.ASSETS.
  const memory = memoryKV();
  const assets = {
    fetch: async () => new Response(GOOD_HTML, { status: 200, headers: { 'content-type': 'text/html' } }),
  };
  const env = envOf(memory.kv, { ASSETS: assets });
  const res = await handleAudit(apiRequest('/api/audit', { url: 'https://webao.ca/', lang: 'en' }), env);
  assert.equal(res.status, 200);
  const data = await bodyOf(res) as { ok: boolean; score: number; partial: boolean };
  assert.equal(data.ok, true);
  assert.equal(data.score, 100);
  assert.equal(data.partial, true); // no PageSpeed key, fallback path
});

test('POST /api/audit via PageSpeed drops passing checks from findings', async () => {
  const psiPayload = {
    lighthouseResult: {
      categories: {
        performance: { score: 0.85 },
        accessibility: { score: 1 },
        'best-practices': { score: 0.92 },
        seo: { score: 1 },
      },
      audits: {
        'server-response-time': {
          title: 'Initial server response time was short',
          displayValue: 'Root document took 0 ms',
          score: 1,
          details: { type: 'opportunity' },
        },
        'unused-javascript': {
          title: 'Reduce unused JavaScript',
          displayValue: 'Est savings of 559 KiB',
          score: 0.5,
          details: { type: 'opportunity' },
        },
      },
    },
  };
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes('pagespeedonline')) {
      return { ok: true, status: 200, json: async () => psiPayload } as unknown as Response;
    }
    return { ok: true, status: 200, url: 'https://example.com/', text: async () => GOOD_HTML } as unknown as Response;
  }) as typeof fetch;
  try {
    const memory = memoryKV();
    const env = envOf(memory.kv, { PAGESPEED_API_KEY: 'test-key' });
    const res = await handleAudit(apiRequest('/api/audit', { url: 'https://example.com/', lang: 'en' }), env);
    assert.equal(res.status, 200);
    const data = await bodyOf(res) as { score: number; findings: string[]; partial: boolean };
    assert.equal(data.score, 91);
    assert.equal(data.partial, false);
    assert.ok(data.findings.some((f) => f.includes('Reduce unused JavaScript')));
    assert.ok(!data.findings.some((f) => f.includes('server response')));
  } finally {
    globalThis.fetch = original;
  }
});

test('POST /api/audit rate-limits at 5 per IP per hour', async () => {
  const memory = memoryKV();
  const kv = memory.kv;
  const env = envOf(kv);
  const restore = stubHomepage(GOOD_HTML);
  try {
    for (let i = 0; i < 5; i++) {
      const res = await handleAudit(
        apiRequest('/api/audit', { url: 'https://example.com/' }, { ip: '203.0.113.77' }),
        env,
      );
      assert.equal(res.status, 200);
    }
    const sixth = await handleAudit(
      apiRequest('/api/audit', { url: 'https://example.com/' }, { ip: '203.0.113.77' }),
      env,
    );
    assert.equal(sixth.status, 429);
  } finally {
    restore();
  }
});

test('GET /api/audit/:id returns a stored audit, 404 when missing', async () => {
  const record: AuditRecord = {
    id: '1762456789000:abc123',
    url: 'https://example.com/',
    score: 82,
    findings: ['Slow to load.'],
    strengths: [],
    categories: { performance: 0.8 },
    partial: false,
    lang: 'en',
    at: 1762456789000,
  };
  const memory = memoryKV({ [`audit:${record.id}`]: record });
  const kv = memory.kv;
  const env = envOf(kv);
  const res = await handleAuditGet(
    apiGet('/api/audit/1762456789000%3Aabc123'),
    env,
    '/api/audit/1762456789000%3Aabc123',
  );
  assert.equal(res.status, 200);
  const data = await bodyOf(res) as { ok: boolean; audit: AuditRecord };
  assert.equal(data.audit.score, 82);
  const missing = await handleAuditGet(
    apiGet('/api/audit/1%3Anope'),
    env,
    '/api/audit/1%3Anope',
  );
  assert.equal(missing.status, 404);
});

test('POST /api/audit/report attaches the email to the audit', async () => {
  const record: AuditRecord = {
    id: '1762456789000:abc123',
    url: 'https://example.com/',
    score: 82,
    findings: ['Slow to load.'],
    strengths: [],
    categories: { performance: 0.8 },
    partial: false,
    lang: 'en',
    at: 1762456789000,
  };
  const memory = memoryKV({ [`audit:${record.id}`]: record });
  const kv = memory.kv;
  const env = envOf(kv);
  const badEmail = await handleAuditReport(
    apiRequest('/api/audit/report', { id: record.id, email: 'not-an-email' }),
    env,
  );
  assert.equal(badEmail.status, 400);
  const unknown = await handleAuditReport(
    apiRequest('/api/audit/report', { id: '1%3Anope', email: 'a@b.com' }),
    env,
  );
  assert.equal(unknown.status, 404);
  const ok = await handleAuditReport(
    apiRequest('/api/audit/report', { id: record.id, email: 'owner@example.com' }),
    env,
  );
  assert.equal(ok.status, 200);
  const stored = await kv.get(`audit:${record.id}`, { type: 'json' }) as AuditRecord | null;
  assert.equal(stored?.email, 'owner@example.com');
  assert.ok(stored?.reportRequestedAt);
});
