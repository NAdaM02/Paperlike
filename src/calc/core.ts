/**
 * The calculator as a pure state machine: keys in, screen state out.
 * The React component only renders `Calc` and forwards key presses.
 */
import { CONST_GROUPS, CONV_GROUPS, ENG_SYMBOLS } from "./data";
import { calculate, CalcError, EvalEnv, solve, Val, AngleMode } from "./engine";
import { Ex, exAdd, exNeg, floatToExact, ratEx } from "./exact";
import { IneqOp, Root, polyRoots, quadVertex, solveIneq, solveSimul, vDiv, vMul } from "./apps";
import {
  DecParts,
  DispSetup,
  FracMode,
  NumFormat,
  decNodes,
  decText,
  dmsNodes,
  exactNodes,
  factNodes,
  formatDecimal,
  formatEng,
} from "./format";
import { Editor, NEEDS_LEFT, Node, TplKind, ch, cloneNodes, deserialize, serialize, toLinear, tpl, varsUsed } from "./model";

export type KeyId =
  | "shift" | "alpha" | "up" | "down" | "left" | "right" | "menu" | "on"
  | "optn" | "calc" | "integ" | "x"
  | "frac" | "sqrt" | "sq" | "pow" | "logb" | "ln"
  | "neg" | "dms" | "inv" | "sin" | "cos" | "tan"
  | "sto" | "eng" | "lp" | "rp" | "sd" | "mplus"
  | "7" | "8" | "9" | "del" | "ac"
  | "4" | "5" | "6" | "mul" | "div"
  | "1" | "2" | "3" | "add" | "sub"
  | "0" | "dot" | "e10" | "ans" | "eq";

export type IOMode = "MathI/MathO" | "MathI/DecimalO" | "LineI/LineO" | "LineI/DecimalO";

export interface Settings {
  io: IOMode;
  angle: AngleMode;
  fmt: NumFormat;
  digits: number;
  frac: FracMode;
}

export const DEFAULT_SETTINGS: Settings = { io: "MathI/MathO", angle: "RAD", fmt: "norm1", digits: 0, frac: "dc" };

type Action = { ins: string } | { tpl: TplKind } | { cmd: string } | null;

/** [plain, SHIFT, ALPHA] for every key, matching the fx-991EX key legends. */
const KEYS: Partial<Record<KeyId, [Action, Action, Action]>> = {
  optn: [{ cmd: "optn" }, { cmd: "qr" }, null],
  calc: [{ cmd: "calc" }, { cmd: "solve" }, { ins: "=" }],
  integ: [{ tpl: "integ" }, { tpl: "deriv" }, { cmd: "colon" }],
  x: [{ ins: "X" }, { tpl: "sum" }, null],
  frac: [{ tpl: "frac" }, { tpl: "mixed" }, null],
  sqrt: [{ tpl: "sqrt" }, { tpl: "cbrt" }, null],
  sq: [{ ins: "²" }, { ins: "³" }, null],
  pow: [{ tpl: "pow" }, { tpl: "root" }, null],
  logb: [{ tpl: "logb" }, { tpl: "pow10" }, null],
  ln: [{ ins: "ln(" }, { tpl: "powe" }, null],
  neg: [{ ins: "neg" }, { ins: "log(" }, { ins: "A" }],
  dms: [{ cmd: "dms" }, { cmd: "fact" }, { ins: "B" }],
  inv: [{ ins: "⁻¹" }, { ins: "!" }, { ins: "C" }],
  sin: [{ ins: "sin(" }, { ins: "sin⁻¹(" }, { ins: "D" }],
  cos: [{ ins: "cos(" }, { ins: "cos⁻¹(" }, { ins: "E" }],
  tan: [{ ins: "tan(" }, { ins: "tan⁻¹(" }, { ins: "F" }],
  sto: [{ cmd: "sto" }, { cmd: "recall" }, null],
  eng: [{ cmd: "eng" }, { cmd: "engL" }, null],
  lp: [{ ins: "(" }, { tpl: "abs" }, null],
  rp: [{ ins: ")" }, { ins: "," }, { ins: "X" }],
  sd: [{ cmd: "sd" }, { cmd: "abcdc" }, { ins: "Y" }],
  mplus: [{ cmd: "m+" }, { cmd: "m-" }, { ins: "M" }],
  "7": [{ ins: "7" }, { cmd: "const" }, null],
  "8": [{ ins: "8" }, { cmd: "conv" }, null],
  "9": [{ ins: "9" }, { cmd: "reset" }, null],
  del: [{ cmd: "del" }, { cmd: "ins" }, { cmd: "undo" }],
  ac: [{ cmd: "ac" }, { cmd: "off" }, null],
  "4": [{ ins: "4" }, null, null],
  "5": [{ ins: "5" }, null, null],
  "6": [{ ins: "6" }, null, null],
  mul: [{ ins: "×" }, { ins: "nPr" }, null],
  div: [{ ins: "÷" }, { ins: "nCr" }, null],
  "1": [{ ins: "1" }, null, null],
  "2": [{ ins: "2" }, null, null],
  "3": [{ ins: "3" }, null, null],
  add: [{ ins: "+" }, { ins: "Pol(" }, null],
  sub: [{ ins: "-" }, { ins: "Rec(" }, null],
  "0": [{ ins: "0" }, { ins: "Rnd(" }, null],
  dot: [{ ins: "." }, { ins: "Ran#" }, { ins: "RanInt#(" }],
  e10: [{ tpl: "e10" }, { ins: "π" }, { ins: "e" }],
  ans: [{ ins: "Ans" }, { ins: "%" }, null],
  eq: [{ cmd: "eq" }, { cmd: "approx" }, null],
};

/** Keys that produce a variable when pressed after STO / in RECALL (no ALPHA needed). */
const VAR_KEYS: Partial<Record<KeyId, string>> = {
  neg: "A", dms: "B", inv: "C", sin: "D", cos: "E", tan: "F", rp: "X", sd: "Y", mplus: "M", x: "X",
};

const VAR_NAMES = ["A", "B", "C", "D", "E", "F", "M", "X", "Y"];

export interface MenuItem {
  label: string;
  hint?: string;
  run: (c: Calc) => void;
  checked?: boolean;
}

export interface MenuScreen {
  kind: "menu";
  title: string;
  items: MenuItem[];
  page: number;
  /** grid of app icons (MENU) instead of a numbered list */
  grid?: boolean;
  back?: () => void;
}

export type ResultForm = "auto" | "exact" | "dec" | "eng" | "dms" | "fact" | "approx";

export interface ResultView {
  val: Val;
  form: ResultForm;
  engShift: number;
  /** improper/mixed toggle for this result (SHIFT S⇔D) */
  frac: FracMode;
  multi?: { labels: [string, string]; vals: [Val, Val] };
  /** text appended to the input line, e.g. "→A" or "M+" */
  suffix?: string;
}

export interface PromptScreen {
  kind: "prompt";
  purpose: "calc" | "solve" | "solveFor";
  vars: string[];
  idx: number;
  ed: Editor;
}

