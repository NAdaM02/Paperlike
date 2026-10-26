/**
 * Variable-width pen outline, in the style of perfect-freehand:
 * thinning 0.5, round caps, a short taper at each end when `taperEnds` is set.
 * Highlighter passes `taperEnds = false`: full width, with straight ends.
 * The same math lives in `src-tauri/src/export.rs` (`mod ink`). Keep them together.
 */

export type Pt = [number, number];

const THINNING = 0.5;
const CAP_STEPS = 8;
const MIN_RADIUS = 0.01;
/** Weight of a new pen sample. The rest stays with the previous point. */
const SAMPLE_NEW = 0.72;

function clamp01(p: number): number {
  if (!Number.isFinite(p)) return 0.5;
  if (p < 0) return 0;
  if (p > 1) return 1;
  return p;
}

/** Radius at `pressure` before taper. At 0.5 this is half of `size`. */
export function strokeRadius(size: number, pressure: number): number {
  const p = clamp01(pressure);
  return size * (0.5 - THINNING * (0.5 - p));
}

/**
 * Hit-test width for a stroke. Pressure strokes use the fattest sample so the
 * eraser still meets the wide parts. Missing pressure keeps `width`.
 */
export function pressureHitWidth(width: number, pressure?: number[]): number {
  if (!pressure?.length) return width;
  let maxP = 0;
  for (const p of pressure) if (p > maxP) maxP = p;
  return width * (0.5 + clamp01(maxP));
}

function easeStart(t: number): number {
  return t * (2 - t);
}

function easeEnd(t: number): number {
  const u = t - 1;
  return u * u * u + 1;
}

function unit(dx: number, dy: number): Pt {
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return [1, 0];
  return [dx / len, dy / len];
}

/** Semicircle from the left of `outward` around to the right, excluding the endpoints. */
function semicircle(center: Pt, outward: Pt, radius: number): Pt[] {
  const mid = Math.atan2(outward[1], outward[0]);
  const start = mid + Math.PI / 2;
  const out: Pt[] = [];
  for (let s = 1; s < CAP_STEPS; s++) {
    const a = start - (Math.PI * s) / CAP_STEPS;
    out.push([center[0] + Math.cos(a) * radius, center[1] + Math.sin(a) * radius]);
  }
  return out;
}

/**
 * Filled polygon for a pressure stroke. Empty and single-point input return [].
 * The ring is closed: the last point repeats the first.
 */
