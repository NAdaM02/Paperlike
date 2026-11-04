# Spec: App State & Data Safety

Everything Paperlike stores **outside** notebooks, plus saving, crash recovery, and
external-change handling.

Owner decision: per-user config directory at `%APPDATA%\Paperlike`.

---

## 1. Directory layout

```
%APPDATA%\Paperlike\
├── settings.json      ← user preferences
├── home.json          ← Home grid content, order, groups
├── ignored.json       ← "Detect" ignore list
├── ui-state.json      ← window geometry, per-notebook sidebar state (volatile-ish)
├── checklist.json     ← app-wide checklist (top-right tools)
├── icons\             ← generated .ico files for notebook folder covers (<hash>.ico)
├── recovery\          ← crash-recovery journals (§4)
└── index\             ← search index cache (see search.md)
```

All JSON files: UTF-8, pretty-printed, with a top-level `"version": 1`. Corrupt
file → rename to `<name>.corrupt-<timestamp>` and start fresh (never crash on bad
state files).

## 2. Schemas

### `settings.json`

```jsonc
{
  "version": 1,
  "theme": "mix" | "bright" | "dark",   // default for new installs: mix
  "autosave": true,                    // File → Auto-save toggle (app-global)
  "export_defaults": { "page_numbers": true, "title_headers": true, "export_date": false, "geometry_block": false },
  "last_export_dir": "C:\\…",
  "update_on_exit": true,              // prefetch + install on close (Settings → General)
  "autostart": false,
  "tray": false,
  "welcome_dismissed": false,
  "study_prompted": false,            // first-run study card answered
  "study_preset": null,               // e.g. "tum-aerospace" after the setup is created
  "study_root": null,                 // folder the preset was written into
  "moodle_enabled": false,            // Moodle course browser switch
  "git_sync": false,                  // Sync github (§6), off by default
  "git_sync_dir": null,               // the repository folder it syncs
  "sidebar_auto_hide": false          // note list hides to a rail, slides out on hover
}
```

`study_prompted`, `study_preset`, `study_root`, `moodle_enabled`, `git_sync` and
`git_sync_dir` are optional on read. A settings file from before those fields existed still loads; the missing
ones default to false / empty. Saving writes them back.

### `checklist.json`

```jsonc
{ "version": 1, "items": [ { "id": "k3f9a2", "text": "Buy paper", "done": false },
                           { "id": "p0c1d7", "text": "Exam on Friday", "done": false, "note": true } ] }
```

Written whole (atomic, no `.bak`) 400 ms after the last change and when the panel
closes. `note: true` rows are plain text without a checkbox. Missing or unreadable
file: an empty list.

### `home.json`

```jsonc
{
  "version": 1,
  "items": [                           // grid order = array order
    { "kind": "notebook", "path": "C:\\Notes\\Aerospace" },
    { "kind": "note",     "path": "C:\\Notes\\loose.note" },
    { "kind": "group", "name": "Uni", "items": [
        { "kind": "notebook", "path": "C:\\Notes\\Calc" },
        { "kind": "notebook", "path": "C:\\Notes\\Physics" }
    ] }
  ]
}
```

Groups are Home-only and never nest (a group cannot contain a group).

### `ignored.json`

```jsonc
{ "version": 1, "paths": [ "C:\\Old\\ArchivedNotes", "C:\\tmp\\test.note" ] }
```

Detect results found at these paths appear **unchecked**. Adding one from a Detect
run removes it from this list.

### `ui-state.json`

```jsonc
{
  "version": 1,
  "window": { "x": 0, "y": 0, "w": 1280, "h": 800, "maximized": false },
  "notebooks": {                       // keyed by notebook path
    "C:\\Notes\\Aerospace": { "sort": "created_desc", "sidebar_width": 220,
                               "sidebar_collapsed": false, "last_note": "10-21" }
  }
}
```

Entries for notebooks no longer on Home are pruned on save.

---

## 3. Saving model

- **Manual save**: Ctrl+S / File → Save. Saves the open note (and `.notebook_data`
  if dirty).
- **Auto-save** (when toggled on): saves about 0.4 s after the last edit, and also
  before leaving the note, closing the window, or exporting it. A failed save
  keeps the edits in the recovery copy.
- **Atomic writes, always**: write to `<file>.tmp` in the same directory, flush,
  then `ReplaceFileW`-style swap that leaves the previous version as `<file>.bak`
  (single rotating backup, hidden attribute). Applies to `.note`,
  `.notebook_data`, and all state JSONs (state files skip the `.bak`).
