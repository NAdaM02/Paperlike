import { invoke } from "@tauri-apps/api/core";

export type HomeTile = {
  kind: string;
  path: string;
  name: string;
  description?: string | null;
  cover_png_base64?: string | null;
  missing: boolean;
  group_name?: string | null;
  group_items?: HomeTile[] | null;
};

export type Settings = {
  version: number;
  theme: string;
  autosave: boolean;
  export_defaults: {
    page_numbers: boolean;
    title_headers: boolean;
    export_date: boolean;
    geometry_block: boolean;
  };
  last_export_dir?: string | null;
  update_on_exit?: boolean;
  autostart?: boolean;
  tray?: boolean;
  welcome_dismissed?: boolean;
  today_format?: string;
  study_prompted?: boolean;
  study_preset?: string | null;
  study_root?: string | null;
  moodle_enabled?: boolean;
  /** Windows Ink. Off treats the pen like a mouse. Missing means on. */
  pen_enabled?: boolean;
  /** Pen draws with the last pen or marker even when another tool is selected. */
  pen_always_draws?: boolean;
  /** Stroke width follows pen pressure. */
  pen_pressure?: boolean;
  /** Ignore touch while a pen is down, hovering, or was just used. */
  palm_rejection?: boolean;
  /** Hide the note title after the canvas scrolls below the top. Missing means on. */
  title_auto_hide?: boolean;
  /** Note title row manually collapsed. */
  title_collapsed?: boolean;
  /** Hide the ribbon tool row under the tabs. */
  ribbon_actions_collapsed?: boolean;
  /** Home grid tile min width in px. Missing means 168. */
  home_tile_size?: number;
};

export type StudyPresetInfo = {
  name: string;
  notebooks: string[];
  folders: string[];
  thumbnail_data_url: string | null;
  default_root: string;
};

export type StudyCreateSummary = {
  root: string;
  created_notebooks: string[];
  created_folders: string[];
  skipped: string[];
};

export type NoteListItem = {
  path: string;
  title: string;
  display_title: string;
  created: string;
  modified: string;
  empty_named: boolean;
};

export type SeparatorEntry = { after: string; id?: string; title?: string };

export type Separators = {
  name: SeparatorEntry[];
  name_desc: SeparatorEntry[];
  created: SeparatorEntry[];
  created_desc: SeparatorEntry[];
};

export type NotebookInfo = {
  path: string;
  name: string;
  description?: string | null;
  cover_png_base64?: string | null;
  notes: NoteListItem[];
  separators: Separators;
};

export type Run = {
  text: string;
  b?: boolean;
  i?: boolean;
  u?: boolean;
  s?: boolean;
  sub?: boolean;
  sup?: boolean;
  font?: string;
  size?: number;
  color?: string;
  hl?: string;
  /** When set, `text` holds LaTeX source rendered as inline math. */
  math?: boolean;
};

export type Paragraph = {
  kind?: "p";
  indent?: number;
  bullet?: string | null;
  align?: string;
  runs: Run[];
};

export type TableBlock = {
  kind: "table";
  col_widths: number[];
  rows: { cells: { blocks: Paragraph[] }[] }[];
  borders?: boolean;
};

export type Block = Paragraph | TableBlock;

export type TextObject = {
  type: "text";
  id: string;
  x: number;
  y: number;
  z: number;
  /** Position lock: inert to move and marquee unless Shift is held. The context menu can still delete it. */
  locked?: boolean;
  width: number;
  /** Optional floor for box height; content can still grow taller. */
  min_height?: number | null;
  /**
   * New boxes widen as you type, up to a comfortable line, then wrap.
   * A manual width drag clears this. Omitted on older notes, which keep their width.
   */
  fit_width?: boolean;
  blocks: Block[];
};

export type ImageObject = {
  type: "image";
  id: string;
  x: number;
  y: number;
  z: number;
  /** Position lock: inert to move and marquee unless Shift is held. The context menu can still delete it. */
  locked?: boolean;
  media: string;
  width: number;
  height: number;
};

