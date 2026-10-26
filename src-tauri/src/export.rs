//! Export to .md and .pdf — specs/export.md + md.md

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;

use anyhow::{Context, Result};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use printpdf::{
    BlendMode, BuiltinFont, Color, ExtendedGraphicsState, ExtendedGraphicsStateId, Line,
    LineCapStyle, LineJoinStyle, LinePoint, Mm, Op, PaintMode, PdfDocument, PdfFontHandle, PdfPage,
    PdfSaveOptions, Point, Polygon, PolygonRing, Pt, RawImage, RawImageData, RawImageFormat, Rgb,
    SeperableBlendMode, TextItem, WindingOrder, XObjectTransform,
};
use serde::Serialize;

use crate::atomic;
use crate::note::{Block, CanvasObject, DrawingItem, NoteFile, Paragraph, Run};

#[derive(Debug, Clone)]
pub struct ExportOptions {
    pub format: String, // pdf | md
    pub page_numbers: bool,
    pub title_header: Option<String>,
    pub export_date: bool,
    pub geometry_block: bool,
}

pub fn export_note(note: &NoteFile, title: &str, dest: &Path, opts: &ExportOptions) -> Result<()> {
    match opts.format.as_str() {
        "md" | "ai" | "md-ai" | "ai.md" => export_md(note, title, dest, opts),
        "pdf" => {
            export_pdf(&[(note, title, opts.title_header.as_deref())], dest, opts)
        }
        other => anyhow::bail!("unknown format {other}"),
    }
}

/// Export several notes into one destination file (sidebar / selection order).
pub fn export_notes_merged(
    notes: &[(NoteFile, String, Option<String>)],
    dest: &Path,
    opts: &ExportOptions,
) -> Result<()> {
    if notes.is_empty() {
        anyhow::bail!("no notes to export");
    }
    if notes.len() == 1 {
        let (n, t, h) = &notes[0];
        let mut single = opts.clone();
        single.title_header = h.clone();
        return export_note(n, t, dest, &single);
    }
    match opts.format.as_str() {
        "md" | "ai" | "md-ai" | "ai.md" => export_md_merged(notes, dest, opts),
        "pdf" => {
            let refs: Vec<(&NoteFile, &str, Option<&str>)> = notes
                .iter()
                .map(|(n, t, h)| (n, t.as_str(), h.as_deref().or(Some(t.as_str()))))
                .collect();
            export_pdf(&refs, dest, opts)
        }
        other => anyhow::bail!("unknown format {other}"),
    }
}

fn sort_by_reading_order<T>(items: &mut [T], bbox: impl Fn(&T) -> (f64, f64, f64, f64)) {
    items.sort_by(|a, b| {
        let (ax, ay, _, ah) = bbox(a);
        let (bx, by, _, bh) = bbox(b);
        let a_mid = ay + ah / 2.0;
        let b_mid = by + bh / 2.0;
        let overlap = (ay + ah).min(by + bh) - ay.max(by);
        let min_h = ah.min(bh);
        if min_h > 0.0 && overlap / min_h >= 0.5 {
            ax.partial_cmp(&bx).unwrap_or(std::cmp::Ordering::Equal)
        } else {
            a_mid
                .partial_cmp(&b_mid)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(ax.partial_cmp(&bx).unwrap_or(std::cmp::Ordering::Equal))
        }
    });
}

fn color_token(hex: &str, palette: &HashMap<String, &'static str>) -> String {
    let key = normalize_hex(hex).unwrap_or_else(|| hex.to_string());
    if let Some(name) = palette.get(&key) {
        (*name).to_string()
    } else {
        key
    }
}

fn runs_to_md(runs: &[Run], palette: &HashMap<String, &'static str>) -> String {
    let mut s = String::new();
    for r in runs {
        if r.math {
            s.push_str(&format!("${}$", r.text));
            continue;
        }
        let mut t = r.text.clone();
        if r.bold {
            t = format!("**{t}**");
        }
        if r.italic {
            t = format!("*{t}*");
        }
        if r.strike {
            t = format!("~~{t}~~");
        }
        if r.underline {
            t = format!("<u>{t}</u>");
        }
        if r.sub {
            t = format!("<sub>{t}</sub>");
        }
        if r.sup {
            t = format!("<sup>{t}</sup>");
        }
        if r.hl.is_some() {
            t = format!("<mark>{t}</mark>");
        }
        let mut attrs = Vec::new();
        if let Some(f) = &r.font {
            attrs.push(format!("f:{f}"));
        }
        if let Some(sz) = r.size {
            attrs.push(format!("s:{sz}"));
        }
        if let Some(c) = &r.color {
            if c != "auto" {
                attrs.push(format!("c:{}", color_token(c, palette)));
            }
        }
        if let Some(h) = &r.hl {
            attrs.push(format!("h:{}", color_token(h, palette)));
        }
        if !attrs.is_empty() {
            t = format!("<span ow=\"{}\">{t}</span>", attrs.join(";"));
        }
        s.push_str(&t);
    }
    s
}

fn paragraph_to_md(p: &Paragraph, palette: &HashMap<String, &'static str>) -> String {
    let indent = "  ".repeat(p.indent as usize);
    let body = runs_to_md(&p.runs, palette);
    if p.bullet.is_some() {
        format!("{indent}- {body}")
    } else {
        format!("{indent}{body}")
    }
}

fn export_md(note: &NoteFile, title: &str, dest: &Path, opts: &ExportOptions) -> Result<()> {
    let out = note_to_md(note, title, opts)?;
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)?;
    }
    atomic::atomic_write_string(dest, &out, false)?;
    Ok(())
}

fn export_md_merged(
    notes: &[(NoteFile, String, Option<String>)],
    dest: &Path,
    opts: &ExportOptions,
) -> Result<()> {
    let mut parts = Vec::with_capacity(notes.len());
    for (note, title, header) in notes.iter() {
        let mut nopts = opts.clone();
        nopts.title_header = header.clone();
        parts.push(note_to_md(note, title, &nopts)?);
    }
    let out = parts.join("\n\n---\n\n");
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)?;
    }
    atomic::atomic_write_string(dest, &out, false)?;
    Ok(())
}

enum MdBody<'a> {
    Obj(&'a CanvasObject),
    Sketch {
        id: String,
        n: usize,
        color: String,
        x: f64,
        y: f64,
        w: f64,
        h: f64,
    },
}

impl MdBody<'_> {
    fn bbox(&self) -> (f64, f64, f64, f64) {
        match self {
            MdBody::Obj(o) => md_bbox(o),
            MdBody::Sketch { x, y, w, h, .. } => (*x, *y, *w, *h),
        }
    }

    fn id(&self) -> &str {
        match self {
            MdBody::Obj(o) => o.id(),
            MdBody::Sketch { id, .. } => id,
        }
    }
}

fn note_to_md(note: &NoteFile, title: &str, opts: &ExportOptions) -> Result<String> {
    let mut out = String::new();
    if let Some(h) = opts.title_header.as_deref().filter(|h| !h.trim().is_empty()) {
        out.push_str(&format!("# {h}\n\n"));
    }

    out.push_str(&format!(
        "<!--pl:doc v=1 note=\"{}\" created={}-->\n\n",
        title.replace('"', ""),
        note.doc.meta.created.format("%Y-%m-%d")
    ));

    let palette = build_palette(note);
    if !palette.is_empty() {
        out.push_str(&format_palette_line(note, &palette));
        out.push('\n');
    }

    let order = md_body_order(note);
    let median_w = {
        let mut widths: Vec<f64> = note
            .doc
            .canvas
            .objects
            .iter()
            .filter_map(|o| match o {
                CanvasObject::Text(t) => Some(t.width),
                _ => None,
            })
            .collect();
        widths.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        if widths.is_empty() {
            340.0
        } else {
            widths[widths.len() / 2]
        }
    };
    let modal_size = modal_run_size(note);

    let mut prev: Vec<RelTarget> = Vec::new();
    let mut edges: Vec<(String, String)> = Vec::new();

    let link_targets: Vec<(String, f64, f64, f64, f64)> = note
        .doc
        .canvas
        .objects
        .iter()
        .filter_map(|o| match o {
            CanvasObject::Text(_) | CanvasObject::Image(_) => {
                let (x, y, w, h) = md_bbox(o);
                Some((o.id().to_string(), x, y, w, h))
            }
            _ => None,
        })
        .collect();

    let labels = object_labels(note);

    for item in order {
        let (x, y, w, h) = item.bbox();
        let id = item.id().to_string();
        let rel = rel_desc(x, y, w, h, &prev);

        match item {
            MdBody::Obj(CanvasObject::Text(t)) => {
                let empty = text_content_empty(t);
                let size = if t.width < median_w * 0.6 {
                    "narrow"
                } else if t.width > median_w * 1.5 {
                    "wide"
                } else {
                    "medium"
                };
                let label = plain_label_text(t);
                let role = text_role(t, modal_size);
                let mut attrs = format!("id={}", t.id);
                if let Some(l) = &label {
                    attrs.push_str(&format!(" label=\"{}\"", html_attr(l)));
                }
                if let Some(r) = role {
                    attrs.push_str(&format!(" role={r}"));
                }
                attrs.push_str(&format!(" rel=\"{rel}\" size={size}"));
                if empty {
                    attrs.push_str(" empty=1");
                    out.push_str(&format!("<!--pl:text {attrs}-->\n\n"));
                } else {
                    out.push_str(&format!("<!--pl:text {attrs}-->\n"));
                    let mut last_bullet: Option<String> = None;
                    for block in &t.blocks {
                        match block {
                            Block::P(p) => {
                                if let Some(b) = &p.bullet {
                                    if last_bullet.as_ref() != Some(b) && b != "disc" {
                                        out.push_str(&format!("<!--pl:bullets {b}-->\n"));
                                    }
                                    last_bullet = Some(b.clone());
                                }
                                if p.align != "left" && !p.align.is_empty() {
                                    out.push_str(&format!("<!--pl:align {}-->\n", p.align));
                                }
                                out.push_str(&paragraph_to_md(p, &palette));
                                out.push_str("\n\n");
                            }
                            Block::Table(tb) => {
                                if tb.rows.is_empty() {
                                    continue;
                                }
                                let cols = tb.col_widths.len();
                                let mut lines = Vec::new();
                                for (ri, row) in tb.rows.iter().enumerate() {
                                    let cells: Vec<String> = row
                                        .cells
                                        .iter()
                                        .map(|c| {
                                            c.blocks
                                                .iter()
                                                .map(|p| runs_to_md(&p.runs, &palette))
                                                .collect::<Vec<_>>()
                                                .join("<br>")
                                        })
                                        .collect();
                                    lines.push(format!("| {} |", cells.join(" | ")));
                                    if ri == 0 {
                                        let sep =
                                            (0..cols).map(|_| "---").collect::<Vec<_>>().join(" | ");
                                        lines.push(format!("| {sep} |"));
                                    }
                                }
                                out.push_str(&lines.join("\n"));
                                out.push_str("\n\n");
                            }
                        }
                    }
                }
                prev.push(RelTarget {
                    id,
                    label: label.unwrap_or_default(),
                    x,
                    y,
                    w,
                    h,
                });
            }
            MdBody::Obj(CanvasObject::Image(img)) => {
                let fname = image_filename(&img.media);
                let image_ocr: Option<String> = None; // reserved: local OCR of pasted screenshots
                let mut attrs = format!("id={} rel=\"{rel}\"", img.id);
                if let Some(ocr) = &image_ocr {
                    attrs.push_str(&format!(" ocr=\"{}\"", html_attr(ocr)));
                }
                out.push_str(&format!("<!--pl:image {attrs}-->\n"));
                out.push_str(&format!("![{fname}](media ref: {})\n\n", img.id));
                prev.push(RelTarget {
                    id,
                    label: fname,
                    x,
                    y,
                    w,
                    h,
                });
            }
            MdBody::Obj(CanvasObject::Drawing(d)) => match &d.item {
                DrawingItem::Arrow {
                    tail, head, color, ..
                } => {
                    let abs_tail = [d.x + tail[0], d.y + tail[1]];
                    let abs_head = [d.x + head[0], d.y + head[1]];
                    let from_id = nearest_object(abs_tail[0], abs_tail[1], &link_targets, 40.0);
                    let to_id = nearest_object(abs_head[0], abs_head[1], &link_targets, 40.0);
                    if let (Some(f), Some(t)) = (&from_id, &to_id) {
                        if f != t {
                            edges.push((f.clone(), t.clone()));
                        }
                    }
                    let mut attrs = format!("id={} rel=\"{rel}\"", d.id);
                    if let Some(f) = &from_id {
                        attrs.push_str(&format!(" from={}", fmt_ref(f, labels.get(f).map(|s| s.as_str()).unwrap_or(""))));
                    }
                    if let Some(t) = &to_id {
                        attrs.push_str(&format!(" to={}", fmt_ref(t, labels.get(t).map(|s| s.as_str()).unwrap_or(""))));
                    }
                    attrs.push_str(&format!(
                        " tail=\"{:.0},{:.0}\" head=\"{:.0},{:.0}\"",
                        abs_tail[0], abs_tail[1], abs_head[0], abs_head[1]
                    ));
                    attrs.push_str(&format!(" color={}", color_token(color, &palette)));
                    out.push_str(&format!("<!--pl:connector {attrs}-->\n\n"));
                    prev.push(RelTarget {
                        id,
                        label: "arrow".into(),
                        x,
                        y,
                        w,
                        h,
                    });
                }
                other => {
                    let kind = match other {
                        DrawingItem::Stroke { .. } => "stroke",
                        DrawingItem::Shape { shape, .. } => shape.as_str(),
                        DrawingItem::Arrow { .. } => "arrow",
                    };
                    let color = drawing_item_color(other);
                    let mut attrs = format!(
                        "id={} label=\"{}\" rel=\"{rel}\" kind={kind} color={}",
                        d.id,
                        html_attr(kind),
                        color_token(color, &palette)
                    );
                    if let DrawingItem::Shape { .. } = other {
                        if let Some(enc) = encloses_list(x, y, w, h, &prev) {
                            attrs.push_str(&format!(" encloses=\"{enc}\""));
                        }
                    }
                    out.push_str(&format!("<!--pl:drawing {attrs}-->\n\n"));
                    prev.push(RelTarget {
                        id,
                        label: kind.to_string(),
                        x,
                        y,
                        w,
                        h,
                    });
                }
            },
            MdBody::Obj(CanvasObject::Group(_)) => {}
            MdBody::Obj(CanvasObject::Pdf(pdf)) => {
                let pages = pdf
                    .pages
                    .iter()
                    .map(|n| n.to_string())
                    .collect::<Vec<_>>()
                    .join(", ");
                out.push_str(&format!(
                    "<!--pl:pdf id={} rel=\"{rel}\" pages=\"{pages}\"-->\n\n",
                    pdf.id
                ));
                out.push_str(&format!("PDF, pages {pages}.\n\n"));
                let (w, h) = pdf.size();
                prev.push(RelTarget {
                    id,
                    label: "pdf".into(),
                    x,
                    y,
                    w,
                    h,
                });
            }
            MdBody::Sketch {
                id: sid,
                n,
                color,
                x: sx,
                y: sy,
                w: sw,
                h: sh,
            } => {
                let col = color_token(&color, &palette);
                out.push_str(&format!(
                    "<!--pl:drawing id={sid} label=\"sketch\" rel=\"{rel}\" kind=sketch n={n} color={col}-->\n\n"
                ));
                prev.push(RelTarget {
                    id: sid,
                    label: "sketch".into(),
                    x: sx,
                    y: sy,
                    w: sw,
                    h: sh,
                });
            }
        }
    }

    if !edges.is_empty() {
        out.push_str("<!--pl:edges-->\n");
        for (a, b) in &edges {
            out.push_str(&format!("{a} -> {b}\n"));
        }
        out.push('\n');
    }

    if opts.geometry_block {
        out.push_str("<!--pl:geometry-->\n```pl-geo\n");
        let geo = build_geometry(note);
        out.push_str(&serde_json::to_string(&geo)?);
        out.push_str("\n```\n");
    }

    Ok(out)
}

