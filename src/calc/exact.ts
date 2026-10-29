/**
 * Exact arithmetic for "Math output": values that are finite sums of terms
 * (n/d)·√rad·π^pi·e^ee with BigInt coefficients. Anything that cannot stay in
 * this form returns null and the engine falls back to floating point.
 */

export type AngleMode = "DEG" | "RAD" | "GRA";

export type ExTerm = { n: bigint; d: bigint; rad: bigint; pi: number; ee: number };
export type Ex = ExTerm[];

export function gcdBig(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b) {
    const t = b;
    b = a % b;
    a = t;
  }
  return a || 1n;
}

export function isPerfectSquare(n: bigint): bigint | null {
  if (n < 2n) return n < 0n ? null : n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x * x === n ? x : null;
}

export function pullSquares(n: bigint): { coeff: bigint; rad: bigint } {
  if (n < 0n) n = -n;
  let coeff = 1n;
  let rad = 1n;
  let x = n;
  const take = (p: bigint) => {
    let pairs = 0n;
    let odd = false;
    while (x % p === 0n) {
      x /= p;
      if (odd) {
        pairs += 1n;
        odd = false;
      } else odd = true;
    }
    if (pairs) {
      let f = 1n;
      for (let i = 0n; i < pairs; i++) f *= p;
      coeff *= f;
    }
    if (odd) rad *= p;
  };
  if (x > 1n) take(2n);
  let p = 3n;
  while (x > 1n && p * p <= x && p <= 100000n) {
    take(p);
    p += 2n;
  }
  if (x > 1n) {
    const s = isPerfectSquare(x);
    if (s) coeff *= s;
    else rad *= x;
  }
  return { coeff, rad: rad === 0n ? 1n : rad };
}

/** Integer cube root when `n` is a perfect cube, otherwise null. */
export function pullCubes(n: bigint): bigint | null {
  if (n < 0n) return null;
  if (n < 2n) return n;
  let coeff = 1n;
  let x = n;
  const take = (p: bigint): boolean => {
    let c = 0;
    while (x % p === 0n) {
      x /= p;
      c++;
    }
    if (c % 3 !== 0) return false;
    let f = 1n;
    for (let i = 0; i < c / 3; i++) f *= p;
    coeff *= f;
    return true;
  };
  if (!take(2n)) return null;
  let p = 3n;
  while (x > 1n && p * p * p <= x && p <= 50000n) {
    if (!take(p)) return null;
    p += 2n;
  }
  if (x > 1n) {
    let lo = 1n;
    let hi = x;
    while (lo < hi) {
      const mid = (lo + hi) / 2n;
      if (mid * mid * mid < x) lo = mid + 1n;
      else hi = mid;
    }
    if (lo * lo * lo !== x) return null;
    coeff *= lo;
  }
  return coeff;
}

export function term(n: bigint, d = 1n, rad = 1n, pi = 0, ee = 0): ExTerm {
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  if (d === 0n) d = 1n;
  if (rad <= 0n) rad = 1n;
  const ps = pullSquares(rad);
  n *= ps.coeff;
  rad = ps.rad;
  if (n === 0n) return { n: 0n, d: 1n, rad: 1n, pi: 0, ee: 0 };
  const g = gcdBig(n, d);
  return { n: n / g, d: d / g, rad, pi, ee };
}

export function exAdd(a: Ex, b: Ex): Ex {
  const out = a.map((t) => ({ ...t }));
  for (const t of b) {
    if (t.n === 0n) continue;
    const i = out.findIndex((u) => u.rad === t.rad && u.pi === t.pi && u.ee === t.ee);
    if (i < 0) {
      out.push({ ...t });
      continue;
    }
    const u = out[i]!;
    const merged = term(u.n * t.d + t.n * u.d, u.d * t.d, u.rad, u.pi, u.ee);
    if (merged.n === 0n) out.splice(i, 1);
    else out[i] = merged;
  }
  return out.filter((t) => t.n !== 0n);
}

export function exNeg(a: Ex): Ex {
  return a.map((t) => term(-t.n, t.d, t.rad, t.pi, t.ee)).filter((t) => t.n !== 0n);
}

