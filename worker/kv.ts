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
