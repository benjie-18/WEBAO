# WEBAO Worker API

Base URL is the site itself (`https://webao.ca`); all endpoints are same-origin JSON.
Every response is JSON. Errors look like `{ "ok": false, "error": "<message>" }`
with an appropriate HTTP status (400 validation, 401 auth, 403 origin, 404 unknown,
429 rate-limited, 500 internal).

`POST`/`DELETE` endpoints require a matching `Origin` or `Referer` header
(`webao.ca`, `www.webao.ca`, `webao.bnji.net`; `localhost`/`127.0.0.1` for dev).
Admin `GET`s additionally accept requests with no origin headers — the Bearer token
is the authentication there.

## Tracking (public)

Session id (`sid`) is generated client-side (uuid, stored in `localStorage`).
IP comes from `CF-Connecting-IP`, country from `cf-ipcountry` — never from the body.

### `POST /api/track/pageview`
Body: `{ sid, path, referrer?, screen?, locale?, theme? }`
→ `{ "ok": true }` (or `{ "ok": true, "tracking": false }` when the admin paused tracking).
Creates the session on first call; increments the per-day view counters.
Rate limit: 120 req/min per IP.

### `POST /api/track/click`
Body: `{ sid, path, kind, label }` — `kind` e.g. `"cta"`, `"nav"`, `"link"`;
`label` is free text (max 120 chars).
→ `{ "ok": true }`. Appends to the session's click log (capped at 200/session).
Same rate limit as pageview.

### `POST /api/track/heartbeat`
Body: `{ sid, path, durationMs, final? }`
→ `{ "ok": true }`. Records time-on-page for the most recent visit of `path`
(monotonic — the stored value never shrinks). Send every ~60s and on
`visibilitychange`/`pagehide`; pass `final: true` for those last-chance sends —
periodic beats are coalesced server-side (persisted at most every 2 min) to
stay inside the KV daily write budget, while final beats always persist.

## Forms (public)

### `POST /api/forms/submit`
Body: `{ form: "pricing" | "contact", fields: { name, email, message?, ... } }`
Validation: `name` required; `pricing` requires a valid `email`; `contact`
requires `email` or `message`. Extra fields are kept (string values, capped).
→ `{ "ok": true, "id": "<ts>:<rand>" }` (400 with an error message otherwise).

## Checkout (public)

### `POST /api/checkout/session`
Body: `{ email?: string, name?: string, business?: string, locale?: "fr", items?: [{ key }] }`
Creates a Stripe Embedded Checkout session from the cart.

`items` carries one cart key per selected product, `${product}-${interval}` with
`interval = month | year | one-time` (e.g. `launch-year`, `localseo-month`,
`extrapage-one-time`; `-onetime` is accepted as an alias). The catalog of keys
and prices lives in `src/lib/cart-catalog.ts`; the Stripe Price IDs live in
`PRICE_MAP` in `worker/checkout.ts`, and `tests/cart.test.ts` keeps the two in
sync. Requests without `items` (the `/start` form) fall back to
`STRIPE_PRICE_ID` — the legacy single-price flow.

Session shape: `mode=subscription` as soon as one recurring item is present
(mixed recurring + one-time carts are supported by Stripe), `mode=payment` when
the cart is one-time only, and `expand[]=line_items` so the response reports the
amounts that will actually be charged.

Guards/limits: same-origin (`Origin`/`Referer` must match the site), 10 req/min
per IP, `email` validated when provided, duplicated keys collapsed, max 20
recurring + 20 one-time line items, and **one billing interval per session** —
monthly and yearly items are rejected with 400 rather than letting Stripe fail
(“Checkout does not support multiple prices with different billing intervals”).
Unknown keys are rejected too, so a stale cart can never be charged less than it
showed.

→ `{ "ok": true, "clientSecret": "<stripe_client_secret>", "mode": "subscription", "lineItems": [{ "description": "Launch", "amount": 89099, "currency": "cad", "interval": "year" }] }`.
→ `{ "ok": false, "error": "…" }` (400 invalid cart / mixed intervals, 403 origin,
429 rate-limited, 502 Stripe error, 503 configuration). `Checkout not configured`
(503) is returned when `STRIPE_SECRET_KEY` is unset, or when the legacy flow runs
without `STRIPE_PRICE_ID`.

## Admin (Bearer token)

Login: `POST /api/admin/login` body `{ password }` → `{ "ok": true, "token": "<64-hex>" }`.
Token is 256-bit, stored server-side with a 7-day TTL. Pass it as
`Authorization: Bearer <token>`. Unknown/expired tokens → `401`.
Login is throttled: 10 attempts/min per IP.
Default password is set on first deploy (see DEPLOY.md); change it in the panel immediately.

### `GET /api/admin/stats?range=day|week|month|year&page=<path|all>`
→
```json
{
  "ok": true, "range": "week", "page": "all",
  "labels": ["2026-09-28", "..."],
  "views": [12, 45], "visitors": [3, 9],
  "topPages": [{ "path": "/pricing", "views": 120 }],
  "devices": { "mobile": 10, "tablet": 2, "desktop": 30 },
  "countries": [{ "code": "CA", "count": 25 }]
}
```
`day`/`week`/`month` return daily buckets (1/7/30 days); `year` returns 12 monthly
buckets. `visitors` counts distinct sessions by `startedAt`; devices/countries are
aggregated over sessions in range. `topPages` is always the global top 10 for the
range (not filtered by `page`).

### `GET /api/admin/forms?limit=50&cursor=`
→ `{ "ok": true, "items": [{ id, form, fields, ip, country, ua, at }], "nextCursor": "50" | null }`
Newest-first. `limit` clamped to 1–100. Pass `nextCursor` back as `cursor` for the
next page; `null` means done.

### `DELETE /api/admin/forms/:id`
`:id` is the `<ts>:<rand>` part returned at submit time. → `{ "ok": true }`.

### `GET /api/admin/config`
→ `{ "ok": true, "settings": { "defaultTheme": "system"|"light"|"dark", "trackingEnabled": true } }`

### `POST /api/admin/config`
Body: any subset of `{ defaultTheme, trackingEnabled }` (keys are whitelisted;
unknown keys ignored). → `{ "ok": true, "settings": { ... } }`.
Setting `trackingEnabled: false` makes the tracking endpoints return
`{ "ok": true, "tracking": false }` without recording anything.

### `POST /api/admin/password`
Body: `{ current, next }` — `next` must be ≥ 5 chars.
Verifies `current` with a timing-safe SHA-256 compare, stores SHA-256 of `next`,
and revokes all other admin tokens (the caller stays logged in).
→ `{ "ok": true }` (401 if `current` is wrong).

## KV layout (for reference)

| Key | Value |
|---|---|
| `config:auth` | `{ passwordHash }` — SHA-256 hex |
| `config:settings` | `{ defaultTheme, trackingEnabled }` |
| `session:<uuid>` | session object (TTL 90 days) |
| `views:<yyyy-mm-dd>:<urlenc-path>` | integer pageview counter |
| `views:<yyyy-mm-dd>:__all` | integer total counter for the day |
| `form:<ts>:<rand>` | form submission object |
| `forms:index` | JSON array of form keys, newest-first, cap 1000 |
| `admin:token:<64-hex>` | `{ createdAt, ip }` (TTL 7 days) |
| `rl:<scope>:<ip>` | `{ c, r }` rate-limit window |