function mulTerm(a: ExTerm, b: ExTerm): ExTerm | null {
  const pi = a.pi + b.pi;
  const ee = a.ee + b.ee;
  if (pi > 4 || pi < -2 || ee > 4 || ee < -2) return null;
  return term(a.n * b.n, a.d * b.d, a.rad * b.rad, pi, ee);
}

export function exMul(a: Ex, b: Ex): Ex | null {
  if (!a.length) return b.some((t) => t.n !== 0n) ? null : [];
  if (!b.length) return a.some((t) => t.n !== 0n) ? null : [];
  if (a.length * b.length > 16) return null;
  let out: Ex = [];
  for (const x of a) {
    for (const y of b) {
      const m = mulTerm(x, y);
      if (!m) return null;
      out = exAdd(out, [m]);
    }
  }
  return out;
}

export function exIsZero(a: Ex): boolean {
  return a.every((t) => t.n === 0n);
}

export function asRat(a: Ex): { n: bigint; d: bigint } | null {
  const t = a.filter((x) => x.n !== 0n);
  if (!t.length) return { n: 0n, d: 1n };
  if (t.length !== 1) return null;
  const u = t[0]!;
  if (u.rad !== 1n || u.pi !== 0 || u.ee !== 0) return null;
  return { n: u.n, d: u.d };
}

export function exInv(a: Ex): Ex | null {
  const terms = a.filter((t) => t.n !== 0n);
  if (!terms.length) return null;
  if (terms.length === 1) {
    const t = terms[0]!;
    const pi = -t.pi;
    const ee = -t.ee;
    if (pi > 4 || pi < -2 || ee > 4 || ee < -2) return null;
    return [term(t.d, t.n * t.rad, t.rad, pi, ee)];
  }
  if (terms.length === 2 && terms.every((t) => t.pi === 0 && t.ee === 0)) {
    const [u, v] = terms;
    if (u!.rad === v!.rad) return exInv(exAdd([u!], [v!]));
    const radical = u!.rad !== 1n ? u! : v!;
    const rational = u!.rad === 1n ? u! : v!;
    if (rational.rad !== 1n || radical.rad === 1n) return null;
    const conj = exAdd([rational], [term(-radical.n, radical.d, radical.rad)]);
    const qq = exMul([rational], [rational]);
    const rr = exMul([radical], [radical]);
    if (!qq || !rr) return null;
    const den = exAdd(qq, exNeg(rr));
    if (den.length !== 1 || den[0]!.rad !== 1n || den[0]!.pi || den[0]!.ee || den[0]!.n === 0n) return null;
    return exMul(conj, [term(den[0]!.d, den[0]!.n)]);
  }
  return null;
}

export function exDiv(a: Ex, b: Ex): Ex | null {
  const inv = exInv(b);
  if (!inv) return null;
  return exMul(a, inv);
}

export function exSqrt(a: Ex): Ex | null {
  const t = a.filter((x) => x.n !== 0n);
  if (!t.length) return [term(0n)];
  if (t.length !== 1) return null;
  const u = t[0]!;
  if (u.n < 0n || u.pi || u.ee || u.rad !== 1n) return null;
  const ps = pullSquares(u.n * u.d);
  return [term(ps.coeff, u.d, ps.rad)];
}

export function exCbrt(a: Ex): Ex | null {
  const t = a.filter((x) => x.n !== 0n);
  if (!t.length) return [term(0n)];
  if (t.length !== 1) return null;
  const u = t[0]!;
  if (u.pi || u.ee || u.rad !== 1n) return null;
  const neg = u.n < 0n;
  const cubes = pullCubes((neg ? -u.n : u.n) * u.d * u.d);
  if (cubes == null) return null;
  return [term(neg ? -cubes : cubes, u.d)];
}

export function exPow(base: Ex, exp: Ex): Ex | null {
  const r = asRat(exp);
  if (!r) return null;
  if (r.d === 1n) {
    const k = Number(r.n);
    if (!Number.isSafeInteger(k) || Math.abs(k) > 16) return null;
    if (k === 0) return [term(1n)];
    let b = base;
    if (k < 0) {
      const inv = exInv(base);
      if (!inv) return null;
      b = inv;
    }
    let acc: Ex = [term(1n)];
    for (let i = 0; i < Math.abs(k); i++) {
      const m = exMul(acc, b);
      if (!m) return null;
      acc = m;
    }
    return acc;
  }
  if (r.d === 2n && r.n > 0n && r.n <= 8n) {
    const root = exSqrt(base);
    if (!root) return null;
    return exPow(root, [term(r.n)]);
  }
  if (r.d === 3n && r.n > 0n && r.n <= 6n) {
    const root = exCbrt(base);
    if (!root) return null;
    return exPow(root, [term(r.n)]);
  }
  return null;
}

