# Intro animation — archived

The WEBAO landing page's signature intro ("The Signature Handoff"):
a cursor flies in, hits a barrier, bounces, invites the click, breaks
through and hands the visitor to the primary CTA.

## Status

Archived 2026-11-22. Nothing in this folder is referenced by any page,
so the intro never plays. It is kept here so a developer can restore it.

## Contents

- `IntroSequence.astro` — the component (was `src/components/anim/IntroSequence.astro`)
- `config.ts` — every artistic decision as an editable number (was `src/lib/intro/config.ts`)
- `engine.ts` — the clock/tween scheduler and physics helpers (was `src/lib/intro/engine.ts`)
- `intro-engine.test.ts` — the engine's unit tests (was `tests/intro-engine.test.ts`)

The imports inside these files were re-pointed at each other (`./config`,
`./engine`), so the folder is coherent as it stands. The `../../lib/i18n`
import in the component still resolves.

The folder is excluded from typecheck (`src/archive` in `tsconfig.json`):
archived code must not gate the build. Run the archived test by hand
with `npx tsx --test src/archive/intro-animation/intro-engine.test.ts`
if you ever need to prove the engine still works.

## How to restore

1. Move the three source files back to their original locations and the
   test back to `tests/`.
2. In `src/pages/index.astro` and `src/pages/fr/index.astro`, re-add
   `import IntroSequence from "../components/anim/IntroSequence.astro";`
   (FR: `../../components/anim/IntroSequence.astro`) and render
   `<IntroSequence slot="overlay" locale={locale} />` inside `BaseLayout`.
3. In `src/layouts/BaseLayout.astro`, re-add the `overlay` slot outside
   `<main>`: `<slot name="overlay" />`.
4. The hero entrance in `src/components/pages/HomePage.astro`
   (`initHeroEntrance`) already waits for `.wi-released` while `.wi-run`
   is on `<html>`, so the handoff works again with no further changes.
5. Run the gates: `npm test`, `npx tsc --noEmit -p worker/tsconfig.json`,
   `npm run check`, `npm run build`.
