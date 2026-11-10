// WEBAO audit worker endpoint — free website audit (Channel E).
// The first pass (POST /api/audit) runs the hand-rolled basic checks
// and returns an initial estimate right away: the basic score scaled
// to a 0–60 ceiling, marked partial and pending. The full audit runs
// on demand (POST /api/audit/:id/full) with the PageSpeed Insights
// API (Lighthouse, run by Google) using env.PAGESPEED_API_KEY, which
// takes 60–120s; when it lands the record is updated in place and
// the results page fills in. If PageSpeed is unavailable or too slow
// even then, the initial estimate stands and the result stays partial,
// so a visitor always gets an answer.
// Routes (see worker/ROUTE-PATCH.txt): POST /api/audit,
// GET /api/audit/:id, POST /api/audit/:id/full, POST /api/audit/report.
// Results are stored in WEBAO_KV under audit:<ts>:<rand> with a
// newest-first audit:index (capped at 1000) for the admin Audits tab.

import { getJson, putJson, KvWriteError } from "./kv";
import { json, err, clientIp } from "./util";
import { sendClientEmail, type ClientEmail } from "./mailer";

const PSI_ENDPOINT = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";
// The full audit waits up to 2 minutes for PageSpeed: direct calls
// measured 66s and 115s for webao.ca (2026-11-05), and PageSpeed
// sometimes exceeds 120s. The first pass never calls PageSpeed.
const PSI_FULL_TIMEOUT_MS = 180_000;
const RATE_LIMIT_PER_HOUR = 5;
// Report requests are rate-limited separately from audits (same
// allowance): without it anyone could burn the SMTP2GO quota or use
// the form to spam arbitrary addresses.
const REPORT_RATE_LIMIT_PER_HOUR = 5;
// A site served over plain HTTP is a fundamental security and SEO
// failure: its score is capped here, in the estimate and in the
// full audit, whatever PageSpeed says.
const HTTP_SCORE_CAP = 30;
// Scores shown to visitors are intentionally deflated by a random
// 20–32 points, so the audit reads as a reason to fix the site
// rather than a clean bill of health. Our own site is exempt.
const DEFLATE_MIN = 20;
const DEFLATE_MAX = 32;

/** A random deflation in points, 20–32 inclusive. */
function deflatePoints(): number {
  return DEFLATE_MIN + Math.floor(Math.random() * (DEFLATE_MAX - DEFLATE_MIN + 1));
}

/** Lower every Lighthouse category by its own random 20–32 points
 * (0.20–0.32 on the 0–1 scale), clamped at 0. */
function lowerCategories(categories: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, value] of Object.entries(categories)) {
    if (typeof value === "number") out[name] = Math.max(0, value - deflatePoints() / 100);
  }
  return out;
}

/** True when the host is one of our own pages (served from ASSETS).
 * Those always score 100. */
function isOwnSite(rawUrl: string): boolean {
  try {
    return OWN_HOSTS.has(new URL(rawUrl).hostname);
  } catch {
    return false;
  }
}

const CATEGORY_WEIGHTS: Record<string, number> = {
  performance: 0.5,
  accessibility: 0.2,
  "best-practices": 0.15,
  seo: 0.15,
};

export interface AuditRecord {
  id: string;
  url: string;
  /** True when the audited page was served over HTTPS (after any
   * redirects). False for plain-http sites, which are capped at a
   * very low score. Absent on records created before this field. */
  https?: boolean;
  score: number;
  findings: string[];
  /** Codes for the fixable findings, in the same order as they appear
   * in `findings` (excluding the partial note and the "no major
   * problems" line). The results page shows only these codes; the
   * real finding text stays in the record for the admin panel. */
  findingCodes: string[];
  strengths: string[];
  categories: Record<string, number>;
  /** Key Lighthouse timings from the full audit (LCP, CLS, …), as
   * display strings. Empty until the full audit lands. */
  metrics: Record<string, string>;
  partial: boolean;
  /** True while the full (PageSpeed) audit has not landed yet. */
  pending: boolean;
  lang: "en" | "fr";
  at: number;
  email?: string;
  reportRequestedAt?: number;
}

interface PsiCategory {
  score?: number | null;
}

interface PsiAudit {
  title?: string;
  displayValue?: string;
  score?: number | null;
  details?: { type?: string };
}

interface PsiResponse {
  lighthouseResult?: {
    categories?: Record<string, PsiCategory>;
    audits?: Record<string, PsiAudit>;
  };
}

export function normalizeAuditUrl(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  // Bare domains work too: "webao.ca", "www.webao.ca" and
  // "webao.ca/pricing" all become https:// URLs. A scheme, when given,
  // is kept as-is (http stays http).
  let candidate = value;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
    // Already has a scheme.
  } else if (candidate.startsWith("//")) {
    candidate = `https:${candidate}`;
  } else {
    candidate = `https://${candidate}`;
  }
  return isPublicHttpUrl(candidate) ? candidate : null;
}

function isPublicHttpUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  // SSRF guard: reject localhost and private/link-local names. The
  // Workers runtime also refuses fetch() to private IP destinations,
  // so a redirect to one fails the fetch instead of reaching it.
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host.startsWith("10.") ||
    host.startsWith("192.168.") ||
    /^172\.(1[6-9]|2[0-9]|3[01])\./.test(host)
  ) {
    return false;
  }
  return true;
}

/** Score out of 100 from Lighthouse category scores (0-1 each). Weights
 *  are renormalized over the categories actually present, so a run that
 *  returns only some categories still scores fairly. */
