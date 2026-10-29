/**
 * Parser + evaluator for the natural-display input tree, following the
 * fx-991EX (ClassWiz) calculation priority sequence:
 *
 *  1. functions with parentheses, templates
 *  2. postfix  x² x³ x⁻¹ x! °′″ % x^■ ×10^■ engineering symbols, unit conversions
 *  3. (fractions are templates and bind like operands)
 *  4. prefix (−)
 *  5. implied multiplication (2π, 3sin(30), 1÷2π = 1/(2π))
 *  6. nPr nCr
 *  7. × ÷
 *  8. + −
 */
import { CONSTS, CONVS, ENG_SYMBOLS } from "./data";
import {
  AngleMode,
  Ex,
  asRat,
  exAdd,
  exCbrt,
  exComb,
  exDiv,
  exFact,
  exIsZero,
  exLn,
  exLog10,
  exMul,
  exNeg,
  exPow,
  exSqrt,
  exValue,
  exactFn,
  floatToExact,
  gcdBig,
  ratEx,
  ratFromDecimal,
  term,
} from "./exact";
import type { Node, Slot } from "./model";

export type { AngleMode };

export interface Val {
  v: number;
  ex: Ex | null;
}

export class CalcError extends Error {
  kind: "Syntax" | "Math" | "Argument" | "Stack" | "Range" | "Time Out" | "Can't Solve";
  at: { slot: Slot; i: number } | null;
  constructor(kind: CalcError["kind"], at: CalcError["at"] = null) {
    super(kind === "Can't Solve" || kind === "Time Out" ? kind : `${kind} ERROR`);
    this.kind = kind;
    this.at = at;
  }
}

/* ------------------------------------------------------------------ */
/* Tokens                                                              */
/* ------------------------------------------------------------------ */

type TokKind = "num" | "var" | "const" | "ans" | "ran" | "op" | "neg" | "lp" | "rp" | "comma" | "fn" | "post" | "tpl" | "eq";

interface Tok {
  k: TokKind;
  v: string;
  node?: Node;
  slot: Slot;
  i: number; // index in slot of the first node of the token
}

const FN_NAMES: Record<string, string> = {
  "sin(": "sin",
  "cos(": "cos",
  "tan(": "tan",
  "sin⁻¹(": "asin",
  "cos⁻¹(": "acos",
  "tan⁻¹(": "atan",
  "sinh(": "sinh",
  "cosh(": "cosh",
  "tanh(": "tanh",
  "sinh⁻¹(": "asinh",
  "cosh⁻¹(": "acosh",
  "tanh⁻¹(": "atanh",
  "log(": "log",
  "ln(": "ln",
  "Pol(": "Pol",
  "Rec(": "Rec",
  "Rnd(": "Rnd",
  "RanInt#(": "RanInt",
  "GCD(": "GCD",
  "LCM(": "LCM",
  "Int(": "Int",
  "Intg(": "Intg",
  "(": "",
};

const POSTFIX_TOKS = new Set(["²", "³", "⁻¹", "!", "%", "°", "°u", "r", "g"]);

