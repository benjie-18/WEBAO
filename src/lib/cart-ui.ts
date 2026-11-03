/**
 * WEBAO cart drawer — DOM layer for the cart.
 *
 * The layout renders an empty drawer plus the "add to cart" buttons; this
 * module owns everything that happens afterwards: reading/persisting the cart,
 * toggling items from the pricing page, re-rendering the drawer, the billing
 * term toggle, and keeping all of it alive across Astro ClientRouter
 * navigations (the body is replaced on every navigation, so listeners are
 * delegated from `document` and the UI is refreshed on `astro:page-load`).
 *
 * All functions take the document explicitly (defaulting to the real global)
 * so the whole flow can be tested in Node with jsdom. DOM checks avoid
 * `instanceof` on purpose: jsdom elements live in their own realm.
 */

import {
  CART_CHANGE_EVENT,
  STORAGE_KEY,
  cartKey,
  isRecurring,
  readCart,
  writeCart,
  type CartInterval,
  type CartItem,
} from "./cart";
import { convertItemsToBilling, type Billing } from "./cart-catalog";

/** localStorage key holding the active billing term. */
export const BILLING_KEY = "webao_billing_v1";

const INIT_FLAG = "__webaoCartUiBound";

/** Pending auto-disarm for the drawer's "empty cart" confirm state. */
let emptyAllTimer: ReturnType<typeof setTimeout> | null = null;

/** Restore the empty-cart button to its idle (red, "Empty cart") state. */
function disarmEmptyAll(doc: Document, btn: HTMLElement): void {
  if (emptyAllTimer) {
    clearTimeout(emptyAllTimer);
    emptyAllTimer = null;
  }
  btn.classList.remove("is-armed");
  btn.textContent = label(doc, "labelEmptyAll", "Empty cart");
}

/** First click on the empty-cart button: switch it to the confirm state. */
function armEmptyAll(doc: Document, btn: HTMLElement): void {
  btn.classList.add("is-armed");
  btn.textContent = label(doc, "labelEmptyConfirm", "Confirm");
  if (emptyAllTimer) clearTimeout(emptyAllTimer);
  emptyAllTimer = setTimeout(() => {
    emptyAllTimer = null;
    disarmEmptyAll(doc, btn);
  }, 3500);
}

type Win = Window & typeof globalThis;

/* ── storage ──────────────────────────────────────────────────────────── */

