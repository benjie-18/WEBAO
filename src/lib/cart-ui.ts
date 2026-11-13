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
import { cartProducts, convertItemsToBilling, priceCentsFor, type Billing } from "./cart-catalog";
import {
  conflictsForAdding,
  findConflicts,
  monthlyOnlyInCart,
  type CartConflict,
  type RuleItem,
} from "./cart-rules";
import { compatibility } from "./pricing";

/** localStorage key holding the active billing term. */
export const BILLING_KEY = "webao_billing_v1";

/**
 * Event fired on the window after the billing term changes, even when no
 * cart item was re-priced (empty cart included). Listeners that depend on
 * the term itself, e.g. the Ads Starter card hiding on yearly, must use
 * this: reading the stored term from a document click listener runs before
 * applyBilling writes it, so it sees the old term.
 */
export const BILLING_CHANGE_EVENT = "webao:billing-change";

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

function fill(template: string | undefined, vars: Record<string, string>): string {
  let out = template ?? "";
  for (const [key, value] of Object.entries(vars)) out = out.split(`{${key}}`).join(value);
  return out;
}

// ---------------------------------------------------------------------------
// Cart conflicts: the popup and the guards.
// ---------------------------------------------------------------------------

/** Products with a monthly price and no yearly price (Ads, AI services). */
export function monthlyOnlySet(): Set<string> {
  return new Set(
    Object.values(cartProducts)
      .filter((p) => p.monthCents !== undefined && p.yearCents === undefined)
      .map((p) => p.product),
  );
}

function toRuleItem(item: CartItem): RuleItem {
  return { product: item.product, interval: item.interval, type: item.type };
}

function toRuleItems(items: CartItem[]): RuleItem[] {
  return items.map(toRuleItem);
}

/** Display names for products, from the cart (or the product id as a fallback). */
function namesOf(items: CartItem[], products: string[]): string {
  return products.map((product) => items.find((i) => i.product === product)?.name ?? product).join(", ");
}

function conflictEl(doc: Document): HTMLElement | null {
  return doc.querySelector<HTMLElement>("[data-cart-conflict]");
}

function conflictOverlayEl(doc: Document): HTMLElement | null {
  return doc.querySelector<HTMLElement>("[data-cart-conflict-overlay]");
}

function conflictData(doc: Document): Record<string, string | undefined> {
  return ((conflictEl(doc)?.dataset ?? {}) as Record<string, string | undefined>);
}

let conflictOpener: HTMLElement | null = null;

export interface ConflictAction {
  label: string;
  primary?: boolean;
  apply: () => void;
}

/**
 * Show the conflict popup: one short line of why, then buttons that fix
 * it. Returns true when the attempted action must not proceed: either
 * the popup is shown (the fix runs from its buttons) or the dialog is
 * missing, in which case blocking is the safe choice. The dialog is
 * rendered by BaseLayout on every page, so the missing case never
 * happens in production. Closing the popup changes nothing.
 */
export function showConflict(doc: Document, message: string, actions: ConflictAction[]): boolean {
  const dialog = conflictEl(doc);
  const overlay = conflictOverlayEl(doc);
  if (!dialog || !overlay) return true;
  const data = conflictData(doc);
  const title = dialog.querySelector<HTMLElement>("[data-cart-conflict-title]");
  const body = dialog.querySelector<HTMLElement>("[data-cart-conflict-message]");
  const box = dialog.querySelector<HTMLElement>("[data-cart-conflict-actions]");
  if (!title || !body || !box) return true;
  conflictOpener = (doc.activeElement as HTMLElement | null) ?? null;
  title.textContent = data.title ?? "That doesn't go together";
  body.textContent = message;
  box.innerHTML = "";
  for (const action of actions) {
    const btn = doc.createElement("button");
    btn.type = "button";
    btn.className = action.primary ? "btn btn--primary" : "btn btn--ghost";
    btn.textContent = action.label;
    btn.addEventListener("click", () => {
      closeConflict(doc);
      action.apply();
    });
    box.appendChild(btn);
  }
  overlay.hidden = false;
  dialog.hidden = false;
  const first = box.querySelector<HTMLElement>("button");
  if (first) first.focus();
  return true;
}

