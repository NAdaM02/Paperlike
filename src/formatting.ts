/**
 * Applying inline formatting to the current selection.
 *
 * execCommand handles the simple toggles well, but it cannot express point
 * sizes, and browsers disagree about font/colour nesting. For those we use the
 * fontSize=7 trick: let the browser split the selection into <font size="7">
 * elements (which it does correctly, including across nested tags), then swap
 * those for spans carrying the style we actually want, and finally restore the
 * selection over the replacements.
 *
 * Important: the marker pass often flattens nested spans, so we snapshot the
 * font/size/colour/highlight set on the caret's spans *before* execCommand and
 * paint those back onto the new span (minus the property being changed).
 * Otherwise changing the font family after a size change would drop the size.
 * Only styles someone actually set are carried over: copying the computed
 * colour froze "default" text to black or white, so it stopped following the
 * theme, and baked the plain font and size into every span.
 */

const MARKER_SIZE = "7";

type Preserved = {
  font?: string;
  sizePt?: number;
  color?: string;
  highlight?: string;
};

function rgbToHex(c: string): string {
  const m = c.match(/rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?/);
  if (!m) return c.startsWith("#") ? c : "";
  if (m[4] !== undefined && parseFloat(m[4]) === 0) return "";
  const hex = (n: string) => Math.round(Number(n)).toString(16).padStart(2, "0");
  return `#${hex(m[1])}${hex(m[2])}${hex(m[3])}`;
}

