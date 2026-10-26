//! Import annotated Markdown back into a note. See specs/md.md §4.

use std::collections::{HashMap, HashSet};

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use chrono::{DateTime, NaiveDate, TimeZone, Utc};
use serde::Deserialize;
use serde_json::Value;

use crate::note::{
    Block, CanvasObject, DrawingItem, DrawingObject, ImageObject, NoteFile, Paragraph, Run, TableBlock,
    TableCell, TableRow, TextObject,
};

const COL_X: f64 = 48.0;
const COL_Y: f64 = 48.0;
const COL_GAP: f64 = 24.0;
const TEXT_W: f64 = 480.0;
const IMAGE_W: f64 = 300.0;
const IMAGE_H: f64 = 200.0;
const MARK_YELLOW: &str = "#fff59d";

#[derive(Debug)]
pub struct MarkdownImport {
    pub note: NoteFile,
    pub title: Option<String>,
    pub warnings: Vec<String>,
}

/// Filename stem: the `pl:doc` title when the file has one, otherwise the
/// source stem. Legacy `name.ai.md` drops the extra `.ai`.
pub fn import_stem(title: Option<&str>, src_stem: &str) -> String {
    if let Some(t) = title.map(str::trim).filter(|s| !s.is_empty()) {
        return t.to_string();
    }
    src_stem.strip_suffix(".ai").unwrap_or(src_stem).to_string()
}

pub fn parse_markdown(md: &str) -> Result<MarkdownImport, String> {
    let md = md.strip_prefix('\u{feff}').unwrap_or(md);
    let comments = scan_comments(md);
    if comments.is_empty() {
        return Ok(plain_note(md));
    }
    if !comments.iter().any(|c| c.kind == "doc") {
        return Err(
            "This Markdown file has Paperlike marks but no header, so it was not imported.".into(),
        );
    }

    let mut title: Option<String> = None;
    let mut created: Option<DateTime<Utc>> = None;
    let mut newer = false;
    let mut second_note = false;
    let mut seen_doc = false;
    let mut palette: HashMap<String, String> = HashMap::new();
    let mut geo = GeoParse::default();
    let mut geo_read = false;

    let mut built: Vec<Built> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut dropped: Vec<String> = Vec::new();
    let mut missing_pixels: Vec<String> = Vec::new();
    let mut pdfs: Vec<String> = Vec::new();

    let mut note = NoteFile::new_empty();

    let mut i = 0;
    while i < comments.len() {
        let kind = comments[i].kind.as_str();
        let attrs = &comments[i].attrs;
        let end = comments[i].end;
        match kind {
            "doc" => {
                if seen_doc {
                    second_note = true;
                    break;
                }
                seen_doc = true;
                if let Some(t) = attrs.get("note").map(|s| s.trim()).filter(|s| !s.is_empty()) {
                    title = Some(t.to_string());
                }
                if let Some(c) = attrs.get("created") {
                    created = parse_created(c);
                }
                if attrs.get("v").is_some_and(|v| v != "1") {
                    newer = true;
                }
            }
            "palette" => palette = parse_palette(attrs),
            "geometry" => {
                if !geo_read {
                    geo = parse_geometry_block(md, end);
                    geo_read = true;
                }
            }
            "edges" | "bullets" | "align" => {}
            "text" | "image" | "drawing" | "connector" | "pdf" => {
                let id = obj_id(attrs, id_prefix(kind));
                let next = next_object(&comments, i);
                if kind == "text" {
                    let body_end = next.map(|c| c.start).unwrap_or(md.len());
                    let body = trim_newlines(body_between(md, end, body_end, next.map(|c| c.kind.as_str())));
                    let blocks = parse_text_body(body, &palette);
                    if seen.insert(id.clone()) {
                        built.push(make_text(id, blocks));
                    }
                } else if kind == "image" {
                    if seen.insert(id.clone()) {
                        built.push(make_image(id, None));
                    }
                } else if kind == "pdf" {
                    push_unique(&mut pdfs, &id);
                } else if !seen.contains(&id) {
                    // Resolved after the geometry block is known.
                    push_unique(&mut dropped, &id);
                }
            }
            _ => {}
        }
        i += 1;
    }

    let failed: HashSet<String> = geo.failed.iter().cloned().collect();
    let by_id: HashMap<&str, &GeoObj> = geo.objects.iter().map(|g| (g.id.as_str(), g)).collect();

    // Body drawings were recorded as dropped before geometry was applied.
    // Keep only the ones the geometry block cannot restore.
    if !geo.broken {
        dropped.retain(|id| !failed.contains(id) && by_id.get(id.as_str()).and_then(|g| g.item.as_ref()).is_none());
    }

    for item in &mut built {
        let id = item.obj.id().to_string();
        if let Some(g) = by_id.get(id.as_str()) {
            apply_geo(item, g);
        }
        if let CanvasObject::Image(img) = &mut item.obj {
            let height_from_geo = by_id.get(img.id.as_str()).and_then(|g| g.h).is_some();
            if let Some(png) = by_id.get(img.id.as_str()).and_then(|g| png_of(g)) {
                if let Some(pixels) = store_png(&mut note, png) {
                    apply_pixels(img, &pixels, height_from_geo);
                }
            }
            if img.media.is_empty() {
                push_unique(&mut missing_pixels, &img.id);
            }
        }
    }

    for g in &geo.objects {
        if !seen.insert(g.id.clone()) {
            continue;
        }
        if g.pdf {
            push_unique(&mut pdfs, &g.id);
            continue;
        }
        if g.item.is_some() {
            built.push(drawing_from_geo(g));
            continue;
        }
        if g.is_image {
            let mut image = make_image(g.id.clone(), None);
            apply_geo(&mut image, g);
            if let Some(png) = png_of(g) {
                if let CanvasObject::Image(img) = &mut image.obj {
                    if let Some(pixels) = store_png(&mut note, png) {
                        apply_pixels(img, &pixels, g.h.is_some());
                    }
                }
            }
            if let CanvasObject::Image(img) = &image.obj {
                if img.media.is_empty() {
                    push_unique(&mut missing_pixels, &img.id);
                }
            }
            built.push(image);
            continue;
        }
        built.push(make_text(g.id.clone(), Vec::new()));
        if let Some(last) = built.last_mut() {
            apply_geo(last, g);
        }
    }

    layout_unplaced(&mut built);
    built.sort_by_key(|b| b.obj.z());
    note.doc.canvas.objects = built.into_iter().map(|b| b.obj).collect();
    if let Some(dt) = created {
        note.doc.meta.created = dt;
    }

    let mut warnings = Vec::new();
    if newer {
        warnings.push(
            "This file uses a newer Paperlike Markdown version. Some parts may be missing.".into(),
        );
    }
    if second_note {
        warnings.push("Only the first note in this file was imported.".into());
    }
    if geo.broken {
        let mut msg =
            "The geometry block could not be read, so positions and drawings may be missing."
                .to_string();
        if !dropped.is_empty() {
            msg.push_str(" Drawings left out: ");
            msg.push_str(&dropped.join(", "));
            msg.push('.');
        }
        warnings.push(msg);
    } else if !dropped.is_empty() {
        warnings.push(format!(
            "These drawings were not imported because this file has no geometry for them: {}",
            dropped.join(", ")
        ));
    }
    if !failed.is_empty() {
        let mut ids: Vec<_> = failed.iter().cloned().collect();
        ids.sort();
        warnings.push(format!("Could not read drawing {}.", ids.join(", ")));
    }
    if !missing_pixels.is_empty() {
        warnings.push(format!(
            "These images have no picture data. Export with the geometry block to keep the pixels: {}",
            missing_pixels.join(", ")
        ));
    }
    if !pdfs.is_empty() {
        warnings.push(format!(
            "PDF objects were not imported because Markdown does not contain the file: {}",
            pdfs.join(", ")
        ));
    }

    Ok(MarkdownImport { note, title, warnings })
}

