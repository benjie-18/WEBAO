// The intro animation engine: pure math, the clock/tween scheduler and the
// physics helpers that everything on the landing page is built from.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  Clock,
  Debris,
  EASE,
  Tween,
  clamp,
  curveSampler,
  damp,
  lerp,
  mulberry,
  resolveEase,
  smoothing,
  smoothstep,
  speedProfile,
  springStep,
  substep,
  track,
} from '../src/lib/intro/engine';

test('clamp, lerp, smoothstep and damp behave like the primitives they wrap', () => {
  assert.equal(clamp(5, 0, 1), 1);
  assert.equal(clamp(-5, 0, 1), 0);
  assert.equal(clamp(0.5, 0, 1), 0.5);
  assert.equal(lerp(10, 20, 0), 10);
  assert.equal(lerp(10, 20, 1), 20);
  assert.equal(lerp(10, 20, 0.25), 12.5);
  assert.equal(smoothstep(0), 0);
  assert.equal(smoothstep(1), 1);
  assert.equal(smoothstep(0.5), 0.5);
  assert.ok(smoothstep(0.25) < 0.25, 'eases in');

  assert.equal(smoothing(12, 0), 0);
  assert.ok(smoothing(12, 1) > 0.99 && smoothing(12, 1) <= 1, 'approaches 1 without overshooting');
  assert.ok(smoothing(12, 0.1) < smoothing(12, 0.5), 'monotonic in dt');

  const toward = damp(0, 10, 12, 0.1);
  assert.ok(toward > 0 && toward < 10, 'moves toward the target');
  assert.ok(damp(0, 10, 12, 10) > toward, 'bigger steps get closer');
  assert.equal(damp(10, 10, 12, 0.1), 10, 'already there');
});

test('every easing function starts at 0 and ends at 1', () => {
  const names = Object.keys(EASE);
  assert.ok(names.length >= 15, `${names.length} easings`);
  for (const name of names) {
    const ease = EASE[name as keyof typeof EASE];
    assert.ok(Math.abs(ease(0)) < 1e-9, `${name}(0)`);
    assert.ok(Math.abs(ease(1) - 1) < 1e-9, `${name}(1)`);
  }
  assert.ok(EASE.outBack(0.5) > 1, 'outBack overshoots');
  assert.ok(EASE.inQuad(0.5) < 0.5, 'inQuad accelerates');
  assert.ok(EASE.outQuad(0.5) > 0.5, 'outQuad decelerates');
  assert.equal(EASE.linear(0.3), 0.3);
});

test('resolveEase accepts names, functions and falls back to linear', () => {
  assert.equal(resolveEase('inQuad'), EASE.inQuad);
  assert.equal(resolveEase(EASE.outCubic), EASE.outCubic);
  assert.equal(resolveEase('nope' as never), EASE.linear);
  assert.equal(resolveEase((t) => t * 2)(0.5), 1);
});

test('mulberry is a deterministic, seeded generator', () => {
  const first = mulberry(7);
  const second = mulberry(7);
  const runA = Array.from({ length: 8 }, () => first());
  const runB = Array.from({ length: 8 }, () => second());
  assert.deepEqual(runA, runB);
  const other = mulberry(8);
  assert.notDeepEqual(runA, Array.from({ length: 8 }, () => other()));
  for (const value of runA) {
    assert.ok(value >= 0 && value < 1, String(value));
  }
  const mean = Array.from({ length: 1000 }, () => mulberry(99)()).reduce((a, b) => a + b, 0) / 1000;
  const meanOfOne = (() => {
    const rng = mulberry(99);
    let total = 0;
    for (let i = 0; i < 1000; i++) total += rng();
    return total / 1000;
  })();
  assert.ok(meanOfOne > 0.4 && meanOfOne < 0.6, `roughly uniform, got ${meanOfOne} (${mean})`);
});