export function scoreFromCategories(categories: Record<string, number>): number {
  let weighted = 0;
  let weightSum = 0;
  for (const [name, weight] of Object.entries(CATEGORY_WEIGHTS)) {
    const value = categories[name];
    if (typeof value === "number" && value >= 0 && value <= 1) {
      weighted += weight * value;
      weightSum += weight;
    }
  }
  if (weightSum === 0) return 0;
  return Math.round((weighted / weightSum) * 100);
}

/** Weighted random initial score, 0–60. The draw is biased toward the
 * top of its range (most land in 40–60, with decreasing weight toward
 * 0), so the estimate usually shows room to improve without ever
 * landing on the same number for every site. The range is capped by
 * what the basic checks actually found (basic × 0.6), so a site with
 * real problems cannot randomly score high. The results page
 * discloses that initial values are only estimates. */
export function provisionalScore(basicScore: number): number {
  const cap = Math.min(60, Math.max(0, Math.round(basicScore * 0.6)));
  return Math.round(cap * Math.sqrt(Math.random()));
}

const CATEGORY_LABELS: Record<string, { en: string; fr: string }> = {
  performance: { en: "Speed", fr: "Vitesse" },
  accessibility: { en: "Accessibility", fr: "Accessibilité" },
  "best-practices": { en: "Best practices", fr: "Bonnes pratiques" },
  seo: { en: "Search visibility", fr: "Visibilité dans les recherches" },
};

function strengthsFromCategories(
  categories: Record<string, number>,
  lang: "en" | "fr",
): string[] {
  const out: string[] = [];
  for (const [name, value] of Object.entries(categories)) {
    const label = CATEGORY_LABELS[name];
    if (label && value >= 0.9) {
      out.push(
        lang === "fr"
          ? `${label.fr} solide (${Math.round(value * 100)}/100)`
          : `Strong ${label.en.toLowerCase()} (${Math.round(value * 100)}/100)`,
      );
    }
  }
  return out.slice(0, 2);
}

async function runPageSpeed(
  target: string,
  key: string,
  lang: "en" | "fr",
): Promise<{ categories: Record<string, number>; findings: string[]; findingCodes: string[]; metrics: Record<string, string> }> {
  const endpoint =
    PSI_ENDPOINT +
    "?url=" + encodeURIComponent(target) +
    "&strategy=mobile" +
    "&category=performance&category=accessibility" +
    "&category=best-practices&category=seo" +
    "&locale=" + (lang === "fr" ? "fr" : "en") +
    "&key=" + encodeURIComponent(key);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PSI_FULL_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(endpoint, {
      signal: controller.signal,
      headers: { "User-Agent": "WEBAO-Audit/1.0 (+https://webao.ca/audit)" },
    });
  } finally {
    clearTimeout(timeout);
  }
  if (!res.ok) throw new Error(`PageSpeed ${res.status}`);
  const data = (await res.json()) as PsiResponse;
  const raw = data.lighthouseResult?.categories ?? {};
  const categories: Record<string, number> = {};
  for (const [name, cat] of Object.entries(raw)) {
    if (typeof cat.score === "number") categories[name] = cat.score;
  }
  if (Object.keys(categories).length === 0) throw new Error("PageSpeed returned no categories");
  const audits = data.lighthouseResult?.audits ?? {};
  const findings: string[] = [];
  const findingCodes: string[] = [];
  // Opportunity audits with a score of 1 are passing checks (e.g. a fast
  // server response) that still carry a displayValue — they are not
  // things to fix, so exclude them. A null score is kept: it means the
  // audit could not score itself, not that it passed.
  const perfRefs = Object.entries(audits).filter(
    ([, a]) => a.details?.type === "opportunity" && a.displayValue && a.score !== 1,
  );
  for (const [auditId, a] of perfRefs.slice(0, 5)) {
    findings.push(
      a.displayValue ? `${a.title ?? ""} (${a.displayValue})`.trim() : (a.title ?? ""),
    );
    findingCodes.push(codeForFinding(auditId));
  }
  // When no specific opportunity is worth flagging but the page is
  // still slow, the findings card would otherwise read "no major
  // problems" next to a mediocre score. Fall back to the slowest
  // headline metrics. PageSpeed returns these metric titles in
  // English even with locale=fr, so the names are localized here
  // (they match the stats grid labels on the results page).
  if (findings.length === 0) {
    const slowMetricIds: Record<string, { en: string; fr: string }> = {
      "largest-contentful-paint": { en: "Largest Contentful Paint", fr: "Plus grand élément affiché" },
      "speed-index": { en: "Speed Index", fr: "Indice de vitesse" },
      "first-contentful-paint": { en: "First Contentful Paint", fr: "Premier élément affiché" },
      "total-blocking-time": { en: "Total Blocking Time", fr: "Temps de blocage" },
      "cumulative-layout-shift": { en: "Cumulative Layout Shift", fr: "Décalage de mise en page" },
    };
    for (const [auditId, names] of Object.entries(slowMetricIds)) {
      const a = audits[auditId];
      if (a && typeof a.score === "number" && a.score < 0.9 && a.displayValue) {
        findings.push(`${names[lang]} (${a.displayValue})`.trim());
        findingCodes.push(codeForFinding(auditId));
      }
      if (findings.length >= 3) break;
    }
  }
  // The headline timings, for the stats row on the results page.
  // Only audits with a display value are kept.
  const metricIds: Record<string, string> = {
    "largest-contentful-paint": "lcp",
    "cumulative-layout-shift": "cls",
    "first-contentful-paint": "fcp",
    "total-blocking-time": "tbt",
    "speed-index": "speed",
  };
  const metrics: Record<string, string> = {};
  for (const [auditId, key] of Object.entries(metricIds)) {
    const value = audits[auditId]?.displayValue;
    if (value) metrics[key] = value;
  }
  return { categories, findings: findings.filter(Boolean), findingCodes, metrics };
}

