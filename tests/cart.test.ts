// Cart data model: storage helpers, the shared catalog, billing-term
// conversion, and the contract with the Stripe price map in the Worker.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  STORAGE_KEY,
  addToCart,
  cartKey,
  clearCart,
  formatCAD,
  formatInterval,
  getCart,
  getCartCount,
  getCartTotal,
  isInCart,
  readCart,
  removeFromCart,
  sanitizeCartItem,
  writeCart,
  type CartItem,
} from '../src/lib/cart';
import {
  cartCatalogKeys,
  cartProducts,
  convertItemsToBilling,
  intervalFor,
  priceCentsFor,
  priceCentsForBilling,
  type Billing,
} from '../src/lib/cart-catalog';
import { PRICE_MAP, intervalOf, normalizeKey } from '../worker/checkout';

/** Minimal localStorage stand-in. */
function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    raw: map,
  };
}

const item = (over: Partial<CartItem> = {}): CartItem => ({
  key: 'launch-month',
  product: 'launch',
  name: 'Launch',
  priceCents: 8999,
  interval: 'month',
  type: 'plan',
  ...over,
});

test('cart items round-trip through storage', () => {
  const storage = memoryStorage();
  assert.deepEqual(readCart(storage), []);
  writeCart(storage, [item(), item({ key: 'localseo-month', product: 'localseo', name: 'Local SEO', priceCents: 15999, type: 'addon' })]);
  assert.equal(storage.raw.has(STORAGE_KEY), true);
  assert.deepEqual(readCart(storage).map((i) => i.key), ['launch-month', 'localseo-month']);
});

test('malformed storage never throws and never yields broken items', () => {
  const storage = memoryStorage();
  storage.setItem(STORAGE_KEY, 'not json');
  assert.deepEqual(readCart(storage), []);
  storage.setItem(STORAGE_KEY, JSON.stringify([{ key: 'launch-month' }, null, { key: 'x', product: 'x', interval: 'nope', priceCents: 1 }]));
  assert.deepEqual(readCart(storage), []);
  assert.deepEqual(readCart(undefined), []);
  assert.equal(sanitizeCartItem({ key: 'grow-year', product: 'grow', name: 'Grow', priceCents: 149990, interval: 'year', type: 'plan' })?.interval, 'year');
});

