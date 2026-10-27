mod atomic;
mod commands;
mod export;
mod md_import;
mod naming;
mod note;
mod notebook;
mod pdf_render;
mod search;
mod secret_store;
mod shell_open;
mod state;
mod study;
mod feedback;
mod gif;
mod google_account;
mod moodle;

use std::sync::atomic::{AtomicBool, Ordering};

use commands::AppState;
use state::AppPaths;
use tauri::Manager;

/// Set by the tray Quit item so CloseRequested cannot hide-to-tray instead of exiting.
static FORCE_QUIT: AtomicBool = AtomicBool::new(false);

/// Startup already found an update. Close must not hide to the tray; the window asks first.
static UPDATE_READY: AtomicBool = AtomicBool::new(false);

#[tauri::command]
fn set_update_ready(ready: bool) {
    UPDATE_READY.store(ready, Ordering::SeqCst);
}

#[tauri::command]
fn is_force_quit() -> bool {
    FORCE_QUIT.load(Ordering::SeqCst)
}

/// Hide the tray icon and leave. A downloaded update must not keep the process
/// alive behind the icon, or the next launch is the same instance.
#[tauri::command]
fn exit_app(app: tauri::AppHandle) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_visible(false);
    }
    app.exit(0);
    // preventDefault on the close that exit() raises must not keep the process.
    std::process::exit(0);
}

/// Program Files installs need an administrator prompt. A user-folder install does not.
#[tauri::command]
fn update_needs_admin() -> bool {
    let Ok(exe) = std::env::current_exe() else {
        return true;
    };
    let path = exe.to_string_lossy().to_ascii_lowercase();
    for key in ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"] {
        let Ok(dir) = std::env::var(key) else { continue };
        let dir = dir.trim_end_matches(['\\', '/']).to_ascii_lowercase();
        if dir.is_empty() {
            continue;
        }
        if path == dir || path.starts_with(&format!("{dir}\\")) {
            return true;
        }
    }
    false
}

const TRAY_ID: &str = "paperlike";

/// The window icon is applied from the PNG at startup. `tauri dev` otherwise
/// keeps the icon baked into the exe, and that resource is not rebuilt when
/// only the icon files change.
fn apply_window_icon(app: &tauri::App) -> tauri::Result<()> {
    let rgba = image::load_from_memory(include_bytes!("../icons/128x128@2x.png"))
        .expect("icons/128x128@2x.png")
        .into_rgba8();
    let (width, height) = rgba.dimensions();
    let icon = tauri::image::Image::new(rgba.as_raw(), width, height);
    if let Some(window) = app.get_webview_window("main") {
        window.set_icon(icon)?;
    }
    Ok(())
}

