//! Notebook folder + `.notebook_data` — specs/file-formats.md §2

use std::collections::HashSet;
use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::atomic;
use crate::naming;
use crate::note::{self, NoteFile};

pub const NOTEBOOK_DATA: &str = ".notebook_data";
pub const NOTEBOOK_FORMAT: &str = "paperlike-notebook";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct NotebookData {
    pub format: String,
    pub version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cover: Option<Cover>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub separators: Option<Separators>,
    /// Moodle course id for the course browser. Absent on notebooks that have not been linked.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub moodle_course_id: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Cover {
    pub png_base64: String,
    pub hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Separators {
    #[serde(default)]
    pub name: Vec<SeparatorEntry>,
    #[serde(default)]
    pub name_desc: Vec<SeparatorEntry>,
    #[serde(default)]
    pub created: Vec<SeparatorEntry>,
    #[serde(default)]
    pub created_desc: Vec<SeparatorEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SeparatorEntry {
    pub after: String,
    /// Stable id so several separators can sit on the same note. Empty on older notebooks.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub id: String,
    /// Shown in small caps on the line. Empty means a bare rule.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteListItem {
    pub path: String,
    pub title: String,
    pub display_title: String,
    pub created: String,
    pub modified: String,
    pub empty_named: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotebookInfo {
    pub path: String,
    pub name: String,
    pub description: Option<String>,
    pub cover_png_base64: Option<String>,
    pub notes: Vec<NoteListItem>,
    pub separators: Separators,
}

pub fn is_notebook(path: &Path) -> bool {
    path.is_dir() && path.join(NOTEBOOK_DATA).is_file()
}

pub fn load_notebook_data(path: &Path) -> Result<NotebookData> {
    let p = path.join(NOTEBOOK_DATA);
    let s = atomic::read_to_string(&p)?;
    let mut data: NotebookData = serde_json::from_str(&s)?;
    if data.format.is_empty() {
        data.format = NOTEBOOK_FORMAT.into();
    }
    Ok(data)
}

pub fn save_notebook_data(path: &Path, data: &NotebookData) -> Result<()> {
    let mut data = data.clone();
    data.format = NOTEBOOK_FORMAT.into();
    if data.version == 0 {
        data.version = 1;
    }
    let json = serde_json::to_string_pretty(&data)?;
    let p = path.join(NOTEBOOK_DATA);
    atomic::atomic_write_string(&p, &json, true)?;
    #[cfg(windows)]
    {
        winattr::hide(&p);
    }
    Ok(())
}

pub fn get_moodle_course_id(path: &Path) -> Result<Option<i64>> {
    let data = load_notebook_data(path)?;
    Ok(data.moodle_course_id.filter(|id| *id > 0))
}

pub fn set_moodle_course_id(path: &Path, course_id: Option<i64>) -> Result<()> {
    let mut data = load_notebook_data(path)?;
    data.moodle_course_id = course_id.filter(|id| *id > 0);
    save_notebook_data(path, &data)
}

pub fn ensure_notebook(path: &Path) -> Result<()> {
    if !path.is_dir() {
        bail!("not a directory");
    }
    let p = path.join(NOTEBOOK_DATA);
    if !p.exists() {
        let data = NotebookData {
            format: NOTEBOOK_FORMAT.into(),
            version: 1,
            description: None,
            cover: None,
            separators: Some(Separators::default()),
            moodle_course_id: None,
        };
        save_notebook_data(path, &data)?;
    }
    Ok(())
}

pub fn list_notes(notebook_path: &Path) -> Result<Vec<NoteListItem>> {
    let mut items = Vec::new();
    for entry in fs::read_dir(notebook_path)? {
        let entry = entry?;
        let p = entry.path();
        if p.extension().and_then(|e| e.to_str()) != Some("note") {
            continue;
        }
        let stem = p
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let (created, modified) = match note::load_note_document(&p) {
            Ok(doc) => (
                note::ts_rfc3339(doc.meta.created),
                note::ts_rfc3339(doc.meta.modified),
            ),
            Err(_) => {
                let meta = entry.metadata().ok();
                let created = meta
                    .as_ref()
                    .and_then(|m| m.created().ok())
                    .map(|t| {
                        let dt: chrono::DateTime<chrono::Utc> = t.into();
                        note::ts_rfc3339(dt)
                    })
                    .unwrap_or_default();
                (created.clone(), created)
            }
        };
        items.push(NoteListItem {
            path: p.to_string_lossy().to_string(),
            title: stem.clone(),
            display_title: naming::display_title(&stem),
            created,
            modified,
            empty_named: naming::is_empty_named(&stem),
        });
    }
    Ok(items)
}

pub fn open_notebook(path: &Path) -> Result<NotebookInfo> {
    if !is_notebook(path) {
        bail!("not a notebook (missing .notebook_data)");
    }
    let data = load_notebook_data(path)?;
    let notes = list_notes(path)?;
    Ok(NotebookInfo {
        path: path.to_string_lossy().to_string(),
        name: path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default(),
        description: data.description,
        cover_png_base64: data.cover.map(|c| c.png_base64),
        notes,
        separators: data.separators.unwrap_or_default(),
    })
}

pub fn create_note_in_notebook(notebook_path: &Path) -> Result<NoteListItem> {
    ensure_notebook(notebook_path)?;
    let path = naming::next_untitled_path(notebook_path);
    let mut note = NoteFile::new_empty();
    note::save_note(&path, &mut note)?;
    let stem = path.file_stem().unwrap().to_string_lossy().to_string();
    Ok(NoteListItem {
        path: path.to_string_lossy().to_string(),
        title: stem.clone(),
        display_title: String::new(),
        created: note::ts_rfc3339(note.doc.meta.created),
        modified: note::ts_rfc3339(note.doc.meta.modified),
        empty_named: true,
    })
}

pub fn rename_note(path: &Path, new_title: &str) -> Result<String> {
    let dir = path.parent().context("no parent")?;
    let stem = naming::sanitize_title(new_title);
    let dest = if stem == path.file_stem().unwrap().to_string_lossy() {
        path.to_path_buf()
    } else {
        naming::unique_note_path(dir, &stem)
    };
    if dest != path {
        fs::rename(path, &dest)?;
        // Update separator refs
        {
            let nb = dir;
            if is_notebook(nb) {
                if let Ok(mut data) = load_notebook_data(nb) {
                    let old = path.file_stem().unwrap().to_string_lossy().to_string();
                    let new = dest.file_stem().unwrap().to_string_lossy().to_string();
                    if let Some(seps) = data.separators.as_mut() {
                        for list in [
                            &mut seps.name,
                            &mut seps.name_desc,
                            &mut seps.created,
                            &mut seps.created_desc,
                        ] {
                            for e in list.iter_mut() {
                                if e.after == old {
                                    e.after = new.clone();
                                }
                            }
                        }
                    }
                    let _ = save_notebook_data(nb, &data);
                }
            }
        }
    }
    Ok(dest.to_string_lossy().to_string())
}

pub fn set_cover(notebook_path: &Path, image_bytes: &[u8], icons_dir: &Path) -> Result<()> {
    let img = image::load_from_memory(image_bytes).context("decode cover image")?;
    let img = img.thumbnail(512, 512);
    let mut png_buf = Vec::new();
    {
        let mut cursor = std::io::Cursor::new(&mut png_buf);
        img.write_to(&mut cursor, image::ImageFormat::Png)?;
    }
    let mut hasher = Sha256::new();
    hasher.update(&png_buf);
    let hash = crate::atomic::hex(&hasher.finalize());
    let hash16 = hash[..16].to_string();

    fs::create_dir_all(icons_dir)?;
    // Write a PNG as ico-cache stand-in (Windows .ico generation simplified: store PNG; desktop.ini may still work with .ico)
    let ico_path = icons_dir.join(format!("{hash16}.ico"));
    write_simple_ico(&img, &ico_path)?;

    let mut data = load_notebook_data(notebook_path).unwrap_or(NotebookData {
        format: NOTEBOOK_FORMAT.into(),
        version: 1,
        ..Default::default()
    });
    data.cover = Some(Cover {
        png_base64: B64.encode(&png_buf),
        hash: hash16.clone(),
    });
    save_notebook_data(notebook_path, &data)?;
    apply_folder_icon(notebook_path, &ico_path)?;
    Ok(())
}

/// Write the folder icon from the cover already stored in `.notebook_data`.
/// Does not rewrite the notebook file, so an existing notebook is left as it is.
pub fn apply_stored_cover(notebook_path: &Path, icons_dir: &Path) -> Result<()> {
    let data = load_notebook_data(notebook_path)?;
    let Some(cover) = data.cover else {
        return Ok(());
    };
    if cover.hash.is_empty() || cover.png_base64.is_empty() {
        return Ok(());
    }
    fs::create_dir_all(icons_dir)?;
    let ico_path = icons_dir.join(format!("{}.ico", cover.hash));
    if !ico_path.is_file() {
        let bytes = B64
            .decode(cover.png_base64.trim())
            .context("cover base64")?;
        let img = image::load_from_memory(&bytes).context("decode stored cover")?;
        write_simple_ico(&img, &ico_path)?;
    }
    apply_folder_icon(notebook_path, &ico_path)?;
    Ok(())
}

fn write_simple_ico(img: &image::DynamicImage, path: &Path) -> Result<()> {
    // Single-image PNG-in-ICO (Vista+). Explorer reads this as a folder icon.
    let rgba = img.resize(256, 256, image::imageops::FilterType::Lanczos3).to_rgba8();
    let w = if rgba.width() >= 256 { 0u8 } else { rgba.width() as u8 };
    let h = if rgba.height() >= 256 { 0u8 } else { rgba.height() as u8 };
    let mut png = Vec::new();
    {
        let mut c = std::io::Cursor::new(&mut png);
        image::DynamicImage::ImageRgba8(rgba)
            .write_to(&mut c, image::ImageFormat::Png)?;
    }
    // ICO header + one PNG image (Vista+)
    let mut ico = Vec::new();
    ico.extend_from_slice(&[0, 0, 1, 0, 1, 0]); // reserved, type=1, count=1
    ico.push(w);
    ico.push(h);
    ico.push(0); // colors
    ico.push(0); // reserved
    ico.extend_from_slice(&1u16.to_le_bytes()); // planes
    ico.extend_from_slice(&32u16.to_le_bytes()); // bitcount
    let size = png.len() as u32;
    ico.extend_from_slice(&size.to_le_bytes());
    ico.extend_from_slice(&22u32.to_le_bytes()); // offset
    ico.extend_from_slice(&png);
    fs::write(path, ico)?;
    Ok(())
}

fn apply_folder_icon(folder: &Path, ico: &Path) -> Result<()> {
    let desktop_ini = folder.join("desktop.ini");
    let content = format!(
        "[.ShellClassInfo]\r\nIconResource={},0\r\n",
        ico.to_string_lossy()
    );
    fs::write(&desktop_ini, content)?;
    #[cfg(windows)]
    {
        winattr::hide_system(&desktop_ini);
    }
    Ok(())
}

pub const DETECT_MAX_ENTRIES: usize = 300_000;
pub const DETECT_MAX_RESULTS: usize = 2_000;

/// Directory names skipped at any depth. Matching is ASCII case-insensitive.
const SKIP_DIR_NAMES: &[&str] = &[
    "AppData",
    ".cache",
    ".git",
    "node_modules",
    "$RECYCLE.BIN",
    "System Volume Information",
    "Windows",
    "Program Files",
    "Program Files (x86)",
    "ProgramData",
];

/// Visited before other children of the same folder so the entry cap cannot
/// burn the whole budget inside a huge sibling (for example OneDrive) first.
const PRIORITY_DIR_NAMES: &[&str] = &["Downloads", "Desktop", "Documents"];

// Win32 attribute bits. RECALL_ON_OPEN (0x00040000) is intentionally not used:
// it shares its bit with FILE_ATTRIBUTE_EA, so testing it would skip ordinary files.
const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x0000_0010;
const FILE_ATTRIBUTE_OFFLINE: u32 = 0x0000_1000;
const FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS: u32 = 0x0040_0000;
const CLOUD_PLACEHOLDER_ATTRS: u32 = FILE_ATTRIBUTE_OFFLINE | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS;

#[allow(dead_code)]
pub fn detect_candidates(roots: &[PathBuf], ignored: &[String], already: &[String]) -> Vec<DetectedItem> {
    detect_candidates_limited(roots, ignored, already, DETECT_MAX_ENTRIES, DETECT_MAX_RESULTS, None, None)
}

/// Progress for a long detect scan. `path` is the folder currently being walked.
#[derive(Debug, Clone, Serialize)]
pub struct DetectProgress {
    pub walked: usize,
    pub found: usize,
    pub path: String,
}

/// Like [`detect_candidates`], with an explicit entry cap, result cap, and optional deadline.
/// Hitting either cap or the deadline returns whatever was found so far.
pub fn detect_candidates_limited(
    roots: &[PathBuf],
    ignored: &[String],
    already: &[String],
    max_entries: usize,
    max_results: usize,
    deadline: Option<Instant>,
    mut on_progress: Option<&mut dyn FnMut(DetectProgress)>,
) -> Vec<DetectedItem> {
    let ignored_set: HashSet<String> = ignored.iter().cloned().collect();
    let already_set: HashSet<String> = already.iter().cloned().collect();
    let mut seen: HashSet<String> = HashSet::new();
    let mut found = Vec::new();
    // Pop order is the scan order. Reverse so the first root is visited first.
    let mut stack = dedupe_roots(roots.to_vec());
    stack.reverse();
    let mut walked = 0usize;
    let mut stop = false;
    let mut last_emit = Instant::now();

    while let Some(dir) = stack.pop() {
        if stop || deadline_reached(deadline) {
            break;
        }
        if let Some(cb) = on_progress.as_mut() {
            // Throttle UI updates; full scans walk hundreds of thousands of entries.
            if walked == 0 || last_emit.elapsed().as_millis() >= 200 {
                last_emit = Instant::now();
                cb(DetectProgress {
                    walked,
                    found: found.len(),
                    path: dir.to_string_lossy().to_string(),
                });
            }
        }
        // Permission errors and unreadable folders are skipped; the scan continues.
        let rd = match fs::read_dir(&dir) {
            Ok(rd) => rd,
            Err(_) => continue,
        };
        let mut saw_marker = false;
        let mut notes: Vec<PathBuf> = Vec::new();
        let mut subdirs: Vec<PathBuf> = Vec::new();
        let mut priority_subdirs: Vec<PathBuf> = Vec::new();
        for ent in rd {
            walked += 1;
            if walked >= max_entries || deadline_reached(deadline) {
                stop = true;
                break;
            }
            let ent = match ent {
                Ok(ent) => ent,
                Err(_) => continue,
            };
            let name = ent.file_name();
            // Name check applies at every depth: a matching directory is never opened.
            if is_skipped_dir_name(&name) {
                continue;
            }
            let path = ent.path();
            // `DirEntry::file_type` / `metadata` on Windows come from the parent
            // FindFirstFile listing. They do not open the child, so a cloud
            // placeholder is not hydrated just by being seen.
            let attrs = entry_attributes(&ent);
            let is_dir = ent.file_type().map(|t| t.is_dir()).unwrap_or(false);
            // Junctions and cloud folders are reparse points. `is_dir()` is false
            // for those; the DIRECTORY attribute still distinguishes them from files.
            let reparse_dir = !is_dir && attrs & FILE_ATTRIBUTE_DIRECTORY != 0;
            if is_dir && attrs & CLOUD_PLACEHOLDER_ATTRS == 0 {
                if is_priority_dir(&name) {
                    priority_subdirs.push(path);
                } else {
                    subdirs.push(path);
                }
                continue;
            }
            if is_dir || reparse_dir {
                // Do not enumerate an offline / recall-on-access / junction folder.
                // A notebook marker can still be recognized by attributes alone.
                if marker_present(&path) && record(
                    &mut found,
                    &mut seen,
                    &already_set,
                    &ignored_set,
                    max_results,
                    "notebook",
                    &path,
                    base_name(&path),
                ) {
                    stop = true;
                    break;
                }
                continue;
            }
            if is_marker_name(&name) {
                saw_marker = true;
                continue;
            }
            if is_note_name(&name) {
                // Placeholder `.note` files are included from the name alone.
                notes.push(path);
            }
        }
        // Pushed last, so a depth-first pop visits Downloads / Desktop / Documents first.
        stack.extend(subdirs);
        stack.extend(priority_subdirs);
        let is_notebook = saw_marker || (!notes.is_empty() && marker_present(&dir));
        if is_notebook {
            if record(
                &mut found,
                &mut seen,
                &already_set,
                &ignored_set,
                max_results,
                "notebook",
                &dir,
                base_name(&dir),
            ) {
                stop = true;
            }
        } else {
            for note in notes {
                if record(
                    &mut found,
                    &mut seen,
                    &already_set,
                    &ignored_set,
                    max_results,
                    "note",
                    &note,
                    note_title(&note),
                ) {
                    stop = true;
                    break;
                }
            }
        }
    }
    found
}

/// True when `path` is `root` or a descendant. Comparison is case-insensitive
/// and ignores a trailing slash, so `C:\Users\A` does not contain `C:\Users\A2`.
pub(crate) fn path_is_same_or_under(path: &Path, root: &Path) -> bool {
    let p = normalize_path_key(path);
    let r = normalize_path_key(root);
    if p == r {
        return true;
    }
    let prefix = if r.ends_with('\\') { r } else { format!("{r}\\") };
    p.starts_with(&prefix)
}

pub(crate) fn dedupe_roots(roots: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut kept: Vec<PathBuf> = Vec::new();
    for root in roots {
        if root.as_os_str().is_empty() {
            continue;
        }
        if kept.iter().any(|have| path_is_same_or_under(&root, have)) {
            continue;
        }
        kept.retain(|have| !path_is_same_or_under(have, &root));
        kept.push(root);
    }
    kept
}

fn normalize_path_key(path: &Path) -> String {
    let lower = path.to_string_lossy().replace('/', "\\").to_ascii_lowercase();
    let trimmed = lower.trim_end_matches('\\');
    if trimmed.len() == 2 && trimmed.as_bytes().get(1) == Some(&b':') {
        format!("{trimmed}\\")
    } else {
        trimmed.to_string()
    }
}

fn is_skipped_dir_name(name: &OsStr) -> bool {
    SKIP_DIR_NAMES.iter().any(|skip| name.eq_ignore_ascii_case(OsStr::new(skip)))
}

fn is_priority_dir(name: &OsStr) -> bool {
    PRIORITY_DIR_NAMES.iter().any(|priority| name.eq_ignore_ascii_case(OsStr::new(priority)))
}

fn is_marker_name(name: &OsStr) -> bool {
    name.eq_ignore_ascii_case(NOTEBOOK_DATA)
}

fn is_note_name(name: &OsStr) -> bool {
    Path::new(name)
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("note"))
}

fn deadline_reached(deadline: Option<Instant>) -> bool {
    deadline.is_some_and(|deadline| Instant::now() >= deadline)
}

fn base_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string_lossy().to_string())
}

