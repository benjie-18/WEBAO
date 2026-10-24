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
Body: `{ form: "pricing" | "contact" | "support", fields: { name, email, message?, ... } }`
Validation: `name` required; `pricing` requires a valid `email`; `contact`
requires `email` or `message`; `support` requires a valid `email`, a
`category` (`billing` | `changes` | `addons` | `issue` | `other`), a
`subject` and a `message` (the description). Extra fields are kept (string
values, capped). Support and contact submissions also send a best-effort
email copy to the WEBAO inbox via the `EMAIL` send_email binding
(destination pinned in `wrangler.jsonc`); the KV record stays the source of truth.
Throttled to 10 submissions/min per IP (429 beyond that).
→ `{ "ok": true, "id": "<ts>:<rand>" }` (400 with an error message otherwise).

## Outreach lead tracking

Who was emailed, who clicked, who replied. Records live in KV as `lead:<id>`
with a newest-first `leads:index` (cap 1000), the same pattern as forms.

Ingest posture matches `POST /api/forms/submit` (same-origin gate + per-IP
throttle, 20/min). When the `LEADS_INGEST_KEY` worker secret is set, both
ingest endpoints instead require it in the `x-ingest-key` header (no origin
needed) — set the same key on the sender side to harden them.

### `POST /api/leads/register`
Body: `{ business, email, city?, trade?, subject?, lang?, source?, id?, sentAt? }`
`business` and a valid `email` are required. `id` may be supplied by the sender
(`ld_` + 24 lowercase hex chars) or omitted, in which case one is minted.
Re-registering an existing id is idempotent: it returns the existing links
with `"existing": true` and never touches click/reply history.
→ `{ "ok": true, "id": "ld_…", "links": { "demos": "https://webao.ca/go/ld_…?d=demos", "home": "…?d=home", "pricing": "…?d=pricing", "start": "…?d=start" }, "replyTo": "contact+ld_…@webao.ca" }`

Senders put the tracked links in the email (link destinations are fixed:
`demos` → `/demos`, `home` → `/`, `pricing` → `/pricing`, `start` → `/start`)
and, when their mail tool supports it, set the Reply-To to the returned
`replyTo` (the plus-address survives in the To header of replies, which pins
the reply to this lead). The Gmail `+send` shortcut cannot set Reply-To, so
replies to those sends are matched by sender email instead (below).

### `GET /go/:id?d=demos|home|pricing|start`
Public redirect behind every tracked link. Logs the click on the lead
(timestamp, destination, country, and a `suspect` flag when the user agent
looks like a mail scanner or link unfurler such as SafeLinks/Proofpoint —
suspect clicks are stored but never counted in `clickCount`), then answers
302 to the destination path. Unknown ids and unknown destinations still
redirect (default `demos`): a link already sitting in an inbox must never
break. Click logging is best-effort and never blocks the redirect.

### `POST /api/leads/reply`
Body: `{ leadId?, email?, from?, kind?: "reply" | "optout" | "bounce", subject?, at? }`
Matches the lead by `leadId` when given, else by the newest lead sent to
`email`/`from`. Sets `repliedAt` / `optOutAt` / `bouncedAt` on first event of
each kind and appends to the lead's reply log (cap 50).
→ `{ "ok": true, "matched": true, "id": "ld_…", "kind": "reply" }`, or
`{ "ok": true, "matched": false }` when nothing matches (still a 200: the
inbox scanner should not retry a reply that simply predates tracking).

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

→ `{ "ok": true, "clientSecret": "<stripe_client_secret>", "mode": "subscription", "lineItems": [{ "description": "Launch", "amount": 89990, "currency": "cad", "interval": "year" }] }`.
→ `{ "ok": false, "error": "…" }` (400 invalid cart / mixed intervals, 403 origin,
429 rate-limited, 502 Stripe error, 503 configuration). `Checkout not configured`
(503) is returned when `STRIPE_SECRET_KEY` is unset, or when the legacy flow runs
without `STRIPE_PRICE_ID`.

