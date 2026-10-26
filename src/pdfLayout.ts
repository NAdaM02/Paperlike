import { PdfLayout, PdfObject } from "./api";

export type PdfSlot = {
  page: number;
  aspect: number;
  x: number;
  y: number;
  w: number;
  h: number;
};

/** Where each joined page sits inside the group's box. */
export function pdfSlots(obj: Pick<PdfObject, "pages" | "aspects" | "layout" | "pageWidth" | "gap">): PdfSlot[] {
  const { pages, layout, pageWidth, gap } = obj;
  const aspectOf = (i: number) => (obj.aspects[i] > 0 ? obj.aspects[i] : 1.294);
  const cells = pages.map((page, i) => {
    const aspect = aspectOf(i);
    if (layout === "stack") return { page, aspect, col: 0, row: i };
    if (layout === "row") return { page, aspect, col: i, row: 0 };
    if (layout === "pair-odd") return { page, aspect, col: i % 2, row: Math.floor(i / 2) };
    const idx = i + 1;
    return { page, aspect, col: idx % 2, row: Math.floor(idx / 2) };
  });
  const rowH = new Map<number, number>();
  for (const c of cells) rowH.set(c.row, Math.max(rowH.get(c.row) ?? 0, pageWidth * c.aspect));
  const rowY = new Map<number, number>();
  let y = 0;
  for (const row of [...rowH.keys()].sort((a, b) => a - b)) {
    rowY.set(row, y);
    y += (rowH.get(row) ?? 0) + gap;
  }
  return cells.map((c) => ({
    page: c.page,
    aspect: c.aspect,
    x: c.col * (pageWidth + gap),
    y: rowY.get(c.row) ?? 0,
    w: pageWidth,
    h: pageWidth * c.aspect,
  }));
}

export function pdfSize(obj: Pick<PdfObject, "pages" | "aspects" | "layout" | "pageWidth" | "gap">): {
  w: number;
  h: number;
} {
  const slots = pdfSlots(obj);
  if (!slots.length) return { w: obj.pageWidth, h: obj.pageWidth * 1.294 };
  let w = 0;
  let h = 0;
  for (const s of slots) {
    w = Math.max(w, s.x + s.w);
    h = Math.max(h, s.y + s.h);
  }
  return { w, h };
}

export const PDF_LAYOUTS: PdfLayout[] = ["stack", "row", "pair-odd", "pair-even"];

/**
 * Insertion index for a page being dragged, among the pages that stay behind.
 * Pointer coordinates are in the group's box. Stack compares Y to slot midpoints,
 * row compares X, and the pair layouts compare row then column.
 */
export function pdfInsertIndex(
  layout: PdfLayout,
  others: Pick<PdfObject, "pages" | "aspects" | "layout" | "pageWidth" | "gap">,
  px: number,
  py: number,
): number {
  const slots = pdfSlots({ ...others, layout });
  const before = (s: PdfSlot) => {
    const cy = s.y + s.h / 2;
    const cx = s.x + s.w / 2;
    if (layout === "row") return px < cx;
    if (layout === "stack") return py < cy;
    const rowTol = Math.max(8, s.h * 0.35);
    if (py < cy - rowTol) return true;
    if (py > cy + rowTol) return false;
    return px < cx;
  };
  for (let i = 0; i < slots.length; i++) {
    if (before(slots[i])) return i;
  }
  return slots.length;
}
