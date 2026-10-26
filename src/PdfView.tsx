import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { PdfLayout, PdfMask, PdfObject } from "./api";
import { IcPdfEven, IcPdfOdd, IcPdfRow, IcPdfStack } from "./icons";
import { openPdf, pageTextRuns, recordedImageBoxes } from "./pdfDoc";
import { PDF_LAYOUTS, pdfInsertIndex, pdfSlots, PdfSlot } from "./pdfLayout";
import { detectPageNumberMasks } from "./pdfNumbers";
import { ContextMenu, MenuItem } from "./ui";

const LAYOUT_ICON = {
  stack: IcPdfStack,
  row: IcPdfRow,
  "pair-odd": IcPdfOdd,
  "pair-even": IcPdfEven,
} as const;

const LAYOUT_TITLE: Record<PdfLayout, string> = {
  stack: "Top to bottom",
  row: "Side by side",
  "pair-odd": "Two by two, odd pages on the left",
  "pair-even": "Two by two, even pages on the left",
};

type PickedImage = { key: string; canvas: HTMLCanvasElement };
type Run = { str: string; x: number; y: number; h: number; w: number; angle?: number };
type ImgHit = { x: number; y: number; w: number; h: number };

/**
 * `cssScale` is the unzoomed slot (canvas CSS px / PDF unit). The world is then
 * CSS-scaled by `zoom`, so paint at zoom × devicePixelRatio is 1:1 with the screen.
 * One page bitmap stays under 12MP and 8192px — not a higher multiple than that.
 */
function paintScale(pageW: number, pageH: number, cssScale: number, zoom: number): number {
  const dpr = window.devicePixelRatio || 1;
  let paint = (zoom > 0 ? zoom : 1) * dpr;
  const px = pageW * cssScale * paint * pageH * cssScale * paint;
  const maxPx = 12_000_000;
  if (px > maxPx) paint *= Math.sqrt(maxPx / px);
  const side = Math.max(pageW, pageH) * cssScale * paint;
  if (side > 8192) paint *= 8192 / side;
  return Math.max(0.35, paint);
}

/** Copy a slot-relative image out of the page bitmap already on screen. */
function cropPageImage(
  src: HTMLCanvasElement,
  slotW: number,
  slotH: number,
  img: ImgHit,
): HTMLCanvasElement | null {
  if (!(slotW > 0) || !(slotH > 0) || !src.width || !src.height) return null;
  const sx = (img.x / slotW) * src.width;
  const sy = (img.y / slotH) * src.height;
  const sw = (img.w / slotW) * src.width;
  const sh = (img.h / slotH) * src.height;
  if (!(sw > 2) || !(sh > 2)) return null;
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(sw));
  out.height = Math.max(1, Math.round(sh));
  const ctx = out.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, out.width, out.height);
  return out;
}

export type PdfCanvasView = { x: number; y: number; w: number; h: number };

type Preview = {
  order: number[];
  ghostX: number;
  ghostY: number;
  basisPages: number[];
  basisAspects: number[];
  dragIndex: number;
};

type Gesture = {
  pointerId: number;
  dragIndex: number;
  grabX: number;
  grabY: number;
  startX: number;
  startY: number;
  active: boolean;
  basisPages: number[];
  basisAspects: number[];
  order: number[];
  layout: PdfLayout;
  pageWidth: number;
  gap: number;
};

/** Pages whose slot meets the canvas viewport, plus one page of vertical padding. */
function visibleSlotIndexes(obj: PdfObject, slots: PdfSlot[], view: PdfCanvasView | undefined): number[] {
  if (!slots.length) return [];
  if (!view) return slots.map((_, i) => i);
  if (!(view.w > 0) || !(view.h > 0)) return [0];
  const pad = slots.reduce((m, s) => Math.max(m, s.h), 0);
  const hit: number[] = [];
  slots.forEach((s, i) => {
    const x = obj.x + s.x;
    const y = obj.y + s.y;
    const overlaps =
      x < view.x + view.w && x + s.w > view.x && y < view.y + view.h + pad && y + s.h > view.y - pad;
    if (overlaps) hit.push(i);
  });
  return hit;
}