export interface SolveScreen {
  kind: "solved";
  name: string;
  x: Val;
  lr: number;
}

export interface ErrorScreen {
  kind: "error";
  err: CalcError;
  /** app screen to return to when the error is dismissed */
  back?: Overlay;
}

/** A table of values: coefficient editors, Table Range and the Table app's output. */
export interface GridScreen {
  kind: "grid";
  title: string;
  cols: string[];
  rowLabels: string[];
  cells: (Val | null)[][];
  r: number;
  c: number;
  /** the value being typed into the selected cell */
  ed: Editor | null;
  readOnly?: boolean;
  /** "=" with nothing being typed (solve / next step); readOnly: "=" and AC */
  onEq: () => void;
  /** hint shown under the table */
  hint?: string;
  /** the ◀ in the title: back to the app's previous menu */
  exit?: () => void;
}

export interface AnswerRow {
  label: string;
  /** values and literal tokens, rendered in order */
  parts: (Val | string)[];
}

export interface AnswersScreen {
  kind: "answers";
  title: string;
  rows: AnswerRow[];
  /** first visible row */
  top: number;
  /** S⇔D: show decimals instead of exact forms */
  dec: boolean;
  back: () => void;
}

/** One expression line, e.g. f(x)= for the Table app. */
export interface InputScreen {
  kind: "input";
  title: string;
  label: string;
  ed: Editor;
  hint?: string;
  accept: () => void;
  back: () => void;
}

export interface MessageScreen {
  kind: "msg";
  title: string;
  lines: string[];
}

export interface RecallScreen {
  kind: "recall";
}

export interface ConfirmScreen {
  kind: "confirm";
  title: string;
  run: () => void;
}

export type Overlay =
  | MenuScreen
  | PromptScreen
  | SolveScreen
  | ErrorScreen
  | MessageScreen
  | RecallScreen
  | ConfirmScreen
  | GridScreen
  | AnswersScreen
  | InputScreen
  | null;

const APP_KINDS = new Set(["grid", "answers", "input"]);

export interface HistEntry {
  expr: Node[];
  val: Val;
  multi?: ResultView["multi"];
}

interface Snapshot {
  ed: Editor;
}

const POLY_LABEL: Record<number, string> = {
  2: "aX²+bX+c=0",
  3: "aX³+bX²+cX+d=0",
  4: "aX⁴+bX³+cX²+dX+e=0",
};
const SUB = "₀₁₂₃₄";

/** "re ± im·i" pieces for a polynomial root. */
function rootParts(r: Root): (Val | string)[] {
  if (!r.im) return [r.re];
  const neg = r.im.v < 0;
  const mag: Val = neg ? { v: -r.im.v, ex: r.im.ex ? exNeg(r.im.ex) : null } : r.im;
  const parts: (Val | string)[] = [];
  if (r.re.v !== 0) parts.push(r.re, neg ? "-" : "+");
  else if (neg) parts.push("neg");
  if (Math.abs(mag.v - 1) > 1e-15) parts.push(mag);
  parts.push("i");
  return parts;
}

export class Calc {
  settings: Settings = { ...DEFAULT_SETTINGS };
  vars: Record<string, Val> = {};
  ans: Val = { v: 0, ex: ratEx(0n) };
  ed = new Editor();
  result: ResultView | null = null;
  overlay: Overlay = null;
  shift = false;
  alpha = false;
  sto = false;
  insWrap = false;
  calcMode = false; // after CALC: "=" restarts the prompts
  history: HistEntry[] = [];
  histPos = -1; // index into history while browsing with ▲▼
  undo: Snapshot[] = [];
  /** set when the user pressed SHIFT AC (OFF) */
  wantsClose = false;
  version = 0;
  /** a short-lived hint shown in the status line, e.g. "Stored to A" */
  toast: string | null = null;

  constructor() {
    for (const v of VAR_NAMES) this.vars[v] = { v: 0, ex: ratEx(0n) };
  }

  /* ---------------- environment & display ---------------- */

  get disp(): DispSetup {
    return { fmt: this.settings.fmt, digits: this.settings.digits, frac: this.settings.frac };
  }

  get mathOut() {
    return this.settings.io === "MathI/MathO" || this.settings.io === "LineI/LineO";
  }

  get lineIn() {
    return this.settings.io.startsWith("LineI");
  }

  env(): EvalEnv {
    return { angle: this.settings.angle, vars: this.vars, ans: this.ans, rnd: (x) => this.rnd(x) };
  }

  rnd(x: number): number {
    const { fmt, digits } = this.settings;
    if (x === 0) return 0;
    if (fmt === "fix") return Number(x.toFixed(digits));
    const sig = fmt === "sci" ? digits || 10 : 10;
    return Number(x.toPrecision(sig));
  }

  /** Nodes for showing a value with the current setup. */
  valueNodes(val: Val, form: ResultForm = "auto", engShift = 0, frac: FracMode = this.settings.frac): Node[] {
    const d = { ...this.disp, frac };
    if (form === "dms") return dmsNodes(val.v);
    if (form === "fact") return factNodes(val.v) ?? decNodes(formatDecimal(val.v, d));
    if (form === "eng") return decNodes(formatEng(val.v, engShift, d));
    const wantExact = form === "exact" || (form === "auto" && this.mathOut);
    if (wantExact && val.ex) {
      const ex = exactNodes(val.ex, d);
      if (ex) return ex;
    }
    return decNodes(formatDecimal(val.v, d));
  }

  /** Whether S⇔D would change the shown form. */
  hasAltForm(val: Val): boolean {
    if (!val.ex) return false;
    return exactNodes(val.ex, this.disp) !== null;
  }

  valueText(val: Val): string {
    const p: DecParts = formatDecimal(val.v, this.disp);
    return decText(p);
  }

  /** Plain text of the current result (for copying). */
  resultText(): string {
    if (!this.result) return "";
    const r = this.result;
    if (r.multi) return r.multi.labels.map((l, i) => `${l}=${toLinear(this.valueNodes(r.multi!.vals[i]))}`).join(", ");
    return toLinear(this.valueNodes(r.val, r.form, r.engShift, r.frac));
  }

  /* ---------------- key handling ---------------- */

  press(key: KeyId) {
    this.toast = null;
    try {
      this.handle(key);
    } catch (e) {
      const back = this.overlay && APP_KINDS.has(this.overlay.kind) ? this.overlay : undefined;
      if (e instanceof CalcError) this.overlay = { kind: "error", err: e, back };
      else {
        console.error(e);
        this.overlay = { kind: "error", err: new CalcError("Math"), back };
      }
    }
    this.version++;
  }

