/**
 * WEBAO — Intro motion engine
 * ----------------------------------------------------------------------------
 * A deliberately tiny motion toolkit so the intro ships **zero animation
 * dependencies** (the project's stated convention: transform/opacity only, no
 * GSAP/Framer in the bundle). It gives us the three things the choreography
 * actually needs, and nothing else:
 *
 *   1. a scheduling clock    → `after()` / `tween()` driven by one rAF loop
 *   2. authored easing       → classic curves + normalised *speed profiles*
 *   3. physical helpers      → damped springs, angle smoothing, Catmull-Rom
 *
 * Everything is deterministic and frame-rate independent (all smoothing is
 * expressed as `1 - exp(-k·dt)`), so the sequence feels identical at 60, 90
 * and 120 Hz.
 */

/* --------------------------------------------------------------- utilities */

export const clamp = (v: number, min: number, max: number) => (v < min ? min : v > max ? max : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smoothstep = (t: number) => t * t * (3 - 2 * t);
export const mapRange = (v: number, a: number, b: number, c: number, d: number) =>
  b === a ? c : c + ((v - a) / (b - a)) * (d - c);

/** Frame-rate independent smoothing factor: 1 - e^(-rate·dt). */
export const smoothing = (rate: number, dt: number) => 1 - Math.exp(-rate * Math.max(dt, 0));

/** Shortest signed delta between two angles, in degrees. */
export const angleDelta = (from: number, to: number) => ((((to - from) % 360) + 540) % 360) - 180;

export const damp = (current: number, target: number, lambda: number, dt: number) =>
  lerp(current, target, smoothing(lambda, dt));

/** Deterministic pseudo-random so the fracture looks authored, not noisy. */
export function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ easing */

export type Ease = (t: number) => number;

const c1 = 1.70158;
const c3 = c1 + 1;

export const EASE = {
  linear: (t: number) => t,
  inSine: (t: number) => 1 - Math.cos((t * Math.PI) / 2),
  outSine: (t: number) => Math.sin((t * Math.PI) / 2),
  inOutSine: (t: number) => -(Math.cos(Math.PI * t) - 1) / 2,
  inQuad: (t: number) => t * t,
  outQuad: (t: number) => 1 - (1 - t) * (1 - t),
  inOutQuad: (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
  inCubic: (t: number) => t * t * t,
  outCubic: (t: number) => 1 - Math.pow(1 - t, 3),
  inOutCubic: (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  inQuart: (t: number) => t * t * t * t,
  outQuart: (t: number) => 1 - Math.pow(1 - t, 4),
  inOutQuart: (t: number) => (t < 0.5 ? 8 * t * t * t * t : 1 - Math.pow(-2 * t + 2, 4) / 2),
  inQuint: (t: number) => t * t * t * t * t,
  outQuint: (t: number) => 1 - Math.pow(1 - t, 5),
  inOutQuint: (t: number) => (t < 0.5 ? 16 * t * t * t * t * t : 1 - Math.pow(-2 * t + 2, 5) / 2),
  inExpo: (t: number) => (t === 0 ? 0 : Math.pow(2, 10 * t - 10)),
  outExpo: (t: number) => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  inOutExpo: (t: number) =>
    t === 0 ? 0 : t === 1 ? 1 : t < 0.5 ? Math.pow(2, 20 * t - 10) / 2 : (2 - Math.pow(2, -20 * t + 10)) / 2,
  outBack: (t: number) => 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2),
  inOutBack: (t: number) =>
    t < 0.5
      ? (Math.pow(2 * t, 2) * ((c1 + 1) * 2 * t - c1)) / 2
      : (Math.pow(2 * t - 2, 2) * ((c1 + 1) * (t * 2 - 2) + c1) + 2) / 2,
} satisfies Record<string, Ease>;

export type EaseName = keyof typeof EASE;

export const resolveEase = (e: EaseName | Ease): Ease => (typeof e === "function" ? e : (EASE[e] ?? EASE.linear));

/**
 * Turns an authored [[t, relativeSpeed]] table into an easing function.
 * The area under the curve is normalised, so the result always runs 0 → 1 on
 * 0 → 1 while *feeling* like the requested speed profile. This is how the dive
 * can start already flying, glide through the middle and slam at the end.
 */
export function speedProfile(points: readonly (readonly [number, number])[], samples = 96): Ease {
  const pts = [...points].sort((a, b) => a[0] - b[0]);
  if (pts.length < 2) return EASE.linear;
  if (pts[0][0] > 0) pts.unshift([0, pts[0][1]]);
  if (pts[pts.length - 1][0] < 1) pts.push([1, pts[pts.length - 1][1]]);

  const speedAt = (t: number) => {
    let i = 0;
    while (i < pts.length - 2 && t > pts[i + 1][0]) i++;
    const [t0, v0] = pts[i];
    const [t1, v1] = pts[i + 1];
    const k = t1 === t0 ? 0 : (t - t0) / (t1 - t0);
    return lerp(v0, v1, k);
  };

  // cumulative distance table → position is the integral of the speed profile
  const table = new Float64Array(samples + 1);
  let total = 0;
  for (let i = 1; i <= samples; i++) {
    const t0 = (i - 1) / samples;
    const t1 = i / samples;
    const mid = (t0 + t1) / 2;
    total += speedAt(mid) * (t1 - t0);
    table[i] = total;
  }
  if (total <= 0) return EASE.linear;
  for (let i = 0; i <= samples; i++) table[i] /= total;

  return (t: number) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    const x = t * samples;
    const i = Math.floor(x);
    const k = x - i;
    return lerp(table[i], table[i + 1] ?? 1, k);
  };
}

/* ------------------------------------------------------------------- curves */

export type Pt = { x: number; y: number };

/**
 * Catmull-Rom through the author's waypoints → smooth, C1-continuous curve.
 * `t` is the normalised arc parameter (0..1 across all segments).
 */
export function curveSampler(points: readonly Pt[], tension = 0.5) {
  const p = points.map((v) => ({ x: v.x, y: v.y }));
  if (p.length < 2) return () => ({ ...p[0] ?? { x: 0, y: 0 } });
  const segs = p.length - 1;
  const ctrl = (i: number, k: number): Pt => {
    const a = p[clamp(i - 1, 0, p.length - 1)];
    const b = p[clamp(i + k, 0, p.length - 1)];
    return { x: (b.x - a.x) * tension, y: (b.y - a.y) * tension };
  };
  return (t: number) => {
    const u = clamp(t, 0, 1) * segs;
    const i = Math.min(Math.floor(u), segs - 1);
    const k = u - i;
    const p0 = p[i];
    const p1 = p[i + 1];
    const m0 = ctrl(i, 1);
    const m1 = ctrl(i + 1, 1);
    const k2 = k * k;
    const k3 = k2 * k;
    const h00 = 2 * k3 - 3 * k2 + 1;
    const h10 = k3 - 2 * k2 + k;
    const h01 = -2 * k3 + 3 * k2;
    const h11 = k3 - k2;
    return {
      x: h00 * p0.x + h10 * m0.x + h01 * p1.x + h11 * m1.x,
      y: h00 * p0.y + h10 * m0.y + h01 * p1.y + h11 * m1.y,
    };
  };
}

/* ------------------------------------------------------------------- clock */

type Task = { at: number; fn: () => void; id: number };
type FrameFn = (dt: number, elapsed: number) => void;

export class Tween {
  killed = false;
  private start: number;
  private delay: number;
  /** Duration in SECONDS — the clock's unit. (`ms` is given in milliseconds.) */
  private duration: number;
  private ease: Ease;
  private onUpdate?: (v: number, dt: number) => void;
  private onComplete?: () => void;
  private done = false;

  constructor(
    clock: Clock,
    opts: {
      /** Delay before the tween starts, in seconds (scaled time). */
      delay?: number;
      /** Duration in milliseconds. */
      ms: number;
      ease?: EaseName | Ease;
      onUpdate?: (v: number, dt: number) => void;
      onComplete?: () => void;
    }
  ) {
    this.delay = opts.delay ?? 0;
    this.duration = Math.max(opts.ms, 0.1) / 1000;
    this.ease = resolveEase(opts.ease ?? "linear");
    this.onUpdate = opts.onUpdate;
    this.onComplete = opts.onComplete;
    this.start = clock.time + this.delay;
  }

  kill() {
    this.killed = true;
  }

  /** @internal */
  step(now: number, dt: number) {
    if (this.killed || this.done) return true;
    const raw = (now - this.start) / this.duration;
    if (raw < 0) return false;
    const v = this.ease(clamp(raw, 0, 1));
    this.onUpdate?.(v, dt);
    if (raw >= 1) {
      this.done = true;
      this.onComplete?.();
      return true;
    }
    return false;
  }
}

export class Clock {
  time = 0;
  scale = 1;
  private tasks: Task[] = [];
  private tweens = new Set<Tween>();
  private frames = new Set<FrameFn>();
  private id = 0;

  get visible() {
    return this.tweens.size + this.tasks.length + this.frames.size;
  }

  /** Schedule once, `delay` seconds from now (scaled time). */
  after(delay: number, fn: () => void) {
    this.tasks.push({ at: this.time + delay, fn, id: this.id++ });
    this.tasks.sort((a, b) => a.at - b.at);
    return () => {
      this.tasks = this.tasks.filter((t) => t.fn !== fn);
    };
  }

  onFrame(fn: FrameFn) {
    this.frames.add(fn);
    return () => this.frames.delete(fn);
  }

  tween(opts: ConstructorParameters<typeof Tween>[1]) {
    const tw = new Tween(this, opts);
    this.tweens.add(tw);
    return tw;
  }

  /** Drop everything still scheduled (used when tearing the intro down). */
  reset() {
    this.tasks.length = 0;
    this.tweens.clear();
    this.frames.clear();
  }

  /**
   * Advance the world. `rawDt` is real seconds; scaling happens here.
   * The clamp keeps a single hitch from teleporting the animation; because all
   * physics runs in fixed substeps, a generous clamp is safe *and* it means the
   * sequence still keeps real time on a slow device.
   */
  static readonly MAX_STEP = 1 / 12;
  tick(rawDt: number) {
    const dt = clamp(rawDt, 0, Clock.MAX_STEP) * this.scale;
    this.time += dt;
    const now = this.time;

    // dispatch due tasks (guarded: a task may schedule more tasks)
    while (this.tasks.length && this.tasks[0].at <= now) {
      const task = this.tasks.shift()!;
      task.fn();
    }
    for (const tw of [...this.tweens]) {
      if (tw.step(now, dt)) this.tweens.delete(tw);
    }
    for (const fn of this.frames) fn(dt, now);
  }

  get empty() {
    return this.tasks.length === 0 && this.tweens.size === 0;
  }
}

/* ------------------------------------------------------------------ physics */

/**
 * Fixed-timestep substepping. Springs integrated with the raw frame delta go
 * soft on 120 Hz displays and can go unstable on slow frames; stepping the
 * physics in 1/120 s slices keeps the *feel* identical everywhere.
 */
export function substep(dt: number, fn: (h: number) => boolean | void, step = 1 / 120) {
  let remaining = dt;
  let guard = 0;
  while (remaining > 1e-5 && guard++ < 64) {
    const h = Math.min(step, remaining);
    if (fn(h) === false) return;
    remaining -= h;
  }
}

/**
 * Tracking spring: chases a (possibly moving) target with real inertia.
 * Feeding the target's velocity into the damper — instead of assuming a static
 * target — is what removes the rubber-band lag and lets the pointer *lean out
 * of corners* instead of sliding behind the curve.
 */
export function track(
  s: { x: number; y: number; vx: number; vy: number },
  tx: number,
  ty: number,
  tvx: number,
  tvy: number,
  stiffness: number,
  damping: number,
  maxSpeed: number,
  dt: number
) {
  const omega = Math.sqrt(stiffness);
  s.vx += ((tx - s.x) * stiffness + 2 * damping * omega * (tvx - s.vx)) * dt;
  s.vy += ((ty - s.y) * stiffness + 2 * damping * omega * (tvy - s.vy)) * dt;
  const sp = Math.hypot(s.vx, s.vy);
  if (sp > maxSpeed) {
    const k = maxSpeed / sp;
    s.vx *= k;
    s.vy *= k;
  }
  s.x += s.vx * dt;
  s.y += s.vy * dt;
  return sp;
}

/** Semi-implicit spring step. `damping` 1 = critically damped, <1 = bouncy. */
export function springStep(
  state: { x: number; y: number; vx: number; vy: number },
  tx: number,
  ty: number,
  stiffness: number,
  damping: number,
  maxSpeed: number,
  dt: number
) {
  const ax = (tx - state.x) * stiffness - state.vx * 2 * Math.sqrt(stiffness) * damping;
  const ay = (ty - state.y) * stiffness - state.vy * 2 * Math.sqrt(stiffness) * damping;
  state.vx += ax * dt;
  state.vy += ay * dt;
  const sp = Math.hypot(state.vx, state.vy);
  if (sp > maxSpeed) {
    const k = maxSpeed / sp;
    state.vx *= k;
    state.vy *= k;
  }
  state.x += state.vx * dt;
  state.y += state.vy * dt;
  return sp;
}

/* ------------------------------------------------------------------- debris */

type Shard = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  vrot: number;
  w: number;
  h: number;
  life: number;
  maxLife: number;
  color: string;
  sliver: boolean;
};

