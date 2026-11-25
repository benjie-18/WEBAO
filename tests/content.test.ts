// Content model: the demo catalog, the pricing-plan structure and the
// footnote cross-references must agree with each other and with the
// dictionaries they are rendered from.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { demos } from '../src/lib/demos';
import en from '../src/lib/i18n/en';
import fr from '../src/lib/i18n/fr';
import { cartProducts } from '../src/lib/cart-catalog';
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
  // The old hero visual (browser-frame preview with floating cards) was
  // replaced by the live demo preview, but its parallax script, its CSS
  // and the intro-handoff wait survived: no element carries data-parallax
  // any more, so the mousemove loop only ever moved nulls, and the intro
  // is archived, so the wait could never fire.
  assert.equal(home.includes('data-parallax'), false, 'the hero parallax is gone');
  assert.equal(home.includes('wi-run'), false, 'the intro-handoff wait is gone');
  assert.equal(home.includes('wi-released'), false, 'no intro release class is waited on');
  assert.equal(home.includes('.hero-visual'), false, 'the old hero visual CSS is gone');
  assert.equal(home.includes('.visual-stack'), false, 'the old preview frame CSS is gone');
  assert.equal(home.includes('.float-card'), false, 'the old floating-card CSS is gone');
  assert.equal(home.includes('hero-visual-in'), false, 'the old hero visual keyframes are gone');
  // The craft collage label is localized, not hardcoded English on the FR page.
  assert.ok(home.includes('aria-label={t.home.craft.collageAlt}'), 'the craft collage label comes from i18n');
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

test('the header dropdown drops guides and website design, and the estimator starts from services', () => {
  const layout = read('src/layouts/BaseLayout.astro');
  assert.ok(layout.includes('data-mega-trigger'), 'the header has the Services dropdown trigger');
  assert.ok(layout.includes('data-mega-panel'), 'the header has the dropdown panel');
  assert.ok(layout.includes('data-mega-scrim'), 'the dropdown has a scrim');
  assert.ok(layout.includes('href={navLinks.portal}'), 'the client portal is in the header dropdown');
  assert.ok(layout.includes('href={navLinks.serviceHosting}'), 'hosting is in the dropdown');
  assert.ok(layout.includes('href={navLinks.serviceMontreal}'), 'Montreal is in the dropdown');
  const header = layout.split('<main id="main">')[0];
  assert.equal(header.includes('href={navLinks.serviceDesign}'), false, 'website design is out of the header');
  assert.equal(header.includes('href={navLinks.guideIndex}'), false, 'guides are out of the header');
  const panel = layout.split('id="mobile-panel"')[1].split('<main id="main">')[0];
  assert.ok(panel.includes('href={navLinks.portal}'), 'the mobile panel has the portal link');
  assert.equal(panel.includes('href={navLinks.serviceDesign}'), false, 'the mobile panel has no website design link');
  assert.equal(panel.includes('href={navLinks.guideIndex}'), false, 'the mobile panel has no guides link');
  const estimator = read('src/components/pricing/PlanEstimator.astro');
  assert.ok(estimator.includes('name="est-service"'), 'the quiz starts from the service');
  assert.ok(estimator.includes('value="website"'), 'the quiz offers a website');
  assert.ok(estimator.includes('value="ads"'), 'the quiz offers advertising');
  assert.ok(estimator.includes('value="ai"'), 'the quiz offers AI help');
  assert.ok(estimator.includes('value="all"'), 'the quiz offers all three services');
  assert.ok(estimator.includes('value="ads-starter"'), 'the quiz offers the Meta test first');
  assert.ok(estimator.includes('value="ads-both"'), 'the quiz offers both ad channels');
  assert.ok(estimator.includes('value="ai-receptionist"'), 'the quiz offers the receptionist');
  assert.ok(estimator.includes('value="ai-pack"'), 'the quiz offers the AI pack');
  assert.ok(estimator.includes('if (pages === "20") id = "scale";'), '10 to 20 pages recommends Scale');
  assert.ok(estimator.includes('else if (pages === "10" || job !== "inform") id = "grow";'), '5 to 10 pages, or a booking/sales job, recommends Grow');
  assert.ok(estimator.includes('id = "growth-engine";'), 'all three services recommend the Growth Engine');
  assert.ok(estimator.includes('cartProducts[product]'), 'the quiz prices come from the cart catalog');
  assert.ok(estimator.includes('btn.dataset.priceYear = r.yearCents ? String(r.yearCents) : "";'), 'monthly-only recommendations carry no yearly price');
  const en = read('src/lib/i18n/en.ts');
  assert.ok(en.includes('title: "Find what you need in 5 seconds"'), 'the quiz title is 5 seconds, not 15');
  const adsCard = read('src/components/pricing/AdsPackCard.astro');
  assert.ok(adsCard.includes('priceCentsFor("ads-meta", "month")'), 'the ads card prices the single channel from the catalog');
  assert.ok(adsCard.includes('priceCentsFor("ads-both", "month")'), 'the ads card prices both channels from the catalog');
  assert.equal(adsCard.includes('89999'), false, 'the ads card carries no stale single-channel cents');
  assert.equal(adsCard.includes('134999'), false, 'the ads card carries no stale both-channels cents');
  const aiCards = read('src/components/pricing/AiPackCards.astro');
  assert.ok(aiCards.includes('priceCentsFor("ai-receptionist", "month")'), 'the AI cards price the receptionist from the catalog');
  assert.ok(aiCards.includes('priceCentsFor("ai-pack", "month")'), 'the AI cards price the pack from the catalog');
  const home = read('src/components/pages/HomePage.astro');
  assert.ok(home.includes('<PlanEstimator locale={locale} />'), 'the home page shows the quiz');
  const pricing = read('src/components/pages/PricingPage2.astro');
  assert.ok(pricing.includes('<PlanEstimator locale={locale} showCompare={false} service="website" />'), 'the live pricing page shows the quiz without the compare link, website-only');
});

