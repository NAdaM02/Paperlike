# Spec: UI Flows

Screen-by-screen behavior. Editor internals are in [`editor.md`](editor.md),
export dialogs in [`export.md`](export.md), persistence locations in
[`app-state.md`](app-state.md).

General style: modern flat UI, generous spacing, rounded corners, subtle shadows.
Two themes — **bright** (dark text on light) and **dark** (light text on dark) —
switchable from View; choice persists in settings. All dialogs are in-app modals
(not native windows) except OS file pickers.

---

## 1. Home

Layout: top bar · notebook grid (scrollable) · nothing else. Home is the start
screen on every launch.

### 1.1 Top bar

Left side:

**"Blank note"**

Creates `Untitled.note` (then `Untitled 2.note`, …) in `Documents\Paperlike`,
pins it on Home, and opens it. The note starts with an empty title.

**"Add note or notebook to Home"**

1. Opens the native file picker in "any" mode: user can select folders and/or
   `.note` files, multi-select allowed. (Implementation note: Windows pickers can't
   mix files+folders in one dialog — acceptable to implement as a two-tab in-app
   modal: "Notebooks (folders)" / "Notes (files)", each opening the matching native
   picker; both selections accumulate in a staging list shown in the modal.)
2. Validation per item: folder without `.notebook_data` → offer "Make this a
   notebook?" (creates a minimal `.notebook_data`); `.note` file → added as
   standalone note; duplicates of already-added items are skipped with a toast.
3. Confirm → items appended to the end of the grid; `home.json` saved.

**"Detect notes and notebooks"**

1. Scan sources, in order of preference:
   - If **Everything** (voidtools) is installed and its IPC/SDK responds: query
     `.notebook_data` and `*.note` — instant results.
   - Fallback: background walk of all fixed-drive user-accessible directories,
     skipping junctions, `Windows`, `Program Files*`, `AppData`, `node_modules`,
     `.git`. Progress bar with cancel; results stream in live.
2. Results modal: a checkbox list of found notebooks and standalone notes
   (path shown small under the name). Checked by default **unless** the item is on
   the ignore list — those appear **unchecked** (owner rule: ignored items keep
   showing up, just unchecked).
   Already-added items are not listed at all.
3. Buttons: "Add selected" (adds checked; *unchecked items get added to the ignore
   list*), "Cancel" (no changes, ignore list untouched).

Right side: search (Ctrl+Shift+F, [`search.md`](search.md)), the **Quick
question** field (Ctrl+K; answer in a floating card, see [`brief.md`](brief.md)),
then:

**"Brief"**

Opens the summary desk ([`brief.md`](brief.md)). From Home it searches every
notebook on Home once a topic is typed.

**"Ask"** (also Ctrl+J, anywhere)