export function strokeOutline(
  points: Pt[],
  pressures: number[] | undefined,
  baseWidth: number,
  taperEnds = true,
): Pt[] {
  const n = points.length;
  if (n < 2 || !(baseWidth > 0)) return [];
  const run: number[] = new Array(n);
  run[0] = 0;
  for (let i = 1; i < n; i++) {
    run[i] = run[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  }
  const total = run[n - 1];
  if (!(total > 1e-6)) return [];
  const taper = taperEnds ? Math.min(baseWidth, total / 2) : 0;
  const left: Pt[] = [];
  const right: Pt[] = [];
  const radii: number[] = [];
  for (let i = 0; i < n; i++) {
    const prev = points[Math.max(0, i - 1)];
    const next = points[Math.min(n - 1, i + 1)];
    const [dx, dy] = unit(next[0] - prev[0], next[1] - prev[1]);
    const px = -dy;
    const py = dx;
    const p = pressures && i < pressures.length ? clamp01(pressures[i]) : 0.5;
    let radius = strokeRadius(baseWidth, p);
    const ts = run[i] < taper ? easeStart(run[i] / taper) : 1;
    const te = total - run[i] < taper ? easeEnd((total - run[i]) / taper) : 1;
    radius = Math.max(MIN_RADIUS, radius * Math.min(ts, te));
    radii.push(radius);
    const [x, y] = points[i];
    left.push([x + px * radius, y + py * radius]);
    right.push([x - px * radius, y - py * radius]);
  }
  right.reverse();
  const poly: Pt[] = taperEnds
    ? [
        ...left,
        ...semicircle(
          points[n - 1],
          unit(points[n - 1][0] - points[n - 2][0], points[n - 1][1] - points[n - 2][1]),
          radii[n - 1],
        ),
        ...right,
        ...semicircle(
          points[0],
          unit(points[0][0] - points[1][0], points[0][1] - points[1][1]),
          radii[0],
        ),
      ]
    : [...left, ...right];
  if (poly.length < 3) return [];
  poly.push([poly[0][0], poly[0][1]]);
  return poly;
}

/** Every run of a stroke. `parts` are extra marker runs kept in the same object. */
export function strokeRuns(points: Pt[], parts?: Pt[][]): Pt[][] {
  const runs: Pt[][] = [];
  if (points.length >= 2) runs.push(points);
  for (const part of parts ?? []) if (part.length >= 2) runs.push(part);
  return runs;
}

/**
 * One filled path for every marker run. Separate path elements would each
 * multiply, so a crossing left by an erase would go darker than the rest.
 */
export function markerOutlinePath(runs: Pt[][], width: number): string {
  let d = "";
  for (const run of runs) {
    const ring = strokeOutline(run, undefined, width, false);
    if (ring.length >= 3) d += `${outlinePath(ring)} `;
  }
  return d.trim();
}

/** SVG path for a filled outline. */
export function outlinePath(pts: Pt[]): string {
  if (pts.length < 3) return "";
  let d = `M ${pts[0][0]} ${pts[0][1]}`;
  for (let i = 1; i < pts.length; i++) d += ` L ${pts[i][0]} ${pts[i][1]}`;
  return `${d} Z`;
}

/**
 * Light blend of a new pen sample onto the stroke. Drops the sample when it
 * lands within `minDist` canvas pixels of the previous kept point.
 * `pressure` is updated only when that array is passed (pen pressure on).
 */
export function pushPenSample(
  pts: Pt[],
  pressure: number[] | undefined,
  x: number,
  y: number,
  nextPressure: number | null,
  minDist = 0.5,
): boolean {
  if (!pts.length) {
    pts.push([x, y]);
    if (pressure && nextPressure != null) pressure.push(clamp01(nextPressure));
    return true;
  }
  const prev = pts[pts.length - 1];
  const px = prev[0] * (1 - SAMPLE_NEW) + x * SAMPLE_NEW;
  const py = prev[1] * (1 - SAMPLE_NEW) + y * SAMPLE_NEW;
  if (Math.hypot(px - prev[0], py - prev[1]) < minDist) return false;
  pts.push([px, py]);
  if (pressure) {
    const pp = pressure.length ? pressure[pressure.length - 1] : 0.5;
    const raw = nextPressure == null ? pp : nextPressure;
    pressure.push(clamp01(pp * (1 - SAMPLE_NEW) + clamp01(raw) * SAMPLE_NEW));
  }
  return true;
}

/** One light 1-2-1 pass. Endpoints stay put. Pressure stays aligned when present. */
export function smoothInk(pts: Pt[], pressure?: number[]): { pts: Pt[]; pressure?: number[] } {
  if (pts.length < 3) return { pts, pressure };
  const pr = pressure && pressure.length === pts.length ? pressure : undefined;
  const next: Pt[] = [pts[0]];
  const nextP = pr ? [pr[0]] : undefined;
  for (let i = 1; i < pts.length - 1; i++) {
    next.push([
      (pts[i - 1][0] + 2 * pts[i][0] + pts[i + 1][0]) / 4,
      (pts[i - 1][1] + 2 * pts[i][1] + pts[i + 1][1]) / 4,
    ]);
    if (nextP && pr) nextP.push((pr[i - 1] + 2 * pr[i] + pr[i + 1]) / 4);
  }
  next.push(pts[pts.length - 1]);
  if (nextP && pr) nextP.push(pr[pr.length - 1]);
  return { pts: next, pressure: nextP };
}