fn plain_note(md: &str) -> MarkdownImport {
    let mut note = NoteFile::new_empty();
    let text = md.trim();
    if !text.is_empty() {
        note.doc.canvas.objects.push(
            make_text(
                "t1".into(),
                vec![paragraph(vec![Run { text: text.into(), ..Run::default() }], 0, None, "left")],
            )
            .obj,
        );
        if let CanvasObject::Text(t) = &mut note.doc.canvas.objects[0] {
            t.x = COL_X;
            t.y = COL_Y;
            t.z = 1;
        }
    }
    MarkdownImport { note, title: None, warnings: Vec::new() }
}

struct Built {
    obj: CanvasObject,
    placed: bool,
    z_set: bool,
}

fn id_prefix(kind: &str) -> char {
    match kind {
        "image" => 'i',
        "drawing" | "connector" => 'd',
        "pdf" => 'p',
        _ => 't',
    }
}

fn obj_id(attrs: &HashMap<String, String>, prefix: char) -> String {
    attrs
        .get("id")
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| crate::note::new_id(prefix))
}

fn make_text(id: String, blocks: Vec<Block>) -> Built {
    let blocks = if blocks.is_empty() { vec![empty_paragraph()] } else { blocks };
    Built {
        obj: CanvasObject::Text(TextObject {
            id,
            x: 0.0,
            y: 0.0,
            z: 0,
            width: TEXT_W,
            min_height: None,
            blocks,
            locked: false,
            extra: Default::default(),
        }),
        placed: false,
        z_set: false,
    }
}

fn make_image(id: String, media: Option<String>) -> Built {
    Built {
        obj: CanvasObject::Image(ImageObject {
            id,
            x: 0.0,
            y: 0.0,
            z: 0,
            media: media.unwrap_or_default(),
            width: IMAGE_W,
            height: IMAGE_H,
            locked: false,
            extra: Default::default(),
        }),
        placed: false,
        z_set: false,
    }
}

fn drawing_from_geo(g: &GeoObj) -> Built {
    let mut built = Built {
        obj: CanvasObject::Drawing(DrawingObject {
            id: g.id.clone(),
            x: 0.0,
            y: 0.0,
            z: 0,
            item: g.item.clone().unwrap_or(DrawingItem::Stroke {
                points: vec![[0.0, 0.0], [1.0, 1.0]],
                width: 2.0,
                color: "#333333".into(),
                highlighter: false,
                opacity: None,
                pressure: vec![],
                parts: vec![],
            }),
            locked: false,
            extra: Default::default(),
        }),
        placed: false,
        z_set: false,
    };
    apply_geo(&mut built, g);
    built
}

fn apply_geo(built: &mut Built, g: &GeoObj) {
    let (x, y) = match (g.x, g.y) {
        (Some(x), Some(y)) => {
            built.placed = true;
            (Some(x), Some(y))
        }
        _ => (None, None),
    };
    if g.z.is_some() {
        built.z_set = true;
    }
    match &mut built.obj {
        CanvasObject::Text(t) => {
            if let (Some(x), Some(y)) = (x, y) {
                t.x = x;
                t.y = y;
            }
            if let Some(z) = g.z {
                t.z = z;
            }
            if let Some(w) = g.w.filter(|w| w.is_finite() && *w > 0.0) {
                t.width = w;
            }
        }
        CanvasObject::Image(img) => {
            if let (Some(x), Some(y)) = (x, y) {
                img.x = x;
                img.y = y;
            }
            if let Some(z) = g.z {
                img.z = z;
            }
            if let Some(w) = g.w.filter(|w| w.is_finite() && *w > 0.0) {
                img.width = w;
            }
            if let Some(h) = g.h.filter(|h| h.is_finite() && *h > 0.0) {
                img.height = h;
            }
        }
        CanvasObject::Drawing(d) => {
            if let (Some(x), Some(y)) = (x, y) {
                d.x = x;
                d.y = y;
            }
            if let Some(z) = g.z {
                d.z = z;
            }
        }
        CanvasObject::Group(o) => {
            if let (Some(x), Some(y)) = (x, y) {
                o.x = x;
                o.y = y;
            }
            if let Some(z) = g.z {
                o.z = z;
            }
        }
        CanvasObject::Pdf(o) => {
            if let (Some(x), Some(y)) = (x, y) {
                o.x = x;
                o.y = y;
            }
            if let Some(z) = g.z {
                o.z = z;
            }
        }
    }
}