export function closeConflict(doc: Document): void {
  const dialog = conflictEl(doc);
  const overlay = conflictOverlayEl(doc);
  if (dialog) dialog.hidden = true;
  if (overlay) overlay.hidden = true;
  if (conflictOpener && doc.contains(conflictOpener)) conflictOpener.focus();
  conflictOpener = null;
}

export function isConflictOpen(doc: Document): boolean {
  const dialog = conflictEl(doc);
  return !!dialog && !dialog.hidden;
}

/** One short message for a bare conflict (stale carts reaching checkout). */
export function conflictMessage(doc: Document, conflict: CartConflict, items: CartItem[]): string {
  const data = conflictData(doc);
  switch (conflict.kind) {
    case "included":
      return fill(data.msgIncluded, { item: namesOf(items, [conflict.component ?? ""]), plan: namesOf(items, [conflict.plan ?? ""]) });
    case "not-available":
      return fill(data.msgNotAvailable, { item: namesOf(items, [conflict.component ?? ""]), plan: namesOf(items, [conflict.plan ?? ""]) });
    case "bundle-component":
      return fill(data.msgBundleComponent, {
        bundle: namesOf(items, [conflict.bundle ?? ""]),
        item: namesOf(items, conflict.components ?? [conflict.component ?? ""]),
      });
    case "bundle-overlap":
      return fill(data.msgBundleOverlap, {
        first: namesOf(items, [conflict.products[0] ?? ""]),
        second: namesOf(items, [conflict.products[1] ?? ""]),
      });
    case "ads-two":
      return data.msgAdsTwo ?? "";
    case "ai-pack":
      return fill(data.msgAiPack, { item: namesOf(items, conflict.products.filter((p) => p !== "ai-pack")) });
    case "mixed-intervals":
      return data.msgMixed ?? "";
    case "two-plans":
      return data.twoPlans ?? "";
  }
}

/** Apply a conflict's automated fix to the cart (remove, or re-bill monthly). */
export function applyConflictFix(win: Window | null, items: CartItem[], conflict: CartConflict): CartItem[] {
  if (conflict.fix && "convertTo" in conflict.fix) {
    return convertItemsToBilling(items, conflict.fix.convertTo);
  }
  const remove = conflict.fix && "remove" in conflict.fix ? conflict.fix.remove : [];
  return items.filter((item) => !remove.includes(item.product));
}

/**
 * Guard a cart that is about to be paid for (drawer checkout, /start
 * submit). Returns true when the cart is clean; otherwise shows the
 * popup for the first conflict, with its automated fix, and returns
 * false.
 */
export function guardCheckout(doc: Document): boolean {
  const win = doc.defaultView;
  const cart = getCart(win);
  const conflicts = findConflicts(toRuleItems(cart));
  if (conflicts.length === 0) return true;
  const conflict = conflicts[0];
  const data = conflictData(doc);
  const message = conflictMessage(doc, conflict, cart);
  const actions: ConflictAction[] = [];
  if (conflict.fix && "convertTo" in conflict.fix) {
    actions.push({
      label: data.fixSwitchMonthly ?? "Switch everything to monthly",
      primary: true,
      apply: () => setCart(win, applyConflictFix(win, cart, conflict)),
    });
  } else {
    const remove = conflict.fix && "remove" in conflict.fix ? conflict.fix.remove : [];
    actions.push({
      label: fill(data.fixRemove, { item: namesOf(cart, remove) }),
      primary: true,
      apply: () => setCart(win, applyConflictFix(win, cart, conflict)),
    });
  }
  actions.push({ label: data.keepAsIs ?? "Keep as is", apply: () => {} });
  return !showConflict(doc, message, actions);
}

/**
 * Cheapest plan (by monthly price) where `product` is a plain add-on
 * (matrix "A"), closest in price to `fromPlan`. Used for the
 * "Switch to Grow and add it" fix.
 */
