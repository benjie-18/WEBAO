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
    Array.from({ length: 34 }, (_, i) => i + 1),
    'the six sections cover notes 1..34 exactly once',
  );
  for (const note of referenced) {
    assert.ok(sectionNotes.includes(note), `note ${note} belongs to a section`);
  }
});

test('terms notes have the same structure in both languages', () => {
  const noteIds = Object.keys(en.terms.notes).map(Number).sort((a, b) => a - b);
  assert.deepEqual(noteIds, Array.from({ length: 34 }, (_, i) => i + 1));
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
  // Live-verified 2026-11-18: an empty submit moved focus to the name
  // field but left every field with a grey border and no aria-invalid, so
  // neither a sighted visitor nor a screen reader could tell which fields
  // had failed. The support form marks its failed fields like the contact
  // and start pages do, and clears the mark once a field is fixed.
  assert.ok(supportPage.includes("setAttribute('aria-invalid'"), 'the support form sets aria-invalid on its fields');
  assert.ok(supportPage.includes("classList.toggle('input-error'"), 'the support form marks failed fields with the error class');
  assert.ok(supportPage.includes('input.input-error'), 'the support form has a red-border rule for marked fields');
  assert.ok(supportPage.includes('select.input-error'), 'the red-border rule covers the category select too');
  assert.ok(supportPage.includes("classList.contains('input-error')"), 'the support form clears the mark once a field is fixed');
});

test('the support add-ons add to the cart instead of linking away', () => {
  // Live-verified 2026-11-18: the "Add" button on every support add-on row
  // navigated to /pricing#addons instead of adding the item to the cart,
  // so a client had to leave the page and find the add-on again. The rows
  // now use the same CartButton as the pricing page, with prices derived
  // from the shared cart catalog, and the FAQ says so.
  const supportPage = read('src/components/pages/SupportPage.astro');
  assert.equal(supportPage.includes('pricing#addons'), false, 'no support add-on row links away to the pricing page');
  assert.ok(supportPage.includes('<CartButton'), 'the support add-on rows use the cart button');
  assert.ok(supportPage.includes('cartProducts'), 'the support add-on prices come from the shared cart catalog');
  assert.ok(supportPage.includes('type="addon"'), 'the support add-on buttons are add-on buttons');
  assert.match(en.support.faq.items[1].a, /list above/, 'the English add-on FAQ points at the list on this page');
  assert.match(fr.support.faq.items[1].a, /liste ci-dessus/, 'the French add-on FAQ points at the list on this page');
});

test('the contact form marks the fields that failed, like the start page', () => {
  // Live-verified 2026-11-16: an empty submit moved focus to the name
  // field but left every field with a grey border and no aria-invalid, so
  // neither a sighted visitor nor a screen reader could tell which fields
  // had failed. The start page already marks its fields, so the contact
  // form mirrors it instead of inventing a second pattern.
  const contactPage = read('src/components/pages/ContactPage.astro');
  assert.ok(contactPage.includes("setAttribute('aria-invalid'"), 'the contact form sets aria-invalid on its fields');
  assert.ok(contactPage.includes("classList.toggle('input-error'"), 'the contact form marks failed fields with the error class');
  assert.ok(contactPage.includes('input.input-error'), 'the contact form has a red-border rule for marked fields');
  assert.ok(contactPage.includes("classList.contains('input-error')"), 'the contact form clears the mark once a field is fixed');
  // The start page's empty-cart error is announced, not just shown.
  const startPage = read('src/components/pages/StartPage.astro');
  assert.ok(
    startPage.includes('<p class="field-error mono sel-error" role="alert" data-start-selection-error hidden>'),
    'the selection error is announced to screen readers',
  );
  assert.equal(startPage.includes('data-astro-reload'), false, 'the start form has no dead reload attribute');
});

