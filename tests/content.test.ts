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
  assert.deepEqual(featuredAddonOrder, ['localseo', 'booking', 'review', 'ecommerce']);

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
    Array.from({ length: 31 }, (_, i) => i + 1),
    'the six sections cover notes 1..31 exactly once',
  );
  for (const note of referenced) {
    assert.ok(sectionNotes.includes(note), `note ${note} belongs to a section`);
  }
});

test('terms notes have the same structure in both languages', () => {
  const noteIds = Object.keys(en.terms.notes).map(Number).sort((a, b) => a - b);
  assert.deepEqual(noteIds, Array.from({ length: 31 }, (_, i) => i + 1));
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

test('the terms search message templates sit before the search script', () => {
  // The search script queries these spans at init; on a direct page load it
  // runs while the page is still parsing, so spans below the script are
  // null and the result count, prev/next navigation and screen-reader
  // announcements break (filtering still works, which hides the bug).
  const termsPage = read('src/components/pages/TermsPage.astro');
  const scriptAt = termsPage.indexOf('<script data-astro-rerun>');
  assert.ok(scriptAt > 0, 'the terms page has a rerun search script');
  for (const attr of ['data-search-msg-count', 'data-search-msg-count-pl', 'data-search-msg-announced', 'data-search-msg-none']) {
    const at = termsPage.indexOf(attr);
    assert.ok(at > 0, `${attr} template exists`);
    assert.ok(at < scriptAt, `${attr} template sits before the search script`);
  }
});

test('the support form validates like the contact form', () => {
  // Same three guards the contact page has: a real email regex (not a bare
  // '@' check), an in-flight guard against double submits, and focus to the
  // first invalid field. The category select also starts on an empty
  // placeholder instead of silently defaulting to Billing.
  const supportPage = read('src/components/pages/SupportPage.astro');
  assert.ok(supportPage.includes('EMAIL_RE.test(email)'), 'the support form uses the shared email regex');
  assert.equal(supportPage.includes("email.includes('@')"), false, 'the support form does not use a bare @ check');
  assert.ok(supportPage.includes("dataset.sending === '1'"), 'the support form has an in-flight guard');
  assert.ok(supportPage.includes('firstInvalid'), 'the support form focuses the first invalid field');
  assert.ok(supportPage.includes('<option value="" disabled selected>'), 'the category select starts on an empty placeholder');
  assert.notEqual(en.support.form.categoryPlaceholder.trim(), '', 'the category placeholder exists in English');
  assert.notEqual(fr.support.form.categoryPlaceholder.trim(), '', 'the category placeholder exists in French');
  assert.notEqual(en.support.form.categoryPlaceholder, fr.support.form.categoryPlaceholder, 'the category placeholder is translated');
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

test('the service pages use the pricing SEO term and agree in French', () => {
  // The pricing page names the Launch SEO feature "Foundational SEO" /
  // "SEO fondamental"; the service pages drifted to "Basic SEO" /
  // "Référencement de base". The FR small-business page also had an
  // agreement slip: "mises à jour ... sont inclus" instead of "incluses".
  assert.ok(en.pricing.plans.launch.features.includes('Foundational SEO'), 'pricing EN calls it Foundational SEO');
  assert.ok(fr.pricing.plans.launch.features.includes('SEO fondamental'), 'pricing FR calls it SEO fondamental');
  const enServices = [
    'src/pages/services/montreal-web-design/index.astro',
    'src/pages/services/small-business-website-design/index.astro',
  ];
  const frServices = [
    'src/pages/fr/services/conception-site-web-montreal/index.astro',
    'src/pages/fr/services/conception-site-web-pme/index.astro',
    'src/pages/fr/services/forfaits-mensuels-site-web/index.astro',
  ];
  for (const path of enServices) {
    const page = read(path);
    assert.ok(page.includes('Foundational SEO'), `${path} uses the pricing term`);
    assert.equal(page.includes('Basic SEO') || page.includes('basic SEO'), false, `${path} has no "Basic SEO" left`);
  }
  for (const path of frServices) {
    const page = read(path);
    assert.ok(page.includes('SEO fondamental'), `${path} uses the pricing term`);
    assert.equal(page.includes('Référencement de base') || page.includes('référencement de base'), false, `${path} has no "Référencement de base" left`);
  }
  const frPme = read('src/pages/fr/services/conception-site-web-pme/index.astro');
  assert.ok(frPme.includes('sont incluses dans le frais mensuel'), 'the FR small-business FAQ agrees "mises à jour" with "incluses"');
});

test('the guide pages use the pricing SEO term, the Ads Packages name, and the full Bill 96 exceptions', () => {
  // Same drift as the service pages: the guides said "Basic SEO" /
  // "SEO de base" while pricing calls the feature "Foundational SEO" /
  // "SEO fondamental", the EN ads guide heading said "Ads Pack", and the
  // Bill 96 guides listed only three of Educaloi's four limited exceptions.
  assert.ok(en.pricing.plans.launch.features.includes('Foundational SEO'), 'pricing EN calls it Foundational SEO');
  assert.ok(fr.pricing.plans.launch.features.includes('SEO fondamental'), 'pricing FR calls it SEO fondamental');
  const enGuides = [
    'src/pages/guides/index.astro',
    'src/pages/guides/ai-receptionist-small-business/index.astro',
    'src/pages/guides/meta-vs-google-ads-small-business/index.astro',
    'src/pages/guides/quebec-bill-96-website/index.astro',
    'src/pages/guides/quebec-law-25-website/index.astro',
    'src/pages/guides/small-business-seo-basics/index.astro',
    'src/pages/guides/website-cost-canada/index.astro',
    'src/pages/guides/website-that-brings-quote-requests/index.astro',
    'src/pages/guides/what-to-prepare-for-your-website/index.astro',
    'src/pages/guides/when-to-redesign-your-website/index.astro',
  ];
  const frGuides = [
    'src/pages/fr/guides/index.astro',
    'src/pages/fr/guides/bases-seo-pme/index.astro',
    'src/pages/fr/guides/cout-site-web-canada/index.astro',
    'src/pages/fr/guides/loi-25-site-web-quebec/index.astro',
    'src/pages/fr/guides/loi-96-site-web-quebec/index.astro',
    'src/pages/fr/guides/meta-ou-google-ads-pme/index.astro',
    'src/pages/fr/guides/preparer-votre-site-web/index.astro',
    'src/pages/fr/guides/quand-refaire-votre-site-web/index.astro',
    'src/pages/fr/guides/receptionniste-ia-pme/index.astro',
    'src/pages/fr/guides/site-web-demandes-soumission/index.astro',
  ];
  for (const path of enGuides) {
    const page = read(path);
    assert.equal(page.includes('Basic SEO') || page.includes('basic SEO'), false, `${path} has no "Basic SEO" left`);
  }
  for (const path of frGuides) {
    const page = read(path);
    assert.equal(page.includes('SEO de base'), false, `${path} has no "SEO de base" left`);
  }
  const enAds = read('src/pages/guides/meta-vs-google-ads-small-business/index.astro');
  assert.ok(enAds.includes('What the Ads Packages include'), 'the EN ads guide heading uses the Ads Packages name');
  const enBill96 = read('src/pages/guides/quebec-bill-96-website/index.astro');
  assert.ok(enBill96.includes('an event intended solely for a specialized or limited public'), 'the EN Bill 96 guide lists the fourth Educaloi exception');
  const frBill96 = read('src/pages/fr/guides/loi-96-site-web-quebec/index.astro');
  assert.ok(frBill96.includes('un événement destiné uniquement à un public spécialisé ou limité'), 'the FR Bill 96 guide lists the fourth Educaloi exception');
});
