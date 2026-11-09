// Start page (step 1 of the funnel), exercised against the same DOM hooks
// `StartPage.astro` renders. jsdom runs the real module together with the
// shared cart layer, so the test covers the actual hand-off to /checkout:
// seeded default plan, plan switch, validation, stored details, owner
// notification and navigation.
import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM, VirtualConsole } from 'jsdom';
import { STORAGE_KEY, type CartItem } from '../src/lib/cart';
import { BILLING_KEY, initCart } from '../src/lib/cart-ui';
import {
  CUSTOMER_KEY,
  hasValidDetails,
  initStart,
  planItem,
  readCustomer,
  validateDetails,
  writeCustomer,
} from '../src/lib/start-ui';

/** jsdom cannot navigate; ignore that one message, keep everything else. */
function quietConsole() {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error: Error) => {
    if (!/Not implemented: navigation/.test(error.message)) throw error;
  });
  return virtualConsole;
}

interface FixtureOptions {
  cart?: CartItem[];
  billing?: 'month' | 'year';
  customer?: Record<string, string>;
  french?: boolean;
}

/** Mirrors the layout's drawer attributes and StartPage's selection card + form. */
function fixture(options: FixtureOptions = {}) {
  const drawer = options.french
    ? 'data-suffix-month="/mois" data-suffix-year="/an" data-suffix-one-time=" unique" data-money-prefix="" data-money-suffix="&nbsp;$" data-money-decimal=","'
    : 'data-suffix-month="/mo" data-suffix-year="/yr" data-suffix-one-time=" one-time" data-money-prefix="C$" data-money-suffix="" data-money-decimal="."';
  const dom = new JSDOM(
    `<!doctype html><html><body>
      <header><button type="button" data-cart-open><span data-cart-count hidden>0</span></button></header>
      <main>
        <div class="eyebrow" data-start-eyebrow>Start your site</div>
        <div data-start data-default-plan="grow" data-label-remove="Remove {name}"
          data-eyebrow-web="Start your site" data-eyebrow-ads="Start your ads"
          data-eyebrow-ai="Start your AI" data-eyebrow-mixed="Start with WEBAO"
          data-hint-web="Add-ons only" data-hint-service="No website plan selected."
          data-label-group-web="Website" data-label-group-ads="Ads" data-label-group-ai="AI">
          <aside>
            <div class="billing-toggle" data-billing-toggle>
              <button type="button" class="billing-opt is-active" data-billing-opt="month" aria-pressed="true">Monthly</button>
              <button type="button" class="billing-opt" data-billing-opt="year" aria-pressed="false">Yearly</button>
            </div>
            <div data-branch-select>
              <button type="button" data-branch-toggle="web" aria-pressed="true">Website</button>
              <button type="button" data-branch-toggle="ads" aria-pressed="false">Ads</button>
              <button type="button" data-branch-toggle="ai" aria-pressed="false">AI</button>
            </div>
            <fieldset data-branch-picker="web">
              <label><input type="radio" name="plan" value="launch" data-name="Launch" /><span data-plan-price></span></label>
              <label><input type="radio" name="plan" value="grow" data-name="Grow" /><span data-plan-price></span></label>
              <label><input type="radio" name="plan" value="scale" data-name="Scale" /><span data-plan-price></span></label>
              <label><input type="radio" name="plan" value="none" /><span>No website plan</span></label>
            </fieldset>
            <fieldset data-branch-picker="ads" hidden>
              <label><input type="radio" name="ads-channel" value="ads-meta" data-name="Meta" /><span data-ads-price></span></label>
              <label><input type="radio" name="ads-channel" value="ads-google" data-name="Google" /><span data-ads-price></span></label>
              <label><input type="radio" name="ads-channel" value="ads-both" data-name="Meta + Google" /><span data-ads-price></span></label>
              <label><input type="radio" name="ads-channel" value="none" /><span>No Ads Pack</span></label>
              <label><input type="checkbox" name="gbp" value="gbp-revamp" data-name="Google Business Profile Revamp" /><span data-gbp-price></span></label>
            </fieldset>
            <fieldset data-branch-picker="ai" hidden>
              <label><input type="checkbox" name="ai-service" value="ai-receptionist" data-name="AI Receptionist" /><span data-ai-price></span></label>
              <label><input type="checkbox" name="ai-service" value="aichat" data-name="Trained AI Chat Assistant" /><span data-ai-price></span></label>
              <label><input type="checkbox" name="ai-service" value="ai-followup" data-name="AI Follow-up" /><span data-ai-price></span></label>
              <label><input type="checkbox" name="ai-service" value="ai-pack" data-name="AI Pack" /><span data-ai-price></span></label>
            </fieldset>
            <p data-start-no-plan hidden>Add-ons only</p>
            <p data-start-default-note hidden>Grow is pre-selected</p>
            <div data-start-extras hidden><ul data-start-extras-list></ul></div>
            <strong data-start-total>C$0.00</strong>
            <p data-start-selection-error hidden>Choose a plan</p>
          </aside>
          <form data-start-form novalidate data-checkout-path="/checkout"
            data-err-name="Please enter your name." data-err-email="Please enter your email."
            data-err-email-format="Please enter a valid email." data-err-business="Please enter your business name.">
            <input name="name" /><span data-error="name" hidden></span>
            <input name="email" type="email" /><span data-error="email" hidden></span>
            <input name="business" /><span data-error="business" hidden></span>
            <button type="submit">Continue</button>
          </form>
        </div>
      </main>
      <div data-cart-overlay hidden></div>
      <aside ${drawer} data-cart-drawer hidden data-label-open="Open cart" data-label-add="Add {name}" data-label-remove="Remove {name}"
        data-empty-title="Your cart is empty." data-empty-hint="Add items.">
        <div data-cart-items></div>
        <strong data-cart-total>C$0.00</strong>
        <a href="/start" data-cart-checkout aria-disabled="true">Checkout</a>
      </aside>
      <div data-cart-conflict-overlay hidden></div>
      <div data-cart-conflict role="dialog" aria-modal="true" hidden
        data-title="That doesn't go together"
        data-msg-included="{item} is already included in {plan}."
        data-msg-not-available="{item} isn't available with {plan}."
        data-msg-bundle-component="{bundle} already includes {item}."
        data-msg-bundle-overlap="{first} and {second} both include the Review Generation Engine."
        data-msg-ads-two="You can only have one Ads option at a time."
        data-two-plans="Only one website plan can be bought at a time."
        data-msg-ai-pack="The AI Pack already includes {item}."
        data-msg-monthly-only-add="{item} is monthly only, but your cart is yearly."
        data-msg-yearly-blocked="Yearly billing isn't available with {items}. They're monthly only."
        data-msg-plan-switch="Switching to {plan} doesn't work with {items}."
        data-msg-mixed="Monthly and yearly items can't be paid together. Pick one billing term in your cart."
        data-fix-remove="Remove {item}"
        data-fix-replace="Replace {old} with {new}"
        data-fix-switch-plan="Switch to {plan} and add it"
        data-fix-switch-monthly="Switch everything to monthly"
        data-fix-switch-yearly="Remove {items} and switch to yearly"
        data-fix-switch-remove="Switch and remove {items}"
        data-keep-plan="Keep {plan}"
        data-keep-item="Keep {item}"
        data-keep-as-is="Keep as is"
        data-dont-add="Don't add it">
        <h2 data-cart-conflict-title></h2>
        <p data-cart-conflict-message></p>
        <div data-cart-conflict-actions></div>
        <button type="button" data-cart-conflict-close aria-label="Close">×</button>
      </div>
    </body></html>`,
    {
      url: options.french ? 'https://webao.ca/fr/commencer' : 'https://webao.ca/start',
      runScripts: 'dangerously',
      pretendToBeVisual: true,
      virtualConsole: quietConsole(),
    },
  );
  const { window } = dom;
  const doc = window.document;
  if (options.cart) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(options.cart));
  if (options.billing) window.localStorage.setItem(BILLING_KEY, options.billing);
  if (options.customer) window.sessionStorage.setItem(CUSTOMER_KEY, JSON.stringify(options.customer));

  // The owner notification is fire-and-forget; capture it instead of sending it.
  const requests: Array<{ url: string; body: unknown; keepalive?: boolean }> = [];
  (window as unknown as { fetch: typeof fetch }).fetch = ((url: string, init?: RequestInit) => {
    requests.push({ url, body: JSON.parse(String(init?.body)), keepalive: init?.keepalive });
    return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
  }) as typeof fetch;
  // Navigation is not implemented in jsdom; record the target instead.
  const navigations: string[] = [];

  initCart(doc);
  initStart(doc, { navigate: (href) => navigations.push(href) });

  const cart = () => JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '[]') as CartItem[];
  const radio = (product: string) => doc.querySelector<HTMLInputElement>(`input[name="plan"][value="${product}"]`)!;
  const price = (product: string) => radio(product).closest('label')!.querySelector('[data-plan-price]')!.textContent;
  const form = doc.querySelector<HTMLFormElement>('form[data-start-form]')!;
  const fill = (values: Record<string, string>) => {
    for (const [name, value] of Object.entries(values)) {
      (form.elements.namedItem(name) as HTMLInputElement).value = value;
    }
  };
  const submit = () => {
    const event = new window.Event('submit', { bubbles: true, cancelable: true });
    form.dispatchEvent(event);
    return event;
  };
  const choose = (product: string) => {
    radio(product).checked = true;
    radio(product).dispatchEvent(new window.Event('change', { bubbles: true }));
  };
  const chip = (branch: string) => doc.querySelector<HTMLButtonElement>(`[data-branch-toggle="${branch}"]`)!;
  const adsRadio = (product: string) =>
    doc.querySelector<HTMLInputElement>(`input[name="ads-channel"][value="${product}"]`)!;
  const aiBox = (product: string) =>
    doc.querySelector<HTMLInputElement>(`input[name="ai-service"][value="${product}"]`)!;
  const gbpBox = () => doc.querySelector<HTMLInputElement>('input[name="gbp"]')!;
  const chooseAds = (product: string) => {
    adsRadio(product).checked = true;
    adsRadio(product).dispatchEvent(new window.Event('change', { bubbles: true }));
  };
  const toggleBox = (input: HTMLInputElement, on: boolean) => {
    input.checked = on;
    input.dispatchEvent(new window.Event('change', { bubbles: true }));
  };
  const summary = () => doc.querySelector<HTMLElement>('[data-start-extras-list]')!.textContent ?? '';
  const conflict = () => doc.querySelector<HTMLElement>('[data-cart-conflict]')!;
  const conflictMessage = () =>
    doc.querySelector<HTMLElement>('[data-cart-conflict-message]')!.textContent ?? '';
  const conflictButtons = () =>
    [...doc.querySelectorAll<HTMLElement>('[data-cart-conflict-actions] button')].map((b) => b.textContent ?? '');
  const clickConflictButton = (label: string) => {
    const btn = [...doc.querySelectorAll<HTMLElement>('[data-cart-conflict-actions] button')].find(
      (b) => b.textContent === label,
    );
    click(btn ?? null);
  };
  const click = (el: Element | null) => {
    assert.ok(el, 'expected element to click');
    el!.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  };
  const error = (field: string) => form.querySelector<HTMLElement>(`[data-error="${field}"]`)!;
  return { dom, window, doc, cart, radio, price, form, fill, submit, choose, click, error, requests, navigations, chip, adsRadio, aiBox, gbpBox, chooseAds, toggleBox, summary, conflict, conflictMessage, conflictButtons, clickConflictButton };
}