fn note_title(path: &Path) -> String {
    path.file_stem().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()
}

/// Attributes from a directory listing. On Windows this is the `WIN32_FIND_DATA`
/// already returned by `FindFirstFile` — not a `CreateFile` — so it does not
/// hydrate OneDrive Files On-Demand placeholders.
fn entry_attributes(ent: &fs::DirEntry) -> u32 {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        return ent.metadata().map(|meta| meta.file_attributes()).unwrap_or(0);
    }
    #[cfg(not(windows))]
    {
        let _ = ent;
        0
    }
}

/// Whether `dir/.notebook_data` exists, without opening it.
/// `GetFileAttributesW` reads attributes only; `std::fs::metadata` / `is_file`
/// open a handle and can hydrate a placeholder.
fn marker_present(dir: &Path) -> bool {
    let marker = dir.join(NOTEBOOK_DATA);
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows::core::PCWSTR;
        use windows::Win32::Storage::FileSystem::GetFileAttributesW;
        let wide: Vec<u16> = marker.as_os_str().encode_wide().chain(Some(0)).collect();
        let attrs = unsafe { GetFileAttributesW(PCWSTR(wide.as_ptr())) };
        return attrs != u32::MAX;
    }
    #[cfg(not(windows))]
    {
        marker.is_file()
    }
}

