//! `.note` ZIP container — specs/file-formats.md §1

use std::collections::{HashMap, HashSet};
use std::io::{Cursor, Read, Write};
use std::path::Path;

use anyhow::{bail, Context, Result};
use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::atomic;

pub const APP_VERSION: &str = "1.3.8";
pub const NOTE_FORMAT: &str = "paperlike-note";
/// Newest `version` this build understands; newer notes open read-only.
pub const NOTE_VERSION: u32 = 1;

pub type Extra = serde_json::Map<String, serde_json::Value>;

/** RFC3339 with millisecond precision — JS Date.parse is unreliable on ns fractions. */
pub fn ts_rfc3339(dt: DateTime<Utc>) -> String {
    dt.to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteDocument {
    pub format: String,
    pub version: u32,
    pub meta: NoteMeta,
    pub canvas: Canvas,
    /// Fields this version does not know, kept so a save writes them back.
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteMeta {
    pub created: DateTime<Utc>,
    pub modified: DateTime<Utc>,
    pub app_version: String,
    /// Fields this version does not know, kept so a save writes them back.
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(from = "CanvasJson", into = "CanvasJson")]
pub struct Canvas {
    pub objects: Vec<CanvasObject>,
    /// Editor background: "blank" | "dots" | "lines" | "grid". None = dots. Not exported.
    pub paper: Option<String>,
    /// Objects this version cannot read (a newer kind, say), written back unchanged.
    pub unknown_objects: Vec<serde_json::Value>,
    pub extra: Extra,
}

#[derive(Serialize, Deserialize)]
struct CanvasJson {
    objects: Vec<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    paper: Option<String>,
    #[serde(flatten)]
    extra: Extra,
}

impl From<CanvasJson> for Canvas {
    fn from(raw: CanvasJson) -> Self {
        let mut objects = Vec::with_capacity(raw.objects.len());
        let mut unknown_objects = Vec::new();
        for value in raw.objects {
            match serde_json::from_value::<CanvasObject>(value.clone()) {
                Ok(obj) => objects.push(obj),
                Err(_) => unknown_objects.push(value),
            }
        }
        Canvas { objects, paper: raw.paper, unknown_objects, extra: raw.extra }
    }
}

impl From<Canvas> for CanvasJson {
    fn from(canvas: Canvas) -> Self {
        let mut objects: Vec<serde_json::Value> = canvas
            .objects
            .iter()
            .filter_map(|o| serde_json::to_value(o).ok())
            .collect();
        objects.extend(canvas.unknown_objects);
        CanvasJson { objects, paper: canvas.paper, extra: canvas.extra }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum CanvasObject {
    Text(TextObject),
    Image(ImageObject),
    Drawing(DrawingObject),
    Group(GroupObject),
    Pdf(PdfObject),
}

impl CanvasObject {
    pub fn id(&self) -> &str {
        match self {
            CanvasObject::Text(o) => &o.id,
            CanvasObject::Image(o) => &o.id,
            CanvasObject::Drawing(o) => &o.id,
            CanvasObject::Group(o) => &o.id,
            CanvasObject::Pdf(o) => &o.id,
        }
    }

    pub fn z(&self) -> i32 {
        match self {
            CanvasObject::Text(o) => o.z,
            CanvasObject::Image(o) => o.z,
            CanvasObject::Drawing(o) => o.z,
            CanvasObject::Group(o) => o.z,
            CanvasObject::Pdf(o) => o.z,
        }
    }

    pub fn bbox(&self) -> (f64, f64, f64, f64) {
        match self {
            CanvasObject::Text(o) => (o.x, o.y, o.width, 80.0),
            CanvasObject::Image(o) => (o.x, o.y, o.width, o.height),
            CanvasObject::Drawing(o) => o.item.bbox_abs(o.x, o.y),
            CanvasObject::Group(o) => (o.x, o.y, o.width, o.min_height.unwrap_or(64.0)),
            CanvasObject::Pdf(o) => {
                let (w, h) = o.size();
                (o.x, o.y, w, h)
            }
        }
    }
}

/// A collapsible note on the canvas. Members are other objects (absolute coordinates)
/// listed in `children`. `fill` is the paper wash behind them, 0–1; omitted uses the default.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroupObject {
    pub id: String,
    pub x: f64,
    pub y: f64,
    pub z: i32,
    pub width: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_height: Option<f64>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub collapsed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fill: Option<f64>,
    /// Always written. An omitted list crashes the canvas, which treats it as missing.
    #[serde(default)]
    pub children: Vec<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub locked: bool,
    /// Fields this version does not know, kept so a save writes them back.
    #[serde(flatten)]
    pub extra: Extra,
}

/// A joined PDF. The original file lives in `media`; pages are rendered live.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfObject {
    pub id: String,
    pub x: f64,
    pub y: f64,
    pub z: i32,
    pub media: String,
    pub pages: Vec<u32>,
    pub aspects: Vec<f64>,
    pub layout: String,
    pub page_width: f64,
    #[serde(default = "default_pdf_gap")]
    pub gap: f64,
    #[serde(default, skip_serializing_if = "is_false")]
    pub locked: bool,
    /// Cover-up rectangles (printed page numbers). Fractions 0-1 of the page width/height.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub masks: Vec<PdfMask>,
    /// Hide the on-page index. Printed numbers stay covered by `masks` when we found them.
    #[serde(default, skip_serializing_if = "is_false")]
    pub hide_numbers: bool,
    /// Fields this version does not know, kept so a save writes them back.
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PdfMask {
    pub page: u32,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub color: String,
}

fn default_pdf_gap() -> f64 {
    14.0
}

#[derive(Debug, Clone, Copy)]
pub struct PdfSlot {
    pub page: u32,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl PdfObject {
    /// Same placement as the editor (`pdfSlots` in the frontend).
    pub fn slots(&self) -> Vec<PdfSlot> {
        let gap = if self.gap.is_finite() { self.gap } else { 14.0 };
        let page_width = self.page_width.max(1.0);
        let aspect_of = |i: usize| self.aspects.get(i).copied().filter(|a| *a > 0.0).unwrap_or(1.294);
        let cells: Vec<(u32, f64, i32, i32)> = self
            .pages
            .iter()
            .enumerate()
            .map(|(i, &page)| {
                let aspect = aspect_of(i);
                let (col, row) = match self.layout.as_str() {
                    "row" => (i as i32, 0),
                    "pair-odd" => ((i % 2) as i32, (i / 2) as i32),
                    "pair-even" => {
                        let idx = i + 1;
                        ((idx % 2) as i32, (idx / 2) as i32)
                    }
                    _ => (0, i as i32),
                };
                (page, aspect, col, row)
            })
            .collect();
        let mut rows: Vec<i32> = cells.iter().map(|c| c.3).collect();
        rows.sort_unstable();
        rows.dedup();
        let mut row_h: std::collections::HashMap<i32, f64> = std::collections::HashMap::new();
        for (_, aspect, _, row) in &cells {
            let h = page_width * aspect;
            row_h.entry(*row).and_modify(|m| *m = m.max(h)).or_insert(h);
        }
        let mut row_y = std::collections::HashMap::new();
        let mut y = 0.0;
        for row in rows {
            row_y.insert(row, y);
            y += row_h.get(&row).copied().unwrap_or(0.0) + gap;
        }
        cells
            .into_iter()
            .map(|(page, aspect, col, row)| PdfSlot {
                page,
                x: col as f64 * (page_width + gap),
                y: row_y.get(&row).copied().unwrap_or(0.0),
                w: page_width,
                h: page_width * aspect,
            })
            .collect()
    }

    pub fn size(&self) -> (f64, f64) {
        let slots = self.slots();
        if slots.is_empty() {
            return (self.page_width.max(1.0), self.page_width.max(1.0) * 1.294);
        }
        let w = slots.iter().map(|s| s.x + s.w).fold(0.0, f64::max);
        let h = slots.iter().map(|s| s.y + s.h).fold(0.0, f64::max);
        (w.max(1.0), h.max(1.0))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TextObject {
    pub id: String,
    pub x: f64,
    pub y: f64,
    pub z: i32,
    pub width: f64,
    /// Optional minimum height in DIP; content may still grow taller.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_height: Option<f64>,
    pub blocks: Vec<Block>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub locked: bool,
    /// Fields this version does not know, kept so a save writes them back.
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Block {
    P(Paragraph),
    Table(TableBlock),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Paragraph {
    #[serde(default)]
    pub indent: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bullet: Option<String>,
    #[serde(default = "default_align")]
    pub align: String,
    pub runs: Vec<Run>,
    /// Fields this version does not know, kept so a save writes them back.
    #[serde(flatten)]
    pub extra: Extra,
}

fn default_align() -> String {
    "left".into()
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Run {
    pub text: String,
    #[serde(default, skip_serializing_if = "is_false", rename = "b")]
    pub bold: bool,
    #[serde(default, skip_serializing_if = "is_false", rename = "i")]
    pub italic: bool,
    #[serde(default, skip_serializing_if = "is_false", rename = "u")]
    pub underline: bool,
    #[serde(default, skip_serializing_if = "is_false", rename = "s")]
    pub strike: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub sub: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub sup: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hl: Option<String>,
    /// When true, `text` is LaTeX source rendered as inline math.
    #[serde(default, skip_serializing_if = "is_false")]
    pub math: bool,
    /// Fields this version does not know, kept so a save writes them back.
    #[serde(flatten)]
    pub extra: Extra,
}

fn is_false(b: &bool) -> bool {
    !*b
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableBlock {
    pub col_widths: Vec<f64>,
    pub rows: Vec<TableRow>,
    #[serde(default = "default_true")]
    pub borders: bool,
    /// Fields this version does not know, kept so a save writes them back.
    #[serde(flatten)]
    pub extra: Extra,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableRow {
    pub cells: Vec<TableCell>,
    /// Fields this version does not know, kept so a save writes them back.
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableCell {
    pub blocks: Vec<Paragraph>,
    /// Fields this version does not know, kept so a save writes them back.
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageObject {
    pub id: String,
    pub x: f64,
    pub y: f64,
    pub z: i32,
    pub media: String,
    pub width: f64,
    pub height: f64,
    #[serde(default, skip_serializing_if = "is_false")]
    pub locked: bool,
    /// Fields this version does not know, kept so a save writes them back.
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DrawingObject {
    pub id: String,
    pub x: f64,
    pub y: f64,
    pub z: i32,
    pub item: DrawingItem,
    #[serde(default, skip_serializing_if = "is_false")]
    pub locked: bool,
    /// Fields this version does not know, kept so a save writes them back.
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum DrawingItem {
    Stroke {
        points: Vec<[f64; 2]>,
        width: f64,
        color: String,
        /// Translucent marker ink: rendered with multiply blending, below other content.
        #[serde(default, skip_serializing_if = "is_false")]
        highlighter: bool,
        /// Marker strength, 0–1. Absent on older strokes; the editor treats that as a light marker.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        opacity: Option<f64>,
        /// Pen pressure in 0..=1, one value per point. Empty for mouse, touch, marker, and old notes.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        pressure: Vec<f64>,
        /// Extra marker runs, same coordinates as `points`. One object, one ink level.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        parts: Vec<Vec<[f64; 2]>>,
    },
    Shape {
        shape: String,
        w: f64,
        h: f64,
        width: f64,
        color: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        fill: Option<String>,
    },
    Arrow {
        tail: [f64; 2],
        head: [f64; 2],
        c1: [f64; 2],
        c2: [f64; 2],
        width: f64,
        color: String,
        #[serde(default = "default_arrow_head")]
        head_style: String,
        #[serde(default = "default_arrow_tail")]
        tail_style: String,
        /// "double" draws a pair of lines (an implication arrow). Omitted is a single line.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        body: Option<String>,
        /// Freehand shaft, relative to the drawing origin. Omitted arrows use the bezier.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        shaft: Vec<[f64; 2]>,
    },
}

fn default_arrow_head() -> String {
    "arrow".into()
}
fn default_arrow_tail() -> String {
    "none".into()
}

impl DrawingItem {
    /// Absolute canvas bbox matching the frontend `drawingBBox` (point extents + origin).
    fn bbox_abs(&self, ox: f64, oy: f64) -> (f64, f64, f64, f64) {
        match self {
            DrawingItem::Stroke { points, width, pressure, parts, .. } => {
                let mut min_x = f64::INFINITY;
                let mut min_y = f64::INFINITY;
                let mut max_x = f64::NEG_INFINITY;
                let mut max_y = f64::NEG_INFINITY;
                for p in points.iter().chain(parts.iter().flatten()) {
                    min_x = min_x.min(p[0]);
                    min_y = min_y.min(p[1]);
                    max_x = max_x.max(p[0]);
                    max_y = max_y.max(p[1]);
                }
                if !min_x.is_finite() {
                    return (ox, oy, 1.0, 1.0);
                }
                // Pad by stroke radius so page cuts don't slice through thick pressure ink.
                let mut max_p = 0.5_f64;
                for p in pressure {
                    if *p > max_p {
                        max_p = *p;
                    }
                }
                let pad = if pressure.is_empty() {
                    width * 0.5
                } else {
                    width * (0.5 + max_p.clamp(0.0, 1.0)) * 0.5
                };
                (
                    ox + min_x - pad,
                    oy + min_y - pad,
                    (max_x - min_x + 2.0 * pad).max(1.0),
                    (max_y - min_y + 2.0 * pad).max(1.0),
                )
            }
            DrawingItem::Shape { w, h, .. } => (ox, oy, (*w).max(1.0), (*h).max(1.0)),
            DrawingItem::Arrow { tail, head, c1, c2, shaft, .. } => {
                let mut xs = vec![tail[0], head[0], c1[0], c2[0]];
                let mut ys = vec![tail[1], head[1], c1[1], c2[1]];
                for p in shaft {
                    xs.push(p[0]);
                    ys.push(p[1]);
                }
                let min_x = xs.iter().cloned().fold(f64::INFINITY, f64::min);
                let max_x = xs.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
                let min_y = ys.iter().cloned().fold(f64::INFINITY, f64::min);
                let max_y = ys.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
                (
                    ox + min_x,
                    oy + min_y,
                    (max_x - min_x).max(1.0),
                    (max_y - min_y).max(1.0),
                )
            }
        }
    }
}

/// In-memory note with media bytes.
#[derive(Debug, Clone)]
pub struct NoteFile {
    pub doc: NoteDocument,
    pub media: HashMap<String, Vec<u8>>, // path -> bytes, e.g. "media/abc.png"
}

impl NoteFile {
    pub fn new_empty() -> Self {
        let now = Utc::now();
        Self {
            doc: NoteDocument {
                extra: Default::default(),
                format: NOTE_FORMAT.into(),
                version: 1,
                meta: NoteMeta {
                    extra: Default::default(),
                    created: now,
                    modified: now,
                    app_version: APP_VERSION.into(),
                },
                canvas: Canvas::default(),
            },
            media: HashMap::new(),
        }
    }

    pub fn plain_text(&self) -> String {
        let mut out = String::new();
        for obj in &self.doc.canvas.objects {
            if let CanvasObject::Text(t) = obj {
                for block in &t.blocks {
                    match block {
                        Block::P(p) => {
                            for r in &p.runs {
                                out.push_str(&r.text);
                            }
                            out.push('\n');
                        }
                        Block::Table(tb) => {
                            for row in &tb.rows {
                                for cell in &row.cells {
                                    for p in &cell.blocks {
                                        for r in &p.runs {
                                            out.push_str(&r.text);
                                        }
                                        out.push(' ');
                                    }
                                }
                                out.push('\n');
                            }
                        }
                    }
                }
            }
        }
        out
    }

    pub fn content_bbox(&self) -> Option<(f64, f64, f64, f64)> {
        let hidden = collapsed_child_ids(&self.doc.canvas.objects);
        let mut min_x = f64::INFINITY;
        let mut min_y = f64::INFINITY;
        let mut max_x = f64::NEG_INFINITY;
        let mut max_y = f64::NEG_INFINITY;
        for obj in &self.doc.canvas.objects {
            if hidden.contains(obj.id()) {
                continue;
            }
            // A collapsed fold is only its marker. Its members stay put on the canvas
            // but must not stretch the page as if the fold were open.
            let (x, y, w, h) = if let CanvasObject::Group(g) = obj {
                if g.collapsed {
                    (g.x, g.y, 28.0, 28.0)
                } else {
                    obj.bbox()
                }
            } else {
                obj.bbox()
            };
            min_x = min_x.min(x);
            min_y = min_y.min(y);
            max_x = max_x.max(x + w);
            max_y = max_y.max(y + h);
        }
        if min_x.is_finite() {
            Some((min_x, min_y, max_x - min_x, max_y - min_y))
        } else {
            None
        }
    }
}

/// Members of a collapsed fold. Preview and export treat the fold as its marker only.
pub fn collapsed_child_ids(objects: &[CanvasObject]) -> std::collections::HashSet<&str> {
    let mut hidden = std::collections::HashSet::new();
    for obj in objects {
        if let CanvasObject::Group(g) = obj {
            if g.collapsed {
                for id in &g.children {
                    hidden.insert(id.as_str());
                }
            }
        }
    }
    hidden
}

#[allow(dead_code)] // IDs for new objects are minted in the frontend.
pub fn new_id(prefix: char) -> String {
    let u = uuid::Uuid::new_v4();
    let hex = &u.simple().to_string()[..8];
    format!("{prefix}_{hex}")
}

pub fn media_hash_name(bytes: &[u8], ext: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let hash = hasher.finalize();
    let hex = crate::atomic::hex(&hash);
    format!("media/{}{}", &hex[..16], if ext.starts_with('.') { ext.to_string() } else { format!(".{ext}") })
}

pub fn load_note(path: &Path) -> Result<NoteFile> {
    let bytes = std::fs::read(path).with_context(|| format!("read {}", path.display()))?;
    // Zero-byte placeholders (e.g. renamed empty .txt → .note in Explorer) become
    // a real empty note so opening a notebook doesn't fail.
    if bytes.is_empty() {
        let mut note = NoteFile::new_empty();
        if let Ok(meta) = std::fs::metadata(path) {
            let stamp = meta
                .created()
                .or_else(|_| meta.modified())
                .ok()
                .map(|t| {
                    let dt: DateTime<Utc> = t.into();
                    dt
                });
            if let Some(dt) = stamp {
                note.doc.meta.created = dt;
                note.doc.meta.modified = dt;
            }
        }
        // Best-effort: leave a proper ZIP on disk so the next open is normal.
        let _ = save_note(path, &mut note);
        return Ok(note);
    }
    load_note_bytes(&bytes).with_context(|| format!("parse {}", path.display()))
}

pub fn load_note_bytes(bytes: &[u8]) -> Result<NoteFile> {
    let cursor = Cursor::new(bytes);
    let mut zip = ZipArchive::new(cursor).context("not a valid .note ZIP")?;
    let mut doc_json = String::new();
    let mut media = HashMap::new();

    if zip.len() > 4_000 {
        bail!("note has too many entries");
    }
    let mut total: u64 = 0;
    for i in 0..zip.len() {
        let mut file = zip.by_index(i)?;
        let name = file.name()?.to_string();
        total = total.saturating_add(file.size());
        if total > 400_000_000 {
            bail!("note is too large");
        }
        if name == "note.json" {
            file.read_to_string(&mut doc_json)?;
            if doc_json.len() > 32_000_000 {
                bail!("note.json is too large");
            }
        } else if name.starts_with("media/") && !name.ends_with('/') {
            if name.contains("..") || Path::new(&name).is_absolute() {
                bail!("invalid media path {name}");
            }
            if file.size() > 120_000_000 {
                bail!("media entry too large: {name}");
            }
            let mut buf = Vec::new();
            file.read_to_end(&mut buf)?;
            media.insert(name, buf);
        }
    }

    if doc_json.is_empty() {
        bail!("note.json missing");
    }

    let doc = parse_note_document(&doc_json)?;
    Ok(NoteFile { doc, media })
}

fn parse_note_document(doc_json: &str) -> Result<NoteDocument> {
    let doc: NoteDocument = serde_json::from_str(doc_json).context("invalid note.json")?;
    if doc.format != NOTE_FORMAT {
        bail!("unknown format {}", doc.format);
    }
    Ok(doc)
}

/// Read `note.json` from the ZIP without decompressing media blobs.
pub fn load_note_document(path: &Path) -> Result<NoteDocument> {
    let file = std::fs::File::open(path).with_context(|| format!("read {}", path.display()))?;
    let mut zip = ZipArchive::new(file).context("not a valid .note ZIP")?;
    let mut doc_json = String::new();
    {
        let mut entry = zip.by_name("note.json").context("note.json missing")?;
        entry.read_to_string(&mut doc_json)?;
    }
    parse_note_document(&doc_json).with_context(|| format!("parse {}", path.display()))
}

pub fn save_note(path: &Path, note: &mut NoteFile) -> Result<()> {
    if note.doc.version > NOTE_VERSION {
        bail!("this note was written by a newer Paperlike (version {}); it opens read-only", note.doc.version);
    }
    note.doc.meta.modified = Utc::now();
    note.doc.meta.app_version = APP_VERSION.into();
    note.doc.format = NOTE_FORMAT.into();

    // GC unused media
    let mut used = HashSet::new();
    for obj in &note.doc.canvas.objects {
        if let CanvasObject::Image(img) = obj {
            used.insert(img.media.clone());
        } else if let CanvasObject::Pdf(pdf) = obj {
            used.insert(pdf.media.clone());
        }
    }
    note.media.retain(|k, _| used.contains(k));

    let json = serde_json::to_string_pretty(&note.doc)?;
    let mut buf = Cursor::new(Vec::new());
    {
        let mut zip = ZipWriter::new(&mut buf);
        let json_opts = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        zip.start_file("note.json", json_opts)?;
        zip.write_all(json.as_bytes())?;

        let store_opts = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        let mut keys: Vec<_> = note.media.keys().cloned().collect();
        keys.sort();
        for k in keys {
            zip.start_file(&k, store_opts)?;
            zip.write_all(&note.media[&k])?;
        }
        zip.finish()?;
    }

    atomic::atomic_write(path, &buf.into_inner(), true)?;
    Ok(())
}

/// Rename media entries to content-addressed names and rewrite the object
/// references, so the same picture inserted twice is stored once.
pub fn normalize_media(note: &mut NoteFile) {
    let mut renames: HashMap<String, String> = HashMap::new();
    let mut next: HashMap<String, Vec<u8>> = HashMap::new();
    for (key, bytes) in note.media.drain() {
        let ext = Path::new(&key)
            .extension()
            .map(|e| e.to_string_lossy().to_string())
            .unwrap_or_else(|| "png".into());
        let hashed = media_hash_name(&bytes, &ext);
        if hashed != key {
            renames.insert(key, hashed.clone());
        }
        next.entry(hashed).or_insert(bytes);
    }
    note.media = next;

    if renames.is_empty() {
        return;
    }
    for obj in note.doc.canvas.objects.iter_mut() {
        let media = match obj {
            CanvasObject::Image(img) => &mut img.media,
            CanvasObject::Pdf(pdf) => &mut pdf.media,
            _ => continue,
        };
        if let Some(new_key) = renames.get(media) {
            *media = new_key.clone();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn empty_file_becomes_valid_note() {
        let dir = std::env::temp_dir().join(format!("ow_empty_note_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("from_txt.note");
        fs::write(&path, b"").unwrap();

        let note = load_note(&path).expect("empty .note should open");
        assert_eq!(note.doc.format, NOTE_FORMAT);
        assert!(note.doc.canvas.objects.is_empty());

        let on_disk = fs::read(&path).unwrap();
        assert!(!on_disk.is_empty(), "should materialize a ZIP on disk");
        let again = load_note_bytes(&on_disk).expect("materialized note must parse");
        assert_eq!(again.doc.format, NOTE_FORMAT);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn unknown_fields_and_objects_survive_round_trip() {
        let json = r##"{"format":"paperlike-note","version":1,"future":{"a":1},
            "meta":{"created":"2026-01-01T00:00:00Z","modified":"2026-01-01T00:00:00Z","app_version":"9","tz":"CET"},
            "canvas":{"layers":2,"objects":[
                {"type":"text","id":"t","x":0,"y":0,"z":1,"width":100,"tint":"red","blocks":[{"kind":"p","runs":[{"text":"hi","glow":true}],"spacing":3}]},
                {"type":"hologram","id":"h","x":5,"y":5,"z":2}
            ]}}"##;
        let doc: NoteDocument = serde_json::from_str(json).unwrap();
        assert_eq!(doc.canvas.objects.len(), 1);
        assert_eq!(doc.canvas.unknown_objects.len(), 1);
        let out: serde_json::Value = serde_json::to_value(&doc).unwrap();
        assert_eq!(out["future"]["a"], 1);
        assert_eq!(out["meta"]["tz"], "CET");
        assert_eq!(out["canvas"]["layers"], 2);
        let objs = out["canvas"]["objects"].as_array().unwrap();
        assert_eq!(objs[0]["tint"], "red");
        assert_eq!(objs[0]["blocks"][0]["spacing"], 3);
        assert_eq!(objs[0]["blocks"][0]["runs"][0]["glow"], true);
        assert_eq!(objs[1]["type"], "hologram");
        assert!(out.get("unknown_objects").is_none() && out["canvas"].get("unknown_objects").is_none());
    }

    #[test]
    fn newer_note_versions_are_never_rewritten() {
        let dir = std::env::temp_dir().join(format!("ow_newer_note_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("future.note");
        let mut note = NoteFile::new_empty();
        note.doc.version = NOTE_VERSION + 1;
        assert!(save_note(&path, &mut note).is_err());
        assert!(!path.exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn paper_and_highlighter_survive_round_trip_and_stay_optional() {
        let json = r##"{"objects":[{"type":"drawing","id":"d","x":0,"y":0,"z":1,"item":{"kind":"stroke","points":[[0,0],[9,0]],"width":14,"color":"#ffe066","highlighter":true}}],"paper":"grid"}"##;
        let c: Canvas = serde_json::from_str(json).unwrap();
        assert_eq!(c.paper.as_deref(), Some("grid"));
        let out = serde_json::to_string(&c).unwrap();
        assert!(out.contains(r#""paper":"grid""#) && out.contains(r#""highlighter":true"#));

        let plain: Canvas = serde_json::from_str(
            r##"{"objects":[{"type":"drawing","id":"d","x":0,"y":0,"z":1,"item":{"kind":"stroke","points":[[0,0]],"width":2,"color":"#000000"}}]}"##,
        )
        .unwrap();
        let out = serde_json::to_string(&plain).unwrap();
        assert!(
            !out.contains("paper") && !out.contains("highlighter") && !out.contains("pressure"),
            "defaults must not be written: {out}"
        );
    }

    #[test]
    fn stroke_pressure_round_trips_and_old_notes_omit_it() {
        let json = r##"{"objects":[{"type":"drawing","id":"d","x":1,"y":2,"z":1,"item":{"kind":"stroke","points":[[0,0],[4,1]],"width":2,"color":"#111111","pressure":[0.25,0.9]}}]}"##;
        let c: Canvas = serde_json::from_str(json).unwrap();
        let CanvasObject::Drawing(d) = &c.objects[0] else { panic!("drawing") };
        let DrawingItem::Stroke { points, pressure, highlighter, .. } = &d.item else { panic!("stroke") };
        assert_eq!(points.len(), pressure.len());
        assert!((pressure[0] - 0.25).abs() < 1e-9 && (pressure[1] - 0.9).abs() < 1e-9);
        assert!(!highlighter);
        let out = serde_json::to_string(&c).unwrap();
        assert!(out.contains("\"pressure\":[0.25,0.9]"), "{out}");
    }

    #[test]
    fn fold_round_trips_and_old_notes_still_load() {
        let json = r##"{"objects":[{"type":"group","id":"g","x":10,"y":20,"z":3,"width":300,"min_height":80,"children":["t"]},{"type":"text","id":"t","x":24,"y":40,"z":4,"width":200,"blocks":[{"kind":"p","runs":[{"text":"inside"}]}]}]}"##;
        let c: Canvas = serde_json::from_str(json).unwrap();
        match &c.objects[0] {
            CanvasObject::Group(g) => {
                assert_eq!(g.children, vec!["t".to_string()]);
                assert!(!g.collapsed);
                assert_eq!(g.min_height, Some(80.0));
            }
            _ => panic!("expected a fold"),
        }
        let out = serde_json::to_string(&c).unwrap();
        assert!(out.contains(r#""type":"group""#) && out.contains(r#""children":["t"]"#));
        assert!(!out.contains("collapsed"), "false collapsed must be omitted");
    }
}
