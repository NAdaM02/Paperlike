/**
 * Renders the natural-textbook input tree (and results, which use the same
 * nodes) the way the ClassWiz LCD does: real fractions, radicals that grow
 * with their contents, ∫ / Σ / d/dx templates with limits, and dashed boxes
 * for empty slots.
 */
import { Fragment, type ReactNode } from "react";
import type { Cursor, Node, Slot } from "./model";
import { CONSTS, CONVS } from "./data";

interface Ctx {
  cur: Cursor | null;
  /** a slot or node to underline (error position) */
}

export function MathView({ items, cur = null }: { items: Node[] | Slot; cur?: Cursor | null }) {
  const slot: Slot = Array.isArray(items) ? { items, owner: null } : items;
  return <span className="m-row m-root">{renderSlot(slot, { cur }, true)}</span>;
}

const Caret = () => <span className="m-caret" aria-hidden="true" />;

function renderSlot(slot: Slot, ctx: Ctx, root = false): ReactNode {
  const here = ctx.cur && ctx.cur.slot === slot ? ctx.cur.i : -1;
  if (slot.items.length === 0) {
    if (root) return here === 0 ? <Caret /> : null;
    return <span className={`m-empty${here === 0 ? " has-caret" : ""}`}>{here === 0 && <Caret />}</span>;
  }
  const out: ReactNode[] = [];
  slot.items.forEach((n, i) => {
    if (here === i) out.push(<Caret key={`c${i}`} />);
    out.push(<Fragment key={i}>{renderNode(n, ctx)}</Fragment>);
  });
  if (here === slot.items.length) out.push(<Caret key="cEnd" />);
  return out;
}

function S({ n, i, ctx, cls = "" }: { n: Node; i: number; ctx: Ctx; cls?: string }) {
  return <span className={`m-row ${cls}`}>{renderSlot(n.slots[i], ctx)}</span>;
}

/** The radical sign as a stretchable vector path, so it scales with tall contents. */
function Radical({ index }: { index?: ReactNode }) {
  return (
    <span className="m-rad-sign">
      {index && <span className="m-rad-index">{index}</span>}
      <svg viewBox="0 0 10 20" preserveAspectRatio="none" aria-hidden="true">
        <path d="M0.6 11.6 L2.6 10.4 L5.4 18.8 L9.4 0.8 L10 0.8" vectorEffect="non-scaling-stroke" />
      </svg>
    </span>
  );
}

