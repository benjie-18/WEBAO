// Admin auth: password hashing, timing-safe compare, token issue/verify,
// KV-backed rate limiting, and site settings storage.

import { getJson, putJson, listAllKeys, deleteKey, KvWriteError } from "./kv";
import { sha256Hex, timingSafeEqual, randomHex, dayKey, err } from "./util";

export const AUTH_KEY = "config:auth";
export const SETTINGS_KEY = "config:settings";
const TOKEN_PREFIX = "admin:token:";
const TOKEN_TTL = 7 * 24 * 3600; // 7 days, in seconds

/**
 * Prefix for day-bound stateless fallback tokens (see issueToken). Format:
 * "fb1.<yyyy-mm-dd>.<hmac-hex>". Accepted by requireAdmin alongside KV tokens.
 */
const FALLBACK_PREFIX = "fb1";

export interface Settings {
  defaultTheme: "system" | "light" | "dark";
  trackingEnabled: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  defaultTheme: "system",
  trackingEnabled: true,
};

/**
 * SHA-256 hex of the default admin password.
 * Seeded lazily into KV on first use so a fresh namespace works out of the box.
 * The default password is documented in DEPLOY.md (change it immediately).
 */
export const DEFAULT_PASSWORD_HASH =
  "26cc435143c4926972d65ef8b6c331961613270cf4801a2ede45048e8d9a0012";

/** Fetch the stored password hash, seeding the default on a fresh namespace. */
export async function getPasswordHash(kv: KVNamespace): Promise<string> {
  const rec = await getJson<{ passwordHash?: string }>(kv, AUTH_KEY);
  if (rec?.passwordHash) return rec.passwordHash;
  await putJson(kv, AUTH_KEY, { passwordHash: DEFAULT_PASSWORD_HASH });
  return DEFAULT_PASSWORD_HASH;
}

export async function setPasswordHash(kv: KVNamespace, hash: string): Promise<void> {
  await putJson(kv, AUTH_KEY, { passwordHash: hash });
}

export async function verifyPassword(kv: KVNamespace, password: unknown): Promise<boolean> {
  if (typeof password !== "string" || password.length === 0 || password.length > 256) return false;
  const [stored, given] = await Promise.all([getPasswordHash(kv), sha256Hex(password)]);
  return timingSafeEqual(stored, given);
}

/**
 * Fixed-window throttle backed by KV. Returns true when the request is allowed.
 * (Read-modify-write races are acceptable at this scale; worst case a couple of
 * extra requests slip through a window boundary.)
 */
export async function throttle(
  kv: KVNamespace,
  scope: string,
  ip: string,
  limit: number,
  windowMs = 60_000,
): Promise<boolean> {
  const key = `rl:${scope}:${ip}`;
  const now = Date.now();
  try {
    const rec = await getJson<{ c: number; r: number }>(kv, key);
    if (rec && rec.r > now) {
      if (rec.c >= limit) return false;
      await putJson(kv, key, { c: rec.c + 1, r: rec.r }, Math.ceil((rec.r - now) / 1000) + 1);
      return true;
    }
    await putJson(kv, key, { c: 1, r: now + windowMs }, Math.ceil(windowMs / 1000) + 1);
    return true;
  } catch (e) {
    if (e instanceof KvWriteError) {
      // Storage is down (e.g. the daily KV write quota is exhausted). Rate
      // limiting is a secondary defense: fail open so the outage degrades
      // protection instead of taking every route down with a 500.
      console.error("throttle: KV write failed, failing open", key);
      return true;
    }
    throw e;
  }
}

/**
 * Day-bound stateless fallback token, issued only when the token cannot be
 * persisted to KV (e.g. the daily write quota is exhausted). This is what
 * keeps a correct password working during a KV write outage: the token is
 * HMAC-SHA256 over (prefix, password hash, UTC day) keyed by the stored
 * password hash itself, which never leaves the server, so it cannot be
 * forged. It expires at the end of the UTC day, and changing the password
 * invalidates outstanding fallback tokens.
 */
async function fallbackToken(passwordHash: string): Promise<string> {
  const day = dayKey();
  const msg = `${FALLBACK_PREFIX}:${passwordHash}:${day}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passwordHash),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${FALLBACK_PREFIX}.${day}.${hex}`;
}

async function verifyFallbackToken(token: string, kv: KVNamespace): Promise<boolean> {
  const m = /^fb1\.(\d{4}-\d{2}-\d{2})\.([a-f0-9]{64})$/.exec(token);
  if (!m || m[1] !== dayKey()) return false;
  const expected = await fallbackToken(await getPasswordHash(kv));
  return timingSafeEqual(expected, token);
}

/** Issue a 256-bit bearer token with a 7-day TTL. */
export async function issueToken(kv: KVNamespace, ip: string): Promise<string> {
  const token = randomHex(32);
  try {
    await putJson(kv, TOKEN_PREFIX + token, { createdAt: Date.now(), ip }, TOKEN_TTL);
  } catch (e) {
    if (e instanceof KvWriteError) {
      // Can't persist the session (write quota exhausted, ...): hand out a
      // day-bound stateless token instead so login still succeeds.
      console.error("issueToken: KV write failed, issuing fallback token");
      return fallbackToken(await getPasswordHash(kv));
    }
    throw e;
  }
  return token;
}

const BEARER_RE = /^Bearer ([A-Za-z0-9._-]{1,128})$/;
const KV_TOKEN_RE = /^[a-f0-9]{64}$/;

/**
 * Validate `Authorization: Bearer <token>`.
 * Returns a 401 Response when invalid, or null when the request is authorized.
 */
export async function requireAdmin(req: Request, kv: KVNamespace): Promise<Response | null> {
  const h = req.headers.get("Authorization") || "";
  const m = BEARER_RE.exec(h.trim());
  if (!m) return err("Unauthorized", 401);
  const token = m[1];
  if (token.startsWith(FALLBACK_PREFIX + ".")) {
    if (await verifyFallbackToken(token, kv)) return null;
    return err("Unauthorized", 401);
  }
  if (!KV_TOKEN_RE.test(token)) return err("Unauthorized", 401);
  const rec = await getJson(kv, TOKEN_PREFIX + token);
  if (!rec) return err("Unauthorized", 401);
  return null;
}

/** Extract the raw token string from the Authorization header (or null). */
export function currentToken(req: Request): string | null {
  const h = req.headers.get("Authorization") || "";
  const m = BEARER_RE.exec(h.trim());
  return m ? m[1] : null;
}

/** Revoke every admin token except the one currently in use. */
export async function revokeOtherTokens(kv: KVNamespace, keep: string | null): Promise<void> {
  const keys = await listAllKeys(kv, TOKEN_PREFIX, 5000);
  for (const k of keys) {
    if (keep && k === TOKEN_PREFIX + keep) continue;
    try {
      await deleteKey(kv, k);
    } catch {
      /* best effort */
    }
  }
}

export async function getSettings(kv: KVNamespace): Promise<Settings> {
  const s = await getJson<Partial<Settings>>(kv, SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(s || {}) };
}
