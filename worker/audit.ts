// WEBAO audit worker endpoint — free website audit (Channel E).
// Phase 1 scoring uses the PageSpeed Insights API (Lighthouse, run by
// Google) with env.PAGESPEED_API_KEY. If PageSpeed is unavailable or too
// slow, the audit falls back to the hand-rolled basic checks below and
// marks the result partial, so a visitor always gets an answer.
// Routes (see worker/ROUTE-PATCH.txt): POST /api/audit,
// GET /api/audit/:id, POST /api/audit/report. Results are stored in
// WEBAO_KV under audit:<ts>:<rand> with a newest-first audit:index
// (capped at 1000) for the admin Audits tab.

import { getJson, putJson, KvWriteError } from "./kv";
import { json, err, clientIp } from "./util";

const PSI_ENDPOINT = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";
const PSI_TIMEOUT_MS = 25_000;
const AUDIT_INDEX = "audit:index";
const MAX_INDEX = 1000;
const RATE_LIMIT_PER_HOUR = 5;

const CATEGORY_WEIGHTS: Record<string, number> = {
  performance: 0.5,
  accessibility: 0.2,
  "best-practices": 0.15,
  seo: 0.15,
};

export interface AuditRecord {
  id: string;
  url: string;
  score: number;
  findings: string[];
  strengths: string[];
  categories: Record<string, number>;
  partial: boolean;
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
): Promise<{ categories: Record<string, number>; findings: string[] }> {
  const endpoint =
    PSI_ENDPOINT +
    "?url=" + encodeURIComponent(target) +
    "&strategy=mobile" +
    "&category=performance&category=accessibility" +
    "&category=best-practices&category=seo" +
    "&locale=" + (lang === "fr" ? "fr" : "en") +
    "&key=" + encodeURIComponent(key);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PSI_TIMEOUT_MS);
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
  // Opportunity audits with a score of 1 are passing checks (e.g. a fast
  // server response) that still carry a displayValue — they are not
  // things to fix, so exclude them. A null score is kept: it means the
  // audit could not score itself, not that it passed.
  const perfRefs = Object.entries(audits).filter(
    ([, a]) => a.details?.type === "opportunity" && a.displayValue && a.score !== 1,
  );
  for (const [, a] of perfRefs.slice(0, 5)) {
    findings.push(
      a.displayValue ? `${a.title ?? ""} (${a.displayValue})`.trim() : (a.title ?? ""),
    );
  }
  return { categories, findings: findings.filter(Boolean) };
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
    en: "No major problems found in this quick check. The full report covers the details worth polishing next.",
    fr: "Aucun problème majeur dans ce contrôle rapide. Le rapport complet couvre les détails à peaufiner.",
  },
  partialNote: {
    en: "The full speed test was unavailable, so this score covers the basics only.",
    fr: "Le test de vitesse complet n'était pas disponible, donc ce score couvre seulement les bases.",
  },
};

function tr(key: string, lang: "en" | "fr"): string {
  return FALLBACK_STRINGS[key]?.[lang] ?? key;
}

