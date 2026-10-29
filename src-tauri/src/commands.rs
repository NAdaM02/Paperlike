//! Tauri commands exposed to the frontend.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{Manager, State};

use crate::export::{self, ExportOptions, PageRect};
use crate::naming;
use crate::note::{self, NoteFile};
use crate::notebook::{self, DetectedItem, NoteListItem, NotebookInfo};
use crate::search::{self, SearchHit};
use crate::state::{self, AppPaths, HomeItem, HomeState, NotebookUiState, Settings, WindowState};

pub struct AppState {
    pub paths: AppPaths,
}

fn err_str(e: impl ToString) -> String {
    e.to_string()
}

#[tauri::command]
pub fn get_settings(state: State<AppState>) -> Result<Settings, String> {
    state.paths.ensure().map_err(err_str)?;
    state::load_settings(&state.paths).map_err(err_str)
}

#[tauri::command]
pub fn save_settings(
    app: tauri::AppHandle,
    state: State<AppState>,
    mut settings: Settings,
) -> Result<(), String> {
    settings.home_tile_size = state::clamp_home_tile_size(settings.home_tile_size);
    state::save_settings(&state.paths, &settings).map_err(err_str)?;
    crate::apply_tray_setting(&app, settings.tray);
    Ok(())
}

#[tauri::command]
pub fn get_home(state: State<AppState>) -> Result<HomeState, String> {
    state.paths.ensure().map_err(err_str)?;
    state::load_home(&state.paths).map_err(err_str)
}

#[tauri::command]
pub fn save_home(state: State<AppState>, home: HomeState) -> Result<(), String> {
    state::save_home(&state.paths, &home).map_err(err_str)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HomeTile {
    pub kind: String,
    pub path: String,
    pub name: String,
    pub description: Option<String>,
    pub cover_png_base64: Option<String>,
    pub missing: bool,
    pub group_name: Option<String>,
    pub group_items: Option<Vec<HomeTile>>,
}

#[tauri::command]
pub fn get_home_tiles(state: State<AppState>) -> Result<Vec<HomeTile>, String> {
    state.paths.ensure().map_err(err_str)?;
    let home = state::load_home(&state.paths).map_err(err_str)?;
    Ok(home.items.iter().map(item_to_tile).collect())
}

fn item_to_tile(it: &HomeItem) -> HomeTile {
    match it {
        HomeItem::Notebook { path } => {
            let p = Path::new(path);
            let missing = !notebook::is_notebook(p);
            let (description, cover) = if !missing {
                notebook::load_notebook_data(p)
                    .map(|d| (d.description, d.cover.map(|c| c.png_base64)))
                    .unwrap_or((None, None))
            } else {
                (None, None)
            };
            HomeTile {
                kind: "notebook".into(),
                path: path.clone(),
                name: p
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default(),
                description,
                cover_png_base64: cover,
                missing,
                group_name: None,
                group_items: None,
            }
        }
        HomeItem::Note { path } => {
            let p = Path::new(path);
            HomeTile {
                kind: "note".into(),
                path: path.clone(),
                name: p
                    .file_stem()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default(),
                description: Some(path.clone()),
                cover_png_base64: None,
                missing: !p.is_file(),
                group_name: None,
                group_items: None,
            }
        }
        HomeItem::Group { name, items } => HomeTile {
            kind: "group".into(),
            path: format!("group:{name}"),
            name: name.clone(),
            description: None,
            cover_png_base64: None,
            missing: false,
            group_name: Some(name.clone()),
            group_items: Some(items.iter().map(item_to_tile).collect()),
        },
    }
}

/// Add notebooks and notes to `home.json`. Paths already on Home are left in place.
pub(crate) fn add_paths_to_home(
    app_paths: &AppPaths,
    items: Vec<String>,
    make_notebook: bool,
) -> Result<HomeState, String> {
    let mut home = state::load_home(app_paths).map_err(err_str)?;
    let existing = notebook::home_paths_flat(&home.items);
    for path in items {
        if existing.contains(&path) {
            continue;
        }
        let p = PathBuf::from(&path);
        if p.is_dir() {
            if make_notebook || !notebook::is_notebook(&p) {
                notebook::ensure_notebook(&p).map_err(err_str)?;
            }
            if notebook::is_notebook(&p) {
                home.items.push(HomeItem::Notebook { path });
            }
        } else if p.extension().and_then(|e| e.to_str()) == Some("note") {
            home.items.push(HomeItem::Note { path });
        }
    }
    state::save_home(app_paths, &home).map_err(err_str)?;
    Ok(home)
}

#[tauri::command]
pub fn add_to_home(state: State<AppState>, paths: Vec<String>, make_notebook: bool) -> Result<HomeState, String> {
    add_paths_to_home(&state.paths, paths, make_notebook)
}

#[tauri::command]
pub fn remove_from_home(state: State<AppState>, path: String) -> Result<HomeState, String> {
    let mut home = state::load_home(&state.paths).map_err(err_str)?;
    home.items.retain(|it| match it {
        HomeItem::Notebook { path: p } | HomeItem::Note { path: p } => p != &path,
        HomeItem::Group { .. } => true, // groups are pruned below
    });
    for it in home.items.iter_mut() {
        if let HomeItem::Group { items, .. } = it {
            items.retain(|g| match g {
                HomeItem::Notebook { path: p } | HomeItem::Note { path: p } => p != &path,
                _ => true,
            });
        }
    }
    home.items.retain(|it| match it {
        HomeItem::Group { items, .. } => !items.is_empty(),
        _ => true,
    });
    state::save_home(&state.paths, &home).map_err(err_str)?;
    Ok(home)
}

#[derive(Debug, Serialize)]
pub struct PathInfo {
    pub path: String,
    pub kind: String,
}

/// Classify paths so the UI can ask "Make this a notebook?" before adding
/// plain folders to Home.
#[tauri::command]
pub fn classify_paths(paths: Vec<String>) -> Vec<PathInfo> {
    paths
        .into_iter()
        .map(|p| {
            let pb = PathBuf::from(&p);
            let kind = if pb.is_dir() {
                if notebook::is_notebook(&pb) {
                    "notebook"
                } else {
                    "folder"
                }
            } else if pb.extension().and_then(|e| e.to_str()) == Some("note") {
                "note"
            } else if pb.exists() {
                "other"
            } else {
                "missing"
            };
            PathInfo {
                path: p,
                kind: kind.into(),
            }
        })
        .collect()
}

fn env_path(key: &str) -> Option<PathBuf> {
    let raw = std::env::var(key).ok()?;
    let trimmed = raw.trim().trim_matches('"');
    if trimmed.is_empty() {
        None
    } else {
        Some(PathBuf::from(trimmed))
    }
}

/// Profile-wide roots for the normal detect scan.
///
/// `%USERPROFILE%\Downloads` is pushed explicitly so it stays covered if the
/// profile root is ever dropped. It is nested under the profile, and
/// [`notebook::dedupe_roots`] collapses that duplicate.
///
/// `OneDrive`, `OneDriveCommercial`, and `OneDriveConsumer` are added only when
/// they are not already inside the profile (a typical `%USERPROFILE%\OneDrive`
/// is). Business setups sometimes keep the folder elsewhere.
fn default_detect_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(profile) = env_path("USERPROFILE") {
        roots.push(profile.clone());
        roots.push(profile.join("Downloads"));
    }
    for var in ["OneDrive", "OneDriveCommercial", "OneDriveConsumer"] {
        if let Some(path) = env_path(var) {
            roots.push(path);
        }
    }
    roots.retain(|path| path.exists());
    notebook::dedupe_roots(roots)
}

/// Fixed local drives. Removable, network, CD, and RAM disks are left out.
/// `DRIVE_UNKNOWN` (and any unexpected type) is included — if the type cannot
/// be told, the drive is scanned rather than silently dropped.
///
/// Unused until `detect_notes_full_scan` is listed in `lib.rs`.
#[allow(dead_code)]
fn fixed_drive_roots() -> Vec<PathBuf> {
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{GetDriveTypeW, GetLogicalDrives};

    // These live in Win32_System_WindowsProgramming, which this crate does not enable.
    const DRIVE_UNKNOWN: u32 = 0;
    const DRIVE_NO_ROOT_DIR: u32 = 1;
    const DRIVE_REMOVABLE: u32 = 2;
    const DRIVE_FIXED: u32 = 3;
    const DRIVE_REMOTE: u32 = 4;
    const DRIVE_CDROM: u32 = 5;
    const DRIVE_RAMDISK: u32 = 6;

    let mask = unsafe { GetLogicalDrives() };
    let mut roots = Vec::new();
    for i in 0..26u32 {
        if mask != 0 && mask & (1 << i) == 0 {
            continue;
        }
        let letter = char::from(b'A' + i as u8);
        let root = format!("{letter}:\\");
        let wide: Vec<u16> = root.encode_utf16().chain(Some(0)).collect();
        let kind = unsafe { GetDriveTypeW(PCWSTR(wide.as_ptr())) };
        let include = match kind {
            DRIVE_FIXED | DRIVE_UNKNOWN => true,
            DRIVE_NO_ROOT_DIR | DRIVE_REMOVABLE | DRIVE_REMOTE | DRIVE_CDROM | DRIVE_RAMDISK => false,
            _ => true,
        };
        if include {
            roots.push(PathBuf::from(root));
        }
    }
    roots
}

