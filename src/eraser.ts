import { CanvasObject, DrawingObject, newId } from "./api";
import { pressureHitWidth, strokeRuns } from "./ink";

export type EraserMode = "area" | "shape";

type Pt = [number, number];

/** Eraser ring radius presets, in screen pixels (independent of zoom). */
export const ERASER_SIZES = { S: 6, M: 12, L: 24 } as const;
export type EraserSize = keyof typeof ERASER_SIZES;

function distToSeg(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function cross(o: Pt, a: Pt, b: Pt) {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

function segsIntersect(p: Pt, q: Pt, a: Pt, b: Pt): boolean {
  const d1 = cross(a, b, p);
  const d2 = cross(a, b, q);
  const d3 = cross(p, q, a);
  const d4 = cross(p, q, b);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function segDist(p: Pt, q: Pt, a: Pt, b: Pt): number {
  if (segsIntersect(p, q, a, b)) return 0;
  return Math.min(distToSeg(p, a, b), distToSeg(q, a, b), distToSeg(a, p, q), distToSeg(b, p, q));
}

function bezier(t: Pt, c1: Pt, c2: Pt, h: Pt, steps: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= steps; i++) {
    const u = i / steps;
    const m = 1 - u;
    const b0 = m * m * m, b1 = 3 * m * m * u, b2 = 3 * m * u * u, b3 = u * u * u;
    out.push([
      b0 * t[0] + b1 * c1[0] + b2 * c2[0] + b3 * h[0],
      b0 * t[1] + b1 * c1[1] + b2 * c2[1] + b3 * h[1],
    ]);
  }
  return out;
}

/** The visible line of a drawing as an absolute-coordinate polyline. */
function outline(o: DrawingObject): { pts: Pt[]; closed: boolean } {
  const it = o.item;
  const abs = (p: Pt): Pt => [o.x + p[0], o.y + p[1]];
  if (it.kind === "stroke") return { pts: it.points.map(abs), closed: false };
  if (it.kind === "arrow") {
    const line = it.shaft && it.shaft.length > 1 ? it.shaft : bezier(it.tail, it.c1, it.c2, it.head, 32);
    return { pts: line.map(abs), closed: false };
  }
  const { w, h } = it;
  let rel: Pt[];
  if (it.shape === "ellipse") {
    rel = Array.from({ length: 65 }, (_, i) => {
      const a = (i / 64) * Math.PI * 2;
      return [w / 2 + (w / 2) * Math.cos(a), h / 2 + (h / 2) * Math.sin(a)] as Pt;
    });
  } else if (it.shape === "triangle") {
    rel = [[w / 2, 0], [w, h], [0, h], [w / 2, 0]];
  } else if (it.shape === "diamond") {
    rel = [[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2], [w / 2, 0]];
  } else {
    rel = [[0, 0], [w, 0], [w, h], [0, h], [0, 0]];
  }
  return { pts: rel.map(abs), closed: true };
}

function resample(pts: Pt[], step: number): Pt[] {
  if (pts.length < 2) return pts;
  const out: Pt[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step);
    for (let k = 1; k <= n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
    if (n === 0) out.push(b);
  }
  return out;
}

function pathLength(pts: Pt[]): number {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return l;
}

function toStroke(src: DrawingObject, pts: Pt[], keepId: boolean): DrawingObject {
  let minX = Infinity, minY = Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p[0]);
    minY = Math.min(minY, p[1]);
  }
  return {
    type: "drawing",
    id: keepId ? src.id : newId("d"),
    x: minX,
    y: minY,
    z: src.z,
    item: {
      kind: "stroke",
      points: pts.map((p) => [p[0] - minX, p[1] - minY] as Pt),
      width: src.item.width,
      color: src.item.color,
      ...(src.item.kind === "stroke" && src.item.highlighter ? { highlighter: true } : {}),
      ...(src.item.kind === "stroke" && src.item.opacity != null ? { opacity: src.item.opacity } : {}),
    },
  };
}