### `POST /api/stripe/webhook`
Stripe server-to-server webhook (no origin gate; authenticity comes from the
`Stripe-Signature` HMAC, verified against `STRIPE_WEBHOOK_SECRET` with a
5-minute timestamp tolerance). Returns 503 until the secret is set, 400 on a
bad signature. Events are deduped via `stripe-event:<event_id>`: a
processing claim is written before handling (60s TTL; a concurrent
delivery for the same event gets 503 so Stripe retries), replaced by a
completed marker (TTL 30 days) after successful handling, which answers
`{ duplicate: true }`. Failures leave no completed marker, so Stripe
retries still work.

Handled events: `checkout.session.completed` (create or enrich the client
record at stage `onboarding`, items from the session's `metadata[items]`, plus
a best-effort inbox notification from start@webao.ca), `invoice.paid`,
`invoice.payment_failed`, `customer.subscription.updated` and
`customer.subscription.deleted` (mirror billing status onto the client),
`checkout.session.expired` (store an abandoned checkout for recovery, see
`recovery.ts`), `charge.dispute.created` (record the dispute at
`dispute:<id>`, flag the client, alert the inbox immediately through the
send_email binding) and `invoice.payment_action_required` (set
`client.paymentActionRequired` with the hosted invoice URL, bannered in the
portal and emailed to the client; the next `invoice.paid` clears it).
Clients live in `client:<cl_id>` with the `client-customer:<cus_id>` lookup;
unknown customers and unknown event types are acknowledged as no-ops.

## Client portal (cookie session)

Sign-in is passwordless. `POST /api/portal/request-link` `{ email }` mails a
one-time link (30 min, single use) through SMTP2GO and always answers
`{ ok: true }` for unknown emails (no enumeration); the link lands on
`/portal#t=<token>` and the page trades it at `POST /api/portal/exchange` for
a session cookie (`webao_portal`, HttpOnly, 30 days, `portal-session:<tok>`).
`POST /api/portal/claim` `{ sessionId }` is the post-checkout bootstrap: the
Stripe session is verified server-side and a paid session whose customer or
email resolves to a client signs the browser in, no email needed.
`GET /api/portal/me` returns the client's own view (stage, billing, items,
onboarding). `POST /api/portal/onboarding` saves onboarding answers; the
first save that completes the required fields (business, contact, phone,
services, service area, domain choice + value) stamps `onboardingCompletedAt`,
advances stage `onboarding` → `build` and notifies the inbox. When the
save is post-completion and the requested domain is taken by another
client, the save still succeeds but the response carries
`domainConflict: true` and the client's domain is unchanged.
`POST /api/portal/logout` drops the session. Client-facing mail needs the
`SMTP2GO_API_KEY` secret (the `send_email` binding can only reach the WEBAO
inbox); a new-client welcome email is sent from the Stripe webhook on the
same channel.

`POST /api/portal/review` `{ decision: "approved" | "changes", note? }` is
the client's sign-off on the build in review (stage must be `review`).
Approval publishes the draft on the spot (it already passed QA) and records
the decision; a changes request requires a note, bumps `revisionCount`,
returns the record to stage `build`, and notifies the inbox with the note.
The decision shows on the admin Clients card.

### `POST /api/internal/onboarding-nudges`
Shared-secret Bearer auth (`INTERNAL_CRON_SECRET`), called daily by a cron.
Clients still in stage `onboarding` with an incomplete form get a reminder
email on day 2 and day 5; on day 7 the inbox is notified instead
(escalation, `nudgesEscalatedAt`). Answers `{ nudged, escalated, skippedNoMail }`.

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

### `GET /api/admin/leads?limit=50&cursor=`
→ `{ "ok": true, "items": [{ id, business, email, city, trade, subject, lang, source, sentAt, clicks: [{ at, dest, country, suspect }], replies: [{ at, kind, from, subject }], clickCount, firstClickAt, lastClickAt, repliedAt, optOutAt, bouncedAt }], "nextCursor": "50" | null }`
Newest-first by registration order. Same pagination rules as forms.