#[tauri::command]
pub async fn detect_notes(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<Vec<DetectedItem>, String> {
    use tauri::Emitter;
    let paths = state.paths.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let home = state::load_home(&paths).map_err(err_str)?;
        let ignored = state::load_ignored(&paths).map_err(err_str)?;
        let already = notebook::home_paths_flat(&home.items);
        let roots = default_detect_roots();
        let mut emit = |p: notebook::DetectProgress| {
            let _ = app.emit("detect-progress", &p);
        };
        Ok(notebook::detect_candidates_limited(
            &roots,
            &ignored.paths,
            &already,
            notebook::DETECT_MAX_ENTRIES,
            notebook::DETECT_MAX_RESULTS,
            None,
            Some(&mut emit),
        ))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Whole-PC scan.
#[tauri::command]
pub async fn detect_notes_full_scan(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<Vec<DetectedItem>, String> {
    use tauri::Emitter;
    let paths = state.paths.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let home = state::load_home(&paths).map_err(err_str)?;
        let ignored = state::load_ignored(&paths).map_err(err_str)?;
        let already = notebook::home_paths_flat(&home.items);
        let mut roots = fixed_drive_roots();
        if roots.is_empty() {
            roots = default_detect_roots();
        }
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
        let mut emit = |p: notebook::DetectProgress| {
            let _ = app.emit("detect-progress", &p);
        };
        Ok(notebook::detect_candidates_limited(
            &roots,
            &ignored.paths,
            &already,
            1_000_000,
            2_000,
            Some(deadline),
            Some(&mut emit),
        ))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn apply_detect(
    state: State<AppState>,
    add: Vec<DetectedItem>,
    ignore: Vec<String>,
) -> Result<HomeState, String> {
    let mut home = state::load_home(&state.paths).map_err(err_str)?;
    let mut ignored = state::load_ignored(&state.paths).map_err(err_str)?;
    for item in add {
        ignored.paths.retain(|p| p != &item.path);
        if item.kind == "notebook" {
            home.items.push(HomeItem::Notebook { path: item.path });
        } else {
            home.items.push(HomeItem::Note { path: item.path });
        }
    }
    for p in ignore {
        if !ignored.paths.contains(&p) {
            ignored.paths.push(p);
        }
    }
    state::save_ignored(&state.paths, &ignored).map_err(err_str)?;
    state::save_home(&state.paths, &home).map_err(err_str)?;
    Ok(home)
}

#[tauri::command]
pub async fn open_notebook(path: String) -> Result<NotebookInfo, String> {
    tauri::async_runtime::spawn_blocking(move || notebook::open_notebook(Path::new(&path)).map_err(err_str))
        .await
        .map_err(|e| e.to_string())?
}

fn gate_edit() -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub fn create_note(notebook_path: String) -> Result<NoteListItem, String> {
    gate_edit()?;
    notebook::create_note_in_notebook(Path::new(&notebook_path)).map_err(err_str)
}

fn rewrite_home_path(items: &mut [HomeItem], old: &str, new: &str) -> bool {
    let mut changed = false;
    for it in items {
        match it {
            HomeItem::Notebook { path } | HomeItem::Note { path } => {
                if path == old {
                    *path = new.to_string();
                    changed = true;
                }
            }
            HomeItem::Group { items, .. } => {
                changed |= rewrite_home_path(items, old, new);
            }
        }
    }
    changed
}

#[tauri::command]
pub fn rename_note(state: State<AppState>, path: String, new_title: String) -> Result<String, String> {
    gate_edit()?;
    let new_path = notebook::rename_note(Path::new(&path), &new_title).map_err(err_str)?;
    // A standalone note may be pinned to Home; keep that reference valid.
    if new_path != path {
        if let Ok(mut home) = state::load_home(&state.paths) {
            if rewrite_home_path(&mut home.items, &path, &new_path) {
                let _ = state::save_home(&state.paths, &home);
            }
        }
    }
    Ok(new_path)
}

#[tauri::command]
pub fn delete_note(path: String) -> Result<(), String> {
    // Deleting a note stays available after the trial. Every other change stays gated.
    trash::delete(&path).map_err(err_str)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotePayload {
    pub path: String,
    pub title: String,
    pub display_title: String,
    pub empty_named: bool,
    pub created: String,
    pub modified: String,
    pub doc: note::NoteDocument,
    /// media path -> base64
    pub media_b64: std::collections::HashMap<String, String>,
    /// Written by a newer Paperlike: shown, never saved.
    #[serde(default)]
    pub read_only: bool,
    /// Objects of kinds this version cannot show; they ride along and are saved back.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub unknown_objects: Vec<serde_json::Value>,
}

#[tauri::command]
pub fn load_note(path: String) -> Result<NotePayload, String> {
    let p = Path::new(&path);
    let mut n = note::load_note(p).map_err(err_str)?;
    let unknown_objects = std::mem::take(&mut n.doc.canvas.unknown_objects);
    let read_only = n.doc.version > note::NOTE_VERSION;
    let stem = p
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let media_b64 = n
        .media
        .iter()
        .map(|(k, v)| (k.clone(), base64_encode(v)))
        .collect();
    Ok(NotePayload {
        path,
        title: stem.clone(),
        display_title: naming::display_title(&stem),
        empty_named: naming::is_empty_named(&stem),
        created: note::ts_rfc3339(n.doc.meta.created),
        modified: note::ts_rfc3339(n.doc.meta.modified),
        doc: n.doc,
        media_b64,
        read_only,
        unknown_objects,
    })
}

fn base64_encode(b: &[u8]) -> String {
    use base64::{engine::general_purpose::STANDARD, Engine};
    STANDARD.encode(b)
}

fn base64_decode(s: &str) -> Result<Vec<u8>, String> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    STANDARD.decode(s).map_err(err_str)
}

/// What the editor needs back after an autosave. Returning the whole note
/// would send the full document across the bridge again only to be dropped.
#[derive(Debug, Clone, Serialize)]
pub struct SavedNoteInfo {
    pub path: String,
    pub title: String,
    pub empty_named: bool,
    pub created: String,
    pub modified: String,
}

#[tauri::command]
pub fn save_note_info(payload: NotePayload) -> Result<SavedNoteInfo, String> {
    let saved = save_note(payload)?;
    Ok(SavedNoteInfo {
        path: saved.path,
        title: saved.title,
        empty_named: saved.empty_named,
        created: saved.created,
        modified: saved.modified,
    })
}

#[tauri::command]
pub fn save_note(payload: NotePayload) -> Result<NotePayload, String> {
    gate_edit()?;
    let mut media = std::collections::HashMap::new();
    for (k, v) in payload.media_b64 {
        media.insert(k, base64_decode(&v)?);
    }
    if payload.read_only {
        return Err("This note was written by a newer Paperlike; it opens read-only.".into());
    }
    let mut note = NoteFile {
        doc: payload.doc,
        media,
    };
    note.doc.canvas.unknown_objects = payload.unknown_objects;
    note::normalize_media(&mut note);
    let path = PathBuf::from(&payload.path);
    note::save_note(&path, &mut note).map_err(err_str)?;
    let unknown_objects = std::mem::take(&mut note.doc.canvas.unknown_objects);
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let media_b64 = note
        .media
        .iter()
        .map(|(k, v)| (k.clone(), base64_encode(v)))
        .collect();
    Ok(NotePayload {
        path: payload.path,
        title: stem.clone(),
        display_title: naming::display_title(&stem),
        empty_named: naming::is_empty_named(&stem),
        created: note::ts_rfc3339(note.doc.meta.created),
        modified: note::ts_rfc3339(note.doc.meta.modified),
        doc: note.doc,
        media_b64,
        read_only: false,
        unknown_objects,
    })
}

#[tauri::command]
pub fn add_today_title(path: String, format: Option<String>) -> Result<String, String> {
    let p = Path::new(&path);
    let stem = p
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let display = naming::display_title(&stem);
    let new_title = naming::prefix_today(&display, format.as_deref());
    notebook::rename_note(p, &new_title).map_err(err_str)
}

#[tauri::command]
pub fn set_notebook_meta(
    state: State<AppState>,
    path: String,
    name: Option<String>,
    description: Option<String>,
) -> Result<(), String> {
    gate_edit()?;
    let mut notebook_path = PathBuf::from(&path);
    if let Some(ref new_name) = name {
        let clean = naming::sanitize_title(new_name);
        let parent = notebook_path.parent().ok_or("no parent")?;
        let dest = parent.join(&clean);
        if dest != notebook_path {
            std::fs::rename(&notebook_path, &dest).map_err(err_str)?;
            let mut home = state::load_home(&state.paths).map_err(err_str)?;
            let newp = dest.to_string_lossy().to_string();
            rewrite_home_path(&mut home.items, &path, &newp);
            state::save_home(&state.paths, &home).map_err(err_str)?;
            notebook_path = dest;
        }
    }

    if description.is_some() {
        let mut data = notebook::load_notebook_data(&notebook_path).map_err(err_str)?;
        data.description = description;
        notebook::save_notebook_data(&notebook_path, &data).map_err(err_str)?;
    }
    Ok(())
}

#[tauri::command]
pub fn set_notebook_cover(
    state: State<AppState>,
    path: String,
    image_b64: String,
) -> Result<(), String> {
    gate_edit()?;
    let bytes = base64_decode(&image_b64)?;
    notebook::set_cover(Path::new(&path), &bytes, &state.paths.icons).map_err(err_str)
}

#[tauri::command]
pub fn save_separators(
    path: String,
    separators: notebook::Separators,
) -> Result<(), String> {
    let mut data = notebook::load_notebook_data(Path::new(&path)).map_err(err_str)?;
    data.separators = Some(separators);
    notebook::save_notebook_data(Path::new(&path), &data).map_err(err_str)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportArgs {
    pub note_path: String,
    pub dest: String,
    pub format: String,
    pub page_numbers: bool,
    pub title_header: Option<String>,
    pub export_date: bool,
    pub geometry_block: bool,
}

#[tauri::command]
pub async fn export_note(args: ExportArgs) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let note = note::load_note(Path::new(&args.note_path)).map_err(err_str)?;
        let title = Path::new(&args.note_path)
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let opts = ExportOptions {
            format: args.format,
            page_numbers: args.page_numbers,
            title_header: args.title_header,
            export_date: args.export_date,
            geometry_block: args.geometry_block,
        };
        export::export_note(&note, &title, Path::new(&args.dest), &opts).map_err(err_str)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportMergedArgs {
    pub note_paths: Vec<String>,
    pub dest: String,
    pub format: String,
    pub page_numbers: bool,
    pub title_headers: Option<std::collections::HashMap<String, String>>,
    pub export_date: bool,
    pub geometry_block: bool,
}

#[tauri::command]
pub async fn export_notes_merged(args: ExportMergedArgs) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || export_notes_merged_sync(args))
        .await
        .map_err(|e| e.to_string())?
}

fn export_notes_merged_sync(args: ExportMergedArgs) -> Result<(), String> {
    let mut notes = Vec::with_capacity(args.note_paths.len());
    for path in &args.note_paths {
        let note = note::load_note(Path::new(path)).map_err(err_str)?;
        let title = Path::new(path)
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let header = args
            .title_headers
            .as_ref()
            .and_then(|m| m.get(path).cloned());
        notes.push((note, title, header));
    }
    let opts = ExportOptions {
        format: args.format,
        page_numbers: args.page_numbers,
        title_header: None,
        export_date: args.export_date,
        geometry_block: args.geometry_block,
    };
    export::export_notes_merged(&notes, Path::new(&args.dest), &opts).map_err(err_str)
}

#[tauri::command]
pub fn compute_pdf_pages(note_path: String) -> Result<Vec<PageRect>, String> {
    let note = note::load_note(Path::new(&note_path)).map_err(err_str)?;
    Ok(export::compute_pages(&note))
}

#[tauri::command]
pub async fn search_global(state: State<'_, AppState>, query: String) -> Result<Vec<SearchHit>, String> {
    let paths = state.paths.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let home = state::load_home(&paths).map_err(err_str)?;
        search::global_search(&paths, &home.items, &query).map_err(err_str)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn create_notebook(state: State<AppState>, parent: String, name: String) -> Result<String, String> {
    gate_edit()?;
    let dir = PathBuf::from(&parent).join(naming::sanitize_title(&name));
    std::fs::create_dir_all(&dir).map_err(err_str)?;
    notebook::ensure_notebook(&dir).map_err(err_str)?;
    let path = dir.to_string_lossy().to_string();
    let mut home = state::load_home(&state.paths).map_err(err_str)?;
    home.items.push(HomeItem::Notebook {
        path: path.clone(),
    });
    state::save_home(&state.paths, &home).map_err(err_str)?;
    Ok(path)
}

#[tauri::command]
pub fn get_notebook_ui(state: State<AppState>, path: String) -> Result<NotebookUiState, String> {
    let ui = state::load_ui_state(&state.paths).map_err(err_str)?;
    let mut nb = ui
        .notebooks
        .get(&path)
        .cloned()
        .unwrap_or_default();
    // Sort travels with the notebook folder; ui-state is only a fallback for older notebooks.
    if let Ok(data) = notebook::load_notebook_data(Path::new(&path)) {
        if let Some(sort) = data.sort.filter(|s| !s.is_empty()) {
            nb.sort = sort;
        }
    }
    Ok(nb)
}

#[tauri::command]
pub fn set_notebook_ui(
    state: State<AppState>,
    path: String,
    nb_ui: NotebookUiState,
) -> Result<(), String> {
    let mut ui = state::load_ui_state(&state.paths).map_err(err_str)?;
    ui.notebooks.insert(path.clone(), nb_ui.clone());
    state::save_ui_state(&state.paths, &ui).map_err(err_str)?;
    // Persist sort in `.notebook_data` so it follows the folder across machines.
    if let Ok(mut data) = notebook::load_notebook_data(Path::new(&path)) {
        let sort = nb_ui.sort.trim();
        data.sort = if sort.is_empty() || sort == "name" {
            // Keep default explicit so a shared notebook still reads the same order.
            Some(if sort.is_empty() { "name".into() } else { sort.into() })
        } else {
            Some(sort.into())
        };
        let _ = notebook::save_notebook_data(Path::new(&path), &data);
    }
    Ok(())
}

#[tauri::command]
pub fn get_window_state(state: State<AppState>) -> Result<WindowState, String> {
    let ui = state::load_ui_state(&state.paths).map_err(err_str)?;
    Ok(ui.window)
}

#[tauri::command]
pub fn save_window_state(state: State<AppState>, window: WindowState) -> Result<(), String> {
    let mut ui = state::load_ui_state(&state.paths).map_err(err_str)?;
    ui.window = window;
    state::save_ui_state(&state.paths, &ui).map_err(err_str)
}

fn recovery_file(state: &AppState, note_path: &str) -> PathBuf {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(note_path.as_bytes());
    let key = crate::atomic::hex(&h.finalize())[..16].to_string();
    state.paths.recovery.join(format!("{key}.json"))
}

#[tauri::command]
pub fn write_recovery(state: State<AppState>, note_path: String, payload: NotePayload) -> Result<(), String> {
    state.paths.ensure().map_err(err_str)?;
    let json = serde_json::to_string(&payload).map_err(err_str)?;
    crate::atomic::atomic_write_string(&recovery_file(&state, &note_path), &json, false).map_err(err_str)
}

#[tauri::command]
pub fn clear_recovery(state: State<AppState>, note_path: String) -> Result<(), String> {
    let _ = std::fs::remove_file(recovery_file(&state, &note_path));
    Ok(())
}

/// An unsaved note left behind by a crash or a failed save.
#[derive(Serialize)]
pub struct RecoveryItem {
    pub key: String,
    pub path: String,
    pub title: String,
    /// When the recovery copy was written (RFC 3339).
    pub written: String,
    /// The note file is still there (Recover then replaces it, keeping a backup).
    pub exists: bool,
    /// Its folder is still there; otherwise Recover writes to Documents\Paperlike\Recovered.
    pub folder: bool,
}

#[tauri::command]
pub fn list_recovery(state: State<AppState>) -> Result<Vec<RecoveryItem>, String> {
    let Ok(dir) = std::fs::read_dir(&state.paths.recovery) else { return Ok(Vec::new()) };
    let mut items = Vec::new();
    for entry in dir.flatten() {
        let file = entry.path();
        if file.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Some(key) = file.file_stem().map(|s| s.to_string_lossy().to_string()) else { continue };
        let Ok(text) = std::fs::read_to_string(&file) else { continue };
        let Ok(payload) = serde_json::from_str::<NotePayload>(&text) else {
            let _ = std::fs::remove_file(&file);
            continue;
        };
        let Ok(written_at) = entry.metadata().and_then(|m| m.modified()) else { continue };
        let note_saved = std::fs::metadata(&payload.path).and_then(|m| m.modified()).ok();
        // Saved after the copy was written, or gone for a month (renamed, moved or deleted
        // since): nothing left to recover. A recent copy of a missing note may be an
        // unplugged drive or an unsynced folder, so it is still offered.
        let stale = match note_saved {
            Some(saved) => saved > written_at,
            None => written_at.elapsed().is_ok_and(|age| age > std::time::Duration::from_secs(30 * 86_400)),
        };
        if stale {
            let _ = std::fs::remove_file(&file);
            continue;
        }
        let written = note::ts_rfc3339(written_at.into());
        items.push(RecoveryItem {
            key,
            exists: note_saved.is_some(),
            folder: Path::new(&payload.path).parent().is_some_and(|d| d.is_dir()),
            title: payload.display_title.clone(),
            path: payload.path,
            written,
        });
    }
    items.sort_by(|a, b| b.written.cmp(&a.written));
    Ok(items)
}

fn recovery_by_key(state: &AppState, key: &str) -> Result<PathBuf, String> {
    if key.is_empty() || !key.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("bad recovery key".into());
    }
    Ok(state.paths.recovery.join(format!("{key}.json")))
}

/// Where a recovered note went, and the notebook to open it in.
#[derive(Serialize)]
pub struct Recovered {
    pub path: String,
    pub notebook: Option<String>,
}

/// Writes the unsaved version over the note (the replaced file goes to `backups\`), or to
/// Documents\Paperlike\Recovered when the note's folder is gone.
#[tauri::command]
pub fn recover_note(state: State<AppState>, key: String) -> Result<Recovered, String> {
    let file = recovery_by_key(&state, &key)?;
    let text = std::fs::read_to_string(&file).map_err(err_str)?;
    let mut payload: NotePayload = serde_json::from_str(&text).map_err(err_str)?;
    let original = PathBuf::from(&payload.path);
    let dest = if original.parent().is_some_and(|d| d.is_dir()) {
        original
    } else {
        let dir = notes_folder().join("Recovered");
        std::fs::create_dir_all(&dir).map_err(err_str)?;
        let name = original.file_name().map(|n| n.to_owned()).unwrap_or_else(|| "Recovered.note".into());
        let mut dest = dir.join(&name);
        let mut i = 2;
        while dest.exists() {
            let stem = Path::new(&name).file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            dest = dir.join(format!("{stem} ({i}).note"));
            i += 1;
        }
        dest
    };
    payload.path = dest.to_string_lossy().to_string();
    payload.read_only = false;
    save_note(payload)?;
    let _ = std::fs::remove_file(&file);
    let notebook = dest
        .parent()
        .filter(|d| d.join(crate::notebook::NOTEBOOK_DATA).exists())
        .map(|d| d.to_string_lossy().to_string());
    Ok(Recovered { path: dest.to_string_lossy().to_string(), notebook })
}

#[tauri::command]
pub fn discard_recovery(state: State<AppState>, key: String) -> Result<(), String> {
    let _ = std::fs::remove_file(recovery_by_key(&state, &key)?);
    Ok(())
}

fn notes_folder() -> PathBuf {
    if let Ok(home) = std::env::var("USERPROFILE") {
        return PathBuf::from(home).join("Documents").join("Paperlike");
    }
    PathBuf::from("Paperlike")
}

/// A standalone empty note in Documents\\Paperlike, pinned on Home.
#[tauri::command]
pub fn create_blank_note(state: State<AppState>) -> Result<String, String> {
    gate_edit()?;
    let dir = notes_folder();
    std::fs::create_dir_all(&dir).map_err(err_str)?;
    let path = naming::next_untitled_path(&dir);
    let mut note = NoteFile::new_empty();
    note::save_note(&path, &mut note).map_err(err_str)?;
    let path_str = path.to_string_lossy().to_string();
    let mut home = state::load_home(&state.paths).map_err(err_str)?;
    if !notebook::home_paths_flat(&home.items).contains(&path_str) {
        home.items.push(HomeItem::Note {
            path: path_str.clone(),
        });
        state::save_home(&state.paths, &home).map_err(err_str)?;
    }
    Ok(path_str)
}

/// The notes bundle a supported chat site can take as an attachment.
#[tauri::command]
pub fn save_brief_bundle(title: String, body: String) -> Result<String, String> {
    let dir = notes_folder().join("briefs");
    std::fs::create_dir_all(&dir).map_err(err_str)?;
    let stem = naming::sanitize_title(&title);
    let path = dir.join(format!("{stem}.md"));
    std::fs::write(&path, body).map_err(err_str)?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn path_is_dir(path: String) -> bool {
    Path::new(&path).is_dir()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateNote {
    pub version: String,
    pub notes: String,
    pub date: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct UpdateLog {
    #[serde(default)]
    pending: Option<UpdateNote>,
    #[serde(default)]
    history: Vec<UpdateNote>,
}

fn update_log_path(paths: &AppPaths) -> PathBuf {
    paths.root.join("updates.json")
}

fn read_update_log(paths: &AppPaths) -> UpdateLog {
    let path = update_log_path(paths);
    let Ok(text) = std::fs::read_to_string(&path) else {
        return UpdateLog::default();
    };
    serde_json::from_str(&text).unwrap_or_default()
}

/// 1.2.0 is the customer opening. Notes from earlier releases are not part of it.
fn is_before_opening(version: &str) -> bool {
    cmp_release(version, "1.2.0") == std::cmp::Ordering::Less
}

fn forget_notes_before_opening(log: &mut UpdateLog) -> bool {
    let before = log.history.len();
    log.history.retain(|item| !is_before_opening(&item.version));
    let drop_pending = log.pending.as_ref().is_some_and(|item| is_before_opening(&item.version));
    if drop_pending {
        log.pending = None;
    }
    log.history.len() != before || drop_pending
}

fn load_update_log(paths: &AppPaths) -> UpdateLog {
    let mut log = read_update_log(paths);
    if forget_notes_before_opening(&mut log) {
        let _ = write_update_log(paths, &log);
    }
    log
}

fn write_update_log(paths: &AppPaths, log: &UpdateLog) -> Result<(), String> {
    paths.ensure().map_err(err_str)?;
    let text = serde_json::to_string_pretty(log).map_err(err_str)?;
    std::fs::write(update_log_path(paths), text).map_err(err_str)
}

/// Remember this release for About, and for the launch that is actually running it.
/// The welcome card waits until then: the launch that only finds the update has not
/// downloaded it yet.
#[tauri::command]
pub fn record_update_note(
    state: State<AppState>,
    version: String,
    notes: String,
    date: String,
) -> Result<(), String> {
    let version = version.trim().to_string();
    if version.is_empty() {
        return Ok(());
    }
    let note = UpdateNote {
        version: version.clone(),
        notes: notes.trim().to_string(),
        date,
    };
    let mut log = load_update_log(&state.paths);
    // 1.1.0 and 1.2.0 each replace every note from before that release.
    if version == "1.1.0" || version == "1.2.0" {
        log.history.clear();
    }
    // A release with no notes must not leave a card or a blank row.
    if note.notes.is_empty() {
        if log.pending.as_ref().is_some_and(|item| item.version == version) {
            log.pending = None;
        }
        return write_update_log(&state.paths, &log);
    }
    log.history.retain(|item| item.version != version);
    log.history.insert(0, note.clone());
    log.history.truncate(40);
    log.pending = Some(note);
    write_update_log(&state.paths, &log)
}

/// The note for the launch that is already running the installed version.
/// A newer pending note stays put while this process is still the old build.
/// Once shown, it is cleared, so closing without dismissing the card hides it next time.
#[tauri::command]
pub fn take_update_announcement(
    app: tauri::AppHandle,
    state: State<AppState>,
) -> Result<Option<UpdateNote>, String> {
    let mut log = load_update_log(&state.paths);
    let Some(pending) = log.pending.clone() else {
        return Ok(None);
    };
    let current = app.package_info().version.to_string();
    match pending_note_action(&current, &pending.version) {
        PendingNote::Wait => Ok(None),
        PendingNote::Show => {
            log.pending = None;
            write_update_log(&state.paths, &log)?;
            Ok(Some(pending))
        }
        PendingNote::Drop => {
            log.pending = None;
            write_update_log(&state.paths, &log)?;
            Ok(None)
        }
    }
}

enum PendingNote {
    Show,
    Wait,
    Drop,
}

/// Show only when this process is the release the note describes.
/// An older process still has the download ahead of it, so the note waits.
/// A newer process missed that launch; drop the stale note.
fn pending_note_action(current: &str, pending_version: &str) -> PendingNote {
    match cmp_release(current, pending_version) {
        std::cmp::Ordering::Equal => PendingNote::Show,
        std::cmp::Ordering::Less => PendingNote::Wait,
        std::cmp::Ordering::Greater => PendingNote::Drop,
    }
}

fn cmp_release(current: &str, pending: &str) -> std::cmp::Ordering {
    let parts = |text: &str| -> Vec<u64> {
        text.trim()
            .trim_start_matches(['v', 'V'])
            .split(|c: char| !c.is_ascii_digit())
            .filter(|part| !part.is_empty())
            .map(|part| part.parse::<u64>().unwrap_or(0))
            .collect()
    };
    let a = parts(current);
    let b = parts(pending);
    let n = a.len().max(b.len());
    for i in 0..n {
        let av = a.get(i).copied().unwrap_or(0);
        let bv = b.get(i).copied().unwrap_or(0);
        if av != bv {
            return av.cmp(&bv);
        }
    }
    std::cmp::Ordering::Equal
}

#[tauri::command]
pub fn update_note_history(state: State<AppState>) -> Result<Vec<UpdateNote>, String> {
    Ok(load_update_log(&state.paths).history)
}

#[tauri::command]
pub fn reveal_path(path: String) -> Result<(), String> {
    std::process::Command::new("explorer")
        .arg(format!("/select,{path}"))
        .spawn()
        .map_err(err_str)?;
    Ok(())
}

#[tauri::command]
pub fn write_summary_pdf(title: String, body: String, dest: String) -> Result<(), String> {
    export::write_summary_pdf(&title, &body, Path::new(&dest)).map_err(err_str)
}

fn assistant_label(host: &str) -> String {
    match host {
        "chatgpt" => "ask-chatgpt".into(),
        "gemini" => "ask-gemini".into(),
        _ => "ask-claude".into(),
    }
}

fn assistant_url(host: &str) -> &'static str {
    match host {
        "chatgpt" => "https://chatgpt.com/",
        "gemini" => "https://gemini.google.com/app",
        _ => "https://claude.ai/new",
    }
}

fn hide_assistant(app: &tauri::AppHandle, except: &str) {
    use tauri::{LogicalPosition, LogicalSize};
    for host in ["claude", "gemini", "chatgpt"] {
        let label = assistant_label(host);
        if label == except {
            continue;
        }
        if let Some(view) = app.get_webview(&label) {
            // Park off-screen so a failed hide cannot leave an invisible click shield.
            let _ = view.set_position(LogicalPosition::new(-8000.0, -8000.0));
            let _ = view.set_size(LogicalSize::new(1.0, 1.0));
            let _ = view.hide();
        }
    }
}

#[derive(Clone, Serialize)]
struct AssistantEvent {
    host: String,
    /// `loading` / `loaded`; detail is the url
    kind: String,
    detail: String,
}

fn emit_assistant(app: &tauri::AppHandle, host: &str, kind: &str, detail: String) {
    use tauri::Emitter;
    let _ = app.emit_to(
        "main",
        "assistant",
        AssistantEvent { host: host.into(), kind: kind.into(), detail },
    );
}

/// A browser view on a chat site. Each host keeps its own profile, so a login
/// in Ask and in quick questions is the same one for that site only.
fn chat_profile(state: &State<'_, AppState>, host: &str) -> std::path::PathBuf {
    state.paths.root.join("browser").join(match host {
        "chatgpt" => "chatgpt",
        "gemini" => "gemini",
        _ => "claude",
    })
}

fn chat_builder(
    state: &State<'_, AppState>,
    host: &str,
    label: &str,
    url: &str,
) -> Result<tauri::WebviewBuilder<tauri::Wry>, String> {
    let profile = chat_profile(state, host);
    std::fs::create_dir_all(&profile).map_err(err_str)?;
    let parsed: url::Url = url.parse().map_err(|e: url::ParseError| e.to_string())?;
    Ok(tauri::WebviewBuilder::new(label, tauri::WebviewUrl::External(parsed))
        .data_directory(profile)
        .enable_clipboard_access()
        .disable_drag_drop_handler()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
        .on_new_window(|_url, _features| tauri::webview::NewWindowResponse::Allow))
}

/// A browser pane inside the main window. Each host keeps its own profile, so a login survives.
/// Returns true when the pane was created now and is still loading.
#[tauri::command]
pub async fn assistant_show(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    host: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<bool, String> {
    use tauri::webview::PageLoadEvent;
    use tauri::{LogicalPosition, LogicalSize, Manager};
    let label = assistant_label(&host);
    let url = assistant_url(&host).to_string();
    hide_assistant(&app, &label);
    if let Some(view) = app.get_webview(&label) {
        view.set_position(LogicalPosition::new(x, y)).map_err(err_str)?;
        view.set_size(LogicalSize::new(w.max(200.0), h.max(120.0))).map_err(err_str)?;
        view.show().map_err(err_str)?;
        return Ok(false);
    }
    let (load_app, load_host) = (app.clone(), host.clone());
    // Once a pane is attached the window holds several webviews, so it is no longer a WebviewWindow.
    let window = app.get_window("main").ok_or("main window is missing")?;
    let builder = chat_builder(&state, &host, &label, &url)?
        .on_page_load(move |_view, payload| {
            let kind = match payload.event() {
                PageLoadEvent::Started => "loading",
                PageLoadEvent::Finished => "loaded",
            };
            emit_assistant(&load_app, &load_host, kind, payload.url().to_string());
        });
    window
        .add_child(builder, LogicalPosition::new(x, y), LogicalSize::new(w.max(200.0), h.max(120.0)))
        .map_err(err_str)?;
    Ok(true)
}

/// Back, forward, reload, or a fresh chat in the pane's browser.
#[tauri::command]
pub fn assistant_nav(app: tauri::AppHandle, host: String, action: String) -> Result<(), String> {
    use tauri::Manager;
    let Some(view) = app.get_webview(&assistant_label(&host)) else { return Ok(()) };
    match action.as_str() {
        "back" => view.eval("history.back()"),
        "forward" => view.eval("history.forward()"),
        "reload" => view.reload(),
        _ => view.navigate(assistant_url(&host).parse().map_err(|e: url::ParseError| e.to_string())?),
    }
    .map_err(err_str)
}

#[tauri::command]
pub fn assistant_bounds(app: tauri::AppHandle, host: String, x: f64, y: f64, w: f64, h: f64) -> Result<(), String> {
    use tauri::{LogicalPosition, LogicalSize, Manager};
    let Some(view) = app.get_webview(&assistant_label(&host)) else { return Ok(()) };
    view.set_position(LogicalPosition::new(x, y)).map_err(err_str)?;
    view.set_size(LogicalSize::new(w.max(200.0), h.max(120.0))).map_err(err_str)?;
    Ok(())
}

#[tauri::command]
pub fn assistant_hide(app: tauri::AppHandle) -> Result<(), String> {
    hide_assistant(&app, "");
    Ok(())
}

#[tauri::command]
pub fn assistant_focus(app: tauri::AppHandle, host: String) -> Result<(), String> {
    use tauri::Manager;
    if let Some(view) = app.get_webview(&assistant_label(&host)) {
        view.set_focus().map_err(err_str)?;
    }
    Ok(())
}

/// Files a chat can read, for each note: the page as a PDF (drawings included), its text as
/// Markdown with layout and colour, and every PDF that sits on the canvas.
struct StagedFiles {
    paths: Vec<PathBuf>,
    /// A PDF on the page was left out. The note's own export is still in `paths` when it worked.
    notice: Option<String>,
}

const NOT_SAVED: &str = "This note isn't saved yet, so it can't be attached.";
/// Originals bigger than this are not given to the chat page. WebView2 loads them in-process.
const MAX_MEDIA_PDF: usize = 20 * 1024 * 1024;
/// Above this size, or with too many pages, the original is still attached but not redrawn
/// into the note PDF. Rasterizing a long deck on top of many pen strokes can abort the process.
const MAX_RASTER_PDF: usize = 8 * 1024 * 1024;
const MAX_RASTER_PAGES: usize = 24;

fn saved_note_path(raw: &str) -> Result<PathBuf, String> {
    let raw = raw.trim();
    if raw.is_empty() || raw.contains('\0') {
        return Err(NOT_SAVED.into());
    }
    let path = PathBuf::from(raw);
    let note_ext = path
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("note"));
    if !note_ext || !path.is_file() {
        return Err(NOT_SAVED.into());
    }
    Ok(path)
}

fn load_saved_note(path: &Path) -> Result<NoteFile, String> {
    note::load_note(path).map_err(|err| {
        let msg = err.to_string().to_ascii_lowercase();
        if msg.contains("too large") || msg.contains("too many") {
            "This note is too large to attach.".into()
        } else {
            "Couldn't read this note.".into()
        }
    })
}

fn note_title(path: &Path) -> String {
    let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    match naming::display_title(&stem) {
        title if title.is_empty() => "Untitled note".into(),
        title => title,
    }
}

fn next_attach_base(title: &str) -> String {
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!("{} {n}", naming::sanitize_title(title))
}

fn embedded_pdf_pages(note: &NoteFile, media: &str) -> usize {
    let mut pages = 0usize;
    for obj in &note.doc.canvas.objects {
        if let note::CanvasObject::Pdf(pdf) = obj {
            if pdf.media == media {
                pages = pages.max(pdf.pages.len());
            }
        }
    }
    pages
}

fn safe_pdf_name(stored: &str) -> String {
    let raw = Path::new(stored)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let cleaned = naming::sanitize_title(&raw);
    if cleaned.to_ascii_lowercase().ends_with(".pdf") {
        cleaned
    } else if cleaned.is_empty() {
        "slides.pdf".into()
    } else {
        format!("{cleaned}.pdf")
    }
}

/// Export one file. A panic inside export becomes an error, and a half-written file is removed.
fn export_caught(note: &NoteFile, title: &str, dest: &Path, format: &str) -> Result<(), String> {
    let opts = ExportOptions {
        format: format.to_string(),
        page_numbers: true,
        title_header: Some(title.to_string()),
        export_date: false,
        geometry_block: false,
    };
    let written = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        export::export_note(note, title, dest, &opts)
    }));
    match written {
        Ok(Ok(())) => Ok(()),
        _ => {
            let _ = std::fs::remove_file(dest);
            Err("Couldn't export this note.".into())
        }
    }
}

fn stage_attachments(note_paths: &[String]) -> Result<StagedFiles, String> {
    let owned = note_paths.to_vec();
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| stage_attachments_work(&owned))) {
        Ok(result) => result,
        Err(_) => Err("Couldn't export this note.".into()),
    }
}

