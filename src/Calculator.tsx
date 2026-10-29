import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Calc, type AnswersScreen, type GridScreen, type InputScreen, type KeyId, type MenuScreen } from "./calc/core";
import type { Val } from "./calc/engine";
import { MathView } from "./calc/MathView";
import { IcClose } from "./icons";
import { CalcBody } from "./calc/Body";

/*
 * fx-991EX ClassWiz, drawn entirely in vector: the body (calc/Body), the
 * silver keys, the D-pad and every rectangular key with its legends, so every
 * label is crisp and every touch area is exactly the key you see. All
 * coordinates are in the 267 × 565 face space.
 */

const SKIN_W = 267;
const SKIN_H = 565;
const LCD = { x: 27.5, y: 84.8, w: 212, h: 83.6 };
const DPAD = { cx: 132.5, cy: 239.25, rx: 42, ry: 30.75 };
const SILVER: { id: KeyId; cx: number; label: string }[] = [
  { id: "shift", cx: 34, label: "SHIFT" },
  { id: "alpha", cx: 69, label: "ALPHA" },
  { id: "menu", cx: 194, label: "MENU (SHIFT: SETUP)" },
  { id: "on", cx: 231, label: "ON" },
];
const SILVER_Y = 221.5;
const SILVER_R = 12;

type Tone = "fn" | "pill" | "num" | "blue";

interface KeyDef {
  id: KeyId;
  x: number;
  y: number;
  w: number;
  h: number;
  tone: Tone;
  cap: ReactNode;
  /** SHIFT legend (gold) */
  s?: ReactNode;
  /** ALPHA legend (red) */
  a?: ReactNode;
  name: string;
}

/* ── key-cap glyphs ─────────────────────────────────────────────────── */

const Box = ({ filled = true }: { filled?: boolean }) => <span className={filled ? "kb-box" : "kb-box o"} />;

const CapFrac = (
  <span className="kc-frac">
    <Box />
    <Box filled={false} />
  </span>
);
const CapSqrt = (
  <span className="kc-sqrt">
    <svg viewBox="0 0 22 16" aria-hidden="true">
      <path d="M1 9.2 L3.4 8 L6.6 14.6 L10.6 1.4 H21.2" />
      <rect x="13" y="5" width="6.2" height="7" />
    </svg>
  </span>
);
const CapInteg = (
  <span className="kc-int">
    <svg viewBox="0 0 26 16" aria-hidden="true">
      <path className="stroke" d="M8.2 2 C7.8 0.9 6.6 0.9 6.2 2 C5.8 3.2 5.5 6 5.3 8 C5.1 10 4.8 12.8 4.4 14 C4 15.1 2.8 15.1 2.4 14" />
      <rect className="hollow" x="9.6" y="0.8" width="3.4" height="3.4" />
      <rect className="hollow" x="9.6" y="11.8" width="3.4" height="3.4" />
      <rect x="15" y="4.8" width="9.4" height="6.4" />
    </svg>
  </span>
);
const CapPow = (
  <span className="kc-pow">
    <i>x</i>
    <Box />
  </span>
);
const CapLogb = (
  <span className="kc-logb">
    log
    <Box />
    <Box filled={false} />
  </span>
);
const sup = (base: ReactNode, s: ReactNode) => (
  <span className="kc-sup">
    {base}
    <sup>{s}</sup>
  </span>
);
const X = <i className="kc-x">x</i>;

/* ── legend glyphs ──────────────────────────────────────────────────── */

const LgMixed = (
  <span className="lg-ico">
    <Box />
    <span className="kc-frac sm">
      <Box />
      <Box filled={false} />
    </span>
  </span>
);
const LgCbrt = (
  <span className="lg-ico">
    <sup className="lg-idx">3</sup>√<Box />
  </span>
);
const LgRoot = (
  <span className="lg-ico">
    <sup className="lg-idx">
      <Box filled={false} />
    </sup>
    √<Box />
  </span>
);
const LgPow10 = <span className="lg-ico">10<sup><Box /></sup></span>;
const LgPowE = <span className="lg-ico"><i>e</i><sup><Box /></sup></span>;
const lsup = (b: ReactNode, s: string) => (
  <span className="lg-ico">
    {b}
    <sup>{s}</sup>
  </span>
);

/* ── layout ─────────────────────────────────────────────────────────── */

const FN_W = 31;
const FN_H = 17;
const FN_X = (i: number) => 19.5 + i * 39.34;
const NUM_W = 39.5;
const NUM_H = 25.5;
const NUM_X = (i: number) => 19 + i * 47.25;

const fnRow = (y: number, keys: Omit<KeyDef, "x" | "y" | "w" | "h" | "tone">[]): KeyDef[] =>
  keys.map((k, i) => ({ ...k, x: FN_X(i), y, w: FN_W, h: FN_H, tone: "fn" }));
const numRow = (y: number, keys: (Omit<KeyDef, "x" | "y" | "w" | "h" | "tone"> & { tone?: Tone })[]): KeyDef[] =>
  keys.map((k, i) => ({ tone: "num", ...k, x: NUM_X(i), y, w: NUM_W, h: NUM_H }));

