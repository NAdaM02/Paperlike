import { ReactNode, RefObject, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { MoodlePane } from "./MoodlePane";
import {
  finishMoodleDrag,
  moodleDragSnapshot,
  setMoodlePdfInserter,
  subscribeMoodleDrag,
  type MoodleDragGhost,
} from "./moodleBridge";
import katex from "katex";
import { MathfieldElement } from "mathlive";
import "mathlive/fonts.css";
import { QuickAskField, QuickSeed } from "./QuickAsk";
import {
  api,
  HomeTile,
  GifHit,
  GroupObject,
  ImageObject,
  newId,
  NoteDocument,
  NoteListItem,
  NotePayload,
  NotebookInfo,
  SeparatorEntry,
  NotebookUiState,
  PaperStyle,
  PdfObject,
  Separators,
  Settings,
  TextObject,
} from "./api";
import {
  arrowHeadPolygon,
  CanvasEditor,
  CanvasViewApi,
  FoldMark,
  HlBounds,
  objectBBox,
  polyPoints,
  StrokeInk,
  Tool,
} from "./CanvasEditor";
import { ArrowInk } from "./ArrowInk";
import { DrawOptionsPop, ToolWheel } from "./toolWheel";
import { GifPicker } from "./gifPicker";
import { collapsedIds, placeNew } from "./group";
import { messages } from "./copy/messages";
import { pdfAspects, pdfPlacement } from "./pdfDoc";
import { PdfView, type PdfCanvasView } from "./PdfView";
import { pdfSize } from "./pdfLayout";
import { isGifBase64, StillImage } from "./stillImage";
import { ERASER_SIZES, EraserMode, EraserSize } from "./eraser";
import { CustomColorPicker, pushColorHistory } from "./colorPicker";
import {
  BULLET_GLYPHS,
  DEFAULT_FONT,
  DEFAULT_SIZE,
  FONT_SIZES,
  FONTS,
  FormatState,
  htmlToBlocks,
  mathHtml,
  blocksToHtml,
  blocksPlainText,
  readFormatState,
  readFormatStateFromContent,
  renderMathInto,
} from "./richtext";
import {
  insertBlockHtmlAtSelection,
  insertHtmlAtSelection,
  restoreSelection,
  SavedSelection,
  saveSelection,
  applyToAllContent,
  setFontFamily,
  setFontSize,
  setHighlight,
  setTextColor,
} from "./formatting";
import {
  ConfirmDialog,
  ConfirmState,
  ContextMenu,
  MenuItem,
  Modal,
  PromptDialog,
  PromptState,
  b64ToBytes,
  bytesToB64,
  coverGradient,
  fitImage,
  imageSize,
  pickLocalImage,
  pickLocalPdf,
} from "./ui";
import {
  IcArrow,
  IcEllipse,
  IcLine,
  IcRect,
  IcBrief,
  IcAsk,
  IcBook,
  IcCalendar,
  IcAutoHide,
  IcCheck,
  IcChevron,
  IcChevronUp,
  IcClose,
  IcCollapse,
  IcCursor,
  IcDoc,
  IcEraser,
  IcExpand,
  IcExport,
  IcExportMulti,
  IcFullscreen,
  IcEye,
  IcHighlighter,
  IcHome,
  IcLasso,
  IcLast,
  IcImage,
  IcPdf,
  IcFold,
  IcMath,
  IcMix,
  IcMoon,
  IcPen,
  IcPlus,
  IcRedo,
  IcRename,
  IcSave,
  IcSearch,
  IcSettings,
  IcSpark,
  IcSun,
  IcTable,
  IcTrash,
  IcUndo,
} from "./icons";

type Ribbon = "File" | "Edit" | "Draw" | "View";
const RIBBON_ORDER: Ribbon[] = ["File", "Edit", "Draw", "View"];

/** Canvas y at the top of the viewport is `-cam.y / cam.z`. Past this, the title hides. */
const TITLE_AUTOHIDE_Y = 48;
/** Stay hidden until the view is this close to the top, so the row does not flicker. */
const TITLE_AUTOSHOW_Y = 24;

const A4 = { w: 794, h: 1123, margin: 40 };
const PDF_ZOOM_MIN = 0.4;
const PDF_ZOOM_MAX = 3;

/** Which sheet point sits under the cursor, so a zoom keeps that point still. */
function pdfZoomAnchor(sc: HTMLElement, clientX: number, clientY: number) {
  const els = Array.from(sc.querySelectorAll<HTMLElement>(":scope > .pdf-page"));
  if (!els.length) return null;
  let index = 0;
  let best = Infinity;
  els.forEach((el, i) => {
    const r = el.getBoundingClientRect();
    const dx = clientX < r.left ? r.left - clientX : clientX > r.right ? clientX - r.right : 0;
    const dy = clientY < r.top ? r.top - clientY : clientY > r.bottom ? clientY - r.bottom : 0;
    const d = dx + dy;
    if (d < best) {
      best = d;
      index = i;
    }
  });
  const r = els[index].getBoundingClientRect();
  return {
    index,
    fx: r.width > 0 ? (clientX - r.left) / r.width : 0.5,
    fy: r.height > 0 ? (clientY - r.top) / r.height : 0.5,
    clientX,
    clientY,
  };
}
const PDF_TITLE_PT = 15;
const PDF_TITLE_GAP = 20;
const PDF_TITLE_BLOCK = PDF_TITLE_PT * (96 / 72) + PDF_TITLE_GAP;

const LOCAL_DATE = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const LOCAL_DATETIME = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

/* ── drawing preferences (app-wide, survive restarts) ── */

const DRAW_PREFS_KEY = "paperlike-draw-prefs";
const DRAW_WIDTHS = [1, 2, 4, 8];
/** null = theme ink (dark on light paper, light on dark paper). */
const PEN_QUICK_COLORS: (string | null)[] = [null, "#d64545", "#3f7fd6", "#2f9e5a", "#e8853d"];

const HL_WIDTHS = [8, 14, 22];
const HL_COLORS = ["#ffe066", "#9be38f", "#8ccfff", "#ffadd6", "#ffc078"];

type DrawPrefs = {
  color: string | null;
  width: number;
  eraserMode: EraserMode;
  eraserSize: EraserSize;
  hlColor: string;
  hlWidth: number;
  hlOpacity: number;
  arrowMode: "free" | "straight";
  arrowHead: "drawn" | "open" | "full";
  arrowBody: "single" | "double";
};

function loadDrawPrefs(): DrawPrefs {
  const base: DrawPrefs = {
    color: null,
    width: 2,
    eraserMode: "area",
    eraserSize: "M",
    hlColor: HL_COLORS[0],
    hlWidth: 14,
    hlOpacity: 0.4,
    arrowMode: "free",
    arrowHead: "drawn",
    arrowBody: "single",
  };
  try {
    const p = JSON.parse(localStorage.getItem(DRAW_PREFS_KEY) ?? "{}") as Partial<DrawPrefs>;
    return {
      color: typeof p.color === "string" ? p.color : null,
      width: DRAW_WIDTHS.includes(p.width as number) ? (p.width as number) : base.width,
      eraserMode: p.eraserMode === "shape" ? "shape" : "area",
      eraserSize: p.eraserSize && p.eraserSize in ERASER_SIZES ? p.eraserSize : base.eraserSize,
      hlColor: typeof p.hlColor === "string" ? p.hlColor : base.hlColor,
      hlWidth: HL_WIDTHS.includes(p.hlWidth as number) ? (p.hlWidth as number) : base.hlWidth,
      hlOpacity: typeof p.hlOpacity === "number" ? Math.min(0.72, Math.max(0.15, p.hlOpacity)) : base.hlOpacity,
      arrowMode: p.arrowMode === "straight" ? "straight" : "free",
      arrowHead: p.arrowHead === "open" || p.arrowHead === "full" ? p.arrowHead : "drawn",
      arrowBody: p.arrowBody === "double" ? "double" : "single",
    };
  } catch {
    return base;
  }
}

function themeInk(theme: string): string {
  return theme === "dark" ? "#ece7df" : "#23201c";
}

const TOOL_KEYS: Record<string, Tool> = {
  v: "select",
  s: "lasso",
  p: "pen",
  h: "highlighter",
  g: "smart",
  e: "eraser",
  r: "rect",
  o: "ellipse",
  l: "line",
  a: "arrow",
};

/**
 * Case-insensitive matches of `q` in the editor's text windows, in reading order
 * (top-to-bottom, then left-to-right). Matches never span two paragraphs or table cells.
 */
function findRanges(q: string): Range[] {
  const wins = [...document.querySelectorAll<HTMLElement>(".editor-pane .canvas-world .text-window .content")];
  wins.sort((a, b) => {
    const ra = a.getBoundingClientRect();
    const rb = b.getBoundingClientRect();
    return Math.abs(ra.top - rb.top) > 4 ? ra.top - rb.top : ra.left - rb.left;
  });
  const out: Range[] = [];
  for (const root of wins) {
    const nodes: { node: Text; start: number }[] = [];
    let text = "";
    let lastBlock: Element | null = null;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) =>
        n.parentElement?.closest(".pl-math") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
      const block = n.parentElement?.closest(".p, p, li, td, th, h1, h2, h3") ?? root;
      if (lastBlock && block !== lastBlock) text += "\u0000";
      lastBlock = block;
      nodes.push({ node: n, start: text.length });
      text += n.data;
    }
    const hay = text.toLowerCase();
    const locate = (pos: number, end: boolean) => {
      for (let i = nodes.length - 1; i >= 0; i--) {
        const { node, start } = nodes[i];
        if (end ? start < pos : start <= pos) return { node, offset: pos - start };
      }
      return null;
    };
    for (let i = hay.indexOf(q); i >= 0; i = hay.indexOf(q, i + q.length)) {
      const a = locate(i, false);
      const b = locate(i + q.length, true);
      if (!a || !b) continue;
      const r = document.createRange();
      r.setStart(a.node, a.offset);
      r.setEnd(b.node, b.offset);
      out.push(r);
    }
  }
  return out;
}

export function huDate(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : LOCAL_DATE.format(d);
}
export function huDateTime(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : LOCAL_DATETIME.format(d);
}

type Props = {
  mode: "notebook" | "standalone";
  path: string;
  settings: Settings;
  onSettings: (s: Settings) => void;
  onHome: () => void;
  homeTiles: HomeTile[];
  onSwitch: (path: string, kind: "notebook" | "note") => void;
  onToast: (m: string) => void;
  /** Currently open note path (driven by app navigation history). */
  activeNotePath?: string;
  /** First note settled after opening a notebook — sync into history without pushing. */
  onNoteOpened?: (notePath: string) => void;
  /** User chose another note in the sidebar — push history. */
  onNoteUserOpen?: (notePath: string) => void;
  initialFind?: string;
  /** Open the summary desk with this notebook, or the standalone note, already checked. */
  onBrief: () => void;
  /** Open or close the chat beside the note. */
  onAsk: () => void;
  onOpenSettings: () => void;
  /** Customer trial is over: read and navigate, do not edit. */
  expired?: boolean;
  onQuickAsk: (seed: QuickSeed) => void;
  onCalc?: () => void;
  onAnalyze?: () => void;
  /** Hands the parent a way to save the open note right now. */
  onRegisterSave?: (save: (() => Promise<void>) | null) => void;
  /** A floating Moodle window is already open, so this view must not open a second one. */
  moodleHeld?: boolean;
  /** Dock the floating window back beside this notebook's note. */
  moodleDock?: { path: string; n: number } | null;
  /** Detach Moodle for this notebook into the floating window. */
  onFloatMoodle?: (name: string, preservePage: boolean) => void;
};

/** chrono strftime patterns offered for "Add today"; the first is the default. */
const TODAY_FORMATS = ["%Y-%m-%d", "%Y-%m-%d (%a)", "%d.%m.%Y", "%m-%d"];

/** Live preview of a strftime pattern (only the specifiers used above). */
function fmtToday(d: Date, f: string): string {
  const p2 = (n: number) => String(n).padStart(2, "0");
  return f
    .replace(/%Y/g, String(d.getFullYear()))
    .replace(/%m/g, p2(d.getMonth() + 1))
    .replace(/%d/g, p2(d.getDate()))
    .replace(/%a/g, d.toLocaleDateString("en-US", { weekday: "short" }));
}

