import type { DrawingItem, DrawingObject } from "./api";
import { strokeRuns } from "./ink";

export type Pt = [number, number];

export type ArrowHeadKind = "drawn" | "open" | "full" | "none";

/** Legacy notes store "arrow" for the filled tip. New arrows say which tip they use. */
export function arrowHeadKind(style?: string): ArrowHeadKind {
  if (style === "none") return "none";
  if (style === "open") return "open";
  if (style === "drawn") return "drawn";
  return "full";
}

/**
 * Tip length along the shaft. It depends on the stroke width only: 6px plus 2.5px per
 * stroke-px (width 2 → 11px, width 4 → 16px, width 8 → 26px), the same for any arrow length.
 * Only a very short shaft shrinks it, so a body stays visible: the head is at most 40% of it.
 * `len` is the shaft's length along the path. Must match export.rs `arrow_reach`.
 */
export function arrowReach(len: number, width: number): number {
  const ideal = Math.max(8, 6 + width * 2.5);
  if (!(len > 1)) return Math.max(3, width * 1.6);
  return Math.min(ideal, len * 0.4);
}

/** Length along a polyline. */
export function pathLength(pts: Pt[]): number {
  let n = 0;
  for (let i = 1; i < pts.length; i++) n += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return n;
}

function unit(from: Pt, to: Pt): { ux: number; uy: number; len: number } {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const len = Math.hypot(dx, dy) || 1;
  return { ux: dx / len, uy: dy / len, len };
}

/** Stable 0..1 wobble so a drawn tip doesn't change every render. */
function wobble(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

export function cubicPoints(tail: Pt, c1: Pt, c2: Pt, head: Pt, steps = 28): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i <= steps; i++) {
    const u = i / steps;
    const m = 1 - u;
    const b0 = m * m * m;
    const b1 = 3 * m * m * u;
    const b2 = 3 * m * u * u;
    const b3 = u * u * u;
    pts.push([
      b0 * tail[0] + b1 * c1[0] + b2 * c2[0] + b3 * head[0],
      b0 * tail[1] + b1 * c1[1] + b2 * c2[1] + b3 * head[1],
    ]);
  }
  return pts;
}

export function arrowCenterline(it: { tail: Pt; head: Pt; c1: Pt; c2: Pt; shaft?: Pt[] }): Pt[] {
  if (it.shaft && it.shaft.length >= 2) return it.shaft.map((p) => [p[0], p[1]]);
  return cubicPoints(it.tail, it.c1, it.c2, it.head);
}

function trimEnd(pts: Pt[], dist: number): Pt[] {
  if (pts.length < 2 || dist <= 0.5) return pts;
  const out = pts.map((p) => [p[0], p[1]] as Pt);
  let left = dist;
  while (out.length >= 2 && left > 0) {
    const a = out[out.length - 2];
    const b = out[out.length - 1];
    const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (seg > left + 0.01) {
      const t = (seg - left) / seg;
      out[out.length - 1] = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      break;
    }
    left -= seg;
    out.pop();
  }
  return out.length >= 2 ? out : pts.slice(0, 2);
}

/**
 * The point on the line `need` px (straight distance) back from its end. The head points from
 * there to the end: the end tangent over the stretch the head covers, so it lies along the last
 * bit of the line instead of the start→end direction. Must match export.rs `aim_back`.
 */
export function aimBack(line: Pt[], need: number): Pt {
  const end = line[line.length - 1];
  for (let i = line.length - 2; i >= 0; i--) {
    const p = line[i];
    const d = Math.hypot(p[0] - end[0], p[1] - end[1]);
    if (d >= need) {
      // Interpolate on the segment p → next so the distance is exactly `need`.
      const q = line[i + 1];
      const dq = Math.hypot(q[0] - end[0], q[1] - end[1]);
      const t = d - dq > 1e-6 ? (need - dq) / (d - dq) : 1;
      return [q[0] + (p[0] - q[0]) * t, q[1] + (p[1] - q[1]) * t];
    }
  }
  return line[0];
}

function pathOf(pts: Pt[]): string {
  if (pts.length < 2) return "";
  let d = `M ${pts[0][0].toFixed(2)} ${pts[0][1].toFixed(2)}`;
  for (let i = 1; i < pts.length; i++) d += ` L ${pts[i][0].toFixed(2)} ${pts[i][1].toFixed(2)}`;
  return d;
}