const KEYS: KeyDef[] = [
  { id: "optn", x: 19.5, y: 256, w: 30.5, h: 20.5, tone: "pill", cap: "OPTN", s: "QR", name: "OPTN" },
  { id: "calc", x: 58.5, y: 256, w: 30.5, h: 20.5, tone: "pill", cap: "CALC", s: "SOLVE", a: "=", name: "CALC" },
  { id: "integ", x: 176, y: 256, w: 30.5, h: 20.5, tone: "fn", cap: CapInteg, s: <i>d/dx</i>, a: ":", name: "Integral" },
  { id: "x", x: 216, y: 256, w: 30.5, h: 20.5, tone: "fn", cap: X, s: "Σ", name: "x variable" },
  ...fnRow(290.4, [
    { id: "frac", cap: CapFrac, s: LgMixed, name: "Fraction" },
    { id: "sqrt", cap: CapSqrt, s: LgCbrt, name: "Square root" },
    { id: "sq", cap: sup(X, "2"), s: lsup(<i>x</i>, "3"), name: "Square" },
    { id: "pow", cap: CapPow, s: LgRoot, name: "Power" },
    { id: "logb", cap: CapLogb, s: LgPow10, name: "Logarithm base" },
    { id: "ln", cap: "ln", s: LgPowE, name: "Natural log" },
  ]),
  ...fnRow(322.4, [
    { id: "neg", cap: "(−)", s: "log", a: "A", name: "Negative" },
    { id: "dms", cap: <span className="kc-dms">° ′ ″</span>, s: "FACT", a: "B", name: "Degrees minutes seconds" },
    { id: "inv", cap: sup(X, "−1"), s: lsup(<i>x</i>, "!"), a: "C", name: "Reciprocal" },
    { id: "sin", cap: "sin", s: lsup("sin", "−1"), a: "D", name: "sin" },
    { id: "cos", cap: "cos", s: lsup("cos", "−1"), a: "E", name: "cos" },
    { id: "tan", cap: "tan", s: lsup("tan", "−1"), a: "F", name: "tan" },
  ]),
  ...fnRow(354.7, [
    { id: "sto", cap: "STO", s: "RECALL", name: "Store" },
    { id: "eng", cap: "ENG", s: "←", name: "Engineering notation" },
    { id: "lp", cap: "(", s: "Abs", name: "Open parenthesis" },
    { id: "rp", cap: ")", s: ";", a: <i>x</i>, name: "Close parenthesis" },
    { id: "sd", cap: <span className="kc-sd">S⇔D</span>, s: <span className="lg-ico lg-sd">a<sup>b</sup>/<sub>c</sub>⇔<sup>d</sup>/<sub>c</sub></span>, a: <i>y</i>, name: "Standard to decimal" },
    { id: "mplus", cap: "M+", s: "M−", a: "M", name: "Memory add" },
  ]),
  ...numRow(388.5, [
    { id: "7", cap: "7", s: "CONST", name: "7" },
    { id: "8", cap: "8", s: "CONV", name: "8" },
    { id: "9", cap: "9", s: "RESET", name: "9" },
    { id: "del", cap: "DEL", s: "INS", a: "UNDO", tone: "blue", name: "Delete" },
    { id: "ac", cap: "AC", s: "OFF", tone: "blue", name: "All clear" },
  ]),
  ...numRow(427.5, [
    { id: "4", cap: "4", name: "4" },
    { id: "5", cap: "5", name: "5" },
    { id: "6", cap: "6", name: "6" },
    { id: "mul", cap: "×", s: "nPr", name: "Multiply" },
    { id: "div", cap: "÷", s: "nCr", name: "Divide" },
  ]),
  ...numRow(466, [
    { id: "1", cap: "1", name: "1" },
    { id: "2", cap: "2", name: "2" },
    { id: "3", cap: "3", name: "3" },
    { id: "add", cap: "+", s: "Pol", name: "Add" },
    { id: "sub", cap: "−", s: "Rec", name: "Subtract" },
  ]),
  ...numRow(505, [
    { id: "0", cap: "0", s: "Rnd", name: "0" },
    { id: "dot", cap: ",", s: "Ran#", a: "RanInt", name: "Decimal point" },
    { id: "e10", cap: <span className="kc-e10">×10<sup><i>x</i></sup></span>, s: "π", a: <i>e</i>, name: "Times ten to the" },
    { id: "ans", cap: "Ans", s: "%", name: "Answer" },
    { id: "eq", cap: "=", s: "≈", name: "Equals" },
  ]),
];

/** Keys that repeat while held, like the hardware. */
const REPEATS = new Set<KeyId>(["del", "left", "right", "up", "down"]);

function clampCalcWidth(w: number): number {
  const byHeight = typeof window === "undefined" ? 420 : Math.max(200, (window.innerHeight - 28) * (SKIN_W / SKIN_H));
  return Math.round(Math.max(200, Math.min(w, 420, byHeight)));
}

function pct(r: { x: number; y: number; w: number; h: number }): CSSProperties {
  return {
    left: `${(r.x / SKIN_W) * 100}%`,
    top: `${(r.y / SKIN_H) * 100}%`,
    width: `${(r.w / SKIN_W) * 100}%`,
    height: `${(r.h / SKIN_H) * 100}%`,
  };
}

const pctX = (x: number) => `${(x / SKIN_W) * 100}%`;

/* D-pad artwork in its own 84 × 61.5 box, shaped like the ClassWiz pad: a
   rounded lozenge with four chrome segments around a dark hub, split by
   black diagonal grooves. Outlines are superellipses (|x/a|ⁿ + |y/b|ⁿ = 1). */
const DP_W = DPAD.rx * 2;
const DP_H = DPAD.ry * 2;
const DP_CX = DP_W / 2;
const DP_CY = DP_H / 2;
function lozPt(a: number, b: number, n: number, deg: number): [number, number] {
  const t = (deg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  return [DP_CX + a * Math.sign(c) * Math.abs(c) ** (2 / n), DP_CY + b * Math.sign(s) * Math.abs(s) ** (2 / n)];
}
function lozArc(a: number, b: number, n: number, d0: number, d1: number, steps = 24): string[] {
  const out: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const [x, y] = lozPt(a, b, n, d0 + ((d1 - d0) * i) / steps);
    out.push(`${x.toFixed(2)} ${y.toFixed(2)}`);
  }
  return out;
}
const lozPath = (a: number, b: number, n: number) => `M${lozArc(a, b, n, 0, 360, 96).join(" L")} Z`;
const OUT = { a: 38.6, b: 27.6, n: 1.55 };
const HUB = { a: 17.4, b: 12.2, n: 1.5 };
/* left/right segments span ±55° (in the shape's own angle), up/down ±35°, like the real pad */
const SPLIT = 55;
/* each segment is its own rounded key: inset by half the gap plus the corner radius,
   then filled and stroked at 2·DP_R with round joins so every corner comes out rounded */