### `DELETE /api/admin/leads/:id`
`:id` is the `ld_…` lead id. Removes the record and its index entry.
→ `{ "ok": true }`.

### `GET /api/admin/clients?limit=50&cursor=`
→ `{ "ok": true, "items": [{ id, email, lang, test, name, business, stage, billingStatus, items, createdAt, updatedAt, onboardingComplete, onboarding, onboardingCompletedAt, previewUrl, domain, domainStatus, domainCheckedAt, reviewDecision, revisionCount, nudgeCount, nudgesEscalatedAt, stripeCustomerId, stripeSubscriptionId, paymentActionRequired, disputeFlag, hasAds, adsStatus, adsTrade, adsBudget, adAccountId, buildAt, buildQaPassed, buildQaFailedChecks, hasDraft, isPublished, publishPending }], "abandoned": [{ sessionId, email, items, amountTotal, currency, lang, createdAt, status }], "nextCursor": "50" | null }`
Newest-first. Same pagination rules as forms. Backs the admin Clients tab.
The top-level `abandoned` list is the first page (max 50) of abandoned
checkouts, newest-first; it is present only on the first page.

### `POST /api/admin/clients/update`
Body `{ id, stage?, previewUrl?, domain?, adsStatus?, adAccountId? }`. Moves a client between stages
(`onboarding | build | review | live | paused`), sets or clears the review
preview URL the portal shows during stage `review`, and assigns or clears
(`""`) the client's domain (normalized to a bare hostname; 409 when another
client owns it, 400 when unusable). `adsStatus` moves the ads track
(`onboarding | setup | ready | live | paused`); `adAccountId` stores the
client's Meta ad account id. → `{ "ok": true, "client" }`.

## Tenant domains (multi-tenant serving)

A client's canonical domain lives on the record (`domain`, `domainStatus`:
`none | to-register | pending-dns | connected | live`) with a
`domain:<host>` KV mapping to the client key. Assignment happens three ways:
onboarding completion claims the form's domain automatically (existing →
`pending-dns`, new → `to-register`), the admin Clients tab, and this API.
A non-main hostname with a mapping resolves through it (a www/bare mismatch
is tolerated) to a per-client "coming soon" page (or "temporarily
unavailable" when paused). Unmapped hosts fall through to the main site for
now; once Cloudflare for SaaS custom hostnames are enabled, unverified
hosts are rejected at the edge before reaching the worker. Published builds
are served from the same path once the build pipeline writes them.
The portal shows the client their domain state, including the CNAME record
to add (`<host>` → `hosting.webao.ca`) while `pending-dns`.

## Build pipeline

`worker/sitegen.ts` renders a deterministic baseline site from the client's
onboarding answers (the demo picks steer only the palette; the build is
custom, never a clone). `worker/builds.ts` stores each build immutably:
files at `site:<clientId>:<buildId>:<path>`, metadata at
`build:<clientId>:<buildId>`, pointers at `build:<clientId>:latest`,
`site:<clientId>:draft` and `site:<clientId>:published`.

Every build runs the QA suite (15 checks: files, doctype, title, meta
description, lang, single h1, tappable phone link, all services and the
service area rendered, no em dashes, no placeholder text, links resolve,
contact section, canonical, size budget). A clean report is the launch
gate: the client advances to `review`, `previewUrl` is set to
`https://webao.ca/preview/<clientId>/` (the worker serves the draft there,
noindexed), and the client is emailed. Any failure leaves the build in the
exception queue: the stage does not move, the inbox gets the failing
checks, and the admin Clients tab shows them on the card.

### `POST /api/admin/clients/build`
Body `{ id }`. Generates a draft build and runs QA. → `{ ok, buildId, qaPassed, checks }`.

### `POST /api/admin/clients/publish`
Body `{ id }`. Publishes the current draft (requires a passing QA report):
the tenant host serves it, the stage becomes `live`, a `connected` domain
becomes `live`, and the client is emailed. → `{ ok, buildId }`.

### `POST /api/admin/clients/create-test`
Body `{ email, business?, lang? }`. Creates a test client record (Launch +
Ads Pack, `source: "admin-test"`, flagged `test`): excluded from onboarding
nudges and monthly reports, and a real checkout with the same email
graduates it into a real record. → `{ ok, client }` (409 if the email
already has a record).

### `POST /api/admin/clients/view-as`
Body `{ id }`. Mints an admin-flagged portal session for the client (24 h,
`viaAdmin` on the session record) and returns it as the portal cookie, so
the admin's browser opens the portal exactly as the client sees it.
`/api/portal/me` reports `viaAdmin` and the portal shows a banner with an
exit back to /admin. → `{ ok }` + `Set-Cookie`.

## Client reports

Published tenant pageviews are counted per client per month
(`tstats:<clientId>:<yyyy-mm>` = `{ views, byDay }`) when the worker serves
a published site (GET only, via waitUntil; previews and placeholders are
not counted). The portal shows a live client their current month's views.

### `POST /api/internal/monthly-reports`
Shared-secret Bearer auth (`INTERNAL_CRON_SECRET`), run monthly. Emails
every `live` client their previous month's real numbers (page views, days
with visits, site URL) and writes `report:<clientId>:<yyyy-mm>` so a client
is never reported twice for a month; a failed send (for example the SMTP2GO
key missing) is left unrecorded and retries next run. An optional
`{ month: "yyyy-mm" }` body targets a specific month.
Answers `{ month, sent, skipped, failed }`.

