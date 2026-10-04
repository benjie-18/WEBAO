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

For more information on the artistic direction and components of the main site, visit artistc-direction.md

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
- `src/components/{ui,layout,anim}`: reusable Button, Card, Badge, Section, Reveal, CursorJourney, **IntroSequence**
- `src/lib/{demos,motion}.ts`: demo catalog (12 art-directed fictional businesses, clearly labeled as demos) + motion helpers
- `src/lib/intro/{config,engine}.ts`: the intro's art direction (`INTRO_CONFIG`) and its dependency-free motion engine
- `src/pages/{index,pricing,contact,demos,404,sitemap.xml.ts}`: polished marketing site; demos are a searchable/filterable catalog (no demo microsites yet per spec)

## The intro sequence (`IntroSequence.astro`)

The landing page opens with a signature interaction: a stylized pointer flies
through the screen, hits the barrier at the bottom, bounces back, invites a
click, breaks through, and hands the visitor to **"Start your site"** with a
restrained glow. The site rises into place behind it — no `scrollTo()` jump.

```
arrives  →  flies (real inertia)  →  impact (squash · shake · dent · debris)
      →  bounce (gravity + restitution)  →  invite (ring pulse + prompt)
      →  break through (fracture · hole · shockwave)  →  site rises
      →  cursor locks onto the real CTA  →  glow pulse  →  releases the page
```

### Tuning it

Every artistic decision is a number in **`src/lib/intro/config.ts`** — nothing is
hard-coded in the component. Nothing else needs to be edited to re-time,
re-aim, soften or exaggerate the sequence:

| Want to change…            | Edit                                             |
| -------------------------- | ------------------------------------------------ |
| the flight path or speed   | `flight.path`, `flight.speedProfile`, `duration`  |
| the weight / momentum      | `flight.chase`, `bounce.gravity`, `restitution`   |
| cursor rotation behaviour  | `cursor.rotation`, `cursor.restAngle`             |
| the hit                    | `impact.squash`, `shake`, `dent`, `debris`, `shock` |
| the invitation             | `invite.pulse`, `halo`, `promptText`              |
| the break                  | `breach.fracture`, `hole`, `flex`, `hold`         |
| the handoff + CTA glow     | `handoff.rise`, `handoff.cta`, `handoff.scroll`, `handoff.glow` |
| overall pace               | `master.timeScale`                                |

Positions are fractions of the viewport and the final cursor position is
measured from the **actual** `"Start your site"` element (`.hero-actions
.btn--primary`, overridable via the `target` prop or `[data-intro-target]`), so
alignment stays pixel-true at every screen size — including short viewports,
where the sequence deliberately glides the page until the CTA is in view and the
captured cursor rides along.

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
  completely; scroll, navigation and the site's own `CursorJourney` behave
  exactly as they did before the intro existed.
- Inspect/tune live: `__wiDebug.state()`, `__wiDebug.config`,
  `__wiDebug.forceTimeScale(0.4)` (slow motion), `__wiDebug.skipToInvite()`.

## Deployment: Cloudflare Workers (static assets)

- **Framework preset:** `Astro`
- **Build command:** `npm run build` (runs `astro build` → `dist/client`)
- **Output / Assets directory:** `dist/client`
- **Deploy commands:**
  ```bash
  npm run build && npx wrangler deploy
  # or
  npm run cf:deploy
  npm run cf:dev   # local Workers preview with assets
  ```

`wrangler.jsonc` is configured for **assets-only Workers** (no Worker script, static SPA):

```jsonc
{
  "assets": { "directory": "./dist/client" },
  "compatibility_date": "2026-10-03",
  "compatibility_flags": ["nodejs_compat"]
}
```

> **Fixes for Cloudflare build errors:**
> - **`npx wrangler build` / “Could not detect static files”:** Do **not** use `npx wrangler build` as the build command. That command compiles a Worker and expects built assets before it runs, so it fails when `dist/client` doesn’t yet exist. Use **`npm run build`** instead. Astro generates `dist/client` (and `dist/client/_headers` for caching), then `wrangler deploy` uploads from that directory. If your dashboard is set to `npx wrangler build`, change it to `npm run build`.
> - **`Cannot use assets with a binding in an assets-only Worker`:** Remove the `assets.binding` (`\"ASSETS\"`) from `wrangler.jsonc` when no `main` Worker script is present. Assets-only Workers serve `dist/client` directly; a binding is only valid when you also provide a Worker (e.g. `main: \"./src/worker.ts\"`). Fixed by leaving `assets` as `{ \"directory\": \"./dist/client\" }`.