fn stage_attachments_work(note_paths: &[String]) -> Result<StagedFiles, String> {
    // Each send writes new names. The previous send's files stay: the chat pane still has
    // them open, and deleting them crashes WebView2.
    let dir = notes_folder().join("briefs").join("attachments");
    std::fs::create_dir_all(&dir).map_err(|_| "Couldn't prepare the attachment folder.".to_string())?;
    let mut out = Vec::new();
    let mut notice = None;
    for raw in note_paths {
        let path = saved_note_path(raw)?;
        let mut note = load_saved_note(&path)?;
        let title = note_title(&path);
        let base = next_attach_base(&title);
        let mut copies: Vec<(String, Vec<u8>)> = Vec::new();
        let mut seen = std::collections::HashSet::new();
        let pdfs: Vec<String> = note
            .media
            .keys()
            .filter(|name| name.to_ascii_lowercase().ends_with(".pdf"))
            .cloned()
            .collect();
        for name in pdfs {
            let len = note.media.get(&name).map(|bytes| bytes.len()).unwrap_or(0);
            let pages = embedded_pdf_pages(&note, &name);
            if len > MAX_MEDIA_PDF {
                note.media.remove(&name);
                notice = Some("A PDF on the page is too large, so it was left out.".to_string());
                continue;
            }
            let raster = len <= MAX_RASTER_PDF && pages <= MAX_RASTER_PAGES;
            let Some(bytes) = note.media.get(&name).cloned() else { continue };
            if !raster {
                note.media.remove(&name);
            }
            let mut file_name = safe_pdf_name(&name);
            if !seen.insert(file_name.to_ascii_lowercase()) {
                file_name = format!("{base} {file_name}");
                seen.insert(file_name.to_ascii_lowercase());
            }
            copies.push((file_name, bytes));
        }
        let pdf = dir.join(format!("{base}.pdf"));
        export_caught(&note, &title, &pdf, "pdf")?;
        out.push(pdf);
        let md = dir.join(format!("{base}.md"));
        export_caught(&note, &title, &md, "md")?;
        out.push(md);
        for (file_name, bytes) in copies {
            if bytes.len() > MAX_MEDIA_PDF {
                notice = Some("A PDF on the page is too large, so it was left out.".to_string());
                continue;
            }
            let dest = dir.join(format!("{base} - {file_name}"));
            if std::fs::write(&dest, bytes).is_err() {
                let _ = std::fs::remove_file(&dest);
                notice = Some("A PDF on the page couldn't be copied, so it was left out.".to_string());
                continue;
            }
            out.push(dest);
        }
    }
    Ok(StagedFiles { paths: out, notice })
}