function Integral() {
  return (
    <svg className="m-int-sign" viewBox="0 0 10 24" aria-hidden="true">
      <path
        d="M8.6 2.6 C8.1 1.4 6.7 1.3 6.1 2.6 C5.5 4 5.2 8 5 12 C4.8 16 4.5 20 3.9 21.4 C3.3 22.7 1.9 22.6 1.4 21.4"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function renderNode(n: Node, ctx: Ctx): ReactNode {
  switch (n.kind) {
    case "ch":
      return tokNode(n.v);
    case "frac":
      return (
        <span className="m-frac">
          <S n={n} i={0} ctx={ctx} cls="m-num" />
          <S n={n} i={1} ctx={ctx} cls="m-den" />
        </span>
      );
    case "mixed":
      return (
        <span className="m-mixed">
          <S n={n} i={0} ctx={ctx} />
          <span className="m-frac">
            <S n={n} i={1} ctx={ctx} cls="m-num" />
            <S n={n} i={2} ctx={ctx} cls="m-den" />
          </span>
        </span>
      );
    case "sqrt":
    case "cbrt":
    case "root":
      return (
        <span className="m-rad">
          <Radical index={n.kind === "cbrt" ? "3" : n.kind === "root" ? <S n={n} i={0} ctx={ctx} /> : undefined} />
          <S n={n} i={n.kind === "root" ? 1 : 0} ctx={ctx} cls="m-rad-body" />
        </span>
      );
    case "pow":
      return <S n={n} i={0} ctx={ctx} cls="m-sup" />;
    case "pow10":
      return (
        <span className="m-pw">
          10
          <S n={n} i={0} ctx={ctx} cls="m-sup" />
        </span>
      );
    case "powe":
      return (
        <span className="m-pw">
          <i className="m-e">e</i>
          <S n={n} i={0} ctx={ctx} cls="m-sup" />
        </span>
      );
    case "e10":
      return (
        <span className="m-pw m-e10">
          ×10
          <S n={n} i={0} ctx={ctx} cls="m-sup" />
        </span>
      );
    case "logb":
      return (
        <span className="m-pw">
          log
          <S n={n} i={0} ctx={ctx} cls="m-sub" />
          <span className="m-paren">(</span>
          <S n={n} i={1} ctx={ctx} />
          <span className="m-paren">)</span>
        </span>
      );
    case "abs":
      return (
        <span className="m-abs">
          <S n={n} i={0} ctx={ctx} />
        </span>
      );
    case "integ":
      return (
        <span className="m-big">
          <Integral />
          <span className="m-lims">
            <S n={n} i={2} ctx={ctx} cls="m-lim" />
            <S n={n} i={1} ctx={ctx} cls="m-lim" />
          </span>
          <S n={n} i={0} ctx={ctx} />
          <span className="m-dx">
            d<i>x</i>
          </span>
        </span>
      );
    case "deriv":
      return (
        <span className="m-big">
          <span className="m-frac m-ddx">
            <span className="m-row m-num">d</span>
            <span className="m-row m-den">
              d<i>x</i>
            </span>
          </span>
          <span className="m-paren">(</span>
          <S n={n} i={0} ctx={ctx} />
          <span className="m-paren">)</span>
          <span className="m-at">
            <span className="m-at-bar" />
            <span className="m-row m-sub">
              <i>x</i>=<S n={n} i={1} ctx={ctx} />
            </span>
          </span>
        </span>
      );
    case "sum":
      return (
        <span className="m-big">
          <span className="m-sigma">
            <S n={n} i={2} ctx={ctx} cls="m-lim" />
            <span className="m-sigma-sign">Σ</span>
            <span className="m-row m-lim">
              <i>x</i>=<S n={n} i={1} ctx={ctx} />
            </span>
          </span>
          <span className="m-paren">(</span>
          <S n={n} i={0} ctx={ctx} />
          <span className="m-paren">)</span>
        </span>
      );
  }
}

const SUP: Record<string, string> = { "²": "2", "³": "3", "⁻¹": "−1", r: "r", g: "g" };

function tokNode(v: string): ReactNode {
  if (v in SUP) return <span className="m-sup m-row">{SUP[v]}</span>;
  if (v.startsWith("c:")) return <span className="m-const">{CONSTS[v.slice(2)]?.sym ?? "?"}</span>;
  if (v.startsWith("v:")) return <span className="m-conv">{CONVS[v.slice(2)]?.label ?? "?"}</span>;
  if (v.startsWith("k:")) return <span className="m-eng">{v.slice(2)}</span>;
  const inv = v.match(/^(sinh?|cosh?|tanh?)⁻¹\($/);
  if (inv)
    return (
      <span className="m-fn">
        {inv[1]}
        <span className="m-sup m-row">−1</span>(
      </span>
    );
  switch (v) {
    case "-":
      return <span className="m-op">−</span>;
    case "+":
    case "×":
    case "÷":
      return <span className="m-op">{v}</span>;
    case "=":
      return <span className="m-op">=</span>;
    case "neg":
      return <span className="m-neg">−</span>;
    case "X":
      return <i className="m-var">x</i>;
    case "Y":
      return <i className="m-var">y</i>;
    case "nPr":
      return <span className="m-comb">P</span>;
    case "nCr":
      return <span className="m-comb">C</span>;
    case "°u":
    case "°":
      return <span>°</span>;
    case "e":
      return <i className="m-e">e</i>;
    case ",":
      // decimal comma is in use, so arguments are separated with ";" (as on Casio)
      return <span className="m-comma">;</span>;
    case ".":
      return <span className="m-dec">,</span>;
  }
  if (/^[A-Za-z#]+\($/.test(v)) return <span className="m-fn">{v}</span>;
  if (/^[0-9.]+$/.test(v)) return <span>{v.replace(/\./g, ",")}</span>;
  return <span>{v}</span>;
}