fn text_content_empty(t: &crate::note::TextObject) -> bool {
    for block in &t.blocks {
        match block {
            Block::P(p) => {
                if p.runs.iter().any(|r| !r.text.trim().is_empty()) {
                    return false;
                }
            }
            Block::Table(tb) => {
                for row in &tb.rows {
                    for cell in &row.cells {
                        for p in &cell.blocks {
                            if p.runs.iter().any(|r| !r.text.trim().is_empty()) {
                                return false;
                            }
                        }
                    }
                }
            }
        }
    }
    true
}

pub(crate) fn text_object_height(t: &crate::note::TextObject) -> f64 {
    let mut dummy = Vec::new();
    let origin_x = t.x + TEXT_PAD_X;
    let mut y = t.y + TEXT_PAD_Y;
    let max_w = (t.width - 2.0 * TEXT_PAD_X).max(1.0);
    for block in &t.blocks {
        match block {
            Block::P(p) => {
                y = layout_paragraph(p, origin_x, y, max_w, &mut dummy);
            }
            Block::Table(tb) => {
                let row_h = 26.0;
                y += tb.rows.len() as f64 * row_h + 6.0;
            }
        }
    }
    let h = (y - t.y) + TEXT_PAD_Y;
    h.max(t.min_height.unwrap_or(0.0)).max(24.0)
}

fn md_bbox(obj: &CanvasObject) -> (f64, f64, f64, f64) {
    match obj {
        CanvasObject::Text(t) => (t.x, t.y, t.width, text_object_height(t)),
        _ => obj.bbox(),
    }
}

fn image_filename(media: &str) -> String {
    Path::new(media)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| media.to_string())
}

fn sanitize_label(s: &str) -> String {
    let joined = s.split_whitespace().collect::<Vec<_>>().join(" ");
    let chars: Vec<char> = joined
        .chars()
        .map(|c| match c {
            '"' | '(' | ')' => '\'',
            _ => c,
        })
        .collect();
    if chars.len() > 40 {
        let mut t: String = chars.into_iter().take(40).collect();
        t.push('…');
        t
    } else {
        chars.into_iter().collect()
    }
}

fn html_attr(s: &str) -> String {
    s.replace('"', "'")
}

fn fmt_ref(id: &str, label: &str) -> String {
    if label.is_empty() {
        id.to_string()
    } else {
        format!("{id}({label})")
    }
}

fn plain_label_text(t: &crate::note::TextObject) -> Option<String> {
    for block in &t.blocks {
        if let Block::P(p) = block {
            let s: String = p.runs.iter().map(|r| r.text.as_str()).collect();
            let s = s.trim();
            if !s.is_empty() {
                return Some(sanitize_label(s));
            }
        }
    }
    None
}

fn drawing_item_color(item: &DrawingItem) -> &str {
    match item {
        DrawingItem::Stroke { color, .. }
        | DrawingItem::Shape { color, .. }
        | DrawingItem::Arrow { color, .. } => color,
    }
}

fn drawing_kind(item: &DrawingItem) -> &str {
    match item {
        DrawingItem::Stroke { highlighter: true, .. } => "highlight",
        DrawingItem::Stroke { .. } => "stroke",
        DrawingItem::Shape { shape, .. } => shape.as_str(),
        DrawingItem::Arrow { .. } => "arrow",
    }
}

fn object_labels(note: &NoteFile) -> HashMap<String, String> {
    let mut m = HashMap::new();
    for o in &note.doc.canvas.objects {
        match o {
            CanvasObject::Text(t) => {
                if let Some(l) = plain_label_text(t) {
                    m.insert(t.id.clone(), l);
                }
            }
            CanvasObject::Image(i) => {
                m.insert(i.id.clone(), image_filename(&i.media));
            }
            CanvasObject::Drawing(d) => {
                m.insert(d.id.clone(), drawing_kind(&d.item).to_string());
            }
            CanvasObject::Group(_) => {}
            CanvasObject::Pdf(p) => {
                m.insert(p.id.clone(), format!("pdf ({} pages)", p.pages.len()));
            }
        }
    }
    m
}

fn modal_run_size(note: &NoteFile) -> f64 {
    let mut counts: HashMap<i64, usize> = HashMap::new();
    for o in &note.doc.canvas.objects {
        if let CanvasObject::Text(t) = o {
            for block in &t.blocks {
                let runs: Vec<&Run> = match block {
                    Block::P(p) => p.runs.iter().collect(),
                    Block::Table(tb) => tb
                        .rows
                        .iter()
                        .flat_map(|r| r.cells.iter().flat_map(|c| c.blocks.iter().flat_map(|p| p.runs.iter())))
                        .collect(),
                };
                for r in runs {
                    let s = r.size.unwrap_or(DEFAULT_PT);
                    *counts.entry((s * 10.0).round() as i64).or_insert(0) += 1;
                }
            }
        }
    }
    counts
        .into_iter()
        .max_by_key(|(_, n)| *n)
        .map(|(k, _)| k as f64 / 10.0)
        .unwrap_or(DEFAULT_PT)
}

fn text_role(t: &crate::note::TextObject, modal_size: f64) -> Option<&'static str> {
    if text_content_empty(t) {
        return None;
    }
    let mut all_runs: Vec<&Run> = Vec::new();
    for block in &t.blocks {
        match block {
            Block::P(p) => all_runs.extend(p.runs.iter()),
            Block::Table(tb) => {
                for row in &tb.rows {
                    for cell in &row.cells {
                        for p in &cell.blocks {
                            all_runs.extend(p.runs.iter());
                        }
                    }
                }
            }
        }
    }
    if !all_runs.is_empty()
        && all_runs.iter().all(|r| matches!(family_for(r.font.as_ref()), FontFamily::Mono))
    {
        return Some("code");
    }
    if let Some(Block::P(p)) = t.blocks.iter().find(|b| matches!(b, Block::P(_))) {
        if let Some(dom) = p
            .runs
            .iter()
            .filter(|r| !r.text.trim().is_empty())
            .max_by_key(|r| r.text.len())
        {
            let sz = dom.size.unwrap_or(DEFAULT_PT);
            if dom.bold && sz >= modal_size * 1.3 {
                return Some("heading");
            }
        }
    }
    None
}

fn box_sep(a: (f64, f64, f64, f64), b: (f64, f64, f64, f64)) -> f64 {
    let (x, y, w, h) = a;
    let (x2, y2, w2, h2) = b;
    let ox = (x + w).min(x2 + w2) - x.max(x2);
    let oy = (y + h).min(y2 + h2) - y.max(y2);
    if ox > 0.0 && oy > 0.0 {
        0.0
    } else if ox > 0.0 {
        (-oy).max(0.0)
    } else if oy > 0.0 {
        (-ox).max(0.0)
    } else {
        ((-ox).max(0.0).powi(2) + (-oy).max(0.0).powi(2)).sqrt()
    }
}

const STROKE_GROUP_DIP: f64 = 24.0;

fn md_body_order(note: &NoteFile) -> Vec<MdBody<'_>> {
    let strokes: Vec<&crate::note::DrawingObject> = note
        .doc
        .canvas
        .objects
        .iter()
        .filter_map(|o| match o {
            CanvasObject::Drawing(d) if matches!(d.item, DrawingItem::Stroke { .. }) => Some(d),
            _ => None,
        })
        .collect();

    let n = strokes.len();
    let mut parent: Vec<usize> = (0..n).collect();
    fn find(parent: &mut [usize], i: usize) -> usize {
        let mut i = i;
        while parent[i] != i {
            parent[i] = parent[parent[i]];
            i = parent[i];
        }
        i
    }
    for i in 0..n {
        let bi = {
            let (x, y, w, h) = CanvasObject::Drawing(strokes[i].clone()).bbox();
            (x, y, w, h)
        };
        let ci = match &strokes[i].item {
            DrawingItem::Stroke { color, .. } => normalize_hex(color).unwrap_or_else(|| color.clone()),
            _ => continue,
        };
        for (j, sj) in strokes.iter().enumerate().skip(i + 1) {
            let cj = match &sj.item {
                DrawingItem::Stroke { color, .. } => {
                    normalize_hex(color).unwrap_or_else(|| color.clone())
                }
                _ => continue,
            };
            if ci != cj {
                continue;
            }
            let bj = {
                let (x, y, w, h) = CanvasObject::Drawing((*sj).clone()).bbox();
                (x, y, w, h)
            };
            if box_sep(bi, bj) <= STROKE_GROUP_DIP {
                let a = find(&mut parent, i);
                let b = find(&mut parent, j);
                parent[b] = a;
            }
        }
    }

    let mut groups: HashMap<usize, Vec<usize>> = HashMap::new();
    for i in 0..n {
        let r = find(&mut parent, i);
        groups.entry(r).or_default().push(i);
    }

    let mut grouped_ids: HashSet<&str> = HashSet::new();
    let mut items: Vec<MdBody<'_>> = Vec::new();
    for members in groups.values() {
        if members.len() < 2 {
            continue;
        }
        let mut min_x = f64::INFINITY;
        let mut min_y = f64::INFINITY;
        let mut max_x = f64::NEG_INFINITY;
        let mut max_y = f64::NEG_INFINITY;
        for &i in members {
            grouped_ids.insert(strokes[i].id.as_str());
            let (x, y, w, h) = CanvasObject::Drawing(strokes[i].clone()).bbox();
            min_x = min_x.min(x);
            min_y = min_y.min(y);
            max_x = max_x.max(x + w);
            max_y = max_y.max(y + h);
        }
        let color = match &strokes[members[0]].item {
            DrawingItem::Stroke { color, .. } => color.clone(),
            _ => "#000000".into(),
        };
        items.push(MdBody::Sketch {
            id: strokes[members[0]].id.clone(),
            n: members.len(),
            color,
            x: min_x,
            y: min_y,
            w: (max_x - min_x).max(1.0),
            h: (max_y - min_y).max(1.0),
        });
    }

    for o in &note.doc.canvas.objects {
        if grouped_ids.contains(o.id()) {
            continue;
        }
        items.push(MdBody::Obj(o));
    }
    sort_by_reading_order(&mut items, |it| it.bbox());
    items
}

fn encloses_list(x: f64, y: f64, w: f64, h: f64, prev: &[RelTarget]) -> Option<String> {
    let mut hits = Vec::new();
    for p in prev {
        let inner_area = p.w.max(1.0) * p.h.max(1.0);
        let ox = (x + w).min(p.x + p.w) - x.max(p.x);
        let oy = (y + h).min(p.y + p.h) - y.max(p.y);
        if ox <= 0.0 || oy <= 0.0 {
            continue;
        }
        if ox * oy / inner_area >= 0.9 {
            hits.push(fmt_ref(&p.id, &p.label));
        }
    }
    if hits.is_empty() {
        None
    } else {
        Some(hits.join(", "))
    }
}

/// Nearest object whose bbox is within `max_dist` DIP of the point (0 if inside).
fn nearest_object(
    px: f64,
    py: f64,
    targets: &[(String, f64, f64, f64, f64)],
    max_dist: f64,
) -> Option<String> {
    let mut best: Option<(f64, &str)> = None;
    for (id, x, y, w, h) in targets {
        let cx = px.clamp(*x, *x + *w);
        let cy = py.clamp(*y, *y + *h);
        let d = ((px - cx).powi(2) + (py - cy).powi(2)).sqrt();
        if d <= max_dist && best.map(|(bd, _)| d < bd).unwrap_or(true) {
            best = Some((d, id.as_str()));
        }
    }
    best.map(|(_, id)| id.to_string())
}