function pointInPolygon(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Objects captured by a freeform lasso (canvas coords). Drawings need most of their
 * outline inside; text windows and images are caught when their centre is inside.
 */
export function lassoHits(
  objects: CanvasObject[],
  poly: Pt[],
  bbox: (o: CanvasObject) => { x: number; y: number; w: number; h: number },
): string[] {
  if (poly.length < 3) return [];
  return objects
    .filter((o) => {
      if (o.type === "drawing") {
        const chains = o.item.kind === "stroke"
          ? strokeRuns(o.item.points, o.item.parts).map((run) => run.map((p) => [o.x + p[0], o.y + p[1]] as Pt))
          : [outline(o).pts];
        const pts = chains.flatMap((c) => resample(c, 4));
        if (!pts.length) return false;
        const inside = pts.filter((p) => pointInPolygon(p, poly)).length;
        return inside / pts.length >= 0.7;
      }
      const b = bbox(o);
      return pointInPolygon([b.x + b.w / 2, b.y + b.h / 2], poly);
    })
    .map((o) => o.id);
}

/** Drop samples that sit closer than `minStep`, but keep both ends. */
function simplifyRun(pts: Pt[], minStep: number): Pt[] {
  if (pts.length < 3) return pts;
  const out: Pt[] = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const prev = out[out.length - 1];
    if (Math.hypot(pts[i][0] - prev[0], pts[i][1] - prev[1]) >= minStep) out.push(pts[i]);
  }
  const end = pts[pts.length - 1];
  const prev = out[out.length - 1];
  if (Math.hypot(end[0] - prev[0], end[1] - prev[1]) < minStep * 0.45 && out.length > 1) out[out.length - 1] = end;
  else out.push(end);
  return out;
}

/** Walk `dist` in from one end so a cut ribbon does not overlap the next piece. */
function trimEnd(pts: Pt[], dist: number, fromStart: boolean): Pt[] {
  if (pts.length < 2 || dist <= 0) return pts;
  let left = dist;
  if (fromStart) {
    let i = 0;
    while (i < pts.length - 1 && left > 0) {
      const step = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
      if (step > left) {
        const t = left / step;
        const p: Pt = [
          pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t,
          pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t,
        ];
        return [p, ...pts.slice(i + 1)];
      }
      left -= step;
      i++;
    }
    return pts.slice(Math.min(i, pts.length - 1));
  }
  let i = pts.length - 1;
  while (i > 0 && left > 0) {
    const step = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (step > left) {
      const t = left / step;
      const p: Pt = [
        pts[i][0] + (pts[i - 1][0] - pts[i][0]) * t,
        pts[i][1] + (pts[i - 1][1] - pts[i][1]) * t,
      ];
      return [...pts.slice(0, i), p];
    }
    left -= step;
    i--;
  }
  return pts.slice(0, Math.max(1, i + 1));
}

function toArrow(src: DrawingObject, pts: Pt[], keepId: boolean, ends: { head: boolean; tail: boolean }): DrawingObject {
  const it = src.item;
  if (it.kind !== "arrow") return toStroke(src, pts, keepId);
  let minX = Infinity, minY = Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p[0]);
    minY = Math.min(minY, p[1]);
  }
  const rel = pts.map((p) => [p[0] - minX, p[1] - minY] as Pt);
  const tail = rel[0];
  const head = rel[rel.length - 1];
  return {
    type: "drawing",
    id: keepId ? src.id : newId("d"),
    x: minX,
    y: minY,
    z: src.z,
    item: {
      kind: "arrow",
      tail,
      head,
      c1: [tail[0] + (head[0] - tail[0]) / 3, tail[1] + (head[1] - tail[1]) / 3],
      c2: [tail[0] + ((head[0] - tail[0]) * 2) / 3, tail[1] + ((head[1] - tail[1]) * 2) / 3],
      width: it.width,
      color: it.color,
      head_style: ends.head ? (it.head_style ?? "arrow") : "none",
      tail_style: ends.tail ? (it.tail_style ?? "none") : "none",
      ...(it.body ? { body: it.body } : {}),
      ...(rel.length > 2 ? { shaft: rel } : {}),
    },
  };
}

function runHits(pts: Pt[], a: Pt, b: Pt, tol: number): boolean {
  if (!pts.length) return false;
  if (pts.length === 1) return distToSeg(pts[0], a, b) <= tol;
  for (let i = 1; i < pts.length; i++) if (segDist(pts[i - 1], pts[i], a, b) <= tol) return true;
  return false;
}

/** Pieces of one run, or null when the eraser missed it. */
function splitRun(
  pts: Pt[],
  a: Pt,
  b: Pt,
  tol: number,
  step: number,
): { pts: Pt[]; cutStart: boolean; cutEnd: boolean }[] | null {
  if (!runHits(pts, a, b, tol)) return null;
  const dense = resample(pts, step);
  const keep = dense.map((p) => distToSeg(p, a, b) > tol);
  const pieces: { pts: Pt[]; cutStart: boolean; cutEnd: boolean }[] = [];
  let cur: Pt[] = [];
  let curCutStart = false;
  dense.forEach((p, i) => {
    if (keep[i]) {
      if (!cur.length) curCutStart = i > 0 && !keep[i - 1];
      cur.push(p);
    } else if (cur.length) {
      pieces.push({ pts: cur, cutStart: curCutStart, cutEnd: true });
      cur = [];
    }
  });
  if (cur.length) pieces.push({ pts: cur, cutStart: curCutStart, cutEnd: false });
  return pieces;
}

