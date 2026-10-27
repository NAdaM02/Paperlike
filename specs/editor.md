# Spec: Editor Mechanics

The main editing area of the Notebook view. Data structures referenced here are
defined in [`file-formats.md`](file-formats.md) §1.3.

Golden rules (from the project owner — never violate):

- **No auto-list creation** from typing patterns (`- `, `* `, Tab at line start…).
- **No auto-table creation** from typing patterns.
- **No numbered lists** — bullets only, multiple styles.
- Smart behavior (list continuation, table Tab-navigation) activates **only after
  the user manually created** the list/table via the ribbon.

---

## 1. Infinite canvas

- The canvas extends infinitely in all four directions; the viewport starts at
  (0,0) top-left for a new note.
- **Pan**: middle-mouse drag, or Space+left-drag, or scroll wheel (vertical) /
  Shift+wheel (horizontal). Touchpad two-finger scroll pans.
- **Zoom**: Ctrl+wheel, 10%–500%, steps of ~10% (multiplicative 1.1). Ctrl+0 resets
  to 100%. Zoom centers on the cursor position.
- **Click on empty canvas** with Select active, and no modifier, drag, or menu
  just dismissed: creates an empty text window there with a blinking caret.
  Clicking elsewhere without typing removes that empty window and does not add
  an undo step. A drag still marquees. Ctrl-click and Shift-click do not create
  a box.
- Scrollbars: thin overlay scrollbars sized to the *content bounding box + one
  viewport margin*, purely as an orientation aid.

### 1.1 Selection & manipulation (all object types)

- Left click selects an object (topmost by `z` under the cursor). Ctrl+click adds
  to selection. Click-drag on empty canvas draws a rubber-band selection.
  A marquee that covers one text window still selects the **window** (no caret).
  On a text window: the top bar and the top strip of the box select the **window**
  (object mode, no caret). A click **inside** the text enters text-edit mode.
- Selected objects show a bounding frame with 8 resize handles and a move cursor on
  the frame edge.
- Drag frame = move (multi-selection moves together). Arrow keys nudge 1 DIP,
  Shift+arrows 10 DIP.
- Delete/Backspace with object(s) selected (not in text-edit mode) deletes them.
  Window-select (top bar, move, or marquee — even a single text window) is not
  text-edit mode: Delete/Backspace removes the selected object(s).
  If **more than one** object is selected (marquee, Ctrl+click, Ctrl+A, …),
  text-edit mode does not start at all — clicking a text window moves/keeps
  the selection instead of placing a caret. Delete/Backspace then removes
  every selected object.
- Right-click on an object: context menu — Cut / Copy / Paste / (sep) / Bring to
  front / Send to back / (sep) / Delete. A right-click on a fold also has a
  background slider. The menu closes on the next click outside it, or Escape.
  A right-drag still pans; the menu opens
  only when the pointer barely moved. Right-click on empty canvas offers Paste
  when something was copied, and Unlock all when anything is locked.
- Ctrl+X/C/V work on object selections via an internal clipboard (serialized object
  JSON); paste offsets by +24,+24 DIP from the original. An image on the system
  clipboard still pastes as an image. Ctrl+C/X do nothing to objects while a
  text box is being edited.

---

## 2. Text windows

### 2.1 Geometry

- A text window has a user-controlled **width** (drag left/right frame handles);
  **height is automatic** — it grows/shrinks with content ("auto-grow down").
  Top/bottom handles are not resize handles; the frame's top bar is the move grip
  (OneNote-style).
- Minimum width 60 DIP. New windows created by canvas click default to width
  "grow-with-typing": the window widens as the user types until 480 DIP, then wraps.
  The first manual width-drag fixes the width permanently (stored in `width`).
- Overlap between objects is allowed; no snapping in v1.

### 2.2 Caret, selection, editing

- **Window selected** (top bar, top strip of the box, or move): purple wash, no
  caret. Ribbon formatting applies to the whole window and must **leave the
  window selected** — it does not enter text-edit mode.
- **Text-edit mode** starts only from a click **inside** the text (below the top
  chrome strip). Caret navigation with arrows/Home/End/Ctrl+arrows (word-wise),
  Shift extends selection, double-click selects word, triple-click selects
  paragraph, Ctrl+A selects all blocks *in the focused text window* (not the
  whole canvas).

Typing inserts at caret with the **current style** = style of the character before
the caret, or the sticky style set via ribbon toggles when the selection is empty.

### 2.3 Text styling (ribbon "Edit" + shortcuts)