export function runBasicChecks(
  html: string,
  finalUrl: string,
  fetchMs: number,
  lang: "en" | "fr",
): { score: number; findings: string[]; checks: Record<string, boolean | number | string> } {
  const lower = html.toLowerCase();
  const findings: string[] = [];
  const checks: Record<string, boolean | number | string> = {};
  let score = 100;

  const https = finalUrl.startsWith("https://");
  checks.https = https;
  if (!https) {
    score -= 20;
    findings.push(tr("noHttps", lang));
  }

  const hasTitle = /<title[^>]*>[^<]{3,}<\/title>/.test(lower);
  checks.title = hasTitle;
  if (!hasTitle) {
    score -= 15;
    findings.push(tr("noTitle", lang));
  }

  const hasDescription = /<meta[^>]+name=["']description["']/.test(lower);
  checks.metaDescription = hasDescription;
  if (!hasDescription) {
    score -= 10;
    findings.push(tr("noDescription", lang));
  }

  const hasViewport = /<meta[^>]+name=["']viewport["']/.test(lower);
  checks.viewport = hasViewport;
  if (!hasViewport) {
    score -= 15;
    findings.push(tr("noViewport", lang));
  }

  const yearMatch = html.match(/(?:©|&copy;|copyright)[^0-9]{0,20}(20\d{2})/i);
  const year = yearMatch ? parseInt(yearMatch[1], 10) : null;
  checks.copyrightYear = year ?? "not found";
  if (year && year <= 2022) {
    score -= 10;
    findings.push(tr("oldYear", lang).replace("{year}", String(year)));
  }

  checks.sizeBytes = html.length;
  checks.fetchMs = fetchMs;
  if (html.length > 500_000) {
    score -= 10;
    findings.push(tr("large", lang));
  }
  if (fetchMs > 3000) {
    score -= 10;
    findings.push(tr("slow", lang));
  }

  if (findings.length === 0) findings.push(tr("none", lang));
  return { score: Math.max(0, score), findings, checks };
}

/** Hosts served by this worker itself. A Worker cannot fetch its own origin
 * over the network (the subrequest routes back into this worker and never
 * returns), so the fallback serves our own pages straight from the ASSETS
 * binding instead. */
const OWN_HOSTS = new Set(["webao.ca", "www.webao.ca", "webao.bnji.net"]);

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

async function storeAudit(kv: KVNamespace, record: AuditRecord): Promise<void> {
  await putJson(kv, `audit:${record.id}`, record);
  const index = (await getJson<string[]>(kv, AUDIT_INDEX)) || [];
  index.unshift(`audit:${record.id}`);
  if (index.length > MAX_INDEX) index.splice(MAX_INDEX);
  await putJson(kv, AUDIT_INDEX, index);
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

  let score = 0;
  let findings: string[] = [];
  let strengths: string[] = [];
  let categories: Record<string, number> = {};
  let partial = false;

  if (env.PAGESPEED_API_KEY) {
    try {
      const psi = await runPageSpeed(url, env.PAGESPEED_API_KEY, lang);
      categories = psi.categories;
      score = scoreFromCategories(categories);
      findings = psi.findings;
      strengths = strengthsFromCategories(categories, lang);
      if (findings.length === 0) {
        findings.push(tr("none", lang));
      }
    } catch {
      partial = true;
      findings = [];
    }
  } else {
    partial = true;
  }

  if (partial) {
    try {
      const page = await fetchHomepage(url, env);
      const basic = runBasicChecks(page.html, page.finalUrl, page.fetchMs, lang);
      score = basic.score;
      findings = basic.findings;
      categories = {};
    } catch {
      return err("That site could not be reached.", 502);
    }
    findings.unshift(tr("partialNote", lang));
  }

  const record: AuditRecord = {
    id: newAuditId(),
    url,
    score,
    findings,
    strengths,
    categories,
    partial,
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
    resultUrl: lang === "fr" ? `/fr/audits/${record.id}` : `/audits/${record.id}`,
  });
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

export async function handleAuditReport(req: Request, env: Env): Promise<Response> {
  // Phase 1: store the report request in KV for the admin / lead jobs to
  // send from contact@webao.ca using the approved report template.
  // The worker does NOT send email, deliberately, so no mailer
  // credentials are added here.
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
  const id = typeof body?.id === "string" ? body.id : "";
  if (id) {
    const record = await getJson<AuditRecord>(env.WEBAO_KV, `audit:${id}`);
    if (!record) return err("Audit not found. Run a new audit first.", 404);
    record.email = email;
    record.reportRequestedAt = Date.now();
    await putJson(env.WEBAO_KV, `audit:${id}`, record);
  } else {
    const record: AuditRecord = {
      id: newAuditId(),
      url: typeof body?.url === "string" ? body.url : "",
      score: typeof body?.score === "number" ? body.score : 0,
      findings: Array.isArray(body?.findings) ? (body.findings as string[]) : [],
      strengths: [],
      categories: {},
      partial: true,
      lang: body?.lang === "fr" ? "fr" : "en",
      at: Date.now(),
      email,
      reportRequestedAt: Date.now(),
    };
    await storeAudit(env.WEBAO_KV, record);
  }
  return json({ ok: true });
}
