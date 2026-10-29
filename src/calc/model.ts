/**
 * Natural-textbook input model for the fx-991EX style calculator.
 *
 * An expression is a list of nodes. A node is either a single "char" token
 * (digit, operator, function name, variable, postfix mark …) or a template with
 * slots (fraction, root, power, ∫ …). Each slot is again a list of nodes, so the
 * whole input is a tree. The cursor is a (slot, index) pair: it sits between
 * two nodes of one slot.
 */

export type TplKind =
  | "frac" // ■/■
  | "mixed" // ■ ■/■
  | "sqrt" // √■
  | "cbrt" // ∛■
  | "root" // ■√■ (index, radicand)
  | "pow" // x^■ (exponent attached to the term on its left)
  | "logb" // log_■(■)
  | "pow10" // 10^■
  | "powe" // e^■
  | "abs" // |■|
  | "integ" // ∫ f dx, a → b
  | "deriv" // d/dx (f)|x=a
  | "sum" // Σ f, x=a → b
  | "e10"; // ×10^■

export interface Slot {
  items: Node[];
  owner: Node | null;
}

export interface Node {
  kind: "ch" | TplKind;
  /** token id for chars, e.g. "7", "+", "sin(", "Ans", "²" */
  v: string;
  slots: Slot[];
  parent: Slot | null;
}

export interface Cursor {
  slot: Slot;
  i: number;
}

/** Number of slots per template, in Casio key-entry (navigation) order. */
export const SLOT_COUNT: Record<TplKind, number> = {
  frac: 2,
  mixed: 3,
  sqrt: 1,
  cbrt: 1,
  root: 2,
  pow: 1,
  logb: 2,
  pow10: 1,
  powe: 1,
  abs: 1,
  integ: 3, // integrand, lower, upper
  deriv: 2, // f, x value
  sum: 3, // f, lower, upper
  e10: 1,
};

export function newSlot(owner: Node | null = null): Slot {
  return { items: [], owner };
}

export function ch(v: string): Node {
  return { kind: "ch", v, slots: [], parent: null };
}

export function tpl(kind: TplKind, fill?: Node[][]): Node {
  const n: Node = { kind, v: kind, slots: [], parent: null };
  for (let i = 0; i < SLOT_COUNT[kind]; i++) {
    const s = newSlot(n);
    if (fill && fill[i]) for (const c of fill[i]) attach(s, c, s.items.length);
    n.slots.push(s);
  }
  return n;
}

function attach(s: Slot, n: Node, at: number) {
  n.parent = s;
  s.items.splice(at, 0, n);
}

/* ------------------------------------------------------------------ */
/* Token classes                                                       */
/* ------------------------------------------------------------------ */

/** Tokens that need a left operand (an operator after a result becomes "Ans op"). */
export const NEEDS_LEFT = new Set(["+", "-", "×", "÷", "²", "³", "⁻¹", "!", "%", "nPr", "nCr", "°", "°u", "r", "g"]);

export function isDigitTok(v: string) {
  return /^[0-9.]$/.test(v);
}

/* ------------------------------------------------------------------ */
/* Editor                                                              */
/* ------------------------------------------------------------------ */

export class Editor {
  root: Slot = newSlot(null);
  cur: Cursor = { slot: this.root, i: 0 };

  static from(nodes: Node[]): Editor {
    const e = new Editor();
    for (const n of nodes) attach(e.root, cloneNode(n), e.root.items.length);
    e.cur = { slot: e.root, i: e.root.items.length };
    return e;
  }

  isEmpty() {
    return this.root.items.length === 0;
  }

  clear() {
    this.root = newSlot(null);
    this.cur = { slot: this.root, i: 0 };
  }

  clone(): Editor {
    const e = new Editor();
    const map = new Map<Slot, Slot>();
    e.root = cloneSlot(this.root, null, map);
    const s = map.get(this.cur.slot) ?? e.root;
    e.cur = { slot: s, i: Math.min(this.cur.i, s.items.length) };
    return e;
  }