function altPlanFor(product: string, fromPlan?: string): string | undefined {
  const rowKey = product === "lead-pack" ? "leadpack" : product === "visibility-pack" ? "vispack" : product;
  const row = compatibility.find((r) => r.key === rowKey);
  if (!row) return undefined;
  const fromPrice = fromPlan ? cartProducts[fromPlan]?.monthCents ?? 0 : 0;
  const available = (["launch", "grow", "scale"] as const)
    .filter((planId) => row[planId] === "A")
    .map((planId) => ({ planId, diff: Math.abs((cartProducts[planId]?.monthCents ?? 0) - fromPrice) }))
    .sort((a, b) => a.diff - b.diff);
  return available[0]?.planId;
}

/**
 * Guard adding `candidate` to `cart`. Returns true when the add may
 * proceed; otherwise shows the popup with the fix and returns false.
 * `planItemFor` resolves a plan product to its cart item (the pricing
 * page reads it off the plan button); without it, fixes that need a
 * plan switch are not offered.
 */
export function guardAdd(
  doc: Document,
  cart: CartItem[],
  candidate: CartItem,
  planItemFor?: (product: string) => CartItem | null,
): boolean {
  const win = doc.defaultView;
  const conflicts = conflictsForAdding(toRuleItems(cart), toRuleItem(candidate));
  if (conflicts.length === 0) return true;
  const data = conflictData(doc);
  const conflict = conflicts[0];
  const plan = cart.find((i) => i.type === "plan");
  const name = candidate.name;
  const removeProducts = (products: string[]) => cart.filter((i) => !products.includes(i.product));
  const dismiss = { label: data.dontAdd ?? "Don't add it", apply: () => {} };

  // Buttons for a replace conflict (Ads, AI Pack, bundles). The automated
  // fix always drops the cheaper side, so the main button keeps the dearer
  // configuration; the cheaper swap is the secondary choice, for a visitor
  // who really wants the cheaper option.
  const fixRemove = conflict.fix && "remove" in conflict.fix ? conflict.fix.remove : [];
  const candidateLoses = fixRemove.includes(candidate.product);
  // Products the fix keeps that are already in the cart (never the candidate).
  const keptExisting = conflict.products.filter((p) => p !== candidate.product && !fixRemove.includes(p));
  const removedNames = namesOf(cart, fixRemove);
  const keptNames = namesOf(cart, keptExisting);
  const replaceActions = (): ConflictAction[] => {
    if (candidateLoses) {
      return [
        { label: fill(data.keepItem ?? "Keep {item}", { item: keptNames }), primary: true, apply: () => {} },
        {
          label: fill(data.fixReplace, { old: keptNames, new: name }),
          apply: () => setCart(win, [...removeProducts(keptExisting), candidate]),
        },
      ];
    }
    return [
      {
        label: fill(data.fixReplace, { old: removedNames, new: name }),
        primary: true,
        apply: () => setCart(win, [...removeProducts(fixRemove), candidate]),
      },
      dismiss,
    ];
  };

  switch (conflict.kind) {
    case "included": {
      return !showConflict(doc, fill(data.msgIncluded, { item: name, plan: plan?.name ?? "" }), [
        { label: fill(data.keepPlan, { plan: plan?.name ?? "" }), primary: true, apply: () => {} },
      ]);
    }
    case "not-available": {
      const alt = altPlanFor(conflict.component ?? "", plan?.product);
      const altItem = alt && plan && planItemFor ? planItemFor(alt) : null;
      const actions: ConflictAction[] = [];
      if (altItem && plan) {
        // Only offer the switch when nothing else in the cart would
        // break under the new plan; otherwise stay with "don't add".
        const next = [...removeProducts([plan.product]), altItem, candidate];
        if (findConflicts(toRuleItems(next)).length === 0) {
          actions.push({
            label: fill(data.fixSwitchPlan, { plan: altItem.name }),
            primary: true,
            apply: () => setCart(win, next),
          });
        }
      }
      actions.push(dismiss);
      return !showConflict(doc, fill(data.msgNotAvailable, { item: name, plan: plan?.name ?? "" }), actions);
    }
    case "bundle-component": {
      const components = conflict.components ?? [conflict.component ?? ""];
      if (candidate.product === conflict.bundle) {
        // Adding the bundle: the fix keeps whichever side costs more.
        return !showConflict(
          doc,
          fill(data.msgBundleComponent, { bundle: name, item: namesOf(cart, components) }),
          replaceActions(),
        );
      }
      // Adding a component the bundle already includes: the bundle is the
      // dearer side, so keeping it is the main button; swapping down to
      // just the component is the secondary choice.
      return !showConflict(
        doc,
        fill(data.msgBundleComponent, { bundle: namesOf(cart, [conflict.bundle ?? ""]), item: name }),
        replaceActions(),
      );
    }
    case "bundle-overlap": {
      const existing = conflict.products.find((p) => p !== candidate.product) ?? "";
      return !showConflict(
        doc,
        fill(data.msgBundleOverlap, { first: namesOf(cart, [existing]), second: name }),
        replaceActions(),
      );
    }
    case "ads-two": {
      return !showConflict(doc, data.msgAdsTwo ?? "", replaceActions());
    }
    case "ai-pack": {
      if (candidate.product === "ai-pack") {
        const individuals = conflict.products.filter((p) => p !== "ai-pack");
        return !showConflict(doc, fill(data.msgAiPack, { item: namesOf(cart, individuals) }), replaceActions());
      }
      return !showConflict(doc, fill(data.msgAiPack, { item: name }), replaceActions());
    }
    case "mixed-intervals": {
      return !showConflict(
        doc,
        candidate.interval === "month" && candidate.product !== plan?.product
          ? fill(data.msgMonthlyOnlyAdd, { item: name })
          : (data.msgMixed ?? ""),
        [
          {
            label: data.fixSwitchMonthly ?? "Switch everything to monthly",
            primary: true,
            apply: () => {
              const monthly = convertItemsToBilling(cart, "month");
              const candidateMonth =
                candidate.interval === "month"
                  ? candidate
                  : {
                      ...candidate,
                      key: cartKey(candidate.product, "month"),
                      interval: "month" as const,
                      priceCents: priceCentsFor(candidate.product, "month") ?? candidate.priceCents,
                    };
              setCart(win, [...monthly, candidateMonth]);
            },
          },
          dismiss,
        ],
      );
    }
    case "two-plans":
      // Unreachable through the UI: adding a plan replaces the old one.
      return true;
  }
}