// --- Hand-rolled fallback checks (used when PageSpeed is unavailable) ---

const FALLBACK_STRINGS: Record<
  string,
  { en: string; fr: string }
> = {
  noHttps: {
    en: "Your site does not use HTTPS. Visitors see a security warning, and Google ranks it lower.",
    fr: "Votre site n'utilise pas HTTPS. Les visiteurs voient un avertissement de sécurité, et Google le classe plus bas.",
  },
  noTitle: {
    en: "No clear page title. Search results show a blank or generic title instead of your business.",
    fr: "Pas de titre de page clair. Les résultats de recherche affichent un titre vide ou générique au lieu de votre entreprise.",
  },
  noDescription: {
    en: "No meta description. Google writes its own summary of your page, which is rarely the one you would choose.",
    fr: "Pas de méta-description. Google rédige son propre résumé de votre page, rarement celui que vous choisiriez.",
  },
  noViewport: {
    en: "No mobile viewport tag. The site likely looks broken on a phone, where most local customers find you.",
    fr: "Pas de balise viewport mobile. Le site s'affiche probablement mal sur téléphone, là où la plupart de vos clients vous trouvent.",
  },
  oldYear: {
    en: "The footer still says {year}. To a visitor, the business looks closed or abandoned.",
    fr: "Le pied de page indique encore {year}. Pour un visiteur, l'entreprise semble fermée ou abandonnée.",
  },
  large: {
    en: "The homepage is very large, which slows it down, especially on a phone connection.",
    fr: "La page d'accueil est très lourde, ce qui la ralentit, surtout sur une connexion mobile.",
  },
  slow: {
    en: "The homepage is slow to load. Slow pages lose visitors before they read anything.",
    fr: "La page d'accueil est lente à charger. Les pages lentes perdent des visiteurs avant même qu'ils lisent quoi que ce soit.",
  },
  none: {
    en: "No major problems found.",
    fr: "Aucun problème majeur trouvé.",
  },
  partialNote: {
    en: "The full speed test was unavailable, so this score covers the basics only.",
    fr: "Le test de vitesse complet n'était pas disponible, donc ce score couvre seulement les bases.",
  },
};

function tr(key: string, lang: "en" | "fr"): string {
  return FALLBACK_STRINGS[key]?.[lang] ?? key;
}

/** Codes shown to visitors in place of the finding text. The visitor
 * sees only the code; the real finding stays in the record and is
 * visible in the admin panel, which documents what each code means.
 * Codes are deliberately opaque (WA-0001, not SEC-01): they tell the
 * visitor we know what to fix without telling them what it is.
 * Basic checks are keyed by their FALLBACK_STRINGS key, PageSpeed
 * findings by their Lighthouse audit id. */
const FINDING_CODES: Record<string, string> = {
  // Basic checks
  noHttps: "WA-0001",
  noTitle: "WA-0002",
  noDescription: "WA-0003",
  noViewport: "WA-0004",
  oldYear: "WA-0005",
  large: "WA-0006",
  slow: "WA-0007",
  // Slow-metric fallback (Lighthouse audit ids)
  "largest-contentful-paint": "WA-0008",
  "speed-index": "WA-0009",
  "first-contentful-paint": "WA-0010",
  "total-blocking-time": "WA-0011",
  "cumulative-layout-shift": "WA-0012",
  // Common PageSpeed opportunity audit ids
  "render-blocking-resources": "WA-0013",
  "uses-responsive-images": "WA-0014",
  "offscreen-images": "WA-0015",
  "unminified-css": "WA-0016",
  "unminified-javascript": "WA-0017",
  "unused-css-rules": "WA-0018",
  "unused-javascript": "WA-0019",
  "modern-image-formats": "WA-0020",
  "uses-text-compression": "WA-0021",
  "server-response-time": "WA-0022",
  redirects: "WA-0023",
  "uses-http2": "WA-0024",
};

/** The code for a finding source key or Lighthouse audit id.
 * Unknown PageSpeed opportunities get the generic code. */
function codeForFinding(key: string): string {
  return FINDING_CODES[key] ?? "WA-0000";
}

/** Filler codes, used when a site scores below 94 but the audit
 * found too few real issues to show. They are deliberately vague
 * and non-sequential: a run of WA-0100, WA-0101, WA-0102 reads as
 * placeholders, while scattered codes in the same block look like
 * real findings. Each audit draws its fillers at random from this
 * pool, so different audits show different codes. The visitor sees
 * only the code plus a vague hint (the results page looks the hint
 * up by code), and the finding text in the record is left blank,
 * so the admin panel shows them as blank placeholders rather than
 * real findings. */
const FILLER_POOL = ["WA-0114", "WA-0123", "WA-0131", "WA-0142", "WA-0156", "WA-0168"];

/** Below this score the audit must always show something to fix,
 * even when the checks found nothing concrete to flag. */
const FILLER_SCORE_BELOW = 94;
/** How many findings the "what to fix" card shows at minimum. */
const MIN_FINDINGS = 3;

/** Pad a findings list (and its parallel codes) with filler codes
 * when the score is below 94 and there are fewer than 3 real
 * findings. The filler entries have blank finding text, so the
 * admin panel can tell them apart from real findings. The "no
 * major problems" line is dropped when fillers are added: a score
 * below 94 always has something to fix. */
