# Paperlike

Paperlike is a Windows app for notes. The page is an open sheet: write, draw, and place images and PDFs wherever you want. Each notebook is a folder on your computer.

It is free and open source under the [MIT license](LICENSE).

## Install

Go to [https://paperlike.duckdns.org/app](https://paperlike.duckdns.org/app) and download the installer.

That is the way to get Paperlike. The installer is for Windows. Your notes stay in the folders you create. They are not uploaded.

## Build it yourself

You do not need this to use the app. Use it when you want to edit Paperlike or run your own copy.

Install these once:

1. [Node.js](https://nodejs.org) (the LTS version).
2. [Rust](https://rustup.rs). When the installer asks, accept the default MSVC toolchain.

Then open this folder, and run:

```powershell
.\build.ps1
```

The first time takes several minutes. It downloads what the build needs, then compiles the app. When it finishes, this folder contains **Paperlike.lnk**. Double-click that shortcut to open your build.

## Free up disk space

A build leaves a few gigabytes of temporary files. To remove them:

```powershell
.\clean.ps1
```

It lists what it will delete and asks before doing it. It does not delete your notes, and it does not delete the shortcut. The shortcut will not open until you run `.\build.ps1` again.

## Recap of the commands

| Command | What it does |
| --- | --- |
| `.\build.ps1` | Builds Paperlike executables and puts **Paperlike.lnk** in the root folder. |
| `.\clean.ps1` | Shows the build files and, if you answer `y`, deletes them. |
| `.\clean.ps1 -WhatIf` | Only lists those files. Nothing is deleted. |
| `.\clean.ps1 -Force` | Deletes them without asking. |
| `.\clean.ps1 -All` | Also deletes `node_modules`, the folder of downloaded build pieces. The next `.\build.ps1` downloads them again. |

## Command line

After installation, `paperlike` is on your PATH. It works in PowerShell, Command Prompt and Windows Terminal.

Wherever a command takes a name, you can type the start of a notebook or note name on Home (case doesn't matter) or a full path.

### Open

| Command | What it does |
| --- | --- |
| `paperlike` | Opens the Paperlike window at Home, or brings it to the front. |
| `paperlike open "Advanced Math"` | Opens the first notebook or note whose name starts with "Advanced Math". |
| `paperlike open "C:\Notes\todo.note"` | Opens a note by its full path. |
| `paperlike list` | Shows everything on Home, with groups indented. |
| `paperlike list "Advanced Math"` | Shows the notes inside a notebook. |

### Export

| Command | What it does |
| --- | --- |
| `paperlike export todo` | Exports the note "todo" to a PDF next to the note. |
| `paperlike export "Mechanics 1/Week 3"` | Exports a note inside a notebook. The note's name alone works too. |
| `paperlike export todo --format md` | Exports it to Markdown instead. |
| `paperlike export todo -o "C:\Exports\todo.pdf"` | Writes the file to a path you choose (one note at a time). |
| `paperlike export "Week 1" "Week 2"` | Exports several notes at once. |

Page numbers, the export date and the other options follow the export defaults you set in the app.

### Help

| Command | What it does |
| --- | --- |
| `paperlike --help` | Lists the commands with examples. |
| `paperlike export --help` | Shows the details of one command. |

### Tab completion (PowerShell)

Open your profile with `notepad $PROFILE` and add this line:

```powershell
paperlike completion powershell | Out-String | Invoke-Expression
```

Open a new terminal. Now `paperlike open Adv` + <kbd>Tab</kbd> completes to names on Home, such as `"Advanced Math 1"`.

## Work on the app

```powershell
npm install
npm run tauri dev
```

That opens a live copy you can change while it is running. `.\build.ps1` is the copy you actually use.

How the app is supposed to behave is written in [`index.md`](index.md) and [`specs/`](specs/).
