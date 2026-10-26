# Spec: File Formats

Authoritative definition of everything Paperlike writes to user-visible disk
locations. App-internal state (config, caches) is covered in
[`app-state.md`](app-state.md).

Decisions already made by the project owner (do not revisit):

- Images are **embedded** in the `.note` file.
- The format may be user-inspectable; a readable container was chosen deliberately.
- Windows-only.

---

## 1. `.note` — the note file

### 1.1 Container

A `.note` file is a **ZIP archive** (like `.docx`). Rationale: embedded images stay
binary (no base64 bloat), the JSON manifest stays human-readable, and a curious user
can rename the file to `.zip` and look inside.

```
example.note (ZIP)
├── note.json          ← manifest: metadata + all canvas objects
└── media/
    ├── a3f9c2….png    ← embedded images, filename = SHA-256 hash (first 16 hex chars) + original extension
    └── 7bd014….jpg
```

Rules:

- ZIP compression: `deflate` for `note.json`, `store` (no recompression) for `media/*`.
- `media/` files are content-addressed. Inserting the same image twice creates one
  media entry referenced twice. On save, media entries referenced by zero objects are
  removed.
- Writers MUST produce `note.json` as UTF-8, pretty-printed with 2-space indent
  (human inspectability is a goal; file size is not a concern at note scale).

### 1.2 `note.json` schema

```jsonc
{
  "format": "paperlike-note",
  "version": 1,                     // integer; see §1.4 Versioning
  "meta": {
    "created": "2026-08-08T17:44:03Z",   // ISO 8601 UTC; set once at creation, never changed
    "modified": "2026-08-08T18:02:11Z",  // updated on every save
    "app_version": "0.1.0"               // app that last saved; diagnostic only
  },
  "canvas": {
    "objects": [ /* array of Object, see §1.3 */ ],
    "paper": "blank" | "dots" | "lines" | "grid"   // optional editor background; omitted = "dots"
  }
}
```

- `paper` only affects the editor background (it follows pan/zoom); it is never
  exported or printed.

- The note's **title is the filename** (without `.note`), not a field in the JSON.
  See §3 Naming.
- The note's displayed "creation date" is `meta.created` (fallback: filesystem
  creation time if the field is missing/corrupt).

### 1.3 Canvas objects

Canvas coordinate system: origin at top-left of the canvas, `x` grows right, `y`
grows down, unit = **device-independent pixel (DIP, 1/96 inch)**. Coordinates are
numbers (float allowed). Negative coordinates are legal (infinite canvas grows in
all directions).

Every object has:

```jsonc
{
  "id": "t_8f3a1b2c",     // unique within the note: 1-char type prefix + "_" + 8 hex chars
  "type": "text" | "image" | "drawing" | "group" | "pdf",
  "x": 0, "y": 0,          // top-left of the object's bounding box
  "z": 3                    // integer z-order, higher = on top; unique per note
}
```

#### 1.3.1 `text` — text window

```jsonc
{
  "id": "t_…", "type": "text", "x": 120, "y": 80, "z": 1,
  "width": 340,            // user-set width; height is derived from content (auto-grow down)
  "blocks": [ /* Block[] */ ]
}
```

A **Block** is one of:

**Paragraph**

```jsonc
{
  "kind": "p",
  "indent": 0,             // 0-8; indentation level
  "bullet": null | "disc" | "circle" | "square" | "dash" | "arrow",
  "align": "left" | "center" | "right",   // default "left"
  "runs": [ /* Run[] */ ]
}
```

**Table**

```jsonc
{
  "kind": "table",
  "col_widths": [120, 200, 90],          // DIP; length defines column count
  "rows": [
    { "cells": [ { "blocks": [ /* paragraphs only, no nested tables */ ] }, … ] }
  ],
  "borders": true                          // false = invisible borders
}
```

**Run** — a span of uniformly styled text:

```jsonc
{
  "text": "Hello",
  // All style fields optional; omitted = inherited default (see §1.3.4)
  "b": true,  "i": true,  "u": true,  "s": true,       // bold, italic, underline, strikethrough
  "sub": true, "sup": true,                              // mutually exclusive
  "font": "Segoe UI", "size": 12,                       // size in pt
  "color": "#RRGGBB", "hl": "#RRGGBB"                   // font color, highlight
}
```

#### 1.3.2 `image`

