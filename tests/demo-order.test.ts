// Shared session shuffle: deterministic, unbiased, hidden-safe, and identical
// across the carousel and catalog. DOM tests run the real reorder helpers
// against fixtures that mirror the server-rendered data-demo-index contract.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { demos } from '../src/lib/demos';
import { HIDDEN_DEMOS } from '../src/lib/demo-seo';
import {
  DEMO_ORDER_STORAGE_KEY,
  applyDemoOrderToCarousel,
  applyDemoOrderToCatalog,
  getDemoOrderSeed,
  mulberry32,
  parseDemoSeed,
  readOrCreateDemoSeed,
  reorderDemoNodes,
  shuffleWithSeed,
} from '../src/lib/demo-order';
import { filterDemoCards } from '../src/lib/demo-catalog';

const visible = demos.filter((demo) => !HIDDEN_DEMOS.has(demo.id));
const visibleIds = visible.map((demo) => demo.id);
const seeds = [0, 1, 2, 7, 42, 12345, 0xdeadbeef, 0xffffffff, 0x80000000, 123456789];

function idsOf(nodes: Element[]): string[] {
  return nodes.map((node) => node.getAttribute('data-demo-id') ?? '');
}

function fixture(surface: 'carousel' | 'catalog') {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
  const doc = dom.window.document;
  const root = doc.getElementById('root')!;
  // The carousel's no-JS fallback is pinned; the catalog is canonical. Both
  // carry the same canonical data-demo-index so the shuffle input matches.
  const rank = (id: string) =>
    id === 'noctua' ? 0 : id === 'lisiere' ? 1 : id === 'studio-reve' ? 2 : id === 'nora' ? 99 : 50;
  const order = surface === 'carousel' ? visible.slice().sort((a, b) => rank(a.id) - rank(b.id)) : visible;
  for (const demo of order) {
    const node = doc.createElement(surface === 'carousel' ? 'article' : 'a');
    node.setAttribute('data-demo-id', demo.id);
    node.setAttribute('data-demo-index', String(visibleIds.indexOf(demo.id)));
    if (surface === 'carousel') {
      node.setAttribute('data-proof-panel', '');
      const index = doc.createElement('span');
      index.className = 'proof-index';
      node.appendChild(index);
      const img = doc.createElement('img');
      node.appendChild(img);
    } else {
      node.setAttribute('data-category', demo.category);
      node.setAttribute('data-demo-family', 'timeless');
      node.setAttribute('data-demo-trade', demo.trade ?? '');
      node.setAttribute('data-search', `${demo.name} ${demo.category} ${demo.city}`.toLowerCase());
    }
    root.appendChild(node);
  }
  return { dom, doc, root };
}

test('mulberry32 is deterministic and stays in [0, 1)', () => {
  const a = mulberry32(12345);
  const b = mulberry32(12345);
  for (let i = 0; i < 100; i++) {
    const value = a();
    assert.equal(value, b());
    assert.ok(value >= 0 && value < 1);
  }
});

test('same seed produces the same order on both surfaces', () => {
  for (const seed of seeds) {
    const expected = shuffleWithSeed(visibleIds, seed);
    const carousel = fixture('carousel');
    const catalog = fixture('catalog');
    const panels = applyDemoOrderToCarousel(carousel.root, seed);
    const cards = applyDemoOrderToCatalog(catalog.root, seed);
    assert.deepEqual(idsOf(panels), expected, `carousel seed ${seed}`);
    assert.deepEqual(idsOf(cards), expected, `catalog seed ${seed}`);
    assert.deepEqual(idsOf(panels), idsOf(cards), `surfaces agree for seed ${seed}`);
    carousel.dom.window.close();
    catalog.dom.window.close();
  }
});

test('different seeds produce different orders across several seeds', () => {
  const orders = seeds.map((seed) => shuffleWithSeed(visibleIds, seed).join(','));
  assert.equal(new Set(orders).size, seeds.length, 'each sampled seed gives a distinct order');
  for (const order of orders) assert.notEqual(order, visibleIds.join(','), 'not the canonical order');
});

test('shuffle contains every visible demo exactly once and no hidden demo', () => {
  for (const seed of seeds) {
    const shuffled = shuffleWithSeed(visibleIds, seed);
    assert.equal(shuffled.length, visible.length);
    assert.equal(new Set(shuffled).size, visible.length);
    assert.deepEqual(shuffled.slice().sort(), visibleIds.slice().sort());
    for (const hidden of HIDDEN_DEMOS) assert.equal(shuffled.includes(hidden), false);
  }
});

test('shuffle does not mutate its input', () => {
  const input = visibleIds.slice();
  shuffleWithSeed(input, 42);
  assert.deepEqual(input, visibleIds);
});

test('no demo is pinned to first or last across seeds', () => {
  const first = new Map<string, number>();
  const last = new Map<string, number>();
  for (let seed = 0; seed < 400; seed++) {
    const shuffled = shuffleWithSeed(visibleIds, seed);
    first.set(shuffled[0], (first.get(shuffled[0]) ?? 0) + 1);
    last.set(shuffled[shuffled.length - 1], (last.get(shuffled[shuffled.length - 1]) ?? 0) + 1);
  }
  assert.ok(first.size >= 20, `first position varies across ${first.size} demos`);
  assert.ok(last.size >= 20, `last position varies across ${last.size} demos`);
  for (const count of first.values()) assert.ok(count < 80, `first-position count ${count} is not pinned`);
  for (const count of last.values()) assert.ok(count < 80, `last-position count ${count} is not pinned`);
  assert.notEqual(first.get('noctua'), 400);
  assert.notEqual(last.get('nora'), 400);
});

