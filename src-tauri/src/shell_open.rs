//! Open a `.note` or notebook when Paperlike is launched from File Explorer.
//!
//! A folder "Open in Paperlike" verb is intentionally not registered. That would
//! mean writing `Directory\shell` for every folder on the machine. Notebooks stay
//! a Home action ("Add note or notebook to Home").

use std::path::Path;
use std::sync::Mutex;

use anyhow::{bail, Context, Result};
use tauri::{Emitter, Manager};

/// Path from the first launch, cleared when the window asks for it.
pub struct PendingOpen {
    pub path: Mutex<Option<String>>,
}

impl PendingOpen {
    pub fn from_startup() -> Self {
        Self {
            path: Mutex::new(startup_open_path()),
        }
    }
}

/// File the process itself was started with, if it is a note or a notebook.
pub fn startup_open_path() -> Option<String> {
    openable_from_args(std::env::args())
}

/// Second process: focus the window that is already open and hand it the new args.
pub fn on_second_instance<R: tauri::Runtime>(app: &tauri::AppHandle<R>, argv: Vec<String>, _cwd: String) {
    if let Some(path) = openable_from_args(argv.iter().map(String::as_str)) {
        if let Some(pending) = app.try_state::<PendingOpen>() {
            let mut slot = pending.path.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            *slot = Some(path);
        }
    }
    present_main(app);
    let _ = app.emit_to("main", "open-file", argv);
}

/// Bring the main window back. A second launch is delivered inside a Windows
/// message that ignores `ShowWindow`, so the show waits until that returns.
///
/// `get_webview_window("main")` is empty once Moodle's child webview exists,
/// so this uses the window itself.
pub fn present_main<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let window = app.get_window("main");
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(200));
        let Some(window) = window.or_else(|| app.get_window("main")) else { return };
        #[cfg(target_os = "windows")]
        if let Ok(hwnd) = window.hwnd() {
            use windows::Win32::Foundation::HWND;
            use windows::Win32::UI::WindowsAndMessaging::{
                GetAncestor, GetWindowLongW, SetForegroundWindow, SetWindowLongW, SetWindowPos,
                ShowWindow, GA_ROOT, GWL_STYLE, HWND_TOP, SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW,
                SW_SHOWNORMAL, WS_VISIBLE,
            };
            let root = unsafe { GetAncestor(hwnd, GA_ROOT) };
            let chosen = if root.0.is_null() { hwnd } else { root };
            let hwnd = HWND(chosen.0);
            unsafe {
                // ShowWindow does nothing while WS_VISIBLE is still set on a hidden window.
                let style = GetWindowLongW(hwnd, GWL_STYLE);
                SetWindowLongW(hwnd, GWL_STYLE, style & !(WS_VISIBLE.0 as i32));
                let _ = ShowWindow(hwnd, SW_SHOWNORMAL);
                let _ = SetWindowPos(
                    hwnd,
                    Some(HWND_TOP),
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW,
                );
                let _ = SetForegroundWindow(hwnd);
            }
        }
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    });
}

/// Skip argv[0] (the executable) and flags. Keep the first note, `.notebook_data`,
/// or notebook folder.
fn openable_from_args<I, S>(args: I) -> Option<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    args.into_iter().skip(1).find_map(|arg| {
        let arg = arg.as_ref().trim().trim_matches('"');
        if is_openable(arg) {
            Some(arg.to_string())
        } else {
            None
        }
    })
}

fn is_openable(arg: &str) -> bool {
    if arg.is_empty() || arg.starts_with('-') {
        return false;
    }
    let path = Path::new(arg);
    if file_name_is(path, ".notebook_data") || ext_is(path, "note") {
        return true;
    }
    path.is_dir() && path.join(".notebook_data").is_file()
}

fn file_name_is(path: &Path, name: &str) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.eq_ignore_ascii_case(name))
}

fn ext_is(path: &Path, ext: &str) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case(ext))
}

#[tauri::command]
pub fn take_pending_open(state: tauri::State<PendingOpen>) -> Option<String> {
    state
        .path
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .take()
}

#[tauri::command]
pub fn register_file_association() -> Result<(), String> {
    register_note_association().map_err(|e| e.to_string())
}

fn register_note_association() -> Result<()> {
    #[cfg(not(windows))]
    {
        bail!("Making Paperlike the default .note app is only available on Windows");
    }
    #[cfg(windows)]
    {
        write_note_association()
    }
}

#[cfg(windows)]
fn write_note_association() -> Result<()> {
    use windows::Win32::UI::Shell::{SHChangeNotify, SHCNE_ASSOCCHANGED, SHCNF_IDLIST};

    let exe = std::env::current_exe().context("Could not find Paperlike.exe")?;
    let exe = exe.to_string_lossy();
    if exe.contains('"') {
        bail!("Paperlike's path contains a quote, so it cannot be registered safely");
    }
    let command = format!("\"{exe}\" \"%1\"");
    let icon = format!("{exe},0");

    set_classes_sz("Software\\Classes\\.note", "Paperlike.Note")
        .context("Could not map .note files to Paperlike")?;
    set_classes_sz("Software\\Classes\\Paperlike.Note", "Paperlike Note")
        .context("Could not create the Paperlike note type")?;
    set_classes_sz("Software\\Classes\\Paperlike.Note\\DefaultIcon", &icon)
        .context("Could not set the .note icon")?;
    set_classes_sz(
        "Software\\Classes\\Paperlike.Note\\shell\\open\\command",
        &command,
    )
    .context("Could not set the command that opens .note files")?;

    unsafe {
        SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, None, None);
    }
    Ok(())
}

#[cfg(windows)]
fn set_classes_sz(subkey: &str, value: &str) -> Result<()> {
    use windows::core::PCWSTR;
    use windows::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyW, RegSetValueExW, HKEY, HKEY_CURRENT_USER, REG_SZ,
    };

    let sub: Vec<u16> = subkey.encode_utf16().chain(std::iter::once(0)).collect();
    let mut key = HKEY::default();
    let created = unsafe { RegCreateKeyW(HKEY_CURRENT_USER, PCWSTR(sub.as_ptr()), &mut key) };
    if created.is_err() {
        bail!("Could not create {subkey} ({created:?})");
    }
    let data = utf16_z(value);
    let wrote = unsafe { RegSetValueExW(key, PCWSTR::null(), Some(0), REG_SZ, Some(data.as_slice())) };
    unsafe {
        let _ = RegCloseKey(key);
    }
    if wrote.is_err() {
        bail!("Could not write {subkey} ({wrote:?})");
    }
    Ok(())
}

#[cfg(windows)]
fn utf16_z(value: &str) -> Vec<u8> {
    value
        .encode_utf16()
        .chain(std::iter::once(0))
        .flat_map(|unit| unit.to_le_bytes())
        .collect()
}
