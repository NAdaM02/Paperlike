import {
  memo,
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  api,
  CanvasObject,
  DrawingItem,
  DrawingObject,
  GroupObject,
  ImageObject,
  newId,
  NotePayload,
  PaperStyle,
  PdfLayout,
  PdfMask,
  PdfObject,
  TextObject,
} from "./api";
import { blockedByFold, collapsedIds, groupAtPoint, groupFrame, groupOf, GROUP_MIN_H, placeNew, pruneGroups, withChild } from "./group";
import { PdfView } from "./PdfView";
import { mergePdfParts } from "./pdfDoc";
import { pdfSize, pdfSlots } from "./pdfLayout";
import { blocksPlainText, blocksToHtml, htmlToBlocks } from "./richtext";
import {
  applyCellSelection,
  cellAt,
  cellCoord,
  clearAllTableSelections,
  clearCells,
  colResizeHit,
  deleteColumn,
  deleteRow,
  insertColumn,
  insertRow,
  MIN_COL_WIDTH,
  removeTable,
  setColWidth,
  TABLE_BOX_PAD,
  tableOuterWidth,
  toggleBorders,
  type CellCoord,
} from "./tableOps";
import { ContextMenu, MenuItem, b64ToBytes, bytesToB64, fitImage, imageSize } from "./ui";
import { dotPoints, EraserMode, eraseSweep, lassoHits, smoothPoints, strokePath } from "./eraser";
import { drawingTouchesRect, lassoLoop, pushLassoPoint, refineSmartStroke } from "./inkGesture";
import { markerOutlinePath, outlinePath, pressureHitWidth, pushPenSample, smoothInk, strokeOutline, strokeRuns } from "./ink";
import { isGifBase64, StillImage } from "./stillImage";
import { ArrowInk } from "./ArrowInk";
import { arrowHeadKind, arrowHeadPoints, scaleDrawing, shaftIsStraight, smoothFreeShaft, type Pt } from "./drawGeom";

/** How long a lifted pen still counts as "in use" for palm rejection. */
const PEN_PALM_MS = 500;

type PenSettings = {
  pen_enabled: boolean;
  pen_always_draws: boolean;
  pen_pressure: boolean;
  palm_rejection: boolean;
};

function penSettingsFrom(s: {
  pen_enabled?: boolean;
  pen_always_draws?: boolean;
  pen_pressure?: boolean;
  palm_rejection?: boolean;
}): PenSettings {
  return {
    pen_enabled: s.pen_enabled !== false,
    pen_always_draws: s.pen_always_draws !== false,
    pen_pressure: s.pen_pressure !== false,
    palm_rejection: s.palm_rejection !== false,
  };
}

/** PDFs paint under text, drawings, and images. Within a layer, `z` still wins. */
function paintOrder(a: CanvasObject, b: CanvasObject): number {
  const layer = (o: CanvasObject) => (o.type === "pdf" ? 0 : 1);
  return layer(a) - layer(b) || a.z - b.z;
}

/** Touch pointer-downs are ignored while a pen is down, hovering, or was used recently. */
function penBlocksTouch(pointerType: string, s: PenSettings, penDown: boolean, penHover: boolean, lastPenAt: number): boolean {
  if (pointerType !== "touch" || !s.pen_enabled || !s.palm_rejection) return false;
  if (penDown || penHover) return true;
  return performance.now() - lastPenAt < PEN_PALM_MS;
}

function readPressure(ev: PointerEvent): number {
  const p = ev.pressure;
  if (!Number.isFinite(p) || p <= 0) return 0.5;
  return p > 1 ? 1 : p;
}

function coalescedEvents(e: PointerEvent): PointerEvent[] {
  const fn = e.getCoalescedEvents?.bind(e);
  if (typeof fn !== "function") return [e];
  const list = fn();
  return list.length ? list : [e];
}

export type Tool =
  | "select"
  | "lasso"
  | "pen"
  | "highlighter"
  | "smart"
  | "eraser"
  | "rect"
  | "ellipse"
  | "line"
  | "arrow";

/** Lets the notebook place content where the user is looking and bring find matches into view. */
export type CanvasViewApi = {
  center: () => { x: number; y: number };
  /** Canvas point under a viewport client coordinate (CSS pixels). */
  point: (clientX: number, clientY: number) => { x: number; y: number };
  /** Start the current tool at a screen point. Used when the tool wheel closes onto the page. */
  press: (clientX: number, clientY: number) => void;
  /** Pan (no zoom change) so a screen-space rect is comfortably inside the viewport. */
  reveal: (r: DOMRect) => void;
};

/** Editor background pattern; follows pan and zoom like real paper. */
function paperBackground(paper: PaperStyle, cam: { x: number; y: number; z: number }): React.CSSProperties {
  const step = (paper === "lines" ? 28 : 22) * cam.z;
  if (paper === "blank" || step < 6) return { backgroundImage: "none" };
  const line = "var(--canvas-line)";
  if (paper === "lines") {
    return {
      backgroundImage: `linear-gradient(to bottom, ${line} 1px, transparent 1px)`,
      backgroundSize: `100% ${step}px`,
      backgroundPosition: `0 ${cam.y}px`,
    };
  }
  if (paper === "grid") {
    return {
      backgroundImage: `linear-gradient(to right, ${line} 1px, transparent 1px), linear-gradient(to bottom, ${line} 1px, transparent 1px)`,
      backgroundSize: `${step}px ${step}px`,
      backgroundPosition: `${cam.x}px ${cam.y}px`,
    };
  }
  return {
    backgroundImage: "radial-gradient(var(--canvas-dot) 1.2px, transparent 1.2px)",
    backgroundSize: `${step}px ${step}px`,
    backgroundPosition: `${cam.x - step / 2}px ${cam.y - step / 2}px`,
  };
}

type Props = {
  note: NotePayload;
  /** Functional update so rapid changes in the same tick never stomp each other. */
  onUpdate: (fn: (n: NotePayload) => NotePayload) => void;
  /** Push an undo snapshot BEFORE a change. key coalesces rapid same-kind changes. */
  snapshot: (key: string, coalesceMs?: number) => void;
  tool: Tool;
  drawColor: string;
  drawWidth: number;
  /** Highlighter ink, 0–1. Capped below solid so strokes stay marker-like. */
  hlOpacity?: number;
  eraserMode: EraserMode;
  /** Eraser ring radius in screen pixels. */
  eraserRadius: number;
  /** Free follows the stroke. Straight is the dragged line. */
  arrowMode?: "free" | "straight";
  arrowHead?: "drawn" | "open" | "full";
  arrowBody?: "single" | "double";
  /** Right button held, then left click: open the tool wheel here. */
  onToolChord?: (x: number, y: number) => void;
  /** The drawing just placed. Ribbon color and width restyle it until the next click or stroke. */
  onLiveDraw?: (id: string | null) => void;
  viewRef?: React.MutableRefObject<CanvasViewApi | null>;
  paper: PaperStyle;
  /** Draw tools can ask the ribbon to switch. The lasso stays on Lasso. */
  onRequestTool?: (t: Tool) => void;
  /** PDF Preview: camera stays on this page slice. Pan and zoom are off. */
  lockedView?: { x: number; y: number; z: number } | null;
  /** Starting camera when not locked (used on mount only). */
  initialCam?: { x: number; y: number; z: number } | null;
  /** Receives the live camera and viewport size (free canvas only), without re-rendering the parent. */
  liveCamRef?: React.MutableRefObject<{ x: number; y: number; z: number; w: number; h: number } | null>;
  findQuery: string;
  /** map object id -> measured pixel height (kept fresh for hit tests / pdf) */
  heightsRef: React.MutableRefObject<Record<string, number>>;
  defaultFont?: string;
  defaultSize?: number;
  defaultColor?: string;
  onSelectionChange?: (ids: string[]) => void;
  /** Text window in canvas-highlight edit mode (ribbon applies to whole box). */
  highlightedTextId?: string | null;
  onTextEditStart?: (id: string) => void;
  /** Top bar / move / marquee: stay in window-select mode even if selection is unchanged. */
  onWindowSelect?: (id: string) => void;
  /** Trial over: pan and read, no drawing, typing, or moving. */
  canEdit?: boolean;
  /** Faint pages under the cursor while a Moodle PDF is on its way. Not saved. */
  dragGhost?: { x: number; y: number; pageWidth: number; aspects: number[]; preview?: string } | null;
};

type Camera = { x: number; y: number; z: number };

type ShapeHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

type Drag =
  | { mode: "pan"; sx: number; sy: number; moved: number; via: "middle" | "right" | "space" }
  | { mode: "erase"; last: [number, number]; snapped: boolean; temp: boolean; pointerId: number }
  | {
      mode: "marquee";
      sx: number;
      sy: number;
      cx: number;
      cy: number;
      base: string[];
      additive: boolean;
      /** True if something was selected when the gesture started — a plain click only deselects. */
      hadSelection: boolean;
    }
  | {
      mode: "move";
      ids: string[];
      orig: { x: number; y: number }[];
      sx: number;
      sy: number;
      snapped: boolean;
      /** Click with no drag on a collapsed fold expands it. */
      toggleGroup?: string;
      pendingDx?: number;
      pendingDy?: number;
    }
  | {
      mode: "resize-text";
      id: string;
      edge: "w" | "e" | "s" | "se";
      ox: number;
      ow: number;
      oh: number;
      sx: number;
      sy: number;
    }
  | { mode: "resize-img"; id: string; ow: number; oh: number; sx: number; sy: number }
  | {
      mode: "draw";
      pts: [number, number][];
      /** 0..1, same length as pts. Only a pressure-enabled pen stroke sets this. */
      pressure?: number[];
      sx: number;
      sy: number;
      hl: boolean;
      groupId: string | null;
      /** Pen input is on and this stroke came from pointerType "pen". */
      pen: boolean;
      /** Stroke pointer. -1 after Windows ends the pen pointer, until the mouse stream is adopted. */
      pointerId: number;
      /** Set when the stroke should commit. A pen pointerup alone does not. */
      closing?: boolean;
      /** Last pen/marker ink, when the pen draws while another tool is selected. */
      color?: string;
      width?: number;
      /** Marker strength, stored on the stroke. */
      opacity?: number;
      /** Smart tool: timestamps aligned with pts, for speed and corners. */
      smart?: boolean;
      times?: number[];
    }
  | { mode: "lasso"; pts: [number, number][]; pen?: boolean; pointerId?: number; additive?: boolean }
  | { mode: "shape"; shape: "rect" | "ellipse" | "line"; sx: number; sy: number; cx: number; cy: number; groupId: string | null }
  | {
      mode: "arrow";
      sx: number;
      sy: number;
      cx: number;
      cy: number;
      groupId: string | null;
      /** Free mode records the stroke. Straight mode uses sx/sy → cx/cy. */
      free?: boolean;
      pts?: [number, number][];
    }
  | {
      mode: "resize-draw";
      handle: ShapeHandle;
      ax: number;
      ay: number;
      hx: number;
      hy: number;
      sx: number;
      sy: number;
      snapped: boolean;
      orig: DrawingObject[];
    }
  | { mode: "resize-group"; id: string; edge: "w" | "e" | "s" | "se"; ox: number; oy: number; ow: number; oh: number; sx: number; sy: number }
  | { mode: "resize-pdf"; id: string; startW: number; aspect: number; sx: number; sy: number }
  | { mode: "ctrl-pt"; id: string; pt: "tail" | "head" | "c1" | "c2" }
  | {
      mode: "resize-shape";
      id: string;
      handle: "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
      ox: number;
      oy: number;
      ow: number;
      oh: number;
    };

/**
 * Unpainted box around a marker stroke. Chromium drops a mix-blend-mode layer whose
 * geometry has zero height or width (a perfectly straight stroke) — this keeps it alive.
 */
export function HlBounds({ pts, width }: { pts: [number, number][]; width: number }) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p[0]);
    minY = Math.min(minY, p[1]);
    maxX = Math.max(maxX, p[0]);
    maxY = Math.max(maxY, p[1]);
  }
  if (!isFinite(minX)) return null;
  const h = width / 2;
  return <rect x={minX - h} y={minY - h} width={maxX - minX + width} height={maxY - minY + width} fill="none" />;
}

/** Tip vertices in item space, so the frame and the hit box cover the drawn head. */
function arrowTipExtents(it: Extract<DrawingItem, { kind: "arrow" }>): Pt[] {
  const line = it.shaft && it.shaft.length >= 2 ? it.shaft : [it.tail, it.head];
  const from = it.shaft && it.shaft.length > 1 ? it.shaft[it.shaft.length - 2] : it.c2;
  const to = it.shaft && it.shaft.length ? it.shaft[it.shaft.length - 1] : it.head;
  const span = Math.hypot(to[0] - line[0][0], to[1] - line[0][1]);
  const pts: Pt[] = [];
  if ((it.head_style ?? "arrow") !== "none") {
    pts.push(...arrowHeadPoints(from, to, it.width, arrowHeadKind(it.head_style), span));
  }
  if (it.tail_style === "arrow") pts.push(...arrowHeadPoints(it.c1, it.tail, it.width, "full", span));
  return pts;
}

export function drawingBBox(o: DrawingObject): { x: number; y: number; w: number; h: number } {
  const it = o.item;
  if (it.kind === "stroke") {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const run of strokeRuns(it.points, it.parts)) {
      for (const p of run) {
        minX = Math.min(minX, p[0]);
        minY = Math.min(minY, p[1]);
        maxX = Math.max(maxX, p[0]);
        maxY = Math.max(maxY, p[1]);
      }
    }
    if (!isFinite(minX)) return { x: o.x, y: o.y, w: 1, h: 1 };
    return { x: o.x + minX, y: o.y + minY, w: maxX - minX || 1, h: maxY - minY || 1 };
  }
  if (it.kind === "shape") return { x: o.x, y: o.y, w: it.w || 1, h: it.h || 1 };
  const pts = [it.tail, it.head, it.c1, it.c2, ...(it.shaft ?? []), ...arrowTipExtents(it)];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  return { x: o.x + minX, y: o.y + minY, w: maxX - minX || 1, h: maxY - minY || 1 };
}

export function objectBBox(
  o: CanvasObject,
  heights: Record<string, number>,
): { x: number; y: number; w: number; h: number } {
  if (o.type === "text") {
    const auto = heights[o.id] ?? 40;
    const h = Math.max(auto, o.min_height ?? 0);
    return { x: o.x, y: o.y, w: o.width, h };
  }
  if (o.type === "image") return { x: o.x, y: o.y, w: o.width, h: o.height };
  if (o.type === "group") return { x: o.x, y: o.y, w: o.width, h: Math.max(GROUP_MIN_H, o.min_height ?? GROUP_MIN_H) };
  if (o.type === "pdf") {
    const size = pdfSize(o);
    return { x: o.x, y: o.y, w: size.w, h: size.h };
  }
  return drawingBBox(o);
}

/** Collapsed fold marker. New folds store the chevron center; older ones sit on x,y. */
function collapsedBox(g: GroupObject): { x: number; y: number; w: number; h: number } {
  return { x: g.marker_x ?? g.x, y: g.marker_y ?? g.y, w: 28, h: 28 };
}

/** Center the 28px marker on the collapse chevron (16px, sitting just above the frame). */
function markerOnChevron(frame: { x: number; y: number }): { marker_x: number; marker_y: number } {
  return { marker_x: frame.x + 8 - 14, marker_y: frame.y - 8 - 14 };
}

/** Trailing blank paragraphs (Enter / click-pad) that only inflate height. */
function isVacantParagraph(el: HTMLElement): boolean {
  if (!el.classList.contains("p")) return false;
  return !(el.textContent ?? "").trim() && !el.querySelector("img, .pl-math, table");
}

/** Remove trailing empty lines until the text window fits targetH (or real content remains). */
function trimTrailingEmptyToHeight(win: HTMLElement, targetH: number): boolean {
  const content = win.querySelector(".content") as HTMLElement | null;
  if (!content) return false;
  let changed = false;
  while (win.offsetHeight > targetH + 0.5 && content.children.length > 1) {
    const last = content.lastElementChild as HTMLElement | null;
    if (!last || !isVacantParagraph(last)) break;
    last.remove();
    changed = true;
  }
  return changed;
}