Opens the Claude / Gemini pane on the right ([`brief.md`](brief.md), "Asking
beside the note"). On Home nothing is attached.

### 1.2 Notebook grid

- Responsive grid of tiles: cover image (or generic notebook glyph in an
  auto-colored rounded rect derived from the name hash), name beneath, standalone
  notes use a note glyph.
- **Hover** ≥500 ms → tooltip card with the description from `.notebook_data`
  (nothing if none). Standalone notes: shows full path.
- **Left click** → open Notebook view (or standalone note view §4).
- **Right click** (notebooks) → context menu:
  1. Change name — inline rename on the tile; renames the folder on disk.
  2. Change image — image file picker; runs the cover pipeline
     ([`file-formats.md`](file-formats.md) §2.2).
  3. Change description — small text popover, saves to `.notebook_data`.
  4. ── separator ──
  5. Remove from Home — removes the entry from `home.json` only. Never touches
     disk. No confirmation needed (non-destructive).
- Right click (standalone notes): Change name / ── / Remove from Home.
- Missing-on-disk items (folder/file gone): tile grays out with a warning badge;
  click offers "Locate…" (file picker) or "Remove from Home".

### 1.3 "Manage notebooks" (top-right button)

Enters **manage mode** (button becomes "Done"):

- Tiles jiggle-free but show a grab cursor; **drag & drop reorders** the grid; drop
  target indicated with an insertion bar.
- **Grouping, Android-style**: dropping a tile *onto* another (center 60% of the
  tile as the hit zone — edges mean reorder) creates a **group** containing both.
  Group tiles render a 2×2 mini-mosaic of member covers and a name (default
  "Group", inline-renamable). Dropping further tiles onto a group adds them.
- Clicking a group (in normal mode) opens a centered overlay sub-grid of its
  members; members open on click. In manage mode, clicking a group opens the same
  overlay where members can be dragged **out** (onto the dimmed background =
  remove from group) or reordered. A group with one member left dissolves.
- Groups are **Home-only** (owner decision): stored purely in `home.json`, no
  filesystem effect.
- Esc or "Done" exits manage mode; layout saves on every completed drop.

---

## 2. Notebook view

Layout: header row (top-left controls + section bar) · action bar (contents of the
selected section) · below, side by side: note-list sidebar (left) + editor.

### 2.1 Top-left controls

- **Home button** (house icon) → back to Home. If the open note has unsaved
  changes and auto-save is off → save prompt (Save / Discard / Cancel).
- **Notebook name + dropdown chevron** → click opens a quick-switch popover
  listing all Home notebooks (covers as 20 px thumbnails, groups as flat
  sections). Click switches notebook in place (same unsaved-changes guard).
  Typing in the popover filters the list.

Right end of the header row, after the unsaved-changes dot:

- **Quick question** field (Ctrl+K) → a floating answer card
  ([`brief.md`](brief.md), "Quick question").

- **Brief** → the summary desk ([`brief.md`](brief.md)), with this notebook’s
  notes listed and the open note checked. A standalone note opens Brief with
  that note checked.
- **Ask** (Ctrl+J) → the chat pane beside the note, with the open note attached
  ([`brief.md`](brief.md)). Switching notes while it is open attaches the new one.

### 2.2 Section bar (ribbon)

Tabs left to right: **File · Edit · Draw · View**. Selecting a tab swaps the action
bar beneath. The action bar contents:

- **File**: Auto-save toggle (switch with label; state persists per app, not per
  notebook) · Save (Ctrl+S; disabled when auto-save on and clean) · Export note
  (grayed out when no note open) · Export multiple · Import .md.
  Flows: [`export.md`](export.md) §3, [`md.md`](md.md) §4.
- **Edit**: text/list/table/image/PDF/fold controls per [`editor.md`](editor.md) §2.3–2.6.
- **Draw**: tools per [`editor.md`](editor.md) §3.
- **View**: theme toggle · **Paper** (Blank / Dots / Lines / Grid — per note, saved
  in the note, undoable, never printed; see [`file-formats.md`](file-formats.md)
  §1.2) · PDF Preview toggle ([`export.md`](export.md) §2).

### 2.3 Note-list sidebar

- Lists the notebook's notes; entry = title (dim "Untitled" if empty-named) +
  small creation date. Current note highlighted.
- **Sort control** (top of sidebar): Name ↑ / Name ↓ / Created ↑ / Created ↓.
  Persisted per notebook in app state (not in `.notebook_data`).
- **Separators** ([`file-formats.md`](file-formats.md) §2.3): thin lines between
  entries. Right-click **in the gap between two entries** → "Add separator";
  right-click a separator → "Remove separator". Separator sets are independent per
  sort mode; switching sort shows that mode's set.
- **Quick create**: "+" button pinned at the sidebar bottom (and Ctrl+N): creates
  an empty-named note (file per naming rules), opens it, focuses the title field.
- **Filter** (shown when the notebook has 2+ notes): field under "New note";
  filters live by title or date (substring, case-insensitive). Separators are
  hidden while filtering. In the field: ↑/↓ open the previous/next visible note,
  Enter opens the first match and moves focus to the list, Esc clears (second Esc
  leaves the field). Empty result → "No notes match …".
- **Keyboard navigation**: after clicking an entry (or Enter in the filter) the list
  has focus; ↑/↓ open the previous/next visible note (canvas shortcuts are inactive
  while the sidebar has focus). The active entry is kept scrolled into view.
- **Quick-rename**: double-click an entry title (or F2, or right-click → Rename)
  → inline edit box; Enter commits (filename rename + separator-reference update),
  Esc cancels.
- Right-click an entry: Open · Rename · Export… (single-note export dialog) · ──
  · Delete (confirmation dialog; moves the file to the Recycle Bin, not permanent
  delete).
- **Resize**: drag the sidebar/editor divider (min 140, max 480 DIP). **Collapse**:
  chevron button in the sidebar header collapses to a 28 px rail with only the
  chevron (expand restores previous width). Width and collapsed state persist.
- Selecting a note with unsaved changes in the current one: same guard as §2.1.

### 2.4 Editor area

Per [`editor.md`](editor.md). When **no note is open** (fresh notebook or after a
delete): empty-state graphic + "Create a note" button; File → Export note grayed
out.

---

## 3. Window & app chrome

- Single main window, standard Windows chrome, min size 900×600.
- Window size/position/maximized state persist.
- Closing the window with unsaved changes → same Save/Discard/Cancel guard.
- Global search entry point: Ctrl+Shift+F anywhere → [`search.md`](search.md).

---

## 4. Standalone note view

Opening a standalone `.note` from Home (owner decision: "like a notebook, except
no note list panel and no export-multiple"):

- Identical to Notebook view **without the sidebar** (no divider, editor takes the
  full width) and with **"Export multiple" hidden** from File.
- Top-left shows the note title instead of a notebook name; the dropdown chevron
  still works and lists Home items for quick switching.
- Everything else (ribbon, editing, single export, PDF Preview) behaves the same.

---

## 5. Study presets

On launch, when `study_prompted` is false, a card asks **"Are you a TUM Aerospace
student?"** before the customer welcome tour (personal and customer builds). It
shows the preset thumbnail when `resources/presets/tum-aerospace/thumbnail.png`
is present, otherwise a plain placeholder.

**Yes, set it up** writes the bundled `tum-aerospace` preset into the chosen
folder (default `%USERPROFILE%\TUM`): a notebook for each first-semester lecture
at `Lectures/<course>`, a `Material` folder inside each notebook for lecture
PDFs, and `Exercises/<course>`. Existing files are kept, including a
`.notebook_data` that is already there. Each of those notebooks (new or already
present) is added to Home, and its cover is applied as the folder icon. The card
then lists what was created. **No** records the answer and creates nothing.
**Ask me later** closes the card until the next launch.

The same card opens from **Settings → Study**, which also has the Moodle course
browser switch (`moodle_enabled`). The tour step after the Home explanation says
what was created and where when `study_preset` is set, and otherwise points at
Settings → Study.

The preset ships inside the app binary (covers included). Those cover images
come from the example setup's artwork; confirm the rights before a customer build.

---

## 6. Moodle course browser

In a notebook, a **Moodle** button sits beside Ask when Settings → Study has the course browser on (`moodle_enabled`). If that value is missing from settings, the button also shows when the notebook path contains a `Lectures` folder, a `Material` folder is next to the notes, or `localStorage` `paperlike-moodle` is `1`.

The pane docks on the right, about 46% of the notebook. Sign in inside the pane, including two-factor prompts on `tum.de` and `aai.dfn.de`. Other links open in the system browser. A saved course opens directly; otherwise a confident name match (notebook "Mechanics 1" with "Engineering Mechanics I – Statics") opens and is stored on the notebook. The current week section is expanded. PDFs save into `Material` without overwriting, and **Insert into note** places the file on the canvas.
