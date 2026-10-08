/**
 * WEBAO start page — step 1 of the funnel (/start, /fr/commencer).
 *
 * The layout + `StartPage.astro` render a details form and a "Your selection"
 * card; this module owns what happens afterwards:
 *
 * - the card mirrors the shared cart (`src/lib/cart-ui.ts`): plan radios,
 *   add-ons/bundles with remove buttons, total, billing term;
 * - an empty cart is seeded with the default plan (Grow, the C$149 anchor the
 *   "Start →" CTAs advertise) so the page is a one-click path to the core
 *   offer, while a visitor who arrives with a cart keeps exactly that cart;
 * - the form is validated, the details are stored for the payment step
 *   (`/checkout` reads `CUSTOMER_KEY` from sessionStorage), the owner is
 *   notified through /api/forms/submit, and the visitor is sent to checkout.
 *
 * Like cart-ui, every function takes the document explicitly so the whole
 * flow runs under jsdom, and listeners are delegated from `document` so the
 * page keeps working after ClientRouter swaps the body.
 */

import { CART_CHANGE_EVENT, STORAGE_KEY, cartKey, type CartItem } from "./cart";
import { cartProducts, convertItemsToBilling, intervalFor, priceCentsFor, type Billing } from "./cart-catalog";
import { BILLING_KEY, formatMoney, getCart, intervalSuffix, moneyFormat, readBilling, setCart } from "./cart-ui";

/** sessionStorage key shared with the checkout page. */
export const CUSTOMER_KEY = "webao-checkout";

const INIT_FLAG = "__webaoStartUiBound";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MAX_FIELD = 200;

type Win = Window & typeof globalThis;

export interface CustomerDetails {
  name: string;
  email: string;
  business: string;
}

export type DetailErrors = Partial<Record<keyof CustomerDetails, "required" | "format">>;

/* ── customer details ─────────────────────────────────────────────────── */

function sessionOf(win: Win | null | undefined): Storage | null {
  try {
    return win?.sessionStorage ?? null;
  } catch {
    return null;
  }
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, MAX_FIELD) : "";
}