/** Snapshot the styles set on the selection's spans so a format pass doesn't wipe them. */
function captureSelectionStyles(): Preserved {
  const sel = window.getSelection();
  if (!sel?.anchorNode) return {};
  let node: Node = sel.anchorNode;
  if (node.nodeType === Node.ELEMENT_NODE) {
    const host = node as HTMLElement;
    let child: Node | undefined =
      host.childNodes[Math.min(sel.anchorOffset, Math.max(0, host.childNodes.length - 1))];
    if (child) node = child;
    while (node.nodeType === Node.ELEMENT_NODE && node.firstChild) node = node.firstChild;
  }
  const el: HTMLElement | null =
    node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node.parentElement;
  if (!el) return {};

  // Walk up to (not including) the box itself; the box's own style is read on save.
  const root = el.closest(".content");
  let font: string | undefined;
  let sizePt: number | undefined;
  let color: string | undefined;
  let highlight: string | undefined;
  for (let n: HTMLElement | null = el; n && n !== root; n = n.parentElement) {
    const st = n.style;
    const isFont = n.tagName === "FONT";
    if (!font) {
      const f = st.fontFamily || (isFont ? n.getAttribute("face") ?? "" : "");
      font = f.split(",")[0].replace(/["']/g, "").trim() || undefined;
    }
    if (sizePt === undefined && st.fontSize) {
      const pt = Math.round((parseFloat(getComputedStyle(n).fontSize) * 72) / 96);
      if (Number.isFinite(pt)) sizePt = pt;
    }
    if (!color && (st.color || (isFont && n.hasAttribute("color")))) {
      color = rgbToHex(getComputedStyle(n).color) || undefined;
    }
    if (!highlight) highlight = rgbToHex(getComputedStyle(n).backgroundColor) || undefined;
  }

  return { font, sizePt, color, highlight };
}

function paintPreserved(
  span: HTMLSpanElement,
  preserved: Preserved,
  except: Partial<Record<keyof Preserved, boolean>>,
) {
  if (preserved.font && !except.font) span.style.fontFamily = preserved.font;
  if (preserved.sizePt && !except.sizePt) span.style.fontSize = `${preserved.sizePt}pt`;
  if (preserved.color && !except.color) span.style.color = preserved.color;
  if (preserved.highlight && !except.highlight) span.style.backgroundColor = preserved.highlight;
}

function clearNested(
  span: HTMLSpanElement,
  props: Array<"fontFamily" | "fontSize" | "color" | "backgroundColor">,
) {
  span.querySelectorAll<HTMLElement>("[style]").forEach((d) => {
    if (d.closest(".pl-math")) return;
    for (const p of props) {
      d.style[p] = "";
      d.style.removeProperty(p.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`));
    }
  });
}

function rangeIntersectsNode(range: Range, node: Node): boolean {
  if (!range.intersectsNode(node)) return false;
  const nodeRange = document.createRange();
  nodeRange.selectNode(node);
  return (
    range.compareBoundaryPoints(Range.START_TO_END, nodeRange) < 0 &&
    range.compareBoundaryPoints(Range.END_TO_START, nodeRange) > 0
  );
}

export function normalizeDecorations(root: HTMLElement) {
  const decors = root.querySelectorAll<HTMLElement>("u, s");
  decors.forEach((el) => {
    const hasColoredChild = Array.from(el.children).some(
      (c) => c instanceof HTMLElement && (c.style.color || c.getAttribute("color")),
    );
    if (!hasColoredChild) return;

    const tag = el.tagName.toLowerCase();
    const frag = document.createDocumentFragment();
    const children = Array.from(el.childNodes);
    for (const child of children) {
      if (child instanceof HTMLElement && child.classList.contains("pl-math")) {
        const inner = document.createElement(tag);
        inner.appendChild(child);
        if (child.style.color) {
          const outer = document.createElement("span");
          outer.style.color = child.style.color;
          outer.appendChild(inner);
          frag.appendChild(outer);
        } else {
          frag.appendChild(inner);
        }
      } else if (child instanceof HTMLElement && child.tagName === "SPAN" && child.style.color) {
        const inner = document.createElement(tag);
        while (child.firstChild) {
          inner.appendChild(child.firstChild);
        }
        child.appendChild(inner);
        frag.appendChild(child);
      } else {
        const wrap = document.createElement(tag);
        wrap.appendChild(child);
        frag.appendChild(wrap);
      }
    }
    el.replaceWith(frag);
  });
}

export function applyToSelection(styler: (span: HTMLSpanElement) => void): boolean {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return false;

  const host =
    ((sel.anchorNode instanceof HTMLElement ? sel.anchorNode : sel.anchorNode?.parentElement)?.closest(
      ".content",
    ) as HTMLElement | null) ?? null;
  if (!host) return false;

  const selRange = sel.getRangeAt(0);
  const mathNodes = Array.from(host.querySelectorAll<HTMLElement>(".pl-math")).filter((node) =>
    rangeIntersectsNode(selRange, node),
  );

  const already = new Set(host.querySelectorAll(`font[size="${MARKER_SIZE}"]`));

  document.execCommand("styleWithCSS", false, "false");
  document.execCommand("fontSize", false, MARKER_SIZE);

  // Only the markers this pass just created, and only inside the box being edited.
  // A document-wide query restyled font-size-7 text in other boxes and, on the
  // next commit, those boxes came back as the default font and size.
  const marked = Array.from(host.querySelectorAll(`font[size="${MARKER_SIZE}"]`)).filter(
    (node) => !already.has(node),
  );
  if (!marked.length && !mathNodes.length) return false;

  const replacements: HTMLSpanElement[] = [];
  for (const f of marked) {
    const span = document.createElement("span");
    span.innerHTML = (f as HTMLElement).innerHTML;
    styler(span);
    f.replaceWith(span);
    replacements.push(span);
  }

  for (const m of mathNodes) {
    if (m.isConnected) styler(m);
  }

  normalizeDecorations(host);

  const allAffected: HTMLElement[] = [...replacements, ...mathNodes].filter((el) => el.isConnected);
  if (allAffected.length > 0) {
    allAffected.sort((a, b) =>
      a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
    );
    const range = document.createRange();
    range.setStartBefore(allAffected[0]);
    range.setEndAfter(allAffected[allAffected.length - 1]);
    sel.removeAllRanges();
    sel.addRange(range);
  }
  return true;
}

/** Collapsed caret: style the insertion point so the next typed characters pick it up. */
function applyAtCaret(styler: (span: HTMLSpanElement) => void): boolean {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return false;
  const range = sel.getRangeAt(0);
  const span = document.createElement("span");
  styler(span);
  if (!span.childNodes.length) span.appendChild(document.createTextNode("\u200b"));
  range.insertNode(span);
  const r = document.createRange();
  const text = span.lastChild;
  if (text && text.nodeType === Node.TEXT_NODE) {
    r.setStart(text, text.textContent?.length ?? 0);
  } else {
    r.selectNodeContents(span);
    r.collapse(false);
  }
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
  return true;
}

/** Selection: restyle those characters. Caret: set typing style for what comes next. */
export function applyToSelectionOrCaret(styler: (span: HTMLSpanElement) => void): boolean {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return false;
  if (sel.isCollapsed) return applyAtCaret(styler);
  return applyToSelection(styler);
}

export function setFontSize(pt: number): boolean {
  const preserved = captureSelectionStyles();
  return applyToSelectionOrCaret((span) => {
    if (span.classList.contains("pl-math")) {
      span.style.fontSize = `${pt}pt`;
      return;
    }
    paintPreserved(span, preserved, { sizePt: true });
    span.style.fontSize = `${pt}pt`;
    clearNested(span, ["fontSize", "fontFamily", "color", "backgroundColor"]);
    span.querySelectorAll("font[size]").forEach((d) => d.removeAttribute("size"));
  });
}

export function setFontFamily(font: string): boolean {
  const preserved = captureSelectionStyles();
  return applyToSelectionOrCaret((span) => {
    if (span.classList.contains("pl-math")) {
      return;
    }
    paintPreserved(span, preserved, { font: true });
    span.style.fontFamily = font;
    clearNested(span, ["fontFamily", "fontSize", "color", "backgroundColor"]);
    span.querySelectorAll("font[face]").forEach((d) => d.removeAttribute("face"));
  });
}

/*
 * Colour and highlight are painted straight onto the selected text nodes rather
 * than through the fontSize=7 marker pass. That pass copied the font, size and
 * colour of the first selected character onto every piece of the selection and
 * cleared them from everything inside it, so recolouring mixed text (or a whole
 * box) flattened its sizes and fonts, and Chrome sometimes merged or dropped
 * spans so only part of the selection changed. Here each covered text node gets
 * the one property and nothing else is touched.
 */
type PaintProp = "color" | "backgroundColor";

function propOf(el: HTMLElement, prop: PaintProp): string {
  if (prop === "color" && el.tagName === "FONT" && el.getAttribute("color")) return el.getAttribute("color")!;
  if (prop === "backgroundColor" && el.tagName === "MARK") return "mark";
  return el.style[prop];
}

function clearProp(el: HTMLElement, prop: PaintProp) {
  el.style[prop] = "";
  if (prop === "color" && el.tagName === "FONT") el.removeAttribute("color");
  if (el.getAttribute("style") === "") el.removeAttribute("style");
}

/** Split the range's edge text nodes, then return the text nodes it covers whole. */
function coveredTextNodes(range: Range, host: HTMLElement): Text[] {
  let sc = range.startContainer;
  let so = range.startOffset;
  let ec = range.endContainer;
  let eo = range.endOffset;
  if (ec.nodeType === Node.TEXT_NODE && eo > 0 && eo < (ec as Text).length) (ec as Text).splitText(eo);
  if (sc.nodeType === Node.TEXT_NODE && so > 0 && so < (sc as Text).length) {
    const rest = (sc as Text).splitText(so);
    if (ec === sc) {
      ec = rest;
      eo -= so;
    }
    sc = rest;
    so = 0;
  }
  const r = document.createRange();
  r.setStart(sc, so);
  r.setEnd(ec, eo);
  const out: Text[] = [];
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    if (!n.length || n.parentElement?.closest(".pl-math")) continue;
    // Formatting whitespace between paragraphs is not text anyone selected.
    if (n.parentElement === host && !n.data.trim()) continue;
    if (r.comparePoint(n, 0) >= 0 && r.comparePoint(n, n.length) <= 0) out.push(n);
  }
  return out;
}

function paintSelection(prop: PaintProp, value: string | null, fallback: string): boolean {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return false;
  if (sel.isCollapsed) {
    // Caret: the next typed characters take the colour (theme ink / no highlight for "none").
    return applyAtCaret((span) => {
      span.style[prop] = value ?? fallback;
    });
  }
  const range = sel.getRangeAt(0);
  const anchor = range.commonAncestorContainer;
  const host = (anchor instanceof HTMLElement ? anchor : anchor.parentElement)?.closest(
    ".content",
  ) as HTMLElement | null;
  if (!host) return false;

  const mathNodes = Array.from(host.querySelectorAll<HTMLElement>(".pl-math")).filter((m) =>
    rangeIntersectsNode(range, m),
  );
  const texts = coveredTextNodes(range, host);
  if (!texts.length && !mathNodes.length) return false;
  const covered = new Set<Node>(texts);
  const allText = (el: HTMLElement) => {
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode() as Text | null; n; n = w.nextNode() as Text | null) {
      if (n.length && !n.parentElement?.closest(".pl-math") && !covered.has(n)) {
        if (!(n.parentElement === host && !n.data.trim())) return false;
      }
    }
    return true;
  };

  // Elements whose text is all selected drop their own colour, so it doesn't pile up.
  const seen = new Set<HTMLElement>();
  for (const t of texts) {
    for (let a = t.parentElement; a && a !== host; a = a.parentElement) {
      if (seen.has(a)) continue;
      seen.add(a);
      if (!propOf(a, prop) || !allText(a)) continue;
      if (a.tagName === "MARK") {
        const s = document.createElement("span");
        while (a.firstChild) s.appendChild(a.firstChild);
        a.replaceWith(s);
      } else {
        clearProp(a, prop);
      }
    }
  }
  const wholeBox = allText(host);
  if (prop === "color" && wholeBox) {
    // New text typed into the box keeps the colour too.
    if (value) host.style.color = value;
    else clearProp(host, prop);
  }

  for (const t of texts) {
    const p = t.parentElement!;
    let target: HTMLElement;
    if (p !== host && p.tagName === "SPAN" && p.childNodes.length === 1) {
      target = p;
    } else {
      target = document.createElement("span");
      t.replaceWith(target);
      target.appendChild(t);
    }
    if (value) {
      target.style[prop] = value;
      continue;
    }
    clearProp(target, prop);
    // A partly selected parent still colours this text; override it explicitly.
    let inherited = false;
    for (let a = target.parentElement; a && !inherited; a = a.parentElement) {
      inherited = !!propOf(a, prop);
      if (a === host) break;
    }
    if (inherited) target.style[prop] = fallback;
    else if (!target.attributes.length) target.replaceWith(t);
  }

  for (const m of mathNodes) {
    if (!m.isConnected) continue;
    if (value) m.style[prop] = value;
    else if (prop === "color") m.style.color = "";
    else m.style.backgroundColor = "transparent";
  }

  normalizeDecorations(host);
  const first = texts[0] ?? mathNodes[0];
  const last = texts[texts.length - 1] ?? mathNodes[mathNodes.length - 1];
  if (first?.isConnected && last?.isConnected) {
    const r = document.createRange();
    r.setStartBefore(first);
    r.setEndAfter(last);
    if (first.nodeType === Node.TEXT_NODE) r.setStart(first, 0);
    if (last.nodeType === Node.TEXT_NODE) r.setEnd(last, (last as Text).length);
    sel.removeAllRanges();
    sel.addRange(r);
  }
  return true;
}

/** `null` = back to the default ink; `ink` is the theme colour used where a parent would keep its colour. */
export function setTextColor(color: string | null, ink: string): boolean {
  return paintSelection("color", color, ink);
}

export function setHighlight(color: string | null): boolean {
  return paintSelection("backgroundColor", color, "transparent");
}

/** Snapshot/restore so clicking a ribbon control doesn't lose the selection. */
export type SavedSelection = { range: Range; content: HTMLElement };

export function saveSelection(): SavedSelection | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  const node =
    range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? (range.commonAncestorContainer as HTMLElement)
      : range.commonAncestorContainer.parentElement;
  const content = node?.closest(".content") as HTMLElement | null;
  if (!content) return null;
  return { range: range.cloneRange(), content };
}

export function restoreSelection(saved: SavedSelection | null): boolean {
  if (!saved || !saved.content.isConnected) return false;
  try {
    saved.content.focus({ preventScroll: true });
    const sel = window.getSelection();
    if (!sel) return false;
    sel.removeAllRanges();
    sel.addRange(saved.range.cloneRange());
    return sel.rangeCount > 0;
  } catch {
    return false;
  }
}

/** Select all editable content inside a text window (for canvas-highlight formatting). */
export function selectAllInContent(content: HTMLElement): void {
  const range = document.createRange();
  range.selectNodeContents(content);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

function returnFocusToCanvas(content: HTMLElement) {
  window.getSelection()?.removeAllRanges();
  content.blur();
  (document.querySelector(".canvas-wrap") as HTMLElement | null)?.focus({ preventScroll: true });
}

/** Apply formatting to all content briefly, then return focus to the canvas. */
export function applyToAllContent(content: HTMLElement, fn: () => boolean | void): boolean {
  const win = content.closest(".text-window") as HTMLElement | null;
  win?.classList.add("keep-highlight");
  selectAllInContent(content);
  content.focus({ preventScroll: true });
  const ok = fn();
  normalizeDecorations(content);
  returnFocusToCanvas(content);
  requestAnimationFrame(() => {
    if (document.activeElement === content || content.contains(document.activeElement)) {
      returnFocusToCanvas(content);
    }
    win?.classList.remove("keep-highlight");
  });
  return ok !== false;
}

export function insertHtmlAtSelection(html: string) {
  document.execCommand("insertHTML", false, html);
}

/**
 * Insert block-level HTML (e.g. a table) as a sibling of the current paragraph,
 * not inside it. execCommand("insertHTML") often nests tables in the caret's
 * <div class="p">, and those get dropped on the next html→blocks commit.
 */
export function insertBlockHtmlAtSelection(html: string): HTMLElement | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  const node =
    range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? (range.commonAncestorContainer as HTMLElement)
      : range.commonAncestorContainer.parentElement;
  const content = node?.closest(".content") as HTMLElement | null;
  if (!content) {
    insertHtmlAtSelection(html);
    return null;
  }

  let block: HTMLElement | null = node;
  while (block && block.parentElement !== content) {
    block = block.parentElement;
  }

  const wrap = document.createElement("div");
  wrap.innerHTML = html;
  const nodes = [...wrap.childNodes];
  if (!nodes.length) return null;

  const frag = document.createDocumentFragment();
  nodes.forEach((n) => frag.appendChild(n));
  const first = frag.firstChild as HTMLElement | null;

  if (block && block.parentElement === content) {
    const vacant =
      block.classList.contains("p") &&
      !(block.textContent ?? "").trim() &&
      !block.querySelector("img, .pl-math, table");
    if (vacant) {
      content.insertBefore(frag, block);
      block.remove();
    } else {
      block.after(frag);
    }
  } else {
    content.appendChild(frag);
  }

  return first;
}