### `POST /api/internal/abandoned-followups`
Shared-secret Bearer <redacted> (`INTERNAL_CRON_SECRET`), run daily by the
automation cron. Sends one follow-up email per abandoned checkout
(`abandoned:<sessionId>`, written by the webhook on
`checkout.session.expired`) once it is at least 12 hours old: skipped and
marked `converted` when the email now belongs to a client, marked `stale`
unemailed after 14 days, left `pending` when the mailer cannot send.
At most 20 follow-ups per run.
Answers `{ emailed, converted, stale, pending }`.

## Ads Pack

Buying the pack (cart key `ads-pack-month`) opens an ads track on the
client record (`ads.status`: onboarding → setup → ready → live / paused).
The one-time setup fee is added by checkout automatically (server-side)
when the cart holds the pack. The monthly price is static in the
checkout catalog (`price_1UTsvJE57vVzxI41esicPXuU`, C$899.99/mo); only
the setup fee is env-configured (`STRIPE_PRICE_ADS_SETUP`, C$499.99
one-time). Without the setup secret the pack still checks out, monthly
only, with no setup line.

`POST /api/portal/ads-onboarding` saves the ads intake (trade, services,
area, radius, monthly budget, landing website, lead contacts). It counts
as complete with a trade, an area, a budget of at least $1,500 (the
client's own ad spend, on their card), a lead destination, and a landing
page (their site or the WEBAO domain); completion moves the status to
`setup` and notifies the inbox.

`POST /api/internal/ads-lead` (shared-secret) records a lead for a client
from any source (Meta lead sync, landing page, manual): it is stored
(`adslead:<id>`, index `adsleads:<clientId>`), emailed to the client's
lead contact instantly, and copied to the inbox. In the portal, the
client can mark a lead `booked` or `not-fit` with one tap
(`POST /api/portal/ads-lead-outcome`), which feeds the monthly report:
leads received, jobs booked, and, when a spend record exists
(`POST /api/admin/clients/ads-spend` { id, month, amountCents }), cost
per lead and cost per booked job.

`GET /api/admin/clients/ads-packet?id=` returns the launch packet: the
per-trade Meta template (worker/ads-templates.ts) filled with the
client's business, area and budget (daily = monthly / 30), landing page,
creative angles, lead form questions, and the readiness checklist
(pack bought, onboarding complete, budget floor, landing page, client ad
account connected). Campaign creation itself waits on the Meta app
review; the admin Clients card also carries the ads status, the client
ad account id, and the spend recorder.

### `POST /api/internal/build`
Shared-secret Bearer auth (`INTERNAL_CRON_SECRET`). Body `{ clientId }`.
Same build as the admin action, for agent jobs. → `{ ok, buildId, qaPassed, checks }`.

### `POST /api/internal/domain-checks`
Shared-secret Bearer auth (`INTERNAL_CRON_SECRET`), called daily by a cron.
For each `pending-dns` / `to-register` domain, a DNS-over-HTTPS lookup marks
it `connected` when its CNAME points into webao.ca (the instructed target is
hosting.webao.ca); `domainCheckedAt` is stamped either way.
Answers `{ checked, connected, stillPending }`.

### `GET /api/admin/charts?range=day|week|month|year`
Per-day form + outreach series for the admin chart cards, in the same label
shape as stats (daily buckets; monthly for `year`).
→ `{ "ok": true, "range", "labels": [...], "forms": { "total": [...], "byType": { "contact": [...], "support": [...], "pricing": [...] } }, "leads": { "sent": [...], "clicked": [...], "replied": [...] }, "leadStages": { "replied", "clicked", "none", "optout", "bounced" }, "clickDests": { "demos", "home", "pricing", "start" } }`
`leadStages` counts each in-range lead once, at its furthest outcome
(bounced > opted out > replied > clicked > no response). `clickDests` counts
human (non-scanner) clicks in range by destination.

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
| `forms:index` | JSON array of form keys, newest-first, cap 1000 (index trim only; records are never deleted) |
| `lead:<ld_id>` | outreach lead object (sent/clicks/replies) |
| `leads:index` | JSON array of lead keys, newest-first, cap 5000 (index trim only; records are never deleted) |
| `client:<cl_id>` | client record (stage, billing status, Stripe ids, items) |
| `clients:index` | JSON array of client keys, newest-first, cap 1000 (index trim only; records are never deleted) |
| `client-customer:<cus_id>` | client key for a Stripe customer id |
| `client-email:<email>` | client key for a client email |
| `stripe-event:<event_id>` | webhook dedupe: processing claim `{ processing: true }` (TTL 60s), then completed marker `{ type, at }` (TTL 30 days) |
| `abandoned:<sessionId>` | abandoned checkout record (status pending/emailed/converted/stale) |
| `abandoned:index` | JSON array of abandoned keys, newest-first, cap 500 (follow-up sweep reads `abandoned:` keys directly, not the index) |
| `dispute:<dispute_id>` | dispute record (amount, reason, evidence due date) |
| `portal-session:<tok>` | portal session (TTL 30 days) |
| `portal-login:<tok>` | portal login token (TTL 30 min) |
| `domain:<host>` | client key for a mapped hostname |
| `build:<clientId>:<buildId>` | build record (files, QA results, published flag); `build:<clientId>:latest` points at the newest |
| `site:<clientId>:<buildId>:<path>` | published site files (per-page HTML); `site:<clientId>:draft` is the working draft |
| `tstats:<clientId>:<yyyy-mm>` | tenant traffic counters |
| `report:<clientId>:<yyyy-mm>` | monthly report record (idempotency marker) |
| `adslead:<lead_id>` | ads lead record (contact, outcome) |
| `adsleads:<clientId>` | JSON array of ads lead keys for a client |
| `adsspend:<clientId>:<yyyy-mm>` | recorded ad spend for a client-month |
| `admin:token:<64-hex>` | `{ createdAt, ip }` (TTL 7 days) |
| `rl:<scope>:<ip>` | `{ c, r }` rate-limit window |