function sampleMaskColor(canvas: HTMLCanvasElement | null, m: { x: number; y: number; w: number; h: number }): string {
  if (!canvas?.width || !canvas.height) return "#ffffff";
  let ctx: CanvasRenderingContext2D | null = null;
  try {
    ctx = canvas.getContext("2d");
  } catch {
    return "#ffffff";
  }
  if (!ctx) return "#ffffff";
  const pix = (fx: number, fy: number): [number, number, number] | null => {
    const x = Math.min(canvas.width - 1, Math.max(0, Math.round(fx * canvas.width)));
    const y = Math.min(canvas.height - 1, Math.max(0, Math.round(fy * canvas.height)));
    try {
      const d = ctx.getImageData(x, y, 1, 1).data;
      if (d[3] < 16) return null;
      return [d[0], d[1], d[2]];
    } catch {
      return null;
    }
  };
  const nudge = 3 / Math.max(canvas.width, canvas.height);
  const pts: [number, number][] = [
    [m.x - nudge, m.y + m.h / 2],
    [m.x + m.w + nudge, m.y + m.h / 2],
    [m.x + m.w / 2, m.y - nudge],
    [m.x + m.w / 2, m.y + m.h + nudge],
  ];
  const samples = pts
    .filter(([x, y]) => x >= 0 && y >= 0 && x <= 1 && y <= 1)
    .map(([x, y]) => pix(x, y))
    .filter((s): s is [number, number, number] => !!s);
  if (!samples.length) return "#ffffff";
  const n = samples.length;
  const hex = (v: number) => Math.round(v).toString(16).padStart(2, "0");
  const r = samples.reduce((s, p) => s + p[0], 0) / n;
  const g = samples.reduce((s, p) => s + p[1], 0) / n;
  const b = samples.reduce((s, p) => s + p[2], 0) / n;
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/**
 * One joined PDF. Pages are painted from the original file at the current size,
 * so a resize stays sharp. Text can be selected; a decoded image can be copied.
 * On the live canvas, only pages near the viewport stay mounted.
 */
export function PdfView({
  obj,
  b64,
  active,
  chosen,
  zoom,
  view,
  onChoose,
  onLayout,
  onDrop,
  onSeparate,
  onCopy,
  onCut,
  onPaste,
  onFront,
  onBack,
  onDelete,
  onJoin,
  onMove,
  onResize,
  editable = true,
  shiftHeld,
  onToggleLock,
  onReorder,
  onDropPage,
  onMasks,
}: {
  obj: PdfObject;
  b64: string;
  /** The joined object is the canvas selection. */
  active: boolean;
  chosen: number[];
  zoom: number;
  /** Canvas-space viewport. Pages outside it stay unmounted. */
  view?: PdfCanvasView;
  onChoose: (pages: number[], additive: boolean, keepOthers?: boolean) => void;
  onLayout: (layout: PdfLayout) => void;
  onDrop: (pages: number[]) => void;
  onSeparate: () => void;
  onCopy?: () => void;
  onCut?: () => void;
  onPaste?: () => void;
  onFront?: () => void;
  onBack?: () => void;
  onDelete?: () => void;
  onJoin?: () => void;
  onMove: (e: React.PointerEvent) => void;
  onResize: (e: React.PointerEvent) => void;
  /** False after the license ends: pages stay readable, nothing can be changed. */
  editable?: boolean;
  /** Shift is down: images become pickable and locked objects react again. */
  shiftHeld: boolean;
  onToggleLock: () => void;
  onReorder?: (pages: number[], aspects: number[]) => void;
  /** Shift-drag released outside the object: drop this one page, keeping `pages` order. */
  onDropPage?: (page: number, pages: number[], aspects: number[]) => void;
  onMasks?: (masks: PdfMask[] | undefined, hideNumbers?: boolean) => void;
}) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const shown: PdfObject = preview
    ? {
        ...obj,
        pages: preview.order.map((i) => preview.basisPages[i]),
        aspects: preview.order.map((i) => preview.basisAspects[i] ?? 1.294),
      }
    : obj;
  const slots = pdfSlots(shown);
  const visible = visibleSlotIndexes(obj, slots, view);
  const visibleSet = new Set(visible);
  const mountKey = visible.map((i) => slots[i]?.page ?? "").join(",");
  const [runs, setRuns] = useState<Record<number, Run[]>>({});
  const [images, setImages] = useState<Record<number, ImgHit[]>>({});
  const [picked, setPicked] = useState<PickedImage | null>(null);
  const [failed, setFailed] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; pages: number[] } | null>(null);
  // Once the menu is open, releasing Shift must not freeze the page or dismiss Unlock.
  const inert = !!obj.locked && !shiftHeld && !menu;
  const canvasRefs = useRef<Record<number, HTMLCanvasElement | null>>({});
  const objRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const gesture = useRef<Gesture | null>(null);
  const listenRef = useRef<(() => void) | null>(null);
  const onReorderRef = useRef(onReorder);
  onReorderRef.current = onReorder;
  const onDropPageRef = useRef(onDropPage);
  onDropPageRef.current = onDropPage;

  useEffect(() => () => listenRef.current?.(), []);

  useEffect(() => {
    let cancel = false;
    const tasks: { cancel: () => void }[] = [];
    setFailed(false);
    const wanted = visible.map((i) => slots[i]).filter((s): s is PdfSlot => !!s);
    (async () => {
      if (obj.pending) return;
      if (!b64) {
        setFailed(true);
        return;
      }
      try {
        const doc = await openPdf(obj.media, b64);
        for (const slot of wanted) {
          if (cancel) return;
          try {
            const page = await doc.getPage(slot.page);
            const base = page.getViewport({ scale: 1 });
            const cssScale = slot.w / Math.max(1, base.width);
            const cssView = page.getViewport({ scale: cssScale });
            const paint = paintScale(base.width, base.height, cssScale, zoom);
            const viewPort = page.getViewport({ scale: cssScale * paint });
            // Paint offscreen, then copy onto the live canvas. Resizing the live
            // canvas first would blank the page for the whole (slow) render, and
            // walking every embedded image here used to decode the file a second
            // time — that is what made image-heavy pages come out blank or torn.
            const off = document.createElement("canvas");
            off.width = Math.max(1, Math.ceil(viewPort.width));
            off.height = Math.max(1, Math.ceil(viewPort.height));
            const task = page.render({ canvas: off, viewport: viewPort, recordImages: true });
            tasks.push(task);
            await task.promise;
            if (cancel) return;
            const live = canvasRefs.current[slot.page];
            if (live) {
              live.width = off.width;
              live.height = off.height;
              live.getContext("2d")?.drawImage(off, 0, 0);
              live.classList.add("ready");
            }
            const coords = page.imageCoordinates;
            const hits = recordedImageBoxes(coords, slot.w, slot.h);
            let runs: Run[] = [];
            try {
              runs = await pageTextRuns(page, cssView);
            } catch (e) {
              console.warn(`Failed to read text on PDF page ${slot.page}:`, e);
            }
            if (cancel) return;
            setRuns((prev) => ({ ...prev, [slot.page]: runs }));
            setImages((prev) => ({ ...prev, [slot.page]: hits }));
          } catch (e) {
            if (cancel) return;
            console.warn(`Failed to render PDF page ${slot.page}:`, e);
          }
        }
      } catch {
        if (!cancel) setFailed(true);
      }
    })();
    return () => {
      cancel = true;
      for (const task of tasks) task.cancel();
    };
    // slots identity changes every render; key the work on the layout inputs and which pages are mounted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [obj.media, obj.pending, b64, obj.pageWidth, obj.layout, obj.gap, obj.pages.join(","), mountKey, zoom]);

  useEffect(() => {
    if (!picked) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "c") return;
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) return;
      e.preventDefault();
      picked.canvas.toBlob(async (blob) => {
        if (!blob) return;
        try {
          await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        } catch {
          /* the webview may refuse the clipboard */
        }
      }, "image/png");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [picked]);

  useEffect(() => {
    if (!picked) return;
    const onDown = (e: PointerEvent) => {
      const node = e.target as Node | null;
      const el = node instanceof Element ? node : node?.parentElement;
      if (el?.closest(".pdf-img")) return;
      setPicked(null);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [picked]);

  const width = Math.max(...slots.map((s) => s.x + s.w), obj.pageWidth);
  const height = Math.max(...slots.map((s) => s.y + s.h), 40);

  useEffect(() => {
    if (!menu) return;
    // Capture pointerdown: a canvas click cancels the later mouse event, so a
    // bubble-phase mousedown listener never hears "click away".
    // Shift keyup must not close this — Unlock is chosen after the right-click.
    const close = (e: PointerEvent) => {
      const t = e.target;
      if (t instanceof Element && t.closest(".menu")) return;
      if (e.button === 2 && t instanceof Element && t.closest(".pdf-page")) return;
      setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const startReorder = (e: React.PointerEvent, index: number) => {
    if (gesture.current || obj.pages.length < 2) return;
    const pageEl = e.currentTarget as HTMLElement;
    const host = objRef.current;
    if (!host) return;
    const z = zoomRef.current || 1;
    const pageBox = pageEl.getBoundingClientRect();
    const g: Gesture = {
      pointerId: e.pointerId,
      dragIndex: index,
      grabX: (e.clientX - pageBox.left) / z,
      grabY: (e.clientY - pageBox.top) / z,
      startX: e.clientX,
      startY: e.clientY,
      active: false,
      basisPages: obj.pages.slice(),
      basisAspects: obj.aspects.slice(),
      order: obj.pages.map((_, i) => i),
      layout: obj.layout,
      pageWidth: obj.pageWidth,
      gap: obj.gap,
    };
    gesture.current = g;
    const onMove = (ev: PointerEvent) => {
      const cur = gesture.current;
      if (!cur || ev.pointerId !== cur.pointerId) return;
      if (!cur.active && Math.hypot(ev.clientX - cur.startX, ev.clientY - cur.startY) < 4) return;
      const box = objRef.current?.getBoundingClientRect();
      if (!box) return;
      const zz = zoomRef.current || 1;
      const px = (ev.clientX - box.left) / zz;
      const py = (ev.clientY - box.top) / zz;
      cur.active = true;
      const others = cur.basisPages.map((_, i) => i).filter((i) => i !== cur.dragIndex);
      const insert = pdfInsertIndex(
        cur.layout,
        {
          pages: others.map((i) => cur.basisPages[i]),
          aspects: others.map((i) => cur.basisAspects[i] ?? 1.294),
          layout: cur.layout,
          pageWidth: cur.pageWidth,
          gap: cur.gap,
        },
        px,
        py,
      );
      const order = others.slice();
      order.splice(insert, 0, cur.dragIndex);
      cur.order = order;
      setPreview({
        order,
        ghostX: px - cur.grabX,
        ghostY: py - cur.grabY,
        basisPages: cur.basisPages,
        basisAspects: cur.basisAspects,
        dragIndex: cur.dragIndex,
      });
    };
    const finish = (ev: PointerEvent) => {
      if (gesture.current && ev.pointerId !== gesture.current.pointerId) return;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      listenRef.current = null;
      const cur = gesture.current;
      gesture.current = null;
      setPreview(null);
      if (!cur?.active || ev.type === "pointercancel") return;
      const box = objRef.current?.getBoundingClientRect();
      const inside =
        !!box && ev.clientX >= box.left && ev.clientX <= box.right && ev.clientY >= box.top && ev.clientY <= box.bottom;
      const pages = cur.order.map((i) => cur.basisPages[i]);
      const aspects = cur.order.map((i) => cur.basisAspects[i] ?? 1.294);
      if (inside) {
        const changed = pages.some((p, i) => p !== cur.basisPages[i]);
        if (changed) onReorderRef.current?.(pages, aspects);
      } else {
        onDropPageRef.current?.(cur.basisPages[cur.dragIndex], pages, aspects);
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    listenRef.current = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
    };
  };

  const hideNumbers = async () => {
    if (!b64 || obj.pages.length < 2) return;
    try {
      const doc = await openPdf(obj.media, b64);
      const pages: { page: number; runs: Run[]; vw: number; vh: number }[] = [];
      for (let i = 0; i < obj.pages.length; i++) {
        const pageNo = obj.pages[i];
        const page = await doc.getPage(pageNo);
        const base = page.getViewport({ scale: 1 });
        const css = page.getViewport({ scale: obj.pageWidth / base.width });
        pages.push({ page: pageNo, runs: await pageTextRuns(page, css), vw: css.width, vh: css.height });
      }
      const found = detectPageNumberMasks(pages);
      if (!found?.length) return;
      onMasks?.(
        found.map((m) => ({
          ...m,
          color: sampleMaskColor(canvasRefs.current[m.page] ?? null, m),
        })),
        true,
      );
    } catch (e) {
      console.warn("page number detection failed", e);
    }
  };

  return (
    <div
      ref={objRef}
      className={`pdf-obj ${active ? "active" : ""} ${preview ? "reordering" : ""} ${obj.pending ? "is-ghost" : ""} ${obj.locked ? "locked" : ""}`}
      style={{ left: obj.x, top: obj.y, width, height, zIndex: 1 }}
      onPointerDown={(e) => {
        if (!inert) e.stopPropagation();
      }}
    >
      {failed && <div className="pdf-failed">Couldn’t read this PDF</div>}
      {slots.map((slot, i) => {
        if (!visibleSet.has(i)) return null;
        const basisIndex = preview ? preview.order[i] : i;
        const lifted = !!preview && preview.order[i] === preview.dragIndex;
        const pageMasks = (obj.masks ?? []).filter((m) => m.page === slot.page);
        const translate = lifted
          ? `translate(${preview.ghostX}px, ${preview.ghostY}px) scale(1.04)`
          : `translate(${slot.x}px, ${slot.y}px)`;
        return (
          <div
            key={`${basisIndex}:${slot.page}`}
            className={`pdf-page ${chosen.includes(slot.page) ? "chosen" : ""} ${lifted ? "pdf-lift" : ""}`}
            style={{
              width: slot.w,
              height: slot.h,
              transform: translate,
              transformOrigin: "0 0",
              transition: preview && !lifted ? "transform 150ms ease" : "none",
              zIndex: lifted ? 6 : 1,
            }}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              const t = e.target as HTMLElement;
              if (inert || !editable) return;
              if (t.closest(".pdf-img, .pdf-resize")) return;
              if ((e.ctrlKey || e.metaKey) && !preview) {
                e.preventDefault();
                e.stopPropagation();
                onChoose([slot.page], true);
                return;
              }
              if ((e.shiftKey || shiftHeld) && obj.pages.length <= 1 && !preview) {
                e.preventDefault();
                e.stopPropagation();
                onChoose([slot.page], true);
                return;
              }
              if ((e.shiftKey || shiftHeld) && obj.pages.length > 1 && !preview) {
                e.preventDefault();
                e.stopPropagation();
                onChoose([slot.page], e.ctrlKey || e.metaKey);
                startReorder(e, basisIndex);
                return;
              }
              if (t.closest(".pdf-text")) return;
              e.stopPropagation();
              onChoose([slot.page], false);
              onMove(e);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (preview) return;
              const already = chosen.includes(slot.page);
              const pages = already && chosen.length ? [...chosen] : [slot.page];
              if (!already) onChoose([slot.page], false, true);
              setMenu({ x: e.clientX, y: e.clientY, pages });
            }}
          >
            <canvas ref={(node) => { canvasRefs.current[slot.page] = node; }} />
            {!obj.hideNumbers && !obj.pending && <span className="pdf-num">{i + 1} / {slots.length}</span>}
            <div className="pdf-textlayer">
              {(runs[slot.page] ?? []).map((run, ri) => {
                const cx = (run.x + run.w / 2) / slot.w;
                const cy = (run.y + run.h / 2) / slot.h;
                if (pageMasks.some((m) => cx >= m.x && cx <= m.x + m.w && cy >= m.y && cy <= m.y + m.h)) return null;
                return (
                  <span
                    key={ri}
                    className="pdf-text"
                    style={{
                      left: run.x,
                      top: run.y,
                      fontSize: run.h,
                      width: run.w,
                      height: run.h,
                      transform: run.angle ? `rotate(${run.angle}deg)` : undefined,
                      transformOrigin: "0 0",
                    }}
                  >
                    {run.str}
                  </span>
                );
              })}
            </div>
            {(images[slot.page] ?? []).map((img, ii) => {
              const key = `${obj.id}:${slot.page}:${ii}`;
              return (
                <button
                  key={key}
                  type="button"
                  className={`pdf-img ${picked?.key === key ? "on" : ""}`}
                  title={shiftHeld ? "Select image — Ctrl+C copies it" : "Shift+click to select image"}
                  style={{ left: img.x, top: img.y, width: img.w, height: img.h, pointerEvents: shiftHeld ? undefined : "none" }}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => {
                    const src = canvasRefs.current[slot.page];
                    if (!src) return;
                    const cropped = cropPageImage(src, slot.w, slot.h, img);
                    if (cropped) setPicked({ key, canvas: cropped });
                  }}
                />
              );
            })}
            {pageMasks.map((m, mi) => (
              <div
                key={mi}
                className="pdf-mask"
                style={{
                  left: `${m.x * 100}%`,
                  top: `${m.y * 100}%`,
                  width: `${m.w * 100}%`,
                  height: `${m.h * 100}%`,
                  background: m.color,
                }}
              />
            ))}
            {active && editable && <div className="pdf-resize" title="Resize every page" onPointerDown={onResize} />}
          </div>
        );
      })}
      {menu &&
        createPortal(
          <ContextMenu
            x={menu.x}
            y={menu.y}
            onClose={() => setMenu(null)}
            header={
              editable ? (
              <div className="pdf-menu-layouts">
                {PDF_LAYOUTS.map((layout) => {
                  const Icon = LAYOUT_ICON[layout];
                  return (
                    <button
                      key={layout}
                      type="button"
                      className={obj.layout === layout ? "on" : ""}
                      title={LAYOUT_TITLE[layout]}
                      onClick={() => {
                        onLayout(layout);
                        setMenu(null);
                      }}
                    >
                      <Icon size={16} />
                    </button>
                  );
                })}
              </div>
              ) : undefined
            }
            items={((): MenuItem[] => {
              const pages = menu.pages;
              const items: MenuItem[] = [];
              if (!editable) {
                if (onCopy) items.push({ label: "Copy", hint: "Ctrl+C", onClick: onCopy });
                return items;
              }
              if (onCut) items.push({ label: "Cut", hint: "Ctrl+X", onClick: onCut });
              if (onCopy) items.push({ label: "Copy", hint: "Ctrl+C", onClick: onCopy });
              if (onPaste) items.push({ label: "Paste", hint: "Ctrl+V", onClick: onPaste });
              items.push(
                "sep",
                { label: "Bring to front", onClick: () => onFront?.() },
                { label: "Send to back", onClick: () => onBack?.() },
                "sep",
                { label: obj.locked ? "Unlock" : "Lock position", onClick: onToggleLock },
              );
              if (onJoin) items.push({ label: "Join pages", onClick: onJoin });
              items.push(
                "sep",
                {
                  label: obj.hideNumbers || obj.masks?.length ? "Show page numbers" : "Hide page numbers",
                  onClick: () => {
                    if (obj.hideNumbers || obj.masks?.length) onMasks?.(undefined, false);
                    else {
                      onMasks?.(undefined, true);
                      void hideNumbers();
                    }
                  },
                },
                {
                  label: pages.length > 1 ? "Drop selected pages" : "Drop selected page",
                  disabled: pages.length === 0 || pages.length >= obj.pages.length,
                  onClick: () => onDrop(pages),
                },
                {
                  label: "Separate all pages",
                  disabled: obj.pages.length < 2,
                  onClick: onSeparate,
                },
              );
              if (onDelete) items.push("sep", { label: "Delete", hint: "Del", danger: true, onClick: onDelete });
              return items;
            })()}
          />,
          document.body,
        )}
    </div>
  );
}