export function NotebookView({
  mode,
  path,
  settings,
  onSettings,
  onHome,
  homeTiles,
  onSwitch,
  onToast,
  activeNotePath,
  onNoteOpened,
  onNoteUserOpen,
  initialFind,
  onBrief,
  onAsk,
  onOpenSettings,
  expired = false,
  onQuickAsk,
  onCalc,
  onAnalyze,
  onRegisterSave,
  moodleHeld = false,
  moodleDock = null,
  onFloatMoodle,
}: Props) {
  const [info, setInfo] = useState<NotebookInfo | null>(null);
  const [moodleOpen, setMoodleOpen] = useState(false);
  const [tourAt, setTourAt] = useState("");
  const [moodlePreserve, setMoodlePreserve] = useState(false);
  const [moodleHint, setMoodleHint] = useState(false);
  const insertPdfRef = useRef<(paths: string[]) => void>(() => {});
  const [dragGhost, setDragGhost] = useState<MoodleDragGhost | null>(null);
  const dragLand = useRef<{ token: number; x: number; y: number } | null>(null);
  const dragReady = useRef<{ token: number; b64: string; media: string; aspects: number[]; preview: string } | null>(null);
  const dragPrep = useRef(0);
  const dragPlaced = useRef(new Set<number>());
  const [note, setNote] = useState<NotePayload | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saveInFlight, setSaveInFlight] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const savedFlashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [openRibbons, setOpenRibbons] = useState<Set<Ribbon>>(() => new Set(["Edit"]));
  const [titleScrolledAway, setTitleScrolledAway] = useState(false);
  /** Keep the title open after a manual reveal until the canvas returns to the top. */
  const [titleHoldOpen, setTitleHoldOpen] = useState(false);
  const onRibbonTab = (r: Ribbon, e: React.MouseEvent) => {
    if (e.ctrlKey || e.metaKey) {
      setOpenRibbons((prev) => {
        const next = new Set(prev);
        if (next.has(r)) {
          if (next.size > 1) next.delete(r);
        } else {
          next.add(r);
        }
        return next;
      });
    } else {
      setOpenRibbons(new Set([r]));
    }
  };
  const [ui, setUi] = useState<NotebookUiState>({
    sort: "name",
    sidebar_width: 224,
    sidebar_collapsed: false,
  });
  const [listFilter, setListFilter] = useState("");
  const noteListRef = useRef<HTMLUListElement>(null);
  const [switcher, setSwitcher] = useState(false);
  const [switchFilter, setSwitchFilter] = useState("");
  const [tool, setTool] = useState<Tool>("select");
  const [wheel, setWheel] = useState<{ x: number; y: number; at: number } | null>(null);
  const [drawPop, setDrawPop] = useState<{ x: number; y: number } | null>(null);
  const [gifOpen, setGifOpen] = useState(false);
  const [drawPrefs, setDrawPrefs] = useState<DrawPrefs>(loadDrawPrefs);
  const drawColor = drawPrefs.color ?? themeInk(settings.theme);
  const drawWidth = drawPrefs.width;
  const updateDrawPrefs = (patch: Partial<DrawPrefs>) =>
    setDrawPrefs((p) => {
      const next = { ...p, ...patch };
      try {
        localStorage.setItem(DRAW_PREFS_KEY, JSON.stringify(next));
      } catch {
        /* quota / private mode */
      }
      return next;
    });
  const viewRef = useRef<CanvasViewApi | null>(null);
  const [bulletStyle, setBulletStyle] = useState("disc");
  const [format, setFormat] = useState<FormatState | null>(null);
  const [mathEdit, setMathEdit] = useState<
    { target: HTMLElement; initial: string; isNew: boolean; id: number } | null
  >(null);
  const mathEditSeq = useRef(0);
  const mathInsertRef = useRef<() => void>(() => {});
  const [defaultFont, setDefaultFont] = useState(DEFAULT_FONT);
  const [defaultSize, setDefaultSize] = useState(DEFAULT_SIZE);
  const [sizeDraft, setSizeDraft] = useState<string | null>(null);
  const [lastColor, setLastColor] = useState(() =>
    settings.theme === "dark" ? "#ffffff" : "#000000",
  );
  const [lastHl, setLastHl] = useState("#ffe066");
  const [findOpen, setFindOpen] = useState(!!initialFind);
  const [findQ, setFindQ] = useState(initialFind ?? "");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [titleDraft, setTitleDraft] = useState("");
  const [ctx, setCtx] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState>(null);
  const [prompt, setPrompt] = useState<PromptState>(null);
  const [guard, setGuard] = useState<{ then: () => void } | null>(null);
  const [sbDragging, setSbDragging] = useState(false);

  // export flow
  const [exportSel, setExportSel] = useState<Record<string, boolean> | null>(null);
  const [sepDrag, setSepDrag] = useState<{ id: string; to: number } | null>(null);
  const [sepEdit, setSepEdit] = useState<{ id: string; title: string } | null>(null);
  const sepDragRef = useRef(sepDrag);
  sepDragRef.current = sepDrag;
  const [exportOpts, setExportOpts] = useState<{
    multi: boolean;
    paths: string[];
  } | null>(null);
  const dragCheck = useRef<{ start: string; startVal: boolean } | null>(null);

  // pdf preview
  const [pdf, setPdf] = useState<{
    scale: number;
    page: number;
    pages: { x: number; y: number; h: number; titleBlock: number; title?: string }[];
  } | null>(null);
  const [pdfZoom, setPdfZoom] = useState(1);
  const pdfZoomRef = useRef(1);
  const pdfPreviewRef = useRef<HTMLDivElement>(null);
  const pdfScrollRef = useRef<HTMLDivElement>(null);
  const pdfZoomAnchorRef = useRef<ReturnType<typeof pdfZoomAnchor>>(null);

  useEffect(() => {
    if (!pdf || !note) return;
    const last = pdf.pages[pdf.pages.length - 1];
    if (!last) return;
    const span = (A4.h - 2 * A4.margin - last.titleBlock) / pdf.scale;
    const floor = last.y + span;
    let maxBottom = floor;
    const hidden = collapsedIds(note.doc.canvas.objects);
    for (const o of note.doc.canvas.objects) {
      if (hidden.has(o.id)) continue;
      if (o.type === "text" && !blocksPlainText(o.blocks).trim()) continue;
      if (o.type === "group" && o.collapsed) {
        maxBottom = Math.max(maxBottom, (o.marker_y ?? o.y) + 28);
        continue;
      }
      const b = objectBBox(o, heightsRef.current);
      maxBottom = Math.max(maxBottom, b.y + b.h);
    }
    if (maxBottom <= floor + 0.5) return;
    const full = (A4.h - 2 * A4.margin) / pdf.scale;
    const extra: typeof pdf.pages = [];
    let y = floor;
    for (let guard = 0; maxBottom - y > 0.5 && guard < 30; guard++) {
      extra.push({ x: last.x, y, h: full, titleBlock: 0 });
      y += full;
    }
    if (extra.length) setPdf((p) => (p ? { ...p, pages: [...p.pages, ...extra] } : p));
  }, [note, pdf]);

  // undo/redo
  const past = useRef<NoteDocument[]>([]);
  const future = useRef<NoteDocument[]>([]);
  const lastSnap = useRef({ t: 0, key: "" });
  const heightsRef = useRef<Record<string, number>>({});
  const noteRef = useRef<NotePayload | null>(null);
  noteRef.current = note;
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  const closingRef = useRef(false);
  const camRef = useRef<{ x: number; y: number; z: number; w: number; h: number } | null>(null);
  const titleAwayRef = useRef(false);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const pdfCamZ = useRef<number | null>(null);
  const pdfScrollWant = useRef<{ page: number; frac: number } | null>(null);
  const restoreCamRef = useRef<{ x: number; y: number; z: number } | null>(null);
  const expiredRef = useRef(expired);
  expiredRef.current = expired;
  const savingRef = useRef(false);
  const saveAgainRef = useRef(false);

  const patchSettings = (partial: Partial<Settings>) => {
    const next = { ...settingsRef.current, ...partial };
    settingsRef.current = next;
    onSettings(next);
    void api.saveSettings(next).catch((e) => onToast(String(e)));
  };

  const noteOpen = !!note;
  // liveCamRef is written after each camera commit. Poll it while a note is open
  // so auto-hide follows pan and zoom without re-rendering the editor.
  useEffect(() => {
    if (!noteOpen || settings.title_auto_hide === false) {
      titleAwayRef.current = false;
      setTitleScrolledAway(false);
      return;
    }
    let frame = 0;
    let dead = false;
    const tick = () => {
      if (dead) return;
      const cam = camRef.current;
      // A canvas point (x, y) is drawn at (cam.x + x*cam.z, cam.y + y*cam.z).
      // The viewport's top edge is therefore canvas y = -cam.y / cam.z.
      const top = cam && cam.z > 0 ? -cam.y / cam.z : 0;
      const prev = titleAwayRef.current;
      const editingTitle = !!document.activeElement?.closest(".note-title-row");
      const away = !editingTitle && (prev ? top > TITLE_AUTOSHOW_Y : top > TITLE_AUTOHIDE_Y);
      if (away !== prev) {
        titleAwayRef.current = away;
        setTitleScrolledAway(away);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      dead = true;
      cancelAnimationFrame(frame);
    };
  }, [noteOpen, settings.title_auto_hide]);

  useEffect(() => {
    if (!titleScrolledAway) setTitleHoldOpen(false);
  }, [titleScrolledAway]);

  /** True while undo/redo is writing the document, so the blur-commit cannot clobber it or clear redo. */
  const applyingHist = useRef(false);

  const snapshot = useCallback((key: string, coalesceMs = 0) => {
    if (applyingHist.current) return;
    const n = noteRef.current;
    if (!n) return;
    const now = Date.now();
    if (coalesceMs && lastSnap.current.key === key && now - lastSnap.current.t < coalesceMs) {
      lastSnap.current.t = now;
      return;
    }
    past.current.push(structuredClone(n.doc));
    if (past.current.length > 200) past.current.shift();
    future.current = [];
    lastSnap.current = { t: now, key };
  }, []);

  const applyDoc = (doc: NoteDocument) => {
    const n = noteRef.current;
    if (!n) return;
    applyingHist.current = true;
    (document.activeElement as HTMLElement | null)?.blur();
    setNote({ ...n, doc });
    setDirty(true);
    applyingHist.current = false;
  };

  const undo = useCallback(() => {
    const prev = past.current.pop();
    const n = noteRef.current;
    if (!prev || !n) return;
    future.current.push(structuredClone(n.doc));
    lastSnap.current = { t: 0, key: "" };
    applyDoc(prev);
  }, []);

  const redo = useCallback(() => {
    const next = future.current.pop();
    const n = noteRef.current;
    if (!next || !n) return;
    past.current.push(structuredClone(n.doc));
    lastSnap.current = { t: 0, key: "" };
    applyDoc(next);
  }, []);

  const noteChanged = (n: NotePayload) => {
    setNote(n);
    setDirty(true);
  };

  const updateNote = useCallback((fn: (n: NotePayload) => NotePayload) => {
    if (applyingHist.current || noteRef.current?.read_only) return;
    setNote((prev) => (prev ? fn(prev) : prev));
    setDirty(true);
  }, []);

  /* ── loading ── */
  const loadNoteAt = useCallback(async (p: string) => {
    const n = await api.loadNote(p);
    past.current = [];
    future.current = [];
    heightsRef.current = {};
    setNote(n);
    setTitleDraft(n.display_title);
    setDirty(false);
    setPdf(null);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        if (mode === "standalone") {
          setInfo(null);
          await loadNoteAt(path);
          return;
        }
        const nb = await api.openNotebook(path);
        setInfo(nb);
        const nui = await api.getNotebookUi(path);
        setUi({
          ...nui,
          sort: nui.sort || "name",
          sidebar_width: nui.sidebar_width || 224,
        });
        const target =
          activeNotePath ??
          (nui.last_note ? nb.notes.find((x) => x.title === nui.last_note)?.path : undefined) ??
          nb.notes[0]?.path;
        if (target) {
          await loadNoteAt(target);
          onNoteOpened?.(target);
        } else setNote(null);
      } catch (e) {
        onToast(String(e));
      }
    })();
    // Only re-open when notebook/mode changes — note switches are handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, path, loadNoteAt, onToast]);

  const refreshInfo = useCallback(async () => {
    if (mode !== "notebook") return null;
    const nb = await api.openNotebook(path);
    setInfo(nb);
    return nb;
  }, [mode, path]);

  /* ── saving ── */
  /** Saves the open note; false when the write failed (the edits then go to recovery). */
  const save = useCallback(async (): Promise<boolean> => {
    const n = noteRef.current;
    if (!n || n.read_only) return true;
    setSaveInFlight(true);
    try {
      const saved = await api.saveNote({
        ...n,
        doc: {
          ...n.doc,
          canvas: {
            ...n.doc.canvas,
            objects: n.doc.canvas.objects.filter((o) => !(o.type === "pdf" && o.pending)),
          },
        },
      });
      const cur = noteRef.current;
      if (!cur || cur.path !== n.path) return true;
      // Keep any edits that landed while the write was in flight.
      const stillDirty = cur.doc !== n.doc || cur.media_b64 !== n.media_b64;
      setNote({ ...saved, doc: cur.doc, media_b64: cur.media_b64, display_title: cur.display_title });
      dirtyRef.current = stillDirty;
      setDirty(stillDirty);
      if (!stillDirty) {
        await api.clearRecovery(n.path);
        setSavedFlash(true);
        if (savedFlashTimer.current) clearTimeout(savedFlashTimer.current);
        savedFlashTimer.current = setTimeout(() => setSavedFlash(false), 2000);
      }
      setInfo((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          notes: prev.notes.map((item) =>
            item.path === saved.path
              ? { ...item, modified: saved.modified, created: saved.created }
              : item,
          ),
        };
      });
      return true;
    } catch (e) {
      onToast(`Save failed: ${e}`);
      api.writeRecovery(n.path, n).catch(() => {});
      return false;
    } finally {
      setSaveInFlight(false);
    }
  }, [onToast]);

  useEffect(() => {
    if (dirty) setSavedFlash(false);
  }, [dirty]);

  useEffect(
    () => () => {
      if (savedFlashTimer.current) clearTimeout(savedFlashTimer.current);
    },
    [],
  );

  /** Immediate autosave with in-flight coalescing (no 5s wait). */
  const flushSave = useCallback(async () => {
    if (savingRef.current) {
      saveAgainRef.current = true;
      return;
    }
    savingRef.current = true;
    try {
      do {
        saveAgainRef.current = false;
        await save();
      } while (saveAgainRef.current);
    } finally {
      savingRef.current = false;
    }
  }, [save]);

  useEffect(() => {
    onRegisterSave?.(async () => {
      if (dirtyRef.current && noteRef.current) await save();
    });
    return () => onRegisterSave?.(null);
  }, [onRegisterSave, save]);

  /* Auto-save, or without it a recovery copy, shortly after the last edit. */
  useEffect(() => {
    if (!expired) return;
    dirtyRef.current = false;
    setDirty(false);
  }, [expired]);

  useEffect(() => {
    if (!dirty || !note || note.read_only || expired) return;
    const id = window.setTimeout(
      () => {
        if (settings.autosave) void flushSave();
        else api.writeRecovery(note.path, note).catch(() => {});
      },
      settings.autosave ? 400 : 1500,
    );
    return () => window.clearTimeout(id);
  }, [dirty, note, settings.autosave, flushSave, expired]);

  /* leave guard: save / discard / cancel */
  const guarded = useCallback(
    (action: () => void) => {
      if (expiredRef.current) {
        dirtyRef.current = false;
        action();
        return;
      }
      if (!dirtyRef.current || !noteRef.current) {
        action();
        return;
      }
      if (settings.autosave) {
        save().then((ok) => ok && action());
        return;
      }
      setGuard({ then: action });
    },
    [settings.autosave, save],
  );

  /* Closing the window goes through the same guard.
   * After a save, re-issue close() so the tray can hide and a known update can prompt. */
  useEffect(() => {
    const win = getCurrentWindow();
    let off: (() => void) | undefined;
    let gone = false;
    const w = window as Window & { __plCloseForDirty?: boolean };
    win
      .onCloseRequested((e) => {
        // Always cancel. This listener destroys the window on return, which
        // races App's installer spawn and also turns tray X into a real quit.
        e.preventDefault();
        if (expiredRef.current || closingRef.current) return;
        if (!dirtyRef.current || !noteRef.current) return;
        w.__plCloseForDirty = true;
        guarded(() => {
          w.__plCloseForDirty = false;
          closingRef.current = true;
          void win.close().finally(() => window.setTimeout(() => (closingRef.current = false), 300));
        });
      })
      .then((u) => (gone ? u() : (off = u)));
    return () => {
      gone = true;
      w.__plCloseForDirty = false;
      off?.();
    };
  }, [guarded]);

  /* History back/forward changed the active note. */
  useEffect(() => {
    if (mode !== "notebook" || !activeNotePath) return;
    if (noteRef.current?.path === activeNotePath) return;
    guarded(() => {
      void loadNoteAt(activeNotePath);
    });
  }, [activeNotePath, mode, loadNoteAt, guarded]);

  /* ── keyboard ── */
  useEffect(() => {
    const inNoteText = () => {
      const ae = document.activeElement as HTMLElement | null;
      return !!ae?.isContentEditable && !!ae.closest(".canvas-wrap");
    };
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (expiredRef.current && (k === "s" || k === "z" || k === "y" || k === "n") && e.ctrlKey) {
        e.preventDefault();
        return;
      }
      if (e.ctrlKey && k === "s") {
        e.preventDefault();
        save();
      } else if (e.ctrlKey && !e.shiftKey && k === "z") {
        e.preventDefault();
        undo();
      } else if ((e.ctrlKey && k === "y") || (e.ctrlKey && e.shiftKey && k === "z")) {
        e.preventDefault();
        redo();
      } else if (e.ctrlKey && !e.shiftKey && k === "f") {
        e.preventDefault();
        setFindOpen(true);
        setTimeout(() => document.querySelector<HTMLInputElement>(".find-bar input")?.focus(), 40);
      } else if (e.ctrlKey && k === "n" && mode === "notebook") {
        e.preventDefault();
        createNote();
      } else if (e.ctrlKey && k === "m") {
        e.preventDefault();
        mathInsertRef.current();
      } else if (e.ctrlKey && !e.altKey && (e.key === "-" || e.code === "Minus") && inNoteText()) {
        e.preventDefault();
        execRef.current("strikeThrough");
      } else if (e.ctrlKey && !e.altKey && !e.shiftKey && (e.key === "=" || e.code === "Equal") && inNoteText()) {
        e.preventDefault();
        execRef.current("subscript");
      } else if (e.ctrlKey && e.shiftKey && (e.key === "=" || e.key === "+" || e.code === "Equal") && inNoteText()) {
        e.preventDefault();
        execRef.current("superscript");
      } else if (e.ctrlKey && e.key === " " && inNoteText()) {
        e.preventDefault();
        execRef.current("removeFormat");
      } else if (e.key === "F2") {
        const n = noteRef.current;
        if (n) {
          e.preventDefault();
          setRenaming(n.path);
          setRenameDraft(n.display_title);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [save, undo, redo, mode]);

  /* Thumb buttons: bottom = undo, top = redo. Only this view (a note) is mounted. */
  useEffect(() => {
    const run = (e: MouseEvent) => {
      if (e.button !== 3 && e.button !== 4) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.button === 3) undo();
      else redo();
    };
    const swallow = (e: Event) => {
      const b = (e as MouseEvent).button;
      if (b === 3 || b === 4) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    // Keep the webview from treating the back thumb button as history navigation.
    history.pushState({ owThumb: 1 }, "");
    const onPop = () => history.pushState({ owThumb: 1 }, "");
    window.addEventListener("mousedown", run, true);
    window.addEventListener("mouseup", swallow, true);
    window.addEventListener("auxclick", swallow, true);
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("mousedown", run, true);
      window.removeEventListener("mouseup", swallow, true);
      window.removeEventListener("auxclick", swallow, true);
      window.removeEventListener("popstate", onPop);
    };
  }, [undo, redo]);

  /* Single-key draw tools (Excalidraw-style) — only while not typing anywhere. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey) return;
      const ae = document.activeElement as HTMLElement | null;
      if (ae && (ae.isContentEditable || ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.tagName === "SELECT")) return;
      if (document.querySelector(".modal-backdrop, .math-pop")) return;
      const k = e.key.toLowerCase();
      if (e.key === "Escape") {
        if (tool !== "select") setTool("select");
        return;
      }
      if (k === "[" || k === "]") {
        e.preventDefault();
        const step = (list: number[], cur: number) => {
          const i = Math.max(0, list.indexOf(cur));
          return list[Math.max(0, Math.min(list.length - 1, i + (k === "]" ? 1 : -1)))];
        };
        setDrawPrefs((p) => {
          const next =
            tool === "highlighter"
              ? { ...p, hlWidth: step(HL_WIDTHS, p.hlWidth) }
              : { ...p, width: step(DRAW_WIDTHS, p.width) };
          localStorage.setItem(DRAW_PREFS_KEY, JSON.stringify(next));
          return next;
        });
        return;
      }
      if (e.shiftKey && k === "e") {
        e.preventDefault();
        setDrawPrefs((p) => {
          const next: DrawPrefs = { ...p, eraserMode: p.eraserMode === "area" ? "shape" : "area" };
          localStorage.setItem(DRAW_PREFS_KEY, JSON.stringify(next));
          return next;
        });
        return;
      }
      const t = TOOL_KEYS[k];
      if (!t || e.shiftKey || !noteRef.current) return;
      // Letters belong to text whenever anything is selected or focus is outside the bare canvas.
      if (canvasSelRef.current.length) return;
      if (ae && ae !== document.body && !ae.classList.contains("canvas-wrap")) return;
      e.preventDefault();
      setTool(t);
      if (t !== "select") setOpenRibbons((prev) => (prev.has("Draw") ? prev : new Set<Ribbon>(["Draw"])));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tool]);

  useEffect(() => {
    setLastColor((c) =>
      c === "#000000" || c === "#ffffff" ? (settings.theme === "dark" ? "#ffffff" : "#000000") : c,
    );
  }, [settings.theme]);

  /* ── notes list ── */
  const sortedNotes = useMemo(() => {
    if (!info) return [] as NoteListItem[];
    const notes = [...info.notes];
    const sort = ui.sort || "name";
    const byName = (a: NoteListItem, b: NoteListItem) =>
      a.title.localeCompare(b.title, "hu", { numeric: true, sensitivity: "base" });
    /** chrono emits ns-precision RFC3339; truncate to ms so Date.parse is reliable. */
    const ts = (iso: string) => {
      if (!iso) return 0;
      const t = Date.parse(iso.replace(/(\.\d{3})\d+/, "$1"));
      return Number.isFinite(t) ? t : 0;
    };
    notes.sort((a, b) => {
      if (sort.startsWith("name")) {
        const c = byName(a, b);
        return sort === "name_desc" ? -c : c;
      }
      const ta = ts(a.created);
      const tb = ts(b.created);
      if (ta !== tb) {
        // created = oldest→newest (top→bottom); created_desc = newest first (later toward top)
        return sort === "created_desc" ? tb - ta : ta - tb;
      }
      return byName(a, b);
    });
    return notes;
  }, [info, ui.sort]);

  const sepKey = (ui.sort || "name") as keyof Separators;
  const seps = info?.separators?.[sepKey] ?? [];

  const persistUi = async (next: NotebookUiState) => {
    setUi(next);
    if (mode === "notebook") await api.setNotebookUi(path, next);
  };

  const openNote = (p: string) =>
    guarded(async () => {
      await loadNoteAt(p);
      if (mode === "notebook") {
        const stem = p.replace(/^.*[\\/]/, "").replace(/\.note$/i, "");
        persistUi({ ...ui, last_note: stem });
        onNoteUserOpen?.(p);
      }
    });

  const createNote = () =>
    guarded(async () => {
      if (expiredRef.current || mode !== "notebook") return;
      const item = await api.createNote(path);
      await refreshInfo();
      await loadNoteAt(item.path);
      onNoteUserOpen?.(item.path);
      if (titleAwayRef.current) setTitleHoldOpen(true);
      if (settingsRef.current.title_collapsed) patchSettings({ title_collapsed: false });
      setTimeout(() => document.querySelector<HTMLInputElement>(".note-title-row input.title")?.focus(), 60);
    });

  const commitRename = async (notePath: string, title: string) => {
    setRenaming(null);
    try {
      const newPath = await api.renameNote(notePath, title || "Untitled");
      await refreshInfo();
      if (noteRef.current?.path === notePath) {
        const n = await api.loadNote(newPath);
        setNote((cur) => (cur ? { ...n, doc: cur.doc, media_b64: cur.media_b64 } : n));
        setTitleDraft(n.display_title);
      }
    } catch (e) {
      onToast(String(e));
    }
  };

  const deleteNote = (item: NoteListItem) => {
    setConfirm({
      title: `Delete "${item.display_title || "Untitled"}"?`,
      message: "The note is moved to the Recycle Bin.",
      okLabel: "Delete",
      danger: true,
      onOk: async () => {
        try {
          const order = sortedNotes.map((x) => x.path);
          const idx = order.indexOf(item.path);
          const neighbour = order[idx + 1] ?? order[idx - 1];
          await api.deleteNote(item.path);
          const nb = await refreshInfo();
          if (noteRef.current?.path === item.path) {
            const next = nb?.notes.some((x) => x.path === neighbour) ? neighbour : nb?.notes[0]?.path;
            if (next) await loadNoteAt(next);
            else setNote(null);
          }
        } catch (e) {
          onToast(String(e));
        }
      },
    });
  };

  const freshSepId = () => `sep-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  const normalizeSeps = (list: SeparatorEntry[]) =>
    list.map((s, i) => ({
      after: s.after ?? "",
      id: s.id || `legacy-${i}-${s.after}`,
      title: (s.title ?? "").toUpperCase(),
    }));

  const writeSeparators = async (next: SeparatorEntry[]) => {
    if (!info) return;
    const all = structuredClone(info.separators);
    all[sepKey] = next;
    await api.saveSeparators(info.path, all);
    setInfo({ ...info, separators: all });
  };

  const currentSeps = () => normalizeSeps(seps);

  const addSeparator = (afterTitle: string) => {
    void writeSeparators([...currentSeps(), { after: afterTitle, id: freshSepId(), title: "" }]);
  };

  const removeSeparator = (id: string) => {
    void writeSeparators(currentSeps().filter((s) => s.id !== id));
  };

  const retitleSeparator = (id: string, title: string) => {
    const next = title.toUpperCase();
    void writeSeparators(currentSeps().map((s) => (s.id === id ? { ...s, title: next } : s)));
  };

  /* ── formatting ── */

  /**
   * The last caret position inside a text window. Ribbon controls must not
   * steal focus; we restore this before applying formatting to a selection.
   */
  const savedSel = useRef<SavedSelection | null>(null);
  /** Canvas object ids currently selected (from CanvasEditor). */
  const canvasSelRef = useRef<string[]>([]);
  /** Last stroke or shape. The ribbon restyles it until the next click or stroke. */
  const liveDrawRef = useRef<string | null>(null);
  const onLiveDraw = useCallback((id: string | null) => {
    liveDrawRef.current = id;
  }, []);
  const drawTargetIds = () => {
    const sel = canvasSelRef.current;
    if (sel.length) return sel;
    return liveDrawRef.current ? [liveDrawRef.current] : [];
  };
  /** Canvas-highlight edit mode: one text box selected, ribbon edits apply to the whole box. */
  const [highlightedTextId, setHighlightedTextId] = useState<string | null>(null);
  /** True while programmatically applying format to a highlighted box (ignore transient focus). */
  const formatLockRef = useRef(false);
  /** True while a ribbon control is handling a click (don't clear savedSel). */
  const ribbonLive = useRef(false);

  const getHighlightedContent = useCallback((): HTMLElement | null => {
    const id = highlightedTextId;
    if (!id || !canvasSelRef.current.includes(id)) return null;
    const win = document.querySelector(
      `[data-oid="${CSS.escape(id)}"]`,
    ) as HTMLElement | null;
    if (!win?.classList.contains("selected")) return null;
    return win.querySelector(".content") as HTMLElement | null;
  }, [highlightedTextId]);

  /**
   * Whole-window format target: purple canvas-highlight (top bar / move /
   * marquee of a single text window). DOM focus must not drop this mode.
   */
  const windowFormatContent = (): HTMLElement | null => getHighlightedContent();

  useEffect(() => {
    const onSelChange = () => {
      if (ribbonLive.current || formatLockRef.current) return;
      const ae = document.activeElement as HTMLElement | null;
      const inContent = !!ae?.closest?.(".content");
      // Box-select mode stays until the user clicks inside the text (onTextEditStart).
      const highlighted = getHighlightedContent();
      if (highlighted) {
        setFormat(readFormatStateFromContent(highlighted));
        savedSel.current = null;
        return;
      }
      if (inContent) {
        const saved = saveSelection();
        if (saved) {
          savedSel.current = saved;
          setFormat(readFormatState(saved.content));
        } else {
          setFormat(null);
        }
        return;
      }
      setFormat(null);
      savedSel.current = null;
    };
    document.addEventListener("selectionchange", onSelChange);
    return () => document.removeEventListener("selectionchange", onSelChange);
  }, [getHighlightedContent]);

  /** Capture the in-text selection before a ribbon control runs. */
  const keepTextSelection = () => {
    ribbonLive.current = true;
    const saved = saveSelection();
    if (saved) savedSel.current = saved;
  };

  const endRibbon = useCallback(() => {
    requestAnimationFrame(() => {
      ribbonLive.current = false;
    });
  }, []);

  const refreshHighlightedFormat = useCallback(() => {
    if (ribbonLive.current || formatLockRef.current) return;
    const ae = document.activeElement as HTMLElement | null;
    if (ae?.closest?.(".content")) return;
    const highlighted = getHighlightedContent();
    if (highlighted) {
      setFormat(readFormatStateFromContent(highlighted));
      savedSel.current = null;
    } else if (!ae?.closest?.(".content")) {
      setFormat(null);
      savedSel.current = null;
    }
  }, [getHighlightedContent]);

  /** True for the click that entered type mode; canvas selection must not restore the wash. */
  const typingClickRef = useRef(false);

  const onCanvasSelection = useCallback(
    (ids: string[]) => {
      canvasSelRef.current = ids;
      if (formatLockRef.current) return;
      if (typingClickRef.current) {
        typingClickRef.current = false;
        setHighlightedTextId(null);
        refreshHighlightedFormat();
        return;
      }
      if (ids.length === 1) {
        const o = noteRef.current?.doc.canvas.objects.find((x) => x.id === ids[0]);
        setHighlightedTextId(o?.type === "text" ? ids[0] : null);
      } else {
        setHighlightedTextId(null);
      }
      refreshHighlightedFormat();
    },
    [refreshHighlightedFormat],
  );

  const onTextEditStart = useCallback((_id: string) => {
    if (formatLockRef.current) return;
    typingClickRef.current = true;
    setHighlightedTextId(null);
    requestAnimationFrame(() => {
      typingClickRef.current = false;
    });
  }, []);

  const onWindowSelect = useCallback((id: string) => {
    typingClickRef.current = false;
    const o = noteRef.current?.doc.canvas.objects.find((x) => x.id === id);
    setHighlightedTextId(o?.type === "text" ? id : null);
  }, []);

  const applyHighlightedFormat = (content: HTMLElement, fn: () => boolean | void) => {
    formatLockRef.current = true;
    keepTextSelection();
    snapshot("format", 400);
    applyToAllContent(content, fn);
    const oid = content.closest("[data-oid]")?.getAttribute("data-oid");
    if (oid) setHighlightedTextId(oid);
    setFormat(readFormatStateFromContent(content));
    content.dispatchEvent(new Event("input", { bubbles: true }));
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        formatLockRef.current = false;
        endRibbon();
      });
    });
  };

  useEffect(() => {
    const onDbl = (e: MouseEvent) => {
      const math = (e.target as HTMLElement | null)?.closest?.(".pl-math") as HTMLElement | null;
      if (math) {
        e.preventDefault();
        e.stopPropagation();
        snapshot("math");
        setMathEdit({
          target: math,
          initial: math.dataset.tex ?? "",
          isNew: false,
          id: ++mathEditSeq.current,
        });
      }
    };
    document.addEventListener("dblclick", onDbl, true);
    return () => document.removeEventListener("dblclick", onDbl, true);
  }, [snapshot]);

  const withSelection = (label: string, fn: (content: HTMLElement) => boolean | void): void => {
    const win = windowFormatContent();
    if (win) {
      applyHighlightedFormat(win, () => fn(win));
      return;
    }
    keepTextSelection();
    const saved = savedSel.current;
    if (!restoreSelection(saved)) {
      onToast("Click into a text window first");
      return;
    }
    const content = saved!.content;
    snapshot("format", 400);
    const collapsed = window.getSelection()?.isCollapsed ?? true;
    const ok = fn(content);
    // Collapsed caret: execCommand sets the typing default (Word). Don't demand a range.
    if (ok === false && !collapsed) {
      onToast(`Select some text to ${label}`);
      return;
    }
    savedSel.current = saveSelection() ?? savedSel.current;
    if (savedSel.current) restoreSelection(savedSel.current);
    setFormat(readFormatState(content));
    content.dispatchEvent(new Event("input", { bubbles: true }));
  };

  /** Range → that text; caret → next typed characters; window chrome → whole box. */
  const applyLiveFormat = (fn: () => boolean | void): boolean => {
    const win = windowFormatContent();
    if (win) {
      applyHighlightedFormat(win, fn);
      return true;
    }

    const saved = savedSel.current;
    if (!saved || !saved.content.isConnected) {
      endRibbon();
      return false;
    }
    const active = saved;
    if (!restoreSelection(active)) {
      setFormat(null);
      endRibbon();
      return false;
    }
    const content = active.content;
    snapshot("format", 400);
    const ok = fn();
    if (ok === false) {
      endRibbon();
      return false;
    }
    savedSel.current = saveSelection() ?? saved;
    if (savedSel.current) restoreSelection(savedSel.current);
    setFormat(readFormatState(content));
    content.dispatchEvent(new Event("input", { bubbles: true }));
    endRibbon();
    return true;
  };

  /** Font: whole window when canvas-highlighted; else caret/selection (typing default). */
  const changeFont = (font: string) => {
    setDefaultFont(font);
    applyLiveFormat(() => setFontFamily(font));
  };

  /** Size: whole window when canvas-highlighted; else caret/selection (typing default). */
  const changeSize = (pt: number) => {
    const size = Math.max(5, Math.min(200, pt));
    setDefaultSize(size);
    setSizeDraft(null);
    applyLiveFormat(() => setFontSize(size));
  };

  /** Text colour: sticky default + apply to selection when present.
   *  null = theme ink (black on light/mix pages, white on dark). */
  const changeColor = (c: string | null) => {
    const color =
      c ?? (settings.theme === "dark" ? "#ffffff" : "#000000");
    setLastColor(color);
    applyLiveFormat(() => setTextColor(color));
  };

  /** Highlight: sticky default (when non-null) + apply / clear on selection. */
  const changeHighlight = (c: string | null) => {
    if (c) setLastHl(c);
    applyLiveFormat(() => setHighlight(c));
  };

  const changeSizeRef = useRef(changeSize);
  changeSizeRef.current = changeSize;
  const formatRef = useRef(format);
  formatRef.current = format;
  const defaultSizeRef = useRef(defaultSize);
  defaultSizeRef.current = defaultSize;
  const bulletStyleRef = useRef(bulletStyle);
  bulletStyleRef.current = bulletStyle;

  const fontWrapRef = useRef<HTMLDivElement>(null);
  const sizeStepperRef = useRef<HTMLDivElement>(null);
  const bulletStyleRefEl = useRef<HTMLSelectElement>(null);
  const toggleWheelRef = useRef<HTMLDivElement>(null);

  const restyleBullets = (style: string) => {
    setBulletStyle(style);
    const win = windowFormatContent();
    if (win) {
      snapshot("bullets", 400);
      const bulleted = [...win.querySelectorAll<HTMLElement>(":scope > div.p")].filter(
        (p) => p.dataset.bullet,
      );
      if (!bulleted.length) return;
      bulleted.forEach((p) => {
        p.dataset.bullet = style;
        p.dataset.glyph = BULLET_GLYPHS[style] ?? "•";
      });
      win.dispatchEvent(new Event("input", { bubbles: true }));
      setFormat(readFormatStateFromContent(win));
      return;
    }
    keepTextSelection();
    const saved = savedSel.current;
    if (!saved || !restoreSelection(saved)) return;
    const el = saved.content;
    const sel = window.getSelection();
    if (!sel?.anchorNode) return;
    const paras = new Set<HTMLElement>();
    const collect = (node: Node | null) => {
      let n: Node | null = node;
      while (n && n !== el) {
        if (n instanceof HTMLElement && n.classList.contains("p")) {
          paras.add(n);
          return;
        }
        n = n.parentNode;
      }
    };
    collect(sel.anchorNode);
    collect(sel.focusNode);
    if (!sel.isCollapsed) {
      el.querySelectorAll(":scope > div.p").forEach((p) => {
        if (sel.containsNode(p, true)) paras.add(p as HTMLElement);
      });
    }
    const bulleted = [...paras].filter((p) => p.dataset.bullet);
    if (!bulleted.length) return;
    snapshot("bullets", 400);
    bulleted.forEach((p) => {
      p.dataset.bullet = style;
      p.dataset.glyph = BULLET_GLYPHS[style] ?? "•";
    });
    el.dispatchEvent(new Event("input", { bubbles: true }));
    if (savedSel.current) restoreSelection(savedSel.current);
  };
  const restyleBulletsRef = useRef(restyleBullets);
  restyleBulletsRef.current = restyleBullets;

  /* Scroll-wheel over size / bullet / toggle buttons (Edit ribbon open). */
  useEffect(() => {
    if (!openRibbons.has("Edit")) return;
    const sizeEl = sizeStepperRef.current;
    const bulletEl = bulletStyleRefEl.current;
    const toggleEl = toggleWheelRef.current;

    const onSizeWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      keepTextSelection();
      const cur = formatRef.current?.size ?? defaultSizeRef.current;
      let i = FONT_SIZES.indexOf(cur);
      if (i < 0) {
        i = FONT_SIZES.findIndex((s) => s >= cur);
        if (i < 0) i = FONT_SIZES.length - 1;
        else if (i > 0 && cur - FONT_SIZES[i - 1] < FONT_SIZES[i] - cur) i = i - 1;
      }
      // Scroll up → larger, scroll down → smaller (same feel as zoom)
      const dir = e.deltaY > 0 ? -1 : 1;
      changeSizeRef.current(FONT_SIZES[Math.max(0, Math.min(FONT_SIZES.length - 1, i + dir))]);
    };

    const onBulletWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const keys = Object.keys(BULLET_GLYPHS);
      let i = keys.indexOf(bulletStyleRef.current);
      if (i < 0) i = 0;
      const dir = e.deltaY > 0 ? 1 : -1;
      restyleBulletsRef.current(keys[(i + dir + keys.length) % keys.length]);
    };

    const onToggleWheel = (e: WheelEvent) => {
      const btn = (e.target as Element | null)?.closest?.("[data-toggle-cmd]") as HTMLElement | null;
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      const cmd = btn.dataset.toggleCmd;
      if (cmd) execRef.current(cmd);
    };

    sizeEl?.addEventListener("wheel", onSizeWheel, { passive: false });
    bulletEl?.addEventListener("wheel", onBulletWheel, { passive: false });
    toggleEl?.addEventListener("wheel", onToggleWheel, { passive: false });
    return () => {
      sizeEl?.removeEventListener("wheel", onSizeWheel);
      bulletEl?.removeEventListener("wheel", onBulletWheel);
      toggleEl?.removeEventListener("wheel", onToggleWheel);
    };
  }, [openRibbons]);

  const exec = (cmd: string, value?: string) =>
    withSelection(cmd, () => {
      document.execCommand("styleWithCSS", false, "false");
      document.execCommand(cmd, false, value);
    });
  const execRef = useRef(exec);
  execRef.current = exec;

  const applyBullets = (style: string) => {
    const win = windowFormatContent();
    if (win) {
      snapshot("bullets");
      win.querySelectorAll<HTMLElement>(":scope > div.p").forEach((p) => {
        p.dataset.bullet = style;
        p.dataset.glyph = BULLET_GLYPHS[style] ?? "•";
      });
      setFormat(readFormatStateFromContent(win));
      win.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    keepTextSelection();
    let saved = savedSel.current;
    if (!saved || !restoreSelection(saved)) {
      onToast("Click into a text window first");
      return;
    }
    const el = saved!.content;
    const sel = window.getSelection();
    if (!sel?.anchorNode) return;
    snapshot("bullets");
    const paras = new Set<HTMLElement>();
    const collect = (node: Node | null) => {
      let n: Node | null = node;
      while (n && n !== el) {
        if (n instanceof HTMLElement && n.classList.contains("p")) {
          paras.add(n);
          return;
        }
        n = n.parentNode;
      }
    };
    collect(sel.anchorNode);
    collect(sel.focusNode);
    // include paragraphs between anchor and focus
    if (!sel.isCollapsed) {
      el.querySelectorAll(":scope > div.p").forEach((p) => {
        if (sel.containsNode(p, true)) paras.add(p as HTMLElement);
      });
    }
    if (!paras.size) return;
    const anyWithout = [...paras].some((p) => p.dataset.bullet !== style);
    paras.forEach((p) => {
      if (anyWithout) {
        p.dataset.bullet = style;
        p.dataset.glyph = BULLET_GLYPHS[style] ?? "•";
      } else {
        delete p.dataset.bullet;
        delete p.dataset.glyph;
      }
    });
    el.dispatchEvent(new Event("input", { bubbles: true }));
  };

  const insertTable = (rows: number, cols: number) => {
    const n = noteRef.current;
    if (!n) return;
    const cellHtml = '<td contenteditable="true"><div class="p"><br></div></td>';
    const tableW = cols * 120;
    const html = `<table class="plt" data-borders="true" contenteditable="false" style="width:${tableW}px"><colgroup>${'<col style="width:120px">'.repeat(cols)}</colgroup><tbody>${`<tr>${cellHtml.repeat(cols)}</tr>`.repeat(rows)}</tbody></table><div class="p"><br></div>`;
    if (restoreSelection(savedSel.current)) {
      const el = savedSel.current!.content;
      snapshot("table");
      // Block-level insert — avoid nesting the table inside the caret's <div.p>
      // (that made the next commit drop the table and it "disappeared").
      insertBlockHtmlAtSelection(html);
      const table = el.querySelector("table.plt") as HTMLTableElement | null;
      const first = table?.querySelector("td") as HTMLElement | null;
      if (first) {
        const range = document.createRange();
        const target = first.querySelector(".p") ?? first;
        range.selectNodeContents(target);
        range.collapse(true);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
        el.focus({ preventScroll: true });
      }
      // Persist blocks + width immediately so a React sync can't wipe the DOM table.
      const win = el.closest(".text-window") as HTMLElement | null;
      const oid = win?.dataset.oid;
      if (oid) {
        const blocks = htmlToBlocks(el);
        const need = tableW + 24;
        noteChanged({
          ...n,
          doc: {
            ...n.doc,
            canvas: {
              ...n.doc.canvas,
              objects: n.doc.canvas.objects.map((o) =>
                o.id === oid && o.type === "text"
                  ? { ...o, blocks, width: Math.max(o.width, need) }
                  : o,
              ),
            },
          },
        });
      } else {
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
      return;
    }
    // no focused text window → create one containing the table, where the user is looking
    snapshot("table");
    const z = n.doc.canvas.objects.reduce((m, o) => Math.max(m, o.z), 0) + 1;
    const center = viewRef.current?.center() ?? { x: 120 + (cols * 120) / 2, y: 140 };
    const t: TextObject = {
      type: "text",
      id: newId("t"),
      x: Math.round(center.x - (cols * 120 + 24) / 2),
      y: Math.round(center.y - rows * 16),
      z,
      width: cols * 120 + 24,
      blocks: [
        {
          kind: "table",
          col_widths: Array(cols).fill(120),
          borders: true,
          rows: Array.from({ length: rows }, () => ({
            cells: Array.from({ length: cols }, () => ({
              blocks: [{ kind: "p" as const, indent: 0, bullet: null, align: "left", runs: [{ text: "" }] }],
            })),
          })),
        },
      ],
    };
    noteChanged({ ...n, doc: { ...n.doc, canvas: { ...n.doc.canvas, objects: [...n.doc.canvas.objects, t] } } });
  };

  /** Insert an empty chip at the caret and start editing it in place. */
  const insertMathChip = () => {
    snapshot("math");
    insertHtmlAtSelection(`${mathHtml("").replace('class="', 'id="__math_new" class="')}&nbsp;`);
    const chip = document.getElementById("__math_new");
    if (!chip) return;
    chip.removeAttribute("id");
    setMathEdit({ target: chip, initial: "", isNew: true, id: ++mathEditSeq.current });
  };

  const startMathInsert = () => {
    if (mathEdit) return;
    if (restoreSelection(savedSel.current)) {
      insertMathChip();
      return;
    }
    const content =
      getHighlightedContent() ??
      ((document.activeElement as HTMLElement | null)?.closest?.(".content") as HTMLElement | null);
    if (!content) {
      onToast("Click into a text window first");
      return;
    }
    // Whole-box selection makes the window non-editable until the next paint.
    setHighlightedTextId(null);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        content.focus();
        const range = document.createRange();
        range.selectNodeContents(content);
        range.collapse(false);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
        savedSel.current = saveSelection();
        insertMathChip();
      });
    });
  };
  mathInsertRef.current = startMathInsert;

  /** Called by the inline editor when it closes. */
  const finishMathEdit = (commit: boolean) => {
    const edit = mathEdit;
    setMathEdit(null);
    if (!edit || !edit.target.isConnected) return;
    const content = edit.target.closest(".content") as HTMLElement | null;
    const tex = (edit.target.dataset.tex ?? "").trim();
    if (!commit) {
      // revert: restore the original formula, or remove a freshly inserted chip
      if (edit.isNew || !edit.initial.trim()) edit.target.remove();
      else renderMathInto(edit.target, edit.initial);
    } else if (!tex) {
      edit.target.remove();
    }
    content?.dispatchEvent(new Event("input", { bubbles: true }));
  };

  /** Pen colour / width also restyle drawings selected with the Select tool (OneNote-style). */
  const restyleSelectedDrawings = (patch: { color?: string; width?: number; opacity?: number }) => {
    const ids = drawTargetIds();
    const n = noteRef.current;
    if (!n || !ids.length) return;
    if (!n.doc.canvas.objects.some((o) => o.type === "drawing" && ids.includes(o.id))) return;
    snapshot("restyle-drawing", 400);
    updateNote((cur) => ({
      ...cur,
      doc: {
        ...cur.doc,
        canvas: {
          ...cur.doc.canvas,
          objects: cur.doc.canvas.objects.map((o) => {
            if (o.type !== "drawing" || !ids.includes(o.id)) return o;
            if (patch.opacity != null && !(o.item.kind === "stroke" && o.item.highlighter)) return o;
            return { ...o, item: { ...o.item, ...patch } };
          }),
        },
      },
    }));
  };

  const pickDrawColor = (c: string | null) => {
    updateDrawPrefs({ color: c });
    if (!canvasSelRef.current.length) return;
    restyleSelectedDrawings({ color: c ?? themeInk(settings.theme) });
  };

  const pickHlColor = (c: string | null) => {
    if (!c) return;
    updateDrawPrefs({ hlColor: c });
    if (!canvasSelRef.current.length) return;
    restyleSelectedDrawings({ color: c });
  };

  /** The colour and width next to this button, painted onto the stroke just drawn. */
  const applyColorToLast = () => {
    const id = liveDrawRef.current;
    const n = noteRef.current;
    if (!id || !n) return;
    if (!n.doc.canvas.objects.some((o) => o.type === "drawing" && o.id === id)) return;
    const color = tool === "highlighter" ? drawPrefs.hlColor : (drawPrefs.color ?? themeInk(settings.theme));
    const width = tool === "highlighter" ? drawPrefs.hlWidth : drawPrefs.width;
    snapshot("restyle-drawing", 400);
    updateNote((cur) => ({
      ...cur,
      doc: {
        ...cur.doc,
        canvas: {
          ...cur.doc.canvas,
          objects: cur.doc.canvas.objects.map((o) =>
            o.type === "drawing" && o.id === id ? { ...o, item: { ...o.item, color, width } } : o,
          ),
        },
      },
    }));
  };

  const paper: PaperStyle = note?.doc.canvas.paper ?? "dots";
  const setPaper = (p: PaperStyle) => {
    if (!noteRef.current || p === paper) return;
    snapshot("paper");
    updateNote((cur) => ({
      ...cur,
      doc: { ...cur.doc, canvas: { ...cur.doc.canvas, paper: p === "dots" ? undefined : p } },
    }));
  };

  const pickDrawWidth = (w: number) => {
    updateDrawPrefs({ width: w });
    if (!canvasSelRef.current.length) return;
    restyleSelectedDrawings({ width: w });
  };

  const restyleSelectedArrows = (patch: { head_style?: string; body?: string }) => {
    const ids = drawTargetIds();
    const n = noteRef.current;
    if (!n || !ids.length) return;
    if (!n.doc.canvas.objects.some((o) => o.type === "drawing" && o.item.kind === "arrow" && ids.includes(o.id))) return;
    snapshot("restyle-arrow", 400);
    updateNote((cur) => ({
      ...cur,
      doc: {
        ...cur.doc,
        canvas: {
          ...cur.doc.canvas,
          objects: cur.doc.canvas.objects.map((o) => {
            if (o.type !== "drawing" || o.item.kind !== "arrow" || !ids.includes(o.id)) return o;
            const item = { ...o.item, ...patch };
            if (patch.body === "single") delete item.body;
            return { ...o, item };
          }),
        },
      },
    }));
  };

  const pickArrow = (patch: Partial<Pick<DrawPrefs, "arrowMode" | "arrowHead" | "arrowBody">>) => {
    updateDrawPrefs(patch);
    if (patch.arrowHead) restyleSelectedArrows({ head_style: patch.arrowHead });
    if (patch.arrowBody) restyleSelectedArrows({ body: patch.arrowBody });
  };

  const insertImages = async () => {
    const n = noteRef.current;
    if (!n) return;
    const imgs = await pickLocalImage(true);
    if (!imgs.length) return;
    snapshot("insert-image");
    const center = viewRef.current?.center() ?? { x: 360, y: 300 };
    let z = n.doc.canvas.objects.reduce((m, o) => Math.max(m, o.z), 0);
    const media = { ...n.media_b64 };
    let placed = [...n.doc.canvas.objects];
    const box = (o: (typeof placed)[number]) => objectBBox(o, heightsRef.current);
    imgs.forEach((img, i) => {
      const ext = img.name.split(".").pop() || "png";
      const mp = `media/${newId("m").slice(2)}.${ext}`;
      media[mp] = img.b64;
      const { width, height } = fitImage(img.width, img.height);
      const obj: ImageObject = {
        type: "image",
        id: newId("i"),
        x: Math.round(center.x - width / 2 + i * 24),
        y: Math.round(center.y - height / 2 + i * 24),
        z: ++z,
        media: mp,
        width,
        height,
      };
      placed = placeNew(placed, obj, obj.x + width / 2, obj.y + height / 2, box);
    });
    noteChanged({ ...n, media_b64: media, doc: { ...n.doc, canvas: { ...n.doc.canvas, objects: placed } } });
  };

  const insertGif = async (hit: GifHit) => {
    setGifOpen(false);
    const n = noteRef.current;
    if (!n) return;
    onToast("Adding GIF…");
    try {
      const { b64 } = await api.gifFetch(hit.url);
      const natural = hit.w > 0 && hit.h > 0 ? { width: hit.w, height: hit.h } : await imageSize(b64);
      const { width, height } = fitImage(natural.width || 240, natural.height || 180);
      const latest = noteRef.current;
      if (!latest) return;
      snapshot("insert-image");
      const center = viewRef.current?.center() ?? { x: 360, y: 300 };
      const z = latest.doc.canvas.objects.reduce((m, o) => Math.max(m, o.z), 0) + 1;
      const media = { ...latest.media_b64 };
      const mp = `media/${newId("m").slice(2)}.gif`;
      media[mp] = b64;
      const obj: ImageObject = {
        type: "image",
        id: newId("i"),
        x: Math.round(center.x - width / 2),
        y: Math.round(center.y - height / 2),
        z,
        media: mp,
        width,
        height,
      };
      const box = (o: (typeof latest.doc.canvas.objects)[number]) => objectBBox(o, heightsRef.current);
      const placed = placeNew(latest.doc.canvas.objects, obj, obj.x + width / 2, obj.y + height / 2, box);
      noteChanged({ ...latest, media_b64: media, doc: { ...latest.doc, canvas: { ...latest.doc.canvas, objects: placed } } });
    } catch {
      onToast("Couldn't add that GIF.");
    }
  };

  const insertPdfs = async () => {
    const n = noteRef.current;
    if (!n) return;
    const files = await pickLocalPdf();
    if (!files.length) return;
    onToast(files.length > 1 ? "Reading PDFs…" : "Reading PDF…");
    const center = viewRef.current?.center() ?? { x: 360, y: 200 };
    const made: { b64: string; aspects: number[] }[] = [];
    for (const file of files) {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const aspects = await pdfAspects(bytes.slice());
        made.push({ b64: bytesToB64(bytes), aspects });
      } catch {
        onToast(`Couldn't read ${file.name}`);
      }
    }
    const latest = noteRef.current;
    if (!latest || !made.length) return;
    commitPdfs(latest, made, center);
  };

  const commitPdfs = (
    latest: NotePayload,
    made: { b64: string; aspects: number[] }[],
    center: { x: number; y: number },
  ) => {
    snapshot("insert-pdf");
    const floor = latest.doc.canvas.objects.reduce((m, o) => Math.min(m, o.z), 0);
    let z = floor - made.length;
    let placed = latest.doc.canvas.objects;
    const media = { ...latest.media_b64 };
    const box = (o: (typeof placed)[number]) => objectBBox(o, heightsRef.current);
    let y = center.y;
    for (const file of made) {
      const mp = `media/${newId("m").slice(2)}.pdf`;
      media[mp] = file.b64;
      const pageWidth = 620;
      const obj: PdfObject = {
        type: "pdf",
        id: newId("p"),
        x: Math.round(center.x - pageWidth / 2),
        y: Math.round(y),
        z: ++z,
        media: mp,
        pages: file.aspects.map((_, i) => i + 1),
        aspects: file.aspects,
        layout: "stack",
        pageWidth,
        gap: 14,
      };
      placed = placeNew(placed, obj, obj.x + pageWidth / 2, obj.y + 8, box);
      y += pdfSize(obj).h + 40;
    }
    noteChanged({
      ...latest,
      media_b64: media,
      doc: { ...latest.doc, canvas: { ...latest.doc.canvas, objects: placed } },
    });
  };

  const insertPdfsFromPaths = async (paths: string[]) => {
    const n = noteRef.current;
    if (!n || !paths.length) return;
    onToast(paths.length > 1 ? "Reading PDFs…" : "Reading PDF…");
    const made: { b64: string; aspects: number[] }[] = [];
    for (const filePath of paths) {
      try {
        const b64 = await invoke<string>("moodle_read_pdf", { path: filePath });
        const bytes = b64ToBytes(b64);
        const aspects = await pdfAspects(bytes.slice());
        made.push({ b64, aspects });
      } catch {
        onToast(`Couldn't read ${filePath.split(/[\\/]/).pop() || "PDF"}`);
      }
    }
    const latest = noteRef.current;
    if (!latest || !made.length) return;
    commitPdfs(latest, made, insertAt());
  };

  /** Where a Moodle file opened with a click lands. Dragged files go through the drag session instead. */
  const insertAt = () => viewRef.current?.center() ?? { x: 360, y: 240 };

  const placePreparedPdf = (b64: string, media: string, aspects: number[], origin: { x: number; y: number }) => {
    const latest = noteRef.current;
    if (!latest || !aspects.length) return;
    snapshot("insert-pdf");
    const pageWidth = 620;
    const floor = latest.doc.canvas.objects.reduce((m, o) => Math.min(m, o.z), 0);
    const obj: PdfObject = {
      type: "pdf",
      id: newId("p"),
      x: origin.x,
      y: origin.y,
      z: floor - 1,
      media,
      pages: aspects.map((_, i) => i + 1),
      aspects,
      layout: "stack",
      pageWidth,
      gap: 14,
    };
    const placed = placeNew(
      latest.doc.canvas.objects,
      obj,
      obj.x + pageWidth / 2,
      obj.y + 8,
      (o) => objectBBox(o, heightsRef.current),
    );
    noteChanged({
      ...latest,
      media_b64: { ...latest.media_b64, [media]: b64 },
      doc: { ...latest.doc, canvas: { ...latest.doc.canvas, objects: placed } },
    });
  };

  const pumpMoodleDrag = () => {
    const session = moodleDragSnapshot();
    if (!session) {
      setDragGhost(null);
      return;
    }
    const pageWidth = 620;
    let origin = dragLand.current?.token === session.token ? dragLand.current : null;
    if (session.client && viewRef.current && (!session.dropped || !origin)) {
      const p = viewRef.current.point(session.client.x, session.client.y);
      const next = { token: session.token, x: Math.round(p.x - pageWidth / 2), y: Math.round(p.y) };
      if (session.dropped) dragLand.current = next;
      origin = session.dropped ? dragLand.current : next;
    }
    const ready = dragReady.current?.token === session.token ? dragReady.current : null;
    if (!origin) {
      setDragGhost(null);
    } else {
      const aspects = ready?.aspects ?? Array.from({ length: session.pages }, () => session.aspect);
      setDragGhost({
        x: origin.x,
        y: origin.y,
        pageWidth,
        aspects,
        preview: ready?.preview || undefined,
      });
    }
    if (session.file && !ready && dragPrep.current !== session.token) {
      const token = session.token;
      const file = session.file;
      dragPrep.current = token;
      void (async () => {
        try {
          const b64 = await invoke<string>("moodle_read_pdf", { path: file });
          const media = `media/${newId("m").slice(2)}.pdf`;
          const placed = await pdfPlacement(media, b64, pageWidth);
          if (moodleDragSnapshot()?.token !== token && dragLand.current?.token !== token) return;
          dragReady.current = { token, b64, media, aspects: placed.aspects, preview: placed.preview };
          pumpMoodleDrag();
        } catch {
          if (moodleDragSnapshot()?.token === token) {
            finishMoodleDrag(token);
            onToast("Couldn't read that PDF.");
          }
        }
      })();
    }
    if (session.dropped && ready && origin && !dragPlaced.current.has(session.token)) {
      dragPlaced.current.add(session.token);
      const land = { x: origin.x, y: origin.y };
      finishMoodleDrag(session.token);
      placePreparedPdf(ready.b64, ready.media, ready.aspects, land);
      setDragGhost(null);
    }
  };

  const insertFold = () => {
    const n = noteRef.current;
    if (!n) return;
    snapshot("fold");
    const center = viewRef.current?.center() ?? { x: 360, y: 280 };
    const z = n.doc.canvas.objects.reduce((m, o) => Math.max(m, o.z), 0) + 1;
    const g: GroupObject = {
      type: "group",
      id: newId("g"),
      x: Math.round(center.x - 170),
      y: Math.round(center.y - 36),
      z,
      width: 340,
      min_height: 96,
      collapsed: false,
      children: [],
    };
    noteChanged({ ...n, doc: { ...n.doc, canvas: { ...n.doc.canvas, objects: [...n.doc.canvas.objects, g] } } });
  };
  const insertFileFromPath = async (filePath: string) => {
    const ext = (filePath.split(/[\\/]/).pop() || "").split(".").pop()?.toLowerCase() || "";
    if (ext === "pdf") {
      await insertPdfsFromPaths([filePath]);
      return;
    }
    if (!["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) {
      onToast("That file can't be added to a note.");
      return;
    }
    const n = noteRef.current;
    if (!n) {
      onToast("Open a note to add this file.");
      return;
    }
    try {
      const b64 = await invoke<string>("moodle_read_pdf", { path: filePath });
      const natural = await imageSize(b64);
      const fitted = fitImage(natural.width, natural.height);
      snapshot("insert-image");
      const latest = noteRef.current;
      if (!latest) return;
      const center = insertAt();
      const z = latest.doc.canvas.objects.reduce((m, o) => Math.max(m, o.z), 0) + 1;
      const media = { ...latest.media_b64 };
      const mp = `media/${newId("m").slice(2)}.${ext === "jpeg" ? "jpg" : ext}`;
      media[mp] = b64;
      const obj: ImageObject = {
        type: "image",
        id: newId("i"),
        x: Math.round(center.x - fitted.width / 2),
        y: Math.round(center.y - fitted.height / 2),
        z,
        media: mp,
        width: fitted.width,
        height: fitted.height,
      };
      const placed = placeNew(
        latest.doc.canvas.objects,
        obj,
        obj.x + fitted.width / 2,
        obj.y + fitted.height / 2,
        (o) => objectBBox(o, heightsRef.current),
      );
      noteChanged({ ...latest, media_b64: media, doc: { ...latest.doc, canvas: { ...latest.doc.canvas, objects: placed } } });
    } catch {
      onToast(`Couldn't read ${filePath.split(/[\\/]/).pop() || "file"}`);
    }
  };
  insertPdfRef.current = (paths) => {
    for (const filePath of paths) void insertFileFromPath(filePath);
  };

  const addToday = async (format?: string) => {
    const cur0 = noteRef.current;
    if (!cur0) return;
    const p = await api.addTodayTitle(cur0.path, format);
    const n = await api.loadNote(p);
    setNote((cur) => (cur ? { ...n, doc: cur.doc, media_b64: cur.media_b64 } : n));
    setTitleDraft(n.display_title);
    await refreshInfo();
  };

  /* ── PDF preview ── */
  const togglePdf = () => {
    const n = noteRef.current;
    if (!n) return;
    if (pdf) {
      exitPdf();
      return;
    }
    computePdf(true);
  };

  /** Leaving preview: put the free canvas where the preview was scrolled to. */
  const exitPdf = () => {
    try {
      const cam = camRef.current;
      const sc = document.querySelector<HTMLElement>(".pdf-scroll");
      if (pdf && cam && sc && pdf.pages.length) {
        const sr = sc.getBoundingClientRect();
        const cy = sr.top + sc.clientHeight / 2;
        const els = Array.from(sc.querySelectorAll<HTMLElement>(":scope > .pdf-page"));
        let idx = 0;
        let best = Infinity;
        els.forEach((el, i) => {
          const r = el.getBoundingClientRect();
          const d = cy < r.top ? r.top - cy : cy > r.bottom ? cy - r.bottom : 0;
          if (d < best) {
            best = d;
            idx = i;
          }
        });
        idx = Math.min(idx, pdf.pages.length - 1);
        const pg = pdf.pages[idx];
        const r = els[idx]?.getBoundingClientRect();
        if (pg && r) {
          const zView = pdfZoomRef.current || 1;
          const off = (cy - r.top) / zView;
          const cyCanvas = Math.min(pg.y + pg.h, Math.max(pg.y, pg.y + (off - A4.margin - pg.titleBlock) / pdf.scale));
          const cxCanvas = pg.x + (A4.w / 2 - A4.margin) / pdf.scale;
          const z = pdfCamZ.current ?? cam.z;
          restoreCamRef.current = { z, x: cam.w / 2 - cxCanvas * z, y: cam.h / 2 - cyCanvas * z };
        }
      }
    } catch {
      /* best effort */
    }
    setPdf(null);
    pdfZoomRef.current = 1;
    setPdfZoom(1);
  };

  /** Entering preview: scroll so the page under the canvas centre is in view. */
  useEffect(() => {
    const want = pdfScrollWant.current;
    if (!pdf || !want) return;
    let cancelled = false;
    // Two frames: the sheet pages exist, then layout has their real tops.
    // Direct-child only — a PDF on the page also uses .pdf-page inside the sheet.
    const id = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (cancelled) return;
        pdfScrollWant.current = null;
        const sc = document.querySelector<HTMLElement>(".pdf-scroll");
        const els = sc?.querySelectorAll<HTMLElement>(":scope > .pdf-page");
        const pg = pdf.pages[want.page];
        const el = els?.[want.page];
        if (!sc || !el || !pg) return;
        const zView = pdfZoomRef.current || 1;
        const off = (A4.margin + pg.titleBlock + want.frac * pg.h * pdf.scale) * zView;
        sc.scrollTop += el.getBoundingClientRect().top - sc.getBoundingClientRect().top + off - sc.clientHeight / 2;
      });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(id);
    };
  }, [pdf]);

  useEffect(() => {
    if (!pdf) restoreCamRef.current = null;
  }, [pdf]);

  const pdfZoomAcc = useRef(0);

  /** Ctrl+scroll and the ± buttons land on the next multiple of 10. */
  const stepPdfZoom = (dir: 1 | -1, clientX: number, clientY: number) => {
    const pct = Math.round(pdfZoomRef.current * 100);
    const min = Math.round(PDF_ZOOM_MIN * 100);
    const max = Math.round(PDF_ZOOM_MAX * 100);
    const next = dir > 0
      ? Math.min(max, Math.floor(pct / 10) * 10 + 10)
      : Math.max(min, pct % 10 === 0 ? pct - 10 : Math.floor(pct / 10) * 10);
    zoomPreview(next / 100, clientX, clientY);
  };

  const zoomPreview = (next: number, clientX: number, clientY: number) => {
    const sc = pdfScrollRef.current;
    const z = Math.min(PDF_ZOOM_MAX, Math.max(PDF_ZOOM_MIN, next));
    if (Math.abs(z - pdfZoomRef.current) < 0.0005) return;
    if (sc) pdfZoomAnchorRef.current = pdfZoomAnchor(sc, clientX, clientY);
    pdfZoomRef.current = z;
    setPdfZoom(z);
  };

  useLayoutEffect(() => {
    const anchor = pdfZoomAnchorRef.current;
    const sc = pdfScrollRef.current;
    if (!anchor || !sc) return;
    pdfZoomAnchorRef.current = null;
    const el = sc.querySelectorAll<HTMLElement>(":scope > .pdf-page")[anchor.index];
    if (!el) return;
    const r = el.getBoundingClientRect();
    sc.scrollLeft += r.left + anchor.fx * r.width - anchor.clientX;
    sc.scrollTop += r.top + anchor.fy * r.height - anchor.clientY;
  }, [pdfZoom]);

  useEffect(() => {
    if (!pdf) return;
    const el = pdfPreviewRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      pdfZoomAcc.current += e.deltaY;
      if (Math.abs(pdfZoomAcc.current) < 36) return;
      const dir: 1 | -1 = pdfZoomAcc.current > 0 ? -1 : 1;
      pdfZoomAcc.current = 0;
      stepPdfZoom(dir, e.clientX, e.clientY);
    };
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key !== "0") return;
      const t = e.target;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
      e.preventDefault();
      const sc = pdfScrollRef.current;
      const rect = sc?.getBoundingClientRect();
      zoomPreview(1, rect ? rect.left + rect.width / 2 : 0, rect ? rect.top + rect.height / 2 : 0);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("keydown", onKey);
    return () => {
      el.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKey);
    };
  }, [pdf]);

  /** Page cuts from Rust `compute_pdf_pages` — same path as export_pdf. */
  const computePdf = (entering = false) => {
    const n = noteRef.current;
    if (!n) return;
    const titleLabel = n.display_title || n.title || "Untitled";
    const cw = A4.w - 2 * A4.margin;
    void (async () => {
      try {
        if (dirtyRef.current) {
          const ok = await save();
          if (!ok) return;
        }
        const rects = await invoke<{ x: number; y: number; w: number; h: number }[]>("compute_pdf_pages", {
          notePath: n.path,
        });
        if (!rects.length) return;
        const scale = rects[0].w > 0 ? Math.min(1, cw / rects[0].w) : 1;
        const pages = rects.map((r, i) => ({
          x: r.x,
          y: r.y,
          h: Math.max(1, r.h),
          titleBlock: i === 0 ? PDF_TITLE_BLOCK : 0,
          title: i === 0 ? titleLabel : undefined,
        }));
        let page = 0;
        if (entering === true) {
          const cam = camRef.current;
          pdfCamZ.current = cam?.z ?? null;
          if (cam && pages.length) {
            const cyCanvas = (cam.h / 2 - cam.y) / cam.z;
            let idx = pages.findIndex((p) => cyCanvas >= p.y && cyCanvas < p.y + p.h);
            if (idx < 0) idx = cyCanvas < pages[0].y ? 0 : pages.length - 1;
            const p = pages[idx];
            page = idx;
            pdfScrollWant.current = { page: idx, frac: Math.min(1, Math.max(0, (cyCanvas - p.y) / p.h)) };
          }
        }
        setPdf({ scale, page, pages });
      } catch (e) {
        onToast(String(e));
      }
    })();
  };

  /* ── export ── */
  const runExport = async (
    paths: string[],
    format: string,
    opts: { pageNumbers: boolean; headers: Record<string, string> | null; exportDate: boolean; geometry: boolean; separate?: boolean },
  ) => {
    const ext = format === "pdf" ? "pdf" : "md";
    try {
      const open = noteRef.current;
      if (open && dirtyRef.current && paths.includes(open.path)) await save();
      if (paths.length === 1) {
        const stem = paths[0].replace(/^.*[\\/]/, "").replace(/\.note$/i, "");
        const dest = await saveDialog({
          defaultPath: `${stem}.${ext}`,
          filters: [{ name: ext.toUpperCase(), extensions: [ext.split(".").pop()!] }],
        });
        if (!dest) return;
        await api.exportNote({
          notePath: paths[0],
          dest,
          format,
          pageNumbers: opts.pageNumbers,
          titleHeader: opts.headers?.[paths[0]] ?? null,
          exportDate: opts.exportDate,
          geometryBlock: opts.geometry,
        });
        onToast(`Exported ${dest}`);
      } else if (opts.separate) {
        const { open } = await import("@tauri-apps/plugin-dialog");
        const dir = await open({ directory: true });
        if (!dir || Array.isArray(dir)) return;
        const used = new Set<string>();
        for (const p of paths) {
          let stem = p.replace(/^.*[\\/]/, "").replace(/\.note$/i, "") || "note";
          let name = stem;
          let n = 2;
          while (used.has(name.toLowerCase())) name = `${stem} (${n++})`;
          used.add(name.toLowerCase());
          await api.exportNote({
            notePath: p,
            dest: `${dir}\\${name}.${ext}`,
            format,
            pageNumbers: opts.pageNumbers,
            titleHeader: opts.headers?.[p] ?? null,
            exportDate: opts.exportDate,
            geometryBlock: opts.geometry,
          });
        }
        onToast(`Exported ${paths.length} files`);
      } else {
        // Multi-select → one merged file; note list bottom→top (oldest first on Created ↓).
        const notebookName = info?.name?.replace(/[<>:"/\\|?*]/g, "").trim() || "notes";
        const dest = await saveDialog({
          defaultPath: `${notebookName}.${ext}`,
          filters: [{ name: ext.toUpperCase(), extensions: [ext.split(".").pop()!] }],
        });
        if (!dest) return;
        await api.exportNotesMerged({
          notePaths: paths,
          dest,
          format,
          pageNumbers: opts.pageNumbers,
          titleHeaders: opts.headers,
          exportDate: opts.exportDate,
          geometryBlock: opts.geometry,
        });
        onToast(`Exported ${dest}`);
      }
    } catch (e) {
      onToast(`Export failed: ${e}`);
    }
  };

  /* ── find ── */
  const [findIdx, setFindIdx] = useState(0);
  const [findTotal, setFindTotal] = useState(0);
  const [findTick, setFindTick] = useState(0);
  /** Set by typing / Enter so the current match is panned into view (not on every note edit). */
  const findReveal = useRef(false);

  useEffect(() => {
    const reg = typeof Highlight !== "undefined" && "highlights" in CSS ? CSS.highlights : null;
    const q = findQ.trim().toLowerCase();
    const ranges = findOpen && q ? findRanges(q) : [];
    setFindTotal(ranges.length);
    const idx = Math.min(findIdx, Math.max(0, ranges.length - 1));
    if (reg) {
      if (ranges.length) {
        reg.set("pl-find", new Highlight(...ranges));
        reg.set("pl-find-current", new Highlight(ranges[idx]));
      } else {
        reg.delete("pl-find");
        reg.delete("pl-find-current");
      }
    }
    if (findReveal.current && ranges[idx]) {
      findReveal.current = false;
      viewRef.current?.reveal(ranges[idx].getBoundingClientRect());
    }
  }, [findQ, findOpen, note, pdf, findIdx, findTick]);

  const stepFind = (dir: 1 | -1) => {
    if (!findTotal) return;
    findReveal.current = true;
    setFindIdx((i) => (Math.min(i, findTotal - 1) + dir + findTotal) % findTotal);
    setFindTick((t) => t + 1);
  };

  /* ── sidebar resize ── */
  useEffect(() => {
    if (!sbDragging) return;
    const move = (e: MouseEvent) => {
      const w = Math.min(480, Math.max(140, e.clientX));
      setUi((u) => ({ ...u, sidebar_width: w }));
    };
    const up = () => {
      setSbDragging(false);
      setUi((u) => {
        if (mode === "notebook") api.setNotebookUi(path, u);
        return u;
      });
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, [sbDragging, mode, path]);

  const noMouseSteal = { onMouseDown: (e: React.MouseEvent) => e.preventDefault() };

  const switcherRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!switcher) return;
    const onDown = (e: MouseEvent) => {
      if (!switcherRef.current?.contains(e.target as Node)) setSwitcher(false);
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [switcher]);

  const filteredTiles = homeTiles
    .flatMap((t) => (t.kind === "group" ? t.group_items ?? [] : [t]))
    .filter((t) => t.name.toLowerCase().includes(switchFilter.toLowerCase()));

  const visibleNotes = useMemo(() => {
    const f = listFilter.trim().toLowerCase();
    if (!f) return sortedNotes;
    return sortedNotes.filter((n) =>
      `${n.display_title || "Untitled"} ${n.title} ${huDate(n.created)}`.toLowerCase().includes(f),
    );
  }, [sortedNotes, listFilter]);

  const listWithSeps = useMemo(() => {
    const out: ({ kind: "note"; n: NoteListItem } | { kind: "sep"; id: string; after: string; title: string })[] = [];
    const filtering = !!listFilter.trim();
    const named = seps.map((s, i) => ({
      after: s.after ?? "",
      id: s.id || `legacy-${i}-${s.after}`,
      title: (s.title ?? "").toUpperCase(),
    }));
    if (filtering) return visibleNotes.map((n) => ({ kind: "note" as const, n }));
    const buckets = new Map<string, typeof named>();
    for (const s of named) {
      const key = visibleNotes.some((n) => n.title === s.after) ? s.after : "";
      const list = buckets.get(key) ?? [];
      list.push({ ...s, after: key });
      buckets.set(key, list);
    }
    for (const s of buckets.get("") ?? []) out.push({ kind: "sep", ...s });
    for (const n of visibleNotes) {
      out.push({ kind: "note", n });
      for (const s of buckets.get(n.title) ?? []) out.push({ kind: "sep", ...s });
    }
    return out;
  }, [visibleNotes, seps, listFilter]);

  const beginExportSelect = () => {
    const c: Record<string, boolean> = {};
    const firstSep = listWithSeps.findIndex((item) => item.kind === "sep");
    const above = firstSep < 0 ? sortedNotes : listWithSeps.slice(0, firstSep).flatMap((item) => (item.kind === "note" ? [item.n] : []));
    const picked = new Set((firstSep < 0 ? sortedNotes : above).map((n) => n.path));
    for (const n of sortedNotes) c[n.path] = picked.has(n.path);
    setExportSel(c);
    if (ui.sidebar_collapsed) persistUi({ ...ui, sidebar_collapsed: false });
  };

  const finishSepDrag = () => {
    const drag = sepDragRef.current;
    setSepDrag(null);
    if (!drag) return;
    const from = listWithSeps.findIndex((item) => item.kind === "sep" && item.id === drag.id);
    if (from < 0) return;
    const next = [...listWithSeps];
    const [moved] = next.splice(from, 1);
    let to = drag.to;
    if (to > from) to -= 1;
    to = Math.max(0, Math.min(next.length, to));
    next.splice(to, 0, moved);
    let after = "";
    const written: SeparatorEntry[] = [];
    for (const item of next) {
      if (item.kind === "note") after = item.n.title;
      else written.push({ after, id: item.id, title: item.title });
    }
    void writeSeparators(written);
  };

  /** Arrow keys in the note list / filter: open the previous or next visible note. */
  const stepNote = (dir: 1 | -1) => {
    const list = visibleNotes;
    if (!list.length) return;
    const i = list.findIndex((x) => x.path === note?.path);
    const next = i < 0 ? list[dir > 0 ? 0 : list.length - 1] : list[Math.max(0, Math.min(list.length - 1, i + dir))];
    if (next && next.path !== note?.path) openNote(next.path);
  };

  useEffect(() => {
    document.querySelector(".note-list .note-item.active")?.scrollIntoView({ block: "nearest" });
  }, [note?.path]);

  const pumpDragRef = useRef(pumpMoodleDrag);
  pumpDragRef.current = pumpMoodleDrag;
  useEffect(() => {
    setMoodlePdfInserter((pdfPath) => void insertPdfRef.current([pdfPath]));
    const offDrag = subscribeMoodleDrag(() => pumpDragRef.current());
    return () => {
      setMoodlePdfInserter(null);
      offDrag();
    };
  }, []);

  useEffect(() => {
    if (expired || !moodleDock || moodleDock.path !== path || mode !== "notebook") return;
    setMoodlePreserve(true);
    setMoodleOpen(true);
  }, [moodleDock, path, mode, expired]);

  useEffect(() => {
    if (mode !== "notebook") return;
    let dead = false;
    invoke<boolean>("moodle_suggest", { path })
      .then((v) => {
        if (!dead) setMoodleHint(!!v);
      })
      .catch(() => {});
    return () => {
      dead = true;
    };
  }, [mode, path]);
  useEffect(() => {
    const sync = () => setTourAt(document.documentElement.dataset.tourAt ?? "");
    sync();
    window.addEventListener("paperlike-tour", sync);
    return () => window.removeEventListener("paperlike-tour", sync);
  }, []);
  const showMoodle =
    mode === "notebook" &&
    (typeof settings.moodle_enabled === "boolean"
      ? settings.moodle_enabled
      : moodleHint || localStorage.getItem("paperlike-moodle") === "1");
  useEffect(() => {
    if (!showMoodle) setMoodleOpen(false);
  }, [showMoodle]);

  const titleAutoHide = settings.title_auto_hide !== false;
  const ribbonActionsCollapsed = settings.ribbon_actions_collapsed === true;
  const titleHidden =
    settings.title_collapsed === true || (titleAutoHide && !pdf && titleScrolledAway && !titleHoldOpen);
  const revealTitle = () => {
    if (settingsRef.current.title_collapsed) patchSettings({ title_collapsed: false });
    if ((settingsRef.current.title_auto_hide !== false) && titleScrolledAway) setTitleHoldOpen(true);
  };
  const toggleFullscreen = () => {
    window.dispatchEvent(new Event("paperlike-toggle-fullscreen"));
  };

  const title = mode === "notebook" ? info?.name ?? "…" : note?.display_title || "Untitled note";

  return (
    <div className="nb-shell">
    <div className="notebook">
      {/* ── header ── */}
      <div className="nb-header">
        <button className="btn icon" data-tour="nb-home" title="Home" onClick={() => guarded(onHome)}>
          <IcHome size={17} />
        </button>
        <div style={{ position: "relative" }} ref={switcherRef}>
          <button
            className={`btn nb-title-btn${switcher ? " open" : ""}`}
            aria-expanded={switcher}
            onClick={() => setSwitcher((s) => !s)}
          >
            {title}
            <IcChevron size={13} />
          </button>
          {switcher && (
            <div className="popover nb-switcher">
              <input
                className="filter"
                autoFocus
                placeholder="Switch to…"
                value={switchFilter}
                onChange={(e) => setSwitchFilter(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setSwitcher(false);
                  if (e.key === "Enter" && filteredTiles[0]) {
                    const t = filteredTiles[0];
                    setSwitcher(false);
                    guarded(() => onSwitch(t.path, t.kind === "note" ? "note" : "notebook"));
                  }
                }}
              />
              <div className="items">
                {filteredTiles.map((t) => (
                  <button
                    key={t.path}
                    onClick={() => {
                      setSwitcher(false);
                      guarded(() => onSwitch(t.path, t.kind === "note" ? "note" : "notebook"));
                    }}
                  >
                    <span className="thumb" style={{ background: coverGradient(t.name) }}>
                      {t.cover_png_base64 ? (
                        <img src={`data:image/png;base64,${t.cover_png_base64}`} alt="" />
                      ) : t.kind === "note" ? (
                        <IcDoc size={12} />
                      ) : (
                        <IcBook size={12} />
                      )}
                    </span>
                    {t.name || "Untitled"}
                  </button>
                ))}
                {!filteredTiles.length && <div className="muted small" style={{ padding: 10 }}>No matches</div>}
              </div>
            </div>
          )}
        </div>
        <div className="ribbon-tabs">
          {RIBBON_ORDER.map((r) => (
            <button
              key={r}
              data-tour={r === "File" ? "nb-file" : r === "Edit" ? "nb-edit" : r === "Draw" ? "nb-draw" : undefined}
              className={`tab ${openRibbons.has(r) ? "active" : ""}`}
              disabled={expired && (r === "Edit" || r === "Draw")}
              onClick={(e) => {
                if (expired && (r === "Edit" || r === "Draw")) return;
                onRibbonTab(r, e);
              }}
              title={`${r} tools (Ctrl+click to pin multiple)`}
            >
              {r}
            </button>
          ))}
          <button
            className="btn icon ribbon-collapse"
            title={ribbonActionsCollapsed ? messages.showToolRow : messages.hideToolRow}
            aria-label={ribbonActionsCollapsed ? messages.showToolRow : messages.hideToolRow}
            aria-pressed={ribbonActionsCollapsed}
            aria-expanded={!ribbonActionsCollapsed}
            onClick={() => patchSettings({ ribbon_actions_collapsed: !ribbonActionsCollapsed })}
          >
            {ribbonActionsCollapsed ? <IcChevron size={14} /> : <IcChevronUp size={14} />}
          </button>
          <div className="ribbon-tab-sep" aria-hidden />
          <button
            data-tour="nb-pdf"
            className={`tab pdf-tab ${pdf ? "active" : ""}`}
            onClick={togglePdf}
            disabled={!note}
            title={!note ? messages.openNoteFirst : "PDF Preview"}
          >
            <IcEye size={15} />
            <span className="pdf-tab-label">PDF Preview</span>
          </button>
        </div>
        <div className="spacer" />
        <QuickAskField onAsk={onQuickAsk} onCalc={onCalc} onAnalyze={onAnalyze} disabled={expired} />
        <button
          className="btn outline"
          title={expired ? messages.premiumOff : "Study sheets and quizzes from several notes"}
          disabled={expired}
          data-tour="nb-ask"
          onClick={onBrief}
        >
          <IcBrief size={15} /> Brief
        </button>
        <button
          className="btn outline"
          data-tour="nb-ask"
          title={expired ? messages.premiumOff : "Chat beside this note — attaches the open page (Ctrl+J)"}
          disabled={expired}
          onClick={onAsk}
        >
          <IcAsk size={15} /> Ask
        </button>
        {(showMoodle || tourAt === "nb-moodle") && (
          <button
            data-tour="nb-moodle"
            className={`btn outline${moodleOpen || moodleHeld ? " active" : ""}`}
            title={expired ? messages.premiumOff : "TUM Moodle for this course"}
            disabled={expired}
            onClick={() => {
              if (expired) return;
              if (moodleHeld) {
                onFloatMoodle?.(info?.name || title, false);
                return;
              }
              setMoodlePreserve(false);
              setMoodleOpen((v) => !v);
            }}
          >
            Moodle
          </button>
        )}
        <button className="btn icon" title="Settings" aria-label="Settings" onClick={onOpenSettings}>
          <IcSettings size={16} />
        </button>
      </div>

      {expired && <div className="expiry-banner">{messages.expiredBanner}</div>}

      {/* ── action bar ── */}
      <div className={`action-bar ${expired ? "expired" : ""} ${ribbonActionsCollapsed ? "is-collapsed" : ""}`}>
        {openRibbons.has("File") && (
          <div className="action-section">
            <label className="switch">
              <input
                type="checkbox"
                checked={settings.autosave}
                onChange={async (e) => {
                  const next = { ...settings, autosave: e.target.checked };
                  await api.saveSettings(next);
                  onSettings(next);
                }}
              />
              Auto-save
              <span className="track" />
            </label>
            <div className="sep" />
            <button
              className="btn"
              onClick={save}
              disabled={expired || !note || !dirty}
              title={
                expired
                  ? messages.expiredBanner
                  : !note
                    ? messages.openNoteFirst
                    : !dirty
                      ? messages.nothingToSave
                      : "Save (Ctrl+S)"
              }
            >
              <IcSave size={15} /> Save
            </button>
            <button
              className="btn"
              disabled={!note}
              title={!note ? messages.openNoteFirst : undefined}
              onClick={() => note && setExportOpts({ multi: false, paths: [note.path] })}
            >
              <IcExport size={15} /> Export note
            </button>
            {mode === "notebook" && (
              <button
                className="btn"
                disabled={!sortedNotes.length}
                title={!sortedNotes.length ? messages.noNotesToExport : "Notes above the first separator, or every note"}
                onClick={beginExportSelect}
              >
                <IcExportMulti size={15} /> Export multiple
              </button>
            )}
            <button
              className="btn"
              disabled={expired}
              title={expired ? messages.expiredBanner : messages.importMarkdownTitle}
              onClick={async () => {
                if (expired) return;
                const { open } = await import("@tauri-apps/plugin-dialog");
                const file = await open({ filters: [{ name: "Markdown", extensions: ["md"] }] });
                if (!file || Array.isArray(file)) return;
                const destDir = mode === "notebook" ? path : note ? note.path.replace(/[^\\/]+$/, "") : path;
                try {
                  const created = await api.importMarkdown(file, destDir);
                  if (mode === "notebook") await refreshInfo();
                  await loadNoteAt(created.path);
                  onToast(created.warnings.length ? `Imported. ${created.warnings.join(" ")}` : "Imported");
                } catch (e) {
                  onToast(String(e));
                }
              }}
            >
              Import Markdown
            </button>
          </div>
        )}

        {openRibbons.has("Edit") && (
          <div className="action-section" inert={expired || undefined}>
            <button className="btn icon" title="Undo (Ctrl+Z)" onClick={undo} {...noMouseSteal}>
              <IcUndo size={15} />
            </button>
            <button className="btn icon" title="Redo (Ctrl+Y)" onClick={redo} {...noMouseSteal}>
              <IcRedo size={15} />
            </button>
            <div className="sep" />
            <div ref={toggleWheelRef} className="toggle-wheel-group">
            <button
              className={`btn icon ${format?.bold ? "active" : ""}`}
              title="Bold (Ctrl+B) — scroll to toggle"
              data-toggle-cmd="bold"
              onClick={() => exec("bold")}
              {...noMouseSteal}
            >
              <b>B</b>
            </button>
            <button
              className={`btn icon ${format?.italic ? "active" : ""}`}
              title="Italic (Ctrl+I) — scroll to toggle"
              data-toggle-cmd="italic"
              onClick={() => exec("italic")}
              {...noMouseSteal}
            >
              <i>I</i>
            </button>
            <button
              className={`btn icon ${format?.underline ? "active" : ""}`}
              title="Underline (Ctrl+U) — scroll to toggle"
              data-toggle-cmd="underline"
              onClick={() => exec("underline")}
              {...noMouseSteal}
            >
              <u>U</u>
            </button>
            <button
              className={`btn icon ${format?.strike ? "active" : ""}`}
              title="Strikethrough (Ctrl+-) — scroll to toggle"
              data-toggle-cmd="strikeThrough"
              onClick={() => exec("strikeThrough")}
              {...noMouseSteal}
            >
              <s>S</s>
            </button>
            <button
              className={`btn icon script ${format?.sub ? "active" : ""}`}
              title="Subscript (Ctrl+=) — scroll to toggle"
              data-toggle-cmd="subscript"
              onClick={() => exec("subscript")}
              {...noMouseSteal}
            >
              <span className="script-x">x</span>
              <span className="script-n low">2</span>
            </button>
            <button
              className={`btn icon script ${format?.sup ? "active" : ""}`}
              title="Superscript (Ctrl+Shift+=) — scroll to toggle"
              data-toggle-cmd="superscript"
              onClick={() => exec("superscript")}
              {...noMouseSteal}
            >
              <span className="script-x">x</span>
              <span className="script-n high">2</span>
            </button>
            </div>
            <div className="sep" />
            <FontPicker
              wrapRef={fontWrapRef}
              value={format?.font ?? defaultFont}
              onPick={changeFont}
              onKeepSelection={keepTextSelection}
              onEndRibbon={endRibbon}
            />
            <div ref={sizeStepperRef} className="size-stepper" title="Font size — scroll to cycle">
              <button
                title="Smaller"
                onMouseDown={(e) => {
                  e.preventDefault();
                  keepTextSelection();
                }}
                onClick={() => changeSize((format?.size ?? defaultSize) - 1)}
              >
                −
              </button>
              <input
                className="size-value"
                value={sizeDraft ?? String(format?.size ?? defaultSize)}
                title="Font size in points — type a value and press Enter"
                onMouseDown={keepTextSelection}
                onChange={(e) => setSizeDraft(e.target.value.replace(/[^\d]/g, ""))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    const pt = parseInt(sizeDraft ?? "");
                    if (pt >= 5 && pt <= 200) changeSize(pt);
                    setSizeDraft(null);
                  } else if (e.key === "Escape") {
                    setSizeDraft(null);
                  }
                }}
                onBlur={() => {
                  const pt = parseInt(sizeDraft ?? "");
                  if (pt >= 5 && pt <= 200) changeSize(pt);
                  setSizeDraft(null);
                }}
              />
              <button
                title="Larger"
                onMouseDown={(e) => {
                  e.preventDefault();
                  keepTextSelection();
                }}
                onClick={() => changeSize((format?.size ?? defaultSize) + 1)}
              >
                +
              </button>
              <button
                title="Pick a size"
                onMouseDown={(e) => {
                  e.preventDefault();
                  keepTextSelection();
                }}
                onClick={(e) =>
                  setCtx({
                    x: e.clientX,
                    y: e.clientY,
                    items: FONT_SIZES.map((s) => ({
                      label: `${s} pt`,
                      onClick: () => changeSize(s),
                    })),
                  })
                }
              >
                <IcChevron size={12} />
              </button>
            </div>
            <ColorControl
              glyph="A"
              title="Text colour"
              value={lastColor}
              current={format?.color}
              allowDefault
              onKeepSelection={keepTextSelection}
              onEndRibbon={endRibbon}
              onPick={changeColor}
            />
            <ColorControl
              glyph="▮"
              title="Text highlight colour"
              value={lastHl}
              current={format?.highlight ?? null}
              allowNone
              onKeepSelection={keepTextSelection}
              onEndRibbon={endRibbon}
              onPick={changeHighlight}
            />
            <button className="btn" title="Clear formatting (Ctrl+Space)" onClick={() => exec("removeFormat")} {...noMouseSteal}>
              Clear
            </button>
            <div className="sep" />
            <button
              className={`btn ${format?.bullet ? "active" : ""}`}
              title="Toggle bullets"
              onClick={() => applyBullets(bulletStyle)}
              {...noMouseSteal}
            >
              {BULLET_GLYPHS[bulletStyle]} Bullets
            </button>
            <select
              ref={bulletStyleRefEl}
              value={bulletStyle}
              onChange={(e) => setBulletStyle(e.target.value)}
              title="Bullet style — scroll to cycle"
            >
              {Object.entries(BULLET_GLYPHS).map(([k, g]) => (
                <option key={k} value={k}>
                  {g} {k}
                </option>
              ))}
            </select>
            <div className="sep" />
            <TablePicker
              onKeepSelection={keepTextSelection}
              onEndRibbon={endRibbon}
              onInsert={(rows, cols) => {
                insertTable(rows, cols);
                endRibbon();
              }}
            />
            <button className="btn" onClick={insertImages}>
              <IcImage size={15} /> Image
            </button>
            <button className="btn" title="Browse and add a GIF" onClick={() => setGifOpen(true)}>
              GIF
            </button>
            <button className="btn" title="Insert a PDF as one joined set of pages" onClick={insertPdfs}>
              <IcPdf size={15} /> PDF
            </button>
            <button className="btn" title="Collapsible note — draw and type inside it" onClick={insertFold}>
              <IcFold size={15} /> Fold
            </button>
            <button
              className="btn"
              title="Insert math (Ctrl+M)"
              onClick={startMathInsert}
              {...noMouseSteal}
            >
              <IcMath size={15} /> Math
            </button>
          </div>
        )}

        {openRibbons.has("Draw") && (
          <div className="action-section draw-ribbon" inert={expired || undefined}>
            <div className="seg">
              {(
                [
                  ["select", <IcCursor key="c" size={15} />, "Select", "V / Esc"],
                  ["lasso", <IcLasso key="s" size={15} />, "Lasso", "S · draw around objects to select them"],
                ] as [Tool, React.ReactNode, string, string][]
              ).map(([t, icon, label, hint]) => (
                <button
                  key={t}
                  className={`btn ${tool === t ? "active" : ""}`}
                  title={`${label} (${hint})`}
                  onClick={() => setTool(t)}
                >
                  {icon}
                  <span className="small">{label}</span>
                </button>
              ))}
            </div>
            <div className="seg">
              {(
                [
                  ["pen", <IcPen key="p" size={15} />, "Pen", "P · Shift = straight · side button lassos · eraser end erases · hold right-click to erase"],
                  ["highlighter", <IcHighlighter key="h" size={15} />, "Marker", "H · Shift = straight · side button lassos · eraser end erases · hold right-click to erase"],
                  ["smart", <IcSpark key="g" size={15} />, "Smart", "G · lightly straightens lines and tidy shapes. Writing stays writing. Hold right-click to erase."],
                  ["eraser", <IcEraser key="e" size={15} />, "Eraser", "E · set mode and size here"],
                ] as [Tool, React.ReactNode, string, string][]
              ).map(([t, icon, label, hint]) => (
                <button
                  key={t}
                  className={`btn ${tool === t ? "active" : ""}`}
                  title={`${label} (${hint})`}
                  onClick={() => setTool(t)}
                >
                  {icon}
                  <span className="small">{label}</span>
                </button>
              ))}
            </div>
            <div className="seg">
              {(
                [
                  ["line", <IcLine key="l" size={15} />, "Line", "Line (L · Shift = 45° steps · hold right-click to erase)"],
                  ["arrow", <IcArrow key="a" size={15} />, "Arrow", "Arrow (A · Shift = 45° steps · hold right-click to erase)"],
                  ["rect", <IcRect key="r" size={15} />, "Rect", "Rectangle (R · Shift = square · hold right-click to erase)"],
                  ["ellipse", <IcEllipse key="o" size={15} />, "Ellipse", "Ellipse (O · Shift = circle · hold right-click to erase)"],
                ] as [Tool, React.ReactNode, string, string][]
              ).map(([t, icon, label, hint]) => (
                <button
                  key={t}
                  className={`btn ${tool === t ? "active" : ""}`}
                  title={hint}
                  onClick={() => setTool(t)}
                >
                  {icon}
                  <span className="small">{label}</span>
                </button>
              ))}
            </div>
            {tool === "eraser" && (
              <>
                <div className="sep" />
                <span className="lbl">Mode</span>
                <div className="seg" title="Shift+E toggles the eraser mode">
                  <button
                    className={`btn ${drawPrefs.eraserMode === "area" ? "active" : ""}`}
                    title="Area: erase only what is under the eraser ring"
                    onClick={() => updateDrawPrefs({ eraserMode: "area" })}
                  >
                    <span className="small">Area</span>
                  </button>
                  <button
                    className={`btn ${drawPrefs.eraserMode === "shape" ? "active" : ""}`}
                    title="Shape: remove every whole stroke or shape the eraser touches"
                    onClick={() => updateDrawPrefs({ eraserMode: "shape" })}
                  >
                    <span className="small">Shape</span>
                  </button>
                </div>
                <div className="seg" title="Eraser size">
                  {(Object.keys(ERASER_SIZES) as EraserSize[]).map((s) => (
                    <button
                      key={s}
                      className={`btn eraser-size ${drawPrefs.eraserSize === s ? "active" : ""}`}
                      title={`Eraser size ${s}`}
                      onClick={() => updateDrawPrefs({ eraserSize: s })}
                    >
                      <span className="dot" style={{ width: ERASER_SIZES[s] * 0.75 + 3, height: ERASER_SIZES[s] * 0.75 + 3 }} />
                    </button>
                  ))}
                </div>
              </>
            )}
            {tool === "arrow" && (
              <>
                <div className="sep" />
                <span className="lbl">Mode</span>
                <div className="seg" title="Free follows your stroke. Straight is a dragged line.">
                  <button className={`btn ${drawPrefs.arrowMode === "free" ? "active" : ""}`} onClick={() => pickArrow({ arrowMode: "free" })}>
                    <span className="small">Free</span>
                  </button>
                  <button className={`btn ${drawPrefs.arrowMode === "straight" ? "active" : ""}`} onClick={() => pickArrow({ arrowMode: "straight" })}>
                    <span className="small">Straight</span>
                  </button>
                </div>
                <span className="lbl">Tip</span>
                <div className="seg">
                  <button className={`btn ${drawPrefs.arrowHead === "drawn" ? "active" : ""}`} title="Hand-drawn tip" onClick={() => pickArrow({ arrowHead: "drawn" })}>
                    <span className="small">Drawn</span>
                  </button>
                  <button className={`btn ${drawPrefs.arrowHead === "open" ? "active" : ""}`} title="Open tip" onClick={() => pickArrow({ arrowHead: "open" })}>
                    <span className="small">Open</span>
                  </button>
                  <button className={`btn ${drawPrefs.arrowHead === "full" ? "active" : ""}`} title="Filled tip" onClick={() => pickArrow({ arrowHead: "full" })}>
                    <span className="small">Full</span>
                  </button>
                </div>
                <span className="lbl">Line</span>
                <div className="seg">
                  <button className={`btn ${drawPrefs.arrowBody === "single" ? "active" : ""}`} onClick={() => pickArrow({ arrowBody: "single" })}>
                    <span className="small">Single</span>
                  </button>
                  <button className={`btn ${drawPrefs.arrowBody === "double" ? "active" : ""}`} title="Double line, like ⇒" onClick={() => pickArrow({ arrowBody: "double" })}>
                    <span className="small">Double</span>
                  </button>
                </div>
              </>
            )}
            <div className="sep" />
            {tool === "highlighter" ? (
              <>
                <div className="pen-swatches" title="Marker colour">
                  {HL_COLORS.map((c) => (
                    <button
                      key={c}
                      className={`pen-sw ${drawPrefs.hlColor.toLowerCase() === c ? "on" : ""}`}
                      style={{ background: c }}
                      title={c}
                      onClick={() => pickHlColor(c)}
                    />
                  ))}
                </div>
                <ColorControl
                  glyph={<IcHighlighter size={12} />}
                  title="More marker colours"
                  value={drawPrefs.hlColor}
                  onKeepSelection={() => {}}
                  onEndRibbon={() => {}}
                  onPick={pickHlColor}
                />
                <span className="lbl">Width</span>
                <div className="seg" title="Marker width ([ and ] to change)">
                  {HL_WIDTHS.map((w, i) => (
                    <button
                      key={w}
                      className={`btn ${drawPrefs.hlWidth === w ? "active" : ""}`}
                      onClick={() => updateDrawPrefs({ hlWidth: w })}
                    >
                      {["S", "M", "L"][i]}
                    </button>
                  ))}
                </div>
                <button type="button" className="btn apply-last" title="Apply this colour and width to the last stroke" onClick={applyColorToLast}>
                  <IcLast size={12} />
                  Last
                </button>
                <label className="hl-opacity" title="How strong the marker is. It stays translucent, and crossing a stroke only darkens it a little.">
                  <span className="lbl">Ink</span>
                  <input
                    type="range"
                    min={15}
                    max={72}
                    step={1}
                    value={Math.round(drawPrefs.hlOpacity * 100)}
                    aria-label="Marker opacity"
                    onChange={(e) => {
                      const opacity = Number(e.target.value) / 100;
                      updateDrawPrefs({ hlOpacity: opacity });
                      restyleSelectedDrawings({ opacity });
                    }}
                  />
                  <span className="hl-opacity-val">{Math.round(drawPrefs.hlOpacity * 100)}%</span>
                </label>
              </>
            ) : (
              <>
                <div className="pen-swatches" title="Pen colour">
                  {PEN_QUICK_COLORS.map((c) => {
                    const hex = c ?? themeInk(settings.theme);
                    const on = c === null ? drawPrefs.color === null : drawPrefs.color?.toLowerCase() === c;
                    return (
                      <button
                        key={c ?? "auto"}
                        className={`pen-sw ${on ? "on" : ""}`}
                        style={{ background: hex }}
                        title={c === null ? "Ink (follows the theme)" : c}
                        onClick={() => pickDrawColor(c)}
                      />
                    );
                  })}
                </div>
                <ColorControl
                  glyph={<IcPen size={12} />}
                  title="More pen colours"
                  value={drawColor}
                  allowDefault
                  onKeepSelection={() => {}}
                  onEndRibbon={() => {}}
                  onPick={pickDrawColor}
                />
                <span className="lbl">Width</span>
                <div className="seg" title="Stroke width ([ and ] to change)">
                  {DRAW_WIDTHS.map((w) => (
                    <button
                      key={w}
                      className={`btn ${drawWidth === w ? "active" : ""}`}
                      onClick={() => pickDrawWidth(w)}
                    >
                      {w}
                    </button>
                  ))}
                </div>
                <button type="button" className="btn apply-last" title="Apply this colour and width to the last stroke" onClick={applyColorToLast}>
                  <IcLast size={12} />
                  Last
                </button>
              </>
            )}
          </div>
        )}

        {openRibbons.has("View") && (
          <div className="action-section">
            <span className="lbl">Theme</span>
            <div className="seg">
              {(
                [
                  ["bright", <IcSun key="s" size={15} />, "Bright"],
                  ["mix", <IcMix key="m" size={15} />, "Mix"],
                  ["dark", <IcMoon key="d" size={15} />, "Dark"],
                ] as [string, React.ReactNode, string][]
              ).map(([value, icon, label]) => (
                <button
                  key={value}
                  className={`btn ${settings.theme === value ? "active" : ""}`}
                  title={value === "mix" ? "Dark interface, bright page" : `${label} theme`}
                  onClick={async () => {
                    const next = { ...settings, theme: value };
                    document.documentElement.dataset.theme = value;
                    await api.saveSettings(next);
                    onSettings(next);
                  }}
                >
                  {icon}
                  <span className="small">{label}</span>
                </button>
              ))}
            </div>
            <div className="sep" />
            <span className="lbl">Paper</span>
            <div className="seg" title="Background of this note (not printed)">
              {(["blank", "dots", "lines", "grid"] as PaperStyle[]).map((p) => (
                <button
                  key={p}
                  className={`btn ${paper === p ? "active" : ""}`}
                  disabled={!note}
                  title={!note ? messages.openNoteFirst : undefined}
                  onClick={() => setPaper(p)}
                >
                  <span className={`paper-swatch ps-${p}`} />
                  <span className="small">{p[0].toUpperCase() + p.slice(1)}</span>
                </button>
              ))}
            </div>
            <div className="sep" />
            <button className="btn" title={messages.fullscreen} onClick={toggleFullscreen}>
              <IcFullscreen size={15} /> Full screen
            </button>
          </div>
        )}
      </div>

      {/* ── body ── */}
      <div className="nb-body" style={{ position: "relative" }}>
        {mode === "notebook" &&
          (ui.sidebar_collapsed ? (
            <div className="sidebar-rail">
              <button
                className="btn icon"
                title="Expand note list"
                onClick={() => persistUi({ ...ui, sidebar_collapsed: false })}
              >
                <IcExpand size={15} />
              </button>
            </div>
          ) : (
            <>
              <div
                className="sidebar"
                data-tour="nb-sidebar"
                style={{ width: ui.sidebar_width }}
                onContextMenu={(e) => {
                  const t = e.target as HTMLElement;
                  if (t.closest(".note-item, .sep-line, .sidebar-head, .sidebar-new, .sidebar-filter, button, input, select")) return;
                  e.preventDefault();
                  const last = visibleNotes[visibleNotes.length - 1];
                  setCtx({
                    x: e.clientX,
                    y: e.clientY,
                    items: [
                      { label: "Create new note", icon: <IcPlus size={14} />, onClick: () => createNote() },
                      { label: "Add separator", onClick: () => addSeparator(last?.title ?? "") },
                      { label: "Select notes for export", icon: <IcExportMulti size={14} />, onClick: beginExportSelect },
                    ],
                  });
                }}
              >
                <div className="sidebar-head">
                  <select
                    value={ui.sort}
                    onChange={(e) => persistUi({ ...ui, sort: e.target.value })}
                    title="Sort notes"
                  >
                    <option value="name">Name ↑</option>
                    <option value="name_desc">Name ↓</option>
                    <option value="created">Created ↑</option>
                    <option value="created_desc">Created ↓</option>
                  </select>
                  <button
                    className="btn icon"
                    title="Collapse"
                    onClick={() => persistUi({ ...ui, sidebar_collapsed: true })}
                  >
                    <IcCollapse size={15} />
                  </button>
                </div>
                <div className="sidebar-new">
                  <button
                    className="btn primary"
                    style={{ width: "100%", justifyContent: "center" }}
                    onClick={createNote}
                    disabled={expired}
                    title={expired ? messages.expiredBanner : "New note (Ctrl+N)"}
                  >
                    <IcPlus size={15} /> New note
                  </button>
                </div>
                {sortedNotes.length > 1 && (
                  <div className="sidebar-filter">
                    <IcSearch size={13} />
                    <input
                      value={listFilter}
                      placeholder="Filter notes"
                      title="↑ ↓ open the previous / next note · Enter opens the first match · Esc clears"
                      onChange={(e) => setListFilter(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                          e.preventDefault();
                          stepNote(e.key === "ArrowDown" ? 1 : -1);
                        } else if (e.key === "Enter") {
                          e.preventDefault();
                          const first = visibleNotes[0];
                          if (first && first.path !== note?.path) openNote(first.path);
                          noteListRef.current?.focus({ preventScroll: true });
                        } else if (e.key === "Escape") {
                          if (listFilter) setListFilter("");
                          else (e.target as HTMLInputElement).blur();
                        }
                      }}
                    />
                    {listFilter && (
                      <button className="btn icon" title="Clear filter" onClick={() => setListFilter("")}>
                        <IcClose size={12} />
                      </button>
                    )}
                  </div>
                )}
                <ul
                  className="note-list"
                  ref={noteListRef}
                  tabIndex={-1}
                  onKeyDown={(e) => {
                    if ((e.target as HTMLElement).tagName === "INPUT") return;
                    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                      e.preventDefault();
                      stepNote(e.key === "ArrowDown" ? 1 : -1);
                    }
                  }}
                >
                  {(() => {
                    const sepFrom = sepDrag
                      ? listWithSeps.findIndex((row) => row.kind === "sep" && row.id === sepDrag.id)
                      : -1;
                    const sepDrop = sepDrag && sepDrag.to !== sepFrom ? sepDrag.to : -1;
                    return listWithSeps.map((item, idx) => {
                      const drop = sepDrop === idx ? <div key={`drop-${idx}`} className="sep-drop" /> : null;
                      if (item.kind === "sep") {
                        const untitled = !item.title && sepEdit?.id !== item.id;
                        return [
                          drop,
                          <div
                            key={item.id}
                            data-list-index={idx}
                            className={`sep-line${untitled ? " untitled" : ""}${sepDrag?.id === item.id ? " dragging" : ""}`}
                            title="Drag to move · right-click for a title"
                            onPointerDown={(e) => {
                              if (e.button !== 0) return;
                              if ((e.target as HTMLElement).closest("input")) return;
                              e.preventDefault();
                              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                              setSepDrag({ id: item.id, to: idx });
                            }}
                            onPointerMove={(e) => {
                              if (sepDragRef.current?.id !== item.id) return;
                              const row = (document.elementFromPoint(e.clientX, e.clientY) as Element | null)?.closest("[data-list-index]");
                              const to = row ? Number(row.getAttribute("data-list-index")) : idx;
                              if (Number.isFinite(to) && to !== sepDragRef.current.to) setSepDrag({ id: item.id, to });
                            }}
                            onPointerUp={() => {
                              if (sepDragRef.current?.id === item.id) finishSepDrag();
                            }}
                            onContextMenu={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              const titled = !!item.title;
                              setCtx({
                                x: e.clientX,
                                y: e.clientY,
                                items: [
                                  {
                                    label: titled ? "Change title" : "Give title",
                                    onClick: () => setSepEdit({ id: item.id, title: item.title }),
                                  },
                                  {
                                    label: "Remove title",
                                    disabled: !titled,
                                    onClick: () => retitleSeparator(item.id, ""),
                                  },
                                  "sep",
                                  { label: "Remove separator", icon: <IcTrash size={14} />, onClick: () => removeSeparator(item.id) },
                                ],
                              });
                            }}
                          >
                            {sepEdit?.id === item.id ? (
                              <input
                                className="sep-title-input"
                                autoFocus
                                value={sepEdit.title}
                                aria-label="Separator title"
                                onChange={(e) => {
                                  const title = e.target.value.toUpperCase();
                                  setSepEdit({ id: item.id, title });
                                  retitleSeparator(item.id, title);
                                }}
                                onBlur={() => setSepEdit(null)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter" || e.key === "Escape") {
                                    e.preventDefault();
                                    (e.target as HTMLInputElement).blur();
                                  }
                                }}
                                onPointerDown={(e) => e.stopPropagation()}
                              />
                            ) : item.title ? (
                              <span className="sep-title">{item.title}</span>
                            ) : null}
                          </div>,
                        ];
                      }
                      return [
                        drop,
                        <li
                          key={item.n.path}
                        data-list-index={idx}
                        className={`note-item ${note?.path === item.n.path ? "active" : ""}`}
                        onClick={() => {
                          if (renaming === item.n.path) return;
                          noteListRef.current?.focus({ preventScroll: true });
                          openNote(item.n.path);
                        }}
                        onDoubleClick={() => {
                          setRenaming(item.n.path);
                          setRenameDraft(item.n.display_title);
                        }}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          const n = item.n;
                          setCtx({
                            x: e.clientX,
                            y: e.clientY,
                            items: [
                              { label: "Open", icon: <IcDoc size={14} />, onClick: () => openNote(n.path) },
                              {
                                label: "Rename",
                                icon: <IcRename size={14} />,
                                hint: "F2",
                                onClick: () => {
                                  setRenaming(n.path);
                                  setRenameDraft(n.display_title);
                                },
                              },
                              { label: "Export…", icon: <IcExport size={14} />, onClick: () => setExportOpts({ multi: false, paths: [n.path] }) },
                              "sep",
                              { label: "Add separator below", onClick: () => addSeparator(n.title) },
                              "sep",
                              { label: "Delete", icon: <IcTrash size={14} />, danger: true, onClick: () => deleteNote(n) },
                            ],
                          });
                        }}
                      >
                        {exportSel && (
                          <input
                            type="checkbox"
                            checked={!!exportSel[item.n.path]}
                            onChange={() => {}}
                            onPointerDown={(e) => {
                              e.stopPropagation();
                              e.preventDefault();
                              dragCheck.current = { start: item.n.path, startVal: !!exportSel[item.n.path] };
                            }}
                            onPointerEnter={() => {
                              const dc = dragCheck.current;
                              if (!dc) return;
                              const paths = visibleNotes.map((x) => x.path);
                              const a = paths.indexOf(dc.start);
                              const b = paths.indexOf(item.n.path);
                              if (a < 0 || b < 0) return;
                              const [lo, hi] = a < b ? [a, b] : [b, a];
                              setExportSel((cur) => {
                                const next = { ...(cur ?? {}) };
                                for (let i = lo; i <= hi; i++) next[paths[i]] = !dc.startVal;
                                return next;
                              });
                            }}
                            onPointerUp={(e) => {
                              e.stopPropagation();
                              const dc = dragCheck.current;
                              if (dc && dc.start === item.n.path) {
                                setExportSel((cur) => ({ ...(cur ?? {}), [item.n.path]: !dc.startVal }));
                              }
                              dragCheck.current = null;
                            }}
                            onClick={(e) => e.stopPropagation()}
                          />
                        )}
                        {renaming === item.n.path ? (
                          <input
                            className="rename"
                            autoFocus
                            value={renameDraft}
                            onChange={(e) => setRenameDraft(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") commitRename(item.n.path, renameDraft);
                              if (e.key === "Escape") setRenaming(null);
                            }}
                            onBlur={() => commitRename(item.n.path, renameDraft)}
                            onClick={(e) => e.stopPropagation()}
                          />
                        ) : (
                          <span className={`nm ${item.n.empty_named ? "untitled" : ""}`}>
                            {item.n.display_title || "Untitled"}
                          </span>
                        )}
                        <span className="dt" title={`Created ${huDateTime(item.n.created)}`}>
                          {huDate(item.n.created)}
                        </span>
                      </li>,
                      ];
                    });
                  })()}
                  {!sortedNotes.length && (
                    <div className="muted small" style={{ padding: 12 }}>
                      No notes yet.
                    </div>
                  )}
                  {!!sortedNotes.length && !visibleNotes.length && (
                    <div className="muted small" style={{ padding: 12 }}>
                      No notes match “{listFilter.trim()}”.
                    </div>
                  )}
                </ul>
                {exportSel && (
                  <div className="sidebar-export-bar">
                    <span className="small muted">
                      {Object.values(exportSel).filter(Boolean).length} / {sortedNotes.length} selected
                    </span>
                    <div className="sidebar-export-actions">
                      <button
                        className="btn outline"
                        onClick={() => {
                          const c: Record<string, boolean> = {};
                          sortedNotes.forEach((n) => (c[n.path] = true));
                          setExportSel(c);
                        }}
                      >
                        All
                      </button>
                      <button
                        className="btn outline"
                        onClick={() => {
                          const c: Record<string, boolean> = {};
                          sortedNotes.forEach((n) => (c[n.path] = false));
                          setExportSel(c);
                        }}
                      >
                        None
                      </button>
                      <button className="btn" onClick={() => setExportSel(null)}>
                        Cancel
                      </button>
                      <button
                        className="btn primary"
                        disabled={!Object.values(exportSel).some(Boolean)}
                        onClick={() => {
                          const paths = sortedNotes.filter((n) => exportSel[n.path]).map((n) => n.path);
                          setExportSel(null);
                          setExportOpts({ multi: true, paths });
                        }}
                      >
                        Export selected…
                      </button>
                    </div>
                  </div>
                )}
              </div>
              <div
                className={`sidebar-resizer ${sbDragging ? "drag" : ""}`}
                onMouseDown={() => setSbDragging(true)}
              />
            </>
          ))}

        {/* editor */}
        <div className={`editor-pane${titleHidden ? " title-collapsed" : ""}`} data-tour="nb-canvas">
          {note ? (
            <>
              <div className={`note-title-slot${titleHidden ? " is-collapsed" : ""}`}>
              <div className="note-title-row" inert={titleHidden || undefined}>
                {/* the hidden span sizes the input to its text so the date can sit right beside it */}
                <span className="title-sizer">
                  <span className="ghost">{titleDraft || "Untitled"}</span>
                  <input
                    className="title"
                    value={titleDraft}
                    placeholder="Untitled"
                    readOnly={expired}
                    onChange={(e) => {
                      if (!expired) setTitleDraft(e.target.value);
                    }}
                    onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                    onBlur={() => {
                      if (titleDraft !== note.display_title) commitRename(note.path, titleDraft);
                    }}
                  />
                </span>
                {!expired && !note.read_only && (saveInFlight || dirty || savedFlash) && (
                  <span className="note-save-status" aria-live="polite">
                    {saveInFlight
                      ? messages.saveSaving
                      : dirty
                        ? messages.saveUnsaved
                        : messages.saveSaved}
                  </span>
                )}
                <span className="meta" title={`Created ${huDateTime(note.created)}`}>
                  {huDate(note.created)}
                </span>
                {expired && (
                  <span className="note-readonly" title={messages.expiredBanner}>
                    Trial over · reading only
                  </span>
                )}
                {note.read_only && (
                  <span className="note-readonly" title="Opened read-only so this version never rewrites it">
                    Made by a newer Paperlike · read-only
                  </span>
                )}
                <div className="spacer" />
                {note.empty_named && !titleDraft && (
                  <span style={{ display: "inline-flex", gap: 0 }}>
                    <button
                      className="btn outline"
                      style={{ borderTopRightRadius: 0, borderBottomRightRadius: 0 }}
                      title="Puts today's date at the front of the title — only offered while the note is still unnamed"
                      onClick={() => void addToday(settings.today_format)}
                    >
                      <IcCalendar size={14} /> Add today
                    </button>
                    <button
                      className="btn outline"
                      style={{ borderTopLeftRadius: 0, borderBottomLeftRadius: 0, borderLeft: 0, padding: "0 6px" }}
                      title="Choose the date format"
                      onClick={(e) => {
                        const r = e.currentTarget.getBoundingClientRect();
                        const now = new Date();
                        setCtx({
                          x: r.left - 120,
                          y: r.bottom + 4,
                          items: TODAY_FORMATS.map((f) => ({
                            label: fmtToday(now, f),
                            hint: f === (settings.today_format || TODAY_FORMATS[0]) ? "default" : undefined,
                            onClick: () => {
                              const next = { ...settings, today_format: f };
                              api.saveSettings(next).then(() => onSettings(next)).catch(() => {});
                              void addToday(f);
                            },
                          })),
                        });
                      }}
                    >
                      <IcChevron size={12} />
                    </button>
                  </span>
                )}
                <div className="note-title-tools">
                  <button
                    className={`btn icon title-autohide${titleAutoHide ? " is-on" : ""}`}
                    title={messages.titleAutoHide}
                    aria-pressed={titleAutoHide}
                    onClick={() => patchSettings({ title_auto_hide: !titleAutoHide })}
                  >
                    <IcAutoHide size={15} />
                  </button>
                  <button
                    className="btn icon"
                    title={messages.hideTitle}
                    aria-label={messages.hideTitle}
                    onClick={() => {
                      setTitleHoldOpen(false);
                      patchSettings({ title_collapsed: true });
                    }}
                  >
                    <IcChevronUp size={15} />
                  </button>
                </div>
              </div>
              </div>
              <div className={`note-title-reveal-slot${titleHidden ? " is-open" : ""}`}>
                <button className="note-title-reveal" title={messages.showTitle} aria-label={messages.showTitle} onClick={revealTitle}>
                  <IcChevron size={12} />
                </button>
              </div>

              {findOpen && (
                <div className="find-bar">
                  <input
                    value={findQ}
                    placeholder="Find in note"
                    onChange={(e) => {
                      setFindQ(e.target.value);
                      setFindIdx(0);
                      findReveal.current = true;
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") setFindOpen(false);
                      else if (e.key === "Enter" || e.key === "F3") {
                        e.preventDefault();
                        stepFind(e.shiftKey ? -1 : 1);
                      }
                    }}
                  />
                  <span className={`count ${findQ.trim() && !findTotal ? "none" : ""}`}>
                    {!findQ.trim() ? "" : findTotal ? `${Math.min(findIdx, findTotal - 1) + 1} / ${findTotal}` : "0 / 0"}
                  </span>
                  <button
                    className="btn icon"
                    title="Previous match (Shift+Enter)"
                    disabled={!findTotal}
                    onClick={() => stepFind(-1)}
                  >
                    <span style={{ display: "inline-flex", transform: "rotate(180deg)" }}>
                      <IcChevron size={14} />
                    </span>
                  </button>
                  <button
                    className="btn icon"
                    title="Next match (Enter)"
                    disabled={!findTotal}
                    onClick={() => stepFind(1)}
                  >
                    <IcChevron size={14} />
                  </button>
                  <button
                    className="btn icon"
                    title="Close (Esc)"
                    onClick={() => {
                      setFindOpen(false);
                      setFindQ("");
                    }}
                  >
                    <IcClose size={14} />
                  </button>
                </div>
              )}

              {pdf ? (
                <div className="canvas-wrap" ref={pdfPreviewRef} style={{ background: "var(--bg-2)" }}>
                  <div className="pdf-chip">
                    PDF Preview — pages locked
                    <label className="pdf-zoom">
                      <button
                        type="button"
                        className="btn pdf-zoom-step"
                        title="Smaller (next 10%)"
                        onClick={() => {
                          const sc = pdfScrollRef.current;
                          const rect = sc?.getBoundingClientRect();
                          stepPdfZoom(-1, rect ? rect.left + rect.width / 2 : 0, rect ? rect.top + rect.height / 2 : 0);
                        }}
                      >
                        −
                      </button>
                      <input
                        type="range"
                        min={Math.round(PDF_ZOOM_MIN * 100)}
                        max={Math.round(PDF_ZOOM_MAX * 100)}
                        step={1}
                        value={Math.round(pdfZoom * 100)}
                        aria-label="Preview zoom"
                        onChange={(e) => {
                          const sc = pdfScrollRef.current;
                          const rect = sc?.getBoundingClientRect();
                          zoomPreview(
                            Number(e.target.value) / 100,
                            rect ? rect.left + rect.width / 2 : 0,
                            rect ? rect.top + rect.height / 2 : 0,
                          );
                        }}
                      />
                      <button
                        type="button"
                        className="btn pdf-zoom-step"
                        title="Larger (next 10%)"
                        onClick={() => {
                          const sc = pdfScrollRef.current;
                          const rect = sc?.getBoundingClientRect();
                          stepPdfZoom(1, rect ? rect.left + rect.width / 2 : 0, rect ? rect.top + rect.height / 2 : 0);
                        }}
                      >
                        +
                      </button>
                      <button
                        type="button"
                        className="btn pdf-zoom-pct"
                        title="Reset zoom (Ctrl+0)"
                        onClick={() => {
                          const sc = pdfScrollRef.current;
                          const rect = sc?.getBoundingClientRect();
                          zoomPreview(1, rect ? rect.left + rect.width / 2 : 0, rect ? rect.top + rect.height / 2 : 0);
                        }}
                      >
                        {Math.round(pdfZoom * 100)}%
                      </button>
                    </label>
                    <button className="btn" onClick={() => computePdf()}>
                      Refresh
                    </button>
                    <button className="btn" onClick={exitPdf}>
                      Exit
                    </button>
                  </div>
                  <div className="pdf-scroll" ref={pdfScrollRef}>
                    {pdf.pages.map((pg, i) => {
                      const z = pdf.scale * pdfZoom;
                      return (
                      <div key={i} className="pdf-page" style={{ width: A4.w * pdfZoom, height: A4.h * pdfZoom, marginBottom: 26 * pdfZoom }}>
                        <div
                          className="content-clip"
                          style={{
                            left: A4.margin * pdfZoom,
                            top: A4.margin * pdfZoom,
                            width: (A4.w - 2 * A4.margin) * pdfZoom,
                            height: (A4.h - 2 * A4.margin) * pdfZoom,
                          }}
                        >
                          {pg.title ? (
                            <div className="pdf-title" style={{ height: pg.titleBlock * pdfZoom, fontSize: `${15 * pdfZoom}pt` }}>
                              {pg.title}
                            </div>
                          ) : null}
                          <div className="pdf-content" style={{ top: pg.titleBlock * pdfZoom, height: (A4.h - 2 * A4.margin - pg.titleBlock) * pdfZoom }}>
                            {pdf.page === i ? (
                              <CanvasEditor
                                lockedView={{ x: -pg.x * z, y: -pg.y * z, z }}
                                note={note}
                                onUpdate={updateNote}
                                canEdit={!expired}
                                snapshot={snapshot}
                                tool={openRibbons.has("Draw") ? tool : "select"}
                                drawColor={tool === "highlighter" ? drawPrefs.hlColor : drawColor}
                                drawWidth={tool === "highlighter" ? drawPrefs.hlWidth : drawWidth}
                                hlOpacity={drawPrefs.hlOpacity}
                                eraserMode={drawPrefs.eraserMode}
                                eraserRadius={ERASER_SIZES[drawPrefs.eraserSize]}
                                arrowMode={drawPrefs.arrowMode}
                                arrowHead={drawPrefs.arrowHead}
                                arrowBody={drawPrefs.arrowBody}
                                onToolChord={(x, y) => {
                                  setDrawPop(null);
                                  setWheel({ x, y, at: performance.now() });
                                }}
                                viewRef={viewRef}
                                paper="blank"
                                onRequestTool={setTool}
                                findQuery={findOpen ? findQ : ""}
                                heightsRef={heightsRef}
                                defaultFont={defaultFont}
                                defaultSize={defaultSize}
                                defaultColor={lastColor}
                                highlightedTextId={highlightedTextId}
                                onTextEditStart={onTextEditStart}
                                onWindowSelect={onWindowSelect}
                                onSelectionChange={onCanvasSelection}
                                onLiveDraw={onLiveDraw}
                              />
                            ) : (
                              <LazyPdfStatic
                                note={note}
                                scale={pdf.scale * pdfZoom}
                                originX={pg.x}
                                originY={pg.y}
                                view={{
                                  x: pg.x,
                                  y: pg.y,
                                  w: (A4.w - 2 * A4.margin) / pdf.scale,
                                  h: Math.max(1, (A4.h - 2 * A4.margin - pg.titleBlock) / pdf.scale),
                                }}
                                onActivate={() => setPdf((p) => (p ? { ...p, page: i } : p))}
                              />
                            )}
                          </div>
                        </div>
                        <div className="page-num" style={{ bottom: 14 * pdfZoom, fontSize: 11 * pdfZoom }}>
                          {i + 1} / {pdf.pages.length}
                        </div>
                      </div>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <CanvasEditor
                  note={note}
                  onUpdate={updateNote}
                  canEdit={!expired}
                  snapshot={snapshot}
                  tool={openRibbons.has("Draw") ? tool : "select"}
                  drawColor={tool === "highlighter" ? drawPrefs.hlColor : drawColor}
                  drawWidth={tool === "highlighter" ? drawPrefs.hlWidth : drawWidth}
                  hlOpacity={drawPrefs.hlOpacity}
                  eraserMode={drawPrefs.eraserMode}
                  eraserRadius={ERASER_SIZES[drawPrefs.eraserSize]}
                  arrowMode={drawPrefs.arrowMode}
                  arrowHead={drawPrefs.arrowHead}
                  arrowBody={drawPrefs.arrowBody}
                  onToolChord={(x, y) => {
                    setDrawPop(null);
                    setWheel({ x, y, at: performance.now() });
                  }}
                  viewRef={viewRef}
                  liveCamRef={camRef}
                  initialCam={restoreCamRef.current}
                  paper={paper}
                  onRequestTool={setTool}
                  findQuery={findOpen ? findQ : ""}
                  heightsRef={heightsRef}
                  defaultFont={defaultFont}
                  defaultSize={defaultSize}
                  defaultColor={lastColor}
                  highlightedTextId={highlightedTextId}
                  onTextEditStart={onTextEditStart}
                  onWindowSelect={onWindowSelect}
                  onSelectionChange={onCanvasSelection}
                  onLiveDraw={onLiveDraw}
                  dragGhost={dragGhost}
                />
              )}
            </>
          ) : (
            <div className="empty-state">
              <div className="big">✎</div>
              <div>No note open</div>
              {mode === "notebook" && (
                <button className="btn primary" onClick={createNote}>
                  <IcPlus size={15} /> Create a note
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {wheel && (
        <ToolWheel
          x={wheel.x}
          y={wheel.y}
          tool={tool}
          onPick={(t) => {
            setTool(t);
            if (t !== "select") setOpenRibbons((prev) => (prev.has("Draw") ? prev : new Set<Ribbon>(["Draw"])));
            setWheel(null);
          }}
          onCenter={() => {
            const fresh = performance.now() - wheel.at < 550;
            const at = { x: wheel.x, y: wheel.y - 8 };
            setWheel(null);
            if (fresh) setDrawPop(at);
          }}
          onDismiss={(x, y) => {
            setWheel(null);
            viewRef.current?.press(x, y);
          }}
        />
      )}
      {drawPop && (
        <DrawOptionsPop x={drawPop.x} y={drawPop.y} onClose={() => setDrawPop(null)}>
          {tool === "eraser" ? (
            <>
              <div className="draw-pop-row">
                <span className="lbl">Mode</span>
                <div className="seg">
                  <button className={`btn ${drawPrefs.eraserMode === "area" ? "active" : ""}`} onClick={() => updateDrawPrefs({ eraserMode: "area" })}>Area</button>
                  <button className={`btn ${drawPrefs.eraserMode === "shape" ? "active" : ""}`} onClick={() => updateDrawPrefs({ eraserMode: "shape" })}>Shape</button>
                </div>
              </div>
              <div className="draw-pop-row">
                <span className="lbl">Size</span>
                <div className="seg">
                  {(Object.keys(ERASER_SIZES) as EraserSize[]).map((s) => (
                    <button key={s} className={`btn ${drawPrefs.eraserSize === s ? "active" : ""}`} onClick={() => updateDrawPrefs({ eraserSize: s })}>{s}</button>
                  ))}
                </div>
              </div>
            </>
          ) : tool === "select" || tool === "lasso" ? (
            <p className="draw-pop-hint">Right-click, then click a tool. Click the middle again for these settings.</p>
          ) : (
            <>
              {tool === "arrow" && (
                <>
                  <div className="draw-pop-row">
                    <span className="lbl">Path</span>
                    <div className="seg">
                      <button className={`btn ${drawPrefs.arrowMode === "free" ? "active" : ""}`} onClick={() => pickArrow({ arrowMode: "free" })}>Free</button>
                      <button className={`btn ${drawPrefs.arrowMode === "straight" ? "active" : ""}`} onClick={() => pickArrow({ arrowMode: "straight" })}>Straight</button>
                    </div>
                  </div>
                  <div className="draw-pop-row">
                    <span className="lbl">Tip</span>
                    <div className="seg">
                      <button className={`btn ${drawPrefs.arrowHead === "drawn" ? "active" : ""}`} onClick={() => pickArrow({ arrowHead: "drawn" })}>Drawn</button>
                      <button className={`btn ${drawPrefs.arrowHead === "open" ? "active" : ""}`} onClick={() => pickArrow({ arrowHead: "open" })}>Open</button>
                      <button className={`btn ${drawPrefs.arrowHead === "full" ? "active" : ""}`} onClick={() => pickArrow({ arrowHead: "full" })}>Full</button>
                    </div>
                  </div>
                  <div className="draw-pop-row">
                    <span className="lbl">Line</span>
                    <div className="seg">
                      <button className={`btn ${drawPrefs.arrowBody === "single" ? "active" : ""}`} onClick={() => pickArrow({ arrowBody: "single" })}>Single</button>
                      <button className={`btn ${drawPrefs.arrowBody === "double" ? "active" : ""}`} onClick={() => pickArrow({ arrowBody: "double" })}>Double</button>
                    </div>
                  </div>
                </>
              )}
              <div className="draw-pop-row">
                <span className="lbl">Colour</span>
                <div className="pen-swatches">
                  {(tool === "highlighter" ? HL_COLORS.map((c) => c) : PEN_QUICK_COLORS).map((c) => {
                    const hex = c ?? themeInk(settings.theme);
                    const on = tool === "highlighter"
                      ? drawPrefs.hlColor.toLowerCase() === c
                      : c === null ? drawPrefs.color === null : drawPrefs.color?.toLowerCase() === c;
                    return (
                      <button
                        key={c ?? "auto"}
                        className={`pen-sw ${on ? "on" : ""}`}
                        style={{ background: hex }}
                        onClick={() => (tool === "highlighter" && c ? pickHlColor(c) : pickDrawColor(c))}
                      />
                    );
                  })}
                </div>
              </div>
              <div className="draw-pop-row">
                <span className="lbl">Width</span>
                <div className="seg">
                  {(tool === "highlighter" ? HL_WIDTHS : DRAW_WIDTHS).map((w) => (
                    <button
                      key={w}
                      className={`btn ${(tool === "highlighter" ? drawPrefs.hlWidth : drawWidth) === w ? "active" : ""}`}
                      onClick={() => (tool === "highlighter" ? updateDrawPrefs({ hlWidth: w }) : pickDrawWidth(w))}
                    >
                      {w}
                    </button>
                  ))}
                </div>
                <button type="button" className="btn apply-last" title="Apply this colour and width to the last stroke" onClick={applyColorToLast}>
                  <IcLast size={12} />
                  Last
                </button>
              </div>
            </>
          )}
        </DrawOptionsPop>
      )}
      {gifOpen && <GifPicker onClose={() => setGifOpen(false)} onPick={(hit) => void insertGif(hit)} />}

      {/* ── dialogs ── */}
      {exportOpts && (
        <ExportOptionsModal
          paths={exportOpts.paths}
          multi={exportOpts.multi}
          notes={sortedNotes}
          settings={settings}
          onClose={() => setExportOpts(null)}
          onExport={(format, opts) => {
            const paths = exportOpts.paths;
            setExportOpts(null);
            runExport(paths, format, opts);
          }}
        />
      )}

      {guard && (
        <Modal
          title="Unsaved changes"
          onClose={() => {
            (window as Window & { __plCloseForDirty?: boolean }).__plCloseForDirty = false;
            setGuard(null);
          }}
          actions={
            <>
              <button
                className="btn outline"
                onClick={() => {
                  (window as Window & { __plCloseForDirty?: boolean }).__plCloseForDirty = false;
                  setGuard(null);
                }}
              >
                Cancel
              </button>
              <button
                className="btn"
                onClick={() => {
                  const g = guard;
                  setGuard(null);
                  dirtyRef.current = false;
                  setDirty(false);
                  if (noteRef.current) api.clearRecovery(noteRef.current.path).catch(() => {});
                  g.then();
                }}
              >
                Discard
              </button>
              <button
                className="btn primary"
                onClick={async () => {
                  const g = guard;
                  setGuard(null);
                  if (await save()) g.then();
                }}
              >
                Save
              </button>
            </>
          }
        >
          <p className="muted" style={{ marginTop: 0 }}>
            This note has unsaved changes.
          </p>
        </Modal>
      )}

      {mathEdit && (
        <MathPopover
          key={mathEdit.id}
          target={mathEdit.target}
          initial={mathEdit.initial}
          onClose={finishMathEdit}
        />
      )}

      {ctx && <ContextMenu x={ctx.x} y={ctx.y} items={ctx.items} onClose={() => setCtx(null)} />}
      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} />
      <PromptDialog state={prompt} onClose={() => setPrompt(null)} />
    </div>
    {moodleOpen && !moodleHeld && (
      <MoodlePane
        notebookPath={path}
        notebookName={info?.name ?? title}
        preservePage={moodlePreserve}
        onInsertPdf={(filePath) => void insertFileFromPath(filePath)}
        onClose={() => setMoodleOpen(false)}
        onFloat={() => {
          setMoodleOpen(false);
          onFloatMoodle?.(info?.name || title, true);
        }}
      />
    )}
    </div>
  );
}

/* ─── math editor ──────────────────────────────────────────────────────── */

type MathItem = { tex: string; preview?: string };
type MathCatId = "structures" | "greek" | "operators" | "relations" | "symbols";

const MATH_CATS: { id: MathCatId; label: string; items: MathItem[] }[] = [
  {
    id: "structures",
    label: "Structures",
    items: [
      { tex: "\\frac{}{}", preview: "\\frac{a}{b}" },
      { tex: "\\sqrt{}", preview: "\\sqrt{x}" },
      { tex: "\\sqrt[]{}", preview: "\\sqrt[n]{x}" },
      { tex: "^{}", preview: "x^{2}" },
      { tex: "_{}", preview: "x_{i}" },
      { tex: "\\sum_{}^{}", preview: "\\sum_{i=1}^{n}" },
      { tex: "\\int_{}^{}", preview: "\\int_{a}^{b}" },
      { tex: "\\lim_{}", preview: "\\lim_{x \\to 0}" },
      {
        tex: "\\begin{pmatrix}{} & {}\\\\{} & {}\\end{pmatrix}",
        preview: "\\begin{pmatrix}a & b\\\\c & d\\end{pmatrix}",
      },
      { tex: "\\left({}\\right)", preview: "\\left(x\\right)" },
      { tex: "\\left|{}\\right|", preview: "\\left|x\\right|" },
      { tex: "'", preview: "f'" },
    ],
  },
  {
    id: "greek",
    label: "Greek",
    items: [
      { tex: "\\alpha" },
      { tex: "\\beta" },
      { tex: "\\gamma" },
      { tex: "\\delta" },
      { tex: "\\epsilon" },
      { tex: "\\zeta" },
      { tex: "\\eta" },
      { tex: "\\theta" },
      { tex: "\\iota" },
      { tex: "\\kappa" },
      { tex: "\\lambda" },
      { tex: "\\mu" },
      { tex: "\\nu" },
      { tex: "\\xi" },
      { tex: "\\pi" },
      { tex: "\\rho" },
      { tex: "\\sigma" },
      { tex: "\\tau" },
      { tex: "\\upsilon" },
      { tex: "\\phi" },
      { tex: "\\chi" },
      { tex: "\\psi" },
      { tex: "\\omega" },
      { tex: "\\Gamma" },
      { tex: "\\Delta" },
      { tex: "\\Theta" },
      { tex: "\\Lambda" },
      { tex: "\\Pi" },
      { tex: "\\Sigma" },
      { tex: "\\Phi" },
      { tex: "\\Psi" },
      { tex: "\\Omega" },
    ],
  },
  {
    id: "operators",
    label: "Operators",
    items: [
      { tex: "\\pm" },
      { tex: "\\mp" },
      { tex: "\\times" },
      { tex: "\\div" },
      { tex: "\\cdot" },
      { tex: "\\circ" },
      { tex: "\\oplus" },
      { tex: "\\otimes" },
      { tex: "/" },
      { tex: "\\partial" },
      { tex: "\\nabla" },
      { tex: "\\prod_{}^{}", preview: "\\prod_{i=1}^{n}" },
      { tex: "!" },
      { tex: "\\ast" },
    ],
  },
  {
    id: "relations",
    label: "Relations",
    items: [
      { tex: "=" },
      { tex: "\\neq" },
      { tex: "\\approx" },
      { tex: "\\equiv" },
      { tex: "\\leq" },
      { tex: "\\geq" },
      { tex: "\\ll" },
      { tex: "\\gg" },
      { tex: "\\in" },
      { tex: "\\notin" },
      { tex: "\\subset" },
      { tex: "\\subseteq" },
      { tex: "\\cup" },
      { tex: "\\cap" },
      { tex: "\\to" },
      { tex: "\\Rightarrow" },
      { tex: "\\leftrightarrow" },
      { tex: "\\infty" },
      { tex: "\\propto" },
      { tex: "\\sim" },
    ],
  },
  {
    id: "symbols",
    label: "Symbols",
    items: [
      { tex: "\\cdots" },
      { tex: "\\ldots" },
      { tex: "\\vdots" },
      { tex: "\\ddots" },
      { tex: "\\angle" },
      { tex: "\\degree" },
      { tex: "'" },
      { tex: "\\prime" },
      { tex: "\\parallel" },
      { tex: "\\perp" },
      { tex: "\\forall" },
      { tex: "\\exists" },
      { tex: "\\neg" },
      { tex: "\\emptyset" },
      { tex: "\\hbar" },
      { tex: "\\ell" },
    ],
  },
];

function MathGlyph({ tex }: { tex: string }) {
  const html = useMemo(() => {
    try {
      return katex.renderToString(tex, { throwOnError: false, output: "html" });
    } catch {
      return tex;
    }
  }, [tex]);
  return <span className="math-glyph-inner" dangerouslySetInnerHTML={{ __html: html }} />;
}

/** LaTeX the note can render. Placeholders and MathLive-only fences stay out of storage. */
function storedLatex(mf: MathfieldElement): string {
  return mf
    .getValue("latex-without-placeholders")
    .replace(/\\mleft/g, "\\left")
    .replace(/\\mright/g, "\\right")
    .replace(/\\placeholder\{([^{}]*)\}/g, "$1");
}

/**
 * Formula editor: the caret lives in the rendered math. Typing a LaTeX command
 * (a backslash, then the name) converts it in place. The symbol menus insert
 * the same way.
 */
function MathPopover({
  target,
  initial,
  onClose,
}: {
  target: HTMLElement;
  initial: string;
  onClose: (commit: boolean) => void;
}) {
  const [openCat, setOpenCat] = useState<MathCatId | null>("structures");
  const fieldRef = useRef<MathfieldElement | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const POP_W = 460;
  const [pos, setPos] = useState(() => {
    const r = target.getBoundingClientRect();
    const left = Math.max(8, Math.min(r.left, window.innerWidth - POP_W - 8));
    let top = r.bottom + 8;
    if (top > window.innerHeight - 220) top = Math.max(8, r.top - 210);
    return { left, top };
  });

  const place = useCallback(() => {
    const r = target.getBoundingClientRect();
    const left = Math.max(8, Math.min(r.left, window.innerWidth - POP_W - 8));
    let top = r.bottom + 8;
    if (top > window.innerHeight - 220) top = Math.max(8, r.top - 210);
    setPos({ left, top });
  }, [target]);

  useEffect(() => {
    place();
  }, [place]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    MathfieldElement.soundsDirectory = null;
    const mf = new MathfieldElement();
    mf.mathVirtualKeyboardPolicy = "manual";
    mf.smartFence = false;
    mf.smartSuperscript = false;
    // A real space. The default leaves the current slot instead of inserting one.
    mf.mathModeSpace = "\\ ";
    mf.placeholder = "\\text{Type or pick a symbol}";
    mf.className = "math-field";
    mf.style.setProperty("--caret-color", "var(--accent)");
    mf.style.setProperty("--contains-highlight-background-color", "transparent");
    mf.style.setProperty("--contains-highlight-color", "currentColor");
    mf.style.setProperty("--selection-background-color", "transparent");
    mf.style.setProperty("--selection-color", "currentColor");
    const sync = () => {
      const chip = target;
      if (chip.isConnected) renderMathInto(chip, storedLatex(mf));
    };
    const caretOnly = () => {
      const root = mf.shadowRoot;
      if (!root || root.getElementById("pl-math-caret")) return;
      const style = document.createElement("style");
      style.id = "pl-math-caret";
      style.textContent = `
        .ML__focused .ML__contains-highlight,
        .ML__focused .ML__selection,
        :host(:focus) .ML__selection { background: transparent !important; }
        .ML__focused .ML__selected { color: inherit !important; }
        .ML__content-placeholder,
        .ML__focused .ML__content-placeholder,
        .ML__focused .ML__content-placeholder .ML__text {
          background: transparent !important;
          color: var(--_placeholder-color) !important;
          opacity: 0.55;
        }
        .ML__focused .ML__placeholder.ML__selected {
          background: transparent !important;
          box-shadow: inset 2px 0 0 var(--_caret-color);
        }
      `;
      root.appendChild(style);
    };
    const dropFractionKeys = () => {
      try {
        mf.keybindings = mf.keybindings.filter((binding) => {
          const command = binding.command;
          return !(Array.isArray(command) && command[0] === "insert" && String(command[1] ?? "").includes("\\frac"));
        });
      } catch {
        /* field not mounted yet */
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
      // Fraction follows the "/" character. The built-in shortcut is tied to a
      // physical key (Shift+7 on a German layout), which is "=" on this keyboard.
      if (e.key === "/" && mf.mode !== "text" && mf.mode !== "latex") {
        e.preventDefault();
        e.stopPropagation();
        mf.executeCommand(["insert", "\\frac{#@}{#?}"]);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        sync();
        onCloseRef.current(true);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onCloseRef.current(false);
      }
    };
    const hideMenu = () => {
      try {
        mf.menuItems = [];
      } catch {
        /* field not mounted yet */
      }
    };
    mf.addEventListener("mount", hideMenu);
    mf.addEventListener("mount", caretOnly);
    mf.addEventListener("mount", dropFractionKeys);
    mf.addEventListener("input", sync);
    mf.addEventListener("keydown", onKey, true);
    host.replaceChildren(mf);
    mf.value = initial;
    fieldRef.current = mf;
    hideMenu();
    caretOnly();
    dropFractionKeys();
    const focusTimer = window.setTimeout(() => {
      mf.focus();
      if (!mf.getValue("latex-without-placeholders")) mf.executeCommand("moveToMathfieldStart");
    }, 30);
    return () => {
      window.clearTimeout(focusTimer);
      mf.removeEventListener("mount", hideMenu);
      mf.removeEventListener("mount", caretOnly);
      mf.removeEventListener("mount", dropFractionKeys);
      mf.removeEventListener("input", sync);
      mf.removeEventListener("keydown", onKey, true);
      mf.remove();
      fieldRef.current = null;
    };
    // The field is created once per open. `initial` is the formula at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onScroll = (e: Event) => {
      const t = e.target;
      if (t instanceof Node && popRef.current?.contains(t)) return;
      place();
    };
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [place]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const node = e.target as Node;
      if (popRef.current?.contains(node)) return;
      const el = node instanceof Element ? node : node.parentElement;
      if (el?.closest("#mathlive-suggestion-popover, #mathlive-environment-popover, .ML__popover")) return;
      onCloseRef.current(true);
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, []);

  const insertSnippet = (s: string) => {
    const mf = fieldRef.current;
    if (!mf) return;
    const slotted = s.replace(/\{\}/g, "{\\placeholder{}}");
    mf.insert(slotted, {
      selectionMode: slotted.includes("\\placeholder") ? "placeholder" : "after",
      focus: true,
      feedback: false,
    });
    if (target.isConnected) renderMathInto(target, storedLatex(mf));
  };

  if (!pos) return null;
  const active = MATH_CATS.find((c) => c.id === openCat);

  return (
    <div className="math-pop" ref={popRef} style={{ left: pos.left, top: pos.top }}>
      <div className="math-cats">
        {MATH_CATS.map((cat) => (
          <button
            key={cat.id}
            type="button"
            className={`math-cat-btn ${openCat === cat.id ? "open" : ""}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setOpenCat((c) => (c === cat.id ? null : cat.id))}
          >
            {cat.label}
            <IcChevron size={10} />
          </button>
        ))}
      </div>
      {active && (
        <div className="math-cat-menu">
          {active.items.map((item) => (
            <button
              key={item.tex}
              type="button"
              className="math-glyph"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => insertSnippet(item.tex)}
            >
              <MathGlyph tex={item.preview ?? item.tex} />
            </button>
          ))}
        </div>
      )}
      <div className="math-pop-row">
        <div className="math-field-host" ref={hostRef} />
        <button className="btn icon" title="Done (Enter)" onClick={() => onClose(true)}>
          <IcCheck size={14} />
        </button>
        <button className="btn icon" title="Cancel (Esc)" onClick={() => onClose(false)}>
          <IcClose size={14} />
        </button>
      </div>
      <div className="math-hint">Type / to put one part over another. Tab moves between them. Enter finishes.</div>
    </div>
  );
}

/* ─── font picker (custom — native <select> steals focus and kills selection) ── */

function FontPicker({
  wrapRef,
  value,
  onPick,
  onKeepSelection,
  onEndRibbon,
}: {
  wrapRef: RefObject<HTMLDivElement | null>;
  value: string;
  onPick: (font: string) => void;
  onKeepSelection: () => void;
  onEndRibbon: () => void;
}) {
  const [open, setOpen] = useState(false);
  const list = FONTS.includes(value) ? FONTS : [value, ...FONTS];
  const valueRef = useRef(value);
  valueRef.current = value;
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;
  const onKeepRef = useRef(onKeepSelection);
  onKeepRef.current = onKeepSelection;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) {
        setOpen(false);
        onEndRibbon();
      }
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [open, wrapRef, onEndRibbon]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      onKeepRef.current();
      let i = FONTS.indexOf(valueRef.current);
      if (i < 0) i = 0;
      const dir = e.deltaY > 0 ? 1 : -1;
      onPickRef.current(FONTS[(i + dir + FONTS.length) % FONTS.length]);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [wrapRef]);

  return (
    <div
      ref={wrapRef}
      className={`font-picker-wrap ${open ? "open" : ""}`}
      title="Font — scroll to cycle"
    >
      <button
        type="button"
        className="font-picker"
        onMouseDown={(e) => {
          e.preventDefault();
          onKeepSelection();
        }}
        onClick={() => {
          onKeepSelection();
          setOpen((o) => !o);
        }}
      >
        <span className="font-picker-label" style={{ fontFamily: value }}>
          {value}
        </span>
      </button>
      {open && (
        <div className="font-pop">
          {list.map((f) => (
            <button
              key={f}
              type="button"
              className={`font-opt ${f === value ? "on" : ""}`}
              style={{ fontFamily: f }}
              onMouseDown={(e) => {
                e.preventDefault();
                onKeepSelection();
              }}
              onClick={() => {
                onPick(f);
                setOpen(false);
              }}
            >
              {f}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ─── OneNote-style table grid picker ──────────────────────────────────── */

const TABLE_PICK_MAX = 8;

function TablePicker({
  onInsert,
  onKeepSelection,
  onEndRibbon,
}: {
  onInsert: (rows: number, cols: number) => void;
  onKeepSelection: () => void;
  onEndRibbon: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState({ rows: 0, cols: 0 });
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) {
        setOpen(false);
        onEndRibbon();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        onEndRibbon();
      }
    };
    document.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onEndRibbon]);

  const guard = (e: React.MouseEvent) => {
    e.preventDefault();
    onKeepSelection();
  };

  const label =
    hover.rows > 0
      ? `Insert ${hover.rows} × ${hover.cols} table`
      : "Insert table";

  return (
    <div className="table-picker-wrap" ref={rootRef}>
      <button
        className={`btn ${open ? "active" : ""}`}
        title="Insert table"
        onMouseDown={guard}
        onClick={() => {
          onKeepSelection();
          setOpen((o) => !o);
          setHover({ rows: 0, cols: 0 });
        }}
      >
        <IcTable size={15} /> Table
      </button>
      {open && (
        <div
          className="table-pop"
          onMouseDown={guard}
          onMouseLeave={() => setHover({ rows: 0, cols: 0 })}
        >
          <div className="table-pop-title">{label}</div>
          <div
            className="table-grid"
            style={{ gridTemplateColumns: `repeat(${TABLE_PICK_MAX}, 16px)` }}
            role="grid"
            aria-label="Table size"
          >
            {Array.from({ length: TABLE_PICK_MAX * TABLE_PICK_MAX }, (_, i) => {
              const r = Math.floor(i / TABLE_PICK_MAX) + 1;
              const c = (i % TABLE_PICK_MAX) + 1;
              const on = hover.rows > 0 && r <= hover.rows && c <= hover.cols;
              return (
                <button
                  key={i}
                  type="button"
                  className={`table-grid-cell ${on ? "on" : ""}`}
                  aria-label={`${r} by ${c}`}
                  onMouseEnter={() => setHover({ rows: r, cols: c })}
                  onClick={() => {
                    onInsert(r, c);
                    setOpen(false);
                  }}
                />
              );
            })}
          </div>
          <div className="table-pop-foot">
            {hover.rows > 0 ? `${hover.rows} × ${hover.cols}` : "Hover to choose size"}
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── colour picker ────────────────────────────────────────────────────── */

const PALETTE = [
  "#1d1d1f", "#5f5f66", "#9a9aa2", "#ffffff",
  "#d64545", "#e8853d", "#e3b341", "#ffe066",
  "#4caf6d", "#2aa198", "#3f7fd6", "#5c6bc0",
  "#8e5cd9", "#d465a5", "#8d6748", "#f6c9c9",
];

/**
 * Split colour button: the main part re-applies the last colour, the chevron
 * opens a palette. Keeps text selection (mousedown preventDefault) like FontPicker.
 */
function ColorControl({
  glyph,
  title,
  value,
  current,
  allowNone,
  allowDefault,
  onPick,
  onKeepSelection,
  onEndRibbon,
}: {
  glyph: ReactNode;
  title: string;
  value: string;
  current?: string | null;
  allowNone?: boolean;
  allowDefault?: boolean;
  onPick: (color: string | null) => void;
  onKeepSelection: () => void;
  onEndRibbon: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;
  const onKeepRef = useRef(onKeepSelection);
  onKeepRef.current = onKeepSelection;
  const valueRef = useRef(value);
  valueRef.current = value;
  const currentRef = useRef(current);
  currentRef.current = current;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) {
        setOpen(false);
        onEndRibbon();
      }
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [open, onEndRibbon]);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      onKeepRef.current();
      const cur = (currentRef.current ?? valueRef.current).toLowerCase();
      let i = PALETTE.findIndex((c) => c.toLowerCase() === cur);
      if (i < 0) i = 0;
      const dir = e.deltaY > 0 ? 1 : -1;
      onPickRef.current(PALETTE[(i + dir + PALETTE.length) % PALETTE.length]);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const shown = current ?? value;
  const active = current ?? value;
  const norm = (c: string | null | undefined) => (c ?? "").toLowerCase();

  const pick = (c: string | null, close = true) => {
    if (c) pushColorHistory(c);
    onPick(c);
    if (close) setOpen(false);
  };

  const guard = (e: React.MouseEvent) => {
    e.preventDefault();
    onKeepSelection();
  };

  return (
    <div className="color-ctl" ref={rootRef} title={`${title} — scroll to cycle`}>
      <button
        className="btn icon color-main"
        title={`${title} (${value})`}
        onMouseDown={guard}
        onClick={() => onPick(value)}
      >
        <span className="glyph">{glyph}</span>
        <span className="bar" style={{ background: shown || "transparent" }} />
      </button>
      <button
        className={`btn icon color-caret ${open ? "active" : ""}`}
        title={`${title}…`}
        onMouseDown={guard}
        onClick={() => {
          onKeepSelection();
          setOpen((o) => !o);
        }}
      >
        <IcChevron size={11} />
      </button>
      {open && (
        <div className="color-pop">
          <div className="swatches">
            {PALETTE.map((c) => (
              <button
                key={c}
                className={`sw ${norm(c) === norm(active) ? "on" : ""}`}
                style={{ background: c }}
                title={c}
                onMouseDown={guard}
                onClick={() => pick(c)}
              />
            ))}
          </div>
          <CustomColorPicker
            color={active}
            onKeepSelection={onKeepSelection}
            onChange={(hex) => onPick(hex)}
          />
          <div className="color-pop-foot">
            {allowDefault && (
              <button
                className="chip"
                onMouseDown={guard}
                onClick={() => pick(null)}
              >
                Default
              </button>
            )}
            {allowNone && (
              <button
                className="chip"
                onMouseDown={guard}
                onClick={() => pick(null)}
              >
                No colour
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── static render for pages you are not editing ─────────────────────── */

function LazyPdfStatic({
  note,
  view,
  scale,
  originX,
  originY,
  onActivate,
}: {
  note: NotePayload;
  view: PdfCanvasView;
  scale: number;
  originX: number;
  originY: number;
  onActivate: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const root = el.closest(".pdf-scroll");
    const io = new IntersectionObserver(
      ([entry]) => setNear(entry.isIntersecting),
      { root: root instanceof Element ? root : null, rootMargin: "800px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div className="pdf-static" ref={ref} onPointerDown={onActivate}>
      {near && (
        <div
          style={{
            position: "absolute",
            transformOrigin: "0 0",
            transform: `scale(${scale}) translate(${-originX}px, ${-originY}px)`,
          }}
        >
          <PdfStatic note={note} view={view} />
        </div>
      )}
    </div>
  );
}

function PdfStatic({ note, view }: { note: NotePayload; view: PdfCanvasView }) {
  const hidden = collapsedIds(note.doc.canvas.objects);
  return (
    <>
      {[...note.doc.canvas.objects]
        .sort((a, b) => (a.type === "pdf" ? 0 : 1) - (b.type === "pdf" ? 0 : 1) || a.z - b.z)
        .map((o) => {
          if (hidden.has(o.id)) return null;
          if (o.type === "text") {
            return (
              <div
                key={o.id}
                className="content"
                style={{
                  position: "absolute",
                  left: o.x,
                  top: o.y,
                  width: o.width,
                  zIndex: 2 + o.z,
                  fontSize: "11pt",
                  lineHeight: 1.5,
                }}
                dangerouslySetInnerHTML={{ __html: blocksToHtml(o.blocks) }}
              />
            );
          }
          if (o.type === "image") {
            const src = note.media_b64[o.media];
            return src ? (
              isGifBase64(src) ? (
                <StillImage
                  key={o.id}
                  b64={src}
                  style={{ position: "absolute", left: o.x, top: o.y, width: o.width, height: o.height, zIndex: 2 + o.z }}
                />
              ) : (
              <img
                key={o.id}
                src={`data:image/*;base64,${src}`}
                style={{ position: "absolute", left: o.x, top: o.y, width: o.width, height: o.height, zIndex: 2 + o.z }}
                alt=""
              />
              )
            ) : null;
          }
          if (o.type === "group") {
            if (!o.collapsed) return null;
            return (
              <div key={o.id} className="fold-mark" style={{ position: "absolute", left: o.marker_x ?? o.x, top: o.marker_y ?? o.y, width: 28, height: 28, zIndex: 2 + o.z }}>
                <FoldMark />
              </div>
            );
          }
          if (o.type === "pdf") {
            return (
              <PdfView
                key={o.id}
                obj={o}
                b64={note.media_b64[o.media] ?? ""}
                view={view}
                active={false}
                chosen={[]}
                zoom={1}
                onChoose={() => {}}
                onLayout={() => {}}
                onDrop={() => {}}
                onSeparate={() => {}}
                onMove={() => {}}
                onResize={() => {}}
                shiftHeld={false}
                onToggleLock={() => {}}
              />
            );
          }
          const it = o.item;
          return (
              <svg
                key={o.id}
                className={it.kind === "stroke" && it.highlighter ? "hl" : undefined}
                style={{
                  position: "absolute",
                  left: o.x,
                  top: o.y,
                  overflow: "visible",
                  width: 1,
                  height: 1,
                  zIndex: 2 + o.z,
                }}
              >
              {it.kind === "stroke" && (
                <StrokeInk
                  pts={it.points}
                  parts={it.parts}
                  width={it.width}
                  color={it.color}
                  hl={!!it.highlighter}
                  pressure={it.pressure}
                />
              )}
              {it.kind === "stroke" && it.highlighter && (
                <HlBounds pts={[...it.points, ...(it.parts ?? []).flat()]} width={it.width} />
              )}
              {it.kind === "shape" && it.shape === "rect" && (
                <rect width={it.w} height={it.h} fill={it.fill ?? "none"} stroke={it.color} strokeWidth={it.width} />
              )}
              {it.kind === "shape" && it.shape === "ellipse" && (
                <ellipse cx={it.w / 2} cy={it.h / 2} rx={it.w / 2} ry={it.h / 2} fill={it.fill ?? "none"} stroke={it.color} strokeWidth={it.width} />
              )}
              {it.kind === "arrow" && (
                <>
                  <ArrowInk item={it} />
                  {it.tail_style && it.tail_style !== "none" && (
                    <polygon
                      points={polyPoints(arrowHeadPolygon(it.c1, it.tail, it.width))}
                      fill={it.color}
                    />
                  )}
                </>
              )}
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
            </svg>
          );
        })}
    </>
  );
}

/* ─── export options dialog ────────────────────────────────────────────── */

function ExportOptionsModal({
  paths,
  multi,
  notes,
  settings,
  onClose,
  onExport,
}: {
  paths: string[];
  multi: boolean;
  notes: NoteListItem[];
  settings: Settings;
  onClose: () => void;
  onExport: (
    format: string,
    opts: { pageNumbers: boolean; headers: Record<string, string> | null; exportDate: boolean; geometry: boolean; separate?: boolean },
  ) => void;
}) {
  const [format, setFormat] = useState("pdf");
  const [pageNumbers, setPageNumbers] = useState(settings.export_defaults.page_numbers);
  const [exportDate, setExportDate] = useState(settings.export_defaults.export_date);
  const [geometry, setGeometry] = useState(settings.export_defaults.geometry_block);
  const [useHeaders, setUseHeaders] = useState(multi ? settings.export_defaults.title_headers : false);
  const [separate, setSeparate] = useState(false);
  const [headers, setHeaders] = useState<Record<string, string>>(() => {
    const h: Record<string, string> = {};
    for (const p of paths) {
      const n = notes.find((x) => x.path === p);
      h[p] = n?.display_title || p.replace(/^.*[\\/]/, "").replace(/\.note$/i, "");
    }
    return h;
  });

  return (
    <Modal
      title={multi ? `Export ${paths.length} notes` : "Export note"}
      wide={multi && useHeaders}
      onClose={onClose}
      actions={
        <>
          <button className="btn outline" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            onClick={() => onExport(format, { pageNumbers, headers: useHeaders ? headers : null, exportDate, geometry, separate })}
          >
            Export…
          </button>
        </>
      }
    >
      <div className="field">
        <span>Format</span>
        <div className="radio-row">
          {[
            ["pdf", "PDF"],
            ["md", "Markdown"],
          ].map(([v, label]) => (
            <div key={v} className={`radio-card ${format === v ? "on" : ""}`} onClick={() => setFormat(v)}>
              {label}
            </div>
          ))}
        </div>
      </div>
      {multi && (
        <label className="switch">
          <input type="checkbox" checked={separate} onChange={(e) => setSeparate(e.target.checked)} />
          Separate files, one per note
        </label>
      )}
      {format === "pdf" && (
        <>
          <label className="check-row">
            <input type="checkbox" checked={pageNumbers} onChange={(e) => setPageNumbers(e.target.checked)} />
            Page numbers
          </label>
          <label className="check-row">
            <input type="checkbox" checked={exportDate} onChange={(e) => setExportDate(e.target.checked)} />
            Export date
          </label>
        </>
      )}
      {format === "md" && (
        <label className="check-row">
          <input type="checkbox" checked={geometry} onChange={(e) => setGeometry(e.target.checked)} />
          Keep layout positions (for re-import into Paperlike)
        </label>
      )}
      <label className="check-row">
        <input type="checkbox" checked={useHeaders} onChange={(e) => setUseHeaders(e.target.checked)} />
        Title headers
      </label>
      {useHeaders && (
        <div style={{ marginTop: 8 }}>
          {paths.map((p) => (
            <div key={p} className="header-edit-row">
              <span className="src">{p.replace(/^.*[\\/]/, "")}</span>
              <input value={headers[p] ?? ""} onChange={(e) => setHeaders({ ...headers, [p]: e.target.value })} />
            </div>
          ))}
        </div>
      )}
      {multi && (
        <p className="muted small" style={{ marginBottom: 0 }}>
          {separate
            ? "Each selected note becomes its own file."
            : "Selected notes are combined into one file, in the same order as the note list (top to bottom)."}
        </p>
      )}
    </Modal>
  );
}