/// One Chrome DevTools Protocol call in a pane. Unlike page script, input sent this way
/// counts as the user's own, so the chat accepts the files.
async fn cdp(view: &tauri::Webview, method: &str, params: serde_json::Value) -> Result<serde_json::Value, String> {
    let (tx, rx) = std::sync::mpsc::channel::<Result<serde_json::Value, String>>();
    let (method, params) = (method.to_string(), params.to_string());
    view.with_webview(move |pw| {
        use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
        use windows::core::{HSTRING, PCWSTR};
        let failed = tx.clone();
        let (method, params) = (HSTRING::from(method), HSTRING::from(params));
        let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |hr, json| {
            let out = hr
                .map_err(|e| e.message())
                .and_then(|()| serde_json::from_str(&json).map_err(err_str));
            let _ = tx.send(out);
            Ok(())
        }));
        let sent = unsafe {
            pw.controller().CoreWebView2().and_then(|core| {
                core.CallDevToolsProtocolMethod(PCWSTR(method.as_ptr()), PCWSTR(params.as_ptr()), &handler)
            })
        };
        if let Err(e) = sent {
            let _ = failed.send(Err(e.message()));
        }
    })
    .map_err(err_str)?;
    tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(std::time::Duration::from_secs(25)))
        .await
        .map_err(err_str)?
        .map_err(|_| "The chat page did not answer.".to_string())?
}

/// Runs an async page expression and returns its JSON value.
async fn page_eval(view: &tauri::Webview, expression: String) -> Result<serde_json::Value, String> {
    let res = cdp(
        view,
        "Runtime.evaluate",
        serde_json::json!({ "expression": expression, "awaitPromise": true, "returnByValue": true }),
    )
    .await?;
    if res.get("exceptionDetails").is_some_and(|ex| !ex.is_null()) {
        return Err("The chat page couldn't take that step.".into());
    }
    Ok(res.get("result").and_then(|r| r.get("value")).cloned().unwrap_or(serde_json::Value::Null))
}

/// Message boxes of the supported chat sites, then generic fallbacks.
const LOGIN_WALL_JS: &str = r#"
const owLoginWall = () => {
  const url = location.href;
  if (/\/(login|signin|sign-in|auth)(\/|$|\?)|accounts\.google\.|ServiceLogin/i.test(url)) return true;
  const shown = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 8 && r.height > 8;
  };
  const label = (el) => ((el.innerText || el.getAttribute('aria-label') || '')).replace(/\s+/g, ' ').trim();
  const nodes = [...document.querySelectorAll('button, a, [role="button"], h1, h2')].filter(shown);
  return nodes.some((el) => /^(log in|sign in|sign up|continue with google|continue with email|continue with apple)$/i.test(label(el)))
    || nodes.some((el) => (el.tagName === 'H1' || el.tagName === 'H2') && /sign in|log in/i.test(label(el)));
};
"#;