test('the quiz works after a ClientRouter navigation, and the pricing quiz is website-only', () => {
  // The quiz was dead after a ClientRouter navigation (home -> /pricing):
  // the module script runs once per page load and never re-bound, so
  // clicking an option did nothing. Same failure the pills had, same fix.
  const estimator = read('src/components/pricing/PlanEstimator.astro');
  assert.ok(estimator.includes('<script data-astro-rerun>'), 'the quiz script re-runs on navigation');
  assert.ok(estimator.includes('document.addEventListener("astro:page-load", initEstimators)'), 'the quiz re-inits on page-load');
  assert.ok(estimator.includes('if (el.dataset.estimatorInit === "1") return;'), 'a re-init does not double-bind');
  assert.ok(estimator.includes('render();'), 'the follow-ups show on init, not only on change');
  // On /pricing the visitor already picked the service with the pill, so
  // the quiz there skips the service question and opens the website
  // follow-ups directly instead of proposing all services.
  assert.ok(estimator.includes('data-est-fixed-service={service}'), 'the fixed service reaches the script');
  assert.ok(estimator.includes('hidden={service !== undefined}'), 'the service question hides when the service is fixed');
  assert.ok(estimator.includes('return fixedService || read("est-service");'), 'the fixed service drives the follow-ups');
  assert.ok(estimator.includes('.estimator-q[hidden] {'), 'the hidden service question is really hidden (display: grid would beat hidden)');
  // The home quiz keeps the full service picker: no fixed service there.
  const home = read('src/components/pages/HomePage.astro');
  assert.ok(home.includes('<PlanEstimator locale={locale} />'), 'the home quiz still asks the service first');
});