struct RelTarget {
    id: String,
    label: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

fn rel_desc(x: f64, y: f64, w: f64, h: f64, prev: &[RelTarget]) -> String {
    if prev.is_empty() {
        return "top-left".into();
    }
    let cx = x + w / 2.0;
    let cy = y + h / 2.0;
    let mut best_overlap: Option<(f64, &RelTarget)> = None;
    // (same_axis, gap, clause)
    let mut best_v: Option<(bool, f64, String)> = None;
    let mut best_h: Option<(bool, f64, String)> = None;

    for p in prev {
        let overlap_x = (x + w).min(p.x + p.w) - x.max(p.x);
        let overlap_y = (y + h).min(p.y + p.h) - y.max(p.y);
        if overlap_x > 0.0 && overlap_y > 0.0 {
            let area = overlap_x * overlap_y;
            if best_overlap.map(|(a, _)| area > a).unwrap_or(true) {
                best_overlap = Some((area, p));
            }
            continue;
        }

        let pcx = p.x + p.w / 2.0;
        let pcy = p.y + p.h / 2.0;
        let same_col = overlap_x > 0.0;
        let same_row = overlap_y > 0.0;

        let gap_v = if cy >= pcy {
            (y - (p.y + p.h)).max(0.0)
        } else {
            (p.y - (y + h)).max(0.0)
        };
        let gap_h = if cx >= pcx {
            (x - (p.x + p.w)).max(0.0)
        } else {
            (p.x - (x + w)).max(0.0)
        };

        let r = fmt_ref(&p.id, &p.label);
        let v_clause = if cy >= pcy {
            if gap_v >= 300.0 {
                format!("far-below {r}")
            } else {
                format!("below {r}")
            }
        } else if gap_v >= 300.0 {
            format!("far-above {r}")
        } else {
            format!("above {r}")
        };
        let h_clause = if cx >= pcx {
            if gap_h >= 300.0 {
                format!("far-right-of {r}")
            } else {
                format!("right-of {r}")
            }
        } else if gap_h >= 300.0 {
            format!("far-left-of {r}")
        } else {
            format!("left-of {r}")
        };

        let v_better = match &best_v {
            None => true,
            Some((sc, g, _)) => match (same_col, *sc) {
                (true, false) => true,
                (false, true) => false,
                _ => gap_v < *g,
            },
        };
        if v_better {
            best_v = Some((same_col, gap_v, v_clause));
        }
        let h_better = match &best_h {
            None => true,
            Some((sr, g, _)) => match (same_row, *sr) {
                (true, false) => true,
                (false, true) => false,
                _ => gap_h < *g,
            },
        };
        if h_better {
            best_h = Some((same_row, gap_h, h_clause));
        }
    }

    if let Some((_, p)) = best_overlap {
        return format!("overlaps {}", fmt_ref(&p.id, &p.label));
    }
    let mut parts = Vec::new();
    if let Some((_, _, v)) = best_v {
        parts.push(v);
    }
    if let Some((_, _, h)) = best_h {
        if parts.len() < 2 {
            parts.push(h);
        }
    }
    if parts.is_empty() {
        "top-left".into()
    } else {
        parts.join(", ")
    }
}

const NAMED_COLORS: &[(&str, u8, u8, u8)] = &[
    ("red", 255, 0, 0),
    ("red", 192, 57, 43),
    ("orange", 255, 165, 0),
    ("yellow", 255, 255, 0),
    ("yellow", 255, 245, 157),
    ("green", 0, 128, 0),
    ("green", 39, 174, 96),
    ("teal", 0, 128, 128),
    ("blue", 0, 0, 255),
    ("blue", 52, 152, 219),
    ("indigo", 75, 0, 130),
    ("purple", 128, 0, 128),
    ("pink", 255, 192, 203),
    ("brown", 165, 42, 42),
    ("gray", 128, 128, 128),
    ("black", 0, 0, 0),
    ("white", 255, 255, 255),
    ("cyan", 0, 255, 255),
    ("magenta", 255, 0, 255),
    ("lime", 0, 255, 0),
    ("navy", 0, 0, 128),
    ("maroon", 128, 0, 0),
    ("olive", 128, 128, 0),
    ("gold", 255, 215, 0),
];

const COLOR_MATCH_MAX_DIST: f64 = 85.0;

fn parse_rgb(hex: &str) -> Option<(u8, u8, u8)> {
    let h = hex.trim().trim_start_matches('#');
    let h = if h.len() == 3 {
        format!(
            "{0}{0}{1}{1}{2}{2}",
            h.as_bytes()[0] as char,
            h.as_bytes()[1] as char,
            h.as_bytes()[2] as char
        )
    } else {
        h.to_string()
    };
    if h.len() != 6 {
        return None;
    }
    let r = u8::from_str_radix(&h[0..2], 16).ok()?;
    let g = u8::from_str_radix(&h[2..4], 16).ok()?;
    let b = u8::from_str_radix(&h[4..6], 16).ok()?;
    Some((r, g, b))
}

fn normalize_hex(hex: &str) -> Option<String> {
    let (r, g, b) = parse_rgb(hex)?;
    Some(format!("#{r:02x}{g:02x}{b:02x}"))
}

pub(crate) fn named_color_hex(name: &str) -> Option<String> {
    let name = name.trim();
    for (n, r, g, b) in NAMED_COLORS {
        if n.eq_ignore_ascii_case(name) {
            return Some(format!("#{r:02x}{g:02x}{b:02x}"));
        }
    }
    None
}

fn nearest_named_color(hex: &str) -> Option<&'static str> {
    let (r, g, b) = parse_rgb(hex)?;
    let mut best: Option<(f64, &'static str)> = None;
    for (name, nr, ng, nb) in NAMED_COLORS {
        let d = ((r as f64 - *nr as f64).powi(2)
            + (g as f64 - *ng as f64).powi(2)
            + (b as f64 - *nb as f64).powi(2))
        .sqrt();
        if d <= COLOR_MATCH_MAX_DIST && best.map(|(bd, _)| d < bd).unwrap_or(true) {
            best = Some((d, *name));
        }
    }
    best.map(|(_, n)| n)
}

fn collect_hexes(note: &NoteFile) -> (Vec<String>, Vec<String>) {
    let mut colors = Vec::new();
    let mut highlights = Vec::new();
    let mut push_c = |s: &str| {
        if s != "auto" {
            if let Some(n) = normalize_hex(s) {
                if !colors.contains(&n) {
                    colors.push(n);
                }
            }
        }
    };
    let mut push_h = |s: &str| {
        if let Some(n) = normalize_hex(s) {
            if !highlights.contains(&n) {
                highlights.push(n);
            }
        }
    };
    for o in &note.doc.canvas.objects {
        match o {
            CanvasObject::Text(t) => {
                for block in &t.blocks {
                    match block {
                        Block::P(p) => {
                            for r in &p.runs {
                                if let Some(c) = &r.color {
                                    push_c(c);
                                }
                                if let Some(h) = &r.hl {
                                    push_h(h);
                                }
                            }
                        }
                        Block::Table(tb) => {
                            for row in &tb.rows {
                                for cell in &row.cells {
                                    for p in &cell.blocks {
                                        for r in &p.runs {
                                            if let Some(c) = &r.color {
                                                push_c(c);
                                            }
                                            if let Some(h) = &r.hl {
                                                push_h(h);
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            CanvasObject::Drawing(d) => {
                push_c(drawing_item_color(&d.item));
                if let DrawingItem::Shape { fill: Some(f), .. } = &d.item {
                    push_c(f);
                }
            }
            _ => {}
        }
    }
    (colors, highlights)
}

fn build_palette(note: &NoteFile) -> HashMap<String, &'static str> {
    let (colors, highlights) = collect_hexes(note);
    let mut map = HashMap::new();
    for hex in colors.iter().chain(highlights.iter()) {
        if let Some(name) = nearest_named_color(hex) {
            map.insert(hex.clone(), name);
        }
    }
    map
}

fn format_palette_line(note: &NoteFile, palette: &HashMap<String, &'static str>) -> String {
    let (colors, highlights) = collect_hexes(note);
    let mut parts = Vec::new();
    let mut ci = 1;
    for hex in &colors {
        if let Some(name) = palette.get(hex) {
            parts.push(format!("c{ci}=\"{hex}:{name}\""));
            ci += 1;
        }
    }
    let mut hi = 1;
    for hex in &highlights {
        if let Some(name) = palette.get(hex) {
            parts.push(format!("h{hi}=\"{hex}:{name}\""));
            hi += 1;
        }
    }
    format!("<!--pl:palette {}-->\n", parts.join(" "))
}

#[derive(Serialize)]
struct GeometryDoc {
    v: u32,
    defaults: GeometryDefaults,
    objects: Vec<serde_json::Value>,
}

#[derive(Serialize)]
struct GeometryDefaults {
    font: String,
    size: f64,
}

fn build_geometry(note: &NoteFile) -> GeometryDoc {
    let link_targets: Vec<(String, f64, f64, f64, f64)> = note
        .doc
        .canvas
        .objects
        .iter()
        .filter_map(|o| match o {
            CanvasObject::Text(_) | CanvasObject::Image(_) => {
                let (x, y, w, h) = md_bbox(o);
                Some((o.id().to_string(), x, y, w, h))
            }
            _ => None,
        })
        .collect();

    let mut objects = Vec::new();
    for obj in &note.doc.canvas.objects {
        match obj {
            CanvasObject::Text(t) => {
                let mut v = serde_json::json!({
                    "id": t.id, "x": t.x, "y": t.y, "z": t.z, "w": t.width
                });
                if text_content_empty(t) {
                    v["empty"] = serde_json::json!(true);
                }
                objects.push(v);
            }
            CanvasObject::Image(img) => {
                let png = note
                    .media
                    .get(&img.media)
                    .map(|b| B64.encode(b))
                    .unwrap_or_default();
                objects.push(serde_json::json!({
                    "id": img.id, "x": img.x, "y": img.y, "z": img.z,
                    "w": img.width, "h": img.height, "png": png
                }));
            }
            CanvasObject::Drawing(d) => {
                let mut v = serde_json::json!({
                    "id": d.id, "x": d.x, "y": d.y, "z": d.z,
                    "item": d.item
                });
                if let DrawingItem::Arrow { tail, head, .. } = &d.item {
                    let abs_tail = [d.x + tail[0], d.y + tail[1]];
                    let abs_head = [d.x + head[0], d.y + head[1]];
                    v["abs_tail"] = serde_json::json!(abs_tail);
                    v["abs_head"] = serde_json::json!(abs_head);
                    if let Some(f) = nearest_object(abs_tail[0], abs_tail[1], &link_targets, 40.0) {
                        v["from"] = serde_json::json!(f);
                    }
                    if let Some(t) = nearest_object(abs_head[0], abs_head[1], &link_targets, 40.0) {
                        v["to"] = serde_json::json!(t);
                    }
                }
                objects.push(v);
            }
            CanvasObject::Group(_) => {}
            CanvasObject::Pdf(p) => {
                let (w, h) = p.size();
                objects.push(serde_json::json!({
                    "id": p.id, "type": "pdf", "x": p.x, "y": p.y, "z": p.z,
                    "w": w, "h": h, "pages": p.pages, "layout": p.layout,
                }));
            }
        }
    }
    GeometryDoc {
        v: 1,
        defaults: GeometryDefaults {
            font: "Segoe UI".into(),
            size: 11.0,
        },
        objects,
    }
}

/* ─── PDF ──────────────────────────────────────────────────────────────── */

// A4 at 96 dpi, matching the canvas' device-independent pixels.
const DIP_TO_MM: f64 = 25.4 / 96.0;
const PAGE_W_DIP: f64 = 794.0;
const PAGE_H_DIP: f64 = 1123.0;
const MARGIN_DIP: f64 = 40.0;
const CONTENT_W_DIP: f64 = PAGE_W_DIP - 2.0 * MARGIN_DIP;
const CONTENT_H_DIP: f64 = PAGE_H_DIP - 2.0 * MARGIN_DIP;
const PDF_TITLE_PT: f64 = 15.0;
const PDF_TITLE_GAP_DIP: f64 = 20.0;
/// Reserved band at the top of page 1 for the note title + breathing room.
const TITLE_BLOCK_DIP: f64 = PDF_TITLE_PT * (96.0 / 72.0) + PDF_TITLE_GAP_DIP;
/// Text windows have a 1px border plus 8px/5px padding around their content.
const TEXT_PAD_X: f64 = 9.0;
const TEXT_PAD_Y: f64 = 6.0;
const DEFAULT_PT: f64 = 11.0;
const LINE_FACTOR: f64 = 1.5;

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
enum FontFamily {
    Sans,
    Serif,
    Mono,
}

fn family_for(name: Option<&String>) -> FontFamily {
    let n = name.map(|s| s.to_ascii_lowercase()).unwrap_or_default();
    if n.contains("times")
        || n.contains("georgia")
        || n.contains("cambria")
        || n.contains("garamond")
        || n.contains("serif")
        || n.contains("book")
    {
        FontFamily::Serif
    } else if n.contains("consolas") || n.contains("courier") || n.contains("mono") {
        FontFamily::Mono
    } else {
        FontFamily::Sans
    }
}

fn builtin(family: FontFamily, bold: bool, italic: bool) -> BuiltinFont {
    match (family, bold, italic) {
        (FontFamily::Sans, false, false) => BuiltinFont::Helvetica,
        (FontFamily::Sans, true, false) => BuiltinFont::HelveticaBold,
        (FontFamily::Sans, false, true) => BuiltinFont::HelveticaOblique,
        (FontFamily::Sans, true, true) => BuiltinFont::HelveticaBoldOblique,
        (FontFamily::Serif, false, false) => BuiltinFont::TimesRoman,
        (FontFamily::Serif, true, false) => BuiltinFont::TimesBold,
        (FontFamily::Serif, false, true) => BuiltinFont::TimesItalic,
        (FontFamily::Serif, true, true) => BuiltinFont::TimesBoldItalic,
        (FontFamily::Mono, false, false) => BuiltinFont::Courier,
        (FontFamily::Mono, true, false) => BuiltinFont::CourierBold,
        (FontFamily::Mono, false, true) => BuiltinFont::CourierOblique,
        (FontFamily::Mono, true, true) => BuiltinFont::CourierBoldOblique,
    }
}

/// Rough advance width in em units. The builtin metrics aren't exposed by
/// printpdf, so wrapping uses this approximation.
fn char_em(c: char, family: FontFamily) -> f64 {
    if family == FontFamily::Mono {
        return 0.6;
    }
    match c {
        'i' | 'l' | 'j' | 'I' | '.' | ',' | ':' | ';' | '\'' | '|' | '!' | '`' => 0.28,
        'f' | 't' | 'r' | '(' | ')' | '[' | ']' | '/' | '\\' | '-' | ' ' => 0.34,
        'm' | 'w' | 'M' | 'W' | '@' | '%' => 0.86,
        'A'..='Z' => 0.68,
        '0'..='9' => 0.56,
        _ => 0.52,
    }
}

fn text_width(s: &str, family: FontFamily, size_pt: f64) -> f64 {
    // returned in DIP so it can be compared with the window width
    let em: f64 = s.chars().map(|c| char_em(c, family)).sum();
    em * size_pt * (96.0 / 72.0)
}

fn soften_marker(color: &str, opacity: f64) -> String {
    let h = color.trim().trim_start_matches('#');
    if h.len() < 6 {
        return color.to_string();
    }
    let parse = |i: usize| u8::from_str_radix(&h[i..i + 2], 16).unwrap_or(0);
    let keep = (0.32 + 0.28 * opacity) as f32;
    let mix = |c: u8| (c as f32 * keep + 255.0 * (1.0 - keep)).round() as u8;
    format!("#{:02x}{:02x}{:02x}", mix(parse(0)), mix(parse(2)), mix(parse(4)))
}

fn hex_color(hex: &Option<String>) -> Color {
    let fallback = Color::Rgb(Rgb::new(0.1, 0.1, 0.1, None));
    let Some(h) = hex else { return fallback };
    let h = h.trim_start_matches('#');
    if h.len() < 6 {
        return fallback;
    }
    let p = |i: usize| u8::from_str_radix(&h[i..i + 2], 16).unwrap_or(0) as f32 / 255.0;
    Color::Rgb(Rgb::new(p(0), p(2), p(4), None))
}

/// One laid-out piece of text in absolute canvas coordinates.
struct Fragment {
    x: f64,
    /// baseline, canvas coords
    y: f64,
    text: String,
    size_pt: f64,
    family: FontFamily,
    bold: bool,
    italic: bool,
    color: Option<String>,
    hl: Option<String>,
}

fn layout_paragraph(
    p: &Paragraph,
    origin_x: f64,
    start_y: f64,
    max_w: f64,
    out: &mut Vec<Fragment>,
) -> f64 {
    let indent = origin_x + p.indent as f64 * 22.0;
    let bullet_glyph = p.bullet.as_deref().map(|b| match b {
        "circle" => "o",
        "square" => "-",
        "dash" => "-",
        "arrow" => ">",
        _ => "•",
    });

    // Split runs into words, keeping each word's styling.
    struct Word {
        text: String,
        run: usize,
        w: f64,
    }
    let mut words: Vec<Word> = Vec::new();
    for (ri, r) in p.runs.iter().enumerate() {
        let family = family_for(r.font.as_ref());
        let size = r.size.unwrap_or(DEFAULT_PT);
        let text = if r.math {
            format!("[{}]", r.text)
        } else {
            r.text.clone()
        };
        for w in text.split_inclusive(' ') {
            if w.is_empty() {
                continue;
            }
            words.push(Word {
                w: text_width(w, family, size),
                text: w.to_string(),
                run: ri,
            });
        }
    }

    let max_size = p
        .runs
        .iter()
        .map(|r| r.size.unwrap_or(DEFAULT_PT))
        .fold(DEFAULT_PT, f64::max);
    let line_h = max_size * (96.0 / 72.0) * LINE_FACTOR;

    if words.is_empty() {
        return start_y + line_h;
    }

    let mut y = start_y;
    let mut x = indent;
    let bullet_w = if bullet_glyph.is_some() { 16.0 } else { 0.0 };

    if let Some(g) = bullet_glyph {
        out.push(Fragment {
            x: indent,
            y: y + max_size * 0.95,
            text: g.to_string(),
            size_pt: max_size,
            family: FontFamily::Sans,
            bold: false,
            italic: false,
            color: None,
            hl: None,
        });
    }
    x += bullet_w;

    for word in words {
        let line_start = indent + bullet_w;
        if x > line_start && x + word.w > origin_x + max_w {
            y += line_h;
            x = line_start;
        }
        let r = &p.runs[word.run];
        out.push(Fragment {
            x,
            y: y + max_size * 0.95,
            text: word.text.clone(),
            size_pt: r.size.unwrap_or(DEFAULT_PT),
            family: family_for(r.font.as_ref()),
            bold: r.bold,
            italic: r.italic,
            color: r.color.clone(),
            hl: r.hl.clone(),
        });
        x += word.w;
    }
    y + line_h
}

fn layout_text_object(t: &crate::note::TextObject) -> Vec<Fragment> {
    let mut out = Vec::new();
    let origin_x = t.x + TEXT_PAD_X;
    let mut y = t.y + TEXT_PAD_Y;
    let max_w = t.width - 2.0 * TEXT_PAD_X;
    for block in &t.blocks {
        match block {
            Block::P(p) => {
                y = layout_paragraph(p, origin_x, y, max_w, &mut out);
            }
            Block::Table(tb) => {
                let row_h = 26.0;
                for (ri, row) in tb.rows.iter().enumerate() {
                    let mut cx = origin_x;
                    for (ci, cell) in row.cells.iter().enumerate() {
                        let w = tb.col_widths.get(ci).copied().unwrap_or(120.0);
                        let mut cy = y + ri as f64 * row_h + 4.0;
                        for p in &cell.blocks {
                            cy = layout_paragraph(p, cx + 6.0, cy, w - 12.0, &mut out);
                        }
                        cx += w;
                    }
                }
                y += tb.rows.len() as f64 * row_h + 6.0;
            }
        }
    }
    out
}

struct Mapper {
    bx: f64,
    page_top: f64,
    scale: f64,
    /// Pushes page-1 canvas content below the title band.
    content_offset_y: f64,
}

impl Mapper {
    /// canvas DIP -> page mm (PDF origin is bottom-left)
    fn point(&self, x: f64, y: f64) -> Point {
        let px = MARGIN_DIP + (x - self.bx) * self.scale;
        let py = MARGIN_DIP + self.content_offset_y + (y - self.page_top) * self.scale;
        Point::new(Mm((px * DIP_TO_MM) as f32), Mm(((PAGE_H_DIP - py) * DIP_TO_MM) as f32))
    }
    fn mm_x(&self, x: f64) -> Mm {
        Mm(((MARGIN_DIP + (x - self.bx) * self.scale) * DIP_TO_MM) as f32)
    }
    fn mm_y(&self, y: f64) -> Mm {
        let py = MARGIN_DIP + self.content_offset_y + (y - self.page_top) * self.scale;
        Mm(((PAGE_H_DIP - py) * DIP_TO_MM) as f32)
    }
}

/// The content of one PDF page, recorded as printpdf operations.
struct Layer {
    ops: Vec<Op>,
    /// Graphics state with the multiply blend mode, for highlighter strokes.
    multiply: Option<ExtendedGraphicsStateId>,
}

impl Layer {
    fn new(multiply: Option<ExtendedGraphicsStateId>) -> Self {
        Self { ops: Vec::new(), multiply }
    }
    fn set_fill_color(&mut self, col: Color) {
        self.ops.push(Op::SetFillColor { col });
    }
    fn set_outline_color(&mut self, col: Color) {
        self.ops.push(Op::SetOutlineColor { col });
    }
    fn set_outline_thickness(&mut self, pt: f32) {
        self.ops.push(Op::SetOutlineThickness { pt: Pt(pt) });
    }
    fn use_text(&mut self, text: impl Into<String>, size: f32, x: Mm, y: Mm, font: BuiltinFont) {
        self.ops.extend([
            Op::StartTextSection,
            Op::SetTextCursor { pos: Point::new(x, y) },
            Op::SetFont { font: PdfFontHandle::Builtin(font), size: Pt(size) },
            Op::ShowText { items: vec![TextItem::Text(text.into())] },
            Op::EndTextSection,
        ]);
    }
    fn into_page(self) -> PdfPage {
        PdfPage::new(Mm(210.0), Mm(297.0), self.ops)
    }
}

fn line_points(pts: Vec<Point>) -> Vec<LinePoint> {
    pts.into_iter().map(|p| LinePoint { p, bezier: false }).collect()
}

fn stroke_path(layer: &mut Layer, pts: Vec<Point>, closed: bool) {
    if pts.len() < 2 {
        return;
    }
    let line = Line {
        points: line_points(pts),
        is_closed: closed,
    };
    layer.ops.push(Op::DrawLine { line });
}

/// Exact cubic matching SVG `C` — avoids 48-segment polyline drift on hand-drawn arrows.
fn stroke_cubic(layer: &mut Layer, p0: Point, c1: Point, c2: Point, p3: Point) {
    let line = Line {
        points: vec![
            LinePoint { p: p0, bezier: false },
            LinePoint { p: c1, bezier: true },
            LinePoint { p: c2, bezier: true },
            LinePoint { p: p3, bezier: false },
        ],
        is_closed: false,
    };
    layer.ops.push(Op::DrawLine { line });
}

fn set_stroke_style(layer: &mut Layer, cap: LineCapStyle, join: LineJoinStyle) {
    layer.ops.push(Op::SetLineCapStyle { cap });
    layer.ops.push(Op::SetLineJoinStyle { join });
}

fn fill_polygon(layer: &mut Layer, pts: Vec<Point>) {
    if pts.len() < 3 {
        return;
    }
    fill_rings(layer, vec![pts]);
}

/// Several contours in one fill. Overlaps stay one ink level instead of stacking.
fn fill_rings(layer: &mut Layer, rings: Vec<Vec<Point>>) {
    let rings: Vec<PolygonRing> = rings
        .into_iter()
        .filter(|pts| pts.len() >= 3)
        .map(|pts| PolygonRing {
            points: line_points(pts),
        })
        .collect();
    if rings.is_empty() {
        return;
    }
    layer.ops.push(Op::DrawPolygon {
        polygon: Polygon {
            rings,
            mode: PaintMode::Fill,
            winding_order: WindingOrder::NonZero,
        },
    });
}

fn save_pdf(mut doc: PdfDocument, pages: Vec<Layer>, dest: &Path) -> Result<()> {
    doc.with_pages(pages.into_iter().map(Layer::into_page).collect());
    let mut warnings = Vec::new();
    let bytes = doc.save(&PdfSaveOptions::default(), &mut warnings);
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)?;
    }
    crate::atomic::atomic_write(dest, &bytes, false)
        .with_context(|| format!("create {}", dest.display()))?;
    Ok(())
}

fn ellipse_points(cx: f64, cy: f64, rx: f64, ry: f64) -> Vec<[f64; 2]> {
    (0..=48)
        .map(|i| {
            let a = (i as f64 / 48.0) * std::f64::consts::TAU;
            [cx + rx * a.cos(), cy + ry * a.sin()]
        })
        .collect()
}

#[allow(clippy::too_many_arguments)]
fn draw_image(
    doc: &mut PdfDocument,
    layer: &mut Layer,
    bytes: &[u8],
    map: &Mapper,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<()> {
    let decoded = image::load_from_memory(bytes)?.to_rgb8();
    let (pw, ph) = decoded.dimensions();
    if pw == 0 || ph == 0 {
        return Ok(());
    }
    let id = doc.add_image(&RawImage {
        pixels: RawImageData::U8(decoded.into_raw()),
        width: pw as usize,
        height: ph as usize,
        data_format: RawImageFormat::RGB8,
        tag: Vec::new(),
    });
    // Choose a dpi such that the image lands at exactly the requested size.
    let target_w_pt = w * map.scale * 0.75;
    let dpi = (pw as f64) * 72.0 / target_w_pt.max(1.0);
    layer.ops.push(Op::UseXobject {
        id,
        transform: XObjectTransform {
            translate_x: Some(map.mm_x(x).into()),
            // translate refers to the bottom edge of the image
            translate_y: Some(map.mm_y(y + h).into()),
            dpi: Some(dpi as f32),
            ..Default::default()
        },
    });
    Ok(())
}

/// Renders the note onto A4 pages, matching the in-app PDF preview.
pub fn export_pdf(
    notes: &[(&NoteFile, &str, Option<&str>)],
    dest: &Path,
    opts: &ExportOptions,
) -> Result<()> {
    if notes.is_empty() {
        anyhow::bail!("no notes to export");
    }

    struct NotePages<'a> {
        note: &'a NoteFile,
        header: Option<&'a str>,
        bx: f64,
        bottom: f64,
        scale: f64,
        cuts: Vec<f64>,
    }

    let layouts: Vec<NotePages<'_>> = notes
        .iter()
        .map(|(note, title, header)| {
            let (bx, by, bw, bh) = page_content_bbox(note).unwrap_or_else(empty_pagination_bbox);
            let scale = if bw > CONTENT_W_DIP {
                CONTENT_W_DIP / bw
            } else {
                1.0
            };
            let header_text = header.as_deref().or(Some(*title));
            let with_title = header_text.is_some_and(|h: &str| !h.is_empty());
            let (first_span, full_span, _) = paginate_spans(bh, scale, with_title);
            let cuts = page_cuts(note, by, by + bh, first_span, full_span);
            NotePages {
                note,
                header: header_text,
                bx,
                bottom: by + bh,
                scale,
                cuts,
            }
        })
        .collect();

    let total_pages: usize = layouts.iter().map(|l| l.cuts.len()).sum();
    let doc_title = notes
        .first()
        .map(|(_, t, _)| *t)
        .unwrap_or("Paperlike export");

    let mut doc = PdfDocument::new(doc_title);
    let multiply = doc.add_graphics_state(
        ExtendedGraphicsState::default()
            .with_blend_mode(BlendMode::Seperable(SeperableBlendMode::Multiply)),
    );
    let base_font = BuiltinFont::Helvetica;

    let mut pages: Vec<Layer> = Vec::with_capacity(total_pages);
    let mut global_page = 0usize;
    let mut pdf_cache: HashMap<(String, u32, u32), Vec<u8>> = HashMap::new();
    for layout in &layouts {
        let hidden = crate::note::collapsed_child_ids(&layout.note.doc.canvas.objects);
        let mut objects: Vec<&CanvasObject> = layout
            .note
            .doc
            .canvas
            .objects
            .iter()
            .filter(|o| !hidden.contains(o.id()))
            .collect();
        objects.sort_by_key(|o| o.z());

        for page_idx in 0..layout.cuts.len() {
            let page_top = layout.cuts[page_idx];
            let page_span = if page_idx + 1 < layout.cuts.len() {
                layout.cuts[page_idx + 1] - page_top
            } else {
                layout.bottom - page_top
            };
            let content_offset = if page_idx == 0 && layout.header.is_some_and(|h| !h.is_empty()) {
                TITLE_BLOCK_DIP
            } else {
                0.0
            };
            let mut layer = Layer::new(Some(multiply.clone()));
            let page_bottom = page_top + page_span;
            let map = Mapper {
                bx: layout.bx,
                page_top,
                scale: layout.scale,
                content_offset_y: content_offset,
            };
            let scale = layout.scale;

            for obj in &objects {
                match obj {
                    CanvasObject::Text(t) => {
                        for f in layout_text_object(t) {
                            if f.y < page_top || f.y > page_bottom || f.text.trim().is_empty() {
                                continue;
                            }
                            // Highlight behind the glyphs (run.hl → CSS background-color).
                            if let Some(hl) = &f.hl {
                                let dip = f.size_pt * (96.0 / 72.0);
                                let ascent = dip * 0.85;
                                let descent = dip * 0.25;
                                let tw = text_width(&f.text, f.family, f.size_pt).max(1.0);
                                let pad = 1.0;
                                layer.set_fill_color(hex_color(&Some(hl.clone())));
                                fill_polygon(
                                    &mut layer,
                                    vec![
                                        map.point(f.x - pad, f.y - ascent),
                                        map.point(f.x + tw + pad, f.y - ascent),
                                        map.point(f.x + tw + pad, f.y + descent),
                                        map.point(f.x - pad, f.y + descent),
                                    ],
                                );
                            }
                            layer.set_fill_color(hex_color(&f.color));
                            layer.use_text(
                                pdf_text(&f.text),
                                (f.size_pt * scale) as f32,
                                map.mm_x(f.x),
                                map.mm_y(f.y),
                                builtin(f.family, f.bold, f.italic),
                            );
                        }
                    }
                    CanvasObject::Image(img) => {
                        if img.y > page_bottom || img.y + img.height < page_top {
                            continue;
                        }
                        if let Some(bytes) = layout.note.media.get(&img.media) {
                            let _ = draw_image(
                                &mut doc, &mut layer, bytes, &map, img.x, img.y, img.width,
                                img.height,
                            );
                        }
                    }
                    CanvasObject::Drawing(d) => {
                        let (_, oy, _, oh) = obj.bbox();
                        if oy > page_bottom || oy + oh < page_top {
                            continue;
                        }
                        draw_drawing(&mut layer, d, &map, scale);
                    }
                    CanvasObject::Group(_) => {}
                    CanvasObject::Pdf(pdf) => {
                        let (ox, oy, _, oh) = obj.bbox();
                        if oy > page_bottom || oy + oh < page_top {
                            continue;
                        }
                        let Some(bytes) = layout.note.media.get(&pdf.media) else {
                            continue;
                        };
                        for slot in pdf.slots() {
                            let y = pdf.y + slot.y;
                            if y > page_bottom || y + slot.h < page_top {
                                continue;
                            }
                            let px = (slot.w * scale * 2.0).clamp(160.0, 1600.0) as u32;
                            let key = (pdf.media.clone(), slot.page, px);
                            let png = if let Some(hit) = pdf_cache.get(&key) {
                                hit.clone()
                            } else {
                                match crate::pdf_render::render_pdf_page(bytes, slot.page, px) {
                                    Ok(buf) => {
                                        pdf_cache.insert(key, buf.clone());
                                        buf
                                    }
                                    Err(err) => {
                                        eprintln!("pdf page {} of {}: {err}", slot.page, pdf.media);
                                        continue;
                                    }
                                }
                            };
                            let _ = draw_image(
                                &mut doc,
                                &mut layer,
                                &png,
                                &map,
                                ox + slot.x,
                                y,
                                slot.w,
                                slot.h,
                            );
                            // Page-number masks: fractions of the page, painted over the render.
                            for m in pdf.masks.iter().filter(|m| m.page == slot.page) {
                                layer.set_fill_color(hex_color(&Some(m.color.clone())));
                                let (x0, y0) = (ox + slot.x + m.x * slot.w, y + m.y * slot.h);
                                let (x1, y1) = (x0 + m.w * slot.w, y0 + m.h * slot.h);
                                fill_polygon(
                                    &mut layer,
                                    vec![map.point(x0, y0), map.point(x1, y0), map.point(x1, y1), map.point(x0, y1)],
                                );
                            }
                        }
                    }
                }
            }

            layer.set_fill_color(Color::Rgb(Rgb::new(0.35, 0.35, 0.35, None)));
            if let Some(h) = layout.header {
                if page_idx == 0 && !h.is_empty() {
                    let title_baseline = MARGIN_DIP + PDF_TITLE_PT * (96.0 / 72.0) * 0.78;
                    layer.set_fill_color(Color::Rgb(Rgb::new(0.1, 0.1, 0.1, None)));
                    layer.use_text(
                        pdf_text(h),
                        PDF_TITLE_PT as f32,
                        Mm((MARGIN_DIP * DIP_TO_MM) as f32),
                        Mm(((PAGE_H_DIP - title_baseline) * DIP_TO_MM) as f32),
                        BuiltinFont::HelveticaBold,
                    );
                    layer.set_fill_color(Color::Rgb(Rgb::new(0.35, 0.35, 0.35, None)));
                }
            }
            if opts.page_numbers {
                let label = format!("{} / {}", global_page + 1, total_pages);
                layer.use_text(label, 9.0, Mm(100.0), Mm(8.0), base_font);
            }
            if opts.export_date {
                let d = chrono::Local::now().format("%Y. %m. %d.").to_string();
                layer.use_text(d, 9.0, Mm((MARGIN_DIP * DIP_TO_MM) as f32), Mm(8.0), base_font);
            }

            pages.push(layer);
            global_page += 1;
        }
    }

    save_pdf(doc, pages, dest)
}

/// A study-sheet PDF from plain text (markdown-ish headings and bullets).
pub fn write_summary_pdf(title: &str, body: &str, dest: &Path) -> Result<()> {
    let safe_title = pdf_plain(title);
    let doc = PdfDocument::new(if safe_title.is_empty() { "Brief" } else { &safe_title });
    let ink = Color::Rgb(Rgb::new(0.12, 0.11, 0.1, None));
    let muted = Color::Rgb(Rgb::new(0.45, 0.42, 0.38, None));

    let mut pages = vec![Layer::new(None)];
    let mut y = 274.0f64;

    let break_page = |pages: &mut Vec<Layer>, y: &mut f64| {
        pages.push(Layer::new(None));
        *y = 274.0;
    };
    let paint = |pages: &mut [Layer], text: &str, size: f32, x: f64, y: f64, bold: bool| {
        let layer = pages.last_mut().expect("at least one page");
        layer.set_fill_color(ink.clone());
        let face = if bold { BuiltinFont::HelveticaBold } else { BuiltinFont::Helvetica };
        layer.use_text(text, size, Mm(x as f32), Mm(y as f32), face);
    };

    if !safe_title.is_empty() {
        for (i, line) in wrap_pdf(&safe_title, 42).into_iter().enumerate() {
            let size = if i == 0 { 16.0 } else { 14.0 };
            paint(&mut pages, &line, size, 18.0, y, true);
            y -= 7.2;
        }
        y -= 3.0;
    }

    for raw in body.split('\n') {
        let line = raw.trim_end();
        if line.trim().is_empty() {
            y -= 3.2;
            if y < 18.0 {
                break_page(&mut pages, &mut y);
            }
            continue;
        }
        let (text, size, bold, indent) = if let Some(rest) = line.trim_start().strip_prefix("### ") {
            (pdf_plain(rest), 12.0f32, true, 0.0)
        } else if let Some(rest) = line.trim_start().strip_prefix("## ") {
            (pdf_plain(rest), 13.0, true, 0.0)
        } else if let Some(rest) = line.trim_start().strip_prefix("# ") {
            (pdf_plain(rest), 15.0, true, 0.0)
        } else if let Some(rest) = line.trim_start().strip_prefix("- ") {
            (pdf_plain(&format!("- {rest}")), 11.0, false, 4.0)
        } else {
            (pdf_plain(line), 11.0, false, 0.0)
        };
        let max_chars = if size >= 15.0 { 48 } else if size >= 13.0 { 58 } else { 86 };
        let step = if size >= 15.0 { 7.0 } else if size >= 13.0 { 6.2 } else { 5.15 };
        if bold {
            y -= 1.6;
        }
        for piece in wrap_pdf(&text, max_chars) {
            if y < 18.0 {
                break_page(&mut pages, &mut y);
            }
            paint(&mut pages, &piece, size, 18.0 + indent, y, bold);
            y -= step;
        }
    }

    let total = pages.len();
    for (i, layer) in pages.iter_mut().enumerate() {
        layer.set_fill_color(muted.clone());
        layer.use_text(
            format!("{} / {}", i + 1, total),
            9.0,
            Mm(168.0),
            Mm(10.0),
            BuiltinFont::Helvetica,
        );
    }

    save_pdf(doc, pages, dest)
}

fn wrap_pdf(text: &str, max_chars: usize) -> Vec<String> {
    let max_chars = max_chars.max(8);
    let mut out = Vec::new();
    let mut cur = String::new();
    for word in text.split_whitespace() {
        if cur.is_empty() {
            cur = word.to_string();
        } else if cur.chars().count() + 1 + word.chars().count() <= max_chars {
            cur.push(' ');
            cur.push_str(word);
        } else {
            out.push(std::mem::take(&mut cur));
            cur = word.to_string();
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    if out.is_empty() {
        out.push(String::new());
    }
    out
}

/// Builtin PDF fonts are WinAnsi. Keep the prose readable when a symbol won't fit.
/// `c` as a character the builtin PDF fonts can show (WinAnsi), if there is one.
fn winansi_char(c: char) -> Option<char> {
    const TYPOGRAPHIC: &str = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ";
    match c {
        ' '..='~' | '\u{A0}'..='\u{FF}' => Some(c),
        _ if TYPOGRAPHIC.contains(c) => Some(c),
        'ő' => Some('ö'),
        'ű' => Some('ü'),
        'Ő' => Some('Ö'),
        'Ű' => Some('Ü'),
        '−' => Some('-'),
        '∙' | '⋅' => Some('·'),
        '≈' | '∼' => Some('~'),
        _ => None,
    }
}

/// Text for the builtin PDF fonts; characters they can't show become `?`.
fn pdf_text(text: &str) -> String {
    text.chars().map(|c| winansi_char(c).unwrap_or('?')).collect()
}

fn greek_name(c: char) -> Option<&'static str> {
    Some(match c {
        'α' => "alpha",
        'β' => "beta",
        'γ' => "gamma",
        'δ' => "delta",
        'ε' => "epsilon",
        'η' => "eta",
        'θ' => "theta",
        'κ' => "kappa",
        'λ' => "lambda",
        'μ' => "mu",
        'ν' => "nu",
        'ξ' => "xi",
        'π' => "pi",
        'ρ' => "rho",
        'σ' => "sigma",
        'τ' => "tau",
        'φ' => "phi",
        'χ' => "chi",
        'ψ' => "psi",
        'ω' => "omega",
        'Γ' => "Gamma",
        'Δ' => "Delta",
        'Θ' => "Theta",
        'Λ' => "Lambda",
        'Π' => "Pi",
        'Σ' => "Sigma",
        'Φ' => "Phi",
        'Ψ' => "Psi",
        'Ω' => "Omega",
        _ => return None,
    })
}

/// Summary text for the builtin fonts: Greek is spelled out, the rest of
/// what WinAnsi lacks gets a close ASCII stand-in or is dropped.
fn pdf_plain(text: &str) -> String {
    let mut out = String::new();
    let mut after_word = false;
    for c in text.chars() {
        if let Some(name) = greek_name(c) {
            if out.chars().last().is_some_and(|p| p.is_alphanumeric()) {
                out.push(' ');
            }
            out.push_str(name);
            after_word = true;
            continue;
        }
        let mapped: Option<&str> = match c {
            '≤' => Some("<="),
            '≥' => Some(">="),
            '≠' => Some("!="),
            '→' => Some("->"),
            '←' => Some("<-"),
            '∞' => Some("inf"),
            '√' => Some("sqrt"),
            '∂' => Some("d"),
            '∫' => Some("int"),
            '∑' => Some("sum"),
            '\n' | '\t' => Some(" "),
            _ => None,
        };
        let piece = match (mapped, winansi_char(c)) {
            (Some(s), _) => s.to_string(),
            (None, Some(w)) => w.to_string(),
            (None, None) => continue,
        };
        if after_word && piece.starts_with(|p: char| p.is_alphanumeric()) {
            out.push(' ');
        }
        after_word = false;
        out.push_str(&piece);
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Variable-width pen outline. Keep in step with `src/ink.ts`.
mod ink {
    const THINNING: f64 = 0.5;
    const CAP_STEPS: usize = 8;
    const MIN_RADIUS: f64 = 0.01;

    fn clamp01(p: f64) -> f64 {
        if !p.is_finite() {
            return 0.5;
        }
        p.clamp(0.0, 1.0)
    }

    fn stroke_radius(size: f64, pressure: f64) -> f64 {
        let p = clamp01(pressure);
        size * (0.5 - THINNING * (0.5 - p))
    }

    fn ease_start(t: f64) -> f64 {
        t * (2.0 - t)
    }

    fn ease_end(t: f64) -> f64 {
        let u = t - 1.0;
        u * u * u + 1.0
    }

    fn unit(dx: f64, dy: f64) -> (f64, f64) {
        let len = (dx * dx + dy * dy).sqrt();
        if len < 1e-9 {
            (1.0, 0.0)
        } else {
            (dx / len, dy / len)
        }
    }

    /// Semicircle from the left of `outward` around to the right, excluding the endpoints.
    fn semicircle(cx: f64, cy: f64, ox: f64, oy: f64, radius: f64) -> Vec<[f64; 2]> {
        let mid = oy.atan2(ox);
        let start = mid + std::f64::consts::PI / 2.0;
        let mut out = Vec::with_capacity(CAP_STEPS);
        let steps = CAP_STEPS as f64;
        for s in 1..CAP_STEPS {
            let a = start - (std::f64::consts::PI * s as f64) / steps;
            out.push([cx + a.cos() * radius, cy + a.sin() * radius]);
        }
        out
    }

    /// Filled polygon. Empty and single-point input return an empty vec. The ring repeats its first point.
    /// `taper_ends` pinches the stroke to a point and rounds the caps. Highlighter strokes pass false so the ends stay full width and square.
    pub fn stroke_outline(
        points: &[[f64; 2]],
        pressures: &[f64],
        base_width: f64,
        taper_ends: bool,
    ) -> Vec<[f64; 2]> {
        let n = points.len();
        if n < 2 || !(base_width > 0.0) {
            return Vec::new();
        }
        let mut run = vec![0.0; n];
        for i in 1..n {
            let dx = points[i][0] - points[i - 1][0];
            let dy = points[i][1] - points[i - 1][1];
            run[i] = run[i - 1] + (dx * dx + dy * dy).sqrt();
        }
        let total = run[n - 1];
        if !(total > 1e-6) {
            return Vec::new();
        }
        let taper = if taper_ends { base_width.min(total / 2.0) } else { 0.0 };
        let mut left = Vec::with_capacity(n);
        let mut right = Vec::with_capacity(n);
        let mut radii = Vec::with_capacity(n);
        for i in 0..n {
            let prev = points[i.saturating_sub(1)];
            let next = points[(i + 1).min(n - 1)];
            let (dx, dy) = unit(next[0] - prev[0], next[1] - prev[1]);
            let (px, py) = (-dy, dx);
            let p = if i < pressures.len() { clamp01(pressures[i]) } else { 0.5 };
            let mut radius = stroke_radius(base_width, p);
            let ts = if run[i] < taper { ease_start(run[i] / taper) } else { 1.0 };
            let te = if total - run[i] < taper {
                ease_end((total - run[i]) / taper)
            } else {
                1.0
            };
            radius = MIN_RADIUS.max(radius * ts.min(te));
            radii.push(radius);
            let (x, y) = (points[i][0], points[i][1]);
            left.push([x + px * radius, y + py * radius]);
            right.push([x - px * radius, y - py * radius]);
        }
        let mut poly = left;
        right.reverse();
        if taper_ends {
            let (edx, edy) = unit(
                points[n - 1][0] - points[n - 2][0],
                points[n - 1][1] - points[n - 2][1],
            );
            let (sdx, sdy) = unit(points[1][0] - points[0][0], points[1][1] - points[0][1]);
            poly.extend(semicircle(
                points[n - 1][0],
                points[n - 1][1],
                edx,
                edy,
                radii[n - 1],
            ));
            poly.extend(right);
            poly.extend(semicircle(points[0][0], points[0][1], -sdx, -sdy, radii[0]));
        } else {
            poly.extend(right);
        }
        if poly.len() < 3 {
            return Vec::new();
        }
        let first = poly[0];
        poly.push(first);
        poly
    }

    #[cfg(test)]
    mod tests {
        use super::stroke_outline;

        #[test]
        fn constant_pressure_stroke_is_a_closed_polygon() {
            let pts = [[0.0, 0.0], [10.0, 0.0], [20.0, 0.0], [30.0, 1.0]];
            let pressure = [0.5, 0.5, 0.5, 0.5];
            let poly = stroke_outline(&pts, &pressure, 4.0, true);
            assert!(poly.len() >= 8, "len {}", poly.len());
            let a = poly[0];
            let b = poly[poly.len() - 1];
            assert!((a[0] - b[0]).abs() < 1e-6 && (a[1] - b[1]).abs() < 1e-6);
            let min_y = poly.iter().map(|p| p[1]).fold(f64::INFINITY, f64::min);
            let max_y = poly.iter().map(|p| p[1]).fold(f64::NEG_INFINITY, f64::max);
            assert!(max_y > min_y + 1.0, "{min_y}..{max_y}");
        }

        #[test]
        fn empty_and_one_point_do_not_panic() {
            assert!(stroke_outline(&[], &[], 3.0, true).is_empty());
            assert!(stroke_outline(&[[1.0, 2.0]], &[1.0], 3.0, true).is_empty());
            assert!(stroke_outline(&[[1.0, 2.0]], &[], 3.0, true).is_empty());
            assert!(stroke_outline(&[[0.0, 0.0], [0.0, 0.0]], &[0.5, 0.5], 2.0, true).is_empty());
            assert!(stroke_outline(&[[0.0, 0.0], [1.0, 0.0]], &[], 0.0, true).is_empty());
        }

        #[test]
        fn highlighter_ends_are_square() {
            let poly = stroke_outline(&[[0.0, 0.0], [30.0, 0.0]], &[], 10.0, false);
            let max_x = poly.iter().map(|p| p[0]).fold(f64::NEG_INFINITY, f64::max);
            let min_x = poly.iter().map(|p| p[0]).fold(f64::INFINITY, f64::min);
            assert!(max_x < 30.5, "round cap would pass the end, max_x {max_x}");
            assert!(min_x > -0.5, "round cap would pass the start, min_x {min_x}");
        }
    }
}

fn draw_drawing(
    layer: &mut Layer,
    d: &crate::note::DrawingObject,
    map: &Mapper,
    scale: f64,
) {
    let thickness = |w: f64| ((w * scale * 0.75) as f32).max(0.3);
    match &d.item {
        DrawingItem::Stroke {
            points,
            width,
            color,
            highlighter,
            opacity,
            pressure,
            parts,
        } => {
            if *highlighter {
                let alpha = opacity.unwrap_or(0.4).clamp(0.15, 0.72);
                let softened = soften_marker(color, alpha);
                let mut rings = Vec::new();
                let mut runs: Vec<&Vec<[f64; 2]>> = Vec::new();
                if points.len() >= 2 {
                    runs.push(points);
                }
                for part in parts {
                    if part.len() >= 2 {
                        runs.push(part);
                    }
                }
                for run in runs {
                    let outline = ink::stroke_outline(run, &[], *width, false);
                    if outline.len() >= 3 {
                        rings.push(
                            outline
                                .into_iter()
                                .map(|p| map.point(d.x + p[0], d.y + p[1]))
                                .collect(),
                        );
                    }
                }
                if !rings.is_empty() {
                    let multiply = layer.multiply.clone();
                    if let Some(gs) = &multiply {
                        layer.ops.push(Op::SaveGraphicsState);
                        layer.ops.push(Op::LoadGraphicsState { gs: gs.clone() });
                    }
                    layer.set_fill_color(hex_color(&Some(softened)));
                    // One fill, so crossings of the same marker do not stack.
                    fill_rings(layer, rings);
                    if multiply.is_some() {
                        layer.ops.push(Op::RestoreGraphicsState);
                    }
                    return;
                }
            }
            if !*highlighter && points.len() >= 2 && !pressure.is_empty() {
                let outline = ink::stroke_outline(points, pressure, *width, true);
                if outline.len() >= 3 {
                    layer.set_fill_color(hex_color(&Some(color.clone())));
                    fill_polygon(
                        layer,
                        outline
                            .into_iter()
                            .map(|p| map.point(d.x + p[0], d.y + p[1]))
                            .collect(),
                    );
                    return;
                }
            }
            let multiply = layer.multiply.clone().filter(|_| *highlighter);
            if let Some(gs) = &multiply {
                layer.ops.push(Op::SaveGraphicsState);
                layer.ops.push(Op::LoadGraphicsState { gs: gs.clone() });
            }
            layer.set_outline_color(hex_color(&Some(color.clone())));
            layer.set_outline_thickness(thickness(*width));
            // Match canvas StrokeInk: round caps on pen, butt on highlighter.
            set_stroke_style(
                layer,
                if *highlighter {
                    LineCapStyle::Butt
                } else {
                    LineCapStyle::Round
                },
                LineJoinStyle::Round,
            );
            stroke_path(
                layer,
                points
                    .iter()
                    .map(|p| map.point(d.x + p[0], d.y + p[1]))
                    .collect(),
                false,
            );
            if multiply.is_some() {
                layer.ops.push(Op::RestoreGraphicsState);
            }
        }
        DrawingItem::Shape {
            shape,
            w,
            h,
            width,
            color,
            fill,
        } => {
            layer.set_outline_color(hex_color(&Some(color.clone())));
            layer.set_outline_thickness(thickness(*width));
            set_stroke_style(layer, LineCapStyle::Butt, LineJoinStyle::Miter);
            let pts: Vec<[f64; 2]> = match shape.as_str() {
                "ellipse" => ellipse_points(d.x + w / 2.0, d.y + h / 2.0, w / 2.0, h / 2.0),
                "triangle" => vec![
                    [d.x + w / 2.0, d.y],
                    [d.x + w, d.y + h],
                    [d.x, d.y + h],
                ],
                "diamond" => vec![
                    [d.x + w / 2.0, d.y],
                    [d.x + w, d.y + h / 2.0],
                    [d.x + w / 2.0, d.y + h],
                    [d.x, d.y + h / 2.0],
                ],
                _ => vec![
                    [d.x, d.y],
                    [d.x + w, d.y],
                    [d.x + w, d.y + h],
                    [d.x, d.y + h],
                ],
            };
            if let Some(f) = fill {
                layer.set_fill_color(hex_color(&Some(f.clone())));
                fill_polygon(layer, pts.iter().map(|p| map.point(p[0], p[1])).collect());
            }
            stroke_path(
                layer,
                pts.iter().map(|p| map.point(p[0], p[1])).collect(),
                true,
            );
        }
        DrawingItem::Arrow {
            tail,
            head,
            c1,
            c2,
            width,
            color,
            head_style,
            tail_style,
            body,
            shaft,
        } => {
            layer.set_outline_color(hex_color(&Some(color.clone())));
            set_stroke_style(layer, LineCapStyle::Round, LineJoinStyle::Round);
            let abs = |p: &[f64; 2]| [d.x + p[0], d.y + p[1]];
            let t = abs(tail);
            let a = abs(c1);
            let b = abs(c2);
            let h = abs(head);
            let double = body.as_deref() == Some("double");
            // Each line of a ⇒ body is half the stroke. The tip below uses the original width.
            layer.set_outline_thickness(thickness(if double { (*width * 0.5).max(0.6) } else { *width }));
            let chord = if shaft.len() >= 2 {
                let p0 = abs(&shaft[0]);
                let p1 = abs(shaft.last().unwrap_or(head));
                let (dx, dy) = (p1[0] - p0[0], p1[1] - p0[1]);
                (dx * dx + dy * dy).sqrt()
            } else {
                let (dx, dy) = (h[0] - t[0], h[1] - t[1]);
                (dx * dx + dy * dy).sqrt()
            };
            let reach = if head_style == "none" { 0.0 } else { arrow_reach(chord, *width) };
            let trim = if head_style == "open" { reach * 0.2 } else { reach * 0.62 };
            if shaft.len() >= 2 {
                let raw: Vec<[f64; 2]> = shaft.iter().map(|p| abs(p)).collect();
                let pts = trim_end(&raw, trim);
                let paint = |layer: &mut Layer, shift: [f64; 2]| {
                    stroke_path(
                        layer,
                        pts.iter().map(|p| map.point(p[0] + shift[0], p[1] + shift[1])).collect(),
                        false,
                    );
                };
                if double {
                    let gap = (*width * 1.05).max(2.6);
                    let (dx, dy) = (h[0] - t[0], h[1] - t[1]);
                    let len = (dx * dx + dy * dy).sqrt().max(0.001);
                    let (nx, ny) = (-dy / len * gap / 2.0, dx / len * gap / 2.0);
                    paint(layer, [nx, ny]);
                    paint(layer, [-nx, -ny]);
                } else {
                    paint(layer, [0.0, 0.0]);
                }
            } else if double {
                let gap = (*width * 1.05).max(2.6);
                let (dx, dy) = (h[0] - t[0], h[1] - t[1]);
                let len = (dx * dx + dy * dy).sqrt().max(0.001);
                let (nx, ny) = (-dy / len * gap / 2.0, dx / len * gap / 2.0);
                let end = pull_back(b, h, trim);
                for (sx, sy) in [(nx, ny), (-nx, -ny)] {
                    stroke_cubic(
                        layer,
                        map.point(t[0] + sx, t[1] + sy),
                        map.point(a[0] + sx, a[1] + sy),
                        map.point(b[0] + sx, b[1] + sy),
                        map.point(end[0] + sx, end[1] + sy),
                    );
                }
            } else {
                let end = pull_back(b, h, trim);
                stroke_cubic(
                    layer,
                    map.point(t[0], t[1]),
                    map.point(a[0], a[1]),
                    map.point(b[0], b[1]),
                    map.point(end[0], end[1]),
                );
            }
            if double {
                layer.set_outline_thickness(thickness(*width));
            }
            layer.set_fill_color(hex_color(&Some(color.clone())));
            // Aim along the end of the line, not the last tiny mouse segment.
            // The tail still uses the control point.
            let tip = if shaft.len() >= 2 {
                abs(shaft.last().unwrap_or(head))
            } else {
                h
            };
            if head_style != "none" {
                let from = if shaft.len() >= 2 {
                    let pts: Vec<[f64; 2]> = shaft.iter().map(|p| abs(p)).collect();
                    let back = aim_back(&pts);
                    directed_from(back, tip, pts[0])
                } else {
                    aim_along_tangent(b, h, t, chord)
                };
                arrow_head(layer, map, from, tip, *width, head_style, chord);
            }
            if tail_style != "none" {
                arrow_head(layer, map, a, t, *width, "full", chord);
            }
        }
    }
}

/// Same reach as frontend `arrowReach`. Width 2 ≈ 22.5px, width 8 = 4.5× the stroke.
fn arrow_reach(len: f64, width: f64) -> f64 {
    if !(len > 1.0) {
        return (width * 1.6).max(3.0);
    }
    let ideal = (18.0_f64).max(18.0 + width * 2.25).max(width * 4.5);
    ideal.min(len * 0.42)
}

/// Stable 0..1 wobble. Matches frontend `wobble` (floor, not Rust `fract`, so negatives stay in range).
fn wobble(seed: f64) -> f64 {
    let x = (seed * 12.9898).sin() * 43758.5453;
    x - x.floor()
}

/// Drop `dist` off the end of a polyline. Matches frontend `trimEnd`.
fn trim_end(pts: &[[f64; 2]], dist: f64) -> Vec<[f64; 2]> {
    if pts.len() < 2 || dist <= 0.5 {
        return pts.to_vec();
    }
    let mut out = pts.to_vec();
    let mut left = dist;
    while out.len() >= 2 && left > 0.0 {
        let a = out[out.len() - 2];
        let b = out[out.len() - 1];
        let dx = b[0] - a[0];
        let dy = b[1] - a[1];
        let seg = (dx * dx + dy * dy).sqrt();
        if seg > left + 0.01 {
            let t = (seg - left) / seg;
            let last = out.len() - 1;
            out[last] = [a[0] + dx * t, a[1] + dy * t];
            break;
        }
        left -= seg;
        out.pop();
    }
    if out.len() >= 2 { out } else { pts[..2].to_vec() }
}

/// Shorten a cubic's end along its end tangent (c2 → head) so the shaft stops inside the tip.
fn pull_back(anchor: [f64; 2], end: [f64; 2], dist: f64) -> [f64; 2] {
    if dist <= 0.5 {
        return end;
    }
    let dx = end[0] - anchor[0];
    let dy = end[1] - anchor[1];
    let len = (dx * dx + dy * dy).sqrt();
    if len < 0.001 {
        return end;
    }
    let d = dist.min(len * 0.85);
    let t = (len - d) / len;
    [anchor[0] + dx * t, anchor[1] + dy * t]
}

/// Look-back for a head. max(28px, min(80px, 18% of the shaft chord)).
/// A zero chord uses 1px, same as frontend `aimBack`, and still floors at 28.
fn arrow_aim_dist(chord: f64) -> f64 {
    let span = if chord > 0.0 { chord } else { 1.0 };
    (span * 0.18).min(80.0).max(28.0)
}

/// Vertex where the path from the tip has covered [`arrow_aim_dist`].
/// Matches frontend `aimBack`. A shorter shaft returns its first point.
fn aim_back(pts: &[[f64; 2]]) -> [f64; 2] {
    let n = pts.len();
    if n == 0 {
        return [0.0, 0.0];
    }
    if n == 1 {
        return pts[0];
    }
    let end = pts[n - 1];
    let start = pts[0];
    let dx = end[0] - start[0];
    let dy = end[1] - start[1];
    let need = arrow_aim_dist((dx * dx + dy * dy).sqrt());
    let mut walked = 0.0;
    for i in (0..n - 1).rev() {
        let a = pts[i];
        let b = pts[i + 1];
        let sx = b[0] - a[0];
        let sy = b[1] - a[1];
        walked += (sx * sx + sy * sy).sqrt();
        if walked >= need {
            return a;
        }
    }
    pts[0]
}

/// `from` for a bezier head: `need` back from `head` toward `c2`, staying on that segment.
/// A shaft shorter than 28px, or a vanishing tangent, uses `start` (the tail).
fn aim_along_tangent(c2: [f64; 2], head: [f64; 2], start: [f64; 2], chord: f64) -> [f64; 2] {
    if chord < 28.0 {
        return start;
    }
    let dx = head[0] - c2[0];
    let dy = head[1] - c2[1];
    let len = (dx * dx + dy * dy).sqrt();
    if len < 0.001 {
        return start;
    }
    let d = arrow_aim_dist(chord).min(len);
    let t = d / len;
    directed_from([head[0] - dx * t, head[1] - dy * t], head, start)
}

/// Keep a real direction. A look-back that landed on the tip falls back to `start`.
fn directed_from(back: [f64; 2], tip: [f64; 2], start: [f64; 2]) -> [f64; 2] {
    let dx = tip[0] - back[0];
    let dy = tip[1] - back[1];
    if dx * dx + dy * dy < 1.0e-6 { start } else { back }
}

/// Tip matching frontend `arrowHeadPoints`. `from` → `tip` is the pointing direction.
/// `shaft_len` is the whole shaft chord, so the head isn't sized off the last segment.
/// Open is two strokes. Drawn and full are filled. Legacy "arrow" stays the triangle.
fn arrow_head(
    layer: &mut Layer,
    map: &Mapper,
    from: [f64; 2],
    tip: [f64; 2],
    width: f64,
    style: &str,
    shaft_len: f64,
) {
    let dx = tip[0] - from[0];
    let dy = tip[1] - from[1];
    let seg = (dx * dx + dy * dy).sqrt();
    if seg < 0.001 {
        return;
    }
    let (ux, uy) = (dx / seg, dy / seg);
    let reach = arrow_reach(shaft_len.max(seg), width);
    let (px, py) = (-uy, ux);
    let at = |along: f64, side: f64| {
        [
            tip[0] + ux * along * reach + px * side * reach,
            tip[1] + uy * along * reach + py * side * reach,
        ]
    };
    let poly: Vec<[f64; 2]> = if style == "drawn" {
        // Blunt nose, long barb / short barb, concave notch. Same fractions as drawGeom.ts.
        const SKETCH: [(f64, f64); 15] = [
            (-0.05, 0.09),
            (-0.37, 0.31),
            (-0.65, 0.50),
            (-0.92, 0.58),
            (-0.96, 0.39),
            (-0.69, 0.21),
            (-0.48, 0.07),
            (-0.42, -0.04),
            (-0.61, -0.13),
            (-0.85, -0.25),
            (-0.88, -0.40),
            (-0.80, -0.42),
            (-0.53, -0.34),
            (-0.18, -0.19),
            (-0.01, -0.05),
        ];
        let s = tip[0] * 12.3 + tip[1] * 4.7 + from[0] * 0.3 + from[1];
        SKETCH
            .iter()
            .enumerate()
            .map(|(i, (along, side))| {
                let i = i as f64;
                let ja = (wobble(s + i * 2.2) - 0.5) * 0.08;
                let js = (wobble(s + i * 2.2 + 9.1) - 0.5) * 0.08;
                // Drawn tips only: narrow the perpendicular sketch. Along-shaft length stays.
                at(along + ja, (side + js) * 0.7)
            })
            .collect()
    } else {
        let wing = reach * if style == "open" { 0.48 } else { 0.44 };
        let base = at(-1.0, 0.0);
        vec![tip, [base[0] + px * wing, base[1] + py * wing], [base[0] - px * wing, base[1] - py * wing]]
    };
    if style == "open" {
        let left = poly[1];
        let right = poly[2];
        stroke_path(layer, vec![map.point(tip[0], tip[1]), map.point(left[0], left[1])], false);
        stroke_path(layer, vec![map.point(tip[0], tip[1]), map.point(right[0], right[1])], false);
        return;
    }
    fill_polygon(layer, poly.into_iter().map(|p| map.point(p[0], p[1])).collect());
}

#[derive(Debug, Clone, Serialize)]
pub struct PageRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// Page tops. A cut that would slice a text line, or an image or drawing that fits on a
/// page, moves up to just above it, but never by more than 40% of the page.
fn page_cuts(note: &NoteFile, top: f64, bottom: f64, first_span: f64, full_span: f64) -> Vec<f64> {
    let hidden = crate::note::collapsed_child_ids(&note.doc.canvas.objects);
    let mut lines: Vec<(f64, f64)> = Vec::new();
    let mut wholes: Vec<(f64, f64)> = Vec::new();
    for obj in &note.doc.canvas.objects {
        if hidden.contains(obj.id()) {
            continue;
        }
        match obj {
            CanvasObject::Text(t) => {
                for f in layout_text_object(t) {
                    if f.text.trim().is_empty() {
                        continue;
                    }
                    let y0 = f.y - f.size_pt * 0.95;
                    let y1 = y0 + f.size_pt * (96.0 / 72.0) * 1.35;
                    lines.push((y0, y1));
                }
            }
            CanvasObject::Image(_) | CanvasObject::Drawing(_) => {
                let (_, y, _, h) = obj.bbox();
                wholes.push((y, h));
            }
            _ => {}
        }
    }
    let mut cuts = vec![top];
    let mut y = top;
    let mut first = true;
    for _ in 0..200 {
        if bottom - y <= 0.5 {
            break;
        }
        let span = if first { first_span } else { full_span };
        first = false;
        let raw = y + span;
        if raw >= bottom - 0.5 {
            break;
        }
        let floor = raw - 0.4 * span;
        let mut best = raw;
        for (y0, y1) in &lines {
            if *y0 < raw && *y1 > raw && *y0 >= floor && *y0 < best {
                best = *y0;
            }
        }
        for (oy, h) in &wholes {
            if *h <= span && *oy < raw && *oy + *h > raw && *oy >= floor && *oy < best {
                best = *oy;
            }
        }
        if best <= y + 1.0 {
            best = raw;
        }
        cuts.push(best);
        y = best;
    }
    cuts
}

/// Content box for page cuts. Same union as `NoteFile::content_bbox`, but text
/// with no visible glyphs is skipped: `CanvasObject::bbox` gives every text box
/// 80px, so a blank one still stretched the page. Images, drawings, pdfs, and
/// non-empty text stay. A collapsed fold is only its marker.
fn page_content_bbox(note: &NoteFile) -> Option<(f64, f64, f64, f64)> {
    let hidden = crate::note::collapsed_child_ids(&note.doc.canvas.objects);
    let skips_empty_text = note.doc.canvas.objects.iter().any(|obj| {
        !hidden.contains(obj.id()) && matches!(obj, CanvasObject::Text(t) if text_content_empty(t))
    });
    // Nothing blank to ignore: the saved-note box is already the page box.
    if !skips_empty_text {
        return note.content_bbox();
    }
    let mut min_x = f64::INFINITY;
    let mut min_y = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    let mut max_y = f64::NEG_INFINITY;
    for obj in &note.doc.canvas.objects {
        if hidden.contains(obj.id()) {
            continue;
        }
        if let CanvasObject::Text(t) = obj {
            if text_content_empty(t) {
                continue;
            }
        }
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

/// No real content. Width fits the page (scale 1). Height stays strictly under the
/// titled first span — a fallback of `CONTENT_H_DIP` is one title-block too tall
/// and `page_cuts` opens a second, nearly empty page.
fn empty_pagination_bbox() -> (f64, f64, f64, f64) {
    let (first_span, _, _) = paginate_spans(0.0, 1.0, true);
    (0.0, 0.0, CONTENT_W_DIP, (first_span - 1.0).max(1.0))
}

/// Compute locked page rects for PDF Preview. Must match `export_pdf`.
pub fn compute_pages(note: &NoteFile) -> Vec<PageRect> {
    let (bx, by, bw, bh) = page_content_bbox(note).unwrap_or_else(empty_pagination_bbox);
    let scale = if bw > CONTENT_W_DIP {
        CONTENT_W_DIP / bw
    } else {
        1.0
    };
    let (first_span, full_span, _) = paginate_spans(bh, scale, true);
    let cuts = page_cuts(note, by, by + bh, first_span, full_span);
    let w = bw.max(CONTENT_W_DIP / scale);
    cuts.iter()
        .enumerate()
        .map(|(i, &y)| {
            let next = cuts.get(i + 1).copied().unwrap_or(by + bh);
            PageRect { x: bx, y, w, h: (next - y).max(1.0) }
        })
        .collect()
}

fn paginate_spans(bh: f64, scale: f64, with_title: bool) -> (f64, f64, usize) {
    let first_h = if with_title {
        CONTENT_H_DIP - TITLE_BLOCK_DIP
    } else {
        CONTENT_H_DIP
    };
    let first_span = first_h / scale;
    let full_span = CONTENT_H_DIP / scale;
    let n = if bh <= first_span {
        1
    } else {
        1 + ((bh - first_span) / full_span).ceil() as usize
    };
    (first_span, full_span, n.max(1))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::note::{Canvas, DrawingObject, ImageObject, NoteDocument, NoteMeta, TextObject};
    use std::collections::HashMap;

    fn note_with(objects: Vec<CanvasObject>, media: HashMap<String, Vec<u8>>) -> NoteFile {
        NoteFile {
            doc: NoteDocument {
                extra: Default::default(),
                format: "paperlike.note".into(),
                version: 1,
                meta: NoteMeta {
                    extra: Default::default(),
                    created: chrono::Utc::now(),
                    modified: chrono::Utc::now(),
                    app_version: "test".into(),
                },
                canvas: Canvas { extra: Default::default(), unknown_objects: Vec::new(), objects, paper: None },
            },
            media,
        }
    }

    fn run(text: &str) -> Run {
        Run {
            text: text.into(),
            ..Default::default()
        }
    }

    #[test]
    fn compute_pages_empty_note_is_one_page() {
        let empty = note_with(vec![], HashMap::new());
        assert_eq!(compute_pages(&empty).len(), 1, "note with no objects");

        let blank = note_with(
            vec![CanvasObject::Text(TextObject {
                locked: false,
                extra: Default::default(),
                id: "t_blank".into(),
                x: 48.0,
                y: 64.0,
                z: 1,
                width: 280.0,
                min_height: None,
                blocks: vec![Block::P(Paragraph {
                    extra: Default::default(),
                    indent: 0,
                    bullet: None,
                    align: "left".into(),
                    runs: vec![run("")],
                })],
            })],
            HashMap::new(),
        );
        assert_eq!(compute_pages(&blank).len(), 1, "only an empty text box");
    }

    #[test]
    fn pdf_export_includes_all_object_kinds() {
        let long = "The quick brown fox jumps over the lazy dog, repeatedly and at length. "
            .repeat(6);
        let text = CanvasObject::Text(TextObject {
            locked: false,
            extra: Default::default(),
            id: "t1".into(),
            x: 40.0,
            y: 40.0,
            z: 1,
            width: 320.0,
            min_height: None,
            blocks: vec![
                Block::P(Paragraph {
                    extra: Default::default(),
                    indent: 0,
                    bullet: None,
                    align: "left".into(),
                    runs: vec![
                        Run {
                            text: "Bold ".into(),
                            bold: true,
                            size: Some(18.0),
                            color: Some("#c0392b".into()),
                            ..Default::default()
                        },
                        run(&long),
                    ],
                }),
                Block::P(Paragraph {
                    extra: Default::default(),
                    indent: 1,
                    bullet: Some("disc".into()),
                    align: "left".into(),
                    runs: vec![run("a bulleted line")],
                }),
            ],
        });
        let arrow = CanvasObject::Drawing(DrawingObject {
            locked: false,
            extra: Default::default(),
            id: "d1".into(),
            x: 400.0,
            y: 60.0,
            z: 2,
            item: DrawingItem::Arrow {
                tail: [0.0, 0.0],
                head: [120.0, 90.0],
                c1: [40.0, 10.0],
                c2: [80.0, 80.0],
                width: 2.0,
                color: "#2d7a4f".into(),
                head_style: "arrow".into(),
                tail_style: "none".into(),
                body: None,
                shaft: Vec::new(),
            },
        });
        let stroke = CanvasObject::Drawing(DrawingObject {
            locked: false,
            extra: Default::default(),
            id: "d2".into(),
            x: 60.0,
            y: 400.0,
            z: 3,
            item: DrawingItem::Stroke {
                points: (0..40).map(|i| [i as f64 * 4.0, (i as f64).sin() * 20.0]).collect(),
                width: 3.0,
                color: "#333333".into(),
                highlighter: false,
                opacity: None,
                pressure: vec![],
                parts: vec![],
            },
        });
        let shape = CanvasObject::Drawing(DrawingObject {
            locked: false,
            extra: Default::default(),
            id: "d3".into(),
            x: 300.0,
            y: 400.0,
            z: 4,
            item: DrawingItem::Shape {
                shape: "ellipse".into(),
                w: 140.0,
                h: 90.0,
                width: 2.0,
                color: "#3355aa".into(),
                fill: None,
            },
        });

        // a tiny 2x2 PNG
        let mut png = Vec::new();
        {
            let img = image::RgbImage::from_fn(2, 2, |x, _| {
                if x == 0 {
                    image::Rgb([255, 0, 0])
                } else {
                    image::Rgb([0, 0, 255])
                }
            });
            image::DynamicImage::ImageRgb8(img)
                .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
                .unwrap();
        }
        let image_obj = CanvasObject::Image(ImageObject {
            locked: false,
            extra: Default::default(),
            id: "i1".into(),
            x: 500.0,
            y: 400.0,
            z: 5,
            media: "media/a.png".into(),
            width: 120.0,
            height: 80.0,
        });
        let mut media = HashMap::new();
        media.insert("media/a.png".to_string(), png);

        let marker = CanvasObject::Drawing(DrawingObject {
            locked: false,
            extra: Default::default(),
            id: "d4".into(),
            x: 60.0,
            y: 120.0,
            z: 6,
            item: DrawingItem::Stroke {
                points: vec![[0.0, 0.0], [200.0, 0.0]],
                width: 14.0,
                color: "#ffe066".into(),
                highlighter: true,
                opacity: None,
                pressure: vec![],
                parts: vec![],
            },
        });

        let note = note_with(vec![text, arrow, stroke, shape, image_obj, marker], media);
        let dir = std::env::temp_dir().join("paperlike_pdf_test");
        std::fs::create_dir_all(&dir).unwrap();
        let dest = dir.join("out.pdf");
        let opts = ExportOptions {
            format: "pdf".into(),
            page_numbers: true,
            title_header: Some("Test note".into()),
            export_date: true,
            geometry_block: false,
        };
        export_pdf(&[( &note, "Test note", opts.title_header.as_deref())], &dest, &opts).unwrap();

        let bytes = std::fs::read(&dest).unwrap();
        assert!(bytes.starts_with(b"%PDF"), "not a pdf");
        // text + vector paths + an embedded image should be well past a stub file
        assert!(bytes.len() > 3000, "pdf suspiciously small: {}", bytes.len());
        assert!(inked_pixels(&bytes) > 2000, "page 1 rendered nearly blank");
        let _ = std::fs::remove_file(dest);
    }

    /// Non-white pixels on page 1, as rendered by the Windows PDF engine.
    fn inked_pixels(pdf: &[u8]) -> usize {
        let png = crate::pdf_render::render_pdf_page(pdf, 1, 600).expect("pdf renders");
        let img = image::load_from_memory(&png).expect("render decodes").to_rgb8();
        img.pixels().filter(|p| p.0.iter().any(|&c| c < 200)).count()
    }

    #[test]
    fn summary_pdf_renders_text() {
        let dest = std::env::temp_dir().join("paperlike_summary_test.pdf");
        let body = "# Lift\n\nLift grows with α and with v².\n\n- Bernoulli: p + ½ρv² = const\n- Thin airfoil: c_l ≈ 2πα\n";
        write_summary_pdf("Aerodynamics — lift", &body.repeat(30), &dest).unwrap();
        let bytes = std::fs::read(&dest).unwrap();
        assert!(bytes.starts_with(b"%PDF"), "not a pdf");
        assert!(inked_pixels(&bytes) > 2000, "summary page rendered nearly blank");
        let _ = std::fs::remove_file(dest);
    }

    #[test]
    fn wrapping_produces_multiple_lines() {
        let p = Paragraph {
            extra: Default::default(),
            indent: 0,
            bullet: None,
            align: "left".into(),
            runs: vec![run(&"word ".repeat(60))],
        };
        let mut out = Vec::new();
        let end = layout_paragraph(&p, 0.0, 0.0, 200.0, &mut out);
        let distinct_lines: std::collections::BTreeSet<i64> =
            out.iter().map(|f| (f.y * 10.0) as i64).collect();
        assert!(distinct_lines.len() > 3, "expected wrapping, got {} lines", distinct_lines.len());
        assert!(end > 0.0);
    }

    #[test]
    fn md_export_uses_annotated_format() {
        let text = CanvasObject::Text(TextObject {
            locked: false,
            extra: Default::default(),
            id: "t1".into(),
            x: 40.0,
            y: 40.0,
            z: 1,
            width: 320.0,
            min_height: None,
            blocks: vec![
                Block::P(Paragraph {
                    extra: Default::default(),
                    indent: 0,
                    bullet: None,
                    align: "left".into(),
                    runs: vec![Run {
                        text: "Hello".into(),
                        bold: true,
                        size: Some(18.0),
                        color: Some("#c0392b".into()),
                        ..Default::default()
                    }],
                }),
                Block::P(Paragraph {
                    extra: Default::default(),
                    indent: 0,
                    bullet: None,
                    align: "left".into(),
                    runs: vec![run("body text at default size")],
                }),
                Block::P(Paragraph {
                    extra: Default::default(),
                    indent: 0,
                    bullet: None,
                    align: "left".into(),
                    runs: vec![run("more body")],
                }),
            ],
        });
        let note = note_with(vec![text], HashMap::new());
        let opts = ExportOptions {
            format: "md".into(),
            page_numbers: false,
            title_header: None,
            export_date: false,
            geometry_block: true,
        };
        let md = note_to_md(&note, "Hello note", &opts).unwrap();
        assert!(md.contains("<!--pl:doc v=1"));
        assert!(md.contains("<!--pl:text id=t1"));
        assert!(md.contains("label=\"Hello\""));
        assert!(md.contains("role=heading"));
        assert!(md.contains("<!--pl:palette"));
        assert!(md.contains("<span ow="));
        assert!(md.contains("c:red") || md.contains("c:#c0392b"));
        assert!(md.contains("<!--pl:geometry-->"));
        assert!(!md.contains("*[drawing]*"));
    }

    fn rt(id: &str, label: &str, x: f64, y: f64, w: f64, h: f64) -> RelTarget {
        RelTarget {
            id: id.into(),
            label: label.into(),
            x,
            y,
            w,
            h,
        }
    }

    #[test]
    fn rel_desc_prefers_edge_gap_over_center() {
        // Same-column neighbor A is farther in center-distance than diagonal B.
        let prev = vec![
            rt("a", "col", 0.0, 0.0, 100.0, 50.0),
            rt("b", "diag", 220.0, 80.0, 100.0, 50.0),
        ];
        let rel = rel_desc(0.0, 200.0, 100.0, 50.0, &prev);
        assert!(
            rel.contains("below a(col)"),
            "expected same-column neighbor, got {rel}"
        );
        assert!(!rel.contains("b(diag)") || rel.starts_with("below a"), "{rel}");
    }

    #[test]
    fn rel_labels_reference_first_line_text() {
        let a = CanvasObject::Text(TextObject {
            locked: false,
            extra: Default::default(),
            id: "t_a".into(),
            x: 40.0,
            y: 40.0,
            z: 1,
            width: 280.0,
            min_height: None,
            blocks: vec![Block::P(Paragraph {
                extra: Default::default(),
                indent: 0,
                bullet: None,
                align: "left".into(),
                runs: vec![run("Rocket equation")],
            })],
        });
        let b = CanvasObject::Text(TextObject {
            locked: false,
            extra: Default::default(),
            id: "t_b".into(),
            x: 40.0,
            y: 200.0,
            z: 2,
            width: 280.0,
            min_height: None,
            blocks: vec![Block::P(Paragraph {
                extra: Default::default(),
                indent: 0,
                bullet: None,
                align: "center".into(),
                runs: vec![run("Derivation")],
            })],
        });
        let note = note_with(vec![a, b], HashMap::new());
        let opts = ExportOptions {
            format: "md".into(),
            page_numbers: false,
            title_header: None,
            export_date: false,
            geometry_block: false,
        };
        let md = note_to_md(&note, "n", &opts).unwrap();
        assert!(
            md.contains("below t_a(Rocket equation)"),
            "missing labeled rel: {md}"
        );
        assert!(md.contains("<!--pl:align center-->"), "{md}");
        assert!(md.contains("label=\"Rocket equation\""));
    }

    #[test]
    fn overlaps_picks_largest_area_not_first() {
        let small = rt("small", "s", 40.0, 40.0, 20.0, 20.0);
        let large = rt("large", "L", 0.0, 0.0, 120.0, 120.0);
        let rel = rel_desc(50.0, 50.0, 40.0, 40.0, &[small, large]);
        assert_eq!(rel, "overlaps large(L)");
    }

    #[test]
    fn palette_assigns_friendly_names_only_when_close() {
        assert_eq!(nearest_named_color("#ff0000"), Some("red"));
        assert_eq!(nearest_named_color("#c0392b"), Some("red"));
        assert_eq!(nearest_named_color("#8f3cff"), None);
    }

    #[test]
    fn stroke_grouping_merges_nearby_same_color_strokes() {
        let mk = |id: &str, x: f64, y: f64| {
            CanvasObject::Drawing(DrawingObject {
                locked: false,
                extra: Default::default(),
                id: id.into(),
                x,
                y,
                z: 1,
                item: DrawingItem::Stroke {
                    points: vec![[0.0, 0.0], [8.0, 4.0], [16.0, 0.0]],
                    width: 2.0,
                    color: "#333333".into(),
                    highlighter: false,
                opacity: None,
                pressure: vec![],
                parts: vec![],
                },
            })
        };
        let note = note_with(vec![mk("d1", 10.0, 10.0), mk("d2", 20.0, 12.0), mk("d3", 28.0, 8.0)], HashMap::new());
        let opts = ExportOptions {
            format: "md".into(),
            page_numbers: false,
            title_header: None,
            export_date: false,
            geometry_block: false,
        };
        let md = note_to_md(&note, "n", &opts).unwrap();
        assert!(md.contains("kind=sketch n=3"), "{md}");
        let drawing_lines = md.matches("<!--pl:drawing").count();
        assert_eq!(drawing_lines, 1, "{md}");
    }

    #[test]
    fn drawing_encloses_detected_for_containing_shape() {
        let text = CanvasObject::Text(TextObject {
            locked: false,
            extra: Default::default(),
            id: "t1".into(),
            x: 40.0,
            y: 80.0,
            z: 1,
            width: 120.0,
            min_height: Some(40.0),
            blocks: vec![Block::P(Paragraph {
                extra: Default::default(),
                indent: 0,
                bullet: None,
                align: "left".into(),
                runs: vec![run("Important")],
            })],
        });
        let shape = CanvasObject::Drawing(DrawingObject {
            locked: false,
            extra: Default::default(),
            id: "d1".into(),
            x: 45.0,
            y: 60.0,
            z: 2,
            item: DrawingItem::Shape {
                shape: "ellipse".into(),
                w: 200.0,
                h: 160.0,
                width: 2.0,
                color: "#3355aa".into(),
                fill: None,
            },
        });
        let note = note_with(vec![text, shape], HashMap::new());
        let opts = ExportOptions {
            format: "md".into(),
            page_numbers: false,
            title_header: None,
            export_date: false,
            geometry_block: false,
        };
        let md = note_to_md(&note, "n", &opts).unwrap();
        assert!(md.contains("encloses=\"t1(Important)\""), "{md}");
        assert!(
            md.contains("color=blue") || md.contains("color=teal") || md.contains("color=#3355aa"),
            "{md}"
        );
    }

    fn sample_note() -> (NoteFile, Vec<u8>) {
        use crate::note::{TableBlock, TableCell, TableRow};
        let text = CanvasObject::Text(TextObject {
            locked: false,
            extra: Default::default(),
            id: "t1".into(),
            x: 40.0,
            y: 40.0,
            z: 1,
            width: 320.0,
            min_height: None,
            blocks: vec![
                Block::P(Paragraph {
                    extra: Default::default(),
                    indent: 0,
                    bullet: None,
                    align: "left".into(),
                    runs: vec![Run {
                        text: "Hello".into(),
                        bold: true,
                        size: Some(18.0),
                        color: Some("#c0392b".into()),
                        ..Default::default()
                    }],
                }),
                Block::P(Paragraph {
                    extra: Default::default(),
                    indent: 0,
                    bullet: None,
                    align: "center".into(),
                    runs: vec![run("Centered")],
                }),
                Block::P(Paragraph {
                    extra: Default::default(),
                    indent: 0,
                    bullet: Some("dash".into()),
                    align: "left".into(),
                    runs: vec![run("dash item")],
                }),
                Block::P(Paragraph {
                    extra: Default::default(),
                    indent: 1,
                    bullet: Some("dash".into()),
                    align: "left".into(),
                    runs: vec![run("nested")],
                }),
                Block::Table(TableBlock {
                    extra: Default::default(),
                    col_widths: vec![120.0, 180.0],
                    borders: true,
                    rows: vec![
                        TableRow {
                            extra: Default::default(),
                            cells: vec![
                                TableCell {
                                    extra: Default::default(),
                                    blocks: vec![Paragraph {
                                        extra: Default::default(),
                                        indent: 0,
                                        bullet: None,
                                        align: "left".into(),
                                        runs: vec![Run { text: "A".into(), bold: true, ..Default::default() }],
                                    }],
                                },
                                TableCell {
                                    extra: Default::default(),
                                    blocks: vec![Paragraph {
                                        extra: Default::default(),
                                        indent: 0,
                                        bullet: None,
                                        align: "left".into(),
                                        runs: vec![run("B")],
                                    }],
                                },
                            ],
                        },
                        TableRow {
                            extra: Default::default(),
                            cells: vec![
                                TableCell {
                                    extra: Default::default(),
                                    blocks: vec![Paragraph {
                                        extra: Default::default(),
                                        indent: 0,
                                        bullet: None,
                                        align: "left".into(),
                                        runs: vec![run("1")],
                                    }],
                                },
                                TableCell {
                                    extra: Default::default(),
                                    blocks: vec![Paragraph {
                                        extra: Default::default(),
                                        indent: 0,
                                        bullet: None,
                                        align: "left".into(),
                                        runs: vec![run("2")],
                                    }],
                                },
                            ],
                        },
                    ],
                }),
            ],
        });
        let arrow = CanvasObject::Drawing(DrawingObject {
            locked: false,
            extra: Default::default(),
            id: "d_arrow".into(),
            x: 400.0,
            y: 60.0,
            z: 2,
            item: DrawingItem::Arrow {
                tail: [0.0, 0.0],
                head: [120.0, 90.0],
                c1: [40.0, 10.0],
                c2: [80.0, 80.0],
                width: 2.0,
                color: "#2d7a4f".into(),
                head_style: "arrow".into(),
                tail_style: "none".into(),
                body: None,
                shaft: Vec::new(),
            },
        });
        let shape = CanvasObject::Drawing(DrawingObject {
            locked: false,
            extra: Default::default(),
            id: "d_shape".into(),
            x: 300.0,
            y: 400.0,
            z: 4,
            item: DrawingItem::Shape {
                shape: "ellipse".into(),
                w: 140.0,
                h: 90.0,
                width: 2.0,
                color: "#3355aa".into(),
                fill: Some("#ffeeaa".into()),
            },
        });
        let ink = CanvasObject::Drawing(DrawingObject {
            locked: false,
            extra: Default::default(),
            id: "d_ink".into(),
            x: 60.0,
            y: 520.0,
            z: 6,
            item: DrawingItem::Stroke {
                points: vec![[0.0, 0.0], [30.0, 10.0]],
                width: 14.0,
                color: "#ffe066".into(),
                highlighter: true,
                opacity: None,
                pressure: vec![],
                parts: vec![],
            },
        });
        let mut png = Vec::new();
        let img = image::RgbImage::from_fn(2, 2, |x, _| {
            if x == 0 { image::Rgb([255, 0, 0]) } else { image::Rgb([0, 0, 255]) }
        });
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .unwrap();
        let image_obj = CanvasObject::Image(ImageObject {
            locked: false,
            extra: Default::default(),
            id: "i1".into(),
            x: 40.0,
            y: 280.0,
            z: 5,
            media: "media/a.png".into(),
            width: 120.0,
            height: 80.0,
        });
        let mut media = HashMap::new();
        media.insert("media/a.png".to_string(), png.clone());
        (note_with(vec![text, arrow, shape, ink, image_obj], media), png)
    }

    fn obj<'a>(note: &'a NoteFile, id: &str) -> &'a CanvasObject {
        note.doc.canvas.objects.iter().find(|o| o.id() == id).unwrap_or_else(|| panic!("missing {id}"))
    }

    #[test]
    fn md_round_trip_restores_geometry_drawings_and_images() {
        let (note, png) = sample_note();
        let opts = ExportOptions {
            format: "md".into(),
            page_numbers: false,
            title_header: None,
            export_date: false,
            geometry_block: true,
        };
        let md = note_to_md(&note, "Round trip", &opts).unwrap();
        let imported = crate::md_import::parse_markdown(&md).unwrap();
        assert!(imported.warnings.is_empty(), "{:?}", imported.warnings);
        assert_eq!(imported.title.as_deref(), Some("Round trip"));
        assert_eq!(
            imported.note.doc.meta.created.format("%Y-%m-%d").to_string(),
            note.doc.meta.created.format("%Y-%m-%d").to_string()
        );

        let CanvasObject::Text(t) = obj(&imported.note, "t1") else { panic!("text") };
        assert_eq!(t.x, 40.0);
        assert_eq!(t.y, 40.0);
        assert_eq!(t.width, 320.0);
        let Block::P(hello) = &t.blocks[0] else { panic!("hello") };
        assert_eq!(hello.runs[0].text, "Hello");
        assert!(hello.runs[0].bold);
        assert_eq!(hello.runs[0].size, Some(18.0));
        assert_eq!(hello.runs[0].color.as_deref(), Some("#c0392b"));
        let Block::P(centered) = &t.blocks[1] else { panic!("center") };
        assert_eq!(centered.align, "center");
        assert_eq!(centered.runs[0].text, "Centered");
        let Block::P(dash) = &t.blocks[2] else { panic!("dash") };
        assert_eq!(dash.bullet.as_deref(), Some("dash"));
        assert_eq!(dash.runs[0].text, "dash item");
        let Block::P(nested) = &t.blocks[3] else { panic!("nested") };
        assert_eq!(nested.indent, 1);
        assert_eq!(nested.bullet.as_deref(), Some("dash"));
        let Block::Table(table) = &t.blocks[4] else { panic!("table") };
        assert_eq!(table.rows.len(), 2);
        assert!(table.rows[0].cells[0].blocks[0].runs[0].bold);
        assert_eq!(table.rows[0].cells[0].blocks[0].runs[0].text, "A");
        assert_eq!(table.rows[1].cells[1].blocks[0].runs[0].text, "2");

        let CanvasObject::Image(img) = obj(&imported.note, "i1") else { panic!("image") };
        assert_eq!(img.x, 40.0);
        assert_eq!(img.y, 280.0);
        assert_eq!(img.width, 120.0);
        assert_eq!(img.height, 80.0);
        assert_eq!(imported.note.media.get(&img.media).map(Vec::as_slice), Some(png.as_slice()));

        for id in ["d_arrow", "d_shape", "d_ink"] {
            let CanvasObject::Drawing(d) = obj(&imported.note, id) else { panic!("{id}") };
            let CanvasObject::Drawing(src) = obj(&note, id) else { panic!("src {id}") };
            assert_eq!(d.x, src.x);
            assert_eq!(d.y, src.y);
            assert_eq!(d.z, src.z);
            assert_eq!(serde_json::to_value(&d.item).unwrap(), serde_json::to_value(&src.item).unwrap());
        }
    }

    #[test]
    fn md_import_without_geometry_drops_drawings() {
        let (note, _) = sample_note();
        let opts = ExportOptions {
            format: "md".into(),
            page_numbers: false,
            title_header: None,
            export_date: false,
            geometry_block: false,
        };
        let md = note_to_md(&note, "Round trip", &opts).unwrap();
        let imported = crate::md_import::parse_markdown(&md).unwrap();
        let CanvasObject::Text(t) = obj(&imported.note, "t1") else { panic!("text") };
        assert_eq!(t.x, 48.0);
        assert_eq!(t.y, 48.0);
        assert_eq!(t.width, 480.0);
        let Block::P(hello) = &t.blocks[0] else { panic!("hello") };
        assert_eq!(hello.runs[0].text, "Hello");
        let CanvasObject::Image(img) = obj(&imported.note, "i1") else { panic!("image") };
        assert_eq!(img.width, 300.0);
        assert!(img.media.is_empty());
        assert!(imported.note.doc.canvas.objects.iter().all(|o| !matches!(o, CanvasObject::Drawing(_))));
        let msg = imported.warnings.join(" ");
        assert!(msg.contains("d_arrow") && msg.contains("d_shape") && msg.contains("d_ink") && msg.contains("i1"), "{msg}");
    }

    #[test]
    fn grouped_strokes_round_trip_from_geometry() {
        let mk = |id: &str, x: f64, y: f64| {
            CanvasObject::Drawing(DrawingObject {
                locked: false,
                extra: Default::default(),
                id: id.into(),
                x,
                y,
                z: 1,
                item: DrawingItem::Stroke {
                    points: vec![[0.0, 0.0], [8.0, 4.0], [16.0, 0.0]],
                    width: 2.0,
                    color: "#333333".into(),
                    highlighter: false,
                opacity: None,
                pressure: vec![],
                parts: vec![],
                },
            })
        };
        let note = note_with(vec![mk("d1", 10.0, 10.0), mk("d2", 20.0, 12.0), mk("d3", 28.0, 8.0)], HashMap::new());
        let opts = ExportOptions {
            format: "md".into(),
            page_numbers: false,
            title_header: None,
            export_date: false,
            geometry_block: true,
        };
        let md = note_to_md(&note, "sketch", &opts).unwrap();
        assert!(md.contains("kind=sketch n=3"), "{md}");
        let imported = crate::md_import::parse_markdown(&md).unwrap();
        assert!(imported.warnings.is_empty(), "{:?}", imported.warnings);
        assert_eq!(imported.note.doc.canvas.objects.len(), 3);
        for id in ["d1", "d2", "d3"] {
            let CanvasObject::Drawing(d) = obj(&imported.note, id) else { panic!("{id}") };
            let CanvasObject::Drawing(src) = obj(&note, id) else { panic!("src") };
            assert_eq!(serde_json::to_value(&d.item).unwrap(), serde_json::to_value(&src.item).unwrap());
            assert_eq!(d.x, src.x);
            assert_eq!(d.y, src.y);
        }
    }
}
