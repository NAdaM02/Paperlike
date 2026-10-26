import type { DrawingObject } from "./api";
import { strokeRuns } from "./ink";

type Pt = [number, number];

export type SmartInk = { kind: "stroke"; points: Pt[] };

function dist(a: Pt, b: Pt): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function heading(a: Pt, b: Pt): number {
  return Math.atan2(b[1] - a[1], b[0] - a[0]);
}

function angDiff(a: number, b: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function pathLen(pts: Pt[]): number {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += dist(pts[i - 1], pts[i]);
  return l;
}

function smoothOnce(pts: Pt[]): Pt[] {
  if (pts.length < 3) return pts.map((p) => [p[0], p[1]] as Pt);
  const next: Pt[] = [[pts[0][0], pts[0][1]]];
  for (let i = 1; i < pts.length - 1; i++) {
    next.push([
      (pts[i - 1][0] + 2 * pts[i][0] + pts[i + 1][0]) / 4,
      (pts[i - 1][1] + 2 * pts[i][1] + pts[i + 1][1]) / 4,
    ]);
  }
  const last = pts[pts.length - 1];
  next.push([last[0], last[1]]);
  return next;
}

function speeds(pts: Pt[], times?: number[]): number[] {
  const out: number[] = [];
  const timed = times && times.length === pts.length;
  for (let i = 1; i < pts.length; i++) {
    const dt = timed ? Math.max(8, times[i] - times[i - 1]) : 16;
    out.push(dist(pts[i - 1], pts[i]) / dt);
  }
  return out;
}

function walkIndex(pts: Pt[], from: number, dir: 1 | -1, need: number): number {
  let walked = 0;
  let i = from;
  while (i + dir >= 0 && i + dir < pts.length && walked < need) {
    i += dir;
    walked += dist(pts[i], pts[i - dir]);
  }
  return walked >= need * 0.55 ? i : -1;
}

/**
 * Corners of a hand-drawn polygon. The turn is measured across a short run,
 * so a rectangle or triangle corner still counts after the pen rounds it a little.
 */
function sharpCorners(pts: Pt[]): number[] {
  const scored: { i: number; turn: number }[] = [];
  for (let i = 2; i < pts.length - 2; i++) {
    const back = walkIndex(pts, i, -1, 16);
    const fore = walkIndex(pts, i, 1, 16);
    if (back < 0 || fore < 0) continue;
    const turn = Math.abs(angDiff(heading(pts[back], pts[i]), heading(pts[i], pts[fore])));
    if (turn > 0.9) scored.push({ i, turn });
  }
  scored.sort((a, b) => b.turn - a.turn);
  const kept: number[] = [];
  for (const corner of scored) {
    if (kept.every((i) => dist(pts[i], pts[corner.i]) > 20)) kept.push(corner.i);
  }
  kept.sort((a, b) => a - b);
  return kept;
}

function joinTurn(pts: Pt[]): number {
  const back = walkIndex(pts, pts.length - 1, -1, 16);
  const fore = walkIndex(pts, 0, 1, 16);
  if (back < 0 || fore < 0) return 0;
  return Math.abs(angDiff(heading(pts[back], pts[pts.length - 1]), heading(pts[0], pts[fore])));
}

function sliceSide(pts: Pt[], from: number, to: number): Pt[] {
  if (from <= to) return pts.slice(from, to + 1);
  const tail = pts.slice(from);
  const head = pts.slice(0, to + 1);
  if (tail.length && head.length && dist(tail[tail.length - 1], head[0]) < 1.5) head.shift();
  return [...tail, ...head];
}

function segmentsCross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const cross = (p: Pt, q: Pt, r: Pt) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  return cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0;
}

/**
 * The pen meets ink it already drew, so this is not one simple loop.
 * A crossing, a doubled stroke (the bar of an f), or a loop that returns
 * all count. The two ends of a plain triangle or circle do not, and neither
 * does a sharp corner: points only meet there because the turn is tight.
 */