| Action | Shortcut | Behavior on selection / on empty selection |
|---|---|---|
| Bold | Ctrl+B | toggle on runs / toggle sticky style |
| Italic | Ctrl+I | same |
| Underline | Ctrl+U | same |
| Strikethrough | Ctrl+- | same |
| Highlight | Ctrl+Shift+H | applies current highlight color; button has color dropdown |
| Font family | — | dropdown, applies to selection |
| Font size | — | numeric field + step-down/up buttons changing by exactly 1 pt |
| Font color | — | color button + dropdown palette (16 presets + custom picker) |
| Subscript | Ctrl+= | toggle; turning on turns superscript off |
| Superscript | Ctrl+Shift+= | toggle; turning on turns subscript off |
| Clear formatting | Ctrl+Space | reset all run styles in selection to defaults (keeps text) |

Toggle semantics on mixed selections: if any part of the selection lacks the style,
the first press applies it to all; a second press removes it from all.

### 2.4 Lists (bullets only)

- Ribbon "bullets" button with style dropdown: `disc`, `circle`, `square`, `dash`,
  `arrow`. Clicking the main button applies the last-used style.
- Applying to a selection sets `bullet` on every selected paragraph; applying to a
  caret sets it on the current paragraph.
- **After** a paragraph is a bullet (i.e., list manually created):
  - **Enter** creates a new paragraph with the same bullet + indent (continuation).
  - **Enter on an empty bullet paragraph** removes the bullet (exits the list).
  - **Tab / Shift+Tab** at *any caret position in a bullet paragraph* indents /
    outdents (`indent` ±1, clamp 0–8). Indent levels cycle bullet glyphs
    disc → circle → square (custom styles keep their glyph at all levels).
  - **Backspace at the start** of a bullet paragraph removes the bullet first; a
    second Backspace merges with the previous paragraph.
- In a **non-bullet** paragraph: Tab inserts a tab character; typing `- `, `* `,
  `1. ` etc. does nothing special. There is no path into a list except the ribbon
  button (or paste of list content).

### 2.5 Tables

- Created only via ribbon "Table" button → grid-picker popup (hover to choose up to
  8×8, click to insert) at the caret position as a new block.
- Column widths start equal at 120 DIP; draggable borders resize columns (stored in
  `col_widths`). Row height is automatic from content.
- Cells contain paragraphs (full text styling and bullets allowed; no nested
  tables).
- **After** the table exists, typing-driven management is active *inside it*:
  - **Tab** → next cell; **Shift+Tab** → previous cell. Tab in the **last cell**
    appends a new row and moves into its first cell.
  - **Enter** inside a cell → new paragraph within the cell (not a new row).
  - **Ctrl+Enter** in a cell → insert new row below the current one.
  - Right-click in a table: Insert row above/below, Insert column left/right,
    Delete row, Delete column, Delete table, Toggle borders.
  - Selecting from one cell into another selects whole cells (grid selection);
    Delete clears their content.
- Deleting the last row/column deletes the table.

### 2.6 Images

- **PDF**: the original file is embedded and drawn live, as one joined object
  (top to bottom by default). Drag any page to move the group. The corner of
  any page resizes every page; each page is rendered again from the file.
  Click a page to select it, Ctrl+click to add pages. The page outline clears
  when the PDF is no longer selected. Right-click a page for the layout icons
  (top-to-bottom, one row, two columns with odd pages on the left, two columns
  with the first page on the right), **Drop selected page** (or **pages**, when
  more than one is selected), and **Separate all pages**. That menu closes on a
  click outside it, or Escape. Each page shows a small `n / total` in its
  bottom-right corner — its place among the pages still joined, such as `5 / 7`.
  Drop pulls the selected pages out and the pages left behind close the gap.
  Separate puts every page where it already sits, each movable on its own.
  Page text can be selected and copied. A decoded picture in the PDF can be
  clicked and copied with Ctrl+C. PDF Preview and PDF export paint those same
  pages from the file.
  Shift picks a picture inside a PDF, and it is also how a locked object moves.
  Right-click Lock pins an object so it stays put until Shift is held. Choosing
  Delete (or Cut) in the context menu still removes a locked object. When two
  or more pieces from the same PDF are selected, Join pages stacks them into one
  object (mixed files stay disabled). Shift-drag a page inside a joined PDF to
  reorder it; releasing outside the object drops that page out. Hide page numbers
  covers a detected printed number with a mask that stays put when the page is resized.