const COMPOSER_JS: &str = r#"
const owBox = () => {
  const selectors = [
    '#prompt-textarea',
    'div#prompt-textarea[contenteditable="true"]',
    'textarea#prompt-textarea',
    'div.ProseMirror[contenteditable="true"]',
    'rich-textarea [contenteditable="true"]',
    '.ql-editor[contenteditable="true"]',
    '[contenteditable="true"][role="textbox"]',
    'textarea',
  ];
  for (const s of selectors) {
    for (const el of document.querySelectorAll(s)) {
      const r = el.getBoundingClientRect();
      if (r.width > 60 && r.height > 8) return el;
    }
  }
  return null;
};
const owWalk = (node, fn) => {
  if (!node) return;
  if (node.nodeType === 11) { for (const c of node.childNodes) owWalk(c, fn); return; }
  if (node.nodeType === 3) { fn(node, null); return; }
  if (node.nodeType !== 1) return;
  fn(node, node);
  if (node.shadowRoot) owWalk(node.shadowRoot, fn);
  for (const c of node.childNodes) owWalk(c, fn);
};
const owBlob = () => {
  let t = "";
  owWalk(document.body, (node, el) => {
    if (!el) { t += node.textContent || ""; return; }
    t += "\n" + [el.getAttribute("title"), el.getAttribute("aria-label"), el.getAttribute("alt"), el.getAttribute("data-name"), el.getAttribute("aria-description")].filter(Boolean).join("\n");
  });
  return t.toLowerCase();
};
const owHits = (blob, mark) => {
  const needle = String(mark || "").toLowerCase().trim();
  const key = needle.length > 18 ? needle.slice(0, 18) : needle;
  if (key.length < 3) return 0;
  let n = 0, i = 0;
  while ((i = blob.indexOf(key, i)) >= 0) { n++; i += Math.max(1, key.length); }
  return n;
};
const owCount = (marks) => { const blob = owBlob(); return marks.map((m) => owHits(blob, m)); };
const owChip = (el) => {
  const tag = (el.tagName || "").toLowerCase();
  const cls = typeof el.className === "string" ? el.className.toLowerCase() : "";
  return tag.includes("file-preview") || tag.includes("uploader-file") || /file-preview|file-chip|attachment-chip|uploaded-file|upload-preview/.test(cls);
};
const owChips = () => { let n = 0; owWalk(document.body, (_n, el) => { if (el && owChip(el)) n++; }); return n; };
const owHeld = (marks) => {
  const names = [];
  owWalk(document.body, (_n, el) => {
    if (el && el.tagName === "INPUT" && el.type === "file" && el.files) {
      for (const f of el.files) names.push((f.name || "").toLowerCase());
    }
  });
  return marks.filter((m) => {
    const key = String(m || "").toLowerCase().slice(0, 18);
    return key.length >= 3 && names.some((name) => name.includes(key));
  }).length;
};
const owSleep = (ms) => new Promise((r) => setTimeout(r, ms));
"#;

/// Waits for the message box, focuses it, and returns its centre plus how often each
/// file name already shows on the page.
fn find_box_js(marks: &serde_json::Value) -> String {
    format!(
        r#"(async () => {{ {LOGIN_WALL_JS} {COMPOSER_JS}
  const started = Date.now();
  let box = null;
  while (Date.now() - started < 15000) {{
    if (owLoginWall()) return {{ found: false, signin: true, url: location.href }};
    box = owBox();
    if (box) break;
    await owSleep(400);
  }}
  if (owLoginWall()) return {{ found: false, signin: true, url: location.href }};
  if (!box) return {{ found: false, signin: false, url: location.href }};
  box.scrollIntoView({{ block: "nearest" }});
  box.focus();
  const r = box.getBoundingClientRect();
  return {{ found: true, x: r.left + r.width / 2, y: r.top + r.height / 2, before: owCount({marks}), chips: owChips() }};
}})()"#
    )
}

/// True once any file name shows up more often than before: the chat drew its attachment chip.
fn verify_js(marks: &serde_json::Value, before: &serde_json::Value, chips: &serde_json::Value) -> String {
    format!(
        r#"(async () => {{ {COMPOSER_JS}
  const before = {before};
  const chips0 = {chips};
  for (let i = 0; i < 8; i++) {{
    if (owCount({marks}).some((n, j) => n > (before[j] ?? 0))) return true;
    if (owChips() > chips0) return true;
    if (owHeld({marks}) > 0) return true;
    await owSleep(300);
  }}
  return false;
}})()"#
    )
}

/// Types into the message box, after what is there or (`replace`) instead of it.
fn type_text_js(text: &str, replace: bool) -> String {
    format!(
        r#"(async () => {{ {COMPOSER_JS}
  const text = {text};
  const replace = {replace};
  const box = owBox();
  if (!box) return false;
  box.focus();
  if (box instanceof HTMLTextAreaElement) {{
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    set.call(box, (box.value && !replace ? box.value + "\n" : "") + text);
    box.dispatchEvent(new Event("input", {{ bubbles: true }}));
    return true;
  }}
  const sel = getSelection();
  sel.selectAllChildren(box);
  if (!replace) sel.collapseToEnd();
  return document.execCommand("insertText", false, text);
}})()"#,
        text = serde_json::to_string(text).unwrap_or_else(|_| "\"\"".into()),
    )
}

/// A visible file input that takes PDFs, preferring one that takes several files.
const FILE_INPUT_JS: &str = r#"(() => {
  const ok = (i) => !i.disabled && (!i.accept || /pdf|application|\*|\.md|text/i.test(i.accept));
  const inputs = [...document.querySelectorAll('input[type="file"]')].filter(ok);
  return inputs.find((i) => i.multiple) || inputs[0] || null;
})()"#;

/// Hands the files to the page's own file input, as if picked in its file dialog.
async fn attach_by_input(view: &tauri::Webview, files: &[String]) -> Result<bool, String> {
    let res = cdp(view, "Runtime.evaluate", serde_json::json!({ "expression": FILE_INPUT_JS })).await?;
    let Some(object_id) = res["result"]["objectId"].as_str() else { return Ok(false) };
    cdp(view, "DOM.setFileInputFiles", serde_json::json!({ "files": files, "objectId": object_id })).await?;
    Ok(true)
}

/// Drops the files on the message box, as if dragged in from Explorer.
async fn attach_by_drop(view: &tauri::Webview, files: &[String], x: f64, y: f64) -> Result<(), String> {
    let data = serde_json::json!({ "items": [], "files": files, "dragOperationsMask": 1 });
    for kind in ["dragEnter", "dragOver", "drop"] {
        cdp(view, "Input.dispatchDragEvent", serde_json::json!({ "type": kind, "x": x, "y": y, "data": data })).await?;
    }
    Ok(())
}

#[derive(Serialize)]
pub struct AttachResult {
    /// File names, in the order they were attached.
    pub files: Vec<String>,
    /// The chat's message box was found and the question typed into it.
    pub found_box: bool,
    /// The chat shows the files as attachments.
    pub attached: bool,
    /// Set when a file on the page was left out. The note itself is still in `files` when it exported.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notice: Option<String>,
}

/// Put the notes and the question into the chat's message box. The files also go on the
/// clipboard, so Ctrl+V in the message box attaches them if the chat refuses them.
#[tauri::command]
pub async fn assistant_attach(
    app: tauri::AppHandle,
    host: String,
    note_paths: Vec<String>,
    text: String,
) -> Result<AttachResult, String> {
    use tauri::Manager;
    let staged = tauri::async_runtime::spawn_blocking(move || stage_attachments(&note_paths))
        .await
        .map_err(|_| "Couldn't prepare this note.".to_string())??;
    let notice = staged.notice;
    let paths: Vec<String> = staged.paths.iter().map(|p| plain_path(p)).collect();
    let names: Vec<String> = staged
        .paths
        .iter()
        .filter_map(|p| p.file_name().map(|s| s.to_string_lossy().to_string()))
        .collect();
    if !paths.is_empty() {
        copy_files_to_clipboard(&paths).map_err(|_| "Couldn't copy the files to the clipboard.".to_string())?;
    }
    let view = app.get_webview(&assistant_label(&host)).ok_or("The chat pane is not open.")?;
    let _ = view.set_focus();

    let marks = serde_json::json!(staged
        .paths
        .iter()
        .filter_map(|p| p.file_stem().map(|s| s.to_string_lossy().to_string()))
        .collect::<Vec<_>>());
    let found = page_eval(&view, find_box_js(&marks)).await?;
    if found["found"] != serde_json::Value::Bool(true) {
        return Ok(AttachResult { files: names, found_box: false, attached: false, notice });
    }
    let before = found["before"].clone();
    let chips = found.get("chips").cloned().unwrap_or(serde_json::json!(0));
    let mut attached = paths.is_empty();
    if !attached && attach_by_input(&view, &paths).await.unwrap_or(false) {
        // The page's own file input has the files. Gemini shows the chip inside a
        // shadow root, so the name check often misses an upload that did succeed.
        // A second drop would attach them again.
        let _ = page_eval(&view, verify_js(&marks, &before, &chips)).await;
        attached = true;
    } else if !attached {
        let (x, y) = (found["x"].as_f64().unwrap_or(0.0), found["y"].as_f64().unwrap_or(0.0));
        if attach_by_drop(&view, &paths, x, y).await.is_ok() {
            attached = page_eval(&view, verify_js(&marks, &before, &chips)).await.unwrap_or(serde_json::Value::Bool(false))
                == serde_json::Value::Bool(true);
        }
    }
    let text = text.trim();
    if !text.is_empty() {
        page_eval(&view, type_text_js(text, false)).await?;
    }
    let _ = view.set_focus();
    Ok(AttachResult { files: names, found_box: true, attached, notice })
}


fn is_chat_url(url: &url::Url, host: &str) -> bool {
    let valid_host = match host {
        "chatgpt" => matches!(url.host_str(), Some("chatgpt.com" | "chat.openai.com")),
        "gemini" => url.host_str() == Some("gemini.google.com"),
        _ => url.host_str() == Some("claude.ai"),
    };
    url.scheme() == "https" && valid_host
}

/// A saved conversation that can be opened again (private chats have no such address).
fn is_conversation_url(url: &str, host: &str) -> bool {
    let Ok(parsed) = url::Url::parse(url) else { return false };
    let prefix = match host {
        "chatgpt" => "/c/",
        "gemini" => "/app/",
        _ => "/chat/",
    };
    is_chat_url(&parsed, host) && parsed.path().strip_prefix(prefix).is_some_and(|id| !id.is_empty())
}

/// Open a conversation in the Ask pane, e.g. one started from a quick question.
#[tauri::command]
pub fn assistant_open(app: tauri::AppHandle, host: String, url: String) -> Result<(), String> {
    use tauri::Manager;
    let parsed: url::Url = url.parse().map_err(|e: url::ParseError| e.to_string())?;
    if !is_chat_url(&parsed, &host) {
        return Err("not a chat address".into());
    }
    let Some(view) = app.get_webview(&assistant_label(&host)) else { return Ok(()) };
    view.navigate(parsed).map_err(err_str)
}

/* ── Quick questions: a chat site in a background view, its reply read back as Markdown ── */

/// Bumped by every new quick question and by Stop; a running read loop ends when it changes.
static QUICK_RUN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
/// Serializes creating the offscreen quick webviews (avoids "label already exists" races).
static QUICK_VIEW_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn quick_label(host: &str) -> String {
    match host {
        "chatgpt" => "quick-chatgpt".into(),
        "gemini" => "quick-gemini".into(),
        _ => "quick-claude".into(),
    }
}

fn new_chat_url(host: &str) -> &'static str {
    match host {
        "chatgpt" => "https://chatgpt.com/",
        "gemini" => "https://gemini.google.com/app",
        _ => "https://claude.ai/new",
    }
}

#[derive(Clone, Serialize)]
struct QuickEvent {
    id: u64,
    /// Reply so far, as Markdown.
    text: String,
    done: bool,
    /// `signin`, `nobox`, `noreply`, or another message.
    error: Option<String>,
    /// Address of the conversation, so the Ask pane can continue it.
    url: Option<String>,
}