/**
 * Guard switching to `newPlan`. Returns true when the switch may
 * proceed; otherwise shows the popup and returns false.
 */
export function guardPlanChange(doc: Document, cart: CartItem[], newPlan: CartItem): boolean {
  const win = doc.defaultView;
  const conflicts = conflictsForAdding(toRuleItems(cart), toRuleItem(newPlan));
  if (conflicts.length === 0) return true;
  const data = conflictData(doc);
  const oldPlan = cart.find((i) => i.type === "plan");
  const remove: string[] = [];
  for (const conflict of conflicts) {
    if (conflict.fix && "remove" in conflict.fix) remove.push(...conflict.fix.remove);
    if (conflict.kind === "mixed-intervals") {
      remove.push(...monthlyOnlyInCart(toRuleItems(cart), monthlyOnlySet()));
    }
  }
  const offending = [...new Set(remove)];
  const message =
    conflicts.every((c) => c.kind === "mixed-intervals")
      ? fill(data.msgYearlyBlocked, { items: namesOf(cart, offending) })
      : fill(data.msgPlanSwitch, { plan: newPlan.name, items: namesOf(cart, offending) });
  const apply = () => {
    const kept = cart.filter((i) => i.type !== "plan" && !offending.includes(i.product));
    setCart(win, [...kept, newPlan]);
  };
  return !showConflict(doc, message, [
    { label: fill(data.fixSwitchRemove, { items: namesOf(cart, offending) }), primary: true, apply },
    {
      label: oldPlan ? fill(data.keepPlan, { plan: oldPlan.name }) : (data.keepAsIs ?? "Keep as is"),
      apply: () => {},
    },
  ]);
}