  private handle(key: KeyId) {
    if (key === "on") {
      this.allClear();
      this.overlay = null;
      return;
    }
    if (key === "shift") {
      this.shift = !this.shift;
      this.alpha = false;
      return;
    }
    if (key === "alpha") {
      this.alpha = !this.alpha;
      this.shift = false;
      return;
    }
    const mod = this.shift ? 1 : this.alpha ? 2 : 0;
    this.shift = false;
    this.alpha = false;
    // the fraction key wraps the number before the cursor into the numerator ("12" → 12/□)
    if (key === "frac" && mod === 0 && !this.result) this.insWrap = true;

    if (mod === 1 && key === "ac") {
      this.wantsClose = true;
      return;
    }
    if (mod === 1 && key === "menu") {
      this.openSetup();
      return;
    }

    const ov = this.overlay;
    if (key === "menu" && ov && APP_KINDS.has(ov.kind)) {
      this.openAppMenu(ov);
      return;
    }
    if (ov) {
      this.handleOverlay(ov, key, mod);
      return;
    }
    if (key === "menu") {
      this.openAppMenu();
      return;
    }

    if (this.sto) {
      this.sto = false;
      const name = VAR_KEYS[key] ?? (mod === 2 ? VAR_KEYS[key] : undefined);
      if (name) {
        this.storeTo(name);
        return;
      }
      if (key === "ac") return;
    }

    const insInsWrap = this.insWrap;
    this.insWrap = false;

    // navigation
    if (key === "left" || key === "right") {
      if (this.result) {
        this.leaveResult(key === "left" ? "end" : "start");
        return;
      }
      if (key === "left") this.ed.left();
      else this.ed.right();
      return;
    }
    if (key === "up" || key === "down") {
      if (this.result || this.ed.isEmpty()) {
        this.browseHistory(key === "up" ? -1 : 1);
        return;
      }
      this.ed.vertical(key === "up" ? -1 : 1);
      return;
    }

    const act = KEYS[key]?.[mod] ?? null;
    if (!act) return;
    if ("cmd" in act) {
      this.command(act.cmd, key);
      return;
    }
    if ("ins" in act) {
      this.insertTok(act.ins);
      return;
    }
    if ("tpl" in act) this.insertTpl(act.tpl, insInsWrap);
  }

  /* ---------------- editing ---------------- */

  private snapshot() {
    this.undo.push({ ed: this.ed.clone() });
    if (this.undo.length > 40) this.undo.shift();
  }

  /** Start a fresh expression after a result; with `withAns`, it begins with "Ans". */
  private freshFromResult(withAns: boolean) {
    this.snapshot();
    this.ed.clear();
    if (withAns) this.ed.insertCh("Ans");
    this.result = null;
    this.calcMode = false;
    this.histPos = -1;
  }

  private insertTok(v: string) {
    if (this.result) this.freshFromResult(NEEDS_LEFT.has(v));
    else this.snapshot();
    this.ed.insertCh(v);
  }

  private insertTpl(kind: TplKind, wrap: boolean) {
    if (this.result) {
      const withAns = kind === "pow" || kind === "frac";
      this.freshFromResult(withAns);
      if (withAns) {
        this.ed.insertTpl(kind, true);
        return;
      }
    } else this.snapshot();
    this.ed.insertTpl(kind, wrap);
  }

  private leaveResult(where: "start" | "end") {
    this.result = null;
    this.calcMode = false;
    this.histPos = -1;
    if (where === "start") this.ed.toStart();
    else this.ed.toEnd();
  }

  private allClear() {
    this.ed.clear();
    this.result = null;
    this.calcMode = false;
    this.sto = false;
    this.insWrap = false;
    this.histPos = -1;
  }

  private browseHistory(dir: -1 | 1) {
    if (!this.history.length) return;
    // while the latest answer is on screen it *is* the newest history entry
    let pos = this.histPos >= 0 ? this.histPos : this.result ? this.history.length - 1 : this.history.length;
    pos += dir;
    if (pos < 0) pos = 0;
    if (pos >= this.history.length) {
      if (this.histPos < 0) return;
      pos = this.history.length - 1;
    }
    this.histPos = pos;
    const h = this.history[pos];
    this.ed = Editor.from(cloneNodes(h.expr));
    this.result = { val: h.val, form: "auto", engShift: 0, frac: this.settings.frac, multi: h.multi };
  }

  /* ---------------- commands ---------------- */

  private command(cmd: string, key: KeyId) {
    void key;
    switch (cmd) {
      case "ac":
        this.allClear();
        return;
      case "off":
        this.wantsClose = true;
        return;
      case "del":
        if (this.result) {
          this.leaveResult("end");
          return;
        }
        this.snapshot();
        this.ed.del();
        return;
      case "ins":
        if (this.result) this.leaveResult("end");
        this.insWrap = true;
        this.toast = "INS: next template wraps";
        return;
      case "undo": {
        const s = this.undo.pop();
        if (s) {
          this.ed = s.ed;
          this.result = null;
        }
        return;
      }
      case "eq":
        if (this.calcMode) {
          this.startCalc();
          return;
        }
        this.equals(false);
        return;
      case "approx":
        this.equals(true);
        return;
      case "sd":
        if (!this.result) this.equals(false);
        if (this.result && !this.result.multi) {
          const r = this.result;
          const alt = this.hasAltForm(r.val);
          if (this.mathOut) r.form = r.form === "auto" && alt ? "dec" : "auto";
          else r.form = r.form === "auto" && alt ? "exact" : "auto";
        }
        return;
      case "abcdc":
        if (!this.result) this.equals(false);
        if (this.result) {
          this.result.frac = this.result.frac === "dc" ? "abc" : "dc";
          if (this.result.form !== "auto" && this.result.form !== "dec") this.result.form = "auto";
        }
        return;
      case "eng":
      case "engL": {
        if (!this.result) this.equals(false);
        const r = this.result;
        if (!r || r.multi) return;
        const delta = cmd === "eng" ? -1 : 1;
        if (r.form !== "eng") {
          r.form = "eng";
          r.engShift = cmd === "eng" ? 0 : 1;
        } else r.engShift += delta;
        return;
      }
      case "dms":
        if (this.result) {
          this.result.form = this.result.form === "dms" ? "auto" : "dms";
          return;
        }
        this.insertTok("°");
        return;
      case "fact": {
        if (!this.result) this.equals(false);
        const r = this.result;
        if (!r) return;
        if (!Number.isInteger(r.val.v) || r.val.v < 2 || r.val.v >= 1e10) throw new CalcError("Math");
        r.form = r.form === "fact" ? "auto" : "fact";
        return;
      }
      case "sto":
        if (!this.result && !this.ed.isEmpty()) this.equals(false);
        if (this.overlay) return;
        this.sto = true;
        return;
      case "recall":
        this.overlay = { kind: "recall" };
        return;
      case "m+":
      case "m-": {
        if (!this.result) this.equals(false);
        if (this.overlay || !this.result) return;
        const v = this.result.val;
        const M = this.vars.M;
        const nv = cmd === "m+" ? M.v + v.v : M.v - v.v;
        let ex: Ex | null = null;
        if (M.ex && v.ex) {
          ex = exAdd(M.ex, cmd === "m-" ? exNeg(v.ex) : v.ex);
        }
        this.vars.M = { v: nv, ex: ex ?? floatToExact(nv) };
        this.result.suffix = cmd === "m+" ? "M+" : "M−";
        return;
      }
      case "calc":
        this.startCalc();
        return;
      case "solve":
        this.startSolve();
        return;
      case "optn":
        this.openOptn();
        return;
      case "const":
        this.openConst();
        return;
      case "conv":
        this.openConv();
        return;
      case "reset":
        this.openReset();
        return;
      case "qr":
        this.overlay = {
          kind: "msg",
          title: "QR Code",
          lines: ["QR codes aren't available", "in Paperlike.", "", "[AC] Back"],
        };
        return;
      case "colon":
        this.toast = "Multi-statements aren't supported";
        return;
    }
  }