const details = { name: 'Ada Lovelace', email: 'ada@example.com', business: 'Analytical Engines' };

test('an empty cart is seeded with the Grow plan and says so', () => {
  const { window, doc, cart, radio, price } = fixture();
  assert.deepEqual(
    cart().map((item) => item.key),
    ['grow-month'],
  );
  assert.equal(radio('grow').checked, true);
  assert.equal(radio('launch').checked, false);
  assert.equal(price('grow'), 'C$149.99/mo');
  assert.equal(price('launch'), 'C$89.99/mo');
  assert.equal(doc.querySelector<HTMLElement>('[data-start-default-note]')!.hidden, false);
  assert.equal(doc.querySelector('[data-start-total]')!.textContent, 'C$149.99');
  // The layout's drawer sees the same cart.
  assert.equal(doc.querySelector('[data-cart-count]')!.textContent, '1');
  assert.equal(doc.querySelector('[data-cart-checkout]')!.getAttribute('aria-disabled'), 'false');
  window.close();
});

test('a visitor arriving with a cart keeps exactly that cart', () => {
  const launch = planItem('launch', 'Launch', 'year')!;
  const extra: CartItem = { key: 'extrapage-one-time', product: 'extrapage', name: 'Extra Page', priceCents: 4499, interval: 'one-time', type: 'addon' };
  const { window, doc, cart, radio, price } = fixture({ cart: [launch, extra], billing: 'year' });
  assert.deepEqual(
    cart().map((item) => item.key),
    ['launch-year', 'extrapage-one-time'],
  );
  assert.equal(radio('launch').checked, true);
  assert.equal(price('launch'), 'C$899.90/yr');
  assert.equal(price('grow'), 'C$1,499.90/yr');
  assert.equal(doc.querySelector<HTMLElement>('[data-start-default-note]')!.hidden, true);
  const extras = doc.querySelector<HTMLElement>('[data-start-extras]')!;
  assert.equal(extras.hidden, false);
  assert.match(extras.textContent ?? '', /Extra Page/);
  assert.match(extras.textContent ?? '', /C\$44\.99 one-time/);
  assert.equal(
    extras.querySelector('[data-remove-key="extrapage-one-time"]')!.getAttribute('aria-label'),
    'Remove Extra Page',
  );
  assert.equal(doc.querySelector('[data-start-total]')!.textContent, 'C$944.89');
  window.close();
});