test('curveSampler walks the control points', () => {
  const sampler = curveSampler([{ x: 0, y: 0 }, { x: 100, y: 50 }, { x: 200, y: 0 }], 0.5);
  assert.deepEqual(sampler(0), { x: 0, y: 0 });
  const middle = sampler(0.5);
  assert.ok(Math.abs(middle.x - 100) < 1e-6 && Math.abs(middle.y - 50) < 1e-6, JSON.stringify(middle));
  const end = sampler(1);
  assert.ok(Math.abs(end.x - 200) < 1e-6 && Math.abs(end.y - 0) < 1e-6, JSON.stringify(end));

  // Outside [0,1] is clamped to the endpoints.
  assert.deepEqual(sampler(-1), { x: 0, y: 0 });
  assert.deepEqual(sampler(2), { x: 200, y: 0 });

  const line = curveSampler([{ x: 0, y: 0 }, { x: 10, y: 20 }], 0.5);
  assert.ok(line(0.5).x > 0 && line(0.5).x < 10, 'stays within the segment');
  assert.ok(line(0.75).x > line(0.5).x, 'moves forward');
});

test('speedProfile turns keyframes into a monotonic 0→1 ease', () => {
  const profile = speedProfile([[0, 0], [0.5, 1], [1, 0.2]]);
  assert.equal(profile(0), 0);
  assert.equal(profile(1), 1);
  let previous = 0;
  for (let t = 0.05; t <= 1; t += 0.05) {
    const value = profile(t);
    assert.ok(value >= previous - 1e-9, `monotonic at ${t}`);
    previous = value;
  }
  const flat = speedProfile([[0, 1], [1, 1]]);
  assert.ok(flat(0.5) > 0 && flat(1) === 1);
});

test('Clock schedules tasks in order, cancels them, and clamps big frames', () => {
  const clock = new Clock();
  const order: string[] = [];
  clock.after(0.15, () => order.push('late'));
  clock.after(0.05, () => order.push('early'));
  const cancel = clock.after(0.3, () => order.push('cancelled'));
  assert.equal(clock.visible, 3);

  clock.tick(Clock.MAX_STEP); // time 0.0833
  assert.deepEqual(order, ['early'], 'only the due task runs');
  clock.tick(Clock.MAX_STEP); // time 0.1667
  assert.deepEqual(order, ['early', 'late']);
  cancel();
  assert.equal(clock.visible, 0);
  clock.tick(1); // clamped, nothing else is due
  assert.deepEqual(order, ['early', 'late']);

  // A huge frame is clamped to MAX_STEP so nothing teleports.
  const clamped = new Clock();
  clamped.tick(10);
  assert.equal(clamped.time, Clock.MAX_STEP);
  clamped.tick(-5);
  assert.equal(clamped.time, Clock.MAX_STEP, 'negative frames are ignored');
  clamped.scale = 0.5;
  clamped.tick(Clock.MAX_STEP);
  assert.ok(Math.abs(clamped.time - Clock.MAX_STEP * 1.5) < 1e-9, 'scale halves the step');
});

test('Tweens report progress once, complete, and can be killed', () => {
  const clock = new Clock();
  const updates: number[] = [];
  let completed = 0;
  const tween = clock.tween({
    ms: 100,
    ease: 'linear',
    onUpdate: (value) => updates.push(value),
    onComplete: () => completed++,
  });
  assert.equal(clock.visible, 1);
  clock.tick(0.05);
  assert.ok(Math.abs(updates.at(-1)! - 0.5) < 1e-6, `halfway, got ${updates.at(-1)}`);
  clock.tick(0.05);
  clock.tick(0.05);
  assert.equal(completed, 1);
  assert.equal(updates.at(-1), 1);
  assert.equal(clock.visible, 0, 'completed tweens are dropped');
  assert.equal(clock.empty, true);

  const killed = clock.tween({ ms: 100, onComplete: () => completed++ });
  killed.kill();
  clock.tick(1);
  assert.equal(completed, 1, 'a killed tween never completes');

  // Delays shift the start in clock time.
  const delayed = new Clock();
  const seen: number[] = [];
  delayed.tween({ ms: 100, delay: 0.1, onUpdate: (value) => seen.push(value) });
  delayed.tick(0.05);
  assert.deepEqual(seen, [], 'still waiting');
  delayed.tick(0.05);
  delayed.tick(0.05);
  assert.ok(seen.length > 0, 'started after the delay');
});