  private equals(approx: boolean) {
    if (this.ed.isEmpty()) {
      if (this.result) {
        this.result.form = approx ? "approx" : "auto";
      }
      return;
    }
    const expr = cloneNodes(this.ed.root.items);
    const res = calculate(this.ed.root, this.env());
    this.commitResult(expr, res.val, res.multi, approx);
  }

  private commitResult(expr: Node[], val: Val, multi: ResultView["multi"], approx: boolean) {
    this.ans = val;
    if (multi) {
      // Pol( / Rec( store their two results in X and Y
      this.vars.X = multi.vals[0];
      this.vars.Y = multi.vals[1];
    }
    this.result = { val, form: approx ? "approx" : "auto", engShift: 0, frac: this.settings.frac, multi };
    this.history.push({ expr, val, multi });
    if (this.history.length > 30) this.history.shift();
    this.histPos = -1;
    this.ed.toEnd();
  }

  private storeTo(name: string) {
    const v = this.result ? this.result.val : this.ans;
    this.vars[name] = v;
    if (this.result) this.result.suffix = `→${name === "X" ? "x" : name === "Y" ? "y" : name}`;
    else {
      this.result = { val: v, form: "auto", engShift: 0, frac: this.settings.frac, suffix: `Ans→${name}` };
    }
    this.toast = `Stored to ${name === "X" ? "x" : name === "Y" ? "y" : name}`;
  }

  /* ---------------- CALC / SOLVE ---------------- */

  private startCalc() {
    if (this.ed.isEmpty()) return;
    const vars = varsUsed(this.ed.root.items);
    const target = topLevelAssign(this.ed.root.items);
    const prompts = vars.filter((v) => v !== target);
    this.result = null;
    this.calcMode = true;
    if (!prompts.length) {
      this.finishCalc();
      return;
    }
    this.overlay = { kind: "prompt", purpose: "calc", vars: prompts, idx: 0, ed: new Editor() };
  }

  private finishCalc() {
    const expr = cloneNodes(this.ed.root.items);
    const res = calculate(this.ed.root, this.env(), { allowEq: true });
    if (res.assigned) this.vars[res.assigned] = res.val;
    this.overlay = null;
    this.commitResult(expr, res.val, res.multi, false);
    this.calcMode = true;
  }

  private startSolve() {
    if (this.result) this.leaveResult("end");
    if (this.ed.isEmpty()) return;
    const vars = varsUsed(this.ed.root.items);
    if (!vars.length) throw new CalcError("Can't Solve");
    const unknown = vars.includes("X") ? "X" : vars[0];
    const others = vars.filter((v) => v !== unknown);
    this.calcMode = false;
    this.overlay = { kind: "prompt", purpose: "solve", vars: [...others, unknown], idx: 0, ed: new Editor() };
    if (!others.length) this.overlay.purpose = "solveFor";
  }

  private promptAccept(p: PromptScreen) {
    const name = p.vars[p.idx];
    if (!p.ed.isEmpty()) {
      const r = calculate(p.ed.root, this.env());
      this.vars[name] = r.val;
    }
    const last = p.idx === p.vars.length - 1;
    if (p.purpose === "calc") {
      if (last) this.finishCalc();
      else this.overlay = { ...p, idx: p.idx + 1, ed: new Editor() };
      return;
    }
    if (!last) {
      const nextIdx = p.idx + 1;
      this.overlay = { ...p, idx: nextIdx, ed: new Editor(), purpose: nextIdx === p.vars.length - 1 ? "solveFor" : "solve" };
      return;
    }
    // solve for the unknown, starting from its current value
    const x0 = this.vars[name].v;
    const { x, lr } = solve(this.ed.root, this.env(), x0, name);
    const xv: Val = { v: x, ex: floatToExact(x) };
    this.vars[name] = xv;
    this.ans = xv;
    this.overlay = { kind: "solved", name, x: xv, lr };
  }

  /* ---------------- overlays ---------------- */

  private handleOverlay(ov: Exclude<Overlay, null>, key: KeyId, mod: number) {
    switch (ov.kind) {
      case "error":
        if (ov.back && (key === "ac" || key === "left" || key === "right" || key === "del" || key === "eq")) {
          this.overlay = ov.back;
          return;
        }
        if (key === "ac") {
          this.overlay = null;
          this.allClear();
        } else if (key === "left" || key === "right" || key === "del") {
          this.overlay = null;
          this.result = null;
          this.calcMode = false;
          if (ov.err.at && slotInTree(this.ed.root, ov.err.at.slot)) this.ed.goto(ov.err.at.slot, ov.err.at.i);
          else this.ed.toEnd();
        }
        return;
      case "msg":
        if (key === "ac" || key === "left" || key === "eq") this.overlay = null;
        return;
      case "confirm":
        if (key === "eq") {
          ov.run();
          if (this.overlay === ov) this.overlay = null;
        } else if (key === "ac") this.overlay = null;
        return;
      case "recall": {
        if (key === "ac" || key === "left") {
          this.overlay = null;
          return;
        }
        const name = VAR_KEYS[key];
        if (name) {
          this.overlay = null;
          this.insertTok(name);
        }
        return;
      }
      case "solved":
        if (key === "ac") {
          this.overlay = null;
          this.result = null;
          this.ed.toEnd();
        } else if (key === "eq" || key === "calc" && mod === 1) {
          this.startSolve();
        } else if (key === "left" || key === "right") {
          this.overlay = null;
          this.leaveResult(key === "left" ? "end" : "start");
        }
        return;
      case "prompt":
        this.handlePrompt(ov, key, mod);
        return;
      case "menu":
        this.handleMenu(ov, key);
        return;
      case "grid":
        this.handleGrid(ov, key, mod);
        return;
      case "answers":
        this.handleAnswers(ov, key);
        return;
      case "input":
        this.handleInput(ov, key, mod);
        return;
    }
  }