function revisitsEarlierInk(pts: Pt[]): boolean {
  const n = pts.length;
  if (n < 8) return false;
  const prefix: number[] = [0];
  for (let i = 1; i < n; i++) prefix.push(prefix[i - 1] + dist(pts[i - 1], pts[i]));
  const len = prefix[n - 1];
  if (len < 24) return false;

  const gap = dist(pts[0], pts[n - 1]);
  const closed = gap <= Math.max(28, len * 0.22);
  const closeReach = Math.max(16, gap + 6);
  if (closed) {
    for (let k = 0; k < n; k++) {
      const fromStart = prefix[k];
      if (fromStart < 36 || len - fromStart < 36) continue;
      if (dist(pts[k], pts[0]) <= closeReach || dist(pts[k], pts[n - 1]) <= closeReach) return true;
    }
  }

  const cap = 26;
  const closingPair = (early: number, late: number) =>
    closed && prefix[early] <= cap && len - prefix[late] <= cap;

  for (let a = 0; a < n - 1; a++) {
    for (let b = a + 2; b < n - 1; b++) {
      if (prefix[b] - prefix[a] < 24) continue;
      if (closingPair(a, b)) continue;
      if (segmentsCross(pts[a], pts[a + 1], pts[b], pts[b + 1])) return true;
    }
  }

  const spun: number[] = [0, 0];
  for (let k = 2; k < n; k++) {
    spun.push(spun[k - 1] + Math.abs(angDiff(heading(pts[k - 2], pts[k - 1]), heading(pts[k - 1], pts[k]))));
  }

  for (let i = 1; i < n; i++) {
    for (let j = 0; j < i; j++) {
      const along = prefix[i] - prefix[j];
      if (along < 32 || closingPair(j, i)) continue;
      // The two sides of the corner where a loop closes are close only
      // because the ends meet. The short way between them is the join.
      if (closed && len - along < 110) continue;
      const d = dist(pts[i], pts[j]);
      if (d > 14) continue;
      const bulge = dist(pts[(i + j) >> 1], pts[j]);
      if (bulge < 16) continue;
      if (j + 1 < n) {
        const forward = heading(pts[j], pts[j + 1]);
        const back = heading(pts[i - 1], pts[i]);
        // Nearly opposite. A triangle corner, even a sharp one, turns less than this.
        if (Math.abs(angDiff(forward, back)) > 2.98) return true;
      }
      const turned = (i >= 2 ? spun[i - 1] : 0) - spun[j];
      if (d <= 12 && turned > 4.2) return true;
      if (d <= 5 && bulge > 28 && along > 70) return true;
    }
  }
  return false;
}

/**
 * A capital D is one straight stem and one bowed bowl. That mix is a letter.
 * A triangle or rectangle has no bowed side, and a circle has no stem.
 * Under 0.08 of the chord is a stem — a straight side sits nearer a few
 * percent. Over 0.10 is a bowl: shallow enough that the old 0.42 side
 * cutoff still polygonized it (a split bowl lands near 0.14–0.21; a
 * quarter-circle is about 0.21).
 */
function straightStemAndBowl(sides: Pt[][]): boolean {
  let stem = false;
  let bowl = false;
  for (const seg of sides) {
    if (seg.length < 4 || pathLen(seg) <= 28) continue;
    const dev = deviationFromChord(seg);
    if (dev < 0.08) stem = true;
    else if (dev > 0.10) bowl = true;
  }
  return stem && bowl;
}

