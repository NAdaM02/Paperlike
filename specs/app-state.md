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
  "moodle_enabled": false             // Moodle course browser switch
}
```

`study_prompted`, `study_preset`, `study_root`, and `moodle_enabled` are optional
on read. A settings file from before those fields existed still loads; the missing
ones default to false / empty. Saving writes them back.

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
