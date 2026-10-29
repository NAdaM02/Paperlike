/**
 * Math for the Equation/Func, Inequality and Ratio apps.
 * Pure functions: values in, values out. Results stay exact (fractions and
 * square roots) whenever the inputs are rational, like the real ClassWiz.
 */
import { CalcError, Val } from "./engine";
import { Ex, asRat, exAdd, exDiv, exMul, exNeg, exSqrt, floatToExact, gcdBig, ratEx } from "./exact";

/* ---------------- small helpers ---------------- */

type Q = { n: bigint; d: bigint };

const q = (n: bigint, d = 1n): Q => {
  if (d < 0n) (n = -n), (d = -d);
  const g = gcdBig(n, d);
  return { n: n / g, d: d / g };
};
const qAdd = (a: Q, b: Q) => q(a.n * b.d + b.n * a.d, a.d * b.d);
const qSub = (a: Q, b: Q) => q(a.n * b.d - b.n * a.d, a.d * b.d);
const qMul = (a: Q, b: Q) => q(a.n * b.n, a.d * b.d);
const qDiv = (a: Q, b: Q) => q(a.n * b.d, a.d * b.n);
const qNum = (a: Q) => Number(a.n) / Number(a.d);
const qVal = (a: Q): Val => ({ v: qNum(a), ex: ratEx(a.n, a.d) });

function ratOf(v: Val): Q | null {
  if (!v.ex) return null;
  const r = asRat(v.ex);
  return r ? q(r.n, r.d) : null;
}

/** Snap tiny float noise: 1.9999999999997 → 2, 1e-17 → 0. */
function tidy(x: number, scale = 1): number {
  if (Math.abs(x) < 1e-11 * Math.max(1, scale)) return 0;
  const r = Math.round(x);
  if (Math.abs(x - r) < 1e-10 * Math.max(1, Math.abs(x))) return r;
  return Number(x.toPrecision(14));
}

export function fval(x: number, scale = 1): Val {
  const t = tidy(x, scale);
  // only short decimals become exact; long ones are irrational in practice
  const digits = Math.abs(t).toPrecision(14).replace(/e.*$/, "").replace(".", "").replace(/^0+/, "").replace(/0+$/, "");
  return { v: t, ex: digits.length <= 9 ? floatToExact(t) : null };
}

/** Exact-when-possible arithmetic on calculator values. */
export function vMul(a: Val, b: Val): Val {
  const ex = a.ex && b.ex ? exMul(a.ex, b.ex) : null;
  return { v: a.v * b.v, ex };
}
export function vDiv(a: Val, b: Val): Val {
  if (b.v === 0) throw new CalcError("Math");
  const ex = a.ex && b.ex ? exDiv(a.ex, b.ex) : null;
  return ex ? { v: a.v / b.v, ex } : fval(a.v / b.v);
}

/* ---------------- simultaneous linear equations ---------------- */

export type SimulResult = { kind: "one"; xs: Val[] } | { kind: "none" } | { kind: "infinite" };

/** rows: n rows of n coefficients plus the constant. */
export function solveSimul(rows: Val[][]): SimulResult {
  const n = rows.length;
  const rat = rows.map((r) => r.map(ratOf));
  if (rat.every((r) => r.every((x) => x !== null))) {
    const m = rat as Q[][];
    const rank = (cols: number) => {
      const a = m.map((r) => r.slice(0, cols));
      let rk = 0;
      for (let c = 0; c < cols && rk < n; c++) {
        const p = a.findIndex((r, i) => i >= rk && r[c].n !== 0n);
        if (p < 0) continue;
        [a[rk], a[p]] = [a[p], a[rk]];
        for (let i = 0; i < n; i++) {
          if (i === rk || a[i][c].n === 0n) continue;
          const f = qDiv(a[i][c], a[rk][c]);
          a[i] = a[i].map((x, j) => qSub(x, qMul(f, a[rk][j])));
        }
        rk++;
      }
      return { rk, a };
    };
    const coef = rank(n).rk;
    if (coef < n) return rank(n + 1).rk > coef ? { kind: "none" } : { kind: "infinite" };
    const { a } = rank(n + 1);
    return { kind: "one", xs: a.map((r, i) => qVal(qDiv(r[n], r[i]))) };
  }
  // floating point with partial pivoting
  const a = rows.map((r) => r.map((x) => x.v));
  const scale = Math.max(1, ...a.flat().map(Math.abs));
  const eps = 1e-11 * scale;
  let rk = 0;
  const pivCol: number[] = [];
  for (let c = 0; c < n && rk < n; c++) {
    let p = rk;
    for (let i = rk + 1; i < n; i++) if (Math.abs(a[i][c]) > Math.abs(a[p][c])) p = i;
    if (Math.abs(a[p][c]) < eps) continue;
    [a[rk], a[p]] = [a[p], a[rk]];
    for (let i = 0; i < n; i++) {
      if (i === rk) continue;
      const f = a[i][c] / a[rk][c];
      for (let j = c; j <= n; j++) a[i][j] -= f * a[rk][j];
    }
    pivCol.push(c);
    rk++;
  }
  if (rk < n) {
    for (let i = rk; i < n; i++) if (Math.abs(a[i][n]) > eps) return { kind: "none" };
    return { kind: "infinite" };
  }
  return { kind: "one", xs: a.map((r, i) => fval(r[n] / r[i], scale)) };
}