/**
 * Cut a marker but keep every remaining run in the same object.
 * Separate objects would multiply against each other, so a crossing
 * that used to be one trail would come out darker.
 * Returns the same object when the eraser missed, or null when nothing is left.
 */
function cutMarker(o: DrawingObject, a: Pt, b: Pt, r: number): DrawingObject | null {
  const it = o.item;
  if (it.kind !== "stroke") return o;
  const abs = (p: Pt): Pt => [o.x + p[0], o.y + p[1]];
  const runs = strokeRuns(it.points, it.parts).map((run) => run.map(abs));
  const tol = r + it.width / 2;
  const survivors: Pt[][] = [];
  let hit = false;
  for (const run of runs) {
    const pieces = splitRun(run, a, b, tol, Math.max(0.75, r / 3));
    if (!pieces) {
      survivors.push(run);
      continue;
    }
    hit = true;
    for (const piece of pieces) {
      let pts = piece.pts;
      const inset = it.width * 0.55;
      if (piece.cutStart) pts = trimEnd(pts, inset, true);
      if (piece.cutEnd) pts = trimEnd(pts, inset, false);
      pts = smoothPoints(simplifyRun(pts, Math.max(3, it.width * 0.4)), 1);
      if (pts.length >= 2 && pathLength(pts) >= 0.5) survivors.push(pts);
    }
  }
  if (!hit) return o;
  if (!survivors.length) return null;
  let minX = Infinity, minY = Infinity;
  for (const run of survivors) {
    for (const p of run) {
      minX = Math.min(minX, p[0]);
      minY = Math.min(minY, p[1]);
    }
  }
  const rel = survivors.map((run) => run.map((p) => [p[0] - minX, p[1] - minY] as Pt));
  const [points, ...parts] = rel;
  return {
    ...o,
    x: minX,
    y: minY,
    item: {
      kind: "stroke",
      points: points ?? [],
      ...(parts.length ? { parts } : {}),
      width: it.width,
      color: it.color,
      highlighter: true,
      ...(it.opacity != null ? { opacity: it.opacity } : {}),
    },
  };
}

/** Area mode can cut it into pieces; otherwise the whole object goes. */
function isCuttable(o: DrawingObject): boolean {
  const it = o.item;
  if (it.kind === "stroke" || it.kind === "arrow") return true;
  if (it.kind === "shape") return !it.fill;
  return false;
}

/**
 * Apply one eraser sweep from `a` to `b` (canvas coords, radius `r`).
 * Returns the new object list, or null when nothing was touched.
 */
