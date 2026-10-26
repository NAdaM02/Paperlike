//! Bundled study-folder presets.
//!
//! The tree under `resources/presets/` is compiled into the binary with
//! `include_dir`. The portable exe has no installer and no resource directory,
//! so embedding is the copy both builds can rely on. Tauri `bundle.resources`
//! is not used for this.

use std::fs;
use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use include_dir::{include_dir, Dir, File};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::{self, AppState};
use crate::notebook::{self, NotebookData, NOTEBOOK_DATA};

static PRESETS: Dir<'static> = include_dir!("$CARGO_MANIFEST_DIR/resources/presets");

#[derive(Debug, Deserialize)]
struct PresetManifest {
    id: String,
    name: String,
    root_default: String,
    #[serde(default)]
    thumbnail: Option<String>,
    notebooks: Vec<String>,
    folders: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct StudyPresetInfo {
    pub name: String,
    pub notebooks: Vec<String>,
    pub folders: Vec<String>,
    pub thumbnail_data_url: Option<String>,
    pub default_root: String,
}

#[derive(Debug, Serialize)]
pub struct StudyCreateSummary {
    pub root: String,
    pub created_notebooks: Vec<String>,
    pub created_folders: Vec<String>,
    pub skipped: Vec<String>,
}

fn err(e: impl ToString) -> String {
    e.to_string()
}

/// Paths inside the embedded tree are relative to `resources/presets`, not to the preset folder.
fn preset_file(id: &str, rel: &str) -> Option<&'static File<'static>> {
    let rel = rel.trim_matches('/');
    let path = if rel.is_empty() {
        id.to_string()
    } else {
        format!("{id}/{rel}")
    };
    PRESETS.get_file(path)
}

fn load_preset(id: &str) -> Result<PresetManifest, String> {
    if PRESETS.get_dir(id).is_none() {
        return Err(format!("Unknown study preset: {id}"));
    }
    let file = preset_file(id, "preset.json")
        .ok_or_else(|| format!("Study preset {id} has no preset.json"))?;
    let manifest: PresetManifest = serde_json::from_slice(file.contents()).map_err(err)?;
    if manifest.id != id {
        return Err(format!("Study preset id mismatch: {id}"));
    }
    Ok(manifest)
}

fn default_root_path(name: &str) -> PathBuf {
    if let Ok(profile) = std::env::var("USERPROFILE") {
        let profile = profile.trim().trim_matches('"').to_string();
        if !profile.is_empty() {
            return PathBuf::from(profile).join(name);
        }
    }
    PathBuf::from(name)
}

fn resolve_root(root: &str, fallback_name: &str) -> PathBuf {
    let trimmed = root.trim().trim_matches('"');
    if trimmed.is_empty() {
        default_root_path(fallback_name)
    } else {
        PathBuf::from(trimmed)
    }
}

fn rel_under(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel = rel.replace('\\', "/");
    if rel.is_empty() || rel.starts_with('/') || rel.contains(':') {
        return Err(format!("Preset path is not relative: {rel}"));
    }
    let mut out = root.to_path_buf();
    for part in rel.split('/') {
        if part.is_empty() || part == "." || part == ".." {
            return Err(format!("Preset path is not relative: {rel}"));
        }
        out.push(part);
    }
    Ok(out)
}

fn embedded_notebook(id: &str, rel: &str) -> Result<&'static [u8], String> {
    let file_rel = format!("{}/{}", rel.trim_matches('/'), NOTEBOOK_DATA);
    preset_file(id, &file_rel)
        .map(|f| f.contents())
        .ok_or_else(|| format!("Preset is missing {id}/{file_rel}"))
}

/// Drop separator entries that point at someone's notes. Name, description, and cover stay.
fn sanitize_notebook(bytes: &[u8]) -> Result<NotebookData, String> {
    let mut data: NotebookData = serde_json::from_slice(bytes).map_err(err)?;
    if let Some(seps) = data.separators.as_ref() {
        let refs_notes = [&seps.name, &seps.name_desc, &seps.created, &seps.created_desc]
            .into_iter()
            .flatten()
            .any(|entry| !entry.after.trim().is_empty());
        if refs_notes {
            data.separators = None;
        }
    }
    Ok(data)
}

fn thumbnail_data_url(id: &str, name: &str) -> Option<String> {
    let name = name.trim();
    if name.is_empty() {
        return None;
    }
    let bytes = preset_file(id, name)?.contents();
    if bytes.is_empty() {
        return None;
    }
    let mime = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        "image/jpeg"
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        "image/gif"
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        "image/webp"
    } else {
        return None;
    };
    Some(format!("data:{mime};base64,{}", B64.encode(bytes)))
}

