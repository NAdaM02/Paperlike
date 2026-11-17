/**
 * Copy and paste of rich text inside text boxes.
 *
 * Left to the browser, copying from a text box put the *computed* style of every
 * piece on the clipboard, including the box's own card background, so pasting it
 * back painted a background behind text that never had one. Copying from a box now
 * puts just the box's own markup (only the styles someone set) on the clipboard,
 * and pasting HTML into a box keeps text formatting but drops backgrounds, layout
 * and other page styling that came from elsewhere.
 */

const MARK = "data-pl-clip";

/** Inline styles worth keeping from a paste; highlights only survive from our own boxes. */
const KEEP_STYLES = [
  "color",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "text-decoration-line",
  "vertical-align",
];
const DROP_TAGS = "script, style, meta, link, title, head, iframe, object, embed, svg, noscript, template";
const KEEP_ATTRS = new Set(["href", "src", "alt", "colspan", "rowspan", "color", "face"]);

function textBoxSelection(): { sel: Selection; content: HTMLElement } | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const node = sel.getRangeAt(0).commonAncestorContainer;
  const el = node instanceof HTMLElement ? node : node.parentElement;
  const content = el?.closest(".text-window .content") as HTMLElement | null;
  return content ? { sel, content } : null;
}

function onCopy(e: ClipboardEvent) {
  if (e.defaultPrevented || !e.clipboardData) return;
  const hit = textBoxSelection();
  if (!hit) return;
  const holder = document.createElement("div");
  holder.setAttribute(MARK, "1");
  holder.appendChild(hit.sel.getRangeAt(0).cloneContents());
  e.clipboardData.setData("text/html", holder.outerHTML);
  e.clipboardData.setData("text/plain", hit.sel.toString());
  e.preventDefault();
  if (e.type === "cut" && hit.content.isContentEditable) {
    document.execCommand("delete");
  }
}

/** Clipboard HTML → markup safe to drop into a text box. */
export function cleanPastedHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const body = doc.body;
  const ours = !!body.querySelector(`[${MARK}]`);
  body.querySelectorAll(DROP_TAGS).forEach((n) => n.remove());
  const walker = doc.createTreeWalker(body, NodeFilter.SHOW_COMMENT);
  const comments: Node[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) comments.push(n);
  comments.forEach((n) => n.parentNode?.removeChild(n));

  body.querySelectorAll<HTMLElement>("*").forEach((el) => {
    const keep: string[] = [];
    for (const p of KEEP_STYLES) {
      const v = el.style.getPropertyValue(p);
      if (v) keep.push(`${p}: ${v}`);
    }
    if (ours) {
      const bg = el.style.getPropertyValue("background-color");
      if (bg) keep.push(`background-color: ${bg}`);
    }
    for (const a of Array.from(el.attributes)) {
      const name = a.name.toLowerCase();
      if (name === "style") continue;
      // Our own boxes' classes and data (paragraph blocks, maths) still mean something here.
      if (ours && (name === "class" || name.startsWith("data-") || name === "contenteditable")) continue;
      if (!KEEP_ATTRS.has(name)) el.removeAttribute(a.name);
    }
    if (keep.length) el.setAttribute("style", keep.join("; "));
    else el.removeAttribute("style");
    if (el.tagName === "A" && /^\s*javascript:/i.test(el.getAttribute("href") ?? "")) el.removeAttribute("href");
  });

  const wrap = body.querySelector(`[${MARK}]`);
  return wrap ? wrap.innerHTML : body.innerHTML;
}

function onPaste(e: ClipboardEvent) {
  if (e.defaultPrevented || !e.clipboardData) return;
  const ae = document.activeElement as HTMLElement | null;
  if (!ae?.isContentEditable || !ae.closest(".text-window")) return;
  const html = e.clipboardData.getData("text/html");
  if (!html.trim()) return; // plain text: the browser's own paste is already clean
  const clean = cleanPastedHtml(html);
  if (!clean.trim()) return;
  e.preventDefault();
  document.execCommand("insertHTML", false, clean);
}

let installed = false;

/** One document-level listener for every text box (main canvas and folds alike). */
export function installTextClipboard() {
  if (installed) return;
  installed = true;
  document.addEventListener("copy", onCopy);
  document.addEventListener("cut", onCopy);
  document.addEventListener("paste", onPaste);
}
