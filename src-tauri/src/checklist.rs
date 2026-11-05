//! App-wide checklist: human-readable Markdown (default %APPDATA%\Paperlike\checklist.md).
//! Settings → Files can point `checklist_path` at any `.md` file (e.g. in a git repo).

use crate::atomic::atomic_write_string;
use crate::state::{self, AppPaths};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ChecklistDoc {
    version: u32,
    items: Vec<ChecklistItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ChecklistItem {
    id: String,
    text: String,
    done: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    note: bool,
}

fn is_false(v: &bool) -> bool { !*v }

fn default_md_path(root: &Path) -> PathBuf {
    root.join("checklist.md")
}

fn legacy_json_path(root: &Path) -> PathBuf {
    root.join("checklist.json")
}

/// Resolve the on-disk checklist path from settings (or the AppData default).
fn resolve_path() -> PathBuf {
    let paths = AppPaths::resolve();
    if let Ok(s) = state::load_settings(&paths) {
        if let Some(p) = s.checklist_path {
            let t = p.trim();
            if !t.is_empty() {
                return PathBuf::from(t);
            }
        }
    }
    default_md_path(&paths.root)
}

fn new_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let n = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{:x}", n % 0xffff_ffff_ffff)
}

/// Turn Markdown into the JSON the UI already speaks.
fn md_to_json(md: &str) -> String {
    let mut items = Vec::new();
    for raw in md.lines() {
        let line = raw.trim_end();
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix("- [ ]") {
            let text = rest.trim().to_string();
            if text.is_empty() {
                continue;
            }
            items.push(ChecklistItem {
                id: new_id(),
                text,
                done: false,
                note: false,
            });
            continue;
        }
        if let Some(rest) = trimmed
            .strip_prefix("- [x]")
            .or_else(|| trimmed.strip_prefix("- [X]"))
        {
            let text = rest.trim().to_string();
            if text.is_empty() {
                continue;
            }
            items.push(ChecklistItem {
                id: new_id(),
                text,
                done: true,
                note: false,
            });
            continue;
        }
        // Also accept "- [x]" with a space after the brackets already handled;
        // plain "- text" (no checkbox) is a note line.
        if let Some(rest) = trimmed.strip_prefix('-') {
            let body = rest.trim();
            // Skip any other "[.]" checkbox forms we don't treat as tasks above.
            if body.starts_with('[') && body.len() >= 3 && body.as_bytes().get(2) == Some(&b']') {
                // Unknown checkbox state — treat as unchecked task with the rest.
                let text = body[3..].trim().to_string();
                if text.is_empty() {
                    continue;
                }
                items.push(ChecklistItem {
                    id: new_id(),
                    text,
                    done: false,
                    note: false,
                });
                continue;
            }
            if body.is_empty() {
                continue;
            }
            items.push(ChecklistItem {
                id: new_id(),
                text: body.to_string(),
                done: false,
                note: true,
            });
            continue;
        }
        // Bare line → note
        items.push(ChecklistItem {
            id: new_id(),
            text: trimmed.to_string(),
            done: false,
            note: true,
        });
    }
    serde_json::to_string_pretty(&ChecklistDoc { version: 1, items }).unwrap_or_else(|_| {
        "{\"version\":1,\"items\":[]}".into()
    })
}

/// Pretty Markdown humans can edit outside Paperlike.
fn json_to_md(json: &str) -> Result<String, String> {
    let doc: ChecklistDoc = serde_json::from_str(json).map_err(|e| e.to_string())?;
    let mut out = String::from("# Checklist\n\n");
    for it in doc.items {
        let text = it.text.replace('\r', " ").replace('\n', " ").trim().to_string();
        if text.is_empty() {
            continue;
        }
        if it.note {
            out.push_str("- ");
            out.push_str(&text);
            out.push('\n');
        } else if it.done {
            out.push_str("- [x] ");
            out.push_str(&text);
            out.push('\n');
        } else {
            out.push_str("- [ ] ");
            out.push_str(&text);
            out.push('\n');
        }
    }
    if !out.ends_with('\n') {
        out.push('\n');
    }
    Ok(out)
}

fn load_legacy_json(path: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(path).ok()?;
    // Validate shape; return the pretty JSON wire form (or empty).
    let doc: ChecklistDoc = serde_json::from_str(&raw).ok()?;
    serde_json::to_string_pretty(&doc).ok()
}

/// The saved list as JSON for the UI, or "" when there is none yet.
#[tauri::command]
pub fn checklist_load() -> String {
    let path = resolve_path();
    if path.exists() {
        let raw = std::fs::read_to_string(&path).unwrap_or_default();
        if !raw.trim().is_empty() {
            if path
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.eq_ignore_ascii_case("json"))
                == Some(true)
            {
                return raw;
            }
            // Prefer Markdown; if the file is still legacy JSON content, pass it through.
            if raw.trim_start().starts_with('{') {
                return raw;
            }
            return md_to_json(&raw);
        }
        // Empty file at the chosen path — fall through and try the AppData JSON.
    }

    // Missing or empty target: migrate %APPDATA%\Paperlike\checklist.json once into `path`.
    let paths = AppPaths::resolve();
    let legacy = legacy_json_path(&paths.root);
    if let Some(json) = load_legacy_json(&legacy) {
        if let Ok(md) = json_to_md(&json) {
            let _ = atomic_write_string(&path, &md, false);
            let _ = std::fs::remove_file(&legacy);
        }
        return json;
    }
    String::new()
}

/// Replace the saved list; the UI sends the whole list as pretty JSON, we write Markdown.
#[tauri::command]
pub fn checklist_save(json: String) -> Result<(), String> {
    let md = json_to_md(&json)?;
    let p = resolve_path();
    // If the chosen path has no extension, keep it; if someone picked .json, still write Markdown
    // but prefer .md when using the default.
    atomic_write_string(&p, &md, false).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_tasks_and_notes() {
        let json = r#"{
          "version": 1,
          "items": [
            {"id":"a","text":"Buy paper","done":false},
            {"id":"b","text":"Exam on Friday","done":false,"note":true},
            {"id":"c","text":"Done thing","done":true}
          ]
        }"#;
        let md = json_to_md(json).unwrap();
        assert!(md.contains("- [ ] Buy paper"));
        assert!(md.contains("- Exam on Friday"));
        assert!(md.contains("- [x] Done thing"));
        let back = md_to_json(&md);
        let doc: ChecklistDoc = serde_json::from_str(&back).unwrap();
        assert_eq!(doc.items.len(), 3);
        assert!(!doc.items[0].note && !doc.items[0].done);
        assert!(doc.items[1].note);
        assert!(doc.items[2].done);
    }
}
