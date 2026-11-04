//! Sync github: keeps the notes folder in step with its git remote — specs/app-state.md
//!
//! The same steps as the `sync` command line script: stage everything, commit a
//! snapshot, fetch, merge the remote branch and push. It runs only on startup, on
//! shutdown, and about two minutes after an edited note was closed and not reopened.
//! A merge conflict pauses the sync until the user picks a side for each file.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::state::{self, AppPaths};

/// How long a closed note waits before its changes are synced.
const CLOSE_DELAY: Duration = Duration::from_secs(120);

#[derive(Debug, Clone, Serialize, Default)]
pub struct Conflict {
    /// Absolute path of the conflicted file.
    pub path: String,
    /// Path inside the repository, with forward slashes.
    pub name: String,
    /// Last local and remote commit times of the file (RFC 3339), when known.
    pub mine: Option<String>,
    pub theirs: Option<String>,
    pub is_note: bool,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct SyncStatus {
    /// off | idle | syncing | ok | error | conflict
    pub state: String,
    /// Error kind for the UI copy: no-git, folder-missing, not-repo, no-remote, detached,
    /// auth, offline, rejected, stage, commit, merge, other.
    pub code: String,
    /// Last line git printed, for the tooltip.
    pub detail: String,
    /// When the last sync finished (RFC 3339).
    pub at: Option<String>,
    pub conflicts: Vec<Conflict>,
}

#[derive(Default)]
struct Tracker {
    open: HashSet<String>,
    edited: HashSet<String>,
    pending: HashMap<String, u64>,
}

static APP: OnceLock<AppHandle> = OnceLock::new();
static RUN: Mutex<()> = Mutex::new(());
static AGAIN: AtomicBool = AtomicBool::new(false);
static TOKEN: AtomicU64 = AtomicU64::new(1);

fn tracker() -> &'static Mutex<Tracker> {
    static T: OnceLock<Mutex<Tracker>> = OnceLock::new();
    T.get_or_init(|| Mutex::new(Tracker::default()))
}

fn status_cell() -> &'static Mutex<SyncStatus> {
    static S: OnceLock<Mutex<SyncStatus>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(SyncStatus { state: "idle".into(), ..Default::default() }))
}

fn key(path: &str) -> String {
    path.replace('/', "\\").trim_end_matches('\\').to_lowercase()
}

/// The folder to sync, when the setting is on.
fn folder() -> Option<PathBuf> {
    let settings = state::load_settings(&AppPaths::resolve()).ok()?;
    if !settings.git_sync {
        return None;
    }
    let dir = settings.git_sync_dir?;
    let dir = dir.trim();
    if dir.is_empty() {
        None
    } else {
        Some(PathBuf::from(dir))
    }
}

fn inside(path: &str, dir: &Path) -> bool {
    let root = key(&dir.to_string_lossy());
    let p = key(path);
    p == root || p.starts_with(&format!("{root}\\"))
}

fn publish(status: SyncStatus) {
    if let Ok(mut cur) = status_cell().lock() {
        *cur = status.clone();
    }
    if let Some(app) = APP.get() {
        let _ = app.emit("git-sync", &status);
    }
}

fn changed(paths: Vec<String>) {
    if paths.is_empty() {
        return;
    }
    if let Some(app) = APP.get() {
        let _ = app.emit("git-sync-changed", &paths);
    }
}

/* ── git ── */

struct Fail {
    code: &'static str,
    detail: String,
}

fn fail(code: &'static str, detail: impl Into<String>) -> Fail {
    Fail { code, detail: last_line(&detail.into()) }
}

fn last_line(text: &str) -> String {
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with("hint:"))
        .last()
        .unwrap_or("")
        .chars()
        .take(300)
        .collect()
}

struct Out {
    ok: bool,
    stdout: String,
    stderr: String,
}

impl Out {
    fn text(&self) -> String {
        format!("{}\n{}", self.stdout, self.stderr)
    }
    fn lines(&self) -> Vec<String> {
        self.stdout.lines().map(str::trim).filter(|l| !l.is_empty()).map(String::from).collect()
    }
}

