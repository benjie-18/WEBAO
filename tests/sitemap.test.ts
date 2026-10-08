// Sitemap and robots.txt: every indexable page is listed once with correct
// hreflang alternates, hidden demos stay hidden, and every sitemap URL maps
// back to a real page file.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { demos } from '../src/lib/demos';
import { HIDDEN_DEMOS, localHeroFor } from '../src/lib/demo-seo';
import { GET } from '../src/pages/sitemap.xml.ts';

const SITE = 'https://webao.ca';

async function sitemap() {
  const response = await (GET as unknown as (context: unknown) => Response | Promise<Response>)({});
  const body = await response.text();
  return { response, body, locs: [...body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]) };
}

/** Resolve a sitemap URL back to the Astro page file that renders it. */
function sourceFor(loc: string): string | undefined {
  const path = loc.replace(SITE, '').replace(/\/$/, '') || '/';
  const candidates =
    path === '/'
      ? ['src/pages/index.astro']
      : [`src/pages${path}.astro`, `src/pages${path}/index.astro`];
  return candidates.find((candidate) => existsSync(candidate));
}

test('the sitemap is served as cacheable XML', async () => {
  const { response, body } = await sitemap();
  assert.equal(response.headers.get('content-type'), 'application/xml; charset=utf-8');
  assert.equal(response.headers.get('cache-control'), 'public, max-age=3600');
  assert.match(body, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(body, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9"/);
  assert.match(body, new RegExp(`<lastmod>${new Date().toISOString().slice(0, 10)}</lastmod>`));
});

test('the sitemap lists every locale page, the standalone pages and every visible demo', async () => {
  const { locs } = await sitemap();
  const expected =
    7 * 2 + // home, pricing, contact, demos, start, terms, refunds × en/fr
    2 + // /sources, /fr/sources
    (demos.length - 1) * 2; // every demo except the hidden one, × en/fr
  assert.equal(locs.length, expected, `${locs.length} urls`);

  for (const url of [
    `${SITE}/`,
    `${SITE}/pricing/`,
    `${SITE}/fr/tarifs/`,
    `${SITE}/contact/`,
    `${SITE}/fr/contact/`,
    `${SITE}/start/`,
    `${SITE}/fr/commencer/`,
    `${SITE}/terms/`,
    `${SITE}/fr/conditions/`,
    `${SITE}/refunds/`,
    `${SITE}/fr/remboursements/`,
    `${SITE}/demos/`,
    `${SITE}/fr/demos/`,
    `${SITE}/sources/`,
    `${SITE}/fr/sources/`,
    `${SITE}/demos/nora/`,
    `${SITE}/fr/demos/nora/`,
  ]) {
    assert.ok(locs.includes(url), `missing ${url}`);
  }

  assert.equal(locs.includes(`${SITE}/fr/demos/boba-club/`), false, 'the hidden demo is excluded');
  assert.equal(locs.includes(`${SITE}/demos/boba-club/`), false);
  for (const path of ['/checkout', '/admin', '/404', '/fr/404', '/checkout/success']) {
    assert.equal(locs.includes(`${SITE}${path}/`), false, `${path} is not indexable`);
  }
});

test('every sitemap URL is unique, absolute, trailing-slashed and backed by a page file', async () => {
  const { locs } = await sitemap();
  assert.equal(new Set(locs).size, locs.length, 'no duplicates');
  for (const loc of locs) {
    assert.ok(loc.startsWith(`${SITE}/`), loc);
    assert.ok(loc.endsWith('/'), `${loc} is the canonical directory URL`);
    const source = sourceFor(loc);
    assert.ok(source, `no Astro page renders ${loc}`);
  }
});

test('each entry carries en, fr and x-default alternates', async () => {
  const { body } = await sitemap();
  const { locs } = await sitemap();
  const blocks = [...body.matchAll(/<url>([\s\S]*?)<\/url>/g)].map((match) => match[1]);
  assert.equal(blocks.length, locs.length);
  for (const block of blocks) {
    const loc = /<loc>([^<]+)<\/loc>/.exec(block)?.[1];
    const alternates = [...block.matchAll(/hreflang="([^"]+)" href="([^"]+)"/g)].map((match) => ({
      hreflang: match[1],
      href: match[2],
    }));
    assert.deepEqual(
      alternates.map((alternate) => alternate.hreflang).sort(),
      ['en', 'fr', 'x-default'],
      loc,
    );
    const byHreflang = new Map(alternates.map((alternate) => [alternate.hreflang, alternate.href]));
    const english = byHreflang.get('en')!;
    const french = byHreflang.get('fr')!;
    assert.equal(byHreflang.get('x-default'), english, `${loc} x-default points at English`);
    assert.ok(english.startsWith(`${SITE}/`) && french.startsWith(`${SITE}/`), loc);
    assert.notEqual(english, french, `${loc} has two distinct language targets`);
    if (loc.startsWith(`${SITE}/fr/`)) {
      assert.ok(french.startsWith(`${SITE}/fr/`) && !english.startsWith(`${SITE}/fr/`), `${loc} cross-links`);
    }
  }
});

test('the localized pages cross-link to their true counterparts', async () => {
  const { body } = await sitemap();
  const blockFor = (loc: string) => new RegExp(`<loc>${loc.replace(/\//g, '\\/')}</loc>([\\s\\S]*?)</url>`).exec(body)?.[1] ?? '';
  const pricing = blockFor(`${SITE}/pricing/`);
  assert.match(pricing, new RegExp(`hreflang="fr" href="${SITE}/fr/tarifs/"`));
  const contact = blockFor(`${SITE}/fr/contact/`);
  assert.match(contact, new RegExp(`hreflang="en" href="${SITE}/contact/"`));
  const home = blockFor(`${SITE}/`);
  assert.match(home, new RegExp(`hreflang="fr" href="${SITE}/fr/"`));
});

test('the sitemap declares the image namespace and lists demo lead images', async () => {
  const { body, locs } = await sitemap();
  assert.match(body, /xmlns:image="http:\/\/www\.google\.com\/schemas\/sitemap-image\/1\.1"/);
  const images = [...body.matchAll(/<image:image><image:loc>([^<]+)<\/image:loc><image:title>([^<]*)<\/image:title><\/image:image>/g)];
  // One image per visible demo URL (en + fr) that has local imagery.
  const withLocalHero = demos.filter((demo) => localHeroFor(demo.id) !== null && !HIDDEN_DEMOS.has(demo.id));
  assert.equal(images.length, withLocalHero.length * 2, `${images.length} image entries`);
  const locsWithImages = new Set(
    [...body.matchAll(/<loc>([^<]+)<\/loc>\s*(?:<xhtml:link[^>]*>\s*)*<image:image>/g)].map((m) => m[1]),
  );
  assert.ok(locsWithImages.size >= withLocalHero.length, 'demo urls carry their image');
  for (const [, imageLoc, title] of images) {
    assert.match(imageLoc, /^https:\/\/webao\.ca\/demos\/[a-z0-9-]+\/\d+\.jpg$/, imageLoc);
    assert.ok(title.length > 0, 'image title present');
    assert.ok(!title.includes('&amp;amp;'), 'titles are escaped exactly once');
  }
  // The escaped ampersand in "Sahara & Sage" must survive as &amp; in the XML.
  assert.ok(body.includes('<image:title>Sahara &amp; Sage</image:title>'));
  assert.ok(locs.length === 98, 'image entries do not add url entries');
});

test('robots.txt allows the site, blocks the API and points at the sitemap', () => {
  const robots = readFileSync('public/robots.txt', 'utf8');
  const lines = robots.split('\n').map((line) => line.trim()).filter(Boolean);
  assert.equal(lines[0], 'User-agent: *');
  assert.ok(lines.includes('Allow: /'));
  assert.ok(lines.includes('Disallow: /api/'), 'the JSON API stays out of the index');
  for (const blocked of [
    'Disallow: /admin',
    'Disallow: /fr/admin',
    'Disallow: /checkout',
    'Disallow: /fr/checkout',
    'Disallow: /404',
    'Disallow: /fr/404',
    'Disallow: /demos/boba-club',
    'Disallow: /fr/demos/boba-club',
  ]) {
    assert.ok(lines.includes(blocked), `robots.txt blocks ${blocked}`);
  }
  assert.ok(lines.includes(`Sitemap: ${SITE}/sitemap.xml`));

  const astroConfig = readFileSync('astro.config.mjs', 'utf8');
  const site = /site:\s*"([^"]+)"/.exec(astroConfig)?.[1];
  assert.equal(site, SITE, 'the canonical site matches the sitemap host');
});