test('the hero shows a random live demo and the intro lives only in the archive', () => {
  const home = read('src/components/pages/HomePage.astro');
  assert.ok(home.includes('<HeroPreview locale={locale} />'), 'the hero renders the live demo preview');
  assert.equal(home.includes('hero-stars'), false, 'the hero stars are gone');
  assert.ok(
    home.includes('<a href={paths.pricing} class="btn btn--on-dark btn--lg">{t.home.finalCta.ctaPrimary}</a>'),
    'the final CTA is one normal button',
  );
  assert.equal(home.includes('cta-statement-title'), false, 'the final CTA title is gone');
  assert.equal(home.includes('btn--crack'), false, 'the crack button is gone');
  const preview = read('src/components/home/HeroPreview.astro');
  assert.ok(preview.includes('Math.floor(Math.random() * demos.length)'), 'the preview picks a random demo on every load');
  assert.ok(preview.includes('liveDemoIds'), 'the preview draws from the live demos only');
  // Intro archived, not live.
  assert.ok(existsSync('src/archive/intro-animation/IntroSequence.astro'), 'the archived intro component exists');
  assert.ok(existsSync('src/archive/intro-animation/README.md'), 'the archive explains how to restore it');
  assert.equal(existsSync('src/components/anim/IntroSequence.astro'), false, 'the live intro component is gone');
  assert.equal(existsSync('src/lib/intro/config.ts'), false, 'the live intro config is gone');
  assert.equal(existsSync('src/lib/intro/engine.ts'), false, 'the live intro engine is gone');
  assert.equal(existsSync('tests/intro-engine.test.ts'), false, 'the live intro test is gone');
  const indexEn = read('src/pages/index.astro');
  assert.equal(indexEn.includes('IntroSequence'), false, 'the EN home page no longer renders the intro');
  const indexFr = read('src/pages/fr/index.astro');
  assert.equal(indexFr.includes('IntroSequence'), false, 'the FR home page no longer renders the intro');
});

test('the header dropdown carries the client portal and the estimator uses current tiers', () => {
  const layout = read('src/layouts/BaseLayout.astro');
  assert.ok(layout.includes('data-mega-trigger'), 'the header has the Services dropdown trigger');
  assert.ok(layout.includes('data-mega-panel'), 'the header has the dropdown panel');
  assert.ok(layout.includes('data-mega-scrim'), 'the dropdown has a scrim');
  assert.ok(layout.includes('href={navLinks.portal}'), 'the client portal is in the header dropdown');
  assert.ok(layout.includes('href={navLinks.serviceHosting}'), 'hosting is in the dropdown');
  assert.ok(layout.includes('href={navLinks.serviceMontreal}'), 'Montreal is in the dropdown');
  const panel = layout.split('id="mobile-panel"')[1];
  assert.ok(panel.includes('href={navLinks.portal}'), 'the mobile panel has the portal link');
  assert.ok(panel.includes('href={navLinks.serviceDesign}'), 'the mobile panel has the services link');
  const estimator = read('src/components/pricing/PlanEstimator.astro');
  assert.ok(estimator.includes('value="5"'), 'the quiz offers 1 to 5 pages');
  assert.ok(estimator.includes('value="10"'), 'the quiz offers 5 to 10 pages');
  assert.ok(estimator.includes('value="20"'), 'the quiz offers 10 to 20 pages');
  assert.ok(estimator.includes('if (pages === "20") id = "scale";'), '10 to 20 pages recommends Scale');
  assert.ok(estimator.includes('else if (pages === "10" || job !== "inform") id = "grow";'), '5 to 10 pages, or a booking/sales job, recommends Grow');
  const en = read('src/lib/i18n/en.ts');
  assert.ok(en.includes('title: "Find your plan in 5 seconds"'), 'the quiz title is 5 seconds, not 15');
  assert.ok(en.includes('one channel from C$649.99/mo'), 'the ads note carries the current single-channel price');
  const home = read('src/components/pages/HomePage.astro');
  assert.ok(home.includes('<PlanEstimator locale={locale} />'), 'the home page shows the quiz');
  const pricing = read('src/components/pages/PricingPage2.astro');
  assert.ok(pricing.includes('<PlanEstimator locale={locale} showCompare={false} />'), 'the live pricing page shows the quiz without the compare link');
});