  /** Insert a character token at the cursor. */
  insertCh(v: string) {
    const n = ch(v);
    attach(this.cur.slot, n, this.cur.i);
    this.cur = { slot: this.cur.slot, i: this.cur.i + 1 };
  }

  /**
   * Insert a template. Fraction/power-like templates pick up the term on their
   * left as the first slot, like Casio does for ■/■ after a number
   * (Casio only does that in INS-wrap mode; by default the slot starts empty,
   * except for x^■ which attaches to the left operand and has only one slot).
   */
  insertTpl(kind: TplKind, wrap = false) {
    const n = tpl(kind);
    const s = this.cur.slot;
    const start = wrap ? termStart(s.items, this.cur.i) : this.cur.i;
    if (wrap && start < this.cur.i) {
      // SHIFT INS / fraction key: move the term left of the cursor into the first slot
      const moved = s.items.splice(start, this.cur.i - start);
      for (const m of moved) attach(n.slots[0], m, n.slots[0].items.length);
      attach(s, n, start);
      this.cur = { slot: n.slots[kind === "mixed" ? 0 : 0], i: n.slots[0].items.length };
      if (kind === "frac" || kind === "logb" || kind === "root" || kind === "integ" || kind === "deriv" || kind === "sum") {
        // after wrapping, Casio puts the cursor in the next empty slot
        if (n.slots[1]) this.cur = { slot: n.slots[1], i: 0 };
      }
      return;
    }
    attach(s, n, this.cur.i);
    this.cur = { slot: n.slots[0], i: 0 };
  }

  /** DEL: delete the node left of the cursor (Casio semantics for templates). */
  del() {
    const { slot, i } = this.cur;
    if (i > 0) {
      const left = slot.items[i - 1];
      if (left.kind === "ch") {
        slot.items.splice(i - 1, 1);
        this.cur = { slot, i: i - 1 };
        return;
      }
      if (isTplEmpty(left)) {
        slot.items.splice(i - 1, 1);
        this.cur = { slot, i: i - 1 };
        return;
      }
      // step into the template's last slot
      const last = left.slots[left.slots.length - 1];
      this.cur = { slot: last, i: last.items.length };
      // if that slot is empty, keep stepping backwards until something deletable
      if (last.items.length === 0) this.del();
      return;
    }
    // at the start of a slot
    const owner = slot.owner;
    if (!owner) return;
    const idx = owner.slots.indexOf(slot);
    if (idx > 0) {
      // move to the end of the previous slot
      const prev = owner.slots[idx - 1];
      this.cur = { slot: prev, i: prev.items.length };
      return;
    }
    // first slot: unwrap the template, keeping all slot contents in place
    const ps = owner.parent!;
    const at = ps.items.indexOf(owner);
    const contents: Node[] = [];
    for (const s of owner.slots) contents.push(...s.items);
    ps.items.splice(at, 1);
    contents.forEach((c, k) => attach(ps, c, at + k));
    this.cur = { slot: ps, i: at };
  }

  /** ◀ */
  left(): boolean {
    const { slot, i } = this.cur;
    if (i > 0) {
      const n = slot.items[i - 1];
      if (n.kind !== "ch") {
        const last = n.slots[n.slots.length - 1];
        this.cur = { slot: last, i: last.items.length };
      } else this.cur = { slot, i: i - 1 };
      return true;
    }
    const owner = slot.owner;
    if (!owner) {
      // wrap to the end, like the real calculator
      this.cur = { slot, i: slot.items.length };
      return false;
    }
    const idx = owner.slots.indexOf(slot);
    if (idx > 0) {
      const prev = owner.slots[idx - 1];
      this.cur = { slot: prev, i: prev.items.length };
    } else {
      const ps = owner.parent!;
      this.cur = { slot: ps, i: ps.items.indexOf(owner) };
    }
    return true;
  }

