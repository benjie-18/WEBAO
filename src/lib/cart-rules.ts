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
    conflicts.push({
      kind: "two-plans",
      products: plans.map((item) => item.product),
      fix: { remove: plans.slice(1).map((item) => item.product) },
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

  for (const [bundle, components] of Object.entries(BUNDLE_COMPONENTS)) {
    if (!has(bundle)) continue;
    for (const component of components) {
      if (has(component)) {
        conflicts.push({
          kind: "bundle-component",
          products: [bundle, component],
          bundle,
          component,
          fix: { remove: [component] },
        });
      }
    }
  }

  const bundles = Object.keys(BUNDLE_COMPONENTS).filter((bundle) => has(bundle));
  if (bundles.length > 1) {
    // Both bundles include the Review Generation Engine.
    conflicts.push({
      kind: "bundle-overlap",
      products: bundles,
      fix: { remove: bundles.slice(1) },
    });
  }

  const ads = ADS_OPTIONS.filter((option) => has(option));
  if (ads.length > 1) {
    conflicts.push({ kind: "ads-two", products: ads, fix: { remove: ads.slice(1) } });
  }

  // One conflict for all the individuals the Pack already includes, so
  // the popup's fix removes them all in one tap instead of one per popup.
  if (has(AI_PACK)) {
    const individuals = AI_INDIVIDUALS.filter((individual) => has(individual));
    if (individuals.length > 0) {
      conflicts.push({
        kind: "ai-pack",
        products: [AI_PACK, ...individuals],
        bundle: AI_PACK,
        component: individuals[0],
        fix: { remove: individuals },
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
