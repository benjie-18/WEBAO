# WEBAO Worker — deploy checklist

The worker code (`worker/`) is written and type-checked locally. These steps need
to run once, with the user's approval (they create Cloudflare resources).

## 1. Create the KV namespace

```bash
cd ~/workspace/webao-darkmode/webao
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
> no manual step needed. The default password is `32560`; change it immediately
> in the admin panel (Config tab) after the first login.

## 3. Build the site and deploy

```bash
npm run build          # Astro → dist/client (unchanged behavior)
npx wrangler deploy    # uploads worker + static assets
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
  -d '{"password":"32560"}'

# stats (expect 200 with labels/views/visitors arrays)
curl -s 'https://webao.ca/api/admin/stats?range=week' \
  -H "Authorization: Bearer <token>"
```

## 5. Local dev (optional)

```bash
npm run build
npx wrangler dev --assets ./dist/client
```

KV works in dev via local emulation (add `--persist-to` to keep state between runs).
Note: `CF-Connecting-IP` / `cf-ipcountry` are absent locally, so IP shows as
`unknown` and country as `XX` — expected.

## Notes

- No npm dependencies were added; the worker uses Web APIs only.
- Type-check the worker any time with: `npx tsc --noEmit -p worker/tsconfig.json`
- `worker/` is excluded from Astro's own `tsconfig`/`astro check` (only `src/` is included), so the site build is unaffected.
- If wrangler ever prints "Using redirected Wrangler configuration" pointing at
  `dist/client/wrangler.json` (a stale artifact from an earlier adapter build),
  delete `.wrangler/deploy/config.json` and re-run — plain `wrangler deploy`
  from the repo root will then use `wrangler.jsonc` directly.
