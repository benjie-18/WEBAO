// Content model: the demo catalog, the pricing-plan structure and the
// footnote cross-references must agree with each other and with the
// dictionaries they are rendered from.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { demos } from '../src/lib/demos';
import en from '../src/lib/i18n/en';
import fr from '../src/lib/i18n/fr';
import {
  bundleOrder,
  bundles,
  compatibility,
  featuredAddonOrder,
  plans,
  remainingAddonOrder,
  termSections,
} from '../src/lib/pricing';

const read = (path: string) => readFileSync(path, 'utf8');

const validCategories = new Set([
  'Trades', 'Restaurant', 'Automotive', 'Health', 'Creative', 'Retail', 'Wellness',
  'Hospitality', 'Landscaping', 'Technology', 'Fashion', 'Music', 'Finance', 'Gaming',
  'Design', 'Beauty',
]);
const validTrades = new Set(['plumbing', 'electrical', 'hvac', 'roofing', 'renovation']);

const noteNumbers = (values: Array<number | undefined>) =>
  values.filter((value): value is number => typeof value === 'number' && value > 0);

test('the demo catalog entries are well-formed and unique', () => {
  assert.ok(demos.length >= 40, `${demos.length} demos`);
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const demo of demos) {
    assert.match(demo.id, /^[a-z0-9-]+$/, demo.id);
    assert.equal(ids.has(demo.id), false, `duplicate id ${demo.id}`);
    ids.add(demo.id);
    assert.equal(names.has(demo.name), false, `duplicate name ${demo.name}`);
    names.add(demo.name);
    assert.match(demo.accent, /^#[0-9a-fA-F]{6}$/, `${demo.id} accent`);
    for (const field of ['name', 'city', 'tone', 'palette', 'description'] as const) {
      assert.equal(typeof demo[field], 'string', `${demo.id}.${field}`);
      assert.notEqual(demo[field].trim(), '', `${demo.id}.${field}`);
    }
    assert.ok(validCategories.has(demo.category), `${demo.id} category ${demo.category}`);
    if (demo.trade !== undefined) assert.ok(validTrades.has(demo.trade), `${demo.id} trade ${demo.trade}`);
    assert.ok(Array.isArray(demo.pages) && demo.pages.length > 0, `${demo.id} has sub-pages`);
    assert.equal(new Set(demo.pages).size, demo.pages!.length, `${demo.id} pages are unique`);
  }
});

test('every demo has an English and a French page on disk', () => {
  for (const demo of demos) {
    for (const path of [`src/pages/demos/${demo.id}.astro`, `src/pages/fr/demos/${demo.id}.astro`]) {
      assert.equal(existsSync(path), true, `missing ${path}`);
    }
  }
});

test('the catalog page hides the same demo the sitemap excludes', () => {
  const page = read('src/components/pages/DemosPage.astro');
  const hidden = /hiddenDemos\s*=\s*new Set\(\[([^\]]*)\]\)/.exec(page)?.[1] ?? '';
  assert.match(hidden, /"boba-club"/, 'DemosPage hides boba-club');
  const sitemap = read('src/pages/sitemap.xml.ts');
  const sitemapHidden = /hiddenDemos\s*=\s*new Set\(\[([^\]]*)\]\)/.exec(sitemap)?.[1] ?? '';
  assert.match(sitemapHidden, /"boba-club"/, 'sitemap hides boba-club');
  const setOf = (source: string) => new Set(source.match(/"[a-z0-9-]+"/g)?.map((token) => token.replace(/"/g, '')) ?? []);
  assert.deepEqual([...setOf(hidden)].sort(), [...setOf(sitemapHidden)].sort(), 'both files hide the same demos');
  // The demo SEO helpers hide the same demo, so its page stays noindex.
  const demoSeo = read('src/lib/demo-seo.ts');
  const seoHidden = /HIDDEN_DEMOS[^=]*=\s*new Set\(\[([^\]]*)\]\)/.exec(demoSeo)?.[1] ?? '';
  assert.deepEqual([...setOf(seoHidden)].sort(), [...setOf(hidden)].sort(), 'demo-seo hides the same demos');
});

test('the plan definitions match the dictionaries', () => {
  assert.deepEqual(plans.map((plan) => plan.id), ['launch', 'grow', 'scale']);
  assert.deepEqual(plans.map((plan) => plan.inheritsFrom), [null, 'launch', 'grow']);
  for (const plan of plans) {
    for (const locale of [en, fr]) {
      const strings = locale.pricing.plans[plan.id];
      assert.equal(strings.features.length, plan.features.length, `${plan.id} feature count`);
      for (const feature of plan.features) {
        assert.equal(typeof strings.features[Number(feature.key.slice(1)) - 1], 'string', `${plan.id}.${feature.key}`);
      }
      if (plan.inheritsFrom) assert.notEqual(strings.inherits.trim(), '', `${plan.id}.inherits`);
      else assert.equal(strings.inherits, '', `${plan.id} inherits nothing`);
    }
  }
  // Plan names are brand nouns (same in both languages); descriptions are not.
  assert.equal(en.pricing.plans.launch.name, fr.pricing.plans.launch.name);
  assert.notEqual(en.pricing.plans.launch.desc, fr.pricing.plans.launch.desc);
});

