//! `paperlike` CLI — src-tauri/src/cli/mod.rs

use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{bail, Context, Result};
use clap::{Parser, Subcommand};

use crate::export::ExportOptions;
use crate::state::{AppPaths, HomeItem, Settings};

// ── Argument types ────────────────────────────────────────────────────────────

const AFTER_HELP: &str = "\
Examples:
  paperlike                              Open the Paperlike window at Home
  paperlike open \"Advanced Math\"         Open the first notebook or note whose name starts with this
  paperlike list                         Show everything on Home, with groups indented
  paperlike list \"Advanced Math\"         Show the notes inside a notebook
  paperlike export todo                  Export the note \"todo\" to PDF, next to the note
  paperlike export \"Mechanics 1/Week 3\"  Export a note inside a notebook
  paperlike export todo --format md      Export to Markdown instead
  paperlike export a b c                 Export several notes in one go

Names are matched against Home: first by how they start, then anywhere in the name,
ignoring case. A full path to a .note file or a notebook folder works everywhere too.

Tab completion in PowerShell: run  paperlike completion --help";

#[derive(Parser)]
#[command(
    name = "paperlike",
    about = "Open, list and export your Paperlike notes from the terminal.",
    long_about = "Open, list and export your Paperlike notes from the terminal.\n\nRun without a command to open the Paperlike window.",
    after_help = AFTER_HELP,
    version,
    disable_help_subcommand = true
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Cmd>,
}

#[derive(Clone, Copy, PartialEq, Eq, clap::ValueEnum)]
enum Format {
    /// PDF document (the default)
    Pdf,
    /// Markdown text file
    Md,
}

impl Format {
    fn as_str(self) -> &'static str {
        match self {
            Format::Pdf => "pdf",
            Format::Md => "md",
        }
    }
}

#[derive(Clone, Copy, clap::ValueEnum)]
enum Shell {
    Powershell,
}

#[derive(Subcommand)]
enum Cmd {
    /// Open a notebook or note in the Paperlike window
    #[command(after_help = "Examples:\n  paperlike open \"Advanced Math\"\n  paperlike open adv\n  paperlike open \"C:\\Notes\\todo.note\"")]
    Open {
        /// Name on Home (start of the name is enough) or a full path
        #[arg(value_name = "NAME_OR_PATH")]
        query: String,
    },
    /// Show what's on Home, or the notes inside one notebook
    #[command(after_help = "Examples:\n  paperlike list\n  paperlike list \"Advanced Math\"")]
    List {
        /// Notebook to look inside (start of the name is enough)
        #[arg(value_name = "NOTEBOOK")]
        notebook: Option<String>,
    },
    /// Export notes to PDF or Markdown
    #[command(after_help = "Examples:\n  paperlike export todo\n  paperlike export todo --format md\n  paperlike export todo -o \"C:\\Exports\\todo.pdf\"\n  paperlike export \"Mechanics 1/Week 3\"\n  paperlike export \"Week 1\" \"Week 2\"\n\nPage numbers, the export date and the other options follow the defaults set in the app.")]
    Export {
        /// Note name ("Notebook/Note" for notes in a notebook) or a path to a .note file
        #[arg(required = true, value_name = "NOTE")]
        notes: Vec<String>,
        /// Where to write the file (only with a single note). Default: next to the note
        #[arg(short = 'o', long, value_name = "FILE")]
        output: Option<String>,
        /// File type to create
        #[arg(short = 'f', long, value_enum, default_value_t = Format::Pdf)]
        format: Format,
    },
    /// Print the script that adds Tab completion to your shell
    #[command(after_help = "Add this line to your PowerShell profile (notepad $PROFILE):\n\n  paperlike completion powershell | Out-String | Invoke-Expression\n\nThen  paperlike open Adv<Tab>  completes to names on Home.")]
    Completion {
        #[arg(value_enum, default_value_t = Shell::Powershell)]
        shell: Shell,
    },
    /// Names for Tab completion (used by the completion script)
    #[command(hide = true)]
    Complete {
        command: String,
        prefix: Option<String>,
    },
}

// ── Entry point ───────────────────────────────────────────────────────────────

pub fn run() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        None => launch_gui(None),
        Some(Cmd::Open { query }) => cmd_open(&query),
        Some(Cmd::List { notebook }) => cmd_list(notebook.as_deref()),
        Some(Cmd::Export { notes, output, format }) => cmd_export(notes, output.as_deref(), format.as_str()),
        Some(Cmd::Completion { shell: Shell::Powershell }) => {
            print!("{POWERSHELL_COMPLETION}");
            Ok(())
        }
        Some(Cmd::Complete { command, prefix }) => cmd_complete(&command, prefix.as_deref()),
    }
}

