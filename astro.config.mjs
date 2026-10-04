import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";

// https://docs.astro.build/en/guides/deploy/cloudflare/
export default defineConfig({
  site: "https://webao.ca",
  output: "static",
  // Disable Astro sessions (we don't need KV for a static marketing site)
  session: false,
  adapter: cloudflare({
    imageService: "passthrough",
    platformProxy: {
      enabled: false,
    },
    // Use Node prerender instead of Workerd to avoid CF Request.cf fetch in CI
    // @ts-ignore: adapter supports this but types may lag
    prerenderEnvironment: "node",
  }),
  vite: {
    server: { host: "0.0.0.0", allowedHosts: true },
    preview: { host: "0.0.0.0" },
    ssr: {
      external: ["node:fs", "node:path", "node:url"],
    },
  },
  compressHTML: true,
  prefetch: {
    prefetchAll: true,
    defaultStrategy: "viewport",
  },
  experimental: {
    // enable client prerender for smoother transitions if needed
  },
});
