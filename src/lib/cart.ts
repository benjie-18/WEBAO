/**
 * WEBAO Cart — client-side cart state with localStorage persistence.
 *
 * Stores selected products (plans, bundles, add-ons) with their billing
 * interval. The checkout page reads this and sends it to the backend
 * which maps product keys to Stripe Price IDs.
 *
 * Key format is `${product}-${interval}`, e.g. "launch-month", "grow-year",
 * "extrapage-one-time" — it must match `PRICE_MAP` in `worker/checkout.ts`
 * (the worker accepts "extrapage-onetime" too). The full list of keys this
 * site can produce is derived from `src/lib/cart-catalog.ts`.
 *
 * The storage helpers take an explicit `Storage`-like object so they can be
 * unit-tested outside a browser; the public helpers below use `localStorage`.
 */

export interface CartItem {
  /** Unique key: e.g. "launch-month", "grow-year", "extrapage-one-time" */
  key: string;
  /** Product key: e.g. "launch", "grow", "lead-pack", "localseo" */
  product: string;
  /** Display name */
  name: string;
  /** Price in cents (e.g. 8999 = C$89.99) */
  priceCents: number;
  /** Billing interval */
  interval: CartInterval;
  /** Product type for grouping */
  type: "plan" | "bundle" | "addon";
}

export type CartInterval = "month" | "year" | "one-time";

/** Interval, in the order shown in the guide's cart keys. */
export const CART_INTERVALS: CartInterval[] = ["month", "year", "one-time"];

export const STORAGE_KEY = "webao_cart_v1";

/** Event dispatched on `window` whenever the cart changes. */
export const CART_CHANGE_EVENT = "webao:cart-change";

/** The subset of the Web Storage API the cart needs. */
export interface CartStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

/** Cart key for a product on an interval: `${product}-${interval}`. */
export function cartKey(product: string, interval: CartInterval): string {
  return `${product}-${interval}`;
}

/** True when the interval is billed repeatedly (monthly or yearly). */
export function isRecurring(interval: CartInterval): boolean {
  return interval === "month" || interval === "year";
}

/** Narrow unknown values (localStorage, request bodies) to cart items. */
export function sanitizeCartItem(value: unknown): CartItem | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const interval = raw.interval;
  if (typeof raw.key !== "string" || raw.key === "") return null;
  if (typeof raw.product !== "string" || raw.product === "") return null;
  if (interval !== "month" && interval !== "year" && interval !== "one-time") return null;
  const priceCents = typeof raw.priceCents === "number" ? raw.priceCents : Number(raw.priceCents);
  if (!Number.isFinite(priceCents) || priceCents < 0) return null;
  const type = raw.type === "plan" || raw.type === "bundle" || raw.type === "addon" ? raw.type : "addon";
  return {
    key: raw.key,
    product: raw.product,
    name: typeof raw.name === "string" ? raw.name : raw.product,
    priceCents: Math.round(priceCents),
    interval,
    type,
  };
}

/** Read cart items from a storage object. Never throws. */
export function readCart(storage?: CartStorage | null): CartItem[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(sanitizeCartItem).filter((item): item is CartItem => item !== null);
  } catch {
    return [];
  }
}

/** Persist cart items. Never throws. */
export function writeCart(storage: CartStorage | null | undefined, items: CartItem[]): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {
    // Storage unavailable; cart just won't persist
  }
}

function defaultStorage(): CartStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function notify(items: CartItem[]): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(CART_CHANGE_EVENT, { detail: { items } }));
}

/** Get all cart items */
export function getCart(): CartItem[] {
  return readCart(defaultStorage());
}

/** Save cart items */
function saveCart(items: CartItem[]): void {
  writeCart(defaultStorage(), items);
  // Notify listeners (header drawer, pricing buttons)
  notify(items);
}

/**
 * Add an item to the cart (replaces if same key exists).
 * Only one plan at a time: adding a plan drops the previous plan.
 */
export function addToCart(item: CartItem): void {
  const cart = getCart();
  // Remove existing with same key (prevents duplicates)
  const filtered = cart.filter((i) => i.key !== item.key);
  // For plans: only one plan at a time (replace existing plan)
  const withoutPlan = item.type === "plan" ? filtered.filter((i) => i.type !== "plan") : filtered;
  saveCart([...withoutPlan, item]);
}

/** Remove an item from the cart by key */
export function removeFromCart(key: string): void {
  const cart = getCart();
  saveCart(cart.filter((i) => i.key !== key));
}

/** Check if an item is in the cart */
export function isInCart(key: string): boolean {
  return getCart().some((i) => i.key === key);
}

/** Clear the entire cart */
export function clearCart(): void {
  saveCart([]);
}

/** Get cart total in cents */
export function getCartTotal(): number {
  return getCart().reduce((sum, item) => sum + item.priceCents, 0);
}

/** Get cart item count */
export function getCartCount(): number {
  return getCart().length;
}

/** Format cents as CAD currency string */
export function formatCAD(cents: number): string {
  return `C$${(cents / 100).toFixed(2)}`;
}

/** Format interval for display */
export function formatInterval(interval: CartInterval): string {
  if (interval === "month") return "/mo";
  if (interval === "year") return "/yr";
  return "";
}