/**
 * Canvas debris field. Starts on demand, stops itself when the last fragment
 * dies, so nothing keeps running (and nothing paints) after the intro.
 */
export class Debris {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private shards: Shard[] = [];
  private dpr = 1;
  private floorY = 0;
  private rng: () => number;
  private palette: readonly string[];
  private painted = false;
  private dirty = { x0: 0, y0: 0, x1: 0, y1: 0 };

  constructor(canvas: HTMLCanvasElement, palette: readonly string[], seed = 7) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: true });
    this.palette = palette;
    this.rng = mulberry(seed);
  }

  get count() {
    return this.shards.length;
  }

  resize(w: number, h: number, floorY: number, dprCap = 2) {
    this.dpr = Math.min(window.devicePixelRatio || 1, dprCap);
    this.canvas.width = Math.max(1, Math.round(w * this.dpr));
    this.canvas.height = Math.max(1, Math.round(h * this.dpr));
    this.floorY = floorY;
  }

  burst(
    x: number,
    y: number,
    count: number,
    opts: { speed: readonly [number, number]; spreadDeg: readonly [number, number]; lifeMs: readonly [number, number]; size: readonly [number, number] }
  ) {
    const [s0, s1] = opts.speed;
    const [a0, a1] = opts.spreadDeg;
    const [l0, l1] = opts.lifeMs;
    const [z0, z1] = opts.size;
    for (let i = 0; i < count; i++) {
      const a = ((lerp(a0, a1, this.rng()) + (this.rng() - 0.5) * 16) * Math.PI) / 180;
      const sp = lerp(s0, s1, this.rng() ** 1.35);
      const sliver = this.rng() > 0.62;
      const size = lerp(z0, z1, this.rng());
      this.shards.push({
        x,
        y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        rot: this.rng() * Math.PI * 2,
        vrot: (this.rng() - 0.5) * 14,
        w: sliver ? size * 2.6 : size,
        h: sliver ? Math.max(1, size * 0.42) : size * lerp(0.6, 1, this.rng()),
        life: 0,
        maxLife: lerp(l0, l1, this.rng()) / 1000,
        color: this.palette[Math.floor(this.rng() * this.palette.length)] ?? "#0A0F1C",
        sliver,
      });
    }
  }

  step(dt: number) {
    const ctx = this.ctx;
    if (!ctx) return;
    const wipe = () => {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const d = this.dirty;
      ctx.clearRect(
        Math.floor(d.x0) - 2,
        Math.floor(d.y0) - 2,
        Math.ceil(d.x1 - d.x0) + 6,
        Math.ceil(d.y1 - d.y0) + 6
      );
      this.dirty = { x0: 1e9, y0: 1e9, x1: -1e9, y1: -1e9 };
      this.painted = false;
    };
    if (!this.shards.length) {
      // one final wipe of the dirty region, then the canvas costs nothing
      if (this.painted) wipe();
      return;
    }
    // only the region that changed is cleared: a full-viewport clearRect at
    // DPR 2 is a multi-megapixel fill every single frame
    if (this.painted) wipe();
    else this.dirty = { x0: 1e9, y0: 1e9, x1: -1e9, y1: -1e9 };
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const track = (x: number, y: number, pad: number) => {
      const d = this.dirty;
      d.x0 = Math.min(d.x0, (x - pad) * this.dpr);
      d.y0 = Math.min(d.y0, (y - pad) * this.dpr);
      d.x1 = Math.max(d.x1, (x + pad) * this.dpr);
      d.y1 = Math.max(d.y1, (y + pad) * this.dpr);
    };
    this.painted = true;
    const gravity = 2500;
    const drag = 0.86;
    for (let i = this.shards.length - 1; i >= 0; i--) {
      const s = this.shards[i];
      s.life += dt;
      if (s.life >= s.maxLife) {
        this.shards.splice(i, 1);
        continue;
      }
      s.vy += gravity * dt;
      const d = Math.pow(drag, dt * 60);
      s.vx *= d;
      s.vy *= d;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.rot += s.vrot * dt;
      // settle on the barrier lip instead of falling through it
      if (s.y > this.floorY) {
        s.y = this.floorY;
        s.vy *= -0.34;
        s.vx *= 0.7;
        s.vrot *= 0.5;
        if (Math.abs(s.vy) < 26) {
          s.vy = 0;
          s.vrot = 0;
        }
      }
      const k = s.life / s.maxLife;
      const alpha = k < 0.72 ? 1 : 1 - (k - 0.72) / 0.28;
      track(s.x, s.y, Math.max(s.w, s.h) * 1.6 + 4);
      ctx.save();
      ctx.globalAlpha = Math.max(alpha, 0) * 0.95;
      ctx.translate(s.x, s.y);
      ctx.rotate(s.rot);
      ctx.fillStyle = s.color;
      if (s.sliver) {
        ctx.fillRect(-s.w / 2, -s.h / 2, s.w, s.h);
      } else {
        ctx.beginPath();
        ctx.moveTo(-s.w / 2, s.h / 2);
        ctx.lineTo(s.w / 2, s.h / 2 - s.h * 0.24);
        ctx.lineTo(s.w * 0.12, -s.h / 2);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    }
  }

  clear() {
    this.shards.length = 0;
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.painted = false;
    this.dirty = { x0: 1e9, y0: 1e9, x1: -1e9, y1: -1e9 };
  }
}
