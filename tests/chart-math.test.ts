// Pure chart geometry used by the admin panel (donuts, axis scaling).
import assert from 'node:assert/strict';
import test from 'node:test';
import { donutSegments, donutSlicePath, niceCeil } from '../src/components/admin/chart-math';

test('niceCeil rounds up to 1/2/2.5/5/10 steps and never returns 0', () => {
  assert.equal(niceCeil(0), 1);
  assert.equal(niceCeil(-4), 1);
  assert.equal(niceCeil(1), 1);
  assert.equal(niceCeil(3), 5);
  assert.equal(niceCeil(21), 25);
  assert.equal(niceCeil(99), 100);
  assert.equal(niceCeil(100), 100);
  assert.equal(niceCeil(101), 200);
});

test('donutSegments splits values into ordered turn fractions', () => {
  const segs = donutSegments([1, 1, 2]);
  assert.equal(segs.length, 3);
  assert.deepEqual(
    segs.map((s) => s.fraction),
    [0.25, 0.25, 0.5],
  );
  assert.equal(segs[0].start, 0);
  assert.equal(segs[1].start, 0.25);
  assert.equal(segs[2].start, 0.5);
  assert.equal(segs[2].end, 1);
});

test('donutSegments handles zero totals and zero values without NaN', () => {
  for (const s of donutSegments([0, 0])) {
    assert.equal(s.fraction, 0);
    assert.equal(s.start, s.end);
  }
  const mixed = donutSegments([0, 5]);
  assert.equal(mixed[0].fraction, 0);
  assert.equal(mixed[1].fraction, 1);
  assert.deepEqual(donutSegments([]), []);
});

test('donutSlicePath draws quarter, half and full slices and skips empties', () => {
  const quarter = donutSlicePath(88, 88, 84, 55, 0, 0.25);
  assert.match(quarter, /^M [\d.]+ [\d.]+ A 84\.00 84\.00 0 0 1 /);
  assert.ok(quarter.endsWith('Z'));

  const half = donutSlicePath(88, 88, 84, 55, 0, 0.5);
  assert.match(half, /A 84\.00 84\.00 0 0 1/);

  const full = donutSlicePath(88, 88, 84, 55, 0, 1);
  // A full circle needs two outer arcs (a single arc cannot span 360°).
  assert.equal((full.match(/A 84\.00/g) || []).length, 2);

  assert.equal(donutSlicePath(88, 88, 84, 55, 0.5, 0.5), '');
});