const POWERSHELL_COMPLETION: &str = r#"Register-ArgumentCompleter -Native -CommandName paperlike, paperlike.exe -ScriptBlock {
    param($word, $ast, $cursor)
    $parts = @($ast.CommandElements | ForEach-Object { $_.ToString() })
    $word = "$word".Trim('"', "'")
    if ($parts.Count -le 1 -or ($parts.Count -eq 2 -and $word)) {
        $items = 'open', 'list', 'export', 'completion'
    } elseif ($parts[1] -in 'open', 'list', 'export') {
        $items = @(paperlike complete $parts[1] $word)
    } else {
        return
    }
    $items | Where-Object { $_.Trim('"') -like "$word*" } | ForEach-Object {
        [System.Management.Automation.CompletionResult]::new($_, $_.Trim('"'), 'ParameterValue', $_.Trim('"'))
    }
}
"#;

// ── Commands ──────────────────────────────────────────────────────────────────

/// Start or focus the GUI, optionally pre-opening a path.
fn launch_gui(path: Option<&str>) -> Result<()> {
    let gui = sibling_exe("Paperlike")?;
    let mut cmd = Command::new(&gui);
    if let Some(p) = path {
        cmd.arg(p);
    }
    cmd.spawn()
        .with_context(|| format!("Could not start {}", gui.display()))?;
    Ok(())
}

/// Resolve a name or path and open it in the GUI.
fn cmd_open(query: &str) -> Result<()> {
    // Absolute or relative path that already exists → open directly.
    let p = Path::new(query);
    if p.exists() {
        return launch_gui(Some(query));
    }

    let paths = AppPaths::resolve();
    let home = crate::state::load_home(&paths)?;
    let items = flat_home_items(&home.items);

    let resolved = resolve_query(query, &items)
        .with_context(|| format!("no notebook or note matches '{query}' (try `paperlike list`)"))?;
    launch_gui(Some(&resolved))
}

/// Print all Home notebooks and notes.
fn cmd_list(notebook: Option<&str>) -> Result<()> {
    let paths = AppPaths::resolve();
    let home = crate::state::load_home(&paths)?;
    if let Some(q) = notebook {
        let books: Vec<(String, String)> = flat_home_items(&home.items)
            .into_iter()
            .filter(|(_, p)| Path::new(p).is_dir())
            .collect();
        let dir = resolve_query(q, &books)
            .with_context(|| format!("no notebook matches '{q}' (try `paperlike list`)"))?;
        let notes = notes_in(Path::new(&dir));
        println!("{}", path_name(&dir));
        if notes.is_empty() {
            println!("  (no notes yet)");
        }
        for n in notes {
            println!("  {}", path_stem(&n));
        }
        return Ok(());
    }
    if home.items.is_empty() {
        println!("Home is empty. Add a notebook or note in the app first.");
    } else {
        print_items(&home.items, 0);
    }
    Ok(())
}

fn print_items(items: &[HomeItem], depth: usize) {
    let indent = "  ".repeat(depth);
    for item in items {
        match item {
            HomeItem::Notebook { path } => {
                println!("{indent}[notebook] {}", path_name(path));
            }
            HomeItem::Note { path } => {
                println!("{indent}[note]     {}", path_stem(path));
            }
            HomeItem::Group { name, items: children } => {
                println!("{indent}[group]    {name}/");
                print_items(children, depth + 1);
            }
        }
    }
}

/// Export notes to PDF or Markdown.
fn cmd_export(note_paths: Vec<String>, output: Option<&str>, format: &str) -> Result<()> {
    if output.is_some() && note_paths.len() > 1 {
        bail!("-o / --output can only be used with a single note");
    }

    let app_paths = AppPaths::resolve();
    let settings = crate::state::load_settings(&app_paths)?;

    let home_items = crate::state::load_home(&app_paths).map(|h| all_notes(&h.items)).unwrap_or_default();
    for np in &note_paths {
        let resolved = resolve_note(np, &home_items)?;
        let note_path = Path::new(&resolved);
        let note = crate::note::load_note(note_path)
            .with_context(|| format!("could not load {np}"))?;
        let title = note_path
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "Untitled".into());
        let dest = export_dest(note_path, output, format)?;
        let opts = make_export_opts(format, &settings);
        crate::export::export_note(&note, &title, &dest, &opts)
            .with_context(|| format!("export failed for {np}"))?;
        println!("Exported: {}", dest.display());
    }
    Ok(())
}

/// Every note reachable from Home: loose notes by name, notes inside notebooks
/// both as "Notebook/Note" and by their own name.
fn all_notes(items: &[HomeItem]) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut inner = Vec::new();
    for (name, path) in flat_home_items(items) {
        let p = Path::new(&path);
        if is_note_path(p) {
            out.push((name, path));
        } else if p.is_dir() {
            for stem_path in notes_in(p) {
                let stem = path_stem(&stem_path);
                inner.push((format!("{name}/{stem}"), stem_path.clone()));
                out.push((stem, stem_path));
            }
        }
    }
    out.extend(inner);
    out
}

