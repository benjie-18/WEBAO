/**
 * WEBAO PRICING PLAN (FINAL) — language-independent structure.
 *
 * This module holds the shape of the plan only: ordering, note cross
 * references and the add-on compatibility matrix. Every user-facing string
 * lives in `src/lib/i18n/{en,fr}.ts` under `t.pricing` / `t.terms`, keyed by
 * the ids defined here, so English and French can never drift apart.
 *
 * Source of truth: "WEBAO PRICING PLAN (FINAL).txt" at the repo root.
 */

export type PlanId = "launch" | "grow" | "scale";

/** One feature line on a plan card / comparison row. */
interface PlanFeature {
  /** Key into t.pricing.plans[plan].features[] */
  key: string;
  /** Index number linking to the matching note on the terms page. */
  note?: number;
}

export interface PlanDef {
  id: PlanId;
  /** Line shown above this tier's own additions, e.g. "Everything in Launch, plus:" */
  inheritsFrom: PlanId | null;
  features: PlanFeature[];
}

/** Plans in display order: least expensive → most expensive. */
export const plans: PlanDef[] = [
  {
    id: "launch",
    inheritsFrom: null,
    features: [
      { key: "f1" },
      { key: "f2" },
      { key: "f3", note: 29 },
      { key: "f4" },
      { key: "f5" },
      { key: "f6" },
      { key: "f7" },
      { key: "f8", note: 4 },
      { key: "f9" },
      { key: "f10", note: 5 },
      { key: "f11", note: 6 },
      { key: "f12", note: 7 },
      { key: "f13", note: 8 },
    ],
  },
  {
    id: "grow",
    inheritsFrom: "launch",
    features: [
      { key: "f1" },
      { key: "f2" },
      { key: "f3", note: 28 },
      { key: "f4", note: 6 },
      { key: "f5", note: 10 },
      { key: "f6" },
      { key: "f7" },
      { key: "f8", note: 5 },
      { key: "f9", note: 11 },
      { key: "f10", note: 7 },
      { key: "f11", note: 8 },
    ],
  },
  {
    id: "scale",
    inheritsFrom: "grow",
    features: [
      { key: "f1" },
      { key: "f2" },
      { key: "f3", note: 6 },
      { key: "f4" },
      { key: "f5", note: 13 },
      { key: "f6", note: 11 },
      { key: "f7", note: 7 },
      { key: "f8", note: 8 },
    ],
  },
];

/** Bundle ids in display order. Data-driven: adding a bundle is one entry
 *  here plus its strings in the i18n dictionaries. */
export const bundleOrder = ["lead", "visibility"] as const;
export type BundleId = (typeof bundleOrder)[number];

interface BundleDef {
  id: BundleId;
  /** Index number on the bundle price line. */
  note: number;
  /** Keys into t.pricing.bundles[id].includes */
  includes: string[];
}

/**
 * NOTE: the plan defines Lead Pack and Visibility Pack only. There is no
 * Conversion bundle in the plan, so none is invented here.
 */
export const bundles: BundleDef[] = [
  { id: "lead", note: 15, includes: ["i1", "i2", "i3"] },
  { id: "visibility", note: 16, includes: ["i1", "i2"] },
];

/** Add-on ids. The first five are the featured/popular group, in the exact
 *  order the brief requires; the rest follow plan order. */
export const featuredAddonOrder = [
  "booking",
  "review",
  "localseo",
  "ecommerce",
  "bilingual",
] as const;

export const remainingAddonOrder = [
  "aichat",
  "blog",
  "email",
  "report",
  "extrapage",
  "priority",
  "admin",
  "quotephoto",
] as const;

export type Compat = "I" | "A" | "N";

interface CompatRow {
  /** Key into t.pricing.compatibility.rows[] */
  key: string;
  note?: number;
  launch: Compat;
  grow: Compat;
  scale: Compat;
}

/** Add-on compatibility, in plan order. */
export const compatibility: CompatRow[] = [
  { key: "localseo", launch: "A", grow: "A", scale: "A" },
  { key: "review", launch: "A", grow: "A", scale: "I" },
  { key: "aichat", launch: "A", grow: "A", scale: "A" },
  { key: "booking", launch: "A", grow: "A", scale: "I" },
  { key: "blog", note: 22, launch: "A", grow: "A", scale: "A" },
  { key: "bilingual", launch: "A", grow: "A", scale: "A" },
  { key: "ecommerce", launch: "A", grow: "A", scale: "A" },
  { key: "email", launch: "A", grow: "A", scale: "A" },
  { key: "report", launch: "A", grow: "A", scale: "I" },
  { key: "extrapage", note: 25, launch: "A", grow: "A", scale: "A" },
  { key: "priority", note: 26, launch: "A", grow: "A", scale: "A" },
  { key: "admin", note: 27, launch: "N", grow: "A", scale: "A" },
  { key: "quotephoto", note: 28, launch: "A", grow: "I", scale: "I" },
  { key: "leadpack", note: 17, launch: "A", grow: "A", scale: "N" },
  { key: "vispack", note: 17, launch: "A", grow: "A", scale: "N" },
];

/** Terms page sections with their note numbers in ascending order. */
export const termSections = [
  { id: "billing", notes: [1, 2, 3] },
  { id: "plans", notes: [4, 9, 12] },
  { id: "details", notes: [5, 6, 7, 8, 10, 11, 13, 14] },
  { id: "bundles", notes: [15, 16, 17] },
  { id: "addons", notes: [18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29] },
] as const;
