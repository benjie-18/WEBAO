// Client cart flow, exercised against the same DOM hooks the layout renders
// (see the drawer markup and `CartButton` in the .astro sources). jsdom runs
// the real module — no re-implementation of the logic under test.
import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM, VirtualConsole } from 'jsdom';
import { STORAGE_KEY, cartKey, type CartItem } from '../src/lib/cart';
import {
  BILLING_KEY,
  applyBilling,
  formatMoney,
  moneyFormat,
  initCart,
  intervalSuffix,
  refresh,
} from '../src/lib/cart-ui';

const drawerAttrs = (over: Record<string, string> = {}) =>
  Object.entries({
    'data-label-open': 'Open cart',
    'data-label-add': 'Add {name} to cart',
    'data-label-remove': 'Remove {name} from cart',
    'data-label-empty-all': 'Empty cart',
    'data-label-empty-confirm': 'Confirm',
    'data-empty-title': 'Your cart is empty.',
    'data-empty-hint': 'Add items from the pricing page.',
    'data-suffix-month': '/mo',
    'data-suffix-year': '/yr',
    'data-suffix-one-time': ' one-time',
    'data-money-prefix': 'C$',
    'data-money-suffix': '',
    'data-money-decimal': '.',
    ...over,
  })
    .map(([key, value]) => `${key}="${value}"`)
    .join(' ');

/** jsdom cannot navigate; ignore that one message, keep everything else. */
function quietConsole() {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error: Error) => {
    if (!/Not implemented: navigation/.test(error.message)) throw error;
  });
  return virtualConsole;
}

/** Mirrors BaseLayout's header button, drawer and the pricing page buttons. */
function fixture(options: { french?: boolean } = {}) {
  const attrs = options.french
    ? drawerAttrs({
        'data-suffix-month': '/mois',
        'data-suffix-year': '/an',
        'data-suffix-one-time': ' unique',
        'data-money-prefix': '',
        'data-money-suffix': '\u00a0$',
        'data-money-decimal': ',',
      })
    : drawerAttrs();
  const dom = new JSDOM(
    `<!doctype html><html><body>
      <header>
        <button type="button" class="header-cart-btn" data-cart-open aria-label="Open cart">
          <span class="header-cart-count" data-cart-count hidden>0</span>
        </button>
      </header>
      <main>
        <div class="billing-toggle" data-billing-toggle>
          <button type="button" class="billing-opt is-active" data-billing-opt="month" aria-pressed="true">Monthly</button>
          <button type="button" class="billing-opt" data-billing-opt="year" aria-pressed="false">Yearly</button>
        </div>
        <button type="button" class="cart-btn" data-cart-btn data-key="launch-month" data-product="launch"
          data-name="Launch" data-price-cents="8999" data-interval="month" data-type="plan" data-price-year="89990"></button>
        <button type="button" class="cart-btn" data-cart-btn data-key="grow-month" data-product="grow"
          data-name="Grow" data-price-cents="14999" data-interval="month" data-type="plan" data-price-year="149990"></button>
        <button type="button" class="cart-btn" data-cart-btn data-key="review-month" data-product="review"
          data-name="Review Generation Engine" data-price-cents="9999" data-interval="month" data-type="addon" data-price-year="99990"></button>
        <button type="button" class="cart-btn" data-cart-btn data-key="extrapage-one-time" data-product="extrapage"
          data-name="Extra Page" data-price-cents="4499" data-interval="one-time" data-type="addon"></button>
      </main>
      <div class="cart-overlay" data-cart-overlay hidden></div>
      <aside class="cart-drawer" ${attrs} data-cart-drawer hidden>
        <div class="cart-drawer-header">
          <h2 class="cart-drawer-title">Your cart</h2>
          <button type="button" class="cart-drawer-close" data-cart-close aria-label="Close cart">×</button>
        </div>
        <div class="cart-drawer-scroll">
          <div class="cart-drawer-items" data-cart-items><div class="cart-drawer-empty">Your cart is empty.</div></div>
          <button type="button" class="cart-empty-all" data-cart-empty-all hidden>Empty cart</button>
        </div>
        <div class="cart-drawer-footer">
          <strong data-cart-total>C$0.00</strong>
          <a href="/checkout" class="cart-drawer-checkout" data-cart-checkout aria-disabled="true">Checkout</a>
        </div>
      </aside>
    </body></html>`,
    {
      url: 'https://webao.ca/pricing',
      runScripts: 'dangerously',
      pretendToBeVisual: true,
      virtualConsole: quietConsole(),
    },
  );
  const doc = dom.window.document;
  initCart(doc);
  const cart = () => JSON.parse(dom.window.localStorage.getItem(STORAGE_KEY) ?? '[]') as CartItem[];
  const click = (el: Element | null) => {
    assert.ok(el, 'expected element to click');
    const event = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
    el!.dispatchEvent(event);
    return event;
  };
  const button = (product: string) => doc.querySelector<HTMLElement>(`[data-cart-btn][data-product="${product}"]`);
  return { dom, doc, window: dom.window, cart, click, button, close: () => dom.window.close() };
}