test('switching to a plan that already includes an add-on asks before dropping it', () => {
  const extra: CartItem = { key: 'review-month', product: 'review', name: 'Review Generation Engine', priceCents: 9999, interval: 'month', type: 'addon' };
  const { window, doc, cart, radio, choose, conflict, conflictMessage, conflictButtons, clickConflictButton } = fixture({ cart: [planItem('grow', 'Grow', 'month')!, extra] });
  choose('scale');
  assert.equal(conflict().hidden, false);
  assert.equal(conflictMessage(), "Switching to Scale doesn't work with Review Generation Engine.");
  assert.deepEqual(conflictButtons(), ['Switch and remove Review Generation Engine', 'Keep Grow']);
  assert.deepEqual(
    cart().map((item) => item.key),
    ['grow-month', 'review-month'],
  );
  clickConflictButton('Switch and remove Review Generation Engine');
  assert.equal(conflict().hidden, true);
  assert.deepEqual(
    cart().map((item) => item.key),
    ['scale-month'],
  );
  assert.equal(radio('scale').checked, true);
  assert.equal(radio('grow').checked, false);
  assert.equal(doc.querySelector('[data-start-total]')!.textContent, 'C$349.99');
  // The default note only describes the seeded Grow plan.
  assert.equal(doc.querySelector<HTMLElement>('[data-start-default-note]')!.hidden, true);
  window.close();
});

