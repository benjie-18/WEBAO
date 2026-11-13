// Shared helpers: JSON responses, hashing, origin checks, UA parsing, KV batching.

/** Hosts allowed to call the same-origin JSON API. */
export const ALLOWED_HOSTS = new Set([
  "webao.ca",
  "www.webao.ca",
  "test.webao.ca",
  "webao.bnji.net",
  "localhost",
  "127.0.0.1",
]);

/** True on the test worker (test.webao.ca): all external effects off. */
export function isTestMode(env: { TEST_MODE?: string }): boolean {
  return env.TEST_MODE === "1";
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

export function err(message: string, status = 400): Response {
  return json({ ok: false, error: message }, status);
}

/** Client IP from Cloudflare — never trust X-Forwarded-For here. */
export function clientIp(req: Request): string {
  return req.headers.get("CF-Connecting-IP")?.trim() || "unknown";
}

export function clientCountry(req: Request): string {
  const h = req.headers.get("cf-ipcountry")?.trim();
  if (h) return h.toUpperCase();
  const cf = (req as unknown as { cf?: { country?: string } }).cf;
  return (cf?.country || "XX").toUpperCase();
}

export function clientCity(req: Request): string | undefined {
  const cf = (req as unknown as { cf?: { city?: string } }).cf;
  return cf?.city || undefined;
}

/** Extra hosts allowed to call the API, from the ALLOWED_ORIGINS binding. */
export interface OriginEnv {
  /** Comma-separated hostnames; `*.example.com` matches any subdomain. */
  ALLOWED_ORIGINS?: string;
}

function extraAllowedHosts(env?: OriginEnv): string[] {
  return (env?.ALLOWED_ORIGINS || "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
}

function hostMatches(host: string, pattern: string): boolean {
  if (pattern.startsWith("*.")) return host.endsWith(pattern.slice(1));
  return host === pattern;
}

/**
 * Same-origin gate for the JSON API.
 * When requireOrigin is true, at least one of Origin/Referer must be present
 * and match an allowed host. When false, missing headers are tolerated
 * (used for Bearer-authed GETs, where the token itself is the auth).
 *
 * `ALLOWED_ORIGINS` adds hosts for local/preview environments (set it in
 * `.dev.vars`; unset in production).
 */
export function originAllowed(req: Request, requireOrigin: boolean, env?: OriginEnv): boolean {
  const origin = req.headers.get("Origin");
  const referer = req.headers.get("Referer");
  const candidate = origin || referer;
  if (!candidate) return !requireOrigin;
  try {
    const host = new URL(candidate).hostname.toLowerCase();
    if (ALLOWED_HOSTS.has(host)) return true;
    return extraAllowedHosts(env).some((pattern) => hostMatches(host, pattern));
  } catch {
    return false;
  }
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time comparison for fixed-length hex hashes. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function uuid(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return randomHex(16);
}

/** "yyyy-mm-dd" in UTC. */
export function dayKey(ts = Date.now()): string {
  return new Date(ts).toISOString().slice(0, 10);
}

export function addDays(base: string, delta: number): string {
  const d = new Date(base + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

export interface DeviceInfo {
  device: "mobile" | "tablet" | "desktop";
  browser: string;
}

export function parseUserAgent(ua: string): DeviceInfo {
  const u = ua.toLowerCase();
  const device =
    /tablet|ipad|playbook|silk(?!.+mobile)/.test(u)
      ? "tablet"
      : /mobile|android|iphone|ipod|blackberry|iemobile|opera mini/.test(u)
        ? "mobile"
        : "desktop";
  let browser = "other";
  if (/edg\//.test(u)) browser = "edge";
  else if (/opr\/|opera/.test(u)) browser = "opera";
  else if (/firefox|fxios/.test(u)) browser = "firefox";
  else if (/crios|chrome/.test(u)) browser = "chrome";
  else if (/safari/.test(u)) browser = "safari";
  return { device, browser };
}

/** Normalize a page path for safe use inside KV keys. Returns null if invalid. */
export function sanitizePath(path: unknown): string | null {
  if (typeof path !== "string") return null;
  let p = path.split("?")[0].split("#")[0].trim();
  if (!p.startsWith("/")) return null;
  if (p.length > 160) p = p.slice(0, 160);
  p = p.toLowerCase().replace(/[^a-z0-9/_.\-]/g, "_");
  return p || "/";
}

export function clampStr(v: unknown, max: number): string {
  return typeof v === "string" ? v.slice(0, max) : "";
}

/** Shared email shape check (same pattern that lived in five worker files). */
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Strict "yyyy-mm" month key: shape AND a real month (1-12). The bare
 * /^\d{4}-\d{2}$/ regex accepted 2026-13, which produced phantom report
 * keys and an "undefined 2026" label.
 */
export function isMonthKey(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const m = /^(\d{4})-(\d{2})$/.exec(value);
  if (!m) return false;
  const mm = parseInt(m[2], 10);
  return mm >= 1 && mm <= 12;
}

export async function readJson(req: Request, maxBytes = 64 * 1024): Promise<unknown> {
  const ct = req.headers.get("content-type") || "";
  if (!ct.includes("application/json")) throw new Error("Expected application/json");
  const text = await req.text();
  if (text.length > maxBytes) throw new Error("Body too large");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Invalid JSON");
  }
}

/** Run async tasks in bounded-concurrency chunks. */
export async function batch<T, R>(
  items: T[],
  size: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    const chunk = items.slice(i, i + size);
    const res = await Promise.all(chunk.map((t, j) => fn(t, i + j)));
    out.push(...res);
  }
  return out;
}