export type DrawingItem =
  | {
      kind: "stroke";
      points: [number, number][];
      /**
       * More runs of the same marker, in the same coordinates as `points`.
       * They paint as one shape, so a crossing stays one ink level after an erase.
       */
      parts?: [number, number][][];
      width: number;
      color: string;
      highlighter?: boolean;
      pressure?: number[];
      opacity?: number;
    }
  | {
      kind: "shape";
      shape: string;
      w: number;
      h: number;
      width: number;
      color: string;
      fill?: string | null;
    }
  | {
      kind: "arrow";
      tail: [number, number];
      head: [number, number];
      c1: [number, number];
      c2: [number, number];
      width: number;
      color: string;
      head_style?: string;
      tail_style?: string;
      /** "double" is a pair of lines. Omitted is a single shaft. */
      body?: string;
      /** Freehand shaft in drawing-local coordinates. Omitted arrows are the bezier. */
      shaft?: [number, number][];
    };

export type GifHit = { id: string; preview: string; url: string; w: number; h: number };

export type DrawingObject = {
  type: "drawing";
  id: string;
  x: number;
  y: number;
  z: number;
  /** Position lock: inert to move and marquee unless Shift is held. The context menu can still delete it. */
  locked?: boolean;
  item: DrawingItem;
};

/** A collapsible note living on the canvas. Children keep absolute coordinates. */
export type GroupObject = {
  type: "group";
  id: string;
  x: number;
  y: number;
  z: number;
  /** Position lock: inert to move and marquee unless Shift is held. The context menu can still delete it. */
  locked?: boolean;
  width: number;
  /** Floor for the frame height. Content can grow the frame past this. */
  min_height?: number | null;
  collapsed?: boolean;
  /** Collapsed marker top-left. The marker is centered on the fold's chevron. */
  marker_x?: number;
  marker_y?: number;
  /** Paper fill strength, 0–1. Omitted means the default, about 88%. */
  fill?: number;
  /** Ids of objects that belong to this fold. They cannot leave it. */
  children: string[];
};

/** How the pages of one joined PDF sit next to each other. */
export type PdfLayout = "stack" | "row" | "pair-odd" | "pair-even";

/**
 * A PDF kept as the original file and drawn live. `pages` is the joined set
 * (1-based). Every page shares `pageWidth`; height follows `aspects`.
 */
export type PdfObject = {
  type: "pdf";
  id: string;
  x: number;
  y: number;
  z: number;
  /** Position lock: inert to move and marquee unless Shift is held. The context menu can still delete it. */
  locked?: boolean;
  media: string;
  pages: number[];
  /** height / width for each entry in `pages`. */
  aspects: number[];
  layout: PdfLayout;
  pageWidth: number;
  gap: number;
  /** Cover-up rects (printed page numbers); x/y/w/h are fractions 0-1 of the page. */
  masks?: PdfMask[];
  /** Hide the page index we draw, and any printed page numbers we could cover. */
  hideNumbers?: boolean;
  /** Blank stand-in while a Moodle PDF is still downloading. Not written to the note. */
  pending?: boolean;
};

export type PdfMask = { page: number; x: number; y: number; w: number; h: number; color: string };

export type CanvasObject = TextObject | ImageObject | DrawingObject | GroupObject | PdfObject;

export type NoteDocument = {
  format: string;
  version: number;
  meta: { created: string; modified: string; app_version: string };
  canvas: { objects: CanvasObject[]; paper?: PaperStyle };
};

export type PaperStyle = "blank" | "dots" | "lines" | "grid";

/** Unsaved edits left behind by a crash or a failed save. */
export type RecoveryItem = {
  key: string;
  path: string;
  title: string;
  written: string;
  exists: boolean;
  folder: boolean;
};

export type NotePayload = {
  path: string;
  title: string;
  display_title: string;
  empty_named: boolean;
  created: string;
  modified: string;
  doc: NoteDocument;
  media_b64: Record<string, string>;
  /** Written by a newer Paperlike: shown, never edited or saved. */
  read_only?: boolean;
  /** Objects this version cannot show; passed back untouched on save. */
  unknown_objects?: unknown[];
};

export type DetectedItem = {
  kind: string;
  path: string;
  name: string;
  ignored: boolean;
};

export type SearchHit = {
  note_path: string;
  note_title: string;
  notebook_name: string;
  notebook_path?: string | null;
  snippet: string;
  score: number;
};

