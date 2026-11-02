//! File chips: any file embedded whole in a note — specs/editor.md §2.6.
//!
//! The bytes live in the note's `media/` like pictures and PDFs. Opening one
//! writes a copy to a temp folder and hands it to Windows; that folder is
//! emptied the next time the app starts.

use std::path::{Path, PathBuf};
use std::process::Command;

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::Serialize;
use sha2::{Digest, Sha256};

/// Largest file a note embeds. An open note is held in memory as a whole.
pub const MAX_FILE: u64 = 100 * 1024 * 1024;

/// File types that would run code when opened. These are shown in Explorer instead.
const RUNNABLE: &[&str] = &[
    "exe", "msi", "msix", "appx", "bat", "cmd", "com", "scr", "pif", "ps1", "psm1", "vbs", "vbe", "js",
    "jse", "wsf", "wsh", "hta", "lnk", "url", "reg", "cpl", "msc", "jar", "inf", "application", "gadget",
];

#[derive(Debug, Serialize)]
pub struct LocalFile {
    pub name: String,
    pub size: u64,
    pub b64: String,
}

#[derive(Debug, Serialize)]
pub struct Opened {
    /// "opened" in its default app, or "shown" in Explorer (a program or script).
    pub how: String,
}

fn open_root() -> PathBuf {
    std::env::temp_dir().join("Paperlike open files")
}

/// Removes the copies earlier sessions opened. Files still open elsewhere stay.
pub fn clean_open_copies() {
    std::thread::spawn(|| {
        let root = open_root();
        if root.is_dir() {
            let _ = std::fs::remove_dir_all(&root);
        }
    });
}

/// A file name Windows accepts, kept close to the original.
fn safe_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or_default();
    let mut out: String = base
        .chars()
        .map(|c| if c.is_control() || r#"<>:"/\|?*"#.contains(c) { '_' } else { c })
        .collect();
    out = out.trim().trim_end_matches(['.', ' ']).to_string();
    let stem = out.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = ["CON", "PRN", "AUX", "NUL"].contains(&stem.as_str())
        || ((stem.starts_with("COM") || stem.starts_with("LPT")) && stem.len() == 4);
    if out.is_empty() || reserved {
        out = format!("file {out}").trim().to_string();
    }
    if out.chars().count() > 120 {
        let ext = Path::new(&out).extension().map(|e| e.to_string_lossy().into_owned());
        let keep: String = out.chars().take(100).collect();
        out = match ext {
            Some(e) if e.len() <= 12 => format!("{}.{e}", keep.trim_end()),
            _ => keep,
        };
    }
    out
}

fn ext_of(name: &str) -> String {
    Path::new(name)
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default()
}

fn read(path: &str) -> Result<LocalFile, String> {
    let p = Path::new(path);
    let meta = std::fs::metadata(p).map_err(|_| "file-missing".to_string())?;
    if meta.is_dir() {
        return Err("file-folder".into());
    }
    if meta.len() > MAX_FILE {
        return Err("file-too-large".into());
    }
    let bytes = std::fs::read(p).map_err(|_| "file-unreadable".to_string())?;
    Ok(LocalFile {
        name: p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "file".into()),
        size: bytes.len() as u64,
        b64: B64.encode(&bytes),
    })
}

/// Reads a file the user dropped or picked, for embedding.
#[tauri::command]
pub async fn read_local_file(path: String) -> Result<LocalFile, String> {
    tauri::async_runtime::spawn_blocking(move || read(&path))
        .await
        .map_err(|e| e.to_string())?
}

/// Writes the embedded copy to disk (once per content) and returns its path.
fn write_copy(root: &Path, name: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    let hash = crate::atomic::hex(&Sha256::digest(bytes));
    let dir = root.join(&hash[..16]);
    std::fs::create_dir_all(&dir).map_err(|_| "file-open-failed".to_string())?;
    let file = dir.join(safe_name(name));
    let same = std::fs::read(&file).map(|b| b == bytes).unwrap_or(false);
    if !same && std::fs::write(&file, bytes).is_err() && !file.exists() {
        return Err("file-open-failed".into());
    }
    Ok(file)
}

fn open(name: &str, b64: &str) -> Result<Opened, String> {
    let bytes = B64.decode(b64).map_err(|_| "file-open-failed".to_string())?;
    let file = write_copy(&open_root(), name, &bytes)?;
    let runnable = RUNNABLE.contains(&ext_of(name).as_str());
    let mut cmd = Command::new("explorer");
    if runnable {
        cmd.arg(format!("/select,{}", file.display()));
    } else {
        cmd.arg(&file);
    }
    cmd.spawn().map_err(|_| "file-open-failed".to_string())?;
    Ok(Opened { how: if runnable { "shown".into() } else { "opened".into() } })
}

/// Opens an embedded file in its default app.
#[tauri::command]
pub async fn open_attachment(name: String, b64: String) -> Result<Opened, String> {
    tauri::async_runtime::spawn_blocking(move || open(&name, &b64))
        .await
        .map_err(|e| e.to_string())?
}

/// Save as: writes an embedded file where the user chose.
#[tauri::command]
pub async fn save_attachment(dest: String, b64: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = B64.decode(b64).map_err(|_| "file-save-failed".to_string())?;
        crate::atomic::atomic_write(Path::new(&dest), &bytes, false).map_err(|_| "file-save-failed".to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_windows_accepts() {
        assert_eq!(safe_name("Lab report.docx"), "Lab report.docx");
        assert_eq!(safe_name("a:b?.txt"), "a_b_.txt");
        assert_eq!(safe_name("con.txt"), "file con.txt");
        assert_eq!(safe_name("..\\..\\evil.bat"), "evil.bat");
        assert_eq!(safe_name("trail. "), "trail");
        let long = format!("{}.xlsx", "x".repeat(200));
        assert!(safe_name(&long).ends_with(".xlsx") && safe_name(&long).chars().count() <= 106);
    }

    #[test]
    fn copies_once_per_content() {
        let root = std::env::temp_dir().join(format!("pl-attach-test-{}", std::process::id()));
        let a = write_copy(&root, "notes.txt", b"hello").unwrap();
        let b = write_copy(&root, "notes.txt", b"hello").unwrap();
        let c = write_copy(&root, "notes.txt", b"other").unwrap();
        assert_eq!(a, b);
        assert_ne!(a, c);
        assert_eq!(std::fs::read(&c).unwrap(), b"other");
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn runnable_types_are_not_run() {
        assert!(RUNNABLE.contains(&ext_of("setup.EXE").as_str()));
        assert!(!RUNNABLE.contains(&ext_of("thesis.docx").as_str()));
    }
}