/** Sides of a 3- or 4-corner loop, or of an open stroke with a few corners. */
function loopSides(pts: Pt[], corners: number[], len: number): { closed: boolean; joinSharp: boolean; interior: number[]; sides: Pt[][] } | null {
  if (pts.length < 4) return null;
  const gap = dist(pts[0], pts[pts.length - 1]);
  const closed = gap <= Math.max(28, len * 0.22);
  const joinSharp = closed && joinTurn(pts) > 0.9;
  const interior = corners.filter(
    (i) => !joinSharp || (dist(pts[i], pts[0]) > 18 && dist(pts[i], pts[pts.length - 1]) > 18),
  );
  const count = interior.length + (joinSharp ? 1 : 0);
  if (closed && (count === 3 || count === 4)) {
    const cuts = joinSharp ? [0, ...interior, pts.length - 1] : interior;
    const steps = joinSharp ? cuts.length - 1 : cuts.length;
    const sides: Pt[][] = [];
    for (let s = 0; s < steps; s++) {
      const from = cuts[s];
      const to = cuts[(s + 1) % cuts.length];
      sides.push(!joinSharp && s === cuts.length - 1 ? sliceSide(pts, from, to) : pts.slice(from, to + 1));
    }
    return { closed: true, joinSharp, interior, sides };
  }
  if (!closed && interior.length >= 2 && interior.length <= 5) {
    const cuts = [0, ...interior, pts.length - 1];
    const sides: Pt[][] = [];
    for (let s = 0; s < cuts.length - 1; s++) {
      const seg = pts.slice(cuts[s], cuts[s + 1] + 1);
      if (pathLen(seg) < 12) continue;
      sides.push(seg);
    }
    return { closed: false, joinSharp, interior, sides };
  }
  return null;
}

/**
 * Closed triangle or rectangle: keep every corner and pull each side toward
 * its chord. The side that crosses where the pen started is one side, not two.
 * Only one simple loop with exactly three or four corners is straightened.
 * A five-corner blob, ink that crosses itself, or a straight stem with a
 * bowed side (a capital D) is not forced into that polygon.
 */
function straightenPolygon(pts: Pt[], corners: number[], len: number): Pt[] | null {
  if (pts.length < 4 || revisitsEarlierInk(pts)) return null;
  const loop = loopSides(pts, corners, len);
  if (!loop) return null;
  if (straightStemAndBowl(loop.sides)) return null;
  if (loop.closed) {
    const box = bounds(pts);
    if (radialError(pts, box) < 0.11 && Math.min(box.w, box.h) > 20) return null;
    for (const seg of loop.sides) {
      if (seg.length >= 4 && pathLen(seg) > 28 && deviationFromChord(seg) > 0.42) return null;
    }
    const out: Pt[] = [];
    for (const seg of loop.sides) {
      if (seg.length < 2) continue;
      let next = pullTowardLine(seg, 0.92);
      if (out.length) next = next.slice(1);
      out.push(...next);
    }
    if (!loop.joinSharp && out.length >= 2) out[out.length - 1] = [out[0][0], out[0][1]];
    return out.length >= 2 ? out : null;
  }
  let straightish = 0;
  for (const seg of loop.sides) {
    if (deviationFromChord(seg) < 0.38) straightish += 1;
  }
  if (loop.sides.length >= 2 && straightish >= Math.ceil(loop.sides.length * 0.6)) return tidy(pts, loop.interior, true);
  return null;
}

/** Intentional corners: a real turn that also slowed down. Fast flicks are not corners. */
function corners(pts: Pt[], times?: number[]): number[] {
  const spd = speeds(pts, times);
  const found: number[] = [];
  for (let i = 2; i < pts.length - 2; i++) {
    const turn = Math.abs(angDiff(heading(pts[i - 2], pts[i - 1]), heading(pts[i], pts[i + 1])));
    const here = spd[i] ?? 0;
    const before = spd[Math.max(0, i - 1)] ?? here;
    const slow = here < before * 0.78;
    if (turn > 0.62 && (slow || turn > 1.2)) found.push(i);
  }
  const kept: number[] = [];
  for (const i of found) {
    if (!kept.length || dist(pts[kept[kept.length - 1]], pts[i]) > 16) kept.push(i);
  }
  return kept;
}

function deviationFromChord(pts: Pt[]): number {
  if (pts.length < 3) return 0;
  const a = pts[0];
  const b = pts[pts.length - 1];
  const len2 = dist(a, b) ** 2 || 1;
  let max = 0;
  for (const p of pts) {
    let t = ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / len2;
    t = Math.max(0, Math.min(1, t));
    max = Math.max(max, dist(p, [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]));
  }
  return max / Math.sqrt(len2);
}