fn apply_pixels(img: &mut ImageObject, pixels: &Pixels, height_from_geo: bool) {
    img.media = pixels.path.clone();
    if !height_from_geo {
        if let (Some(nw), Some(nh)) = (pixels.width, pixels.height) {
            if nw > 0.0 {
                img.height = (img.width * nh / nw).max(1.0);
            }
        }
    }
}

fn layout_unplaced(built: &mut [Built]) {
    let mut bottom: Option<f64> = None;
    for b in built.iter() {
        if !b.placed {
            continue;
        }
        let (_, y, _, _) = b.obj.bbox();
        let edge = y + stack_height(&b.obj);
        bottom = Some(bottom.map(|m| m.max(edge)).unwrap_or(edge));
    }
    let mut y = bottom.map(|b| b + COL_GAP).unwrap_or(COL_Y);
    let mut next_z = built.iter().filter(|b| b.z_set).map(|b| b.obj.z()).max().unwrap_or(0);
    for b in built.iter_mut() {
        if !b.z_set {
            next_z += 1;
            set_z(&mut b.obj, next_z);
        }
        if !b.placed {
            set_xy(&mut b.obj, COL_X, y);
            y += stack_height(&b.obj) + COL_GAP;
        }
    }
}

fn stack_height(obj: &CanvasObject) -> f64 {
    match obj {
        CanvasObject::Text(t) => crate::export::text_object_height(t),
        CanvasObject::Image(img) => img.height.max(1.0),
        _ => obj.bbox().3.max(1.0),
    }
}

fn set_xy(obj: &mut CanvasObject, x: f64, y: f64) {
    match obj {
        CanvasObject::Text(o) => {
            o.x = x;
            o.y = y;
        }
        CanvasObject::Image(o) => {
            o.x = x;
            o.y = y;
        }
        CanvasObject::Drawing(o) => {
            o.x = x;
            o.y = y;
        }
        CanvasObject::Group(o) => {
            o.x = x;
            o.y = y;
        }
        CanvasObject::Pdf(o) => {
            o.x = x;
            o.y = y;
        }
    }
}

fn set_z(obj: &mut CanvasObject, z: i32) {
    match obj {
        CanvasObject::Text(o) => o.z = z,
        CanvasObject::Image(o) => o.z = z,
        CanvasObject::Drawing(o) => o.z = z,
        CanvasObject::Group(o) => o.z = z,
        CanvasObject::Pdf(o) => o.z = z,
    }
}

struct Pixels {
    path: String,
    width: Option<f64>,
    height: Option<f64>,
}

fn store_png(note: &mut NoteFile, b64: &str) -> Option<Pixels> {
    let cleaned: String = b64.chars().filter(|c| !c.is_whitespace()).collect();
    if cleaned.is_empty() {
        return None;
    }
    let bytes = B64.decode(cleaned).ok()?;
    if bytes.is_empty() {
        return None;
    }
    let (width, height) = image::load_from_memory(&bytes)
        .ok()
        .map(|img| (Some(img.width() as f64), Some(img.height() as f64)))
        .unwrap_or((None, None));
    let path = crate::note::media_hash_name(&bytes, sniff_ext(&bytes));
    note.media.insert(path.clone(), bytes);
    Some(Pixels { path, width, height })
}

fn sniff_ext(bytes: &[u8]) -> &'static str {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        "png"
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        "jpg"
    } else if bytes.starts_with(b"GIF") {
        "gif"
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        "webp"
    } else if bytes.starts_with(b"BM") {
        "bmp"
    } else {
        "png"
    }
}

fn png_of(g: &GeoObj) -> Option<&str> {
    g.png.as_deref().map(str::trim).filter(|s| !s.is_empty())
}

#[derive(Default)]
struct GeoParse {
    objects: Vec<GeoObj>,
    failed: Vec<String>,
    broken: bool,
}

#[derive(Clone)]
struct GeoObj {
    id: String,
    x: Option<f64>,
    y: Option<f64>,
    z: Option<i32>,
    w: Option<f64>,
    h: Option<f64>,
    png: Option<String>,
    item: Option<DrawingItem>,
    is_image: bool,
    pdf: bool,
}

#[derive(Deserialize)]
struct GeoFile {
    #[serde(default)]
    objects: Vec<Value>,
}

fn parse_geometry_block(md: &str, from: usize) -> GeoParse {
    let Some(json) = geometry_json(md, from) else {
        return GeoParse { broken: true, ..GeoParse::default() };
    };
    let Ok(file) = serde_json::from_str::<GeoFile>(json) else {
        return GeoParse { broken: true, ..GeoParse::default() };
    };
    let mut objects = Vec::new();
    let mut failed = Vec::new();
    for v in file.objects {
        match geo_from_value(&v) {
            Ok(obj) => objects.push(obj),
            Err(id) => {
                if !id.is_empty() {
                    failed.push(id);
                }
            }
        }
    }
    GeoParse { objects, failed, broken: false }
}

