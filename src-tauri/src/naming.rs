//! Note filename / title rules per specs/file-formats.md §3.

use std::path::Path;

const FORBIDDEN: &[char] = &['<', '>', ':', '"', '/', '\\', '|', '?', '*'];
const RESERVED: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
    "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

pub fn sanitize_title(raw: &str) -> String {
    let mut s: String = raw
        .chars()
        .filter(|c| !FORBIDDEN.contains(c) && *c != '\0')
        .collect();
    while s.ends_with('.') || s.ends_with(' ') {
        s.pop();
    }
    if s.len() > 120 {
        s.truncate(120);
        while s.ends_with('.') || s.ends_with(' ') {
            s.pop();
        }
    }
    if s.is_empty() {
        return "Untitled".into();
    }
    let upper = s.to_ascii_uppercase();
    if RESERVED.iter().any(|r| *r == upper) {
        s = format!("_{s}");
    }
    s
}

pub fn is_empty_named(filename_stem: &str) -> bool {
    if filename_stem == "Untitled" {
        return true;
    }
    if let Some(rest) = filename_stem.strip_prefix("Untitled ") {
        return rest.parse::<u32>().is_ok();
    }
    false
}

pub fn display_title(filename_stem: &str) -> String {
    if is_empty_named(filename_stem) {
        String::new()
    } else {
        filename_stem.to_string()
    }
}

/// Allocate `Untitled.note`, `Untitled 2.note`, … in `dir`.
pub fn next_untitled_path(dir: &Path) -> std::path::PathBuf {
    let first = dir.join("Untitled.note");
    if !first.exists() {
        return first;
    }
    for i in 2..10_000 {
        let p = dir.join(format!("Untitled {i}.note"));
        if !p.exists() {
            return p;
        }
    }
    dir.join(format!("Untitled {}.note", uuid::Uuid::new_v4()))
}

/// Ensure unique filename in dir for a desired stem (without .note).
pub fn unique_note_path(dir: &Path, desired_stem: &str) -> std::path::PathBuf {
    let stem = sanitize_title(desired_stem);
    let first = dir.join(format!("{stem}.note"));
    if !first.exists() {
        return first;
    }
    for i in 2..10_000 {
        let p = dir.join(format!("{stem} ({i}).note"));
        if !p.exists() {
            return p;
        }
    }
    dir.join(format!("{stem}-{}.note", uuid::Uuid::new_v4()))
}

pub fn prefix_today(title: &str, format: Option<&str>) -> String {
    use std::fmt::Write;
    let now = chrono::Local::now();
    let mut today = String::new();
    let ok = match format {
        Some(f) if !f.trim().is_empty() => write!(today, "{}", now.format(f)).is_ok() && !today.trim().is_empty(),
        _ => false,
    };
    if !ok {
        today = now.format("%Y-%m-%d").to_string();
    }
    let today = sanitize_title(&today);
    if title.is_empty() {
        today
    } else {
        format!("{today} {title}")
    }
}