/** Details entered on the start page, or null when nothing (valid) is stored. */
export function readCustomer(win: Win | null | undefined): CustomerDetails | null {
  try {
    const raw = sessionOf(win)?.getItem(CUSTOMER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return null;
    return { name: clean(parsed.name), email: clean(parsed.email), business: clean(parsed.business) };
  } catch {
    return null;
  }
}

export function writeCustomer(win: Win | null | undefined, details: CustomerDetails): void {
  try {
    sessionOf(win)?.setItem(
      CUSTOMER_KEY,
      JSON.stringify({ name: clean(details.name), email: clean(details.email), business: clean(details.business) }),
    );
  } catch {
    // Storage unavailable; checkout will ask again.
  }
}

/** Field-level validation; an empty object means the details are complete. */
export function validateDetails(details: CustomerDetails): DetailErrors {
  const errors: DetailErrors = {};
  if (!clean(details.name)) errors.name = "required";
  if (!clean(details.business)) errors.business = "required";
  const email = clean(details.email);
  if (!email) errors.email = "required";
  else if (!EMAIL_RE.test(email)) errors.email = "format";
  return errors;
}

export function hasValidDetails(details: CustomerDetails | null): details is CustomerDetails {
  return details !== null && Object.keys(validateDetails(details)).length === 0;
}

/* ── selection ────────────────────────────────────────────────────────── */

/** The cart item for a plan on the given billing term (null for unknown plans). */
export function planItem(product: string, name: string, billing: Billing): CartItem | null {
  const def = cartProducts[product];
  if (!def || def.type !== "plan") return null;
  const interval = intervalFor(product, billing);
  const priceCents = priceCentsFor(product, interval);
  if (priceCents === undefined) return null;
  return { key: cartKey(product, interval), product, name, priceCents, interval, type: "plan" };
}

function rootEl(doc: Document): HTMLElement | null {
  return doc.querySelector<HTMLElement>("[data-start]");
}

function label(root: HTMLElement | null, name: string, fallback: string): string {
  return (root?.dataset as Record<string, string | undefined> | undefined)?.[name] ?? fallback;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Re-render the selection card from the cart: radios, extras, total. */
export function renderStart(doc: Document): void {
  const root = rootEl(doc);
  if (!root) return;
  const win = doc.defaultView;
  const billing = readBilling(win);
  const cart = getCart(win);
  const fmt = moneyFormat(doc);
  const plan = cart.find((item) => item.type === "plan");

  root.querySelectorAll<HTMLInputElement>('input[name="plan"]').forEach((input) => {
    const product = input.value;
    input.checked = plan?.product === product;
    const price = input.closest("label")?.querySelector<HTMLElement>("[data-plan-price]");
    if (price) {
      const interval = intervalFor(product, billing);
      const cents = priceCentsFor(product, interval);
      price.textContent = cents === undefined ? "" : `${formatMoney(cents, fmt)}${intervalSuffix(doc, interval)}`;
    }
  });

  const extras = cart.filter((item) => item.type !== "plan");
  const extrasWrap = root.querySelector<HTMLElement>("[data-start-extras]");
  if (extrasWrap) extrasWrap.hidden = extras.length === 0;
  const list = root.querySelector<HTMLElement>("[data-start-extras-list]");
  if (list) {
    const removeLabel = label(root, "labelRemove", "Remove {name}");
    list.innerHTML = extras
      .map(
        (item) => `
        <li class="sel-extra" data-start-item="${escapeHtml(item.key)}">
          <span class="sel-extra-name">${escapeHtml(item.name)}</span>
          <span class="sel-extra-price mono">${formatMoney(item.priceCents, fmt)}${escapeHtml(
            intervalSuffix(doc, item.interval),
          )}</span>
          <button type="button" class="sel-extra-remove" data-remove-key="${escapeHtml(item.key)}" aria-label="${escapeHtml(
            removeLabel.replace("{name}", item.name),
          )}">
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 3l10 10M13 3L3 13" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
          </button>
        </li>`,
      )
      .join("");
  }

  // Add-ons without a plan: legitimate for an existing site, but say so.
  const noPlan = root.querySelector<HTMLElement>("[data-start-no-plan]");
  if (noPlan) noPlan.hidden = !!plan || extras.length === 0;
  const defaultNote = root.querySelector<HTMLElement>("[data-start-default-note]");
  if (defaultNote) defaultNote.hidden = !(root.dataset.defaulted === "1" && plan?.product === root.dataset.defaultPlan);

  const total = cart.reduce((sum, item) => sum + item.priceCents, 0);
  root.querySelectorAll<HTMLElement>("[data-start-total]").forEach((el) => {
    el.textContent = formatMoney(total, fmt);
  });

  // A non-empty cart clears the "choose a plan" error.
  if (cart.length > 0) showSelectionError(root, false);
}

/** Switch the plan: one plan at a time, everything on one billing term. */
export function selectPlan(doc: Document, product: string, name: string): void {
  const win = doc.defaultView;
  const billing = readBilling(win);
  const item = planItem(product, name, billing);
  if (!item) return;
  const others = getCart(win).filter((entry) => entry.type !== "plan");
  setCart(win, [...convertItemsToBilling(others, billing), item]);
}

/* ── form ─────────────────────────────────────────────────────────────── */

function formEl(doc: Document): HTMLFormElement | null {
  return doc.querySelector<HTMLFormElement>("form[data-start-form]");
}

export function readForm(form: HTMLFormElement): CustomerDetails {
  const value = (name: string) => clean((form.elements.namedItem(name) as HTMLInputElement | null)?.value);
  return { name: value("name"), email: value("email"), business: value("business") };
}

function setFieldError(form: HTMLFormElement, field: keyof CustomerDetails, kind: DetailErrors[keyof DetailErrors] | undefined) {
  const el = form.querySelector<HTMLElement>(`[data-error="${field}"]`);
  const input = form.querySelector<HTMLInputElement>(`[name="${field}"]`);
  const data = form.dataset as Record<string, string | undefined>;
  let message = "";
  if (kind === "required") message = data[`err${field[0].toUpperCase()}${field.slice(1)}`] ?? "Required.";
  if (kind === "format") message = data.errEmailFormat ?? "Enter a valid email.";
  if (el) {
    el.textContent = message;
    el.hidden = !message;
  }
  if (input) {
    input.classList.toggle("input-error", !!message);
    input.setAttribute("aria-invalid", message ? "true" : "false");
  }
}

/** Show (or clear) the per-field errors; returns true when the form is valid. */
export function showErrors(form: HTMLFormElement, errors: DetailErrors): boolean {
  (["name", "email", "business"] as const).forEach((field) => setFieldError(form, field, errors[field]));
  return Object.keys(errors).length === 0;
}

function showSelectionError(root: HTMLElement, show: boolean): void {
  const el = root.querySelector<HTMLElement>("[data-start-selection-error]");
  if (el) el.hidden = !show;
}

function prefill(form: HTMLFormElement, details: CustomerDetails | null): void {
  if (!details) return;
  (["name", "email", "business"] as const).forEach((field) => {
    const input = form.elements.namedItem(field) as HTMLInputElement | null;
    if (input && !input.value) input.value = details[field];
  });
}

/** What the owner sees in the admin inbox for this order. */
export function selectionSummary(doc: Document, cart: CartItem[]): string {
  const fmt = moneyFormat(doc);
  return cart
    .map((item) => `${item.name} (${formatMoney(item.priceCents, fmt)}${intervalSuffix(doc, item.interval).trim()})`)
    .join(", ");
}

function notifyOwner(doc: Document, details: CustomerDetails, cart: CartItem[]): void {
  const win = doc.defaultView;
  if (!win || typeof win.fetch !== "function") return;
  try {
    win
      .fetch("/api/forms/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        keepalive: true,
        body: JSON.stringify({
          form: "pricing",
          fields: {
            ...details,
            selection: selectionSummary(doc, cart),
            items: cart.map((item) => item.key).join(","),
            billing: readBilling(win),
            page: win.location.pathname,
          },
        }),
      })
      .catch(() => {});
  } catch {
    // Never block the visitor on the notification.
  }
}

export type Navigate = (href: string) => void;

/** Default navigation: a full load of the checkout page. */
function assignLocation(doc: Document): Navigate {
  return (href) => doc.defaultView?.location.assign(href);
}

/** Validate, persist the details, notify the owner and move to checkout. */
export function submitStart(doc: Document, form: HTMLFormElement, navigate: Navigate = assignLocation(doc)): boolean {
  const win = doc.defaultView;
  const root = rootEl(doc);
  const details = readForm(form);
  const valid = showErrors(form, validateDetails(details));
  const cart = getCart(win);
  if (root) showSelectionError(root, cart.length === 0);
  if (!valid || cart.length === 0) {
    const first = form.querySelector<HTMLElement>(".input-error") ?? root?.querySelector<HTMLElement>('input[name="plan"]');
    first?.focus();
    return false;
  }

  writeCustomer(win, details);
  notifyOwner(doc, details, cart);
  const target = form.dataset.checkoutPath || "/checkout";
  const button = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (button) button.disabled = true;
  try {
    navigate(target);
  } catch {
    if (button) button.disabled = false;
  }
  return true;
}

/* ── wiring ───────────────────────────────────────────────────────────── */

function closestElement(target: EventTarget | null, selector: string): HTMLElement | null {
  const el = target as { closest?: (selector: string) => Element | null } | null;
  if (!el || typeof el.closest !== "function") return null;
  return el.closest(selector) as HTMLElement | null;
}

/** Per page view: seed the default plan into an empty cart, prefill the form. */
function setupPage(doc: Document): void {
  const root = rootEl(doc);
  if (!root || root.dataset.webaoStartInit) return;
  root.dataset.webaoStartInit = "1";
  const win = doc.defaultView;

  const defaultPlan = root.dataset.defaultPlan;
  if (defaultPlan && getCart(win).length === 0) {
    const input = root.querySelector<HTMLInputElement>(`input[name="plan"][value="${defaultPlan}"]`);
    const item = planItem(defaultPlan, input?.dataset.name ?? defaultPlan, readBilling(win));
    if (item) {
      root.dataset.defaulted = "1";
      setCart(win, [item]);
    }
  }

  const form = formEl(doc);
  if (form) prefill(form, readCustomer(win));
}

export interface StartOptions {
  /** How to reach the checkout page once the details are stored (defaults to `location.assign`). */
  navigate?: Navigate;
}

/**
 * Bind the start page and render it. Safe to call repeatedly: listeners are
 * registered once per document, the per-page setup once per rendered page.
 */
export function initStart(doc: Document = document, options: StartOptions = {}): void {
  const win = doc.defaultView ?? (typeof window === "undefined" ? undefined : window);
  const navigate = options.navigate ?? assignLocation(doc);
  const bound = doc as unknown as Record<string, boolean>;
  if (!bound[INIT_FLAG]) {
    bound[INIT_FLAG] = true;

    doc.addEventListener("change", (event) => {
      const input = closestElement(event.target, 'input[name="plan"]') as HTMLInputElement | null;
      if (input && input.checked) selectPlan(doc, input.value, input.dataset.name ?? input.value);
    });

    // The billing toggle is handled by cart-ui (same hooks as the pricing
    // page); it only broadcasts a change when cart items were re-priced, so
    // re-render the plan prices on the next tick in every case.
    doc.addEventListener("click", (event) => {
      if (closestElement(event.target, "[data-billing-opt]") && rootEl(doc)) setTimeout(() => renderStart(doc), 0);
    });

    doc.addEventListener("submit", (event) => {
      const form = closestElement(event.target, "form[data-start-form]") as HTMLFormElement | null;
      if (!form) return;
      event.preventDefault();
      submitStart(doc, form, navigate);
    });

    // Clear a field's error as soon as it is fixed.
    doc.addEventListener("input", (event) => {
      const input = closestElement(event.target, "form[data-start-form] input") as HTMLInputElement | null;
      const form = input?.form;
      if (!input || !form || !input.classList.contains("input-error")) return;
      const field = input.name as keyof CustomerDetails;
      if (field !== "name" && field !== "email" && field !== "business") return;
      setFieldError(form, field, validateDetails(readForm(form))[field]);
    });

    win?.addEventListener(CART_CHANGE_EVENT, () => renderStart(doc));
    win?.addEventListener("storage", (event) => {
      const key = (event as StorageEvent).key;
      if (key === null || key === STORAGE_KEY || key === BILLING_KEY) renderStart(doc);
    });
    doc.addEventListener("astro:page-load", () => {
      setupPage(doc);
      renderStart(doc);
    });
  }
  setupPage(doc);
  renderStart(doc);
}