test('the bundle and add-on catalogs line up with the dictionaries', () => {
  assert.deepEqual(bundles.map((bundle) => bundle.id), [...bundleOrder]);
  for (const bundle of bundles) {
    for (const locale of [en, fr]) {
      const strings = locale.pricing.bundles[bundle.id];
      assert.equal(strings.includes.length, bundle.includes.length, `${bundle.id} includes`);
    }
  }

  const addonIds = [...featuredAddonOrder, ...remainingAddonOrder];
  assert.equal(new Set(addonIds).size, addonIds.length, 'no duplicate add-ons');
  for (const locale of [en, fr]) {
    assert.deepEqual(Object.keys(locale.pricing.addons.items).sort(), [...addonIds].sort(), 'add-on ids');
  }
  assert.deepEqual(featuredAddonOrder, ['localseo', 'booking', 'review', 'ecommerce', 'bilingual']);

  const compatKeys = compatibility.map((row) => row.key);
  assert.equal(new Set(compatKeys).size, compatKeys.length, 'no duplicate compatibility rows');
  for (const locale of [en, fr]) {
    assert.deepEqual(Object.keys(locale.pricing.compare.compatRows).sort(), [...compatKeys].sort());
  }
  for (const row of compatibility) {
    for (const tier of ['launch', 'grow', 'scale'] as const) {
      assert.ok(['I', 'A', 'N'].includes(row[tier]), `${row.key}.${tier}`);
    }
  }
  for (const key of [...addonIds, 'leadpack', 'vispack']) {
    assert.ok(compatKeys.includes(key), `${key} has a compatibility row`);
  }
});

test('every footnote reference resolves to a terms note in both languages', () => {
  const referenced = noteNumbers([
    ...plans.flatMap((plan) => plan.features.map((feature) => feature.note)),
    ...bundles.map((bundle) => bundle.note),
    ...compatibility.map((row) => row.note),
    ...Object.values(en.pricing.plans).flatMap((plan) => (typeof plan === 'object' && plan && 'priceNote' in plan ? [plan.priceNote as number] : [])),
  ]);
  assert.ok(referenced.length > 10, `${referenced.length} references`);
  for (const note of referenced) {
    assert.ok(en.terms.notes[String(note)], `en note ${note}`);
    assert.ok(fr.terms.notes[String(note)], `fr note ${note}`);
  }

  const sectionNotes = termSections.flatMap((section) => [...section.notes]);
  assert.deepEqual(
    [...sectionNotes].sort((a, b) => a - b),
    Array.from({ length: 30 }, (_, i) => i + 1),
    'the six sections cover notes 1..30 exactly once',
  );
  for (const note of referenced) {
    assert.ok(sectionNotes.includes(note), `note ${note} belongs to a section`);
  }
});

test('terms notes have the same structure in both languages', () => {
  const noteIds = Object.keys(en.terms.notes).map(Number).sort((a, b) => a - b);
  assert.deepEqual(noteIds, Array.from({ length: 30 }, (_, i) => i + 1));
  assert.deepEqual(Object.keys(fr.terms.notes).map(Number).sort((a, b) => a - b), noteIds);
  for (const id of noteIds) {
    const english = en.terms.notes[String(id)];
    const french = fr.terms.notes[String(id)];
    assert.notEqual(english.title.trim(), '', `note ${id} title`);
    assert.notEqual(french.title.trim(), '', `note ${id} titre`);
    assert.equal(french.blocks.length, english.blocks.length, `note ${id} blocks`);
    for (let i = 0; i < english.blocks.length; i++) {
      const a = english.blocks[i] as Record<string, unknown>;
      const b = french.blocks[i] as Record<string, unknown>;
      assert.equal(b.text !== undefined, a.text !== undefined, `note ${id} block ${i} text`);
      assert.equal(b.items !== undefined, a.items !== undefined, `note ${id} block ${i} items`);
    }
  }
});

test('the terms page anchors match the NoteRef link format', () => {
  const termsPage = read('src/components/pages/TermsPage.astro');
  const noteRef = read('src/components/NoteRef.astro');
  assert.match(termsPage, /id=\{`note-\$\{note\.n\}`\}/, 'the terms page renders note-N anchors');
  assert.match(noteRef, /#note-\$\{note\}/, 'NoteRef links to #note-N');
  assert.match(noteRef, /\/fr\/conditions/, 'French notes link to the French terms page');
  assert.match(termsPage, /terms\.notes/, 'the terms page reads the shared note dictionary');
});

test('the image provenance list is well-formed and matches the catalog', () => {
  const sources = JSON.parse(read('src/lib/sources.json')) as Array<{
    demo: string;
    file: string;
    source: string;
    query: string;
  }>;
  assert.ok(sources.length > 100, `${sources.length} entries`);
  const ids = new Set(demos.map((demo) => demo.id));
  const files = new Set<string>();
  for (const entry of sources) {
    assert.ok(ids.has(entry.demo), `unknown demo ${entry.demo}`);
    assert.equal(files.has(entry.file), false, `duplicate file ${entry.file}`);
    files.add(entry.file);
    assert.match(entry.file, /^\/[\w\/.-]+\.(jpg|jpeg|png|webp)$/i, entry.file);
    assert.match(entry.source, /^https?:\/\//, entry.source);
    assert.notEqual(entry.query.trim(), '', entry.file);
  }
});

test('French strings are not left in English for the plan names', () => {
  // A light smell test: the two dictionaries must not be the same object and
  // a sample of user-facing strings must differ.
  const sample: Array<[string, string]> = [
    [en.pricing.hero.title, fr.pricing.hero.title],
    [en.pricing.addons.title, fr.pricing.addons.title],
    [en.terms.notes['1'].title, fr.terms.notes['1'].title],
    [en.cart.title, fr.cart.title],
  ];
  for (const [english, french] of sample) {
    assert.notEqual(english.trim(), '', String(english));
    assert.notEqual(french.trim(), '', String(french));
    assert.notEqual(english, french, `${english} is translated`);
  }
});
