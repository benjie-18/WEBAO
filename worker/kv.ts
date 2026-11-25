// Thin KV helpers: JSON get/put, numeric counters, full-prefix key listing.

/**
 * Thrown when a KV *write* fails — e.g. the account hit its daily write
 * quota, or KV is briefly unreachable. Reads already degrade to null (see
 * getJson); writes surface this typed error so routes can degrade gracefully
 * (honest 503, fail-open rate limiting) instead of 500ing.
 */
export class KvWriteError extends Error {
  constructor(public readonly cause?: unknown) {
    super("KV write failed");
    this.name = "KvWriteError";
  }
}

export async function getJson<T>(kv: KVNamespace, key: string): Promise<T | null> {
  try {
    return await kv.get<T>(key, { type: "json" });
  } catch {
    return null;
  }
}

/**
 * Strict twin of getJson: null only when the key is genuinely absent.
 * A read failure (KV outage) throws instead of masquerading as "not
 * found" — callers that must not act on a false absence (webhook dedupe
 * and client resolution) use this so a failed read retries via Stripe
 * instead of creating a duplicate record.
 */
export async function getJsonStrict<T>(kv: KVNamespace, key: string): Promise<T | null> {
  return kv.get<T>(key, { type: "json" });
}

export async function putJson(
  kv: KVNamespace,
  key: string,
  value: unknown,
  expirationTtl?: number,
): Promise<void> {
  try {
    await kv.put(key, JSON.stringify(value), expirationTtl ? { expirationTtl } : undefined);
  } catch (e) {
    throw new KvWriteError(e);
  }
}

/**
 * Put JSON, retrying once after a short pause when the first write fails.
 * KV writes from a Worker fail intermittently even while the namespace is
 * healthy (observed 2026-11-25: 9 of 10 lead-reply writes 503d while direct
 * Cloudflare API writes to the same namespace succeeded). One retry turns
 * a transient blip into a success; a second failure still surfaces as
 * KvWriteError, so the caller can answer honestly instead of pretending
 * the write landed. Callers that retry must be idempotent (see the reply
 * dedupe in leads.ts) so a write that landed but reported failure is safe.
 */
export async function putJsonWithRetry(
  kv: KVNamespace,
  key: string,
  value: unknown,
  expirationTtl?: number,
): Promise<void> {
  try {
    await putJson(kv, key, value, expirationTtl);
  } catch (e) {
    if (!(e instanceof KvWriteError)) throw e;
    await new Promise((resolve) => setTimeout(resolve, 300));
    await putJson(kv, key, value, expirationTtl);
  }
}

/** Delete a key, surfacing write failures as KvWriteError. */
export async function deleteKey(kv: KVNamespace, key: string): Promise<void> {
  try {
    await kv.delete(key);
  } catch (e) {
    throw new KvWriteError(e);
  }
}

/** Increment a numeric counter stored as plain text. Returns the new value. */
export async function incrCounter(kv: KVNamespace, key: string): Promise<number> {
  const cur = await kv.get(key);
  const next = (cur ? parseInt(cur, 10) || 0 : 0) + 1;
  try {
    await kv.put(key, String(next));
  } catch (e) {
    throw new KvWriteError(e);
  }
  return next;
}

/**
 * List ALL key names under a prefix, following KV pagination cursors.
 * Guarded by maxKeys so a stats call can never loop forever.
 */
export async function listAllKeys(
  kv: KVNamespace,
  prefix: string,
  maxKeys = 20000,
): Promise<string[]> {
  const names: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const res = await kv.list({ prefix, cursor, limit: 1000 });
    for (const k of res.keys) names.push(k.name);
    if (names.length >= maxKeys || res.list_complete) break;
    cursor = res.cursor;
    if (!cursor) break;
  }
  return names.slice(0, maxKeys);
}