test('the yearly toggle re-prices the plan options and the selection', () => {
  const { window, doc, cart, price, click } = fixture();
  click(doc.querySelector('[data-billing-opt="year"]'));
  assert.deepEqual(
    cart().map((item) => item.key),
    ['grow-year'],
  );
  assert.equal(window.localStorage.getItem(BILLING_KEY), 'year');
  assert.equal(doc.querySelector('[data-billing-opt="year"]')!.getAttribute('aria-pressed'), 'true');
  assert.equal(price('grow'), 'C$1,499.90/yr');
  assert.equal(price('scale'), 'C$3,499.90/yr');
  assert.equal(doc.querySelector('[data-start-total]')!.textContent, 'C$1,499.90');
  window.close();
});

test('the yearly toggle converts the AI Pack to its yearly price', () => {
  const { window, doc, cart, chip, click, toggleBox, aiBox } = fixture();
  click(chip('ai'));
  toggleBox(aiBox('ai-pack'), true);
  assert.deepEqual(
    cart().map((item) => item.key),
    ['grow-month', 'ai-pack-month'],
  );
  click(doc.querySelector('[data-billing-opt="year"]'));
  assert.deepEqual(
    cart().map((item) => [item.key, item.priceCents]),
    [
      ['grow-year', 149990],
      ['ai-pack-year', 399990],
    ],
  );
  assert.equal(doc.querySelector('[data-start-total]')!.textContent, 'C$5,499.80');
  window.close();
});

test('removing an add-on from the selection card updates the cart', () => {
  const extra: CartItem = { key: 'extrapage-one-time', product: 'extrapage', name: 'Extra Page', priceCents: 4499, interval: 'one-time', type: 'addon' };
  const { window, doc, cart, click, summary } = fixture({ cart: [planItem('grow', 'Grow', 'month')!, extra] });
  click(doc.querySelector('[data-remove-key="extrapage-one-time"]'));
  assert.deepEqual(
    cart().map((item) => item.key),
    ['grow-month'],
  );
  // The summary keeps the plan row; only the add-on is gone.
  assert.match(summary(), /Grow/);
  assert.doesNotMatch(summary(), /Extra Page/);
  assert.equal(doc.querySelector('[data-start-total]')!.textContent, 'C$149.99');
  window.close();
});

test('an empty form shows one error per field and goes nowhere', () => {
  const { window, submit, error, requests, navigations, form } = fixture();
  const event = submit();
  assert.equal(event.defaultPrevented, true);
  assert.equal(error('name').textContent, 'Please enter your name.');
  assert.equal(error('email').textContent, 'Please enter your email.');
  assert.equal(error('business').textContent, 'Please enter your business name.');
  assert.equal(error('name').hidden, false);
  assert.equal(form.querySelector('[name="name"]')!.getAttribute('aria-invalid'), 'true');
  assert.equal(requests.length, 0);
  assert.equal(navigations.length, 0);
  assert.equal(window.sessionStorage.getItem(CUSTOMER_KEY), null);
  window.close();
});

test('a malformed email is rejected and the error clears once fixed', () => {
  const { window, fill, submit, error, form, navigations } = fixture();
  fill({ ...details, email: 'not-an-email' });
  submit();
  assert.equal(error('email').textContent, 'Please enter a valid email.');
  assert.equal(error('name').hidden, true);
  assert.equal(navigations.length, 0);

  const email = form.elements.namedItem('email') as HTMLInputElement;
  email.value = 'ada@example.com';
  email.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal(error('email').hidden, true);
  assert.equal(email.classList.contains('input-error'), false);
  window.close();
});

