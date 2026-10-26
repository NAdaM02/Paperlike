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

| Command | What it does |
| --- | --- |
| `.\build.ps1` | Builds Paperlike and puts **Paperlike.lnk** in this folder. |
| `.\clean.ps1` | Shows the build files and, if you answer `y`, deletes them. |
| `.\clean.ps1 -WhatIf` | Only lists those files. Nothing is deleted. |
| `.\clean.ps1 -Force` | Deletes them without asking. |
| `.\clean.ps1 -All` | Also deletes `node_modules`, the folder of downloaded build pieces. The next `.\build.ps1` downloads them again. |

## Work on the app

```powershell
npm install
npm run tauri dev
```

That opens a live copy you can change while it is running. `.\build.ps1` is the copy you actually use.

How the app is supposed to behave is written in [`index.md`](index.md) and [`specs/`](specs/).