/// Chat-site status with no answer in it ("Claude is responding…", "Just now").
fn status_line(line: &str) -> bool {
    let l = line.trim().trim_matches(|c: char| {
        matches!(c, '.' | '…' | '·' | ' ' | '*' | '_' | '[' | ']' | '(' | ')')
    });
    if l.is_empty() {
        return true;
    }
    let lower = l.to_ascii_lowercase();
    if matches!(
        lower.as_str(),
        "responding"
            | "thinking"
            | "typing"
            | "writing"
            | "working"
            | "just now"
            | "edited"
            | "copied"
    ) {
        return true;
    }
    // "3 seconds ago", "Just now" glued on, or a short "X is responding" line.
    if lower.chars().count() <= 48
        && (lower.ends_with(" ago") || lower == "now" || lower.starts_with("just now"))
    {
        return true;
    }
    lower.ends_with("is responding")
        || lower.ends_with("is thinking")
        || lower.ends_with("is typing")
        || lower.ends_with("is writing")
        || lower.ends_with("is working")
}

fn status_only(text: &str) -> bool {
    let t = text.trim();
    if t.is_empty() {
        return false;
    }
    // Only a short chip ("Claude is responding", optionally with "Just now").
    // A normal sentence that happens to contain those words is left alone.
    t.chars().count() <= 120 && t.lines().all(status_line)
}

fn emit_quick(app: &tauri::AppHandle, ev: QuickEvent) {
    use tauri::Emitter;
    let _ = app.emit_to("main", "quick", ev);
}

/// Page helpers for the reply: where replies sit on each site, whether one is still being
/// written, and a converter from the rendered reply back to Markdown with LaTeX.
const REPLY_JS: &str = r#"
const plReplySel = [
  '[data-message-author-role="assistant"]', 'article[data-turn="assistant"]', '.agent-turn',
  '.font-claude-response', '.font-claude-message', '[data-testid="assistant-message"]',
  'model-response message-content', 'message-content', '.model-response-text', 'model-response',
];
const plReplyCounts = () => plReplySel.map((s) => document.querySelectorAll(s).length);
const owShown = (b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
const owButton = (cls, re) => [...document.querySelectorAll(`button.${cls}, button[aria-label]`)].find((b) =>
  owShown(b) && (b.classList.contains(cls) || re.test((b.getAttribute('aria-label') || '').trim())));
const owStopButton = () => {
  const labeled = [...document.querySelectorAll('button, [role="button"]')].find((b) => {
    if (!owShown(b)) return false;
    const s = ((b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('data-testid') || '') + ' ' + (b.className || '')).toLowerCase();
    return /\bstop\b/.test(s) || s.includes('interrupt') || s.includes('leállítás');
  });
  return labeled || owButton('stop', /^(stop\b|interrupt\b|válasz leállítása|leállítás)/i);
};
const owSendButton = () => {
  const b = owButton('send-button', /^(send( message)?|üzenet küldése|küldés)$/i);
  return b && !b.classList.contains('stop') && b !== owStopButton() ? b : null;
};
const owStopVisible = () => !!owStopButton();
const owTex = (el) => {
  const a = el.querySelector('annotation[encoding="application/x-tex"]');
  const t = a ? a.textContent : el.getAttribute('data-math');
  return t == null ? null : t.trim();
};
// Claude marks its thinking summary (and other page chrome) as data-find-omitted.
const owSkip = 'button, svg, style, script, .sr-only, [data-find-omitted], time, [datetime]';
const owBlockTags = /^(P|UL|OL|H[1-6]|PRE|TABLE|BLOCKQUOTE|HR|DIV|SECTION|ARTICLE)$/;
// Chat UI footers that ride along with the reply node (Claude / ChatGPT / Gemini).
const owChromeLine = /^(just now|edited|copied|regenerate|retry|good response|bad response|share|copy|claude (said|response)|chatgpt said|gemini said|\d+\s*(sec|secs|second|seconds|min|mins|minute|minutes|hr|hrs|hour|hours|d|day|days)\s*ago|responding|thinking|(?:\S+\s+){0,3}is (?:responding|thinking|typing|writing))[.…]*$/i;
const owMd = (root) => {
  const inline = (n) => {
    if (n.nodeType === 3) return n.textContent;
    if (n.nodeType !== 1) return '';
    const el = n;
    if (el.matches('.katex-display, .math-block')) { const t = owTex(el); if (t != null) return `\n$$${t}$$\n`; }
    if (el.matches('.katex, .math-inline, [data-math]')) { const t = owTex(el); if (t != null) return `$${t}$`; }
    if (el.matches(owSkip)) return '';
    const kids = [...el.childNodes].map(inline).join('');
    switch (el.tagName) {
      case 'STRONG': case 'B': return kids.trim() ? `**${kids}**` : kids;
      case 'EM': case 'I': return kids.trim() ? `*${kids}*` : kids;
      case 'CODE': return el.closest('pre') ? kids : '`' + kids + '`';
      case 'BR': return '\n';
      default: return kids;
    }
  };
  const hasBlocks = (el) => [...el.children].some((c) => owBlockTags.test(c.tagName) || c.tagName.includes('-'));
  const out = [];
  const list = (el, depth) => {
    const lines = [];
    let i = 1;
    for (const li of el.children) {
      if (li.tagName !== 'LI') continue;
      const clone = li.cloneNode(true);
      clone.querySelectorAll('ul, ol').forEach((x) => x.remove());
      const mark = el.tagName === 'OL' ? `${i++}. ` : '- ';
      lines.push('  '.repeat(depth) + mark + inline(clone).replace(/\s+/g, ' ').trim());
      for (const sub of li.querySelectorAll(':scope > ul, :scope > ol')) lines.push(list(sub, depth + 1));
    }
    return lines.join('\n');
  };
  const block = (el) => {
    for (const n of el.childNodes) {
      if (n.nodeType === 3) { if (n.textContent.trim()) out.push(n.textContent.trim()); continue; }
      if (n.nodeType !== 1) continue;
      const t = n.tagName;
      if (n.matches(owSkip)) continue;
      if (/^H[1-6]$/.test(t)) out.push('#'.repeat(Math.min(+t[1], 4)) + ' ' + inline(n).trim());
      else if (t === 'P') out.push(inline(n).trim());
      else if (t === 'UL' || t === 'OL') out.push(list(n, 0));
      else if (t === 'PRE') out.push('```\n' + n.innerText.replace(/\n$/, '') + '\n```');
      else if (t === 'HR') out.push('---');
      else if (t === 'BLOCKQUOTE') out.push(inline(n).trim().split('\n').map((l) => '> ' + l).join('\n'));
      else if (t === 'TABLE') out.push([...n.querySelectorAll('tr')].map((r) => [...r.children].map((c) => inline(c).trim()).join(' | ')).join('\n'));
      else if (n.matches('.katex-display, .math-block')) out.push(inline(n).trim());
      else if (hasBlocks(n)) block(n);
      else { const s = inline(n).trim(); if (s) out.push(s); }
    }
  };
  block(root);
  return out.filter(Boolean).filter((line) => !owChromeLine.test(line.trim())).join('\n\n')
    .replace(/\n*(Just now|Edited|\d+\s*(sec|secs|second|seconds|min|mins|minute|minutes|hr|hrs|hour|hours)\s*ago)\s*$/i, '')
    .trim();
};
"#;

/// What the background page looks like, for `quick-log.txt`.
fn quick_diag_js() -> String {
    format!(
        r#"(() => {{ {COMPOSER_JS} {REPLY_JS}
  const box = owBox();
  return {{
    url: location.href, title: document.title, ready: document.readyState, focus: document.hasFocus(),
    visibility: document.visibilityState,
    box: box ? (box.innerText || box.value || '').slice(0, 160) : null,
    replies: Object.fromEntries(plReplySel.map((s, i) => [s, plReplyCounts()[i]])),
    stop: owStopVisible(),
    send: !!owSendButton(),
    reply: (() => {{
      const k = plReplySel.findIndex((s) => document.querySelector(s));
      if (k < 0) return null;
      const all = document.querySelectorAll(plReplySel[k]);
      const shape = (el, d) => [...el.children].map((c) => '  '.repeat(d) + c.tagName.toLowerCase() + (c.className && typeof c.className === 'string' ? '.' + c.className.trim().split(/\s+/).slice(0, 4).join('.') : '') + [...c.attributes].filter((a) => /^(data-|aria-)/.test(a.name)).map((a) => `[${{a.name}}=${{a.value.slice(0, 30)}}]`).join('') + ' :: ' + (c.innerText || '').slice(0, 50).replace(/\n/g, ' ') + (d < 3 ? '\n' + shape(c, d + 1) : '')).join('\n');
      return {{ selector: plReplySel[k], shape: shape(all[all.length - 1], 0) }};
    }})(),
    buttons: [...document.querySelectorAll('button[aria-label]')].map((b) => b.getAttribute('aria-label') + (b.disabled ? ' (disabled)' : '')).filter((l) => !/^more options for /i.test(l)).slice(0, 40),
    tail: document.body ? document.body.innerText.slice(-400) : '',
  }};
}})()"#
    )
}

/// Debug-only trace of the background page. Release builds do not write chat text.
async fn quick_log(path: &Path, view: &tauri::Webview, step: &str) {
    if !cfg!(debug_assertions) {
        return;
    }
    use std::io::Write;
    let diag = page_eval(view, quick_diag_js()).await.unwrap_or_else(|e| serde_json::json!({ "error": e }));
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "[{}] {step}\n{}\n", chrono::Local::now().format("%H:%M:%S%.3f"), serde_json::to_string_pretty(&diag).unwrap_or_default());
    }
}

/// Remembers how many replies the page shows before the question goes out.
fn quick_mark_js() -> String {
    format!("(() => {{ {REPLY_JS} window.__plQuick = {{ before: plReplyCounts() }}; return true; }})()")
}

/// The newest reply since the mark, as Markdown, and whether the site is still writing it.
fn quick_read_js() -> String {
    format!(
        r#"(() => {{ {LOGIN_WALL_JS} {REPLY_JS}
  const before = (window.__plQuick && window.__plQuick.before) || [];
  const now = plReplyCounts();
  const k = now.findIndex((n, i) => n > (before[i] ?? 0));
  const writing = owStopVisible() || !!document.querySelector('[data-is-streaming="true"], [data-is-streaming="1"], .result-streaming, [data-testid="stop-button"]');
  const signin = owLoginWall();
  if (k < 0) return {{ found: false, writing, signin, url: location.href }};
  const all = document.querySelectorAll(plReplySel[k]);
  const el = all[all.length - 1];
  return {{ found: true, writing, signin, text: owMd(el), url: location.href }};
}})()"#
    )
}

/// Clicks the site's send button; returns false when there is none to click.
/// Synchronous on purpose: the click navigates the page, and an awaited script then
/// dies with a Windows error instead of returning.
fn quick_send_js() -> String {
    format!(
        r#"(() => {{ {REPLY_JS}
  const btn = owSendButton();
  if (!btn || btn.disabled) return false;
  btn.click();
  return true;
}})()"#
    )
}

fn quick_stop_js() -> String {
    format!("(() => {{ {REPLY_JS} const btn = owStopButton(); if (btn) btn.click(); return !!btn; }})()")
}

/// The background view for quick questions: same profile as the Ask pane, placed outside the
/// window so it never covers the app while the page still runs at full speed.
async fn quick_view(app: &tauri::AppHandle, state: &State<'_, AppState>, host: &str) -> Result<(tauri::Webview, bool), String> {
    use tauri::{LogicalPosition, LogicalSize, Manager};
    let label = quick_label(host);
    // Serialize create so Strict Mode / double Analyze cannot both race past get_webview
    // and hit "label already exists". Never hold the mutex across an await.
    let create_result = {
        let _guard = QUICK_VIEW_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(view) = app.get_webview(&label) {
            return Ok((view, false));
        }
        let window = app.get_window("main").ok_or("main window is missing")?;
        let builder = chat_builder(state, host, &label, new_chat_url(host))?;
        match window.add_child(
            builder,
            LogicalPosition::new(-6000.0, -6000.0),
            LogicalSize::new(900.0, 1000.0),
        ) {
            Ok(view) => return Ok((view, true)),
            Err(e) => {
                if let Some(view) = app.get_webview(&label) {
                    return Ok((view, false));
                }
                e.to_string()
            }
        }
    };
    // WebView2 sometimes registers the label before Manager exposes get_webview.
    if create_result.to_ascii_lowercase().contains("already exists") {
        for _ in 0..20 {
            tokio_sleep(std::time::Duration::from_millis(50)).await;
            if let Some(view) = app.get_webview(&label) {
                return Ok((view, false));
            }
        }
    }
    Err(create_result)
}