test('an empty cart renders the localized empty state', () => {
  const { doc, window, cart } = fixture();
  assert.equal(doc.querySelector('[data-cart-count]')!.hidden, true);
  assert.match(doc.querySelector('[data-cart-items]')!.textContent ?? '', /Your cart is empty\./);
  assert.equal(doc.querySelector('[data-cart-total]')!.textContent, 'C$0.00');
  assert.equal(doc.querySelector('[data-cart-checkout]')!.getAttribute('aria-disabled'), 'true');
  assert.equal(cart().length, 0);
  window.close();
});

test('clicking a plan button adds it, again removes it', () => {
  const { doc, click, button, cart } = fixture();
  click(button('launch'));
  assert.deepEqual(cart().map((i) => [i.key, i.priceCents, i.interval, i.type]), [['launch-month', 8999, 'month', 'plan']]);
  assert.equal(button('launch')!.classList.contains('is-added'), true);
  assert.equal(button('launch')!.getAttribute('aria-label'), 'Remove Launch from cart');
  assert.equal(doc.querySelector('[data-cart-count]')!.textContent, '1');
  assert.equal(doc.querySelector('[data-cart-count]')!.hidden, false);
  assert.equal(doc.querySelector('[data-cart-total]')!.textContent, 'C$89.99');
  assert.match(doc.querySelector('[data-cart-items]')!.textContent ?? '', /Launch/);
  assert.match(doc.querySelector('[data-cart-items]')!.textContent ?? '', /C\$89\.99\/mo/);

  click(button('launch'));
  assert.deepEqual(cart(), []);
  assert.equal(button('launch')!.classList.contains('is-added'), false);
  assert.equal(doc.querySelector('[data-cart-count]')!.hidden, true);
});

test('only one plan at a time, add-ons stack, totals add up', () => {
  const { doc, click, button, cart } = fixture();
  click(button('launch'));
  click(button('grow'));
  assert.deepEqual(cart().map((i) => i.key), ['grow-month']);
  assert.equal(button('launch')!.classList.contains('is-added'), false);
  click(button('review'));
  click(button('extrapage'));
  assert.deepEqual(cart().map((i) => i.key), ['grow-month', 'review-month', 'extrapage-one-time']);
  assert.equal(doc.querySelector('[data-cart-total]')!.textContent, 'C$294.97');
  assert.match(doc.querySelector('[data-cart-items]')!.textContent ?? '', /C\$44\.99 one-time/);
  assert.equal(doc.querySelector('[data-cart-count]')!.textContent, '3');
});

