// Shared test doubles for the Worker API tests.
// Not a test file itself (the runner only picks up tests/*.test.ts).

export interface MemoryKV {
  /** Structural KVNamespace stand-in (loose types keep the tests readable). */
  kv: any;
  /** Raw string store, for asserting what a handler persisted. */
  store: Map<string, string>;
  /** Keys written / deleted, in order. */
  puts: string[];
  deletes: string[];
  /** expirationTtl seen for each put, keyed by KV key. */
  ttls: Map<string, number | undefined>;
  /** When true, every write throws (simulates the daily KV write quota). */
  failWrites: (fail: boolean) => void;
  /** When set, kv.list throws it (simulates a storage outage on reads). */
  failList: (error: Error | null) => void;
}

export function memoryKV(seed: Record<string, unknown> = {}): MemoryKV {
  const store = new Map<string, string>();
  const ttls = new Map<string, number | undefined>();
  const puts: string[] = [];
  const deletes: string[] = [];
  let failWrites = false;
  let listError: Error | null = null;

  for (const [key, value] of Object.entries(seed)) {
    store.set(key, typeof value === 'string' ? value : JSON.stringify(value));
  }

  const kv = {
    async get(key: string, options?: { type?: string } | string) {
      const raw = store.get(key);
      if (raw === undefined) return null;
      // Workers KV accepts both get(key, "json") and get(key, { type: "json" }).
      const type = typeof options === 'string' ? options : options?.type;
      if (type === 'json') return JSON.parse(raw);
      if (type === 'arrayBuffer') return new TextEncoder().encode(raw).buffer;
      return raw;
    },
    async put(key: string, value: string | ArrayBuffer, options?: { expirationTtl?: number }) {
      if (failWrites) throw new Error('KV write failed (test)');
      puts.push(key);
      store.set(key, typeof value === 'string' ? value : new TextDecoder().decode(value));
      ttls.set(key, options?.expirationTtl);
    },
    async delete(key: string) {
      if (failWrites) throw new Error('KV delete failed (test)');
      deletes.push(key);
      store.delete(key);
      ttls.delete(key);
    },
    async list(options?: { prefix?: string; limit?: number; cursor?: string }) {
      if (listError) throw listError;
      const prefix = options?.prefix ?? '';
      const names = [...store.keys()].filter((key) => key.startsWith(prefix)).sort();
      const start = options?.cursor ? Number(options.cursor) : 0;
      const limit = options?.limit ?? 1000;
      const slice = names.slice(start, start + limit);
      const next = start + slice.length;
      return {
        keys: slice.map((name) => ({ name })),
        list_complete: next >= names.length,
        cursor: next < names.length ? String(next) : undefined,
      };
    },
  };

  return {
    kv,
    store,
    puts,
    deletes,
    ttls,
    failWrites: (fail: boolean) => {
      failWrites = fail;
    },
    failList: (error: Error | null) => {
      listError = error;
    },
  };
}

/** `{ WEBAO_KV: kv, ...extra }`, cast to the worker's ambient Env type. */
export function envOf(kv: any, extra: Record<string, unknown> = {}): any {
  return { WEBAO_KV: kv, ...extra };
}

export interface RequestOptions {
  origin?: string | null;
  ip?: string;
  headers?: Record<string, string>;
  method?: string;
  url?: string;
  body?: BodyInit | null;
}

/** A JSON POST as the browser would send it, with sensible defaults. */
export function apiRequest(
  path: string,
  body: unknown,
  options: RequestOptions = {},
): Request {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'CF-Connecting-IP': options.ip ?? '203.0.113.9',
    ...options.headers,
  };
  if (options.origin !== null) headers.origin = options.origin ?? 'https://webao.ca';
  return new Request(`${options.url ?? 'https://webao.ca'}${path}`, {
    method: options.method ?? 'POST',
    headers,
    body: options.body !== undefined ? (options.body as BodyInit) : JSON.stringify(body),
  });
}

/** A GET with an optional Bearer token. */
export function apiGet(path: string, options: RequestOptions = {}): Request {
  const headers: Record<string, string> = {
    'CF-Connecting-IP': options.ip ?? '203.0.113.9',
    ...options.headers,
  };
  if (options.origin !== null) headers.origin = options.origin ?? 'https://webao.ca';
  return new Request(`${options.url ?? 'https://webao.ca'}${path}`, { headers });
}

/** The JSON body of a response, typed loosely for assertions. */
export async function bodyOf(response: Response): Promise<any> {
  return response.json();
}