const DP_GAP = 7.2;
const DP_R = 1.5;
type Pt = [number, number];
function splitLine(deg: number): { p: Pt; u: Pt } {
  const p = lozPt(HUB.a, HUB.b, HUB.n, deg);
  const q = lozPt(OUT.a, OUT.b, OUT.n, deg);
  const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
  return { p, u: [(q[0] - p[0]) / len, (q[1] - p[1]) / len] };
}
/** signed distance of pt from the split line at deg, positive toward increasing angle */
function sideDist(deg: number, pt: Pt): number {
  const { p, u } = splitLine(deg);
  const n: Pt = [-u[1], u[0]];
  return (pt[0] - p[0]) * n[0] + (pt[1] - p[1]) * n[1];
}
/** angle on a lozenge where it crosses the split line at deg, offset by d toward the segment */
function crossAngle(a: number, b: number, n: number, deg: number, d: number, sign: 1 | -1): number {
  let lo = deg;
  let hi = deg + sign * 40;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (sign * sideDist(deg, lozPt(a, b, n, mid)) < d) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}
function dpadSegment(mid: number): string {
  const h = mid % 180 === 0 ? SPLIT : 90 - SPLIT;
  const d = DP_GAP / 2 + DP_R;
  const oa = OUT.a - DP_R - 0.4, ob = OUT.b - DP_R - 0.4, ia = HUB.a + DP_R + 0.9, ib = HUB.b + DP_R + 0.9;
  const o0 = crossAngle(oa, ob, OUT.n, mid - h, d, 1);
  const o1 = crossAngle(oa, ob, OUT.n, mid + h, d, -1);
  const i0 = crossAngle(ia, ib, HUB.n, mid - h, d, 1);
  const i1 = crossAngle(ia, ib, HUB.n, mid + h, d, -1);
  const pts = [...lozArc(oa, ob, OUT.n, o0, o1), ...lozArc(ia, ib, HUB.n, i1, i0)];
  return `M${pts.join(" L")} Z`;
}
const DP_SEGS = (["right", "down", "left", "up"] as const).map((dir, i) => ({ dir, d: dpadSegment(i * 90) }));
function DpadArt() {
  return (
    <svg className="dp-art" viewBox={`0 0 ${DP_W} ${DP_H}`} preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <radialGradient
          id="dp-chrome"
          gradientUnits="userSpaceOnUse"
          cx={DP_CX}
          cy={DP_CY}
          r={OUT.a}
          gradientTransform={`translate(0 ${DP_CY}) scale(1 ${OUT.b / OUT.a}) translate(0 ${-DP_CY})`}
        >
          <stop offset="0.45" stopColor="#5a5a5e" />
          <stop offset="0.6" stopColor="#8b8b8f" />
          <stop offset="0.8" stopColor="#bdbdc0" />
          <stop offset="0.9" stopColor="#a6a6a9" />
          <stop offset="1" stopColor="#68686c" />
        </radialGradient>
        <linearGradient id="dp-sheen" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0.22" />
          <stop offset="0.45" stopColor="#fff" stopOpacity="0" />
          <stop offset="1" stopColor="#000" stopOpacity="0.16" />
        </linearGradient>
        <radialGradient id="dp-hub" cx="0.5" cy="0.42" r="0.6">
          <stop offset="0" stopColor="#2b2a2f" />
          <stop offset="0.7" stopColor="#212024" />
          <stop offset="1" stopColor="#18181b" />
        </radialGradient>
      </defs>
      {/* soft shadow and the thin black frame with a faint bevel */}
      <path d={lozPath(OUT.a + 2.6, OUT.b + 2.4, OUT.n)} fill="#000" opacity="0.35" transform="translate(0 0.9)" />
      <path d={lozPath(OUT.a + 2.2, OUT.b + 2.1, OUT.n)} fill="#0d0d0f" />
      <path d={lozPath(OUT.a + 2.4, OUT.b + 2.3, OUT.n)} fill="none" stroke="#8a8a90" strokeOpacity="0.28" strokeWidth="0.45" />
      {DP_SEGS.map((s) => (
        <g key={s.dir} className={`dp-seg dp-${s.dir}`}>
          <mask id={`dp-m-${s.dir}`} maskUnits="userSpaceOnUse" x="0" y="0" width={DP_W} height={DP_H}>
            <path d={s.d} fill="#fff" stroke="#fff" strokeWidth={DP_R * 2} strokeLinejoin="round" />
          </mask>
          <g mask={`url(#dp-m-${s.dir})`}>
            <rect width={DP_W} height={DP_H} fill="url(#dp-chrome)" />
            <rect width={DP_W} height={DP_H} fill="url(#dp-sheen)" />
          </g>
        </g>
      ))}
      {/* hub: same dark material as the deck, ringed by the gap */}
      <path d={lozPath(HUB.a - 1.5, HUB.b - 1.4, HUB.n)} fill="url(#dp-hub)" />
      <path d={lozPath(HUB.a - 1.5, HUB.b - 1.4, HUB.n)} fill="none" stroke="#fff" strokeOpacity="0.06" strokeWidth="0.4" />
    </svg>
  );
}

/** Display a number-bearing text with a decimal comma (argument separators become ";"). */
const decComma = (t: string) => t.replace(/,/g, ";").replace(/\./g, ",");
/** Same for prose: only touches dots that sit inside numbers. */
const numComma = (t: string) => t.replace(/(\d)\.(?=\d)/g, "$1,");

const STORE_KEY = "pl.calc.v3";
const WIDTH_KEY = "pl.calc.w";
const TEXT_KEY = "pl.calc.text";
const TEXT_MIN = 0.85;
const TEXT_MAX = 1.45;
const TEXT_DEFAULT = 1.12;
const clampText = (k: number) => Math.round(Math.max(TEXT_MIN, Math.min(TEXT_MAX, k)) * 100) / 100;

function makeCalc(): Calc {
  const c = new Calc();
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) c.load(JSON.parse(raw));
  } catch {
    /* corrupt storage: start fresh */
  }
  return c;
}

/* ── physical keyboard ──────────────────────────────────────────────── */

type Combo = KeyId | ["shift" | "alpha", KeyId];

