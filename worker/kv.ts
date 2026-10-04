// Thin KV helpers: JSON get/put, numeric counters, full-prefix key listing.

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
  await kv.put(key, JSON.stringify(value), expirationTtl ? { expirationTtl } : undefined);
}

/** Increment a numeric counter stored as plain text. Returns the new value. */
export async function incrCounter(kv: KVNamespace, key: string): Promise<number> {
  const cur = await kv.get(key);
  const next = (cur ? parseInt(cur, 10) || 0 : 0) + 1;
  await kv.put(key, String(next));
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
