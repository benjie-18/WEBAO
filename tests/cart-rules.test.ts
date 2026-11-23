// Cart rules: every approved conflict is caught, and the tables stay
// pinned to the compatibility matrix and the catalog.
import assert from "node:assert/strict";
import test from "node:test";
import { cartProducts } from "../src/lib/cart-catalog";
import { compatibility } from "../src/lib/pricing";
import {
  AI_INDIVIDUALS,
  AI_PACK,
  ADS_OPTIONS,
  BUNDLE_COMPONENTS,
  INCLUDED_IN_PLAN,
  MONTHLY_PRICE_CENTS,
  NOT_AVAILABLE_ON_PLAN,
  conflictsForAdding,
  findConflicts,
  monthlyOnlyInCart,
  type RuleItem,
} from "../src/lib/cart-rules";

const item = (product: string, interval: RuleItem["interval"] = "month", type: RuleItem["type"] = "addon"): RuleItem => ({
  product,
  interval,
  type,
});
const plan = (product: string, interval: RuleItem["interval"] = "month"): RuleItem => item(product, interval, "plan");
const bundle = (product: string, interval: RuleItem["interval"] = "month"): RuleItem => item(product, interval, "bundle");

/** Monthly-only set, derived from the catalog exactly like the UI does. */
function monthlyOnly(): Set<string> {
  return new Set(
    Object.values(cartProducts)
      .filter((p) => p.monthCents !== undefined && p.yearCents === undefined)
      .map((p) => p.product),
  );
}

test("rule tables match the compatibility matrix", () => {
  // Row keys are the add-on ids, except the bundles (leadpack/vispack/growthbundle/growthengine).
  const rowToProduct: Record<string, string> = {
    leadpack: "lead-pack",
    vispack: "visibility-pack",
    growthbundle: "growth-bundle",
    growthengine: "growth-engine",
  };
  for (const row of compatibility) {
    const product = rowToProduct[row.key] ?? row.key;
    for (const [planId, value] of [
      ["launch", row.launch],
      ["grow", row.grow],
      ["scale", row.scale],
    ] as const) {
      if (value === "I") {
        assert.ok(
          (INCLUDED_IN_PLAN[planId] ?? []).includes(product),
          `${product} is Included on ${planId} but missing from INCLUDED_IN_PLAN`,
        );
      } else {
        assert.ok(
          !(INCLUDED_IN_PLAN[planId] ?? []).includes(product),
          `${product} is not Included on ${planId} but listed in INCLUDED_IN_PLAN`,
        );
      }
      if (value === "N") {
        assert.ok(
          (NOT_AVAILABLE_ON_PLAN[planId] ?? []).includes(product),
          `${product} is Not available on ${planId} but missing from NOT_AVAILABLE_ON_PLAN`,
        );
      } else {
        assert.ok(
          !(NOT_AVAILABLE_ON_PLAN[planId] ?? []).includes(product),
          `${product} is available on ${planId} but listed in NOT_AVAILABLE_ON_PLAN`,
        );
      }
    }
  }
});

test("rule tables only name real catalog products", () => {
  const all = new Set([
    ...Object.values(INCLUDED_IN_PLAN).flat(),
    ...Object.values(NOT_AVAILABLE_ON_PLAN).flat(),
    ...Object.keys(BUNDLE_COMPONENTS),
    ...Object.values(BUNDLE_COMPONENTS).flat(),
    ...ADS_OPTIONS,
    AI_PACK,
    ...AI_INDIVIDUALS,
  ]);
  for (const product of all) {
    assert.ok(product in cartProducts, `${product} is in the rules but not in the catalog`);
  }
});

test("monthly-only set matches the catalog", () => {
  assert.deepEqual(
    [...monthlyOnly()].sort(),
    ["ads-both", "ads-google", "ads-meta", "ads-pack", "ads-starter", "growth-engine"],
  );
  assert.ok(!monthlyOnly().has("aichat"), "the online receptionist is yearly available");
  assert.ok(!monthlyOnly().has("ai-pack"), "the AI Pack is yearly available (Benji, 2026-11-08)");
  assert.ok(!monthlyOnly().has("ai-receptionist"), "the Receptionist is yearly available");
  assert.ok(!monthlyOnly().has("ai-followup"), "the Smart Follow-up is yearly available");
});

test("monthly price table matches the catalog", () => {
  for (const [product, cents] of Object.entries(MONTHLY_PRICE_CENTS)) {
    assert.equal(cartProducts[product]?.monthCents, cents, `${product} price drifted from the catalog`);
  }
  // Every catalog product with a monthly rate is in the table.
  for (const p of Object.values(cartProducts)) {
    if (p.monthCents !== undefined) {
      assert.ok(p.product in MONTHLY_PRICE_CENTS, `${p.product} has a monthly rate but no rules price`);
    }
  }
});

