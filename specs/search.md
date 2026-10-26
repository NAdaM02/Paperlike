# Spec: Search

Two scopes: **in-note** (Ctrl+F) and **global** (Ctrl+Shift+F). Text only —
drawings and image pixels are not searched (no OCR in v1).

---

## 1. In-note search (Ctrl+F)

- Small overlay bar at the top-right of the editor: text field, match counter
  ("3 / 12", red "0 / 0" when nothing matches), prev/next buttons (Shift+Enter /
  Enter, also F3 / Shift+F3; both wrap around), close (Esc).
- Searches the text of all text windows and table cells of the open note (rendered
  math is skipped), live while typing. Matches never span two paragraphs or cells.
  Order is reading order: windows top-to-bottom, then left-to-right.
- Every match is highlighted in place on the canvas; the current match gets a
  stronger (orange) highlight. Typing jumps to the first match and Enter/Shift+Enter
  move on; when the current match is off-screen (or near the edge) the canvas pans
  — zoom unchanged — to centre it. Edits while the bar is open keep the highlights
  in sync without moving the view. Text windows containing a match also get a soft
  outline so they stand out when zoomed out. Not active in PDF Preview.
- Substring matching, case-insensitive, no regex in v1.

## 2. Global search (Ctrl+Shift+F, works from Home and Notebook view)

- Modal palette (Ctrl+Shift+F): text field on top, streaming result list below.
- **Scope**: all notebooks and standalone notes currently added to Home (including
  inside groups). Not a whole-disk search — that's what Detect is for.
- Result row: note title · notebook name · snippet with the match bolded (±40
  chars). Grouped by notebook, best-match-first within a group (rank = match count,
  then title match > body match).
- Enter / click opens the note and immediately runs an in-note search for the same
  query, jumped to the first match.
- Matching: case-insensitive substring on note **titles** and **body text**;
  multiple space-separated terms = AND.

## 3. Index cache

Global search must feel instant without re-reading every `.note` each keystroke.

- Cache location: `%APPDATA%\Paperlike\index\` — one JSON per notebook
  (`<sha256-of-path, 16 hex chars>.json`) mapping note filename → { `mtime`, `title`, `text` }
  where `text` is the concatenated plain text extracted at index time.
- On opening the global search palette: for each Home item, compare directory
  listing + file `mtime`s against the cache; re-extract only stale/new files
  (background threads, results stream into the open palette).
- Cache entries for removed notes/notebooks are pruned during this pass.
- The cache is disposable — deleting `index\` only costs a slower first search.