export function contentBBox(
  objects: CanvasObject[],
  heights: Record<string, number>,
): { x: number; y: number; w: number; h: number } | null {
  if (!objects.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const o of objects) {
    const b = objectBBox(o, heights);
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Objects copied inside the app. Survives switching notes. */
/** Marks a clipboard write that belongs to the in-app object clipboard, so a stale image does not win the next paste. */
const OBJECT_CLIP_MARKER = "\u200bpaperlike-objects\u200b";
let objectClip: { objects: CanvasObject[]; media: Record<string, string> } | null = null;
let pasteBusy = false;

export function CanvasEditor({
  note,
  onUpdate,
  snapshot,
  tool,
  drawColor,
  drawWidth,
  hlOpacity = 0.4,
  eraserMode,
  eraserRadius,
  arrowMode = "free",
  arrowHead = "drawn",
  arrowBody = "single",
  onToolChord,
  onLiveDraw,
  viewRef,
  paper,
  lockedView,
  initialCam,
  liveCamRef,
  findQuery,
  heightsRef,
  defaultFont = "Segoe UI",
  defaultSize = 11,
  defaultColor,
  onSelectionChange,
  highlightedTextId = null,
  onTextEditStart,
  onWindowSelect,
  canEdit = true,
  dragGhost = null,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const onPointerDownRef = useRef<(e: React.PointerEvent<HTMLDivElement>) => void>(() => {});
  const onPointerMoveRef = useRef<(e: React.PointerEvent<HTMLDivElement>) => void>(() => {});
  const onPointerUpRef = useRef<(e: React.PointerEvent<HTMLDivElement>) => void>(() => {});
  const marqueeElRef = useRef<HTMLDivElement>(null);
  const liveInkRef = useRef<SVGSVGElement>(null);
  const liveInkPathRef = useRef<SVGPathElement>(null);
  const lastEmptyClick = useRef({ t: 0, x: 0, y: 0 });
  const marqueeRaf = useRef(0);
  /** Shift is the shared "reach through" modifier: pick PDF images, move locked items. */
  const [shiftHeld, setShiftHeld] = useState(false);
  const shiftRef = useRef(false);
  const [hoverLocked, setHoverLocked] = useState<string | null>(null);
  /** Last piece dropped out of each joined PDF this session, so the next drop lands below it. */
  const lastDrop = useRef<Map<string, { x: number; y: number; w: number; h: number }>>(new Map());
  useEffect(() => {
    const set = (v: boolean) => {
      shiftRef.current = v;
      setShiftHeld(v);
    };
    const kd = (e: KeyboardEvent) => e.key === "Shift" && set(true);
    const ku = (e: KeyboardEvent) => e.key === "Shift" && set(false);
    const off = () => set(false);
    const vis = () => document.hidden && set(false);
    window.addEventListener("keydown", kd);
    window.addEventListener("keyup", ku);
    window.addEventListener("blur", off);
    document.addEventListener("visibilitychange", vis);
    return () => {
      window.removeEventListener("keydown", kd);
      window.removeEventListener("keyup", ku);
      window.removeEventListener("blur", off);
      document.removeEventListener("visibilitychange", vis);
    };
  }, []);
  const [cam, setCam] = useState<Camera>(lockedView ?? initialCam ?? { x: 60, y: 40, z: 1 });
  const [wrapBox, setWrapBox] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setWrapBox({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    if (!liveCamRef || lockedView) return;
    const el = wrapRef.current;
    liveCamRef.current = { ...cam, w: el?.clientWidth ?? 0, h: el?.clientHeight ?? 0 };
  }, [cam, liveCamRef, lockedView]);
  const lockedRef = useRef(lockedView);
  lockedRef.current = lockedView;
  useEffect(() => {
    if (lockedView) setCam(lockedView);
  }, [lockedView]);
  const camRef = useRef(cam);
  camRef.current = cam;
  const [selected, setSelected] = useState<string[]>([]);
  /** Pages picked inside each selected PDF. Ctrl-click adds pages from other PDFs. */
  const [pdfPick, setPdfPick] = useState<Record<string, number[]>>({});
  const pdfPickRef = useRef(pdfPick);
  pdfPickRef.current = pdfPick;
  const [adjustId, setAdjustId] = useState<string | null>(null);
  const [movingIds, setMovingIds] = useState<string[]>([]);
  const [resizingId, setResizingId] = useState<string | null>(null);
  const [spaceDown, setSpaceDown] = useState(false);

  const ADJUST_TOOLS = ["line", "arrow", "rect", "ellipse"] as const;

  // Draw tools keep post-placement adjust handles; switching to select adopts them.
  useEffect(() => {
    if (tool === "select") {
      setAdjustId((prev) => {
        if (prev) setSelected([prev]);
        return null;
      });
    } else if (tool === "lasso") {
      // Lasso keeps whatever is selected, and can still move it.
      setAdjustId(null);
    } else if (!ADJUST_TOOLS.includes(tool as (typeof ADJUST_TOOLS)[number])) {
      setAdjustId(null);
      setSelected([]);
      setMovingIds([]);
      setResizingId(null);
      (document.activeElement as HTMLElement | null)?.blur();
    } else {
      // A new shape tool must not keep the previous shape's edit handles.
      setAdjustId(null);
      setSelected([]);
      setMovingIds([]);
      setResizingId(null);
    }
  }, [tool]);

  useEffect(() => {
    onSelectionChange?.(selected);
  }, [selected, onSelectionChange]);

  // Page outlines follow the canvas selection. Clicking away drops the PDF from
  // `selected`, and the last page marker must go with it.
  useEffect(() => {
    setPdfPick((cur) => {
      const ids = Object.keys(cur);
      if (ids.every((id) => selected.includes(id))) return cur;
      const next: Record<string, number[]> = {};
      for (const id of ids) if (selected.includes(id)) next[id] = cur[id];
      pdfPickRef.current = next;
      return next;
    });
  }, [selected]);

  // Multi-object selection is canvas-level: never leave a caret in a text window.
  useEffect(() => {
    if (selected.length <= 1) return;
    const ae = document.activeElement as HTMLElement | null;
    if (ae?.closest?.(".content")) ae.blur();
  }, [selected]);

  const dragRef = useRef<Drag | null>(null);
  const penSettingsRef = useRef<PenSettings>(penSettingsFrom({}));
  const [penSettings, setPenSettings] = useState<PenSettings>(penSettingsRef.current);
  const penDownRef = useRef(false);
  const penHoverRef = useRef(false);
  const lastPenAt = useRef(0);
  const spaceRef = useRef(false);
  /** Starts a pen stroke from the capture phase so Select-mode objects cannot steal it. */
  const beginPenStrokeRef = useRef<(e: PointerEvent) => void>(() => {});
  /** Last pen or marker ink, so a pen can draw while Select stays selected. */
  const lastInk = useRef({ hl: false, color: drawColor, width: drawWidth });
  const dragMoveRaf = useRef(0);
  /** When pointerrawupdate is flowing, pointermove coordinates are ignored so a frozen event cannot yank the stroke back. */
  const followDrawRef = useRef<(e: PointerEvent) => void>(() => {});
  const followLassoRef = useRef<(e: PointerEvent) => void>(() => {});
  const bumpRef = useRef<() => void>(() => {});
  const endStrokeRef = useRef<(e: PointerEvent) => void>(() => {});
  const penLiftRef = useRef(0);
  const [, forceRender] = useState(0);
  const pendingTextRef = useRef<string | null>(null);
  /** After a deselect-click on empty canvas, typing creates a text box here. */
  const pendingTypeAt = useRef<{ x: number; y: number } | null>(null);
  /** This press closed a menu, so the click must not also drop a text box. */
  const menuDismissRef = useRef(false);
  /** A text box just opened here; the second half of a double-click must not open another. */
  const spawnedTextRef = useRef({ t: 0, x: 0, y: 0 });
  /** Bumps when a paste event is handled, so a keydown fallback does not paste twice. */
  const pasteGenRef = useRef(0);
  const handlePasteRef = useRef<(e: ClipboardEvent) => void>(() => {});
  const createTextAtRef = useRef<(x: number, y: number, initial?: string) => void>(() => {});
  /** Suppress the browser context menu after a right-button pan. */
  const suppressCtxMenu = useRef(false);
  const [objMenu, setObjMenu] = useState<{ x: number; y: number; ids: string[] } | null>(null);
  const openObjMenu = useRef<(e: MouseEvent) => void>(() => {});
  const [panning, setPanning] = useState(false);

  const objects = note.doc.canvas.objects;
  const sorted = useMemo(() => [...objects].sort(paintOrder), [objects]);
  const maxZ = useCallback(() => objects.reduce((m, o) => Math.max(m, o.z), 0), [objects]);

  const updateObjects = useCallback(
    (fn: (objs: CanvasObject[]) => CanvasObject[]) => {
      onUpdate((n) => ({
        ...n,
        doc: { ...n.doc, canvas: { ...n.doc.canvas, objects: pruneGroups(fn(n.doc.canvas.objects)) } },
      }));
    },
    [onUpdate],
  );

  const boxOf = useCallback((o: CanvasObject) => objectBBox(o, heightsRef.current), [heightsRef]);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const noteMediaRef = useRef(note.media_b64);
  noteMediaRef.current = note.media_b64;

  /** Cut, copy and paste for objects. Images on the system clipboard still win on paste. */
  const copyObjects = useCallback((ids: string[]) => {
    const all = objectsRef.current;
    const keep = new Set(ids);
    for (const id of ids) {
      const o = all.find((x) => x.id === id);
      if (o?.type === "group") o.children.forEach((c) => keep.add(c));
    }
    const objs = all.filter((o) => keep.has(o.id)).map((o) => structuredClone(o));
    if (!objs.length) return;
    const media: Record<string, string> = {};
    for (const o of objs) {
      if ((o.type === "image" || o.type === "pdf") && noteMediaRef.current[o.media]) {
        media[o.media] = noteMediaRef.current[o.media];
      }
    }
    objectClip = { objects: objs, media };
    void navigator.clipboard.writeText(OBJECT_CLIP_MARKER).catch(() => {});
  }, []);

  const deleteIds = useCallback(
    (rawIds: string[], force = false) => {
      // Locked objects survive a keypress. The context menu passes force: the user asked.
      const ids = rawIds.filter((id) => force || shiftRef.current || !objectsRef.current.find((x) => x.id === id)?.locked);
      if (!ids.length) return;
      snapshot("delete");
      updateObjects((objs) => {
        const drop = new Set(ids);
        for (const id of ids) {
          const o = objs.find((x) => x.id === id);
          if (o?.type === "group") o.children.forEach((c) => drop.add(c));
        }
        return objs.filter((o) => !drop.has(o.id));
      });
      setSelected([]);
    },
    [snapshot, updateObjects],
  );

  const pasteObjects = useCallback(() => {
    const clip = objectClip;
    if (!clip) return;
    const idOf = new Map<string, string>();
    const prefix: Record<string, string> = { text: "t", image: "i", drawing: "d", group: "g", pdf: "p" };
    for (const o of clip.objects) idOf.set(o.id, newId(prefix[o.type] ?? "o"));
    let z = objectsRef.current.reduce((m, o) => Math.max(m, o.z), 0);
    const clones = clip.objects.map((o) => {
      const id = idOf.get(o.id)!;
      const moved = { ...structuredClone(o), id, x: o.x + 24, y: o.y + 24, z: ++z };
      if (moved.type === "group") moved.children = moved.children.map((c) => idOf.get(c) ?? c);
      return moved;
    });
    snapshot("paste");
    onUpdate((n) => ({
      ...n,
      media_b64: { ...n.media_b64, ...clip.media },
      doc: { ...n.doc, canvas: { ...n.doc.canvas, objects: [...n.doc.canvas.objects, ...clones] } },
    }));
    const tops = clones.filter((o) => !clones.some((g) => g.type === "group" && g.children.includes(o.id))).map((o) => o.id);
    setSelected(tops);
    const wrap = wrapRef.current;
    if (!wrap || !clones.length) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const o of clones) {
      const b = objectBBox(o, heightsRef.current);
      minX = Math.min(minX, b.x);
      minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + b.w);
      maxY = Math.max(maxY, b.y + Math.max(b.h, 28));
    }
    if (!Number.isFinite(minX)) return;
    const c = camRef.current;
    const view = wrap.getBoundingClientRect();
    const left = c.x + minX * c.z;
    const top = c.y + minY * c.z;
    const right = c.x + maxX * c.z;
    const bottom = c.y + maxY * c.z;
    if (left >= 8 && top >= 8 && right <= view.width - 8 && bottom <= view.height - 8) return;
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    setCam((cam) => ({ ...cam, x: view.width / 2 - cx * cam.z, y: view.height / 2 - cy * cam.z }));
  }, [onUpdate, snapshot]);

  const restack = useCallback(
    (ids: string[], front: boolean) => {
      snapshot(front ? "front" : "back");
      updateObjects((objs) => {
        const zs = objs.map((o) => o.z).sort((a, b) => a - b);
        const pick = new Set(ids);
        for (const id of ids) {
          const o = objs.find((x) => x.id === id);
          if (o?.type === "group") o.children.forEach((c) => pick.add(c));
        }
        const moving = objs.filter((o) => pick.has(o.id));
        const staying = objs.filter((o) => !pick.has(o.id));
        const ordered = front ? [...staying, ...moving] : [...moving, ...staying];
        return ordered.map((o, i) => ({ ...o, z: zs[i] ?? i }));
      });
    },
    [snapshot, updateObjects],
  );

  openObjMenu.current = (e: MouseEvent) => {
    const host = (e.target as Element | null)?.closest?.("[data-oid]") as HTMLElement | null;
    let id = host?.dataset.oid;
    // Locked ink often has no pointer target. Hit-test so Delete still finds it.
    if (!id) {
      const pt = toCanvas(e.clientX, e.clientY);
      id = objectAtPoint(pt.x, pt.y) ?? undefined;
    }
    const cur = selectedRef.current;
    const ids = id ? (cur.includes(id) ? cur : [id]) : [];
    if (id && !cur.includes(id)) setSelected([id]);
    if (!ids.length && !id && !objectClip && !objectsRef.current.some((o) => o.locked)) return;
    setObjMenu({ x: e.clientX, y: e.clientY, ids: id && !cur.includes(id) ? [id] : ids });
  };

  const toCanvas = useCallback((clientX: number, clientY: number) => {
    const r = wrapRef.current!.getBoundingClientRect();
    const c = camRef.current;
    return { x: (clientX - r.left - c.x) / c.z, y: (clientY - r.top - c.y) / c.z };
  }, []);

  const paintMarquee = () => {
    const el = marqueeElRef.current;
    if (!el) return;
    const d = dragRef.current;
    if (!d || d.mode !== "marquee") {
      el.style.display = "none";
      return;
    }
    const w = Math.abs(d.cx - d.sx);
    const h = Math.abs(d.cy - d.sy);
    if (w < 2 && h < 2) {
      el.style.display = "none";
      return;
    }
    el.style.display = "block";
    el.style.left = `${Math.min(d.sx, d.cx)}px`;
    el.style.top = `${Math.min(d.sy, d.cy)}px`;
    el.style.width = `${w}px`;
    el.style.height = `${h}px`;
  };

  if (viewRef) {
    viewRef.current = {
      center: () => {
        const r = wrapRef.current?.getBoundingClientRect();
        if (!r) return { x: 120, y: 120 };
        return toCanvas(r.left + r.width / 2, r.top + r.height / 2);
      },
      point: (clientX, clientY) => toCanvas(clientX, clientY),
      press: (clientX, clientY) => {
        const el = wrapRef.current;
        if (!el) return;
        const asPointer = (ev: PointerEvent) =>
          ({
            button: ev.button,
            buttons: ev.buttons,
            clientX: ev.clientX,
            clientY: ev.clientY,
            pointerId: ev.pointerId,
            pointerType: ev.pointerType || "mouse",
            ctrlKey: ev.ctrlKey,
            metaKey: ev.metaKey,
            altKey: ev.altKey,
            shiftKey: ev.shiftKey,
            detail: ev.detail,
            target: el,
            currentTarget: el,
            nativeEvent: ev,
            preventDefault() {
              ev.preventDefault();
            },
            stopPropagation() {
              ev.stopPropagation();
            },
            getModifierState: (key: string) => ev.getModifierState(key),
          }) as unknown as React.PointerEvent<HTMLDivElement>;
        const native = new PointerEvent("pointerdown", {
          clientX,
          clientY,
          button: 0,
          buttons: 1,
          pointerId: 1,
          pointerType: "mouse",
          bubbles: true,
        });
        onPointerDownRef.current(asPointer(native));
        const move = (ev: PointerEvent) => onPointerMoveRef.current(asPointer(ev));
        const up = (ev: PointerEvent) => {
          window.removeEventListener("pointermove", move, true);
          window.removeEventListener("pointerup", up, true);
          onPointerUpRef.current(asPointer(ev));
        };
        window.addEventListener("pointermove", move, true);
        window.addEventListener("pointerup", up, true);
      },
      reveal: (t) => {
        const w = wrapRef.current?.getBoundingClientRect();
        if (!w) return;
        const m = 48;
        if (t.left >= w.left + m && t.right <= w.right - m && t.top >= w.top + m && t.bottom <= w.bottom - m) return;
        const dx = w.left + w.width / 2 - (t.left + t.width / 2);
        const dy = w.top + w.height / 2 - (t.top + t.height / 2);
        setCam((c) => ({ ...c, x: c.x + dx, y: c.y + dy }));
      },
    };
  }

  /* ── eraser (tool, right-drag in Pen mode, or stylus eraser end) ── */
  const objectsRef = useRef(objects);
  objectsRef.current = objects;
  const toolRef = useRef(tool);
  toolRef.current = tool;
  const ringRef = useRef<HTMLDivElement>(null);
  const [tempErasing, setTempErasing] = useState(false);

  const moveRing = (clientX: number, clientY: number, show: boolean) => {
    const ring = ringRef.current;
    const wrap = wrapRef.current;
    if (!ring || !wrap) return;
    if (!show) {
      ring.style.display = "none";
      return;
    }
    const r = wrap.getBoundingClientRect();
    ring.style.display = "block";
    ring.style.width = ring.style.height = `${eraserRadius * 2}px`;
    ring.style.transform = `translate(${clientX - r.left - eraserRadius}px, ${clientY - r.top - eraserRadius}px)`;
  };

  /** One sweep segment of the eraser; the first real change in a gesture takes the undo snapshot. */
  const eraseStep = (d: Extract<Drag, { mode: "erase" }>, to: [number, number]) => {
    const next = eraseSweep(objectsRef.current, d.last, to, eraserRadius / camRef.current.z, eraserMode);
    d.last = to;
    if (!next) return;
    if (!d.snapped) {
      snapshot("erase");
      d.snapped = true;
    }
    objectsRef.current = next;
    updateObjects(() => next);
  };
  const eraseStepRef = useRef(eraseStep);
  eraseStepRef.current = eraseStep;
  const moveRingRef = useRef(moveRing);
  moveRingRef.current = moveRing;
  /** Right button is down, but the pointer hasn't moved enough to pan or erase. */
  const rightHoldRef = useRef<{ pointerId: number; x: number; y: number; kind: "pan" | "erase" } | null>(null);
  const onToolChordRef = useRef(onToolChord);
  onToolChordRef.current = onToolChord;
  const onLiveDrawRef = useRef(onLiveDraw);
  onLiveDrawRef.current = onLiveDraw;
  const updateObjectsRef = useRef(updateObjects);
  updateObjectsRef.current = updateObjects;
  /** Objects before a right-click erase, so a still chord can undo that dab and open the wheel. */
  const eraseChordRef = useRef<{ x: number; y: number; objects: CanvasObject[] } | null>(null);
  useEffect(() => {
    if (tool !== "eraser" && ringRef.current) ringRef.current.style.display = "none";
  }, [tool]);

  /* ── native wheel (React's is passive; we need preventDefault for zoom) ── */
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (lockedRef.current) {
        if (e.ctrlKey) e.preventDefault();
        return;
      }
      const zooming = e.ctrlKey || (e.buttons & 4) !== 0;
      if (zooming) {
        e.preventDefault();
        const r = el.getBoundingClientRect();
        const mx = e.clientX - r.left;
        const my = e.clientY - r.top;
        setCam((c) => {
          const nz = Math.min(5, Math.max(0.15, c.z * Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015))));
          return {
            z: nz,
            x: mx - ((mx - c.x) / c.z) * nz,
            y: my - ((my - c.y) / c.z) * nz,
          };
        });
      } else if (e.shiftKey) {
        setCam((c) => ({ ...c, x: c.x - e.deltaY }));
      } else {
        setCam((c) => ({ x: c.x - e.deltaX, y: c.y - e.deltaY, z: c.z }));
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  /* ── middle / right button pan anywhere (capture, before objects steal it) ── */
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;

    const beginPan = (e: PointerEvent, via: "middle" | "right") => {
      if (lockedRef.current) return;
      e.preventDefault();
      e.stopPropagation();
      suppressCtxMenu.current = false;
      dragRef.current = { mode: "pan", sx: e.clientX, sy: e.clientY, moved: 0, via };
      setPanning(true);
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    };

    /** Temporary eraser: lives only until the button is released, then the pen is back. */
    const beginErase = (e: PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      suppressCtxMenu.current = true;
      const r = el.getBoundingClientRect();
      const c = camRef.current;
      const pt: [number, number] = [(e.clientX - r.left - c.x) / c.z, (e.clientY - r.top - c.y) / c.z];
      const d: Drag = { mode: "erase", last: pt, snapped: false, temp: true, pointerId: e.pointerId };
      dragRef.current = d;
      setTempErasing(true);
      moveRingRef.current(e.clientX, e.clientY, true);
      eraseStepRef.current(d, pt);
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    };

    /** Side button: freeform lasso. The eraser end stays on beginErase. No capture — it freezes the pen. */
    const beginLasso = (e: PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      suppressCtxMenu.current = true;
      const r = el.getBoundingClientRect();
      const c = camRef.current;
      const pt: [number, number] = [(e.clientX - r.left - c.x) / c.z, (e.clientY - r.top - c.y) / c.z];
      dragRef.current = { mode: "lasso", pts: [pt], pen: true, pointerId: e.pointerId };
      bumpRef.current();
    };

    const onDown = (e: PointerEvent) => {
      if ((e.target as Element | null)?.closest?.(".menu")) return;
      if (e.pointerType === "pen" && penSettingsRef.current.pen_enabled) {
        penDownRef.current = true;
        penHoverRef.current = true;
        lastPenAt.current = performance.now();
        // Non-passive: if this does not run, WebView2 cancels the pen after a few pixels.
        if (e.button === 0 || e.button === 2 || e.button === 5) e.preventDefault();
      }
      // A palm is pointerType "touch". Blocking it also stops a two-pointer pinch
      // while the pen is in use. Wheel and precision-touchpad zoom stay on the wheel listener.
      if (penBlocksTouch(e.pointerType, penSettingsRef.current, penDownRef.current, penHoverRef.current, lastPenAt.current)) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      // Stylus eraser end (button 5) erases with any tool. The side button (button 2) lassos.
      if (e.pointerType === "pen" && e.button === 5) {
        beginErase(e);
        return;
      }
      if (e.pointerType === "pen" && e.button === 2) {
        beginLasso(e);
        return;
      }
      // Pen draws even when Select is active. Capture runs before objects, which
      // would otherwise move or select. Mouse and touch keep the current tool.
      if (
        e.button === 0 &&
        e.pointerType === "pen" &&
        penSettingsRef.current.pen_enabled &&
        penSettingsRef.current.pen_always_draws &&
        toolRef.current !== "pen" &&
        toolRef.current !== "highlighter"
      ) {
        beginPenStrokeRef.current(e);
        return;
      }
      const openWheel = (ev: PointerEvent) => {
        const chord = eraseChordRef.current;
        if (chord) {
          // Already dragging the eraser: keep erasing. A still right-click can still become the wheel.
          if (Math.hypot(ev.clientX - chord.x, ev.clientY - chord.y) >= 8) return;
          const prev = chord.objects;
          eraseChordRef.current = null;
          dragRef.current = null;
          objectsRef.current = prev;
          updateObjectsRef.current(() => prev);
          setTempErasing(false);
          moveRingRef.current(0, 0, false);
        }
        rightHoldRef.current = null;
        suppressCtxMenu.current = true;
        ev.preventDefault();
        ev.stopPropagation();
        onToolChordRef.current?.(ev.clientX, ev.clientY);
      };
      // Left click while the right button is held opens the tool wheel.
      // WebView2 sometimes never emits that second pointerdown, so pointermove
      // also watches for both buttons. Pen and marker erase immediately, in place.
      if (e.button === 0 && e.pointerType !== "pen" && (rightHoldRef.current || eraseChordRef.current)) {
        openWheel(e);
        return;
      }
      if (e.button === 1) beginPan(e, "middle");
      else if (e.button === 2) {
        const t = e.target as Element | null;
        if (t?.closest?.("table.plt, .pdf-page")) return;
        if (e.pointerType === "pen") return;
        // Pen, marker, and the shape tools erase while the button is held. Select and lasso still pan.
        const draw =
          toolRef.current === "pen" ||
          toolRef.current === "highlighter" ||
          toolRef.current === "smart" ||
          toolRef.current === "rect" ||
          toolRef.current === "ellipse" ||
          toolRef.current === "line" ||
          toolRef.current === "arrow";
        if (draw) {
          eraseChordRef.current = { x: e.clientX, y: e.clientY, objects: objectsRef.current.slice() };
          beginErase(e);
          return;
        }
        rightHoldRef.current = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, kind: "pan" };
      }
      if (e.button === 0) {
        const t = e.target as Element | null;
        if (!t?.closest?.(".content, .math-pop")) {
          const ae = document.activeElement as HTMLElement | null;
          if (ae?.closest?.(".content")) ae.blur();
          const sel = window.getSelection();
          if (sel && !sel.isCollapsed) sel.removeAllRanges();
          requestAnimationFrame(() => {
            const active = document.activeElement as HTMLElement | null;
            const left = window.getSelection();
            if (!active?.closest?.(".content") && left && !left.isCollapsed) left.removeAllRanges();
          });
        }
      }
    };

    const onRightMove = (e: PointerEvent) => {
      if ((e.buttons & 1) !== 0 && (e.buttons & 2) !== 0 && e.pointerType !== "pen") {
        const hold = rightHoldRef.current;
        const chord = eraseChordRef.current;
        const origin = hold ?? (chord ? { x: chord.x, y: chord.y } : null);
        if (origin && Math.hypot(e.clientX - origin.x, e.clientY - origin.y) < 8) {
          const chordSnap = eraseChordRef.current;
          if (chordSnap) {
            objectsRef.current = chordSnap.objects;
            updateObjectsRef.current(() => chordSnap.objects);
            eraseChordRef.current = null;
            dragRef.current = null;
            setTempErasing(false);
            moveRingRef.current(0, 0, false);
          }
          rightHoldRef.current = null;
          suppressCtxMenu.current = true;
          e.preventDefault();
          e.stopPropagation();
          onToolChordRef.current?.(e.clientX, e.clientY);
          return;
        }
      }
      const hold = rightHoldRef.current;
      if (!hold || e.pointerId !== hold.pointerId) return;
      if ((e.buttons & 1) !== 0) return;
      if (Math.hypot(e.clientX - hold.x, e.clientY - hold.y) < 8) return;
      rightHoldRef.current = null;
      beginPan(e, "right");
    };

    const onRightUp = (e: PointerEvent) => {
      if (rightHoldRef.current && e.pointerId === rightHoldRef.current.pointerId) rightHoldRef.current = null;
      // A finished right-click erase stays. Only a left click while it is still held becomes the wheel.
      if (e.button === 2) eraseChordRef.current = null;
    };

    const onContextMenu = (e: MouseEvent) => {
      if (suppressCtxMenu.current) {
        e.preventDefault();
        e.stopPropagation();
        suppressCtxMenu.current = false;
        return;
      }
      const t = e.target as Element | null;
      if (t?.closest?.("table.plt, .pdf-page")) return;
      e.preventDefault();
      openObjMenu.current(e);
    };

    // Block the browser's middle-click autoscroll affordance.
    const onAuxClick = (e: MouseEvent) => {
      if (e.button === 1) e.preventDefault();
    };

    const onPenUp = (e: PointerEvent) => {
      if (e.pointerType !== "pen" || !penSettingsRef.current.pen_enabled) return;
      penDownRef.current = false;
      lastPenAt.current = performance.now();
    };

    const stopDrag = (ev: Event) => ev.preventDefault();
    el.addEventListener("pointerdown", onDown, { capture: true, passive: false });
    el.addEventListener("pointermove", onRightMove, { capture: true, passive: false });
    el.addEventListener("contextmenu", onContextMenu, true);
    el.addEventListener("auxclick", onAuxClick, true);
    el.addEventListener("dragstart", stopDrag);
    window.addEventListener("pointerup", onPenUp, true);
    window.addEventListener("pointerup", onRightUp, true);
    window.addEventListener("pointercancel", onPenUp, true);
    window.addEventListener("pointercancel", onRightUp, true);
    return () => {
      el.removeEventListener("pointerdown", onDown, true);
      el.removeEventListener("pointermove", onRightMove, true);
      el.removeEventListener("contextmenu", onContextMenu, true);
      el.removeEventListener("auxclick", onAuxClick, true);
      el.removeEventListener("dragstart", stopDrag);
      window.removeEventListener("pointerup", onPenUp, true);
      window.removeEventListener("pointerup", onRightUp, true);
      window.removeEventListener("pointercancel", onPenUp, true);
      window.removeEventListener("pointercancel", onRightUp, true);
    };
  }, []);

  useEffect(() => {
    let alive = true;
    const load = () => {
      void api.getSettings().then((s) => {
        if (!alive) return;
        const next = penSettingsFrom(s);
        penSettingsRef.current = next;
        setPenSettings((cur) =>
          cur.pen_enabled === next.pen_enabled &&
          cur.pen_always_draws === next.pen_always_draws &&
          cur.pen_pressure === next.pen_pressure &&
          cur.palm_rejection === next.palm_rejection
            ? cur
            : next,
        );
      }).catch(() => {});
    };
    load();
    window.addEventListener("paperlike-settings-changed", load);
    return () => {
      alive = false;
      window.removeEventListener("paperlike-settings-changed", load);
    };
  }, []);

  // Hover tracking is the extra listener. It stays off when pen input is disabled.
  useEffect(() => {
    if (!penSettings.pen_enabled) {
      penHoverRef.current = false;
      penDownRef.current = false;
      return;
    }
    const el = wrapRef.current;
    if (!el) return;
    const mark = (e: PointerEvent) => {
      if (e.pointerType !== "pen") return;
      penHoverRef.current = true;
      lastPenAt.current = performance.now();
    };
    const leave = (e: PointerEvent) => {
      if (e.pointerType !== "pen") return;
      penHoverRef.current = false;
      lastPenAt.current = performance.now();
    };
    el.addEventListener("pointerover", mark);
    el.addEventListener("pointermove", mark);
    el.addEventListener("pointerleave", leave);
    return () => {
      el.removeEventListener("pointerover", mark);
      el.removeEventListener("pointermove", mark);
      el.removeEventListener("pointerleave", leave);
      penHoverRef.current = false;
    };
  }, [penSettings.pen_enabled]);

  // Windows often ends the pen pointer after a short mark and continues the same
  // stroke as mouse moves. pointerrawupdate carries the samples pointermove drops.
  useEffect(() => {
    const onSample = (e: Event) => {
      const ev = e as PointerEvent;
      const d = dragRef.current;
      if (!d) return;
      if (d.mode === "lasso" && d.pen) {
        if (ev.pointerType !== "pen" && ev.pointerType !== "mouse") return;
        if (ev.cancelable) ev.preventDefault();
        followLassoRef.current(ev);
        return;
      }
      if (d.mode !== "draw" || !d.pen) return;
      if (ev.pointerType !== "pen" && ev.pointerType !== "mouse") return;
      if (ev.cancelable) ev.preventDefault();
      followDrawRef.current(ev);
    };
    const onLassoUp = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d || d.mode !== "lasso" || !d.pen) return false;
      if (e.pointerType === "pen") {
        e.preventDefault();
        e.stopPropagation();
        d.pointerId = -1;
        window.clearTimeout(penLiftRef.current);
        penLiftRef.current = window.setTimeout(() => {
          if (dragRef.current !== d) return;
          endStrokeRef.current(e);
        }, 120);
        return true;
      }
      if (d.pointerId != null && d.pointerId >= 0 && e.pointerId !== d.pointerId) return false;
      e.preventDefault();
      e.stopPropagation();
      window.clearTimeout(penLiftRef.current);
      endStrokeRef.current(e);
      return true;
    };
    const handoff = (e: PointerEvent) => {
      if (onLassoUp(e)) return;
      const d = dragRef.current;
      if (!d || d.mode !== "draw" || !d.pen || d.closing) return;
      if (d.pointerId >= 0 && e.pointerId !== d.pointerId && e.pointerType !== "pen") return;
      e.preventDefault();
      e.stopPropagation();
      d.pointerId = -1;
      window.clearTimeout(penLiftRef.current);
      penLiftRef.current = window.setTimeout(() => {
        if (dragRef.current !== d) return;
        d.closing = true;
        d.pointerId = e.pointerId;
        endStrokeRef.current(e);
      }, 120);
    };
    const onUp = (e: PointerEvent) => {
      if (onLassoUp(e)) return;
      const d = dragRef.current;
      if (!d || d.mode !== "draw" || !d.pen) return;
      if (e.pointerType === "pen") {
        handoff(e);
        return;
      }
      // A mouse up before that mouse was adopted is the compatibility click Windows
      // sends with the pen lift. Committing it ends the stroke at the first mark.
      if (d.pointerId < 0 || e.pointerId !== d.pointerId) return;
      e.preventDefault();
      e.stopPropagation();
      window.clearTimeout(penLiftRef.current);
      d.closing = true;
      endStrokeRef.current(e);
    };
    window.addEventListener("pointerrawupdate", onSample, { capture: true, passive: false });
    window.addEventListener("pointermove", onSample, { capture: true, passive: false });
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", handoff, true);
    return () => {
      window.removeEventListener("pointerrawupdate", onSample, { capture: true });
      window.removeEventListener("pointermove", onSample, { capture: true });
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", handoff, true);
      window.clearTimeout(penLiftRef.current);
    };
  }, []);

  /* ── keyboard ── */
  useEffect(() => {
    const inEditable = () => {
      const ae = document.activeElement as HTMLElement | null;
      return !!ae && (ae.isContentEditable || ae.tagName === "INPUT" || ae.tagName === "TEXTAREA");
    };
    const down = (e: KeyboardEvent) => {
      if (!canEdit) return;
      // Note list / filter own the arrow keys (they switch notes, not nudge objects).
      if (e.key.startsWith("Arrow") && (document.activeElement as HTMLElement | null)?.closest?.(".sidebar")) return;
      if (e.code === "Space" && !inEditable()) {
        // Space after a deselect-click should type a space, not arm pan.
        if (!(pendingTypeAt.current && tool === "select" && !e.ctrlKey && !e.metaKey && !e.altKey)) {
          setSpaceDown(true);
        }
      }
      if (e.key === "Escape") {
        setSelected([]);
        pendingTypeAt.current = null;
      }
      if (e.ctrlKey && e.key === "0" && !lockedRef.current) {
        setCam({ x: 60, y: 40, z: 1 });
      }
      // Ctrl+A: when not editing text, select every object on the canvas
      if (e.ctrlKey && (e.key === "a" || e.key === "A") && !inEditable()) {
        e.preventDefault();
        pendingTypeAt.current = null;
        setSelected(objects.map((o) => o.id));
        return;
      }
      // Ctrl+V is owned by the paste event when the webview delivers one. If it
      // never arrives (focus was on a button), paste the object clipboard anyway.
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === "v" || e.key === "V") && !inEditable()) {
        const gen = ++pasteGenRef.current;
        window.setTimeout(() => {
          if (pasteGenRef.current !== gen || !objectClip) return;
          const ae = document.activeElement as HTMLElement | null;
          if (ae && (ae.isContentEditable || ae.tagName === "INPUT" || ae.tagName === "TEXTAREA")) return;
          pasteObjects();
        }, 60);
      }
      if ((e.key === "Delete" || e.key === "Backspace") && selected.length) {
        const ae = document.activeElement as HTMLElement | null;
        const inField = !!ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA");
        if (inField) return;
        const boxMode = selected.length > 1 || !!highlightedTextId;
        if (boxMode || !inEditable()) {
          e.preventDefault();
          e.stopImmediatePropagation();
          ae?.blur();
          const targets = selected.filter((id) => e.shiftKey || !objects.find((x) => x.id === id)?.locked);
          if (!targets.length) return;
          snapshot("delete");
          updateObjects((objs) => {
            const drop = new Set(targets);
            for (const id of targets) {
              const o = objs.find((x) => x.id === id);
              if (o?.type === "group") o.children.forEach((c) => drop.add(c));
            }
            return objs.filter((o) => !drop.has(o.id));
          });
          setSelected([]);
          pendingTypeAt.current = null;
          return;
        }
      }
      if (
        selected.length &&
        e.key.startsWith("Arrow") &&
        (selected.length > 1 || !!highlightedTextId || !inEditable())
      ) {
        e.preventDefault();
        const d = e.shiftKey ? 10 : 1;
        const dx = e.key === "ArrowLeft" ? -d : e.key === "ArrowRight" ? d : 0;
        const dy = e.key === "ArrowUp" ? -d : e.key === "ArrowDown" ? d : 0;
        const free = selected.filter((id) => e.shiftKey || !objects.find((x) => x.id === id)?.locked);
        if (!free.length) return;
        snapshot("nudge", 700);
        updateObjects((objs) =>
          objs.map((o) => (free.includes(o.id) ? { ...o, x: o.x + dx, y: o.y + dy } : o)),
        );
        return;
      }
      // After a deselect-click on empty canvas: first printable key opens a text box there.
      if (
        !inEditable() &&
        tool === "select" &&
        pendingTypeAt.current &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey
      ) {
        const printable = e.key.length === 1;
        if (printable || e.key === "Enter") {
          e.preventDefault();
          const pt = pendingTypeAt.current;
          createTextAtRef.current(pt.x, pt.y, printable ? e.key : "");
        }
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") setSpaceDown(false);
    };
    const takeObjectClip = (e: ClipboardEvent, cut: boolean) => {
      if (!canEdit || inEditable()) return;
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && sel.toString().trim()) return;
      const ids = selectedRef.current;
      if (!ids.length) return;
      e.preventDefault();
      e.stopPropagation();
      copyObjects(ids);
      try {
        e.clipboardData?.setData("text/plain", OBJECT_CLIP_MARKER);
      } catch {
        /* the clipboard may refuse a custom payload */
      }
      if (cut) deleteIds(ids);
    };
    const onCopyEvt = (e: ClipboardEvent) => takeObjectClip(e, false);
    const onCutEvt = (e: ClipboardEvent) => takeObjectClip(e, true);
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up);
    window.addEventListener("copy", onCopyEvt, true);
    window.addEventListener("cut", onCutEvt, true);
    return () => {
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up);
      window.removeEventListener("copy", onCopyEvt, true);
      window.removeEventListener("cut", onCutEvt, true);
    };
  }, [selected, updateObjects, snapshot, objects, tool, highlightedTextId, copyObjects, deleteIds, pasteObjects, canEdit]);

  useEffect(() => {
    const onPasteEvt = (e: ClipboardEvent) => handlePasteRef.current(e);
    window.addEventListener("paste", onPasteEvt, true);
    return () => window.removeEventListener("paste", onPasteEvt, true);
  }, []);

  if (tool === "pen" || tool === "highlighter") {
    lastInk.current = { hl: tool === "highlighter", color: drawColor, width: drawWidth };
  }
  spaceRef.current = spaceDown;
  beginPenStrokeRef.current = (e: PointerEvent) => {
    if (!canEdit || spaceRef.current) return;
    const open = dragRef.current;
    if (open?.mode === "draw" && open.pen && !open.closing) {
      window.clearTimeout(penLiftRef.current);
      open.closing = true;
      open.pointerId = e.pointerId;
      endStrokeRef.current(e);
    }
    e.preventDefault();
    e.stopPropagation();
    const r = wrapRef.current?.getBoundingClientRect();
    if (!r) return;
    const c = camRef.current;
    const pt = { x: (e.clientX - r.left - c.x) / c.z, y: (e.clientY - r.top - c.y) / c.z };
    const hl = lastInk.current.hl;
    const recordPressure = penSettingsRef.current.pen_pressure && !hl;
    setSelected([]);
    setAdjustId(null);
    onLiveDrawRef.current?.(null);
    dragRef.current = {
      mode: "draw",
      pts: [[0, 0]],
      ...(recordPressure ? { pressure: [readPressure(e)] } : {}),
      sx: pt.x,
      sy: pt.y,
      hl,
      groupId: groupAtPoint(objectsRef.current, pt.x, pt.y, boxOf),
      pen: true,
      pointerId: e.pointerId,
      color: lastInk.current.color,
      width: lastInk.current.width,
    };
    // Do not capture the pen. WebView2 freezes clientX/clientY after capture.
    forceRender((n) => n + 1);
  };

  /* ── pointer on empty canvas ── */
  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as Element | null)?.closest?.(".menu")) return;
    if (document.querySelector(".menu")) menuDismissRef.current = true;
    if (penBlocksTouch(e.pointerType, penSettingsRef.current, penDownRef.current, penHoverRef.current, lastPenAt.current)) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (!canEdit) {
      if (e.button === 0 && spaceDown && !lockedView) {
        dragRef.current = { mode: "pan", sx: e.clientX, sy: e.clientY, moved: 0, via: "space" };
        setPanning(true);
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      }
      return;
    }
    if (e.button === 1 || e.button === 2) return; // handled in capture listener
    if (e.button === 0 && spaceDown && !lockedView) {
      dragRef.current = { mode: "pan", sx: e.clientX, sy: e.clientY, moved: 0, via: "space" };
      setPanning(true);
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      return;
    }
    if (e.button !== 0) return;
    const hitEl = e.target as Element | null;
    if (hitEl?.closest?.(".ctrl-handle, .draw-grip, .shape-hit")) return;
    const pt = toCanvas(e.clientX, e.clientY);
    // preventDefault stops WebView2 from starting a native drag. Rapid clicks
    // while drawing otherwise leave the red "no entry" cursor until the next click.
    e.preventDefault();
    if (e.pointerType !== "pen") {
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch {
        /* already gone */
      }
    }

    if (tool === "pen" || tool === "highlighter" || tool === "smart" || (penSettingsRef.current.pen_enabled && e.pointerType === "pen" && penSettingsRef.current.pen_always_draws)) {
      const open = dragRef.current;
      if (open?.mode === "draw" && open.pen && !open.closing) {
        window.clearTimeout(penLiftRef.current);
        open.closing = true;
        open.pointerId = e.pointerId;
        endStrokeRef.current(e.nativeEvent);
      }
      const inkTool = tool === "pen" || tool === "highlighter" || tool === "smart";
      const hl = tool === "highlighter" || (!inkTool && lastInk.current.hl);
      const penOn = penSettingsRef.current.pen_enabled && e.pointerType === "pen";
      const recordPressure = penOn && penSettingsRef.current.pen_pressure && !hl;
      // Don't rebuild the page before the first sample. The stroke paints on
      // its own SVG; selection chrome clears after the ink is already down.
      startTransition(() => {
        setSelected([]);
        setAdjustId(null);
      });
      const draw: Drag = {
        mode: "draw",
        pts: [[0, 0]],
        ...(recordPressure ? { pressure: [readPressure(e.nativeEvent)] } : {}),
        sx: pt.x,
        sy: pt.y,
        hl,
        groupId: groupAtPoint(objects, pt.x, pt.y, boxOf),
        pen: penOn && tool !== "smart",
        pointerId: e.pointerId,
        ...(hl ? { opacity: hlOpacity } : {}),
        ...(tool === "smart" ? { smart: true, times: [performance.now()] } : {}),
        ...(inkTool ? {} : { color: lastInk.current.color, width: lastInk.current.width }),
      };
      dragRef.current = draw;
      paintLiveInk(draw);
      return;
    }
    if (tool === "lasso") {
      const hitDraw = (e.target as Element | null)?.closest?.(
        ".draw-obj, .text-window, .img-obj, .pdf-obj, .fold, .sel-move, .draw-grip, .drag-bar, .fold-grip",
      );
      if (hitDraw) return;
      onLiveDrawRef.current?.(null);
      setAdjustId(null);
      const additive = e.ctrlKey || e.metaKey || e.getModifierState("Control") || e.getModifierState("Meta");
      dragRef.current = { mode: "lasso", pts: [[pt.x, pt.y]], additive };
      forceRender((n) => n + 1);
      return;
    }
    if (tool === "eraser") {
      const d: Drag = { mode: "erase", last: [pt.x, pt.y], snapped: false, temp: false, pointerId: e.pointerId };
      dragRef.current = d;
      eraseStep(d, [pt.x, pt.y]);
      return;
    }
    if (tool === "rect" || tool === "ellipse" || tool === "line") {
      setAdjustId(null);
      onLiveDrawRef.current?.(null);
      setSelected([]);
      dragRef.current = {
        mode: "shape",
        shape: tool,
        sx: pt.x,
        sy: pt.y,
        cx: pt.x,
        cy: pt.y,
        groupId: groupAtPoint(objects, pt.x, pt.y, boxOf),
      };
      forceRender((n) => n + 1);
      return;
    }
    if (tool === "arrow") {
      setAdjustId(null);
      onLiveDrawRef.current?.(null);
      setSelected([]);
      const free = arrowMode !== "straight";
      dragRef.current = {
        mode: "arrow",
        sx: pt.x,
        sy: pt.y,
        cx: pt.x,
        cy: pt.y,
        groupId: groupAtPoint(objects, pt.x, pt.y, boxOf),
        ...(free ? { free: true, pts: [[pt.x, pt.y] as [number, number]] } : {}),
      };
      forceRender((n) => n + 1);
      return;
    }

    // Select tool on empty canvas: drag → marquee. A plain click with nothing
    // selected opens a text box; a click that clears a selection only deselects.
    e.preventDefault();
    onLiveDrawRef.current?.(null);
    setAdjustId(null);
    const editing = !!(document.activeElement as HTMLElement | null)?.closest?.(".content");
    const hadSelection = selected.length > 0 || editing;
    (document.activeElement as HTMLElement | null)?.blur();
    const additive = e.ctrlKey || e.metaKey || e.getModifierState("Control") || e.getModifierState("Meta");
    // preventDefault on pointerdown stops the browser click count, so e.detail
    // stays 1 and a double-click never opened a box. Time the two presses.
    const now = performance.now();
    const prevClick = lastEmptyClick.current;
    const repeated = now - prevClick.t < 500 && Math.hypot(pt.x - prevClick.x, pt.y - prevClick.y) < 14;
    if (!additive) lastEmptyClick.current = { t: now, x: pt.x, y: pt.y };
    const spawned =
      now - spawnedTextRef.current.t < 600 &&
      Math.hypot(pt.x - spawnedTextRef.current.x, pt.y - spawnedTextRef.current.y) < 28;
    if (spawned) return;
    if (!additive && (e.detail >= 2 || repeated)) {
      createTextAt(pt.x, pt.y);
      return;
    }
    if (!additive) setSelected([]);
    focusCanvas();
    dragRef.current = {
      mode: "marquee",
      sx: pt.x,
      sy: pt.y,
      cx: pt.x,
      cy: pt.y,
      base: additive ? [...selected] : [],
      additive,
      hadSelection,
    };
    forceRender((n) => n + 1);
  };
  onPointerDownRef.current = onPointerDown;

  const createTextAt = (x: number, y: number, initial = "", history = true) => {
    pendingTypeAt.current = null;
    spawnedTextRef.current = { t: performance.now(), x, y };
    const id = newId("t");
    const text: TextObject = {
      type: "text",
      id,
      x,
      y: y - 14,
      z: maxZ() + 1,
      width: 120,
      fit_width: true,
      blocks: [
        {
          kind: "p",
          indent: 0,
          bullet: null,
          align: "left",
          runs: [
            {
              text: initial,
              font: defaultFont,
              size: defaultSize,
              ...(defaultColor ? { color: defaultColor } : {}),
            },
          ],
        },
      ],
    };
    pendingTextRef.current = initial ? null : id;
    // A click that is abandoned (blur deletes the empty box) must not push an undo step.
    if (history || initial) snapshot("create-text");
    updateObjects((objs) => placeNew(objs, text, x, y, boxOf));
    // A new box opens in text-edit mode (caret), never in whole-window select mode.
    onTextEditStart?.(id);
    setSelected([id]);
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(`[data-oid="${id}"] .content`);
      if (!el) return;
      el.style.fontFamily = defaultFont;
      el.style.fontSize = `${defaultSize}pt`;
      if (defaultColor) el.style.color = defaultColor;
      el.focus();
      const sel = window.getSelection();
      if (!sel) return;
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    });
  };
  createTextAtRef.current = createTextAt;

  const objectAtPoint = (x: number, y: number): string | null => {
    const hidden = collapsedIds(objectsRef.current);
    let best: CanvasObject | null = null;
    for (const o of objectsRef.current) {
      if (hidden.has(o.id) || blockedByFold(objectsRef.current, o, boxOf)) continue;
      let hit = false;
      if (o.type === "group") {
        const b = o.collapsed ? collapsedBox(o) : groupFrame(o, objectsRef.current, boxOf);
        hit = x >= b.x && y >= b.y && x <= b.x + b.w && y <= b.y + b.h;
      } else if (o.type === "drawing") {
        // Hit the ink, not the padded selection frame. Overlapping frames made
        // a click land on a neighbour when many small strokes were selected.
        hit = drawingTouchesRect(o, x - 2, y - 2, x + 2, y + 2);
      } else {
        const b = objectBBox(o, heightsRef.current);
        hit = x >= b.x && y >= b.y && x <= b.x + b.w && y <= b.y + b.h;
      }
      if (hit && (!best || o.z >= best.z)) best = o;
    }
    return best?.id ?? null;
  };

  const marqueeHits = (d: Extract<Drag, { mode: "marquee" }>): string[] => {
    const x1 = Math.min(d.sx, d.cx);
    const y1 = Math.min(d.sy, d.cy);
    const x2 = Math.max(d.sx, d.cx);
    const y2 = Math.max(d.sy, d.cy);
    const hitsRect = (b: { x: number; y: number; w: number; h: number }) =>
      b.x < x2 && b.x + b.w > x1 && b.y < y2 && b.y + b.h > y1;
    const hidden = collapsedIds(objects);
    const startedIn = groupAtPoint(objects, d.sx, d.sy, boxOf);
    const wholeFold = new Set<string>();
    for (const o of objects) {
      if (o.type !== "group" || o.collapsed || o.id === startedIn) continue;
      const frame = groupFrame(o, objects, boxOf);
      const childHit = (o.children ?? []).some((id) => {
        const child = objects.find((c) => c.id === id);
        if (!child || child.type === "group") return false;
        if (child.type === "drawing") return drawingTouchesRect(child, x1, y1, x2, y2);
        return hitsRect(objectBBox(child, heightsRef.current));
      });
      if (hitsRect(frame) || childHit) wholeFold.add(o.id);
    }
    return objects
      .filter((o) => {
        if (hidden.has(o.id) || blockedByFold(objects, o, boxOf)) return false;
        if (o.locked && !shiftRef.current) return false;
        if (o.type === "group") {
          if (o.collapsed) return hitsRect(collapsedBox(o));
          return wholeFold.has(o.id);
        }
        const parent = groupOf(objects, o.id);
        if (parent && wholeFold.has(parent)) return false;
        if (o.type === "drawing") return drawingTouchesRect(o, x1, y1, x2, y2);
        return hitsRect(objectBBox(o, heightsRef.current));
      })
      .map((o) => o.id);
  };

  /** Ink for the stroke in progress. Updating the path avoids a full page render on each sample. */
  const paintLiveInk = (d: Extract<Drag, { mode: "draw" }>) => {
    const svg = liveInkRef.current;
    const path = liveInkPathRef.current;
    if (!svg || !path) return;
    const width = d.width ?? drawWidth;
    const color = d.color ?? drawColor;
    const pts = d.smart ? smoothPoints(d.pts, 1) : d.pts;
    svg.style.display = "block";
    svg.style.left = `${d.sx}px`;
    svg.style.top = `${d.sy}px`;
    svg.classList.toggle("hl", !!d.hl);
    const marker = d.hl && pts.length >= 2 ? strokeOutline(pts, undefined, width, false) : [];
    const outlined =
      !d.hl && d.pressure && d.pressure.length === pts.length && pts.length >= 2
        ? strokeOutline(pts, d.pressure, width)
        : [];
    if (marker.length >= 3) {
      path.setAttribute("d", outlinePath(marker));
      path.setAttribute("fill", color);
      path.setAttribute("stroke", "none");
      path.style.fillOpacity = String(d.opacity ?? hlOpacity);
      return;
    }
    if (outlined.length >= 3) {
      path.setAttribute("d", outlinePath(outlined));
      path.setAttribute("fill", color);
      path.setAttribute("stroke", "none");
      path.style.fillOpacity = "1";
      return;
    }
    const dot = pts.length < 2;
    path.setAttribute("d", dot ? "M 0 0 L 0.01 0" : strokePath(pts));
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", color);
    path.setAttribute("stroke-width", String(width));
    path.setAttribute("stroke-linecap", dot || !d.hl ? "round" : "butt");
    path.setAttribute("stroke-linejoin", "round");
    path.style.fillOpacity = "1";
  };

  /** Add samples to the stroke in progress. Used by pointermove and by pointerrawupdate. */
  const followDraw = (e: PointerEvent) => {
    const d = dragRef.current;
    if (!d || d.mode !== "draw") return;
    if (d.pointerId < 0) {
      const down = (e.buttons & 1) !== 0 || (e.pointerType === "pen" && e.pressure > 0);
      if (!down) return;
      d.pointerId = e.pointerId;
      window.clearTimeout(penLiftRef.current);
    } else if (e.pointerId !== d.pointerId) return;
    if (d.pen && !e.shiftKey) {
      let grew = false;
      for (const ev of coalescedEvents(e)) {
        const c = toCanvas(ev.clientX, ev.clientY);
        const x = c.x - d.sx;
        const y = c.y - d.sy;
        const tip = d.pts[d.pts.length - 1];
        // A stuck WebView2 event repeats the contact point after the tip has moved.
        if (tip && d.pts.length > 4 && Math.hypot(tip[0], tip[1]) > 12 && Math.hypot(x, y) < 2) continue;
        if (pushPenSample(d.pts, d.pressure, x, y, d.pressure ? readPressure(ev) : null)) grew = true;
      }
      if (grew) paintLiveInk(d);
      return;
    }
    const pt = toCanvas(e.clientX, e.clientY);
    let p: [number, number] = [pt.x - d.sx, pt.y - d.sy];
    if (e.shiftKey) {
      const len = Math.hypot(p[0], p[1]);
      const a = Math.atan2(p[1], p[0]);
      const snap = Math.round(a / (Math.PI / 4)) * (Math.PI / 4);
      if (Math.abs(a - snap) < (8 * Math.PI) / 180) p = [Math.cos(snap) * len, Math.sin(snap) * len];
      d.pts = [[0, 0], p];
      if (d.times) d.times = [d.times[0] ?? performance.now(), performance.now()];
      if (d.pressure) d.pressure = [d.pressure[0] ?? 0.5, readPressure(e)];
      paintLiveInk(d);
      return;
    }
    const prev = d.pts[d.pts.length - 1];
    if (Math.hypot(p[0] - prev[0], p[1] - prev[1]) * camRef.current.z < 0.45) return;
    d.pts.push(p);
    if (d.times) d.times.push(performance.now());
    paintLiveInk(d);
  };
  followDrawRef.current = followDraw;

  const followLasso = (e: PointerEvent) => {
    const d = dragRef.current;
    if (!d || d.mode !== "lasso") return;
    if (d.pointerId != null && d.pointerId < 0) {
      if (e.buttons === 0) return;
      d.pointerId = e.pointerId;
      window.clearTimeout(penLiftRef.current);
    }
    if (e.buttons === 0 && e.pointerType !== "pen") return;
    const pt = toCanvas(e.clientX, e.clientY);
    const prev = d.pts[d.pts.length - 1];
    if (Math.hypot(pt.x - prev[0], pt.y - prev[1]) * camRef.current.z < 3.5) return;
    if (pushLassoPoint(d.pts, pt.x, pt.y)) forceRender((n) => n + 1);
  };
  followLassoRef.current = followLasso;
  bumpRef.current = () => forceRender((n) => n + 1);

  onPointerDownRef.current = onPointerDown;

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (tool === "eraser" || d?.mode === "erase") moveRing(e.clientX, e.clientY, true);
    if (!d) {
      // Padlock badge on a locked object under the pointer.
      let hit: string | null = null;
      if (!shiftRef.current && objects.some((o) => o.locked)) {
        const p = toCanvas(e.clientX, e.clientY);
        for (const o of sorted) {
          if (!o.locked) continue;
          const b = boxOf(o);
          if (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) hit = o.id;
        }
      }
      setHoverLocked((cur) => (cur === hit ? cur : hit));
      return;
    }    if (d.mode === "pan") {
      const dx = e.clientX - d.sx;
      const dy = e.clientY - d.sy;
      d.moved += Math.hypot(dx, dy);
      setCam((c) => ({ ...c, x: c.x + dx, y: c.y + dy }));
      d.sx = e.clientX;
      d.sy = e.clientY;
      return;
    }
    const pt = toCanvas(e.clientX, e.clientY);
    if (d.mode === "erase") {
      if (e.pointerId !== d.pointerId) return;
      eraseStep(d, [pt.x, pt.y]);
      return;
    }
    if (d.mode === "marquee") {
      d.cx = pt.x;
      d.cy = pt.y;
      paintMarquee();
      if (marqueeRaf.current) return;
      marqueeRaf.current = requestAnimationFrame(() => {
        marqueeRaf.current = 0;
        const cur = dragRef.current;
        if (!cur || cur.mode !== "marquee") return;
        const hits = [...new Set([...cur.base, ...marqueeHits(cur)])];
        const sel = selectedRef.current;
        if (hits.length !== sel.length || hits.some((id) => !sel.includes(id))) setSelected(hits);
      });
      return;
    }
    if (d.mode === "move") {
      const dx = pt.x - d.sx;
      const dy = pt.y - d.sy;
      if (!d.snapped) {
        if (Math.hypot(dx, dy) < 1.5) return;
        snapshot("move");
        d.snapped = true;
      }
      d.pendingDx = dx;
      d.pendingDy = dy;
      if (dragMoveRaf.current) return;
      dragMoveRaf.current = requestAnimationFrame(() => {
        dragMoveRaf.current = 0;
        const cur = dragRef.current;
        if (!cur || cur.mode !== "move" || cur.pendingDx == null || cur.pendingDy == null) return;
        const mdx = cur.pendingDx;
        const mdy = cur.pendingDy;
        updateObjects((objs) =>
          objs.map((o) => {
            const i = cur.ids.indexOf(o.id);
            if (i < 0) return o;
            return { ...o, x: cur.orig[i].x + mdx, y: cur.orig[i].y + mdy };
          }),
        );
      });
      return;
    }
    if (d.mode === "resize-group") {
      const dx = pt.x - d.sx;
      const dy = pt.y - d.sy;
      updateObjects((objs) =>
        objs.map((o) => {
          if (o.id !== d.id || o.type !== "group") return o;
          let next = o;
          if (d.edge === "e" || d.edge === "se") {
            const newRight = d.ox + d.ow + dx;
            next = { ...next, width: Math.max(80, newRight - o.x) };
          }
          if (d.edge === "w") {
            const newLeft = d.ox + dx;
            const anchorRight = Math.max(o.x + o.width, d.ox + d.ow);
            const x = Math.min(newLeft, anchorRight - 80);
            return { ...o, x, width: anchorRight - x };
          }
          if (d.edge === "s" || d.edge === "se") {
            const newBottom = d.oy + d.oh + dy;
            next = { ...next, min_height: Math.max(48, newBottom - o.y) };
          }
          return next;
        }),
      );
      return;
    }
    if (d.mode === "resize-text") {
      const dx = pt.x - d.sx;
      const dy = pt.y - d.sy;
      let trimmedBlocks: TextObject["blocks"] | undefined;
      if (d.edge === "s" || d.edge === "se") {
        const targetH = Math.max(28, d.oh + dy);
        const win = wrapRef.current?.querySelector(
          `[data-oid="${CSS.escape(d.id)}"]`,
        ) as HTMLElement | null;
        if (win && trimTrailingEmptyToHeight(win, targetH)) {
          const content = win.querySelector(".content") as HTMLElement | null;
          if (content) {
            trimmedBlocks = htmlToBlocks(content);
            heightsRef.current[d.id] = win.offsetHeight;
          }
        }
      }
      updateObjects((objs) =>
        objs.map((o) => {
          if (o.id !== d.id || o.type !== "text") return o;
          let width = o.width;
          let x = o.x;
          let min_height = o.min_height ?? undefined;
          if (d.edge === "e" || d.edge === "se") {
            width = Math.max(60, d.ow + dx);
          } else if (d.edge === "w") {
            width = Math.max(60, d.ow - dx);
            x = d.ox + (d.ow - width);
          }
          if (d.edge === "s" || d.edge === "se") {
            min_height = Math.max(28, d.oh + dy);
          }
          return {
            ...o,
            x,
            width,
            min_height,
            ...(trimmedBlocks ? { blocks: trimmedBlocks } : {}),
            // A sideways drag fixes the width. Typing no longer grows the box.
            ...(d.edge !== "s" ? { fit_width: undefined } : {}),
          };
        }),
      );
      return;
    }
    if (d.mode === "resize-pdf") {
      const dx = pt.x - d.sx;
      const dy = pt.y - d.sy;
      const pageWidth = Math.max(80, d.startW + Math.max(dx, dy / Math.max(0.2, d.aspect)));
      updateObjects((objs) =>
        objs.map((o) => (o.id === d.id && o.type === "pdf" ? { ...o, pageWidth } : o)),
      );
      return;
    }
    if (d.mode === "resize-img") {
      const dx = pt.x - d.sx;
      const dy = pt.y - d.sy;
      updateObjects((objs) =>
        objs.map((o) => {
          if (o.id !== d.id || o.type !== "image") return o;
          if (e.altKey) {
            return { ...o, width: Math.max(24, d.ow + dx), height: Math.max(24, d.oh + dy) };
          }
          const s = Math.max((d.ow + dx) / d.ow, 24 / d.ow);
          return { ...o, width: d.ow * s, height: d.oh * s };
        }),
      );
      return;
    }
    if (d.mode === "lasso") {
      const prev = d.pts[d.pts.length - 1];
      if (Math.hypot(pt.x - prev[0], pt.y - prev[1]) * camRef.current.z < 3.5) return;
      if (pushLassoPoint(d.pts, pt.x, pt.y)) forceRender((n) => n + 1);
      return;
    }
    if (d.mode === "draw") {
      if (d.pen) return;
      if (d.pointerId >= 0 && e.pointerId !== d.pointerId) return;
      followDraw(e.nativeEvent);
      return;
    }
    if (d.mode === "arrow" && d.free && d.pts) {
      const prev = d.pts[d.pts.length - 1];
      if (Math.hypot(pt.x - prev[0], pt.y - prev[1]) * camRef.current.z >= 1.1) d.pts.push([pt.x, pt.y]);
      d.cx = pt.x;
      d.cy = pt.y;
      forceRender((n) => n + 1);
      return;
    }
    if (d.mode === "resize-draw") {
      const dx = d.hx - d.ax;
      const dy = d.hy - d.ay;
      const edgeX = d.handle === "n" || d.handle === "s";
      const edgeY = d.handle === "e" || d.handle === "w";
      let sx = edgeX || Math.abs(dx) < 1 ? 1 : (pt.x - d.ax) / dx;
      let sy = edgeY || Math.abs(dy) < 1 ? 1 : (pt.y - d.ay) / dy;
      // Aspect stays locked. Shift is the way to scale width and height independently.
      if (!e.shiftKey) {
        const s = Math.max(Math.abs(sx), Math.abs(sy));
        sx = Math.sign(sx || 1) * s;
        sy = Math.sign(sy || 1) * s;
      }
      sx = Math.max(-12, Math.min(12, sx));
      sy = Math.max(-12, Math.min(12, sy));
      if (Math.abs(sx) < 0.08) sx = Math.sign(sx || 1) * 0.08;
      if (Math.abs(sy) < 0.08) sy = Math.sign(sy || 1) * 0.08;
      if (!d.snapped) {
        snapshot("resize-draw");
        d.snapped = true;
      }
      const scaled = new Map(d.orig.map((o) => [o.id, scaleDrawing(o, d.ax, d.ay, sx, sy)]));
      updateObjects((objs) => objs.map((o) => scaled.get(o.id) ?? o));
      return;
    }
    if (d.mode === "shape" || d.mode === "arrow") {
      let cx = pt.x;
      let cy = pt.y;
      if (e.shiftKey) {
        const dx = cx - d.sx;
        const dy = cy - d.sy;
        if (d.mode === "shape" && d.shape !== "line") {
          const s = Math.max(Math.abs(dx), Math.abs(dy));
          cx = d.sx + Math.sign(dx || 1) * s;
          cy = d.sy + Math.sign(dy || 1) * s;
        } else {
          const len = Math.hypot(dx, dy);
          const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
          cx = d.sx + Math.cos(a) * len;
          cy = d.sy + Math.sin(a) * len;
        }
      }
      d.cx = cx;
      d.cy = cy;
      forceRender((n) => n + 1);
      return;
    }
    if (d.mode === "ctrl-pt") {
      updateObjects((objs) =>
        objs.map((o) => {
          if (o.id !== d.id || o.type !== "drawing" || o.item.kind !== "arrow") return o;
          const rel: [number, number] = [pt.x - o.x, pt.y - o.y];
          return { ...o, item: { ...o.item, [d.pt]: rel } };
        }),
      );
      return;
    }
    if (d.mode === "resize-shape") {
      let x = d.ox;
      let y = d.oy;
      let w = d.ow;
      let h = d.oh;
      if (d.handle === "se") {
        w = Math.max(3, pt.x - d.ox);
        h = Math.max(3, pt.y - d.oy);
      } else if (d.handle === "sw") {
        w = Math.max(3, d.ox + d.ow - pt.x);
        x = pt.x;
        h = Math.max(3, pt.y - d.oy);
      } else if (d.handle === "ne") {
        w = Math.max(3, pt.x - d.ox);
        h = Math.max(3, d.oy + d.oh - pt.y);
        y = pt.y;
      } else if (d.handle === "nw") {
        w = Math.max(3, d.ox + d.ow - pt.x);
        h = Math.max(3, d.oy + d.oh - pt.y);
        x = pt.x;
        y = pt.y;
      } else if (d.handle === "n") {
        h = Math.max(3, d.oy + d.oh - pt.y);
        y = pt.y;
      } else if (d.handle === "s") {
        h = Math.max(3, pt.y - d.oy);
      } else if (d.handle === "e") {
        w = Math.max(3, pt.x - d.ox);
      } else if (d.handle === "w") {
        w = Math.max(3, d.ox + d.ow - pt.x);
        x = pt.x;
      }
      updateObjects((objs) =>
        objs.map((o) => {
          if (o.id !== d.id || o.type !== "drawing" || o.item.kind !== "shape") return o;
          return { ...o, x, y, item: { ...o.item, w, h } };
        }),
      );
      return;
    }
  };
  onPointerMoveRef.current = onPointerMove;

  const onPointerUp = (e: React.PointerEvent) => {
    const dismissMenu = menuDismissRef.current;
    menuDismissRef.current = false;
    const d = dragRef.current;
    // A pen pointerup is not the end of the stroke. Windows continues it as mouse input.
    if (d?.mode === "draw" && d.pen && !d.closing && e.pointerType === "pen") return;
    if (d?.mode === "draw" && d.pointerId >= 0 && e.pointerId !== d.pointerId) return;
    if (d?.mode === "erase" && e.pointerId !== d.pointerId) return;
    dragRef.current = null;
    if (marqueeRaf.current) {
      cancelAnimationFrame(marqueeRaf.current);
      marqueeRaf.current = 0;
    }
    if (marqueeElRef.current) marqueeElRef.current.style.display = "none";
    if (liveInkRef.current) liveInkRef.current.style.display = "none";
    if (panning) setPanning(false);
    if (!d) return;
    if (d.mode === "pan") {
      // Right-drag that actually moved → eat the following contextmenu event.
      if (d.via === "right" && d.moved > 4) suppressCtxMenu.current = true;
      return;
    }
    if (d.mode === "erase") {
      if (d.temp) {
        setTempErasing(false);
        moveRing(0, 0, false);
      }
      return;
    }
    if (d.mode === "move") {
      setMovingIds([]);
      if (!d.snapped && d.toggleGroup) {
        const id = d.toggleGroup;
        snapshot("fold");
        updateObjects((objs) =>
          objs.map((o) => {
            if (o.type !== "group" || o.id !== id) return o;
            if (o.collapsed) return { ...o, collapsed: false };
            const frame = groupFrame(o, objs, boxOf);
            return { ...o, collapsed: true, ...markerOnChevron(frame) };
          }),
        );
      }
      return;
    }
    if (d.mode === "resize-text") {
      setResizingId(null);
      return;
    }
    if (d.mode === "marquee") {
      focusCanvas();
      const moved = Math.hypot(d.cx - d.sx, d.cy - d.sy) * camRef.current.z;
      if (moved < 4 && d.additive) {
        const hit = objectAtPoint(d.sx, d.sy);
        if (hit) setSelected(d.base.includes(hit) ? d.base.filter((id) => id !== hit) : [...new Set([...d.base, hit])]);
        forceRender((n) => n + 1);
        return;
      }
      const plainClick =
        moved < 4 &&
        !d.additive &&
        canEdit &&
        !dismissMenu &&
        !shiftRef.current &&
        !e.shiftKey &&
        !e.altKey &&
        !e.ctrlKey &&
        !e.metaKey;
      // Selection was already cleared on pointerdown. Only spawn a text box
      // when the click started with nothing selected.
      if (plainClick && !d.hadSelection) {
        createTextAt(d.sx, d.sy, "", false);
        return;
      }
      pendingTypeAt.current = null;
      if (moved >= 4 && selected.length === 1) onWindowSelect?.(selected[0]);
      forceRender((n) => n + 1);
      return;
    }
    if (d.mode === "lasso") {
      const moved = d.pts.reduce((m, p, i) => (i === 0 ? 0 : m + Math.hypot(p[0] - d.pts[i - 1][0], p[1] - d.pts[i - 1][1])), 0);
      if (moved * camRef.current.z < 6) {
        if (!d.additive) {
          setSelected([]);
          onLiveDrawRef.current?.(null);
          setAdjustId(null);
        }
        forceRender((n) => n + 1);
        return;
      }
      const hidden = collapsedIds(objects);
      const loop = lassoLoop(d.pts);
      const boxForLasso = (o: CanvasObject) =>
        o.type === "group"
          ? o.collapsed
            ? collapsedBox(o)
            : { x: 0, y: 0, w: 0, h: 0 }
          : objectBBox(o, heightsRef.current);
      const hits = lassoHits(objects, loop, boxForLasso).filter((id) => {
        const o = objects.find((x) => x.id === id);
        if (!o || hidden.has(id) || blockedByFold(objects, o, boxOf)) return false;
        if (o.type === "group") return o.collapsed;
        return true;
      });
      if (d.additive) {
        const cur = selectedRef.current;
        const onlySelected = hits.length > 0 && hits.every((id) => cur.includes(id));
        if (onlySelected) setSelected(cur.filter((id) => !hits.includes(id)));
        else if (hits.length) setSelected([...new Set([...cur, ...hits])]);
      } else if (hits.length) {
        focusCanvas();
        setSelected(hits);
        if (hits.length === 1) onWindowSelect?.(hits[0]);
      }
      forceRender((n) => n + 1);
      return;
    }
    if (d.mode === "draw") {
      if (d.hl && d.pts.length < 2) {
        forceRender((n) => n + 1);
        return;
      }
      if (d.smart && d.pts.length > 1) {
        const abs = d.pts.map((p) => [p[0] + d.sx, p[1] + d.sy] as [number, number]);
        const refined = refineSmartStroke(abs, d.times);
        const width = d.width ?? drawWidth;
        const color = d.color ?? drawColor;
        let minX = Infinity, minY = Infinity;
        for (const p of refined.points) {
          minX = Math.min(minX, p[0]);
          minY = Math.min(minY, p[1]);
        }
        const obj: DrawingObject = {
          type: "drawing",
          id: newId("d"),
          x: minX,
          y: minY,
          z: maxZ() + 1,
          item: {
            kind: "stroke",
            points: refined.points.map((p) => [p[0] - minX, p[1] - minY]),
            width,
            color,
          },
        };
        snapshot("stroke");
        updateObjects((objs) => [...(d.groupId ? withChild(objs, obj.id, d.groupId) : objs), obj]);
        onLiveDrawRef.current?.(obj.id);
        forceRender((n) => n + 1);
        return;
      }
      const width = d.width ?? drawWidth;
      const color = d.color ?? drawColor;
      const smoothed = d.pen
        ? d.pts.length > 1
          ? smoothInk(d.pts, d.pressure)
          : { pts: d.pts, pressure: d.pressure }
        : { pts: d.pts.length > 1 ? smoothPoints(d.pts) : d.pts, pressure: undefined };
      const raw = smoothed.pts.length > 1 ? smoothed.pts : null;
      const rawPressure =
        raw && !d.hl && smoothed.pressure && smoothed.pressure.length === raw.length ? smoothed.pressure : undefined;
      let minX = Infinity, minY = Infinity;
      for (const p of raw ?? []) {
        minX = Math.min(minX, p[0]);
        minY = Math.min(minY, p[1]);
      }
      // A plain click leaves a dot (i-dots, decimal points, vector dots).
      const dot = dotPoints(width);
      const dotR = dot[0][0] / 2;
      const pts = raw ? raw.map((p) => [p[0] - minX, p[1] - minY] as [number, number]) : dot;
      const off = raw ? [minX, minY] : [-dotR, -dotR];
      const obj: DrawingObject = {
        type: "drawing",
        id: newId("d"),
        x: d.sx + off[0],
        y: d.sy + off[1],
        z: maxZ() + 1,
        item: {
          kind: "stroke",
          points: pts,
          width,
          color,
          ...(d.hl ? { highlighter: true, opacity: d.opacity ?? hlOpacity } : {}),
          ...(rawPressure ? { pressure: rawPressure } : {}),
        },
      };
      snapshot("stroke");
      updateObjects((objs) => [...(d.groupId ? withChild(objs, obj.id, d.groupId) : objs), obj]);
      onLiveDrawRef.current?.(obj.id);
      forceRender((n) => n + 1);
      return;
    }
    if (d.mode === "shape") {
      const x = Math.min(d.sx, d.cx);
      const y = Math.min(d.sy, d.cy);
      const w = Math.abs(d.cx - d.sx);
      const h = Math.abs(d.cy - d.sy);
      if (w > 3 || h > 3) {
        const id = newId("d");
        const item: DrawingItem =
          d.shape === "line"
            ? {
                kind: "arrow",
                tail: [d.sx - x, d.sy - y],
                head: [d.cx - x, d.cy - y],
                c1: [(d.cx - d.sx) / 3 + (d.sx - x), (d.cy - d.sy) / 3 + (d.sy - y)],
                c2: [((d.cx - d.sx) * 2) / 3 + (d.sx - x), ((d.cy - d.sy) * 2) / 3 + (d.sy - y)],
                width: drawWidth,
                color: drawColor,
                head_style: "none",
                tail_style: "none",
              }
            : { kind: "shape", shape: d.shape, w, h, width: drawWidth, color: drawColor, fill: null };
        snapshot("shape");
        const obj: DrawingObject = { type: "drawing", id, x, y, z: maxZ() + 1, item };
        updateObjects((objs) => [...(d.groupId ? withChild(objs, id, d.groupId) : objs), obj]);
        setAdjustId(id);
        onLiveDrawRef.current?.(id);
      }
      forceRender((n) => n + 1);
      return;
    }
    if (d.mode === "arrow") {
      const raw = d.free && d.pts && d.pts.length > 1 ? smoothFreeShaft(d.pts) : null;
      const straight = !raw || shaftIsStraight(raw);
      const a0 = raw && !straight ? raw[0] : ([d.sx, d.sy] as [number, number]);
      const a1 = raw && !straight ? raw[raw.length - 1] : ([d.cx, d.cy] as [number, number]);
      const x = straight
        ? Math.min(a0[0], a1[0])
        : Math.min(...(raw ?? [a0]).map((p) => p[0]));
      const y = straight
        ? Math.min(a0[1], a1[1])
        : Math.min(...(raw ?? [a0]).map((p) => p[1]));
      const tail: [number, number] = [a0[0] - x, a0[1] - y];
      const head: [number, number] = [a1[0] - x, a1[1] - y];
      if (Math.hypot(head[0] - tail[0], head[1] - tail[1]) > 6) {
        const id = newId("d");
        snapshot("arrow");
        const shaft = raw && !straight ? raw.map((p) => [p[0] - x, p[1] - y] as [number, number]) : undefined;
        const obj: DrawingObject = {
          type: "drawing",
          id,
          x,
          y,
          z: maxZ() + 1,
          item: {
            kind: "arrow",
            tail,
            head,
            c1: [tail[0] + (head[0] - tail[0]) / 3, tail[1] + (head[1] - tail[1]) / 3],
            c2: [tail[0] + ((head[0] - tail[0]) * 2) / 3, tail[1] + ((head[1] - tail[1]) * 2) / 3],
            width: drawWidth,
            color: drawColor,
            head_style: arrowHead,
            tail_style: "none",
            ...(arrowBody === "double" ? { body: "double" } : {}),
            ...(shaft ? { shaft } : {}),
          },
        };
        updateObjects((objs) => [...(d.groupId ? withChild(objs, id, d.groupId) : objs), obj]);
        // A free arrow is ink. Straight arrows and the other shapes keep the resize handle.
        if (d.free) setAdjustId(null);
        else setAdjustId(id);
        onLiveDrawRef.current?.(id);
      }
      forceRender((n) => n + 1);
      return;
    }
  };
  onPointerUpRef.current = onPointerUp;
  endStrokeRef.current = (ev: PointerEvent) => {
    onPointerUp({
      pointerId: ev.pointerId,
      pointerType: ev.pointerType,
      button: ev.button,
      buttons: ev.buttons,
      preventDefault() {},
      stopPropagation() {},
      nativeEvent: ev,
    } as unknown as React.PointerEvent);
  };

  /* ── object gestures (called from children) ── */

  /** Grabbing an object must not start a native text-selection drag: if a
   * caret was sitting in some text window, the browser would extend the DOM
   * selection from there across everything the pointer passes. */
  const suppressNativeSelection = (e: React.PointerEvent) => {
    e.preventDefault();
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) sel.removeAllRanges();
  };

  const focusCanvas = () => {
    const ae = document.activeElement as HTMLElement | null;
    if (ae?.closest?.(".content")) ae.blur();
    wrapRef.current?.focus({ preventScroll: true });
  };

  const startMove = (e: React.PointerEvent, id: string, toggleGroup?: string) => {
    if (!canEdit) return;
    // Locked and no Shift: let the press fall through to the canvas (marquee).
    const objsNow = objectsRef.current;
    const selectedNow = selectedRef.current;
    if (!shiftRef.current && objsNow.find((x) => x.id === id)?.locked) return;
    onLiveDrawRef.current?.(null);
    setAdjustId(null);
    e.stopPropagation();
    suppressNativeSelection(e);
    pendingTypeAt.current = null;
    focusCanvas();
    const pt = toCanvas(e.clientX, e.clientY);
    if ((e.ctrlKey || e.metaKey) && selectedNow.includes(id)) {
      setSelected(selectedNow.filter((i) => i !== id));
      return;
    }
    const base = e.ctrlKey || e.metaKey ? [...new Set([...selectedNow, id])] : selectedNow.includes(id) ? selectedNow : [id];
    const ids = [...base];
    for (const mid of base) {
      const o = objsNow.find((x) => x.id === mid);
      if (o?.type === "group") {
        for (const c of o.children) if (!ids.includes(c)) ids.push(c);
      }
    }
    const live = ids.filter((i) => objsNow.some((o) => o.id === i && (shiftRef.current || !o.locked)));
    setSelected(base.filter((i) => objsNow.some((o) => o.id === i)));
    if (base.length === 1) onWindowSelect?.(base[0]);
    setMovingIds(live);
    dragRef.current = {
      mode: "move",
      ids: live,
      orig: live.map((i) => {
        const o = objsNow.find((x) => x.id === i)!;
        return { x: o.x, y: o.y };
      }),
      sx: pt.x,
      sy: pt.y,
      snapped: false,
      toggleGroup,
    };
    wrapRef.current?.setPointerCapture(e.pointerId);
  };

  const startGroupResize = (e: React.PointerEvent, id: string, edge: "w" | "e" | "s" | "se") => {
    if (!canEdit) return;
    if (!shiftRef.current && objects.find((x) => x.id === id)?.locked) return;
    e.stopPropagation();
    suppressNativeSelection(e);
    const o = objects.find((x) => x.id === id);
    if (!o || o.type !== "group") return;
    const f = groupFrame(o, objects, boxOf);
    const pt = toCanvas(e.clientX, e.clientY);
    setSelected([id]);
    snapshot("resize-fold");
    dragRef.current = { mode: "resize-group", id, edge, ox: f.x, oy: f.y, ow: f.w, oh: f.h, sx: pt.x, sy: pt.y };
    wrapRef.current?.setPointerCapture(e.pointerId);
  };

  const toggleGroup = (id: string) => {
    snapshot("fold");
    updateObjects((objs) =>
      objs.map((o) => {
        if (o.type !== "group" || o.id !== id) return o;
        if (o.collapsed) return { ...o, collapsed: false };
        const frame = groupFrame(o, objs, boxOf);
        return { ...o, collapsed: true, ...markerOnChevron(frame) };
      }),
    );
  };

  const setFoldFill = (id: string, fill: number) => {
    snapshot("fold-fill", 500);
    updateObjects((objs) => objs.map((o) => (o.type === "group" && o.id === id ? { ...o, fill } : o)));
  };

  const choosePdf = (id: string, pages: number[], additive: boolean, keepOthers = false) => {
    const curSel = selectedRef.current;
    const curPick = pdfPickRef.current;
    const nextSel = additive || keepOthers ? (curSel.includes(id) ? curSel : [...curSel, id]) : [id];
    const base: Record<string, number[]> = additive || keepOthers ? { ...curPick } : {};
    if (!additive) {
      base[id] = pages;
    } else {
      const set = new Set(curPick[id] ?? []);
      for (const p of pages) {
        if (set.has(p)) set.delete(p);
        else set.add(p);
      }
      if (set.size) base[id] = [...set];
      else delete base[id];
    }
    pdfPickRef.current = base;
    setSelected(nextSel);
    setPdfPick(base);
  };

  const setPdfLayout = (id: string, layout: PdfLayout) => {
    if (!canEdit) return;
    snapshot("pdf-layout");
    updateObjects((objs) => objs.map((o) => (o.id === id && o.type === "pdf" ? { ...o, layout } : o)));
  };

  const startPdfResize = (e: React.PointerEvent, id: string) => {
    if (!canEdit) return;
    if (!shiftRef.current && objects.find((x) => x.id === id)?.locked) return;
    e.stopPropagation();
    suppressNativeSelection(e);
    const o = objects.find((x) => x.id === id);
    if (!o || o.type !== "pdf") return;
    const pt = toCanvas(e.clientX, e.clientY);
    snapshot("resize-pdf");
    dragRef.current = {
      mode: "resize-pdf",
      id,
      startW: o.pageWidth,
      aspect: o.aspects[0] || 1.3,
      sx: pt.x,
      sy: pt.y,
    };
    wrapRef.current?.setPointerCapture(e.pointerId);
  };

  const setLocked = (ids: string[], locked: boolean) => {
    snapshot(locked ? "lock" : "unlock");
    const set = new Set(ids);
    updateObjects((objs) => objs.map((o) => (set.has(o.id) ? { ...o, locked } : o)));
  };

  /** Pull pages out of a joined PDF. `all` makes every page its own object, where it already sits. */
  const splitPdf = (
    id: string,
    mode: "drop" | "all",
    explicit?: { pages: number[]; aspects: number[]; drop: number[] },
  ) => {
    if (!canEdit) return;
    const picked = explicit?.drop ?? pdfPickRef.current[id] ?? [];
    snapshot(mode === "all" ? "pdf-separate" : "pdf-drop");
    // Computed once from the live list (not inside a state updater) so the drop memory below is not double-applied.
    const compute = (objs: CanvasObject[]): CanvasObject[] => {
      const found = objs.find((o) => o.id === id);
      if (!found || found.type !== "pdf") return objs;
      const obj: PdfObject = explicit ? { ...found, pages: explicit.pages, aspects: explicit.aspects } : found;
      const drop = new Set(mode === "all" ? obj.pages : picked);
      if (!drop.size || (mode === "drop" && drop.size === obj.pages.length)) return objs;
      const z0 = objs.reduce((m, o) => Math.max(m, o.z), 0);
      let z = z0;
      const piece = (pages: number[], aspects: number[], x: number, y: number, keepId?: string): PdfObject => {
        const masks = (obj.masks ?? []).filter((m) => pages.includes(m.page));
        return {
          ...obj,
          id: keepId ?? newId("p"),
          pages,
          aspects,
          x,
          y,
          z: keepId ? obj.z : ++z,
          layout: pages.length > 1 ? obj.layout : "stack",
          masks: masks.length ? masks : undefined,
        };
      };
      const kept = obj.pages.map((page, i) => ({ page, aspect: obj.aspects[i] ?? 1.294 })).filter((p) => !drop.has(p.page));
      const replacements: PdfObject[] = [];
      if (kept.length) {
        replacements.push(piece(kept.map((p) => p.page), kept.map((p) => p.aspect), obj.x, obj.y, obj.id));
      }
      if (mode === "all") {
        for (const slot of pdfSlots(obj)) {
          replacements.push(piece([slot.page], [slot.aspect], obj.x + slot.x, obj.y + slot.y));
        }
      } else {
        const taken = obj.pages.map((page, i) => ({ page, aspect: obj.aspects[i] ?? 1.294 })).filter((p) => drop.has(p.page));
        const size = pdfSize(obj);
        const pages = taken.map((p) => p.page);
        const aspects = taken.map((p) => p.aspect);
        const pieceSize = pdfSize({ ...obj, pages, aspects, layout: pages.length > 1 ? obj.layout : "stack" });
        const last = lastDrop.current.get(obj.media);
        let nx = obj.x + size.w + 28;
        let ny = obj.y;
        if (last) {
          // Cascade below the previous drop, then slide down past anything in the way.
          nx = last.x + 24;
          ny = last.y + last.h + obj.gap;
          const hits = (x: number, y: number) =>
            objs.some((o) => {
              if (o.type === "group") return false;
              const b = objectBBox(o, heightsRef.current);
              return x < b.x + b.w && x + pieceSize.w > b.x && y < b.y + b.h && y + pieceSize.h > b.y;
            });
          for (let tries = 0; tries < 50 && hits(nx, ny); tries++) ny += 40;
        }
        replacements.push(piece(pages, aspects, nx, ny));
        lastDrop.current.set(obj.media, { x: nx, y: ny, w: pieceSize.w, h: pieceSize.h });
      }
      const ids = new Set(replacements.map((r) => r.id));
      const next: CanvasObject[] = [];
      for (const o of objs) {
        if (o.id === id) {
          next.push(...replacements);
          continue;
        }
        if (o.type === "group" && o.children.includes(id)) {
          next.push({ ...o, children: o.children.flatMap((c) => (c === id ? [...ids] : [c])) });
          continue;
        }
        next.push(o);
      }
      return next;
    };
    const cur = objectsRef.current;
    const res = compute(cur);
    if (res !== cur) updateObjects(() => res);
    pdfPickRef.current = {};
    setPdfPick({});
  };

  /** Stack every selected piece into one PDF at the top-left piece. */
  const joinSelectedPdfs = (ids: string[]) => {
    if (!canEdit) return;
    const cur = objectsRef.current;
    const pdfs = ids
      .map((id) => cur.find((o) => o.id === id))
      .filter((o): o is PdfObject => !!o && o.type === "pdf");
    if (pdfs.length < 2) return;
    const sortedPdfs = [...pdfs].sort((a, b) => a.y - b.y || a.x - b.x || (a.pages[0] ?? 0) - (b.pages[0] ?? 0));
    if (sortedPdfs.some((p) => p.media !== sortedPdfs[0].media)) {
      void joinDifferentPdfs(sortedPdfs);
      return;
    }
    const sorted = sortedPdfs;
    const anchor = sorted[0];
    const pages = sorted.flatMap((p) => p.pages);
    const aspects = sorted.flatMap((p) => p.pages.map((_, i) => p.aspects[i] ?? 1.294));
    const masks = sorted.flatMap((p) => p.masks ?? []);
    const id = newId("p");
    const joined: PdfObject = {
      type: "pdf",
      id,
      x: anchor.x,
      y: anchor.y,
      z: anchor.z,
      locked: anchor.locked,
      media: anchor.media,
      pages,
      aspects,
      layout: "stack",
      pageWidth: anchor.pageWidth,
      gap: anchor.gap,
      masks: masks.length ? masks : undefined,
    };
    const remove = new Set(pdfs.map((p) => p.id));
    snapshot("pdf-join");
    updateObjects((objs) => {
      const next: CanvasObject[] = [];
      let placed = false;
      for (const o of objs) {
        if (remove.has(o.id)) {
          if (o.id === anchor.id) {
            next.push(joined);
            placed = true;
          }
          continue;
        }
        if (o.type === "group" && o.children.some((c) => remove.has(c))) {
          let injected = false;
          const children: string[] = [];
          for (const c of o.children) {
            if (remove.has(c)) {
              if (!injected) {
                children.push(id);
                injected = true;
              }
            } else children.push(c);
          }
          next.push({ ...o, children });
          continue;
        }
        next.push(o);
      }
      if (!placed) next.push(joined);
      return next;
    });
    pdfPickRef.current = {};
    setPdfPick({});
    setSelected([id]);
  };

  const joinDifferentPdfs = async (sorted: PdfObject[]) => {
    const anchor = sorted[0];
    try {
      const parts = sorted.map((p) => ({
        bytes: b64ToBytes(noteMediaRef.current[p.media] ?? ""),
        pages: p.pages,
      }));
      const merged = await mergePdfParts(parts);
      const media = `media/${newId("m").slice(2)}.pdf`;
      const b64 = bytesToB64(merged.bytes);
      let pageNo = 1;
      const masks = sorted.flatMap((p) => {
        const mapped = (p.masks ?? [])
          .map((m) => {
            const idx = p.pages.indexOf(m.page);
            return idx < 0 ? null : { ...m, page: pageNo + idx };
          })
          .filter((m): m is PdfMask => !!m);
        pageNo += p.pages.length;
        return mapped;
      });
      const id = newId("p");
      const remove = new Set(sorted.map((p) => p.id));
      const joined: PdfObject = {
        type: "pdf",
        id,
        x: anchor.x,
        y: anchor.y,
        z: anchor.z,
        locked: anchor.locked,
        media,
        pages: merged.aspects.map((_, i) => i + 1),
        aspects: merged.aspects,
        layout: "stack",
        pageWidth: anchor.pageWidth,
        gap: anchor.gap,
        masks: masks.length ? masks : undefined,
      };
      snapshot("pdf-join");
      onUpdate((n) => {
        const next: CanvasObject[] = [];
        let placed = false;
        for (const o of n.doc.canvas.objects) {
          if (remove.has(o.id)) {
            if (o.id === anchor.id) {
              next.push(joined);
              placed = true;
            }
            continue;
          }
          if (o.type === "group" && o.children.some((c) => remove.has(c))) {
            let injected = false;
            const children: string[] = [];
            for (const c of o.children) {
              if (remove.has(c)) {
                if (!injected) {
                  children.push(id);
                  injected = true;
                }
              } else children.push(c);
            }
            next.push({ ...o, children });
            continue;
          }
          next.push(o);
        }
        if (!placed) next.push(joined);
        return {
          ...n,
          media_b64: { ...n.media_b64, [media]: b64 },
          doc: { ...n.doc, canvas: { ...n.doc.canvas, objects: next } },
        };
      });
      pdfPickRef.current = {};
      setPdfPick({});
      setSelected([id]);
    } catch {
      /* leave the pages where they are */
    }
  };

  const reorderPdf = (id: string, pages: number[], aspects: number[]) => {
    if (!canEdit) return;
    snapshot("pdf-reorder");
    updateObjects((objs) => objs.map((o) => (o.id === id && o.type === "pdf" ? { ...o, pages, aspects } : o)));
  };

  const setPdfMasks = (id: string, masks: PdfMask[] | undefined, hideNumbers?: boolean) => {
    if (!canEdit) return;
    snapshot("pdf-masks");
    updateObjects((objs) =>
      objs.map((o) => {
        if (o.id !== id || o.type !== "pdf") return o;
        const next: PdfObject = { ...o, masks: masks?.length ? masks : undefined };
        if (hideNumbers === true) next.hideNumbers = true;
        else if (hideNumbers === false) next.hideNumbers = undefined;
        return next;
      }),
    );
  };

  // Canvas space visible through the wrap. Wheel zoom keeps a screen point fixed:
  // canvas = (screen - cam) / zoom, with the world scaled from the origin.
  const pdfView = {
    x: -cam.x / cam.z,
    y: -cam.y / cam.z,
    w: wrapBox.w / cam.z,
    h: wrapBox.h / cam.z,
  };

  const paintPdf = (o: PdfObject, sel: boolean) => (
    <PdfView
      key={o.id}
      obj={o}
      b64={note.media_b64[o.media] ?? ""}
      active={sel}
      chosen={pdfPick[o.id] ?? []}
      zoom={cam.z}
      view={pdfView}
      onChoose={(pages, additive, keepOthers) => choosePdf(o.id, pages, additive, keepOthers)}
      onLayout={(layout) => setPdfLayout(o.id, layout)}
      onDrop={(pages) => splitPdf(o.id, "drop", { pages: o.pages, aspects: o.aspects, drop: pages })}
      onCopy={() => copyObjects(selectedRef.current.includes(o.id) ? selectedRef.current : [o.id])}
      onCut={() => {
        const ids = selectedRef.current.includes(o.id) ? selectedRef.current : [o.id];
        copyObjects(ids);
        deleteIds(ids, true);
      }}
      onPaste={objectClip ? () => pasteObjects() : undefined}
      onFront={() => restack(selectedRef.current.includes(o.id) ? selectedRef.current : [o.id], true)}
      onBack={() => restack(selectedRef.current.includes(o.id) ? selectedRef.current : [o.id], false)}
      onDelete={() => deleteIds(selectedRef.current.includes(o.id) ? selectedRef.current : [o.id], true)}
      onJoin={
        selected.filter((id) => objects.some((x) => x.id === id && x.type === "pdf")).length >= 2
          ? () => joinSelectedPdfs(selectedRef.current)
          : undefined
      }
      onSeparate={() => splitPdf(o.id, "all")}
      onMove={(e) => startMove(e, o.id)}
      onResize={(e) => startPdfResize(e, o.id)}
      editable={canEdit}
      shiftHeld={shiftHeld}
      onToggleLock={() => setLocked([o.id], !o.locked)}
      onReorder={(pages, aspects) => reorderPdf(o.id, pages, aspects)}
      onDropPage={(page, pages, aspects) => splitPdf(o.id, "drop", { pages, aspects, drop: [page] })}
      onMasks={(masks, hideNumbers) => setPdfMasks(o.id, masks, hideNumbers)}
    />
  );

  const startTextResize = (e: React.PointerEvent, id: string, edge: "w" | "e" | "s" | "se") => {
    if (!shiftRef.current && objects.find((x) => x.id === id)?.locked) return;
    e.stopPropagation();
    suppressNativeSelection(e);
    pendingTypeAt.current = null;
    focusCanvas();
    const o = objects.find((x) => x.id === id);
    if (!o || o.type !== "text") return;
    const pt = toCanvas(e.clientX, e.clientY);
    const measured = heightsRef.current[o.id] ?? 40;
    const oh = Math.max(measured, o.min_height ?? 0);
    setSelected([id]);
    onWindowSelect?.(id);
    setResizingId(id);
    snapshot("resize");
    dragRef.current = {
      mode: "resize-text",
      id,
      edge,
      ox: o.x,
      ow: o.width,
      oh,
      sx: pt.x,
      sy: pt.y,
    };
    wrapRef.current?.setPointerCapture(e.pointerId);
  };

  const startDrawResize = (
    e: React.PointerEvent,
    handle: ShapeHandle,
    box: { x: number; y: number; w: number; h: number },
    drawings: DrawingObject[],
  ) => {
    if (!canEdit) return;
    e.stopPropagation();
    e.preventDefault();
    suppressNativeSelection(e);
    const opposite: Record<ShapeHandle, ShapeHandle> = {
      nw: "se", n: "s", ne: "sw", e: "w", se: "nw", s: "n", sw: "ne", w: "e",
    };
    const anchor = shapeHandleAt(opposite[handle], box.w, box.h);
    const at = shapeHandleAt(handle, box.w, box.h);
    dragRef.current = {
      mode: "resize-draw",
      handle,
      ax: box.x + anchor.cx,
      ay: box.y + anchor.cy,
      hx: box.x + at.cx,
      hy: box.y + at.cy,
      sx: 0,
      sy: 0,
      snapped: false,
      orig: drawings.map((o) => ({ ...o, item: { ...o.item } })),
    };
    try {
      wrapRef.current?.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };

  const startImgResize = (e: React.PointerEvent, id: string) => {
    if (!canEdit) return;
    if (!shiftRef.current && objects.find((x) => x.id === id)?.locked) return;
    e.stopPropagation();
    suppressNativeSelection(e);
    const o = objects.find((x) => x.id === id);
    if (!o || o.type !== "image") return;
    const pt = toCanvas(e.clientX, e.clientY);
    snapshot("resize");
    dragRef.current = { mode: "resize-img", id, ow: o.width, oh: o.height, sx: pt.x, sy: pt.y };
    wrapRef.current?.setPointerCapture(e.pointerId);
  };

  const startCtrlPt = (e: React.PointerEvent, id: string, pt: "tail" | "head" | "c1" | "c2") => {
    if (!canEdit) return;
    if (!shiftRef.current && objects.find((x) => x.id === id)?.locked) return;
    e.stopPropagation();
    suppressNativeSelection(e);
    snapshot("curve");
    dragRef.current = { mode: "ctrl-pt", id, pt };
    wrapRef.current?.setPointerCapture(e.pointerId);
  };

  const selectOnly = (e: React.PointerEvent, id: string) => {
    e.stopPropagation();
    e.preventDefault();
    focusCanvas();
    const ctrl = e.ctrlKey || e.metaKey || e.getModifierState("Control") || e.getModifierState("Meta");
    const cur = selectedRef.current;
    if (ctrl) {
      setSelected(cur.includes(id) ? cur.filter((i) => i !== id) : [...cur, id]);
      return;
    }
    setSelected([id]);
    onWindowSelect?.(id);
  };

  /* ── paste image or copied objects ── */
  const onPaste = async (e: ClipboardEvent | React.ClipboardEvent) => {
    if (!canEdit) return;
    const ae = document.activeElement as HTMLElement | null;
    const editing = !!ae && (ae.isContentEditable || ae.tagName === "INPUT" || ae.tagName === "TEXTAREA");
    if (editing) return;
    // A paste event invalidates the keydown fallback, even if this call is the duplicate.
    pasteGenRef.current++;
    if (pasteBusy) return;
    pasteBusy = true;
    try {
      const data = e.clipboardData;
      const text = data?.getData("text/plain") ?? "";
      const items = data?.items;
      if (text !== OBJECT_CLIP_MARKER && items) {
        for (const item of Array.from(items)) {
          if (!item.type.startsWith("image/")) continue;
          const file = item.getAsFile();
          if (!file) continue;
          e.preventDefault();
          e.stopPropagation();
          const b64 = bytesToB64(new Uint8Array(await file.arrayBuffer()));
          const ext = item.type.split("/")[1] || "png";
          const media = `media/${newId("m").slice(2)}.${ext}`;
          const natural = await imageSize(b64);
          const { width, height } = fitImage(natural.width, natural.height);
          const r = wrapRef.current!.getBoundingClientRect();
          const center = toCanvas(r.left + r.width / 2, r.top + r.height / 2);
          const img: ImageObject = {
            type: "image",
            id: newId("i"),
            x: center.x - width / 2,
            y: center.y - height / 2,
            z: maxZ() + 1,
            media,
            width,
            height,
          };
          snapshot("paste-image");
          onUpdate((n) => ({
            ...n,
            media_b64: { ...n.media_b64, [media]: b64 },
            doc: {
              ...n.doc,
              canvas: { ...n.doc.canvas, objects: placeNew(n.doc.canvas.objects, img, img.x + img.width / 2, img.y + img.height / 2, boxOf) },
            },
          }));
          setSelected([img.id]);
          return;
        }
      }
      if (objectClip) {
        e.preventDefault();
        e.stopPropagation();
        pasteObjects();
      }
    } finally {
      pasteBusy = false;
    }
  };
  handlePasteRef.current = (e) => {
    void onPaste(e);
  };

  /* ── text window content committed ── */
  const commitText = useCallback(
    (id: string, el: HTMLElement) => {
      const blocks = htmlToBlocks(el);
      const hasContent =
        blocksPlainText(blocks).trim() !== "" ||
        blocks.some((b) => (b as { kind?: string }).kind === "table") ||
        !!el.querySelector(".pl-math");
      // An empty window is a leftover click, not a note — drop it once it loses focus.
      if (!hasContent && !el.contains(document.activeElement) && document.activeElement !== el) {
        pendingTextRef.current = null;
        updateObjects((objs) => objs.filter((o) => o.id !== id));
        setSelected((s) => s.filter((x) => x !== id));
        return;
      }
      if (hasContent && pendingTextRef.current === id) pendingTextRef.current = null;
      // Tables keep their own column widths; grow the text box to enclose them.
      let tableMin = 0;
      el.querySelectorAll("table.plt").forEach((t) => {
        tableMin = Math.max(tableMin, tableOuterWidth(t as HTMLTableElement) + TABLE_BOX_PAD);
      });
      snapshot(`text:${id}`, 1200);
      updateObjects((objs) =>
        objs.map((o) => {
          if (o.id !== id || o.type !== "text") return o;
          const width = tableMin > o.width ? Math.ceil(tableMin) : o.width;
          return { ...o, blocks, width };
        }),
      );
    },
    [updateObjects, snapshot],
  );

  const growTextWidth = useCallback(
    (id: string, needed: number, source: "type" | "table" = "table") => {
      updateObjects((objs) =>
        objs.map((o) => {
          if (o.id !== id || o.type !== "text") return o;
          const typing = source === "type" && !!o.fit_width;
          const width = Math.ceil(typing ? Math.min(552, Math.max(96, needed)) : Math.max(o.width, needed));
          const fit = typing && width < 548;
          if (width === o.width && !!o.fit_width === fit) return o;
          return { ...o, width, fit_width: fit || undefined };
        }),
      );
    },
    [updateObjects],
  );

  const q = findQuery.trim().toLowerCase();
  const d = dragRef.current;
  const soloSelected = selected.length === 1;

  const cursor = panning
    ? "grabbing"
    : spaceDown
      ? "grab"
      : tool === "eraser" || tempErasing
        ? "none"
        : tool === "select"
          ? "default"
          : "crosshair";

  return (
    <div
      className={`canvas-wrap${lockedView ? " locked" : ""}${shiftHeld ? " shift-held" : ""}`}
      ref={wrapRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onDragStart={(e) => e.preventDefault()}
      onPointerLeave={() => {
        setHoverLocked(null);
        if (dragRef.current?.mode !== "erase") moveRing(0, 0, false);
      }}
      tabIndex={-1}
      style={{ cursor, ...paperBackground(paper, cam) }}
    >
      <div ref={ringRef} className={`eraser-ring ${eraserMode}`} style={{ display: "none" }} />
      {!lockedView && <button
        type="button"
        className="zoom-chip"
        title="Zoom (Ctrl+scroll) — click to reset to 100% (Ctrl+0)"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => setCam({ x: 60, y: 40, z: 1 })}
      >
        {Math.round(cam.z * 100)}%
      </button>}
      {shiftHeld && !lockedView && (
        <div className="shift-hint">Ctrl-click pages to select them across PDFs · Shift: pick images, move locked items, reorder pages</div>
      )}
      <div
        className={`canvas-world ${tool === "select" ? "" : "drawing"} ${tool === "lasso" ? "lasso" : ""} ${selected.length > 1 ? "multi" : ""}`}
        style={{ transform: `translate(${cam.x}px, ${cam.y}px) scale(${cam.z})` }}
      >
        {dragGhost && (
          <div className="pdf-drag-ghost" style={{ left: dragGhost.x, top: dragGhost.y, width: dragGhost.pageWidth }}>
            {dragGhost.aspects.map((aspect, i) => {
              const h = dragGhost.pageWidth * (aspect > 0 ? aspect : 1.294);
              const top = dragGhost.aspects.slice(0, i).reduce((sum, a) => sum + dragGhost.pageWidth * (a > 0 ? a : 1.294) + 14, 0);
              return (
                <div key={i} className="page" style={{ top, width: dragGhost.pageWidth, height: h }}>
                  {i === 0 && dragGhost.preview ? <img src={dragGhost.preview} alt="" /> : null}
                </div>
              );
            })}
          </div>
        )}
        {sorted.map((o) => {
          if (o.type === "group" || groupOf(objects, o.id)) return null;
          const sel = selected.includes(o.id);
          // Shape tools show handles only on the shape just drawn. A leftover
          // selection must not keep the previous shape in edit mode.
          const showAdjust = tool === "select" ? sel && soloSelected : adjustId === o.id;
          if (o.type === "text") {
            const hasMatch = !!q && blocksPlainText(o.blocks).toLowerCase().includes(q);
            return (
              <RichTextWindow
                key={o.id}
                obj={o}
                selected={sel}
                canvasHighlight={highlightedTextId === o.id}
                editable={canEdit && selected.length <= 1 && highlightedTextId !== o.id}
                showResize={showAdjust}
                moving={movingIds.includes(o.id) || resizingId === o.id}
                highlight={hasMatch}
                onSelect={(e) => selectOnly(e, o.id)}
                onFocusSelect={() => setSelected((s) => (s.includes(o.id) ? s : [o.id]))}
                onEditStart={() => onTextEditStart?.(o.id)}
                onDragBar={(e) => startMove(e, o.id)}
                onEdge={(e, edge) => startTextResize(e, o.id, edge)}
                onCommit={commitText}
                onGrowWidth={(w, source) => growTextWidth(o.id, w, source ?? "table")}
                onCreateAt={(cx, cy) => {
                  const pt = toCanvas(cx, cy);
                  createTextAt(pt.x, pt.y);
                }}
                onHeight={(h) => {
                  heightsRef.current[o.id] = h;
                }}
                snapshot={snapshot}
              />
            );
          }
          if (o.type === "image") {
            const src = note.media_b64[o.media];
            return (
              <div
                key={o.id}
                className={`img-obj ${sel ? "selected" : ""}`}
                style={{ left: o.x, top: o.y, width: o.width, height: o.height, zIndex: 2 + o.z }}
                onPointerDown={(e) => startMove(e, o.id)}
              >
                {src ? (
                  lockedView && isGifBase64(src) ? (
                    <StillImage b64={src} />
                  ) : (
                    <img src={`data:image/*;base64,${src}`} alt="" draggable={false} />
                  )
                ) : (
                  <div style={{ padding: 8, color: "var(--ink-3)" }}>missing image</div>
                )}
                {showAdjust && <div className="handle se" onPointerDown={(e) => startImgResize(e, o.id)} />}
              </div>
            );
          }
          if (o.type === "pdf") return paintPdf(o, sel);
          if (o.type !== "drawing") return null;
          return (
            <DrawingViewStable
              key={o.id}
              obj={o}
              selected={sel}
              showHandles={showAdjust}
              onPointerDown={(e) => {
                // While a shape tool is active the body must not swallow the click,
                // so the next press starts a new shape and drops these handles.
                if (tool !== "select" && tool !== "lasso") return;
                startMove(e, o.id);
              }}
              onDragBar={(e) => startMove(e, o.id)}
              onCtrlPt={startCtrlPt}
            />
          );
        })}

        {sorted.filter((o): o is GroupObject => o.type === "group").map((g) => {
          const frame = groupFrame(g, objects, boxOf);
          const kids = (g.children ?? [])
            .map((id) => objects.find((o) => o.id === id))
            .filter((o): o is Exclude<CanvasObject, GroupObject> => !!o && o.type !== "group")
            .sort(paintOrder);
          return (
            <div key={g.id} className="fold-layer" style={{ zIndex: 2 + g.z }}>
              {!g.collapsed && (
                <div
                  className="fold-field"
                  data-oid={g.id}
                  style={{
                    left: frame.x,
                    top: frame.y,
                    width: frame.w,
                    height: frame.h,
                    background: `color-mix(in srgb, var(--paper) ${Math.round((g.fill ?? 0.88) * 100)}%, transparent)`,
                  }}
                />
              )}
              {!g.collapsed &&
                kids.map((o) => {
                  const sel = selected.includes(o.id);
                  const showAdjust = tool === "select" ? sel && soloSelected : adjustId === o.id;
                  if (o.type === "text") {
                    const hasMatch = !!q && blocksPlainText(o.blocks).toLowerCase().includes(q);
                    return (
                      <RichTextWindow
                        key={o.id}
                        obj={o}
                        selected={sel}
                        canvasHighlight={highlightedTextId === o.id}
                        editable={canEdit && selected.length <= 1 && highlightedTextId !== o.id}
                        showResize={showAdjust}
                        moving={movingIds.includes(o.id) || resizingId === o.id}
                        highlight={hasMatch}
                        onSelect={(e) => selectOnly(e, o.id)}
                        onFocusSelect={() => setSelected((s) => (s.includes(o.id) ? s : [o.id]))}
                        onEditStart={() => onTextEditStart?.(o.id)}
                        onDragBar={(e) => startMove(e, o.id)}
                        onEdge={(e, edge) => startTextResize(e, o.id, edge)}
                        onCommit={commitText}
                        onGrowWidth={(w, source) => growTextWidth(o.id, w, source ?? "table")}
                        onCreateAt={(cx, cy) => {
                          const pt = toCanvas(cx, cy);
                          createTextAt(pt.x, pt.y);
                        }}
                        onHeight={(h) => {
                          heightsRef.current[o.id] = h;
                        }}
                        snapshot={snapshot}
                      />
                    );
                  }
                  if (o.type === "image") {
                    const src = note.media_b64[o.media];
                    return (
                      <div
                        key={o.id}
                        className={`img-obj ${sel ? "selected" : ""}`}
                        style={{ left: o.x, top: o.y, width: o.width, height: o.height }}
                        onPointerDown={(e) => startMove(e, o.id)}
                      >
                        {src ? (
                          lockedView && isGifBase64(src) ? (
                            <StillImage b64={src} />
                          ) : (
                            <img src={`data:image/*;base64,${src}`} alt="" draggable={false} />
                          )
                        ) : (
                          <div style={{ padding: 8, color: "var(--ink-3)" }}>missing image</div>
                        )}
                        {showAdjust && <div className="handle se" onPointerDown={(e) => startImgResize(e, o.id)} />}
                      </div>
                    );
                  }
                  if (o.type === "pdf") return paintPdf(o, sel);
                  return (
                    <DrawingViewStable
                      key={o.id}
                      obj={o}
                      selected={sel}
                      showHandles={showAdjust}
                      onPointerDown={(e) => {
                        if (tool !== "select" && tool !== "lasso") return;
                        startMove(e, o.id);
                      }}
                      onDragBar={(e) => startMove(e, o.id)}
                      onCtrlPt={startCtrlPt}
                    />
                  );
                })}
              <div
                data-oid={g.id}
                className={`fold ${g.collapsed ? "collapsed" : ""} ${selected.includes(g.id) ? "selected" : ""} ${(g.children ?? []).length ? "" : "empty"}`}
                style={
                  g.collapsed
                    ? { left: collapsedBox(g).x, top: collapsedBox(g).y, width: 28, height: 28 }
                    : { left: frame.x, top: frame.y, width: frame.w, height: frame.h }
                }
              >
                {g.collapsed ? (
                  <button
                    type="button"
                    className="fold-mark"
                    title="Collapsed note — click to expand, drag to move"
                    onPointerDown={(e) => startMove(e, g.id, e.ctrlKey || e.metaKey ? undefined : g.id)}
                  >
                    <FoldMark />
                  </button>
                ) : (
                  <>
                    <div className="fold-bar">
                      <button
                        type="button"
                        className="fold-toggle"
                        title="Collapse note"
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          e.preventDefault();
                        }}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleGroup(g.id);
                        }}
                      >
                        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
                          <path d="M2 4.5 6 8l4-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                        </svg>
                      </button>
                      <div className="fold-grip" title="Move note" onPointerDown={(e) => startMove(e, g.id)} />
                    </div>
                    <div className="edge w" onPointerDown={(e) => startGroupResize(e, g.id, "w")} />
                    <div className="edge e" onPointerDown={(e) => startGroupResize(e, g.id, "e")} />
                    <div className="edge s" onPointerDown={(e) => startGroupResize(e, g.id, "s")} />
                    <div
                      className="fold-corner se"
                      title="Resize"
                      onPointerDown={(e) => startGroupResize(e, g.id, "se")}
                    />
                    {!(g.children ?? []).length && <div className="fold-hint">Draw or type inside</div>}
                  </>
                )}
              </div>
            </div>
          );
        })}

        {hoverLocked && !shiftHeld && (() => {
          const lo = objects.find((o) => o.id === hoverLocked);
          if (!lo) return null;
          const b = boxOf(lo);
          return (
            <div
              className="lock-badge"
              title="Locked — hold Shift to interact"
              style={{ left: b.x + b.w, top: b.y, transform: `translate(-100%, -100%) scale(${1 / cam.z})`, transformOrigin: "100% 100%" }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <rect x="5" y="11" width="14" height="9" rx="2" />
                <path d="M8 11V8a4 4 0 0 1 8 0v3" />
              </svg>
            </div>
          );
        })()}

        {/* marquee selection box. Moved from the pointer, not from a re-render. */}
        <div ref={marqueeElRef} className="marquee" style={{ display: "none" }} />
        <svg
          ref={liveInkRef}
          className="draw-obj"
          style={{ display: "none", position: "absolute", overflow: "visible", width: 1, height: 1, zIndex: 100000, pointerEvents: "none" }}
        >
          <path ref={liveInkPathRef} />
        </svg>

        {(tool === "select" || tool === "lasso") &&
          selected.length > 1 &&
          (() => {
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const id of selected) {
              const o = objects.find((x) => x.id === id);
              if (!o) continue;
              const b = o.type === "group"
                ? o.collapsed
                  ? collapsedBox(o)
                  : groupFrame(o, objects, boxOf)
                : boxOf(o);
              minX = Math.min(minX, b.x);
              minY = Math.min(minY, b.y);
              maxX = Math.max(maxX, b.x + b.w);
              maxY = Math.max(maxY, b.y + b.h);
            }
            if (!Number.isFinite(minX)) return null;
            const w = Math.max(36, maxX - minX);
            const bar = Math.max(48, Math.min(160, w / 3));
            return (
              <div
                className="sel-move"
                style={{ left: minX + (w - bar) / 2, top: minY - 18, width: bar }}
                onPointerDown={(e) => startMove(e, selected[0])}
              />
            );
          })()}
        {(() => {
            const drawings = (tool === "select" || tool === "lasso" ? selected : adjustId ? [adjustId] : [])
              .map((id) => objects.find((o) => o.id === id))
              .filter((o): o is DrawingObject => !!o && o.type === "drawing");
            if (!drawings.length) return null;
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const o of drawings) {
              const b = drawingBBox(o);
              minX = Math.min(minX, b.x);
              minY = Math.min(minY, b.y);
              maxX = Math.max(maxX, b.x + b.w);
              maxY = Math.max(maxY, b.y + b.h);
            }
            if (!Number.isFinite(minX)) return null;
            return (
              <div
                className="draw-scale"
                title="Resize — Shift for a free scale"
                style={{ left: maxX - 5, top: maxY - 5 }}
                onPointerDown={(e) => startDrawResize(e, "se", { x: minX, y: minY, w: Math.max(8, maxX - minX), h: Math.max(8, maxY - minY) }, drawings)}
              />
            );
          })()}

        {/* live stroke is painted on liveInkRef so the first sample does not wait on React */}
        {d?.mode === "lasso" && d.pts.length > 1 && (
          <svg className="draw-obj lasso-path" style={{ left: 0, top: 0, overflow: "visible", width: 1, height: 1 }}>
            <polygon points={lassoLoop(d.pts).map((p) => p.join(",")).join(" ")} vectorEffect="non-scaling-stroke" />
          </svg>
        )}
        {d?.mode === "shape" && (
          <svg
            className="draw-obj"
            style={{ left: Math.min(d.sx, d.cx), top: Math.min(d.sy, d.cy), overflow: "visible", width: 1, height: 1, zIndex: 100000 }}
          >
            {d.shape === "rect" && (
              <rect width={Math.abs(d.cx - d.sx)} height={Math.abs(d.cy - d.sy)} fill="none" stroke={drawColor} strokeWidth={drawWidth} />
            )}
            {d.shape === "ellipse" && (
              <ellipse
                cx={Math.abs(d.cx - d.sx) / 2}
                cy={Math.abs(d.cy - d.sy) / 2}
                rx={Math.abs(d.cx - d.sx) / 2}
                ry={Math.abs(d.cy - d.sy) / 2}
                fill="none"
                stroke={drawColor}
                strokeWidth={drawWidth}
              />
            )}
            {d.shape === "line" && (
              <line
                x1={d.sx - Math.min(d.sx, d.cx)}
                y1={d.sy - Math.min(d.sy, d.cy)}
                x2={d.cx - Math.min(d.sx, d.cx)}
                y2={d.cy - Math.min(d.sy, d.cy)}
                stroke={drawColor}
                strokeWidth={drawWidth}
              />
            )}
          </svg>
        )}
        {d?.mode === "arrow" && (d.free ? (d.pts?.length ?? 0) > 1 : true) && (
          <LiveArrowInk
            item={
              d.free && d.pts
                ? {
                    tail: d.pts[0],
                    head: d.pts[d.pts.length - 1],
                    c1: d.pts[0],
                    c2: d.pts[d.pts.length - 1],
                    shaft: d.pts,
                    width: drawWidth,
                    color: drawColor,
                    head_style: arrowHead,
                    ...(arrowBody === "double" ? { body: "double" } : {}),
                  }
                : {
                    tail: [d.sx, d.sy],
                    head: [d.cx, d.cy],
                    c1: [d.sx + (d.cx - d.sx) / 3, d.sy + (d.cy - d.sy) / 3],
                    c2: [d.sx + ((d.cx - d.sx) * 2) / 3, d.sy + ((d.cy - d.sy) * 2) / 3],
                    width: drawWidth,
                    color: drawColor,
                    head_style: arrowHead,
                    ...(arrowBody === "double" ? { body: "double" } : {}),
                  }
            }
          />
        )}
      </div>
      {objMenu && (
        <ContextMenu
          x={objMenu.x}
          y={objMenu.y}
          onClose={() => setObjMenu(null)}
          header={(() => {
            const ids = objMenu.ids;
            const only = ids.length === 1 ? objects.find((o) => o.id === ids[0]) : undefined;
            if (!only || only.type !== "group") return null;
            const pct = Math.round((only.fill ?? 0.88) * 100);
            return (
              <label className="menu-slider">
                Background
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={pct}
                  aria-label="Fold background"
                  onChange={(e) => setFoldFill(only.id, Number(e.target.value) / 100)}
                />
              </label>
            );
          })()}
          items={((): MenuItem[] => {
            const ids = objMenu.ids;
            const items: MenuItem[] = [];
            if (ids.length) {
              items.push(
                { label: "Cut", hint: "Ctrl+X", onClick: () => { copyObjects(ids); deleteIds(ids, true); } },
                { label: "Copy", hint: "Ctrl+C", onClick: () => copyObjects(ids) },
              );
            }
            if (objectClip) items.push({ label: "Paste", hint: "Ctrl+V", onClick: () => pasteObjects() });
            if (ids.length) {
              items.push(
                "sep",
                { label: "Bring to front", onClick: () => restack(ids, true) },
                { label: "Send to back", onClick: () => restack(ids, false) },
                "sep",
                (() => {
                  const all = ids.every((i) => objects.find((o) => o.id === i)?.locked);
                  return { label: all ? "Unlock" : "Lock position", onClick: () => setLocked(ids, !all) };
                })(),
                ...(() => {
                  const pdfs = ids
                    .map((i) => objects.find((o) => o.id === i))
                    .filter((o): o is PdfObject => o?.type === "pdf");
                  if (pdfs.length < 2) return [];
                  const item: MenuItem = {
                    label: "Join pages",
                    onClick: () => joinSelectedPdfs(ids),
                  };
                  return [item];
                })(),
                "sep",
                { label: "Delete", hint: "Del", danger: true, onClick: () => deleteIds(ids, true) },
              );
            }
            if (!ids.length && objects.some((o) => o.locked)) {
              if (items.length) items.push("sep");
              items.push({
                label: "Unlock all",
                onClick: () => {
                  snapshot("unlock-all");
                  updateObjects((objs) => objs.map((o) => (o.locked ? { ...o, locked: false } : o)));
                },
              });
            }
            return items;
          })()}
        />
      )}
    </div>
  );
}