fn display(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

#[tauri::command]
pub fn study_preset_info(preset_id: String) -> Result<StudyPresetInfo, String> {
    let manifest = load_preset(&preset_id)?;
    let thumbnail_data_url = manifest
        .thumbnail
        .as_deref()
        .and_then(|name| thumbnail_data_url(&preset_id, name));
    Ok(StudyPresetInfo {
        name: manifest.name,
        notebooks: manifest.notebooks,
        folders: manifest.folders,
        thumbnail_data_url,
        default_root: display(&default_root_path(&manifest.root_default)),
    })
}

#[tauri::command]
pub fn create_study_preset(
    state: State<AppState>,
    preset_id: String,
    root: String,
    create_folders: bool,
) -> Result<StudyCreateSummary, String> {
    let manifest = load_preset(&preset_id)?;
    let root = resolve_root(&root, &manifest.root_default);
    if !create_folders {
        return Ok(StudyCreateSummary {
            root: display(&root),
            created_notebooks: vec![],
            created_folders: vec![],
            skipped: vec![],
        });
    }

    state.paths.ensure().map_err(err)?;
    if root.is_file() {
        return Err(format!("{} is a file", root.display()));
    }
    fs::create_dir_all(&root).map_err(err)?;

    let mut created_notebooks = Vec::new();
    let mut created_folders = Vec::new();
    let mut skipped = Vec::new();
    let mut notebook_paths = Vec::new();

    for rel in &manifest.notebooks {
        let folder = rel_under(&root, rel)?;
        let data_path = folder.join(NOTEBOOK_DATA);
        if data_path.is_file() {
            skipped.push(display(&data_path));
        } else {
            if folder.is_file() {
                return Err(format!("{} is a file", folder.display()));
            }
            fs::create_dir_all(&folder).map_err(err)?;
            let bytes = embedded_notebook(&preset_id, rel)?;
            let data = sanitize_notebook(bytes)?;
            notebook::save_notebook_data(&folder, &data).map_err(err)?;
            created_notebooks.push(display(&folder));
        }
        notebook_paths.push(display(&folder));
    }

    for rel in &manifest.folders {
        let folder = rel_under(&root, rel)?;
        if folder.is_file() {
            return Err(format!("{} is a file", folder.display()));
        }
        if folder.is_dir() {
            skipped.push(display(&folder));
        } else {
            fs::create_dir_all(&folder).map_err(err)?;
            created_folders.push(display(&folder));
        }
        let keep = folder.join(".keep");
        if !keep.exists() {
            fs::write(&keep, b"\n").map_err(err)?;
        }
    }

    for path in &notebook_paths {
        if let Err(e) = notebook::apply_stored_cover(Path::new(path), &state.paths.icons) {
            skipped.push(format!("folder icon for {path} ({e})"));
        }
    }

    commands::add_paths_to_home(&state.paths, notebook_paths, false)?;

    Ok(StudyCreateSummary {
        root: display(&root),
        created_notebooks,
        created_folders,
        skipped,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tum_preset_has_notebooks() {
        let manifest = load_preset("tum-aerospace").unwrap();
        assert_eq!(manifest.notebooks.len(), 7);
        assert_eq!(manifest.folders.len(), 14);
        assert!(manifest.thumbnail.as_deref() == Some("thumbnail.png"));
        if let Some(file) = preset_file("tum-aerospace", "thumbnail.png") {
            let bytes = file.contents();
            let png = bytes.starts_with(b"\x89PNG\r\n\x1a\n");
            let jpeg = bytes.starts_with(&[0xFF, 0xD8, 0xFF]);
            assert!(png || jpeg, "thumbnail.png should be a PNG or JPEG");
        }
        for rel in &manifest.notebooks {
            let data = sanitize_notebook(embedded_notebook("tum-aerospace", rel).unwrap()).unwrap();
            assert!(data.cover.is_some(), "{rel} missing cover");
            assert!(data.description.is_none(), "{rel} has a description");
            if let Some(seps) = &data.separators {
                for list in [&seps.name, &seps.name_desc, &seps.created, &seps.created_desc] {
                    assert!(list.iter().all(|entry| entry.after.trim().is_empty()));
                }
            }
        }
        for rel in &manifest.folders {
            let keep = format!("{rel}/.keep");
            assert!(preset_file("tum-aerospace", &keep).is_some(), "missing {keep}");
        }
    }
}
