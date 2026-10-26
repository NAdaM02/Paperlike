# Spec: `.md` Format

Markdown export of a note. File extension: `<title>.md`.

This is the former `.md (AI)` syntax, now the only Markdown export. It is designed
so a reader (human or model) can reconstruct semantics and layout from the text,
and so Paperlike can round-trip the file back into a `.note` when the geometry
block is included.

Design decisions (owner-approved):

- **Hybrid**: the body carries *relational* layout descriptions (AIs reason poorly
  from raw coordinates); an optional trailing *geometry block* carries exact data so
  Paperlike can **round-trip** the file back into a `.note`.
- **Context frugality is a hard requirement.** Annotations are one short line per
  object; the geometry block is minified and skippable (a reader can stop at its
  fence line). The export dialog has a toggle **"Include geometry block
  (round-trip)"** — default **OFF**; turning it on produces a lossless round-trip
  file (may include image bytes as base64). Comprehension/summarization exports
  leave it off.

Legacy files named `<title>.ai.md` use the same syntax and should be accepted on
import.

---

## 1. File layout

```
<optional H1 title header (per export options)>

<!--pl:doc v=1 note="10-17" created=2026-08-08-->
<!--pl:palette c1="#c0392b:red" h1="#fff59d:yellow"-->

…body: annotated content in reading order…

<!--pl:geometry-->
```pl-geo
{minified JSON}
```
```

`pl:palette` is omitted when the note uses only default colors. Named tokens
(`red`, `yellow`, …) are nearest-neighbor matches to a small table; odd custom
hex stays hex and is **not** listed here.

Everything Paperlike-specific lives in HTML comments prefixed `pl:` — invisible in
rendered Markdown, cheap in tokens, and unambiguous to parse.

---

## 2. Body

Objects appear in **reading order** (row bands by y, then x). Each object is
preceded by exactly **one** annotation comment line.

### 2.1 Object annotation line

```
<!--pl:OBJ id=ID [label="…"] [role=R] [rel="…"] [size=S] [KEY=VAL…]-->
```

- `OBJ` ∈ `text` | `image` | `drawing` | `connector`.
- `id` — the object id from `note.json` (e.g. `t_8f3a1b2c`); links body ↔ geometry
  block. Machine key; always present.
- `label` — short human/AI handle: first line of a text window (plain, ≤40 chars),
  drawing `kind`, or omitted on images (filename is already the Markdown alt).
  Quoted. Parentheses in the source text are replaced so labels stay parseable.
- `rel` — **relational position description**. Grammar: a comma-separated list of
  clauses referencing *previously listed* object ids, each optionally followed by
  a parenthetical label (`below t_a1(Rocket equation)`). The id is the machine
  key; the parenthetical is documentation only.
  - Neighbors are chosen by **edge-to-edge gap**, preferring same-column (vertical)
    / same-row (horizontal) over diagonal. Text-window height is the **rendered**
    height, not a stub.
  - `below X` / `right-of X` / `left-of X` / `above X` — nearest neighbor
    (edge-to-edge gap < 300 DIP);
  - `overlaps X` when bounding boxes intersect (largest overlap area, not first);
  - `far-below X` / `far-right-of X` when the gap ≥ 300 DIP;
  - `top-left` for the first/anchor object of the note (no prior reference).
  The exporter emits **at most 2 clauses** per object: the strongest vertical and
  the strongest horizontal relation.
- `size` — coarse, relative to the note's median text-window width: `narrow`
  (<0.6×), `medium`, `wide` (>1.5×). Emitted for text windows only.
- `role` — omitted unless distinctive: `heading` (first paragraph's dominant run
  is bold and ≥1.3× the note's modal type size) or `code` (every run is
  monospace).

### 2.2 Text windows

Annotation line, then the window's content as Markdown. Styling that plain Markdown
can't express uses the **compact span syntax**:

- Standard Markdown for bold/italic/strike; `<u>`, `<sub>`, `<sup>`, `<mark>`.
- Font/size/color deviations from the note defaults wrap in
  `<span ow="k:v;k:v">…</span>` with keys: `f` font family, `s` size pt, `c` text
  color (named token from `pl:palette` when close, else hex), `h` highlight
  (same). Example: `<span ow="c:red;s:14">warning</span>`.
  Runs styled with defaults get **no** span (frugality).
- Bullet styles: `-` for disc (default); other glyph styles annotate the list once:
  `<!--pl:bullets dash-->` on the line before the list.
- Non-left paragraph alignment: `<!--pl:align center-->` (or `right`) on the line
  before that paragraph. Omitted for `left`.
- Tables: GitHub pipe tables; non-uniform column widths noted in the annotation
  (`cols=narrow,wide,narrow`) only when widths differ by >1.5×.

### 2.3 Images

```
<!--pl:image id=i_b2 rel="below t_a1(Rocket equation)"-->
![diagram.png](media ref: i_b2)
```

