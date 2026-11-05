/**
 * WEBAO start page — step 1 of the funnel (/start, /fr/commencer).
 *
 * The layout + `StartPage.astro` render a details form and a "Your selection"
 * card; this module owns what happens afterwards:
 *
 * - the card mirrors the shared cart (`src/lib/cart-ui.ts`): branch pickers
 *   (website plan, Ads Pack, AI services), a summary grouped by branch,
 *   total, billing term. Website, Ads and AI can be bought together in one
 *   cart, with add-ons and bundles;
 * - an empty cart is seeded with the default plan (Grow, the C$149 anchor the
 *   "Start →" CTAs advertise) so the page is a one-click path to the core
 *   offer, while a visitor who arrives with a cart keeps exactly that cart;
 *   the plan can be removed ("No website plan") for an Ads- or AI-only order;
 * - the copy is branch-aware: the eyebrow and the no-plan hint follow what
 *   is actually in the cart, instead of assuming a website purchase.
 * - the form is validated, the details are stored for the payment step
 *   (`/checkout` reads `CUSTOMER_KEY` from sessionStorage), the owner is
 *   notified through /api/forms/submit, and the visitor is sent to checkout.
 *
 * Like cart-ui, every function takes the document explicitly so the whole
 * flow runs under jsdom, and listeners are delegated from `document` so the
 * page keeps working after ClientRouter swaps the body.
 */

import { CART_CHANGE_EVENT, STORAGE_KEY, cartKey, type CartItem } from "./cart";
import { baseInterval, cartProducts, convertItemsToBilling, intervalFor, priceCentsFor, supportsBilling, type Billing } from "./cart-catalog";
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

/* ── branches ───────────────────────────────────────────────────────── */

export type Branch = "web" | "ads" | "ai";

/** Ads Pack channels (one at a time) plus the GBP revamp add-on. */
const ADS_CHANNELS = ["ads-meta", "ads-google", "ads-both", "ads-pack"];
const ADS_PRODUCTS = new Set([...ADS_CHANNELS, "gbp-revamp"]);
/** AI services and the AI Pack (mutually exclusive, like the pricing page). */
const AI_PRODUCTS = new Set(["ai-receptionist", "ai-website-chat", "ai-followup", "ai-pack"]);

/** Which branch a product belongs to. Unknown keys fall back to Website,
 *  the historical behaviour for website add-ons and bundles. */
export function branchOf(product: string): Branch {
  if (ADS_PRODUCTS.has(product)) return "ads";
  if (AI_PRODUCTS.has(product)) return "ai";
  return "web";
}

/** Branches present in the cart, in display order. */
export function cartBranches(cart: CartItem[]): Branch[] {
  const found = new Set(cart.map((item) => branchOf(item.product)));
  return (["web", "ads", "ai"] as const).filter((branch) => found.has(branch));
}

/**
 * The cart item for a non-plan product. Ads and AI are monthly-only, so
 * they always take the monthly interval: the billing term never moves them
 * onto a yearly interval they have no price on.
 */