  private handlePrompt(p: PromptScreen, key: KeyId, mod: number) {
    if (key === "ac") {
      this.overlay = null;
      this.calcMode = false;
      this.result = null;
      return;
    }
    if (key === "eq") {
      this.promptAccept(p);
      return;
    }
    if (key === "calc" && p.purpose === "calc") {
      this.overlay = null;
      this.calcMode = false;
      return;
    }
    if (key === "up" || key === "down") {
      // ▲▼ step between the prompted variables
      const n = Math.max(0, Math.min(p.vars.length - 1, p.idx + (key === "up" ? -1 : 1)));
      if (n !== p.idx) this.overlay = { ...p, idx: n, ed: new Editor() };
      return;
    }
    if (key === "left") {
      if (p.ed.isEmpty()) {
        this.overlay = null;
        this.calcMode = false;
        this.leaveResult("end");
      } else p.ed.left();
      return;
    }
    if (key === "right") {
      p.ed.right();
      return;
    }
    if (key === "del") {
      p.ed.del();
      return;
    }
    const act = KEYS[key]?.[mod] ?? null;
    if (!act) return;
    if ("ins" in act) p.ed.insertCh(act.ins);
    else if ("tpl" in act) p.ed.insertTpl(act.tpl);
  }

  private handleMenu(m: MenuScreen, key: KeyId) {
    const perPage = m.grid ? 12 : 4;
    const pages = Math.max(1, Math.ceil(m.items.length / perPage));
    if (m.grid && m.back && (key === "ac" || key === "menu" || key === "left")) {
      m.back();
      return;
    }
    if (key === "ac" || key === "left") {
      if (m.back && key === "left") m.back();
      else this.overlay = null;
      return;
    }
    if (key === "menu" && m.grid) {
      this.overlay = null;
      return;
    }
    if (key === "down" || key === "up") {
      m.page = (m.page + (key === "down" ? 1 : -1) + pages) % pages;
      return;
    }
    if (key === "right" && m.grid) {
      m.page = (m.page + 1) % pages;
      return;
    }
    const digit = "0123456789".indexOf(key);
    if (digit > 0 || (digit === 0 && m.items.length >= 10)) {
      const idx = digit === 0 ? 9 : digit - 1;
      const item = m.items[m.grid ? idx : idx];
      if (item) this.selectMenuItem(item);
      return;
    }
    // letters for the 10th+ items of the app grid (A, B, C via ALPHA keys)
    const letter = VAR_KEYS[key];
    if (m.grid && letter && "ABC".includes(letter)) {
      const item = m.items[9 + "ABC".indexOf(letter)];
      if (item) this.selectMenuItem(item);
    }
  }

  selectMenuItem(item: MenuItem) {
    const before = this.overlay;
    item.run(this);
    if (this.overlay === before) this.overlay = null;
    this.version++;
  }

  /** Tap on a menu row (the LCD is touch-enabled in Paperlike). */
  tapMenu(index: number) {
    const m = this.overlay;
    if (!m || m.kind !== "menu") return;
    const item = m.items[index];
    if (item) this.selectMenuItem(item);
  }

  tapRecall(name: string) {
    if (this.overlay?.kind !== "recall") return;
    this.overlay = null;
    this.insertTok(name);
    this.version++;
  }

  private menu(title: string, items: MenuItem[], back?: () => void) {
    this.overlay = { kind: "menu", title, items, page: 0, back };
  }

  private openAppMenu(from?: Overlay) {
    const na = (name: string) => () => {
      this.overlay = {
        kind: "msg",
        title: name,
        lines: [`${name} isn't available`, "in Paperlike yet.", "", "[AC] Back"],
      };
    };
    const items: MenuItem[] = [
      { label: "Calculate", run: () => (this.overlay = null) },
      { label: "Complex", run: na("Complex") },
      { label: "Base-N", run: na("Base-N") },
      { label: "Matrix", run: na("Matrix") },
      { label: "Vector", run: na("Vector") },
      { label: "Statistics", run: na("Statistics") },
      { label: "Distribution", run: na("Distribution") },
      { label: "Spreadsheet", run: na("Spreadsheet") },
      { label: "Table", run: () => this.openTable() },
      { label: "Equation/Func", run: () => this.openEquation() },
      { label: "Inequality", run: () => this.openInequality() },
      { label: "Ratio", run: () => this.openRatio() },
    ];
    const back = from ? () => (this.overlay = from) : undefined;
    this.overlay = { kind: "menu", title: "MENU", items, page: 0, grid: true, back };
  }

  /* ---------------- apps: Equation/Func, Inequality, Ratio, Table ---------------- */

  /** coefficients are kept per app and size, like the real calculator */
  private appData: Record<string, (Val | null)[][]> = {};
  tableF = new Editor();
  tableG = new Editor();

  private zeros(rows: number, cols: number, key: string): (Val | null)[][] {
    const old = this.appData[key];
    if (old && old.length === rows && old[0]?.length === cols) return old;
    const z = Array.from({ length: rows }, () => Array.from({ length: cols }, () => ({ v: 0, ex: ratEx(0n) }) as Val | null));
    this.appData[key] = z;
    return z;
  }

  private grid(o: Omit<GridScreen, "kind" | "r" | "c" | "ed">) {
    this.overlay = { kind: "grid", r: 0, c: 0, ed: null, ...o };
  }

  private answers(title: string, rows: AnswerRow[], back: () => void) {
    this.overlay = { kind: "answers", title, rows, top: 0, dec: false, back };
  }

  private openEquation() {
    const top = () => this.openEquation();
    this.menu("Equation/Func", [
      {
        label: "Simul Equation",
        run: () =>
          this.menu(
            "Number of Unknowns?",
            [2, 3, 4].map((n) => ({ label: `${n} Unknowns`, run: () => this.openSimul(n) })),
            top,
          ),
      },
      {
        label: "Polynomial",
        run: () =>
          this.menu(
            "Degree?",
            [2, 3, 4].map((d) => ({ label: POLY_LABEL[d], run: () => this.openPoly(d) })),
            top,
          ),
      },
    ]);
  }

  private openSimul(n: number) {
    const letters = "abcde".slice(0, n + 1).split("");
    const unknowns = ["x", "y", "z", "t"].slice(0, n);
    const cells = this.zeros(n, n + 1, `simul${n}`);
    const back = () => {
      this.overlay = screen;
      screen.ed = null;
    };
    this.grid({
      title: unknowns.map((u, i) => `${letters[i]}${u}`).join("+") + `=${letters[n]}`,
      cols: letters,
      rowLabels: unknowns.map((_, i) => String(i + 1)),
      cells,
      exit: () => this.openEquation(),
      onEq: () => {
        const res = solveSimul(cells.map((r) => r.map((v) => v!)));
        if (res.kind !== "one") {
          this.answers("Simul Equation", [{ label: "", parts: [res.kind === "none" ? "No Solution" : "Infinite Solution"] }], back);
          return;
        }
        res.xs.forEach((v, i) => n === 2 && (this.vars[i ? "Y" : "X"] = v));
        this.answers(
          "Simul Equation",
          res.xs.map((v, i) => ({ label: unknowns[i], parts: [v] })),
          back,
        );
      },
    });
    const screen = this.overlay as GridScreen;
  }

