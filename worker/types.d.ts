// Minimal Cloudflare Workers ambient types (zero dependencies).
// Only the surface actually used by this worker is declared here.

interface KVNamespaceGetOptions {
  type?: "text" | "json" | "arrayBuffer" | "stream";
  cacheTtl?: number;
}

interface KVNamespacePutOptions {
  expirationTtl?: number;
  expiration?: number;
  metadata?: Record<string, unknown>;
}

interface KVNamespaceListOptions {
  prefix?: string;
  limit?: number;
  cursor?: string;
}

interface KVNamespaceListKey {
  name: string;
  expiration?: number;
  metadata?: unknown;
}

interface KVNamespaceListResult {
  keys: KVNamespaceListKey[];
  list_complete: boolean;
  cursor?: string;
}

interface KVNamespace {
  get(key: string): Promise<string | null>;
  get(key: string, options: { type: "text" }): Promise<string | null>;
  get<T = unknown>(key: string, options: { type: "json" }): Promise<T | null>;
  put(key: string, value: string | ArrayBuffer, options?: KVNamespacePutOptions): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: KVNamespaceListOptions): Promise<KVNamespaceListResult>;
}

/** Static-asset fetcher automatically bound when `assets` is configured. */
interface Fetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

/** Worker bindings (see wrangler.jsonc). */
interface Env {
  WEBAO_KV: KVNamespace;
  ASSETS: Fetcher;
}
