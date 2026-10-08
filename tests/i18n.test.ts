// Bilingual content: the two dictionaries must stay in lockstep, and the
// locale routing helpers must map every page to its counterpart.
import assert from 'node:assert/strict';
import test from 'node:test';
import en from '../src/lib/i18n/en';
import fr from '../src/lib/i18n/fr';
import { demos } from '../src/lib/demos';
import {
  defaultLocale,
  getAlternatePath,
  getAlternateUrls,
  getLocaleFromUrl,
  getPageKeyFromPath,
  locales,
  localizedPaths,
  type Locale,
  type PageKey,
} from '../src/lib/i18n/config';
import { getDemos, t, translations, useTranslations } from '../src/lib/i18n';

function leafPaths(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object') return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    leafPaths(child, prefix ? `${prefix}.${key}` : key),
  );
}

const at = (dict: unknown, path: string): unknown =>
  path.split('.').reduce<any>((node, key) => (node ? node[key] : undefined), dict);

const enPaths = leafPaths(en);
const frPaths = new Set(leafPaths(fr));

test('the English and French dictionaries have identical key paths and types', () => {
  assert.deepEqual([...enPaths].sort(), [...frPaths].sort());
  for (const path of enPaths) {
    assert.equal(typeof at(en, path), typeof at(fr, path), path);
  }
});

test('placeholders match between the two languages', () => {
  const tokens = (value: string) => (value.match(/\{[a-zA-Z0-9]+\}/g) ?? []).sort().join(',');
  for (const path of enPaths) {
    const a = at(en, path);
    const b = at(fr, path);
    if (typeof a === 'string' && typeof b === 'string') {
      assert.equal(tokens(a), tokens(b), path);
    }
  }
});

test('only the money wrapper is deliberately blank, and blanks are symmetric', () => {
  // EN puts the currency before the amount ("C$89.99"), FR after ("89,99 $"),
  // so each locale leaves the other side empty by design.
  const intentional = new Set(['cart.moneyPrefix', 'cart.moneySuffix']);
  const blanks = (dict: unknown) =>
    enPaths.filter((path) => at(dict, path) === '' && !intentional.has(path)).sort();
  assert.deepEqual(blanks(en), blanks(fr), 'an empty string in one language must be empty in the other');
  for (const path of intentional) {
    const pair = [at(en, path), at(fr, path)];
    assert.equal(pair.filter((value) => value === '').length, 1, `${path} is set in exactly one locale`);
  }
});

test('every cart string exists in both languages', () => {
  for (const locale of locales) {
    const cart = useTranslations(locale).cart;
    for (const [key, value] of Object.entries(cart)) {
      assert.equal(typeof value, 'string', `${locale}.cart.${key}`);
      if (key !== 'moneyPrefix' && key !== 'moneySuffix') {
        assert.notEqual(value, '', `${locale}.cart.${key} is translated`);
      }
    }
    assert.match(cart.add, /\{name\}/);
    assert.match(cart.remove, /\{name\}/);
    assert.notEqual(cart.suffixMonth, cart.suffixYear);
    assert.equal(cart.moneyDecimal, locale === 'fr' ? ',' : '.');
    assert.equal([cart.moneyPrefix, cart.moneySuffix].filter((part) => part.trim() !== '').length, 1, 'a symbol on one side');
  }
  assert.equal(en.cart.suffixMonth, '/mo');
  assert.equal(fr.cart.suffixMonth, '/mois');
  assert.equal(en.cart.suffixYear, '/yr');
  assert.equal(fr.cart.suffixYear, '/an');
});

test('localizedPaths lists every page once per locale', () => {
  for (const locale of locales) {
    const paths = Object.values(localizedPaths[locale]);
    assert.equal(new Set(paths).size, paths.length, `${locale} paths are unique`);
    for (const path of paths) {
      assert.ok(path.startsWith('/'), path);
    }
  }
  const pageKeys = Object.keys(localizedPaths.en);
  assert.deepEqual(pageKeys.sort(), Object.keys(localizedPaths.fr).sort());
  for (const key of ['home', 'pricing', 'contact', 'demos', 'start', 'terms', 'refunds'] as PageKey[]) {
    assert.ok(pageKeys.includes(key), key);
  }
  assert.equal(localizedPaths.en.home, '/');
  assert.equal(localizedPaths.fr.home, '/fr');
  assert.equal(localizedPaths.en.pricing, '/pricing');
  assert.equal(localizedPaths.fr.pricing, '/fr/tarifs');
  assert.equal(localizedPaths.en.sources, '/sources');
  assert.equal(localizedPaths.fr.sources, '/fr/sources');
  assert.equal(defaultLocale, 'en');
});