test('shuffle source is Fisher-Yates with a seeded PRNG, not a random sort', () => {
  const source = readFileSync(new URL('../src/lib/demo-order.ts', import.meta.url), 'utf8');
  assert.match(source, /for \(let i = shuffled\.length - 1; i > 0; i--\)/);
  assert.match(source, /Math\.floor\(random\(\) \* \(i \+ 1\)\)/);
  assert.match(source, /mulberry32\(seed\)/);
  assert.doesNotMatch(source, /\.sort\(\s*\(\)\s*=>\s*Math\.random/);
  assert.doesNotMatch(source, /Math\.random\(\)\s*-\s*0\.5/);
});

test('carousel reorder updates index labels, image priority, and active state', () => {
  const { dom, root } = fixture('carousel');
  const panels = applyDemoOrderToCarousel(root, 42);
  panels.forEach((panel, i) => {
    assert.equal(panel.querySelector('.proof-index')?.textContent, String(i + 1).padStart(2, '0'));
    const img = panel.querySelector('img')!;
    assert.equal(img.loading, i < 2 ? 'eager' : 'lazy');
    assert.equal(img.getAttribute('fetchpriority'), i === 0 ? 'high' : null);
    assert.equal(panel.classList.contains('is-active'), false);
  });
  assert.equal(root.scrollLeft, 0);
  assert.equal(panels[0].querySelector('.proof-fracture'), null, 'no fracture before the first panel');
  panels.slice(1).forEach((panel) => {
    assert.ok(panel.querySelector('.proof-fracture'), 'fracture between shuffled panels');
  });
  dom.window.close();
});

test('catalog reorder recomputes reveal stagger from the new position', () => {
  const { dom, root } = fixture('catalog');
  const cards = applyDemoOrderToCatalog(root, 42);
  cards.forEach((card, i) => {
    assert.equal(card.style.getPropertyValue('--d'), `${(i % 3) * 80}ms`);
  });
  dom.window.close();
});

test('filtering and searching a shuffled catalog does not reshuffle it', () => {
  const { dom, root } = fixture('catalog');
  const cards = applyDemoOrderToCatalog(root, 42);
  const before = idsOf(cards);
  const visibleAfter = (filters: { style?: string; trade?: string; query?: string }) =>
    filterDemoCards(cards, { style: filters.style ?? 'All', trade: filters.trade ?? 'All', query: filters.query ?? '' });

  assert.equal(visibleAfter({ query: 'plomberie' }) > 0, true);
  assert.deepEqual(idsOf(Array.from(root.children)), before);
  assert.equal(visibleAfter({ style: 'timeless' }) > 0, true);
  assert.deepEqual(idsOf(Array.from(root.children)), before);
  assert.equal(visibleAfter({ trade: 'plumbing' }) > 0, true);
  assert.deepEqual(idsOf(Array.from(root.children)), before);
  assert.equal(visibleAfter({ query: 'no-such-demo' }), 0);
  assert.deepEqual(idsOf(Array.from(root.children)), before);
  assert.equal(visibleAfter({}), visible.length);
  assert.deepEqual(idsOf(Array.from(root.children)), before);
  dom.window.close();
});

test('reorderDemoNodes never adds or removes nodes', () => {
  const { dom, root } = fixture('catalog');
  const before = new Set(Array.from(root.children));
  const ordered = reorderDemoNodes(root, '[data-category]', 7);
  assert.equal(ordered.length, before.size);
  assert.equal(root.children.length, before.size);
  for (const node of ordered) assert.equal(before.has(node), true);
  dom.window.close();
});

test('parseDemoSeed accepts only unsigned 32-bit decimal strings', () => {
  assert.equal(parseDemoSeed('0'), 0);
  assert.equal(parseDemoSeed('42'), 42);
  assert.equal(parseDemoSeed('4294967295'), 0xffffffff);
  assert.equal(parseDemoSeed(null), null);
  assert.equal(parseDemoSeed(''), null);
  assert.equal(parseDemoSeed('-1'), null);
  assert.equal(parseDemoSeed('4294967296'), null);
  assert.equal(parseDemoSeed('1.5'), null);
  assert.equal(parseDemoSeed('abc'), null);
});

test('readOrCreateDemoSeed persists one seed under the shared namespaced key', () => {
  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
  };
  const first = readOrCreateDemoSeed(storage, () => 123);
  const second = readOrCreateDemoSeed(storage, () => 456);
  assert.equal(first, 123);
  assert.equal(second, 123);
  assert.equal(store.get(DEMO_ORDER_STORAGE_KEY), '123');
});

test('blocked storage falls back to a usable seed without throwing', () => {
  const storage = {
    getItem: () => { throw new Error('blocked'); },
    setItem: () => { throw new Error('blocked'); },
  };
  const seed = readOrCreateDemoSeed(storage, () => 77);
  assert.equal(seed, 77);
  const nullSeed = readOrCreateDemoSeed(null, () => 88);
  assert.equal(nullSeed, 88);
});

test('getDemoOrderSeed shares one seed across surfaces in the same window', () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://webao.ca/' });
  const win = dom.window as unknown as Window;
  const first = getDemoOrderSeed(win);
  const second = getDemoOrderSeed(win);
  assert.equal(first, second);
  assert.equal(dom.window.sessionStorage.getItem(DEMO_ORDER_STORAGE_KEY), String(first));
  dom.window.close();
});

test('getDemoOrderSeed keeps a window-level fallback when sessionStorage throws', () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://webao.ca/' });
  Object.defineProperty(dom.window, 'sessionStorage', {
    get() { throw new Error('blocked'); },
    configurable: true,
  });
  const win = dom.window as unknown as Window;
  const first = getDemoOrderSeed(win);
  const second = getDemoOrderSeed(win);
  assert.equal(first, second);
  assert.ok(first >= 0 && first <= 0xffffffff);
  dom.window.close();
});
