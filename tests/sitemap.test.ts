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
    (28 + 77) * 2 + // home, pricing, contact, demos, start, audit, terms, refunds, support, privacy + 8 service pages + 3 guide pages + guides index + 6 new guide pages × en/fr, + 77 ranking pages (services x CA/QC/MTL, best-of, one page per product) x en/fr
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
    `${SITE}/audit/`,
    `${SITE}/fr/eval/`,
    `${SITE}/terms/`,
    `${SITE}/fr/conditions/`,
    `${SITE}/refunds/`,
    `${SITE}/fr/remboursements/`,
    `${SITE}/support/`,
    `${SITE}/fr/soutien/`,
    `${SITE}/privacy/`,
    `${SITE}/fr/confidentialite/`,
    `${SITE}/demos/`,
    `${SITE}/fr/demos/`,
    `${SITE}/services/small-business-website-design/`,
    `${SITE}/fr/services/conception-site-web-pme/`,
    `${SITE}/services/monthly-website-plans/`,
    `${SITE}/fr/services/forfaits-mensuels-site-web/`,
    `${SITE}/services/website-hosting-maintenance/`,
    `${SITE}/fr/services/hebergement-entretien-site-web/`,
    `${SITE}/services/montreal-web-design/`,
    `${SITE}/fr/services/conception-site-web-montreal/`,
    `${SITE}/services/`,
    `${SITE}/fr/services/`,
    `${SITE}/services/websites/`,
    `${SITE}/fr/services/sites-web/`,
    `${SITE}/services/ads/`,
    `${SITE}/fr/services/publicite/`,
    `${SITE}/services/ai/`,
    `${SITE}/fr/services/ia/`,
    `${SITE}/guides/website-cost-canada/`,
    `${SITE}/fr/guides/cout-site-web-canada/`,
    `${SITE}/guides/quebec-bill-96-website/`,
    `${SITE}/fr/guides/loi-96-site-web-quebec/`,
    `${SITE}/guides/quebec-law-25-website/`,
    `${SITE}/fr/guides/loi-25-site-web-quebec/`,
    `${SITE}/guides/`,
    `${SITE}/fr/guides/`,
    `${SITE}/guides/small-business-seo-basics/`,
    `${SITE}/fr/guides/bases-seo-pme/`,
    `${SITE}/guides/meta-vs-google-ads-small-business/`,
    `${SITE}/fr/guides/meta-ou-google-ads-pme/`,
    `${SITE}/guides/ai-receptionist-small-business/`,
    `${SITE}/fr/guides/receptionniste-ia-pme/`,
    `${SITE}/guides/what-to-prepare-for-your-website/`,
    `${SITE}/fr/guides/preparer-votre-site-web/`,
    `${SITE}/guides/website-that-brings-quote-requests/`,
    `${SITE}/fr/guides/site-web-demandes-soumission/`,
    `${SITE}/guides/when-to-redesign-your-website/`,
    `${SITE}/fr/guides/quand-refaire-votre-site-web/`,
    `${SITE}/sources/`,
    `${SITE}/fr/sources/`,
    `${SITE}/demos/nora/`,
    `${SITE}/fr/demos/nora/`,
    `${SITE}/services/web-design-canada/`,
    `${SITE}/fr/services/conception-site-web-canada/`,
    `${SITE}/services/web-design-quebec/`,
    `${SITE}/fr/services/conception-site-web-quebec/`,
    `${SITE}/services/ai-automation-canada/`,
    `${SITE}/fr/services/automatisation-ia-canada/`,
    `${SITE}/services/ai-automation-quebec/`,
    `${SITE}/fr/services/automatisation-ia-quebec/`,
    `${SITE}/services/ai-automation-montreal/`,
    `${SITE}/fr/services/automatisation-ia-montreal/`,
    `${SITE}/services/ads-agency-canada/`,
    `${SITE}/fr/services/agence-publicite-canada/`,
    `${SITE}/services/ads-agency-quebec/`,
    `${SITE}/fr/services/agence-publicite-quebec/`,
    `${SITE}/services/ads-agency-montreal/`,
    `${SITE}/fr/services/agence-publicite-montreal/`,
    `${SITE}/services/meta-ads-canada/`,
    `${SITE}/fr/services/publicites-meta-canada/`,
    `${SITE}/services/meta-ads-quebec/`,
    `${SITE}/fr/services/publicites-meta-quebec/`,
    `${SITE}/services/meta-ads-montreal/`,
    `${SITE}/fr/services/publicites-meta-montreal/`,
    `${SITE}/services/google-ads-canada/`,
    `${SITE}/fr/services/publicites-google-canada/`,
    `${SITE}/services/google-ads-quebec/`,
    `${SITE}/fr/services/publicites-google-quebec/`,
    `${SITE}/services/google-ads-montreal/`,
    `${SITE}/fr/services/publicites-google-montreal/`,
    `${SITE}/services/ai-receptionist-canada/`,
    `${SITE}/fr/services/receptionniste-ia-canada/`,
    `${SITE}/services/ai-receptionist-quebec/`,
    `${SITE}/fr/services/receptionniste-ia-quebec/`,
    `${SITE}/services/ai-receptionist-montreal/`,
    `${SITE}/fr/services/receptionniste-ia-montreal/`,
    `${SITE}/services/online-receptionist-canada/`,
    `${SITE}/fr/services/receptionniste-en-ligne-canada/`,
    `${SITE}/services/online-receptionist-quebec/`,
    `${SITE}/fr/services/receptionniste-en-ligne-quebec/`,
    `${SITE}/services/online-receptionist-montreal/`,
    `${SITE}/fr/services/receptionniste-en-ligne-montreal/`,
    `${SITE}/services/smart-follow-up-canada/`,
    `${SITE}/fr/services/suivi-intelligent-canada/`,
    `${SITE}/services/smart-follow-up-quebec/`,
    `${SITE}/fr/services/suivi-intelligent-quebec/`,
    `${SITE}/services/smart-follow-up-montreal/`,
    `${SITE}/fr/services/suivi-intelligent-montreal/`,
    `${SITE}/services/local-seo-canada/`,
    `${SITE}/fr/services/seo-local-canada/`,
    `${SITE}/services/local-seo-quebec/`,
    `${SITE}/fr/services/seo-local-quebec/`,
    `${SITE}/services/local-seo-montreal/`,
    `${SITE}/fr/services/seo-local-montreal/`,
    `${SITE}/services/website-redesign-canada/`,
    `${SITE}/fr/services/refonte-site-web-canada/`,
    `${SITE}/services/website-redesign-quebec/`,
    `${SITE}/fr/services/refonte-site-web-quebec/`,
    `${SITE}/services/website-redesign-montreal/`,
    `${SITE}/fr/services/refonte-site-web-montreal/`,
    `${SITE}/services/small-business-websites-canada/`,
    `${SITE}/fr/services/sites-web-pme-canada/`,
    `${SITE}/services/small-business-websites-quebec/`,
    `${SITE}/fr/services/sites-web-pme-quebec/`,
    `${SITE}/services/small-business-websites-montreal/`,
    `${SITE}/fr/services/sites-web-pme-montreal/`,
    `${SITE}/services/monthly-website-plans-canada/`,
    `${SITE}/fr/services/forfaits-mensuels-site-web-canada/`,
    `${SITE}/services/monthly-website-plans-quebec/`,
    `${SITE}/fr/services/forfaits-mensuels-site-web-quebec/`,
    `${SITE}/services/monthly-website-plans-montreal/`,
    `${SITE}/fr/services/forfaits-mensuels-site-web-montreal/`,
    `${SITE}/services/b2b-web-services-canada/`,
    `${SITE}/fr/services/services-web-b2b-canada/`,
    `${SITE}/services/b2b-web-services-quebec/`,
    `${SITE}/fr/services/services-web-b2b-quebec/`,
    `${SITE}/services/b2b-web-services-montreal/`,
    `${SITE}/fr/services/services-web-b2b-montreal/`,
    `${SITE}/services/best-web-design-agency-canada/`,
    `${SITE}/fr/services/meilleure-agence-conception-web-canada/`,
    `${SITE}/services/best-web-agency-quebec/`,
    `${SITE}/fr/services/meilleure-agence-web-quebec/`,
    `${SITE}/services/cheapest-best-web-design-montreal/`,
    `${SITE}/fr/services/conception-web-abordable-montreal/`,
    `${SITE}/services/best-ai-automation-montreal/`,
    `${SITE}/fr/services/meilleure-automatisation-ia-montreal/`,
    `${SITE}/services/best-ads-agency-quebec/`,
    `${SITE}/fr/services/meilleure-agence-publicite-quebec/`,
    `${SITE}/services/affordable-web-design-canada/`,
    `${SITE}/fr/services/conception-web-abordable-canada/`,
    `${SITE}/services/fastest-website-delivery-canada/`,
    `${SITE}/fr/services/livraison-site-web-rapide-canada/`,
    `${SITE}/services/high-quality-custom-websites-canada/`,
    `${SITE}/fr/services/sites-web-sur-mesure-haute-qualite-canada/`,
    `${SITE}/services/tailored-website-design-canada/`,
    `${SITE}/fr/services/conception-site-web-sur-mesure-canada/`,
    `${SITE}/services/best-b2b-web-agency-canada/`,
    `${SITE}/fr/services/meilleure-agence-web-b2b-canada/`,
    `${SITE}/services/best-small-business-website-agency-canada/`,
    `${SITE}/fr/services/meilleure-agence-sites-web-pme-canada/`,
    `${SITE}/services/launch-plan/`,
    `${SITE}/fr/services/forfait-lancement/`,
    `${SITE}/services/grow-plan/`,
    `${SITE}/fr/services/forfait-croissance/`,
    `${SITE}/services/scale-plan/`,
    `${SITE}/fr/services/forfait-echelle/`,
    `${SITE}/services/lead-pack/`,
    `${SITE}/fr/services/pack-leads/`,
    `${SITE}/services/visibility-pack/`,
    `${SITE}/fr/services/pack-visibilite/`,
    `${SITE}/services/growth-bundle/`,
    `${SITE}/fr/services/ensemble-croissance/`,
    `${SITE}/services/growth-engine/`,
    `${SITE}/fr/services/moteur-croissance/`,
    `${SITE}/services/local-seo-management/`,
    `${SITE}/fr/services/gestion-seo-local/`,
    `${SITE}/services/review-generation-engine/`,
    `${SITE}/fr/services/moteur-generation-avis/`,
    `${SITE}/services/online-booking/`,
    `${SITE}/fr/services/reservation-en-ligne/`,
    `${SITE}/services/diy-blog-page/`,
    `${SITE}/fr/services/page-blog-bricolage/`,
    `${SITE}/services/weekly-seo-blog/`,
    `${SITE}/fr/services/blogue-seo-hebdomadaire/`,
    `${SITE}/services/ecommerce-lite/`,
    `${SITE}/fr/services/commerce-en-ligne-leger/`,
    `${SITE}/services/email-marketing/`,
    `${SITE}/fr/services/marketing-courriel/`,
    `${SITE}/services/monthly-growth-report/`,
    `${SITE}/fr/services/rapport-croissance-mensuel/`,
    `${SITE}/services/extra-page/`,
    `${SITE}/fr/services/page-supplementaire/`,
    `${SITE}/services/website-touchup/`,
    `${SITE}/fr/services/retouche-site-web/`,
    `${SITE}/services/priority-support/`,
    `${SITE}/fr/services/soutien-prioritaire/`,
    `${SITE}/services/advanced-admin-panel/`,
    `${SITE}/fr/services/panneau-admin-avance/`,
    `${SITE}/services/quote-photo-upload/`,
    `${SITE}/fr/services/televersement-photo-devis/`,
    `${SITE}/services/ai-receptionist/`,
    `${SITE}/fr/services/receptionniste-ia/`,
    `${SITE}/services/online-receptionist/`,
    `${SITE}/fr/services/receptionniste-en-ligne/`,
    `${SITE}/services/smart-follow-up/`,
    `${SITE}/fr/services/suivi-intelligent/`,
    `${SITE}/services/ai-pack/`,
    `${SITE}/fr/services/pack-ia/`,
    `${SITE}/services/ads-starter/`,
    `${SITE}/fr/services/demarrage-publicites/`,
    `${SITE}/services/ads-single-channel/`,
    `${SITE}/fr/services/publicites-un-canal/`,
    `${SITE}/services/ads-both-channels/`,
    `${SITE}/fr/services/publicites-deux-canaux/`,
    `${SITE}/services/google-business-profile-revamp/`,
    `${SITE}/fr/services/refonte-profil-google/`,
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
  const service = blockFor(`${SITE}/services/montreal-web-design/`);
  assert.match(service, new RegExp(`hreflang="fr" href="${SITE}/fr/services/conception-site-web-montreal/"`));
  const servicesHome = blockFor(`${SITE}/services/`);
  assert.match(servicesHome, new RegExp(`hreflang="fr" href="${SITE}/fr/services/"`));
  const servicesAds = blockFor(`${SITE}/services/ads/`);
  assert.match(servicesAds, new RegExp(`hreflang="fr" href="${SITE}/fr/services/publicite/"`));
  const guide = blockFor(`${SITE}/guides/quebec-law-25-website/`);
  assert.match(guide, new RegExp(`hreflang="fr" href="${SITE}/fr/guides/loi-25-site-web-quebec/"`));
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
  const expectedUrls = (28 + 77) * 2 + 2 + (demos.length - 1) * 2; // locale pages + 77 ranking pages x en/fr + /sources pair + visible demos
  assert.ok(locs.length === expectedUrls, 'image entries do not add url entries');
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