function refSin(deg: number): Ex | null {
  switch (deg) {
    case 0:
      return [term(0n)];
    case 15:
      return [term(1n, 4n, 6n), term(-1n, 4n, 2n)];
    case 30:
      return [term(1n, 2n)];
    case 45:
      return [term(1n, 2n, 2n)];
    case 60:
      return [term(1n, 2n, 3n)];
    case 75:
      return [term(1n, 4n, 6n), term(1n, 4n, 2n)];
    case 90:
      return [term(1n)];
    default:
      return null;
  }
}

export function exactTrig(parts: { n: bigint; d: bigint }, fn: "sin" | "cos" | "tan"): Ex | null {
  const circ = 360n * parts.d;
  let n = parts.n % circ;
  if (n < 0n) n += circ;
  if (parts.d === 0n || n % parts.d !== 0n) return null;
  const ang = Number(n / parts.d) % 360;
  let s: Ex | null;
  let c: Ex | null;
  if (ang <= 90) {
    s = refSin(ang);
    c = refSin(90 - ang);
  } else if (ang <= 180) {
    s = refSin(180 - ang);
    const c0 = refSin(ang - 90);
    c = c0 ? exNeg(c0) : null;
  } else if (ang <= 270) {
    const s0 = refSin(ang - 180);
    const c0 = refSin(270 - ang);
    s = s0 ? exNeg(s0) : null;
    c = c0 ? exNeg(c0) : null;
  } else {
    const s0 = refSin(360 - ang);
    s = s0 ? exNeg(s0) : null;
    c = refSin(ang - 270);
  }
  if (!s || !c) return null;
  if (fn === "sin") return s;
  if (fn === "cos") return c;
  if (exIsZero(c)) return null;
  return exDiv(s, c);
}

export function toDegParts(a: Ex, mode: AngleMode): { n: bigint; d: bigint } | null {
  if (mode === "RAD") {
    const t = a.filter((x) => x.n !== 0n);
    if (!t.length) return { n: 0n, d: 1n };
    if (t.length !== 1 || t[0]!.rad !== 1n || t[0]!.ee !== 0 || t[0]!.pi !== 1) return null;
    return { n: t[0]!.n * 180n, d: t[0]!.d };
  }
  const r = asRat(a);
  if (!r) return null;
  if (mode === "GRA") return { n: r.n * 9n, d: r.d * 10n };
  return r;
}

export function fromDeg(deg: number, mode: AngleMode): Ex {
  if (deg === 0) return [term(0n)];
  if (mode === "DEG") return [term(BigInt(deg))];
  if (mode === "GRA") return [term(BigInt(deg) * 10n, 9n)];
  const neg = deg < 0;
  const a = Math.abs(deg);
  const g = gcdBig(BigInt(a), 180n);
  const t = term(BigInt(a) / g, 180n / g, 1n, 1, 0);
  return neg ? [term(-t.n, t.d, t.rad, t.pi, t.ee)] : [t];
}

export function exEq(a: Ex, b: Ex): boolean {
  return exIsZero(exAdd(a, exNeg(b)));
}

export function matchAngle(value: Ex, fn: "sin" | "cos" | "tan", lo: number, hi: number, step: number): number | null {
  for (let deg = lo; deg <= hi; deg += step) {
    const got = exactTrig({ n: BigInt(deg), d: 1n }, fn);
    if (got && exEq(got, value)) return deg;
  }
  return null;
}

export function exLog10(a: Ex): Ex | null {
  const r = asRat(a);
  if (!r || r.n <= 0n) return null;
  for (let k = -12; k <= 12; k++) {
    const n = k >= 0 ? 10n ** BigInt(k) : 1n;
    const d = k >= 0 ? 1n : 10n ** BigInt(-k);
    if (r.n === n && r.d === d) return [term(BigInt(k))];
  }
  return null;
}

