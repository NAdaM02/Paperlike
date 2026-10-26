# Paperlike — Project Index

> **This file is the single source of truth for the Paperlike project.**
> It is written for both humans and AI models. Any README.md, design document,
> or implementation must be derived from — and stay consistent with — this file.

---

## 1. Project Overview

**Paperlike** is a local-first, OneNote-inspired desktop application for taking and
managing notes.

### Design philosophy

- **Pretty** — modern, clean UI with light and dark themes.
- **Powerful** — infinite canvas editing, rich text, vector drawing, flexible export.
- **Convenient** — everything is plain local files and folders; no accounts, no cloud
  lock-in, no "smart" auto-formatting that fights the user.

### Relationship to OneNote

| Inherited from OneNote | Deliberately dropped / changed |
|---|---|
| Infinite canvas with freely draggable text windows | Auto-list creation while typing or pressing Tab |
| Section-bar / ribbon-style UI (File, Edit, Draw, View) | Auto-table creation while typing |
| Note list sidebar with quick note creation | Auto-numbered lists (bullets only) |
| PDF export of notes | Cloud sync / Microsoft account dependency |
| Light-on-dark / dark-on-light theme toggle | Proprietary opaque storage (Paperlike uses inspectable local files) |

### Status

**Implementation in progress (v0.1)** — Tauri 2 + React + Rust core. Specs remain
authoritative; see [§1.5 Spec documents](#15-spec-documents).

Decided constraints:

- **Windows-only**, dedicated desktop application (not a web app).
- A WebView-based shell (e.g. **Tauri** with a Rust core) is acceptable; pure-native
  Rust GUI is not required. Final framework choice is the owner's, pending.
- Images are **embedded** in `.note` files; the format is user-inspectable
  (ZIP container with pretty-printed JSON inside).
- PDF pages are computed **at export time** from content placement (OneNote-like);
  PDF Preview locks the computed page borders.

### 1.5 Spec documents

The `specs/` folder holds the implementation-grade specifications. An AI model
implementing a feature MUST read the relevant spec first; these files override any
summary in this document.

| Spec | Covers |
|---|---|
| [`specs/file-formats.md`](specs/file-formats.md) | `.note` ZIP container and JSON schema, `.notebook_data`, folder icons, separators data, note naming rules, standalone notes |
| [`specs/editor.md`](specs/editor.md) | Infinite canvas, text windows, rich text, list/table rules, images, draw tools, undo/redo, shortcuts |
| [`specs/export.md`](specs/export.md) | Page-fitting algorithm, PDF Preview lock, export dialogs, drag-to-toggle selection, `.md` export flow |
| [`specs/md.md`](specs/md.md) | `.md` syntax: relational annotations + geometry block, round-trip import |
| [`specs/ui-flows.md`](specs/ui-flows.md) | Home, Detect, grid, groups, Notebook view, sidebar, separators UI, standalone note view |
| [`specs/app-state.md`](specs/app-state.md) | `%APPDATA%\Paperlike` layout, autosave, atomic writes, crash recovery, external-change handling |
| [`specs/search.md`](specs/search.md) | In-note and global search, index cache |
| [`specs/brief.md`](specs/brief.md) | Summaries of selected notes via Claude (browser) and Gemini (browser or API key) |

---

## 2. Core Concepts and File Model

Paperlike manages ordinary files and folders on the local filesystem. There is no
database and no hidden library: what the user sees in their file explorer *is* the
data.

### 2.1 `note` — the `.note` file

A **note** is a single custom-format `.note` file containing *all* data about that
note:

- text windows (content, rich-text styling, position, size),
- images (data + placement),
- vector drawings and shapes,
- metadata (creation date, etc.).

The internal format of `.note` is **not yet specified** (see §7.2).

### 2.2 `notebook` — a folder with `.notebook_data`

A **notebook** is a plain folder that contains `.note` files and one file named
`.notebook_data`.

Example — a notebook named *Aerospace* containing two notes:

```
Aerospace/
├── .notebook_data
├── 10-17.note
└── 10-21.note
```

`.notebook_data` stores (all fields optional):

- **Cover image** — managed in-app. When changed, Paperlike automatically generates an
  `.ico` in the app's background storage and applies it to the notebook folder as its
  folder icon (Windows folder icon mechanism).
- **Description** — shown on hover in the Home grid.
- **Separator data** — visual separators/ordering info for the notes inside the
  notebook.

### 2.3 Export

Every note and notebook must be exportable **at any time** into two formats:

| Format | Purpose |
|---|---|
| `.pdf` | Print-faithful export, similar to OneNote's PDF export. |
| `.md` | Annotated Markdown: relational layout, styling (including color/font), drawings/connectors, and an optional geometry block so the note can be reconstructed and round-tripped. |

Export rules:

- **Single note** → one output file in the chosen format.
- **Notebook / multiple selected notes** → exportable as **multiple files** (one per
  note) *or* as **a single merged file**, with:
  - optionally adjustable **title headers** per note (imported from note names, or set
    manually),
  - automatic **toggleable markings**: page numbers, export date, etc.
    (full list in [`specs/export.md`](specs/export.md) §1.1).

> The `.md` syntax is specified in [`specs/md.md`](specs/md.md): hybrid
> relational annotations (ids plus short labels), named colors, and an optional
> exact-geometry block for round-tripping back into a `.note`. Geometry is off
> by default. This is the former `.md (AI)` format; there is no separate
> lossy "human" Markdown export.

---

## 3. UI Specification

Paperlike has two main views: **Home** and **Notebook view**.

### 3.1 Home

#### Top bar

- **"Add note or notebook to Home"** — opens a file-explorer selection pop-up.
  Supports multi-selection of both notebook folders and standalone `.note` files.
- **"Detect notes and notebooks"** — scans the system for folders containing `.note`
  or `.notebook_data` files (integration with the *Everything* search tool is a
  candidate for fast scanning on Windows). Found items that are not already added are
  listed for the user to **add** or **ignore**:
  - Ignored items are *not* added.
  - On future detection runs, previously ignored items still show up, but
    **un-checked by default**.

#### Middle — notebook grid

- Grid view of added notebooks: cover image with the notebook name underneath.
- **Hover** → shows the description (from `.notebook_data`).
- **Left click** → opens the Notebook view for that notebook.
- **Right click** → context menu:
  1. "Change name"
  2. "Change image"
  3. "Change description"
  4. *(separator)*
  5. "Remove from Home"

#### Top-right

- **"Manage notebooks"** button — enters a management mode where the user can:
  - re-arrange notebook order and placement with the mouse (drag & drop),
  - create **notebook groups**, behaving like app grouping on Android (drag one
    notebook onto another to form a group; groups open into a sub-grid).

### 3.2 Notebook view

Layout, left to right: *top-left corner controls* · *section/ribbon bar* ·
*left part (note list)* · *main area (editor)*.

#### Top-left corner

- **Home button** — returns to Home.
- **Notebook name with drop-down icon** — clicking it quickly shows a list of saved
  notebooks and allows switching between them.

#### Top section bar (ribbon)

Similar to OneNote: a row of section tabs; the actions of the selected section appear
below it in an action bar. Sections, left to right:

##### "File"

- **Auto-save on/off** toggle.
- **Save**.
- **Export note** — a format selection pops up (`.pdf` / `.md`), then
  exports the currently open note. **Grayed out when no note is open** inside the
  notebook.
- **Export multiple**:
  1. Checkmarks appear next to note names in the note list; **all are checked by
     default**.
  2. A window pops up with **"All"** and **"None"** buttons to quickly set every
     checkmark.
  3. **Drag-to-toggle**: if the left mouse button is pressed on a checkmark, held,
     dragged to another note's checkmark, and released there, then *all checkmarks in
     the dragged-over range are set to the opposite of the starting checkmark's
     original state*.
  4. **Next** proceeds to format selection (and the multi-file/single-file + title
     header + page numbering options from §2.3).

##### "Edit" (similar to OneNote)

- **Text options**: bold, italics, underline, highlight, font, font size (with
  step-down/step-up buttons that change the size by one), font color, clear
  formatting, subscript, superscript, strikethrough.
- **List options**:
  - Bullet lists only — no numbered/auto-numbered lists needed.
  - Several bullet **styles** must be available.
  - **No auto-list creation** while typing or pressing Tab.
  - **Auto-indentation recognition / list continuation applies only after the user has
    manually created a list** (e.g. Enter continues the list, Tab indents within it).
- **Table creation**:
  - **No auto-table creation** while typing or pressing Tab.
  - After a table is manually created, typing-driven table management works (adding
    rows on Enter/Tab, etc.).
- **Insert image**:
  - Pop-up window with file selection; allows selecting multiple images.
  - Images must also be insertable by simply pasting (Ctrl+V) from an external
    source.

##### "Draw"

- **Mouse-first** free **vector** drawing.
- Shape drawing.
- Easy arrows with nice, easy-to-manipulate curve points.

##### "View"

- **Theme toggle** — switch between dark-on-bright and bright-on-dark (similar to
  OneNote).
- **"PDF Preview"** — renders the note *exactly* how the PDF export would render it
  as-is. If feasible, the note should be editable in this view too.

#### Left part — note list

- List of the notes in the notebook, similar to OneNote:
  - **Sort options**: by name, by date created, and their reverses.
  - **Quick-rename** in place.
- **Quick note creation** as OneNote allows; **new notes start with an empty name**.
- **Resizable width** by dragging with the mouse; a button to **collapse/expand** the
  panel.

#### Main area — editor

- **Header**: note name and creation date on top.
  - If the name is empty, a button labeled **"Add today"** appears next to it, which
    prefixes the name with the current date in `yyyy-mm-dd` format.
- **Canvas**: editing flow very similar to OneNote —
  - "infinite canvas",
  - draggable text windows,
  - images and drawings placed freely,
  - full **undo/redo** with Ctrl+Z / Ctrl+Y.

---

## 4. Non-Goals

These are **explicitly out of scope**. AI models and contributors must not add them
"helpfully":

- **No auto-list creation** triggered by typing patterns (`- `, `1. `, Tab, …).
- **No auto-table creation** triggered by typing patterns.
- **No auto-numbered lists** — bullet lists only.
- **No cloud sync of note contents, accounts, or telemetry** — notes stay in local
  files. (Users may put notebooks in a Dropbox/OneDrive folder themselves;
  external-change handling is specified in [`specs/app-state.md`](specs/app-state.md) §5.)
  The customer build may call the Paperlike server for activation, feedback, and
  updates. The personal build does not, unless update-on-exit is turned on.
- **No database/opaque library** — data lives in user-visible files and folders.
- **No OCR** of drawings/images for search (v1).

---

## 5. Behavioral Rules Summary (quick reference for AI models)

- A `.note` file is fully self-contained for its note.
- A notebook is *defined* by the presence of a `.notebook_data` file in a folder.
- Export (`.pdf`, `.md`) must be possible at any moment, from any state.
- Ignored notebooks in "Detect" remain listed but unchecked in future scans.
- New notes are created with an empty name; "Add today" prefixes `yyyy-mm-dd`.
- Formatting automation is opt-in-by-action: lists and tables only behave "smart"
  *after* the user manually created them.
- Ctrl+V with an image on the clipboard inserts the image at the cursor/canvas
  position.
- Undo/redo (Ctrl+Z / Ctrl+Y) must cover all edit operations, including canvas
  moves, drawing, and image insertion.
- Notebook groups exist only on Home (`home.json`), never on the filesystem.
- Note-list separators are stored per sort mode and added by right-clicking the
  gap between two notes (Firefox-bookmarks style).
- A standalone `.note` opens like a notebook without the sidebar and without
  "Export multiple".
- Non-Paperlike files inside a notebook folder are silently ignored, never touched.

---

## 6. Suggested Roadmap (non-binding)

A phased order to orient future work.

1. **Foundations** — final stack confirmation (§7.1); implement the `.note` /
   `.notebook_data` readers and writers per [`specs/file-formats.md`](specs/file-formats.md),
   with atomic saves per [`specs/app-state.md`](specs/app-state.md).
2. **Core editor** — infinite canvas, text windows, rich text, undo/redo, images
   per [`specs/editor.md`](specs/editor.md).
3. **Notebook & Home management** — note list, notebook grid, detect/add/ignore,
   groups, cover images + folder icons per [`specs/ui-flows.md`](specs/ui-flows.md).
4. **Export** — `.md`, then `.pdf` and PDF Preview per
   [`specs/export.md`](specs/export.md) and [`specs/md.md`](specs/md.md).
5. **Draw** — vector drawing, shapes, curve-point arrows.
6. **Search, data safety, polish** — [`specs/search.md`](specs/search.md), crash
   recovery, themes, performance, packaging.

---

## 7. Open Decisions and Gaps

Most previously open items were decided by the owner (2026-08-08) and folded into
the specs. Only the following remain — resolve with the project owner before
implementing the affected area.

### 7.1 Final stack confirmation

**Resolved:** Windows-only dedicated desktop app using **Tauri 2 + Rust core + React
TypeScript UI**. PDF via `printpdf`; dialogs via `tauri-plugin-dialog`.

### 7.2 Minor unspecified details *(non-blocking; decide when reached)*

- Hyperlinks in text and links between notes — not specified; v1 may render pasted
  URLs as plain text.
- Spellcheck — not specified; default assumption: none in v1.
- Custom paper sizes / margins UI for PDF export (constants are fixed in
  [`specs/export.md`](specs/export.md) §1 for v1).
- Image alt text for `.md` exports uses filenames; a reserved `ocr=` slot for
  local OCR of pasted screenshots is specified in [`specs/md.md`](specs/md.md)
  §2.3 but not implemented in v1.

---

## 8. Conventions for AI Agents

1. **This file plus `specs/` are authoritative.** For overlaps, the spec file wins
   over this overview; if code, README.md, or other documents conflict, update
   them to match the specs.
2. **Read the relevant spec file before implementing a feature** (map in §1.5).
3. **README.md is derived** from §1–§3 of this file (user-facing tone, no open
   decisions). Do not invent features when writing it.
4. **Do not implement anything listed in §4 (Non-Goals).**
5. **Do not resolve §7 items unilaterally.** Ask the project owner, then record the
   decision by editing this file and the affected spec.
6. When a decision is made or a feature changes, **update this file and the
   affected spec in the same change** so they never drift from reality.
7. Constants in specs (sizes, timings, limits) are deliberate defaults — implement
   them as named constants in one place so they are cheap to tune later.
