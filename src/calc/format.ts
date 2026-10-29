/** Turns values into display node lists (rendered by the same renderer as the input). */
import { Ex, ExTerm, asRat, gcdBig, hasE } from "./exact";
import { ch, Node, tpl } from "./model";

export type NumFormat = "norm1" | "norm2" | "fix" | "sci";
export type IOMode = "MathO" | "DecO";
export type FracMode = "dc" | "abc";

export interface DispSetup {
  fmt: NumFormat;
  digits: number; // Fix 0–9, Sci 0–9 (0 = 10)
  frac: FracMode;
}

const chars = (s: string): Node[] => [...s].map((c) => ch(c === "-" ? "neg" : c));

/* ---------------- decimals ---------------- */

export interface DecParts {
  mant: string; // e.g. "-1.2345"
  exp: number | null;
}

function trimZeros(s: string) {
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

/** Round to `sig` significant digits and return [digits-string mantissa, exponent]. */
function sigParts(x: number, sig: number): { m: string; e: number } {
  const s = Math.abs(x).toExponential(sig - 1); // d.ddddde±x
  const [m, e] = s.split("e");
  return { m, e: Number(e) };
}

export function formatDecimal(x: number, d: DispSetup): DecParts {
  if (x === 0 || Object.is(x, -0)) {
    if (d.fmt === "fix") return { mant: (0).toFixed(d.digits), exp: null };
    if (d.fmt === "sci") {
      const n = d.digits || 10;
      return { mant: (0).toFixed(n - 1), exp: 0 };
    }
    return { mant: "0", exp: null };
  }
  const neg = x < 0 ? "-" : "";
  const ax = Math.abs(x);
  if (d.fmt === "sci") {
    const n = d.digits || 10;
    const { m, e } = sigParts(ax, n);
    return { mant: neg + m, exp: e };
  }
  if (d.fmt === "fix") {
    const f = ax.toFixed(d.digits);
    if (ax >= 1e10 || Number(f) >= 1e10) {
      const { m, e } = sigParts(ax, 10);
      return { mant: neg + trimZeros(m), exp: e };
    }
    // a value that rounds to zero still shows its digits as 0.00…
    return { mant: (Number(f) === 0 ? "" : neg) + f, exp: null };
  }
  const { m, e } = sigParts(ax, 10);
  const lowLimit = d.fmt === "norm1" ? -3 : -10; // norm1: < 0.01 → sci; norm2: < 1e-9 → sci
  if (e >= 10 || e <= lowLimit) return { mant: neg + trimZeros(m), exp: e };
  // fixed notation with 10 significant digits
  const digits = m.replace(".", "");
  let out: string;
  if (e >= 0) {
    const ip = digits.slice(0, e + 1).padEnd(e + 1, "0");
    const fp = digits.slice(e + 1);
    out = fp ? `${ip}.${fp}` : ip;
  } else out = `0.${"0".repeat(-e - 1)}${digits}`;
  return { mant: neg + trimZeros(out), exp: null };
}

/** Engineering notation; `shift` moves the exponent by multiples of 3 (ENG / SHIFT ENG presses). */
export function formatEng(x: number, shift: number, d: DispSetup): DecParts {
  if (x === 0) return { mant: "0", exp: 0 };
  const neg = x < 0 ? "-" : "";
  const sig = d.fmt === "sci" ? d.digits || 10 : 10;
  const { m, e } = sigParts(Math.abs(x), sig);
  let exp = Math.floor(e / 3) * 3 + shift * 3;
  const val = Number(m) * 10 ** (e - exp);
  let s: string;
  if (d.fmt === "fix") s = val.toFixed(d.digits);
  else s = trimZeros(Number(val.toPrecision(sig)).toFixed(Math.max(0, Math.min(20, sig - 1 - Math.floor(Math.log10(Math.abs(val) || 1))))));
  if (Number(s) === 0 && val !== 0) {
    // mantissa underflow after shifting right: keep the significant digits
    s = trimZeros(val.toPrecision(sig));
  }
  void exp;
  return { mant: neg + s, exp: exp };
}

export function decNodes(p: DecParts): Node[] {
  const out = chars(p.mant);
  if (p.exp !== null) out.push(tpl("e10", [chars(String(p.exp))]));
  return out;
}

export function decText(p: DecParts): string {
  const m = p.mant.replace(/^-/, "−");
  return p.exp === null ? m : `${m}×10^${String(p.exp).replace("-", "−")}`;
}

/* ---------------- exact (Math output) ---------------- */

const digitsOf = (n: bigint) => (n < 0n ? -n : n).toString().length;

/**
 * Exact display in ClassWiz forms, or null when the value must be shown as a decimal:
 *  • fractions (improper or mixed) with ≤ 10 digits in total
 *  • aπ/b
 *  • √ forms of up to two terms over a common denominator: (a√b ± c√d)/e, a,c < 100, b,d < 1000, e < 100
 */
export function exactNodes(ex: Ex, d: DispSetup): Node[] | null {
  if (hasE(ex)) return null;
  const terms = ex.filter((t) => t.n !== 0n);
  if (!terms.length) return null;
  const r = asRat(terms);
  if (r) {
    if (r.d === 1n) return null; // integers use decimal formatting
    return fracNodes(r.n, r.d, d);
  }
  if (terms.some((t) => t.ee !== 0)) return null;
  // π forms: a single term with π¹, no radical
  if (terms.some((t) => t.pi !== 0)) {
    if (terms.length !== 1) return null;
    const t = terms[0];
    if (t.pi !== 1 || t.rad !== 1n) return null;
    if (digitsOf(t.n) + digitsOf(t.d) > 10 || (t.n < 0n ? -t.n : t.n) >= 1000n || t.d >= 1000n) return null;
    const numer: Node[] = [];
    const an = t.n < 0n ? -t.n : t.n;
    if (an !== 1n) numer.push(...chars(an.toString()));
    numer.push(ch("π"));
    const sign: Node[] = t.n < 0n ? [ch("neg")] : [];
    if (t.d === 1n) return [...sign, ...numer];
    return [...sign, tpl("frac", [numer, chars(t.d.toString())])];
  }
  return sqrtForm(terms);
}

function fracNodes(n: bigint, dd: bigint, d: DispSetup): Node[] | null {
  const neg = n < 0n;
  const an = neg ? -n : n;
  const sign: Node[] = neg ? [ch("neg")] : [];
  if (d.frac === "abc" && an > dd) {
    const w = an / dd;
    const rem = an % dd;
    if (digitsOf(w) + digitsOf(rem) + digitsOf(dd) > 10) return null;
    return [...sign, tpl("mixed", [chars(w.toString()), chars(rem.toString()), chars(dd.toString())])];
  }
  if (digitsOf(an) + digitsOf(dd) > 10) return null;
  return [...sign, tpl("frac", [chars(an.toString()), chars(dd.toString())])];
}

function lcm(a: bigint, b: bigint) {
  return (a / gcdBig(a, b)) * b;
}

function sqrtForm(terms: ExTerm[]): Node[] | null {
  if (terms.length > 2) return null;
  // integer term first, then by radicand
  // a positive term leads (2√3−1, (√6−√2)/4); otherwise the integer term comes first
  const ts = [...terms].sort((a, b) => {
    if (a.n > 0n !== b.n > 0n) return a.n > 0n ? -1 : 1;
    if (a.rad === 1n) return -1;
    if (b.rad === 1n) return 1;
    return a.rad < b.rad ? -1 : 1;
  });
  let den = 1n;
  for (const t of ts) den = lcm(den, t.d);
  const coefs = ts.map((t) => (t.n * den) / t.d);
  if (den >= 100n) return null;
  for (let i = 0; i < ts.length; i++) {
    const c = coefs[i] < 0n ? -coefs[i] : coefs[i];
    if (c >= 100n || ts[i].rad >= 1000n) return null;
  }
  // common sign: if every coefficient is negative put the sign outside
  let outerNeg = false;
  if (coefs.every((c) => c < 0n) || (ts.length === 2 && den !== 1n && coefs[0] < 0n && coefs[1] < 0n)) {
    outerNeg = true;
    for (let i = 0; i < coefs.length; i++) coefs[i] = -coefs[i];
  }
  const numer: Node[] = [];
  ts.forEach((t, i) => {
    let c = coefs[i];
    if (i > 0) {
      numer.push(ch(c < 0n ? "-" : "+"));
      if (c < 0n) c = -c;
    } else if (c < 0n) {
      numer.push(ch("neg"));
      c = -c;
    }
    if (t.rad === 1n) numer.push(...chars(c.toString()));
    else {
      if (c !== 1n) numer.push(...chars(c.toString()));
      numer.push(tpl("sqrt", [chars(t.rad.toString())]));
    }
  });
  const sign: Node[] = outerNeg ? [ch("neg")] : [];
  if (den === 1n) return [...sign, ...numer];
  return [...sign, tpl("frac", [numer, chars(den.toString())])];
}

/* ---------------- DMS ---------------- */

export function dmsNodes(x: number): Node[] {
  const neg = x < 0;
  let a = Math.abs(x);
  let d = Math.floor(a);
  let mFloat = (a - d) * 60;
  let m = Math.floor(mFloat + 1e-9);
  let s = (mFloat - m) * 60;
  s = Math.round(s * 100) / 100;
  if (s >= 60) {
    s -= 60;
    m += 1;
  }
  if (m >= 60) {
    m -= 60;
    d += 1;
  }
  void a;
  const sStr = trimZeros(s.toFixed(2));
  return [...(neg ? [ch("neg")] : []), ...chars(String(d)), ch("°"), ...chars(String(m)), ch("°"), ...chars(sStr), ch("°")];
}

/* ---------------- prime factorisation (FACT) ---------------- */

export function factNodes(n: number): Node[] | null {
  if (!Number.isInteger(n) || n < 2 || n >= 1e10) return null;
  const out: Node[] = [];
  let x = n;
  const push = (p: number, k: number) => {
    if (out.length) out.push(ch("×"));
    out.push(...chars(String(p)));
    if (k > 1) out.push(tpl("pow", [chars(String(k))]));
  };
  for (let p = 2; p * p <= x && p <= 1000; p += p === 2 ? 1 : 2) {
    let k = 0;
    while (x % p === 0) {
      x /= p;
      k++;
    }
    if (k) push(p, k);
  }
  if (x > 1) {
    if (x > 1002001) {
      // the real calculator shows a remaining unfactored part in parentheses
      if (out.length) out.push(ch("×"));
      out.push(ch("("), ...chars(String(x)), ch(")"));
    } else push(x, 1);
  }
  return out;
}