export function exLn(a: Ex): Ex | null {
  const t = a.filter((x) => x.n !== 0n);
  if (t.length === 1 && t[0]!.rad === 1n && t[0]!.pi === 0 && t[0]!.n === t[0]!.d && t[0]!.ee !== 0) {
    return [term(BigInt(t[0]!.ee))];
  }
  const r = asRat(a);
  if (r && r.n === 1n && r.d === 1n) return [term(0n)];
  return null;
}

export function exFact(a: Ex): Ex | null {
  const r = asRat(a);
  if (!r || r.d !== 1n || r.n < 0n || r.n > 69n) return null;
  let f = 1n;
  for (let i = 2n; i <= r.n; i++) f *= i;
  return [term(f)];
}

export function exComb(n: Ex, r: Ex, perm: boolean): Ex | null {
  const a = asRat(n);
  const b = asRat(r);
  if (!a || !b || a.d !== 1n || b.d !== 1n || a.n < 0n || b.n < 0n || b.n > a.n || a.n > 200n) return null;
  let acc = 1n;
  for (let i = 0n; i < b.n; i++) {
    acc *= a.n - i;
    if (!perm) acc /= i + 1n;
  }
  return [term(acc)];
}

export function exactFn(name: string, args: Ex[], mode: AngleMode): Ex | null {
  const a = args[0];
  if (!a) return null;
  if (name === "sin" || name === "cos" || name === "tan") {
    const deg = toDegParts(a, mode);
    if (!deg) return null;
    return exactTrig(deg, name);
  }
  if (name === "asin" || name === "acos" || name === "atan") {
    const fn = name === "asin" ? "sin" : name === "acos" ? "cos" : "tan";
    const lo = name === "acos" ? 0 : -90;
    const hi = name === "acos" ? 180 : 90;
    const deg = matchAngle(a, fn, lo, hi, 15);
    if (deg == null) return null;
    return fromDeg(deg, mode);
  }
  if (name === "sqrt") return exSqrt(a);
  if (name === "cbrt") return exCbrt(a);
  if (name === "abs") {
    const v = exValue(a);
    if (!Number.isFinite(v)) return null;
    return v < 0 ? exNeg(a) : a;
  }
  if (name === "log") return exLog10(a);
  if (name === "ln") return exLn(a);
  if (name === "exp") {
    const r = asRat(a);
    if (!r || r.d !== 1n || r.n > 6n || r.n < -6n) return null;
    if (r.n === 0n) return [term(1n)];
    return [term(1n, 1n, 1n, 0, Number(r.n))];
  }
  if (name === "fact") return exFact(a);
  if (name === "ncr" || name === "npr") return exComb(a, args[1] ?? [], name === "npr");
  return null;
}


export function exValue(a: Ex): number {
  return a.reduce((s, t) => {
    const q = Number(t.n) / Number(t.d);
    return s + q * Math.sqrt(Number(t.rad)) * Math.PI ** t.pi * Math.E ** t.ee;
  }, 0);
}

/** Exact rational from a decimal literal like "12.5" or "0.125". */
export function ratFromDecimal(text: string): Ex {
  const [ip, fp = ""] = text.split(".");
  const digits = (ip || "0") + fp;
  const n = BigInt(digits.replace(/^0+(?=\d)/, "") || "0");
  const d = 10n ** BigInt(fp.length);
  return [term(n, d)];
}

export function ratEx(n: bigint, d = 1n): Ex {
  return [term(n, d)];
}

/** Best-effort exact value for a float that is (very nearly) a short decimal. */
export function floatToExact(v: number): Ex | null {
  if (!Number.isFinite(v)) return null;
  if (Number.isInteger(v) && Math.abs(v) < 1e15) return [term(BigInt(v))];
  const s = v.toPrecision(15);
  if (/e/i.test(s)) return null;
  const t = s.replace(/0+$/, "").replace(/\.$/, "");
  const frac = t.split(".")[1] ?? "";
  if (frac.length > 12) return null;
  const neg = t.startsWith("-");
  const ex = ratFromDecimal(neg ? t.slice(1) : t);
  return neg ? exNeg(ex) : ex;
}

export function hasE(a: Ex) {
  return a.some((t) => t.ee !== 0);
}
