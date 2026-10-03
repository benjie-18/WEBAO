# WEBAO — Artistic Direction

> **Goal:** Make WEBAO feel like a serious design studio, not a generic website-builder landing page.

The landing page should be **high-impact, memorable, and visually authored**. It should immediately communicate that WEBAO can produce websites with real art direction, not just interchangeable templates.

## Visual References

These references are about **feel, pacing, interaction, composition, and presentation** — not copying their designs.

- https://www.translate-wf.com/
  - Strong visual storytelling and scroll-driven presentation.
  - Oversized typography, large visual moments, movement, and interactive transitions.
  - Sections feel like part of a continuous experience rather than disconnected blocks.

- https://www.bakinatajna.com/
  - Strong use of photography/illustration, visual identity, and editorial composition.
  - Rich imagery can carry the brand instead of relying on generic UI decoration.
  - Product/content sections have distinct visual personalities.

- https://www.audemarspiguet.com/en/home
  - Premium editorial presentation with large imagery and restrained typography.
  - Strong sense of craft, spacing, hierarchy, and storytelling.
  - Individual content areas feel intentional and immersive.

## Landing Page

The home page is the **showcase piece** of WEBAO and should receive substantially more artistic attention than a normal marketing site.

### Expectations

- Custom-designed visual assets rather than generic stock decorations.
- Purposeful animations and micro-interactions.
- Smooth transitions between major sections.
- Strong typography and unusual but usable compositions.
- Large visual moments / hero artwork.
- Scroll-based storytelling where it genuinely improves the experience.
- Responsive behavior designed intentionally for desktop, tablet, and mobile — not simply scaled down.
- Motion should support hierarchy and storytelling, not become visual noise.
- Respect `prefers-reduced-motion`.
- Maintain excellent loading performance despite the visual ambition.

The page should have a clear **visual rhythm**: quiet moments, dense moments, large typography, imagery, whitespace, movement, and contrast should alternate rather than every section looking like the same card grid.

## Navigation / Agency Cards

The landing page should include prominent **cards or visual panels that present WEBAO and lead into the main areas of the site**.

Primary destinations:

- **Pricing** — `/pricing`
- **Contact** — `/contact`
- **Demos** — `/demos`

These should feel like designed components, not three ordinary CTA buttons.

Cards can use different compositions, hover states, imagery, motion, or typography while remaining part of the same WEBAO visual system.

## Pricing Page

The pricing page should look like a **professional agency pricing page**.

Requirements:

- Clear pricing hierarchy.
- Strong comparison between plans/services where applicable.
- Obvious inclusions and exclusions.
- Professional typography and spacing.
- Clear primary CTA leading to contact/onboarding.
- Mobile-friendly table/card behavior.
- Avoid looking like a generic SaaS pricing template.

The page should make the offer easy to understand before adding any decorative complexity.

## Contact Page

The contact page should feel **professional, trustworthy, and intentional**.

It should communicate that contacting WEBAO starts a real conversation about a website, rather than dumping the user into a generic form.

Use strong layout, clear information hierarchy, and appropriate supporting visuals/content. The interaction should be polished and confidence-inspiring.

## Demos

The demos exist to answer one question:

> **“What could my business's website actually look like?”**

They are not meant to be variations of one template.

### Demo Catalog

`/demos` should be a **searchable, filterable catalog** of all available demos.

The catalog should:

- Organize demos by business type/category.
- Support search.
- Support filtering.
- Show a strong visual preview of each demo.
- Make differences between demos immediately visible.
- Make it easy to open a demo and return to the catalog.

Possible categories include trades, restaurants, professional services, retail, health/wellness, creative businesses, hospitality, automotive, and other local businesses.

The catalog should be designed to accommodate many demos without becoming cluttered.

## Demo Design Rules

Every demo should be based on a **fictional company** and should represent a genuinely different design direction.

Do **not** create ten versions of the same website with a different accent color.