test('valid details are stored, the owner is notified and the visitor moves to checkout', () => {
  const { window, fill, submit, requests, navigations, form } = fixture();
  fill(details);
  submit();

  assert.deepEqual(readCustomer(window as never), details);
  assert.deepEqual(navigations, ['/checkout']);
  assert.equal(form.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled, true);

  assert.equal(requests.length, 1);
  const [request] = requests;
  assert.equal(request.url, '/api/forms/submit');
  assert.equal(request.keepalive, true);
  const body = request.body as { form: string; fields: Record<string, string> };
  assert.equal(body.form, 'pricing');
  assert.equal(body.fields.name, details.name);
  assert.equal(body.fields.email, details.email);
  assert.equal(body.fields.business, details.business);
  assert.equal(body.fields.items, 'grow-month');
  assert.equal(body.fields.selection, 'Grow (C$149.99/mo)');
  assert.equal(body.fields.billing, 'month');
  assert.equal(body.fields.page, '/start');
  window.close();
});

test('French pages hand over to the French checkout with French money', () => {
  const { window, doc, fill, submit, requests, navigations, price } = fixture({ french: true });
  doc.querySelector<HTMLFormElement>('form[data-start-form]')!.dataset.checkoutPath = '/fr/checkout';
  assert.equal(price('grow'), '149,99\u00a0$/mois');
  fill(details);
  submit();
  assert.deepEqual(navigations, ['/fr/checkout']);
  const body = requests[0].body as { fields: Record<string, string> };
  assert.equal(body.fields.selection, 'Grow (149,99\u00a0$/mois)');
  assert.equal(body.fields.page, '/fr/commencer');
  window.close();
});

test('add-ons without a plan can continue, with a hint', () => {
  const extra: CartItem = { key: 'extrapage-one-time', product: 'extrapage', name: 'Extra Page', priceCents: 4499, interval: 'one-time', type: 'addon' };
  const { window, doc, cart, fill, submit, navigations } = fixture({ cart: [extra] });
  // No seeding: the visitor already chose something.
  assert.deepEqual(
    cart().map((item) => item.key),
    ['extrapage-one-time'],
  );
  assert.equal(doc.querySelector<HTMLElement>('[data-start-no-plan]')!.hidden, false);
  assert.equal(doc.querySelector<HTMLInputElement>('input[name="plan"][value="none"]')!.checked, true);
  fill(details);
  submit();
  assert.deepEqual(navigations, ['/checkout']);
  window.close();
});

test('an emptied cart blocks the hand-off until something is selected again', () => {
  const { window, doc, fill, submit, navigations, choose, click } = fixture();
  // Remove the seeded plan through the layout's drawer.
  click(doc.querySelector('[data-cart-items] [data-remove-key="grow-month"]'));
  assert.equal(window.localStorage.getItem(STORAGE_KEY), '[]');
  assert.equal(doc.querySelector<HTMLInputElement>('input[name="plan"][value="none"]')!.checked, true);

  fill(details);
  submit();
  assert.equal(navigations.length, 0);
  assert.equal(doc.querySelector<HTMLElement>('[data-start-selection-error]')!.hidden, false);

  choose('launch');
  assert.equal(doc.querySelector<HTMLElement>('[data-start-selection-error]')!.hidden, true);
  submit();
  assert.deepEqual(navigations, ['/checkout']);
  window.close();
});

test('stored details prefill the form on a return visit', () => {
  const { window, form } = fixture({ customer: { ...details, name: '  Ada Lovelace  ' } });
  assert.equal((form.elements.namedItem('name') as HTMLInputElement).value, 'Ada Lovelace');
  assert.equal((form.elements.namedItem('email') as HTMLInputElement).value, details.email);
  assert.equal((form.elements.namedItem('business') as HTMLInputElement).value, details.business);
  window.close();
});

test('the page survives a ClientRouter navigation without double-binding', () => {
  const { window, doc, cart, choose, requests, fill, submit, navigations } = fixture();
  // A second init (new page view) must not add a second set of listeners.
  initStart(doc);
  doc.dispatchEvent(new window.Event('astro:page-load'));
  choose('launch');
  assert.deepEqual(
    cart().map((item) => item.key),
    ['launch-month'],
  );
  fill(details);
  submit();
  assert.equal(requests.length, 1);
  assert.deepEqual(navigations, ['/checkout']);
  window.close();
});