/* ─── rich text window ─────────────────────────────────────────────────── */

const RichTextWindow = memo(function RichTextWindow({
  obj,
  selected,
  canvasHighlight,
  editable,
  showResize,
  moving,
  highlight,
  onSelect,
  onFocusSelect,
  onEditStart,
  onDragBar,
  onEdge,
  onCommit,
  onGrowWidth,
  onCreateAt,
  onHeight,
  snapshot,
}: {
  obj: TextObject;
  selected: boolean;
  canvasHighlight: boolean;
  editable: boolean;
  showResize: boolean;
  moving: boolean;
  highlight: boolean;
  onSelect: (e: React.PointerEvent) => void;
  onFocusSelect: () => void;
  onEditStart: () => void;
  onDragBar: (e: React.PointerEvent) => void;
  onEdge: (e: React.PointerEvent, edge: "w" | "e" | "s" | "se") => void;
  onCommit: (id: string, el: HTMLElement) => void;
  /** Widen the text window so a table is not clipped (OneNote-like). */
  onGrowWidth: (needed: number, source?: "type" | "table") => void;
  onCreateAt: (clientX: number, clientY: number) => void;
  onHeight: (h: number) => void;
  snapshot: (key: string, coalesceMs?: number) => void;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<number | null>(null);
  const padTimerRef = useRef<number | null>(null);
  const lastPadClick = useRef({ t: 0, x: 0, y: 0 });
  const [empty, setEmpty] = useState(() => {
    const plain = blocksPlainText(obj.blocks).trim();
    return !plain && !obj.blocks.some((b) => (b as { kind?: string }).kind === "table");
  });
  const [tableMenu, setTableMenu] = useState<{
    x: number;
    y: number;
    items: MenuItem[];
  } | null>(null);
  const cellSelRef = useRef<{
    table: HTMLTableElement;
    anchor: CellCoord;
    focus: CellCoord;
  } | null>(null);
  const cellDragRef = useRef<{
    table: HTMLTableElement;
    anchor: CellCoord;
    active: boolean;
  } | null>(null);
  const colDragRef = useRef<{
    table: HTMLTableElement;
    colIndex: number;
    startX: number;
    startWidth: number;
  } | null>(null);

  const html = useMemo(() => blocksToHtml(obj.blocks), [obj.blocks]);

  // Sync external changes into the DOM only when not being edited or resized.
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const editing = el === document.activeElement || el.contains(document.activeElement);
    // The formula popover focuses an input outside the box. Rebuilding the DOM
    // then would detach the chip the popover is editing.
    if (document.querySelector(".math-pop") && el.querySelector(".pl-math")) return;
    if (moving || editing) return;
    if (el.innerHTML !== html) el.innerHTML = html;
    const plain = blocksPlainText(obj.blocks).trim();
    setEmpty(!plain && !obj.blocks.some((b) => (b as { kind?: string }).kind === "table") && !el.querySelector(".pl-math"));
  }, [html, obj.blocks, moving]);

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    if (!el.innerHTML) el.innerHTML = html;
    const ro = new ResizeObserver(() => onHeight(el.parentElement?.offsetHeight ?? el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const scheduleCommit = () => {
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      if (contentRef.current) onCommit(obj.id, contentRef.current);
    }, 350);
  };

  const clearCellSel = () => {
    const root = contentRef.current;
    if (root) clearAllTableSelections(root);
    cellSelRef.current = null;
  };

  const setCellSel = (table: HTMLTableElement, anchor: CellCoord, focus: CellCoord) => {
    const root = contentRef.current;
    if (root) clearAllTableSelections(root);
    applyCellSelection(table, anchor, focus);
    cellSelRef.current = { table, anchor, focus };
  };

  const hasMultiCellSel = () => {
    const s = cellSelRef.current;
    if (!s) return false;
    return s.anchor.row !== s.focus.row || s.anchor.col !== s.focus.col;
  };

  const ensureBoxFitsTable = (table: HTMLTableElement) => {
    onGrowWidth(tableOuterWidth(table) + TABLE_BOX_PAD);
  };

  const refreshEmpty = () => {
    const el = contentRef.current;
    if (!el) return;
    const plain = (el.innerText ?? "").replace(/\u2003/g, "").trim();
    setEmpty(!plain && !el.querySelector("table, .pl-math, img"));
  };

  const currentParagraph = (): HTMLElement | null => {
    const sel = window.getSelection();
    if (!sel?.anchorNode) return null;
    let n: Node | null = sel.anchorNode;
    while (n && n !== contentRef.current) {
      if (n instanceof HTMLElement && n.classList.contains("p")) return n;
      n = n.parentNode;
    }
    return null;
  };

  const currentCell = (): HTMLTableCellElement | null => {
    const sel = window.getSelection();
    if (!sel?.anchorNode) return null;
    let n: Node | null = sel.anchorNode;
    while (n && n !== contentRef.current) {
      if (n instanceof HTMLTableCellElement) return n;
      n = n.parentNode;
    }
    return null;
  };

  const setIndent = (p: HTMLElement, indent: number) => {
    indent = Math.max(0, Math.min(8, indent));
    p.dataset.indent = String(indent);
    p.style.paddingLeft = indent ? `${indent * 22}px` : "";
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Multi-cell selection: Delete/Backspace clears content (OneNote-like)
    if ((e.key === "Delete" || e.key === "Backspace") && hasMultiCellSel()) {
      e.preventDefault();
      const s = cellSelRef.current!;
      snapshot("table-clear");
      const cells = s.table.querySelectorAll("td.plt-sel");
      clearCells([...cells] as HTMLTableCellElement[]);
      scheduleCommit();
      return;
    }

    // Table navigation (only active once a table exists — spec rule)
    const cell = currentCell();
    if (cell) {
      if (e.key === "Tab") {
        e.preventDefault();
        clearCellSel();
        const table = cell.closest("table") as HTMLTableElement | null;
        if (!table) return;
        const cells = [...table.querySelectorAll("td")] as HTMLTableCellElement[];
        const idx = cells.indexOf(cell);
        let target: HTMLTableCellElement | null = e.shiftKey ? cells[idx - 1] : cells[idx + 1];
        if (!target && !e.shiftKey) {
          // last cell → append a row
          snapshot("table-row");
          const coord = cellCoord(cell);
          const newRow = insertRow(table, (coord?.row ?? 0) + 1);
          target = newRow?.querySelector("td") ?? null;
        }
        if (target) placeCaret(target);
        scheduleCommit();
        return;
      }
      if (e.key === "Enter" && e.ctrlKey) {
        e.preventDefault();
        clearCellSel();
        snapshot("table-row");
        const table = cell.closest("table") as HTMLTableElement | null;
        const coord = cellCoord(cell);
        if (table && coord) {
          const newRow = insertRow(table, coord.row + 1);
          const td = newRow?.cells[coord.col] as HTMLTableCellElement | undefined;
          if (td) placeCaret(td);
        }
        scheduleCommit();
        return;
      }
      // Arrow keys move between cells when caret is at edge / with Alt
      if (
        e.key === "ArrowLeft" ||
        e.key === "ArrowRight" ||
        e.key === "ArrowUp" ||
        e.key === "ArrowDown"
      ) {
        const table = cell.closest("table") as HTMLTableElement | null;
        const coord = cellCoord(cell);
        if (table && coord && (e.altKey || hasMultiCellSel())) {
          e.preventDefault();
          clearCellSel();
          const dRow = e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0;
          const dCol = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
          const next = cellAt(table, coord.row + dRow, coord.col + dCol);
          if (next) placeCaret(next);
          return;
        }
      }
      return; // let Enter etc. behave normally within a cell
    }

    const p = currentParagraph();
    const isBullet = !!p?.dataset.bullet;

    if (e.key === "Tab") {
      e.preventDefault();
      if (p && isBullet) {
        // list indent/outdent — only for manually created lists (spec)
        snapshot("indent", 700);
        setIndent(p, (parseInt(p.dataset.indent ?? "0") || 0) + (e.shiftKey ? -1 : 1));
        scheduleCommit();
      } else {
        document.execCommand("insertText", false, "\u2003"); // em-space as tab stand-in
      }
      return;
    }

    if (e.key === "Enter" && p && isBullet && !e.shiftKey) {
      const text = p.textContent ?? "";
      if (text.trim() === "") {
        // Enter on empty bullet → exit list
        e.preventDefault();
        delete p.dataset.bullet;
        delete p.dataset.glyph;
        setIndent(p, 0);
        scheduleCommit();
        return;
      }
      // otherwise browser clones the div (with data-* attrs) → list continues
    }

    if (e.key === "Backspace" && p && isBullet) {
      const sel = window.getSelection();
      if (sel?.isCollapsed && sel.anchorOffset === 0) {
        const range = sel.getRangeAt(0);
        const pre = range.cloneRange();
        pre.selectNodeContents(p);
        pre.setEnd(range.startContainer, range.startOffset);
        if (pre.toString() === "") {
          e.preventDefault();
          delete p.dataset.bullet;
          delete p.dataset.glyph;
          scheduleCommit();
          return;
        }
      }
    }
  };

  const estimateLineHeight = (el: HTMLElement) => {
    const p = el.querySelector(".p") as HTMLElement | null;
    if (p) {
      const h = p.getBoundingClientRect().height;
      if (h > 4) return h;
    }
    const cs = getComputedStyle(el);
    const fs = parseFloat(cs.fontSize) || 14.67;
    const lh = parseFloat(cs.lineHeight);
    return Number.isFinite(lh) ? lh : fs * 1.5;
  };

  const lastContentBottom = (): number | null => {
    const content = contentRef.current;
    if (!content) return null;
    const blocks = [...content.children] as HTMLElement[];
    let bottom: number | null = null;
    for (const b of blocks) {
      if (b.tagName === "TABLE") {
        bottom = b.getBoundingClientRect().bottom;
        continue;
      }
      if (!b.classList.contains("p")) continue;
      const has =
        !!(b.textContent ?? "").trim() || !!b.querySelector("img, .pl-math");
      if (has) bottom = b.getBoundingClientRect().bottom;
    }
    return bottom;
  };

  /** True when the pointer is in the blank region of this box (below real
   *  content, on a trailing empty paragraph, or on the stretched content pad). */
  const isEmptyArea = (clientY: number, target: EventTarget | null): boolean => {
    const content = contentRef.current;
    if (!content) return false;
    if (target === content) return true;

    const bottom = lastContentBottom();
    if (bottom == null) return true; // wholly empty box
    const scale = content.getBoundingClientRect().height / Math.max(1, content.offsetHeight);
    const slop = Math.max(0.4, 2 * scale);
    if (clientY > bottom + slop) return true;

    // Trailing empty paragraphs count as empty area even if the Y is "on" them
    const el = target instanceof Element ? target : null;
    const p = el?.closest?.(".p") as HTMLElement | null;
    if (p && content.contains(p) && p.getBoundingClientRect().top >= bottom - 1) {
      const vacant =
        !(p.textContent ?? "").trim() && !p.querySelector("img, .pl-math, table");
      if (vacant) return true;
    }
    return false;
  };

  const padLinesTo = (clientY: number) => {
    const content = contentRef.current;
    if (!content) return;
    const bottom = lastContentBottom() ?? content.getBoundingClientRect().top;
    const lineH = estimateLineHeight(content);
    let needed = Math.max(1, Math.round((clientY - bottom) / lineH));
    const last = content.querySelector(":scope > .p:last-of-type") as HTMLElement | null;
    if (
      last &&
      !(last.textContent ?? "").trim() &&
      !last.querySelector("img, .pl-math, table") &&
      (lastContentBottom() == null || last.getBoundingClientRect().top >= (lastContentBottom() ?? 0) - 1)
    ) {
      needed = Math.max(0, needed - 1);
    }
    for (let i = 0; i < needed; i++) {
      const p = document.createElement("div");
      p.className = "p";
      p.innerHTML = "<br>";
      content.appendChild(p);
    }
    const target = content.querySelector(":scope > .p:last-of-type") as HTMLElement | null;
    if (target) placeCaret(target);
    snapshot(`text:${obj.id}`, 1200);
    scheduleCommit();
  };

  const spawnHere = (clientX: number, clientY: number) => {
    if (padTimerRef.current) {
      window.clearTimeout(padTimerRef.current);
      padTimerRef.current = null;
    }
    // Blur this box first so empty leftovers can clean up, then spawn.
    (document.activeElement as HTMLElement | null)?.blur();
    onCreateAt(clientX, clientY);
  };

  const openTableMenu = (e: React.MouseEvent, cell: HTMLTableCellElement) => {
    e.preventDefault();
    e.stopPropagation();
    const table = cell.closest("table.plt") as HTMLTableElement | null;
    const coord = cellCoord(cell);
    if (!table || !coord) return;

    const run = (key: string, fn: () => void) => {
      snapshot(key);
      fn();
      refreshEmpty();
      scheduleCommit();
    };

    const items: MenuItem[] = [
      {
        label: "Insert row above",
        onClick: () =>
          run("table-row", () => {
            insertRow(table, coord.row);
          }),
      },
      {
        label: "Insert row below",
        onClick: () =>
          run("table-row", () => {
            insertRow(table, coord.row + 1);
          }),
      },
      {
        label: "Insert column left",
        onClick: () =>
          run("table-col", () => {
            insertColumn(table, coord.col);
            ensureBoxFitsTable(table);
          }),
      },
      {
        label: "Insert column right",
        onClick: () =>
          run("table-col", () => {
            insertColumn(table, coord.col + 1);
            ensureBoxFitsTable(table);
          }),
      },
      "sep",
      {
        label: "Delete row",
        danger: true,
        onClick: () =>
          run("table-row", () => {
            const replaced = deleteRow(table, coord.row);
            if (replaced) {
              clearCellSel();
              placeCaret(replaced);
            }
          }),
      },
      {
        label: "Delete column",
        danger: true,
        onClick: () =>
          run("table-col", () => {
            const replaced = deleteColumn(table, coord.col);
            if (replaced) {
              clearCellSel();
              placeCaret(replaced);
            }
          }),
      },
      {
        label: "Delete table",
        danger: true,
        onClick: () =>
          run("table", () => {
            clearCellSel();
            const p = removeTable(table);
            placeCaret(p);
          }),
      },
      "sep",
      {
        label: table.dataset.borders === "false" ? "Show borders" : "Hide borders",
        onClick: () =>
          run("table-borders", () => {
            toggleBorders(table);
          }),
      },
    ];
    setTableMenu({ x: e.clientX, y: e.clientY, items });
  };

  /** Single-click in empty area pads lines; double-click creates a new text box.
   *  Inside tables: column resize + multi-cell selection. */
  const onContentPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!editable) {
      if (canvasHighlight && e.button === 0) {
        const rect = e.currentTarget.getBoundingClientRect();
        const scale = rect.height / Math.max(1, e.currentTarget.offsetHeight);
        const y = e.clientY - rect.top;
        if (y < Math.min(16 * scale, rect.height * 0.45)) {
          e.preventDefault();
          onDragBar(e);
          return;
        }
        onEditStart();
        e.stopPropagation();
        const el = e.currentTarget;
        requestAnimationFrame(() => {
          requestAnimationFrame(() => el.focus({ preventScroll: true }));
        });
        return;
      }
      e.preventDefault();
      onDragBar(e);
      return;
    }
    // Top strip of the box is window chrome (select/move), not a caret click —
    // unless we are already typing in this window.
    const ctrl = e.ctrlKey || e.metaKey || e.getModifierState("Control") || e.getModifierState("Meta");
    if (ctrl && e.button === 0) {
      e.preventDefault();
      onSelect(e);
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const scale = rect.height / Math.max(1, e.currentTarget.offsetHeight);
    const y = e.clientY - rect.top;
    const alreadyTyping =
      !canvasHighlight &&
      (e.currentTarget === document.activeElement ||
        e.currentTarget.contains(document.activeElement));
    if (!alreadyTyping && y < Math.min(16 * scale, rect.height * 0.45)) {
      if (e.button !== 0) return;
      e.preventDefault();
      onDragBar(e);
      return;
    }
    onEditStart();
    e.stopPropagation();
    if (e.button !== 0) return;

    const target = e.target as Element | null;
    const table = target?.closest?.("table.plt") as HTMLTableElement | null;
    const cell = target?.closest?.("td") as HTMLTableCellElement | null;

    if (table) {
      const hit = colResizeHit(table, e.clientX, e.clientY);
      if (hit) {
        e.preventDefault();
        snapshot("table-col-width");
        colDragRef.current = {
          table,
          colIndex: hit.colIndex,
          startX: e.clientX,
          startWidth: hit.startWidth,
        };
        table.classList.add("plt-resizing");
        const onMove = (ev: PointerEvent) => {
          const d = colDragRef.current;
          if (!d) return;
          const w = Math.max(MIN_COL_WIDTH, d.startWidth + (ev.clientX - d.startX));
          setColWidth(d.table, d.colIndex, w);
          ensureBoxFitsTable(d.table);
        };
        const onUp = () => {
          const d = colDragRef.current;
          colDragRef.current = null;
          d?.table.classList.remove("plt-resizing");
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
          scheduleCommit();
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
        return;
      }
    }

    if (cell && table) {
      const coord = cellCoord(cell);
      if (coord) {
        // Start potential multi-cell drag; same-cell stays text selection.
        cellDragRef.current = { table, anchor: coord, active: false };
        clearCellSel();
        const onMove = (ev: PointerEvent) => {
          const drag = cellDragRef.current;
          if (!drag) return;
          const el = document.elementFromPoint(ev.clientX, ev.clientY);
          const over = el?.closest?.("td") as HTMLTableCellElement | null;
          if (!over || !drag.table.contains(over)) return;
          const focus = cellCoord(over);
          if (!focus) return;
          if (focus.row !== drag.anchor.row || focus.col !== drag.anchor.col) {
            if (!drag.active) {
              drag.active = true;
              window.getSelection()?.removeAllRanges();
            }
            setCellSel(drag.table, drag.anchor, focus);
          }
        };
        const onUp = () => {
          cellDragRef.current = null;
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
        return;
      }
    } else {
      clearCellSel();
    }

    if (!isEmptyArea(e.clientY, e.target)) return;

    e.preventDefault();

    if (padTimerRef.current) {
      window.clearTimeout(padTimerRef.current);
      padTimerRef.current = null;
    }

    // preventDefault above stops the browser from counting the click, so a
    // second press is timed here instead of trusting e.detail.
    const now = performance.now();
    const prevPad = lastPadClick.current;
    const repeated = now - prevPad.t < 500 && Math.hypot(e.clientX - prevPad.x, e.clientY - prevPad.y) < 14;
    lastPadClick.current = { t: now, x: e.clientX, y: e.clientY };
    if (e.detail >= 2 || repeated) {
      spawnHere(e.clientX, e.clientY);
      return;
    }

    contentRef.current?.focus({ preventScroll: true });
    const padY = e.clientY;
    // Wait long enough that a double-click's second press cancels padding
    padTimerRef.current = window.setTimeout(() => {
      padTimerRef.current = null;
      padLinesTo(padY);
    }, 350);
  };

  const onContentMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const content = contentRef.current;
    if (!content || colDragRef.current) return;
    const table = (e.target as Element | null)?.closest?.("table.plt") as HTMLTableElement | null;
    if (!table) {
      if (content.style.cursor === "col-resize") content.style.cursor = "";
      return;
    }
    const hit = colResizeHit(table, e.clientX, e.clientY);
    content.style.cursor = hit ? "col-resize" : "";
  };

  useEffect(() => {
    return () => {
      if (padTimerRef.current) window.clearTimeout(padTimerRef.current);
    };
  }, []);

  return (
    <div
      data-oid={obj.id}
      className={`text-window ${selected ? "selected" : ""} ${canvasHighlight ? "canvas-highlight" : ""} ${showResize ? "resizable" : ""} ${moving ? "moving" : ""} ${empty ? "empty" : ""} ${obj.fit_width ? "fit-width" : ""}`}
      style={{
        left: obj.x,
        top: obj.y,
        width: obj.width,
        minHeight: obj.min_height ?? undefined,
        boxShadow: highlight ? "0 0 0 2px var(--warn)" : undefined,
        zIndex: 2 + obj.z,
      }}
      onPointerDown={onSelect}
    >
      <div className="drag-bar" onPointerDown={onDragBar} />
      {showResize && (
        <>
          <div className="edge w" onPointerDown={(e) => onEdge(e, "w")} />
          <div className="edge e" onPointerDown={(e) => onEdge(e, "e")} />
          <div className="edge s" onPointerDown={(e) => onEdge(e, "s")} />
          <div className="handle se" onPointerDown={(e) => onEdge(e, "se")} />
        </>
      )}
      <div
        ref={contentRef}
        className="content"
        contentEditable={editable}
        suppressContentEditableWarning
        spellCheck={false}
        onInput={() => {
          if (hasMultiCellSel()) clearCellSel();
          snapshot(`text:${obj.id}`, 1200);
          refreshEmpty();
          const el = contentRef.current;
          if (el && obj.fit_width) {
            const scale = el.getBoundingClientRect().width / Math.max(1, el.offsetWidth);
            let ink = 0;
            const lines = el.querySelectorAll(":scope > .p");
            const nodes = lines.length ? lines : [el];
            for (const node of nodes) {
              const range = document.createRange();
              range.selectNodeContents(node);
              ink = Math.max(ink, range.getBoundingClientRect().width / (scale || 1));
            }
            onGrowWidth(ink + 32, "type");
          }
          scheduleCommit();
        }}
        onKeyDown={onKeyDown}
        onBlur={(e) => {
          const next = e.relatedTarget as HTMLElement | null;
          if (next?.closest?.(".math-pop")) return;
          if (document.querySelector(".math-pop") && contentRef.current?.querySelector(".pl-math")) return;
          if (debounceRef.current) window.clearTimeout(debounceRef.current);
          if (padTimerRef.current) {
            window.clearTimeout(padTimerRef.current);
            padTimerRef.current = null;
          }
          if (contentRef.current) {
            contentRef.current.style.cursor = "";
            onCommit(obj.id, contentRef.current);
          }
          refreshEmpty();
        }}
        onFocus={() => {
          if (!editable) {
            contentRef.current?.blur();
            return;
          }
          onFocusSelect();
        }}
        onPointerDown={onContentPointerDown}
        onMouseMove={onContentMouseMove}
        onMouseLeave={() => {
          if (contentRef.current) contentRef.current.style.cursor = "";
        }}
        onContextMenu={(e) => {
          const cell = (e.target as Element | null)?.closest?.("td") as HTMLTableCellElement | null;
          if (cell && contentRef.current?.contains(cell)) {
            openTableMenu(e, cell);
          }
        }}
        onDoubleClick={(e) => {
          if (!editable) {
            e.preventDefault();
            e.stopPropagation();
            return;
          }
          if (!isEmptyArea(e.clientY, e.target)) return;
          e.preventDefault();
          e.stopPropagation();
          spawnHere(e.clientX, e.clientY);
        }}
      />
      {tableMenu && (
        <ContextMenu
          x={tableMenu.x}
          y={tableMenu.y}
          items={tableMenu.items}
          onClose={() => setTableMenu(null)}
        />
      )}
    </div>
  );
}, (a, b) =>
  a.obj === b.obj &&
  a.selected === b.selected &&
  a.canvasHighlight === b.canvasHighlight &&
  a.editable === b.editable &&
  a.showResize === b.showResize &&
  a.moving === b.moving &&
  a.highlight === b.highlight,
);