const KEYBOARD: Record<string, Combo> = {
  "0": "0", "1": "1", "2": "2", "3": "3", "4": "4", "5": "5", "6": "6", "7": "7", "8": "8", "9": "9",
  ".": "dot", ",": "dot", ";": ["shift", "rp"], "+": "add", "-": "sub", "*": "mul", "/": "frac", ":": "div", "(": "lp", ")": "rp",
  "^": "pow", "!": ["shift", "inv"], "%": ["shift", "ans"], "=": "eq", Enter: "eq",
  Backspace: "del", Delete: "ac",
  ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down",
  s: "sin", c: "cos", t: "tan", l: "ln", q: "sqrt", f: "frac", x: "x", y: ["alpha", "sd"],
  p: ["shift", "e10"], e: ["alpha", "e10"], a: "ans",
};

/* ── component ──────────────────────────────────────────────────────── */

export function Calculator({ onClose }: { onClose: () => void }) {
  const calcRef = useRef<Calc | null>(null);
  if (!calcRef.current) calcRef.current = makeCalc();
  const calc = calcRef.current;
  const [, setTick] = useState(0);
  const [pressed, setPressed] = useState<KeyId | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [width, setWidth] = useState(() => {
    const n = Number(localStorage.getItem(WIDTH_KEY));
    return n > 0 && Number.isFinite(n) ? clampCalcWidth(n) : 280;
  });
  const [textK, setTextK] = useState(() => {
    const n = Number(localStorage.getItem(TEXT_KEY));
    return n > 0 && Number.isFinite(n) ? clampText(n) : TEXT_DEFAULT;
  });
  const bumpText = (d: number) =>
    setTextK((k) => {
      const next = clampText(k + d);
      localStorage.setItem(TEXT_KEY, String(next));
      return next;
    });
  const cardRef = useRef<HTMLDivElement>(null);
  const lineRef = useRef<HTMLDivElement>(null);
  const repeatRef = useRef<{ t: number; i: number } | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const commit = useCallback(() => {
    const c = calcRef.current!;
    if (c.wantsClose) {
      c.wantsClose = false;
      onCloseRef.current();
    }
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(c.toJSON()));
    } catch {
      /* storage full or unavailable */
    }
    setTick((t) => t + 1);
  }, []);

  const press = useCallback(
    (k: KeyId) => {
      calcRef.current!.press(k);
      commit();
    },
    [commit],
  );

  const pressCombo = useCallback(
    (combo: Combo) => {
      const c = calcRef.current!;
      if (Array.isArray(combo)) {
        const [mod, k] = combo;
        if (mod === "shift" && !c.shift) c.press("shift");
        if (mod === "alpha" && !c.alpha) c.press("alpha");
        c.press(k);
      } else c.press(combo);
      commit();
    },
    [commit],
  );

  const stopRepeat = useCallback(() => {
    const r = repeatRef.current;
    if (r) {
      clearTimeout(r.t);
      clearInterval(r.i);
    }
    repeatRef.current = null;
    setPressed(null);
  }, []);

  useEffect(() => stopRepeat, [stopRepeat]);

  /** Fire on pointer-down (no click latency) and auto-repeat DEL / arrows while held. */
  const keyDown = (k: KeyId) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    cardRef.current?.focus({ preventScroll: true });
    stopRepeat();
    setPressed(k);
    press(k);
    if (REPEATS.has(k)) {
      const t = window.setTimeout(() => {
        const i = window.setInterval(() => press(k), 70);
        if (repeatRef.current) repeatRef.current.i = i;
      }, 420);
      repeatRef.current = { t, i: 0 };
    }
  };

  const flash = (k: KeyId) => {
    setPressed(k);
    window.setTimeout(() => setPressed((p) => (p === k ? null : p)), 110);
  };

  /** D-pad: one elliptical pad; the direction is whichever axis the touch leans to. */
  const dpadDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const r = e.currentTarget.getBoundingClientRect();
    const nx = ((e.clientX - r.left) / r.width) * 2 - 1;
    const ny = ((e.clientY - r.top) / r.height) * 2 - 1;
    const d = Math.hypot(nx, ny);
    if (d > 1.04) return; // outside the pad: let it fall through to the body
    e.preventDefault();
    e.stopPropagation();
    if (d < 0.26) return; // the hub is not a key
    const k: KeyId = Math.abs(nx) > Math.abs(ny) ? (nx < 0 ? "left" : "right") : ny < 0 ? "up" : "down";
    keyDown(k)(e);
  };

  /* keep the caret visible on long inputs */
  useLayoutEffect(() => {
    const line = lineRef.current;
    if (!line) return;
    const caret = line.querySelector(".m-caret") as HTMLElement | null;
    if (!caret) {
      line.scrollLeft = 0;
      return;
    }
    const lr = line.getBoundingClientRect();
    const cr = caret.getBoundingClientRect();
    const pad = 10;
    if (cr.right > lr.right - pad) line.scrollLeft += cr.right - lr.right + pad;
    else if (cr.left < lr.left + pad) line.scrollLeft -= lr.left + pad - cr.left;
  });

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget && (e.target as HTMLElement).tagName !== "BUTTON") return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") {
      const raw = calc.resultText();
      const text = raw && decComma(raw);
      if (text) {
        e.preventDefault();
        void navigator.clipboard?.writeText(text);
        calc.toast = "Copied result";
        setTick((t) => t + 1);
      }
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (calc.overlay || calc.shift || calc.alpha || calc.sto) {
        if (calc.overlay) calc.press("ac");
        else {
          calc.shift = calc.alpha = calc.sto = false;
          calc.version++;
        }
        commit();
      } else onClose();
      return;
    }
    const combo = KEYBOARD[e.key];
    if (!combo) return;
    // typing "3/4" should give the fraction 3 over 4: "/" wraps the number before it
    const ovk = calc.overlay?.kind;
    if (e.key === "/" && (!ovk || ovk === "grid" || ovk === "input") && !calc.result && !calc.shift && !calc.alpha) calc.insWrap = true;
    e.preventDefault();
    e.stopPropagation();
    pressCombo(combo);
    flash(Array.isArray(combo) ? combo[1] : combo);
  };

  /* ── drag & resize (unchanged behaviour) ── */

  /** Resize from a corner; the opposite corner stays put (the skin keeps its aspect ratio). */
  const startResize = (corner: "br" | "bl" | "tl") => (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const card = cardRef.current;
    if (!card) return;
    const r = card.getBoundingClientRect();
    const sx = e.clientX;
    const sw = r.width;
    const right = r.right;
    const bottom = r.bottom;
    const place = (w: number) => {
      const h = (w * SKIN_H) / SKIN_W;
      setPos({ x: corner === "br" ? r.left : right - w, y: corner === "tl" ? bottom - h : r.top });
    };
    place(sw);
    const grip = e.currentTarget;
    grip.setPointerCapture(e.pointerId);
    let latest = sw;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - sx;
      latest = clampCalcWidth(corner === "br" ? sw + dx : sw - dx);
      setWidth(latest);
      place(latest);
    };
    const up = () => {
      localStorage.setItem(WIDTH_KEY, String(Math.round(latest)));
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
  };

  const startDrag = (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    const card = cardRef.current;
    if (!card) return;
    e.preventDefault();
    card.focus({ preventScroll: true });
    const r = card.getBoundingClientRect();
    const dx = e.clientX - r.left;
    const dy = e.clientY - r.top;
    const head = e.currentTarget;
    head.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const x = Math.max(4, Math.min(ev.clientX - dx, window.innerWidth - r.width - 4));
      const y = Math.max(4, Math.min(ev.clientY - dy, window.innerHeight - 60));
      setPos({ x, y });
    };
    const up = () => {
      head.removeEventListener("pointermove", move);
      head.removeEventListener("pointerup", up);
    };
    head.addEventListener("pointermove", move);
    head.addEventListener("pointerup", up);
  };

  useEffect(() => {
    cardRef.current?.focus({ preventScroll: true });
    const onResize = () => setWidth((w) => clampCalcWidth(w));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const mods = `${calc.shift ? " is-shift" : ""}${calc.alpha ? " is-alpha" : ""}`;

  return (
    <div
      ref={cardRef}
      className={`calc-card${mods}`}
      style={{ width, ["--lcd-k" as string]: textK, ...(pos ? { left: pos.x, top: pos.y, right: "auto" } : {}) }}
      onKeyDown={onKeyDown}
      onPointerUp={stopRepeat}
      onPointerCancel={stopRepeat}
      onPointerLeave={stopRepeat}
      tabIndex={0}
      role="application"
      aria-label="Scientific calculator"
    >
      <CalcBody />
      <div className="calc-drag calc-drag-top" onPointerDown={startDrag} title="Drag to move" />
      <div className="calc-drag calc-drag-bottom" onPointerDown={startDrag} />
      <button className="calc-close" type="button" title="Close (Esc)" aria-label="Close calculator" onClick={onClose}>
        <IcClose size={15} />
      </button>

      <div className="calc-textsize" role="group" aria-label="Display text size">
        <button type="button" tabIndex={-1} title="Larger display text (Ctrl + wheel)" aria-label="Larger display text" disabled={textK >= TEXT_MAX} onClick={() => bumpText(0.08)}>
          A<sup>+</sup>
        </button>
        <button type="button" tabIndex={-1} title="Smaller display text (Ctrl + wheel)" aria-label="Smaller display text" disabled={textK <= TEXT_MIN} onClick={() => bumpText(-0.08)}>
          A<sup>−</sup>
        </button>
      </div>

      <div
        className="calc-screen-zoom"
        style={{ display: "contents" }}
        onWheel={(e) => {
          if (!e.ctrlKey) return;
          e.preventDefault();
          bumpText(e.deltaY < 0 ? 0.04 : -0.04);
        }}
      >
        <Screen calc={calc} lineRef={lineRef} onTick={commit} />
      </div>

      {SILVER.map((k) => (
        <button
          key={k.id}
          type="button"
          tabIndex={-1}
          className={`calc-silver sv-${k.id}${pressed === k.id ? " down" : ""}${
            (k.id === "shift" && calc.shift) || (k.id === "alpha" && calc.alpha) ? " lit" : ""
          }`}
          style={pct({ x: k.cx - SILVER_R, y: SILVER_Y - SILVER_R, w: SILVER_R * 2, h: SILVER_R * 2 })}
          aria-label={k.label}
          title={k.label}
          onPointerDown={keyDown(k.id)}
        >
          <span className="sv-cap" />
        </button>
      ))}
      <span className="calc-silver-legs" aria-hidden="true">
        <span className="sl-s" style={{ left: pctX(34) }}>SHIFT</span>
        <span className="sl-a" style={{ left: pctX(69) }}>ALPHA</span>
        <span className="sl-w" style={{ left: pctX(194) }}>
          MENU <span className="sl-s">SETUP</span>
        </span>
        <span className="sl-w sl-on" style={{ left: pctX(231) }}>ON</span>
      </span>

      <div
        className={`calc-dpad${pressed && ["up", "down", "left", "right"].includes(pressed) ? ` down-${pressed}` : ""}`}
        style={pct({ x: DPAD.cx - DPAD.rx, y: DPAD.cy - DPAD.ry, w: DPAD.rx * 2, h: DPAD.ry * 2 })}
        role="group"
        aria-label="Cursor keys"
        onPointerDown={dpadDown}
      >
        <DpadArt />
      </div>

      {KEYS.map((k) => (
        <div key={k.id} className="calc-key-wrap" style={pct({ x: k.x, y: k.y - 9.5, w: k.w, h: k.h + 9.5 })}>
          <span className={`calc-leg${k.s && k.a ? " two" : ""}`} aria-hidden="true">
            {k.s && <span className="lg-s">{k.s}</span>}
            {k.a && <span className="lg-a">{k.a}</span>}
          </span>
          <button
            type="button"
            tabIndex={-1}
            className={`calc-key ${k.tone}${pressed === k.id ? " down" : ""}`}
            aria-label={k.name}
            onPointerDown={keyDown(k.id)}
          >
            <span className="calc-cap">{k.cap}</span>
          </button>
        </div>
      ))}

      <button type="button" tabIndex={-1} className="calc-resize" title="Resize" aria-label="Resize calculator" onPointerDown={startResize("br")} />
      <button type="button" tabIndex={-1} className="calc-resize grip-bl" title="Resize" aria-label="Resize calculator from bottom left" onPointerDown={startResize("bl")} />
      <button type="button" tabIndex={-1} className="calc-resize grip-tl" title="Resize" aria-label="Resize calculator from top left" onPointerDown={startResize("tl")} />
    </div>
  );
}

/* ── LCD ────────────────────────────────────────────────────────────── */


/* status-strip glyphs, drawn to sit on the LCD like the ClassWiz segment icons */
const StIcon = {
  sto: (
    <svg viewBox="0 0 22 12" width="1.75em" height="1em">
      <path d="M1 6h6.5M5 3.4 7.8 6 5 8.6" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <rect x="10" y="1" width="11" height="10" rx="0.6" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path d="M13 3.6l5 4.8M18 3.6l-5 4.8" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  ),
  math: (
    <svg viewBox="0 0 22 13" width="1.65em" height="1em">
      <path d="M1 7.5 3 6.8 5.4 12 8.6 1h12.4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <rect x="10.4" y="3.4" width="9.6" height="8.6" rx="0.5" fill="none" stroke="currentColor" strokeWidth="1.1" />
      <path d="M12.6 10.3l.5-2 4.2-4.2 1.5 1.5-4.2 4.2z" fill="currentColor" />
    </svg>
  ),
  down: (
    <svg viewBox="0 0 10 12" width="0.8em" height="1em">
      <path d="M3.2 1h3.6v5.2H9L5 11 1 6.2h2.2z" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
    </svg>
  ),
  tri: (rot: number) => (
    <svg viewBox="0 0 10 10" width="0.72em" height="0.72em">
      <path d="M9.4 5 1.6 9.5V.5z" fill="currentColor" transform={`rotate(${rot} 5 5)`} />
    </svg>
  ),
  pause: (
    <svg viewBox="0 0 10 12" width="0.75em" height="0.95em">
      <rect x="1.4" y="1" width="2.6" height="10" fill="currentColor" />
      <rect x="6" y="1" width="2.6" height="10" fill="currentColor" />
    </svg>
  ),
  sun: (
    <svg viewBox="0 0 14 14" width="1em" height="1em">
      <circle cx="7" cy="7" r="2.6" fill="currentColor" />
      <path
        d="M7 .6v2.2M7 11.2v2.2M.6 7h2.2M11.2 7h2.2M2.5 2.5l1.5 1.5M10 10l1.5 1.5M2.5 11.5 4 10M10 4l1.5-1.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  ),
};

function Screen({
  calc,
  lineRef,
  onTick,
}: {
  calc: Calc;
  lineRef: React.RefObject<HTMLDivElement | null>;
  onTick: () => void;
}) {
  const s = calc.settings;
  const ov = calc.overlay;
  const memory = calc.vars.M && calc.vars.M.v !== 0;
  const fmtMark = s.fmt === "fix" ? "FIX" : s.fmt === "sci" ? "SCI" : "";
  const canUp = !ov && calc.history.length > 0 && (calc.result !== null || calc.ed.isEmpty());

  /* fixed-segment indicator strip like the ClassWiz: every icon keeps its slot and
     shows as a faint ghost segment when it is off */
  const ind = (label: ReactNode, on: boolean, cls = "") => (
    <span className={`ind${cls ? ` ${cls}` : ""}${on ? " on" : ""}`}>{label}</span>
  );
  const status = (
    <div className="lcd-status" aria-hidden="true">
      <span className="ind-grp">
        {ind("S", calc.shift, "box")}
        {ind("A", calc.alpha, "box")}
      </span>
      {ind("M", !!memory)}
      {ind(StIcon.sto, calc.sto || ov?.kind === "recall", "ico")}
      {ind(StIcon.math, !calc.lineIn, "ico")}
      <span className="ind-grp">
        {ind("D", s.angle === "DEG", "box")}
        {ind("R", s.angle === "RAD", "box")}
        {ind("G", s.angle === "GRA", "box")}
      </span>
      {ind("FIX", fmtMark === "FIX")}
      {ind("SCI", fmtMark === "SCI")}
      {ind("E", false)}
      {ind(<i>i</i>, false, "it")}
      {ind("∠", false)}
      {ind(StIcon.down, false, "ico")}
      <span className="ind-grp tri">
        {ind(StIcon.tri(180), false, "ico")}
        {ind(StIcon.tri(90), canUp, "ico")}
        {ind(StIcon.tri(270), canUp, "ico")}
        {ind(StIcon.tri(0), false, "ico")}
      </span>
      {ind(StIcon.pause, false, "ico")}
      {ind(StIcon.sun, true, "ico")}
    </div>
  );

  let body: ReactNode;
  if (!ov) {
    const r = calc.result;
    body = (
      <>
        <div className="lcd-input" ref={lineRef}>
          <MathView items={calc.ed.root} cur={r ? null : calc.ed.cur} />
          {r?.suffix && <span className="lcd-suffix">{r.suffix}</span>}
        </div>
        <div className="lcd-result" aria-live="polite">
          {r && !r.multi && <MathView items={calc.valueNodes(r.val, r.form, r.engShift, r.frac)} />}
          {r?.multi && (
            <div className="lcd-multi">
              {r.multi.labels.map((l, i) => (
                <div key={l}>
                  <span className="lbl">{l}=</span>
                  <MathView items={calc.valueNodes(r.multi!.vals[i])} />
                </div>
              ))}
            </div>
          )}
          {calc.toast && <span className="lcd-toast">{calc.toast}</span>}
        </div>
      </>
    );
  } else if (ov.kind === "menu") {
    body = <MenuView m={ov} calc={calc} onTick={onTick} />;
  } else if (ov.kind === "prompt") {
    const name = ov.vars[ov.idx];
    const shown = name === "X" ? "x" : name === "Y" ? "y" : name;
    body = (
      <div className="lcd-prompt">
        <div className="lcd-prompt-expr">
          <MathView items={calc.ed.root} />
        </div>
        <div className="lcd-prompt-title">
          {ov.purpose === "calc" ? "CALC" : ov.purpose === "solve" ? "SOLVE: set values" : `Solve for ${shown}`}
          {ov.vars.length > 1 && (
            <span className="lcd-dim">
              {" "}
              {ov.idx + 1}/{ov.vars.length} ▲▼
            </span>
          )}
        </div>
        <div className="lcd-input" ref={lineRef}>
          <span className="lcd-var">{shown}=</span>
          {ov.ed.isEmpty() && <span className="lcd-dim lcd-cur">{decComma(calc.valueText(calc.vars[name]))}</span>}
          <MathView items={ov.ed.root} cur={ov.ed.cur} />
        </div>
      </div>
    );
  } else if (ov.kind === "solved") {
    const shown = ov.name === "X" ? "x" : ov.name === "Y" ? "y" : ov.name;
    body = (
      <div className="lcd-solved">
        <div className="lcd-input">
          <MathView items={calc.ed.root} />
        </div>
        <div className="lcd-solved-x">
          <span className="lcd-var">{shown}=</span>
          <MathView items={calc.valueNodes(ov.x)} />
        </div>
        <div className="lcd-solved-lr">
          L−R= <MathView items={calc.valueNodes({ v: ov.lr, ex: null })} />
        </div>
      </div>
    );
  } else if (ov.kind === "error") {
    body = (
      <button
        type="button"
        tabIndex={-1}
        className="lcd-error"
        onPointerDown={(e) => {
          e.preventDefault();
          calc.press("ac");
          onTick();
        }}
      >
        <b>{ov.err.message}</b>
        <span>[AC] :Cancel</span>
        <span>[◀][▶]:Goto</span>
      </button>
    );
  } else if (ov.kind === "msg") {
    body = (
      <div className="lcd-msg">
        <b>{ov.title}</b>
        {ov.lines.map((l, i) => (
          <span key={i}>{l ? numComma(l) : "\u00a0"}</span>
        ))}
      </div>
    );
  } else if (ov.kind === "confirm") {
    body = (
      <div className="lcd-msg">
        <b>{ov.title}</b>
        <span className="lcd-confirm">
          <button
            type="button"
            tabIndex={-1}
            onPointerDown={(e) => {
              e.preventDefault();
              calc.press("eq");
              onTick();
            }}
          >
            Yes [=]
          </button>
          <button
            type="button"
            tabIndex={-1}
            onPointerDown={(e) => {
              e.preventDefault();
              calc.press("ac");
              onTick();
            }}
          >
            Cancel [AC]
          </button>
        </span>
      </div>
    );
  } else if (ov.kind === "grid") {
    body = <GridView g={ov} calc={calc} onTick={onTick} lineRef={lineRef} />;
  } else if (ov.kind === "answers") {
    body = <AnswersView a={ov} calc={calc} onTick={onTick} />;
  } else if (ov.kind === "input") {
    body = <InputView s={ov} calc={calc} onTick={onTick} lineRef={lineRef} />;
  } else if (ov.kind === "recall") {
    body = (
      <div className="lcd-recall">
        {["A", "B", "C", "D", "E", "F", "M", "X", "Y"].map((n) => (
          <button
            key={n}
            type="button"
            tabIndex={-1}
            onPointerDown={(e) => {
              e.preventDefault();
              calc.tapRecall(n);
              onTick();
            }}
          >
            <span className="lcd-var">{n === "X" ? "x" : n === "Y" ? "y" : n}=</span>
            <span className="v">{decComma(calc.valueText(calc.vars[n]))}</span>
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className={`calc-screen${calc.lineIn ? " line-io" : ""}`} style={pct(LCD)}>
      {status}
      <div className="lcd-body">{body}</div>
    </div>
  );
}

/** Compact cell text: whole numbers as-is, otherwise 6 significant digits. */
function cellText(v: Val | null): string {
  if (!v) return "ERROR";
  const x = v.v;
  let t: string;
  if (Number.isInteger(x) && Math.abs(x) < 1e7) t = String(x);
  else if (Math.abs(x) >= 1e7 || Math.abs(x) < 1e-4) t = x.toExponential(3).replace(/e\+?/, "E");
  else t = String(Number(x.toPrecision(6)));
  return numComma(t).replace(/^-/, "−");
}

/** Title row shared by the app screens: optional back arrow, title, right-hand extra. */
function AppTitle({ title, calc, onTick, extra }: { title: string; calc: Calc; onTick: () => void; extra?: ReactNode }) {
  return (
    <div className="lcd-menu-title">
      <button
        type="button"
        tabIndex={-1}
        className="lcd-back"
        aria-label="Back"
        onPointerDown={(e) => {
          e.preventDefault();
          calc.appBack();
          onTick();
        }}
      >
        ◀
      </button>
      <span className="lcd-app-title">{numComma(title)}</span>
      {extra}
    </div>
  );
}

function GridView({
  g,
  calc,
  onTick,
  lineRef,
}: {
  g: GridScreen;
  calc: Calc;
  onTick: () => void;
  lineRef: React.RefObject<HTMLDivElement | null>;
}) {
  const VISIBLE = g.readOnly ? 4 : 3;
  const rows = g.cells.length;
  const top = Math.min(Math.max(0, g.r - (VISIBLE - 2)), Math.max(0, rows - VISIBLE));
  const shown = g.cells.slice(top, top + VISIBLE);
  const showLabels = g.rowLabels.some((l) => l);
  const cur = g.cells[g.r]?.[g.c] ?? null;
  const hint = g.hint ?? (g.readOnly ? "[AC] Back" : "[=] Solve");
  return (
    <div className={`lcd-grid${g.readOnly ? " ro" : ""}`}>
      <AppTitle title={g.title} calc={calc} onTick={onTick} extra={<span className="lcd-grid-hint">{hint}</span>} />
      <div
        className="lcd-grid-table"
        style={{ gridTemplateColumns: `${showLabels ? "auto " : ""}repeat(${g.cols.length}, minmax(0, 1fr))` }}
        onWheel={(e) => {
          if (Math.abs(e.deltaY) > 4) {
            calc.press(e.deltaY > 0 ? "down" : "up");
            onTick();
          }
        }}
      >
        {showLabels && <span className="gh" />}
        {g.cols.map((c) => (
          <span key={c} className="gh">
            {c}
          </span>
        ))}
        {shown.map((row, j) => {
          const r = top + j;
          return [
            showLabels && (
              <span key={`l${r}`} className="gl">
                {g.rowLabels[r]}
              </span>
            ),
            ...row.map((v, c) => {
              const sel = r === g.r && c === g.c;
              return (
                <button
                  key={`${r}:${c}`}
                  type="button"
                  tabIndex={-1}
                  className={`gc${sel ? " sel" : ""}${sel && g.ed ? " editing" : ""}${v ? "" : " err"}`}
                  onPointerDown={(e) => {
                    e.preventDefault();
                    calc.tapGrid(r, c);
                    onTick();
                  }}
                >
                  {cellText(v)}
                </button>
              );
            }),
          ];
        })}
      </div>
      <div className="lcd-grid-line" ref={lineRef}>
        {g.ed ? (
          <MathView items={g.ed.root} cur={g.ed.cur} />
        ) : cur ? (
          <MathView items={calc.valueNodes(cur)} />
        ) : (
          <span>ERROR</span>
        )}
      </div>
    </div>
  );
}

function AnswersView({ a, calc, onTick }: { a: AnswersScreen; calc: Calc; onTick: () => void }) {
  const shown = a.rows.slice(a.top, a.top + 2);
  const more = a.rows.length > 2;
  const step = (k: KeyId) => {
    calc.press(k);
    onTick();
  };
  return (
    <div
      className="lcd-answers"
      onWheel={(e) => {
        if (more && Math.abs(e.deltaY) > 4) step(e.deltaY > 0 ? "down" : "up");
      }}
    >
      <AppTitle
        title={a.title}
        calc={calc}
        onTick={onTick}
        extra={
          more && (
            <span className="lcd-pager">
              <button type="button" tabIndex={-1} aria-label="Previous answer" onPointerDown={(e) => (e.preventDefault(), step("up"))}>
                ▲
              </button>
              <button type="button" tabIndex={-1} aria-label="Next answer" onPointerDown={(e) => (e.preventDefault(), step("down"))}>
                ▼
              </button>
            </span>
          )
        }
      />
      <div className="lcd-answer-rows">
        {shown.map((row, i) =>
          row.parts.length === 1 && typeof row.parts[0] === "string" && row.parts[0].length > 1 ? (
            <div key={i} className="lcd-answer msg">
              {row.parts[0]}
            </div>
          ) : (
            <div key={i} className="lcd-answer">
              {row.label && <span className="lbl">{row.label}=</span>}
              <span className="val">
                <MathView items={calc.answerNodes(row, a.dec)} />
              </span>
            </div>
          ),
        )}
      </div>
    </div>
  );
}

function InputView({
  s,
  calc,
  onTick,
  lineRef,
}: {
  s: InputScreen;
  calc: Calc;
  onTick: () => void;
  lineRef: React.RefObject<HTMLDivElement | null>;
}) {
  return (
    <div className="lcd-app-input">
      <AppTitle title={s.title} calc={calc} onTick={onTick} />
      <div className="lcd-input" ref={lineRef}>
        <span className="lcd-var">{s.label}</span>
        <MathView items={s.ed.root} cur={s.ed.cur} />
      </div>
      {s.hint && <div className="lcd-app-hint">{s.hint}</div>}
    </div>
  );
}

function MenuView({ m, calc, onTick }: { m: MenuScreen; calc: Calc; onTick: () => void }) {
  const per = m.grid ? 12 : 4;
  const pages = Math.max(1, Math.ceil(m.items.length / per));
  const page = Math.min(m.page, pages - 1);
  const start = page * per;
  const shown = m.items.slice(start, start + per);
  const turn = (d: number) => {
    m.page = (page + d + pages) % pages;
    calc.version++;
    onTick();
  };
  return (
    <div
      className={`lcd-menu${m.grid ? " is-grid" : ""}`}
      onWheel={(e) => {
        if (pages > 1 && Math.abs(e.deltaY) > 4) turn(e.deltaY > 0 ? 1 : -1);
      }}
    >
      <div className="lcd-menu-title">
        {m.back && (
          <button
            type="button"
            tabIndex={-1}
            className="lcd-back"
            aria-label="Back"
            onPointerDown={(e) => {
              e.preventDefault();
              calc.press("left");
              onTick();
            }}
          >
            ◀
          </button>
        )}
        <span>{m.title}</span>
        {pages > 1 && (
          <span className="lcd-pager">
            <button type="button" tabIndex={-1} onPointerDown={(e) => (e.preventDefault(), turn(-1))} aria-label="Previous page">
              ▲
            </button>
            {page + 1}/{pages}
            <button type="button" tabIndex={-1} onPointerDown={(e) => (e.preventDefault(), turn(1))} aria-label="Next page">
              ▼
            </button>
          </span>
        )}
      </div>
      <div className="lcd-menu-items">
        {shown.map((it, j) => {
          const idx = start + j;
          const num = idx < 9 ? String(idx + 1) : "ABC"[idx - 9] ?? "";
          return (
            <button
              key={idx}
              type="button"
              tabIndex={-1}
              className={`lcd-item${it.checked ? " checked" : ""}`}
              onPointerDown={(e) => {
                e.preventDefault();
                calc.tapMenu(idx);
                onTick();
              }}
            >
              <span className="n">{num}:</span>
              <span className="l">{numComma(it.label)}</span>
              {it.hint && !m.grid && <span className="h">{numComma(it.hint)}</span>}
              {it.checked && <span className="dot">◆</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