test("the automated fix always keeps the most expensive side", () => {
  const fixOf = (items: RuleItem[]) => findConflicts(items)[0]?.fix;
  // Ads: keep the dearer option (Both over the legacy pack, Meta over Starter).
  assert.deepEqual(fixOf([bundle("ads-both"), bundle("ads-pack")]), { remove: ["ads-pack"] });
  assert.deepEqual(fixOf([bundle("ads-meta"), bundle("ads-starter")]), { remove: ["ads-starter"] });
  // Equal prices: the later pick wins (the candidate is appended last).
  assert.deepEqual(fixOf([bundle("ads-meta"), bundle("ads-google")]), { remove: ["ads-meta"] });
  // AI Pack: one or two individuals are cheaper than the Pack; all three cost more.
  assert.deepEqual(fixOf([bundle("ai-pack"), item("ai-receptionist")]), { remove: ["ai-receptionist"] });
  assert.deepEqual(fixOf([bundle("ai-pack"), item("ai-receptionist"), item("ai-followup")]), {
    remove: ["ai-receptionist", "ai-followup"],
  });
  assert.deepEqual(fixOf([bundle("ai-pack"), item("ai-receptionist"), item("aichat"), item("ai-followup")]), {
    remove: ["ai-pack"],
  });
  // Bundles: one component is cheaper than its bundle; all three Lead Pack components cost more.
  assert.deepEqual(fixOf([bundle("lead-pack"), item("review")]), { remove: ["review"] });
  assert.deepEqual(fixOf([bundle("lead-pack"), item("localseo"), item("review"), item("aichat")]), {
    remove: ["lead-pack"],
  });
  assert.deepEqual(fixOf([bundle("visibility-pack"), item("report")]), { remove: ["report"] });
  // Growth Bundle: one component is cheaper than the bundle; Local SEO
  // plus Review together now cost less than the bundle, so the bundle wins.
  assert.deepEqual(fixOf([bundle("growth-bundle"), item("grow")]), { remove: ["grow"] });
  assert.deepEqual(fixOf([bundle("growth-bundle"), item("localseo"), item("review")]), {
    remove: ["localseo", "review"],
  });
  // Growth Engine: its components are cheaper than the bundle.
  assert.deepEqual(fixOf([bundle("growth-engine"), item("ads-starter")]), { remove: ["ads-starter"] });
  assert.deepEqual(fixOf([bundle("growth-engine"), bundle("growth-bundle")]), { remove: ["growth-bundle"] });
  // Bundle overlap: the dearer bundle wins.
  assert.deepEqual(fixOf([bundle("growth-bundle"), bundle("lead-pack")]), { remove: ["lead-pack"] });
  assert.deepEqual(fixOf([bundle("growth-engine"), bundle("visibility-pack")]), {
    remove: ["visibility-pack"],
  });
  // One conflict per bundle, listing every component in the cart.
  const lead = findConflicts([bundle("lead-pack"), item("localseo"), item("review"), item("aichat")]);
  assert.equal(lead.length, 1);
  assert.deepEqual(lead[0]?.components, ["localseo", "review", "aichat"]);
  // Both bundles: keep the Lead Pack.
  assert.deepEqual(fixOf([bundle("lead-pack"), bundle("visibility-pack")]), { remove: ["visibility-pack"] });
  // Two plans: keep the dearer plan.
  assert.deepEqual(fixOf([plan("launch"), plan("scale")]), { remove: ["launch"] });
});

test("included add-ons conflict with the plan that includes them", () => {
  assert.deepEqual(
    findConflicts([plan("grow"), item("quotephoto")]).map((c) => c.kind),
    ["included"],
  );
  assert.deepEqual(
    findConflicts([plan("scale"), item("review"), item("booking"), item("report"), item("quotephoto")]).map((c) => c.kind),
    ["included", "included", "included", "included"],
  );
  // Same add-ons are fine on Launch.
  assert.deepEqual(findConflicts([plan("launch"), item("quotephoto"), item("review"), item("booking"), item("report")]), []);
  // Priority Support on Scale still adds the strategy call: no conflict.
  assert.deepEqual(findConflicts([plan("scale"), item("priority")]), []);
});

test("not-available add-ons and bundles conflict", () => {
  assert.equal(findConflicts([plan("launch"), item("admin")])[0]?.kind, "not-available");
  assert.equal(findConflicts([plan("scale"), bundle("lead-pack")])[0]?.kind, "not-available");
  assert.equal(findConflicts([plan("grow"), bundle("lead-pack")])[0]?.kind, "not-available");
  assert.equal(findConflicts([plan("scale"), bundle("visibility-pack")])[0]?.kind, "not-available");
  // The Growth bundles include the Grow plan, so they cannot be bought
  // with Launch or Scale.
  assert.equal(findConflicts([plan("launch"), bundle("growth-bundle")])[0]?.kind, "not-available");
  assert.equal(findConflicts([plan("scale"), bundle("growth-bundle")])[0]?.kind, "not-available");
  assert.equal(findConflicts([plan("launch"), bundle("growth-engine")])[0]?.kind, "not-available");
  assert.equal(findConflicts([plan("scale"), bundle("growth-engine")])[0]?.kind, "not-available");
  assert.deepEqual(findConflicts([plan("grow"), item("admin")]), []);
});