- "Open backup" recovery path offered when a `.note` fails to parse
  ([`file-formats.md`](file-formats.md) §1.4) loads `<file>.bak`.

## 4. Crash recovery

- While a note has unsaved changes, a full snapshot is written to
  `recovery\<sha256-of-path>.json` (with auto-save, just before the save; without
  it, about 1.5 s after the last edit, and again if a save fails).
- A clean save, or Discard in the unsaved-changes dialog, deletes the copy.
- On startup, copies that are still newer than the note on disk (or whose note
  went missing within the last 30 days) are offered one by one: **Recover**
  writes the copy over the note, keeping the replaced file in `backups\`, and
  opens it. If the note's folder is gone it is written to
  Documents\Paperlike\Recovered. **Discard** deletes the copy. **Decide later**
  leaves them for the next start. A copy older than a saved note is dropped.

## 5. External changes & sync tools

Notebooks may live in Dropbox/OneDrive-synced folders; Paperlike must tolerate
files changing under it.

- A filesystem watcher runs on the open notebook folder.
- `.note` changed on disk while open:
  - if the in-app note is **clean** → silently reload;
  - if **dirty** → non-modal banner: "This note changed on disk." with
    [Keep mine] (next save overwrites) / [Load theirs] (discard local edits) /
    [Save a copy] (writes `<title> (conflict yyyy-mm-dd hh-mm).note`, then loads
    theirs).
- `.note` added/removed/renamed externally → sidebar refreshes; if the open note
  was deleted externally, banner: "This note was deleted on disk" with
  [Save it back] / [Close].
- `.notebook_data` changed externally → reload if clean; if dirty, last-writer-wins
  with a toast.
- Never auto-resolve by deleting user data; every destructive branch requires the
  explicit button click above.

## 6. Sync github

Settings › Files › **Sync github** ("Synchronize with the repository where you keep
your notes"). Off by default and not part of the welcome tour. Turning it on asks
for the folder first (a git clone); "Change folder" picks another. The folder is
checked right away (git missing, not a repository, no remote) and the remote URL
is shown under it. Code: `src-tauri/src/gitsync.rs`, `src/GitSync.tsx`.

**When it runs.** Only these, never on a timer or after each save:
- on startup (about 1.5 s after launch);
- on shutdown: the window hides, then one sync runs (the UI waits at most 30 s).
  Hiding to the tray is not a shutdown;
- about 2 minutes after a note that was saved while open is closed (switching
  notes, leaving the notebook) and not reopened. The wait is per note; reopening
  cancels it. A deleted note counts as closed. Notes outside the folder are ignored;
- when **Sync now** is pressed in Settings › Files (disabled while a sync runs or
  the folder can't be synced).

One sync runs at a time; a trigger during a run queues one more run.

**Steps** (the `sync` command line script): `add -A`; commit only when something is
staged (`yyyy. MM. dd. - HH:mm`, so a nested repository that cannot be staged makes
no empty commit); `fetch`; push with `-u` when the branch is not on the remote yet;
merge `<remote>/<branch>` when behind; push when ahead. It uses the current branch
(an empty repository starts on `main`), `origin` or else the first remote, and the
system git with its credential helper (`GIT_TERMINAL_PROMPT=0`, no console window).
After a pull, the notebook list refreshes and the open note reloads when it has no
unsaved edits.

**Status.** A small chip at the bottom left: "Syncing" only when a sync takes over
0.6 s, then "Synced" for about 2 s; "Sync didn't finish" on an error (tooltip with
the reason and git's last line, click opens Settings › Files, × hides it until the
error changes); "Sync conflict" while files wait. The settings block shows the last
sync time or the error in words: git missing, folder missing, not a repository, no
remote, detached HEAD, sign-in refused, offline, push rejected, files that could not
be added, commit failed (identity), merge failed.

**Conflicts** are the only interruption. The merge is left in progress and each
conflicted file is set to the local version, so the app never reads conflict
markers. A card ("Pick a version") lists each file with the last local and remote
commit times and **Keep mine** / **Keep theirs** / **Open note**; it opens once per
new conflict, "Later" closes it and the chip reopens it. Keep mine stages the local
file (edits made since the conflict included). Keep theirs first copies the local
file to `<name> (my edits).<ext>` when it changed since the conflict, then checks
out the remote version. When no file is left, the merge commit is made and pushed.
Until then every sync stops at the conflict. Both versions stay in git history.