- **Fold** (collapsible note): a frame at the viewport centre with a translucent
  paper fill. It blocks selecting what is underneath. Right-click the fold for a
  background slider (default about 88% paper; older folds use that too). Anything created inside it
  belongs to it. Dragging a member past the edge grows the frame instead of
  releasing the member. Drag the top grip to move the fold and its contents;
  drag the side edges, the bottom edge, or the bottom-right corner to set a
  minimum size. The chevron collapses it to a small note icon at the top-left.
  A drag-selection over that icon selects the fold. Click the icon to expand,
  drag it to move the collapsed fold. Deleting the fold deletes what is inside.
- Ribbon "Insert image": file dialog (filter: png/jpg/jpeg/gif/bmp/webp), multiple
  selection allowed. Images are inserted at the viewport center, cascading +24,+24
  for each additional image, at natural size capped to 60% of viewport.
- **Ctrl+V** with image data on the clipboard inserts it the same way (single
  image, at cursor position if over canvas). Clipboard files (copied image files)
  also work.
- Insertion embeds the bytes into the note's `media/` (converted to PNG only when
  the source format is not in the allowed set; otherwise original bytes kept).
- Resize via frame handles keeps aspect ratio; Alt+drag resizes freely.

---

## 3. Draw tools (ribbon "Draw")

Mouse-first vector drawing. Tools (left to right in the action bar, single-key
shortcut in brackets): **Select** [V], **Lasso** [S], **Pen** [P], **Marker** [H],
**Eraser** [E], then icon-only **Rectangle** [R], **Ellipse** [O], **Line** [L],
**Arrow** [A] (letters only switch tools when nothing is selected, no caret is
active and no type-to-create point is pending; otherwise they are text), plus stroke width presets 1/2/4/8 (`[` / `]` step through them)
and pen colour: quick swatches (theme ink, red, blue, green, orange) + the full
palette/custom picker. Theme ink resolves to dark ink on light/Mix paper and light
ink on dark paper at the moment of drawing.
Colour and width changes restyle drawings that are selected. Changing the width
does not restyle the last stroke unless it is selected. The Last button applies
the current colour and width to the last stroke.
Tool keys only fire while no text field/window has focus; choosing a draw tool by
key opens the Draw ribbon. Choosing any Draw tool switches the canvas out of text
mode; Esc or choosing Select returns. Pen and marker colour/width and eraser
settings persist app-wide.

- **Pen**: freehand. Sub-pixel jitter (< 1.2 screen px) is dropped while drawing,
  a light 1-2-1 smoothing pass is applied on release, and rendering uses
  quadratic curves through segment midpoints. A click without movement leaves a
  round dot. One mouse-down→up = one `drawing` object. **Shift** while dragging
  draws a straight segment from the start point (snaps exactly to 0/45/90° when
  within 8°).
  A selected stroke or shape shows its real bounds and a grip above them; drag the
  ink or the grip to move it. A marquee shows that same frame on every hit, and
  dragging one selected drawing moves the whole selection.
  **Hold the right mouse button** in Pen, Marker, or a shape tool (rectangle,
  ellipse, line, arrow) to erase temporarily
  (current eraser mode/size); releasing returns to the tool. The stylus side
  button lassos with any tool (same selection as the Lasso tool). The eraser end
  erases with any tool. (Right-drag still pans with the other tools.)
  **Pen input** (Settings → Drawing & pen, on by default) follows a Windows Ink
  stylus (`pointerType` `"pen"`). The pen is not pointer-captured: capture freezes
  the coordinates after the first mark. Samples come from `pointermove` and
  `pointerrawupdate`. A pen `pointerup` does not finish the stroke: Windows often
  continues it as mouse input, and the stroke commits only after that stream lifts
  (or after a short wait if nothing continues). Coalesced
  samples are smoothed lightly and points closer than about 0.5 canvas px are dropped.
  Pressure (0..1, one value per point) is stored only for the pen, and that stroke
  is painted as a filled outline (thinning about 0.5, round caps, a short taper).
  Mouse, touch, and marker strokes keep the centreline. Turning pen input off
  treats the pen as a mouse. "Pen draws while Select is on" lets a pen press draw
  with the last pen or marker without changing the tool. "Ignore touch while using
  the pen" drops touch pointer-downs while the pen is down, hovering, or was used
  in the last 500 ms, so a palm does not draw, select, or pan. Wheel and
  precision-touchpad scrolling stay.
