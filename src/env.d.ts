/// <reference types="astro/client" />
/// <reference types="@astrojs/cloudflare" />

type KVNamespace = import("@cloudflare/workers-types").KVNamespace;

type ENV = {
  // Add bindings here as needed, e.g. SESSION: KVNamespace
};

type Runtime = import("@astrojs/cloudflare").Runtime<ENV>;

declare namespace App {
  interface Locals extends Runtime {
    // Add locals here
  }
}