test('the yearly toggle prices every recurring item, one-time items untouched', () => {
  const { doc, click, button, cart, window } = fixture();
  click(button('launch'));
  click(button('review'));
  click(button('extrapage'));
  click(doc.querySelector('[data-billing-opt="year"]'));

  assert.equal(window.localStorage.getItem(BILLING_KEY), 'year');
  assert.deepEqual(cart().map((i) => [i.key, i.priceCents]), [
    ['launch-year', 89990],
    ['review-year', 99990],
    ['extrapage-one-time', 4499],
  ]);
  assert.equal(doc.querySelector('[data-billing-opt="year"]')!.getAttribute('aria-pressed'), 'true');
  assert.equal(doc.querySelector('[data-billing-opt="year"]')!.classList.contains('is-active'), true);
  assert.equal(doc.querySelector('[data-billing-opt="month"]')!.classList.contains('is-active'), false);
  assert.equal(button('launch')!.classList.contains('is-added'), true, 'the yearly button stays marked');
  assert.equal(doc.querySelector('[data-cart-total]')!.textContent, 'C$1,944.79');
  assert.match(doc.querySelector('[data-cart-items]')!.textContent ?? '', /C\$899\.90\/yr/);

  // A button clicked while yearly adds the yearly price, and plans still
  // replace each other.
  click(button('grow'));
  assert.deepEqual(cart().map((i) => i.key), ['review-year', 'extrapage-one-time', 'grow-year']);
  assert.equal(button('launch')!.classList.contains('is-added'), false);
  assert.equal(button('grow')!.classList.contains('is-added'), true);

  // Switching back restores monthly prices.
  click(doc.querySelector('[data-billing-opt="month"]'));
  assert.deepEqual(cart().map((i) => [i.key, i.priceCents]), [
    ['review-month', 9999],
    ['extrapage-one-time', 4499],
    ['grow-month', 14999],
  ]);
  assert.equal(window.localStorage.getItem(BILLING_KEY), 'month');
});

test('a persisted billing term is honoured on load', () => {
  const { doc, button, click, cart, window } = fixture();
  window.localStorage.setItem(BILLING_KEY, 'year');
  refresh(doc);
  assert.equal(doc.querySelector('[data-billing-opt="year"]')!.classList.contains('is-active'), true);
  click(button('launch'));
  assert.deepEqual(cart().map((i) => [i.key, i.priceCents]), [['launch-year', 89990]]);
});

test('drawer opens from the header, closes with Escape, the overlay and the close button', async () => {
  const { doc, window, click } = fixture();
  const drawer = doc.querySelector<HTMLElement>('[data-cart-drawer]')!;
  const overlay = doc.querySelector<HTMLElement>('[data-cart-overlay]')!;

  click(doc.querySelector('[data-cart-open]'));
  assert.equal(drawer.hidden, false);
  assert.equal(overlay.hidden, false);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(drawer.classList.contains('is-open'), true);
  assert.equal(doc.body.style.overflow, 'hidden');

  doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(drawer.classList.contains('is-open'), false);
  assert.equal(doc.body.style.overflow, '');
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(drawer.hidden, true);

  click(doc.querySelector('[data-cart-open]'));
  click(doc.querySelector('[data-cart-close]'));
  assert.equal(drawer.classList.contains('is-open'), false);

  click(doc.querySelector('[data-cart-open]'));
  click(overlay);
  assert.equal(drawer.classList.contains('is-open'), false);
  window.close();
});

test('removing an item from the drawer updates buttons, badge and total', () => {
  const { doc, click, button, cart, window } = fixture();
  click(button('launch'));
  click(button('review'));
  click(doc.querySelector('[data-cart-open]'));
  const remove = doc.querySelector<HTMLElement>('[data-remove-key="launch-month"]');
  click(remove);
  assert.deepEqual(cart().map((i) => i.key), ['review-month']);
  assert.equal(doc.querySelector('[data-cart-count]')!.textContent, '1');
  assert.equal(button('launch')!.classList.contains('is-added'), false);
  assert.equal(doc.querySelector('[data-cart-total]')!.textContent, 'C$99.99');
  window.close();
});