function pullTowardLine(pts: Pt[], amount: number): Pt[] {
  const a = pts[0];
  const b = pts[pts.length - 1];
  const n = pts.length - 1;
  return pts.map((p, i) => {
    if (i === 0 || i === n) return [p[0], p[1]] as Pt;
    const t = i / n;
    const lx = a[0] + (b[0] - a[0]) * t;
    const ly = a[1] + (b[1] - a[1]) * t;
    return [p[0] + (lx - p[0]) * amount, p[1] + (ly - p[1]) * amount];
  });
}

function looksLikeWriting(pts: Pt[]): boolean {
  if (pts.length < 10) return false;
  const len = pathLen(pts);
  if (len < 28) return false;
  let reversals = 0;
  let prev = 0;
  for (let i = 2; i < pts.length; i++) {
    const turn = angDiff(heading(pts[i - 2], pts[i - 1]), heading(pts[i - 1], pts[i]));
    if (Math.abs(turn) > 0.45 && prev * turn < 0) reversals++;
    if (Math.abs(turn) > 0.28) prev = turn;
  }
  let minY = Infinity;
  let maxY = -Infinity;
  let minX = Infinity;
  let maxX = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p[0]);
    maxX = Math.max(maxX, p[0]);
    minY = Math.min(minY, p[1]);
    maxY = Math.max(maxY, p[1]);
  }
  const closed = dist(pts[0], pts[pts.length - 1]) < Math.max(14, len * 0.12);
  if (closed && Math.min(maxX - minX, maxY - minY) > 36) return false;
  return reversals >= 3 && reversals / (len / 42) > 0.5 && maxY - minY < 150;
}

function bounds(pts: Pt[]) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p[0]);
    minY = Math.min(minY, p[1]);
    maxX = Math.max(maxX, p[0]);
    maxY = Math.max(maxY, p[1]);
  }
  return { minX, minY, maxX, maxY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) };
}

/** Share of samples that sit near the bounding-box edge, not in the middle. */
function edgeFraction(pts: Pt[], b: ReturnType<typeof bounds>): number {
  const tol = 0.16 * Math.min(b.w, b.h);
  let n = 0;
  for (const p of pts) {
    const d = Math.min(p[0] - b.minX, b.maxX - p[0], p[1] - b.minY, b.maxY - p[1]);
    if (d <= tol) n++;
  }
  return n / pts.length;
}

function radialError(pts: Pt[], b: ReturnType<typeof bounds>): number {
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  const rx = b.w / 2;
  const ry = b.h / 2;
  let err = 0;
  for (const p of pts) {
    err += Math.abs(Math.hypot((p[0] - cx) / rx, (p[1] - cy) / ry) - 1);
  }
  return err / pts.length;
}

function resample(pts: Pt[], step: number): Pt[] {
  if (pts.length < 2) return pts.map((p) => [p[0], p[1]] as Pt);
  const out: Pt[] = [[pts[0][0], pts[0][1]]];
  let prev = pts[0];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    let remain = dist(prev, pts[i]);
    if (remain === 0) continue;
    let ax = prev[0];
    let ay = prev[1];
    const bx = pts[i][0];
    const by = pts[i][1];
    while (carry + remain >= step) {
      const need = step - carry;
      if (need <= 1e-4) {
        carry = 0;
        continue;
      }
      const t = need / remain;
      ax += (bx - ax) * t;
      ay += (by - ay) * t;
      out.push([ax, ay]);
      remain = Math.hypot(bx - ax, by - ay);
      carry = 0;
    }
    carry += remain;
    prev = pts[i];
  }
  const last = pts[pts.length - 1];
  const tail = out[out.length - 1];
  if (dist(tail, last) > 0.5) out.push([last[0], last[1]]);
  else out[out.length - 1] = [last[0], last[1]];
  return out;
}