test('getPageKeyFromPath resolves known pages and detects the locale of the rest', () => {
  const cases: Array<[string, Locale, PageKey | null]> = [
    ['/', 'en', 'home'],
    ['/pricing', 'en', 'pricing'],
    ['/pricing/', 'en', 'pricing'],
    ['/terms', 'en', 'terms'],
    ['/fr', 'fr', 'home'],
    ['/fr/', 'fr', 'home'],
    ['/fr/tarifs', 'fr', 'pricing'],
    ['/fr/tarifs/', 'fr', 'pricing'],
    ['/fr/conditions', 'fr', 'terms'],
    ['/fr/demos/nora', 'fr', null],
    ['/demos/nora', 'en', null],
    ['/fr/checkout', 'fr', null],
    ['/checkout', 'en', null],
    ['/sources', 'en', 'sources'],
    ['/fr/sources', 'fr', 'sources'],
  ];
  for (const [path, locale, pageKey] of cases) {
    assert.deepEqual(getPageKeyFromPath(path), { locale, pageKey }, path);
  }
  assert.equal(getLocaleFromUrl('https://webao.ca/fr/tarifs'), 'fr', 'full URL strings work');
  assert.equal(getLocaleFromUrl('/fr/tarifs'), 'fr', 'pathnames work');
  assert.equal(getLocaleFromUrl(new URL('https://webao.ca/pricing')), 'en');
});

test('alternate-path helpers cross-link the two locales', () => {
  const cases: Array<[string, Locale, string]> = [
    ['/pricing', 'fr', '/fr/tarifs'],
    ['/fr/tarifs', 'en', '/pricing'],
    ['/', 'fr', '/fr'],
    ['/fr', 'en', '/'],
    ['/terms', 'fr', '/fr/conditions'],
    ['/fr/conditions', 'en', '/terms'],
    ['/demos/nora', 'fr', '/fr/demos/nora'],
    ['/fr/demos/nora', 'en', '/demos/nora'],
    ['/checkout', 'fr', '/fr/checkout'],
    ['/fr/checkout', 'en', '/checkout'],
    ['/sources', 'fr', '/fr/sources'],
    ['/sources', 'en', '/sources'],
    ['/fr/sources', 'fr', '/fr/sources'],
  ];
  for (const [path, target, expected] of cases) {
    assert.equal(getAlternatePath(path, target), expected, `${path} -> ${target}`);
  }
  assert.equal(getAlternatePath('/pricing', 'en'), '/pricing', 'same-locale lookups are a no-op');

  assert.deepEqual(getAlternateUrls('/pricing', 'https://webao.ca'), {
    en: 'https://webao.ca/pricing/',
    fr: 'https://webao.ca/fr/tarifs/',
  });
  assert.deepEqual(getAlternateUrls('/', 'https://webao.ca/'), {
    en: 'https://webao.ca/',
    fr: 'https://webao.ca/fr/',
  });
});

test('useTranslations and t() fall back to English for unknown locales and paths', () => {
  assert.equal(useTranslations('en'), en);
  assert.equal(useTranslations('fr'), fr);
  assert.equal(useTranslations('de' as Locale), en, 'unknown locale falls back to English');
  assert.equal(translations.fr, fr);
  assert.equal(t('fr', 'pricing.plans.launch.name'), fr.pricing.plans.launch.name);
  assert.equal(t('en', 'pricing.plans.launch.name'), en.pricing.plans.launch.name);
  assert.equal(t('fr', 'does.not.exist'), 'does.not.exist', 'missing paths return the path itself');
  assert.equal(t('fr', 'cart.title'), fr.cart.title);
});

test('getDemos localizes every demo description in both languages', () => {
  for (const locale of locales) {
    const localized = getDemos(locale);
    assert.equal(localized.length, demos.length);
    for (const demo of localized) {
      assert.equal(typeof demo.localizedDescription, 'string');
      assert.notEqual(demo.localizedDescription.trim(), '', `${locale}:${demo.id}`);
    }
  }
  const english = new Map(getDemos('en').map((demo) => [demo.id, demo.localizedDescription]));
  const french = new Map(getDemos('fr').map((demo) => [demo.id, demo.localizedDescription]));
  const translated = demos.filter((demo) => english.get(demo.id) !== french.get(demo.id)).length;
  assert.ok(translated >= demos.length - 1, `expected nearly every demo to be translated, got ${translated}/${demos.length}`);
  assert.notEqual(english.get('nora'), french.get('nora'));
});