function offsetLine(pts: Pt[], dist: number): Pt[] {
  if (pts.length < 2 || dist === 0) return pts;
  const out: Pt[] = [];
  for (let i = 0; i < pts.length; i++) {
    const prev = pts[Math.max(0, i - 1)];
    const next = pts[Math.min(pts.length - 1, i + 1)];
    let dx = next[0] - prev[0];
    let dy = next[1] - prev[1];
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    out.push([pts[i][0] - dy * dist, pts[i][1] + dx * dist]);
  }
  return out;
}

/**
 * Tip polygon. Open and full: index 0 is the point, then the two barbs.
 * Drawn is a wide sketch: blunt nose, uneven barbs, concave notch at the shaft.
 * `shaftLen` is the whole shaft (not the last segment) so the head isn't tiny.
 */
export function arrowHeadPoints(from: Pt, to: Pt, width: number, kind: ArrowHeadKind, shaftLen?: number): Pt[] {
  const { ux, uy, len } = unit(from, to);
  const reach = arrowReach(Math.max(len, shaftLen ?? 0), width);
  const px = -uy;
  const py = ux;
  const at = (along: number, side: number): Pt => [
    to[0] + ux * along * reach + px * side * reach,
    to[1] + uy * along * reach + py * side * reach,
  ];
  if (kind === "drawn") {
    // along 0 sits on the endpoint; negative runs back toward the tail. side is perpendicular.
    const sketch: Array<[number, number]> = [
      [0, 0.07],
      [-0.37, 0.31],
      [-0.65, 0.5],
      [-0.92, 0.58],
      [-0.96, 0.39],
      [-0.69, 0.21],
      [-0.48, 0.07],
      [-0.42, -0.04],
      [-0.61, -0.13],
      [-0.85, -0.25],
      [-0.88, -0.4],
      [-0.8, -0.42],
      [-0.53, -0.34],
      [-0.18, -0.19],
      [0, -0.04],
    ];
    const s = to[0] * 12.3 + to[1] * 4.7 + from[0] * 0.3 + from[1];
    const last = sketch.length - 1;
    return sketch.map(([along, side], i) => {
      // The nose stays on the line end; the rest wobbles a little.
      const ja = i === 0 || i === last ? 0 : (wobble(s + i * 2.2) - 0.5) * 0.08;
      const js = (wobble(s + i * 2.2 + 9.1) - 0.5) * 0.08;
      return at(Math.min(0, along + ja), (side + js) * 0.6);
    });
  }
  // The point sits exactly on the line end. Must match export.rs `arrow_head`.
  const wing = reach * (kind === "open" ? 0.42 : 0.36);
  const baseX = to[0] - ux * reach;
  const baseY = to[1] - uy * reach;
  return [to, [baseX + px * wing, baseY + py * wing], [baseX - px * wing, baseY - py * wing]];
}

export type ArrowDraw = {
  shafts: string[];
  /** Filled tip, SVG polygon points. */
  headFill: string | null;
  /** Open tip: two strokes from the point. */
  headOpen: [Pt, Pt][] | null;
};

/** Where the head sits on a line: the end, the point it aims from, and the shaft length. */
export function arrowHeadPlace(line: Pt[], width: number): { end: Pt; from: Pt; span: number } {
  const end = line[line.length - 1];
  const span = pathLength(line);
  const reach = arrowReach(span, width);
  let from = aimBack(line, Math.max(3, reach));
  if (Math.hypot(end[0] - from[0], end[1] - from[1]) < 1e-3) from = line[0];
  return { end, from, span };
}

/** The head polygon of an arrow item, as drawn (frame and hit box use it too). */
export function arrowHeadOf(it: { tail: Pt; head: Pt; c1: Pt; c2: Pt; shaft?: Pt[]; width: number; head_style?: string }): Pt[] {
  const kind = arrowHeadKind(it.head_style);
  if (kind === "none") return [];
  const { end, from, span } = arrowHeadPlace(arrowCenterline(it), it.width);
  return arrowHeadPoints(from, end, it.width, kind, span);
}

