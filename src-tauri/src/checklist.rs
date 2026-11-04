//! App-wide checklist: %APPDATA%\Paperlike\checklist.json (specs/app-state.md).

use crate::atomic::atomic_write_string;
use crate::state::AppPaths;
use std::path::PathBuf;

fn path() -> PathBuf {
    AppPaths::resolve().root.join("checklist.json")
}

/// The saved list as JSON, or "" when there is none yet.
#[tauri::command]
pub fn checklist_load() -> String {
    std::fs::read_to_string(path()).unwrap_or_default()
}

/// Replace the saved list; the UI sends the whole list as pretty JSON.
#[tauri::command]
pub fn checklist_save(json: String) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(&json).map_err(|e| e.to_string())?;
    let p = path();
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    atomic_write_string(&p, &json, false).map_err(|e| e.to_string())
}
