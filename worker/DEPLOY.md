# WEBAO Worker — deploy checklist

The worker code (`worker/`) is written and type-checked locally. These steps need
to run once, with the user's approval (they create Cloudflare resources).

## 1. Create the KV namespace

```bash
cd ~/workspace/WEBAO
npx wrangler kv:namespace create WEBAO_KV
```

This prints something like:

```
{ "id": "abc123..." }
```

## 2. Paste the namespace ID into `wrangler.jsonc`

Replace the placeholder in the `kv_namespaces` block:

```jsonc
"kv_namespaces": [
  {
    "binding": "WEBAO_KV",
    "id": "abc123..."   // ← real id from step 1
  }
]
```

> The admin password hash (`config:auth`) is seeded automatically on first login —
> no manual step needed. Use the default password from your deploy notes (never
> commit it to the repo); change it immediately in the admin panel (Config tab)
> after the first login. If the default was ever exposed, rotate it now.

## 3. Build the site and deploy

```bash
npm run build          # Astro → dist/client (unchanged behavior)
npx wrangler deploy --config wrangler.jsonc    # uploads worker + static assets
```

`wrangler.jsonc` already points `main` at `worker/index.ts` and serves the static
site from `./dist/client` via `env.ASSETS`. Non-`/api/*` requests fall through to
the assets binding, so current site behavior is preserved exactly.

## 4. Smoke-test (after deploy)

```bash
# tracking (expect {"ok":true})
curl -s -X POST https://webao.ca/api/track/pageview \
  -H 'Content-Type: application/json' -H 'Origin: https://webao.ca' \
  -d '{"sid":"test-1234","path":"/"}'

# login (expect {"ok":true,"token":"..."}) — then CHANGE the password
curl -s -X POST https://webao.ca/api/admin/login \
  -H 'Content-Type: application/json' -H 'Origin: https://webao.ca' \
  -d '{"password":"<default-from-deploy-log>"}'

# stats (expect 200 with labels/views/visitors arrays)
curl -s 'https://webao.ca/api/admin/stats?range=week' \
  -H "Authorization: Bearer <token>"
```

## 5. Local dev (optional)

```bash
npm run build
npx wrangler dev --config wrangler.jsonc
```

KV works in dev via local emulation (add `--persist-to` to keep state between runs).
Note: `CF-Connecting-IP` / `cf-ipcountry` are absent locally, so IP shows as
`unknown` and country as `XX` — expected.

## Notes

- No npm dependencies were added; the worker uses Web APIs only.
- Type-check the worker any time with: `npx tsc --noEmit -p worker/tsconfig.json`
- `worker/` is excluded from Astro's own `tsconfig`/`astro check` (only `src/` is included), so the site build is unaffected.
- Astro’s static build generates `.wrangler/deploy/config.json` on every build.
  Plain `wrangler deploy` follows it to `dist/client/wrangler.json`, an assets-only
  configuration that omits this Worker. Always pass `--config wrangler.jsonc`
  (or use `npm run cf:deploy` / `npm run cf:dev`). Do not rely on deleting the
  redirect; it will be recreated.
- Demo/carousel images not present in `public/` require raw binary KV values under
  `img:<pathname>`, e.g. `img:/demos/tactile/01.jpg`. The repository has no demo
  binaries or `.b64` restoration inputs; building does not populate remote KV.
- `npm run test:integration` builds and verifies real Workerd HTTP serving with an
  isolated, locally seeded KV fixture. It does not access or modify production.
  After deploying, check actual production image URLs and confirm the image bytes
  decode; passing local tests cannot establish that remote KV has the artwork.