/* ---------------- polynomial roots ---------------- */

export interface Root {
  re: Val;
  /** imaginary part (positive or negative); null for a real root */
  im: Val | null;
}

/** Real roots of a·x²+b·x+c with exact surds; complex pairs too. */
function quadExact(a: Q, b: Q, c: Q): Root[] {
  const D = qSub(qMul(b, b), qMul(q(4n), qMul(a, c)));
  const two_a = qMul(q(2n), a);
  const re: Ex = ratEx(-b.n * two_a.d, b.d * two_a.n);
  const reV = -qNum(b) / qNum(two_a);
  const sq = exSqrt(ratEx(D.n < 0n ? -D.n : D.n, D.d));
  const sqV = Math.sqrt(Math.abs(qNum(D)));
  const inv2a: Ex = ratEx(two_a.d, two_a.n);
  const part = sq ? exMul(sq, inv2a) : null;
  const partV = sqV / qNum(two_a);
  if (D.n === 0n) return [{ re: { v: reV, ex: re }, im: null }];
  if (D.n > 0n) {
    const r1 = { v: reV + partV, ex: part ? exAdd(re, part) : null };
    const r2 = { v: reV - partV, ex: part ? exAdd(re, exNeg(part)) : null };
    return [r1, r2].map((r) => ({ re: r, im: null }));
  }
  const im = Math.abs(partV);
  const imEx = part ? (partV < 0 ? exNeg(part) : part) : null;
  return [
    { re: { v: reV, ex: re }, im: { v: im, ex: imEx } },
    { re: { v: reV, ex: re }, im: { v: -im, ex: imEx ? exNeg(imEx) : null } },
  ];
}

function divisors(n: bigint): bigint[] | null {
  if (n < 0n) n = -n;
  if (n > 10n ** 12n) return null;
  const out: bigint[] = [];
  for (let i = 1n; i * i <= n; i++) {
    if (n % i === 0n) {
      out.push(i);
      if (i * i !== n) out.push(n / i);
    }
  }
  return out;
}

/** coefficients highest degree first */
function evalQ(c: bigint[], x: Q): Q {
  let acc = q(0n);
  for (const k of c) acc = qAdd(qMul(acc, x), q(k));
  return acc;
}

/** Exact rational roots of an integer polynomial; returns them plus the deflated rest. */
function rationalRoots(c: bigint[]): { roots: Q[]; rest: bigint[] } {
  const roots: Q[] = [];
  let p = c.slice();
  for (;;) {
    if (p.length <= 1) break;
    if (p[p.length - 1] === 0n) {
      roots.push(q(0n));
      p = p.slice(0, -1);
      continue;
    }
    if (p.length <= 3 && roots.length) break; // a leftover quadratic is solved exactly anyway
    const ps = divisors(p[p.length - 1]);
    const qs = divisors(p[0]);
    if (!ps || !qs) break;
    let found: Q | null = null;
    outer: for (const a of ps)
      for (const b of qs)
        for (const s of [1n, -1n]) {
          const x = q(s * a, b);
          if (evalQ(p, x).n === 0n) {
            found = x;
            break outer;
          }
        }
    if (!found) break;
    roots.push(found);
    // divide by (d·x − n): integer synthetic division
    const { n, d } = found;
    const out: bigint[] = [];
    let carry = 0n;
    for (let i = 0; i < p.length - 1; i++) {
      const coef = (p[i] + carry) / d;
      out.push(coef);
      carry = coef * n;
    }
    p = out;
    const g = p.reduce((acc, x) => gcdBig(acc, x), 0n);
    if (g > 1n) p = p.map((x) => x / g);
  }
  return { roots, rest: p };
}

