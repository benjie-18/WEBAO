/**
 * WEBAO cart rules — which products can be bought together.
 *
 * Pure functions with no imports, so the same rules run in the browser
 * (cart-ui, start-ui) and in the Worker (checkout.ts). The browser passes
 * the monthly-only set derived from the catalog; the Worker derives it
 * from PRICE_MAP (a product with a monthly price and no yearly price).
 * `tests/cart-rules.test.ts` pins every table below against the
 * compatibility matrix (`src/lib/pricing.ts`) and the catalog, so the
 * three can never drift apart silently.
 *
 * Rules (approved 2026-11-08):
 * - one website plan at a time;
 * - one Ads option at a time (Meta, Google, both, legacy pack, Starter);
 * - the AI Pack excludes the individual AI services;
 * - an add-on already included in the plan cannot be bought with it;
 * - an add-on not available on the plan cannot be bought with it;
 * - a bundle cannot be bought with one of its own components, and the
 *   two bundles cannot be bought together (both include the Review
 *   Generation Engine);
 * - recurring items in one checkout share a single billing interval.
 *
 * Deliberately NOT rules: website add-ons with no plan (existing
 * customers add options after purchase), Blog on Launch (the extra page
 * is included in its price), Priority Support on Scale (it still adds
 * the strategy call).
 *
 * The automated fix always resolves to the most expensive valid
 * configuration (Benji, 2026-11-08): where two products clash, the popup's
 * main button keeps the dearer side, and the cheaper swap is offered only
 * as the secondary choice.
 */

export type RuleInterval = "month" | "year" | "one-time";

export interface RuleItem {
  product: string;
  interval: RuleInterval;
  type: "plan" | "bundle" | "addon";
}

export type ConflictKind =
  | "included"
  | "not-available"
  | "bundle-component"
  | "bundle-overlap"
  | "ads-two"
  | "ai-pack"
  | "two-plans"
  | "mixed-intervals";

/** How to resolve the conflict: drop these products, or re-bill the
 *  cart onto one term. `remove` holds product ids, in cart order. */
export type ConflictFix = { remove: string[] } | { convertTo: "month" | "year" };

export interface CartConflict {
  kind: ConflictKind;
  /** Products involved, in cart order where that matters. */
  products: string[];
  /** Plan involved, for plan-scoped kinds. */
  plan?: string;
  /** Bundle involved, for bundle-scoped kinds. */
  bundle?: string;
  /** Component / add-on involved, for bundle-component and ai-pack. */
  component?: string;
  /** All components involved, for bundle-component (one conflict per bundle). */
  components?: string[];
  /** The automated fix: what to drop, or which term to convert onto. */
  fix: ConflictFix;
}

/** Ads options: at most one per cart (Starter included). */
export const ADS_OPTIONS = ["ads-pack", "ads-meta", "ads-google", "ads-both", "ads-starter"] as const;

/** AI Pack and the individual AI services it already includes. */
export const AI_PACK = "ai-pack";
export const AI_INDIVIDUALS = ["ai-receptionist", "aichat", "ai-followup"] as const;

/** Bundle -> the add-ons it already includes. */
export const BUNDLE_COMPONENTS: Record<string, string[]> = {
  "lead-pack": ["localseo", "review", "aichat"],
  "visibility-pack": ["review", "report"],
};

/** Plan -> add-ons already included in the plan. */
export const INCLUDED_IN_PLAN: Record<string, string[]> = {
  grow: ["quotephoto"],
  scale: ["quotephoto", "review", "booking", "report"],
};

/** Plan -> products not available on that plan. */
export const NOT_AVAILABLE_ON_PLAN: Record<string, string[]> = {
  launch: ["admin"],
  scale: ["lead-pack", "visibility-pack"],
};

/**
 * Monthly rate in cents, the common unit for comparing products. Pinned
 * against the catalog by tests/cart-rules.test.ts, so a price change in
 * one place fails loudly in the other.
 */
export const MONTHLY_PRICE_CENTS: Record<string, number> = {
  launch: 8999,
  grow: 14999,
  scale: 34999,
  "lead-pack": 23999,
  "visibility-pack": 9999,
  "ads-pack": 89999,
  "ads-meta": 89999,
  "ads-google": 89999,
  "ads-both": 134999,
  "ads-starter": 49999,
  "ai-receptionist": 29999,
  aichat: 9999,
  "ai-followup": 9999,
  "ai-pack": 39999,
  localseo: 15999,
  review: 9999,
  booking: 4999,
  report: 2999,
  admin: 3999,
  quotephoto: 999,
  ecommerce: 5999,
  blog: 3499,
  email: 2999,
  priority: 5999,
};

/** Monthly rate of one product (unknown products cost nothing here). */
function priceOf(product: string): number {
  return MONTHLY_PRICE_CENTS[product] ?? 0;
}

/**
 * Most expensive product in the list. Ties keep the last one: in the
 * add simulation the candidate is appended last, so an equally priced
 * pick the visitor just made wins over the one already in the cart.
 */