test('the pricing card buttons wrap instead of cutting the label off', () => {
  // "Choose Scale · C$3,499.90/yr →" outgrows the plan button below
  // about 1150px of viewport (the card keeps 52px of inline padding),
  // and .btn's nowrap + overflow: clip cut it off instead of wrapping.
  const css = read('src/styles/global.css');
  const at = css.indexOf('.btn [data-cta-label] {');
  assert.ok(at > 0, 'the pricing CTA label rule exists');
  const block = css.slice(at, css.indexOf('}', at));
  assert.match(block, /white-space:\s*normal/, 'the label wraps to a second line');
  assert.match(block, /line-height:\s*1\.35/, 'the wrapped label keeps readable line height');
});

test('the pricing chooser has no Services pill: Ads, Web and Services only', () => {
  // The Services pill showed all three panels at once and was removed:
  // the chooser is three tabs, Web by default.
  const page = read('src/components/pages/PricingPage2.astro');
  assert.ok(!page.includes('data-service-pill="services"'), 'no Services pill in the chooser');
  assert.ok(!page.includes('p2-tab-services'), 'no Services pill id');
  assert.ok(!page.includes('ALL_PANELS'), 'no show-all branch left in the switch script');
  for (const pill of ['ads', 'web', 'ai']) {
    assert.ok(page.includes(`data-service-pill="${pill}"`), `the ${pill} pill is still there`);
  }
  assert.ok(page.includes('var order = ["ads", "web", "ai"];'), 'arrow keys walk Ads, Web, AI');
});

test('the Ads Starter trial is always visible in the Ads card', () => {
  // The trial vanished whenever yearly billing was active or the
  // channel was not Meta: the card hid it on both. It is a separate
  // trial block now, always shown, and its own copy says Meta-only.
  const card = read('src/components/pricing/AdsPackCard.astro');
  assert.ok(card.includes('data-ads-starter'), 'the trial block is in the card');
  assert.ok(!card.includes('syncStarter'), 'no channel/billing hiding logic left');
  assert.ok(!card.includes('isYearlyBilling'), 'no yearly check left');
  assert.ok(!card.includes('.bc-starter[hidden]'), 'no hidden rule left for the trial block');
});

test('the bundle carousel cards clear the pills on short viewports', () => {
  // The tallest bundle card covered the pills row on short viewports:
  // the old scale only subtracted 100px and divided by 560px, which
  // assumed a shorter card and no UI zone at the stage bottom.
  const carousel = read('src/components/pricing/BundleCarousel.astro');
  const at = carousel.indexOf('.bcard {');
  assert.ok(at > 0, 'the card rule exists');
  const block = carousel.slice(at, carousel.indexOf('}', carousel.indexOf('scale:', at)) + 1);
  assert.match(block, /top:\s*42%/, 'the card sits higher in the stage');
  assert.match(block, /scale:\s*min\(1, calc\(\(100svh - 280px\) \/ 720px\)\)/, 'the scale reserves the pills zone and the tallest card');
  // The pill and arrow targets used the full scroll distance while
  // progress() reaches 1 at 70% of it, so the third card's target read
  // as progress 0.95 and rounded up to the fourth: its pill could never
  // be landed on. All three conversions share one factor now.
  assert.ok(carousel.includes('var progressEnd = 0.7;'), 'one shared progress factor');
  assert.ok(carousel.includes('top + (i / segCount) * progressEnd * total'), 'goTo lands on the card it names');
  assert.ok(carousel.includes('snapY = top + nearest * progressEnd * total;'), 'the snap correction lands on the nearest card');
});

test('the bundle carousel becomes a full-size stacked grid on phones', () => {
  // On a phone the ring's scale (~0.53 on a ~660px viewport, on a 340px
  // card) shrank the bundles to ~180px wide. The scroll stage hides and
  // the static grid shows the same cards full size instead.
  const carousel = read('src/components/pricing/BundleCarousel.astro');
  const at = carousel.indexOf('@media (max-width: 819px)');
  assert.ok(at > 0, 'the phone media query exists');
  const block = carousel.slice(at, carousel.indexOf('</style>', at));
  assert.match(block, /\.bundle-scroll\s*\{\s*display:\s*none;\s*\}/, 'the scroll stage hides on phones');
  assert.match(block, /\.bundle-static\s*\{\s*display:\s*block;\s*\}/, 'the static grid shows on phones');
});