  private openPoly(d: number) {
    const letters = "abcde".slice(0, d + 1).split("");
    const cells = this.zeros(1, d + 1, `poly${d}`);
    const back = () => {
      this.overlay = screen;
      screen.ed = null;
    };
    this.grid({
      title: POLY_LABEL[d],
      cols: letters,
      rowLabels: [""],
      cells,
      exit: () => this.openEquation(),
      onEq: () => {
        const coefs = cells[0].map((v) => v!);
        const roots = polyRoots(coefs);
        const rows: AnswerRow[] = roots.map((r, i) => ({
          label: roots.length === 1 ? "x" : `x${SUB[i + 1]}`,
          parts: rootParts(r),
        }));
        if (d === 2) {
          const [vx, vy] = quadVertex(coefs[0], coefs[1], coefs[2]);
          const kind = coefs[0].v > 0 ? "Min" : "Max";
          rows.push({ label: `${kind} x`, parts: [vx] }, { label: `${kind} y`, parts: [vy] });
        }
        this.answers(POLY_LABEL[d], rows, back);
      },
    });
    const screen = this.overlay as GridScreen;
  }

  private openInequality() {
    const top = () => this.openInequality();
    this.menu(
      "Inequality: Degree?",
      [2, 3, 4].map((d) => ({
        label: POLY_LABEL[d].replace("=0", ""),
        hint: `degree ${d}`,
        run: () =>
          this.menu(
            "Inequality type",
            (["<", ">", "≤", "≥"] as IneqOp[]).map((op) => ({
              label: POLY_LABEL[d].replace("=", op),
              run: () => this.openIneq(d, op),
            })),
            top,
          ),
      })),
    );
  }

  private openIneq(d: number, op: IneqOp) {
    const letters = "abcde".slice(0, d + 1).split("");
    const cells = this.zeros(1, d + 1, `ineq${d}`);
    const back = () => {
      this.overlay = screen;
      screen.ed = null;
    };
    const title = POLY_LABEL[d].replace("=", op);
    this.grid({
      title,
      cols: letters,
      rowLabels: [""],
      cells,
      exit: () => this.openInequality(),
      onEq: () => {
        const res = solveIneq(
          cells[0].map((v) => v!),
          op,
        );
        if (res.kind !== "set") {
          this.answers(title, [{ label: "", parts: [res.kind === "all" ? "All Real Numbers" : "No Solution"] }], back);
          return;
        }
        const rows: AnswerRow[] = res.pieces.map((p) => {
          if (p.lo && p.hi && p.lo === p.hi) return { label: "", parts: ["X", "=", p.lo] };
          const parts: (Val | string)[] = [];
          if (p.lo) parts.push(p.lo, p.loIn ? "≤" : "<");
          parts.push("X");
          if (p.hi) parts.push(p.hiIn ? "≤" : "<", p.hi);
          return { label: "", parts };
        });
        this.answers(title, rows, back);
      },
    });
    const screen = this.overlay as GridScreen;
  }

  private openRatio() {
    this.menu("Ratio", [
      { label: "A:B=X:D", run: () => this.openRatioGrid(false) },
      { label: "A:B=C:X", run: () => this.openRatioGrid(true) },
    ]);
  }

  private openRatioGrid(xLast: boolean) {
    const cols = xLast ? ["A", "B", "C"] : ["A", "B", "D"];
    const cells = this.zeros(1, 3, xLast ? "ratio2" : "ratio1");
    const back = () => {
      this.overlay = screen;
      screen.ed = null;
    };
    const title = xLast ? "A:B=C:X" : "A:B=X:D";
    this.grid({
      title,
      cols,
      rowLabels: [""],
      cells,
      exit: () => this.openRatio(),
      onEq: () => {
        const [a, b, cd] = cells[0].map((v) => v!);
        // A:B = X:D → X = A·D/B ;  A:B = C:X → X = B·C/A
        const x = xLast ? vDiv(vMul(b, cd), a) : vDiv(vMul(a, cd), b);
        this.vars.X = x;
        this.answers(title, [{ label: "X", parts: [x] }], back);
      },
    });
    const screen = this.overlay as GridScreen;
  }

  private openTable() {
    this.overlay = {
      kind: "input",
      title: "Table",
      label: "f(x)=",
      ed: this.tableF,
      hint: "Enter f(x) with [x], then [=]",
      back: () => (this.overlay = null),
      accept: () => {
        if (this.tableF.isEmpty()) return;
        this.tableF.toEnd();
        this.overlay = {
          kind: "input",
          title: "Table",
          label: "g(x)=",
          ed: this.tableG,
          hint: "Optional: leave empty and press [=]",
          back: () => this.openTable(),
          accept: () => this.openTableRange(),
        };
      },
    };
  }

  private openTableRange() {
    let cells = this.appData.tableRange;
    if (!cells) {
      cells = [[{ v: 1, ex: ratEx(1n) }], [{ v: 5, ex: ratEx(5n) }], [{ v: 1, ex: ratEx(1n) }]];
      this.appData.tableRange = cells;
    }
    const range = cells;
    this.grid({
      title: "Table Range",
      cols: ["Value"],
      rowLabels: ["Start", "End", "Step"],
      cells: range,
      hint: "[=] Make table",
      exit: () => this.openTable(),
      onEq: () => this.makeTable(range.map((r) => r[0]!)),
    });
  }

  private makeTable([start, end, step]: Val[]) {
    if (step.v === 0 || (end.v - start.v) / step.v < -1e-9) throw new CalcError("Range");
    const n = Math.floor((end.v - start.v) / step.v + 1e-9) + 1;
    const useG = !this.tableG.isEmpty();
    if (n > (useG ? 30 : 45)) throw new CalcError("Range");
    const saved = this.vars.X;
    const rows: (Val | null)[][] = [];
    try {
      for (let i = 0; i < n; i++) {
        const iv: Val = { v: i, ex: ratEx(BigInt(i)) };
        const prod = vMul(iv, step);
        const x: Val = {
          v: start.v + i * step.v,
          ex: start.ex && prod.ex ? exAdd(start.ex, prod.ex) : floatToExact(start.v + i * step.v),
        };
        this.vars.X = x;
        const at = (ed: Editor): Val | null => {
          try {
            return calculate(ed.root, this.env()).val;
          } catch {
            return null;
          }
        };
        rows.push(useG ? [x, at(this.tableF), at(this.tableG)] : [x, at(this.tableF)]);
      }
    } finally {
      this.vars.X = saved;
    }
    const back = () => this.openTable();
    this.grid({
      title: "Table",
      cols: useG ? ["x", "f(x)", "g(x)"] : ["x", "f(x)"],
      rowLabels: rows.map((_, i) => String(i + 1)),
      cells: rows,
      readOnly: true,
      onEq: back,
      exit: back,
    });
    const g = this.overlay as GridScreen;
    g.c = 1;
  }

  private gridCommit(g: GridScreen): boolean {
    if (!g.ed) return false;
    if (!g.ed.isEmpty()) g.cells[g.r][g.c] = calculate(g.ed.root, this.env()).val;
    g.ed = null;
    return true;
  }

  private gridMove(g: GridScreen, dr: number, dc: number) {
    g.r = Math.max(0, Math.min(g.cells.length - 1, g.r + dr));
    g.c = Math.max(0, Math.min(g.cols.length - 1, g.c + dc));
  }