function sameSide(pts: Pt[]): boolean {
  const a = pts[0];
  const b = pts[pts.length - 1];
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  let pos = 0;
  let neg = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const cross = dx * (pts[i][1] - a[1]) - dy * (pts[i][0] - a[0]);
    if (cross > 1.5) pos++;
    else if (cross < -1.5) neg++;
  }
  const n = pos + neg;
  return n >= 3 && Math.max(pos, neg) / n > 0.85;
}

function circleThrough(a: Pt, b: Pt, c: Pt): { cx: number; cy: number; r: number } | null {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-3) return null;
  const a2 = a[0] * a[0] + a[1] * a[1];
  const b2 = b[0] * b[0] + b[1] * b[1];
  const c2 = c[0] * c[0] + c[1] * c[1];
  const cx = (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d;
  const cy = (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d;
  const r = Math.hypot(a[0] - cx, a[1] - cy);
  if (r < 6 || r > 6000) return null;
  return { cx, cy, r };
}

function sweepThrough(from: number, mid: number, to: number): number {
  const short = angDiff(from, to);
  const long = short > 0 ? short - Math.PI * 2 : short + Math.PI * 2;
  const holds = (sweep: number) => {
    const at = angDiff(from, mid);
    return sweep >= 0 ? at >= -0.08 && at <= sweep + 0.08 : at <= 0.08 && at >= sweep - 0.08;
  };
  return holds(short) ? short : long;
}

/** Bend a one-sided curve toward the arc through its ends and its bulge. */
function pullTowardArc(pts: Pt[], amount: number): Pt[] {
  const a = pts[0];
  const b = pts[pts.length - 1];
  const len2 = dist(a, b) ** 2 || 1;
  let far = 1;
  let farD = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i];
    let t = ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / len2;
    t = Math.max(0, Math.min(1, t));
    const dd = dist(p, [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    if (dd > farD) {
      farD = dd;
      far = i;
    }
  }
  const circle = circleThrough(a, pts[far], b);
  if (!circle) return pullTowardLine(pts, amount);
  const a0 = Math.atan2(a[1] - circle.cy, a[0] - circle.cx);
  const am = Math.atan2(pts[far][1] - circle.cy, pts[far][0] - circle.cx);
  const a1 = Math.atan2(b[1] - circle.cy, b[0] - circle.cx);
  const sweep = sweepThrough(a0, am, a1);
  const n = pts.length - 1;
  return pts.map((p, i) => {
    if (i === 0 || i === n) return [p[0], p[1]] as Pt;
    const ang = a0 + sweep * (i / n);
    const x = circle.cx + circle.r * Math.cos(ang);
    const y = circle.cy + circle.r * Math.sin(ang);
    return [p[0] + (x - p[0]) * amount, p[1] + (y - p[1]) * amount];
  });
}

function pullTowardEllipse(pts: Pt[], amount: number): Pt[] {
  const box = bounds(pts);
  const cx = (box.minX + box.maxX) / 2;
  const cy = (box.minY + box.maxY) / 2;
  const rx = box.w / 2;
  const ry = box.h / 2;
  const out = pts.map((p) => {
    const ang = Math.atan2((p[1] - cy) / ry, (p[0] - cx) / rx);
    const x = cx + rx * Math.cos(ang);
    const y = cy + ry * Math.sin(ang);
    return [p[0] + (x - p[0]) * amount, p[1] + (y - p[1]) * amount] as Pt;
  });
  out[out.length - 1] = [out[0][0], out[0][1]];
  return out;
}

function nearest(pts: Pt[], p: Pt): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const d = dist(pts[i], p);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

function tidy(pts: Pt[], turns: number[], straightSides = false): Pt[] {
  const cs = [0, ...turns, pts.length - 1];
  const out: Pt[] = [];
  for (let s = 0; s < cs.length - 1; s++) {
    const seg = pts.slice(cs[s], cs[s + 1] + 1);
    if (seg.length < 2) continue;
    const dev = deviationFromChord(seg);
    let next: Pt[];
    if (straightSides) next = pullTowardLine(seg, 0.92);
    else if (dev < 0.05) next = pullTowardLine(seg, dev < 0.02 ? 0.9 : 0.74);
    else if (sameSide(seg) && dev < 0.16) next = pullTowardArc(seg, 0.66);
    else if (sameSide(seg) && dev < 0.32) next = pullTowardArc(smoothOnce(seg), 0.42);
    else next = smoothOnce(smoothOnce(seg));
    if (s > 0) next = next.slice(1);
    out.push(...next);
  }
  return out.length >= 2 ? out : smoothOnce(pts);
}

/**
 * Ink only. A triangle or rectangle keeps its corners and gets straight sides.
 * A stroke that crosses itself, a stem with a loop, or a straight stem beside
 * a bowed side, keeps that drawing and is only smoothed. Other strokes:
 * nearly straight runs pull toward a line,
 * one-sided curves toward an arc, and an already-round loop toward its ellipse.
 * The result stays a stroke. Handwriting is only smoothed.
 */
export function refineSmartStroke(pts: Pt[], times?: number[]): SmartInk {
  if (pts.length < 2) return { kind: "stroke", points: pts };
  const len = pathLen(pts);
  if (len < 10) return { kind: "stroke", points: pts };
  const even = resample(pts, 3.2);
  const ink = smoothOnce(even);
  if (looksLikeWriting(ink)) return { kind: "stroke", points: smoothOnce(ink) };
  const tangled = revisitsEarlierInk(even);
  const sharp = sharpCorners(even);
  const polygon = tangled ? null : straightenPolygon(even, sharp, len);
  if (polygon) return { kind: "stroke", points: polygon };
  const turns = corners(pts, times)
    .map((i) => nearest(ink, pts[i]))
    .filter((i, n, all) => i > 2 && i < ink.length - 3 && all.indexOf(i) === n)
    .sort((a, b) => a - b);

  // A D is not a circle. The ellipse pull would oval the stem; smooth it instead.
  const loop = tangled ? null : loopSides(even, sharp, len);
  const letter = !!loop && straightStemAndBowl(loop.sides);
  // Just short of touching still counts. A few pixels, or a small fraction of a
  // longer path — 26px / 19% is only a little past 16px / 15%, not an open arc.
  const closed = dist(ink[0], ink[ink.length - 1]) < Math.max(26, len * 0.19);
  if (!tangled && !letter && closed && len > 36) {
    const box = bounds(ink);
    const boxy = turns.length >= 3 && edgeFraction(ink, box) > 0.72;
    if (!boxy && turns.length <= 2 && box.w > 18 && box.h > 18) {
      const radial = radialError(ink, box);
      if (radial < 0.34) {
        return { kind: "stroke", points: pullTowardEllipse(ink, radial < 0.16 ? 0.74 : 0.52) };
      }
    }
  }
  return { kind: "stroke", points: tidy(ink, turns) };
}

/** Drop a lasso sample that is only hand shake: a tiny step, or an instant reversal. */
export function pushLassoPoint(pts: Pt[], x: number, y: number): boolean {
  const next: Pt = [x, y];
  const prev = pts[pts.length - 1];
  if (!prev) {
    pts.push(next);
    return true;
  }
  const step = dist(prev, next);
  if (step < 2.4) return false;
  if (pts.length >= 2) {
    const before = pts[pts.length - 2];
    const turn = Math.abs(angDiff(heading(before, prev), heading(prev, next)));
    if (turn > 2.2 && step < 14) return false;
  }
  pts.push(next);
  return true;
}

/**
 * One smooth bend from the pen's last steady heading onto the start.
 * A single curve cannot spiral into extra loops.
 */
export function predictLassoClose(pts: Pt[]): Pt[] {
  if (pts.length < 2) return [];
  const start = pts[0];
  const end = pts[pts.length - 1];
  const gap = dist(end, start);
  if (gap < 8) return [[start[0], start[1]]];
  let back = end;
  let walked = 0;
  for (let i = pts.length - 2; i >= 0; i--) {
    walked += dist(pts[i + 1], pts[i]);
    back = pts[i];
    if (walked >= 32) break;
  }
  const home = heading(end, start);
  const raw = heading(back, end);
  const off = angDiff(home, raw);
  const aim = Math.abs(off) > Math.PI * 0.85 ? home : home + Math.max(-1.15, Math.min(1.15, off));
  const lead = Math.min(gap * 0.4, 96);
  const cx = end[0] + Math.cos(aim) * lead;
  const cy = end[1] + Math.sin(aim) * lead;
  const steps = Math.max(6, Math.min(16, Math.round(gap / 16)));
  const out: Pt[] = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const m = 1 - t;
    out.push([
      m * m * end[0] + 2 * m * t * cx + t * t * start[0],
      m * m * end[1] + 2 * m * t * cy + t * t * start[1],
    ]);
  }
  out[out.length - 1] = [start[0], start[1]];
  return out;
}

