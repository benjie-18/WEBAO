// Free audit funnel: scoring, basic checks, audit/report endpoints,
// rate limit, and result lookup. PageSpeed is not stubbed here: with no
// PAGESPEED_API_KEY in env the handler takes the hand-rolled fallback
// path, and the homepage fetch is stubbed per test.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  handleAudit,
  handleAuditFull,
  handleAuditGet,
  handleAuditReport,
  normalizeAuditUrl,
  provisionalScore,
  runBasicChecks,
  scoreFromCategories,
  type AuditRecord,
} from '../worker/audit';
import { apiGet, apiRequest, bodyOf, envOf, memoryKV } from './helpers';
import { putJson } from '../worker/kv';

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

test('provisionalScore is a weighted random draw, 0–60, biased toward the top', () => {
  assert.equal(provisionalScore(0), 0); // a site with nothing passing caps at 0
  const draws: number[] = [];
  for (let i = 0; i < 500; i++) draws.push(provisionalScore(100));
  assert.ok(draws.every((d) => d >= 0 && d <= 60));
  assert.ok(new Set(draws).size > 10); // varies, never a fixed number
  const mean = draws.reduce((a, b) => a + b, 0) / draws.length;
  assert.ok(mean >= 30 && mean <= 50); // weighted toward 40–60, mean ~40
});

test('POST /api/audit accepts a bare domain and stores the normalized URL', async () => {
  const restore = stubHomepage(GOOD_HTML);
  try {
    const memory = memoryKV();
    const env = envOf(memory.kv);
    const res = await handleAudit(apiRequest('/api/audit', { url: 'example.com', lang: 'en' }), env);
    assert.equal(res.status, 200);
    const data = await bodyOf(res) as { ok: boolean; id: string; url: string; score: number; partial: boolean; pending: boolean };
    assert.equal(data.ok, true);
    assert.equal(data.url, 'https://example.com');
    assert.ok(data.score >= 0 && data.score <= 60); // weighted random initial estimate
    assert.equal(data.partial, true);
    assert.equal(data.pending, true);
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
    const data = await bodyOf(res) as { ok: boolean; id: string; score: number; resultUrl: string; partial: boolean; pending: boolean };
    assert.equal(data.ok, true);
    assert.ok(data.score >= 0 && data.score <= 60); // weighted random initial estimate
    assert.equal(data.partial, true); // no PageSpeed call on the first pass
    assert.equal(data.pending, true);
    assert.equal(data.resultUrl, `/audits/${data.id}`);
    const stored = await kv.get(`audit:${data.id}`, { type: 'json' }) as AuditRecord | null;
    assert.ok(stored);
    assert.equal(stored.url, 'https://example.com/');
    assert.ok(stored.score >= 0 && stored.score <= 60);
    assert.equal(stored.pending, true);
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
    const data = await bodyOf(res) as { ok: boolean; id: string; resultUrl: string; pending: boolean };
    assert.equal(data.ok, true);
    assert.equal(data.resultUrl, `/fr/audits/${data.id}`);
    assert.equal(data.pending, true);
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
  const data = await bodyOf(res) as { ok: boolean; score: number; partial: boolean; pending: boolean };
  assert.equal(data.ok, true);
  assert.ok(data.score >= 0 && data.score <= 60); // weighted random initial estimate
  assert.equal(data.partial, true);
  assert.equal(data.pending, true);
});

test('POST /api/audit/:id/full fills the record from PageSpeed and drops passing checks', async () => {
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
        'largest-contentful-paint': { title: 'Largest Contentful Paint', displayValue: '7.2 s', score: 0.5 },
        'cumulative-layout-shift': { title: 'Cumulative Layout Shift', displayValue: '0', score: 1 },
        'first-contentful-paint': { title: 'First Contentful Paint', displayValue: '1.7 s', score: 0.9 },
        'total-blocking-time': { title: 'Total Blocking Time', displayValue: '0 ms', score: 1 },
        'speed-index': { title: 'Speed Index', displayValue: '2.1 s', score: 0.8 },
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
    const kv = memory.kv;
    const env = envOf(memory.kv, { PAGESPEED_API_KEY: 'test-key' });
    const first = await handleAudit(apiRequest('/api/audit', { url: 'https://example.com/', lang: 'en' }), env);
    assert.equal(first.status, 200);
    const created = await bodyOf(first) as { id: string; score: number; pending: boolean };
    assert.ok(created.score >= 0 && created.score <= 60); // weighted random initial estimate first
    assert.equal(created.pending, true);
    const res = await handleAuditFull(
      apiRequest(`/api/audit/${encodeURIComponent(created.id)}/full`, {}),
      env,
      `/api/audit/${created.id}/full`,
    );
    assert.equal(res.status, 200);
    const data = await bodyOf(res) as { ok: boolean; audit: AuditRecord };
    assert.equal(data.ok, true);
    assert.equal(data.audit.score, 91);
    assert.equal(data.audit.partial, false);
    assert.equal(data.audit.pending, false);
    assert.ok(data.audit.findings.some((f) => f.includes('Reduce unused JavaScript')));
    assert.ok(!data.audit.findings.some((f) => f.includes('server response')));
    assert.equal(data.audit.metrics.lcp, '7.2 s');
    assert.equal(data.audit.metrics.cls, '0');
    assert.equal(data.audit.metrics.fcp, '1.7 s');
    assert.equal(data.audit.metrics.tbt, '0 ms');
    assert.equal(data.audit.metrics.speed, '2.1 s');
    const stored = await kv.get(`audit:${created.id}`, { type: 'json' }) as AuditRecord | null;
    assert.ok(stored);
    assert.equal(stored.score, 91);
    assert.equal(stored.pending, false);
    // A second full call is a no-op once the record is complete.
    const again = await handleAuditFull(
      apiRequest(`/api/audit/${encodeURIComponent(created.id)}/full`, {}),
      env,
      `/api/audit/${created.id}/full`,
    );
    assert.equal(again.status, 200);
    const againData = await bodyOf(again) as { ok: boolean; audit: AuditRecord };
    assert.equal(againData.audit.score, 91);
  } finally {
    globalThis.fetch = original;
  }
});

