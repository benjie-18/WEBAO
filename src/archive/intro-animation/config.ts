/**
 * WEBAO — Intro Sequence ("The Signature Handoff")
 * ----------------------------------------------------------------------------
 * Every artistic decision in the intro is an editable number in this file.
 * Nothing in the component is hard-coded, so the choreography can be re-timed,
 * re-aimed, softened or exaggerated without touching the animation logic.
 *
 * Units
 *   • durations / delays  → seconds (scaled by `timeScale`)
 *   • positions           → fractions of the viewport (0..1), so everything is
 *                           responsive by construction
 *   • pixels              → CSS px (DPR-agnostic, scrubbed on resize)
 *
 * Editing guide
 *   timing      → `beats`            (when each phase of the story happens)
 *   the flight  → `flight`           (path + speed profile + inertia)
 *   the hit     → `impact`           (squash, shake, dent, debris)
 *   the bounce  → `bounce`           (real gravity + restitution)
 *   the invite  → `invite`           (pulse, prompt, pointer follow)
 *   the break   → `breach`           (fracture, hole, curtain, content rise)
 *   the handoff → `handoff`          (CTA lock-on, glow pulse, release)
 */

export type Frac = { x: number; y: number };

export const INTRO_CONFIG = {
  /* ---------------------------------------------------------------- master */
  /**
   * Note: `sessionKey`, `failsafeMs` and the `?intro=` switch are mirrored in
   * the tiny inline boot gate at the top of `IntroSequence.astro` (it has to run
   * before the page is parsed, so it cannot import this file). Keep them in sync.
   */
  master: {
    /** Global time multiplier for the whole sequence. 1 = as art-directed. */
    timeScale: 1,
    /** Time multiplier used when a visitor interacts before being invited. */
    rushScale: 3.6,
    /** Run the intro again in the same tab even if it has already played. */
    replay: false,
    /** sessionStorage key that remembers the visitor has seen the intro. */
    sessionKey: "webao.intro.seen.v1",
    /** If the module never boots, the inline failsafe releases the page. */
    failsafeMs: 7000,
  },

  /* ------------------------------------------------------------- composition */
  layout: {
    /** The barrier (studio floor) — height in CSS px, min → max. */
    floorHeight: { min: 52, ideal: 0.088, max: 92 }, // ideal = fraction of vh
    /** Height of the deformable lip drawn on top of the barrier, in px. */
    lipHeight: 46,
    /** Where the cursor comes to rest between the bounce and the click. */
    settle: { x: 0.5, y: 0.625 },
    /** Faint technical crosshair on the veil (fades before the invite). */
    crosshair: true,
    /** Frame captions on the veil. */
    caption: { brand: "WEBAO", left: "WEBAO · WEBAO.CA", right: "STUDIO · MONTRÉAL" },
  },

  /* ------------------------------------------------------------------ cursor */
  cursor: {
    /** Cursor size multiplier: [min, max] mapped over the viewport size. */
    scale: { min: 0.62, max: 1 },
    /** Screen angle (deg) the arrow head points at rest. -135 = up-left. */
    restAngle: -135,
    /** Velocity-derived rotation smoothing. */
    rotation: {
      rateFlying: 10.5, // 1/s — softer tracking keeps the arrow easy to follow
      rateSettling: 6.8, // 1/s — deliberate return to its resting angle
      rateLooking: 4.8, // 1/s — slow, readable glance toward the barrier
      rateApproaching: 5.4, // 1/s — the final CTA landing feels guided, not snapped
      restBelowSpeed: 110, // px/s — under this the head eases to restAngle
      maxDegPerFrame: 26, // safety clamp so it can never spin unnaturally
    },
    /** Motion smear: the pointer stretches along its travel axis. */
    stretch: { perSpeed: 1 / 2100, max: 0.38, relax: 9 },
    /** Ghost copies left behind while flying (motion blur trail). */
    trail: {
      delaysMs: [26, 56, 92],
      opacity: [0.22, 0.13, 0.07],
      blur: [1.1, 2.3, 3.6],
      /** Speed (px/s) at which the trail reaches full strength. */
      reference: 1250,
    },
    /** Contact shadow, scales with the cursor's height above the barrier. */
    shadow: { max: 8, min: 2.4, altitude: 340 },
    /** Mirror reflection on the barrier's glossy lip. */
    reflection: { opacity: 0.16, squash: 0.74, near: 220 },
  },

  /* ------------------------------------------------------------------ flight */
  flight: {
    /**
     * Reference path the cursor chases — an authored curve, not a tween.
     * The route eases into the frame, makes one broad, readable sweep, then
     * deliberately settles just above the barrier for a beat before the first
     * gentle test impact.
     */
    path: [
      { x: -0.1, y: -0.18 }, // unhurried entry from just outside the frame
      { x: 0.18, y: 0.12 }, // first visible arc
      { x: 0.72, y: 0.25 }, // a broad, easy-to-follow sweep
      { x: 0.82, y: 0.46 }, // soften the corner instead of snapping across it
      { x: 0.64, y: 0.66 }, // turn back toward the barrier
      { x: 0.56, y: 0.79 }, // inspection position, above the surface
    ] as Frac[],
    /** Curve sampling: higher = tighter tracking of the authored path. */
    pathTension: 0.42,
    /** Duration of the whole chase (seconds), before the barrier is inspected. */
    duration: 2.05,
    /** Slow at both ends: ease into the frame and settle before the first hit. */
    speedProfile: [
      [0, 0.16],
      [0.12, 0.48],
      [0.34, 0.86],
      [0.58, 1.02],
      [0.76, 0.86],
      [0.91, 0.48],
      [1, 0.16],
    ] as [number, number][],
    /** Pause for a quiet look, then approach the surface for a soft first tap. */
    lookMs: 720,
    firstHit: { stiffness: 148, damping: 0.88, maxSpeed: 1900 },
    /** Inertia of the pointer while it chases the curve. */
    chase: {
      stiffness: 92, // gentler spring makes each direction change legible
      damping: 0.9, // less overshoot, more intentional movement
      maxSpeed: 3600, // px/s
      entryVelocity: { x: 0.28, y: 0.16 }, // × viewport / s; a soft arrival
    },
  },

  /* ------------------------------------------------------------------ impact */
  impact: {
    /** Squash along the travel axis / bulge across it. */
    squash: { along: 0.66, across: 1.24, ms: 96, recoverMs: 420 },
    /** Screen shake: amplitude in px, duration, rotation in deg. */
    shake: { amp: 11, ms: 460, rotDeg: 0.34, freq: 26 },
    /** The barrier's lip deforms and springs back. */
    dent: { depth: 30, sigma: 0.052, ms: 760 }, // sigma = fraction of width
    /** Debris burst. */
    debris: {
      count: 26,
      speed: [140, 780],
      spreadDeg: [-168, -12], // mostly upward, off the surface
      lifeMs: [560, 1250],
      size: [1.6, 5.2],
    },
    /** Expanding shock ellipse on the surface. */
    shock: { width: 0.42, ms: 520, alpha: 0.4 },
    /** Very short surface flash at the contact point. */
    flash: 0.18,
    /** Restitution for the bounce off the barrier (0..1). */
    restitution: 0.62,
    /** How much sideways momentum survives the hit (tangential loss). */
    deflection: 0.3,
  },

  /* ------------------------------------------------------------------ bounce */
  bounce: {
    gravity: 2500, // px/s²
    /** Horizontal spring pulling the rebound back to the settle lane. */
    drift: 6,
    driftDamping: 0.92,
    /** When to hand over to the settle spring, as a multiple of the arc time. */
    arcHold: 1.2,
    arcMin: 0.72,
    arcMax: 1.35,
    /** Beat between arriving in the settle pose and the invitation. */
    settleHold: 0.34,
    /** A quiet, readable thinking pause before the invitation appears. */
    thinkMs: 660,
    thinkBobPx: 2.5,
    /** Small second tap on the floor before it settles. */
    secondTap: { enabled: true, restitution: 0.19 },
    /** Critically damped arrival at the settle point. */
    settle: { stiffness: 58, damping: 1, maxSpeed: 2600 },
    /** Length of the free arc before the settle spring takes over. */
    arc: 0.72,
  },

  /* ------------------------------------------------------------------ invite */
  invite: {
    promptDelay: 0.42, // s after the cursor settles
    promptFade: 0.5,
    /** Restrained interaction cue: a slow halo breath + a thin pulse ring. */
    pulse: { periodMs: 2050, maxScale: 2.5, alpha: 0.36, loops: 2 },
    halo: { min: 0.05, max: 0.13, periodMs: 4600 },
    /** Prompt follows the pointer during the invitation (softly). */
    follow: { lerp: 0.2, settleLerp: 0.1 },
    promptOffset: { x: 20, y: -34 }, // px from the cursor tip
    promptText: { pointer: "Click to enter", touch: "Tap to enter", key: "Enter" },
  },

  /* ------------------------------------------------------------------ breach */
  breach: {
    /** Wind-up: the cursor takes a small step back before launching. */
    prepare: { moveMs: 520, holdMs: 180, stepBackX: 0.045, stepBackY: 0.1 },
    /** The plunge: a committed, accelerating second dive. */
    plunge: { stiffness: 96, damping: 0.88, maxSpeed: 4600 },
    /** Let the fracture read before the site starts rising. */
    hold: 0.38,
    /** Camera move is eased in/out, keeping the contact point near center. */
    camera: { focusY: 0.58, shiftMs: 360, returnMs: 1050 },
    /** Fracture. */
    fracture: {
      pieces: 7, // seven irregular slabs instead of three wide panels
      jitter: 11, // px of jaggedness along each fracture edge
      cracks: 7, // crack flash lines drawn from the impact point
      crackMs: 240,
      pieceMs: 1180,
      staggerMs: 28,
      drift: { x: 0.12, y: 0.1, rot: 24 }, // exit margin / viewport / degrees
    },
    debris: {
      count: 54,
      speed: [240, 1350],
      spreadDeg: [-198, 18],
      lifeMs: [700, 1650],
      size: [1.8, 7],
    },
    shake: { amp: 12, ms: 520, rotDeg: 0.34, freq: 21 },
    /** The hole torn in the veil — the landing page shows through it. */
    hole: { ms: 1120, overshoot: 1.45, ease: "inOutCubic" },
    /** The veil flexes as the cursor punches through, then springs back. */
    flex: { y: 12, ms: 560 },
  },

  /* ----------------------------------------------------------------- handoff */
  handoff: {
    /** The landing page rises into place (never a scrollTo jump). */
    rise: {
      duration: 1.55,
      /** Deliberate start · sustained glide · soft landing. */
      profile: [
        [0, 0.22],
        [0.14, 1],
        [0.68, 0.94],
        [1, 0.1],
      ] as [number, number][],
      /** Header leads the content slightly (layered dolly). */
      headerLead: 1.07,
      /** Veil dissolves over this slice of the rise. */
      veil: [0.3, 0.92] as [number, number],
      /** Hero reveal timing is left to the page's own reveal system. */
    },
    /** The cursor is captured by the real CTA — computed, never hard-coded. */
    cta: {
      /** Primary target inside the hero. */
      selector: '.hero-actions .btn--primary, [data-intro-target], a[href="/contact"].btn--primary',
      /** Anchor within the button's box (0..1) where the tip should land. */
      anchor: { x: 0.5, y: 0.56 },
      /** Spring that locks the tip onto the button, ramped across the rise. */
      lock: { stiffnessFrom: 15, stiffnessTo: 92, damping: 0.94, maxSpeed: 6200 },
      /** Leave a small, visible gap for the cursor's final guided approach. */
      captureRemaining: 0.22,
      /** Slow travel from the open break to the real CTA after the page lands. */
      approachMs: 1080,
      /** Spring that absorbs the leftover dive energy during the capture. */
      wobbleStiffness: 30,
      /** Tiny landing acknowledgement (scale dip), 1 = off. */
      landing: { dip: 0.97, ms: 300 },
    },
    /**
     * On short viewports the CTA can sit below the fold. Instead of dropping the
     * cursor off-screen we glide the page until the button is comfortably in
     * view — the captured cursor simply rides along with it. This is also the
     * "slow, deliberate scroll" the sequence ends on.
     */
    scroll: { ms: 950, ease: "inOutCubic", band: [0.22, 0.9], focus: 0.58, min: 6 },
    /** The restrained glow that hands attention to the CTA. */
    glow: { periodMs: 1500, alpha: 0.12, ringAlpha: 0.2, ringScale: 1.85 },
    /** How long the cursor rests on the CTA before it dissolves (ends early
     *  if the visitor starts interacting with the page). */
    restMs: 3000,
    fadeMs: 0.62,
  },

  /* ----------------------------------------------------------- reduced motion */
  reduced: {
    /** Static, instant-into-the-site fallback (no flight, no cursor). */
    fadeMs: 0.36,
  },

  /* ------------------------------------------------------------------ colour */
  palette: {
    paper: "#F8F5EF",
    ink: "#0A0F1C",
    ink2: "#2A354A",
    accent: "#FF3B30",
    /** Debris colours, weighted by repetition. */
    debris: ["#0A0F1C", "#0A0F1C", "#2A354A", "#0A0F1C", "#FF3B30", "#F8F5EF"],
  },
  /**
   * Dark-theme art direction for the intro: the veil becomes deep black, the
   * cursor arrow inverts to paper with a dark outline, and the accent (halo,
   * final CTA glow, pulse rings) switches to electric blue. Selected at boot
   * from `document.documentElement.dataset.theme`.
   */
  paletteDark: {
    paper: "#05070D",
    ink: "#F8F5EF",
    ink2: "#8A96A8",
    accent: "#0043E0",
    /** Debris colours, weighted by repetition (light shards + blue sparks). */
    debris: ["#F8F5EF", "#F8F5EF", "#8A96A8", "#0043E0", "#F8F5EF", "#0043E0"],
  },
} as const;