function mostExpensive(products: string[]): string {
  let best = products[0];
  for (const product of products.slice(1)) {
    if (priceOf(product) >= priceOf(best)) best = product;
  }
  return best;
}

/** The fix drops everything except the most expensive product. */
function keepMostExpensive(products: string[]): ConflictFix {
  const keep = mostExpensive(products);
  return { remove: products.filter((product) => product !== keep) };
}

function planOf(items: RuleItem[]): string | undefined {
  return items.find((item) => item.type === "plan")?.product;
}

/**
 * Every conflict in a cart, in a stable order (plans first, then the
 * rest in cart order). An empty array means the cart can be bought.
 */
export function findConflicts(items: RuleItem[]): CartConflict[] {
  const conflicts: CartConflict[] = [];
  const products = items.map((item) => item.product);
  const has = (product: string): boolean => products.includes(product);
  const plan = planOf(items);

  const plans = items.filter((item) => item.type === "plan");
  if (plans.length > 1) {
    // The fix keeps the most expensive plan (Benji, 2026-11-08: the popup's
    // main button always resolves to the most expensive configuration).
    conflicts.push({
      kind: "two-plans",
      products: plans.map((item) => item.product),
      fix: keepMostExpensive(plans.map((item) => item.product)),
    });
  }

  if (plan) {
    for (const included of INCLUDED_IN_PLAN[plan] ?? []) {
      if (has(included)) {
        conflicts.push({
          kind: "included",
          products: [included],
          plan,
          component: included,
          fix: { remove: [included] },
        });
      }
    }
    for (const unavailable of NOT_AVAILABLE_ON_PLAN[plan] ?? []) {
      if (has(unavailable)) {
        conflicts.push({
          kind: "not-available",
          products: [unavailable],
          plan,
          component: unavailable,
          fix: { remove: [unavailable] },
        });
      }
    }
  }

  // One conflict per bundle with all of its components in the cart, so
  // the popup's fix settles the whole bundle in one tap instead of one
  // component per popup. The fix keeps whichever side costs more: the
  // bundle, or the components it would replace, added up.
  for (const [bundle, components] of Object.entries(BUNDLE_COMPONENTS)) {
    if (!has(bundle)) continue;
    const present = components.filter((component) => has(component));
    if (present.length === 0) continue;
    const componentsCost = present.reduce((sum, component) => sum + priceOf(component), 0);
    conflicts.push({
      kind: "bundle-component",
      products: [bundle, ...present],
      bundle,
      component: present[0],
      components: present,
      fix: componentsCost > priceOf(bundle) ? { remove: [bundle] } : { remove: present },
    });
  }

  const bundles = Object.keys(BUNDLE_COMPONENTS).filter((bundle) => has(bundle));
  if (bundles.length > 1) {
    // Both bundles include the Review Generation Engine: keep the dearer one.
    conflicts.push({
      kind: "bundle-overlap",
      products: bundles,
      fix: keepMostExpensive(bundles),
    });
  }

  const ads = ADS_OPTIONS.filter((option) => has(option));
  if (ads.length > 1) {
    // One Ads option at a time: keep the dearest, drop the rest.
    conflicts.push({ kind: "ads-two", products: ads, fix: keepMostExpensive(ads) });
  }

  // One conflict for all the individuals the Pack already includes, so
  // the popup's fix removes them all in one tap instead of one per popup.
  // The fix keeps whichever side costs more: the Pack, or the individuals
  // added up (all three together cost more than the Pack).
  if (has(AI_PACK)) {
    const individuals = AI_INDIVIDUALS.filter((individual) => has(individual));
    if (individuals.length > 0) {
      const individualsCost = individuals.reduce((sum, individual) => sum + priceOf(individual), 0);
      conflicts.push({
        kind: "ai-pack",
        products: [AI_PACK, ...individuals],
        bundle: AI_PACK,
        component: individuals[0],
        fix: individualsCost > priceOf(AI_PACK) ? { remove: [AI_PACK] } : { remove: individuals },
      });
    }
  }

  const recurring = new Set(items.filter((item) => item.interval !== "one-time").map((item) => item.interval));
  if (recurring.size > 1) {
    conflicts.push({
      kind: "mixed-intervals",
      products,
      fix: { convertTo: "month" },
    });
  }

  return conflicts;
}

/** Products in the cart that have no yearly price (monthly only). */
export function monthlyOnlyInCart(items: RuleItem[], monthlyOnly: ReadonlySet<string>): string[] {
  return items.filter((item) => monthlyOnly.has(item.product)).map((item) => item.product);
}

/**
 * Conflicts the cart would have if `candidate` were added. The caller
 * uses this before adding, so the popup can offer the fix instead of
 * letting the bad combination into the cart.
 */
export function conflictsForAdding(items: RuleItem[], candidate: RuleItem): CartConflict[] {
  // Already in the cart: the click removes it, so nothing can conflict.
  if (items.some((item) => item.product === candidate.product)) return [];
  // Adding a plan replaces the previous plan, so check against the cart
  // without it; every other product stacks onto what is already there.
  const base = candidate.type === "plan" ? items.filter((item) => item.type !== "plan") : items;
  return findConflicts([...base, candidate]);
}
