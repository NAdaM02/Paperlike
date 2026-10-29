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
 * caret's computed font/size/colour/highlight *before* execCommand and paint
 * those back onto the new span (minus the property being changed). Otherwise
 * changing the font family after a size change would drop the size, etc.
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

/** Snapshot styles at the selection so a later format pass doesn't wipe them. */
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

  const cs = getComputedStyle(el);
  const font = cs.fontFamily.split(",")[0].replace(/["']/g, "").trim();
  const sizePt = Math.round((parseFloat(cs.fontSize) * 72) / 96);
  const color = rgbToHex(cs.color) || undefined;

  let highlight: string | undefined;
  let hn: HTMLElement | null = el;
  const root = el.closest(".content");
  while (hn && hn !== root) {
    const bg = rgbToHex(getComputedStyle(hn).backgroundColor);
    if (bg) {
      highlight = bg;
      break;
    }
    hn = hn.parentElement;
  }

  return {
    font: font || undefined,
    sizePt: Number.isFinite(sizePt) ? sizePt : undefined,
    color,
    highlight,
  };
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
    for (const p of props) {
      d.style[p] = "";
      d.style.removeProperty(p.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`));
    }
  });
}

export function applyToSelection(styler: (span: HTMLSpanElement) => void): boolean {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return false;

  const host =
    (sel.anchorNode instanceof HTMLElement ? sel.anchorNode : sel.anchorNode?.parentElement)?.closest(
      ".content",
    ) ?? null;
  if (!host) return false;
  const already = new Set(host.querySelectorAll(`font[size="${MARKER_SIZE}"]`));

  document.execCommand("styleWithCSS", false, "false");
  document.execCommand("fontSize", false, MARKER_SIZE);

  // Only the markers this pass just created, and only inside the box being edited.
  // A document-wide query restyled font-size-7 text in other boxes and, on the
  // next commit, those boxes came back as the default font and size.
  const marked = Array.from(host.querySelectorAll(`font[size="${MARKER_SIZE}"]`)).filter(
    (node) => !already.has(node),
  );
  if (!marked.length) return false;

  const replacements: HTMLSpanElement[] = [];
  for (const f of marked) {
    const span = document.createElement("span");
    span.innerHTML = (f as HTMLElement).innerHTML;
    styler(span);
    f.replaceWith(span);
    replacements.push(span);
  }

  const range = document.createRange();
  range.setStartBefore(replacements[0]);
  range.setEndAfter(replacements[replacements.length - 1]);
  sel.removeAllRanges();
  sel.addRange(range);
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
    paintPreserved(span, preserved, { sizePt: true });
    span.style.fontSize = `${pt}pt`;
    clearNested(span, ["fontSize", "fontFamily", "color", "backgroundColor"]);
    span.querySelectorAll("font[size]").forEach((d) => d.removeAttribute("size"));
  });
}

export function setFontFamily(font: string): boolean {
  const preserved = captureSelectionStyles();
  return applyToSelectionOrCaret((span) => {
    paintPreserved(span, preserved, { font: true });
    span.style.fontFamily = font;
    clearNested(span, ["fontFamily", "fontSize", "color", "backgroundColor"]);
    span.querySelectorAll("font[face]").forEach((d) => d.removeAttribute("face"));
  });
}

export function setTextColor(color: string): boolean {
  const preserved = captureSelectionStyles();
  return applyToSelectionOrCaret((span) => {
    paintPreserved(span, preserved, { color: true });
    span.style.color = color;
    clearNested(span, ["color", "fontFamily", "fontSize", "backgroundColor"]);
    span.querySelectorAll("font[color]").forEach((d) => d.removeAttribute("color"));
  });
}

export function setHighlight(color: string | null): boolean {
  const preserved = captureSelectionStyles();
  return applyToSelectionOrCaret((span) => {
    paintPreserved(span, preserved, { highlight: true });
    span.querySelectorAll("mark").forEach((m) => {
      const s = document.createElement("span");
      s.innerHTML = m.innerHTML;
      m.replaceWith(s);
    });
    clearNested(span, ["backgroundColor", "fontFamily", "fontSize", "color"]);
    if (color) span.style.backgroundColor = color;
    else span.style.backgroundColor = "transparent";
  });
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