test('public helpers operate on localStorage', () => {
  const storage = memoryStorage();
  (globalThis as { localStorage?: unknown }).localStorage = storage;
  try {
    clearCart();
    addToCart(item());
    assert.equal(isInCart('launch-month'), true);
    assert.equal(getCartCount(), 1);
    assert.equal(getCartTotal(), 8999);
    assert.equal(formatCAD(getCartTotal()), 'C$89.99');
    // A newer plan replaces the previous one: only one plan at a time.
    addToCart(item({ key: 'grow-month', product: 'grow', name: 'Grow', priceCents: 14999 }));
    assert.deepEqual(getCart().map((i) => i.key), ['grow-month']);
    // Add-ons stack alongside the plan.
    addToCart(item({ key: 'review-month', product: 'review', name: 'Review', priceCents: 9999, type: 'addon' }));
    addToCart(item({ key: 'review-month', product: 'review', name: 'Review', priceCents: 9999, type: 'addon' }));
    assert.deepEqual(getCart().map((i) => i.key), ['grow-month', 'review-month']);
    removeFromCart('review-month');
    assert.deepEqual(getCart().map((i) => i.key), ['grow-month']);
    clearCart();
    assert.equal(getCartCount(), 0);
    assert.equal(formatInterval('month'), '/mo');
    assert.equal(formatInterval('year'), '/yr');
    assert.equal(formatInterval('one-time'), '');
  } finally {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});

test('catalog prices match the pricing plan', () => {
  assert.equal(priceCentsFor('launch', 'month'), 8999);
  assert.equal(priceCentsFor('grow', 'month'), 14999);
  assert.equal(priceCentsFor('scale', 'month'), 34999);
  assert.equal(priceCentsFor('launch', 'year'), 89990);
  assert.equal(priceCentsFor('grow', 'year'), 149990);
  assert.equal(priceCentsFor('scale', 'year'), 349990);
  assert.equal(priceCentsFor('localseo', 'month'), 15999);
  assert.equal(priceCentsFor('extrapage', 'one-time'), 4499);
  assert.equal(priceCentsFor('extrapage', 'month'), undefined);
  // Every recurring product is billed in advance at ten months ("2 months free"),
  // plans included: their annual figures are exactly 10 monthly payments.
  for (const [id, product] of Object.entries(cartProducts)) {
    if (product.monthCents === undefined || product.yearCents === undefined) continue;
    assert.equal(product.yearCents, product.monthCents * 10, `${id}: annual = 10 months`);
  }
  assert.deepEqual(
    Object.values(cartProducts)
      .filter((product) => product.type === "plan")
      .map((product) => product.yearCents),
    [89990, 149990, 349990],
  );
  // Every product declares at least one price, and every interval has a price.
  for (const [id, product] of Object.entries(cartProducts)) {
    assert.ok(
      product.monthCents !== undefined || product.oneTimeCents !== undefined,
      `${id}: has a base price`,
    );
    assert.equal(priceCentsForBilling(id, 'month'), product.monthCents ?? product.oneTimeCents);
    assert.equal(priceCentsForBilling(id, 'year'), product.yearCents ?? product.oneTimeCents);
  }
  assert.equal(intervalFor('extrapage', 'year'), 'one-time', 'one-time products ignore the term');
  assert.equal(intervalFor('launch', 'year'), 'year');
  assert.equal(cartKey('lead-pack', 'month'), 'lead-pack-month');
});

test('every catalog key has a Stripe price, and every price has a catalog key', () => {
  const catalogKeys = new Set(cartCatalogKeys().map(normalizeKey));
  const stripeKeys = new Set(Object.keys(PRICE_MAP).map(normalizeKey));
  for (const key of catalogKeys) {
    assert.ok(stripeKeys.has(key), `missing Stripe price for ${key}`);
  }
  for (const key of stripeKeys) {
    assert.ok(catalogKeys.has(key), `Stripe price ${key} is not sold anywhere in the catalog`);
  }
  assert.equal(intervalOf('launch-year'), 'year');
  assert.equal(intervalOf('launch-month'), 'month');
  assert.equal(intervalOf('extrapage-onetime'), 'one-time');
  // The cart spells it "one-time"; the price map uses "onetime".
  assert.equal(normalizeKey('extrapage-one-time'), 'extrapage-onetime');
});

test('ads pack is monthly-only and stays monthly on a yearly cart', () => {
  assert.equal(intervalFor('ads-pack', 'month'), 'month');
  assert.equal(priceCentsFor('ads-pack', 'month'), 89999);
  assert.equal(priceCentsFor('ads-pack', 'year'), undefined);
  const cart: CartItem[] = [
    item({ key: 'ads-pack-month', product: 'ads-pack', name: 'Ads Pack', priceCents: 89999, type: 'bundle' }),
  ];
  const yearly = convertItemsToBilling(cart, 'year');
  assert.deepEqual(yearly.map((i) => i.key), ['ads-pack-month']);
  assert.deepEqual(yearly.map((i) => i.priceCents), [89999]);
});

test('ads starter test is monthly-only and stays monthly on a yearly cart', () => {
  assert.equal(intervalFor('ads-starter', 'month'), 'month');
  assert.equal(priceCentsFor('ads-starter', 'month'), 49999);
  assert.equal(priceCentsFor('ads-starter', 'year'), undefined);
  const cart: CartItem[] = [
    item({ key: 'ads-starter-month', product: 'ads-starter', name: 'Starter test (Meta only)', priceCents: 49999, type: 'bundle' }),
  ];
  const yearly = convertItemsToBilling(cart, 'year');
  assert.deepEqual(yearly.map((i) => i.key), ['ads-starter-month']);
  assert.deepEqual(yearly.map((i) => i.priceCents), [49999]);
});

test('switching the billing term re-prices recurring items only', () => {
  const cart: CartItem[] = [
    item(),
    item({ key: 'localseo-month', product: 'localseo', name: 'Local SEO', priceCents: 15999, type: 'addon' }),
    item({ key: 'extrapage-one-time', product: 'extrapage', name: 'Extra Page', priceCents: 4499, interval: 'one-time', type: 'addon' }),
  ];
  const yearly = convertItemsToBilling(cart, 'year');
  assert.deepEqual(yearly.map((i) => i.key), ['launch-year', 'localseo-year', 'extrapage-one-time']);
  assert.deepEqual(yearly.map((i) => i.priceCents), [89990, 159990, 4499]);
  assert.equal(yearly[0].interval, 'year');

  const monthly = convertItemsToBilling(yearly, 'month');
  assert.deepEqual(monthly.map((i) => i.key), ['launch-month', 'localseo-month', 'extrapage-one-time']);
  assert.deepEqual(monthly.map((i) => i.priceCents), [8999, 15999, 4499]);

  // Idempotent: same term returns the same items.
  assert.deepEqual(convertItemsToBilling(monthly, 'month'), monthly);
  // Every recurring product survives the round trip onto both terms.
  for (const id of Object.keys(cartProducts)) {
    const base = priceCentsForBilling(id, 'month');
    const roundTrip = (['month', 'year', 'month'] as Billing[]).reduce(
      (items, term) => convertItemsToBilling(items, term),
      [item({ key: cartKey(id, 'month'), product: id, name: id, priceCents: base ?? 0, interval: intervalFor(id, 'month') })],
    );
    assert.equal(roundTrip[0].priceCents, base, `${id}: monthly restored`);
    assert.equal(roundTrip[0].key, cartKey(id, 'month'), `${id}: key restored`);
  }
});