  /** The ◀ on an app screen's title row. */
  appBack() {
    const ov = this.overlay;
    this.toast = null;
    if (ov?.kind === "grid") {
      if (ov.ed) ov.ed = null;
      else if (ov.exit) ov.exit();
    } else if (ov?.kind === "answers") ov.back();
    else if (ov?.kind === "input") ov.back();
    this.version++;
  }

  /** Tap on a table cell. */
  tapGrid(r: number, c: number) {
    const g = this.overlay;
    if (!g || g.kind !== "grid") return;
    this.toast = null;
    try {
      this.gridCommit(g);
      g.r = r;
      g.c = c;
    } catch (e) {
      if (e instanceof CalcError) this.overlay = { kind: "error", err: e, back: g };
    }
    this.version++;
  }

  private handleGrid(g: GridScreen, key: KeyId, mod: number) {
    if (key !== "frac") this.insWrap = false;
    const nav: Record<string, [number, number]> = { up: [-1, 0], down: [1, 0], left: [0, -1], right: [0, 1] };
    if (g.readOnly) {
      if (key in nav) this.gridMove(g, ...nav[key]);
      else if (key === "ac" || key === "eq") g.onEq();
      return;
    }
    if (key === "ac") {
      g.ed = null;
      return;
    }
    if (key === "eq") {
      if (this.gridCommit(g)) {
        // move to the next cell, row by row
        if (g.c < g.cols.length - 1) g.c++;
        else if (g.r < g.cells.length - 1) {
          g.r++;
          g.c = 0;
        }
      } else g.onEq();
      return;
    }
    if (key in nav) {
      if (g.ed && !g.ed.isEmpty() && (key === "left" || key === "right")) {
        if (key === "left") g.ed.left();
        else g.ed.right();
        return;
      }
      this.gridCommit(g);
      this.gridMove(g, ...nav[key]);
      return;
    }
    if (key === "del") {
      if (g.ed) g.ed.del();
      return;
    }
    const act = KEYS[key]?.[mod] ?? null;
    if (!act || "cmd" in act) return;
    const wrap = this.insWrap;
    this.insWrap = false;
    if (!g.ed) g.ed = new Editor();
    if ("ins" in act) g.ed.insertCh(act.ins);
    else g.ed.insertTpl(act.tpl, wrap);
  }

  private handleAnswers(a: AnswersScreen, key: KeyId) {
    if (key === "ac" || key === "eq" || key === "left") a.back();
    else if (key === "up") a.top = Math.max(0, a.top - 1);
    else if (key === "down") a.top = Math.max(0, Math.min(a.rows.length - 2, a.top + 1));
    else if (key === "sd") a.dec = !a.dec;
  }

  private handleInput(s: InputScreen, key: KeyId, mod: number) {
    if (key !== "frac") this.insWrap = false;
    if (key === "ac") {
      if (s.ed.isEmpty()) s.back();
      else s.ed.clear();
      return;
    }
    if (key === "eq") return s.accept();
    if (key === "left") return s.ed.left();
    if (key === "right") return s.ed.right();
    if (key === "up" || key === "down") return s.ed.vertical(key === "up" ? -1 : 1);
    if (key === "del") return s.ed.del();
    const act = KEYS[key]?.[mod] ?? null;
    if (!act || "cmd" in act) return;
    const wrap = this.insWrap;
    this.insWrap = false;
    if ("ins" in act) s.ed.insertCh(act.ins);
    else s.ed.insertTpl(act.tpl, wrap);
  }

  /** Nodes for an answer row. */
  answerNodes(row: AnswerRow, dec: boolean): Node[] {
    const out: Node[] = [];
    for (const p of row.parts) {
      if (typeof p === "string") {
        out.push(ch(p));
      } else out.push(...this.valueNodes(p, dec ? "dec" : "auto"));
    }
    return out;
  }

  openSetup() {
    const s = this.settings;
    const top = () => this.openSetup();
    this.menu("SETUP", [
      {
        label: "Input/Output",
        hint: s.io,
        run: () =>
          this.menu(
            "Input/Output",
            (["MathI/MathO", "MathI/DecimalO", "LineI/LineO", "LineI/DecimalO"] as IOMode[]).map((io) => ({
              label: io,
              checked: s.io === io,
              run: () => {
                s.io = io;
                this.redisplay();
              },
            })),
            top,
          ),
      },
      {
        label: "Angle Unit",
        hint: { DEG: "Degree", RAD: "Radian", GRA: "Gradian" }[s.angle],
        run: () =>
          this.menu(
            "Angle Unit",
            (["DEG", "RAD", "GRA"] as AngleMode[]).map((a) => ({
              label: { DEG: "Degree", RAD: "Radian", GRA: "Gradian" }[a],
              checked: s.angle === a,
              run: () => {
                s.angle = a;
              },
            })),
            top,
          ),
      },
      {
        label: "Number Format",
        hint: s.fmt === "fix" ? `Fix ${s.digits}` : s.fmt === "sci" ? `Sci ${s.digits}` : s.fmt === "norm1" ? "Norm 1" : "Norm 2",
        run: () =>
          this.menu(
            "Number Format",
            [
              { label: "Fix", checked: s.fmt === "fix", run: () => this.digitsMenu("fix", "Fix 0~9?") },
              { label: "Sci", checked: s.fmt === "sci", run: () => this.digitsMenu("sci", "Sci 0~9?") },
              {
                label: "Norm",
                checked: s.fmt === "norm1" || s.fmt === "norm2",
                run: () =>
                  this.menu(
                    "Norm 1~2?",
                    [
                      { label: "Norm 1", checked: s.fmt === "norm1", run: () => this.setFmt("norm1", 0) },
                      { label: "Norm 2", checked: s.fmt === "norm2", run: () => this.setFmt("norm2", 0) },
                    ],
                    top,
                  ),
              },
            ],
            top,
          ),
      },
      {
        label: "Fraction Result",
        hint: s.frac === "dc" ? "d/c" : "ab/c",
        run: () =>
          this.menu(
            "Fraction Result",
            [
              { label: "ab/c", checked: s.frac === "abc", run: () => ((s.frac = "abc"), this.redisplay()) },
              { label: "d/c", checked: s.frac === "dc", run: () => ((s.frac = "dc"), this.redisplay()) },
            ],
            top,
          ),
      },
    ]);
  }

  private digitsMenu(fmt: "fix" | "sci", title: string) {
    const items: MenuItem[] = [];
    for (let i = 1; i <= 10; i++) {
      const d = i % 10;
      items.push({
        label: `${d}`,
        checked: this.settings.fmt === fmt && this.settings.digits === d,
        run: () => this.setFmt(fmt, d),
      });
    }
    this.menu(title, items, () => this.openSetup());
  }

  private setFmt(fmt: NumFormat, digits: number) {
    this.settings.fmt = fmt;
    this.settings.digits = digits;
    this.redisplay();
  }

  private redisplay() {
    if (this.result) {
      this.result.form = "auto";
      this.result.frac = this.settings.frac;
    }
  }