/// Write a PNG from base64 into the attachments folder. Used by Analyze.
#[tauri::command]
pub fn stage_analyze_png(png_b64: String) -> Result<String, String> {
    let bytes = base64_decode(&png_b64)?;
    let dir = notes_folder().join("briefs").join("attachments");
    std::fs::create_dir_all(&dir).map_err(err_str)?;
    let name = format!("analyze-{}.png", chrono::Utc::now().timestamp_millis());
    let path = dir.join(&name);
    std::fs::write(&path, &bytes).map_err(err_str)?;
    Ok(plain_path(&path))
}

/// Capture a rectangle of the desktop (physical pixels: `screenX`/`screenY` style) as PNG base64.
#[tauri::command]
pub fn capture_screen_region(x: i32, y: i32, width: u32, height: u32) -> Result<String, String> {
    if width == 0 || height == 0 || width > 8192 || height > 8192 {
        return Err("Capture area is empty or too large.".into());
    }
    #[cfg(not(windows))]
    {
        let _ = (x, y, width, height);
        Err("Screen capture is only available on Windows.".into())
    }
    #[cfg(windows)]
    {
        capture_desktop_region(x, y, width, height)
    }
}

#[cfg(windows)]
fn capture_desktop_region(x: i32, y: i32, width: u32, height: u32) -> Result<String, String> {
    use windows::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC,
        GetDIBits, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
        HGDIOBJ, SRCCOPY,
    };

    unsafe {
        let screen = GetDC(None);
        if screen.is_invalid() {
            return Err("Couldn't open the screen.".into());
        }
        let mem = CreateCompatibleDC(Some(screen));
        if mem.is_invalid() {
            ReleaseDC(None, screen);
            return Err("Couldn't create a capture buffer.".into());
        }
        let bmp = CreateCompatibleBitmap(screen, width as i32, height as i32);
        if bmp.is_invalid() {
            let _ = DeleteDC(mem);
            ReleaseDC(None, screen);
            return Err("Couldn't create a capture bitmap.".into());
        }
        let old = SelectObject(mem, HGDIOBJ(bmp.0));
        let ok = BitBlt(mem, 0, 0, width as i32, height as i32, Some(screen), x, y, SRCCOPY);
        if ok.is_err() {
            SelectObject(mem, old);
            let _ = DeleteObject(HGDIOBJ(bmp.0));
            let _ = DeleteDC(mem);
            ReleaseDC(None, screen);
            return Err("Couldn't copy the screen region.".into());
        }

        let mut info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width as i32,
                biHeight: -(height as i32), // top-down
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                biSizeImage: 0,
                biXPelsPerMeter: 0,
                biYPelsPerMeter: 0,
                biClrUsed: 0,
                biClrImportant: 0,
            },
            bmiColors: [Default::default()],
        };
        let stride = (width as usize) * 4;
        let mut pixels = vec![0u8; stride * height as usize];
        let got = GetDIBits(
            mem,
            bmp,
            0,
            height,
            Some(pixels.as_mut_ptr() as *mut _),
            &mut info,
            DIB_RGB_COLORS,
        );
        SelectObject(mem, old);
        let _ = DeleteObject(HGDIOBJ(bmp.0));
        let _ = DeleteDC(mem);
        ReleaseDC(None, screen);
        if got == 0 {
            return Err("Couldn't read the capture pixels.".into());
        }

        // BGRA → RGBA for the image crate
        for px in pixels.chunks_exact_mut(4) {
            px.swap(0, 2);
        }
        let img = image::RgbaImage::from_raw(width, height, pixels)
            .ok_or_else(|| "Couldn't build the capture image.".to_string())?;
        let mut png = Vec::new();
        image::DynamicImage::ImageRgba8(img)
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .map_err(|e| e.to_string())?;
        Ok(base64_encode(&png))
    }
}

/// Ask a chat site a question in the background and stream its reply as `quick` events.
/// `fresh` starts a new conversation; otherwise the question follows up in the current one.
/// `file_paths` are extra files (e.g. Analyze PNGs) attached alongside any notes.
#[tauri::command]
pub async fn quick_ask(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: u64,
    host: String,
    text: String,
    fresh: bool,
    private: Option<bool>,
    note_paths: Option<Vec<String>>,
    file_paths: Option<Vec<String>>,
) -> Result<(), String> {
    use std::sync::atomic::Ordering;
    use std::time::{Duration, Instant};
    let run = QUICK_RUN.fetch_add(1, Ordering::SeqCst) + 1;
    let live = || QUICK_RUN.load(Ordering::SeqCst) == run;
    let fail = |error: &str, url: Option<String>| {
        emit_quick(&app, QuickEvent { id, text: String::new(), done: true, error: Some(error.into()), url });
    };
    let log = state.paths.root.join("quick-log.txt");
    let _ = std::fs::write(&log, format!("{host} fresh={fresh}\n\n"));
    let (view, created) = quick_view(&app, &state, &host).await?;
    if fresh && !created {
        view.navigate(new_chat_url(&host).parse().map_err(|e: url::ParseError| e.to_string())?)
            .map_err(err_str)?;
    }
    if fresh || created {
        tokio_sleep(Duration::from_millis(1200)).await;
    }
    let mut found = page_eval(&view, find_box_js(&serde_json::json!([]))).await?;
    quick_log(&log, &view, &format!("message box: {found}")).await;
    if found["signin"] == serde_json::Value::Bool(true) {
        let url = found["url"].as_str().map(str::to_string);
        fail("signin", url);
        return Ok(());
    }
    if fresh && private.unwrap_or(false) && found["found"] == serde_json::Value::Bool(true) {
        let toggled = page_eval(&view, quick_private_js()).await.unwrap_or_default();
        if toggled == serde_json::Value::Bool(true) {
            tokio_sleep(Duration::from_millis(900)).await;
            found = page_eval(&view, find_box_js(&serde_json::json!([]))).await?;
        }
        quick_log(&log, &view, &format!("private chat: {toggled}")).await;
    }
    if found["found"] != serde_json::Value::Bool(true) {
        let url = found["url"].as_str().map(str::to_string);
        let signin = found["signin"] == serde_json::Value::Bool(true)
            || url.as_deref().is_some_and(|u| {
                ["login", "signin", "sign-in", "accounts.google.", "ServiceLogin"]
                    .iter()
                    .any(|k| u.contains(k))
            });
        fail(if signin { "signin" } else { "nobox" }, url);
        return Ok(());
    }
    let mut attach_paths: Vec<String> = Vec::new();
    let mut attach_marks: Vec<String> = Vec::new();
    if let Some(note_paths) = note_paths.filter(|p| !p.is_empty()) {
        let staged = tauri::async_runtime::spawn_blocking(move || stage_attachments(&note_paths)).await;
        if let Ok(Ok(staged)) = staged {
            for p in &staged.paths {
                attach_paths.push(plain_path(p));
                if let Some(stem) = p.file_stem() {
                    attach_marks.push(stem.to_string_lossy().to_string());
                }
            }
        }
    }
    if let Some(extra) = file_paths.filter(|p| !p.is_empty()) {
        for raw in extra {
            let p = PathBuf::from(raw.trim());
            if !p.is_file() {
                continue;
            }
            attach_paths.push(plain_path(&p));
            if let Some(stem) = p.file_stem() {
                attach_marks.push(stem.to_string_lossy().to_string());
            }
        }
    }
    if !attach_paths.is_empty() {
        let marks = serde_json::json!(attach_marks);
        let before = found["before"].clone();
        let chips = found.get("chips").cloned().unwrap_or(serde_json::json!(0));
        let _ = copy_files_to_clipboard(&attach_paths);
        if !attach_by_input(&view, &attach_paths).await.unwrap_or(false) {
            let (x, y) = (found["x"].as_f64().unwrap_or(0.0), found["y"].as_f64().unwrap_or(0.0));
            let _ = attach_by_drop(&view, &attach_paths, x, y).await;
        }
        let _ = page_eval(&view, verify_js(&marks, &before, &chips)).await;
        // Give the chat a moment to show the image chip before the message is typed.
        tokio_sleep(Duration::from_millis(600)).await;
    }
    page_eval(&view, quick_mark_js()).await?;
    let typed = page_eval(&view, type_text_js(text.trim(), true)).await?;
    quick_log(&log, &view, &format!("typed: {typed}")).await;
    tokio_sleep(Duration::from_millis(250)).await;
    // A click that sends the message also leaves the page, so the script result can
    // fail even though the question went out. Poll for the reply either way.
    let clicked = page_eval(&view, quick_send_js()).await.unwrap_or_else(|e| serde_json::json!(e));
    quick_log(&log, &view, &format!("send button clicked: {clicked}")).await;
    if clicked == serde_json::Value::Bool(false) {
        for kind in ["keyDown", "keyUp"] {
            let _ = cdp(
                &view,
                "Input.dispatchKeyEvent",
                serde_json::json!({ "type": kind, "key": "Enter", "code": "Enter", "windowsVirtualKeyCode": 13, "text": if kind == "keyDown" { "\r" } else { "" } }),
            )
            .await;
        }
    }

    let started = Instant::now();
    let mut last = String::new();
    let mut steady = 0u32;
    let mut url = None;
    let mut polls = 0u32;
    while live() {
        tokio_sleep(Duration::from_millis(350)).await;
        polls += 1;
        let read = page_eval(&view, quick_read_js()).await.unwrap_or_default();
        if polls == 3 || polls.is_multiple_of(20) {
            quick_log(&log, &view, &format!("poll {polls}: {}", serde_json::to_string(&read).unwrap_or_default().chars().take(300).collect::<String>())).await;
        }
        url = read["url"].as_str().filter(|u| is_conversation_url(u, &host)).map(String::from).or(url);
        let found = read["found"] == serde_json::Value::Bool(true);
        let raw = read["text"].as_str().unwrap_or_default().to_string();
        // "Claude is responding…" is page chrome, not the answer. Treating it as
        // the reply makes that line vanish again as soon as the real text starts,
        // and a quiet stretch looks like the card gave up.
        let placeholder = status_only(&raw);
        let writing = read["writing"] == serde_json::Value::Bool(true) || placeholder;
        let text = if placeholder { String::new() } else { raw };
        let signed_out = read["signin"] == serde_json::Value::Bool(true);
        if signed_out && text.is_empty() && started.elapsed() > Duration::from_secs(5) {
            fail("signin", url.clone().or_else(|| read["url"].as_str().map(str::to_string)));
            return Ok(());
        }
        // A status line, a blank scrape, or a still-writing page is not a finished
        // answer. Counting those toward "steady" is what cleared the "is responding"
        // line and then sat there while the model was still going.
        if !found || writing || text.is_empty() {
            steady = 0;
        } else if text != last {
            last = text.clone();
            steady = 0;
            emit_quick(&app, QuickEvent { id, text, done: false, error: None, url: url.clone() });
        } else {
            steady += 1;
        }
        // About 2.5 s of unchanged text with no stop button: models often pause
        // mid-answer (thinking, tool use), and ending early hides the waiting row.
        if found && !writing && !last.is_empty() && steady >= 7 {
            break;
        }
        if !found && !writing && started.elapsed() > Duration::from_secs(90) {
            fail("noreply", url);
            return Ok(());
        }
        if started.elapsed() > Duration::from_secs(300) {
            break;
        }
    }
    quick_log(&log, &view, &format!("done after {polls} polls")).await;
    emit_quick(&app, QuickEvent { id, text: last, done: true, error: None, url });
    Ok(())
}

/// Stop the reply being written for a quick question.
#[tauri::command]
pub async fn quick_stop(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    QUICK_RUN.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    for host in ["claude", "gemini", "chatgpt"] {
        if let Some(view) = app.get_webview(&quick_label(host)) {
            let _ = page_eval(&view, quick_stop_js()).await;
        }
    }
    Ok(())
}

/// Switches a new chat to the site's private mode; false when the page has no such switch
/// or it is already on.
fn quick_private_js() -> String {
    format!(
        r#"(() => {{ {REPLY_JS}
  const re = /^(use incognito|incognito|temporary chat|ideiglenes csevegés|inkognitó mód)$/i;
  const btn = [...document.querySelectorAll('button[aria-label], a[aria-label]')].find((b) =>
    owShown(b) && re.test((b.getAttribute('aria-label') || '').trim()));
  if (!btn || btn.getAttribute('aria-pressed') === 'true' || btn.getAttribute('aria-checked') === 'true') return false;
  btn.click();
  return true;
}})()"#
    )
}