test('full audit with no opportunities falls back to the slowest metric', async () => {
  const psiPayload = {
    lighthouseResult: {
      categories: {
        performance: { score: 0.75 },
        accessibility: { score: 1 },
        'best-practices': { score: 0.96 },
        seo: { score: 1 },
      },
      audits: {
        'largest-contentful-paint': { title: 'Largest Contentful Paint', displayValue: '7.8 s', score: 0.5 },
        'cumulative-layout-shift': { title: 'Cumulative Layout Shift', displayValue: '0', score: 1 },
        'first-contentful-paint': { title: 'First Contentful Paint', displayValue: '1.7 s', score: 0.9 },
        'total-blocking-time': { title: 'Total Blocking Time', displayValue: '0 ms', score: 1 },
        'speed-index': { title: 'Speed Index', displayValue: '1.8 s', score: 0.8 },
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
    const first = await handleAudit(apiRequest('/api/audit', { url: 'https://example.com/', lang: 'en' }), env);
    const created = await bodyOf(first) as { id: string };
    const res = await handleAuditFull(
      apiRequest(`/api/audit/${encodeURIComponent(created.id)}/full`, {}),
      env,
      `/api/audit/${created.id}/full`,
    );
    assert.equal(res.status, 200);
    const data = await bodyOf(res) as { audit: AuditRecord };
    assert.equal(data.audit.score, 87); // 0.75*0.5 + 1*0.2 + 0.96*0.15 + 1*0.15 = 0.869
    assert.equal(data.audit.partial, false);
    assert.equal(data.audit.pending, false);
    // No opportunities, but performance is mediocre and LCP is slow:
    // the card must flag the slow paint instead of saying nothing
    // is wrong.
    assert.ok(data.audit.findings.some((f) => f.includes('Largest Contentful Paint')));
    assert.ok(data.audit.findings.some((f) => f.includes('7.8 s')));
    assert.ok(!data.audit.findings.some((f) => f.includes('No major problems')));
  } finally {
    globalThis.fetch = original;
  }
});

test('POST /api/audit/:id/full returns 404 for an unknown id', async () => {
  const memory = memoryKV();
  const env = envOf(memory.kv, { PAGESPEED_API_KEY: 'test-key' });
  const res = await handleAuditFull(
    apiRequest('/api/audit/1%3Anope/full', {}),
    env,
    '/api/audit/1%3Anope/full',
  );
  assert.equal(res.status, 404);
});

test('POST /api/audit/:id/full returns running when a run is already in flight', async () => {
  const memory = memoryKV();
  const kv = memory.kv;
  const env = envOf(memory.kv, { PAGESPEED_API_KEY: 'test-key' });
  const restore = stubHomepage(GOOD_HTML);
  try {
    const first = await handleAudit(apiRequest('/api/audit', { url: 'https://example.com/', lang: 'en' }), env);
    const created = await bodyOf(first) as { id: string };
    await putJson(kv, `audit:full:${created.id}`, '1', 180);
    const res = await handleAuditFull(
      apiRequest(`/api/audit/${encodeURIComponent(created.id)}/full`, {}),
      env,
      `/api/audit/${created.id}/full`,
    );
    assert.equal(res.status, 200);
    const data = await bodyOf(res) as { ok: boolean; running: boolean };
    assert.equal(data.ok, true);
    assert.equal(data.running, true);
  } finally {
    restore();
  }
});

test('POST /api/audit/:id/full keeps the initial estimate when PageSpeed fails', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes('pagespeedonline')) {
      return { ok: false, status: 500, json: async () => ({}) } as unknown as Response;
    }
    return { ok: true, status: 200, url: 'https://example.com/', text: async () => GOOD_HTML } as unknown as Response;
  }) as typeof fetch;
  try {
    const memory = memoryKV();
    const kv = memory.kv;
    const env = envOf(memory.kv, { PAGESPEED_API_KEY: 'test-key' });
    const first = await handleAudit(apiRequest('/api/audit', { url: 'https://example.com/', lang: 'en' }), env);
    const created = await bodyOf(first) as { id: string; score: number };
    assert.ok(created.score >= 0 && created.score <= 60);
    const res = await handleAuditFull(
      apiRequest(`/api/audit/${encodeURIComponent(created.id)}/full`, {}),
      env,
      `/api/audit/${created.id}/full`,
    );
    assert.equal(res.status, 200);
    const data = await bodyOf(res) as { ok: boolean; audit: AuditRecord };
    assert.equal(data.ok, true);
    assert.equal(data.audit.score, created.score); // initial estimate stands
    assert.equal(data.audit.partial, true);
    assert.equal(data.audit.pending, false); // stops waiting
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
    metrics: {},
    partial: false,
    pending: false,
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
    metrics: {},
    partial: false,
    pending: false,
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
