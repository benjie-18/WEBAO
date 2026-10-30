# WEBAO
Webao is a website-as-a-service web design and hosting service that creates custom, professional websites for small businesses and individuals. For a simple monthly fee, clients get a custom domain, hosting, maintenance, analytics, and ongoing support without having to manage the technical side themselves.

The goal is simple: clients get a professional website without having to deal with domains, hosting, maintenance, analytics, or technical support.

## Business Model

WEBAO primarily uses a monthly subscription model.

Target starting price: ~$149 CAD/month

Typical package:

Custom 3 to 5 page website
Custom domain
Hosting + SSL
Mobile-responsive design
Contact / quote form
Basic SEO
Analytics
Maintenance and security
Minor content updates
Ongoing technical support

The service should feel simple and all-inclusive to the client. Technical details such as Cloudflare, Astro, deployment pipelines, etc. are implementation details and generally should not be exposed in the customer-facing experience.

## Target Customers

Primarily local small businesses that benefit from a professional web presence:

Electricians
Plumbers
HVAC contractors
Landscapers
Construction / renovation
Auto services
Cleaning businesses
Restaurants 
Other local service businesses

Individuals and small organizations can also be supported where appropriate.

## Product Philosophy

Clients are buying a functional, professional website, not a website deployed through cloudflare via a custom domain... 
Keep it simple

Avoid unnecessary complexity, dependencies, and infrastructure.

Prefer:

Fast static sites
Minimal JavaScript
Strong SEO fundamentals
Excellent mobile experience
Accessible UI
Reliable deployment
Low operating costs
Reusable components and templates

## WEBAO.CA 

Webao.ca is the website that clients may be redirected to for their inquiries. 
It must be impressive and feature packed. Clients should be able to contact the owner to send assets, questions, etc. 
The landing page should be impressive, with animations and great style. 

For more information on the artistic direction and components of the main site, visit artistic-direction.md

## SEO

All SEO lives in `<head>` — no visible content depends on it, so the page
experience is identical with or without it. The invariants, all pinned by
tests (`tests/demo-seo.test.ts`, `tests/sitemap.test.ts`,
`tests/i18n.test.ts`, `tests/content.test.ts` and the built-HTML sweep in
`tests/cloudflare.integration.ts`):

- Every page has a unique, localized `<title>` and meta description, a
  canonical URL (directory-style, trailing slash — matching the 307 targets),
  and `en` / `fr` / `x-default` hreflang alternates.
- Indexed pages emit `index, follow, max-image-preview:large, max-snippet:-1,
  max-video-preview:-1`; utility pages (`/admin`, `/checkout`, `/404`) and the
  hidden demo (`boba-club`) are `noindex, nofollow` and disallowed in
  `robots.txt`.
- Open Graph (with image dimensions + alt) and Twitter `summary_large_image`
  cards on every page; demo pages use their own lead image as `og:image`.
- JSON-LD: `Organization` + `WebSite` everywhere, `BreadcrumbList` on subpages,
  `FAQPage` on the home page, `Product`/`Offer` on pricing, `ItemList` on the
  demo catalog, and `WebPage` + breadcrumb on every demo microsite.
- `sitemap.xml` lists all 118 public URLs with hreflang alternates and image
  entries (the Google image-sitemap namespace) for the demo lead images.
- Demo microsites are standalone HTML documents (no `BaseLayout`); their head
  block is rendered by `src/components/demos/DemoSeo.astro` from the helpers
  in `src/lib/demo-seo.ts`. Hero images get `fetchpriority="high"`, the rest
  `loading="lazy"` + `decoding="async"`.
- Checkout/start pages preconnect to `js.stripe.com`, `api.stripe.com` and
  `checkout.stripe.com` so the payment UI mounts sooner.

## Development

```bash
npm install
npm run dev      # http://localhost:4321
npm run build    # astro build, outputs to dist/client
npm run check    # astro check (type + Astro)
npm run preview  # preview built site
```

Project architecture:

