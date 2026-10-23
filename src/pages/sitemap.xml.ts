import type { APIRoute } from "astro";
import { localizedPaths, type Locale } from "../lib/i18n/config";
import { demos } from "../lib/demos";
import { localHeroFor } from "../lib/demo-seo";

// Hidden from the public catalog (matches DemosPage's visibleDemos) —
// excluded from the sitemap too.
const hiddenDemos = new Set(["boba-club"]);

const pagesByLocale: Record<Locale, { key: keyof typeof localizedPaths.en; changefreq: string; priority: string }[]> = {
  en: [
    { key: "home", changefreq: "weekly", priority: "1.0" },
    { key: "pricing", changefreq: "monthly", priority: "0.8" },
    { key: "contact", changefreq: "monthly", priority: "0.8" },
    { key: "demos", changefreq: "weekly", priority: "0.9" },
    { key: "start", changefreq: "monthly", priority: "0.9" },
    { key: "terms", changefreq: "monthly", priority: "0.5" },
    { key: "refunds", changefreq: "yearly", priority: "0.3" },
    { key: "privacy", changefreq: "yearly", priority: "0.3" },
    { key: "support", changefreq: "monthly", priority: "0.5" },
  ],
  fr: [
    { key: "home", changefreq: "weekly", priority: "1.0" },
    { key: "pricing", changefreq: "monthly", priority: "0.8" },
    { key: "contact", changefreq: "monthly", priority: "0.8" },
    { key: "demos", changefreq: "weekly", priority: "0.9" },
    { key: "start", changefreq: "monthly", priority: "0.9" },
    { key: "terms", changefreq: "monthly", priority: "0.5" },
    { key: "refunds", changefreq: "yearly", priority: "0.3" },
    { key: "privacy", changefreq: "yearly", priority: "0.3" },
    { key: "support", changefreq: "monthly", priority: "0.5" },
  ],
};

// Standalone pages not covered by localizedPaths (no PageKey).
const extraPages: { path: string; changefreq: string; priority: string; alternates: { hreflang: string; href: string }[] }[] = [
  {
    path: "/sources",
    changefreq: "monthly",
    priority: "0.3",
    // Mirror the /fr/sources entry: both sides declare the en/fr pair so the
    // alternates are discoverable from either language.
    alternates: [
      { hreflang: "en", href: "https://webao.ca/sources" },
      { hreflang: "fr", href: "https://webao.ca/fr/sources" },
      { hreflang: "x-default", href: "https://webao.ca/sources" },
    ],
  },
  {
    path: "/fr/sources",
    changefreq: "monthly",
    priority: "0.3",
    alternates: [
      { hreflang: "fr", href: "https://webao.ca/fr/sources" },
      { hreflang: "en", href: "https://webao.ca/sources" },
      { hreflang: "x-default", href: "https://webao.ca/sources" },
    ],
  },
];

// Demo names contain characters like "&" that must be escaped in XML text.
const escapeXml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

export const GET: APIRoute = () => {
  const site = "https://webao.ca";
  const lastmod = new Date().toISOString().slice(0, 10);
  // Directory-style URLs carry a trailing slash on this site; the sitemap
  // must list the final (post-redirect) URLs.
  const slash = (path: string) => (path === "/" ? `${site}/` : `${site}${path.replace(/\/$/, "")}/`);
  const urls: {
    loc: string;
    changefreq: string;
    priority: string;
    alternates: { hreflang: string; href: string }[];
    images?: { loc: string; title: string }[];
  }[] = [];

  for (const locale of ["en", "fr"] as Locale[]) {
    for (const p of pagesByLocale[locale]) {
      const path = localizedPaths[locale][p.key];
      const loc = slash(path);
      const enPath = localizedPaths.en[p.key];
      const frPath = localizedPaths.fr[p.key];
      urls.push({
        loc,
        changefreq: p.changefreq,
        priority: p.priority,
        alternates: [
          { hreflang: "en", href: slash(enPath) },
          { hreflang: "fr", href: slash(frPath) },
          { hreflang: "x-default", href: slash(enPath) },
        ],
      });
    }
  }

  for (const e of extraPages) {
    urls.push({
      loc: slash(e.path),
      changefreq: e.changefreq,
      priority: e.priority,
      alternates: e.alternates.map((a) => ({ ...a, href: slash(new URL(a.href).pathname) })),
    });
  }

  // Demo detail pages (/demos/<id> + /fr/demos/<id>), one entry per visible demo.
  for (const demo of demos) {
    if (hiddenDemos.has(demo.id)) continue;
    const enPath = `/demos/${demo.id}`;
    const frPath = `/fr/demos/${demo.id}`;
    // Image sitemap entry: the demo's lead image, for image search results.
    const hero = localHeroFor(demo.id);
    const images = hero ? [{ loc: hero, title: demo.name }] : undefined;
    urls.push({
      loc: slash(enPath),
      changefreq: "monthly",
      priority: "0.7",
      alternates: [
        { hreflang: "en", href: slash(enPath) },
        { hreflang: "fr", href: slash(frPath) },
        { hreflang: "x-default", href: slash(enPath) },
      ],
      images,
    });
    urls.push({
      loc: slash(frPath),
      changefreq: "monthly",
      priority: "0.7",
      alternates: [
        { hreflang: "en", href: slash(enPath) },
        { hreflang: "fr", href: slash(frPath) },
        { hreflang: "x-default", href: slash(enPath) },
      ],
      images,
    });
  }

  // Deduplicate by loc
  const seen = new Set<string>();
  const deduped = urls.filter((u) => {
    if (seen.has(u.loc)) return false;
    seen.add(u.loc);
    return true;
  });

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
${deduped
  .map(
    (u) => `  <url>
    <loc>${u.loc}</loc>
${u.alternates.map((a) => `    <xhtml:link rel="alternate" hreflang="${a.hreflang}" href="${a.href}" />`).join("\n")}
${(u.images ?? []).map((img) => `    <image:image><image:loc>${escapeXml(img.loc)}</image:loc><image:title>${escapeXml(img.title)}</image:title></image:image>`).join("\n")}
    <lastmod>${lastmod}</lastmod>
    <changefreq>${u.changefreq}</changefreq>
    <priority>${u.priority}</priority>
  </url>`
  )
  .join("\n")}
</urlset>`.trim();

  return new Response(body, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
};