fn record(
    found: &mut Vec<DetectedItem>,
    seen: &mut HashSet<String>,
    already: &HashSet<String>,
    ignored: &HashSet<String>,
    max_results: usize,
    kind: &str,
    path: &Path,
    name: String,
) -> bool {
    if found.len() >= max_results {
        return true;
    }
    let p = path.to_string_lossy().to_string();
    if already.contains(&p) || !seen.insert(p.clone()) {
        return false;
    }
    found.push(DetectedItem {
        kind: kind.to_string(),
        path: p.clone(),
        name,
        ignored: ignored.contains(&p),
    });
    found.len() >= max_results
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DetectedItem {
    pub kind: String,
    pub path: String,
    pub name: String,
    pub ignored: bool,
}

pub fn home_paths_flat(items: &[crate::state::HomeItem]) -> Vec<String> {
    let mut out = Vec::new();
    for it in items {
        match it {
            crate::state::HomeItem::Notebook { path } | crate::state::HomeItem::Note { path } => {
                out.push(path.clone());
            }
            crate::state::HomeItem::Group { items, .. } => {
                for g in items {
                    match g {
                        crate::state::HomeItem::Notebook { path }
                        | crate::state::HomeItem::Note { path } => out.push(path.clone()),
                        _ => {}
                    }
                }
            }
        }
    }
    out
}

#[cfg(windows)]
mod winattr {
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;

    const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
    const FILE_ATTRIBUTE_SYSTEM: u32 = 0x4;
    const INVALID_FILE_ATTRIBUTES: u32 = u32::MAX;

    extern "system" {
        fn GetFileAttributesW(lpFileName: *const u16) -> u32;
        fn SetFileAttributesW(lpFileName: *const u16, dwFileAttributes: u32) -> i32;
    }

    fn wide(path: &Path) -> Vec<u16> {
        path.as_os_str().encode_wide().chain(Some(0)).collect()
    }

    fn add_flags(path: &Path, flags: u32) {
        let w = wide(path);
        unsafe {
            let cur = GetFileAttributesW(w.as_ptr());
            if cur == INVALID_FILE_ATTRIBUTES {
                let _ = SetFileAttributesW(w.as_ptr(), flags);
            } else {
                let _ = SetFileAttributesW(w.as_ptr(), cur | flags);
            }
        }
    }

    pub fn hide(path: &Path) {
        add_flags(path, FILE_ATTRIBUTE_HIDDEN);
    }

    pub fn hide_system(path: &Path) {
        add_flags(path, FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM);
    }
}