- **Marker** (highlighter): like the pen (smoothing, Shift = straight), but wide
  (S/M/L = 8/14/22 DIP, `[` `]` step) with flat ends and its own pastel colours
  (yellow, green, blue, pink, orange). Stored as a stroke with `highlighter: true`
  and painted with multiply blending on light/Mix paper, in PDF Preview and in the
  PDF. The stroke also uses the ink strength as its opacity, so writing and objects
  stay visible when blending does not apply. Dark theme skips multiply and keeps
  that opacity. A click without movement draws nothing. Erasable like any stroke.
- **Lasso**: drag a freeform loop; on release, drawings with ≥ 70 % of their
  outline inside the loop and text windows/images whose centre is inside are
  selected. Lasso stays the tool: the move bar above the selection can be dragged,
  and Delete, restyle, and Ctrl+C work on the catch.
  An empty catch keeps the Lasso tool.
- **Eraser**: shows a ring of the eraser size (S/M/L = 6/12/24 screen px radius,
  independent of zoom). Two modes, toggled in the action bar or with Shift+E:
  - **Area** (default): removes only what lies under the ring; strokes are split
    into pieces. Unfilled shapes and plain lines are converted to strokes when
    cut; arrows with heads and filled shapes are removed whole.
  - **Shape**: removes every whole stroke/shape/arrow the ring touches, hit-tested
    against the actual line (not its bounding box).
  One eraser gesture (down→up) is one undo entry.
- **Shapes**: drag from corner to corner; Shift constrains to square/circle, and
  lines/arrows to 45° steps.
- **Arrow**: drag from tail to head, creating a straight arrow whose two bezier
  control points `c1`,`c2` are initialized on the straight line at 1/3 and 2/3.
  While the arrow is selected, the control points render as small circles and are
  **draggable to curve the arrow** — this is the "nice and easy curve points"
  feature. Tail/head endpoints are also draggable. Head/tail style toggles live in
  the tool's action bar.
- Draw objects participate in normal selection/move/z-order once the Select tool is
  active.

---

## 4. Undo / Redo

- **Ctrl+Z** undo, **Ctrl+Y** (and Ctrl+Shift+Z) redo. The mouse thumb buttons do the
  same while a note is open: the lower button undoes, the upper button redoes.
  Per-note history, unlimited
  depth within the session, cleared when the note is closed.
- The history stores **inverse operations** (command pattern), not full snapshots.
- Undo granularity (one entry each): a burst of typing in one paragraph broken by
  a 2 s pause, caret move, or any non-typing command; one object move/resize
  (mouse-down→up); one style application; one insert/delete of object, image,
  block, table row/column; one pen stroke; one arrow control-point drag.
- Undo of a canvas operation scrolls the viewport to show the affected object if it
  is off-screen.
- Saving does NOT clear or split history.

---

## 5. Note header (above the canvas)

- Title (rendered as editable single-line field, dim "Untitled" placeholder when
  empty) + creation date underneath (read-only, from `meta.created`, local format).
- **"Add today"** button — appears only while the title is empty; inserts
  `yyyy-mm-dd` per [`file-formats.md`](file-formats.md) §3.
- Renaming here = renaming the file (same rules and separator-reference updates as
  quick-rename in the sidebar).

---

## 6. Keyboard shortcut summary (editor scope)

Ctrl+S save · Ctrl+Z/Y undo/redo · Ctrl+B/I/U styles · Ctrl+X/C/V clipboard ·
Ctrl+A select all in window · Ctrl+F search in note (see
[`search.md`](search.md)) · Ctrl+J chat pane beside the note,
Ctrl+K quick question (see [`brief.md`](brief.md)) · Ctrl+wheel zoom · Ctrl+0 reset zoom (or click the
zoom % chip in the canvas corner) · V/S/P/H/E/R/O/L/A draw tools · `[` `]` stroke
width · Shift+E eraser mode · Shift while drawing = straight · hold right mouse in
Pen/Marker = erase · mouse thumb buttons: lower = undo, upper = redo ·
Esc: exit draw tool → clear selection → (nothing).
Finishing a rectangle, ellipse, line, or arrow leaves its handles up so it can be
adjusted; the next press that is not on a handle or the move grip clears them and
starts the next shape.

The canvas background (blank / dots / lines / grid, chosen per note in View →
Paper) moves and scales with pan and zoom like real paper; it is hidden when its
spacing drops below 6 screen px.

Inserted images, and tables inserted with no text window focused, are placed at
the viewport centre.