export type NotebookUiState = {
  sort: string;
  sidebar_width: number;
  sidebar_collapsed: boolean;
  last_note?: string | null;
};

export const api = {
  getSettings: () => invoke<Settings>("get_settings"),
  saveSettings: (settings: Settings) => invoke("save_settings", { settings }),
  licensePrice: () => invoke<string>("license_price"),
  licenseStatus: () =>
    invoke<{ kind: string; days_left: number | null; secs_left: number | null; read_only: boolean; transfers_left: number | null }>("license_status"),
  licenseRefresh: (key: string | null) =>
    invoke<{ kind: string; days_left: number | null; secs_left: number | null; read_only: boolean; transfers_left: number | null }>("license_refresh", { key }),
  licenseTransfer: (key: string) => invoke("license_transfer", { key }),
  feedbackSend: (body: string) => invoke("feedback_send", { body }),
  feedbackReply: (threadId: string, body: string) => invoke("feedback_reply", { threadId, body }),
  feedbackList: () => invoke<{ threads: { id: string; body: string; created: number; unseen?: boolean; replies: { body: string; at: number; author?: string }[] }[] }>("feedback_list"),
  feedbackSeen: (threadId: string) => invoke("feedback_seen", { threadId }),
  uninstallApp: (wipe: boolean) => invoke<string>("uninstall_app", { wipe }),
  importMarkdown: (src: string, destDir: string) =>
    invoke<{ path: string; warnings: string[] }>("import_markdown", { src, destDir }),
  getHomeTiles: () => invoke<HomeTile[]>("get_home_tiles"),
  getHome: () => invoke<{ version: number; items: unknown[] }>("get_home"),
  saveHome: (home: { version: number; items: unknown[] }) => invoke("save_home", { home }),
  addToHome: (paths: string[], makeNotebook = true) =>
    invoke("add_to_home", { paths, makeNotebook }),
  removeFromHome: (path: string) => invoke("remove_from_home", { path }),
  detectNotes: () => invoke<DetectedItem[]>("detect_notes"),
  applyDetect: (add: DetectedItem[], ignore: string[]) =>
    invoke("apply_detect", { add, ignore }),
  openNotebook: (path: string) => invoke<NotebookInfo>("open_notebook", { path }),
  createNote: (notebookPath: string) =>
    invoke<NoteListItem>("create_note", { notebookPath }),
  renameNote: (path: string, newTitle: string) =>
    invoke<string>("rename_note", { path, newTitle }),
  deleteNote: (path: string) => invoke("delete_note", { path }),
  loadNote: (path: string) => invoke<NotePayload>("load_note", { path }),
  saveNote: (payload: NotePayload) => invoke<NotePayload>("save_note", { payload }),
  addTodayTitle: (path: string, format?: string) =>
    invoke<string>("add_today_title", { path, format: format ?? null }),
  setNotebookMeta: (path: string, name?: string, description?: string) =>
    invoke("set_notebook_meta", { path, name: name ?? null, description: description ?? null }),
  setNotebookCover: (path: string, imageB64: string) =>
    invoke("set_notebook_cover", { path, imageB64 }),
  saveSeparators: (path: string, separators: Separators) =>
    invoke("save_separators", { path, separators }),
  exportNote: (args: {
    notePath: string;
    dest: string;
    format: string;
    pageNumbers: boolean;
    titleHeader?: string | null;
    exportDate: boolean;
    geometryBlock: boolean;
  }) => invoke("export_note", { args }),
  exportNotesMerged: (args: {
    notePaths: string[];
    dest: string;
    format: string;
    pageNumbers: boolean;
    titleHeaders?: Record<string, string> | null;
    exportDate: boolean;
    geometryBlock: boolean;
  }) => invoke("export_notes_merged", { args }),
  searchGlobal: (query: string) => invoke<SearchHit[]>("search_global", { query }),
  createNotebook: (parent: string, name: string) =>
    invoke<string>("create_notebook", { parent, name }),
  getNotebookUi: (path: string) => invoke<NotebookUiState>("get_notebook_ui", { path }),
  setNotebookUi: (path: string, nbUi: NotebookUiState) =>
    invoke("set_notebook_ui", { path, nbUi }),
  getWindowState: () =>
    invoke<{ x: number; y: number; w: number; h: number; maximized: boolean }>("get_window_state"),
  saveWindowState: (window: { x: number; y: number; w: number; h: number; maximized: boolean }) =>
    invoke("save_window_state", { window }),
  writeRecovery: (notePath: string, payload: NotePayload) =>
    invoke("write_recovery", { notePath, payload }),
  clearRecovery: (notePath: string) => invoke("clear_recovery", { notePath }),
  listRecovery: () => invoke<RecoveryItem[]>("list_recovery"),
  recoverNote: (key: string) => invoke<{ path: string; notebook: string | null }>("recover_note", { key }),
  discardRecovery: (key: string) => invoke("discard_recovery", { key }),
  classifyPaths: (paths: string[]) =>
    invoke<{ path: string; kind: string }[]>("classify_paths", { paths }),
  createBlankNote: () => invoke<string>("create_blank_note"),
  saveBriefBundle: (title: string, body: string) =>
    invoke<string>("save_brief_bundle", { title, body }),
  revealPath: (path: string) => invoke("reveal_path", { path }),
  writeSummaryPdf: (title: string, body: string, dest: string) =>
    invoke("write_summary_pdf", { title, body, dest }),
  /** True when the pane was just created and is still loading. */
  assistantShow: (host: string, x: number, y: number, w: number, h: number) =>
    invoke<boolean>("assistant_show", { host, x, y, w, h }),
  googleStatus: () =>
    invoke<{ linked: boolean; pending: boolean; email: string }>("google_status"),
  googleShow: (x: number, y: number, w: number, h: number) =>
    invoke("google_show", { x, y, w, h }),
  googleHide: () => invoke("google_hide"),
  googleCapture: () => invoke<string>("google_capture"),
  googleForget: () => invoke<string>("google_forget"),
  assistantBounds: (host: string, x: number, y: number, w: number, h: number) =>
    invoke("assistant_bounds", { host, x, y, w, h }),
  assistantHide: () => invoke("assistant_hide"),
  assistantFocus: (host: string) => invoke("assistant_focus", { host }),
  assistantNav: (host: string, action: "back" | "forward" | "reload" | "new") =>
    invoke("assistant_nav", { host, action }),
  assistantAttach: (host: string, notePaths: string[], text: string) =>
    invoke<AttachResult>("assistant_attach", { host, notePaths, text }),
  gifSearch: (query: string) => invoke<GifHit[]>("gif_search", { query }),
  gifFetch: (url: string) => invoke<{ b64: string }>("gif_fetch", { url }),
  assistantOpen: (host: string, url: string) => invoke("assistant_open", { host, url }),
  quickAsk: (
    id: number,
    host: string,
    text: string,
    fresh: boolean,
    isPrivate: boolean,
    notePaths?: string[],
    filePaths?: string[],
  ) =>
    invoke("quick_ask", {
      id,
      host,
      text,
      fresh,
      private: isPrivate,
      notePaths: notePaths ?? [],
      filePaths: filePaths ?? [],
    }),
  quickStop: () => invoke("quick_stop"),
  quickRelease: () => invoke("quick_release"),
  stageAnalyzePng: (pngB64: string) => invoke<string>("stage_analyze_png", { pngB64 }),
  captureScreenRegion: (x: number, y: number, width: number, height: number) =>
    invoke<string>("capture_screen_region", { x, y, width, height }),
  studyPresetInfo: (presetId: string) => invoke<StudyPresetInfo>("study_preset_info", { presetId }),
  createStudyPreset: (presetId: string, root: string, createFolders: boolean) =>
    invoke<StudyCreateSummary>("create_study_preset", { presetId, root, createFolders }),
};

/** Reply of a background chat question, streamed; `error` ends it (`signin`, `nobox`, `noreply`, …). */
export type QuickEvent = { id: number; text: string; done: boolean; error: string | null; url: string | null };

export type AttachResult = { files: string[]; found_box: boolean; attached: boolean };

/** Sent by the pane's browser: page loads, and what the attach script managed. */
export type AssistantEvent = { host: string; kind: "loading" | "loaded"; detail: string };

export function newId(prefix: string) {
  const uuid =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}_${uuid.replace(/-/g, "").slice(0, 16)}`;
}