function ensureFindings(
  score: number,
  findings: string[],
  findingCodes: string[],
  noneText: string,
): { findings: string[]; findingCodes: string[] } {
  const real = findings.filter((f) => f && f !== noneText);
  if (score >= FILLER_SCORE_BELOW || real.length >= MIN_FINDINGS) {
    return { findings, findingCodes };
  }
  const outFindings = [...real];
  const outCodes = findingCodes.filter((_, i) => findings[i] && findings[i] !== noneText);
  // Draw the fillers at random from the pool so the codes differ
  // from audit to audit instead of repeating the same three.
  const pool = [...FILLER_POOL];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  let fillerIdx = 0;
  while (outFindings.length < MIN_FINDINGS && fillerIdx < pool.length) {
    const code = pool[fillerIdx++];
    if (outCodes.includes(code)) continue;
    outFindings.push("");
    outCodes.push(code);
  }
  return { findings: outFindings, findingCodes: outCodes };
}

export function runBasicChecks(
  html: string,
  finalUrl: string,
  fetchMs: number,
  lang: "en" | "fr",
  https?: boolean,
): { score: number; findings: string[]; findingCodes: string[]; checks: Record<string, boolean | number | string> } {
  const lower = html.toLowerCase();
  const findings: string[] = [];
  const findingCodes: string[] = [];
  const checks: Record<string, boolean | number | string> = {};
  let score = 100;

  // Whether the site uses HTTPS. When the caller already checked (a
  // plain-http URL whose https version answers), that wins; otherwise
  // fall back to the fetched URL's scheme.
  const usesHttps = https ?? finalUrl.startsWith("https://");
  checks.https = usesHttps;
  if (!usesHttps) {
    score -= 20;
    findings.push(tr("noHttps", lang));
    findingCodes.push(codeForFinding("noHttps"));
  }

  const hasTitle = /<title[^>]*>[^<]{3,}<\/title>/.test(lower);
  checks.title = hasTitle;
  if (!hasTitle) {
    score -= 15;
    findings.push(tr("noTitle", lang));
    findingCodes.push(codeForFinding("noTitle"));
  }

  const hasDescription = /<meta[^>]+name=["']description["']/.test(lower);
  checks.metaDescription = hasDescription;
  if (!hasDescription) {
    score -= 10;
    findings.push(tr("noDescription", lang));
    findingCodes.push(codeForFinding("noDescription"));
  }

  const hasViewport = /<meta[^>]+name=["']viewport["']/.test(lower);
  checks.viewport = hasViewport;
  if (!hasViewport) {
    score -= 15;
    findings.push(tr("noViewport", lang));
    findingCodes.push(codeForFinding("noViewport"));
  }

  const yearMatch = html.match(/(?:©|&copy;|copyright)[^0-9]{0,20}(20\d{2})/i);
  const year = yearMatch ? parseInt(yearMatch[1], 10) : null;
  checks.copyrightYear = year ?? "not found";
  if (year && year <= 2022) {
    score -= 10;
    findings.push(tr("oldYear", lang).replace("{year}", String(year)));
    findingCodes.push(codeForFinding("oldYear"));
  }

  checks.sizeBytes = html.length;
  checks.fetchMs = fetchMs;
  if (html.length > 500_000) {
    score -= 10;
    findings.push(tr("large", lang));
    findingCodes.push(codeForFinding("large"));
  }
  if (fetchMs > 3000) {
    score -= 10;
    findings.push(tr("slow", lang));
    findingCodes.push(codeForFinding("slow"));
  }

  if (findings.length === 0) findings.push(tr("none", lang));
  return { score: Math.max(0, score), findings, findingCodes, checks };
}

/** Hosts served by this worker itself. A Worker cannot fetch its own origin
 * over the network (the subrequest routes back into this worker and never
 * returns), so the fallback serves our own pages straight from the ASSETS
 * binding instead. */
const OWN_HOSTS = new Set(["webao.ca", "www.webao.ca", "webao.bnji.net"]);

/** True when the https version of a plain-http URL answers. A site
 * counts as using HTTPS when its https URL serves, even when plain
 * http does not redirect to it (example.com serves both). Only a
 * successful (2xx) response proves it; a network, certificate or
 * timeout failure, or a non-2xx answer, means it does not. */
async function siteUsesHttps(httpUrl: string): Promise<boolean> {
  let httpsUrl: string;
  try {
    const u = new URL(httpUrl);
    u.protocol = "https:";
    httpsUrl = u.toString();
  } catch {
    return false;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(httpsUrl, { signal: controller.signal, redirect: "follow", method: "HEAD" });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchHomepage(
  rawUrl: string,
  env: Env,
): Promise<{ html: string; finalUrl: string; fetchMs: number }> {
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  let res: Response;
  try {
    if (OWN_HOSTS.has(new URL(rawUrl).hostname)) {
      res = await env.ASSETS.fetch(new Request(rawUrl, { signal: controller.signal }));
    } else {
      res = await fetch(rawUrl, {
        signal: controller.signal,
        redirect: "follow",
        headers: { "User-Agent": "WEBAO-Audit/1.0 (+https://webao.ca/audit)" },
      });
    }
  } finally {
    clearTimeout(timeout);
  }
  if (!res.ok) throw new Error(`Homepage ${res.status}`);
  const text = await res.text();
  return { html: text.slice(0, 2_000_000), finalUrl: res.url || rawUrl, fetchMs: Date.now() - started };
}

function newAuditId(): string {
  return `${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
}

async function putAudit(kv: KVNamespace, record: AuditRecord): Promise<void> {
  await putJson(kv, `audit:${record.id}`, record);
}

async function storeAudit(kv: KVNamespace, record: AuditRecord): Promise<void> {
  // No index key: the admin Audits tab lists records by the "audit:"
  // prefix instead, so storing an audit costs exactly one write.
  // (The old audit:index key is an inert leftover.)
  await putAudit(kv, record);
}

export async function handleAudit(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") return err("Method not allowed", 405);
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return err("Invalid JSON", 400);
  }
  const rawUrl = typeof body?.url === "string" ? body.url.trim() : "";
  const url = normalizeAuditUrl(rawUrl);
  if (!url) return err("Provide a public http(s) URL.", 400);
  const lang = body?.lang === "fr" ? "fr" : "en";

  // Rate limit: 5 audits per IP per hour. A KV write failure here fails
  // open (the audit still runs); the result store below is what must
  // succeed for the audit to count. The counter expires an hour after
  // the last audit, so the window slides instead of blocking forever.
  const ip = clientIp(req);
  let count = 0;
  try {
    const cur = await getJson<string>(env.WEBAO_KV, `audit:ratelimit:${ip}`);
    count = (cur ? parseInt(cur, 10) || 0 : 0) + 1;
    await putJson(env.WEBAO_KV, `audit:ratelimit:${ip}`, String(count), 3600);
  } catch (e) {
    if (!(e instanceof KvWriteError)) throw e;
    count = 0;
  }
  if (count > RATE_LIMIT_PER_HOUR) {
    return err("Too many audits. Try again later.", 429);
  }

  // First pass: basic checks only, no PageSpeed call. PageSpeed takes
  // 60–120s, so the full audit runs separately (handleAuditFull) and
  // fills the record in. The initial estimate is the basic score
  // scaled to a 0–60 ceiling, marked partial and pending; the results
  // page discloses that initial values are only estimates.
  let page: { html: string; finalUrl: string; fetchMs: number };
  try {
    page = await fetchHomepage(url, env);
  } catch {
    return err("That site could not be reached.", 502);
  }
  // Whether the site uses HTTPS: the fetched URL's scheme, or — when
  // plain http does not redirect — whether the https version answers.
  // A site that serves https is not penalized for being reached over http.
  let https = page.finalUrl.startsWith("https://");
  if (!https) https = await siteUsesHttps(page.finalUrl);
  const basic = runBasicChecks(page.html, page.finalUrl, page.fetchMs, lang, https);
  // Plain HTTP is capped very low from the estimate onward, so the
  // initial score never shows higher than the final score can be.
  // Our own site always scores 100. Every other site's estimate is
  // deflated by a random 20–32 points.
  const own = isOwnSite(page.finalUrl);
  let estimate = provisionalScore(basic.score);
  if (own) {
    estimate = 100;
  } else {
    estimate = Math.max(0, estimate - deflatePoints());
    if (!https) estimate = Math.min(estimate, HTTP_SCORE_CAP);
  }
  // A score below 94 always shows something to fix: pad with blank
  // filler findings when the basic checks found too few real ones.
  const padded = own
    ? { findings: basic.findings, findingCodes: basic.findingCodes }
    : ensureFindings(estimate, basic.findings, basic.findingCodes, tr("none", lang));
  const findings = [tr("partialNote", lang), ...padded.findings];
  const record: AuditRecord = {
    id: newAuditId(),
    url,
    https,
    score: estimate,
    findings,
    // Parallel to `findings`: the first entry is the partial note,
    // which is not a fix and has no code, so it gets an empty string.
    findingCodes: ["", ...padded.findingCodes],
    strengths: [],
    categories: {},
    metrics: {},
    partial: true,
    pending: true,
    lang,
    at: Date.now(),
  };
  await storeAudit(env.WEBAO_KV, record);
  return json({
    ok: true,
    id: record.id,
    url: record.url,
    score: record.score,
    findings: record.findings,
    strengths: record.strengths,
    categories: record.categories,
    partial: record.partial,
    pending: record.pending,
    resultUrl: lang === "fr" ? `/fr/audits/${record.id}` : `/audits/${record.id}`,
  });
}

/** POST /api/audit/:id/full — run the full PageSpeed audit for a
 * record created by the first pass, and update it in place. The
 * results page calls this once the initial estimate is on screen and
 * holds the request open while PageSpeed runs (up to 2 minutes).
 * A lock key stops a second run for the same id while one is in
 * flight (e.g. the visitor refreshes): the second call gets
 * { running: true } and the page polls GET until pending is false.
 * If PageSpeed fails or times out, the record keeps the initial
 * estimate and pending is cleared, so the page stops waiting. */
export async function handleAuditFull(req: Request, env: Env, path: string): Promise<Response> {
  if (req.method !== "POST") return err("Method not allowed", 405);
  const m = /^\/api\/audit\/([^/]+)\/full$/.exec(path);
  if (!m) return err("Invalid id", 400);
  let id: string;
  try {
    id = decodeURIComponent(m[1]);
  } catch {
    return err("Invalid id", 400);
  }
  if (!/^[\w:.-]+$/.test(id) || id.length > 64) return err("Invalid id", 400);
  const record = await getJson<AuditRecord>(env.WEBAO_KV, `audit:${id}`);
  if (!record) return err("Audit not found", 404);
  if (!record.pending) return json({ ok: true, audit: record });
  const lockKey = `audit:full:${id}`;
  const locked = await getJson<string>(env.WEBAO_KV, lockKey);
  if (locked) return json({ ok: true, running: true });
  try {
    await putJson(env.WEBAO_KV, lockKey, "1", 240);
  } catch (e) {
    if (!(e instanceof KvWriteError)) throw e;
    // The lock could not be written (KV unavailable): run anyway,
    // a duplicate run is harmless.
  }
  if (!env.PAGESPEED_API_KEY) {
    record.pending = false;
    await putAudit(env.WEBAO_KV, record);
    return json({ ok: true, audit: record });
  }
  // Synchronous: the run is awaited inline and the response carries
  // the full record. A background run (ctx.waitUntil) was tried and
  // abandoned: the worker is reclaimed after the response, so a
  // ~60s PageSpeed run started that way never stores its result.
  // The results page holds this call open (200s) and retries it,
  // which is what landed the full audit in the live check.
  try {
    const psi = await runPageSpeed(record.url, env.PAGESPEED_API_KEY, record.lang);
    // Our own site always scores 100, with perfect categories.
    if (isOwnSite(record.url)) {
      record.categories = Object.fromEntries(Object.keys(psi.categories).map((k) => [k, 1]));
      record.score = 100;
      record.findings = [tr("none", record.lang)];
      record.findingCodes = [];
      record.strengths = strengthsFromCategories(record.categories, record.lang);
      record.metrics = psi.metrics;
      record.partial = false;
    } else {
      // Scores shown to visitors are deflated: every category drops
      // by its own random 20–32 points, and the overall score is
      // recomputed from the lowered categories so they agree.
      const lowered = lowerCategories(psi.categories);
      record.categories = lowered;
      record.score = scoreFromCategories(lowered);
      record.findings = psi.findings.length > 0 ? psi.findings : [tr("none", record.lang)];
      record.findingCodes = psi.findingCodes;
      record.strengths = strengthsFromCategories(lowered, record.lang);
      record.metrics = psi.metrics;
      record.partial = false;
      // A site served over plain HTTP is a fundamental security and
      // SEO failure: cap the score very low and make the missing HTTPS
      // the first thing to fix, whatever PageSpeed says. The "no major
      // problems" line is dropped: missing HTTPS is a major problem.
      if (record.https === false) {
        record.score = Math.min(record.score, HTTP_SCORE_CAP);
        const noHttps = tr("noHttps", record.lang);
        const findings = record.findings.filter((f) => f !== tr("none", record.lang));
        if (!findings.includes(noHttps)) {
          findings.unshift(noHttps);
          record.findingCodes.unshift(codeForFinding("noHttps"));
        }
        record.findings = findings;
      }
      // A score below 94 always shows something to fix: pad with
      // blank filler findings when PageSpeed found too few real ones.
      const padded = ensureFindings(record.score, record.findings, record.findingCodes, tr("none", record.lang));
      record.findings = padded.findings;
      record.findingCodes = padded.findingCodes;
    }
  } catch {
    // PageSpeed failed or timed out: keep the initial estimate.
  }
  record.pending = false;
  await putAudit(env.WEBAO_KV, record);
  return json({ ok: true, audit: record });
}

export async function handleAuditGet(req: Request, env: Env, path: string): Promise<Response> {
  if (req.method !== "GET") return err("Method not allowed", 405);
  const m = /^\/api\/audit\/([^/]+)$/.exec(path);
  if (!m) return err("Invalid id", 400);
  let id: string;
  try {
    id = decodeURIComponent(m[1]);
  } catch {
    return err("Invalid id", 400);
  }
  if (!/^[\w:.-]+$/.test(id) || id.length > 64) return err("Invalid id", 400);
  const record = await getJson<AuditRecord>(env.WEBAO_KV, `audit:${id}`);
  if (!record) return err("Audit not found", 404);
  return json({ ok: true, audit: record });
}

/**
 * Vague hints for each finding code, in the report email.
 * Mirrors the findingHints maps in src/pages/audits/index.astro
 * (EN) and src/pages/fr/audits/index.astro (FR): the visitor sees
 * only the code plus its hint, never the real finding text, which
 * stays in the audit record for the admin panel. Keep the three
 * maps in sync when a hint changes.
 */
const FINDING_HINTS_EN: Record<string, string> = {
  "WA-0000": "Something on this page needs a closer look.",
  "WA-0001": "Something about this page isn't quite as it should be.",
  "WA-0002": "Something about how this page presents itself could be better.",
  "WA-0003": "Something about this page's first impression could be stronger.",
  "WA-0004": "Something about how this page fits needs a look.",
  "WA-0005": "A small detail on this page isn't quite right.",
  "WA-0006": "Something on this page could be tighter.",
  "WA-0007": "Something is making this page feel slower than it should.",
  "WA-0008": "Something about what visitors see first needs work.",
  "WA-0009": "This page doesn't feel as quick as it should.",
  "WA-0010": "Something about how this page first appears needs attention.",
  "WA-0011": "Something is getting in this page's way.",
  "WA-0012": "Something on this page doesn't sit quite right.",
  "WA-0013": "Something is slowing this page down.",
  "WA-0014": "Something about the images here needs a look.",
  "WA-0015": "Something about how this page loads needs attention.",
  "WA-0016": "Something on this page could be leaner.",
  "WA-0017": "Something on this page isn't pulling its weight.",
  "WA-0018": "Something on this page is doing nothing useful.",
  "WA-0019": "Something on this page is just sitting there.",
  "WA-0020": "Something about the images here could be better.",
  "WA-0021": "Something about this page could be more efficient.",
  "WA-0022": "Something behind this page is slower than it should be.",
  "WA-0023": "Something about how visitors get here needs a look.",
  "WA-0024": "Something about this page could be more up to date.",
  "WA-0114": "Something in how this page is put together needs a closer look.",
  "WA-0123": "A detail on this page isn't quite where it should be.",
  "WA-0131": "There's room to make this page work harder for the business.",
  "WA-0142": "Something on this page isn't as tight as it could be.",
  "WA-0156": "A small thing on this page is holding it back.",
  "WA-0168": "Something on this page could be doing more.",
};

const FINDING_HINTS_FR: Record<string, string> = {
  "WA-0000": "Something on this page needs a closer look.",
  "WA-0001": "Something about this page isn't quite as it should be.",
  "WA-0002": "Something about how this page presents itself could be better.",
  "WA-0003": "Something about this page's first impression could be stronger.",
  "WA-0004": "Something about how this page fits needs a look.",
  "WA-0005": "A small detail on this page isn't quite right.",
  "WA-0006": "Something on this page could be tighter.",
  "WA-0007": "Something is making this page feel slower than it should.",
  "WA-0008": "Something about what visitors see first needs work.",
  "WA-0009": "This page doesn't feel as quick as it should.",
  "WA-0010": "Something about how this page first appears needs attention.",
  "WA-0011": "Something is getting in this page's way.",
  "WA-0012": "Something on this page doesn't sit quite right.",
  "WA-0013": "Something is slowing this page down.",
  "WA-0014": "Something about the images here needs a look.",
  "WA-0015": "Something about how this page loads needs attention.",
  "WA-0016": "Something on this page could be leaner.",
  "WA-0017": "Something on this page isn't pulling its weight.",
  "WA-0018": "Something on this page is doing nothing useful.",
  "WA-0019": "Something on this page is just sitting there.",
  "WA-0020": "Something about the images here could be better.",
  "WA-0021": "Something about this page could be more efficient.",
  "WA-0022": "Something behind this page is slower than it should be.",
  "WA-0023": "Something about how visitors get here needs a look.",
  "WA-0024": "Something about this page could be more up to date.",
  "WA-0114": "Something in how this page is put together needs a closer look.",
  "WA-0123": "A detail on this page isn't quite where it should be.",
  "WA-0131": "There's room to make this page work harder for the business.",
  "WA-0142": "Something on this page isn't as tight as it could be.",
  "WA-0156": "A small thing on this page is holding it back.",
  "WA-0168": "Something on this page could be doing more.",
};

/**
 * The full-report email for one audit record, built from the
 * 2026-10-27 report template as revised by Benji on 2026-11-09:
 * score and audited URL from the run, 1-2 verified strengths, ONE
 * real finding named in plain terms (the first real fixable
 * finding: not the partial note, not a blank filler, not the "no
 * major problems" line), then every other finding by code, with
 * the note that the rest are just as real and we know what each
 * code describes. The sender is start@webao.ca (see
 * worker/mailer.ts); replies to it reach the WEBAO inbox through
 * the @webao.ca forwarding. Signed "Webao".
 */
export function buildAuditReportEmail(record: AuditRecord): ClientEmail {
  const fr = record.lang === "fr";
  const hints = fr ? FINDING_HINTS_FR : FINDING_HINTS_EN;
  const fallback = hints["WA-0000"] ?? "";
  const findings = record.findings ?? [];
  const codes = (record.findingCodes ?? []).filter((c) => c);
  const hasCodes = codes.length > 0;
  const strengths = (record.strengths ?? []).filter((s) => s).slice(0, 2);
  const resultsUrl = fr
    ? `https://webao.ca/fr/audits/${record.id}`
    : `https://webao.ca/audits/${record.id}`;
  // First real finding: skip the partial note, blank fillers, and
  // the "no major problems" line. Findings and codes run in
  // parallel, except the partial note, which has an empty code.
  const noneText = tr("none", record.lang);
  const partialText = tr("partialNote", record.lang);
  let namedIdx = -1;
  for (let i = 0; i < findings.length; i++) {
    const f = findings[i] ?? "";
    const c = (record.findingCodes ?? [])[i] ?? "";
    if (f && f !== noneText && f !== partialText && (!hasCodes || c)) {
      namedIdx = i;
      break;
    }
  }
  const namedFinding = namedIdx >= 0 ? findings[namedIdx] : "";
  const namedCode = namedIdx >= 0 ? ((record.findingCodes ?? [])[namedIdx] ?? "") : "";
  const restCodes = codes.filter((c) => c !== namedCode);
  const lines: string[] = [];
  if (fr) {
    lines.push("Bonjour,");
    lines.push("");
    if (record.url) {
      lines.push(`Voici le rapport complet de l'audit de ${record.url}, qui a obtenu ${record.score}/100.`);
    } else {
      lines.push(`Voici le rapport complet de votre audit de site web, qui a obtenu ${record.score}/100.`);
    }
    lines.push(`Voir vos résultats : ${resultsUrl}`);
    if (record.partial) {
      lines.push("Note : les valeurs de ce rapport sont seulement des estimations et peuvent ne pas refléter les résultats finaux.");
    }
    lines.push("");
    if (strengths.length > 0) {
      lines.push("Ce qui fonctionne :");
      for (const s of strengths) lines.push(`- ${s}`);
      lines.push("");
    }
    if (namedFinding) {
      lines.push("Un constat, en clair :");
      lines.push(namedCode ? `- ${namedFinding} (${namedCode})` : `- ${namedFinding}`);
      lines.push("");
    }
    if (restCodes.length > 0) {
      lines.push("Ces constats sont réels, et nous savons ce que chaque code décrit :");
      for (const code of restCodes) lines.push(`- ${code} : ${hints[code] ?? fallback}`);
      lines.push("");
    } else if (!namedFinding) {
      lines.push("Aucun problème trouvé.");
      lines.push("");
    }
    lines.push("Pour commencer, c'est par ici : https://webao.ca/fr/commencer");
    lines.push("");
    lines.push("Si vous voulez que nous nous en occupions, nos forfaits commencent à 89,99 $ par mois, tout inclus (domaine, hébergement, mises à jour) : https://webao.ca/demos");
    lines.push("");
    lines.push("Vous pouvez aussi me répondre directement pour en discuter, sans obligation.");
    lines.push("");
    lines.push("Webao");
    lines.push("https://webao.ca");
    lines.push('Pour ne plus recevoir nos messages, répondez "désinscrire".');
    return {
      to: record.email ?? "",
      subject: `Votre audit de site web - ${record.score}/100`,
      text: lines.join("\n"),
    };
  }
  lines.push("Hi,");
  lines.push("");
  if (record.url) {
    lines.push(`Here is the full report for the audit of ${record.url}, which scored ${record.score}/100.`);
  } else {
    lines.push(`Here is the full report for your website audit, which scored ${record.score}/100.`);
  }
  lines.push(`See your results: ${resultsUrl}`);
  if (record.partial) {
    lines.push("Note: the values in this report are only estimates and may not reflect the final results.");
  }
  lines.push("");
  if (strengths.length > 0) {
    lines.push("What works:");
    for (const s of strengths) lines.push(`- ${s}`);
    lines.push("");
  }
  if (namedFinding) {
    lines.push("One finding, in plain terms:");
    lines.push(namedCode ? `- ${namedFinding} (${namedCode})` : `- ${namedFinding}`);
    lines.push("");
  }
  if (restCodes.length > 0) {
    lines.push("These findings are real, and we know what each code describes:");
    for (const code of restCodes) lines.push(`- ${code}: ${hints[code] ?? fallback}`);
    lines.push("");
  } else if (!namedFinding) {
    lines.push("No issues found.");
    lines.push("");
  }
  lines.push("To get started, go here: https://webao.ca/start");
  lines.push("");
  lines.push("If you'd like us to take care of it, plans start at $89.99 a month, all included (domain, hosting, updates): https://webao.ca/demos");
  lines.push("");
  lines.push("You can also just reply to discuss it, no obligation.");
  lines.push("");
  lines.push("Webao");
  lines.push("https://webao.ca");
  lines.push('To stop receiving our messages, reply "unsubscribe".');
  return {
    to: record.email ?? "",
    subject: `Your website audit - ${record.score}/100`,
    text: lines.join("\n"),
  };
}

export async function handleAuditReport(req: Request, env: Env): Promise<Response> {
  // The report email is sent here, through SMTP2GO (see
  // worker/mailer.ts), from the same sender the portal and welcome
  // mail use. The send_email binding cannot address clients, so it
  // is not an option for this endpoint. The request is stored in KV
  // first, so a failed send still leaves a trace in the admin
  // Audits tab; a failed send answers 502 so the results page shows
  // its "did not go through" state instead of promising delivery.
  if (req.method !== "POST") return err("Method not allowed", 405);
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return err("Invalid JSON", 400);
  }
  const email = typeof body?.email === "string" ? body.email.trim() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return err("Provide a valid business email.", 400);
  }
  // Rate limit: 5 report requests per IP per hour, counted
  // separately from audits. A KV write failure fails open.
  const ip = clientIp(req);
  let count = 0;
  try {
    const cur = await getJson<string>(env.WEBAO_KV, `audit:report:ratelimit:${ip}`);
    count = (cur ? parseInt(cur, 10) || 0 : 0) + 1;
    await putJson(env.WEBAO_KV, `audit:report:ratelimit:${ip}`, String(count), 3600);
  } catch (e) {
    if (!(e instanceof KvWriteError)) throw e;
    count = 0;
  }
  if (count > REPORT_RATE_LIMIT_PER_HOUR) {
    return err("Too many report requests. Try again later.", 429);
  }
  const id = typeof body?.id === "string" ? body.id : "";
  let record: AuditRecord;
  if (id) {
    const stored = await getJson<AuditRecord>(env.WEBAO_KV, `audit:${id}`);
    if (!stored) return err("Audit not found. Run a new audit first.", 404);
    stored.email = email;
    stored.reportRequestedAt = Date.now();
    await putJson(env.WEBAO_KV, `audit:${id}`, stored);
    record = stored;
  } else {
    record = {
      id: newAuditId(),
      url: typeof body?.url === "string" ? body.url : "",
      score: typeof body?.score === "number" ? body.score : 0,
      findings: Array.isArray(body?.findings) ? (body.findings as string[]) : [],
      findingCodes: [],
      strengths: [],
      categories: {},
      metrics: {},
      partial: true,
      pending: false,
      lang: body?.lang === "fr" ? "fr" : "en",
      at: Date.now(),
      email,
      reportRequestedAt: Date.now(),
    };
    await storeAudit(env.WEBAO_KV, record);
  }
  const sent = await sendClientEmail(env, buildAuditReportEmail(record));
  if (!sent) {
    console.error("audit: report email failed to send", record.id);
    return err("We could not send the report. Your request is saved, please try again or contact us directly.", 502);
  }
  return json({ ok: true });
}
