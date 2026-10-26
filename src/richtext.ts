/**
 * Rich text serialization: note Blocks/Runs <-> contentEditable HTML.
 * This is what makes ribbon formatting (execCommand) actually persist
 * into the .note file instead of being flattened to plain text.
 */
import katex from "katex";
import { Block, Paragraph, Run, TableBlock } from "./api";

export const BULLET_GLYPHS: Record<string, string> = {
  disc: "•",
  circle: "◦",
  square: "▪",
  dash: "–",
  arrow: "➤",
};

export const FONTS = [
  "Segoe UI",
  "Calibri",
  "Times New Roman",
  "Georgia",
  "Cambria",
  "Garamond",
  "Arial",
  "Verdana",
  "Tahoma",
  "Trebuchet MS",
  "Consolas",
  "Courier New",
  "Comic Sans MS",
  "Impact",
];

export const FONT_SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48, 72];

export const DEFAULT_FONT = "Segoe UI";
export const DEFAULT_SIZE = 11;

function mathBody(tex: string): string {
  if (!tex.trim()) return `<span class="math-placeholder">ƒx</span>`;
  try {
    return katex.renderToString(tex, { throwOnError: false, output: "html" });
  } catch {
    return esc(tex);
  }
}

/** Render a LaTeX snippet into an inline, non-editable math chip. */
export function mathHtml(tex: string): string {
  const cls = tex.trim() ? "pl-math" : "pl-math empty";
  return `<span class="${cls}" contenteditable="false" data-tex="${esc(tex).replace(/"/g, "&quot;")}">${mathBody(tex)}</span>`;
}

/** Re-render an existing chip in place (used by the inline formula editor). */
export function renderMathInto(el: HTMLElement, tex: string) {
  el.dataset.tex = tex;
  el.classList.toggle("empty", !tex.trim());
  el.innerHTML = mathBody(tex);
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\u00a0/g, "&nbsp;");
}

export function runsToHtml(runs: Run[]): string {
  return runs
    .map((r) => {
      if (r.math) return mathHtml(r.text);
      if (!r.text) return "";
      let t = esc(r.text);
      let style = "";
      if (r.color) style += `color:${r.color};`;
      if (r.hl) style += `background-color:${r.hl};`;
      if (r.size) style += `font-size:${r.size}pt;`;
      if (r.font) style += `font-family:${r.font};`;
      if (style) t = `<span style="${style}">${t}</span>`;
      if (r.sub) t = `<sub>${t}</sub>`;
      if (r.sup) t = `<sup>${t}</sup>`;
      if (r.s) t = `<s>${t}</s>`;
      if (r.u) t = `<u>${t}</u>`;
      if (r.i) t = `<i>${t}</i>`;
      if (r.b) t = `<b>${t}</b>`;
      return t;
    })
    .join("");
}

function paragraphToHtml(p: Paragraph): string {
  const indent = p.indent ?? 0;
  const bullet = p.bullet ?? null;
  const glyph = bullet ? BULLET_GLYPHS[bullet] ?? "•" : null;
  const styleParts = [];
  if (indent) styleParts.push(`padding-left:${indent * 22}px`);
  if (p.align && p.align !== "left") styleParts.push(`text-align:${p.align}`);
  const attrs =
    `class="p" data-indent="${indent}"` +
    (bullet ? ` data-bullet="${bullet}" data-glyph="${glyph}"` : "") +
    (styleParts.length ? ` style="${styleParts.join(";")}"` : "");
  const inner = runsToHtml(p.runs);
  return `<div ${attrs}>${inner || "<br>"}</div>`;
}

function tableToHtml(t: TableBlock): string {
  const cols = t.col_widths
    .map((w) => `<col style="width:${Math.round(w)}px">`)
    .join("");
  const total = Math.round(t.col_widths.reduce((a, w) => a + (w || 120), 0));
  const rows = t.rows
    .map(
      (row) =>
        `<tr>${row.cells
          .map(
            (c) =>
              `<td contenteditable="true">${c.blocks.map(paragraphToHtml).join("") || '<div class="p"><br></div>'}</td>`,
          )
          .join("")}</tr>`,
    )
    .join("");
  return `<table class="plt" data-borders="${t.borders !== false}" contenteditable="false" style="width:${total}px"><colgroup>${cols}</colgroup><tbody>${rows}</tbody></table>`;
}

export function blocksToHtml(blocks: Block[]): string {
  if (!blocks.length) return `<div class="p"><br></div>`;
  return blocks
    .map((b) => {
      if ((b as TableBlock).kind === "table") return tableToHtml(b as TableBlock);
      return paragraphToHtml(b as Paragraph);
    })
    .join("");
}

/* ── HTML → Blocks ── */