test('drawer remove buttons carry a minus icon and the empty-cart button shows with items', () => {
  const { doc, click, button, window } = fixture();
  click(button('launch'));
  const remove = doc.querySelector<HTMLElement>('[data-remove-key="launch-month"]');
  assert.ok(remove);
  assert.match(remove.innerHTML, /M3\.5 8h9/);
  const emptyAll = doc.querySelector<HTMLElement>('[data-cart-empty-all]');
  assert.ok(emptyAll);
  assert.equal(emptyAll.hidden, false);
  assert.equal(emptyAll.textContent, 'Empty cart');
  assert.equal(emptyAll.parentElement?.classList.contains('cart-drawer-scroll'), true);
  assert.equal(emptyAll.previousElementSibling?.hasAttribute('data-cart-items'), true);
  assert.equal(doc.querySelector('.cart-drawer-footer [data-cart-empty-all]'), null);
  window.close();
});

test('empty cart button needs a confirm click, then clears everything', () => {
  const { doc, click, button, cart, window } = fixture();
  click(button('launch'));
  click(button('review'));
  const emptyAll = doc.querySelector<HTMLElement>('[data-cart-empty-all]');
  assert.ok(emptyAll);
  click(emptyAll);
  assert.equal(emptyAll.classList.contains('is-armed'), true);
  assert.equal(emptyAll.textContent, 'Confirm');
  assert.equal(cart().length, 2);
  click(emptyAll);
  assert.deepEqual(cart(), []);
  assert.equal(emptyAll.hidden, true);
  assert.match(doc.querySelector('[data-cart-items]')!.textContent ?? '', /Your cart is empty\./);
  window.close();
});

test('the cart keeps working after a ClientRouter navigation', () => {
  const { doc, window, cart, click, button } = fixture();
  click(button('launch'));

  // ClientRouter replaces <main> (new buttons, nothing bound to the old
  // nodes), closes the drawer and fires astro:page-load.
  doc.querySelector('main')!.innerHTML =
    '<button type="button" class="cart-btn" data-cart-btn data-product="scale" data-name="Scale"' +
    ' data-price-cents="34999" data-interval="month" data-type="plan" data-price-year="349990"></button>';
  doc.querySelector<HTMLElement>('[data-cart-drawer]')!.hidden = true;
  doc.dispatchEvent(new window.Event('astro:before-preparation'));
  assert.equal(doc.body.style.overflow, '', 'a navigation never leaves the page scroll-locked');
  doc.dispatchEvent(new window.Event('astro:page-load'));

  // State survives the swap: badge and drawer show the plan added before it.
  assert.equal(doc.querySelector('[data-cart-count]')!.textContent, '1');
  assert.match(doc.querySelector('[data-cart-items]')!.textContent ?? '', /Launch/);

  // The freshly rendered button works without re-binding, and the drawer still
  // opens (its markup was replaced by the router).
  click(doc.querySelector('[data-product="scale"]'));
  assert.deepEqual(cart().map((i) => i.key), ['scale-month']);
  click(doc.querySelector('[data-cart-open]'));
  assert.equal(doc.querySelector<HTMLElement>('[data-cart-drawer]')!.hidden, false);
  window.close();
});

test('an empty cart cannot reach checkout', () => {
  const { doc, click } = fixture();
  const checkout = doc.querySelector('[data-cart-checkout]')!;
  const event = click(checkout);
  assert.equal(event.defaultPrevented, true);
  assert.equal(checkout.getAttribute('aria-disabled'), 'true');
  assert.equal((checkout as HTMLElement).tabIndex, -1);

  // …and with an item in the cart the link works again.
  click(doc.querySelector('[data-cart-btn][data-product="launch"]'));
  assert.equal(checkout.getAttribute('aria-disabled'), 'false');
  assert.equal((checkout as HTMLElement).tabIndex, 0);
  assert.equal(click(checkout).defaultPrevented, false);
});

