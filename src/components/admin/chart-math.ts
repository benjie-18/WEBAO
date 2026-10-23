// Pure chart geometry for the admin panel: no DOM, no dependencies, so the
// math is unit-testable and the renderers in admin-app.ts stay declarative.

/** Round a value up to a "nice" axis top (1 / 2 / 2.5 / 5 / 10 × 10^n). */
export function niceCeil(v: number): number {
  if (v <= 0) return 1;
  const exp = Math.floor(Math.log10(v));
  const base = Math.pow(10, exp);
  const n = v / base;
  const nice = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return nice * base;
}

export interface DonutSegment {
  /** Start of the slice, in turns (0 = top, clockwise), 0..1. */
  start: number;
  /** End of the slice, in turns, start..1. */
  end: number;
  /** Share of the total, 0..1. */
  fraction: number;
}

/**
 * Split values into donut slices in order, starting at the top and going
 * clockwise. Non-positive values get an empty slice; a zero total yields
 * all-empty slices so callers can fall back to an empty state.
 */
export function donutSegments(values: number[]): DonutSegment[] {
  const total = values.reduce((s, v) => s + Math.max(0, v), 0);
  let acc = 0;
  return values.map((v) => {
    const fraction = total > 0 ? Math.max(0, v) / total : 0;
    const seg = { start: acc, end: acc + fraction, fraction };
    acc += fraction;
    return seg;
  });
}

/** Point on a circle for a position in turns (0 = top, clockwise). */
export function polar(cx: number, cy: number, r: number, turn: number): [number, number] {
  const a = (turn - 0.25) * Math.PI * 2;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

const f2 = (x: number): string => x.toFixed(2);

/**
 * SVG path for one donut slice (annular sector). A full-circle slice is
 * drawn as two half arcs because a single arc command cannot span 360°.
 * A zero-width slice returns an empty path.
 */
export function donutSlicePath(
  cx: number,
  cy: number,
  rOuter: number,
  rInner: number,
  start: number,
  end: number,
): string {
  const span = end - start;
  if (span <= 0) return "";
  const outer = (t: number): string => polar(cx, cy, rOuter, t).map(f2).join(" ");
  const inner = (t: number): string => polar(cx, cy, rInner, t).map(f2).join(" ");
  if (span >= 0.9999) {
    const mid = start + span / 2;
    return (
      `M ${outer(start)} A ${f2(rOuter)} ${f2(rOuter)} 0 1 1 ${outer(mid)} ` +
      `A ${f2(rOuter)} ${f2(rOuter)} 0 1 1 ${outer(end)} ` +
      `L ${inner(end)} A ${f2(rInner)} ${f2(rInner)} 0 1 0 ${inner(mid)} ` +
      `A ${f2(rInner)} ${f2(rInner)} 0 1 0 ${inner(start)} Z`
    );
  }
  const large = span > 0.5 ? 1 : 0;
  return (
    `M ${outer(start)} A ${f2(rOuter)} ${f2(rOuter)} 0 ${large} 1 ${outer(end)} ` +
    `L ${inner(end)} A ${f2(rInner)} ${f2(rInner)} 0 ${large} 0 ${inner(start)} Z`
  );
}