function tokenize(slot: Slot): Tok[] {
  const out: Tok[] = [];
  const items = slot.items;
  for (let i = 0; i < items.length; i++) {
    const n = items[i];
    if (n.kind !== "ch") {
      out.push({ k: "tpl", v: n.kind, node: n, slot, i });
      continue;
    }
    const v = n.v;
    if (/^[0-9.]$/.test(v)) {
      let j = i;
      let s = "";
      while (j < items.length && items[j].kind === "ch" && /^[0-9.]$/.test(items[j].v)) s += items[j++].v;
      if ((s.match(/\./g) || []).length > 1 || s === ".") throw new CalcError("Syntax", { slot, i: j });
      out.push({ k: "num", v: s, slot, i });
      i = j - 1;
      continue;
    }
    if (/^[A-FMXY]$/.test(v)) out.push({ k: "var", v, slot, i });
    else if (v === "π" || v === "e" || v.startsWith("c:")) out.push({ k: "const", v, slot, i });
    else if (v === "Ans") out.push({ k: "ans", v, slot, i });
    else if (v === "Ran#") out.push({ k: "ran", v, slot, i });
    else if (v === "+" || v === "-" || v === "×" || v === "÷") out.push({ k: "op", v, slot, i });
    else if (v === "nPr" || v === "nCr") out.push({ k: "op", v: v === "nPr" ? "P" : "C", slot, i });
    else if (v === "neg") out.push({ k: "neg", v, slot, i });
    else if (v in FN_NAMES) out.push({ k: v === "(" ? "lp" : "fn", v: FN_NAMES[v], slot, i });
    else if (v === ")") out.push({ k: "rp", v, slot, i });
    else if (v === ",") out.push({ k: "comma", v, slot, i });
    else if (v === "=") out.push({ k: "eq", v, slot, i });
    else if (POSTFIX_TOKS.has(v) || v.startsWith("v:") || v.startsWith("k:")) out.push({ k: "post", v, slot, i });
    else throw new CalcError("Syntax", { slot, i });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* AST                                                                 */
/* ------------------------------------------------------------------ */

export type Ast =
  | { k: "num"; text: string }
  | { k: "var"; name: string }
  | { k: "const"; name: string }
  | { k: "ans" }
  | { k: "ran" }
  | { k: "bin"; op: string; a: Ast; b: Ast }
  | { k: "neg"; a: Ast }
  | { k: "post"; op: string; a: Ast }
  | { k: "dms"; parts: Ast[] }
  | { k: "fn"; name: string; args: Ast[] }
  | { k: "tpl"; kind: string; a: Ast | null; slots: Ast[] }
  | { k: "eq"; a: Ast; b: Ast };

class Parser {
  toks: Tok[];
  p = 0;
  endSlot: Slot;
  constructor(slot: Slot) {
    this.toks = tokenize(slot);
    this.endSlot = slot;
  }
  peek(): Tok | undefined {
    return this.toks[this.p];
  }
  errAt(t?: Tok): CalcError {
    if (t) return new CalcError("Syntax", { slot: t.slot, i: t.i });
    return new CalcError("Syntax", { slot: this.endSlot, i: this.endSlot.items.length });
  }

  parseTop(allowEq: boolean): Ast {
    const a = this.parseAdd();
    const t = this.peek();
    if (t && t.k === "eq" && allowEq) {
      this.p++;
      const b = this.parseAdd();
      if (this.peek()) throw this.errAt(this.peek());
      return { k: "eq", a, b };
    }
    if (t) throw this.errAt(t);
    return a;
  }

  parseAdd(): Ast {
    let a = this.parseMul();
    for (;;) {
      const t = this.peek();
      if (t && t.k === "op" && (t.v === "+" || t.v === "-")) {
        this.p++;
        a = { k: "bin", op: t.v, a, b: this.parseMul() };
      } else return a;
    }
  }

  parseMul(): Ast {
    let a = this.parseComb();
    for (;;) {
      const t = this.peek();
      if (t && t.k === "op" && (t.v === "×" || t.v === "÷")) {
        this.p++;
        a = { k: "bin", op: t.v, a, b: this.parseComb() };
      } else return a;
    }
  }

  parseComb(): Ast {
    let a = this.parseImplied();
    for (;;) {
      const t = this.peek();
      if (t && t.k === "op" && (t.v === "P" || t.v === "C")) {
        this.p++;
        a = { k: "bin", op: t.v, a, b: this.parseImplied() };
      } else return a;
    }
  }

  startsOperand(t: Tok | undefined): boolean {
    if (!t) return false;
    if (t.k === "tpl") return t.v !== "pow" && t.v !== "e10";
    return t.k === "num" || t.k === "var" || t.k === "const" || t.k === "ans" || t.k === "ran" || t.k === "lp" || t.k === "fn";
  }

  parseImplied(): Ast {
    let a = this.parseUnary();
    while (this.startsOperand(this.peek())) {
      a = { k: "bin", op: "imp", a, b: this.parseUnary() };
    }
    return a;
  }

  parseUnary(): Ast {
    const t = this.peek();
    if (t && (t.k === "neg" || (t.k === "op" && (t.v === "-" || t.v === "+")))) {
      this.p++;
      const a = this.parseUnary();
      return t.v === "+" ? a : { k: "neg", a };
    }
    return this.parsePostfix();
  }

  parsePostfix(): Ast {
    let a = this.parsePrimary();
    for (;;) {
      const t = this.peek();
      if (!t) return a;
      if (t.k === "post") {
        this.p++;
        if (t.v === "°") {
          // d°m°s° — absorb following "number °" pairs as minutes and seconds
          const parts: Ast[] = [a];
          while (parts.length < 3) {
            const n1 = this.toks[this.p];
            const n2 = this.toks[this.p + 1];
            if (n1 && n2 && n1.k === "num" && n2.k === "post" && n2.v === "°") {
              parts.push({ k: "num", text: n1.v });
              this.p += 2;
            } else break;
          }
          a = { k: "dms", parts };
        } else a = { k: "post", op: t.v, a };
        continue;
      }
      if (t.k === "tpl" && (t.v === "pow" || t.v === "e10")) {
        this.p++;
        a = { k: "tpl", kind: t.v, a, slots: t.node!.slots.map((s) => parseSlot(s)) };
        continue;
      }
      return a;
    }
  }

  parsePrimary(): Ast {
    const t = this.peek();
    if (!t) throw this.errAt();
    this.p++;
    switch (t.k) {
      case "num":
        return { k: "num", text: t.v };
      case "var":
        return { k: "var", name: t.v };
      case "const":
        return { k: "const", name: t.v };
      case "ans":
        return { k: "ans" };
      case "ran":
        return { k: "ran" };
      case "lp": {
        const a = this.parseAdd();
        const c = this.peek();
        if (c && c.k === "rp") this.p++;
        else if (c) throw this.errAt(c);
        return a;
      }
      case "fn": {
        const args: Ast[] = [this.parseAdd()];
        for (;;) {
          const c = this.peek();
          if (c && c.k === "comma") {
            this.p++;
            args.push(this.parseAdd());
            continue;
          }
          if (c && c.k === "rp") this.p++;
          else if (c) throw this.errAt(c);
          break;
        }
        return { k: "fn", name: t.v, args };
      }
      case "tpl": {
        if (t.v === "e10") {
          // ×10^■ with nothing on its left means 1×10^■
          return { k: "tpl", kind: "e10", a: { k: "num", text: "1" }, slots: t.node!.slots.map((s) => parseSlot(s)) };
        }
        if (t.v === "pow") throw this.errAt(t);
        return { k: "tpl", kind: t.v, a: null, slots: t.node!.slots.map((s) => parseSlot(s)) };
      }
      default:
        throw this.errAt(t);
    }
  }
}

function parseSlot(s: Slot): Ast {
  return new Parser(s).parseTop(false);
}

export function parse(root: Slot, allowEq = false): Ast {
  return new Parser(root).parseTop(allowEq);
}

/* ------------------------------------------------------------------ */
/* Evaluation                                                          */
/* ------------------------------------------------------------------ */

export interface EvalEnv {
  angle: AngleMode;
  vars: Record<string, Val>;
  ans: Val;
  /** Round function used by Rnd( — depends on the display format. */
  rnd: (x: number) => number;
  /** variable overrides (∫ / d/dx / Σ bind X) */
  local?: Record<string, number>;
  deadline?: number;
}

export interface MultiResult {
  labels: [string, string];
  vals: [Val, Val];
}

const LIMIT = 1e100;

function num(v: number, ex: Ex | null = null): Val {
  if (!Number.isFinite(v) || Math.abs(v) >= LIMIT) throw new CalcError("Math");
  return { v, ex };
}

function exVal(ex: Ex | null, fallback: () => number): Val {
  if (ex) {
    const v = exValue(ex);
    if (Number.isFinite(v)) return num(v, ex);
  }
  return num(fallback());
}

const toRad = (x: number, m: AngleMode) => (m === "DEG" ? (x * Math.PI) / 180 : m === "GRA" ? (x * Math.PI) / 200 : x);
const fromRad = (x: number, m: AngleMode) => (m === "DEG" ? (x * 180) / Math.PI : m === "GRA" ? (x * 200) / Math.PI : x);

/** Reduce an angle in the current unit to a radian value with less noise for big degree inputs. */
function angleRad(x: number, m: AngleMode) {
  if (m === "DEG") return toRad(x % 360, m);
  if (m === "GRA") return toRad(x % 400, m);
  return x;
}

function clean(x: number): number {
  return Math.abs(x) < 1e-13 ? 0 : x;
}

function isInt(x: number) {
  return Number.isInteger(x) || Math.abs(x - Math.round(x)) < 1e-12 * Math.max(1, Math.abs(x));
}

function bigFact(n: number): bigint {
  let f = 1n;
  for (let i = 2n; i <= BigInt(n); i++) f *= i;
  return f;
}

export function evaluate(ast: Ast, env: EvalEnv): Val {
  if (env.deadline && Date.now() > env.deadline) throw new CalcError("Time Out");
  switch (ast.k) {
    case "num": {
      const ex = ratFromDecimal(ast.text);
      return num(Number(ast.text), ex);
    }
    case "var": {
      if (env.local && ast.name in env.local) {
        const x = env.local[ast.name];
        return num(x, Number.isInteger(x) ? floatToExact(x) : null);
      }
      return env.vars[ast.name] ?? num(0, ratEx(0n));
    }
    case "const": {
      if (ast.name === "π") return num(Math.PI, [term(1n, 1n, 1n, 1, 0)]);
      if (ast.name === "e") return num(Math.E, [term(1n, 1n, 1n, 0, 1)]);
      const c = CONSTS[ast.name.slice(2)];
      if (!c) throw new CalcError("Syntax");
      return num(Number(c.value), sciToExact(c.value));
    }
    case "ans":
      return env.ans;
    case "ran": {
      const k = Math.floor(Math.random() * 1000);
      return num(k / 1000, ratEx(BigInt(k), 1000n));
    }
    case "neg": {
      const a = evaluate(ast.a, env);
      return num(-a.v, a.ex ? exNeg(a.ex) : null);
    }
    case "bin":
      return evalBin(ast.op, evaluate(ast.a, env), () => evaluate(ast.b, env), env);
    case "post":
      return evalPost(ast.op, evaluate(ast.a, env), env);
    case "dms": {
      const parts = ast.parts.map((p) => evaluate(p, env));
      let ex: Ex | null = parts[0].ex;
      let v = parts[0].v;
      const div = [1n, 60n, 3600n];
      const neg = v < 0;
      for (let i = 1; i < parts.length; i++) {
        const add = parts[i].v / Number(div[i]);
        v = neg ? v - add : v + add;
        if (ex && parts[i].ex) {
          const t = exMul(parts[i].ex!, ratEx(1n, div[i]));
          ex = t ? exAdd(ex, neg ? exNeg(t) : t) : null;
        } else ex = null;
      }
      return num(v, ex);
    }
    case "fn":
      return evalFn(ast.name, ast.args, env);
    case "tpl":
      return evalTpl(ast, env);
    case "eq": {
      // "L = R" outside SOLVE / CALC assignment evaluates L − R
      const a = evaluate(ast.a, env);
      const b = evaluate(ast.b, env);
      return num(a.v - b.v, a.ex && b.ex ? exAdd(a.ex, exNeg(b.ex)) : null);
    }
  }
}

function sciToExact(s: string): Ex | null {
  const m = /^(-?)(\d+(?:\.\d+)?)(?:e([+-]?\d+))?$/.exec(s);
  if (!m) return null;
  let ex = ratFromDecimal(m[2]);
  const e = Number(m[3] ?? 0);
  if (e) ex = exMul(ex, e > 0 ? ratEx(10n ** BigInt(e)) : ratEx(1n, 10n ** BigInt(-e))) ?? ex;
  return m[1] ? exNeg(ex) : ex;
}

function exactOrNull<T>(f: () => T | null): T | null {
  try {
    return f();
  } catch {
    return null;
  }
}

function evalBin(op: string, a: Val, bf: () => Val, env: EvalEnv): Val {
  const b = bf();
  switch (op) {
    case "+":
      return exVal(a.ex && b.ex ? exAdd(a.ex, b.ex) : null, () => a.v + b.v);
    case "-":
      return exVal(a.ex && b.ex ? exAdd(a.ex, exNeg(b.ex)) : null, () => a.v - b.v);
    case "×":
    case "imp":
      return exVal(a.ex && b.ex ? exactOrNull(() => exMul(a.ex!, b.ex!)) : null, () => a.v * b.v);
    case "÷":
      if (b.v === 0 || (b.ex && exIsZero(b.ex))) throw new CalcError("Math");
      return exVal(a.ex && b.ex ? exactOrNull(() => exDiv(a.ex!, b.ex!)) : null, () => a.v / b.v);
    case "P":
    case "C": {
      if (!isInt(a.v) || !isInt(b.v) || a.v < 0 || b.v < 0 || b.v > a.v || a.v >= 1e10) throw new CalcError("Math");
      const n = Math.round(a.v);
      const r = Math.round(b.v);
      if (n <= 1000) {
        const ex = exComb(ratEx(BigInt(n)), ratEx(BigInt(r)), op === "P");
        if (ex) return exVal(ex, () => NaN);
      }
      // large: floating log-gamma style product
      let acc = 1;
      const k = op === "C" ? Math.min(r, n - r) : r;
      for (let i = 0; i < k; i++) {
        acc *= n - i;
        if (op === "C") acc /= i + 1;
        if (!Number.isFinite(acc)) throw new CalcError("Math");
      }
      return num(Math.round(acc) === acc ? acc : acc);
    }
  }
  void env;
  throw new CalcError("Syntax");
}

function evalPost(op: string, a: Val, env: EvalEnv): Val {
  switch (op) {
    case "²":
      return exVal(a.ex ? exactOrNull(() => exPow(a.ex!, ratEx(2n))) : null, () => a.v * a.v);
    case "³":
      return exVal(a.ex ? exactOrNull(() => exPow(a.ex!, ratEx(3n))) : null, () => a.v * a.v * a.v);
    case "⁻¹":
      if (a.v === 0) throw new CalcError("Math");
      return exVal(a.ex ? exactOrNull(() => exPow(a.ex!, ratEx(-1n))) : null, () => 1 / a.v);
    case "!": {
      if (!isInt(a.v) || a.v < 0 || a.v > 69) throw new CalcError("Math");
      const n = Math.round(a.v);
      const f = bigFact(n);
      return exVal(exFact(ratEx(BigInt(n))), () => Number(f));
    }
    case "%":
      return exVal(a.ex ? exMul(a.ex, ratEx(1n, 100n)) : null, () => a.v / 100);
    case "°u":
    case "r":
    case "g": {
      // explicit angle unit: convert into the current angle mode
      const from: AngleMode = op === "°u" ? "DEG" : op === "r" ? "RAD" : "GRA";
      if (from === env.angle) return a;
      const rad = toRad(a.v, from);
      let ex: Ex | null = null;
      if (a.ex) {
        // exact conversions between DEG/GRA and RAD (π-multiples)
        const piEx: Ex = [term(1n, 1n, 1n, 1, 0)];
        const per: Record<AngleMode, Ex> = { DEG: ratEx(180n), GRA: ratEx(200n), RAD: piEx };
        ex = exactOrNull(() => {
          const t = exDiv(a.ex!, per[from]);
          return t ? exMul(t, per[env.angle]) : null;
        });
      }
      return exVal(ex, () => fromRad(rad, env.angle));
    }
  }
  if (op.startsWith("k:")) {
    const sym = ENG_SYMBOLS.find((s) => s.sym === op.slice(2));
    if (!sym) throw new CalcError("Syntax");
    const f = sym.exp > 0 ? ratEx(10n ** BigInt(sym.exp)) : ratEx(1n, 10n ** BigInt(-sym.exp));
    return exVal(a.ex ? exMul(a.ex, f) : null, () => a.v * 10 ** sym.exp);
  }
  if (op.startsWith("v:")) {
    const c = CONVS[op.slice(2)];
    if (!c) throw new CalcError("Syntax");
    if (c.temp === "F2C") {
      const ex = a.ex ? exMul(exAdd(a.ex, ratEx(-32n)), ratEx(5n, 9n)) : null;
      return exVal(ex, () => ((a.v - 32) * 5) / 9);
    }
    if (c.temp === "C2F") {
      const m = a.ex ? exMul(a.ex, ratEx(9n, 5n)) : null;
      return exVal(m ? exAdd(m, ratEx(32n)) : null, () => (a.v * 9) / 5 + 32);
    }
    const f = c.factor!;
    let fx: Ex | null;
    let fv: number;
    if (f.includes("/")) {
      const [p, q] = f.split("/");
      const pe = ratFromDecimal(p);
      const qe = ratFromDecimal(q);
      fx = exDiv(pe, qe);
      fv = Number(p) / Number(q);
    } else {
      fx = ratFromDecimal(f);
      fv = Number(f);
    }
    return exVal(a.ex && fx ? exMul(a.ex, fx) : null, () => a.v * fv);
  }
  throw new CalcError("Syntax");
}

function trigExact(name: string, a: Val, env: EvalEnv): Ex | null {
  if (!a.ex) return null;
  return exactOrNull(() => exactFn(name, [a.ex!], env.angle));
}

function evalFn(name: string, argAsts: Ast[], env: EvalEnv): Val {
  if (name === "") {
    // plain "(" handled by parser; never here
    return evaluate(argAsts[0], env);
  }
  const arity: Record<string, number> = { Pol: 2, Rec: 2, RanInt: 2, GCD: 2, LCM: 2 };
  const want = arity[name] ?? 1;
  if (argAsts.length !== want) throw new CalcError("Syntax");
  const args = argAsts.map((x) => evaluate(x, env));
  const a = args[0];
  const m = env.angle;
  switch (name) {
    case "sin":
    case "cos": {
      const ex = trigExact(name, a, env);
      if (ex) return exVal(ex, () => NaN);
      if (Math.abs(a.v) >= (m === "RAD" ? 1e10 * Math.PI / 180 * 9 : 9e9)) throw new CalcError("Math");
      const r = angleRad(a.v, m);
      return num(clean(name === "sin" ? Math.sin(r) : Math.cos(r)));
    }
    case "tan": {
      if (a.ex) {
        const c = trigExact("cos", a, env);
        if (c && exIsZero(c)) throw new CalcError("Math");
        const ex = trigExact("tan", a, env);
        if (ex) return exVal(ex, () => NaN);
      }
      const r = angleRad(a.v, m);
      const c = Math.cos(r);
      if (Math.abs(c) < 1e-15) throw new CalcError("Math");
      return num(clean(Math.sin(r) / c));
    }
    case "asin":
    case "acos": {
      if (a.v < -1 - 1e-15 || a.v > 1 + 1e-15) throw new CalcError("Math");
      const ex = trigExact(name, a, env);
      if (ex) return exVal(ex, () => NaN);
      const x = Math.max(-1, Math.min(1, a.v));
      return num(fromRad(name === "asin" ? Math.asin(x) : Math.acos(x), m));
    }
    case "atan": {
      const ex = trigExact(name, a, env);
      if (ex) return exVal(ex, () => NaN);
      return num(fromRad(Math.atan(a.v), m));
    }
    case "sinh":
      return num(Math.sinh(a.v));
    case "cosh":
      return num(Math.cosh(a.v));
    case "tanh":
      return num(Math.tanh(a.v));
    case "asinh":
      return num(Math.asinh(a.v));
    case "acosh":
      if (a.v < 1) throw new CalcError("Math");
      return num(Math.acosh(a.v));
    case "atanh":
      if (a.v <= -1 || a.v >= 1) throw new CalcError("Math");
      return num(Math.atanh(a.v));
    case "log": {
      if (a.v <= 0) throw new CalcError("Math");
      return exVal(a.ex ? exactOrNull(() => exLog10(a.ex!)) ?? logRational(a, 10) : null, () => Math.log10(a.v));
    }
    case "ln": {
      if (a.v <= 0) throw new CalcError("Math");
      return exVal(a.ex ? exactOrNull(() => exLn(a.ex!)) : null, () => Math.log(a.v));
    }
    case "Pol": {
      const [x, y] = args;
      const r2 = x.ex && y.ex ? exactOrNull(() => exAdd(exPow(x.ex!, ratEx(2n))!, exPow(y.ex!, ratEx(2n))!)) : null;
      const rex = r2 ? exactOrNull(() => exSqrt(r2)) : null;
      return exVal(rex, () => Math.hypot(x.v, y.v));
    }
    case "Rec": {
      const [r, t] = args;
      return num(clean(r.v * Math.cos(angleRad(t.v, m))));
    }
    case "Rnd": {
      const v = env.rnd(a.v);
      return num(v, floatToExact(v));
    }
    case "RanInt": {
      const [lo, hi] = args;
      if (!isInt(lo.v) || !isInt(hi.v) || lo.v > hi.v || Math.abs(lo.v) >= 1e10 || Math.abs(hi.v) >= 1e10) throw new CalcError("Math");
      const k = Math.round(lo.v) + Math.floor(Math.random() * (Math.round(hi.v) - Math.round(lo.v) + 1));
      return num(k, ratEx(BigInt(k)));
    }
    case "GCD":
    case "LCM": {
      const [x, y] = args;
      if (!isInt(x.v) || !isInt(y.v) || Math.abs(x.v) >= 1e10 || Math.abs(y.v) >= 1e10) throw new CalcError("Math");
      const p = BigInt(Math.round(Math.abs(x.v)));
      const q = BigInt(Math.round(Math.abs(y.v)));
      const g = p === 0n && q === 0n ? 0n : gcdBig(p, q);
      const res = name === "GCD" ? g : g === 0n ? 0n : (p / g) * q;
      return num(Number(res), ratEx(res));
    }
    case "Int": {
      const v = Math.trunc(a.v + (a.v >= 0 ? 1e-12 : -1e-12) * 0);
      return num(v, ratEx(BigInt(v)));
    }
    case "Intg": {
      const r = a.ex ? asRat(a.ex) : null;
      if (r) {
        let q = r.n / r.d;
        if (r.n < 0n && q * r.d !== r.n) q -= 1n;
        return num(Number(q), ratEx(q));
      }
      const v = Math.floor(a.v);
      return num(v, ratEx(BigInt(v)));
    }
  }
  throw new CalcError("Syntax");
}

/** log_b(a) exactly when a is b^(p/q) for small q. */
function logRational(a: Val, base: number, baseEx?: Ex | null): Ex | null {
  const r = Math.log(a.v) / Math.log(base);
  if (!Number.isFinite(r)) return null;
  for (let q = 1; q <= 6; q++) {
    const p = Math.round(r * q);
    if (Math.abs(p / q - r) > 1e-12 * Math.max(1, Math.abs(r))) continue;
    const g = gcdNum(Math.abs(p), q);
    const pp = p / g;
    const qq = q / g;
    const b = baseEx ?? ratEx(BigInt(base));
    const check = exactOrNull(() => exPow(b, ratEx(BigInt(pp), BigInt(qq))));
    if (check && a.ex && exIsZero(exAdd(check, exNeg(a.ex)))) return ratEx(BigInt(pp), BigInt(qq));
    return null;
  }
  return null;
}

function gcdNum(a: number, b: number) {
  while (b) [a, b] = [b, a % b];
  return a || 1;
}

function evalTpl(ast: Extract<Ast, { k: "tpl" }>, env: EvalEnv): Val {
  const S = ast.slots;
  switch (ast.kind) {
    case "frac": {
      const n = evaluate(S[0], env);
      const d = evaluate(S[1], env);
      return evalBin("÷", n, () => d, env);
    }
    case "mixed": {
      const w = evaluate(S[0], env);
      const n = evaluate(S[1], env);
      const d = evaluate(S[2], env);
      const f = evalBin("÷", n, () => d, env);
      // a b/c: sign of the whole part applies to the fraction
      const neg = w.v < 0;
      return evalBin(neg ? "-" : "+", w, () => f, env);
    }
    case "sqrt": {
      const a = evaluate(S[0], env);
      if (a.v < 0) throw new CalcError("Math");
      return exVal(a.ex ? exactOrNull(() => exSqrt(a.ex!)) : null, () => Math.sqrt(a.v));
    }
    case "cbrt": {
      const a = evaluate(S[0], env);
      const ex = a.ex ? exactOrNull(() => (a.v < 0 ? (exCbrt(exNeg(a.ex!)) ? exNeg(exCbrt(exNeg(a.ex!))!) : null) : exCbrt(a.ex!))) : null;
      return exVal(ex, () => Math.cbrt(a.v));
    }
    case "root": {
      const n = evaluate(S[0], env);
      const x = evaluate(S[1], env);
      if (n.v === 0) throw new CalcError("Math");
      const ni = isInt(n.v) ? Math.round(n.v) : null;
      if (x.v < 0 && !(ni !== null && ni % 2 !== 0)) throw new CalcError("Math");
      let ex: Ex | null = null;
      if (ni === 2 && x.ex) ex = exactOrNull(() => exSqrt(x.ex!));
      else if (ni === 3 && x.ex) ex = exactOrNull(() => (x.v < 0 ? (exCbrt(exNeg(x.ex!)) ? exNeg(exCbrt(exNeg(x.ex!))!) : null) : exCbrt(x.ex!)));
      else if (ni !== null && x.ex && n.ex) {
        const r = Math.round(Math.abs(x.v) ** (1 / ni));
        if (r ** ni === Math.abs(x.v) && Number.isSafeInteger(r ** ni)) ex = ratEx(BigInt(x.v < 0 ? -r : r));
      }
      return exVal(ex, () => (x.v < 0 ? -(Math.abs(x.v) ** (1 / n.v)) : x.v ** (1 / n.v)));
    }
    case "pow": {
      const b = evaluate(ast.a!, env);
      const e = evaluate(S[0], env);
      return power(b, e);
    }
    case "e10": {
      const b = evaluate(ast.a!, env);
      const e = evaluate(S[0], env);
      return evalBin("×", b, () => power(num(10, ratEx(10n)), e), env);
    }
    case "pow10":
      return power(num(10, ratEx(10n)), evaluate(S[0], env));
    case "powe":
      return power(num(Math.E, [term(1n, 1n, 1n, 0, 1)]), evaluate(S[0], env));
    case "logb": {
      const b = evaluate(S[0], env);
      const a = evaluate(S[1], env);
      if (b.v <= 0 || b.v === 1 || a.v <= 0) throw new CalcError("Math");
      let ex: Ex | null = null;
      if (a.ex && b.ex) ex = logRational(a, b.v, b.ex);
      return exVal(ex, () => Math.log(a.v) / Math.log(b.v));
    }
    case "abs": {
      const a = evaluate(S[0], env);
      return num(Math.abs(a.v), a.ex ? (a.v < 0 ? exNeg(a.ex) : a.ex) : null);
    }
    case "integ":
      return integrate(S[0], evaluate(S[1], env).v, evaluate(S[2], env).v, env);
    case "deriv":
      return derive(S[0], evaluate(S[1], env).v, env);
    case "sum":
      return sigma(S[0], evaluate(S[1], env), evaluate(S[2], env), env);
  }
  throw new CalcError("Syntax");
}

function power(b: Val, e: Val): Val {
  if (b.v === 0 && e.v <= 0) throw new CalcError("Math");
  let ex: Ex | null = null;
  if (b.ex && e.ex) {
    const r = asRat(e.ex);
    if (r) {
      if (b.v < 0 && r.d % 2n === 0n) throw new CalcError("Math");
      ex = exactOrNull(() => exPow(b.ex!, e.ex!));
      // integer powers of plain rationals beyond the exPow range
      if (!ex && r.d === 1n) {
        const br = asRat(b.ex!);
        if (br && r.n >= -60n && r.n <= 330n) {
          const k = r.n < 0n ? -r.n : r.n;
          const nn = br.n ** k;
          const dd = br.d ** k;
          if (nn.toString().length < 120 && dd.toString().length < 120) ex = r.n < 0n ? ratEx(dd, nn) : ratEx(nn, dd);
        }
      }
    }
  }
  return exVal(ex, () => {
    if (b.v < 0 && !Number.isInteger(e.v)) {
      // odd-denominator rational exponents of negative bases are real
      for (let q = 3; q <= 15; q += 2) {
        const p = Math.round(e.v * q);
        if (Math.abs(p / q - e.v) < 1e-12) return (p % 2 ? -1 : 1) * Math.abs(b.v) ** e.v;
      }
      throw new CalcError("Math");
    }
    return b.v ** e.v;
  });
}

/* ---------------- numeric calculus ---------------- */

function fx(body: Ast, env: EvalEnv, x: number): number {
  const v = evaluate(body, { ...env, local: { ...(env.local ?? {}), X: x } }).v;
  if (!Number.isFinite(v)) throw new CalcError("Math");
  return v;
}

const GK_X = [
  0.991455371120812639, 0.949107912342758525, 0.864864423359769073, 0.741531185599394440, 0.586087235467691130,
  0.405845151377397167, 0.207784955007898468, 0,
];
const GK_WK = [
  0.022935322010529225, 0.063092092629978553, 0.104790010322250184, 0.140653259715525919, 0.169004726639267903,
  0.190350578064785410, 0.204432940075298892, 0.209482141084727828,
];
const GK_WG = [0, 0.129484966168869693, 0, 0.279705391489276668, 0, 0.381830050505118945, 0, 0.417959183673469388];

function gk15(f: (x: number) => number, a: number, b: number): { k: number; err: number } {
  const c = (a + b) / 2;
  const h = (b - a) / 2;
  let k = 0;
  let g = 0;
  for (let i = 0; i < 8; i++) {
    if (i === 7) {
      const y = f(c);
      k += GK_WK[i] * y;
      g += GK_WG[i] * y;
    } else {
      const y1 = f(c - h * GK_X[i]);
      const y2 = f(c + h * GK_X[i]);
      k += GK_WK[i] * (y1 + y2);
      g += GK_WG[i] * (y1 + y2);
    }
  }
  return { k: k * h, err: Math.abs((k - g) * h) };
}

function integrate(body: Ast, a: number, b: number, env: EvalEnv): Val {
  if (a === b) return num(0, ratEx(0n));
  const deadline = Date.now() + 2500;
  const f = (x: number) => fx(body, { ...env, deadline }, x);
  const sign = a > b ? -1 : 1;
  const [lo, hi] = a > b ? [b, a] : [a, b];
  let total = 0;
  let evals = 0;
  const stack: [number, number, number][] = [[lo, hi, 0]];
  const tol = 1e-12;
  while (stack.length) {
    const [x0, x1, depth] = stack.pop()!;
    const r = gk15(f, x0, x1);
    evals++;
    if (evals > 4000) throw new CalcError("Time Out");
    const scale = Math.max(1, Math.abs(r.k));
    if (r.err <= tol * scale * Math.max((x1 - x0) / (hi - lo), 1e-6) || depth > 40) total += r.k;
    else {
      const m = (x0 + x1) / 2;
      stack.push([x0, m, depth + 1], [m, x1, depth + 1]);
    }
  }
  const v = clean(sign * total);
  return num(v, guessRational(v));
}

function derive(body: Ast, x: number, env: EvalEnv): Val {
  // Ridders' method of polynomial extrapolation
  const f = (t: number) => fx(body, env, t);
  const CON = 1.4;
  const CON2 = CON * CON;
  const NTAB = 10;
  let h = 0.05 * Math.max(1, Math.abs(x));
  const a: number[][] = Array.from({ length: NTAB }, () => new Array(NTAB).fill(0));
  a[0][0] = (f(x + h) - f(x - h)) / (2 * h);
  let err = Infinity;
  let ans = a[0][0];
  for (let i = 1; i < NTAB; i++) {
    h /= CON;
    a[0][i] = (f(x + h) - f(x - h)) / (2 * h);
    let fac = CON2;
    for (let j = 1; j <= i; j++) {
      a[j][i] = (a[j - 1][i] * fac - a[j - 1][i - 1]) / (fac - 1);
      fac *= CON2;
      const errt = Math.max(Math.abs(a[j][i] - a[j - 1][i]), Math.abs(a[j][i] - a[j - 1][i - 1]));
      if (errt <= err) {
        err = errt;
        ans = a[j][i];
      }
    }
    if (Math.abs(a[i][i] - a[i - 1][i - 1]) >= 2 * err) break;
  }
  if (!Number.isFinite(ans) || err > 1e-4 * Math.max(1, Math.abs(ans))) throw new CalcError("Math");
  const v = clean(ans);
  return num(v, guessRational(v));
}

function sigma(body: Ast, a: Val, b: Val, env: EvalEnv): Val {
  if (!isInt(a.v) || !isInt(b.v) || b.v < a.v) throw new CalcError("Math");
  const lo = Math.round(a.v);
  const hi = Math.round(b.v);
  if (hi - lo > 1_000_000) throw new CalcError("Time Out");
  const deadline = Date.now() + 2500;
  let total = 0;
  let ex: Ex | null = ratEx(0n);
  for (let x = lo; x <= hi; x++) {
    const v = evaluate(body, { ...env, deadline, local: { ...(env.local ?? {}), X: x } });
    total += v.v;
    if (ex && v.ex && hi - lo <= 2000) ex = exactOrNull(() => exAdd(ex!, v.ex!));
    else ex = null;
  }
  return exVal(ex, () => total);
}

/** Small-denominator rational when a numeric result is (to ~12 digits) a simple fraction. */
export function guessRational(v: number): Ex | null {
  if (!Number.isFinite(v)) return null;
  if (Math.abs(v) < 1e-300) return ratEx(0n);
  if (Math.abs(v) >= 1e12) return null;
  let h0 = 0,
    h1 = 1,
    k0 = 1,
    k1 = 0,
    x = Math.abs(v);
  for (let i = 0; i < 20; i++) {
    const a = Math.floor(x);
    [h0, h1] = [h1, a * h1 + h0];
    [k0, k1] = [k1, a * k1 + k0];
    if (k1 > 10000) return null;
    if (Math.abs(h1 / k1 - Math.abs(v)) <= 1e-11 * Math.max(1, Math.abs(v))) {
      return ratEx(BigInt(v < 0 ? -h1 : h1), BigInt(k1));
    }
    const f = x - a;
    if (f < 1e-15) break;
    x = 1 / f;
  }
  return null;
}

/* ---------------- top-level API ---------------- */

export interface CalcResult {
  val: Val;
  multi?: MultiResult;
  /** variable assigned by "Y = …" style CALC expressions */
  assigned?: string;
}

export function calculate(root: Slot, env: EvalEnv, opts: { allowEq?: boolean } = {}): CalcResult {
  const ast = parse(root, !!opts.allowEq);
  if (ast.k === "fn" && (ast.name === "Pol" || ast.name === "Rec")) {
    const [p, q] = ast.args.map((x) => evaluate(x, env));
    if (ast.name === "Pol") {
      const r = evalFn("Pol", ast.args, env);
      let th = fromRad(Math.atan2(q.v, p.v), env.angle);
      th = clean(th);
      const thEx = guessAngle(th, env.angle);
      const tv = num(th, thEx);
      return { val: r, multi: { labels: ["r", "θ"], vals: [r, tv] } };
    }
    const rad = angleRad(q.v, env.angle);
    const xv = clean(p.v * Math.cos(rad));
    const yv = clean(p.v * Math.sin(rad));
    const cx = p.ex ? trigExact("cos", q, env) : null;
    const sx = p.ex ? trigExact("sin", q, env) : null;
    const xe = cx && p.ex ? exactOrNull(() => exMul(p.ex!, cx)) : null;
    const ye = sx && p.ex ? exactOrNull(() => exMul(p.ex!, sx)) : null;
    const X = exVal(xe, () => xv);
    const Y = exVal(ye, () => yv);
    return { val: X, multi: { labels: ["x", "y"], vals: [X, Y] } };
  }
  if (ast.k === "eq" && opts.allowEq) {
    // "Y = expr": assign right side to a lone variable on the left
    if (ast.a.k === "var") {
      const v = evaluate(ast.b, env);
      return { val: v, assigned: ast.a.name };
    }
    throw new CalcError("Syntax");
  }
  return { val: evaluate(ast, env) };
}

function guessAngle(th: number, m: AngleMode): Ex | null {
  if (m === "RAD") {
    const k = th / Math.PI;
    const r = guessRational(k);
    if (r) {
      const rr = asRat(r)!;
      if (rr.d <= 12n) return [term(rr.n, rr.d, 1n, 1, 0)];
    }
    return null;
  }
  return floatToExact(Number(th.toPrecision(13)));
}

/** f(X) − g(X) for SOLVE (equation "L = R" or bare expression = 0). */
export function solve(root: Slot, env: EvalEnv, x0: number, unknown = "X"): { x: number; lr: number } {
  const ast = parse(root, true);
  const L = ast.k === "eq" ? ast.a : ast;
  const R = ast.k === "eq" ? ast.b : null;
  const deadline = Date.now() + 3000;
  const F = (x: number): number => {
    const e2: EvalEnv = { ...env, deadline, vars: { ...env.vars, [unknown]: { v: x, ex: null } } };
    const l = evaluate(L, e2).v;
    const r = R ? evaluate(R, e2).v : 0;
    return l - r;
  };
  const safeF = (x: number): number | null => {
    try {
      const v = F(x);
      return Number.isFinite(v) ? v : null;
    } catch (e) {
      if (e instanceof CalcError && e.kind === "Time Out") throw e;
      return null;
    }
  };
  const tolRoot = (x: number) => 1e-14 * Math.max(1, Math.abs(x));
  const finish = (x: number) => {
    const xr = Number(x.toPrecision(15));
    const lr = safeF(xr) ?? safeF(x) ?? 0;
    return { x: Math.abs(xr) < 1e-14 ? 0 : xr, lr: clean(lr) };
  };

  // 1) Newton with numeric derivative and damping
  let x = x0;
  let fxv = safeF(x);
  for (let it = 0; it < 120 && fxv !== null; it++) {
    if (fxv === 0) return finish(x);
    const h = 1e-7 * Math.max(1, Math.abs(x));
    const f1 = safeF(x + h);
    const f2 = safeF(x - h);
    if (f1 === null || f2 === null) break;
    const d = (f1 - f2) / (2 * h);
    if (!Number.isFinite(d) || d === 0) break;
    let step = fxv / d;
    let lam = 1;
    let nx = x - step;
    let nf = safeF(nx);
    while ((nf === null || Math.abs(nf) > Math.abs(fxv)) && lam > 1e-4) {
      lam /= 2;
      nx = x - lam * step;
      nf = safeF(nx);
    }
    if (nf === null) break;
    step = x - nx;
    x = nx;
    fxv = nf;
    if (Math.abs(step) <= tolRoot(x)) return finish(x);
    if (Math.abs(fxv) < 1e-15) return finish(x);
  }
  if (fxv !== null && Math.abs(fxv) < 1e-11) return finish(x);

  // 2) scan outward from the guess for a sign change, then bisection
  const scan = (a0: number): number | null => {
    let prevX = a0;
    let prevF = safeF(a0);
    for (let k = 0; k < 400; k++) {
      const span = (Math.max(1, Math.abs(a0)) * 1e-3) * 1.12 ** k;
      for (const dir of [1, -1]) {
        const xx = a0 + dir * span;
        const ff = safeF(xx);
        if (ff === null) continue;
        if (ff === 0) return xx;
        const ref = dir === 1 ? prevF : prevF;
        if (ref !== null && Math.sign(ff) !== Math.sign(ref)) {
          let lo = dir === 1 ? prevX : xx;
          let hi = dir === 1 ? xx : prevX;
          if (lo > hi) [lo, hi] = [hi, lo];
          let flo = safeF(lo);
          for (let i = 0; i < 200 && hi - lo > tolRoot(lo); i++) {
            const mid = (lo + hi) / 2;
            const fm = safeF(mid);
            if (fm === null || flo === null) return null;
            if (Math.sign(fm) === Math.sign(flo)) {
              lo = mid;
              flo = fm;
            } else hi = mid;
          }
          const root = (lo + hi) / 2;
          const fr = safeF(root);
          // reject poles (sign change through infinity)
          if (fr !== null && Math.abs(fr) < 1e-6 * Math.max(1, Math.abs(safeF(a0) ?? 1))) return root;
        }
      }
      prevX = a0 + span;
      prevF = safeF(prevX);
      if (Date.now() > deadline) throw new CalcError("Time Out");
    }
    return null;
  };
  const r = scan(x0);
  if (r !== null) return finish(r);
  throw new CalcError("Can't Solve");
}
