# Spec: Export & PDF Preview

Covers exporting notes/notebooks to `.pdf` and `.md`, the automatic
page-fitting algorithm, the PDF Preview view mode, and the multi-note export flow.
The `.md` *syntax* itself is specified in [`md.md`](md.md).

Decision already made by the project owner: pages are determined **at export time**
from where content sits on the canvas (OneNote-like), and switching to PDF Preview
**locks** the computed borders and size.

Decision already made by the project owner: pages are determined **at export time**
from where content sits on the canvas (OneNote-like), and switching to PDF Preview
**locks** the computed borders and size.

---

## 1. Page-fitting algorithm (PDF)

Input: the note's canvas objects. Output: an ordered list of pages, each a rectangle
in canvas coordinates, plus the paper size.

Constants (v1; a later settings UI may expose them):

- Paper: **A4 portrait** (210 × 297 mm = 794 × 1123 DIP at 96 DPI).
- Page margins: 40 DIP on all sides → content area 714 × 1043 DIP per page.
- Rendering scale: **1 canvas DIP = 1/96 inch on paper** (no auto-shrink), except
  the width rule below.

Algorithm:

1. **Content bounding box** `B` = union of all object bounding boxes (text windows
   use their rendered height). Empty note → single empty page.
2. **Horizontal fit**: if `B.width` ≤ content-area width, there is one page column,
   x-anchored at `B.left`. If wider, apply a single uniform **scale-down factor**
   `s = contentWidth / B.width` to the whole export (never scale up, never split
   horizontally — matches "figures out page size from where boxes are placed" with
   the least surprise).
3. **Vertical pagination**: starting at `B.top`, cut page-height slices downward
   until `B.bottom` is covered. For each tentative cut line `y`:
   - If the line crosses a **text line** (any line of any text window), move the cut
     up to just above that text line (text lines are never split).
   - If the line crosses an **image or drawing** whose height ≤ content-area height,
     move the cut up to just above that object (push it whole onto the next page).
     Objects taller than a page are split at the raw cut line.
   - A cut may move up at most 40% of the page height for these avoidance rules;
     beyond that, cut at the raw line (prevents pathological loops).
4. Each page renders its slice of the canvas at scale `s` into the content area,
   top-aligned, x-anchored as computed in step 2. A joined PDF object is part of
   that slice: each of its pages is painted from the original file, in the same
   arrangement as on the canvas, both in PDF Preview and in the exported PDF.

### 1.1 Optional page decorations (toggleable at export)

These are the "automatic toggleable markings" from the original goal notes. All are
checkboxes in the export dialog (defaults shown):

- **Page numbers** (on): `n / total`, bottom-center, 9 pt, gray.
- **Note title header** (on for multi-note exports, off for single): title line at
  the top of each note's first page — text is editable in the dialog per note,
  pre-filled from the note name (see §3 flow).
- **Export date** (off): bottom-left, 9 pt gray, `yyyy-mm-dd`.

---

## 2. PDF Preview (ribbon "View" → "PDF Preview")

- Toggling it on runs the page-fitting algorithm **once** and freezes the result:
  page rectangles and paper size are **locked** for the whole preview session.
- Rendering: the canvas is displayed as paper pages (white/dark sheets with
  shadow, gap between pages, decorations rendered) instead of the infinite canvas.
  Joined PDF pages are drawn from the original file, not left blank.
- **Editing stays enabled** on the page you are on: that sheet holds the real
  canvas across the **full A4 content box** (including blank paper under the
  content), so text, drawing and objects can move anywhere on the page. The
  other sheets show the same note; click one to edit it. Dragging an object
  past the bottom of the last page adds another full page immediately. Page
  borders otherwise stay locked and do not reflow until **Refresh**.
- The scroll wheel moves between pages. Ctrl+wheel still zooms the sheet.
- A chip shows "PDF Preview — pages locked", with **Refresh** and **Exit**.
- "Export note" while in preview uses the locked layout as-is.

---

## 3. Export flows (UI)

### 3.1 Single note — ribbon File → "Export note"

Grayed out when no note is open. Otherwise a dialog:

1. **Format**: `.pdf` / `.md` (radio).
2. Format-specific toggles (§1.1 for PDF; `.md` has "note title as H1 heading"
   on/off, default off for single note, plus **"Include geometry block
   (round-trip)"** default OFF per [`md.md`](md.md)).
3. Destination: save-file dialog, default filename = note title + extension
   (`.md` exports as `<title>.md`).

### 3.2 Multiple notes — ribbon File → "Export multiple"

Step 1 — selection (in the note-list sidebar):

- Checkmarks appear next to every note name; **all checked** by default.
- A floating panel appears with buttons **All** / **None** (set every checkmark),
  **Next**, **Cancel**.
- **Drag-to-toggle** (exact rule from the owner): press and hold LMB on a checkmark,
  drag, release on another note's checkmark → every checkmark in the covered range
  (inclusive) is set to the **opposite of the start checkmark's state before the
  drag**. A simple click (press+release on the same checkmark) just toggles it.
- Sidebar sorting stays active; range = visual range in current order.

Step 2 — options dialog ("Next"):

- **Format**: `.pdf` / `.md`.
- **Output**: "Multiple files (one per note)" or "Single merged file".
- **Title headers**: on/off; when on, an editable two-column list (note → header
  text) pre-filled from note names ("import from note names"), each cell manually
  overridable.
- **Page numbers** (PDF only): on/off; in merged output, numbering is continuous
  across notes.
- **Include geometry block** (`.md` only): on/off; default OFF.
- Merged `.md` output separates notes with `\n\n---\n\n` (plus optional `# header`).
  Merged order = current sidebar order.
- Destination: folder picker (multiple files) or save-file dialog (single file).
  Multiple-file names = note titles, deduplicated with ` (2)` as needed.

Progress: modal progress bar with per-note steps; errors collected and shown at the
end ("3 exported, 1 failed: <name> — <reason>"), successful files kept.

---

## 4. `.md` rendering

Syntax, annotations, geometry block, and import rules: [`md.md`](md.md).

Shared with PDF: **object order** is reading order — sort by top-left corner,
primary `y`, secondary `x` (row bands: objects whose vertical ranges overlap
≥50% count as the same row and sort by `x`).

Merged `.md` output separates notes with `\n\n---\n\n` (plus optional `# header`).

---

## 5. Shared export engine note (for implementers)

PDF and `.md` should consume the same intermediate structure:
`layout = objects + computed text line boxes + reading order + (for PDF) page
rects`. Implement layout once; the two writers are serializers over it. The PDF
writer must embed used fonts (subset) and images at original resolution capped at
300 DPI effective.