fn geometry_json(md: &str, from: usize) -> Option<&str> {
    let rest = md.get(from..)?.trim_start();
    let rest = rest.strip_prefix("```pl-geo")?;
    let rest = rest.trim_start_matches(['\r', '\n']);
    let end = rest.find("```")?;
    let json = rest[..end].trim();
    if json.is_empty() {
        None
    } else {
        Some(json)
    }
}

fn geo_from_value(v: &Value) -> Result<GeoObj, String> {
    let id = v.get("id").and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
    if id.is_empty() {
        return Err(String::new());
    }
    let item = if let Some(raw) = v.get("item") {
        match serde_json::from_value(raw.clone()) {
            Ok(item) => Some(item),
            Err(_) => return Err(id),
        }
    } else {
        None
    };
    Ok(GeoObj {
        id,
        x: num(v, "x"),
        y: num(v, "y"),
        z: num_i(v, "z"),
        w: num(v, "w"),
        h: num(v, "h"),
        png: v.get("png").and_then(|p| p.as_str()).map(|s| s.to_string()),
        item,
        is_image: v.get("png").is_some(),
        pdf: v.get("type").and_then(|t| t.as_str()) == Some("pdf"),
    })
}

fn num(v: &Value, key: &str) -> Option<f64> {
    v.get(key).and_then(|n| n.as_f64()).filter(|n| n.is_finite())
}

fn num_i(v: &Value, key: &str) -> Option<i32> {
    let n = v.get(key)?;
    if let Some(i) = n.as_i64() {
        return Some(i as i32);
    }
    n.as_f64().filter(|f| f.is_finite()).map(|f| f as i32)
}

struct PlComment {
    kind: String,
    attrs: HashMap<String, String>,
    start: usize,
    end: usize,
}

fn is_object_kind(kind: &str) -> bool {
    matches!(
        kind,
        "text" | "image" | "drawing" | "connector" | "pdf" | "edges" | "geometry" | "doc"
    )
}

fn next_object(comments: &[PlComment], index: usize) -> Option<&PlComment> {
    comments.iter().skip(index + 1).find(|c| is_object_kind(&c.kind))
}

fn scan_comments(md: &str) -> Vec<PlComment> {
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(rel) = md[from..].find("<!--pl:") {
        let start = from + rel;
        let head = start + "<!--pl:".len();
        let after = &md[head..];
        let kind_len = after.find(|c: char| !c.is_ascii_alphanumeric()).unwrap_or(after.len());
        if kind_len == 0 {
            from = head;
            continue;
        }
        let kind = after[..kind_len].to_ascii_lowercase();
        let attrs_from = head + kind_len;
        let Some(end_rel) = md[attrs_from..].find("-->") else {
            break;
        };
        let attrs_to = attrs_from + end_rel;
        let attrs = parse_attrs(&md[attrs_from..attrs_to]);
        let end = attrs_to + 3;
        out.push(PlComment { kind, attrs, start, end });
        from = end;
    }
    out
}

fn parse_attrs(s: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let mut rest = s;
    while !rest.is_empty() {
        rest = rest.trim_start();
        if rest.is_empty() {
            break;
        }
        let Some(eq) = rest.find('=') else {
            break;
        };
        let key = &rest[..eq];
        if key.is_empty()
            || key.chars().any(|c| c.is_whitespace())
            || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        {
            let mut chars = rest.chars();
            chars.next();
            rest = chars.as_str();
            continue;
        }
        let key = key.to_string();
        rest = &rest[eq + 1..];
        if rest.starts_with('"') || rest.starts_with('\'') {
            let q = rest.chars().next().unwrap();
            rest = &rest[q.len_utf8()..];
            if let Some(end) = rest.find(q) {
                map.insert(key, rest[..end].to_string());
                rest = &rest[end + q.len_utf8()..];
            } else {
                map.insert(key, rest.to_string());
                break;
            }
        } else {
            let mut end = rest.len();
            let mut i = 0;
            while i < rest.len() {
                if rest.as_bytes()[i].is_ascii_whitespace() && looks_like_key_eq(rest[i..].trim_start()) {
                    end = i;
                    break;
                }
                let ch = rest[i..].chars().next().unwrap();
                i += ch.len_utf8();
            }
            map.insert(key, rest[..end].trim().to_string());
            rest = &rest[end..];
        }
    }
    map
}

fn looks_like_key_eq(s: &str) -> bool {
    let Some(eq) = s.find('=') else {
        return false;
    };
    let key = &s[..eq];
    !key.is_empty() && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn parse_palette(attrs: &HashMap<String, String>) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for (k, v) in attrs {
        if !(k.starts_with('c') || k.starts_with('h')) {
            continue;
        }
        let Some((hex, name)) = v.rsplit_once(':') else {
            continue;
        };
        let name = name.trim().to_ascii_lowercase();
        if name.is_empty() {
            continue;
        }
        let hex = normalize_hex(hex).unwrap_or_else(|| hex.trim().to_string());
        map.entry(name).or_insert(hex);
    }
    map
}

fn parse_created(s: &str) -> Option<DateTime<Utc>> {
    let s = s.trim();
    if let Ok(dt) = DateTime::parse_from_rfc3339(s) {
        return Some(dt.with_timezone(&Utc));
    }
    let date = NaiveDate::parse_from_str(s, "%Y-%m-%d").ok()?;
    let naive = date.and_hms_opt(0, 0, 0)?;
    Some(Utc.from_utc_datetime(&naive))
}

fn body_between<'a>(md: &'a str, from: usize, to: usize, next_kind: Option<&str>) -> &'a str {
    let mut body = md.get(from..to).unwrap_or("");
    if next_kind == Some("doc") {
        if let Some(i) = body.rfind("\n---\n") {
            body = &body[..i];
        }
    }
    body
}

fn trim_newlines(body: &str) -> &str {
    body.trim_start_matches(['\n', '\r']).trim_end_matches(['\n', '\r', ' ', '\t'])
}

