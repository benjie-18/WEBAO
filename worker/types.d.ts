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
  get(key: string, type: "arrayBuffer"): Promise<ArrayBuffer | null>;
  get(key: string, options: { type: "text" }): Promise<string | null>;
  get<T = unknown>(key: string, options: { type: "json" }): Promise<T | null>;
  put(key: string, value: string | ArrayBuffer, options?: KVNamespacePutOptions): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: KVNamespaceListOptions): Promise<KVNamespaceListResult>;
}

/** Static-asset fetcher bound explicitly by `assets.binding`. */
interface Fetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

/** send_email binding (destination pinned in wrangler.jsonc). */
interface SendEmailBinding {
  send(message: import("cloudflare:email").EmailMessage): Promise<{ messageId: string }>;
}

declare module "cloudflare:email" {
  export class EmailMessage {
    constructor(from: string, to: string, raw: string);
  }
}

/** Worker bindings (see wrangler.jsonc). */
interface Env {
  WEBAO_KV: KVNamespace;
  ASSETS: Fetcher;
  EMAIL?: SendEmailBinding;
  /** Optional shared key for the lead-tracking ingest endpoints (secret). */
  LEADS_INGEST_KEY?: string;
  /** Stripe webhook signing secret (secret; endpoint 503s until set). */
  STRIPE_WEBHOOK_SECRET?: string;
}