fn notes_in(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> = std::fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .map(|e| e.path())
                .filter(|p| is_note_path(p))
                .map(|p| p.to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    v.sort_by_key(|p| p.to_ascii_lowercase());
    v
}

fn is_note_path(p: &Path) -> bool {
    p.extension().is_some_and(|e| e.eq_ignore_ascii_case("note"))
}

/// A path to an existing file, or a note name (see `all_notes`).
fn resolve_note(query: &str, items: &[(String, String)]) -> Result<String> {
    if Path::new(query).is_file() {
        return Ok(query.to_string());
    }
    match resolve_query(&query.replace('\\', "/"), items) {
        Some(p) => Ok(p),
        None => bail!("no note matches '{query}' (try `paperlike list`)"),
    }
}

/// Print completion candidates for a subcommand and optional prefix.
fn cmd_complete(command: &str, prefix: Option<&str>) -> Result<()> {
    let prefix_lc = prefix.unwrap_or("").to_ascii_lowercase();
    let paths = AppPaths::resolve();
    let home = crate::state::load_home(&paths)?;
    let items: Vec<(String, String)> = match command {
        "open" => flat_home_items(&home.items),
        "list" => flat_home_items(&home.items).into_iter().filter(|(_, p)| Path::new(p).is_dir()).collect(),
        // Offer "Notebook/Note" names; bare note names are accepted but would crowd the list.
        "export" => {
            let all = all_notes(&home.items);
            all.iter()
                .filter(|(n, p)| n.contains('/') || !all.iter().any(|(m, q)| m.contains('/') && q == p))
                .cloned()
                .collect()
        }
        _ => return Ok(()),
    };

    for (name, _path) in &items {
        let name_lc = name.to_ascii_lowercase();
        if prefix_lc.is_empty() || name_lc.starts_with(&prefix_lc) {
            // Quote names that contain spaces.
            if name.contains(' ') {
                println!("\"{name}\"");
            } else {
                println!("{name}");
            }
        }
    }
    Ok(())
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Path to a sibling executable in the same directory as the running binary.
fn sibling_exe(name: &str) -> Result<PathBuf> {
    let exe = std::env::current_exe().context("cannot determine current exe path")?;
    let dir = exe.parent().context("exe has no parent directory")?;
    let path = dir.join(format!("{name}.exe"));
    if !path.exists() {
        bail!("{name}.exe not found next to {}", exe.display());
    }
    Ok(path)
}

/// Flat list of `(display_name, abs_path)` from Home items (groups flattened).
fn flat_home_items(items: &[HomeItem]) -> Vec<(String, String)> {
    let mut out = Vec::new();
    collect_home_items(items, &mut out);
    out
}

fn collect_home_items(items: &[HomeItem], out: &mut Vec<(String, String)>) {
    for item in items {
        match item {
            HomeItem::Notebook { path } => out.push((path_name(path), path.clone())),
            HomeItem::Note { path } => out.push((path_stem(path), path.clone())),
            HomeItem::Group { items: children, .. } => collect_home_items(children, out),
        }
    }
}

/// Prefix-then-contains name match (case-insensitive). Returns the abs path.
fn resolve_query(query: &str, items: &[(String, String)]) -> Option<String> {
    let q = query.to_ascii_lowercase();
    // Prefix match first for speed and predictability.
    for (name, path) in items {
        if name.to_ascii_lowercase().starts_with(&q) {
            return Some(path.clone());
        }
    }
    // Substring match fallback.
    for (name, path) in items {
        if name.to_ascii_lowercase().contains(&q) {
            return Some(path.clone());
        }
    }
    None
}

/// Default export destination: same directory as source, stem + format extension.
fn export_dest(source: &Path, output: Option<&str>, format: &str) -> Result<PathBuf> {
    if let Some(out) = output {
        return Ok(PathBuf::from(out));
    }
    let stem = source.file_stem().unwrap_or_default().to_string_lossy();
    let ext = if format == "md" { "md" } else { "pdf" };
    let dir = source.parent().unwrap_or(Path::new("."));
    Ok(dir.join(format!("{stem}.{ext}")))
}

/// Build ExportOptions from a format string and the user's saved defaults.
fn make_export_opts(format: &str, settings: &Settings) -> ExportOptions {
    let d = &settings.export_defaults;
    ExportOptions {
        format: format.to_string(),
        page_numbers: d.page_numbers,
        title_header: None,
        export_date: d.export_date,
        geometry_block: d.geometry_block,
    }
}

fn path_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_owned())
}

fn path_stem(path: &str) -> String {
    Path::new(path)
        .file_stem()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_owned())
}