test('the audit pages show what a report looks like, labelled as an example', () => {
  // The sample scores are illustrative, so the page says so in both
  // locales; a real audit result never appears on the landing page.
  const enAudit = read('src/pages/audit.astro');
  assert.ok(enAudit.includes('What a report looks like'), 'the EN audit page has the sample-report section');
  assert.ok(enAudit.includes('Example scores for an example site, not a real audit.'), 'the EN sample is labelled as an example');
  assert.ok(enAudit.includes('52/100') && enAudit.includes('61/100') && enAudit.includes('48/100'), 'the EN sample shows three example scores');
  const frAudit = read('src/pages/fr/eval.astro');
  assert.ok(frAudit.includes('À quoi ressemble un rapport'), 'the FR audit page has the sample-report section');
  assert.ok(frAudit.includes("Scores d'exemple pour un site fictif, pas un vrai audit."), 'the FR sample is labelled as an example');
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
  assert.ok(frPme.includes('sont incluses dans les frais mensuels'), 'the FR small-business FAQ agrees "mises à jour" with "incluses" and uses the plural "frais"');
  // "Frais" is a plural-only noun: the FR service pages used the singular
  // articles "le / un / aucun" with it ("le frais mensuel", "Aucun frais
  // d'installation"), while the pricing copy already uses the correct
  // "Aucuns frais" / "les frais mensuels". No singular-article "frais"
  // may remain in any FR service page.
  const frServicePages = [
    ...frServices,
    'src/pages/fr/services/hebergement-entretien-site-web/index.astro',
  ];
  for (const path of frServicePages) {
    const page = read(path);
    for (const bad of ['le frais ', 'un frais', 'Aucun frais']) {
      assert.equal(page.includes(bad), false, `${path} has no "${bad}" left`);
    }
  }
  // The Montreal pages name the 47-demo catalog as the source of the demo
  // directions; the mention links to the catalog instead of leaving the
  // reader to find it.
  const montrealEn = read('src/pages/services/montreal-web-design/index.astro');
  assert.ok(montrealEn.includes('href: "/demos/"'), 'EN Montreal page links to the demo catalog');
  const montrealFr = read('src/pages/fr/services/conception-site-web-montreal/index.astro');
  assert.ok(montrealFr.includes('href: "/fr/demos/"'), 'FR Montreal page links to the demo catalog');
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

test('the guide pages link the start page and use the plural of "frais"', () => {
  // Every guide's "How to start" copy says "Go to /start ..." / "Allez à
  // /fr/commencer ..." as plain text, while the page's only start links
  // were the two buttons. GuidePage now renders the start path as a link
  // in section bodies, items, subsection bodies and FAQ answers. And
  // "frais" is plural-only in French, so "Aucun frais" is wrong where the
  // guides used it; the site's own pricing copy says "Aucuns frais".
  const component = read('src/components/pages/GuidePage.astro');
  assert.ok(component.includes('const startPath = paths.start'), 'GuidePage reads the locale start path');
  assert.ok(component.includes('startLinkParts(section.body)'), 'GuidePage linkifies section bodies');
  assert.ok(component.includes('startLinkParts(item)'), 'GuidePage linkifies section items');
  assert.ok(component.includes('startLinkParts(sub.body)'), 'GuidePage linkifies subsection bodies');
  assert.ok(component.includes('startLinkParts(item.a)'), 'GuidePage linkifies FAQ answers');
  const guideFiles = [
    'src/pages/guides/ai-receptionist-small-business/index.astro',
    'src/pages/guides/meta-vs-google-ads-small-business/index.astro',
    'src/pages/guides/quebec-bill-96-website/index.astro',
    'src/pages/guides/quebec-law-25-website/index.astro',
    'src/pages/guides/small-business-seo-basics/index.astro',
    'src/pages/guides/website-cost-canada/index.astro',
    'src/pages/guides/website-that-brings-quote-requests/index.astro',
    'src/pages/guides/what-to-prepare-for-your-website/index.astro',
    'src/pages/guides/when-to-redesign-your-website/index.astro',
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
  for (const path of guideFiles) {
    const page = read(path);
    // The helper renders one link per string, so a string must not hold
    // the start path twice.
    for (const match of page.matchAll(/"([^"]*(?:\/start|\/fr\/commencer)[^"]*)"/g)) {
      const text = match[1];
      const count = (text.match(/\/start/g) ?? []).length + (text.match(/\/fr\/commencer/g) ?? []).length;
      assert.equal(count, 1, `${path} holds the start path once per string`);
    }
    assert.equal(page.includes('Aucun frais'), false, `${path} has no singular "Aucun frais" left`);
  }
  assert.ok(read('src/pages/fr/guides/cout-site-web-canada/index.astro').includes('Aucuns frais'), 'the FR cost guide uses "Aucuns frais"');
});

test('the mobile menu fits short viewports', () => {
  // The panel is position: fixed, so on a landscape phone (about 375px
  // tall) its roughly 450px of links, theme row and language switcher
  // run past the bottom edge with no way to reach them. The panel must
  // cap its own height at the viewport below the header and scroll.
  const css = read('src/styles/global.css');
  const at = css.indexOf('.mobile-panel {');
  assert.ok(at > 0, 'the mobile panel rule exists');
  const block = css.slice(at, css.indexOf('}', at));
  assert.match(block, /max-height:\s*calc\(100dvh - var\(--header-h\)\)/, 'the panel caps its height at the viewport');
  assert.match(block, /overflow-y:\s*auto/, 'the panel scrolls when it is taller than the viewport');
});

test('the header controls meet the 44px touch target and the row still fits at 320px', () => {
  // The menu toggle, theme toggle and mobile flag toggle sat at 40px,
  // below the site's 44px minimum (EscapeHatch, portal buttons,
  // carousel nav, pricing cart button, header cart button) — the theme
  // toggle live-measured 40x40 on webao.ca 2026-11-21, the menu button
  // hidden at desktop width. At 44px each, the smallest-phone row needs
  // the 360px tightening (26px brand, 6px gaps, 8px inner gap) to stay
  // inside the 288px available at a 320px viewport.
  const css = read('src/styles/global.css');
  const rule = (selector: string): string => {
    const at = css.indexOf(selector);
    assert.ok(at > 0, `${selector} rule exists`);
    return css.slice(at, css.indexOf('}', at));
  };
  for (const selector of ['.menu-toggle {', '.theme-toggle {']) {
    const block = rule(selector);
    assert.match(block, /width:\s*44px/, `${selector} is 44px wide`);
    assert.match(block, /height:\s*44px/, `${selector} is 44px tall`);
  }
  const switcher = read('src/components/ui/LanguageSwitcher.astro');
  const toggleAt = switcher.indexOf('.lang-switcher.lang-toggle {');
  assert.ok(toggleAt > 0, 'the flag toggle rule exists');
  const toggleBlock = switcher.slice(toggleAt, switcher.indexOf('}', toggleAt));
  assert.match(toggleBlock, /width:\s*44px/, 'the flag toggle is 44px wide');
  assert.match(toggleBlock, /height:\s*44px/, 'the flag toggle is 44px tall');
  const narrow = css.slice(css.indexOf('@media (max-width: 360px)'));
  assert.match(narrow, /\.brand-logo \{\s*height:\s*26px/, 'the brand shrinks to 26px at 360px');
  assert.match(narrow, /\.header-right \{\s*gap:\s*6px/, 'the header gaps tighten to 6px at 360px');
  assert.match(narrow, /\.header-inner \{\s*gap:\s*8px/, 'the inner gap tightens to 8px at 360px');
});

test('the mobile menu Escape handler does not pile up, and the chrome keeps no dead selectors', () => {
  // initLayout runs on every astro:page-load, and the menu's Escape
  // handler is a document-level listener: the old code added a new one
  // per client-router navigation while the panel it closed was already
  // detached, so stale listeners accumulated for the session. The stored
  // handler is now removed before the new one is added, the same pattern
  // as scrollCleanup. The chrome also carried selectors that could never
  // match: .brand-mark / .brand-domain have no such element anywhere,
  // .mobile-panel a:last-child never matches (the switcher div is the
  // panel's last child), and navLinks.process was never read. The footer
  // Ads link now lands on the Ads Pack section instead of the top of
  // the pricing page: the #ads-h anchor already exists there.
  const layout = read('src/layouts/BaseLayout.astro');
  assert.match(layout, /let menuKeyHandler: \(\(e: KeyboardEvent\) => void\) \| null = null/, 'the handler is stored module-level');
  assert.match(layout, /document\.removeEventListener\('keydown', menuKeyHandler\)/, 'the old handler is removed before the new one is added');
  assert.match(layout, /menuKeyHandler = onKeyDown/, 'the new handler is stored');
  assert.ok(layout.includes('href={`${navLinks.pricing}#ads-h`}>{t.footer.adsPackages}'), 'the footer Ads link lands on the Ads Pack section');
  assert.equal(layout.includes('process: locale === "fr"'), false, 'the unused navLinks.process key is gone');
  const css = read('src/styles/global.css');
  assert.equal(css.includes('.brand-mark'), false, 'no .brand-mark rule remains');
  assert.equal(css.includes('.brand-domain'), false, 'no .brand-domain rule remains');
  assert.equal(css.includes('.mobile-panel a:last-child'), false, 'no .mobile-panel a:last-child rule remains');
});

test('the portal names what is still missing after a partial save, and shows the real ads budget floor', () => {
  // A partial onboarding save used to answer a bare "Saved.", so a client
  // could walk away thinking the build would start, while the "Still
  // needed: ..." template sat unused. The ads budget label likewise said
  // "min $1,500" for every pack, although Starter is $750 and both
  // channels $2,500; the ads services field also carried a "*" it never
  // had to earn (ads completeness does not require services).
  const portal = read('src/components/pages/PortalPage.astro');
  assert.ok(portal.includes('msg("[data-portal-msg-required]")'), 'the submit handler reads the still-needed template');
  assert.ok(portal.includes('r.data.client.onboardingComplete'), 'the submit handler branches on completeness');
  assert.ok(portal.includes('missingOnboarding(payload)'), 'the submit handler lists the missing fields');
  assert.ok(portal.includes('missingAds(r.data.ads)'), 'the ads submit handler lists the missing fields');
  assert.ok(portal.includes('r.data.ads.complete'), 'the ads submit handler branches on completeness');
  assert.ok(portal.includes('data-portal-msg-ads-budget'), 'the ads budget pattern template exists');
  assert.ok(portal.includes('client.ads.minBudget'), 'the budget label is rewritten from the per-variant floor');
  assert.ok(portal.includes('{copy.adsServices}'), 'the ads form uses its own services label');
  assert.ok(portal.includes('adsServices: "Your services"'), 'the EN ads services label has no asterisk');
  assert.ok(portal.includes('adsServices: "Vos services"'), 'the FR ads services label has no asterisk');
  assert.ok(portal.includes('adsBudgetPattern: "Monthly ad budget (min ${n})"'), 'the EN budget pattern takes the real floor');
  assert.ok(portal.includes('adsBudgetPattern: "Budget publicitaire mensuel (min {n} $)"'), 'the FR budget pattern takes the real floor');
  assert.ok(portal.includes('data-portal-changes-note rows="3" placeholder={copy.reviewNotePh} aria-label={copy.reviewNotePh}'), 'the review-changes note has an accessible name');
  assert.ok(portal.includes('client.business !== client.email'), 'the identity line does not repeat the email when no business name is set');
});

test('the portal survives a dropped connection, guards the ads save, and says what a blank review note needs', () => {
  // The portal's shared api() helper had no fetch-level catch, so a
  // dropped connection rejected the promise and left every submit frozen
  // (button disabled, status stuck on "Saving…" with no way back), while
  // the contact and support forms already catch their submits. The ads
  // form was also the only portal submit without an in-flight guard, so
  // a double-click saved twice. And sending review changes with an empty
  // note answered the generic "Something did not work", a dead end that
  // read as a failed send.
  const portal = read('src/components/pages/PortalPage.astro');
  assert.ok(portal.includes('.catch(function () { return { status: 0, data: { ok: false } }; })'), 'a failed fetch answers ok:false instead of rejecting');
  assert.ok(portal.includes("root.querySelector('[data-portal-ads-form] button[type=\"submit\"]')"), 'the ads submit handler holds its save button');
  assert.ok(portal.includes('btn.disabled = false;\n        if (r.data.ok) {'), 'the ads save button is re-enabled on the save response');
  assert.ok(portal.includes('reviewEmptyNote: "Write what should change before sending."'), 'the EN empty-note message exists');
  assert.ok(portal.includes('reviewEmptyNote: "Écrivez ce qui doit changer avant d\'envoyer."'), 'the FR empty-note message exists');
  assert.ok(portal.includes('data-portal-msg-review-empty'), 'the empty-note template is rendered for the script');
  assert.ok(portal.includes('msg("[data-portal-msg-review-empty]")'), 'an empty review note shows the empty-note message, not the generic error');
  assert.ok(portal.includes('root.querySelector("[data-portal-changes-note]").focus();'), 'an empty review note moves focus into the note field');
  assert.ok(portal.includes('if (!r.data.ok) return;\n        current = null;'), 'sign-out only switches to the sign-in form once the server confirms');
});

test('the homepage timeline agrees with the FAQ: two to three weeks, not one week', () => {
  // The process heading once said "about a week" while the FAQ and the
  // service pages said "2 to 3 weeks", and the scrub readout counted
  // DAY 0..7 to match. Both locales now count weeks, and the carousel
  // sub no longer claims every frame is a real homepage screenshot:
  // boreal and rive-nord have no carousel image (repo or KV), so their
  // panels render the name/tone fallback while the card still opens the
  // real demo homepage.
  const cases = [
    { locale: en, title: 'two to three weeks', weekLabel: 'WEEK', faqWeeks: '2 to 3 weeks', opens: 'opens the real homepage' },
    { locale: fr, title: 'deux à trois semaines', weekLabel: 'SEMAINE', faqWeeks: '2 à 3 semaines', opens: 'ouvre la page d’accueil réelle' },
  ] as const;
  for (const { locale, title, weekLabel, faqWeeks, opens } of cases) {
    assert.match(locale.home.process.title, new RegExp(title), 'process title states the real timeline');
    assert.equal(locale.home.process.week, weekLabel, 'process readout counts weeks');
    assert.equal('day' in locale.home.process, false, 'no day key left to revive the 7-day readout');
    assert.ok(locale.home.faq.items.some((item) => item.a.includes(faqWeeks)), 'the FAQ states the same timeline');
    assert.match(locale.home.proof.sub, new RegExp(opens), 'carousel sub says the card opens the real homepage');
    assert.doesNotMatch(locale.home.proof.sub, /Every frame is the real homepage|Chaque vignette est la page/, 'carousel sub does not overclaim');
  }
  const home = read('src/components/pages/HomePage.astro');
  assert.ok(home.includes('data-week-readout'), 'the scrub readout is a week readout');
  assert.ok(!home.includes('data-day-readout'), 'no day readout remains');
  assert.ok(!home.includes('Math.round(progress * 7)'), 'no 7-day readout math remains');
});

test('the pricing cart button meets the 44px touch target', () => {
  // The add-to-cart button is the conversion control on every pricing
  // card (plans, bundles, Ads Pack, AI, add-ons), and the site's own
  // minimum touch target is 44px (EscapeHatch, portal buttons,
  // carousel nav). At 36px it was the smallest tap target on the page.
  const btn = read('src/components/pricing/CartButton.astro');
  const at = btn.indexOf('.cart-btn {');
  assert.ok(at > 0, 'the cart button rule exists');
  const block = btn.slice(at, btn.indexOf('}', at));
  assert.match(block, /width:\s*44px/, 'the cart button is 44px wide');
  assert.match(block, /height:\s*44px/, 'the cart button is 44px tall');
});

test('the cart drawer controls meet the 44px touch target', () => {
  // The rest of the cart's controls sat below the site's 44px minimum:
  // the header cart button (40px), the drawer close (36px), the per-item
  // remove (28px), the empty-cart pill (~35px) and the conflict popup
  // close (32px) — live-measured on webao.ca 2026-11-15. The conflict
  // title also needs 60px of right clearance so it cannot run under
  // the wider close button (44px + 16px from the edge).
  const layout = read('src/layouts/BaseLayout.astro');
  const rule = (selector: string): string => {
    const at = layout.indexOf(selector);
    assert.ok(at > 0, `${selector} rule exists`);
    return layout.slice(at, layout.indexOf('}', at));
  };
  for (const selector of ['.header-cart-btn {', '.cart-drawer-close {', ':global(.cart-item-remove) {', '.cart-conflict-close {']) {
    const block = rule(selector);
    assert.match(block, /width:\s*44px/, `${selector} is 44px wide`);
    assert.match(block, /height:\s*44px/, `${selector} is 44px tall`);
  }
  const emptyAll = rule('.cart-empty-all {');
  assert.match(emptyAll, /min-height:\s*44px/, 'the empty-cart pill is at least 44px tall');
  const title = rule('.cart-conflict-title {');
  assert.match(title, /margin:\s*0 60px 8px 0/, 'the conflict title clears the close button');
});

test('an empty cart shows its message once on the checkout page', () => {
  // The empty message used to render twice on /checkout and /fr/checkout:
  // once in the summary slot (renderItems) and once in the payment box
  // (the loading line) — live-verified on webao.ca 2026-11-15. The
  // empty branch now hides the payment box instead of printing it again.
  const page = read('src/components/pages/CheckoutPage.astro');
  const at = page.indexOf('if (cartItems.length === 0) {');
  assert.ok(at > 0, 'the empty-cart branch exists');
  const block = page.slice(at, page.indexOf('return;', at));
  assert.match(block, /stripe-checkout/, 'the branch touches the payment box');
  assert.match(block, /\.hidden = true/, 'the branch hides the payment box');
  assert.doesNotMatch(block, /checkoutEmpty/, 'the branch does not print the message again');
});

test('the add-on rows keep the cart button on the name row', () => {
  // The add-on row grid had three columns for four children (number,
  // name, price, cart button), so the button wrapped onto a second row
  // under the row number on every add-on row, desktop and mobile alike.
  const list = read('src/components/pricing/AddonList.astro');
  // The noscript block has its own .addon-reveal-inner rule first, so
  // match the main rule by its position: relative opener.
  assert.match(
    list,
    /\.addon-reveal-inner \{\s*position: relative;[^}]*grid-template-columns:\s*auto 1fr auto auto/,
    'the row grid has a fourth column for the cart button',
  );
});

test('the terms search hides sections left with no matching note', () => {
  // Filtering used to hide the notes but leave every section heading
  // standing: searching "cancel" left "Plans", "Features & services",
  // "Bundles" and "Add-ons" as empty headings (live-verified on
  // webao.ca/terms and /fr/conditions 2026-11-17). A filtered view now
  // hides a section when none of its notes is visible, and clearing the
  // search brings every section back.
  const page = read('src/components/pages/TermsPage.astro');
  assert.ok(page.includes('querySelectorAll("[data-term-section]")'), 'the script collects the sections');
  assert.match(page, /sections\[s\]\.hidden = !anyVisible/, 'a section hides when no note in it is visible');
  assert.match(page, /for \(var s = 0; s < sections\.length; s\+\+\) sections\[s\]\.hidden = false/, 'clearing the search restores every section');
});

test('the terms search controls meet the 44px touch target', () => {
  // The search clear button (30px) and the prev/next buttons (34px)
  // sat below the site's 44px minimum touch target (EscapeHatch,
  // portal buttons, carousel nav, pricing cart button) — live-measured
  // on webao.ca/terms 2026-11-17 (32px rendered). The input grows its
  // padding so the 44px clear button fits inside it, and the browser's
  // own search cancel button is hidden: it used to appear next to ours
  // while typing, two x's side by side.
  const page = read('src/components/pages/TermsPage.astro');
  const rule = (selector: string): string => {
    const at = page.indexOf(selector);
    assert.ok(at > 0, `${selector} rule exists`);
    return page.slice(at, page.indexOf('}', at));
  };
  for (const selector of ['.search-clear {', '.search-nav {']) {
    const block = rule(selector);
    assert.match(block, /width:\s*44px/, `${selector} is 44px wide`);
    assert.match(block, /height:\s*44px/, `${selector} is 44px tall`);
  }
  const input = rule('.search-field input {');
  assert.match(input, /padding:\s*14px 56px 14px 40px/, 'the input clears the 44px clear button');
  assert.match(page, /::-webkit-search-cancel-button/, 'the native search cancel button is hidden');
});
