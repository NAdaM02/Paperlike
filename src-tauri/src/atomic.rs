use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use sha2::{Digest, Sha256};

/// Atomic write: write to a sibling `.tmp`, then replace the target.
/// When `keep_bak` is true, the previous file (if any) is copied to
/// `%APPDATA%\Paperlike\backups\` — never left beside notes in the notebook folder.
pub fn atomic_write(path: &Path, data: &[u8], keep_bak: bool) -> Result<()> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;
    let tmp = sibling_tmp(path);

    {
        let mut f = File::create(&tmp)
            .with_context(|| format!("create temp {}", tmp.display()))?;
        f.write_all(data)?;
        f.sync_all()?;
    }

    if keep_bak && path.exists() {
        let bak = bak_path_for(path)?;
        fs::copy(path, &bak).with_context(|| {
            format!("backup {} → {}", path.display(), bak.display())
        })?;
        // Remove legacy beside-the-note backups from older builds.
        let legacy = path.with_file_name(format!(
            "{}.bak",
            path.file_name()
                .map(|n| n.to_string_lossy())
                .unwrap_or_default()
        ));
        let _ = fs::remove_file(legacy);
    }

    // `rename` replaces an existing destination on Windows; deleting first
    // leaves a crash window where the file is gone entirely.
    fs::rename(&tmp, path).with_context(|| format!("replace {}", path.display()))?;
    Ok(())
}

pub fn atomic_write_string(path: &Path, s: &str, keep_bak: bool) -> Result<()> {
    atomic_write(path, s.as_bytes(), keep_bak)
}

/// Path of the rotating backup for `original` under AppData (may not exist yet).
pub fn bak_path_for(original: &Path) -> Result<PathBuf> {
    let dir = backups_dir()?;
    let key = path_key(original);
    let fname = original
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".into());
    // Sanitize path separators that shouldn't appear in a single file name.
    let safe = fname.replace(['/', '\\', ':'], "_");
    Ok(dir.join(format!("{key}_{safe}.bak")))
}

fn backups_dir() -> Result<PathBuf> {
    let dir = appdata_root().join("Paperlike").join("backups");
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn appdata_root() -> PathBuf {
    if let Ok(p) = std::env::var("APPDATA") {
        return PathBuf::from(p);
    }
    PathBuf::from(".")
}

fn path_key(path: &Path) -> String {
    let canonical = path
        .canonicalize()
        .unwrap_or_else(|_| path.to_path_buf());
    // Normalize for stable keys across slash styles.
    let s = canonical.to_string_lossy().to_lowercase().replace('/', "\\");
    let mut h = Sha256::new();
    h.update(s.as_bytes());
    hex(&h.finalize())[..16].to_string()
}

/// Lowercase hex of a digest.
pub fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    bytes.iter().fold(String::with_capacity(bytes.len() * 2), |mut out, b| {
        let _ = write!(out, "{b:02x}");
        out
    })
}

fn sibling_tmp(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".into());
    path.with_file_name(format!("{name}.tmp"))
}

pub fn read_to_string(path: &Path) -> Result<String> {
    let mut f = File::open(path)?;
    let mut s = String::new();
    f.read_to_string(&mut s)?;
    Ok(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bak_lives_under_appdata_not_beside_note() {
        let dir = std::env::temp_dir().join(format!("ow_bak_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let note = dir.join("Hello.note");
        fs::write(&note, b"v1").unwrap();
        atomic_write(&note, b"v2", true).unwrap();

        assert_eq!(fs::read(&note).unwrap(), b"v2");
        assert!(!dir.join("Hello.note.bak").exists(), "no sibling .bak");
        let bak = bak_path_for(&note).unwrap();
        assert!(bak.exists(), "appdata bak missing: {}", bak.display());
        assert!(bak.to_string_lossy().contains("backups"));
        assert_eq!(fs::read(&bak).unwrap(), b"v1");

        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_file(&bak);
    }
}