export function arrowDraw(it: {
  tail: Pt;
  head: Pt;
  c1: Pt;
  c2: Pt;
  shaft?: Pt[];
  width: number;
  head_style?: string;
  body?: string;
}): ArrowDraw {
  const kind = arrowHeadKind(it.head_style);
  const line = arrowCenterline(it);
  const { end, from: prev, span } = arrowHeadPlace(line, it.width);
  const reach = kind === "none" ? 0 : arrowReach(span, it.width);
  const body = trimEnd(line, kind === "open" ? reach * 0.2 : reach * 0.62);
  const gap = Math.max(it.width * 1.05, 2.6);
  const shafts =
    it.body === "double"
      ? [pathOf(offsetLine(body, gap / 2)), pathOf(offsetLine(body, -gap / 2))]
      : [pathOf(body)];
  if (kind === "none") return { shafts, headFill: null, headOpen: null };
  const poly = arrowHeadPoints(prev, end, it.width, kind, span);
  if (kind === "open") {
    return {
      shafts,
      headFill: null,
      headOpen: [
        [poly[0], poly[1]],
        [poly[0], poly[2]],
      ],
    };
  }
  return {
    shafts,
    headFill: poly.map((p) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(" "),
    headOpen: null,
  };
}

function mapPoint(x: number, y: number, ax: number, ay: number, sx: number, sy: number): Pt {
  return [ax + (x - ax) * sx, ay + (y - ay) * sy];
}

function rebase(pts: Pt[]): { x: number; y: number; pts: Pt[] } {
  let minX = Infinity;
  let minY = Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p[0]);
    minY = Math.min(minY, p[1]);
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, pts };
  return { x: minX, y: minY, pts: pts.map((p) => [p[0] - minX, p[1] - minY]) };
}

/** Scale a drawing around a canvas-space anchor. Used by the resize handles. */
export function scaleDrawing(obj: DrawingObject, ax: number, ay: number, sx: number, sy: number): DrawingObject {
  const it = obj.item;
  const abs = (p: Pt): Pt => mapPoint(obj.x + p[0], obj.y + p[1], ax, ay, sx, sy);
  if (it.kind === "stroke") {
    const runs = strokeRuns(it.points, it.parts).map((run) => run.map(abs));
    let minX = Infinity;
    let minY = Infinity;
    for (const run of runs) {
      for (const p of run) {
        minX = Math.min(minX, p[0]);
        minY = Math.min(minY, p[1]);
      }
    }
    if (!Number.isFinite(minX)) return obj;
    const rel = runs.map((run) => run.map((p) => [p[0] - minX, p[1] - minY] as Pt));
    const parts = rel.slice(1);
    return {
      ...obj,
      x: minX,
      y: minY,
      item: { ...it, points: rel[0] ?? [], parts: parts.length ? parts : undefined },
    };
  }
  if (it.kind === "shape") {
    const p0 = mapPoint(obj.x, obj.y, ax, ay, sx, sy);
    const p1 = mapPoint(obj.x + it.w, obj.y + it.h, ax, ay, sx, sy);
    return {
      ...obj,
      x: Math.min(p0[0], p1[0]),
      y: Math.min(p0[1], p1[1]),
      item: { ...it, w: Math.max(1, Math.abs(p1[0] - p0[0])), h: Math.max(1, Math.abs(p1[1] - p0[1])) },
    };
  }
  const tail = abs(it.tail);
  const head = abs(it.head);
  const c1 = abs(it.c1);
  const c2 = abs(it.c2);
  const shaft = it.shaft?.map(abs);
  const next = rebase([tail, head, c1, c2, ...(shaft ?? [])]);
  const rel = (p: Pt): Pt => [p[0] - next.x, p[1] - next.y];
  return {
    ...obj,
    x: next.x,
    y: next.y,
    item: {
      ...it,
      tail: rel(tail),
      head: rel(head),
      c1: rel(c1),
      c2: rel(c2),
      ...(shaft ? { shaft: shaft.map(rel) } : {}),
    },
  };
}

/** Light smooth used when a free arrow is committed. Keeps the gesture, drops the shake. */
export function smoothFreeShaft(pts: Pt[]): Pt[] {
  if (pts.length < 3) return pts.map((p) => [p[0], p[1]]);
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

/** True when a free stroke is close enough to its chord to store as a straight arrow. */
export function shaftIsStraight(pts: Pt[]): boolean {
  if (pts.length < 3) return true;
  const a = pts[0];
  const b = pts[pts.length - 1];
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  let worst = 0;
  for (const p of pts) {
    const t = ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / (len * len);
    const px = a[0] + (b[0] - a[0]) * t;
    const py = a[1] + (b[1] - a[1]) * t;
    worst = Math.max(worst, Math.hypot(p[0] - px, p[1] - py));
  }
  return worst < Math.max(6, len * 0.045);
}

export function polyPoints(pts: Pt[]): string {
  return pts.map((p) => `${p[0]},${p[1]}`).join(" ");
}

/** Keep the old export name used by the straight-arrow preview. */
export function arrowHeadPolygon(from: Pt, to: Pt, width: number): Pt[] {
  return arrowHeadPoints(from, to, width, "full");
}

export type ArrowItem = Extract<DrawingItem, { kind: "arrow" }>;
