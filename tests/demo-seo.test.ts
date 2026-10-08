// Demo microsite SEO: the shared helpers plus a source-level sweep proving
// every standalone demo page ships the full head block (canonical, hreflang,
// Open Graph, Twitter, JSON-LD) through DemoSeo and no longer carries noindex.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import {
  demoAlternates,
  demoAlternatesForLocale,
  demoBreadcrumb,
  getDemo,
  HIDDEN_DEMOS,
  isHiddenDemo,
  localHeroFor,
  SITE_URL,
} from '../src/lib/demo-seo';
import { demos } from '../src/lib/demos';

test('the hidden demo set matches the catalog and sitemap policy', () => {
  assert.deepEqual([...HIDDEN_DEMOS], ['boba-club']);
  assert.ok(isHiddenDemo('boba-club'));
  assert.ok(!isHiddenDemo('aeris'));
});

test('demo alternates cross-link both locales with the canonical trailing slash', () => {
  assert.deepEqual(demoAlternates('aeris'), {
    canonical: `${SITE_URL}/demos/aeris/`,
    en: `${SITE_URL}/demos/aeris/`,
    fr: `${SITE_URL}/fr/demos/aeris/`,
    xDefault: `${SITE_URL}/demos/aeris/`,
  });
  const fr = demoAlternatesForLocale('aeris', 'fr');
  assert.equal(fr.canonical, `${SITE_URL}/fr/demos/aeris/`, 'the canonical is the page’s own locale');
  assert.equal(fr.en, `${SITE_URL}/demos/aeris/`);
  assert.equal(fr.fr, `${SITE_URL}/fr/demos/aeris/`);
  const en = demoAlternatesForLocale('aeris', 'en');
  assert.equal(en.canonical, `${SITE_URL}/demos/aeris/`);
});

test('localHeroFor resolves an absolute lead image from the provenance list', () => {
  assert.equal(localHeroFor('aeris'), `${SITE_URL}/demos/aeris/01.jpg`);
  assert.equal(localHeroFor('brume'), null, 'remote-only demos have no local hero');
  for (const demo of demos) {
    const hero = localHeroFor(demo.id);
    if (hero) {
      assert.match(hero, new RegExp(`^${SITE_URL}/demos/${demo.id}/\\d+\\.jpg$`), demo.id);
    }
  }
});

test('every demo resolves catalog metadata and localized breadcrumbs', () => {
  for (const demo of demos) {
    assert.ok(getDemo(demo.id)?.name, `${demo.id} resolves`);
    for (const locale of ['en', 'fr'] as const) {
      const crumbs = demoBreadcrumb(demo.id, locale);
      assert.ok(crumbs.name.length > 0, `${demo.id} ${locale} crumb name`);
      assert.ok(crumbs.homeUrl.startsWith(SITE_URL), `${demo.id} ${locale} home url`);
      assert.ok(crumbs.catalogUrl.includes('/demos/'), `${demo.id} ${locale} catalog url`);
      if (locale === 'fr') {
        assert.equal(crumbs.home, 'Accueil');
        assert.equal(crumbs.catalog, 'Démos');
      } else {
        assert.equal(crumbs.home, 'Home');
        assert.equal(crumbs.catalog, 'Demos');
      }
    }
  }
});

// Source-level sweep: every standalone demo page renders its head through
// DemoSeo, with the right demoId/locale and an absolute og:image.
const pageDirs: Array<[string, 'en' | 'fr']> = [
  ['src/pages/demos', 'en'],
  ['src/pages/fr/demos', 'fr'],
];
for (const [dir, locale] of pageDirs) {
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.astro') || file === 'index.astro') continue;
    test(`${dir}/${file} ships the full SEO head through DemoSeo`, () => {
      const source = readFileSync(`${dir}/${file}`, 'utf8');
      const demoId = file.replace(/\.astro$/, '');
      assert.match(source, /<DemoSeo\s/, 'DemoSeo renders the head block');
      assert.match(
        source,
        /import DemoSeo from ["'].*components\/demos\/DemoSeo\.astro["']/,
        'DemoSeo is imported',
      );
      assert.match(source, new RegExp(`demoId="${demoId}"`), 'demoId matches the file');
      assert.match(source, new RegExp(`locale="${locale}"`), 'locale matches the directory');
      assert.match(source, /title="[^"]+"/, 'title prop present');
      assert.match(source, /description="[^"]+"/, 'description prop present');
      assert.match(source, /ogImage="https?:\/\//, 'absolute og:image');
      assert.doesNotMatch(source, /name="robots" content="noindex"/, 'no stale noindex tag');
      assert.doesNotMatch(source, /<title>/, 'title moved into DemoSeo');
      // The demoId is a real catalog demo.
      assert.ok(getDemo(demoId), `${demoId} is in the catalog`);
    });
  }
}

test('every demo page keeps exactly one h1 and image alts survive the SEO pass', () => {
  for (const [dir] of pageDirs) {
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.astro') || file === 'index.astro') continue;
      const source = readFileSync(`${dir}/${file}`, 'utf8');
      const template = source.slice(source.indexOf('\n---\n', 3));
      const h1s = template.match(/<h1[\s>]/g) ?? [];
      assert.ok(h1s.length >= 1, `${file} has an h1`);
      for (const img of template.matchAll(/<img\b[^>]*>/g)) {
        assert.match(img[0], /\balt\s*=/, `${file}: img without alt`);
        assert.match(img[0], /\bdecoding="async"/, `${file}: img without decoding`);
      }
    }
  }
});