test('Clock frames receive dt and elapsed time; reset clears the world', () => {
  const clock = new Clock();
  const frames: Array<[number, number]> = [];
  clock.onFrame((dt, elapsed) => frames.push([dt, elapsed]));
  clock.tick(0.016);
  assert.equal(frames.length, 1);
  assert.ok(Math.abs(frames[0][0] - 0.016) < 1e-9);
  assert.equal(frames[0][1], clock.time);
  clock.after(1, () => {});
  clock.tween({ ms: 100 });
  clock.reset();
  assert.equal(clock.visible, 0);
  assert.equal(clock.empty, true);
});

test('substep slices frames into fixed steps and bounds its work', () => {
  let calls = 0;
  let advanced = 0;
  substep(0.4, (h) => {
    calls++;
    advanced += h;
    assert.ok(h <= 1 / 120 + 1e-9, `slice ${h}`);
  });
  assert.equal(calls, 48);
  assert.ok(Math.abs(advanced - 0.4) < 1e-6);

  let early = 0;
  substep(1, () => {
    early++;
    return false;
  });
  assert.equal(early, 1, 'returning false stops the loop');

  let bounded = 0;
  substep(10, () => {
    bounded++;
  });
  assert.equal(bounded, 64, 'the guard caps a pathological frame');
});

test('track and springStep converge and respect the speed cap', () => {
  const state = { x: 0, y: 0, vx: 0, vy: 0 };
  const speed = track(state, 100, 50, 0, 0, 120, 1, 20, 1 / 60);
  assert.ok(Math.hypot(state.vx, state.vy) <= 20 + 1e-9, 'velocity stays capped');
  assert.ok(speed > 20, 'the returned magnitude is measured before the clamp (current semantics)');
  for (let i = 0; i < 600; i++) track(state, 100, 50, 0, 0, 120, 1, 1000, 1 / 60);
  assert.ok(Math.abs(state.x - 100) < 1, `converges, x=${state.x}`);
  assert.ok(Math.abs(state.y - 50) < 1, `converges, y=${state.y}`);

  const spring = { x: 0, y: 0, vx: 0, vy: 0 };
  let peak = 0;
  for (let i = 0; i < 240; i++) {
    springStep(spring, 10, 0, 120, 0.2, 1000, 1 / 60);
    peak = Math.max(peak, spring.x);
  }
  assert.ok(peak > 10, `a bouncy spring overshoots, peaked at ${peak}`);
  assert.ok(Math.abs(spring.x - 10) < 1, `settles near the target, x=${spring.x}`);
});

test('Debris shards spawn from the palette and expire', () => {
  const ctx = new Proxy(
    {},
    {
      get: () => () => {},
      set: () => true,
    },
  );
  const canvas = {
    width: 800,
    height: 600,
    getContext: () => ctx,
  } as unknown as HTMLCanvasElement;
  (globalThis as { window?: unknown }).window = { devicePixelRatio: 2 };

  const debris = new Debris(canvas, ['#0A0F1C', '#F5F5F5'], 7);
  assert.equal(debris.count, 0);
  debris.resize(400, 300);
  assert.equal((canvas as { width: number }).width, 800, 'backing store scales by DPR');
  assert.equal((canvas as { height: number }).height, 600);

  debris.burst(200, 150, 12, { speed: [100, 200], spreadDeg: [0, 360], lifeMs: [400, 600], size: [4, 10] });
  assert.equal(debris.count, 12);
  debris.fractureBurst(200, 150, 15);
  assert.equal(debris.count, 27, 'fracture adds its own triangles');
  debris.setPointer(210, 140);
  debris.step(0.016);
  assert.equal(debris.count, 27, 'nothing dies immediately');

  // After a few seconds of stepping every shard has lived out its lifespan.
  for (let i = 0; i < 400; i++) debris.step(0.05);
  assert.equal(debris.count, 0, 'the field stops itself when the last shard dies');
  debris.clear();
  assert.equal(debris.count, 0);
});