function cssColorToHex(c: string): string | undefined {
  if (!c || c === "transparent") return undefined;
  if (c.startsWith("#")) return c;
  const m = c.match(/rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?/);
  if (!m) return undefined;
  if (m[4] !== undefined && parseFloat(m[4]) === 0) return undefined;
  const hex = (n: string) => Number(n).toString(16).padStart(2, "0");
  return `#${hex(m[1])}${hex(m[2])}${hex(m[3])}`;
}

function fontSizeToPt(v: string): number | undefined {
  if (!v) return undefined;
  if (v.endsWith("pt")) return Math.round(parseFloat(v) * 10) / 10;
  if (v.endsWith("px")) return Math.round(parseFloat(v) * (72 / 96) * 10) / 10;
  return undefined;
}

type StyleState = Omit<Run, "text">;

function collectRuns(node: Node, state: StyleState, out: Run[]) {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = (node.textContent ?? "").replace(/\u200b/g, "");
    if (text) out.push({ ...state, text });
    return;
  }
  if (!(node instanceof HTMLElement)) return;
  const tag = node.tagName.toLowerCase();
  if (tag === "br") return;
  if (node.classList.contains("pl-math")) {
    out.push({ ...state, math: true, text: node.dataset.tex ?? "" });
    return;
  }
  const next: StyleState = { ...state };
  if (tag === "b" || tag === "strong") next.b = true;
  if (tag === "i" || tag === "em") next.i = true;
  if (tag === "u") next.u = true;
  if (tag === "s" || tag === "strike" || tag === "del") next.s = true;
  if (tag === "sub") next.sub = true;
  if (tag === "sup") next.sup = true;
  if (tag === "mark") next.hl = next.hl ?? "#ffe066";
  if (tag === "font") {
    const c = node.getAttribute("color");
    if (c) next.color = c.startsWith("#") ? c : cssColorToHex(c) ?? c;
    const face = node.getAttribute("face");
    if (face) next.font = face.split(",")[0].replace(/["']/g, "").trim();
    const sizeAttr = node.getAttribute("size");
    if (sizeAttr && !next.size) {
      const map = [0, 8, 10, 12, 14, 18, 24, 36];
      const n = parseInt(sizeAttr, 10);
      if (n >= 1 && n <= 7) next.size = map[n];
    }
  }
  const st = node.style;
  if (st) {
    if (st.fontWeight === "bold" || parseInt(st.fontWeight) >= 600) next.b = true;
    if (st.fontStyle === "italic") next.i = true;
    if (st.textDecorationLine?.includes("underline")) next.u = true;
    if (st.textDecorationLine?.includes("line-through")) next.s = true;
    const c = cssColorToHex(st.color);
    if (c) next.color = c;
    const bg = cssColorToHex(st.backgroundColor);
    if (bg) next.hl = bg;
    const sz = fontSizeToPt(st.fontSize);
    if (sz) next.size = sz;
    if (st.fontFamily) next.font = st.fontFamily.split(",")[0].replace(/["']/g, "").trim();
  }
  node.childNodes.forEach((ch) => collectRuns(ch, next, out));
}

function mergeRuns(runs: Run[]): Run[] {
  const out: Run[] = [];
  for (const r of runs) {
    const prev = out[out.length - 1];
    if (
      prev &&
      !prev.math &&
      !r.math &&
      prev.b === r.b &&
      prev.i === r.i &&
      prev.u === r.u &&
      prev.s === r.s &&
      prev.sub === r.sub &&
      prev.sup === r.sup &&
      prev.font === r.font &&
      prev.size === r.size &&
      prev.color === r.color &&
      prev.hl === r.hl
    ) {
      prev.text += r.text;
    } else {
      out.push({ ...r });
    }
  }
  return out.length ? out : [{ text: "" }];
}

function parseParagraph(el: HTMLElement): Paragraph {
  const indent = Math.min(8, Math.max(0, parseInt(el.dataset.indent ?? "0") || 0));
  const bullet = el.dataset.bullet || null;
  const align = el.style.textAlign || "left";
  const runs: Run[] = [];
  el.childNodes.forEach((ch) => collectRuns(ch, {}, runs));
  return { kind: "p", indent: indent as number, bullet, align, runs: mergeRuns(runs) };
}

function parseTable(el: HTMLTableElement): TableBlock {
  const colWidths: number[] = [];
  el.querySelectorAll("colgroup col").forEach((c) => {
    const w = parseFloat((c as HTMLElement).style.width || "120");
    colWidths.push(isNaN(w) ? 120 : w);
  });
  const rows: TableBlock["rows"] = [];
  el.querySelectorAll("tr").forEach((tr) => {
    const cells: { blocks: Paragraph[] }[] = [];
    tr.querySelectorAll("td, th").forEach((td) => {
      const blocks: Paragraph[] = [];
      const divs = td.querySelectorAll(":scope > div, :scope > p");
      if (divs.length) {
        divs.forEach((d) => blocks.push(parseParagraph(d as HTMLElement)));
      } else {
        const runs: Run[] = [];
        td.childNodes.forEach((ch) => collectRuns(ch, {}, runs));
        blocks.push({ kind: "p", indent: 0, bullet: null, align: "left", runs: mergeRuns(runs) });
      }
      cells.push({ blocks });
    });
    if (cells.length) rows.push({ cells });
  });
  if (!colWidths.length && rows.length) {
    for (let i = 0; i < rows[0].cells.length; i++) colWidths.push(120);
  }
  return { kind: "table", col_widths: colWidths, rows, borders: el.dataset.borders !== "false" };
}

/** Turn a sequence of non-table children into a paragraph (may be empty). */
function paragraphFromNodes(
  nodes: Node[],
  indent = 0,
  bullet: string | null = null,
  align = "left",
): Paragraph | null {
  if (!nodes.length) return null;
  if (
    nodes.length === 1 &&
    nodes[0] instanceof HTMLElement &&
    (nodes[0].tagName === "DIV" || nodes[0].tagName === "P")
  ) {
    const p = parseParagraph(nodes[0] as HTMLElement);
    return {
      ...p,
      indent: (indent || p.indent || 0) as number,
      bullet: bullet ?? p.bullet,
      align: align || p.align || "left",
    };
  }
  const holder = document.createElement("div");
  nodes.forEach((n) => holder.appendChild(n.cloneNode(true)));
  const runs: Run[] = [];
  holder.childNodes.forEach((ch) => collectRuns(ch, {}, runs));
  return { kind: "p", indent, bullet, align, runs: mergeRuns(runs) };
}

function pushBlockElement(el: HTMLElement, blocks: Block[]) {
  if (el instanceof HTMLTableElement) {
    blocks.push(parseTable(el));
    return;
  }
  if (el.tagName !== "DIV" && el.tagName !== "P") {
    const p = paragraphFromNodes([el]);
    if (p) blocks.push(p);
    return;
  }

  // Tables nested inside a paragraph (common after insertHTML) must be hoisted.
  if (!el.querySelector("table")) {
    blocks.push(parseParagraph(el));
    return;
  }

  const indent = Math.min(8, Math.max(0, parseInt(el.dataset.indent ?? "0") || 0));
  const bullet = el.dataset.bullet || null;
  const align = el.style.textAlign || "left";
  let pending: Node[] = [];
  const flushPending = () => {
    // Ignore pure whitespace text nodes between hoisted tables.
    const meaningful = pending.filter(
      (n) =>
        n instanceof HTMLElement ||
        (n.nodeType === Node.TEXT_NODE && !!(n.textContent ?? "").trim()),
    );
    pending = [];
    if (!meaningful.length) return;
    const p = paragraphFromNodes(meaningful, indent, bullet, align);
    if (p) blocks.push(p);
  };
  el.childNodes.forEach((ch) => {
    if (ch instanceof HTMLTableElement) {
      flushPending();
      blocks.push(parseTable(ch));
      return;
    }
    if (ch instanceof HTMLElement && ch.querySelector("table")) {
      flushPending();
      pushBlockElement(ch, blocks);
      return;
    }
    pending.push(ch);
  });
  flushPending();
}

export function htmlToBlocks(root: HTMLElement): Block[] {
  const blocks: Block[] = [];
  let pendingInline: Run[] = [];
  const flushInline = () => {
    if (pendingInline.length) {
      blocks.push({
        kind: "p",
        indent: 0,
        bullet: null,
        align: "left",
        runs: mergeRuns(pendingInline),
      });
      pendingInline = [];
    }
  };
  root.childNodes.forEach((node) => {
    if (node instanceof HTMLTableElement) {
      flushInline();
      blocks.push(parseTable(node));
      return;
    }
    if (node instanceof HTMLElement && (node.tagName === "DIV" || node.tagName === "P")) {
      flushInline();
      pushBlockElement(node, blocks);
      return;
    }
    collectRuns(node, {}, pendingInline);
  });
  flushInline();
  if (!blocks.length) {
    blocks.push({ kind: "p", indent: 0, bullet: null, align: "left", runs: [{ text: "" }] });
  }
  return blocks;
}

export function blocksPlainText(blocks: Block[]): string {
  return blocks
    .map((b) => {
      if ((b as TableBlock).kind === "table") {
        const t = b as TableBlock;
        return t.rows
          .map((r) =>
            r.cells
              .map((c) => c.blocks.map((p) => p.runs.map((x) => x.text).join("")).join(" "))
              .join(" | "),
          )
          .join("\n");
      }
      return (b as Paragraph).runs.map((r) => r.text).join("");
    })
    .join("\n");
}

/* ── formatting state under the caret / selection ── */

export type FormatState = {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  sub: boolean;
  sup: boolean;
  font: string;
  size: number;
  color: string;
  highlight: string | null;
  bullet: string | null;
};

function rgbToHex(c: string): string {
  const m = c.match(/rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?/);
  if (!m) return c.startsWith("#") ? c : "";
  if (m[4] !== undefined && parseFloat(m[4]) === 0) return "";
  const hex = (n: string) => Math.round(Number(n)).toString(16).padStart(2, "0");
  return `#${hex(m[1])}${hex(m[2])}${hex(m[3])}`;
}

/**
 * Reads the live formatting at the caret. Uses the DOM rather than
 * queryCommandValue for font/size/color because browsers report those
 * inconsistently (and in px) once styles are nested.
 */
export function readFormatState(root: HTMLElement): FormatState | null {
  const sel = window.getSelection();
  if (!sel || !sel.anchorNode || !root.contains(sel.anchorNode)) return null;
  // After programmatic re-selection the anchor is often an *element* with a
  // child offset (e.g. the content div pointing at a styled span). Descend to
  // the actual text so computed styles reflect what the user sees — otherwise
  // font-size reads the container and +/− keeps bouncing between two values.
  let node: Node = sel.anchorNode;
  if (node.nodeType === Node.ELEMENT_NODE) {
    const host = node as HTMLElement;
    let child: Node | undefined =
      host.childNodes[Math.min(sel.anchorOffset, Math.max(0, host.childNodes.length - 1))];
    // when the range was set "before" a node, the interesting node is at the offset itself
    if (child) node = child;
    while (node.nodeType === Node.ELEMENT_NODE && node.firstChild) {
      node = node.firstChild;
    }
  }
  const el: HTMLElement | null =
    node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node.parentElement;
  if (!el || !root.contains(el)) return null;

  const cs = getComputedStyle(el);
  const sizePx = parseFloat(cs.fontSize) || 14.67;
  let bullet: string | null = null;
  let p: HTMLElement | null = el;
  while (p && p !== root) {
    if (p.classList.contains("p")) {
      bullet = p.dataset.bullet ?? null;
      break;
    }
    p = p.parentElement;
  }

  // walk up to find an explicit background, ignoring the window's own surface
  let highlight: string | null = null;
  let hn: HTMLElement | null = el;
  while (hn && hn !== root) {
    const bg = rgbToHex(getComputedStyle(hn).backgroundColor);
    if (bg) {
      highlight = bg;
      break;
    }
    hn = hn.parentElement;
  }

  const q = (cmd: string) => {
    try {
      return document.queryCommandState(cmd);
    } catch {
      return false;
    }
  };

  return {
    bold: q("bold") || parseInt(cs.fontWeight) >= 600,
    italic: q("italic") || cs.fontStyle === "italic",
    underline: q("underline"),
    strike: q("strikeThrough"),
    sub: q("subscript") || !!el.closest("sub"),
    sup: q("superscript") || !!el.closest("sup"),
    font: cs.fontFamily.split(",")[0].replace(/["']/g, "").trim() || DEFAULT_FONT,
    size: Math.round((sizePx * 72) / 96),
    color: rgbToHex(cs.color) || "#000000",
    highlight,
    bullet,
  };
}

/** Read formatting at the start of a text window (canvas-highlight, no caret). */
export function readFormatStateFromContent(content: HTMLElement): FormatState | null {
  const sel = window.getSelection();
  const prev = sel && sel.rangeCount > 0 ? sel.getRangeAt(0).cloneRange() : null;
  const range = document.createRange();
  const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      (n.textContent?.length ?? 0) > 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP,
  });
  const text = walker.nextNode();
  if (!text) {
    const cs = getComputedStyle(content);
    const sizePx = parseFloat(cs.fontSize) || 14.67;
    return {
      bold: false,
      italic: false,
      underline: false,
      strike: false,
      sub: false,
      sup: false,
      font: cs.fontFamily.split(",")[0].replace(/["']/g, "").trim() || DEFAULT_FONT,
      size: Math.round((sizePx * 72) / 96),
      color: rgbToHex(cs.color) || "#000000",
      highlight: null,
      bullet: null,
    };
  }
  range.setStart(text, 0);
  range.setEnd(text, 1);
  sel?.removeAllRanges();
  sel?.addRange(range);
  const state = readFormatState(content);
  if (prev) {
    sel?.removeAllRanges();
    sel?.addRange(prev);
  } else {
    sel?.removeAllRanges();
  }
  return state;
}
