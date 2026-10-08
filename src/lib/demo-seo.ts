// Shared SEO helpers for the standalone demo microsites (src/pages/demos/*).
// The demo pages do not use BaseLayout — each one is a self-contained HTML
// document — so the canonical/hreflang/robots decisions live here and are
// rendered by src/components/demos/DemoSeo.astro.

import { demos, type Demo } from "./demos";
import sourcesData from "./sources.json";

export const SITE_URL = "https://webao.ca";

// Hidden from the public catalog (mirrors DemosPage's hiddenDemos and the
// sitemap's hidden set): the page stays reachable but out of the search index.
export const HIDDEN_DEMOS: ReadonlySet<string> = new Set(["boba-club"]);

// Local (KV-served) imagery per demo, from the provenance list. Remote-only
// demos have no entry here.
const localFilesByDemo = new Map<string, string[]>();
for (const entry of sourcesData as { demo: string; file: string }[]) {
  if (!entry.file.startsWith("/demos/") || entry.file.includes("/_remote/")) continue;
  const list = localFilesByDemo.get(entry.demo) ?? [];
  list.push(entry.file);
  localFilesByDemo.set(entry.demo, list);
}

export function getDemo(id: string): Demo | undefined {
  return demos.find((demo) => demo.id === id);
}

export function isHiddenDemo(id: string): boolean {
  return HIDDEN_DEMOS.has(id);
}

/**
 * Canonical + hreflang alternates for a demo page. The site serves
 * directory-style URLs, so the canonical form carries a trailing slash
 * (matching sitemap.xml and the post-redirect URL).
 */
export function demoAlternates(id: string): { canonical: string; en: string; fr: string; xDefault: string } {
  const en = `${SITE_URL}/demos/${id}/`;
  const fr = `${SITE_URL}/fr/demos/${id}/`;
  return { canonical: en, en, fr, xDefault: en };
}

/** Alternates keyed for one locale: canonical is that locale's own URL. */
export function demoAlternatesForLocale(
  id: string,
  locale: "en" | "fr",
): { canonical: string; en: string; fr: string; xDefault: string } {
  const all = demoAlternates(id);
  return { canonical: locale === "fr" ? all.fr : all.en, en: all.en, fr: all.fr, xDefault: all.xDefault };
}

/**
 * Lead image for social previews and the image sitemap, resolved from the
 * provenance list (first local file per demo). Returns an absolute URL, or
 * null when the demo only uses remote imagery — callers then fall back to a
 * page-specific hero or the site-wide og:image.
 */
export function localHeroFor(id: string): string | null {
  const files = (localFilesByDemo.get(id) ?? []).sort();
  return files.length > 0 ? `${SITE_URL}${files[0]}` : null;
}

/** Localized breadcrumb labels for a demo page's JSON-LD. */
export function demoBreadcrumb(
  id: string,
  locale: "en" | "fr",
): { home: string; catalog: string; homeUrl: string; catalogUrl: string; name: string } {
  return {
    home: locale === "fr" ? "Accueil" : "Home",
    catalog: locale === "fr" ? "Démos" : "Demos",
    homeUrl: locale === "fr" ? `${SITE_URL}/fr/` : `${SITE_URL}/`,
    catalogUrl: locale === "fr" ? `${SITE_URL}/fr/demos/` : `${SITE_URL}/demos/`,
    name: getDemo(id)?.name ?? id,
  };
}