```jsonc
{
  "id": "i_…", "type": "image", "x": 0, "y": 0, "z": 2,
  "media": "media/a3f9c2d4e5b60718.png",   // path inside the ZIP
  "width": 300, "height": 200               // display size (DIP); aspect free but UI defaults to locked ratio
}
```

#### 1.3.3 `drawing`

One drawing object = one logical group of vector items (a single pen stroke, one
shape, or one arrow). `x`/`y` is the bounding-box top-left; item coordinates are
**relative to it**.

```jsonc
{
  "id": "d_…", "type": "drawing", "x": 0, "y": 0, "z": 4,
  "item": /* one of: */

  // Freehand stroke: cubic-bezier smoothed polyline
  { "kind": "stroke", "points": [[0,0],[3.5,4],[9,7.2], …],   // raw input points
    "width": 2, "color": "#RRGGBB",
    "highlighter": true }   // optional, omitted = false: marker ink, painted with
                            // multiply blending (canvas on light/Mix paper, PDF preview, PDF export)

  // Shape
  | { "kind": "shape", "shape": "rect" | "ellipse" | "line" | "triangle" | "diamond",
      "w": 120, "h": 80, "width": 2, "color": "#RRGGBB",
      "fill": null | "#RRGGBB" }

  // Arrow: cubic bezier from tail to head with 2 draggable control points
  | { "kind": "arrow",
      "tail": [0,40], "head": [160,0],
      "c1": [50,40], "c2": [110,0],                 // control points
      "width": 2, "color": "#RRGGBB",
      "head_style": "arrow" | "triangle" | "none",
      "tail_style": "none" | "arrow" | "triangle" }
}
```

A stroke may also carry `"pressure": [0.25, 0.9, …]`: one value in `0..1` for each
point. It is omitted when empty, so older notes and mouse, touch, and marker
strokes are unchanged. The note `version` is not bumped. A pen stroke that has
pressure is filled as an outline; every other stroke stays a centreline.

#### 1.3.4 `group` — collapsible note

A fold owns other objects by id; those objects keep ordinary
absolute coordinates and are drawn above everything that is not in a fold.
`fill` (0–1, omitted by default) is how solid the paper wash behind the members
is. The editor uses about 0.88 when it is omitted. Content created inside the frame joins `children` and stays a member (the frame
grows to wrap it). Collapsing hides the members and leaves a small note icon at
`x`,`y`. Deleting the fold deletes its members.

```jsonc
{
  "id": "g_…", "type": "group", "x": 40, "y": 40, "z": 5,
  "width": 340,
  "min_height": 96,          // optional floor; omitted when unset
  "collapsed": true,         // omitted when false
  "fill": 0.88,              // optional paper wash, 0–1; omitted uses the default
  "children": ["t_…", "d_…"] // omitted when empty
}
```

#### 1.3.5 `pdf` — joined pages, rendered from the file

The original PDF is stored under `media` (not pre-rasterised). `pages` is the
1-based set still joined together, in reading order. `aspects[i]` is
height/width of `pages[i]`. `layout` is `stack` (top to bottom), `row` (one
horizontal row), `pair-odd` (two columns, odd on the left) or `pair-even`
(first page on the right). Every page is `pageWidth` DIP wide. The editor
paints each page from the PDF at the current size, and draws `n / total` in the
bottom-right from that page's place in `pages` (not stored).

```jsonc
{
  "id": "p_…", "type": "pdf", "x": 80, "y": 80, "z": 4,
  "media": "media/ab12….pdf",
  "pages": [1, 2, 3],
  "aspects": [1.294, 1.294, 0.75],
  "layout": "stack",
  "pageWidth": 460,
  "gap": 14
}
```

#### 1.3.6 Style defaults

Defaults when a Run omits a field: `font` = "Segoe UI", `size` = 11 pt, `color` =
theme text color (stored as the literal string `"auto"` internally → resolves to
black in bright theme / white in dark theme; **exports resolve `auto` to black**),
all booleans false, `hl` none. A run with explicit `color` keeps that exact color in
both themes and in exports.

### 1.4 Versioning & robustness

- `version` is a single integer. An app reading a **newer** major version than it
  knows MUST open read-only with a warning, never rewrite.
- Readers MUST ignore unknown JSON fields and preserve them on save. Unknown
  object types are kept too and written back; they are not shown. A note whose
  `version` is newer than this build opens with a read-only notice and is never
  rewritten.
- A `.note` that fails to parse: show error, offer "Open backup" (see
  `app-state.md` §Data safety), never overwrite the corrupt file silently.