- `src/layouts/BaseLayout.astro`: SEO, header/footer, scroll progress, ClientRouter, reveal
- `src/styles/global.css`: tokens, typography (Instrument Serif + Inter + IBM Plex Mono), layout, motion (respects `prefers-reduced-motion`)
- `src/components/{ui,layout,anim}`: reusable Button, Card, Badge, Section, Reveal, **IntroSequence**
- `src/lib/{demos,motion}.ts`: demo catalog (43 art-directed fictional businesses, clearly labeled as demos; 42 visible in the public catalog) + motion helpers
- `src/lib/intro/{config,engine}.ts`: the intro's art direction (`INTRO_CONFIG`) and its dependency-free motion engine
- `src/pages/{index,pricing,contact,demos,404,sitemap.xml.ts}`: polished marketing site; demos are a searchable/filterable catalog, each visible demo shipping its own standalone microsite under `src/pages/{,fr/}demos/`

## The intro sequence (`IntroSequence.astro`)

The landing page opens with a signature interaction: a stylized pointer eases
into the frame, pauses to inspect the barrier, tests it with a first tap, then
bounces back for a short thinking beat. After the visitor accepts the prompt,
the pointer steps back and launches again; the barrier breaks into solid slabs
that travel out of view instead of fading. The view gently follows the impacts,
then the site rises into place and the pointer takes a measured path to **"Start
your site"**, where it rests with a restrained glow. No `scrollTo()` jump.

```
arrives → slow flight → inspect → first tap (dent · debris · bounce)
      → think → invite → step back → launch → fracture (solid shards · shockwave)
      → camera eases back → site rises → cursor approaches the real CTA → glow
```

### Tuning it

Every artistic decision is a number in **`src/lib/intro/config.ts`** — nothing is
hard-coded in the component. Nothing else needs to be edited to re-time,
re-aim, soften or exaggerate the sequence:

| Want to change…            | Edit                                             |
| -------------------------- | ------------------------------------------------ |
| the flight path or speed   | `flight.path`, `flight.speedProfile`, `duration`  |
| the first look / thinking  | `flight.lookMs`, `flight.firstHit`, `bounce.thinkMs` |
| the weight / momentum      | `flight.chase`, `bounce.gravity`, `restitution`   |
| cursor rotation behaviour  | `cursor.rotation`, `cursor.restAngle`             |
| the hit                    | `impact.squash`, `shake`, `dent`, `debris`, `shock` |
| the invitation             | `invite.pulse`, `halo`, `promptText`              |
| wind-up / camera / break   | `breach.prepare`, `breach.camera`, `fracture`, `hole`, `flex`, `hold` |
| the handoff + CTA glow     | `handoff.rise`, `handoff.cta`, `handoff.scroll`, `handoff.glow` |
| overall pace               | `master.timeScale`                                |

Positions are fractions of the viewport and the final cursor position is
measured from the **actual** `"Start your site"` element (`.hero-actions
.btn--primary`, overridable via the `target` prop or `[data-intro-target]`), so
alignment stays pixel-true at every screen size — including short viewports,
where the page glides until the CTA is in view, the cursor rides the reveal, and
then closes the last gap with its own eased approach.

### Behaviour

- **Runs once per session** (sessionStorage) and only on `/`; `?intro=1` replays,
  `?intro=0` skips.
- **Keyboard**: Enter/Space works anywhere (the invitation itself is a real
  button, so tab-focus does the right thing). Past the invitation, the pointer
  follows the visitor's own mouse, so the prompt can be clicked naturally.
- **Touch**: no fake pointer-follow; the invite reads "Tap to enter".
- **`prefers-reduced-motion`**: no flight, no cursor — a static, single-action
  entrance (one click/Enter and the intro is gone).
- **No JS / JS failure**: the inline boot gate never fires and a 7 s failsafe
  releases the page, so the site always renders normally.
- **After the handoff** the overlay, classes and transforms are removed
  completely; scroll, navigation and the site's own cursor behave
  exactly as they did before the intro existed.
