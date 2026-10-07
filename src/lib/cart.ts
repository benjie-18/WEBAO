/**
 * WEBAO Cart — client-side cart state with localStorage persistence.
 * 
 * Stores selected products (plans, bundles, add-ons) with their billing
 * interval. The checkout page reads this and sends it to the backend
 * which maps product keys to Stripe Price IDs.
 */

export interface CartItem {
  /** Unique key: e.g. "launch-monthly", "grow-yearly", "lead-pack-monthly" */
  key: string;
  /** Product key: e.g. "launch", "grow", "lead-pack", "localseo" */
  product: string;
  /** Display name */
  name: string;
  /** Price in cents (e.g. 8999 = C$89.99) */
  priceCents: number;
  /** Billing interval */
  interval: "month" | "year" | "one-time";
  /** Product type for grouping */
  type: "plan" | "bundle" | "addon";
}

const STORAGE_KEY = "webao_cart_v1";

/** Get all cart items */
export function getCart(): CartItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const items = JSON.parse(raw);
    return Array.isArray(items) ? items : [];
  } catch {
    return [];
  }
}

/** Save cart items */
function saveCart(items: CartItem[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {
    // Storage unavailable; cart just won't persist
  }
  // Notify listeners (header drawer, pricing buttons)
  window.dispatchEvent(new CustomEvent("webao:cart-change", { detail: { items } }));
}

/** Add an item to the cart (replaces if same key exists) */
export function addToCart(item: CartItem): void {
  const cart = getCart();
  // Remove existing with same key (prevents duplicates)
  const filtered = cart.filter((i) => i.key !== item.key);
  // For plans: only one plan at a time (replace existing plan)
  const withoutPlan = item.type === "plan" 
    ? filtered.filter((i) => i.type !== "plan")
    : filtered;
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
export function formatInterval(interval: CartItem["interval"]): string {
  if (interval === "month") return "/mo";
  if (interval === "year") return "/yr";
  return "";
}