fn parse_text_body(body: &str, palette: &HashMap<String, String>) -> Vec<Block> {
    let lines: Vec<&str> = body.split('\n').map(|l| l.trim_end_matches('\r')).collect();
    let mut blocks = Vec::new();
    let mut bullet_style: Option<String> = None;
    let mut pending_align: Option<String> = None;
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        if line.trim().is_empty() {
            i += 1;
            continue;
        }
        if let Some(style) = pl_tag(line, "bullets") {
            bullet_style = Some(if style.is_empty() { "disc".into() } else { style.to_string() });
            i += 1;
            continue;
        }
        if let Some(align) = pl_tag(line, "align") {
            pending_align = Some(if align.is_empty() { "left".into() } else { align.to_string() });
            i += 1;
            continue;
        }
        if line.trim().starts_with("<!--pl:") {
            i += 1;
            continue;
        }
        if is_table_line(line) {
            let start = i;
            while i < lines.len() && is_table_line(lines[i]) {
                i += 1;
            }
            if let Some(table) = parse_table(&lines[start..i], palette) {
                blocks.push(Block::Table(table));
            }
            bullet_style = None;
            pending_align = None;
            continue;
        }
        let (indent, rest) = split_indent(line);
        let align = pending_align.take().unwrap_or_else(|| "left".into());
        if let Some(content) = rest.strip_prefix("- ") {
            let style = bullet_style.clone().unwrap_or_else(|| "disc".into());
            blocks.push(paragraph(parse_inlines(content, &Style::default(), palette), indent, Some(style), &align));
        } else {
            bullet_style = None;
            blocks.push(paragraph(parse_inlines(rest, &Style::default(), palette), indent, None, &align));
        }
        i += 1;
    }
    blocks
}

fn pl_tag<'a>(line: &'a str, kind: &str) -> Option<&'a str> {
    let t = line.trim();
    let open = format!("<!--pl:{kind}");
    let rest = t.strip_prefix(&open)?.trim_start();
    Some(rest.strip_suffix("-->")?.trim())
}

fn split_indent(line: &str) -> (u8, &str) {
    let spaces = line.chars().take_while(|c| *c == ' ').count();
    let indent = (spaces / 2) as u8;
    (indent, &line[indent as usize * 2..])
}

fn is_table_line(line: &str) -> bool {
    let t = line.trim_start();
    t.starts_with('|') && t.matches('|').count() >= 2
}

fn parse_table(lines: &[&str], palette: &HashMap<String, String>) -> Option<TableBlock> {
    let mut rows = Vec::new();
    let mut cols = 0usize;
    for line in lines {
        let cells = split_cells(line);
        if !cells.is_empty() && cells.iter().all(|c| is_sep_cell(c)) {
            continue;
        }
        cols = cols.max(cells.len());
        rows.push(cells);
    }
    if rows.is_empty() || cols == 0 {
        return None;
    }
    let rows = rows
        .into_iter()
        .map(|cells| {
            let mut padded = cells;
            padded.resize(cols, String::new());
            TableRow {
                cells: padded
                    .into_iter()
                    .map(|cell| TableCell {
                        blocks: split_br(&cell)
                            .into_iter()
                            .map(|part| Paragraph {
                                indent: 0,
                                bullet: None,
                                align: "left".into(),
                                runs: {
                                    let runs = parse_inlines(part, &Style::default(), palette);
                                    if runs.is_empty() { vec![Run::default()] } else { runs }
                                },
                                extra: Default::default(),
                            })
                            .collect(),
                        extra: Default::default(),
                    })
                    .collect(),
                extra: Default::default(),
            }
        })
        .collect();
    Some(TableBlock {
        col_widths: vec![120.0; cols],
        rows,
        borders: true,
        extra: Default::default(),
    })
}

fn split_cells(line: &str) -> Vec<String> {
    let t = line.trim().trim_start_matches('|').trim_end_matches('|');
    t.split('|').map(|c| c.trim().to_string()).collect()
}

fn is_sep_cell(cell: &str) -> bool {
    let c = cell.trim().trim_matches(':');
    !c.is_empty() && c.chars().all(|ch| ch == '-')
}

fn split_br(cell: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut rest = cell;
    while let Some(i) = rest.find("<br") {
        out.push(&rest[..i]);
        let after = &rest[i + 3..];
        let after = after.trim_start();
        let after = after.strip_prefix('/').unwrap_or(after).trim_start();
        rest = after.strip_prefix('>').unwrap_or(after);
    }
    out.push(rest);
    if out.is_empty() {
        vec![cell]
    } else {
        out
    }
}

fn paragraph(mut runs: Vec<Run>, indent: u8, bullet: Option<String>, align: &str) -> Block {
    if runs.is_empty() {
        runs.push(Run::default());
    }
    Block::P(Paragraph {
        indent,
        bullet,
        align: align.into(),
        runs,
        extra: Default::default(),
    })
}

fn empty_paragraph() -> Block {
    paragraph(Vec::new(), 0, None, "left")
}

#[derive(Clone)]
struct Style {
    bold: bool,
    italic: bool,
    underline: bool,
    strike: bool,
    sub: bool,
    sup: bool,
    math: bool,
    font: Option<String>,
    size: Option<f64>,
    color: Option<String>,
    hl: Option<String>,
}

impl Default for Style {
    fn default() -> Self {
        Self {
            bold: false,
            italic: false,
            underline: false,
            strike: false,
            sub: false,
            sup: false,
            math: false,
            font: None,
            size: None,
            color: None,
            hl: None,
        }
    }
}

fn parse_inlines(input: &str, style: &Style, palette: &HashMap<String, String>) -> Vec<Run> {
    parse_inlines_depth(input, style, palette, 0)
}