test("bundles conflict with their own components and with each other", () => {
  assert.equal(findConflicts([bundle("lead-pack"), item("localseo")])[0]?.kind, "bundle-component");
  assert.equal(findConflicts([bundle("lead-pack"), item("review")])[0]?.kind, "bundle-component");
  assert.equal(findConflicts([bundle("lead-pack"), item("aichat")])[0]?.kind, "bundle-component");
  assert.equal(findConflicts([bundle("visibility-pack"), item("report")])[0]?.kind, "bundle-component");
  assert.deepEqual(
    findConflicts([bundle("lead-pack"), bundle("visibility-pack")]).map((c) => c.kind),
    ["bundle-overlap"],
  );
  assert.deepEqual(findConflicts([bundle("lead-pack"), item("blog")]), []);
  // Growth Bundle: the Grow plan itself is a component.
  assert.equal(findConflicts([bundle("growth-bundle"), plan("grow")])[0]?.kind, "bundle-component");
  assert.equal(findConflicts([bundle("growth-bundle"), item("localseo")])[0]?.kind, "bundle-component");
  assert.equal(findConflicts([bundle("growth-bundle"), item("review")])[0]?.kind, "bundle-component");
  // Growth Engine: the Growth Bundle and the Starter test are components.
  assert.equal(findConflicts([bundle("growth-engine"), bundle("growth-bundle")])[0]?.kind, "bundle-component");
  assert.equal(findConflicts([bundle("growth-engine"), bundle("ads-starter")])[0]?.kind, "bundle-component");
  // Growth bundles share the Review Generation Engine with the other bundles.
  assert.deepEqual(
    findConflicts([bundle("growth-bundle"), bundle("lead-pack")]).map((c) => c.kind),
    ["bundle-overlap"],
  );
  assert.deepEqual(
    findConflicts([bundle("growth-engine"), bundle("visibility-pack")]).map((c) => c.kind),
    ["bundle-overlap"],
  );
  // Growth Engine plus Growth Bundle is both a component clash and an
  // overlap; the component fix settles it in one tap.
  assert.deepEqual(
    findConflicts([bundle("growth-engine"), bundle("growth-bundle")]).map((c) => c.kind),
    ["bundle-component", "bundle-overlap"],
  );
});

test("one Ads option and one AI Pack at a time", () => {
  assert.equal(findConflicts([bundle("ads-meta"), bundle("ads-starter")])[0]?.kind, "ads-two");
  assert.equal(findConflicts([bundle("ads-google"), bundle("ads-both")])[0]?.kind, "ads-two");
  assert.deepEqual(findConflicts([bundle("ads-starter")]), []);
  assert.equal(findConflicts([bundle("ai-pack"), item("aichat")])[0]?.kind, "ai-pack");
  assert.equal(findConflicts([bundle("ai-pack"), item("ai-receptionist")])[0]?.kind, "ai-pack");
  assert.deepEqual(findConflicts([item("ai-receptionist"), item("ai-followup")]), []);
});

test("two plans and mixed intervals conflict", () => {
  assert.equal(findConflicts([plan("launch"), plan("grow")])[0]?.kind, "two-plans");
  assert.equal(findConflicts([plan("grow", "year"), bundle("ads-meta", "month")])[0]?.kind, "mixed-intervals");
  assert.deepEqual(findConflicts([plan("grow", "year"), item("extrapage", "one-time")]), []);
});

test("conflictsForAdding simulates the add, including plan replacement", () => {
  // Adding a plan replaces the old one, so no two-plan conflict.
  assert.deepEqual(conflictsForAdding([plan("launch"), item("quotephoto")], plan("grow")), [
    expectIncluded(),
  ]);
  // Adding the same product again is a removal, never a conflict.
  assert.deepEqual(conflictsForAdding([plan("grow"), item("quotephoto")], item("quotephoto")), []);
  // Adding a monthly-only product to a yearly cart conflicts.
  assert.equal(
    conflictsForAdding([plan("grow", "year")], bundle("ads-meta", "month"))[0]?.kind,
    "mixed-intervals",
  );
  function expectIncluded() {
    const found = findConflicts([plan("grow"), item("quotephoto")]);
    assert.equal(found.length, 1);
    return found[0];
  }
});

test("monthlyOnlyInCart lists the monthly-only products", () => {
  const set = monthlyOnly();
  assert.deepEqual(monthlyOnlyInCart([plan("grow"), bundle("ads-starter"), item("aichat")], set), ["ads-starter"]);
  assert.deepEqual(monthlyOnlyInCart([plan("grow")], set), []);
  assert.deepEqual(monthlyOnlyInCart([bundle("growth-engine"), bundle("growth-bundle")], set), ["growth-engine"]);
});