  /** ▶ */
  right(): boolean {
    const { slot, i } = this.cur;
    if (i < slot.items.length) {
      const n = slot.items[i];
      if (n.kind !== "ch") this.cur = { slot: n.slots[0], i: 0 };
      else this.cur = { slot, i: i + 1 };
      return true;
    }
    const owner = slot.owner;
    if (!owner) {
      this.cur = { slot, i: 0 };
      return false;
    }
    const idx = owner.slots.indexOf(slot);
    if (idx < owner.slots.length - 1) {
      this.cur = { slot: owner.slots[idx + 1], i: 0 };
    } else {
      const ps = owner.parent!;
      this.cur = { slot: ps, i: ps.items.indexOf(owner) + 1 };
    }
    return true;
  }

  /** ▲/▼ inside vertical templates (fraction numerator ⇄ denominator, limits). Returns false when nothing moved. */
  vertical(dir: -1 | 1): boolean {
    let slot: Slot | null = this.cur.slot;
    while (slot && slot.owner) {
      const o: Node = slot.owner;
      const idx = o.slots.indexOf(slot);
      const target = verticalTarget(o.kind as TplKind, idx, dir);
      if (target !== null) {
        const t = o.slots[target];
        this.cur = { slot: t, i: dir < 0 ? t.items.length : t.items.length };
        return true;
      }
      slot = o.parent;
    }
    return false;
  }

  toStart() {
    this.cur = { slot: this.root, i: 0 };
  }

  toEnd() {
    this.cur = { slot: this.root, i: this.root.items.length };
  }

  /** Move cursor to a node's position (used by Syntax ERROR → Goto). */
  goto(slot: Slot, i: number) {
    this.cur = { slot, i: Math.max(0, Math.min(i, slot.items.length)) };
  }

  /** The cursor is at the top level with nothing to its left. */
  atRootStart() {
    return this.cur.slot === this.root && this.cur.i === 0;
  }
}

function verticalTarget(kind: TplKind, idx: number, dir: -1 | 1): number | null {
  // dir -1 = up, 1 = down
  switch (kind) {
    case "frac":
      if (idx === 0 && dir > 0) return 1;
      if (idx === 1 && dir < 0) return 0;
      return null;
    case "mixed":
      if (idx === 1 && dir > 0) return 2;
      if (idx === 2 && dir < 0) return 1;
      return null;
    case "integ":
    case "sum":
      // slots: f, lower, upper
      if (idx === 1 && dir < 0) return 2;
      if (idx === 2 && dir > 0) return 1;
      return null;
    default:
      return null;
  }
}

/** Index where the "term" ending at `end` starts (for SHIFT INS wrapping). */
function termStart(items: Node[], end: number): number {
  let i = end;
  if (i === 0) return 0;
  const last = items[i - 1];
  if (last.kind === "ch" && last.v === ")") {
    // walk back to the matching "(" (or function opener)
    let depth = 0;
    while (i > 0) {
      const n = items[i - 1];
      if (n.kind === "ch") {
        if (n.v === ")") depth++;
        else if (n.v === "(" || n.v.endsWith("(")) depth--;
      }
      i--;
      if (depth === 0) break;
    }
    return i;
  }
  if (last.kind !== "ch") return i - 1;
  if (isDigitTok(last.v)) {
    while (i > 0 && items[i - 1].kind === "ch" && isDigitTok(items[i - 1].v)) i--;
    return i;
  }
  if (/^[A-FMXY]$|^π$|^e$|^Ans$/.test(last.v)) return i - 1;
  return end;
}

export function isTplEmpty(n: Node) {
  return n.kind !== "ch" && n.slots.every((s) => s.items.length === 0);
}

function cloneSlot(s: Slot, owner: Node | null, map?: Map<Slot, Slot>): Slot {
  const ns: Slot = { items: [], owner };
  map?.set(s, ns);
  for (const n of s.items) {
    const c = cloneNodeInner(n, map);
    c.parent = ns;
    ns.items.push(c);
  }
  return ns;
}