test('the AI services are named without AI: Receptionist, Smart Follow-up, Services', () => {
  // The pill, the /start group and the two product names drop "AI":
  // the tab is Services, the products are Receptionist and Smart Follow-up.
  const en = read('src/lib/i18n/en.ts');
  const fr = read('src/lib/i18n/fr.ts');
  const checkout = read('worker/checkout.ts');
  assert.ok(en.includes('pillAi: "Services"'), 'the EN pill is Services');
  assert.ok(fr.includes('pillAi: "Services"'), 'the FR pill is Services');
  assert.ok(en.includes('aiReceptionist: "Receptionist"'), 'the EN receptionist drops AI');
  assert.ok(fr.includes('aiReceptionist: "Réceptionniste"'), 'the FR receptionist drops IA');
  assert.ok(en.includes('aiFollowup: "Smart Follow-up"'), 'the EN follow-up is Smart Follow-up');
  assert.ok(fr.includes('aiFollowup: "Suivi intelligent"'), 'the FR follow-up is Suivi intelligent');
  assert.ok(checkout.includes('"ai-receptionist": "Receptionist"'), 'checkout names the Receptionist');
  assert.ok(checkout.includes('"ai-followup": "Smart Follow-up"'), 'checkout names the Smart Follow-up');
  for (const [name, src] of [['en', en], ['fr', fr], ['checkout', checkout]]) {
    assert.ok(!src.includes('AI Receptionist'), `no AI Receptionist left in ${name}`);
    assert.ok(!src.includes('AI Follow-up'), `no AI Follow-up left in ${name}`);
  }
});

test('the AI services are yearly available, like the plans', () => {
  // Receptionist and Follow-up were monthly-only; the Online
  // Receptionist already had a yearly term. All three now follow the
  // billing toggle on the card and in the quiz.
  const catalog = read('src/lib/cart-catalog.ts');
  assert.match(catalog, /"ai-receptionist": \{[^}]*yearCents: 29999 \* TEN_MONTHS/, 'Receptionist yearly is 10x monthly');
  assert.match(catalog, /"ai-followup": \{[^}]*yearCents: 9999 \* TEN_MONTHS/, 'Follow-up yearly is 10x monthly');
  const cards = read('src/components/pricing/AiPackCards.astro');
  assert.ok(cards.includes('yearlyPriceCents: priceCentsFor("ai-receptionist", "year")'), 'the Receptionist card offers the yearly term');
  assert.ok(cards.includes('yearlyPriceCents: priceCentsFor("ai-followup", "year")'), 'the Follow-up card offers the yearly term');
  const estimator = read('src/components/pricing/PlanEstimator.astro');
  assert.ok(estimator.includes('yearlyLabel(cartProducts["ai-receptionist"]?.yearCents ?? 0)'), 'the quiz shows the Receptionist yearly price');
  assert.ok(estimator.includes('yearlyLabel(cartProducts["ai-followup"]?.yearCents ?? 0)'), 'the quiz shows the Follow-up yearly price');
});