pub fn run() {
    let paths = AppPaths::resolve();
    let _ = paths.ensure();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            shell_open::on_second_instance(app, argv, cwd);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            apply_window_icon(app)?;
            install_tray(app)?;
            #[cfg(target_os = "windows")]
            disable_native_zoom(app);
            #[cfg(target_os = "windows")]
            disable_pen_hold(app);
            Ok(())
        })
        .manage(AppState { paths })
        .manage(shell_open::PendingOpen::from_startup())
        .invoke_handler(tauri::generate_handler![
            shell_open::take_pending_open,
            shell_open::register_file_association,
            set_update_ready,
            is_force_quit,
            exit_app,
            update_needs_admin,
            commands::get_settings,
            commands::save_settings,
            commands::get_home,
            commands::save_home,
            commands::get_home_tiles,
            commands::add_to_home,
            commands::remove_from_home,
            commands::classify_paths,
            commands::detect_notes,
            commands::detect_notes_full_scan,
            commands::apply_detect,
            commands::open_notebook,
            commands::create_note,
            commands::rename_note,
            commands::delete_note,
            commands::load_note,
            commands::save_note,
            commands::add_today_title,
            commands::set_notebook_meta,
            commands::set_notebook_cover,
            commands::save_separators,
            commands::export_note,
            commands::export_notes_merged,
            commands::compute_pdf_pages,
            commands::search_global,
            commands::create_notebook,
            commands::get_notebook_ui,
            commands::set_notebook_ui,
            commands::get_window_state,
            commands::save_window_state,
            commands::write_recovery,
            commands::clear_recovery,
            commands::list_recovery,
            commands::recover_note,
            commands::discard_recovery,
            commands::create_blank_note,
            commands::save_brief_bundle,
            commands::record_update_note,
            commands::take_update_announcement,
            commands::update_note_history,
            commands::path_is_dir,
            commands::reveal_path,
            commands::write_summary_pdf,
            commands::assistant_show,
            commands::assistant_bounds,
            commands::assistant_hide,
            commands::assistant_focus,
            commands::assistant_nav,
            commands::assistant_attach,
            gif::gif_search,
            gif::gif_fetch,
            commands::assistant_open,
            commands::google_status,
            commands::google_show,
            commands::google_hide,
            commands::google_capture,
            commands::google_forget,
            commands::quick_ask,
            commands::quick_stop,
            commands::quick_release,
            commands::license_price,
            commands::license_status,
            commands::license_refresh,
            commands::license_transfer,
            commands::feedback_send,
            commands::feedback_list,
            commands::feedback_seen,
            commands::feedback_reply,
            commands::uninstall_app,
            commands::import_markdown,
            study::create_study_preset,
            study::study_preset_info,
            moodle::moodle_show,
            moodle::moodle_warm,
            moodle::moodle_bounds,
            moodle::moodle_hide,
            moodle::moodle_nav,
            moodle::moodle_back,
            moodle::moodle_reload,
            moodle::moodle_eval,
            moodle::moodle_open_external,
            moodle::moodle_set_target,
            moodle::moodle_suggest,
            moodle::moodle_read_pdf,
            moodle::get_notebook_moodle,
            moodle::set_notebook_moodle,
            moodle::moodle_login_saved,
            moodle::moodle_save_login,
            moodle::moodle_decline_login,
            moodle::moodle_clear_login,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Paperlike");
}

/// Press-and-hold turns a pen stroke into a right-click after a short mark.
/// Disabling that feedback lets the ink keep following the pen.
#[cfg(target_os = "windows")]
fn disable_pen_hold(app: &tauri::App) {
    use windows::Win32::Foundation::HWND;
    #[link(name = "user32")]
    unsafe extern "system" {
        fn SetWindowFeedbackSetting(
            hwnd: HWND,
            feedback: i32,
            dwflags: u32,
            size: u32,
            configuration: *const core::ffi::c_void,
        ) -> i32;
    }
    let Some(window) = app.get_webview_window("main") else { return };
    let Ok(hwnd) = window.hwnd() else { return };
    // pen press-and-hold, touch press-and-hold, pen barrel visual, touch contact visual
    const KINDS: [i32; 4] = [5, 9, 2, 1];
    let off: i32 = 0;
    for kind in KINDS {
        unsafe {
            let _ = SetWindowFeedbackSetting(
                hwnd,
                kind,
                0,
                std::mem::size_of::<i32>() as u32,
                &off as *const i32 as *const _,
            );
        }
    }
}

/// Best-effort: stop WebView2 from applying its own pinch/ctrl+wheel zoom so the
/// canvas' own zoom handling receives the gestures. Untested without running the app.
#[cfg(target_os = "windows")]
fn disable_native_zoom(app: &tauri::App) {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings5;
    use windows::core::Interface;
    let Some(window) = app.get_webview_window("main") else { return };
    let res = window.with_webview(|pw| unsafe {
        let r: windows::core::Result<()> = (|| {
            let settings = pw.controller().CoreWebView2()?.Settings()?;
            let _ = settings.SetIsZoomControlEnabled(false);
            if let Ok(s5) = settings.cast::<ICoreWebView2Settings5>() {
                s5.SetIsPinchZoomEnabled(false)?;
            }
            Ok(())
        })();
        if let Err(e) = r {
            eprintln!("warning: could not disable WebView2 zoom: {e}");
        }
    });
    if let Err(e) = res {
        eprintln!("warning: with_webview failed: {e}");
    }
}

fn sync_tray_visible(app: &tauri::AppHandle, visible: bool) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_visible(visible);
    }
}

/// Called from `save_settings` so toggling "Keep running in the tray" shows or hides the icon.
pub fn apply_tray_setting(app: &tauri::AppHandle, tray_enabled: bool) {
    sync_tray_visible(app, tray_enabled);
}

fn install_tray(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::TrayIconBuilder;
    let show = MenuItem::with_id(app, "show", "Open", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    let rgba = image::load_from_memory(include_bytes!("../icons/128x128@2x.png"))
        .expect("icons/128x128@2x.png")
        .into_rgba8();
    let (iw, ih) = rgba.dimensions();
    let tray_icon = tauri::image::Image::new_owned(rgba.into_raw(), iw, ih);
    let tray_enabled = state::load_settings(&AppPaths::resolve())
        .map(|s| s.tray)
        .unwrap_or(false);
    let _tray = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("Paperlike")
        .icon(tray_icon)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let tauri::tray::TrayIconEvent::Click {
                button: tauri::tray::MouseButton::Left,
                button_state: tauri::tray::MouseButtonState::Up,
                ..
            } = event
            {
                shell_open::present_main(tray.app_handle());
            }
        })
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            if id == "show" {
                shell_open::present_main(app);
            } else if id == "quit" {
                FORCE_QUIT.store(true, Ordering::SeqCst);
                // Close, rather than destroy, so the window can install a downloaded update first.
                if let Some(w) = app.get_window("main") {
                    let _ = w.close();
                } else {
                    app.exit(0);
                }
            }
        })
        .build(app)?;
    // Default: no tray icon. Only show when Settings → Keep running in the tray is on.
    sync_tray_visible(&app.handle(), tray_enabled);
    if let Some(window) = app.get_webview_window("main") {
        let win = window.clone();
        let paths = AppPaths::resolve();
        window.on_window_event(move |event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if FORCE_QUIT.load(Ordering::SeqCst) || UPDATE_READY.load(Ordering::SeqCst) {
                    return;
                }
                let keep = state::load_settings(&paths).map(|s| s.tray).unwrap_or(false);
                if keep {
                    api.prevent_close();
                    let _ = win.hide();
                }
            }
        });
    }
    Ok(())
}