export function serviceItem(product: string, name: string, billing: Billing): CartItem | null {
  const def = cartProducts[product];
  if (!def || def.type === "plan") return null;
  const interval =
    baseInterval(def) === "one-time" ? "one-time" : supportsBilling(def, billing) ? intervalFor(product, billing) : "month";
  const priceCents = priceCentsFor(product, interval);
  if (priceCents === undefined) return null;
  return { key: cartKey(product, interval), product, name, priceCents, interval, type: def.type };
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

/** Re-render the selection card from the cart: branch chips and pickers,
 *  the summary grouped by branch, the branch-aware copy, total. */
export function renderStart(doc: Document): void {
  const root = rootEl(doc);
  if (!root) return;
  const win = doc.defaultView;
  const billing = readBilling(win);
  const cart = getCart(win);
  const fmt = moneyFormat(doc);
  const plan = cart.find((item) => item.type === "plan");
  const branches = cartBranches(cart);
  const openBranches = new Set([
    ...branches,
    ...((root.dataset.openBranches ?? "").split(",").filter(Boolean) as Branch[]),
  ]);

  // Branch chips and pickers: a branch is on when the cart holds one of its
  // products, or when the visitor opened it to add one.
  root.querySelectorAll<HTMLButtonElement>("[data-branch-toggle]").forEach((chip) => {
    const branch = chip.dataset.branchToggle as Branch;
    chip.setAttribute("aria-pressed", openBranches.has(branch) ? "true" : "false");
  });
  root.querySelectorAll<HTMLElement>("[data-branch-picker]").forEach((picker) => {
    const branch = picker.dataset.branchPicker as Branch;
    picker.hidden = !openBranches.has(branch);
  });

  // Website plan radios, plus the "no plan" option for Ads/AI-only orders.
  root.querySelectorAll<HTMLInputElement>('input[name="plan"]').forEach((input) => {
    const product = input.value;
    if (product === "none") {
      input.checked = !plan;
      return;
    }
    input.checked = plan?.product === product;
    const price = input.closest("label")?.querySelector<HTMLElement>("[data-plan-price]");
    if (price) {
      const interval = intervalFor(product, billing);
      const cents = priceCentsFor(product, interval);
      price.textContent = cents === undefined ? "" : `${formatMoney(cents, fmt)}${intervalSuffix(doc, interval)}`;
    }
  });

  // Ads channel radios and the GBP checkbox mirror the cart.
  const adsChannel = cart.find((item) => ADS_CHANNELS.includes(item.product));
  root.querySelectorAll<HTMLInputElement>('input[name="ads-channel"]').forEach((input) => {
    input.checked = input.value === "none" ? !adsChannel : adsChannel?.product === input.value;
  });
  const gbp = root.querySelector<HTMLInputElement>('input[name="gbp"]');
  if (gbp) gbp.checked = cart.some((item) => item.product === "gbp-revamp");

  // AI service checkboxes mirror the cart (Pack guard lives in the toggle).
  root.querySelectorAll<HTMLInputElement>('input[name="ai-service"]').forEach((input) => {
    input.checked = cart.some((item) => item.product === input.value);
  });

  // Summary: every selected product, grouped by branch, with a remove
  // button each. The cart drawer already owns [data-remove-key] clicks.
  const list = root.querySelector<HTMLElement>("[data-start-extras-list]");
  const extrasWrap = root.querySelector<HTMLElement>("[data-start-extras]");
  if (extrasWrap) extrasWrap.hidden = cart.length === 0;
  if (list) {
    const removeLabel = label(root, "labelRemove", "Remove {name}");
    const groupLabel = (branch: Branch): string =>
      label(root, `labelGroup${branch[0].toUpperCase()}${branch.slice(1)}`, branch);
    const row = (item: CartItem): string => `
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
        </li>`;
    list.innerHTML = (["web", "ads", "ai"] as const)
      .map((branch) => {
        const items = cart.filter((item) => branchOf(item.product) === branch);
        if (items.length === 0) return "";
        return `<li class="sel-group-head">${escapeHtml(groupLabel(branch))}</li>${items.map(row).join("")}`;
      })
      .join("");
  }

  // Branch-aware copy: the eyebrow follows what is actually being bought,
  // and the no-plan hint says the right thing for Ads/AI-only orders.
  const eyebrow = doc.querySelector<HTMLElement>("[data-start-eyebrow]");
  if (eyebrow) {
    const key =
      cart.length === 0 || branches.length === 0
        ? "eyebrowWeb"
        : branches.length === 1
          ? (`eyebrow${branches[0][0].toUpperCase()}${branches[0].slice(1)}` as const)
          : "eyebrowMixed";
    eyebrow.textContent = label(root, key, eyebrow.textContent ?? "");
  }
  const noPlan = root.querySelector<HTMLElement>("[data-start-no-plan]");
  if (noPlan) {
    noPlan.hidden = !!plan || cart.length === 0;
    if (!noPlan.hidden) {
      const serviceOnly = branches.some((branch) => branch !== "web");
      noPlan.textContent = label(root, serviceOnly ? "hintService" : "hintWeb", noPlan.textContent ?? "");
    }
  }
  const defaultNote = root.querySelector<HTMLElement>("[data-start-default-note]");
  if (defaultNote) defaultNote.hidden = !(root.dataset.defaulted === "1" && plan?.product === root.dataset.defaultPlan);

  const total = cart.reduce((sum, item) => sum + item.priceCents, 0);
  root.querySelectorAll<HTMLElement>("[data-start-total]").forEach((el) => {
    el.textContent = formatMoney(total, fmt);
  });

  // A non-empty cart clears the "choose something" error.
  if (cart.length > 0) showSelectionError(root, false);
}

/** Switch the plan: one plan at a time, everything on one billing term.
 *  "none" removes the plan, for an Ads- or AI-only order. */
export function selectPlan(doc: Document, product: string, name: string): void {
  const win = doc.defaultView;
  const billing = readBilling(win);
  if (product === "none") {
    setCart(
      win,
      getCart(win).filter((entry) => entry.type !== "plan"),
    );
    return;
  }
  const item = planItem(product, name, billing);
  if (!item) return;
  const others = getCart(win).filter((entry) => entry.type !== "plan");
  setCart(win, [...convertItemsToBilling(others, billing), item]);
}

/** Pick an Ads Pack channel: one channel at a time, "none" removes it. */
export function selectAdsChannel(doc: Document, product: string | null, name: string): void {
  const win = doc.defaultView;
  const billing = readBilling(win);
  const rest = getCart(win).filter((entry) => !ADS_CHANNELS.includes(entry.product));
  if (!product || product === "none") {
    setCart(win, rest);
    return;
  }
  const item = serviceItem(product, name, billing);
  if (!item) return;
  setCart(win, [...rest, item]);
}

/** Toggle the Google Business Profile revamp (one-time, on its own or with a pack). */
export function toggleGbp(doc: Document, name: string, on: boolean): void {
  const win = doc.defaultView;
  const billing = readBilling(win);
  const rest = getCart(win).filter((entry) => entry.product !== "gbp-revamp");
  if (!on) {
    setCart(win, rest);
    return;
  }
  const item = serviceItem("gbp-revamp", name, billing);
  if (!item) return;
  setCart(win, [...rest, item]);
}

/**
 * Toggle an AI service. The AI Pack and the individual services exclude
 * each other, the same guard as the pricing page.
 */
export function toggleAiService(doc: Document, product: string, name: string, on: boolean): void {
  const win = doc.defaultView;
  const billing = readBilling(win);
  let rest = getCart(win).filter((entry) => entry.product !== product);
  if (!on) {
    setCart(win, rest);
    return;
  }
  if (product === "ai-pack") rest = rest.filter((entry) => !AI_PRODUCTS.has(entry.product));
  else rest = rest.filter((entry) => entry.product !== "ai-pack");
  const item = serviceItem(product, name, billing);
  if (!item) return;
  setCart(win, [...rest, item]);
}

/** Open a branch's picker that has nothing in the cart yet (Website, Ads and
 *  AI pickers stay open once the cart holds one of their products). */
export function toggleBranch(doc: Document, branch: Branch): void {
  const root = rootEl(doc);
  if (!root) return;
  if (cartBranches(getCart(doc.defaultView)).includes(branch)) return;
  const open = new Set((root.dataset.openBranches ?? "").split(",").filter(Boolean));
  if (open.has(branch)) open.delete(branch);
  else open.add(branch);
  root.dataset.openBranches = [...open].join(",");
  renderStart(doc);
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

  if (!root.dataset.openBranches) root.dataset.openBranches = "web";

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
      const adsInput = closestElement(event.target, 'input[name="ads-channel"]') as HTMLInputElement | null;
      if (adsInput && adsInput.checked)
        selectAdsChannel(doc, adsInput.value, adsInput.dataset.name ?? adsInput.value);
      const gbpInput = closestElement(event.target, 'input[name="gbp"]') as HTMLInputElement | null;
      if (gbpInput) toggleGbp(doc, gbpInput.dataset.name ?? "Google Business Profile Revamp", gbpInput.checked);
      const aiInput = closestElement(event.target, 'input[name="ai-service"]') as HTMLInputElement | null;
      if (aiInput) toggleAiService(doc, aiInput.value, aiInput.dataset.name ?? aiInput.value, aiInput.checked);
    });

    // The billing toggle is handled by cart-ui (same hooks as the pricing
    // page); it only broadcasts a change when cart items were re-priced, so
    // re-render the plan prices on the next tick in every case.
    doc.addEventListener("click", (event) => {
      const chip = closestElement(event.target, "[data-branch-toggle]") as HTMLButtonElement | null;
      if (chip && rootEl(doc)) {
        toggleBranch(doc, chip.dataset.branchToggle as Branch);
        return;
      }
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