test('the AI Pack saving is the sum of its three services', () => {
  // The pack card said "Individual value C$499.97/mo" while the three
  // services on the same panel cost C$299.99 + C$149.99 + C$99.99 =
  // C$549.97, so the saving read C$99.98 instead of C$149.98. The
  // guides already state 549.97 / 149.98.
  const month = (id: string) => cartProducts[id].monthCents ?? 0;
  const individual = month('ai-receptionist') + month('aichat') + month('ai-followup');
  const pack = month('ai-pack');
  assert.equal(individual, 54997, 'the three AI services cost C$549.97/mo together');
  assert.equal(pack, 39999, 'the AI Pack costs C$399.99/mo');
  const fmt = (cents: number) => `C$${(cents / 100).toFixed(2)}`;
  for (const [name, dict, suffix] of [['en', en, '/mo'], ['fr', fr, '/mois']] as const) {
    const ai = dict.pricing.ai;
    assert.equal(ai.packIndividualValue, `${fmt(individual)}${suffix}`, `the ${name} pack card states the summed individual value`);
    assert.equal(ai.packMonthlySaving, `${fmt(individual - pack)}${suffix}`, `the ${name} pack card states the real monthly saving`);
  }
  // The two dead pricing keys are gone: the card prices the single
  // channel from metaPrice/bothPrice, and the chooser has no Services pill.
  for (const [name, dict] of [['en', en], ['fr', fr]] as const) {
    assert.equal((dict.pricing.adsPack as Record<string, unknown>).price, undefined, `no unused ads price in ${name}`);
    assert.equal((dict.pricing.revamped as Record<string, unknown>).pillServices, undefined, `no unused Services pill in ${name}`);
  }
});

test('the start summary never overlaps the page below it', () => {
  // When every branch was selected the sticky summary card grew past
  // the viewport and covered the trust strip and directions as they
  // scrolled under it. The card is capped and scrolls internally, the
  // steps live under the form, and the trailing rows sit in the form
  // column, so nothing ever slides under the card.
  const page = read('src/components/pages/StartPage.astro');
  assert.ok(page.includes('max-height: calc(100dvh - 104px);'), 'the summary card is capped to the viewport');
  assert.ok(page.includes('overflow-y: auto;'), 'the capped card scrolls internally');
  assert.ok(!page.includes('grid-column: 1 / -1;'), 'no full-width row left to slide under the card');
  const stepsAt = page.indexOf('<div class="sel-steps">');
  const formAt = page.indexOf('</form>');
  const asideAt = page.indexOf('</aside>');
  assert.ok(stepsAt > formAt && stepsAt > asideAt, 'the steps sit after the form, outside the summary card');
});

test('the demo cards have no dead gap above the action row', () => {
  // The grid stretches each row to its tallest card, and the card link
  // grew (flex: 1) while its children did not, so the extra height sat
  // as an empty gap between the name and the Quick look / Build row.
  const page = read('src/components/pages/DemosPage.astro');
  assert.match(page, /\.demo-thumb \{[^}]*flex:\s*1/, 'the thumb absorbs the stretched height');
});

test('preview pages hide the back button, keep the cursor, and stack the bar', () => {
  // The red back-to-WEBAO pill belongs on the standalone demo page; in
  // an iframe preview the host already has close and open controls.
  const hatch = read('src/components/demos/EscapeHatch.astro');
  assert.ok(hatch.includes('window.self !== window.top'), 'the pill hides when the demo is framed');
  // The custom cursor froze at the iframe edge: pointer events stop at
  // the boundary, so they are forwarded into the parent document.
  const cursor = read('src/components/anim/CustomCursor.astro');
  assert.ok(cursor.includes('scanIframes'), 'iframes are scanned for forwarding');
  assert.ok(cursor.includes('iframe.contentDocument'), 'the iframe document gets the listeners');
  assert.ok(cursor.includes('cursor:none !important'), 'the native cursor is hidden inside the preview');
  // The hero preview bar crowded its arrows under the toggles at the
  // preview's own narrow width; it stacks by container, not viewport.
  const preview = read('src/components/home/HeroPreview.astro');
  assert.ok(preview.includes('container-type: inline-size;'), 'the preview is a container');
  assert.ok(preview.includes('@container (max-width: 640px)'), 'the bar stacks when the preview is narrow');
});