/**
 * Guard switching the billing term to `billing`. Yearly is unavailable
 * while the cart holds monthly-only products. Returns true when the
 * switch may proceed; otherwise shows the popup and returns false.
 */
export function guardBillingChange(doc: Document, billing: Billing): boolean {
  if (billing !== "year") return true;
  const win = doc.defaultView;
  const cart = getCart(win);
  const monthly = monthlyOnlyInCart(toRuleItems(cart), monthlyOnlySet());
  if (monthly.length === 0) return true;
  const data = conflictData(doc);
  const names = namesOf(cart, monthly);
  const message = fill(data.msgYearlyBlocked, { items: names });
  if (monthly.length === cart.length) {
    // Removing them would empty the cart: only offer to stay monthly.
    return !showConflict(doc, message, [
      { label: data.keepAsIs ?? "Keep as is", primary: true, apply: () => {} },
    ]);
  }
  return !showConflict(doc, message, [
    {
      label: fill(data.fixSwitchYearly, { items: names }),
      primary: true,
      apply: () => {
        setCart(win, cart.filter((i) => !monthly.includes(i.product)));
        applyBilling(doc, "year");
      },
    },
    { label: data.keepAsIs ?? "Keep as is", apply: () => {} },
  ]);
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

  const candidate: CartItem = { key, ...info };
  if (info.type === "plan") {
    // A plan switch goes through the plan guard: it can strand add-ons
    // (included on the new plan, or not available on it).
    if (!guardPlanChange(doc, cart, candidate)) return;
    let next = cart.filter((item) => item.type !== "plan");
    if (isRecurring(info.interval)) next = convertItemsToBilling(next, info.interval as Billing);
    next.push(candidate);
    setCart(win, next);
    return;
  }

  // Every other add goes through the conflict guard. The "switch plan
  // and add it" fix reads the plan off its pricing-page button.
  const planItemFor = (product: string): CartItem | null => {
    const planBtn = doc.querySelector<HTMLElement>(`[data-cart-btn][data-product="${product}"]`);
    if (!planBtn) return null;
    const planInfo = buttonInfo(planBtn, readBilling(win));
    if (!planInfo) return null;
    return { key: cartKey(planInfo.product, planInfo.interval), ...planInfo };
  };
  if (!guardAdd(doc, cart, candidate, planItemFor)) return;
  let next = cart.filter((item) => item.key !== key);
  // Stripe cannot bill monthly and yearly prices in the same session, so the
  // cart always keeps a single term.
  if (isRecurring(info.interval)) next = convertItemsToBilling(next, info.interval as Billing);
  next.push(candidate);
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
    // Full-width plan CTA: keep its visible price label in sync with the
    // cart state and the active billing term.
    const ctaLabel = btn.querySelector<HTMLElement>("[data-cta-label]");
    if (ctaLabel) {
      const d = ctaLabel.dataset;
      ctaLabel.textContent = added
        ? (d.added ?? "")
        : billing === "year"
          ? (d.year ?? d.month ?? "")
          : (d.month ?? "");
    }
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
  // Cadence on the total, only when every item shares one billing interval
  // (a monthly plan alone reads "C$89.99/mo"). Mixed carts (recurring plus
  // one-time) carry no suffix rather than a wrong one.
  const intervals = new Set(items.map((item) => item.interval));
  const totalSuffix =
    items.length > 0 && intervals.size === 1 ? intervalSuffix(doc, items[0].interval) : "";
  doc.querySelectorAll<HTMLElement>("[data-cart-total]").forEach((el) => {
    el.textContent = formatMoney(total, fmt) + totalSuffix;
  });

  const checkout = doc.querySelector<HTMLElement>("[data-cart-checkout]");
  if (checkout) {
    const empty = items.length === 0;
    checkout.classList.toggle("is-disabled", empty);
    checkout.setAttribute("aria-disabled", empty ? "true" : "false");
    checkout.tabIndex = empty ? -1 : 0;
  }

  // Bundle suggestion: Local SEO + Reviews together cost more than the
  // Lead Pack that covers both. Shown only when both are in the cart and
  // the Pack isn't, with the saving computed from the catalog prices for
  // the cart's own billing interval.
  const suggest = doc.querySelector<HTMLElement>("[data-pack-suggest]");
  if (suggest) {
    const seo = items.find((item) => item.product === "localseo");
    const review = items.find((item) => item.product === "review");
    const pack = items.find((item) => item.product === "lead-pack");
    if (seo && review && !pack && seo.interval === review.interval) {
      const packCents = priceCentsFor("lead-pack", seo.interval);
      const combined = seo.priceCents + review.priceCents;
      if (packCents !== undefined && combined > packCents) {
        const suffix = intervalSuffix(doc, seo.interval);
        const textEl = suggest.querySelector<HTMLElement>("[data-pack-suggest-text]");
        const template = suggest.dataset.packSuggestTemplate ?? "Local SEO + Reviews cost {combined}. The Lead Pack covers both for {pack}, saving you {save}.";
        if (textEl) {
          textEl.textContent = template
            .replace("{combined}", formatMoney(combined, fmt) + suffix)
            .replace("{pack}", formatMoney(packCents, fmt) + suffix)
            .replace("{save}", formatMoney(combined - packCents, fmt) + suffix);
        }
        suggest.hidden = false;
      } else {
        suggest.hidden = true;
      }
    } else {
      suggest.hidden = true;
    }
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

/** Reflect the active billing term on the toggle, and on the page itself
    (html[data-billing]) so CSS can hide the yearly total when Monthly is
    active. */
export function syncBillingToggle(doc: Document): void {
  const billing = readBilling(doc.defaultView);
  doc.documentElement.dataset.billing = billing;
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

let toastTimer: ReturnType<typeof setTimeout> | null = null;

/** Brief "Added X to cart" confirmation. Auto-hides after 3.5s; opening
    the drawer dismisses it immediately. */
function showAddedToast(doc: Document, name: string): void {
  const toast = doc.querySelector<HTMLElement>("[data-cart-toast]");
  if (!toast) return;
  const text = toast.querySelector<HTMLElement>("[data-cart-toast-text]");
  const template = toast.dataset.addedToast ?? "Added {name} to cart";
  if (text) text.textContent = template.replace("{name}", name);
  toast.hidden = false;
  requestFrame(() => toast.classList.add("is-visible"));
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => hideAddedToast(doc), 3500);
}

function hideAddedToast(doc: Document): void {
  const toast = doc.querySelector<HTMLElement>("[data-cart-toast]");
  if (!toast) return;
  toast.classList.remove("is-visible");
  toast.hidden = true;
}

export function openDrawer(doc: Document): void {
  hideAddedToast(doc);
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

/** Same trap for the conflict popup, which sits above the drawer. */
function trapConflictTab(event: KeyboardEvent, doc: Document): void {
  const dialog = conflictEl(doc);
  if (!dialog || dialog.hidden) return;
  const focusables = Array.from(
    dialog.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex]:not([tabindex="-1"])'),
  ).filter((el) => !el.hasAttribute("hidden"));
  if (focusables.length === 0) return;
  const active = doc.activeElement as HTMLElement | null;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (event.shiftKey) {
    if (active === first || !dialog.contains(active)) {
      event.preventDefault();
      last.focus();
    }
  } else {
    if (active === last || !dialog.contains(active)) {
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
  // Broadcast the term change in every case, after the new term is stored.
  // setCart above only fires the cart-change event when items actually
  // convert, so with an empty cart nothing told term-dependent UI (the Ads
  // Starter card) to re-check, and it stayed stuck on the old term.
  if (!win) return;
  const EventCtor = (win as unknown as { CustomEvent?: typeof CustomEvent }).CustomEvent;
  if (!EventCtor) return;
  win.dispatchEvent(new EventCtor(BILLING_CHANGE_EVENT, { detail: { billing } }));
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
    const key = buttonKey(cartBtn, readBilling(win));
    const wasAdded = getCart(win).some((item) => item.key === key);
    toggleFromButton(cartBtn, doc);
    const nowAdded = getCart(win).some((item) => item.key === key);
    if (!wasAdded && nowAdded) {
      showAddedToast(doc, cartBtn.dataset.name ?? cartBtn.dataset.product ?? "");
    } else if (wasAdded && !nowAdded) {
      // The confirmation is stale once the item leaves the cart.
      hideAddedToast(doc);
    }
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

  // Bundle switch: replace Local SEO + Reviews with the Lead Pack, on the
  // same billing interval, through the same conflict guard as a normal add
  // (Scale-ineligible packs are refused there, not here).
  const packSwitch = closestElement(event.target, "[data-pack-switch]");
  if (packSwitch) {
    event.preventDefault();
    const suggest = doc.querySelector<HTMLElement>("[data-pack-suggest]");
    const cart = getCart(win);
    const seo = cart.find((item) => item.product === "localseo");
    const review = cart.find((item) => item.product === "review");
    if (!seo || !review || seo.interval !== review.interval) return;
    const packCents = priceCentsFor("lead-pack", seo.interval);
    if (packCents === undefined) return;
    const candidate: CartItem = {
      key: cartKey("lead-pack", seo.interval),
      product: "lead-pack",
      name: suggest?.dataset.packName ?? "Lead Pack",
      type: "bundle",
      interval: seo.interval,
      priceCents: packCents,
    };
    // Guard against the cart WITHOUT the two components: the Pack includes
    // them, so guarding against the current cart would refuse the switch
    // as a bundle overlap. Only commit when the guard passes.
    const reduced = cart.filter((item) => item.product !== "localseo" && item.product !== "review");
    if (!guardAdd(doc, reduced, candidate)) return;
    setCart(win, [...reduced, candidate]);
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
    // Yearly is unavailable while the cart holds monthly-only products:
    // the guard pops the conflict up instead of switching.
    const billing = billingBtn.dataset.billingOpt === "year" ? "year" : "month";
    if (guardBillingChange(doc, billing)) applyBilling(doc, billing);
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

  if (closestElement(event.target, "[data-cart-conflict-close]") || closestElement(event.target, "[data-cart-conflict-overlay]")) {
    event.preventDefault();
    closeConflict(doc);
    return;
  }

  // Empty cart: keep the visitor on the page instead of opening an empty
  // Stripe session.
  const checkoutBtn = closestElement(event.target, "[data-cart-checkout]");
  if (checkoutBtn) {
    const cart = getCart(win);
    if (cart.length === 0) {
      event.preventDefault();
      return;
    }
    // A stale cart can hold a combination the guards now prevent: catch
    // it here instead of letting it fail at payment.
    if (!guardCheckout(doc)) {
      event.preventDefault();
      return;
    }
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
        if (isConflictOpen(doc)) {
          closeConflict(doc);
          return;
        }
        const drawer = drawerEl(doc);
        // `hidden` flips synchronously in openDrawer; the `is-open` class
        // only lands on the next animation frame, so it cannot gate this.
        if (drawer && !drawer.hidden) closeDrawer(doc);
      }
      if ((event as KeyboardEvent).key === "Tab") {
        if (isConflictOpen(doc)) trapConflictTab(event as KeyboardEvent, doc);
        else trapDrawerTab(event as KeyboardEvent, doc);
      }
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
  // Products removed from the catalog (e.g. the merged AI Website Chat)
  // can linger in an old cart: drop them so they can never reach payment.
  const stored = getCart(win);
  const known = stored.filter((item) => item.product in cartProducts);
  if (known.length !== stored.length) setCart(win, known);
  refresh(doc);
}
