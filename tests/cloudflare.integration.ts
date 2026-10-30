// Uses real Workerd assets + local KV, never a Cloudflare account or remote data.
// Run after an Astro build, so its deployment-config redirect is present.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';
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

    // ── Cart ──────────────────────────────────────────────────────────────
    // The pricing page must render the hooks the client cart layer binds to
    // (see tests/cart-ui.test.ts for the behaviour behind them).
    const pricingHtml = await (await request('/pricing')).text();
    for (const hook of [
      'data-cart-btn',
      'data-product="launch"',
      'data-price-year="89990"',
      'data-billing-opt="year"',
      'data-cart-drawer',
      'data-cart-open',
      'data-empty-title',
    ]) {
      assert.ok(pricingHtml.includes(hook), `pricing page is missing ${hook}`);
    }
    // One-time add-ons have no yearly variant.
    assert.match(pricingHtml, /data-product="extrapage"[^>]*data-interval="one-time"/);
    const frPricingHtml = await (await request('/fr/tarifs')).text();
    for (const hook of ['data-suffix-month="/mois"', 'data-money-decimal=","', 'data-label-open="Ouvrir le panier"']) {
      assert.ok(frPricingHtml.includes(hook), `french pricing page is missing ${hook}`);
    }

    const checkoutHtml = await (await request('/checkout')).text();
    assert.ok(checkoutHtml.includes('id="checkout-items"'), 'checkout page renders the cart summary');
    assert.ok(checkoutHtml.includes('webao_cart_v1'), 'checkout page reads the cart from storage');

    const post = (body: unknown, headers: Record<string, string> = {}) =>
      request('/api/checkout/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1', ...headers },
        body: JSON.stringify(body),
      });

    // Monthly and yearly items can never share a Stripe session.
    const mixed = await post({ items: [{ key: 'launch-month' }, { key: 'grow-year' }] });
    assert.equal(mixed.status, 400);
    assert.match(String(((await mixed.json()) as { error: string }).error), /Monthly and yearly/);

    // An item Stripe cannot price must not be silently dropped.
    const unknown = await post({ items: [{ key: 'launch-month' }, { key: 'ghost-month' }] });
    assert.equal(unknown.status, 400);
    assert.match(String(((await unknown.json()) as { error: string }).error), /ghost-month/);

    const foreignOrigin = await post({ items: [{ key: 'launch-month' }] }, { origin: 'https://evil.example' });
    assert.equal(foreignOrigin.status, 403);

    // A real cart (yearly plan + yearly add-on + one-time add-on) reaches the
    // Stripe configuration gate; no secrets are configured in this environment.
    const unconfigured = await post({
      items: [{ key: 'launch-year' }, { key: 'review-year' }, { key: 'extrapage-one-time' }],
    });
    assert.equal(unconfigured.status, 503);
    assert.deepEqual(await unconfigured.json(), { ok: false, error: 'Checkout not configured' });

    // ── Tracking, forms, admin and the public files ───────────────────────
    const beacon = (path: string, body: unknown) =>
      request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1' },
        body: JSON.stringify(body),
      });

    // The tracking gate reaches the KV binding it was handed (regression: the
    // shared gate once referenced an undefined `env` and crashed every call).
    const sid = 'integration-01';
    const pageview = await beacon('/api/track/pageview', { sid, path: '/pricing', locale: 'en' });
    assert.equal(pageview.status, 200);
    assert.deepEqual(await pageview.json(), { ok: true });
    const trackedClick = await beacon('/api/track/click', { sid, path: '/pricing', kind: 'cta', label: 'Grow' });
    assert.equal(trackedClick.status, 200);
    const unknownSession = await beacon('/api/track/heartbeat', { sid: 'integration-99', path: '/pricing', durationMs: 1000 });
    assert.equal(unknownSession.status, 404, 'heartbeats need an existing session');

    // Public form submissions land in KV.
    const submission = await beacon('/api/forms/submit', {
      form: 'contact',
      fields: { name: 'Integration', email: 'integration@example.ca', message: 'bonjour' },
    });
    assert.equal(submission.status, 200);
    assert.match(String(((await submission.json()) as { id: string }).id), /^\d{13}:[0-9a-f]{16}$/);

    // The admin API is closed without a Bearer token.
    assert.equal((await request('/api/admin/stats')).status, 401);
    assert.equal((await request('/api/admin/forms')).status, 401);

    // robots.txt, the generated sitemap and the note anchors it links to.
    const robots = await request('/robots.txt');
    assert.equal(robots.status, 200);
    const robotsBody = await robots.text();
    assert.match(robotsBody, /Disallow: \/api\//);
    assert.match(robotsBody, /Sitemap: https:\/\/webao\.ca\/sitemap\.xml/);
    const sitemap = await request('/sitemap.xml');
    assert.equal(sitemap.status, 200);
    assert.match(sitemap.headers.get('content-type') ?? '', /application\/xml/);
    const sitemapBody = await sitemap.text();
    assert.match(sitemapBody, /<loc>https:\/\/webao\.ca\/fr\/tarifs\/<\/loc>/);
    assert.equal(sitemapBody.includes('boba-club'), false, 'the hidden demo stays out of the sitemap');

    const terms = await (await request('/terms')).text();
    assert.match(terms, /id="note-\d+"/);
    const pricing = await (await request('/pricing')).text();
    assert.match(pricing, /href="\/terms#note-\d+"/, 'pricing footnotes link to the terms notes');
    const frTerms = await (await request('/fr/conditions')).text();
    assert.match(frTerms, /id="note-\d+"/);
    const frTarifs = await (await request('/fr/tarifs')).text();
    assert.match(frTarifs, /href="\/fr\/conditions#note-\d+"/);

    // The build injected the immutable cache rule for hashed assets.
    const headers = readFileSync('dist/client/_headers', 'utf8');
    assert.match(headers, /\/_astro\/\*/);
    assert.match(headers, /immutable/);
  } finally {
    await server?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Closes the client loop the Worker tests cannot reach: the built checkout page
 * reads the cart written by the pricing page, renders the summary with the
 * right billing suffix, and posts the cart keys to /api/checkout/session.
 */
test('built checkout page renders the cart and posts its keys', async () => {
  const html = readFileSync('dist/client/checkout/index.html', 'utf8');
  const cart = [
    { key: 'launch-year', product: 'launch', name: 'Launch', priceCents: 89990, interval: 'year', type: 'plan' },
    { key: 'review-month', product: 'review', name: 'Review Generation Engine', priceCents: 9999, interval: 'month', type: 'addon' },
    { key: 'extrapage-one-time', product: 'extrapage', name: 'Extra Page', priceCents: 4499, interval: 'one-time', type: 'addon' },
  ];
  /** Every fetch the page makes; the tracking beacon posts to /api/track/*. */
  const requests: Array<{ url: string; body: string }> = [];
  const checkoutCalls = () => requests.filter((request) => request.url === '/api/checkout/session');

  // Customer details written by the /start form (step 1 of the funnel).
  const details = { business: '<img src=x onerror=alert(1)>', name: 'A & B', email: 'a@b.co' };

  // Run the real inline checkout script against a given cart and details.
  async function render(items: unknown[], customer: unknown = details) {
    requests.length = 0;
    const virtualConsole = new VirtualConsole();
    virtualConsole.on('jsdomError', (error: Error) => {
      if (!/Not implemented/.test(error.message)) throw error;
    });
    const dom = new JSDOM(html, {
      url: 'https://webao.ca/checkout',
      runScripts: 'dangerously',
      virtualConsole,
      beforeParse(window) {
        window.localStorage.setItem('webao_cart_v1', JSON.stringify(items));
        // Customer details from the /start form must never reach the DOM raw.
        if (customer) window.sessionStorage.setItem('webao-checkout', JSON.stringify(customer));
        // JSdom lacks a few browser APIs the layout scripts touch.
        window.matchMedia = ((query: string) => ({
          matches: false,
          media: query,
          onchange: null,
          addListener: () => {},
          removeListener: () => {},
          addEventListener: () => {},
          removeEventListener: () => {},
          dispatchEvent: () => false,
        })) as unknown as typeof window.matchMedia;
        (window as unknown as { IntersectionObserver: unknown }).IntersectionObserver = class {
          observe() {}
          unobserve() {}
          disconnect() {}
          takeRecords() {
            return [];
          }
        };
        (window as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
          observe() {}
          unobserve() {}
          disconnect() {}
        };
        // Stripe.js is an external script JSdom never loads.
        (window as unknown as { Stripe: unknown }).Stripe = () => ({
          initEmbeddedCheckout: async () => ({ mount: () => {}, unmount: () => {} }),
        });
        window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
          requests.push({ url: String(input), body: String(init?.body ?? '') });
          return new Response(JSON.stringify({ ok: true, clientSecret: 'cs_test', lineItems: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }) as typeof fetch;
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    return dom;
  }

  let dom: JSDOM | undefined;
  let empty: JSDOM | undefined;
  try {
    dom = await render(cart);
    const summary = dom.window.document.getElementById('checkout-items')?.textContent ?? '';
    assert.match(summary, /YOUR SELECTION/);
    assert.match(summary, /Launch/);
    assert.match(summary, /C\$899\.90\/yr/);
    assert.match(summary, /C\$99\.99\/mo/);
    assert.match(summary, /C\$44\.99 one-time/);
    assert.match(summary, /C\$1,044\.88/, 'total = sum of the selected items');
    const customer = dom.window.document.getElementById('checkout-customer');
    assert.ok(customer?.textContent?.includes('A & B'), 'customer details render');
    assert.ok(!customer?.innerHTML.includes('<img'), 'customer details are HTML-escaped');
    assert.ok(customer?.innerHTML.includes('&lt;img'), 'escaped markup is present');
    assert.equal(checkoutCalls().length, 1, 'exactly one checkout session is created');
    const payload = JSON.parse(checkoutCalls()[0].body);
    assert.deepEqual(payload.items, [{ key: 'launch-year' }, { key: 'review-month' }, { key: 'extrapage-one-time' }]);
    assert.equal(payload.email, 'a@b.co', 'the Stripe session is created for the customer from /start');
    assert.equal(payload.name, 'A & B');
    assert.equal(payload.locale, 'en', 'the Worker picks the success page for this locale');
  } finally {
    dom?.window.close();
  }

  let detailsMissing: JSDOM | undefined;
  try {
    // Step 1 skipped (direct hit on /checkout): no session, back to /start.
    detailsMissing = await render(cart, null);
    const message = detailsMissing.window.document.getElementById('stripe-checkout')?.textContent ?? '';
    assert.match(message, /details/i, 'explains that the details step is missing');
    assert.ok(
      detailsMissing.window.document.querySelector('#stripe-checkout a[href="/start"]'),
      'links back to the start page when the redirect cannot run',
    );
    assert.equal(checkoutCalls().length, 0, 'no Stripe session without customer details');
  } finally {
    detailsMissing?.window.close();
  }

  try {
    // An empty cart never opens a Stripe session.
    empty = await render([]);
    const message = empty.window.document.getElementById('stripe-checkout')?.textContent ?? '';
    assert.match(message, /No items in cart/);
    assert.equal(checkoutCalls().length, 0, 'an empty cart never opens a Stripe session');
  } finally {
    empty?.window.close();
  }
});

/**
 * Step 1 of the funnel against the built markup: the start page's hooks
 * (`data-start*`, plan radios, the form's data-* copy) must match what
 * `src/lib/start-ui.ts` expects, in both languages. jsdom does not run module
 * scripts, so the page's own modules are invoked on the built document.
 */
test('built start page seeds the cart and hands the details to checkout', async () => {
  const [{ initCart }, { initStart }] = await Promise.all([import('../src/lib/cart-ui'), import('../src/lib/start-ui')]);
  const pages = [
    { path: 'start/index.html', url: 'https://webao.ca/start', checkout: '/checkout', money: /C\$149\.99\/mo/ },
    { path: 'fr/commencer/index.html', url: 'https://webao.ca/fr/commencer', checkout: '/fr/checkout', money: /149,99\u00a0\$\/mois/ },
  ];
  for (const page of pages) {
    const virtualConsole = new VirtualConsole();
    virtualConsole.on('jsdomError', (error: Error) => {
      if (!/Not implemented/.test(error.message)) throw error;
    });
    const dom = new JSDOM(readFileSync(`dist/client/${page.path}`, 'utf8'), { url: page.url, virtualConsole });
    try {
      const { window } = dom;
      const doc = window.document;
      const requests: string[] = [];
      const navigations: string[] = [];
      window.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(String(init?.body ?? ''));
        return new Response('{"ok":true}', { status: 200 });
      }) as typeof fetch;
      initCart(doc);
      initStart(doc, { navigate: (href) => navigations.push(href) });

      // An empty cart is seeded with Grow, mirrored by the plan radios and the layout's badge.
      assert.deepEqual(JSON.parse(window.localStorage.getItem('webao_cart_v1') ?? '[]').map((i: { key: string }) => i.key), ['grow-month']);
      const grow = doc.querySelector<HTMLInputElement>('input[name="plan"][value="grow"]');
      assert.equal(grow?.checked, true, `${page.path}: Grow pre-selected`);
      assert.match(grow?.closest('label')?.querySelector('[data-plan-price]')?.textContent ?? '', page.money);
      assert.equal(doc.querySelector('[data-cart-count]')?.textContent, '1');
      assert.equal(doc.querySelector<HTMLElement>('[data-start-default-note]')?.hidden, false);

      // Empty form: localized field errors from the markup, no hand-off.
      const form = doc.querySelector<HTMLFormElement>('form[data-start-form]')!;
      form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
      for (const field of ['name', 'email', 'business']) {
        const error = form.querySelector<HTMLElement>(`[data-error="${field}"]`);
        assert.equal(error?.hidden, false, `${page.path}: ${field} error shown`);
        assert.ok((error?.textContent ?? '').length > 0, `${page.path}: ${field} error has copy`);
      }
      assert.equal(navigations.length, 0);

      // Valid details: stored for /checkout, owner notified, visitor sent on.
      (form.elements.namedItem('name') as HTMLInputElement).value = 'Ada Lovelace';
      (form.elements.namedItem('email') as HTMLInputElement).value = 'ada@example.com';
      (form.elements.namedItem('business') as HTMLInputElement).value = 'Analytical Engines';
      form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
      assert.deepEqual(JSON.parse(window.sessionStorage.getItem('webao-checkout') ?? 'null'), {
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        business: 'Analytical Engines',
      });
      assert.deepEqual(navigations, [page.checkout]);
      assert.equal(requests.length, 1);
      assert.equal(JSON.parse(requests[0]).form, 'pricing', 'the Worker only accepts pricing/contact forms');
    } finally {
      dom.window.close();
    }
  }
});

/**
 * SEO sweep over the built HTML: canonical + hreflang on every page type,
 * Open Graph/Twitter cards with image dimensions, explicit robots directives,
 * per-page JSON-LD, and the demo pages indexable (except the hidden one).
 * These are head-only tags — the visible markup is covered by the other tests.
 */
test('built pages carry the full SEO head', () => {
  const read = (path: string) => readFileSync(`dist/client/${path}`, 'utf8');
  const head = (path: string) => read(path).slice(0, read(path).indexOf('</head>'));

  // ── Main site pages ────────────────────────────────────────────────────
  const home = head('index.html');
  assert.match(home, /<link rel="canonical" href="https:\/\/webao\.ca\/">/);
  for (const hreflang of ['en', 'fr', 'x-default']) {
    assert.match(home, new RegExp(`<link rel="alternate" hreflang="${hreflang}" href="https://webao\\.ca/`));
  }
  assert.match(home, /<meta name="robots" content="index, follow, max-image-preview:large/);
  assert.match(home, /<meta property="og:image" content="https:\/\/webao\.ca\/og-image\.jpg">/);
  assert.match(home, /<meta property="og:image:width" content="701">/);
  assert.match(home, /<meta property="og:image:height" content="292">/);
  assert.match(home, /<meta property="og:image:type" content="image\/jpeg">/);
  assert.match(home, /<meta name="twitter:image:alt" content="[^"]+">/);
  assert.match(home, /<meta property="og:locale" content="en_CA">/);
  assert.match(home, /<meta property="og:locale:alternate" content="fr_CA">/);
  // Structured data: Organization, WebSite and the FAQ rich snippet.
  for (const type of ['"@type":"Organization"', '"@type":"WebSite"', '"@type":"FAQPage"']) {
    assert.ok(home.includes(type), `home has ${type}`);
  }
  assert.match(home, /"@type":"Question"/);
  assert.match(home, /"@type":"Answer"/);

  const frHome = head('fr/index.html');
  assert.match(frHome, /<link rel="canonical" href="https:\/\/webao\.ca\/fr\/">/);
  assert.match(frHome, /<meta property="og:locale" content="fr_CA">/);
  assert.match(frHome, /<html lang="fr-CA"[\s>]/);

  // Pricing: Product + Offers with canonical (trailing-slash) URLs.
  const pricing = head('pricing/index.html');
  assert.match(pricing, /"@type":"Product"/);
  assert.equal(pricing.match(/"@type":"Offer"/g)?.length, 3, 'three plan offers');
  assert.ok(pricing.includes('"url":"https://webao.ca/pricing/"'), 'offer urls match the canonical');
  assert.match(pricing, /"@type":"BreadcrumbList"/);

  // Demos catalog: ItemList of the visible demos.
  const catalog = head('demos/index.html');
  assert.match(catalog, /"@type":"ItemList"/);
  assert.match(catalog, /"numberOfItems":43/);

  // Sources: breadcrumb wired through the new pageKey.
  const sources = head('sources/index.html');
  assert.ok(sources.includes('"name":"Sources"'), 'sources breadcrumb label');

  // ── Demo microsites ───────────────────────────────────────────────────
  const demo = head('demos/aeris/index.html');
  assert.match(demo, /<meta name="robots" content="index, follow, max-image-preview:large">/);
  assert.match(demo, /<link rel="canonical" href="https:\/\/webao\.ca\/demos\/aeris\/">/);
  assert.match(demo, /<link rel="alternate" hreflang="fr" href="https:\/\/webao\.ca\/fr\/demos\/aeris\/">/);
  assert.match(demo, /<link rel="alternate" hreflang="x-default" href="https:\/\/webao\.ca\/demos\/aeris\/">/);
  assert.match(demo, /<meta property="og:image" content="https:\/\/webao\.ca\/demos\/aeris\/01\.jpg">/);
  assert.match(demo, /<meta property="og:site_name" content="WEBAO">/);
  assert.match(demo, /<meta name="twitter:card" content="summary_large_image">/);
  assert.match(demo, /"@type":"WebPage"/);
  assert.match(demo, /"@type":"BreadcrumbList"/);
  assert.match(demo, /"inLanguage":"en-CA"/);

  const frDemo = head('fr/demos/aeris/index.html');
  assert.match(frDemo, /<link rel="canonical" href="https:\/\/webao\.ca\/fr\/demos\/aeris\/">/);
  assert.match(frDemo, /<meta property="og:locale" content="fr_CA">/);
  assert.match(frDemo, /"inLanguage":"fr-CA"/);

  // The hidden demo stays out of the index; utility pages stay noindex.
  assert.match(head('demos/boba-club/index.html'), /<meta name="robots" content="noindex, nofollow">/);
  for (const path of ['admin/index.html', 'checkout/index.html', '404.html']) {
    assert.match(head(path), /<meta name="robots" content="noindex, nofollow">/, `${path} is noindex`);
  }

  // The hero image is the LCP candidate: eager + high priority; the rest lazy.
  const demoBody = read('demos/aeris/index.html');
  assert.match(demoBody, /<img[^>]*fetchpriority="high"[^>]*decoding="async"/);
  assert.match(demoBody, /<img[^>]*loading="lazy"[^>]*decoding="async"/);

  // ── Sitemap + robots ───────────────────────────────────────────────────
  const sitemap = read('sitemap.xml');
  assert.match(sitemap, /xmlns:image="http:\/\/www\.google\.com\/schemas\/sitemap-image\/1\.1"/);
  assert.ok((sitemap.match(/<image:image>/g) ?? []).length > 0, 'image sitemap entries present');
  const robots = read('robots.txt');
  assert.match(robots, /Disallow: \/demos\/boba-club/);
  assert.match(robots, /Disallow: \/admin/);
});

/**
 * The success page confirms what was actually purchased: it reads the cart
 * while the document parses (before the layout's cart module empties it via
 * data-cart-clear) and renders the selection + total. The legacy /start flow
 * has no cart and keeps the fixed $149 message.
 */
test('built success page shows the purchased selection', async () => {
  const cart = [
    { key: 'launch-year', product: 'launch', name: 'Launch', priceCents: 89990, interval: 'year', type: 'plan' },
    { key: 'review-month', product: 'review', name: 'Review Generation Engine', priceCents: 9999, interval: 'month', type: 'addon' },
    { key: 'extrapage-one-time', product: 'extrapage', name: 'Extra Page', priceCents: 4499, interval: 'one-time', type: 'addon' },
  ];
  const render = async (path: string, items: unknown[]) => {
    const html = readFileSync(`dist/client/${path}`, 'utf8');
    const virtualConsole = new VirtualConsole();
    virtualConsole.on('jsdomError', (error: Error) => {
      if (!/Not implemented/.test(error.message)) throw error;
    });
    const dom = new JSDOM(html, {
      url: `https://webao.ca/${path.replace('index.html', '')}?session_id=cs_test_123`,
      runScripts: 'dangerously',
      virtualConsole,
      beforeParse(window) {
        window.localStorage.setItem('webao_cart_v1', JSON.stringify(items));
        window.matchMedia = ((query: string) => ({
          matches: false,
          media: query,
          onchange: null,
          addListener: () => {},
          removeListener: () => {},
          addEventListener: () => {},
          removeEventListener: () => {},
          dispatchEvent: () => false,
        })) as unknown as typeof window.matchMedia;
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    return dom;
  };

  // Cart flow: the summary lists the items and the real total.
  let dom = await render('checkout/success/index.html', cart);
  try {
    const doc = dom.window.document;
    const summary = doc.getElementById('order-summary');
    assert.equal(summary?.hidden, false, 'order summary is visible');
    const text = summary?.textContent ?? '';
    assert.match(text, /Launch/);
    assert.match(text, /Review Generation Engine/);
    assert.match(text, /Extra Page/);
    assert.match(text, /C\$899\.90\/yr/);
    assert.match(text, /C\$99\.99\/mo/);
    assert.match(text, /C\$44\.99 one-time/);
    assert.match(text, /C\$1,044\.88/, 'total = sum of the purchased items');
    const copy = doc.getElementById('success-copy')?.textContent ?? '';
    assert.match(copy, /payment is confirmed/);
    assert.ok(!copy.includes('$149'), 'no hardcoded $149 for cart checkouts');
  } finally {
    dom?.window.close();
  }

  // French page: localized money and copy.
  dom = await render('fr/checkout/success/index.html', cart);
  try {
    const doc = dom.window.document;
    const text = doc.getElementById('order-summary')?.textContent ?? '';
    assert.match(text, /899,90\u00a0\$/, 'French money format (no-break space)');
    assert.match(text, /\/an/, 'French yearly suffix');
    assert.match(text, /044,88/, 'French thousands separator');
    const copy = doc.getElementById('success-copy')?.textContent ?? '';
    assert.match(copy, /paiement est confirmé/);
    assert.ok(!copy.includes('149 $'), 'no hardcoded 149 $ for cart checkouts');
  } finally {
    dom?.window.close();
  }

  // No cart (direct visit, storage unavailable): generic copy, no summary and
  // no made-up amount — every flow goes through the cart now.
  dom = await render('checkout/success/index.html', []);
  try {
    const doc = dom.window.document;
    assert.equal(doc.getElementById('order-summary')?.hidden, true, 'no summary without a cart');
    const copy = doc.getElementById('success-copy')?.textContent ?? '';
    assert.match(copy, /Your subscription is active/);
    assert.ok(!copy.includes('$149'), 'no hardcoded $149 without a cart');
  } finally {
    dom?.window.close();
  }
});

// Audit built-output pins (this file runs after `npm run build`, so dist
// is fresh): the duplicate cart-clip id is gone, the portal fieldset
// overflow guard and the new AA button/offer tokens shipped.
test('audit built output: no cart-clip id, portal fieldset guard, AA tokens', () => {
  const htmlFiles = readdirSync('dist/client', { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.html'))
    .map((e) => join((e.parentPath ?? (e as unknown as { path: string }).path), e.name));
  assert.ok(htmlFiles.length > 100, `expected the full site build, got ${htmlFiles.length} pages`);
  for (const file of htmlFiles) {
    assert.ok(!readFileSync(file, 'utf-8').includes('id="cart-clip"'), `duplicate cart-clip id in ${file}`);
  }
  const css = readdirSync('dist/client/_astro')
    .filter((n) => n.endsWith('.css'))
    .map((n) => readFileSync(join('dist/client/_astro', n), 'utf-8'))
    .join('\n');
  assert.ok(css.includes('--btn-primary-bg:#c62820'), 'light AA primary button token present');
  assert.ok(css.includes('--offer-panel-bg:#a81e14'), 'light AA offer panel token present');
  // Portal styles are inlined into the page by Astro, not bundled: the
  // fieldset guard lives in the portal HTML style blocks, EN + FR.
  for (const page of ['dist/client/portal/index.html', 'dist/client/fr/portail/index.html']) {
    const html = readFileSync(page, 'utf-8');
    assert.ok(
      html.split('}').some((rule) => rule.includes('data-portal-root') && /fieldset[^{]*\{[^}]*min-width:0/.test(rule + '}')),
      `portal fieldset min-width guard present in ${page}`,
    );
  }
});
