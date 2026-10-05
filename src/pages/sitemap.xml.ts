import type { APIRoute } from "astro";
import { localizedPaths, type Locale } from "../lib/i18n/config";

const pagesByLocale: Record<Locale, { key: keyof typeof localizedPaths.en; changefreq: string; priority: string }[]> = {
  en: [
    { key: "home", changefreq: "weekly", priority: "1.0" },
    { key: "pricing", changefreq: "monthly", priority: "0.8" },
    { key: "contact", changefreq: "monthly", priority: "0.8" },
    { key: "demos", changefreq: "weekly", priority: "0.9" },
    { key: "start", changefreq: "monthly", priority: "0.9" },
  ],
  fr: [
    { key: "home", changefreq: "weekly", priority: "1.0" },
    { key: "pricing", changefreq: "monthly", priority: "0.8" },
    { key: "contact", changefreq: "monthly", priority: "0.8" },
    { key: "demos", changefreq: "weekly", priority: "0.9" },
    { key: "start", changefreq: "monthly", priority: "0.9" },
  ],
};

// Standalone pages not covered by localizedPaths (no PageKey).
const extraPages: { path: string; changefreq: string; priority: string; alternates: { hreflang: string; href: string }[] }[] = [
  {
    path: "/sources",
    changefreq: "monthly",
    priority: "0.3",
    alternates: [{ hreflang: "en", href: "https://webao.ca/sources" }],
  },
  {
    path: "/refunds",
    changefreq: "yearly",
    priority: "0.3",
    alternates: [{ hreflang: "en", href: "https://webao.ca/refunds" }],
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

export const GET: APIRoute = () => {
  const site = "https://webao.ca";
  const lastmod = new Date().toISOString().slice(0, 10);
  const urls: { loc: string; changefreq: string; priority: string; alternates: { hreflang: string; href: string }[] }[] = [];

  for (const locale of ["en", "fr"] as Locale[]) {
    for (const p of pagesByLocale[locale]) {
      const path = localizedPaths[locale][p.key];
      const loc = `${site}${path}`;
      const enPath = localizedPaths.en[p.key];
      const frPath = localizedPaths.fr[p.key];
      urls.push({
        loc,
        changefreq: p.changefreq,
        priority: p.priority,
        alternates: [
          { hreflang: "en", href: `${site}${enPath}` },
          { hreflang: "fr", href: `${site}${frPath}` },
          { hreflang: "x-default", href: `${site}${enPath}` },
        ],
      });
    }
  }

  for (const e of extraPages) {
    urls.push({ loc: `${site}${e.path}`, changefreq: e.changefreq, priority: e.priority, alternates: e.alternates });
  }

  // Deduplicate by loc
  const seen = new Set<string>();
  const deduped = urls.filter((u) => {
    if (seen.has(u.loc)) return false;
    seen.add(u.loc);
    return true;
  });

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${deduped
  .map(
    (u) => `  <url>
    <loc>${u.loc}</loc>
${u.alternates.map((a) => `    <xhtml:link rel="alternate" hreflang="${a.hreflang}" href="${a.href}" />`).join("\n")}
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