export function eraseSweep(
  objects: CanvasObject[],
  a: Pt,
  b: Pt,
  r: number,
  mode: EraserMode,
): CanvasObject[] | null {
  const minX = Math.min(a[0], b[0]) - r, maxX = Math.max(a[0], b[0]) + r;
  const minY = Math.min(a[1], b[1]) - r, maxY = Math.max(a[1], b[1]) + r;
  let changed = false;
  const out: CanvasObject[] = [];
  /** New piece ids that should join the fold their source stroke belonged to. */
  const spawned: { from: string; id: string }[] = [];

  for (const o of objects) {
    if (o.type !== "drawing") {
      out.push(o);
      continue;
    }
    if (mode === "area" && o.item.kind === "stroke" && o.item.highlighter) {
      const next = cutMarker(o, a, b, r);
      if (next === o) {
        out.push(o);
        continue;
      }
      changed = true;
      if (next) out.push(next);
      continue;
    }
    const { pts, closed } = outline(o);
    const inkWidth = o.item.kind === "stroke" ? pressureHitWidth(o.item.width, o.item.pressure) : o.item.width;
    const tol = r + inkWidth / 2;
    const chains = o.item.kind === "stroke"
      ? strokeRuns(o.item.points, o.item.parts).map((run) => run.map((p) => [o.x + p[0], o.y + p[1]] as Pt))
      : [pts];
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    for (const chain of chains) {
      for (const p of chain) {
        bx0 = Math.min(bx0, p[0]);
        by0 = Math.min(by0, p[1]);
        bx1 = Math.max(bx1, p[0]);
        by1 = Math.max(by1, p[1]);
      }
    }
    const w2 = inkWidth / 2;
    if (bx1 + w2 < minX || bx0 - w2 > maxX || by1 + w2 < minY || by0 - w2 > maxY) {
      out.push(o);
      continue;
    }
    let hit = false;
    for (const chain of chains) {
      if (runHits(chain, a, b, tol)) {
        hit = true;
        break;
      }
    }
    if (!hit) {
      out.push(o);
      continue;
    }
    changed = true;
    if (mode === "shape" || !isCuttable(o)) continue;

    const dense = resample(pts, Math.max(0.75, r / 3));
    const keep = dense.map((p) => distToSeg(p, a, b) > tol);
    const pieces: { pts: Pt[]; cutStart: boolean; cutEnd: boolean }[] = [];
    let cur: Pt[] = [];
    let curCutStart = false;
    dense.forEach((p, i) => {
      if (keep[i]) {
        if (!cur.length) curCutStart = i > 0 && !keep[i - 1];
        cur.push(p);
      } else if (cur.length) {
        pieces.push({ pts: cur, cutStart: curCutStart, cutEnd: true });
        cur = [];
      }
    });
    if (cur.length) pieces.push({ pts: cur, cutStart: curCutStart, cutEnd: false });
    if (closed && pieces.length > 1 && keep[0] && keep[keep.length - 1]) {
      const last = pieces.pop()!;
      pieces[0] = { pts: [...last.pts, ...pieces[0].pts], cutStart: last.cutStart, cutEnd: pieces[0].cutEnd };
    }
    const hl = o.item.kind === "stroke" && !!o.item.highlighter;
    const arrow = o.item.kind === "arrow" ? o.item : null;
    let first = true;
    for (const piece of pieces) {
      let pts = piece.pts;
      if (hl) {
        const inset = o.item.width * 0.55;
        if (piece.cutStart) pts = trimEnd(pts, inset, true);
        if (piece.cutEnd) pts = trimEnd(pts, inset, false);
        pts = smoothPoints(simplifyRun(pts, Math.max(3, o.item.width * 0.4)), 1);
      }
      if (pts.length < 2 || pathLength(pts) < 0.5) continue;
      const near = Math.max(8, o.item.width);
      const pieceObj = arrow
        ? toArrow(o, pts, first, {
            head: Math.hypot(pts[pts.length - 1][0] - (o.x + arrow.head[0]), pts[pts.length - 1][1] - (o.y + arrow.head[1])) <= near,
            tail: Math.hypot(pts[0][0] - (o.x + arrow.tail[0]), pts[0][1] - (o.y + arrow.tail[1])) <= near,
          })
        : toStroke(o, pts, first);
      if (!first) spawned.push({ from: o.id, id: pieceObj.id });
      out.push(pieceObj);
      first = false;
    }
  }
  if (spawned.length) {
    for (let i = 0; i < out.length; i++) {
      const host = out[i];
      if (host.type !== "group") continue;
      const extra = spawned.filter((s) => host.children.includes(s.from)).map((s) => s.id);
      if (extra.length) out[i] = { ...host, children: [...host.children, ...extra] };
    }
  }
  return changed ? out : null;
}

/** Light 1-2-1 smoothing of mouse input; endpoints stay put. */
export function smoothPoints(pts: Pt[], passes = 2): Pt[] {
  let cur = pts;
  for (let k = 0; k < passes && cur.length > 2; k++) {
    const next: Pt[] = [cur[0]];
    for (let i = 1; i < cur.length - 1; i++) {
      next.push([
        (cur[i - 1][0] + 2 * cur[i][0] + cur[i + 1][0]) / 4,
        (cur[i - 1][1] + 2 * cur[i][1] + cur[i + 1][1]) / 4,
      ]);
    }
    next.push(cur[cur.length - 1]);
    cur = next;
  }
  return cur;
}

/** SVG path through the points using quadratic curves between midpoints. */
export function strokePath(pts: [number, number][]): string {
  if (!pts.length) return "";
  if (pts.length < 3) return `M ${pts.map((p) => p.join(" ")).join(" L ")}`;
  let d = `M ${pts[0][0]} ${pts[0][1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2;
    const my = (pts[i][1] + pts[i + 1][1]) / 2;
    d += ` Q ${pts[i][0]} ${pts[i][1]} ${mx} ${my}`;
  }
  const last = pts[pts.length - 1];
  return `${d} L ${last[0]} ${last[1]}`;
}

/** A click with the pen (no movement) becomes a small round dot that also survives PDF export. */
export function dotPoints(width: number): Pt[] {
  const r = Math.max(0.6, width * 0.4);
  return Array.from({ length: 9 }, (_, i) => {
    const a = (i / 8) * Math.PI * 2;
    return [r + r * Math.cos(a), r + r * Math.sin(a)] as Pt;
  });
}