fn git(dir: &Path, args: &[&str]) -> Result<Out, Fail> {
    let mut cmd = Command::new("git");
    cmd.args(["-c", "core.quotepath=false", "-c", "advice.detachedHead=false"])
        .args(args)
        .current_dir(dir)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    match cmd.output() {
        Ok(o) => Ok(Out {
            ok: o.status.success(),
            stdout: String::from_utf8_lossy(&o.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&o.stderr).into_owned(),
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(fail("no-git", "")),
        Err(e) => Err(fail("other", e.to_string())),
    }
}

/// Sort a failed fetch or push into the cases the UI explains.
fn network_fail(out: &Out) -> Fail {
    let text = out.text();
    let low = text.to_lowercase();
    let code = if ["could not resolve host", "failed to connect", "could not connect", "timed out", "network is unreachable", "connection refused", "connection was reset", "unable to access"]
        .iter()
        .any(|w| low.contains(w))
        && !low.contains("403")
    {
        "offline"
    } else if ["authentication failed", "could not read username", "could not read password", "permission denied", "terminal prompts disabled", "403", "401", "access denied", "repository not found"]
        .iter()
        .any(|w| low.contains(w))
    {
        "auth"
    } else if low.contains("rejected") || low.contains("non-fast-forward") {
        "rejected"
    } else {
        "other"
    };
    fail(code, text)
}

struct Repo {
    root: PathBuf,
}

impl Repo {
    fn open(dir: &Path) -> Result<Repo, Fail> {
        if !dir.is_dir() {
            return Err(fail("folder-missing", dir.to_string_lossy()));
        }
        let out = git(dir, &["rev-parse", "--show-toplevel"])?;
        if !out.ok {
            return Err(fail("not-repo", out.text()));
        }
        let top = out.stdout.trim();
        Ok(Repo { root: PathBuf::from(top.replace('/', "\\")) })
    }
    fn run(&self, args: &[&str]) -> Result<Out, Fail> {
        git(&self.root, args)
    }
    fn ok(&self, args: &[&str]) -> bool {
        self.run(args).map(|o| o.ok).unwrap_or(false)
    }
    fn first(&self, args: &[&str]) -> String {
        self.run(args).ok().filter(|o| o.ok).and_then(|o| o.lines().into_iter().next()).unwrap_or_default()
    }
    fn remote(&self) -> Result<String, Fail> {
        let remotes = self.run(&["remote"])?.lines();
        if remotes.iter().any(|r| r == "origin") {
            return Ok("origin".into());
        }
        remotes.into_iter().next().ok_or_else(|| fail("no-remote", ""))
    }
    fn abs(&self, name: &str) -> String {
        self.root.join(name.replace('/', "\\")).to_string_lossy().into_owned()
    }
    fn unmerged(&self) -> Vec<String> {
        self.run(&["diff", "--name-only", "--diff-filter=U"]).map(|o| o.lines()).unwrap_or_default()
    }
    fn merging(&self) -> bool {
        self.ok(&["rev-parse", "-q", "--verify", "MERGE_HEAD"])
    }
    fn conflicts(&self, names: &[String]) -> Vec<Conflict> {
        names
            .iter()
            .map(|name| {
                let when = |rev: &str| {
                    let t = self.first(&["log", "-1", "--format=%cI", rev, "--", name]);
                    (!t.is_empty()).then_some(t)
                };
                Conflict {
                    path: self.abs(name),
                    name: name.clone(),
                    mine: when("HEAD"),
                    theirs: when("MERGE_HEAD"),
                    is_note: name.to_lowercase().ends_with(".note"),
                }
            })
            .collect()
    }
}

enum Outcome {
    Done,
    Conflict(Vec<Conflict>),
}

fn sync_once(dir: &Path) -> Result<Outcome, Fail> {
    let repo = Repo::open(dir)?;
    let remote = repo.remote()?;

    // A conflict from an earlier run waits for the user. Once every file is
    // decided the merge commit is made here and the sync carries on.
    if repo.merging() {
        let left = repo.unmerged();
        if !left.is_empty() {
            return Ok(Outcome::Conflict(repo.conflicts(&left)));
        }
        let _ = repo.run(&["add", "-A"])?;
        let out = repo.run(&["commit", "--no-edit"])?;
        if !out.ok {
            return Err(fail("commit", out.text()));
        }
    }

    let has_commits = repo.ok(&["rev-parse", "--verify", "HEAD"]);
    let branch = if has_commits {
        let b = repo.first(&["rev-parse", "--abbrev-ref", "HEAD"]);
        if b.is_empty() || b == "HEAD" {
            return Err(fail("detached", ""));
        }
        b
    } else {
        let head = repo.first(&["symbolic-ref", "--short", "HEAD"]);
        if head.is_empty() {
            let _ = repo.run(&["symbolic-ref", "HEAD", "refs/heads/main"])?;
            "main".to_string()
        } else {
            head
        }
    };

    let out = repo.run(&["add", "-A"])?;
    if !out.ok {
        return Err(fail("stage", out.text()));
    }
    // Only staged changes count: a nested repository shows in status but cannot be committed here.
    let staged = repo.run(&["diff", "--cached", "--name-only"])?.lines();
    if !staged.is_empty() {
        let msg = chrono::Local::now().format("%Y. %m. %d. - %H:%M").to_string();
        let out = repo.run(&["commit", "-m", &msg])?;
        if !out.ok {
            return Err(fail("commit", out.text()));
        }
    }

    let out = repo.run(&["fetch", &remote])?;
    if !out.ok {
        return Err(network_fail(&out));
    }

    let remote_ref = format!("{remote}/{branch}");
    let on_remote = repo.ok(&["rev-parse", "--quiet", "--verify", &remote_ref]);
    if !repo.ok(&["rev-parse", "--verify", "HEAD"]) {
        // A fresh clone of a remote that had no commits yet, or an empty folder.
        if on_remote {
            let out = repo.run(&["merge", "--quiet", &remote_ref])?;
            if !out.ok {
                return Err(fail("merge", out.text()));
            }
            let names = repo.run(&["ls-files"]).map(|o| o.lines()).unwrap_or_default();
            changed(names.iter().map(|n| repo.abs(n)).collect());
        }
        return Ok(Outcome::Done);
    }
    if !on_remote {
        let out = repo.run(&["push", "-u", &remote, &branch])?;
        return if out.ok { Ok(Outcome::Done) } else { Err(network_fail(&out)) };
    }

    let count = |range: &str| repo.first(&["rev-list", "--count", range]).parse::<u64>().unwrap_or(0);
    let behind = count(&format!("HEAD..{remote_ref}"));
    if behind > 0 {
        let before = repo.first(&["rev-parse", "HEAD"]);
        let out = repo.run(&["merge", "--no-edit", "--quiet", &remote_ref])?;
        if !out.ok {
            let left = repo.unmerged();
            if left.is_empty() {
                return Err(fail("merge", out.text()));
            }
            // Text files would now hold conflict markers the app cannot read.
            // Show the local version until the user decides; both sides stay in git.
            for name in &left {
                let _ = repo.run(&["checkout", "--ours", "--", name]);
            }
            return Ok(Outcome::Conflict(repo.conflicts(&left)));
        }
        let names = repo
            .run(&["diff", "--name-only", &before, "HEAD"])
            .map(|o| o.lines())
            .unwrap_or_default();
        changed(names.iter().map(|n| repo.abs(n)).collect());
    }
    if count(&format!("{remote_ref}..HEAD")) > 0 {
        let out = repo.run(&["push", &remote, &branch])?;
        if !out.ok {
            return Err(network_fail(&out));
        }
    }
    Ok(Outcome::Done)
}

/// Run one sync now (or queue one more after the running one). Blocks until done.
pub fn sync_now() -> SyncStatus {
    let Some(dir) = folder() else {
        let s = SyncStatus { state: "off".into(), ..Default::default() };
        publish(s.clone());
        return s;
    };
    let Ok(_guard) = RUN.try_lock() else {
        AGAIN.store(true, Ordering::SeqCst);
        // Wait for the running sync so a shutdown never leaves before it ends.
        let _wait = RUN.lock();
        return current();
    };
    loop {
        AGAIN.store(false, Ordering::SeqCst);
        let mut s = current();
        s.state = "syncing".into();
        publish(s);
        let status = match sync_once(&dir) {
            Ok(Outcome::Done) => SyncStatus {
                state: "ok".into(),
                at: Some(chrono::Local::now().to_rfc3339()),
                ..Default::default()
            },
            Ok(Outcome::Conflict(conflicts)) => SyncStatus {
                state: "conflict".into(),
                at: current().at,
                conflicts,
                ..Default::default()
            },
            Err(f) => SyncStatus {
                state: "error".into(),
                code: f.code.into(),
                detail: f.detail,
                at: current().at,
                conflicts: Vec::new(),
            },
        };
        let stop = status.state == "conflict";
        publish(status);
        if stop || !AGAIN.load(Ordering::SeqCst) {
            break;
        }
    }
    current()
}

fn current() -> SyncStatus {
    status_cell().lock().map(|s| s.clone()).unwrap_or_default()
}

fn sync_later() {
    std::thread::spawn(|| {
        let _ = sync_now();
    });
}

/* ── triggers ── */

pub fn install(app: &AppHandle) {
    let _ = APP.set(app.clone());
    if folder().is_some() {
        std::thread::spawn(|| {
            std::thread::sleep(Duration::from_millis(1500));
            let _ = sync_now();
        });
    } else {
        publish(SyncStatus { state: "off".into(), ..Default::default() });
    }
}

/// A note was written by the app.
pub fn note_saved(path: &str) {
    let k = key(path);
    let closed = match tracker().lock() {
        Ok(mut t) => {
            t.edited.insert(k.clone());
            !t.open.contains(&k)
        }
        Err(_) => false,
    };
    // Saved while not open (a last save after closing, or a note written elsewhere).
    if closed {
        schedule(path);
    }
}

pub fn note_renamed(old: &str, new: &str) {
    if let Ok(mut t) = tracker().lock() {
        t.edited.remove(&key(old));
        t.edited.insert(key(new));
    }
}

/// A deleted note cannot be reopened, so its wait starts now.
pub fn note_deleted(path: &str) {
    if let Ok(mut t) = tracker().lock() {
        t.edited.insert(key(path));
        t.open.remove(&key(path));
    }
    schedule(path);
}

fn schedule(path: &str) {
    let k = key(path);
    let Some(dir) = folder() else {
        if let Ok(mut t) = tracker().lock() {
            t.edited.remove(&k);
        }
        return;
    };
    let token = TOKEN.fetch_add(1, Ordering::SeqCst);
    {
        let Ok(mut t) = tracker().lock() else { return };
        if !t.edited.remove(&k) {
            return;
        }
        if !inside(path, &dir) {
            return;
        }
        t.pending.insert(k.clone(), token);
    }
    std::thread::spawn(move || {
        std::thread::sleep(CLOSE_DELAY);
        let due = tracker()
            .lock()
            .map(|mut t| {
                if t.pending.get(&k) == Some(&token) && !t.open.contains(&k) {
                    t.pending.remove(&k);
                    true
                } else {
                    false
                }
            })
            .unwrap_or(false);
        if due {
            let _ = sync_now();
        }
    });
}

#[tauri::command]
pub fn git_sync_note_opened(path: String) {
    if let Ok(mut t) = tracker().lock() {
        let k = key(&path);
        t.pending.remove(&k);
        t.open.insert(k);
    }
}

#[tauri::command]
pub fn git_sync_note_closed(path: String) {
    if let Ok(mut t) = tracker().lock() {
        t.open.remove(&key(&path));
    }
    schedule(&path);
}

#[tauri::command]
pub fn git_sync_status() -> SyncStatus {
    if folder().is_none() {
        return SyncStatus { state: "off".into(), ..Default::default() };
    }
    let mut s = current();
    if s.state == "off" {
        s.state = "idle".into();
        publish(s.clone());
    }
    s
}

/// Settings › Sync now.
#[tauri::command]
pub async fn git_sync_run() -> SyncStatus {
    tauri::async_runtime::spawn_blocking(sync_now).await.unwrap_or_default()
}

/// Shutdown: one last sync before the window goes away.
#[tauri::command]
pub async fn git_sync_on_exit() -> SyncStatus {
    if let Ok(mut t) = tracker().lock() {
        t.pending.clear();
    }
    tauri::async_runtime::spawn_blocking(sync_now).await.unwrap_or_default()
}

#[derive(Debug, Clone, Serialize)]
pub struct FolderCheck {
    /// Empty when the folder can be synced, else an error code like `SyncStatus::code`.
    pub code: String,
    pub detail: String,
    /// Remote URL, shown under the folder.
    pub remote: String,
}

/// Checks a picked folder without changing anything.
#[tauri::command]
pub async fn git_sync_check(folder: String) -> FolderCheck {
    tauri::async_runtime::spawn_blocking(move || {
        let check = || -> Result<String, Fail> {
            let repo = Repo::open(Path::new(&folder))?;
            let remote = repo.remote()?;
            Ok(repo.first(&["remote", "get-url", &remote]))
        };
        match check() {
            Ok(remote) => FolderCheck { code: String::new(), detail: String::new(), remote },
            Err(f) => FolderCheck { code: f.code.into(), detail: f.detail, remote: String::new() },
        }
    })
    .await
    .unwrap_or(FolderCheck { code: "other".into(), detail: String::new(), remote: String::new() })
}

/// Settle one conflicted file. `keep` is "mine" or "theirs". Nothing is thrown away:
/// both versions stay in the git history, and unsynced edits made to the file
/// after the conflict appeared are kept as a copy beside it before "theirs" replaces it.
#[tauri::command]
pub async fn git_sync_resolve(path: String, keep: String) -> Result<SyncStatus, String> {
    tauri::async_runtime::spawn_blocking(move || resolve(&path, &keep))
        .await
        .map_err(|e| e.to_string())?
}

fn resolve(path: &str, keep: &str) -> Result<SyncStatus, String> {
    let dir = folder().ok_or("Sync github is off.")?;
    let left = resolve_in(&dir, path, keep)?;
    if left.is_empty() {
        // Every file is decided: finish the merge and push.
        sync_later();
        let mut s = current();
        s.state = "syncing".into();
        s.conflicts.clear();
        publish(s.clone());
        return Ok(s);
    }
    let mut s = current();
    s.conflicts = left;
    publish(s.clone());
    Ok(s)
}

/// Settles one file and returns the conflicts still open.
fn resolve_in(dir: &Path, path: &str, keep: &str) -> Result<Vec<Conflict>, String> {
    let repo = Repo::open(dir).map_err(|f| f.detail)?;
    let name = repo
        .unmerged()
        .into_iter()
        .find(|n| key(&repo.abs(n)) == key(path))
        .ok_or("This file has no conflict anymore.")?;
    let file = PathBuf::from(repo.abs(&name));
    let run = |args: &[&str]| -> Result<(), String> {
        let out = repo.run(args).map_err(|f| f.detail)?;
        if out.ok {
            Ok(())
        } else {
            Err(last_line(&out.text()))
        }
    };
    match keep {
        "mine" => {
            if file.exists() {
                run(&["add", "--", &name])?;
            } else {
                run(&["rm", "--quiet", "--", &name])?;
            }
        }
        "theirs" => {
            if file.exists() {
                let now = repo.first(&["hash-object", "--", &name]);
                let ours = repo.first(&["rev-parse", &format!(":2:{name}")]);
                if !now.is_empty() && now != ours {
                    keep_copy(&file)?;
                }
            }
            if repo.ok(&["cat-file", "-e", &format!(":3:{name}")]) {
                run(&["checkout", "--theirs", "--", &name])?;
                run(&["add", "--", &name])?;
            } else {
                run(&["rm", "--quiet", "--", &name])?;
            }
            changed(vec![repo.abs(&name)]);
        }
        _ => return Err("Unknown choice.".into()),
    }
    Ok(repo.conflicts(&repo.unmerged()))
}

/// Copy `file` to "<name> (my edits).<ext>" next to it, numbering when taken.
fn keep_copy(file: &Path) -> Result<(), String> {
    let stem = file.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = file.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    let parent = file.parent().ok_or("No folder.")?;
    for n in 1..1000 {
        let suffix = if n == 1 { " (my edits)".to_string() } else { format!(" (my edits {n})") };
        let target = parent.join(format!("{stem}{suffix}{ext}"));
        if !target.exists() {
            std::fs::copy(file, &target).map_err(|e| e.to_string())?;
            return Ok(());
        }
    }
    Err("Could not keep a copy of your edits.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inside_folder() {
        let dir = Path::new("C:\\Notes");
        assert!(inside("c:/notes/Math/a.note", dir));
        assert!(!inside("C:\\Notes2\\a.note", dir));
    }

    /// A real round trip through a bare remote and two clones, including conflicts.
    #[test]
    fn syncs_and_settles_conflicts() {
        let base = std::env::temp_dir().join(format!("pl-gitsync-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let sh = |dir: &Path, args: &[&str]| {
            let out = git(dir, args).ok().unwrap();
            assert!(out.ok, "git {args:?}: {}", out.text());
        };
        let remote = base.join("remote.git");
        sh(&base, &["init", "--bare", "-q", remote.to_str().unwrap()]);
        let a = base.join("a");
        let b = base.join("b");
        for dir in [&a, &b] {
            sh(&base, &["clone", "-q", remote.to_str().unwrap(), dir.to_str().unwrap()]);
            sh(dir, &["config", "user.name", "Test"]);
            sh(dir, &["config", "user.email", "test@example.com"]);
        }
        let read = |p: PathBuf| std::fs::read_to_string(p).unwrap_or_default();
        let done = |dir: &Path| matches!(sync_once(dir), Ok(Outcome::Done));

        // First push from A; B starts as an empty clone and pulls it.
        std::fs::create_dir_all(a.join("Math")).unwrap();
        std::fs::write(a.join("Math").join("w1.note"), "base").unwrap();
        assert!(done(&a));
        assert!(done(&a)); // nothing to do
        assert!(done(&b));
        assert_eq!(read(b.join("Math").join("w1.note")), "base");

        // Both sides edit the same note.
        std::fs::write(a.join("Math").join("w1.note"), "mine").unwrap();
        std::fs::write(b.join("Math").join("w1.note"), "theirs").unwrap();
        assert!(done(&b));
        let Ok(Outcome::Conflict(list)) = sync_once(&a) else { panic!("expected a conflict") };
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "Math/w1.note");
        assert!(list[0].is_note && list[0].mine.is_some() && list[0].theirs.is_some());
        // The working file is the local version, never conflict markers.
        assert_eq!(read(a.join("Math").join("w1.note")), "mine");
        // Still waiting on the next run.
        assert!(matches!(sync_once(&a), Ok(Outcome::Conflict(_))));

        // Edited again while waiting, then "keep theirs": the new edits survive as a copy.
        std::fs::write(a.join("Math").join("w1.note"), "mine, later").unwrap();
        let left = resolve_in(&a, &list[0].path, "theirs").unwrap();
        assert!(left.is_empty());
        assert_eq!(read(a.join("Math").join("w1.note")), "theirs");
        assert_eq!(read(a.join("Math").join("w1 (my edits).note")), "mine, later");
        assert!(done(&a));
        assert!(done(&b));
        assert_eq!(read(b.join("Math").join("w1 (my edits).note")), "mine, later");

        // Second conflict, "keep mine".
        std::fs::write(a.join("Math").join("w1.note"), "mine 2").unwrap();
        std::fs::write(b.join("Math").join("w1.note"), "theirs 2").unwrap();
        assert!(done(&b));
        let Ok(Outcome::Conflict(list)) = sync_once(&a) else { panic!("expected a conflict") };
        assert!(resolve_in(&a, &list[0].path, "mine").unwrap().is_empty());
        assert!(done(&a));
        assert!(done(&b));
        assert_eq!(read(b.join("Math").join("w1.note")), "mine 2");

        // Errors the UI explains.
        let plain = base.join("plain");
        std::fs::create_dir_all(&plain).unwrap();
        assert!(matches!(sync_once(&plain), Err(Fail { code: "not-repo", .. })));
        let lonely = base.join("lonely");
        sh(&base, &["init", "-q", lonely.to_str().unwrap()]);
        assert!(matches!(sync_once(&lonely), Err(Fail { code: "no-remote", .. })));
        assert!(matches!(sync_once(&base.join("missing")), Err(Fail { code: "folder-missing", .. })));

        // Git marks pack files read-only; clear that so the folder can be removed.
        fn writable(p: &Path) {
            if let Ok(entries) = std::fs::read_dir(p) {
                for e in entries.flatten() {
                    let path = e.path();
                    if path.is_dir() {
                        writable(&path);
                    } else if let Ok(meta) = std::fs::metadata(&path) {
                        let mut perm = meta.permissions();
                        #[allow(clippy::permissions_set_readonly_false)]
                        perm.set_readonly(false);
                        let _ = std::fs::set_permissions(&path, perm);
                    }
                }
            }
        }
        writable(&base);
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn sorts_network_failures() {
        let out = |e: &str| Out { ok: false, stdout: String::new(), stderr: e.into() };
        assert_eq!(network_fail(&out("fatal: unable to access 'https://github.com/x/': Could not resolve host: github.com")).code, "offline");
        assert_eq!(network_fail(&out("fatal: Authentication failed for 'https://github.com/x/'")).code, "auth");
        assert_eq!(network_fail(&out(" ! [rejected] main -> main (fetch first)")).code, "rejected");
    }
}