/// The card or Brief is done with the background chat: close its views after a while unless
/// another question comes first, so two idle browsers don't stay in memory.
#[tauri::command]
pub async fn quick_release(app: tauri::AppHandle) -> Result<(), String> {
    use std::sync::atomic::Ordering;
    use tauri::Manager;
    let run = QUICK_RUN.load(Ordering::SeqCst);
    tokio_sleep(std::time::Duration::from_secs(120)).await;
    if QUICK_RUN.load(Ordering::SeqCst) != run {
        return Ok(());
    }
    for host in ["claude", "gemini", "chatgpt"] {
        if let Some(view) = app.get_webview(&quick_label(host)) {
            let _ = view.close();
        }
    }
    Ok(())
}

async fn tokio_sleep(d: std::time::Duration) {
    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(d)).await;
}

fn plain_path(path: &std::path::Path) -> String {
    let abs = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_default().join(path)
    };
    abs.to_string_lossy().trim_start_matches(r"\\?\").replace('/', "\\")
}

fn copy_files_to_clipboard(paths: &[String]) -> anyhow::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::DataExchange::{CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData};
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
    use windows::Win32::UI::Shell::DROPFILES;
    use windows::core::BOOL;

    let mut wide: Vec<u16> = Vec::new();
    for p in paths {
        wide.extend(std::ffi::OsStr::new(p).encode_wide());
        wide.push(0);
    }
    wide.push(0);
    let header = std::mem::size_of::<DROPFILES>();
    let bytes = header + wide.len() * 2;
    unsafe {
        let hglobal = GlobalAlloc(GMEM_MOVEABLE, bytes).map_err(|e| anyhow::anyhow!(e.to_string()))?;
        let ptr = GlobalLock(hglobal);
        if ptr.is_null() {
            anyhow::bail!("clipboard lock failed");
        }
        let drop = ptr as *mut DROPFILES;
        (*drop).pFiles = header as u32;
        (*drop).pt = windows::Win32::Foundation::POINT { x: 0, y: 0 };
        (*drop).fNC = BOOL(0);
        (*drop).fWide = BOOL(1);
        std::ptr::copy_nonoverlapping(wide.as_ptr() as *const u8, (ptr as *mut u8).add(header), wide.len() * 2);
        GlobalUnlock(hglobal).ok();
        OpenClipboard(None).map_err(|e| anyhow::anyhow!(e.to_string()))?;
        if let Err(e) = EmptyClipboard() {
            let _ = CloseClipboard();
            anyhow::bail!(e.to_string());
        }
        if let Err(e) = SetClipboardData(15, Some(HANDLE(hglobal.0))) {
            let _ = CloseClipboard();
            anyhow::bail!(e.to_string());
        }
        CloseClipboard().map_err(|e| anyhow::anyhow!(e.to_string()))?;
    }
    Ok(())
}

#[tauri::command]
pub fn license_price() -> Result<String, String> {
    Ok(String::new())
}

#[tauri::command]
pub fn license_status(state: State<AppState>) -> Result<serde_json::Value, String> {
    let _ = state;
    Err("unavailable".into())
}

#[tauri::command]
pub fn license_refresh(state: State<AppState>, key: Option<String>) -> Result<serde_json::Value, String> {
    let _ = (state, key);
    Err("unavailable".into())
}

#[tauri::command]
pub fn license_transfer(state: State<AppState>, key: String) -> Result<serde_json::Value, String> {
    let _ = (state, key);
    Err("unavailable".into())
}

#[tauri::command]
pub fn feedback_send(state: State<AppState>, body: String) -> Result<serde_json::Value, String> {
    crate::feedback::send(&state.paths, &body)
}

#[tauri::command]
pub fn feedback_list(state: State<AppState>) -> Result<serde_json::Value, String> {
    crate::feedback::list(&state.paths)
}

#[tauri::command]
pub fn feedback_seen(state: State<AppState>, thread_id: String) -> Result<(), String> {
    crate::feedback::seen(&state.paths, &thread_id)
}

#[tauri::command]
pub fn feedback_reply(state: State<AppState>, thread_id: String, body: String) -> Result<serde_json::Value, String> {
    crate::feedback::reply(&state.paths, &thread_id, &body)
}

#[tauri::command]
pub fn uninstall_app(state: State<AppState>, wipe: bool) -> Result<String, String> {
    if wipe {
        if let Ok(home) = state::load_home(&state.paths) {
            fn walk(items: &[crate::state::HomeItem]) {
                for it in items {
                    match it {
                        crate::state::HomeItem::Notebook { path } | crate::state::HomeItem::Note { path } => {
                            let p = std::path::Path::new(path);
                            if p.is_dir() {
                                let _ = std::fs::remove_dir_all(p);
                            } else {
                                let _ = std::fs::remove_file(p);
                            }
                        }
                        crate::state::HomeItem::Group { items, .. } => walk(items),
                    }
                }
            }
            walk(&home.items);
        }
        if let Ok(profile) = std::env::var("USERPROFILE") {
            let docs = std::path::PathBuf::from(profile).join("Documents").join("Paperlike");
            let _ = std::fs::remove_dir_all(docs);
        }
        let _ = std::fs::remove_dir_all(&state.paths.root);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let un = dir.join("uninstall.exe");
            if un.exists() {
                let _ = std::process::Command::new(un).spawn();
                return Ok("uninstaller".into());
            }
        }
    }
    Ok("portable".into())
}

#[derive(Serialize)]
pub struct ImportedMarkdown {
    pub path: String,
    pub warnings: Vec<String>,
}

#[tauri::command]
pub fn import_markdown(src: String, dest_dir: String) -> Result<ImportedMarkdown, String> {
    gate_edit()?;
    let md = std::fs::read_to_string(&src).map_err(err_str)?;
    let mut imported = crate::md_import::parse_markdown(&md)?;
    let raw_stem = Path::new(&src)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "Imported".into());
    let stem = crate::md_import::import_stem(imported.title.as_deref(), &raw_stem);
    let dest = naming::unique_note_path(Path::new(&dest_dir), &stem);
    note::normalize_media(&mut imported.note);
    note::save_note(&dest, &mut imported.note).map_err(err_str)?;
    Ok(ImportedMarkdown {
        path: dest.to_string_lossy().to_string(),
        warnings: imported.warnings,
    })
}

const GOOGLE_EMAIL_JS: &str = r#"(() => {
  const re = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/;
  for (const el of document.querySelectorAll('[data-email], [data-identifier]')) {
    const v = el.getAttribute('data-email') || el.getAttribute('data-identifier') || '';
    const m = v.match(re);
    if (m) return m[0];
  }
  for (const el of document.querySelectorAll('[aria-label]')) {
    const m = (el.getAttribute('aria-label') || '').match(re);
    if (m) return m[0];
  }
  const text = document.body ? document.body.innerText.slice(0, 8000) : '';
  const m = text.match(re);
  return m ? m[0] : '';
})()"#;

#[tauri::command]
pub fn google_status(state: State<'_, AppState>) -> crate::google_account::GoogleStatus {
    crate::google_account::status(&state.paths)
}

const GOOGLE_PAGE: &str = "google-page";
const GOOGLE_LOGIN_URL: &str =
    "https://accounts.google.com/ServiceLogin?continue=https://myaccount.google.com/personal-info";

fn close_google_window(app: &tauri::AppHandle) {
    if let Some(view) = app.get_webview(GOOGLE_PAGE) {
        let _ = view.close();
    }
}

static GOOGLE_GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static GOOGLE_BUSY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

struct GoogleBusy;
impl Drop for GoogleBusy {
    fn drop(&mut self) {
        GOOGLE_BUSY.store(false, std::sync::atomic::Ordering::Release);
    }
}

/// Move a half-broken profile aside. Deleting it in place never returns, so the
/// sign-in page stays on "Opening Google…".
fn fresh_google_profile(root: &std::path::Path, linked: bool) -> Result<std::path::PathBuf, String> {
    let profile = root.join("browser").join("google");
    if !linked && profile.exists() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let aside = root.join("browser").join(format!("google-old-{stamp}"));
        // A locked folder is left in place. Signing in still has to open.
        let _ = std::fs::rename(&profile, &aside);
    }
    std::fs::create_dir_all(&profile).map_err(err_str)?;
    Ok(profile)
}

/// The Google page is its own pane on the main window, same kind of view as Ask.
/// A separate OS window stayed a blank white page.
#[tauri::command]
pub async fn google_show(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    use std::sync::atomic::Ordering;
    use tauri::{LogicalPosition, LogicalSize, Manager};
    let paths = state.paths.clone();
    crate::google_account::prepare(&paths)?;
    let width = w.max(200.0);
    let height = h.max(200.0);
    if let Some(view) = app.get_webview(GOOGLE_PAGE) {
        view.set_position(LogicalPosition::new(x, y)).map_err(err_str)?;
        view.set_size(LogicalSize::new(width, height)).map_err(err_str)?;
        view.show().map_err(err_str)?;
        return Ok(());
    }
    if GOOGLE_BUSY.swap(true, Ordering::AcqRel) {
        return Ok(());
    }
    let _busy = GoogleBusy;
    let gen = GOOGLE_GEN.load(Ordering::Acquire);
    let linked = crate::google_account::status(&paths).linked;
    let root = paths.root.clone();
    let profile = tauri::async_runtime::spawn_blocking(move || fresh_google_profile(&root, linked))
        .await
        .map_err(err_str)??;
    if GOOGLE_GEN.load(Ordering::Acquire) != gen {
        return Ok(());
    }
    let start: url::Url = GOOGLE_LOGIN_URL.parse().map_err(|e: url::ParseError| e.to_string())?;
    let window = app.get_window("main").ok_or("main window is missing")?;
    let builder = tauri::webview::WebviewBuilder::new(GOOGLE_PAGE, tauri::WebviewUrl::External(start))
        .data_directory(profile)
        .background_color(tauri::webview::Color(255, 255, 255, 255))
        .enable_clipboard_access()
        .disable_drag_drop_handler()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
        .on_new_window(|_url, _features| tauri::webview::NewWindowResponse::Allow);
    window
        .add_child(builder, LogicalPosition::new(x, y), LogicalSize::new(width, height))
        .map_err(err_str)?;
    if GOOGLE_GEN.load(Ordering::Acquire) != gen {
        close_google_window(&app);
    }
    Ok(())
}

#[tauri::command]
pub fn google_hide(app: tauri::AppHandle) {
    GOOGLE_GEN.fetch_add(1, std::sync::atomic::Ordering::AcqRel);
    close_google_window(&app);
}

#[tauri::command]
pub async fn google_capture(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<String, String> {
    let view = app
        .get_webview(GOOGLE_PAGE)
        .ok_or("The Google window is closed. Sign in with Google again.")?;
    let value = cdp(
        &view,
        "Runtime.evaluate",
        serde_json::json!({ "expression": GOOGLE_EMAIL_JS, "returnByValue": true }),
    )
    .await?;
    let email = value
        .pointer("/result/value")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if email.is_empty() {
        let url = "https://myaccount.google.com/personal-info"
            .parse()
            .map_err(|e: url::ParseError| e.to_string())?;
        view.navigate(url).map_err(err_str)?;
        return Err("Sign in on the Google page, then click Use this Google account again.".into());
    }
    let paths = state.paths.clone();
    let email = tauri::async_runtime::spawn_blocking(move || crate::google_account::finish(&paths, &email))
        .await
        .map_err(err_str)??;
    close_google_window(&app);
    Ok(email)
}

#[tauri::command]
pub fn google_forget(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<String, String> {
    let message = crate::google_account::forget(&state.paths)?;
    close_google_window(&app);
    Ok(message)
}

#[cfg(test)]
mod tests {
    use super::pending_note_action;

    #[test]
    fn notes_before_1_2_0_are_not_part_of_the_opening() {
        assert!(super::is_before_opening("1.1.9"));
        assert!(super::is_before_opening("0.1.32"));
        assert!(!super::is_before_opening("1.2.0"));
        assert!(!super::is_before_opening("1.2.1"));
    }

    fn welcome_note_waits_until_that_version_is_running() {
        assert!(matches!(pending_note_action("0.1.19", "0.1.20"), super::PendingNote::Wait));
        assert!(matches!(pending_note_action("0.1.20", "0.1.20"), super::PendingNote::Show));
        assert!(matches!(pending_note_action("v0.1.20", "0.1.20"), super::PendingNote::Show));
        assert!(matches!(pending_note_action("0.1.21", "0.1.20"), super::PendingNote::Drop));
    }
}