test('an Ads channel can be added on the start page and replaces the previous channel', () => {
  const { window, doc, cart, chip, click, chooseAds, summary } = fixture();
  assert.equal(chip('ads').getAttribute('aria-pressed'), 'false');
  assert.equal(doc.querySelector<HTMLElement>('[data-branch-picker="ads"]')!.hidden, true);
  click(chip('ads'));
  assert.equal(chip('ads').getAttribute('aria-pressed'), 'true');
  assert.equal(doc.querySelector<HTMLElement>('[data-branch-picker="ads"]')!.hidden, false);

  chooseAds('ads-meta');
  assert.deepEqual(
    cart().map((item) => item.key),
    ['grow-month', 'ads-meta-month'],
  );
  assert.match(summary(), /Ads/);
  assert.match(summary(), /Meta/);
  assert.equal(doc.querySelector('[data-start-total]')!.textContent, 'C$1,049.98');

  chooseAds('ads-both');
  assert.deepEqual(
    cart().map((item) => item.key),
    ['grow-month', 'ads-both-month'],
  );
  assert.equal(doc.querySelector('[data-start-total]')!.textContent, 'C$1,499.98');
  window.close();
});

test('picking a channel while the Starter test is in the cart asks before replacing it', () => {
  const starter: CartItem = { key: 'ads-starter-month', product: 'ads-starter', name: 'Starter test', priceCents: 49999, interval: 'month', type: 'addon' };
  const { window, cart, chip, click, chooseAds, conflict, conflictMessage, conflictButtons, clickConflictButton } = fixture({
    cart: [planItem('grow', 'Grow', 'month')!, starter],
  });
  click(chip('ads'));
  chooseAds('ads-meta');
  assert.equal(conflict().hidden, false);
  assert.equal(conflictMessage(), 'You can only have one Ads option at a time.');
  assert.deepEqual(conflictButtons(), ['Replace Starter test with Meta', "Don't add it"]);
  assert.deepEqual(
    cart().map((item) => item.key),
    ['grow-month', 'ads-starter-month'],
  );
  clickConflictButton('Replace Starter test with Meta');
  assert.equal(conflict().hidden, true);
  assert.deepEqual(
    cart().map((item) => item.key),
    ['grow-month', 'ads-meta-month'],
  );
  window.close();
});

test('the GBP revamp toggles on and off', () => {
  const { window, cart, chip, click, toggleBox, gbpBox } = fixture();
  click(chip('ads'));
  toggleBox(gbpBox(), true);
  assert.deepEqual(
    cart().map((item) => item.key),
    ['grow-month', 'gbp-revamp-one-time'],
  );
  toggleBox(gbpBox(), false);
  assert.deepEqual(
    cart().map((item) => item.key),
    ['grow-month'],
  );
  window.close();
});

test('AI services can be added, and the Pack asks before replacing the individuals', () => {
  const { window, cart, chip, click, toggleBox, aiBox, conflict, conflictMessage, conflictButtons, clickConflictButton } = fixture();
  click(chip('ai'));
  toggleBox(aiBox('ai-receptionist'), true);
  toggleBox(aiBox('ai-followup'), true);
  assert.deepEqual(
    cart().map((item) => item.key),
    ['grow-month', 'ai-receptionist-month', 'ai-followup-month'],
  );
  toggleBox(aiBox('ai-pack'), true);
  assert.equal(conflict().hidden, false);
  assert.equal(conflictMessage(), 'The AI Pack already includes AI Receptionist, AI Follow-up.');
  assert.deepEqual(conflictButtons(), ['Replace AI Receptionist, AI Follow-up with AI Pack', "Don't add it"]);
  assert.deepEqual(
    cart().map((item) => item.key),
    ['grow-month', 'ai-receptionist-month', 'ai-followup-month'],
  );
  clickConflictButton('Replace AI Receptionist, AI Follow-up with AI Pack');
  assert.equal(conflict().hidden, true);
  assert.deepEqual(
    cart().map((item) => item.key),
    ['grow-month', 'ai-pack-month'],
  );
  // The fix re-syncs the checkboxes: the individuals are off, the Pack is on.
  assert.equal(aiBox('ai-pack').checked, true);
  assert.equal(aiBox('ai-followup').checked, false);
  toggleBox(aiBox('ai-followup'), true);
  assert.equal(conflict().hidden, false);
  assert.equal(conflictMessage(), 'The AI Pack already includes AI Follow-up.');
  // The Pack ($399.99) costs more than one individual ($99.99), so keeping
  // the Pack is the main button and swapping down is only the second choice.
  assert.deepEqual(conflictButtons(), ['Keep AI Pack', 'Replace AI Pack with AI Follow-up']);
  clickConflictButton('Replace AI Pack with AI Follow-up');
  assert.deepEqual(
    cart().map((item) => item.key),
    ['grow-month', 'ai-followup-month'],
  );
  window.close();
});