/** Smoothed lasso, closed by one calm curve. Used for the preview and the hit test. */
export function lassoLoop(pts: Pt[]): Pt[] {
  if (pts.length < 2) return pts.map((p) => [p[0], p[1]] as Pt);
  const drawn = smoothOnce(pts);
  return [...drawn, ...predictLassoClose(drawn)];
}

function diskHitsRect(p: Pt, r: number, x1: number, y1: number, x2: number, y2: number): boolean {
  const cx = Math.max(x1, Math.min(x2, p[0]));
  const cy = Math.max(y1, Math.min(y2, p[1]));
  return Math.hypot(p[0] - cx, p[1] - cy) <= r;
}

function samplesOf(o: DrawingObject): { runs: Pt[][]; width: number } {
  const it = o.item;
  const abs = (p: Pt): Pt => [o.x + p[0], o.y + p[1]];
  if (it.kind === "stroke") return { runs: strokeRuns(it.points, it.parts).map((run) => run.map(abs)), width: it.width };
  if (it.kind === "arrow") {
    const pts: Pt[] = [];
    const steps = 24;
    for (let i = 0; i <= steps; i++) {
      const u = i / steps;
      const m = 1 - u;
      const b0 = m * m * m;
      const b1 = 3 * m * m * u;
      const b2 = 3 * m * u * u;
      const b3 = u * u * u;
      pts.push([
        o.x + b0 * it.tail[0] + b1 * it.c1[0] + b2 * it.c2[0] + b3 * it.head[0],
        o.y + b0 * it.tail[1] + b1 * it.c1[1] + b2 * it.c2[1] + b3 * it.head[1],
      ]);
    }
    return { runs: [pts], width: it.width };
  }
  const { w, h } = it;
  let rel: Pt[];
  if (it.shape === "ellipse") {
    rel = Array.from({ length: 48 }, (_, i) => {
      const a = (i / 48) * Math.PI * 2;
      return [w / 2 + (w / 2) * Math.cos(a), h / 2 + (h / 2) * Math.sin(a)] as Pt;
    });
  } else if (it.shape === "triangle") {
    rel = [[w / 2, 0], [w, h], [0, h], [w / 2, 0]];
  } else if (it.shape === "diamond") {
    rel = [[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2], [w / 2, 0]];
  } else {
    rel = [[0, 0], [w, 0], [w, h], [0, h], [0, 0]];
  }
  return { runs: [rel.map(abs)], width: it.width };
}

/** The marquee overlaps painted ink. A shape's empty inside does not count. */
export function drawingTouchesRect(o: DrawingObject, x1: number, y1: number, x2: number, y2: number): boolean {
  const { runs, width } = samplesOf(o);
  const r = Math.max(1.4, width / 2);
  for (const pts of runs) {
    if (!pts.length) continue;
    if (pts.length === 1) {
      if (diskHitsRect(pts[0], r, x1, y1, x2, y2)) return true;
      continue;
    }
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const steps = Math.max(1, Math.ceil(dist(a, b) / 4));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const p: Pt = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        if (diskHitsRect(p, r, x1, y1, x2, y2)) return true;
      }
    }
  }
  return false;
}