fn parse_inlines_depth(input: &str, style: &Style, palette: &HashMap<String, String>, depth: u32) -> Vec<Run> {
    if depth > 32 {
        return vec![run_from(style, input)];
    }
    let mut out = Vec::new();
    let mut rest = input;
    while !rest.is_empty() {
        if let Some((ow, inner, after)) = take_span(rest) {
            let mut child = style.clone();
            apply_ow(&mut child, ow, palette);
            out.extend(parse_inlines_depth(inner, &child, palette, depth + 1));
            rest = after;
            continue;
        }
        if let Some((inner, after)) = take_tag(rest, "mark") {
            let mut child = style.clone();
            if child.hl.is_none() {
                child.hl = Some(palette.get("yellow").cloned().unwrap_or_else(|| MARK_YELLOW.into()));
            }
            out.extend(parse_inlines_depth(inner, &child, palette, depth + 1));
            rest = after;
            continue;
        }
        if let Some((inner, after, flag)) = take_flag_tag(rest) {
            let mut child = style.clone();
            match flag {
                Flag::Underline => child.underline = true,
                Flag::Sub => child.sub = true,
                Flag::Sup => child.sup = true,
            }
            out.extend(parse_inlines_depth(inner, &child, palette, depth + 1));
            rest = after;
            continue;
        }
        if let Some(after) = strip_br(rest) {
            push_run(&mut out, style, "\n");
            rest = after;
            continue;
        }
        if let Some((inner, after)) = take_delim(rest, "***") {
            let mut child = style.clone();
            child.bold = true;
            child.italic = true;
            out.extend(parse_inlines_depth(inner, &child, palette, depth + 1));
            rest = after;
            continue;
        }
        if let Some((inner, after)) = take_delim(rest, "**") {
            let mut child = style.clone();
            child.bold = true;
            out.extend(parse_inlines_depth(inner, &child, palette, depth + 1));
            rest = after;
            continue;
        }
        if let Some((inner, after)) = take_delim(rest, "~~") {
            let mut child = style.clone();
            child.strike = true;
            out.extend(parse_inlines_depth(inner, &child, palette, depth + 1));
            rest = after;
            continue;
        }
        if let Some((inner, after)) = take_delim(rest, "*") {
            let mut child = style.clone();
            child.italic = true;
            out.extend(parse_inlines_depth(inner, &child, palette, depth + 1));
            rest = after;
            continue;
        }
        if let Some((inner, after)) = take_delim(rest, "$") {
            if !inner.is_empty() && !inner.contains('\n') {
                let mut child = style.clone();
                child.math = true;
                push_run(&mut out, &child, inner);
                rest = after;
                continue;
            }
        }
        let end = rest.find(['<', '*', '~', '$']).unwrap_or(rest.len());
        if end == 0 {
            let ch = rest.chars().next().unwrap();
            push_run(&mut out, style, &ch.to_string());
            rest = &rest[ch.len_utf8()..];
        } else {
            push_run(&mut out, style, &rest[..end]);
            rest = &rest[end..];
        }
    }
    out
}

enum Flag {
    Underline,
    Sub,
    Sup,
}

fn take_flag_tag<'a>(s: &'a str) -> Option<(&'a str, &'a str, Flag)> {
    if let Some((inner, after)) = take_tag(s, "u") {
        return Some((inner, after, Flag::Underline));
    }
    if let Some((inner, after)) = take_tag(s, "sub") {
        return Some((inner, after, Flag::Sub));
    }
    if let Some((inner, after)) = take_tag(s, "sup") {
        return Some((inner, after, Flag::Sup));
    }
    None
}

fn take_tag<'a>(s: &'a str, tag: &str) -> Option<(&'a str, &'a str)> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let inner_src = s.strip_prefix(&open)?;
    let end = inner_src.find(&close)?;
    Some((&inner_src[..end], &inner_src[end + close.len()..]))
}

fn take_span<'a>(s: &'a str) -> Option<(&'a str, &'a str, &'a str)> {
    let rest = s.strip_prefix("<span")?;
    let rest = rest.trim_start();
    let rest = rest.strip_prefix("ow=")?;
    let q = rest.chars().next()?;
    if q != '"' && q != '\'' {
        return None;
    }
    let rest = &rest[q.len_utf8()..];
    let end = rest.find(q)?;
    let ow = &rest[..end];
    let rest = rest[end + q.len_utf8()..].trim_start();
    let rest = rest.strip_prefix('>')?;
    let close = rest.find("</span>")?;
    Some((ow, &rest[..close], &rest[close + "</span>".len()..]))
}

fn take_delim<'a>(s: &'a str, delim: &str) -> Option<(&'a str, &'a str)> {
    let inner = s.strip_prefix(delim)?;
    if delim == "*" && inner.starts_with('*') {
        return None;
    }
    let end = inner.find(delim)?;
    if delim == "*" && inner[end..].starts_with("**") {
        return None;
    }
    Some((&inner[..end], &inner[end + delim.len()..]))
}

fn strip_br(s: &str) -> Option<&str> {
    let rest = s.strip_prefix("<br")?;
    let rest = rest.trim_start();
    let rest = rest.strip_prefix('/').unwrap_or(rest).trim_start();
    rest.strip_prefix('>')
}

fn apply_ow(style: &mut Style, ow: &str, palette: &HashMap<String, String>) {
    for part in ow.split(';') {
        let Some((k, v)) = part.split_once(':') else {
            continue;
        };
        let v = v.trim();
        if v.is_empty() {
            continue;
        }
        match k.trim() {
            "f" => style.font = Some(v.to_string()),
            "s" => style.size = v.parse().ok(),
            "c" if v.eq_ignore_ascii_case("auto") => style.color = None,
            "c" => style.color = Some(resolve_color(v, palette)),
            "h" => style.hl = Some(resolve_color(v, palette)),
            _ => {}
        }
    }
}