Variation should be obvious across:

- Typography.
- Color palette.
- Header/navigation style.
- Hero composition.
- Grid vs. editorial vs. asymmetric layouts.
- Section ordering.
- Card styles.
- Image treatment.
- Shape language.
- Spacing density.
- Button styles.
- Art direction.
- Overall tone.

Examples of possible directions:

- Clean contemporary trades company.
- Warm editorial restaurant.
- Minimal luxury service business.
- Bold modern construction company.
- Traditional professional/local business.
- Playful creative studio.
- Premium automotive service.
- Calm wellness/clinic brand.

These are **design directions**, not fixed templates. New demos should expand the visual range of the collection.

### Each Demo Is Its Own Website

A demo should feel like a believable standalone website for its fictional company.

Each one should have its own:

- Header/navigation.
- Brand treatment.
- Typography system.
- Homepage.
- Relevant sub-pages.
- Footer.
- Content structure.
- Visual language.

For example, a fictional electrician demo might have pages such as Home, Services, About, Service Area, and Contact, while a fictional restaurant could have Menu, Story, Reservations, and Location.

### Demo Restrictions

Demos are **examples only**.

Do not make them look like production WEBAO pages such as:

- `webao.ca/design1`
- `webao.ca/electrician-demo`

They should be treated as isolated fictional microsites/previews rather than part of WEBAO's primary website information architecture. The exact deployment/routing mechanism is an implementation decision, but the user experience should clearly distinguish the demo site from the WEBAO agency site.

Demos must **not** contain functional customer contact forms or imply that the fictional business is real.

Use clearly fictional:

- Company names.
- Addresses.
- Phone numbers.
- Email addresses.
- Reviews/testimonials.
- Service claims.
- Other business information.

Contact areas should use placeholders or clearly non-functional demo interactions.

## Demo Navigation Escape Hatch

Every demo should have a **small, unobtrusive corner control** that lets visitors leave the demo easily.

It should provide a route back to either:

1. the WEBAO home page, or
2. the WEBAO demo catalog.

This control must remain discoverable without overpowering the fictional website's own design.

## Asset Direction

Prefer **custom assets and art-directed visuals** whenever practical.

Possible assets include:

- Custom illustrations.
- Abstract shapes/textures.
- Brand-specific icons.
- Editorial graphics.
- Custom mockups.
- Product/service imagery.
- Generated or commissioned visual assets.
- Subtle decorative elements tied to each demo's identity.

Assets should have a reason to exist. Avoid adding random blobs, gradients, floating objects, or decorative noise simply to make the page look “modern.”

## Motion Direction

Animation should feel **intentional and premium**.

Good uses:

- Entrance/reveal sequences.
- Scroll-linked storytelling.
- Image transitions.
- Typography movement.
- Hover interactions.
- Navigation transitions.
- Subtle parallax/depth.
- Shared-element transitions where appropriate.

Avoid:

- Constant movement everywhere.
- Long blocking animations.
- Excessive bounce/easing.
- Motion that makes text difficult to read.
- Animation that significantly harms performance.

## Design System vs. Demo Freedom

WEBAO itself should have a recognizable visual identity, but the demos should have considerable freedom.

Think of the relationship as:

**WEBAO = the design studio.**  
**Demos = different designers/projects in the studio's portfolio.**

The catalog and agency pages should feel cohesive. Individual demos should be allowed to break away from that system as long as they remain polished, usable, and believable.

## Quality Bar

Before considering a page complete, ask:

- Does this look custom-designed?
- Would a real business be proud to use this?
- Is the visual hierarchy obvious?
- Does the page have a memorable visual idea?
- Are the animations helping rather than distracting?
- Does mobile feel intentionally designed?
- Is the content believable?
- Is the design sufficiently different from the other demos?
- Does it still load and function like a professional production website?

**The goal is not maximum effects. The goal is maximum perceived quality and craft.**