test('the Pack keeps the individuals when all three together cost more', () => {
  const { window, cart, chip, click, toggleBox, aiBox, conflict, conflictMessage, conflictButtons, clickConflictButton } = fixture();
  click(chip('ai'));
  toggleBox(aiBox('ai-receptionist'), true);
  toggleBox(aiBox('aichat'), true);
  toggleBox(aiBox('ai-followup'), true);
  assert.deepEqual(
    cart().map((item) => item.key),
    ['grow-month', 'ai-receptionist-month', 'aichat-month', 'ai-followup-month'],
  );
  toggleBox(aiBox('ai-pack'), true);
  assert.equal(conflict().hidden, false);
  assert.equal(conflictMessage(), 'The AI Pack already includes AI Receptionist, Trained AI Chat Assistant, AI Follow-up.');
  // All three individuals ($499.97) cost more than the Pack ($399.99), so
  // the main button keeps them and the Pack swap is the second choice.
  assert.deepEqual(conflictButtons(), [
    'Keep AI Receptionist, Trained AI Chat Assistant, AI Follow-up',
    'Replace AI Receptionist, Trained AI Chat Assistant, AI Follow-up with AI Pack',
  ]);
  clickConflictButton('Keep AI Receptionist, Trained AI Chat Assistant, AI Follow-up');
  assert.equal(conflict().hidden, true);
  assert.deepEqual(
    cart().map((item) => item.key),
    ['grow-month', 'ai-receptionist-month', 'aichat-month', 'ai-followup-month'],
  );
  assert.equal(aiBox('ai-pack').checked, false);
  toggleBox(aiBox('ai-pack'), true);
  clickConflictButton('Replace AI Receptionist, Trained AI Chat Assistant, AI Follow-up with AI Pack');
  assert.deepEqual(
    cart().map((item) => item.key),
    ['grow-month', 'ai-pack-month'],
  );
  window.close();
});

test('dismissing the AI Pack popup unticks its checkbox', () => {
  const { window, cart, chip, click, toggleBox, aiBox, conflict, conflictButtons, clickConflictButton } = fixture();
  click(chip('ai'));
  toggleBox(aiBox('ai-receptionist'), true);
  toggleBox(aiBox('ai-followup'), true);
  toggleBox(aiBox('ai-pack'), true);
  assert.equal(conflict().hidden, false);
  clickConflictButton("Don't add it");
  assert.equal(conflict().hidden, true);
  // The browser had already ticked the Pack box; the cart never changed,
  // so the checkbox must snap back to the cart.
  assert.equal(aiBox('ai-pack').checked, false);
  assert.equal(aiBox('ai-receptionist').checked, true);
  assert.equal(aiBox('ai-followup').checked, true);
  assert.deepEqual(
    cart().map((item) => item.key),
    ['grow-month', 'ai-receptionist-month', 'ai-followup-month'],
  );
  window.close();
});

test('dismissing a blocked plan switch keeps the old plan ticked', () => {
  const extra: CartItem = { key: 'review-month', product: 'review', name: 'Review Generation Engine', priceCents: 9999, interval: 'month', type: 'addon' };
  const { window, cart, radio, choose, conflict, clickConflictButton } = fixture({ cart: [planItem('grow', 'Grow', 'month')!, extra] });
  choose('scale');
  assert.equal(conflict().hidden, false);
  clickConflictButton('Keep Grow');
  assert.equal(radio('grow').checked, true);
  assert.equal(radio('scale').checked, false);
  assert.deepEqual(
    cart().map((item) => item.key),
    ['grow-month', 'review-month'],
  );
  window.close();
});

test('dismissing a blocked channel pick keeps the channel radios as they were', () => {
  const starter: CartItem = { key: 'ads-starter-month', product: 'ads-starter', name: 'Starter test', priceCents: 49999, interval: 'month', type: 'addon' };
  const { window, cart, chip, click, chooseAds, adsRadio, conflict, clickConflictButton } = fixture({
    cart: [planItem('grow', 'Grow', 'month')!, starter],
  });
  click(chip('ads'));
  chooseAds('ads-meta');
  assert.equal(conflict().hidden, false);
  clickConflictButton("Don't add it");
  assert.equal(adsRadio('ads-meta').checked, false);
  assert.equal(adsRadio('none').checked, true);
  assert.deepEqual(
    cart().map((item) => item.key),
    ['grow-month', 'ads-starter-month'],
  );
  window.close();
});