fn resolve_color(token: &str, palette: &HashMap<String, String>) -> String {
    let t = token.trim();
    if let Some(hex) = palette.get(&t.to_ascii_lowercase()) {
        return hex.clone();
    }
    if t.starts_with('#') {
        return normalize_hex(t).unwrap_or_else(|| t.to_string());
    }
    if let Some(hex) = crate::export::named_color_hex(t) {
        return hex;
    }
    if t.chars().all(|c| c.is_ascii_hexdigit()) && (t.len() == 3 || t.len() == 6) {
        if let Some(hex) = normalize_hex(&format!("#{t}")) {
            return hex;
        }
    }
    t.to_string()
}

fn normalize_hex(hex: &str) -> Option<String> {
    let h = hex.trim().trim_start_matches('#');
    let h = if h.len() == 3 {
        let b = h.as_bytes();
        if b.len() != 3 {
            return None;
        }
        format!(
            "{}{}{}{}{}{}",
            b[0] as char, b[0] as char, b[1] as char, b[1] as char, b[2] as char, b[2] as char
        )
    } else {
        h.to_string()
    };
    if h.len() != 6 || !h.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    Some(format!("#{}", h.to_ascii_lowercase()))
}

fn push_run(out: &mut Vec<Run>, style: &Style, text: &str) {
    if text.is_empty() {
        return;
    }
    if let Some(last) = out.last_mut() {
        if !last.math && !style.math && same_style(last, style) {
            last.text.push_str(text);
            return;
        }
    }
    out.push(run_from(style, text));
}

fn same_style(run: &Run, style: &Style) -> bool {
    run.bold == style.bold
        && run.italic == style.italic
        && run.underline == style.underline
        && run.strike == style.strike
        && run.sub == style.sub
        && run.sup == style.sup
        && run.math == style.math
        && run.font == style.font
        && run.size == style.size
        && run.color == style.color
        && run.hl == style.hl
}

fn run_from(style: &Style, text: &str) -> Run {
    Run {
        text: text.into(),
        bold: style.bold,
        italic: style.italic,
        underline: style.underline,
        strike: style.strike,
        sub: style.sub,
        sup: style.sup,
        font: style.font.clone(),
        size: style.size,
        color: style.color.clone(),
        hl: style.hl.clone(),
        math: style.math,
        extra: Default::default(),
    }
}

