//! Search — specs/search.md

use std::collections::HashMap;
use std::fs;
use std::path::Path;

use anyhow::Result;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::atomic;
use crate::note;
use crate::state::{AppPaths, HomeItem};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct NoteIndexEntry {
    pub mtime: u64,
    pub title: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct NotebookIndex {
    pub notes: HashMap<String, NoteIndexEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchHit {
    pub note_path: String,
    pub note_title: String,
    pub notebook_name: String,
    pub notebook_path: Option<String>,
    pub snippet: String,
    pub score: u32,
}

fn path_key(path: &str) -> String {
    let mut h = Sha256::new();
    h.update(path.as_bytes());
    crate::atomic::hex(&h.finalize())[..16].to_string()
}

fn file_mtime(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

pub fn ensure_index_for_notebook(paths: &AppPaths, notebook_path: &Path) -> Result<NotebookIndex> {
    let key = path_key(&notebook_path.to_string_lossy());
    let index_path = paths.index.join(format!("{key}.json"));
    let mut idx: NotebookIndex = if index_path.exists() {
        atomic::read_to_string(&index_path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    } else {
        NotebookIndex::default()
    };

    let mut seen = std::collections::HashSet::new();
    if notebook_path.is_dir() {
        for entry in fs::read_dir(notebook_path)? {
            let entry = entry?;
            let p = entry.path();
            if p.extension().and_then(|e| e.to_str()) != Some("note") {
                continue;
            }
            let fname = p
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            seen.insert(fname.clone());
            let mt = file_mtime(&p);
            let stale = idx
                .notes
                .get(&fname)
                .map(|e| e.mtime != mt)
                .unwrap_or(true);
            if stale {
                let title = p
                    .file_stem()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_default();
                let text = note::load_note_document(&p)
                    .map(|doc| {
                        note::NoteFile {
                            doc,
                            media: Default::default(),
                        }
                        .plain_text()
                    })
                    .unwrap_or_default();
                idx.notes.insert(
                    fname,
                    NoteIndexEntry {
                        mtime: mt,
                        title,
                        text,
                    },
                );
            }
        }
    } else if notebook_path.extension().and_then(|e| e.to_str()) == Some("note") {
        // standalone
        let fname = notebook_path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        seen.insert(fname.clone());
        let mt = file_mtime(notebook_path);
        let title = notebook_path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let text = note::load_note_document(notebook_path)
            .map(|doc| {
                note::NoteFile {
                    doc,
                    media: Default::default(),
                }
                .plain_text()
            })
            .unwrap_or_default();
        idx.notes.insert(
            fname,
            NoteIndexEntry {
                mtime: mt,
                title,
                text,
            },
        );
    }

    idx.notes.retain(|k, _| seen.contains(k));
    let json = serde_json::to_string_pretty(&idx)?;
    atomic::atomic_write_string(&index_path, &json, false)?;
    Ok(idx)
}

/// Case-insensitive search that returns byte offsets into `text` (not a lowercased copy).
fn find_ignore_case(text: &str, term: &str) -> Option<(usize, usize)> {
    let term_lower = term.to_lowercase();
    let n = term_lower.chars().count();
    if n == 0 {
        return None;
    }
    let chars: Vec<(usize, char)> = text.char_indices().collect();
    for i in 0..chars.len() {
        let slice: String = chars[i..].iter().take(n).map(|(_, c)| *c).collect();
        if slice.to_lowercase() == term_lower {
            let start = chars[i].0;
            let end = chars.get(i + n).map(|(b, _)| *b).unwrap_or(text.len());
            return Some((start, end));
        }
    }
    None
}

fn snippet_around(text: &str, term: &str) -> String {
    match find_ignore_case(text, term) {
        None => text.chars().take(80).collect(),
        Some((m0, m1)) => {
            let chars: Vec<(usize, char)> = text.char_indices().collect();
            let i0 = chars.iter().position(|(b, _)| *b == m0).unwrap_or(0);
            let i1 = chars
                .iter()
                .position(|(b, _)| *b == m1)
                .unwrap_or(chars.len());
            let from = i0.saturating_sub(40);
            let to = (i1 + 40).min(chars.len());
            let start = chars.get(from).map(|(b, _)| *b).unwrap_or(0);
            let end = chars.get(to).map(|(b, _)| *b).unwrap_or(text.len());
            let mut s = String::new();
            if from > 0 {
                s.push('…');
            }
            s.push_str(&text[start..end]);
            if to < chars.len() {
                s.push('…');
            }
            s
        }
    }
}

pub fn global_search(paths: &AppPaths, home: &[HomeItem], query: &str) -> Result<Vec<SearchHit>> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return Ok(vec![]);
    }
    let terms: Vec<&str> = q.split_whitespace().collect();
    let mut hits = Vec::new();

    let mut targets: Vec<(String, Option<String>, String)> = Vec::new(); // path, notebook_path?, name
    for it in home {
        match it {
            HomeItem::Notebook { path } => {
                let name = Path::new(path)
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default();
                targets.push((path.clone(), Some(path.clone()), name));
            }
            HomeItem::Note { path } => {
                let name = Path::new(path)
                    .file_stem()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default();
                targets.push((path.clone(), None, name));
            }
            HomeItem::Group { items, .. } => {
                for g in items {
                    match g {
                        HomeItem::Notebook { path } => {
                            let name = Path::new(path)
                                .file_name()
                                .map(|n| n.to_string_lossy().to_string())
                                .unwrap_or_default();
                            targets.push((path.clone(), Some(path.clone()), name));
                        }
                        HomeItem::Note { path } => {
                            let name = Path::new(path)
                                .file_stem()
                                .map(|n| n.to_string_lossy().to_string())
                                .unwrap_or_default();
                            targets.push((path.clone(), None, name));
                        }
                        _ => {}
                    }
                }
            }
        }
    }

    for (path, nb_path, nb_name) in targets {
        let p = Path::new(&path);
        let idx = ensure_index_for_notebook(paths, p)?;
        for (fname, entry) in idx.notes {
            let hay = format!("{} {}", entry.title, entry.text).to_lowercase();
            if terms.iter().all(|t| hay.contains(t)) {
                let mut score = 0u32;
                for t in &terms {
                    if entry.title.to_lowercase().contains(t) {
                        score += 10;
                    }
                    score += entry.text.to_lowercase().matches(t).count() as u32;
                }
                let note_path = if p.is_dir() {
                    p.join(&fname).to_string_lossy().to_string()
                } else {
                    path.clone()
                };
                hits.push(SearchHit {
                    note_path,
                    note_title: entry.title,
                    notebook_name: nb_name.clone(),
                    notebook_path: nb_path.clone(),
                    snippet: snippet_around(&entry.text, terms[0]),
                    score,
                });
            }
        }
    }

    hits.sort_by_key(|h| std::cmp::Reverse(h.score));
    Ok(hits)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snippet_around_em_space_does_not_panic() {
        let em = "\u{2003}";
        let text = format!("hello{em}world{em}and{em}more{em}text");
        for i in 0..text.len() {
            if !text.is_char_boundary(i) {
                continue;
            }
            let _ = snippet_around(&text, "world");
            let _ = snippet_around(&text[i..], "hello");
        }
        let s = snippet_around(&text, "world");
        assert!(s.contains("world"), "{s}");
        assert!(!s.contains('\u{FFFD}'));
    }

    #[test]
    fn snippet_around_hungarian_and_tab_em_space() {
        let text = "Első\u{2003}bekezdés — második";
        let s = snippet_around(text, "bekezdés");
        assert!(s.to_lowercase().contains("bekezd"));
    }
}