test('the yearly toggle is blocked while a monthly-only AI service is in the cart', () => {
  const { window, doc, cart, chip, click, toggleBox, aiBox, conflict, conflictMessage, conflictButtons, clickConflictButton } = fixture();
  click(chip('ai'));
  toggleBox(aiBox('ai-followup'), true);
  assert.deepEqual(
    cart().map((item) => item.key),
    ['grow-month', 'ai-followup-month'],
  );
  click(doc.querySelector('[data-billing-opt="year"]'));
  assert.equal(conflict().hidden, false);
  assert.equal(conflictMessage(), "Yearly billing isn't available with AI Follow-up. They're monthly only.");
  assert.deepEqual(conflictButtons(), ['Remove AI Follow-up and switch to yearly', 'Keep as is']);
  clickConflictButton('Keep as is');
  assert.deepEqual(
    cart().map((item) => item.key),
    ['grow-month', 'ai-followup-month'],
  );
  click(doc.querySelector('[data-billing-opt="year"]'));
  clickConflictButton('Remove AI Follow-up and switch to yearly');
  assert.deepEqual(
    cart().map((item) => item.key),
    ['grow-year'],
  );
  window.close();
});

test('the summary groups products by branch, in Website, Ads, AI order', () => {
  const { window, summary } = fixture({
    cart: [
      { key: 'ai-followup-month', product: 'ai-followup', name: 'AI Follow-up', priceCents: 9999, interval: 'month', type: 'addon' },
      { key: 'ads-meta-month', product: 'ads-meta', name: 'Meta', priceCents: 89999, interval: 'month', type: 'bundle' },
      planItem('grow', 'Grow', 'month')!,
    ],
  });
  const text = summary();
  assert.ok(text.indexOf('Website') < text.indexOf('Grow'));
  assert.ok(text.indexOf('Grow') < text.indexOf('Ads'));
  assert.ok(text.indexOf('Ads') < text.indexOf('Meta'));
  assert.ok(text.indexOf('Meta') < text.indexOf('AI'));
  assert.ok(text.indexOf('AI') < text.indexOf('AI Follow-up'));
  window.close();
});

test('the eyebrow and the no-plan hint follow the branches in the cart', () => {
  const aiOnly = fixture({
    cart: [
      { key: 'ai-receptionist-month', product: 'ai-receptionist', name: 'AI Receptionist', priceCents: 29999, interval: 'month', type: 'addon' },
    ],
  });
  assert.equal(aiOnly.doc.querySelector('[data-start-eyebrow]')!.textContent, 'Start your AI');
  assert.equal(aiOnly.doc.querySelector<HTMLElement>('[data-start-no-plan]')!.hidden, false);
  assert.equal(aiOnly.doc.querySelector<HTMLElement>('[data-start-no-plan]')!.textContent, 'No website plan selected.');
  aiOnly.window.close();

  const mixed = fixture({
    cart: [
      planItem('grow', 'Grow', 'month')!,
      { key: 'ads-meta-month', product: 'ads-meta', name: 'Meta', priceCents: 89999, interval: 'month', type: 'bundle' },
    ],
  });
  assert.equal(mixed.doc.querySelector('[data-start-eyebrow]')!.textContent, 'Start with WEBAO');
  mixed.window.close();
});

test('an AI-only order can drop the seeded plan and still reach checkout', () => {
  const { window, doc, cart, chip, click, toggleBox, aiBox, fill, submit, navigations } = fixture();
  const none = doc.querySelector<HTMLInputElement>('input[name="plan"][value="none"]')!;
  none.checked = true;
  none.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.deepEqual(cart(), []);
  click(chip('ai'));
  toggleBox(aiBox('ai-receptionist'), true);
  assert.deepEqual(
    cart().map((item) => item.key),
    ['ai-receptionist-month'],
  );
  fill(details);
  submit();
  assert.deepEqual(navigations, ['/checkout']);
  window.close();
});

test('details helpers validate and round-trip through sessionStorage', () => {
  assert.deepEqual(validateDetails({ name: '', email: '', business: '' }), {
    name: 'required',
    email: 'required',
    business: 'required',
  });
  assert.deepEqual(validateDetails({ ...details, email: 'nope' }), { email: 'format' });
  assert.deepEqual(validateDetails(details), {});
  assert.equal(hasValidDetails(null), false);
  assert.equal(hasValidDetails(details), true);

  const { window } = fixture();
  writeCustomer(window as never, { ...details, name: '  Ada Lovelace  ' });
  assert.deepEqual(readCustomer(window as never), details);
  window.sessionStorage.setItem(CUSTOMER_KEY, '{not json');
  assert.equal(readCustomer(window as never), null);
  window.sessionStorage.setItem(CUSTOMER_KEY, '[1,2]');
  assert.equal(hasValidDetails(readCustomer(window as never)), false);
  window.close();
});