  private openOptn() {
    if (this.result) this.leaveResult("end");
    const insert = (v: string) => () => this.insertTok(v);
    const top = () => this.openOptn();
    this.menu("OPTN", [
      {
        label: "Hyperbolic Func",
        run: () =>
          this.menu(
            "Hyperbolic Func",
            ["sinh(", "cosh(", "tanh(", "sinh⁻¹(", "cosh⁻¹(", "tanh⁻¹("].map((f) => ({ label: f.slice(0, -1), run: insert(f) })),
            top,
          ),
      },
      {
        label: "Angle Unit",
        run: () =>
          this.menu(
            "Angle Unit",
            [
              { label: "°  degrees", run: insert("°u") },
              { label: "ʳ  radians", run: insert("r") },
              { label: "ᵍ  gradians", run: insert("g") },
            ],
            top,
          ),
      },
      {
        label: "Engineer Symbol",
        run: () =>
          this.menu(
            "Engineer Symbol",
            ENG_SYMBOLS.map((e) => ({ label: `${e.sym}  ${e.name}`, hint: `10^${e.exp}`, run: insert(`k:${e.sym}`) })),
            top,
          ),
      },
      {
        label: "Other",
        run: () =>
          this.menu(
            "Other",
            [
              { label: "GCD", hint: "greatest common divisor", run: insert("GCD(") },
              { label: "LCM", hint: "least common multiple", run: insert("LCM(") },
              { label: "Int", hint: "integer part", run: insert("Int(") },
              { label: "Intg", hint: "largest integer ≤ x", run: insert("Intg(") },
            ],
            top,
          ),
      },
    ]);
  }

  private openConst() {
    if (this.result) this.leaveResult("end");
    const top = () => this.openConst();
    this.menu(
      "CONST",
      CONST_GROUPS.map((g) => ({
        label: g.name,
        run: () =>
          this.menu(
            g.name,
            g.items.map((c) => ({ label: c.sym, hint: c.name, run: () => this.insertTok(`c:${c.id}`) })),
            top,
          ),
      })),
    );
  }

  private openConv() {
    if (this.result) this.leaveResult("end");
    const top = () => this.openConv();
    this.menu(
      "CONV",
      CONV_GROUPS.map((g) => ({
        label: g.name,
        run: () =>
          this.menu(
            g.name,
            g.items.map((c) => ({ label: c.label, run: () => this.insertTok(`v:${c.id}`) })),
            top,
          ),
      })),
    );
  }

  private openReset() {
    const confirm = (title: string, run: () => void) => () => {
      this.overlay = { kind: "confirm", title, run };
    };
    this.menu("RESET", [
      {
        label: "Setup Data",
        run: confirm("Reset Setup Data?", () => {
          this.settings = { ...DEFAULT_SETTINGS };
          this.overlay = { kind: "msg", title: "RESET", lines: ["Reset Setup Data", "", "[AC] Back"] };
        }),
      },
      {
        label: "Variable Memory",
        run: confirm("Clear Variable Memory?", () => {
          for (const v of VAR_NAMES) this.vars[v] = { v: 0, ex: ratEx(0n) };
          this.ans = { v: 0, ex: ratEx(0n) };
          this.overlay = { kind: "msg", title: "RESET", lines: ["Variables cleared", "", "[AC] Back"] };
        }),
      },
      {
        label: "Initialize All",
        run: confirm("Initialize All?", () => {
          this.settings = { ...DEFAULT_SETTINGS };
          for (const v of VAR_NAMES) this.vars[v] = { v: 0, ex: ratEx(0n) };
          this.ans = { v: 0, ex: ratEx(0n) };
          this.history = [];
          this.allClear();
          this.overlay = { kind: "msg", title: "RESET", lines: ["Initialized all", "", "[AC] Back"] };
        }),
      },
    ]);
  }

  /* ---------------- persistence ---------------- */

  toJSON() {
    const vs = (v: Val) => ({ v: v.v, ex: v.ex ? v.ex.map((t) => [String(t.n), String(t.d), String(t.rad), t.pi, t.ee]) : null });
    return {
      settings: this.settings,
      vars: Object.fromEntries(Object.entries(this.vars).map(([k, v]) => [k, vs(v)])),
      ans: vs(this.ans),
      history: this.history.slice(-15).map((h) => ({ expr: serialize(h.expr), val: vs(h.val) })),
    };
  }

  load(data: unknown) {
    if (!data || typeof data !== "object") return;
    const d = data as Record<string, unknown>;
    const vl = (x: unknown): Val | null => {
      if (!x || typeof x !== "object") return null;
      const o = x as { v: unknown; ex: unknown };
      if (typeof o.v !== "number" || !Number.isFinite(o.v)) return null;
      let ex: Ex | null = null;
      if (Array.isArray(o.ex)) {
        try {
          ex = (o.ex as unknown[][]).map((t) => ({
            n: BigInt(t[0] as string),
            d: BigInt(t[1] as string),
            rad: BigInt(t[2] as string),
            pi: Number(t[3]),
            ee: Number(t[4]),
          }));
        } catch {
          ex = null;
        }
      }
      return { v: o.v, ex };
    };
    const s = d.settings as Partial<Settings> | undefined;
    if (s && typeof s === "object") {
      const ios: IOMode[] = ["MathI/MathO", "MathI/DecimalO", "LineI/LineO", "LineI/DecimalO"];
      if (ios.includes(s.io as IOMode)) this.settings.io = s.io as IOMode;
      if (s.angle === "DEG" || s.angle === "RAD" || s.angle === "GRA") this.settings.angle = s.angle;
      if (s.fmt === "norm1" || s.fmt === "norm2" || s.fmt === "fix" || s.fmt === "sci") this.settings.fmt = s.fmt;
      if (typeof s.digits === "number" && s.digits >= 0 && s.digits <= 9) this.settings.digits = Math.round(s.digits);
      if (s.frac === "dc" || s.frac === "abc") this.settings.frac = s.frac;
    }
    if (d.vars && typeof d.vars === "object") {
      for (const [k, v] of Object.entries(d.vars as Record<string, unknown>)) {
        const val = vl(v);
        if (val && VAR_NAMES.includes(k)) this.vars[k] = val;
      }
    }
    const a = vl(d.ans);
    if (a) this.ans = a;
    if (Array.isArray(d.history)) {
      for (const h of d.history as { expr: unknown; val: unknown }[]) {
        const val = vl(h?.val);
        const expr = deserialize(h?.expr);
        if (val && expr.length) this.history.push({ expr, val });
      }
    }
  }
}

/** Variable assigned by a top-level "V = …" (CALC), if any. */
function topLevelAssign(items: Node[]): string | null {
  const eq = items.findIndex((n) => n.kind === "ch" && n.v === "=");
  if (eq === 1 && items[0].kind === "ch" && /^[A-FMXY]$/.test(items[0].v)) return items[0].v;
  return null;
}

function slotInTree(root: { items: Node[] }, target: unknown): boolean {
  if (root === target) return true;
  for (const n of root.items) for (const s of n.slots) if (slotInTree(s, target)) return true;
  return false;
}

export { ch, tpl };
