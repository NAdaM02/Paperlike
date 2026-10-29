//! App state under %APPDATA%\Paperlike — specs/app-state.md

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::Result;
use serde::{Deserialize, Serialize};

use crate::atomic;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum HomeItem {
    Notebook { path: String },
    Note { path: String },
    Group { name: String, items: Vec<HomeItem> },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HomeState {
    pub version: u32,
    pub items: Vec<HomeItem>,
}

impl Default for HomeState {
    fn default() -> Self {
        Self {
            version: 1,
            items: vec![],
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportDefaults {
    pub page_numbers: bool,
    pub title_headers: bool,
    pub export_date: bool,
    pub geometry_block: bool,
}

impl Default for ExportDefaults {
    fn default() -> Self {
        Self {
            page_numbers: true,
            title_headers: true,
            export_date: false,
            geometry_block: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    pub version: u32,
    pub theme: String,
    pub autosave: bool,
    pub export_defaults: ExportDefaults,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_export_dir: Option<String>,
    /// Prefetch updates and install them when the window closes. On by default.
    #[serde(default = "default_true")]
    pub update_on_exit: bool,
    #[serde(default)]
    pub autostart: bool,
    #[serde(default)]
    pub tray: bool,
    #[serde(default)]
    pub welcome_dismissed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub today_format: Option<String>,
    /// First-run study card has been answered. Missing on old files, so it stays false.
    #[serde(default)]
    pub study_prompted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub study_preset: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub study_root: Option<String>,
    /// Moodle course browser. The browser itself is separate; this only stores the choice.
    #[serde(default)]
    pub moodle_enabled: bool,
    /// Windows Ink. Off treats the pen like a mouse (no pressure, coalescing, or palm rejection).
    #[serde(default = "default_true")]
    pub pen_enabled: bool,
    /// A pen press draws with the last pen or marker even when Select (or another tool) is active.
    #[serde(default = "default_true")]
    pub pen_always_draws: bool,
    /// Stroke width follows pen pressure.
    #[serde(default = "default_true")]
    pub pen_pressure: bool,
    /// Ignore touch pointer-downs while a pen is down, hovering, or was just used.
    #[serde(default = "default_true")]
    pub palm_rejection: bool,
    /// Hide the note title once the canvas is scrolled below the top. Missing means on.
    #[serde(default = "default_true")]
    pub title_auto_hide: bool,
    /// Note title row manually collapsed.
    #[serde(default)]
    pub title_collapsed: bool,
    /// Hide the ribbon tool row under the tabs.
    #[serde(default)]
    pub ribbon_actions_collapsed: bool,
    /// Home grid tile min width in px (CSS `minmax` column size).
    #[serde(default = "default_home_tile_size")]
    pub home_tile_size: u32,
}

fn default_true() -> bool {
    true
}

fn default_home_tile_size() -> u32 {
    168
}

/// Clamp Home tile size to the UI range.
pub fn clamp_home_tile_size(n: u32) -> u32 {
    n.clamp(112, 240)
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            version: 2,
            theme: "mix".into(),
            autosave: true,
            export_defaults: ExportDefaults::default(),
            last_export_dir: None,
            update_on_exit: true,
            autostart: false,
            tray: false,
            welcome_dismissed: false,
            today_format: None,
            study_prompted: false,
            study_preset: None,
            study_root: None,
            moodle_enabled: false,
            pen_enabled: true,
            pen_always_draws: true,
            pen_pressure: true,
            palm_rejection: true,
            title_auto_hide: true,
            title_collapsed: false,
            ribbon_actions_collapsed: false,
            home_tile_size: default_home_tile_size(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Ignored {
    pub version: u32,
    pub paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct NotebookUiState {
    #[serde(default = "default_sort")]
    pub sort: String,
    #[serde(default = "default_sidebar_w")]
    pub sidebar_width: u32,
    #[serde(default)]
    pub sidebar_collapsed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_note: Option<String>,
}

fn default_sort() -> String {
    "name".into()
}
fn default_sidebar_w() -> u32 {
    220
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct WindowState {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
    pub maximized: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct UiState {
    pub version: u32,
    #[serde(default)]
    pub window: WindowState,
    #[serde(default)]
    pub notebooks: HashMap<String, NotebookUiState>,
}

#[derive(Clone)]
pub struct AppPaths {
    pub root: PathBuf,
    pub settings: PathBuf,
    pub home: PathBuf,
    pub ignored: PathBuf,
    pub ui_state: PathBuf,
    pub icons: PathBuf,
    pub recovery: PathBuf,
    pub backups: PathBuf,
    pub index: PathBuf,
}

impl AppPaths {
    pub fn resolve() -> Self {
        let root = dirs_appdata().join("Paperlike");
        Self {
            settings: root.join("settings.json"),
            home: root.join("home.json"),
            ignored: root.join("ignored.json"),
            ui_state: root.join("ui-state.json"),
            icons: root.join("icons"),
            recovery: root.join("recovery"),
            backups: root.join("backups"),
            index: root.join("index"),
            root,
        }
    }

    pub fn ensure(&self) -> Result<()> {
        fs::create_dir_all(&self.root)?;
        fs::create_dir_all(&self.icons)?;
        fs::create_dir_all(&self.recovery)?;
        fs::create_dir_all(&self.backups)?;
        fs::create_dir_all(&self.index)?;
        Ok(())
    }
}

fn dirs_appdata() -> PathBuf {
    if let Ok(p) = std::env::var("APPDATA") {
        return PathBuf::from(p);
    }
    PathBuf::from(".")
}

fn load_or_default<T: for<'de> Deserialize<'de> + Default + Serialize>(
    path: &Path,
) -> Result<T> {
    if !path.exists() {
        return Ok(T::default());
    }
    match atomic::read_to_string(path).and_then(|s| {
        serde_json::from_str(&s).map_err(|e| anyhow::anyhow!(e))
    }) {
        Ok(v) => Ok(v),
        Err(_) => {
            // Keep the unreadable file around for the user, start fresh.
            let ts = chrono::Local::now().format("%Y%m%d%H%M%S");
            let name = path.file_name().unwrap().to_string_lossy();
            let corrupt = path.with_file_name(format!("{name}.corrupt-{ts}"));
            let _ = fs::rename(path, &corrupt);
            Ok(T::default())
        }
    }
}

fn save_json<T: Serialize>(path: &Path, v: &T) -> Result<()> {
    let json = serde_json::to_string_pretty(v)?;
    atomic::atomic_write_string(path, &json, false)
}

pub fn load_settings(paths: &AppPaths) -> Result<Settings> {
    let mut s: Settings = load_or_default(&paths.settings)?;
    // v1 always wrote update_on_exit: false with no settings toggle. Enable it once.
    if s.version < 2 {
        s.update_on_exit = true;
        s.version = 2;
        let _ = save_settings(paths, &s);
    }
    Ok(s)
}
pub fn save_settings(paths: &AppPaths, s: &Settings) -> Result<()> {
    save_json(&paths.settings, s)
}
pub fn load_home(paths: &AppPaths) -> Result<HomeState> {
    load_or_default(&paths.home)
}
pub fn save_home(paths: &AppPaths, h: &HomeState) -> Result<()> {
    save_json(&paths.home, h)
}
pub fn load_ignored(paths: &AppPaths) -> Result<Ignored> {
    let mut i: Ignored = load_or_default(&paths.ignored)?;
    if i.version == 0 {
        i.version = 1;
    }
    Ok(i)
}
pub fn save_ignored(paths: &AppPaths, i: &Ignored) -> Result<()> {
    save_json(&paths.ignored, i)
}
pub fn load_ui_state(paths: &AppPaths) -> Result<UiState> {
    let mut u: UiState = load_or_default(&paths.ui_state)?;
    if u.version == 0 {
        u.version = 1;
    }
    Ok(u)
}
pub fn save_ui_state(paths: &AppPaths, u: &UiState) -> Result<()> {
    save_json(&paths.ui_state, u)
}