- Inspect/tune live: `__wiDebug.state()`, `__wiDebug.config`,
  `__wiDebug.forceTimeScale(0.4)` (slow motion), `__wiDebug.skipToInvite()`.

## Cart and checkout

The pricing page feeds a client-side cart; the purchase is a two-step funnel:

1. `/start` (`/fr/commencer`) — **details.** Shows the selection (plan radios,
   add-ons/bundles, billing term, total) next to the name/email/business form.
   A visitor who arrives with an empty cart gets Grow pre-selected (the C$149
   anchor the "Start →" CTAs advertise); one who arrives from the pricing page
   keeps exactly their cart. Add-ons without a plan are allowed (existing
   WEBAO site). Valid details are stored in `sessionStorage` (`webao-checkout`),
   the owner is notified through `/api/forms/submit` (`form: "pricing"`), and
   the visitor moves on.
2. `/checkout` (`/fr/checkout`) — **payment.** The only page that creates a
   Stripe session. It requires both a cart and stored details: an empty cart
   shows a link to pricing, missing details send the visitor back to `/start`.
   Stripe.js is loaded on demand, the embedded checkout is unmounted on
   `astro:before-swap`, and a cart change while the page is open rebuilds the
   session. The drawer's checkout button leads to `/start`; the mobile sticky
   CTA is hidden on both steps (`stickyCta={false}` / `pageKey="start"`).

- `src/lib/cart-catalog.ts` — every purchasable product with its prices in cents
  (monthly, annual, one-time). Single source of truth for the pricing
  components, the checkout display and the tests.
- `src/lib/cart.ts` — cart item shape, localStorage helpers (`webao_cart_v1`) and
  key format ``${product}-${interval}``.
- `src/lib/cart-ui.ts` — the drawer, the add-to-cart buttons and the billing
  term toggle, imported once by `BaseLayout` (`initCart()`). Listeners are
  delegated from `document` and the UI re-renders on `astro:page-load`, so the
  cart survives ClientRouter navigations and tab switches. All strings are read
  from the drawer's localized `data-*` attributes, so English and French share
  one implementation.
- `src/lib/start-ui.ts` + `src/components/pages/StartPage.astro` — the details
  step (selection card, validation, hand-off). `CheckoutPage.astro` is the
  payment step; its script is inline so the integration suite can drive the
  built page in jsdom.
- `worker/checkout.ts` — `PRICE_MAP` (cart key → Stripe Price ID) and session
  creation. Deploy the Worker for cart checkout to work:
  `cd worker && wrangler deploy` (or `npm run cf:deploy`).

Billing rules the code enforces (both come from Stripe, not from taste):

- **One billing term per checkout.** Stripe Checkout cannot mix monthly and
  yearly recurring prices in one session, so the pricing page carries a
  Monthly/Yearly toggle, switching the term re-prices whatever is already in the
  cart, and the API rejects mixed carts with a 400.
- **Mixed carts are fine otherwise.** Recurring items and one-time ones (Extra
  Page) share a `mode=subscription` session; a one-time-only cart uses
  `mode=payment`. The API still falls back to `STRIPE_PRICE_ID` for a request
  without items, but the site never sends one: `/checkout` refuses to open a
  session for an empty cart.
- Yearly add-ons and bundles are priced at ten months (“2 months free”). Plans
  use the annual figures published on the pricing page (C$890.99 / C$1,490.99 /
  C$3,490.99). Stripe is the source of truth at payment time: the session is
  created with `expand[]=line_items` and the checkout page re-renders the
  summary from those amounts, so a drifted price shows up as the real charge
  instead of a stale label.

`npm test` runs the unit suite (`tests/*.test.ts`, ~140 tests):

- **Worker API** — `worker-util` (origin gate, UA parsing, path sanitising,
  JSON limits, KV batching), `worker-auth` (password hashing, throttling, KV
  tokens, the HMAC fallback used when KV writes are down), `worker-track`
  (sessions, pageview counters, click/heartbeat caps and coalescing,
  tracking opt-out), `worker-forms` (validation, field sanitising, the
  1000-entry index cap), `worker-admin` (login, stats aggregation, form
  moderation, config and password change), `worker-routes` (subdomain
  redirect, `/api` dispatch, KV image fallback, 503/500 mapping).