function placeCaret(el: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(true);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
  (el.closest(".content") as HTMLElement | null)?.focus();
}

/* ─── drawing render ───────────────────────────────────────────────────── */

function shapeHandleAt(handle: ShapeHandle, w: number, ht: number) {
  return {
    cx: handle.includes("e") ? w : handle.includes("w") ? 0 : w / 2,
    cy: handle.includes("s") ? ht : handle.includes("n") ? 0 : ht / 2,
  };
}

function CtrlHandle({
  cx,
  cy,
  cursor,
  onDown,
}: {
  cx: number;
  cy: number;
  cursor: string;
  onDown: (e: React.PointerEvent) => void;
}) {
  return (
    <g className="ctrl-handle" style={{ cursor }}>
      <circle cx={cx} cy={cy} r={12} fill="transparent" onPointerDown={onDown} />
      <circle cx={cx} cy={cy} r={6} className="ctrl-pt" />
    </g>
  );
}

export function StrokeInk({
  pts,
  parts,
  width,
  color,
  hl,
  opacity,
  pressure,
  hit,
}: {
  pts: [number, number][];
  /** Extra marker runs painted in the same fill as `pts`. */
  parts?: [number, number][][];
  width: number;
  color: string;
  hl: boolean;
  opacity?: number;
  pressure?: number[];
  hit?: boolean;
}) {
  if (hl) {
    const d = markerOutlinePath(strokeRuns(pts, parts), width);
    if (d) {
      const strength = opacity ?? 0.4;
      return <path className="hl-ink" style={{ ["--hl" as string]: color, ["--hl-a" as string]: String(strength) }} d={d} />;
    }
  }
  const outlined =
    !hl && pressure && pressure.length === pts.length && pts.length >= 2 ? strokeOutline(pts, pressure, width) : [];
  if (outlined.length >= 3) {
    return (
      <>
        {hit && (
          <path
            d={strokePath(pts)}
            fill="none"
            stroke="transparent"
            strokeWidth={Math.max(16, pressureHitWidth(width, pressure) + 10)}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
        <path d={outlinePath(outlined)} fill={color} stroke="none" />
      </>
    );
  }
  return (
    <>
      {hit && (
        <path
          d={strokePath(pts)}
          fill="none"
          stroke="transparent"
          strokeWidth={Math.max(16, width + 10)}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
      <path
        fill="none"
        stroke={color}
        strokeWidth={width}
        strokeLinecap={hl ? "butt" : "round"}
        strokeLinejoin="round"
        d={strokePath(pts)}
      />
    </>
  );
}

function DrawingView({
  obj,
  selected,
  showHandles,
  onPointerDown,
  onDragBar,
  onCtrlPt,
}: {
  obj: DrawingObject;
  selected: boolean;
  showHandles: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
  onDragBar: (e: React.PointerEvent) => void;
  onCtrlPt: (e: React.PointerEvent, id: string, pt: "tail" | "head" | "c1" | "c2") => void;
}) {
  const it = obj.item;
  const isBoxShape = it.kind === "shape" && (it.shape === "rect" || it.shape === "ellipse");
  const hl = it.kind === "stroke" && !!it.highlighter;
  const b = drawingInkBox(it);
  const pad = 18;
  const vx = b.minX - pad;
  const vy = b.minY - pad;
  const vw = Math.max(12, b.maxX - b.minX + pad * 2);
  const vh = Math.max(12, b.maxY - b.minY + pad * 2);
  const inkW = Math.max(8, b.maxX - b.minX);
  const inkH = Math.max(8, b.maxY - b.minY);
  const showChrome = selected || showHandles;
  return (
    <div
      data-oid={obj.id}
      className={`draw-obj ${hl ? "hl" : ""} ${selected ? "selected" : ""} ${showHandles ? "adjusting" : ""}`}
      style={{ left: obj.x + vx, top: obj.y + vy, width: vw, height: vh, zIndex: 2 + obj.z }}
      onPointerDown={(e) => {
        const t = e.target as Element | null;
        if (t?.closest?.(".ctrl-handle, .shape-hit, .draw-grip")) return;
        onPointerDown(e);
      }}
    >
      <svg className={hl ? "hl" : ""} width={vw} height={vh} style={{ display: "block", overflow: "visible" }}>
        <g transform={`translate(${-vx} ${-vy})`} onPointerDown={onPointerDown} style={{ cursor: showChrome ? "move" : undefined }}>
      {it.kind === "stroke" && (
        <StrokeInk pts={it.points} parts={it.parts} width={it.width} color={it.color} hl={hl} opacity={it.kind === "stroke" ? it.opacity : undefined} pressure={it.pressure} hit />
      )}
      {it.kind === "stroke" && hl && <HlBounds pts={strokeRuns(it.points, it.parts).flat()} width={it.width} />}
      {it.kind === "shape" && it.shape === "rect" && (
        <rect width={it.w} height={it.h} fill={it.fill ?? "none"} stroke={it.color} strokeWidth={it.width} rx={2} />
      )}
      {it.kind === "shape" && it.shape === "ellipse" && (
        <ellipse cx={it.w / 2} cy={it.h / 2} rx={it.w / 2} ry={it.h / 2} fill={it.fill ?? "none"} stroke={it.color} strokeWidth={it.width} />
      )}
      {isBoxShape && <rect x={0} y={0} width={it.w} height={it.h} fill="transparent" stroke="none" />}
      {it.kind === "shape" && (it.shape === "triangle" || it.shape === "diamond") && (
        <polygon
          points={
            it.shape === "triangle"
              ? `${it.w / 2},0 ${it.w},${it.h} 0,${it.h}`
              : `${it.w / 2},0 ${it.w},${it.h / 2} ${it.w / 2},${it.h} 0,${it.h / 2}`
          }
          fill={it.fill ?? "none"}
          stroke={it.color}
          strokeWidth={it.width}
        />
      )}
      {it.kind === "arrow" && (
        <>
          <ArrowInk item={it} hit />
          {it.tail_style === "arrow" && (
            <polygon points={polyPoints(arrowHeadPolygon(it.c1, it.tail, it.width))} fill={it.color} />
          )}
          {showHandles && !it.shaft?.length && (
            <>
              <line className="ctrl-line" x1={it.tail[0]} y1={it.tail[1]} x2={it.c1[0]} y2={it.c1[1]} />
              <line className="ctrl-line" x1={it.head[0]} y1={it.head[1]} x2={it.c2[0]} y2={it.c2[1]} />
              {(["tail", "head", "c1", "c2"] as const).map((k) => (
                <CtrlHandle
                  key={k}
                  cx={it[k][0]}
                  cy={it[k][1]}
                  cursor="grab"
                  onDown={(e) => onCtrlPt(e, obj.id, k)}
                />
              ))}
            </>
          )}
        </>
      )}
        </g>
      </svg>
      {showChrome && (
        <>
          <div className="ink-frame" style={{ left: pad, top: pad, width: inkW, height: inkH }} />
          <div
            className="draw-grip"
            title="Move"
            style={{ left: pad, top: pad - 16, width: Math.max(inkW, 36) }}
            onPointerDown={(e) => {
              e.stopPropagation();
              onDragBar(e);
            }}
          />
          {showHandles && it.kind === "arrow" && !it.shaft?.length &&
            (["tail", "head", "c1", "c2"] as const).map((k) => (
              <div
                key={k}
                className="shape-hit"
                style={{ left: it[k][0] - vx - 9, top: it[k][1] - vy - 9, cursor: "grab" }}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  onCtrlPt(e, obj.id, k);
                }}
              />
            ))}
        </>
      )}
    </div>
  );
}

const DrawingViewStable = memo(DrawingView, (a, b) => a.obj === b.obj && a.selected === b.selected && a.showHandles === b.showHandles);

/** Filled tip. `from` → `to` is the direction the head points. */
export function arrowHeadPolygon(from: [number, number], to: [number, number], width: number): [number, number][] {
  return arrowHeadPoints(from, to, width, "full");
}

export function polyPoints(pts: [number, number][]): string {
  return pts.map((p) => `${p[0]},${p[1]}`).join(" ");
}

/** Live arrow sized to its ink. A 1×1 SVG is clipped by the canvas transform, so the drag never showed. */
function LiveArrowInk({
  item,
}: {
  item: {
    tail: [number, number];
    head: [number, number];
    c1: [number, number];
    c2: [number, number];
    shaft?: [number, number][];
    width: number;
    color: string;
    head_style?: string;
    body?: string;
  };
}) {
  const pts = item.shaft?.length ? item.shaft : [item.tail, item.head, item.c1, item.c2];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p[0]);
    minY = Math.min(minY, p[1]);
    maxX = Math.max(maxX, p[0]);
    maxY = Math.max(maxY, p[1]);
  }
  const pad = Math.max(14, item.width * 6);
  const left = minX - pad;
  const top = minY - pad;
  const w = Math.max(16, maxX - minX + pad * 2);
  const h = Math.max(16, maxY - minY + pad * 2);
  return (
    <svg className="draw-obj" width={w} height={h} style={{ left, top, width: w, height: h, zIndex: 100000 }}>
      <g transform={`translate(${-left} ${-top})`}>
        <ArrowInk item={item} />
      </g>
    </svg>
  );
}

function drawingInkBox(it: DrawingItem): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const add = (x: number, y: number) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  if (it.kind === "stroke") for (const run of strokeRuns(it.points, it.parts)) for (const p of run) add(p[0], p[1]);
  else if (it.kind === "shape") {
    add(0, 0);
    add(it.w, it.h);
  } else {
    const line = it.shaft?.length ? it.shaft : [it.tail, it.head, it.c1, it.c2];
    for (const p of line) add(p[0], p[1]);
    for (const p of arrowTipExtents(it)) add(p[0], p[1]);
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 8, maxY: 8 };
  const m = it.kind === "stroke" ? pressureHitWidth(it.width, it.pressure) / 2 : it.width / 2;
  return { minX: minX - m, minY: minY - m, maxX: maxX + m, maxY: maxY + m };
}

export function FoldMark() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden>
      <path
        d="M6 4.5h8.2L19 9.2V19a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 19V6A1.5 1.5 0 0 1 6.5 4.5H6Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M14 4.8V9h4.2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M8 13h8M8 16.5h5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