/** Durand–Kerner with Newton polish; coefficients highest first, real. */
function numericRoots(c: number[]): { re: number; im: number }[] {
  const n = c.length - 1;
  if (n < 1) return [];
  const a = c.map((x) => x / c[0]);
  const scale = 1 + Math.max(...a.slice(1).map(Math.abs));
  let z = Array.from({ length: n }, (_, k) => {
    const ang = (2 * Math.PI * k) / n + 0.4;
    return { re: scale * 0.9 * Math.cos(ang), im: scale * 0.9 * Math.sin(ang) };
  });
  const mul = (x: { re: number; im: number }, y: { re: number; im: number }) => ({ re: x.re * y.re - x.im * y.im, im: x.re * y.im + x.im * y.re });
  const div = (x: { re: number; im: number }, y: { re: number; im: number }) => {
    const d = y.re * y.re + y.im * y.im;
    return { re: (x.re * y.re + x.im * y.im) / d, im: (x.im * y.re - x.re * y.im) / d };
  };
  const pv = (x: { re: number; im: number }, cs = a) => {
    let r = { re: 0, im: 0 };
    for (const k of cs) r = { re: mul(r, x).re + k, im: mul(r, x).im };
    return r;
  };
  for (let it = 0; it < 800; it++) {
    let moved = 0;
    z = z.map((zi, i) => {
      let den = { re: 1, im: 0 };
      z.forEach((zj, j) => {
        if (j !== i) den = mul(den, { re: zi.re - zj.re, im: zi.im - zj.im });
      });
      const step = div(pv(zi), den);
      moved = Math.max(moved, Math.hypot(step.re, step.im));
      return { re: zi.re - step.re, im: zi.im - step.im };
    });
    if (moved < 1e-15 * scale) break;
  }
  // Newton polish on the full polynomial
  const da = a.slice(0, -1).map((k, i) => k * (n - i));
  return z.map((zi) => {
    for (let k = 0; k < 4; k++) {
      const d = pv(zi, da);
      if (Math.hypot(d.re, d.im) < 1e-300) break;
      const s = div(pv(zi), d);
      zi = { re: zi.re - s.re, im: zi.im - s.im };
    }
    return zi;
  });
}

/** All roots of a polynomial (coefficients highest degree first, leading ≠ 0). */
export function polyRoots(coefs: Val[]): Root[] {
  if (coefs[0].v === 0) throw new CalcError("Math");
  const rats = coefs.map(ratOf);
  const out: Root[] = [];
  if (rats.every((r) => r !== null)) {
    const qs = rats as Q[];
    const l = qs.reduce((acc, x) => (acc * x.d) / gcdBig(acc, x.d), 1n);
    const ints = qs.map((x) => (x.n * l) / x.d);
    const { roots, rest } = rationalRoots(ints);
    for (const r of roots) out.push({ re: qVal(r), im: null });
    if (rest.length === 3) out.push(...quadExact(q(rest[0]), q(rest[1]), q(rest[2])));
    else if (rest.length === 2) out.push({ re: qVal(q(-rest[1], rest[0])), im: null });
    else if (rest.length > 3) out.push(...numericToRoots(rest.map(Number)));
  } else if (coefs.length === 3) {
    const [a, b, c] = coefs.map((x) => x.v);
    const D = b * b - 4 * a * c;
    const s = Math.sqrt(Math.abs(D)) / (2 * a);
    const re = -b / (2 * a);
    if (Math.abs(D) < 1e-13 * Math.max(1, b * b)) out.push({ re: fval(re), im: null });
    else if (D > 0) out.push({ re: fval(re + s), im: null }, { re: fval(re - s), im: null });
    else out.push({ re: fval(re), im: fval(Math.abs(s)) }, { re: fval(re), im: fval(-Math.abs(s)) });
  } else out.push(...numericToRoots(coefs.map((x) => x.v)));
  return orderRoots(out);
}

