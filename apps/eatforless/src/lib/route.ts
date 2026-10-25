// Geometry for the live-tracking car: where along a polyline a progress value
// puts it, and which way it faces. Worklets, so the car is positioned on the
// UI thread every frame without touching React.

export type Pt = { x: number; y: number };

export function cumulative(points: Pt[]): number[] {
  "worklet";
  const out = [0];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    out.push(out[i - 1]! + Math.hypot(b.x - a.x, b.y - a.y));
  }
  return out;
}

function angleOf(a: Pt, b: Pt): number {
  "worklet";
  return Math.atan2(b.y - a.y, b.x - a.x);
}

/** Shortest turn from a to b, in radians. */
function turn(a: number, b: number): number {
  "worklet";
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

/**
 * Position and heading at `progress` (0–1). Within `cornerPx` of a bend the
 * heading eases from one street's direction to the next, so the car turns
 * the corner instead of snapping round it.
 */
export function pointAt(points: Pt[], cum: number[], progress: number, cornerPx = 18): { x: number; y: number; angle: number } {
  "worklet";
  const n = points.length;
  if (n === 0) return { x: 0, y: 0, angle: 0 };
  if (n === 1) return { x: points[0]!.x, y: points[0]!.y, angle: 0 };
  const total = cum[n - 1]!;
  const d = Math.max(0, Math.min(1, progress)) * total;
  let i = 0;
  while (i < n - 2 && cum[i + 1]! < d) i++;
  const a = points[i]!;
  const b = points[i + 1]!;
  const segLen = Math.max(0.0001, cum[i + 1]! - cum[i]!);
  const t = (d - cum[i]!) / segLen;
  const x = a.x + (b.x - a.x) * t;
  const y = a.y + (b.y - a.y) * t;
  let angle = angleOf(a, b);
  const intoSeg = d - cum[i]!;
  const leftInSeg = cum[i + 1]! - d;
  if (i < n - 2 && leftInSeg < cornerPx) {
    // Approaching the next bend: start turning.
    const next = angleOf(b, points[i + 2]!);
    angle += turn(angle, next) * 0.5 * (1 - leftInSeg / cornerPx);
  } else if (i > 0 && intoSeg < cornerPx) {
    // Just round the bend: finish the turn.
    const prev = angleOf(points[i - 1]!, a);
    angle = prev + turn(prev, angle) * (0.5 + 0.5 * (intoSeg / cornerPx));
  }
  return { x, y, angle };
}

/** How far along the polyline (0–1) the point nearest to `p` lies. */
export function progressOf(points: Pt[], p: Pt): number {
  const cum = cumulative(points);
  const total = cum[cum.length - 1] ?? 0;
  if (total === 0) return 0;
  let best = { dist: Infinity, along: 0 };
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const len2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2 || 1;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / len2));
    const q = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    const dist = Math.hypot(p.x - q.x, p.y - q.y);
    if (dist < best.dist) best = { dist, along: cum[i]! + t * Math.sqrt(len2) };
  }
  return best.along / total;
}

export function pathD(points: Pt[]): string {
  return points.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
}