test('the services home and branch pages exist, with the model page treatment', () => {
  for (const [path, key, schema] of [
    ['src/pages/services/index.astro', 'services', 'WEBAO services'],
    ['src/pages/services/websites/index.astro', 'serviceWebsites', 'Website design and monthly plans'],
    ['src/pages/services/ads/index.astro', 'serviceAds', 'Ads Packages'],
    ['src/pages/services/ai/index.astro', 'serviceAi', 'AI services'],
    ['src/pages/fr/services/index.astro', 'services', 'Services WEBAO'],
    ['src/pages/fr/services/sites-web/index.astro', 'serviceWebsites', 'Conception de site web et forfaits mensuels'],
    ['src/pages/fr/services/publicite/index.astro', 'serviceAds', 'Forfaits publicitaires'],
    ['src/pages/fr/services/ia/index.astro', 'serviceAi', 'Services IA'],
  ] as const) {
    const page = read(path);
    assert.ok(page.includes('<ServicePage'), `${path} uses the shared service page`);
    assert.ok(page.includes(`pageKey="${key}"`), `${path} carries pageKey ${key}`);
    assert.ok(page.includes(`name: "${schema}"`), `${path} carries its Service schema`);
    assert.ok(page.includes('serviceSchema={{'), `${path} carries its Service schema`);
  }
  const servicePage = read('src/components/pages/ServicePage.astro');
  assert.ok(servicePage.includes('<RelatedDemos locale={locale} />'), 'service pages show three demo directions');
  assert.ok(servicePage.includes('t.ctaBand.title'), 'service pages end with the what-next band');
  const related = read('src/components/RelatedDemos.astro');
  assert.ok(related.includes('{d.tone}'), 'related demos show the demo tone');
  assert.equal(related.includes('localizedTone'), false, 'no localized tone field is used');
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

test('the desktop mega-menu stays hidden until it opens', () => {
  // The panel carries the hidden attribute until the menu opens, but the
  // .nav-mega rule sets display: flex, and an author display rule beats
  // the browser's built-in hidden styling, so the panel showed on every
  // page, all the time. The [hidden] rule below restores hidden as the
  // source of truth.
  const css = read('src/styles/global.css');
  const at = css.indexOf('.nav-mega[hidden] {');
  assert.ok(at > 0, 'the .nav-mega[hidden] rule exists');
  const block = css.slice(at, css.indexOf('}', at));
  assert.match(block, /display:\s*none/, 'a hidden panel is not displayed');
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

test('the homepage FAQ states the Launch page range and the FR copy uses the plural of "frais"', () => {
  // The $89.99/mo answer once said "a custom 1-page site" while the
  // pricing page says Launch is 1 to 5 pages; the FAQ understated the
  // plan. "Frais" is a plural-only noun: the FR hero lead said "Un seul
  // frais mensuel" and the updates FAQ "dans votre frais mensuel".
  assert.ok(
    en.home.faq.items.some((item) => item.a.includes('a custom site of 1 to 5 pages')),
    'the EN FAQ states the Launch page range',
  );
  assert.ok(
    fr.home.faq.items.some((item) => item.a.includes('un site sur mesure de 1 à 5 pages')),
    'the FR FAQ states the Launch page range',
  );
  assert.equal(fr.home.hero.leadStrong, 'Un seul paiement mensuel.', 'the FR hero lead avoids the singular "frais"');
  assert.ok(
    fr.home.faq.items.some((item) => item.a.includes('incluses dans vos frais mensuels')),
    'the FR updates FAQ uses the plural "frais"',
  );
  const frHome = JSON.stringify(fr.home);
  for (const bad of ['Un seul frais', 'votre frais', 'un frais ', 'le frais ', 'Aucun frais']) {
    assert.equal(frHome.includes(bad), false, `home FR has no "${bad}" left`);
  }
  // The FAQ eyebrow key was dead: the FAQ section renders no eyebrow.
  assert.equal('eyebrow' in en.home.faq, false, 'no dead FAQ eyebrow key in EN');
  assert.equal('eyebrow' in fr.home.faq, false, 'no dead FAQ eyebrow key in FR');
  // The craft collage label is localized in both dictionaries.
  assert.equal(en.home.craft.collageAlt, 'Craft collage', 'the EN collage label');
  assert.equal(fr.home.craft.collageAlt, 'Collage artisanal', 'the FR collage label');
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