function numericToRoots(c: number[]): Root[] {
  const zs = numericRoots(c);
  const scale = 1 + Math.max(...zs.map((z) => Math.hypot(z.re, z.im)));
  return zs.map((z) =>
    Math.abs(z.im) < 1e-9 * scale ? { re: fval(z.re, scale), im: null } : { re: fval(z.re, scale), im: fval(z.im, scale) },
  );
}

/** Real roots first (largest first, duplicates merged), then complex pairs with +i first. */
function orderRoots(rs: Root[]): Root[] {
  const real = rs.filter((r) => !r.im).sort((a, b) => b.re.v - a.re.v);
  const uniq: Root[] = [];
  for (const r of real) {
    const last = uniq[uniq.length - 1];
    if (last && Math.abs(last.re.v - r.re.v) <= 1e-9 * Math.max(1, Math.abs(r.re.v))) continue;
    uniq.push(r);
  }
  const cx = rs.filter((r) => r.im).sort((a, b) => b.re.v - a.re.v || b.im!.v - a.im!.v);
  return [...uniq, ...cx];
}

/** Vertex of a·x²+b·x+c: [x, y]. */
export function quadVertex(a: Val, b: Val, c: Val): [Val, Val] {
  const ra = ratOf(a), rb = ratOf(b), rc = ratOf(c);
  if (ra && rb && rc) {
    const x = qDiv(qMul(q(-1n), rb), qMul(q(2n), ra));
    const y = qAdd(qMul(ra, qMul(x, x)), qAdd(qMul(rb, x), rc));
    return [qVal(x), qVal(y)];
  }
  const x = -b.v / (2 * a.v);
  return [fval(x), fval(a.v * x * x + b.v * x + c.v)];
}

/* ---------------- inequalities ---------------- */

export type IneqOp = ">" | "<" | "≥" | "≤";

/** One piece of a solution set; null bound = infinite. */
export interface Piece {
  lo: Val | null;
  loIn: boolean;
  hi: Val | null;
  hiIn: boolean;
}

export type IneqResult = { kind: "all" } | { kind: "none" } | { kind: "set"; pieces: Piece[] };

export function solveIneq(coefs: Val[], op: IneqOp): IneqResult {
  const roots = polyRoots(coefs).filter((r) => !r.im).sort((a, b) => a.re.v - b.re.v);
  const cs = coefs.map((c) => c.v);
  const f = (x: number) => cs.reduce((acc, k) => acc * x + k, 0);
  const ok = (y: number) => (op === ">" ? y > 0 : op === "<" ? y < 0 : op === "≥" ? y > 0 : y < 0);
  const strict = op === ">" || op === "<";
  const xs = roots.map((r) => r.re.v);
  // test points between roots
  const tests: number[] = [];
  if (!xs.length) tests.push(0);
  else {
    const span = Math.max(1, xs[xs.length - 1] - xs[0]);
    tests.push(xs[0] - span);
    for (let i = 0; i + 1 < xs.length; i++) tests.push((xs[i] + xs[i + 1]) / 2);
    tests.push(xs[xs.length - 1] + span);
  }
  const segOk = tests.map((t) => ok(f(t)));
  if (!xs.length) return segOk[0] ? { kind: "all" } : { kind: "none" };
  const pieces: Piece[] = [];
  let open: Piece | null = segOk[0] ? { lo: null, loIn: false, hi: null, hiIn: false } : null;
  roots.forEach((r, i) => {
    const after = segOk[i + 1];
    const atRoot = !strict;
    if (open) {
      if (atRoot && after) return; // the root is included, keep going
      open.hi = r.re;
      open.hiIn = atRoot;
      pieces.push(open);
      open = null;
      if (after) open = { lo: r.re, loIn: false, hi: null, hiIn: false };
      return;
    }
    if (after) open = { lo: r.re, loIn: atRoot, hi: null, hiIn: false };
    else if (atRoot) pieces.push({ lo: r.re, loIn: true, hi: r.re, hiIn: true });
  });
  if (open) pieces.push(open);
  if (!pieces.length) return { kind: "none" };
  if (pieces.length === 1 && !pieces[0].lo && !pieces[0].hi) return { kind: "all" };
  return { kind: "set", pieces };
}
