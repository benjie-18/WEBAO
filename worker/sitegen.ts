// Deterministic site generator: the baseline custom build.
//
// Every WEBAO site is a custom build; this generator is the starting point
// the pipeline produces from the client's onboarding answers, never a
// template clone of a demo. The demo picks only steer the palette (a style
// direction). Output is a single self-contained index.html: valid, fast,
// and fully checkable by the QA suite in builds.ts. Human design review
// refines from here.

import type { Client } from "./clients";

export interface SiteFile {
  path: string;
  contentType: string;
  content: string;
}

interface Theme {
  bg: string;
  ink: string;
  accent: string;
  soft: string;
}

const THEMES: Record<string, Theme> = {
  default: { bg: "#F7F3EC", ink: "#17222E", accent: "#B3402A", soft: "#EFE7DA" },
  brume: { bg: "#F2F4F5", ink: "#1C2B33", accent: "#33677A", soft: "#E3EAED" },
  nora: { bg: "#FAF4EC", ink: "#2B1D16", accent: "#B4552D", soft: "#F1E2D2" },
  sahara: { bg: "#F8F2E4", ink: "#2E2416", accent: "#A8742C", soft: "#EFE3C8" },
  verde: { bg: "#F3F6EF", ink: "#1E2B1C", accent: "#3E7A34", soft: "#E4EDDA" },
};

export function themeFor(client: Client): Theme {
  const pick = client.onboarding?.styleDemos?.[0];
  return (pick && THEMES[pick]) || THEMES.default;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Services arrive as free text; split on lines, commas and semicolons. */
export function parseServices(raw?: string): string[] {
  if (!raw) return [];
  const parts = raw
    .split(/[\n,;]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.length <= 80);
  return [...new Set(parts)].slice(0, 12);
}

export function generateSite(client: Client): SiteFile[] {
  const o = client.onboarding || {};
  const fr = client.lang === "fr";
  const theme = themeFor(client);
  const business = o.businessName || client.business || client.email;
  const phone = (o.phone || "").trim();
  const phoneHref = "tel:+1" + phone.replace(/\D/g, "").replace(/^1/, "");
  const services = parseServices(o.services);
  const area = (o.serviceArea || "").trim();
  const hours = (o.hours || "").trim();
  const about = (o.about || "").trim();
  const year = new Date().getFullYear();

  const t = fr
    ? {
        services: "Services",
        about: "À propos",
        hours: "Heures d'ouverture",
        contact: "Contact",
        call: "Appeler le",
        serving: "Secteur desservi",
        rights: "Tous droits réservés.",
      }
    : {
        services: "Services",
        about: "About",
        hours: "Business hours",
        contact: "Contact",
        call: "Call",
        serving: "Service area",
        rights: "All rights reserved.",
      };

  const tagline = services.length > 0 && area
    ? `${services[0]} · ${area}`
    : area || services[0] || "";
  const description = (
    `${business}: ${services.join(", ")}${area ? ` · ${area}` : ""}. ${t.call} ${phone}.`
  ).slice(0, 160);
  const canonical = client.domain ? `https://${client.domain}/` : "";

  const serviceCards = services
    .map(
      (s) =>
        `<div class="card"><h3>${esc(s)}</h3></div>`,
    )
    .join("\n          ");
  const aboutBody = about
    ? `<p>${esc(about)}</p>`
    : `<p>${esc(business)}${services.length ? `: ${esc(services.join(", ").toLowerCase())}` : ""}${area ? ` · ${esc(area)}` : ""}.</p>`;

  const html = `<!doctype html>
<html lang="${fr ? "fr" : "en"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(business)}${area ? ` · ${esc(area)}` : ""}</title>
<meta name="description" content="${esc(description)}">
${canonical ? `<link rel="canonical" href="${canonical}">` : ""}
<meta property="og:title" content="${esc(business)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:type" content="website">
<style>
  :root { --bg: ${theme.bg}; --ink: ${theme.ink}; --accent: ${theme.accent}; --soft: ${theme.soft}; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font-family: Inter, system-ui, -apple-system, sans-serif; line-height: 1.55; }
  .wrap { max-width: 960px; margin: 0 auto; padding: 0 20px; }
  header { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 18px 0; }
  .brand { font-family: Georgia, 'Times New Roman', serif; font-size: 22px; font-weight: 600; }
  .btn { display: inline-block; background: var(--accent); color: #fff; text-decoration: none; padding: 11px 20px; border-radius: 999px; font-weight: 600; font-size: 15px; }
  .hero { padding: 56px 0 40px; }
  h1 { font-family: Georgia, 'Times New Roman', serif; font-size: clamp(2.2rem, 6vw, 3.6rem); line-height: 1.05; margin: 0 0 14px; font-weight: 600; }
  .tagline { font-size: 19px; margin: 0 0 26px; }
  section { padding: 30px 0; }
  h2 { font-family: Georgia, 'Times New Roman', serif; font-size: 28px; margin: 0 0 16px; font-weight: 600; }
  h3 { margin: 0; font-size: 17px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
  .card { background: var(--soft); border-radius: 14px; padding: 18px; }
  .panel { background: var(--soft); border-radius: 14px; padding: 22px; }
  .phone { font-size: 26px; font-weight: 700; color: var(--accent); text-decoration: none; }
  footer { padding: 26px 0 34px; font-size: 14px; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="brand">${esc(business)}</div>
    ${phone ? `<a class="btn" href="${phoneHref}">${t.call} ${esc(phone)}</a>` : ""}
  </header>
  <div class="hero">
    <h1>${esc(business)}</h1>
    ${tagline ? `<p class="tagline">${esc(tagline)}</p>` : ""}
    ${phone ? `<a class="btn" href="${phoneHref}">${t.call} ${esc(phone)}</a>` : ""}
  </div>
  ${services.length ? `<section id="services">
    <h2>${t.services}</h2>
    <div class="grid">
          ${serviceCards}
    </div>
  </section>` : ""}
  <section id="about">
    <h2>${t.about}</h2>
    ${aboutBody}
  </section>
  ${hours || area ? `<section id="hours">
    <div class="panel">
      ${hours ? `<h2>${t.hours}</h2><p>${esc(hours)}</p>` : ""}
      ${area ? `<h2>${t.serving}</h2><p>${esc(area)}</p>` : ""}
    </div>
  </section>` : ""}
  <section id="contact">
    <h2>${t.contact}</h2>
    ${phone ? `<p><a class="phone" href="${phoneHref}">${esc(phone)}</a></p>` : ""}
    ${area ? `<p>${esc(area)}</p>` : ""}
  </section>
  <footer>© ${year} ${esc(business)}. ${t.rights}</footer>
</div>
</body>
</html>
`;
  return [{ path: "index.html", contentType: "text/html; charset=utf-8", content: html }];
}