---

## 2. `notebook` — folder + `.notebook_data`

A folder **is a notebook** iff it directly contains a file named `.notebook_data`.
Notes are all `*.note` files directly in that folder (no recursion; subfolders are
independent and may themselves be notebooks).

Files in a notebook folder that are neither `*.note` nor `.notebook_data` are
**silently ignored** by Paperlike (never shown, never touched, never deleted).

### 2.1 `.notebook_data` schema (plain JSON, UTF-8, pretty-printed)

```jsonc
{
  "format": "paperlike-notebook",
  "version": 1,
  "description": "Aerospace lecture notes",     // optional; shown on Home hover
  "cover": {                                      // optional
    "png_base64": "…",        // cover image, re-encoded to PNG, max 512×512 (fit, keep ratio)
    "hash": "a3f9c2d4e5b60718" // SHA-256 (first 16 hex) of the PNG bytes; used as .ico cache key
  },
  "separators": {                                 // optional; see §2.3
    "name":         [ { "after": "10-17" } ],
    "name_desc":    [],
    "created":      [ { "after": "10-21" } ],
    "created_desc": []
  }
}
```

The notebook's **name is the folder name**. "Change name" on Home renames the
folder.

### 2.2 Cover image → folder icon

When the cover changes:

1. Re-encode the picked image to PNG, max 512×512, store in `.notebook_data`.
2. Generate a Windows `.ico` (sizes 16/32/48/256) and write it to the app icon cache
   (`app-state.md` §Layout) named `<hash>.ico`.
3. Apply it to the folder: write/update `desktop.ini` in the notebook folder:

   ```ini
   [.ShellClassInfo]
   IconResource=C:\Users\…\AppData\Roaming\Paperlike\icons\<hash>.ico,0
   ```

   then set the `desktop.ini` file attributes to *hidden + system*, and set the
   folder's *read-only* attribute (required by Explorer to honor desktop.ini).
4. Removing the cover deletes `desktop.ini` (only if it was Paperlike-written — check
   that IconResource points into the Paperlike icon cache) and clears the folder
   attribute.

`.notebook_data` itself SHOULD be written with the *hidden* file attribute.

### 2.3 Separators

Small horizontal separator lines between notes in the note-list sidebar
(Firefox-bookmark style). Rules:

- Managed **independently per sort mode** — the four keys under `separators` map to
  the four sort modes (`name`, `name_desc`, `created`, `created_desc`).
- Each entry: `{ "after": "<note title>" }` — the separator renders directly below
  that note *in that sort mode*.
- If the referenced note no longer exists (deleted/renamed externally), the entry is
  dropped on next save of `.notebook_data`.
- On note rename **inside the app**, all `after` references to it are updated in the
  same save.
- UI for adding/removing is specified in [`ui-flows.md`](ui-flows.md).

---

## 3. Note naming rules

The note title **is** the filename minus `.note`. Consequences:

- **Allowed characters**: anything Windows allows. On rename/creation, strip the
  forbidden characters `< > : " / \ | ? *` and trailing dots/spaces; if the user
  typed any, show the cleaned result inline (no error dialog).
- **Empty name**: new notes start with an *empty title*. Since a file needs a name,
  the file on disk is `Untitled.note`, `Untitled 2.note`, … but the UI renders the
  title as empty (placeholder text "Untitled" in dim style) until the user names it.
  A note is "empty-named" iff its filename matches `^Untitled( \d+)?$`.
- **Duplicates**: renaming to an existing title in the same notebook appends
  ` (2)`, ` (3)`, … (first free suffix).
- **"Add today" button**: prefixes the title with `yyyy-mm-dd` (local date). If the
  title was empty, the result is exactly `yyyy-mm-dd`; otherwise `yyyy-mm-dd <old>`.
  The button is visible only while the title is empty.
- **Reserved names**: after cleaning, if the base name is a Windows reserved device
  name (`CON`, `PRN`, `AUX`, `NUL`, `COM1-9`, `LPT1-9`), prefix `_`.
- Max title length: 120 characters (keeps full paths safely under Windows limits).

---

## 4. Standalone notes

A `.note` file outside any notebook folder is a **standalone note**. It is a
first-class citizen: it can be added to Home and opened (view behavior in
[`ui-flows.md`](ui-flows.md) §Standalone). It has no `.notebook_data`, therefore no
cover, description, or separators; Home renders it with a generic note glyph and its
title.