- The alt text is the original filename (v1). A future `ocr="…"` attribute on
  `pl:image` is **reserved** for local OCR of pasted screenshots/whiteboards —
  not for typed canvas text (already exact in the body) and not for ink/strokes.
  v1 does not emit `ocr=`.
- Pixels are NOT embedded in the body. With the geometry block ON, image bytes are
  carried there (§3) so round-trip is lossless. With it OFF, the reference is
  informational only.

### 2.4 Drawings & connectors

Decorative drawings get a one-liner; **arrows are connectors** with explicit
endpoints (resolved at export — not left for the reader to infer from geometry):

```
<!--pl:drawing id=d_c3 label="ellipse" rel="right-of t_a1(Rocket equation)" kind=ellipse color=blue encloses="t_a1(Rocket equation)"-->

<!--pl:connector id=d_c4 rel="overlaps t_a1(Rocket equation)" from=t_a1(Rocket equation) to=t_b2(Derivation) tail="480,90" head="520,200" color=green-->
```

- `pl:drawing` `kind` ∈ `stroke` | `highlight` (marker stroke) | `rect` | `ellipse` |
  `line` | `triangle` | `diamond` | `sketch` (decoration / freehand). `color=` is a
  palette token or hex.
- `encloses="id(label), …"` — emitted on shapes whose box contains ≥90% of a
  previously listed text or image box (circled/boxed annotations).
- `pl:connector` — directed arrows. Attributes:
  - `from` / `to` — nearest text or image id within **40 DIP** of the absolute
    tail / head (omitted if unresolved); labels in parentheses when known.
  - `tail` / `head` — absolute canvas coordinates `"x,y"` (already resolved; do
    not add the drawing object's own `x`/`y` again).
  - `color=` — palette token or hex.
- Exact local control points stay in the geometry block for round-trip.
- Adjacent strokes (bounding boxes within 24 DIP, same color) are grouped into
  a single body annotation `kind=sketch n=14`; the geometry block still lists them
  individually.

Empty text windows (no non-whitespace runs) emit
`<!--pl:text … empty=1-->` with no body, so parsers can skip placeholders.

### 2.5 Edge list (optional, when any connector resolved)

After the body, before the geometry block:

```
<!--pl:edges-->
t_a1 -> t_b2
t_b2 -> t_c3
```

One line per resolved `from -> to`. Cheap overview of the board's graph;
geometry remains authoritative for rendering.

---

## 3. Geometry block (round-trip payload)

At end of file:

````
<!--pl:geometry-->
```pl-geo
{"v":1,"defaults":{"font":"Segoe UI","size":11},"objects":[
 {"id":"t_a1","x":120,"y":80,"z":1,"w":340},
 {"id":"i_b2","x":100,"y":420,"z":2,"w":300,"h":200,"png":"<base64…>"},
 {"id":"d_c3","x":480,"y":90,"z":3,"item":{…exact drawing item JSON…}}
]}
```
````

- Minified JSON (this is machine-only; the pretty-printing rule of `note.json`
  does not apply).
- Per object only what the body cannot reconstruct: position, z, size, image
  bytes (base64), exact drawing item data (verbatim from `note.json` §1.3.3).
  Text content/styling is NOT duplicated here — on import it is parsed from the
  body (sizes and formatting are round-trippable from the span syntax by design).
- `meta.created` is recovered from the `pl:doc` header line.

## 4. Import (round-trip) rules

"Import .md" (File menu, notebook view); also accept legacy `.ai.md`:

1. A file with no `<!--pl:` marks is not a Paperlike export. Import it as one text
   window containing the whole document.
2. A file with `<!--pl:` marks but no `pl:doc` header is refused.
3. Parse body: each `pl:` annotation opens an object; Markdown/span syntax is
   converted back to blocks/runs (inverse of §2.2 mapping).
4. If the geometry block exists, merge exact x/y/z/w/h/vectors/image bytes by `id`.
   Grouped strokes are one `kind=sketch` line in the body and separate objects in
   the geometry block; import restores each stroke.
5. If it does not exist (or an id is missing from it): **fallback auto-layout** —
   place text and images in a single column in body order, starting at (48, 48),
   24 DIP vertical gap, text width 480, images at 300 wide. Image pixels exist
   only when the geometry block carried them. Drawings, including arrows, are
   dropped with a warning listing their ids.
6. The note is saved into the current notebook (or the open note's folder) and
   opened. The filename comes from `pl:doc note=`. If that name is taken, a
   numeric suffix is added.

## 5. Frugality summary (enforced by tests)

- ≤1 annotation line per object; ≤2 `rel` clauses; no span for default-styled runs;
  stroke grouping; geometry block last so readers can truncate. Target overhead for
  a typical text-dominant note: **<10%** of body tokens (excluding the geometry
  block).