fn push_unique(ids: &mut Vec<String>, id: &str) {
    if !id.is_empty() && !ids.iter().any(|x| x == id) {
        ids.push(id.to_string());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::note::DrawingItem;
    use base64::{engine::general_purpose::STANDARD as B64, Engine};

    fn text_named<'a>(note: &'a NoteFile, id: &str) -> &'a TextObject {
        match note.doc.canvas.objects.iter().find(|o| o.id() == id) {
            Some(CanvasObject::Text(t)) => t,
            _ => panic!("missing text {id}"),
        }
    }

    #[test]
    fn attrs_keep_unquoted_labels() {
        let attrs = parse_attrs(
            r#"id=d_c4 rel="overlaps t_a1(Rocket equation)" from=t_a1(Rocket equation) to=t_b2(Derivation) tail="480,90" head="520,200" color=green"#,
        );
        assert_eq!(attrs.get("id").map(String::as_str), Some("d_c4"));
        assert_eq!(attrs.get("rel").map(String::as_str), Some("overlaps t_a1(Rocket equation)"));
        assert_eq!(attrs.get("from").map(String::as_str), Some("t_a1(Rocket equation)"));
        assert_eq!(attrs.get("to").map(String::as_str), Some("t_b2(Derivation)"));
        assert_eq!(attrs.get("tail").map(String::as_str), Some("480,90"));
        assert_eq!(attrs.get("color").map(String::as_str), Some("green"));
    }

    #[test]
    fn plain_markdown_is_one_window() {
        let got = parse_markdown("# Title\n\nHello").unwrap();
        assert!(got.title.is_none());
        assert!(got.warnings.is_empty());
        assert_eq!(got.note.doc.canvas.objects.len(), 1);
        let t = text_named(&got.note, "t1");
        let text = match &t.blocks[0] {
            Block::P(p) => &p.runs[0].text,
            _ => panic!("paragraph"),
        };
        assert!(text.contains("Hello"));
        assert_eq!(t.x, 48.0);
        assert_eq!(t.width, 480.0);
    }

    #[test]
    fn marks_without_a_header_are_refused() {
        let err = parse_markdown("<!--pl:text id=a-->\nHi\n").unwrap_err();
        assert!(err.contains("header"), "{err}");
    }

    #[test]
    fn fallback_stacks_text_and_drops_drawings() {
        let md = "\
<!--pl:doc v=1 note=\"Col\" created=2026-01-02-->
<!--pl:text id=a-->
One

<!--pl:text id=b-->
Two

<!--pl:image id=i1-->
![x.png](media ref: i1)

<!--pl:drawing id=d1 kind=ellipse color=blue-->

<!--pl:connector id=d2 tail=\"1,2\" head=\"3,4\" color=green-->
";
        let got = parse_markdown(md).unwrap();
        assert_eq!(got.title.as_deref(), Some("Col"));
        assert_eq!(got.note.doc.meta.created.format("%Y-%m-%d").to_string(), "2026-01-02");
        let a = text_named(&got.note, "a");
        let b = text_named(&got.note, "b");
        assert_eq!(a.x, 48.0);
        assert_eq!(a.y, 48.0);
        assert_eq!(a.width, 480.0);
        assert_eq!(b.x, 48.0);
        assert_eq!(b.width, 480.0);
        let expect_b = 48.0 + crate::export::text_object_height(a) + 24.0;
        assert!((b.y - expect_b).abs() < 0.01, "b.y {} vs {expect_b}", b.y);
        let img = match got.note.doc.canvas.objects.iter().find(|o| o.id() == "i1") {
            Some(CanvasObject::Image(img)) => img,
            _ => panic!("missing image"),
        };
        assert_eq!(img.width, 300.0);
        assert_eq!(img.x, 48.0);
        assert!(img.media.is_empty());
        assert!(got.note.doc.canvas.objects.iter().all(|o| !matches!(o, CanvasObject::Drawing(_))));
        let msg = got.warnings.join(" ");
        assert!(msg.contains("d1") && msg.contains("d2") && msg.contains("i1"), "{msg}");
    }

    #[test]
    fn geometry_restores_styles_pixels_and_sketch_strokes() {
        let mut png = Vec::new();
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
        let b64 = B64.encode(&png);
        let shape = serde_json::to_value(DrawingItem::Shape {
            shape: "ellipse".into(),
            w: 140.0,
            h: 90.0,
            width: 2.0,
            color: "#3355aa".into(),
            fill: None,
        })
        .unwrap();
        let stroke = serde_json::to_value(DrawingItem::Stroke {
            points: vec![[0.0, 0.0], [8.0, 4.0]],
            width: 2.0,
            color: "#333333".into(),
            highlighter: false,
                opacity: None,
                pressure: vec![],
                parts: vec![],
        })
        .unwrap();
        let json = serde_json::json!({
            "v": 1,
            "objects": [
                {"id": "t1", "x": 120.0, "y": 80.0, "z": 1, "w": 340.0},
                {"id": "i1", "x": 100.0, "y": 420.0, "z": 2, "w": 300.0, "h": 180.0, "png": b64},
                {"id": "d1", "x": 10.0, "y": 10.0, "z": 3, "item": shape},
                {"id": "d2", "x": 20.0, "y": 12.0, "z": 4, "item": stroke}
            ]
        });
        let header = "\
<!--pl:doc v=1 note=\"Rocket\" created=2026-08-08-->
<!--pl:palette c1=\"#c0392b:red\" h1=\"#fff59d:yellow\"-->
<!--pl:text id=t1 label=\"Hello\" rel=\"top-left\" size=medium-->
<span ow=\"s:18;c:red\">**Hello**</span> <u>under</u> ~~gone~~ <sub>2</sub><sup>3</sup> $E=mc^2$

<span ow=\"h:yellow\"><mark>hi</mark></span>

<!--pl:align center-->
Centered

<!--pl:image id=i1-->
![diagram.png](media ref: i1)

<!--pl:drawing id=d1 label=\"sketch\" kind=sketch n=2 color=gray-->
";
        let md = format!("{header}\n<!--pl:geometry-->\n```pl-geo\n{json}\n```\n");
        let got = parse_markdown(&md).unwrap();
        assert!(got.warnings.is_empty(), "{:?}", got.warnings);
        assert_eq!(got.title.as_deref(), Some("Rocket"));
        let t = text_named(&got.note, "t1");
        assert_eq!(t.x, 120.0);
        assert_eq!(t.y, 80.0);
        assert_eq!(t.width, 340.0);
        let Block::P(hello) = &t.blocks[0] else { panic!("p") };
        assert_eq!(hello.runs[0].text, "Hello");
        assert!(hello.runs[0].bold);
        assert_eq!(hello.runs[0].size, Some(18.0));
        assert_eq!(hello.runs[0].color.as_deref(), Some("#c0392b"));
        assert_eq!(hello.runs[2].text, "under");
        assert!(hello.runs[2].underline);
        assert_eq!(hello.runs[4].text, "gone");
        assert!(hello.runs[4].strike);
        assert!(hello.runs[6].sub && hello.runs[6].text == "2");
        assert!(hello.runs[7].sup && hello.runs[7].text == "3");
        assert!(hello.runs[9].math && hello.runs[9].text == "E=mc^2");
        let Block::P(marked) = &t.blocks[1] else { panic!("mark") };
        assert_eq!(marked.runs[0].text, "hi");
        assert_eq!(marked.runs[0].hl.as_deref(), Some("#fff59d"));
        let Block::P(centered) = &t.blocks[2] else { panic!("center") };
        assert_eq!(centered.align, "center");
        let img = match got.note.doc.canvas.objects.iter().find(|o| o.id() == "i1") {
            Some(CanvasObject::Image(img)) => img,
            _ => panic!("image"),
        };
        assert_eq!(img.x, 100.0);
        assert_eq!(img.y, 420.0);
        assert_eq!(img.width, 300.0);
        assert_eq!(img.height, 180.0);
        assert_eq!(got.note.media.get(&img.media).map(Vec::as_slice), Some(png.as_slice()));
        let drawings: Vec<_> = got
            .note
            .doc
            .canvas
            .objects
            .iter()
            .filter(|o| matches!(o, CanvasObject::Drawing(_)))
            .collect();
        assert_eq!(drawings.len(), 2);
        assert!(drawings.iter().any(|o| o.id() == "d2"));
    }

    #[test]
    fn stem_prefers_the_doc_title() {
        assert_eq!(import_stem(Some("Rocket"), "foo.ai"), "Rocket");
        assert_eq!(import_stem(None, "foo.ai"), "foo");
        assert_eq!(import_stem(Some("  "), "Notes"), "Notes");
    }

    #[test]
    fn only_the_first_note_of_a_merged_file_is_imported() {
        let md = "\
<!--pl:doc v=1 note=\"First\" created=2026-01-01-->
<!--pl:text id=a-->
Alpha

---

# Second

<!--pl:doc v=1 note=\"Second\" created=2026-02-02-->
<!--pl:text id=b-->
Beta
";
        let got = parse_markdown(md).unwrap();
        assert_eq!(got.title.as_deref(), Some("First"));
        assert!(got.note.doc.canvas.objects.iter().any(|o| o.id() == "a"));
        assert!(got.note.doc.canvas.objects.iter().all(|o| o.id() != "b"));
        assert!(got.warnings.iter().any(|w| w.contains("first note")));
    }
}