- **Site content** — `cart`, `cart-ui` (drawer flow in jsdom), `start-ui`
  (details step: default plan, plan switch, validation, hand-off), `checkout`
  (Stripe parameters), `i18n` (en/fr parity, placeholders, locale routing),
  `content` (demo catalog, pricing structure, note cross-references, image
  provenance), `sitemap` (sitemap + robots.txt), `intro-engine` (the landing
  page animation math) and `images`.

`npm run test:integration` builds the site and then checks the real Workerd
worker: static pages, KV-only images, the cart hooks, tracking, form
submissions, the closed admin API, robots.txt/sitemap.xml, footnote anchors
and the built start and checkout pages driven through jsdom.

## Deployment: Cloudflare Workers (static assets)

- **Framework preset:** `Astro`
- **Build command:** `npm run build` (runs `astro build` → `dist/client`)
- **Output / Assets directory:** `dist/client`
- **Deploy commands:**
  ```bash
  npm run build && npx wrangler deploy --config wrangler.jsonc
  # or
  npm run cf:deploy
  npm run cf:dev   # local Workers preview with assets
  ```

`wrangler.jsonc` runs `worker/index.ts` alongside static assets. The Worker
requires `assets.binding: "ASSETS"` for static fallthrough and `WEBAO_KV` for API
data and image fallback. Do not remove the assets binding while `main` is set.

**Always pass `--config wrangler.jsonc` when running Wrangler dev/deploy.** Astro's
static Cloudflare build writes `.wrangler/deploy/config.json`, which redirects
plain Wrangler commands to `dist/client/wrangler.json`. That generated config is
assets-only: it removes `main` and the assets binding, so our API and KV image
fallback are never deployed. Deleting the redirect is not a durable fix—the next
build recreates it. The `cf:dev`, `cf:deploy`, and CI commands explicitly select
the root config to preserve the custom Worker.

### Demo and carousel images

Local URLs such as `/demos/tactile/01.jpg` and `/carousel/tactile.jpg` first use
static assets, then KV keys such as `img:/demos/tactile/01.jpg`. KV values must be
raw image bytes, not base64 text or source-page HTML.

The repository currently contains **no demo/carousel image binaries or `.b64`
files**. The restore script therefore restores zero files; a successful build
is not proof that images exist. Production depends on the separately populated
KV namespace. `npm run dev` runs Astro, not the custom Worker, so it cannot serve
KV-only images. Use a Workers preview with separately seeded local KV to test
that path. `src/lib/sources.json` is attribution, not an image download manifest.

Run `npm test` for binding, fallback, and deployment-command regressions.
Run `npm run test:integration` to build and check actual HTTP serving with
Workerd and isolated local KV. This seeds a tiny synthetic JPEG fixture (not the
production artwork), checks demo/carousel image bytes, GET/HEAD, static EN/FR
pages, a static image, missing-image 404s, and API routing, then cleans up.
After deployment, also check
real image URLs for status 200, an image content type, and decodable image bytes;
unit tests do not verify remote KV contents.

> **Fixes for Cloudflare build errors:**
> - **`npx wrangler build` / “Could not detect static files”:** Do **not** use `npx wrangler build` as the build command. That command compiles a Worker and expects built assets before it runs, so it fails when `dist/client` doesn’t yet exist. Use **`npm run build`** instead. Astro generates `dist/client` (and `dist/client/_headers` for caching), then `wrangler deploy --config wrangler.jsonc` uploads from that directory. If your dashboard is set to `npx wrangler build`, change it to `npm run build`.
> - **`Cannot use assets with a binding in an assets-only Worker`:** Check that the selected config contains both `main: "worker/index.ts"` and `assets.binding: "ASSETS"`. Use `--config wrangler.jsonc` rather than the generated assets-only config. Removing the binding is only appropriate for sites without a custom Worker, not this project.