test('cross-tab storage changes re-render the cart', () => {
  const { doc, window } = fixture();
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify([{ key: 'scale-month', product: 'scale', name: 'Scale', priceCents: 34999, interval: 'month', type: 'plan' }]),
  );
  window.dispatchEvent(new window.StorageEvent('storage', { key: STORAGE_KEY }));
  assert.equal(doc.querySelector('[data-cart-count]')!.textContent, '1');
  assert.match(doc.querySelector('[data-cart-items]')!.textContent ?? '', /Scale/);
  assert.equal(doc.querySelector('[data-cart-total]')!.textContent, 'C$349.99');
  window.close();
});

test('the paid page empties the cart once', () => {
  const { doc, click, button, cart, window } = fixture();
  click(button('launch'));
  assert.equal(cart().length, 1);
  // The success page marks itself with data-cart-clear.
  const marker = doc.createElement('section');
  marker.setAttribute('data-cart-clear', '');
  doc.body.appendChild(marker);
  refresh(doc);
  assert.deepEqual(cart(), []);
  assert.equal(doc.querySelector('[data-cart-count]')!.hidden, true);
  window.close();
});

test('French drawers format money and intervals in French', () => {
  const { doc } = fixture({ french: true });
  assert.equal(intervalSuffix(doc, 'month'), '/mois');
  assert.equal(intervalSuffix(doc, 'year'), '/an');
  assert.equal(intervalSuffix(doc, 'one-time'), ' unique');
  const fmt = moneyFormat(doc);
  assert.deepEqual(fmt, { prefix: '', suffix: '\u00a0$', decimal: ',' });
  assert.equal(formatMoney(89990, fmt), '899,90\u00a0$');
  assert.equal(formatMoney(193534, fmt), '1\u00a0935,34\u00a0$');
  assert.equal(formatMoney(89990), 'C$899.90');
  assert.equal(formatMoney(19353399), 'C$193,533.99');
});

test('billing changes only touch recurring items', () => {
  const { doc, cart, click, button, window } = fixture();
  click(button('extrapage'));
  applyBilling(doc, 'year');
  assert.deepEqual(cart().map((i) => i.key), ['extrapage-one-time']);
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify([
      { key: cartKey('launch', 'month'), product: 'launch', name: 'Launch', priceCents: 8999, interval: 'month', type: 'plan' },
      { key: cartKey('extrapage', 'one-time'), product: 'extrapage', name: 'Extra Page', priceCents: 4499, interval: 'one-time', type: 'addon' },
    ]),
  );
  applyBilling(doc, 'year');
  assert.deepEqual(cart().map((i) => [i.key, i.priceCents]), [
    ['launch-year', 89990],
    ['extrapage-one-time', 4499],
  ]);
  window.close();
});

test('drawer focus: opening moves focus inside, Tab is trapped, closing returns focus', async () => {
  const { doc, window, click } = fixture();
  const openBtn = doc.querySelector<HTMLElement>('[data-cart-open]')!;
  const closeBtn = doc.querySelector<HTMLElement>('[data-cart-close]')!;
  const checkout = doc.querySelector<HTMLElement>('[data-cart-checkout]')!;
  const tab = (shift = false) =>
    doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: shift, bubbles: true, cancelable: true }));

  openBtn.focus();
  click(openBtn);
  assert.equal(doc.activeElement, closeBtn, 'opening focuses the drawer close button');

  checkout.focus();
  tab();
  assert.equal(doc.activeElement, closeBtn, 'Tab on the last focusable wraps to the first');

  closeBtn.focus();
  tab(true);
  assert.equal(doc.activeElement, checkout, 'Shift+Tab on the first focusable wraps to the last');

  doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(doc.activeElement, openBtn, 'closing returns focus to the opener');

  // With the drawer closed, Tab is untouched by the trap.
  tab();
  assert.equal(doc.activeElement, openBtn);
  window.close();
});
