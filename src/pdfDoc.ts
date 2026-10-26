import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import { PDFDocument } from "pdf-lib";
import { b64ToBytes } from "./ui";

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();

const docs = new Map<string, Promise<PDFDocumentProxy>>();

/**
 * JPEG 2000 / JBIG2 decoders. Vite serves `node_modules/pdfjs-dist/wasm` here
 * in dev and copies it to `dist/pdfjs/wasm` for the installed app.
 */
function wasmUrl(): string {
  return new URL("pdfjs/wasm/", document.baseURI).href;
}

function loadPdf(data: Uint8Array) {
  return pdfjs.getDocument({ data, wasmUrl: wasmUrl() });
}

/** One parsed document per media key. The bytes stay the source of truth. */
export function openPdf(media: string, b64: string): Promise<PDFDocumentProxy> {
  let pending = docs.get(media);
  if (!pending) {
    const data = b64ToBytes(b64);
    pending = loadPdf(data).promise.catch((err) => {
      docs.delete(media);
      throw err;
    });
    docs.set(media, pending);
  }
  return pending;
}

export async function pdfAspects(data: Uint8Array): Promise<number[]> {
  const task = loadPdf(data);
  const doc = await task.promise;
  try {
    return await pageAspects(doc);
  } finally {
    await task.destroy();
  }
}

/** Page height/width. A page that cannot be measured keeps the previous page's shape. */
async function pageAspects(doc: PDFDocumentProxy): Promise<number[]> {
  const aspects: number[] = [];
  const total = Math.max(0, doc.numPages);
  for (let i = 1; i <= total; i++) {
    try {
      const page = await doc.getPage(i);
      const view = page.getViewport({ scale: 1 });
      const aspect = view.height / Math.max(1, view.width);
      const prev = aspects.length ? aspects[aspects.length - 1] : 1.294;
      aspects.push(Number.isFinite(aspect) && aspect > 0.05 && aspect < 20 ? aspect : prev);
    } catch {
      aspects.push(aspects.length ? aspects[aspects.length - 1] : 1.294);
    }
  }
  if (!aspects.length) aspects.push(1.294);
  return aspects;
}

/** Aspects plus a JPEG of page 1, using the shared document cache so the note can paint it next. */
export async function pdfPlacement(
  media: string,
  b64: string,
  pageWidth: number,
): Promise<{ aspects: number[]; preview: string }> {
  const doc = await openPdf(media, b64);
  const aspects = await pageAspects(doc);
  let preview = "";
  try {
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const paint = Math.min(2, window.devicePixelRatio || 1);
    const viewport = page.getViewport({ scale: (pageWidth / Math.max(1, base.width)) * paint });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvas, viewport }).promise;
    preview = canvas.toDataURL("image/jpeg", 0.8);
  } catch {
    preview = "";
  }
  return { aspects, preview };
}

type TextRun = { str: string; x: number; y: number; h: number; w: number; angle: number };

function mul(m1: number[], m2: number[]): number[] {
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

/** Selectable text runs in viewport pixels. `angle` is degrees, 0 for horizontal text. */
export async function pageTextRuns(page: PDFPageProxy, viewport: pdfjs.PageViewport): Promise<TextRun[]> {
  const content = await page.getTextContent();
  const styles = content.styles as Record<string, { ascent?: number; descent?: number; vertical?: boolean }>;
  const runs: TextRun[] = [];
  const vs = Math.hypot(viewport.transform[0], viewport.transform[1]) || 1;
  for (const item of content.items) {
    if (!("str" in item) || !item.str) continue;
    const m = mul(viewport.transform, item.transform);
    let angle = Math.atan2(m[1], m[0]);
    const style = styles[item.fontName];
    if (style?.vertical) angle += Math.PI / 2;
    const h = Math.hypot(m[2], m[3]) || Math.hypot(m[0], m[1]) || 12;
    let ascent = 0.8;
    if (style?.ascent) ascent = style.ascent;
    else if (typeof style?.descent === "number") ascent = 1 + style.descent;
    const fontAscent = h * ascent;
    const x = Math.abs(angle) < 0.01 ? m[4] : m[4] + fontAscent * Math.sin(angle);
    const y = Math.abs(angle) < 0.01 ? m[5] - fontAscent : m[5] - fontAscent * Math.cos(angle);
    /* item.width is already in page units (font size included), so only the
       viewport scale applies; m[0], m[1] would scale by the font size again. */
    const w = vs * (item.width || item.str.length * 0.5 * Math.hypot(item.transform[0], item.transform[1]));
    const deg = (angle * 180) / Math.PI;
    runs.push({
      str: item.str,
      x,
      y,
      h,
      w: Math.max(w, h * 0.4),
      angle: Math.abs(deg) < 0.05 ? 0 : deg,
    });
  }
  return runs;
}

/**
 * Axis-aligned image boxes from a render that passed `recordImages`.
 * Coordinates are 0–1 of the painted canvas; `cssW` / `cssH` are the slot size.
 * This stays on the render pdf.js already did — it does not decode each image again.
 */
export function recordedImageBoxes(
  coords: ArrayLike<number> | null | undefined,
  cssW: number,
  cssH: number,
): { x: number; y: number; w: number; h: number }[] {
  if (!coords || coords.length < 6 || !(cssW > 0) || !(cssH > 0)) return [];
  const hits: { x: number; y: number; w: number; h: number }[] = [];
  for (let i = 0; i + 5 < coords.length; i += 6) {
    const xs = [coords[i], coords[i + 2], coords[i + 4]];
    const ys = [coords[i + 1], coords[i + 3], coords[i + 5]];
    const minX = Math.min(xs[0], xs[1], xs[2]);
    const maxX = Math.max(xs[0], xs[1], xs[2]);
    const minY = Math.min(ys[0], ys[1], ys[2]);
    const maxY = Math.max(ys[0], ys[1], ys[2]);
    const x = minX * cssW;
    const y = minY * cssH;
    const w = (maxX - minX) * cssW;
    const h = (maxY - minY) * cssH;
    if (w > 8 && h > 8 && w < cssW * 1.05 && h < cssH * 1.05) hits.push({ x, y, w, h });
  }
  return hits;
}

/** Copy the listed 1-based pages, from several files, into one new PDF. */
export async function mergePdfParts(
  parts: { bytes: Uint8Array; pages: number[] }[],
): Promise<{ bytes: Uint8Array; aspects: number[] }> {
  const out = await PDFDocument.create();
  const aspects: number[] = [];
  for (const part of parts) {
    const src = await PDFDocument.load(part.bytes);
    const count = src.getPageCount();
    const indexes = part.pages.map((p) => p - 1).filter((i) => i >= 0 && i < count);
    if (!indexes.length) continue;
    const copied = await out.copyPages(src, indexes);
    for (const page of copied) {
      out.addPage(page);
      const size = page.getSize();
      aspects.push(size.height / Math.max(1, size.width));
    }
  }
  if (!aspects.length) throw new Error("Those pages could not be joined.");
  return { bytes: await out.save(), aspects };
}