function cloneNodeInner(n: Node, map?: Map<Slot, Slot>): Node {
  const c: Node = { kind: n.kind, v: n.v, slots: [], parent: null };
  c.slots = n.slots.map((s) => cloneSlot(s, c, map));
  return c;
}

export function cloneNode(n: Node): Node {
  return cloneNodeInner(n);
}

export function cloneNodes(ns: Node[]): Node[] {
  return ns.map((n) => cloneNode(n));
}

/** Does any slot in the tree contain a given character token? */
export function containsTok(items: Node[], pred: (v: string) => boolean): boolean {
  for (const n of items) {
    if (n.kind === "ch" ? pred(n.v) : n.slots.some((s) => containsTok(s.items, pred))) return true;
  }
  return false;
}

/** Variables in order of first appearance (for CALC / SOLVE prompts). */
export function varsUsed(items: Node[], out: string[] = []): string[] {
  for (const n of items) {
    if (n.kind === "ch") {
      if (/^[A-FMXY]$/.test(n.v) && !out.includes(n.v)) out.push(n.v);
    } else {
      // ∫, d/dx and Σ bind X inside their body
      n.slots.forEach((s, i) => {
        if ((n.kind === "integ" || n.kind === "deriv" || n.kind === "sum") && i === 0) {
          const inner = varsUsed(s.items, []);
          for (const v of inner) if (v !== "X" && !out.includes(v)) out.push(v);
        } else varsUsed(s.items, out);
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Serialisation (history persistence)                                 */
/* ------------------------------------------------------------------ */

type Ser = string | unknown[];

export function serialize(items: Node[]): Ser[] {
  return items.map((n) => (n.kind === "ch" ? n.v : [n.kind, ...n.slots.map((s) => serialize(s.items))]));
}

export function deserialize(data: unknown): Node[] {
  if (!Array.isArray(data)) return [];
  const out: Node[] = [];
  for (const d of data) {
    if (typeof d === "string") out.push(ch(d));
    else if (Array.isArray(d) && typeof d[0] === "string" && d[0] in SLOT_COUNT) {
      const kind = d[0] as TplKind;
      out.push(tpl(kind, d.slice(1).map((s: unknown) => deserialize(s))));
    }
  }
  return out;
}

/** Plain linear text (for copy to clipboard / accessibility). */
export function toLinear(items: Node[]): string {
  let out = "";
  const sl = (n: Node, i: number) => toLinear(n.slots[i].items);
  for (const n of items) {
    switch (n.kind) {
      case "ch":
        out += n.v === "-" ? "−" : n.v === "neg" ? "−" : n.v === "°u" ? "°" : n.v;
        break;
      case "frac":
        out += `(${sl(n, 0)})/(${sl(n, 1)})`;
        break;
      case "mixed":
        out += `${sl(n, 0)}⌟${sl(n, 1)}⌟${sl(n, 2)}`;
        break;
      case "sqrt":
        out += `√(${sl(n, 0)})`;
        break;
      case "cbrt":
        out += `∛(${sl(n, 0)})`;
        break;
      case "root":
        out += `(${sl(n, 0)})√(${sl(n, 1)})`;
        break;
      case "pow":
        out += `^(${sl(n, 0)})`;
        break;
      case "logb":
        out += `log(${sl(n, 0)},${sl(n, 1)})`;
        break;
      case "pow10":
        out += `10^(${sl(n, 0)})`;
        break;
      case "powe":
        out += `e^(${sl(n, 0)})`;
        break;
      case "abs":
        out += `Abs(${sl(n, 0)})`;
        break;
      case "integ":
        out += `∫(${sl(n, 0)},${sl(n, 1)},${sl(n, 2)})`;
        break;
      case "deriv":
        out += `d/dx(${sl(n, 0)},${sl(n, 1)})`;
        break;
      case "sum":
        out += `Σ(${sl(n, 0)},${sl(n, 1)},${sl(n, 2)})`;
        break;
      case "e10":
        out += `×10^(${sl(n, 0)})`;
        break;
    }
  }
  return out;
}