function storageOf(win: Win | null | undefined) {
  try {
    return win?.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Cart items as stored in the browser. */
export function getCart(win: Win | null | undefined): CartItem[] {
  return readCart(storageOf(win));
}

/** Persist items and notify listeners (drawer, buttons, other pages). */
export function setCart(win: Win | null | undefined, items: CartItem[]): void {
  writeCart(storageOf(win), items);
  if (!win) return;
  // Use the window's own CustomEvent so this works in jsdom tests too.
  const EventCtor = (win as unknown as { CustomEvent?: typeof CustomEvent }).CustomEvent;
  if (!EventCtor) return;
  win.dispatchEvent(new EventCtor(CART_CHANGE_EVENT, { detail: { items } }));
}

/** Active billing term, persisted across pages. Defaults to monthly. */
export function readBilling(win: Win | null | undefined): Billing {
  try {
    return storageOf(win)?.getItem(BILLING_KEY) === "year" ? "year" : "month";
  } catch {
    return "month";
  }
}

function writeBilling(win: Win | null | undefined, billing: Billing): void {
  try {
    storageOf(win)?.setItem(BILLING_KEY, billing);
  } catch {
    // Storage unavailable; the toggle just won't persist
  }
}

/* ── formatting ───────────────────────────────────────────────────────── */

export interface MoneyFormat {
  prefix: string;
  suffix: string;
  decimal: string;
}

const DEFAULT_MONEY: MoneyFormat = { prefix: "C$", suffix: "", decimal: "." };

/**
 * Currency presentation comes from the layout (English: "C$89.99",
 * French: "89,99 $"), so one formatter serves both locales.
 */
export function moneyFormat(doc: Document): MoneyFormat {
  const el = drawerEl(doc);
  const data = (el?.dataset ?? {}) as Record<string, string | undefined>;
  return {
    prefix: data.moneyPrefix ?? DEFAULT_MONEY.prefix,
    suffix: data.moneySuffix ?? DEFAULT_MONEY.suffix,
    decimal: data.moneyDecimal || DEFAULT_MONEY.decimal,
  };
}

/** `1234567` → "C$12,345.67" (en) / "12 345,67 $" (fr). */
export function formatMoney(cents: number, fmt: MoneyFormat = DEFAULT_MONEY): string {
  const fixed = (Math.round(cents) / 100).toFixed(2);
  const [whole, fraction] = fixed.split(".");
  const groupSeparator = fmt.decimal === "." ? "," : "\u00a0";
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, groupSeparator);
  return `${fmt.prefix}${grouped}${fmt.decimal}${fraction}${fmt.suffix}`;
}

/** Interval suffix from the drawer's locale data, e.g. "/mo" or "/mois". */
export function intervalSuffix(doc: Document, interval: CartInterval): string {
  const data = (drawerEl(doc)?.dataset ?? {}) as Record<string, string | undefined>;
  if (interval === "month") return data.suffixMonth ?? "/mo";
  if (interval === "year") return data.suffixYear ?? "/yr";
  return data.suffixOneTime ?? " one-time";
}

/** Localized string carried on the drawer as a `data-*` attribute. */
function label(doc: Document, name: string, fallback: string): string {
  const data = (drawerEl(doc)?.dataset ?? {}) as Record<string, string | undefined>;
  return data[name] ?? fallback;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* ── buttons ──────────────────────────────────────────────────────────── */

interface CartButtonInfo {
  product: string;
  name: string;
  type: CartItem["type"];
  interval: CartInterval;
  priceCents: number;
}

/**
 * The interval a button adds right now: one-time products ignore the billing
 * term, recurring products follow it (a yearly price must exist on the button).
 */
export function buttonInterval(btn: HTMLElement, billing: Billing): CartInterval {
  const base = (btn.dataset.interval as CartInterval | undefined) ?? "month";
  if (base === "one-time") return "one-time";
  const hasYear = (btn.dataset.priceYear ?? "") !== "";
  return hasYear ? billing : base;
}

/** Cart key a button adds/removes for the active billing term. */
export function buttonKey(btn: HTMLElement, billing: Billing): string {
  return cartKey(btn.dataset.product ?? "", buttonInterval(btn, billing));
}

function buttonInfo(btn: HTMLElement, billing: Billing): CartButtonInfo | null {
  const product = btn.dataset.product;
  if (!product) return null;
  const interval = buttonInterval(btn, billing);
  const price = interval === "year" ? btn.dataset.priceYear : btn.dataset.priceCents;
  const priceCents = Number(price);
  if (!Number.isFinite(priceCents)) return null;
  return {
    product,
    name: btn.dataset.name ?? product,
    type: (btn.dataset.type as CartItem["type"] | undefined) ?? "addon",
    interval,
    priceCents,
  };
}

/** Add the button's product, or remove it when it is already in the cart. */
export function toggleFromButton(btn: HTMLElement, doc: Document): void {
  const win = doc.defaultView;
  const info = buttonInfo(btn, readBilling(win));
  if (!info) return;
  const cart = getCart(win);
  const key = cartKey(info.product, info.interval);

  if (cart.some((item) => item.key === key)) {
    setCart(
      win,
      cart.filter((item) => item.key !== key),
    );
    return;
  }

  let next = cart.filter((item) => item.key !== key);
  // Only one plan at a time (adding a plan replaces the previous plan).
  if (info.type === "plan") next = next.filter((item) => item.type !== "plan");
  // Stripe cannot bill monthly and yearly prices in the same session, so the
  // cart always keeps a single term.
  if (isRecurring(info.interval)) next = convertItemsToBilling(next, info.interval as Billing);
  next.push({ key, ...info });
  setCart(win, next);
}

/** Reflect cart state on every "add to cart" button. */
export function syncButtons(doc: Document): void {
  const billing = readBilling(doc.defaultView);
  const keys = new Set(getCart(doc.defaultView).map((item) => item.key));
  doc.querySelectorAll<HTMLElement>("[data-cart-btn]").forEach((btn) => {
    const added = keys.has(buttonKey(btn, billing));
    btn.classList.toggle("is-added", added);
    const name = btn.dataset.name ?? btn.dataset.product ?? "";
    const add = label(doc, "labelAdd", "Add {name} to cart").replace("{name}", name);
    const remove = label(doc, "labelRemove", "Remove {name} from cart").replace("{name}", name);
    btn.setAttribute("aria-label", added ? remove : add);
    btn.setAttribute("title", added ? remove : add);
    btn.setAttribute("aria-pressed", added ? "true" : "false");
  });
}

/** Header badge and the open-cart button's label. */
export function updateCount(doc: Document): void {
  const count = getCart(doc.defaultView).length;
  const openLabel = label(doc, "labelOpen", "Open cart");
  doc.querySelectorAll<HTMLElement>("[data-cart-count]").forEach((badge) => {
    badge.textContent = String(count);
    badge.hidden = count === 0;
  });
  doc.querySelectorAll<HTMLElement>("[data-cart-open]").forEach((btn) => {
    btn.setAttribute("aria-label", count > 0 ? `${openLabel} (${count})` : openLabel);
  });
}

/* ── drawer ───────────────────────────────────────────────────────────── */

function drawerEl(doc: Document): HTMLElement | null {
  return doc.querySelector<HTMLElement>("[data-cart-drawer]");
}

function overlayEl(doc: Document): HTMLElement | null {
  return doc.querySelector<HTMLElement>("[data-cart-overlay]");
}

/** Re-render the drawer contents, total and checkout button state. */
export function renderDrawer(doc: Document): void {
  const container = doc.querySelector<HTMLElement>("[data-cart-items]");
  if (!container) return;
  const items = getCart(doc.defaultView);
  const fmt = moneyFormat(doc);

  if (items.length === 0) {
    const title = label(doc, "emptyTitle", "Your cart is empty.");
    const hint = label(doc, "emptyHint", "Add items from the pricing page.");
    container.innerHTML = `<div class="cart-drawer-empty">${escapeHtml(title)}<br/>${escapeHtml(hint)}</div>`;
  } else {
    const removeLabel = label(doc, "labelRemove", "Remove {name} from cart");
    container.innerHTML = items
      .map(
        (item) => `
        <div class="cart-item" data-cart-item="${escapeHtml(item.key)}">
          <div class="cart-item-info">
            <p class="cart-item-name">${escapeHtml(item.name)}</p>
            <p class="cart-item-meta">${formatMoney(item.priceCents, fmt)}${escapeHtml(
              intervalSuffix(doc, item.interval),
            )}</p>
          </div>
          <button type="button" class="cart-item-remove" data-remove-key="${escapeHtml(item.key)}" aria-label="${escapeHtml(
            removeLabel.replace("{name}", item.name),
          )}">
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M3.5 8h9" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>
            </svg>
          </button>
        </div>`,
      )
      .join("");
  }

  const total = items.reduce((sum, item) => sum + item.priceCents, 0);
  doc.querySelectorAll<HTMLElement>("[data-cart-total]").forEach((el) => {
    el.textContent = formatMoney(total, fmt);
  });

  const checkout = doc.querySelector<HTMLElement>("[data-cart-checkout]");
  if (checkout) {
    const empty = items.length === 0;
    checkout.classList.toggle("is-disabled", empty);
    checkout.setAttribute("aria-disabled", empty ? "true" : "false");
    checkout.tabIndex = empty ? -1 : 0;
  }

  // Empty-cart button (end of the item list): visible only with items, and
  // every re-render resets it to the idle state, so a stray cart change can
  // never leave a live "Confirm" armed.
  const emptyAll = doc.querySelector<HTMLElement>("[data-cart-empty-all]");
  if (emptyAll) {
    disarmEmptyAll(doc, emptyAll);
    emptyAll.hidden = items.length === 0;
  }

  // "Start your site" CTAs (header + mobile panel): with items in the cart
  // they skip the pricing page and go straight to payment — /checkout itself
  // detours to /start when no details are stored yet, so the funnel still
  // collects them. With an empty cart they keep their pricing target.
  const checkoutHref = doc.location?.pathname.startsWith("/fr/") ? "/fr/checkout" : "/checkout";
  doc.querySelectorAll<HTMLAnchorElement>("[data-start-cta]").forEach((a) => {
    if (!a.dataset.pricingHref) a.dataset.pricingHref = a.getAttribute("href") ?? "";
    a.setAttribute("href", items.length > 0 ? checkoutHref : a.dataset.pricingHref);
  });
}

/** Reflect the active billing term on the toggle. */
export function syncBillingToggle(doc: Document): void {
  const billing = readBilling(doc.defaultView);
  doc.querySelectorAll<HTMLElement>("[data-billing-opt]").forEach((btn) => {
    const active = btn.dataset.billingOpt === billing;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-pressed", active ? "true" : "false");
  });
}

/** Buttons, badge, toggle and drawer — everything derived from cart state. */
export function refresh(doc: Document): void {
  clearCartOnPaidPage(doc);
  syncButtons(doc);
  updateCount(doc);
  syncBillingToggle(doc);
  renderDrawer(doc);
}

/**
 * The success page marks itself with `data-cart-clear`: once payment went
 * through, the cart is emptied so the next order starts fresh.
 */
function clearCartOnPaidPage(doc: Document): void {
  if (!doc.querySelector("[data-cart-clear]")) return;
  const win = doc.defaultView;
  if (getCart(win).length > 0) setCart(win, []);
}

export function openDrawer(doc: Document): void {
  const drawer = drawerEl(doc);
  const overlay = overlayEl(doc);
  // Remember who opened the drawer so focus can return there on close.
  (doc as unknown as Record<string, unknown>).__webaoCartOpener = doc.activeElement;
  if (drawer) {
    drawer.hidden = false;
    requestFrame(() => drawer.classList.add("is-open"));
  }
  if (overlay) {
    overlay.hidden = false;
    requestFrame(() => overlay.classList.add("is-open"));
  }
  if (doc.body) doc.body.style.overflow = "hidden";
  renderDrawer(doc);
  // Modal behavior: move focus inside. The close button is first in the
  // drawer header, so keyboard users land on a way out, not a dead end.
  const closeBtn = drawer?.querySelector<HTMLElement>("[data-cart-close]");
  if (closeBtn) closeBtn.focus();
}

export function closeDrawer(doc: Document, options: { instant?: boolean } = {}): void {
  const drawer = drawerEl(doc);
  const overlay = overlayEl(doc);
  if (drawer) drawer.classList.remove("is-open");
  if (overlay) overlay.classList.remove("is-open");
  if (doc.body) doc.body.style.overflow = "";
  const opener = (doc as unknown as Record<string, unknown>).__webaoCartOpener as
    | HTMLElement
    | null
    | undefined;
  const returnFocus = () => {
    if (opener && typeof (opener as HTMLElement).focus === "function" && doc.contains(opener)) {
      (opener as HTMLElement).focus();
    }
  };
  if (options.instant) {
    if (drawer) drawer.hidden = true;
    if (overlay) overlay.hidden = true;
    returnFocus();
    return;
  }
  setTimeout(() => {
    if (drawer) drawer.hidden = true;
    if (overlay) overlay.hidden = true;
    returnFocus();
  }, 350);
}

/**
 * Keep Tab inside the open drawer (WCAG dialog pattern). Without this,
 * keyboard users tabbed straight out of the drawer into the page behind
 * the overlay, and closing dropped focus entirely.
 */
function trapDrawerTab(event: KeyboardEvent, doc: Document): void {
  const drawer = drawerEl(doc);
  if (!drawer || drawer.hidden) return;
  const focusables = Array.from(
    drawer.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((el) => !el.hasAttribute("hidden"));
  if (focusables.length === 0) return;
  const active = doc.activeElement as HTMLElement | null;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (event.shiftKey) {
    if (active === first || !drawer.contains(active)) {
      event.preventDefault();
      last.focus();
    }
  } else {
    if (active === last || !drawer.contains(active)) {
      event.preventDefault();
      first.focus();
    }
  }
}

function requestFrame(fn: () => void): void {
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => fn());
  else setTimeout(fn, 0);
}

/** Switch the billing term for the whole cart (existing items are re-priced). */
export function applyBilling(doc: Document, billing: Billing): void {
  const win = doc.defaultView;
  writeBilling(win, billing);
  const items = getCart(win);
  const converted = convertItemsToBilling(items, billing);
  const changed = converted.some(
    (item, index) => item.key !== items[index]?.key || item.priceCents !== items[index]?.priceCents,
  );
  if (changed) setCart(win, converted);
  else refresh(doc);
}

/* ── wiring ───────────────────────────────────────────────────────────── */

function closestElement(target: EventTarget | null, selector: string): HTMLElement | null {
  const el = target as { closest?: (selector: string) => Element | null } | null;
  if (!el || typeof el.closest !== "function") return null;
  return el.closest(selector) as HTMLElement | null;
}

function onClick(event: Event, doc: Document): void {
  const win = doc.defaultView;

  const cartBtn = closestElement(event.target, "[data-cart-btn]");
  if (cartBtn) {
    event.preventDefault();
    toggleFromButton(cartBtn, doc);
    return;
  }

  const removeBtn = closestElement(event.target, "[data-remove-key]");
  if (removeBtn) {
    event.preventDefault();
    const key = removeBtn.dataset.removeKey;
    setCart(
      win,
      getCart(win).filter((item) => item.key !== key),
    );
    return;
  }

  // Empty the whole cart: the first click arms the button ("Confirm"), the
  // second click within the window clears everything.
  const emptyAllBtn = closestElement(event.target, "[data-cart-empty-all]");
  if (emptyAllBtn) {
    event.preventDefault();
    const btn = emptyAllBtn as HTMLElement;
    if (btn.classList.contains("is-armed")) {
      if (emptyAllTimer) {
        clearTimeout(emptyAllTimer);
        emptyAllTimer = null;
      }
      setCart(win, []);
    } else {
      armEmptyAll(doc, btn);
    }
    return;
  }

  const billingBtn = closestElement(event.target, "[data-billing-opt]");
  if (billingBtn) {
    event.preventDefault();
    applyBilling(doc, billingBtn.dataset.billingOpt === "year" ? "year" : "month");
    return;
  }

  if (closestElement(event.target, "[data-cart-open]")) {
    event.preventDefault();
    openDrawer(doc);
    return;
  }

  if (closestElement(event.target, "[data-cart-close]") || closestElement(event.target, "[data-cart-overlay]")) {
    event.preventDefault();
    closeDrawer(doc);
    return;
  }

  // Empty cart: keep the visitor on the page instead of opening an empty
  // Stripe session.
  if (closestElement(event.target, "[data-cart-checkout]") && getCart(win).length === 0) {
    event.preventDefault();
  }
}

/**
 * Bind the cart UI and render it for the current page.
 *
 * Safe to call more than once: listeners are delegated from `document` (they
 * survive ClientRouter body swaps) and registered only once, and the render
 * pass is idempotent.
 */
export function initCart(doc: Document = document): void {
  const win = doc.defaultView ?? (typeof window === "undefined" ? undefined : window);
  const bound = doc as unknown as Record<string, boolean>;
  if (!bound[INIT_FLAG]) {
    bound[INIT_FLAG] = true;
    doc.addEventListener("click", (event) => onClick(event, doc));
    doc.addEventListener("keydown", (event) => {
      // Only when the drawer is actually open: an unconditional close would
      // re-run the close path (and its delayed focus return) on every
      // Escape press, stealing focus back to the old opener long after the
      // drawer closed, e.g. while the visitor types in a form.
      if ((event as KeyboardEvent).key === "Escape") {
        const drawer = drawerEl(doc);
        // `hidden` flips synchronously in openDrawer; the `is-open` class
        // only lands on the next animation frame, so it cannot gate this.
        if (drawer && !drawer.hidden) closeDrawer(doc);
      }
      if ((event as KeyboardEvent).key === "Tab") trapDrawerTab(event as KeyboardEvent, doc);
    });
    win?.addEventListener(CART_CHANGE_EVENT, () => refresh(doc));
    // Keep multiple tabs in sync.
    win?.addEventListener("storage", (event) => {
      const key = (event as StorageEvent).key;
      if (key === null || key === STORAGE_KEY || key === BILLING_KEY) refresh(doc);
    });
    // ClientRouter swaps the body: re-render against the new DOM and make sure
    // the drawer is closed before the old page is replaced.
    doc.addEventListener("astro:before-preparation", () => closeDrawer(doc, { instant: true }));
    doc.addEventListener("astro:page-load", () => refresh(doc));
    if (doc.readyState === "loading") {
      doc.addEventListener("DOMContentLoaded", () => refresh(doc), { once: true });
    }
  }
  refresh(doc);
}
