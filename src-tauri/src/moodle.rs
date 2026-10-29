//! Moodle course browser (Windows).
//!
//! Injected page script calls `window.paperlikePost`. That sends JSON through
//! WebView2 `postMessage`, prefixed `PL1`, and Rust handles it in
//! `WebMessageReceived` — not through Tauri's invoke bridge. Rust then sets
//! `window.__paperlikeAck` so the script can send the next piece. If
//! `postMessage` is missing, the script navigates to
//! `https://paperlike.local/moodle-msg?d=<json>` and that navigation is cancelled.
//!
//! Tauri still injects its IPC bootstrap into every child webview. The init
//! script runs after that bootstrap and replaces `__TAURI_INTERNALS__.invoke`
//! and `chrome.webview.postMessage` so only `PL1` messages are delivered.
//! Fetches to the `ipc` and `tauri` hosts are blocked. The app capability has
//! no remote URL, so a Moodle origin cannot call commands even if a message
//! reached the parser.
//!
//! Inline `pluginfile.php` PDFs never raise DownloadStarting (WebView2 shows
//! them in place). "Save PDF to Material" `fetch()`es that URL with the
//! session cookie and posts the bytes in base64 chunks on this same channel.
//! A normal PDF download is caught with `ICoreWebView2_4::DownloadStarting`
//! and written into the folder from `moodle_set_target`.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Mutex, OnceLock};

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::commands::AppState;

const LABEL: &str = "moodle";
const DEFAULT_URL: &str = "https://www.moodle.tum.de/my/courses.php";
const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const MAX_MSG: usize = 256 * 1024;
const MAX_PDF: usize = 40 * 1024 * 1024;
#[cfg(not(windows))]
const UNSUPPORTED: &str = "Moodle is only available on Windows.";

#[derive(Debug, Deserialize)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

fn err(e: impl ToString) -> String {
    e.to_string()
}

#[cfg(windows)]
mod win {
    use sha2::{Digest, Sha256};

    use super::*;

    static TARGET: Mutex<Option<PathBuf>> = Mutex::new(None);
    static HOOKED: AtomicBool = AtomicBool::new(false);
    static WORKER: OnceLock<Sender<String>> = OnceLock::new();
    /// Last IdP form credentials, held until the user accepts or declines Save.
    static PENDING_LOGIN: Mutex<Option<crate::secret_store::MoodleLogin>> = Mutex::new(None);
    /// Avoid autofill submit loops on the same document.
    static AUTOFILL_DONE: AtomicBool = AtomicBool::new(false);
    /// One TUM-entry click per visit to the Moodle gate (reset on a fresh load).
    static TUM_CLICKED: AtomicBool = AtomicBool::new(false);
    /// Latest file drag. A newer drag cancels the one still waiting for mouse-up.
    static FILE_DRAG: AtomicU64 = AtomicU64::new(0);
    /// One automatic TOTP attempt per sign-in; a rejected code falls back to typing it.
    static TOTP_TRIED: AtomicBool = AtomicBool::new(false);
    /// True while the user registers Paperlike's TOTP key in TUMonline.
    static TOTP_SETUP: AtomicBool = AtomicBool::new(false);
    /// TUMonline page listing the account's two-factor tokens ("Register TOTP").
    const TOTP_SETUP_URL: &str = "https://campus.tum.de/tumonline/co_loc_wbpi.list";
    /// QR decoder plus the key finder; injected on TUMonline only during setup.
    const TOTP_SETUP_JS: &str = concat!(
        "(function(){var define,exports,module;\n",
        include_str!("vendor/jsqr.min.js"),
        "\n;window.__paperlikeJsQR=window.jsQR;}).call(window);\n",
        include_str!("vendor/totp_setup.js")
    );

    pub fn totp_setup(app: &AppHandle, on: bool) -> Result<(), String> {
        TOTP_SETUP.store(on, Ordering::Release);
        TOTP_TRIED.store(false, Ordering::Release);
        if on {
            nav(app, TOTP_SETUP_URL.into())
        } else {
            Ok(())
        }
    }

    /// Stores the key, tells the pane, and types the first code into TUMonline's
    /// confirmation field (the user still presses TUMonline's own button).
    pub fn totp_found(app: &AppHandle, secret: &str) -> Result<(), String> {
        let paths = crate::state::AppPaths::resolve();
        crate::secret_store::save_moodle_totp(&paths, secret)?;
        TOTP_TRIED.store(false, Ordering::Release);
        emit_msg(app, json!({"type": "totp-found"}));
        totp_fill_confirm(app)
    }

    pub fn totp_fill_confirm(app: &AppHandle) -> Result<(), String> {
        let paths = crate::state::AppPaths::resolve();
        let Some(secret) = crate::secret_store::load_moodle_totp(&paths)? else {
            return Err("No two-factor key is saved.".into());
        };
        let (code, _) = crate::totp::code_now(&secret)?;
        eval_js(
            app,
            format!("window.__paperlikeTotpConfirm && window.__paperlikeTotpConfirm(\"{code}\");"),
        )
    }

    /// Fills and submits the IdP code page, avoiding a code that expires mid-flight.
    fn auto_totp(app: &AppHandle, secret: String) {
        let app = app.clone();
        std::thread::spawn(move || {
            let Ok((_, left)) = crate::totp::code_now(&secret) else { return };
            if left < 4 {
                std::thread::sleep(std::time::Duration::from_secs(left + 1));
            }
            let Ok((code, _)) = crate::totp::code_now(&secret) else { return };
            let _ = eval_js(
                &app,
                format!("window.__paperlikeFillOtp && window.__paperlikeFillOtp(\"{code}\");"),
            );
        });
    }

    struct PdfBuild {
        name: String,
        next: u32,
        b64: String,
        failed: Option<String>,
        /// Put the file straight into the open note, instead of only offering it.
        insert: bool,
        token: u64,
    }

    pub fn show(app: AppHandle, state: &AppState, url: String, bounds: Bounds) -> Result<bool, String> {
        use tauri::webview::PageLoadEvent;
        use tauri::{LogicalPosition, LogicalSize};
        let url = start_url(&url);
        if let Some(view) = app.get_webview(LABEL) {
            place(&view, &bounds)?;
            view.show().map_err(err)?;
            hook_view(&view, &app)?;
            return Ok(false);
        }
        let profile = state.paths.root.join("browser").join("moodle");
        std::fs::create_dir_all(&profile).map_err(err)?;
        let parsed = url::Url::parse(&url).map_err(err)?;
        let app_nav = app.clone();
        let app_new = app.clone();
        let app_load = app.clone();
        let builder = tauri::webview::WebviewBuilder::new(LABEL, tauri::WebviewUrl::External(parsed))
            .data_directory(profile)
            // The Custom view keeps this page hidden while it reads courses; hidden pages must not be throttled.
            .additional_browser_args(
                "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows",
            )
            .user_agent(UA)
            .enable_clipboard_access()
            .disable_drag_drop_handler()
            .initialization_script(INIT_JS)
            .on_navigation(move |url| on_nav(&app_nav, url))
            .on_new_window(move |url, _features| on_new_window(&app_new, url))
            .on_page_load(move |view, payload| {
                let phase = match payload.event() {
                    PageLoadEvent::Started => "started",
                    PageLoadEvent::Finished => "finished",
                };
                let url = payload.url().as_str().to_string();
                emit_page(&app_load, phase, &url);
                if phase == "started" {
                    if let Ok(parsed) = url::Url::parse(&url) {
                        if is_idp(&parsed) {
                            AUTOFILL_DONE.store(false, Ordering::Release);
                        }
                        if is_moodle_gate(&parsed) {
                            TUM_CLICKED.store(false, Ordering::Release);
                        }
                    }
                } else if phase == "finished" {
                    on_page_finished(&app_load, &view, &url);
                }
            });
        let window = app.get_window("main").ok_or("main window is missing")?;
        let view = window
            .add_child(
                builder,
                LogicalPosition::new(bounds.x, bounds.y),
                LogicalSize::new(bounds.w.max(200.0), bounds.h.max(120.0)),
            )
            .map_err(err)?;
        hook_view(&view, &app)?;
        Ok(true)
    }

    pub fn warm(app: AppHandle, state: &AppState) -> Result<(), String> {
        if !crate::secret_store::moodle_login_exists(&state.paths)
            || app.get_webview(LABEL).is_some()
        {
            return Ok(());
        }
        let created = show(
            app.clone(),
            state,
            start_url(DEFAULT_URL),
            Bounds {
                x: -8000.0,
                y: -8000.0,
                w: 8.0,
                h: 8.0,
            },
        )?;
        if created {
            hide(&app)?;
        }
        Ok(())
    }

    pub fn bounds(app: &AppHandle, bounds: Bounds) -> Result<(), String> {
        let Some(view) = app.get_webview(LABEL) else { return Ok(()) };
        place(&view, &bounds)?;
        view.show().map_err(err)
    }

    pub fn hide(app: &AppHandle) -> Result<(), String> {
        use tauri::{LogicalPosition, LogicalSize};
        if let Some(view) = app.get_webview(LABEL) {
            // Park off-screen before hide so a flaky hide cannot leave an invisible
            // hit-target over the notebook editor. Keep the webview alive — closing
            // it and recreating the same label races and leaves "Opening Moodle…".
            let _ = view.set_position(LogicalPosition::new(-8000.0, -8000.0));
            let _ = view.set_size(LogicalSize::new(1.0, 1.0));
            let _ = view.hide();
        }
        Ok(())
    }

    pub fn nav(app: &AppHandle, url: String) -> Result<(), String> {
        let parsed = url::Url::parse(&url).map_err(err)?;
        if !host_ok(&parsed) {
            return open_external(parsed.as_str());
        }
        let Some(view) = app.get_webview(LABEL) else { return Ok(()) };
        view.navigate(parsed).map_err(err)
    }

    pub fn back(app: &AppHandle) -> Result<(), String> {
        let Some(view) = app.get_webview(LABEL) else { return Ok(()) };
        view.eval("history.back()").map_err(err)
    }

    pub fn reload(app: &AppHandle) -> Result<(), String> {
        let Some(view) = app.get_webview(LABEL) else { return Ok(()) };
        view.reload().map_err(err)
    }

    pub fn eval_js(app: &AppHandle, script: String) -> Result<(), String> {
        if script.len() > 500_000 {
            return Err("Script is too large.".into());
        }
        let Some(view) = app.get_webview(LABEL) else { return Ok(()) };
        view.eval(script).map_err(err)
    }

    pub fn set_target(folder: String) -> Result<(), String> {
        let path = PathBuf::from(&folder);
        if !path.is_absolute() {
            return Err("The Material folder must be a full path.".into());
        }
        std::fs::create_dir_all(&path).map_err(err)?;
        if !path.is_dir() {
            return Err("Material is not a folder.".into());
        }
        *lock_target() = Some(path);
        Ok(())
    }

    pub fn suggest(path: String) -> Result<bool, String> {
        let p = PathBuf::from(path);
        let lectures = p.components().any(|c| c.as_os_str().to_string_lossy().eq_ignore_ascii_case("Lectures"));
        let inside = p.join("Material").is_dir();
        let sibling = p.parent().is_some_and(|d| d.join("Material").is_dir());
        Ok(lectures || inside || sibling)
    }

    pub fn read_pdf(path: String) -> Result<String, String> {
        let dir = lock_target().clone().ok_or("Material folder is not set.")?;
        let file = PathBuf::from(&path).canonicalize().map_err(err)?;
        let root = dir.canonicalize().map_err(err)?;
        if !file.starts_with(&root) || !file.is_file() {
            return Err("That file is outside Material.".into());
        }
        let ext = file
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let image = matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp");
        if ext != "pdf" && !image {
            return Err("That file can't be added to a note.".into());
        }
        let bytes = std::fs::read(&file).map_err(err)?;
        if bytes.len() > MAX_PDF {
            return Err("That file is too large.".into());
        }
        if ext == "pdf" && !looks_like_pdf(&bytes) {
            return Err("That file is not a PDF.".into());
        }
        if image && sniff_ext(&bytes).is_none() {
            return Err("That file is not an image.".into());
        }
        Ok(B64.encode(bytes))
    }

    fn place(view: &tauri::Webview, bounds: &Bounds) -> Result<(), String> {
        use tauri::{LogicalPosition, LogicalSize};
        view.set_position(LogicalPosition::new(bounds.x, bounds.y)).map_err(err)?;
        view.set_size(LogicalSize::new(bounds.w.max(200.0), bounds.h.max(120.0))).map_err(err)?;
        Ok(())
    }

    fn start_url(url: &str) -> String {
        let Ok(parsed) = url::Url::parse(url) else { return DEFAULT_URL.into() };
        if host_ok(&parsed) { parsed.to_string() } else { DEFAULT_URL.into() }
    }

    fn hook_view(view: &tauri::Webview, app: &AppHandle) -> Result<(), String> {
        if HOOKED.load(Ordering::Acquire) {
            return Ok(());
        }
        // Do not block the command thread waiting for with_webview — that deadlocks
        // on Windows when the callback needs the same UI thread.
        let app = app.clone();
        view.with_webview(move |pw| {
            if unsafe { install(&pw, app) }.is_ok() {
                HOOKED.store(true, Ordering::Release);
            }
        })
        .map_err(err)?;
        Ok(())
    }

    unsafe fn install(pw: &tauri::webview::PlatformWebview, app: AppHandle) -> Result<(), String> {
        use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_4;
        use webview2_com::{DownloadStartingEventHandler, WebMessageReceivedEventHandler, take_pwstr};
        use windows::core::{Interface, PWSTR};

        let core = pw.controller().CoreWebView2().map_err(err)?;
        if let Ok(settings) = core.Settings() {
            let _ = settings.SetIsWebMessageEnabled(true);
        }
        let app_msg = app.clone();
        let mut msg_token = 0i64;
        core.add_WebMessageReceived(
            &WebMessageReceivedEventHandler::create(Box::new(move |_wv, args| {
                unsafe {
                    let Some(args) = args else { return Ok(()) };
                    let mut pwstr = PWSTR::null();
                    if args.TryGetWebMessageAsString(&mut pwstr).is_ok() && !pwstr.is_null() {
                        let text = take_pwstr(pwstr);
                        if let Some(json) = text.strip_prefix("PL1") {
                            enqueue(&app_msg, json.to_string());
                        }
                    }
                }
                Ok(())
            })),
            &mut msg_token,
        )
        .map_err(err)?;

        let core4: ICoreWebView2_4 = core.cast().map_err(err)?;
        let app_dl = app.clone();
        let mut dl_token = 0i64;
        core4
            .add_DownloadStarting(
                &DownloadStartingEventHandler::create(Box::new(move |_wv, args| {
                    if let Some(args) = args {
                        let _ = unsafe { on_download(&app_dl, &args) };
                    }
                    Ok(())
                })),
                &mut dl_token,
            )
            .map_err(err)?;
        Ok(())
    }

    unsafe fn on_download(
        app: &AppHandle,
        args: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2DownloadStartingEventArgs,
    ) -> Result<(), String> {
        use webview2_com::Microsoft::Web::WebView2::Win32::{
            COREWEBVIEW2_DOWNLOAD_STATE_COMPLETED, COREWEBVIEW2_DOWNLOAD_STATE_IN_PROGRESS,
        };
        use webview2_com::{take_pwstr, StateChangedEventHandler};
        use windows::core::{HSTRING, PWSTR};

        let op = args.DownloadOperation().map_err(err)?;
        let mut mime_pw = PWSTR::null();
        let mime = if op.MimeType(&mut mime_pw).is_ok() && !mime_pw.is_null() {
            take_pwstr(mime_pw).to_ascii_lowercase()
        } else {
            String::new()
        };
        let mut path_pw = PWSTR::null();
        let suggested = if args.ResultFilePath(&mut path_pw).is_ok() && !path_pw.is_null() {
            take_pwstr(path_pw)
        } else {
            String::new()
        };
        let suggested_name = Path::new(&suggested)
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let is_pdf = mime.contains("pdf") || suggested_name.to_ascii_lowercase().ends_with(".pdf");
        if !is_pdf {
            return Ok(());
        }
        let Some(dir) = lock_target().clone() else {
            let _ = args.SetCancel(true);
            emit_download(app, "", "PDF", "error", "Material folder is not set.");
            return Ok(());
        };
        if std::fs::create_dir_all(&dir).is_err() {
            let _ = args.SetCancel(true);
            emit_download(app, "", "PDF", "error", "Could not create Material.");
            return Ok(());
        }
        let raw_name = if suggested_name.is_empty() { "download.pdf".to_string() } else { suggested_name };
        let dest = unique_pdf(&dir, &raw_name);
        let stem = sanitized_pdf_stem(&raw_name);
        let name = dest.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "download.pdf".into());
        let hs = HSTRING::from(plain_path(&dest));
        if args.SetResultFilePath(&hs).is_err() {
            let _ = args.SetCancel(true);
            emit_download(app, "", &name, "error", "Could not choose a file name.");
            return Ok(());
        }
        let _ = args.SetHandled(true);
        let app2 = app.clone();
        let dest2 = dest.clone();
        let name2 = name.clone();
        let stem2 = stem;
        let mut token = 0i64;
        op.add_StateChanged(
            &StateChangedEventHandler::create(Box::new(move |download, _| {
                let Some(download) = download else { return Ok(()) };
                let mut state = COREWEBVIEW2_DOWNLOAD_STATE_IN_PROGRESS;
                let read = unsafe { download.State(&mut state) };
                if read.is_err() || state == COREWEBVIEW2_DOWNLOAD_STATE_IN_PROGRESS {
                    return Ok(());
                }
                if state != COREWEBVIEW2_DOWNLOAD_STATE_COMPLETED {
                    let _ = std::fs::remove_file(&dest2);
                    emit_download(&app2, "", &name2, "error", "The download did not finish.");
                    return Ok(());
                }
                match pdf_header_ok(&dest2) {
                    Some(true) => {
                        let kept = adopt_downloaded_pdf(&dest2, &stem2);
                        let kept_name = kept
                            .file_name()
                            .map(|s| s.to_string_lossy().into_owned())
                            .unwrap_or_else(|| name2.clone());
                        emit_download(&app2, &plain_path(&kept), &kept_name, "completed", "");
                    }
                    None => emit_download(&app2, &plain_path(&dest2), &name2, "completed", ""),
                    Some(false) => {
                        let _ = std::fs::remove_file(&dest2);
                        emit_download(&app2, "", &name2, "error", "The download was not a PDF.");
                    }
                }
                Ok(())
            })),
            &mut token,
        )
        .map_err(err)?;
        Ok(())
    }

    fn enqueue(app: &AppHandle, json: String) {
        let tx = WORKER.get_or_init(|| {
            let app = app.clone();
            let (tx, rx) = mpsc::channel::<String>();
            std::thread::spawn(move || {
                let mut pdf: Option<PdfBuild> = None;
                while let Ok(msg) = rx.recv() {
                    let ack = process(&app, &mut pdf, &msg);
                    if let Some(ack) = ack {
                        if let Some(view) = app.get_webview(LABEL) {
                            let _ = view.eval(format!("window.__paperlikeAck={ack};"));
                        }
                    }
                }
            });
            tx
        });
        let _ = tx.send(json);
    }

    fn process(app: &AppHandle, pdf: &mut Option<PdfBuild>, raw: &str) -> Option<u64> {
        if raw.len() > MAX_MSG {
            return None;
        }
        let v: Value = serde_json::from_str(raw).ok()?;
        if v.get("paperlike").and_then(|p| p.as_str()) != Some("moodle") {
            return None;
        }
        let ack = v.get("ack").and_then(|a| a.as_u64());
        match v.get("type").and_then(|t| t.as_str()).unwrap_or("") {
            "login-required" => emit_msg(app, json!({"type": "login-required"})),
            "login-mfa" => {
                let active = v.get("active").and_then(|a| a.as_bool()).unwrap_or(false);
                let paths = crate::state::AppPaths::resolve();
                let saved = if active && !TOTP_SETUP.load(Ordering::Acquire) {
                    crate::secret_store::load_moodle_totp(&paths).ok().flatten()
                } else {
                    None
                };
                match saved {
                    Some(secret) if !TOTP_TRIED.swap(true, Ordering::AcqRel) => {
                        auto_totp(app, secret);
                        emit_msg(app, json!({"type": "login-auto"}));
                    }
                    Some(_) => emit_msg(app, json!({"type": "login-mfa", "active": true, "autoFailed": true})),
                    None => emit_msg(app, json!({"type": "login-mfa", "active": active})),
                }
            }
            "totp-secret" if TOTP_SETUP.load(Ordering::Acquire) => {
                let raw = clip(v.get("secret").and_then(|s| s.as_str()).unwrap_or(""), 1000);
                let found = crate::totp::parse_secret(&raw).and_then(|secret| totp_found(app, &secret));
                if let Err(message) = found {
                    emit_msg(app, json!({"type": "totp-error", "message": message}));
                }
            }
            "login-credentials" => {
                let user = clip(v.get("user").and_then(|s| s.as_str()).unwrap_or(""), 200);
                let pass = v.get("pass").and_then(|s| s.as_str()).unwrap_or("").to_string();
                if !user.is_empty() && !pass.is_empty() && pass.len() <= 500 {
                    *PENDING_LOGIN.lock().unwrap_or_else(|p| p.into_inner()) =
                        Some(crate::secret_store::MoodleLogin { user, pass });
                }
            }
            "courses" => emit_msg(app, clean_courses(&v)),
            "custom-tab" => {
                let tab = if v.get("tab").and_then(|t| t.as_str()) == Some("exercises") { "exercises" } else { "lectures" };
                emit_msg(app, json!({"type": "custom-tab", "tab": tab}));
            }
            "week" => emit_msg(app, clean_week(&v)),
            "content" => emit_msg(app, clean_content(&v)),
            "content-error" => {
                let course_id = v.get("courseId").and_then(|n| n.as_i64()).unwrap_or(0);
                let message = clip(v.get("message").and_then(|m| m.as_str()).unwrap_or(""), 300);
                emit_msg(app, json!({"type": "content-error", "courseId": course_id, "message": message}));
            }
            "pdf-ghost" => {
                let pages = v.get("pages").and_then(|n| n.as_u64()).unwrap_or(1).clamp(1, 400);
                let raw = v.get("aspect").and_then(|n| n.as_f64()).unwrap_or(1.294);
                let aspect = if raw.is_finite() && raw > 0.15 && raw < 8.0 { raw } else { 1.294 };
                let token = v.get("token").and_then(|n| n.as_u64()).unwrap_or(0);
                emit_msg(app, json!({"type": "pdf-ghost", "pages": pages, "aspect": aspect, "token": token}));
            }
            "pdf-begin" => *pdf = Some(PdfBuild::begin(&v)),
            "pdf-chunk" => {
                if let Some(build) = pdf.as_mut() {
                    build.push(&v);
                }
            }
            "pdf-end" => finish_pdf(app, pdf, v.get("count").and_then(|n| n.as_u64())),
            "pdf-error" => {
                *pdf = None;
                let message = clip(v.get("message").and_then(|m| m.as_str()).unwrap_or("Could not save the PDF"), 300);
                let token = v.get("token").and_then(|n| n.as_u64()).unwrap_or(0);
                emit_download_to(app, "", "", "error", &message, false, token);
            }
            "file-drag-begin" => {
                let url = clip(v.get("url").and_then(|s| s.as_str()).unwrap_or(""), 2000);
                let name = clip(v.get("name").and_then(|s| s.as_str()).unwrap_or(""), 180);
                let cx = v.get("cx").and_then(|n| n.as_f64());
                let cy = v.get("cy").and_then(|n| n.as_f64());
                // Native HTML5 drag dies at the Moodle webview edge (red "no drop").
                // A topmost window follows the real cursor, including over the Moodle page.
                if url.starts_with("https://") {
                    let id = FILE_DRAG.fetch_add(1, Ordering::AcqRel) + 1;
                    let app = app.clone();
                    if let Some((x, y, px, py)) = cursor_point(&app) {
                        emit_msg(
                            &app,
                            json!({"type": "file-drag-begin", "url": url, "name": name, "x": x, "y": y, "px": px, "py": py, "cx": cx, "cy": cy}),
                        );
                    } else {
                        emit_msg(&app, json!({"type": "file-drag-begin", "url": url, "name": name, "cx": cx, "cy": cy}));
                    }
                    let scale = ui_scale(&app);
                    std::thread::spawn(move || {
                        let chip = DragChip::open(&name, scale);
                        let start = std::time::Instant::now();
                        let mut last_emit = std::time::Instant::now() - std::time::Duration::from_secs(1);
                        let mut painted = false;
                        while left_button_down()
                            && start.elapsed() < std::time::Duration::from_secs(30)
                            && FILE_DRAG.load(Ordering::Acquire) == id
                        {
                            if let Some((px, py)) = cursor_screen() {
                                if let Some(chip) = chip.as_ref() {
                                    chip.place(px, py, !painted);
                                    if !painted {
                                        chip.pump();
                                        painted = true;
                                    }
                                }
                                // The chip follows the cursor itself. The note only needs
                                // a slow tick to light the drop target.
                                if last_emit.elapsed() >= std::time::Duration::from_millis(48) {
                                    last_emit = std::time::Instant::now();
                                    let s = scale.max(0.01);
                                    emit_msg(
                                        &app,
                                        json!({
                                            "type": "file-drag-move",
                                            "url": url,
                                            "name": name,
                                            "x": px / s,
                                            "y": py / s,
                                            "px": px,
                                            "py": py,
                                        }),
                                    );
                                }
                            }
                            std::thread::sleep(std::time::Duration::from_millis(8));
                        }
                        drop(chip);
                        if FILE_DRAG.load(Ordering::Acquire) != id {
                            return;
                        }
                        let Some((x, y, px, py)) = cursor_point(&app) else { return };
                        emit_msg(
                            &app,
                            json!({"type": "file-drag-end", "url": url, "name": name, "x": x, "y": y, "px": px, "py": py}),
                        );
                    });
                }
            }
            _ => {}
        }
        ack
    }

    fn on_page_finished(app: &AppHandle, view: &tauri::Webview, url: &str) {
        let Ok(parsed) = url::Url::parse(url) else { return };
        if !host_ok(&parsed) {
            return;
        }
        let _ = view.eval(LOGIN_HOOK_JS);
        if TOTP_SETUP.load(Ordering::Acquire)
            && parsed.host_str().map(|h| h.eq_ignore_ascii_case("campus.tum.de")) == Some(true)
        {
            let _ = view.eval(TOTP_SETUP_JS);
        }
        if is_idp(&parsed) {
            try_autofill(app, view);
            return;
        }
        if is_moodle_logged_in(&parsed) {
            AUTOFILL_DONE.store(false, Ordering::Release);
            TUM_CLICKED.store(false, Ordering::Release);
            TOTP_TRIED.store(false, Ordering::Release);
            maybe_offer_save(app);
            return;
        }
        if is_moodle_gate(&parsed) {
            try_click_tum(app, view);
        }
    }

    fn is_moodle_host(url: &url::Url) -> bool {
        let host = url.host_str().unwrap_or("").to_ascii_lowercase();
        host == "moodle.tum.de" || host.ends_with(".moodle.tum.de")
    }

    /// Moodle front door (not a course, not the Shibboleth hop).
    fn is_moodle_gate(url: &url::Url) -> bool {
        if !is_moodle_host(url) || is_moodle_logged_in(url) {
            return false;
        }
        let path = url.path().to_ascii_lowercase();
        !path.contains("/auth/") && !path.contains("shibboleth") && !path.contains("/saml")
    }

    fn is_idp(url: &url::Url) -> bool {
        let host = url.host_str().unwrap_or("").to_ascii_lowercase();
        // Moodle's own /Shibboleth.sso/Login hop is not the password form.
        if host.contains("moodle") {
            return false;
        }
        if host == "login.tum.de"
            || host.ends_with(".login.tum.de")
            || host == "aai.dfn.de"
            || host.ends_with(".aai.dfn.de")
        {
            return true;
        }
        let path = url.path().to_ascii_lowercase();
        (host == "tum.de" || host.ends_with(".tum.de"))
            && (path.contains("/idp")
                || path.contains("/login")
                || path.contains("/saml")
                || path.contains("/shibboleth"))
    }

    fn is_moodle_logged_in(url: &url::Url) -> bool {
        if !is_moodle_host(url) {
            return false;
        }
        let path = url.path().to_ascii_lowercase();
        // Home, Grades, Participants, and "Manage hidden courses" are ordinary
        // Moodle pages. Only the login and SSO hops should start a new TUM login.
        !(path.contains("/login")
            || path.contains("/auth/")
            || path.contains("shibboleth")
            || path.contains("/saml"))
    }

    fn maybe_offer_save(app: &AppHandle) {
        let paths = crate::state::AppPaths::resolve();
        if crate::secret_store::moodle_login_exists(&paths)
            || crate::secret_store::moodle_login_declined(&paths)
        {
            return;
        }
        let pending = PENDING_LOGIN.lock().unwrap_or_else(|p| p.into_inner());
        if pending.is_some() {
            emit_msg(app, json!({"type": "login-save-offer"}));
        }
    }

    fn try_click_tum(app: &AppHandle, view: &tauri::Webview) {
        if TUM_CLICKED.swap(true, Ordering::AcqRel) {
            return;
        }
        let paths = crate::state::AppPaths::resolve();
        if !crate::secret_store::moodle_login_exists(&paths) {
            TUM_CLICKED.store(false, Ordering::Release);
            return;
        }
        // Skip the Moodle "TUM Login" button and open the Shibboleth entry directly.
        let Ok(dest) = url::Url::parse(
            "https://www.moodle.tum.de/Shibboleth.sso/Login?providerId=https%3A%2F%2Ftumidp.lrz.de%2Fidp%2Fshibboleth&target=https%3A%2F%2Fwww.moodle.tum.de%2Fauth%2Fshibboleth%2Findex.php",
        ) else {
            TUM_CLICKED.store(false, Ordering::Release);
            return;
        };
        let _ = view.navigate(dest);
        emit_msg(app, json!({"type": "login-auto"}));
    }

    fn try_autofill(app: &AppHandle, view: &tauri::Webview) {
        if AUTOFILL_DONE.swap(true, Ordering::AcqRel) {
            return;
        }
        let paths = crate::state::AppPaths::resolve();
        let Ok(Some(login)) = crate::secret_store::load_moodle_login(&paths) else {
            AUTOFILL_DONE.store(false, Ordering::Release);
            return;
        };
        let user = json_escape(&login.user);
        let pass = json_escape(&login.pass);
        let script = format!(
            r#"(function(){{
  try {{
    if (typeof window.__paperlikeFillLogin === "function") {{
      window.__paperlikeFillLogin({user}, {pass});
    }}
  }} catch (e) {{}}
}})();"#
        );
        let _ = view.eval(script);
        emit_msg(app, json!({"type": "login-auto"}));
    }

    fn json_escape(s: &str) -> String {
        serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into())
    }

    pub fn take_pending_login() -> Option<crate::secret_store::MoodleLogin> {
        PENDING_LOGIN.lock().unwrap_or_else(|p| p.into_inner()).take()
    }

    pub fn clear_pending_login() {
        *PENDING_LOGIN.lock().unwrap_or_else(|p| p.into_inner()) = None;
    }

    /// Installs credential capture + autofill helper on IdP pages (and harmlessly elsewhere).
    const LOGIN_HOOK_JS: &str = r#"
(function () {
  if (window.__paperlikeLoginHooked) return;
  window.__paperlikeLoginHooked = true;
  function hostOk() {
    var h = (location.hostname || "").toLowerCase();
    if (h === "login.tum.de" || h.slice(-14) === ".login.tum.de") return true;
    if (h === "aai.dfn.de" || h.slice(-11) === ".aai.dfn.de") return true;
    var p = (location.pathname || "").toLowerCase();
    if ((h === "tum.de" || (h.slice(-7) === ".tum.de" && h.indexOf("moodle") < 0))
        && (p.indexOf("/idp") >= 0 || p.indexOf("/login") >= 0 || p.indexOf("/saml") >= 0 || p.indexOf("/shibboleth") >= 0))
      return true;
    return false;
  }
  function findFields(root) {
    var user = root.querySelector('input[type="email"], input[name="j_username"], input[name="username"], input[name="UserName"], input[autocomplete="username"], input[type="text"]');
    var pass = root.querySelector('input[type="password"], input[name="j_password"], input[name="password"], input[name="Password"], input[autocomplete="current-password"]');
    return { user: user, pass: pass };
  }
  function capture(form) {
    try {
      if (!hostOk() || typeof window.paperlikePost !== "function") return;
      var f = findFields(form || document);
      if (!f.user || !f.pass) return;
      var u = (f.user.value || "").trim();
      var p = f.pass.value || "";
      if (!u || !p) return;
      window.paperlikePost({ type: "login-credentials", user: u, pass: p });
    } catch (e) {}
  }
  document.addEventListener("submit", function (ev) {
    capture(ev.target);
  }, true);
  function setNative(el, value) {
    var proto = window.HTMLInputElement && window.HTMLInputElement.prototype;
    var desc = proto && Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  function clickLogin(form) {
    if (!form) return;
    var btn = form.querySelector('button[type="submit"], input[type="submit"]');
    if (!btn) {
      var nodes = form.querySelectorAll("button, input[type='button'], a");
      for (var i = 0; i < nodes.length; i++) {
        var t = ((nodes[i].innerText || nodes[i].value || nodes[i].getAttribute("aria-label") || "") + "").trim().toLowerCase();
        if (t === "login" || t === "log in" || t === "anmelden" || t.indexOf("login") === 0 || t.indexOf("anmelden") === 0) {
          btn = nodes[i];
          break;
        }
      }
    }
    if (btn) btn.click();
    else if (typeof form.requestSubmit === "function") form.requestSubmit();
    else form.submit();
  }
  function applyFill(user, pass, submit) {
    var f = findFields(document);
    if (!f.user || !f.pass) return false;
    if ((f.user.value || "") !== user) setNative(f.user, user);
    if ((f.pass.value || "") !== pass) setNative(f.pass, pass);
    if (!submit) return true;
    if ((f.user.value || "") !== user || (f.pass.value || "") !== pass) {
      setNative(f.user, user);
      setNative(f.pass, pass);
    }
    clickLogin(f.pass.form || f.user.form || document.querySelector("form"));
    return true;
  }
  window.__paperlikeFillLogin = function (user, pass) {
    try {
      if (!hostOk()) return;
      applyFill(user, pass, false);
      setTimeout(function () { applyFill(user, pass, true); }, 500);
    } catch (e) {}
  };
  // Two-factor (TOTP) step: find the code field, report it, and fill it on request.
  // The code itself is never stored; it is typed in Paperlike and passed straight through.
  function shown(el) {
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  function findOtp() {
    if (!hostOk()) return null;
    if (document.querySelector('input[type="password"]')) return null;
    var direct = document.querySelector('input[autocomplete="one-time-code"]');
    if (direct && shown(direct)) return direct;
    var all = document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"])');
    var cands = [];
    for (var i = 0; i < all.length; i++) if (shown(all[i]) && !all[i].disabled) cands.push(all[i]);
    for (var j = 0; j < cands.length; j++) {
      var key = ((cands[j].name || "") + " " + (cands[j].id || "") + " " + (cands[j].getAttribute("placeholder") || "")).toLowerCase();
      if (/otp|totp|token|code/.test(key)) return cands[j];
    }
    var text = ((document.body && document.body.innerText) || "").toLowerCase();
    if (cands.length === 1 && /totp|two-factor|2fa|zwei-faktor|authenticator|6[- ]digit|6-stellig/.test(text)) return cands[0];
    return null;
  }
  function otpSubmitter(form) {
    var nodes = form.querySelectorAll('button, input[type="submit"]');
    var fallback = null;
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var t = ((n.innerText || n.value || n.getAttribute("aria-label") || "") + " " + (n.name || "")).toLowerCase();
      if (/back|zur\u00fcck|cancel|abbrech|passkey/.test(t)) continue;
      if (/proceed|confirm|best\u00e4tig|verify|login|log in|anmeld|continue|weiter|submit|\bok\b/.test(t)) return n;
      var type = (n.getAttribute("type") || "submit").toLowerCase();
      if (!fallback && type === "submit") fallback = n;
    }
    return fallback;
  }
  window.__paperlikeFillOtp = function (code) {
    try {
      var el = findOtp();
      if (!el) return;
      setNative(el, code);
      var form = el.form || document.querySelector("form");
      if (!form) return;
      var btn = otpSubmitter(form);
      if (btn) btn.click();
      else if (typeof form.requestSubmit === "function") form.requestSubmit();
      else form.submit();
    } catch (e) {}
  };
  function reportOtp() {
    try {
      if (!hostOk() || typeof window.paperlikePost !== "function") return;
      window.paperlikePost({ type: "login-mfa", active: !!findOtp() });
    } catch (e) {}
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function () { setTimeout(reportOtp, 300); });
  else setTimeout(reportOtp, 300);
})();
"#;

    impl PdfBuild {
        fn begin(v: &Value) -> Self {
            let name = clip(v.get("name").and_then(|n| n.as_str()).unwrap_or("download.pdf"), 180);
            let insert = v.get("insert").and_then(|n| n.as_bool()).unwrap_or(false);
            let token = v.get("token").and_then(|n| n.as_u64()).unwrap_or(0);
            Self { name, next: 0, b64: String::new(), failed: None, insert, token }
        }

        fn push(&mut self, v: &Value) {
            if self.failed.is_some() {
                return;
            }
            let i = v.get("i").and_then(|n| n.as_u64()).unwrap_or(u64::MAX);
            let chunk = v.get("b64").and_then(|s| s.as_str()).unwrap_or("");
            if i != u64::from(self.next) || chunk.len() > 262_144 || self.b64.len() + chunk.len() > MAX_PDF * 2 {
                self.failed = Some("The PDF transfer was interrupted.".into());
                return;
            }
            if !chunk.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'=')) {
                self.failed = Some("The PDF transfer was interrupted.".into());
                return;
            }
            self.b64.push_str(chunk);
            self.next += 1;
        }
    }

    fn finish_pdf(app: &AppHandle, pdf: &mut Option<PdfBuild>, count: Option<u64>) {
        let Some(build) = pdf.take() else { return };
        if let Some(message) = build.failed {
            emit_download_to(app, "", &build.name, "error", &message, false, build.token);
            return;
        }
        if count.is_some_and(|n| n != u64::from(build.next)) {
            emit_download_to(app, "", &build.name, "error", "The PDF transfer was interrupted.", false, build.token);
            return;
        }
        let bytes = match B64.decode(build.b64.as_bytes()) {
            Ok(b) => b,
            Err(_) => {
                emit_download_to(app, "", &build.name, "error", "The file transfer was interrupted.", false, build.token);
                return;
            }
        };
        let Some(ext) = sniff_ext(&bytes) else {
            emit_download_to(app, "", &build.name, "error", "That file can't be added to a note.", false, build.token);
            return;
        };
        if bytes.len() > MAX_PDF {
            emit_download_to(app, "", &build.name, "error", "That file is too large.", false, build.token);
            return;
        }
        let Some(dir) = lock_target().clone() else {
            emit_download_to(app, "", &build.name, "error", "Material folder is not set.", false, build.token);
            return;
        };
        if let Err(e) = std::fs::create_dir_all(&dir) {
            emit_download_to(app, "", &build.name, "error", &e.to_string(), false, build.token);
            return;
        }
        let dest = match store_downloaded_file(&dir, &build.name, ext, &bytes) {
            Ok(path) => path,
            Err(message) => {
                emit_download_to(app, "", &build.name, "error", &message, false, build.token);
                return;
            }
        };
        let name = dest.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or(build.name);
        emit_download_to(app, &plain_path(&dest), &name, "completed", "", build.insert, build.token);
    }

    fn lock_target() -> std::sync::MutexGuard<'static, Option<PathBuf>> {
        TARGET.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn emit_page(app: &AppHandle, phase: &str, url: &str) {
        emit_msg(app, json!({"type": "page", "phase": phase, "url": url}));
    }

    fn emit_msg(app: &AppHandle, payload: Value) {
        let _ = app.emit("moodle-msg", payload);
    }

    fn emit_download(app: &AppHandle, path: &str, name: &str, state: &str, message: &str) {
        emit_download_to(app, path, name, state, message, false, 0);
    }

    fn emit_download_to(app: &AppHandle, path: &str, name: &str, state: &str, message: &str, insert: bool, token: u64) {
        let _ = app.emit(
            "moodle-download",
            json!({"path": path, "name": name, "state": state, "message": message, "insert": insert, "token": token}),
        );
    }

    fn cursor_screen() -> Option<(f64, f64)> {
        #[repr(C)]
        struct Point {
            x: i32,
            y: i32,
        }
        #[link(name = "user32")]
        extern "system" {
            fn GetCursorPos(point: *mut Point) -> i32;
        }
        let mut pt = Point { x: 0, y: 0 };
        if unsafe { GetCursorPos(&mut pt) } == 0 {
            return None;
        }
        Some((pt.x as f64, pt.y as f64))
    }

    fn left_button_down() -> bool {
        #[link(name = "user32")]
        extern "system" {
            fn GetAsyncKeyState(key: i32) -> i16;
        }
        unsafe { GetAsyncKeyState(0x01) < 0 }
    }

    /// CSS screen point (same units as `window.screenX`) and the raw physical point.
    fn cursor_point(app: &AppHandle) -> Option<(f64, f64, f64, f64)> {
        #[repr(C)]
        struct Point {
            x: i32,
            y: i32,
        }
        #[link(name = "user32")]
        extern "system" {
            fn GetCursorPos(point: *mut Point) -> i32;
        }
        let mut pt = Point { x: 0, y: 0 };
        if unsafe { GetCursorPos(&mut pt) } == 0 {
            return None;
        }
        let scale = ui_scale(app);
        let px = pt.x as f64;
        let py = pt.y as f64;
        Some((px / scale, py / scale, px, py))
    }

    fn ui_scale(app: &AppHandle) -> f64 {
        let windows = app.webview_windows();
        windows
            .get("main")
            .or_else(|| windows.values().find(|w| w.label() != LABEL))
            .and_then(|w| w.scale_factor().ok())
            .filter(|s| *s > 0.0)
            .unwrap_or(1.0)
    }

    /// PDF and the image types a note can hold.
    fn looks_like_pdf(bytes: &[u8]) -> bool {
        let n = bytes.len().min(512);
        let head: Vec<u8> = bytes[..n].iter().map(|b| b.to_ascii_lowercase()).collect();
        let html = head.windows(9).any(|w| w == b"<!doctype")
            || head.windows(5).any(|w| w == b"<html" || w == b"<head" || w == b"<body");
        if html {
            return false;
        }
        let scan = bytes.len().min(1024);
        bytes[..scan].windows(4).any(|w| w == b"%PDF")
    }

    fn sniff_ext(bytes: &[u8]) -> Option<&'static str> {
        if looks_like_pdf(bytes) {
            return Some("pdf");
        }
        if bytes.starts_with(&[0x89, 0x50, 0x4E, 0x47]) {
            return Some("png");
        }
        if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
            return Some("jpg");
        }
        if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
            return Some("gif");
        }
        if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
            return Some("webp");
        }
        None
    }

    fn on_nav(app: &AppHandle, url: &url::Url) -> bool {
        if let Some(json) = message_json(url) {
            enqueue(app, json);
            return false;
        }
        if url.host_str() == Some("paperlike.local") || blocked(url) {
            return false;
        }
        if url.scheme() == "about" {
            return true;
        }
        if url.scheme() == "http" || url.scheme() == "https" {
            if host_ok(url) {
                return true;
            }
            let _ = open_external(url.as_str());
            return false;
        }
        false
    }

    fn on_new_window(app: &AppHandle, url: url::Url) -> tauri::webview::NewWindowResponse<tauri::Wry> {
        if let Some(json) = message_json(&url) {
            enqueue(app, json);
            return tauri::webview::NewWindowResponse::Deny;
        }
        if host_ok(&url) {
            let app = app.clone();
            std::thread::spawn(move || {
                if let Some(view) = app.get_webview(LABEL) {
                    let _ = view.navigate(url);
                }
            });
            return tauri::webview::NewWindowResponse::Deny;
        }
        if !blocked(&url) {
            let _ = open_external(url.as_str());
        }
        tauri::webview::NewWindowResponse::Deny
    }

    fn message_json(url: &url::Url) -> Option<String> {
        if url.host_str() != Some("paperlike.local") || url.path() != "/moodle-msg" {
            return None;
        }
        let json = url.query_pairs().find(|(k, _)| k == "d").map(|(_, v)| v.into_owned())?;
        if json.len() > MAX_MSG { None } else { Some(json) }
    }

    fn blocked(url: &url::Url) -> bool {
        let host = url.host_str().unwrap_or("").to_ascii_lowercase();
        host == "ipc.localhost"
            || host == "tauri.localhost"
            || url.scheme() == "ipc"
            || url.scheme() == "tauri"
    }

    fn host_ok(url: &url::Url) -> bool {
        if url.scheme() != "http" && url.scheme() != "https" {
            return false;
        }
        let Some(host) = url.host_str() else { return false };
        let host = host.trim_end_matches('.').to_ascii_lowercase();
        host == "tum.de" || host.ends_with(".tum.de") || host == "aai.dfn.de" || host.ends_with(".aai.dfn.de")
    }

    pub fn open_external(url: &str) -> Result<(), String> {
        let parsed = url::Url::parse(url).map_err(err)?;
        if parsed.scheme() != "http" && parsed.scheme() != "https" {
            return Err("Only http(s) links open in the browser.".into());
        }
        if blocked(&parsed) || parsed.host_str() == Some("paperlike.local") {
            return Err("That address cannot be opened.".into());
        }
        if url.chars().any(|c| c == '"' || c == '\r' || c == '\n' || c == '\0' || c.is_control()) {
            return Err("That address cannot be opened.".into());
        }
        use std::os::windows::process::CommandExt;
        std::process::Command::new("cmd")
            .raw_arg(format!("/C start \"\" \"{url}\""))
            .creation_flags(0x0800_0000)
            .spawn()
            .map_err(err)?;
        Ok(())
    }

    fn clean_courses(v: &Value) -> Value {
        let mut out = Vec::new();
        if let Some(arr) = v.get("courses").and_then(|c| c.as_array()) {
            for c in arr.iter().take(400) {
                let Some(id) = c.get("id").and_then(|n| n.as_i64()).filter(|n| *n > 0) else { continue };
                let fullname = clip(c.get("fullname").and_then(|s| s.as_str()).unwrap_or(""), 300);
                if fullname.is_empty() {
                    continue;
                }
                let shortname = clip(c.get("shortname").and_then(|s| s.as_str()).unwrap_or(""), 80);
                let given = c.get("viewurl").and_then(|s| s.as_str()).unwrap_or("");
                let viewurl = url::Url::parse(given)
                    .ok()
                    .filter(host_ok)
                    .map(|u| u.to_string())
                    .unwrap_or_else(|| format!("https://www.moodle.tum.de/course/view.php?id={id}"));
                let current = c.get("current").and_then(|b| b.as_bool()).unwrap_or(false);
                out.push(json!({"id": id, "fullname": fullname, "shortname": shortname, "viewurl": viewurl, "current": current}));
            }
        }
        json!({"type": "courses", "courses": out})
    }

    fn safe_url(raw: Option<&str>) -> String {
        raw.and_then(|s| url::Url::parse(s).ok())
            .filter(host_ok)
            .map(|u| u.to_string())
            .unwrap_or_default()
    }

    /// Sections and activities of one course, for the Custom view.
    fn clean_content(v: &Value) -> Value {
        let course_id = v.get("courseId").and_then(|n| n.as_i64()).unwrap_or(0);
        let mut sections = Vec::new();
        if let Some(arr) = v.get("sections").and_then(|s| s.as_array()) {
            for s in arr.iter().take(150) {
                let mut items = Vec::new();
                if let Some(list) = s.get("items").and_then(|i| i.as_array()) {
                    for it in list.iter().take(200) {
                        let name = clip(it.get("name").and_then(|n| n.as_str()).unwrap_or(""), 300);
                        if name.is_empty() {
                            continue;
                        }
                        let kind: String = it
                            .get("kind")
                            .and_then(|k| k.as_str())
                            .unwrap_or("")
                            .chars()
                            .filter(|c| c.is_ascii_alphanumeric() || *c == '_')
                            .take(40)
                            .collect();
                        items.push(json!({
                            "id": it.get("id").and_then(|n| n.as_i64()).unwrap_or(0),
                            "name": name,
                            "kind": kind.to_ascii_lowercase(),
                            "url": safe_url(it.get("url").and_then(|u| u.as_str())),
                        }));
                    }
                }
                sections.push(json!({
                    "title": clip(s.get("title").and_then(|t| t.as_str()).unwrap_or(""), 240),
                    "number": s.get("number").and_then(|n| n.as_i64()).unwrap_or(sections.len() as i64),
                    "current": s.get("current").and_then(|b| b.as_bool()).unwrap_or(false),
                    "url": safe_url(s.get("url").and_then(|u| u.as_str())),
                    "items": items,
                }));
            }
        }
        json!({"type": "content", "courseId": course_id, "sections": sections})
    }

    fn clean_week(v: &Value) -> Value {
        let title = clip(v.get("title").and_then(|s| s.as_str()).unwrap_or(""), 240);
        let confidence = if v.get("confidence").and_then(|s| s.as_str()) == Some("high") { "high" } else { "low" };
        json!({"type": "week", "title": title, "confidence": confidence})
    }

    fn clip(s: &str, max: usize) -> String {
        let mut out = String::new();
        for (i, c) in s.chars().enumerate() {
            if i >= max {
                break;
            }
            if !c.is_control() {
                out.push(c);
            }
        }
        out.trim().to_string()
    }

    fn sanitize_pdf_name(raw: &str) -> String {
        let base = raw.rsplit(['/', '\\']).next().unwrap_or("download.pdf");
        let mut cleaned = String::new();
        for c in base.chars() {
            if c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*') {
                cleaned.push('_');
            } else {
                cleaned.push(c);
            }
        }
        let trimmed = cleaned.trim().trim_matches('.').trim();
        let mut name = if trimmed.is_empty() { "download.pdf".into() } else { trimmed.to_string() };
        if name.to_ascii_lowercase().ends_with(".pdf") {
            let stem: String = name.chars().take(name.chars().count().saturating_sub(4)).collect();
            name = format!("{}.pdf", stem.trim_end_matches('.'));
        } else {
            name.push_str(".pdf");
        }
        if name == ".pdf" {
            name = "download.pdf".into();
        }
        let stem = name.strip_suffix(".pdf").unwrap_or("download");
        const RESERVED: &[&str] = &[
            "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9", "lpt1",
            "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
        ];
        if RESERVED.contains(&stem.to_ascii_lowercase().as_str()) {
            name = format!("_{name}");
        }
        if name.chars().count() > 80 {
            let stem: String = name.strip_suffix(".pdf").unwrap_or("download").chars().take(70).collect();
            name = format!("{stem}.pdf");
        }
        if name == ".pdf" { "download.pdf".into() } else { name }
    }

    fn file_stem(raw: &str) -> String {
        let base = raw.rsplit(['/', '\\']).next().unwrap_or("file");
        let base = base.split(['?', '#']).next().unwrap_or(base);
        let stem = base.rsplit_once('.').map(|(s, _)| s).unwrap_or(base);
        let mut cleaned = String::new();
        for c in stem.chars() {
            if c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*' | '/' | '\\') {
                cleaned.push('_');
            } else {
                cleaned.push(c);
            }
        }
        let trimmed = cleaned.trim().trim_matches('.').trim();
        let name: String = if trimmed.is_empty() { "file".into() } else { trimmed.to_string() };
        name.chars().take(80).collect()
    }

    fn unique_download(dir: &Path, raw_name: &str, ext: &str) -> PathBuf {
        let stem = file_stem(raw_name);
        let ext = ext.trim_start_matches('.');
        let reuse_empty = ext.eq_ignore_ascii_case("pdf");
        let mut path = dir.join(format!("{stem}.{ext}"));
        let mut n = 2u32;
        while slot_occupied(&path, reuse_empty) && n < 500 {
            path = dir.join(format!("{stem} ({n}).{ext}"));
            n += 1;
        }
        path
    }

    fn unique_pdf(dir: &Path, raw_name: &str) -> PathBuf {
        let name = sanitize_pdf_name(raw_name);
        let stem = name.strip_suffix(".pdf").unwrap_or("download");
        let mut path = dir.join(&name);
        let mut n = 2u32;
        while slot_occupied(&path, true) && n < 500 {
            path = dir.join(format!("{stem} ({n}).pdf"));
            n += 1;
        }
        path
    }

    fn sanitized_pdf_stem(raw_name: &str) -> String {
        let name = sanitize_pdf_name(raw_name);
        name.strip_suffix(".pdf").unwrap_or("download").to_string()
    }

    /// A 0-byte PDF does not occupy its name. Unreadable paths stay occupied so a
    /// failed stat never overwrites a file we could not inspect.
    fn slot_occupied(path: &Path, reuse_empty_pdf: bool) -> bool {
        match std::fs::metadata(path) {
            Ok(meta) => {
                if reuse_empty_pdf && meta.is_file() && meta.len() == 0 {
                    return false;
                }
                true
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
            Err(_) => path.exists(),
        }
    }

    fn plain_path(path: &Path) -> String {
        let text = path.to_string_lossy();
        text.strip_prefix(r"\\?\").unwrap_or(&text).to_string()
    }

    /// `Some(true)` when the file starts with `%PDF`. `None` when it could not be read, so the file is kept.
    fn pdf_header_ok(path: &Path) -> Option<bool> {
        use std::io::Read;
        let mut file = std::fs::File::open(path).ok()?;
        let mut buf = [0u8; 4];
        match file.read(&mut buf) {
            Ok(4) => Some(&buf == b"%PDF"),
            Ok(_) => Some(false),
            Err(_) => None,
        }
    }

    fn sha256_bytes(bytes: &[u8]) -> String {
        let mut hasher = Sha256::new();
        hasher.update(bytes);
        crate::atomic::hex(&hasher.finalize())
    }

    fn sha256_file(path: &Path) -> Option<String> {
        use std::io::Read;
        let mut file = std::fs::File::open(path).ok()?;
        let mut hasher = Sha256::new();
        let mut buf = [0u8; 64 * 1024];
        loop {
            match file.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => hasher.update(&buf[..n]),
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => return None,
            }
        }
        Some(crate::atomic::hex(&hasher.finalize()))
    }

    fn name_key(path: &Path) -> String {
        path.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default()
    }

    /// `Some(0)` is `{stem}.pdf`. `Some(n)` is `{stem} (n).pdf`.
    fn pdf_rank(file_name: &str, stem: &str) -> Option<u32> {
        let (base, ext) = file_name.rsplit_once('.')?;
        if !ext.eq_ignore_ascii_case("pdf") || base.is_empty() {
            return None;
        }
        let base_l = base.to_lowercase();
        let stem_l = stem.to_lowercase();
        if base_l == stem_l {
            return Some(0);
        }
        let rest = base_l.strip_prefix(&format!("{stem_l} ("))?;
        let rest = rest.strip_suffix(')')?;
        if rest.is_empty() || !rest.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        let n = rest.parse::<u32>().ok()?;
        if n == 0 { None } else { Some(n) }
    }

    /// Existing non-empty PDF in `dir` whose bytes match `hash`, under any name (Moodle
    /// serves the same file under different names). Prefers `stem.pdf`, then `stem (n).pdf`
    /// by lowest n, then other names. `skip_name` is a lowercased file name.
    fn find_matching_pdf(dir: &Path, stem: &str, hash: &str, size: u64, skip_name: &str) -> Option<PathBuf> {
        let entries = std::fs::read_dir(dir).ok()?;
        let mut best: Option<((u32, String), PathBuf)> = None;
        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => continue,
            };
            let file_name = entry.file_name();
            let file_name = file_name.to_string_lossy();
            if !skip_name.is_empty() && file_name.to_lowercase() == skip_name {
                continue;
            }
            if !file_name.to_ascii_lowercase().ends_with(".pdf") {
                continue;
            }
            // Same stem first; other names rank after every numbered copy.
            let rank = (pdf_rank(&file_name, stem).unwrap_or(u32::MAX), file_name.to_lowercase());
            let path = entry.path();
            let meta = match std::fs::metadata(&path) {
                Ok(meta) => meta,
                Err(_) => continue,
            };
            if !meta.is_file() || meta.len() == 0 || meta.len() != size {
                continue;
            }
            if pdf_header_ok(&path) != Some(true) {
                continue;
            }
            let Some(file_hash) = sha256_file(&path) else { continue };
            if file_hash != hash {
                continue;
            }
            let better = best.as_ref().map(|(have, _)| rank < *have).unwrap_or(true);
            if better {
                best = Some((rank, path));
            }
        }
        best.map(|(_, path)| path)
    }

    fn remove_empty_stem_pdfs(dir: &Path, stem: &str, keep: &Path) {
        let keep_name = name_key(keep);
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => continue,
            };
            let file_name = entry.file_name();
            let file_name = file_name.to_string_lossy();
            if file_name.to_lowercase() == keep_name {
                continue;
            }
            if pdf_rank(&file_name, stem).is_none() {
                continue;
            }
            let path = entry.path();
            match std::fs::metadata(&path) {
                Ok(meta) if meta.is_file() && meta.len() == 0 => {
                    let _ = std::fs::remove_file(&path);
                }
                _ => {}
            }
        }
    }

    /// Serializes "is it already here? then write" so two saves of the same file at the
    /// same moment cannot both decide it is new.
    static MATERIAL_SAVE: Mutex<()> = Mutex::new(());

    /// Write `bytes` into `dir`, or return an existing PDF whose bytes already match.
    fn store_downloaded_file(dir: &Path, raw_name: &str, ext: &str, bytes: &[u8]) -> Result<PathBuf, String> {
        let _guard = MATERIAL_SAVE.lock().unwrap_or_else(|p| p.into_inner());
        let ext = ext.trim_start_matches('.');
        if ext.eq_ignore_ascii_case("pdf") {
            let stem = file_stem(raw_name);
            let hash = sha256_bytes(bytes);
            if let Some(existing) = find_matching_pdf(dir, &stem, &hash, bytes.len() as u64, "") {
                remove_empty_stem_pdfs(dir, &stem, &existing);
                return Ok(existing);
            }
            let dest = unique_download(dir, raw_name, "pdf");
            crate::atomic::atomic_write(&dest, bytes, false).map_err(|e| e.to_string())?;
            remove_empty_stem_pdfs(dir, &stem, &dest);
            return Ok(dest);
        }
        let dest = unique_download(dir, raw_name, ext);
        crate::atomic::atomic_write(&dest, bytes, false).map_err(|e| e.to_string())?;
        Ok(dest)
    }

    /// WebView2 has already written `dest`. If an older same-stem PDF has the same bytes,
    /// delete `dest` and return that older path.
    fn adopt_downloaded_pdf(dest: &Path, stem: &str) -> PathBuf {
        let Some(dir) = dest.parent() else {
            return dest.to_path_buf();
        };
        let meta = match std::fs::metadata(dest) {
            Ok(meta) if meta.is_file() && meta.len() > 0 => meta,
            _ => return dest.to_path_buf(),
        };
        let _guard = MATERIAL_SAVE.lock().unwrap_or_else(|p| p.into_inner());
        let Some(hash) = sha256_file(dest) else {
            return dest.to_path_buf();
        };
        let skip = name_key(dest);
        if let Some(existing) = find_matching_pdf(dir, stem, &hash, meta.len(), &skip) {
            if name_key(&existing) != skip {
                let _ = std::fs::remove_file(dest);
            }
            remove_empty_stem_pdfs(dir, stem, &existing);
            return existing;
        }
        remove_empty_stem_pdfs(dir, stem, dest);
        dest.to_path_buf()
    }

    const INIT_JS: &str = r#"
(function () {
  try {
    var inn = window.__TAURI_INTERNALS__;
    if (inn) {
      var deny = function () { return Promise.reject(new Error("unavailable")); };
      var seal = function (obj, key, value) {
        try { obj[key] = value; } catch (e1) {}
        if (obj[key] === value) return;
        try { Object.defineProperty(obj, key, { configurable: true, writable: true, value: value }); } catch (e2) {}
      };
      seal(inn, "invoke", deny);
      seal(inn, "postMessage", function () {});
      seal(inn, "convertFileSrc", function () { return ""; });
    }
  } catch (e) {}
  try {
    var wv = window.chrome && window.chrome.webview;
    if (wv && typeof wv.postMessage === "function" && !wv.__paperlikeWrapped) {
      var orig = wv.postMessage.bind(wv);
      var wrapped = function (msg) {
        if (typeof msg === "string" && msg.indexOf("PL1") === 0) orig(msg);
      };
      try { wv.postMessage = wrapped; } catch (e1) {}
      if (wv.postMessage !== wrapped) {
        try { Object.defineProperty(wv, "postMessage", { configurable: true, writable: true, value: wrapped }); } catch (e2) {}
      }
      if (wv.postMessage === wrapped) wv.__paperlikeWrapped = true;
    }
  } catch (e) {}
  var bad = function (u) {
    var s = String(u || "");
    return s.indexOf("ipc.localhost") >= 0 || s.indexOf("tauri.localhost") >= 0 || s.indexOf("ipc:") === 0 || s.indexOf("tauri:") === 0;
  };
  try {
    var origFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      var u = typeof input === "string" ? input : (input && input.url);
      if (bad(u)) return Promise.reject(new Error("blocked"));
      return origFetch(input, init);
    };
  } catch (e) {}
  try {
    var xo = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      if (bad(url)) throw new Error("blocked");
      return xo.apply(this, arguments);
    };
  } catch (e) {}
  window.paperlikePost = function (obj) {
    var run = (window.__paperlikeChain || Promise.resolve()).then(function () {
      return new Promise(function (resolve, reject) {
        var id = (window.__paperlikeSeq = (window.__paperlikeSeq || 0) + 1);
        var body = {};
        if (obj && typeof obj === "object") {
          for (var k in obj) if (Object.prototype.hasOwnProperty.call(obj, k)) body[k] = obj[k];
        }
        body.paperlike = "moodle";
        body.ack = id;
        var json = JSON.stringify(body);
        var timer = setInterval(function () {
          if ((window.__paperlikeAck || 0) >= id) { clearInterval(timer); resolve(); }
        }, 20);
        setTimeout(function () {
          clearInterval(timer);
          if ((window.__paperlikeAck || 0) >= id) resolve();
          else reject(new Error("Moodle pane did not answer"));
        }, 8000);
        try {
          if (window.chrome && window.chrome.webview && window.chrome.webview.postMessage) {
            window.chrome.webview.postMessage("PL1" + json);
            return;
          }
        } catch (e) {}
        try { location.assign("https://paperlike.local/moodle-msg?d=" + encodeURIComponent(json)); }
        catch (e2) { clearInterval(timer); reject(e2); }
      });
    });
    window.__paperlikeChain = run.catch(function () {});
    return run;
  };
})();
"#;

/// Filename chip that sits on the real cursor, above the Moodle child webview.
struct DragChip {
    hwnd: windows::Win32::Foundation::HWND,
    scale: f64,
    chars: i32,
}

impl DragChip {
    fn open(name: &str, scale: f64) -> Option<Self> {
        use std::sync::Once;
        use windows::core::{w, PCWSTR};
        use windows::Win32::Foundation::{COLORREF, HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
        use windows::Win32::Graphics::Gdi::{
            BeginPaint, CreateSolidBrush, DrawTextW, EndPaint, FillRect, GetStockObject, SelectObject, SetBkMode,
            SetTextColor, DEFAULT_GUI_FONT, DT_END_ELLIPSIS, DT_NOPREFIX, DT_SINGLELINE, DT_VCENTER, HGDIOBJ,
            PAINTSTRUCT, TRANSPARENT,
        };
        use windows::Win32::System::LibraryLoader::GetModuleHandleW;
        use windows::Win32::UI::WindowsAndMessaging::{
            CreateWindowExW, DefWindowProcW, RegisterClassW, HMENU, WM_PAINT, WNDCLASSW, WS_EX_NOACTIVATE,
            WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_POPUP,
        };

        thread_local! {
            static LABEL: std::cell::RefCell<String> = const { std::cell::RefCell::new(String::new()) };
        }
        LABEL.with(|slot| *slot.borrow_mut() = name.to_string());

        unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
            if msg == WM_PAINT {
                let mut ps = PAINTSTRUCT::default();
                let hdc = BeginPaint(hwnd, &mut ps);
                if !hdc.is_invalid() {
                    let brush = CreateSolidBrush(COLORREF(0x0022262A));
                    let _ = FillRect(hdc, &ps.rcPaint, brush);
                    let _ = windows::Win32::Graphics::Gdi::DeleteObject(HGDIOBJ(brush.0));
                    let _ = SetBkMode(hdc, TRANSPARENT);
                    let _ = SetTextColor(hdc, COLORREF(0x00E8F0F4));
                    let font = GetStockObject(DEFAULT_GUI_FONT);
                    let old = SelectObject(hdc, font);
                    let mut text: Vec<u16> = LABEL.with(|slot| slot.borrow().encode_utf16().collect());
                    if text.is_empty() {
                        text.extend("File".encode_utf16());
                    }
                    let mut rc = ps.rcPaint;
                    rc.left += 10;
                    rc.right -= 8;
                    let _ = DrawTextW(
                        hdc,
                        &mut text,
                        &mut rc,
                        DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS | DT_NOPREFIX,
                    );
                    if !old.is_invalid() {
                        SelectObject(hdc, old);
                    }
                }
                let _ = EndPaint(hwnd, &ps);
                return LRESULT(0);
            }
            DefWindowProcW(hwnd, msg, wparam, lparam)
        }

        static REGISTER: Once = Once::new();
        REGISTER.call_once(|| {
            unsafe {
                let instance = GetModuleHandleW(None).unwrap_or_default();
                let brush = CreateSolidBrush(COLORREF(0x0022262A));
                let class = WNDCLASSW {
                    style: Default::default(),
                    lpfnWndProc: Some(wndproc),
                    cbClsExtra: 0,
                    cbWndExtra: 0,
                    hInstance: HINSTANCE(instance.0),
                    hIcon: Default::default(),
                    hCursor: Default::default(),
                    hbrBackground: brush,
                    lpszMenuName: PCWSTR::null(),
                    lpszClassName: w!("PaperlikeDragChip"),
                };
                let _ = RegisterClassW(&class);
            }
        });

        let hwnd = unsafe {
            CreateWindowExW(
                WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
                w!("PaperlikeDragChip"),
                w!(""),
                WS_POPUP,
                0,
                0,
                160,
                32,
                None,
                None::<HMENU>,
                None::<HINSTANCE>,
                None,
            )
            .ok()?
        };
        let chars = name.chars().count().clamp(8, 42) as i32;
        Some(Self { hwnd, scale, chars })
    }

    fn place(&self, px: f64, py: f64, first: bool) {
        use windows::Win32::Graphics::Gdi::InvalidateRect;
        use windows::Win32::UI::WindowsAndMessaging::{
            SetWindowPos, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOSIZE, SWP_NOZORDER, SWP_SHOWWINDOW,
        };
        let scale = if self.scale > 0.0 { self.scale } else { 1.0 };
        let w = ((28 + self.chars * 8) as f64 * scale) as i32;
        let h = (32.0 * scale) as i32;
        let x = px as i32 + (14.0 * scale) as i32;
        let y = py as i32 + (16.0 * scale) as i32;
        unsafe {
            if first {
                let _ = SetWindowPos(
                    self.hwnd,
                    Some(HWND_TOPMOST),
                    x,
                    y,
                    w,
                    h,
                    SWP_NOACTIVATE | SWP_SHOWWINDOW,
                );
                let _ = InvalidateRect(Some(self.hwnd), None, false);
            } else {
                // Move only. Repainting every tick is what made the chip lag.
                let _ = SetWindowPos(self.hwnd, None, x, y, 0, 0, SWP_NOACTIVATE | SWP_NOSIZE | SWP_NOZORDER);
            }
        }
    }

    fn pump(&self) {
        use windows::Win32::UI::WindowsAndMessaging::{
            DispatchMessageW, PeekMessageW, TranslateMessage, MSG, PM_REMOVE,
        };
        unsafe {
            let mut msg = MSG::default();
            while PeekMessageW(&mut msg, Some(self.hwnd), 0, 0, PM_REMOVE).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
    }
}

impl Drop for DragChip {
    fn drop(&mut self) {
        use windows::Win32::UI::WindowsAndMessaging::DestroyWindow;
        unsafe {
            let _ = DestroyWindow(self.hwnd);
        }
        self.pump();
    }
}

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn signed_in_pages_do_not_restart_login() {
            let grades = url::Url::parse("https://www.moodle.tum.de/grade/report/index.php?id=122720").unwrap();
            let home = url::Url::parse("https://www.moodle.tum.de/?redirect=0").unwrap();
            let participants = url::Url::parse("https://www.moodle.tum.de/user/index.php?id=5").unwrap();
            let hidden = url::Url::parse("https://www.moodle.tum.de/my/index.php?coc-manage=1").unwrap();
            let login = url::Url::parse("https://www.moodle.tum.de/login/index.php").unwrap();
            assert!(is_moodle_logged_in(&grades) && !is_moodle_gate(&grades));
            assert!(is_moodle_logged_in(&home) && !is_moodle_gate(&home));
            assert!(is_moodle_logged_in(&participants) && !is_moodle_gate(&participants));
            assert!(is_moodle_logged_in(&hidden) && !is_moodle_gate(&hidden));
            assert!(!is_moodle_logged_in(&login) && is_moodle_gate(&login));
        }

        #[test]
        fn note_files_keep_their_type() {
            assert_eq!(sniff_ext(b"%PDF-1.7"), Some("pdf"));
            assert_eq!(sniff_ext(&[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A]), Some("png"));
            assert_eq!(sniff_ext(&[0xFF, 0xD8, 0xFF, 0xE0]), Some("jpg"));
            assert_eq!(sniff_ext(b"not a file"), None);
            assert_eq!(file_stem("Lecture 1a.pdf"), "Lecture 1a");
            assert_eq!(file_stem("photo.jpeg?forcedownload=1"), "photo");
        }

        #[test]
        fn hosts() {
            assert!(host_ok(&url::Url::parse("https://www.moodle.tum.de/my/courses.php").unwrap()));
            assert!(host_ok(&url::Url::parse("https://login.tum.de/idp").unwrap()));
            assert!(host_ok(&url::Url::parse("https://tum.de/").unwrap()));
            assert!(host_ok(&url::Url::parse("https://idp.aai.dfn.de/auth").unwrap()));
            assert!(host_ok(&url::Url::parse("https://aai.dfn.de/").unwrap()));
            assert!(!host_ok(&url::Url::parse("https://tum.de.evil.com/").unwrap()));
            assert!(!host_ok(&url::Url::parse("https://nottum.de/").unwrap()));
            assert!(!host_ok(&url::Url::parse("https://example.com/").unwrap()));
            assert!(!host_ok(&url::Url::parse("https://ipc.localhost/").unwrap()));
        }

        #[test]
        fn pdf_names() {
            assert_eq!(sanitize_pdf_name(r"folder\slides.pdf"), "slides.pdf");
            assert_eq!(sanitize_pdf_name("CON.pdf"), "_CON.pdf");
            assert_eq!(sanitize_pdf_name("notes"), "notes.pdf");
            assert_eq!(sanitize_pdf_name("a<b>:c.pdf"), "a_b__c.pdf");
            let long = format!("{}.pdf", "x".repeat(200));
            assert!(sanitize_pdf_name(&long).chars().count() <= 80);
            assert!(sanitize_pdf_name(&long).ends_with(".pdf"));
        }

        #[test]
        fn unique_appends_number() {
            let dir = std::env::temp_dir().join(format!("paperlike-moodle-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("week.pdf"), b"%PDF").unwrap();
            let next = unique_pdf(&dir, "week.pdf");
            assert_eq!(next.file_name().unwrap().to_string_lossy(), "week (2).pdf");
            let _ = std::fs::remove_dir_all(&dir);
        }

        fn scratch(label: &str) -> PathBuf {
            let dir = std::env::temp_dir().join(format!("paperlike-moodle-{label}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            dir
        }

        #[test]
        fn repeat_pdf_reuses_existing_and_drops_empty_copies() {
            let dir = scratch("reuse");
            let same = b"%PDF-1.4\nsame-lecture";
            let other = b"%PDF-1.4\nother-lecture";
            std::fs::write(dir.join("week.pdf"), other).unwrap();
            std::fs::write(dir.join("week (2).pdf"), same).unwrap();
            std::fs::write(dir.join("week (4).pdf"), b"").unwrap();
            std::fs::write(dir.join("other.pdf"), b"").unwrap();
            std::fs::write(dir.join("week notes.pdf"), b"").unwrap();
            std::fs::write(dir.join("week.txt"), b"").unwrap();

            let got = store_downloaded_file(&dir, "week.pdf", "pdf", same).unwrap();
            assert_eq!(got.file_name().unwrap().to_string_lossy(), "week (2).pdf");
            assert!(!dir.join("week (3).pdf").exists(), "same bytes must not create another copy");
            assert!(!dir.join("week (4).pdf").exists(), "empty same-stem leftover should be removed");
            assert_eq!(std::fs::read(dir.join("week.pdf")).unwrap(), other);
            assert!(dir.join("other.pdf").exists(), "a different stem is left alone");
            assert!(dir.join("week notes.pdf").exists());
            assert!(dir.join("week.txt").exists());

            let fresh = b"%PDF-1.4\nbrand-new";
            let created = store_downloaded_file(&dir, "week.pdf", "pdf", fresh).unwrap();
            assert_eq!(created.file_name().unwrap().to_string_lossy(), "week (3).pdf");
            assert_eq!(std::fs::read(&created).unwrap(), fresh);

            let html = b"<html>not a pdf</html>";
            std::fs::write(dir.join("slides.pdf"), html).unwrap();
            let slides = store_downloaded_file(&dir, "slides.pdf", "pdf", b"%PDF-1.4\nslides").unwrap();
            assert_eq!(slides.file_name().unwrap().to_string_lossy(), "slides (2).pdf");
            assert_eq!(std::fs::read(dir.join("slides.pdf")).unwrap(), html);

            let _ = std::fs::remove_dir_all(&dir);
        }

        #[test]
        fn same_bytes_under_another_name_reuse_the_existing_file() {
            let dir = scratch("renamed");
            let pdf: &[u8] = b"%PDF-1.4\nslides";
            let first = store_downloaded_file(&dir, "Lecture_Slides_EE_01.pdf", "pdf", pdf).unwrap();
            let again = store_downloaded_file(&dir, "DC Circuits Lecture 1.pdf", "pdf", pdf).unwrap();
            assert_eq!(again, first);
            assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
            let _ = std::fs::remove_dir_all(&dir);
        }

        #[test]
        fn simultaneous_saves_keep_one_copy() {
            let dir = scratch("race");
            let workers: Vec<_> = (0..8)
                .map(|_| {
                    let dir = dir.clone();
                    std::thread::spawn(move || store_downloaded_file(&dir, "Lecture 1a.pdf", "pdf", b"%PDF-1.4\nrace").unwrap())
                })
                .collect();
            let paths: Vec<PathBuf> = workers.into_iter().map(|w| w.join().unwrap()).collect();
            assert!(paths.iter().all(|p| p == &paths[0]));
            assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
            let _ = std::fs::remove_dir_all(&dir);
        }

        #[test]
        fn empty_pdf_is_not_the_real_file() {
            let dir = scratch("empty");
            std::fs::write(dir.join("week.pdf"), b"").unwrap();
            assert_eq!(unique_pdf(&dir, "week.pdf").file_name().unwrap().to_string_lossy(), "week.pdf");
            let bytes = b"%PDF-1.4\nreal";
            let got = store_downloaded_file(&dir, "week.pdf", "pdf", bytes).unwrap();
            assert_eq!(got.file_name().unwrap().to_string_lossy(), "week.pdf");
            assert_eq!(std::fs::read(&got).unwrap(), bytes);

            let again = store_downloaded_file(&dir, "week.pdf", "pdf", bytes).unwrap();
            assert_eq!(again.file_name().unwrap().to_string_lossy(), "week.pdf");
            assert!(!dir.join("week (2).pdf").exists());
            let _ = std::fs::remove_dir_all(&dir);
        }

        #[test]
        fn webview_duplicate_is_deleted_for_the_existing_path() {
            let dir = scratch("adopt");
            let same = b"%PDF-1.4\nwebview";
            std::fs::write(dir.join("Vorlesung.pdf"), same).unwrap();
            std::fs::write(dir.join("Vorlesung (3).pdf"), b"").unwrap();
            let dest = dir.join("Vorlesung (2).pdf");
            std::fs::write(&dest, same).unwrap();
            let kept = adopt_downloaded_pdf(&dest, "Vorlesung");
            assert_eq!(kept.file_name().unwrap().to_string_lossy(), "Vorlesung.pdf");
            assert!(!dest.exists(), "the new copy is deleted");
            assert!(!dir.join("Vorlesung (3).pdf").exists());

            let nested = scratch("übung");
            let pdf = "%PDF-1.7\nVorlesung-übung".as_bytes();
            std::fs::write(nested.join("Übung.pdf"), pdf).unwrap();
            let again = store_downloaded_file(&nested, "Übung.pdf", "pdf", pdf).unwrap();
            assert_eq!(again.file_name().unwrap().to_string_lossy(), "Übung.pdf");
            assert!(!nested.join("Übung (2).pdf").exists());
            let _ = std::fs::remove_dir_all(&dir);
            let _ = std::fs::remove_dir_all(&nested);
        }
    }
}

#[cfg(not(windows))]
mod win {
    use super::*;

    pub fn show(_: AppHandle, _: &AppState, _: String, _: Bounds) -> Result<bool, String> { Err(UNSUPPORTED.into()) }
    pub fn warm(_: AppHandle, _: &AppState) -> Result<(), String> { Ok(()) }
    pub fn bounds(_: &AppHandle, _: Bounds) -> Result<(), String> { Err(UNSUPPORTED.into()) }
    pub fn hide(_: &AppHandle) -> Result<(), String> { Err(UNSUPPORTED.into()) }
    pub fn nav(_: &AppHandle, _: String) -> Result<(), String> { Err(UNSUPPORTED.into()) }
    pub fn back(_: &AppHandle) -> Result<(), String> { Err(UNSUPPORTED.into()) }
    pub fn reload(_: &AppHandle) -> Result<(), String> { Err(UNSUPPORTED.into()) }
    pub fn eval_js(_: &AppHandle, _: String) -> Result<(), String> { Err(UNSUPPORTED.into()) }
    pub fn set_target(_: String) -> Result<(), String> { Err(UNSUPPORTED.into()) }
    pub fn suggest(_: String) -> Result<bool, String> { Err(UNSUPPORTED.into()) }
    pub fn read_pdf(_: String) -> Result<String, String> { Err(UNSUPPORTED.into()) }
    pub fn open_external(_: &str) -> Result<(), String> { Err(UNSUPPORTED.into()) }
    pub fn take_pending_login() -> Option<crate::secret_store::MoodleLogin> { None }
    pub fn clear_pending_login() {}
    pub fn totp_setup(_: &AppHandle, _: bool) -> Result<(), String> { Err(UNSUPPORTED.into()) }
    pub fn totp_found(_: &AppHandle, _: &str) -> Result<(), String> { Err(UNSUPPORTED.into()) }
    pub fn totp_fill_confirm(_: &AppHandle) -> Result<(), String> { Err(UNSUPPORTED.into()) }
}

#[tauri::command]
pub async fn moodle_show(
    app: AppHandle,
    state: State<'_, AppState>,
    url: String,
    bounds: Bounds,
) -> Result<bool, String> {
    // Match assistant_show: async so WebView2 create/place is not stuck on a blocking pool thread.
    win::show(app, &*state, url, bounds)
}

#[tauri::command]
pub async fn moodle_warm(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    win::warm(app, &*state)
}

#[tauri::command]
pub fn moodle_bounds(app: AppHandle, bounds: Bounds) -> Result<(), String> {
    win::bounds(&app, bounds)
}

#[tauri::command]
pub fn moodle_hide(app: AppHandle) -> Result<(), String> {
    win::hide(&app)
}

#[tauri::command]
pub fn moodle_nav(app: AppHandle, url: String) -> Result<(), String> {
    win::nav(&app, url)
}

#[tauri::command]
pub fn moodle_back(app: AppHandle) -> Result<(), String> {
    win::back(&app)
}

#[tauri::command]
pub fn moodle_reload(app: AppHandle) -> Result<(), String> {
    win::reload(&app)
}

#[tauri::command]
pub fn moodle_eval(app: AppHandle, script: String) -> Result<(), String> {
    win::eval_js(&app, script)
}

#[tauri::command]
pub fn moodle_totp_saved(state: State<'_, AppState>) -> Result<bool, String> {
    Ok(crate::secret_store::moodle_totp_exists(&state.paths))
}

/// Starts (opens TUMonline's token page) or ends automatic-code setup.
#[tauri::command]
pub fn moodle_totp_setup(app: AppHandle, on: bool) -> Result<(), String> {
    win::totp_setup(&app, on)
}

/// Saves a key the user pasted (bare base32 or an otpauth:// link).
#[tauri::command]
pub fn moodle_save_totp(app: AppHandle, secret: String) -> Result<(), String> {
    let secret = crate::totp::parse_secret(&secret)?;
    win::totp_found(&app, &secret)
}

/// Types the current code into TUMonline's confirmation field again.
#[tauri::command]
pub fn moodle_totp_fill(app: AppHandle) -> Result<(), String> {
    win::totp_fill_confirm(&app)
}

/// Current code and seconds left, for the setup banner.
#[tauri::command]
pub fn moodle_totp_code(state: State<'_, AppState>) -> Result<Value, String> {
    let Some(secret) = crate::secret_store::load_moodle_totp(&state.paths)? else {
        return Err("No two-factor key is saved.".into());
    };
    let (code, left) = crate::totp::code_now(&secret)?;
    Ok(json!({"code": code, "left": left}))
}

#[tauri::command]
pub fn moodle_clear_totp(state: State<'_, AppState>) -> Result<(), String> {
    crate::secret_store::clear_moodle_totp(&state.paths)
}

/// Types a two-factor code into the TUM sign-in page and submits it. Never stored.
#[tauri::command]
pub fn moodle_submit_otp(app: AppHandle, code: String) -> Result<(), String> {
    let code = code.trim();
    if !(6..=8).contains(&code.len()) || !code.bytes().all(|b| b.is_ascii_digit()) {
        return Err("Enter the 6-digit code from your authenticator app.".into());
    }
    win::eval_js(
        &app,
        format!("window.__paperlikeFillOtp && window.__paperlikeFillOtp(\"{code}\");"),
    )
}

#[tauri::command]
pub fn moodle_open_external(url: String) -> Result<(), String> {
    win::open_external(&url)
}

#[tauri::command]
pub fn moodle_set_target(folder: String) -> Result<(), String> {
    win::set_target(folder)
}

#[tauri::command]
pub fn moodle_suggest(path: String) -> Result<bool, String> {
    win::suggest(path)
}

#[tauri::command]
pub fn moodle_read_pdf(path: String) -> Result<String, String> {
    win::read_pdf(path)
}

#[tauri::command]
pub fn get_notebook_moodle(path: String) -> Result<Option<i64>, String> {
    crate::notebook::get_moodle_course_id(Path::new(&path)).map_err(err)
}

#[tauri::command]
pub fn set_notebook_moodle(path: String, course_id: Option<i64>) -> Result<(), String> {
    crate::notebook::set_moodle_course_id(Path::new(&path), course_id).map_err(err)
}

#[tauri::command]
pub fn moodle_login_saved(state: State<'_, AppState>) -> Result<bool, String> {
    Ok(crate::secret_store::moodle_login_exists(&state.paths))
}

#[tauri::command]
pub fn moodle_save_login(state: State<'_, AppState>) -> Result<(), String> {
    #[cfg(windows)]
    {
        let pending = win::take_pending_login();
        let Some(login) = pending else {
            return Err("No sign-in was captured yet. Sign in once, then try Save again.".into());
        };
        crate::secret_store::save_moodle_login(&state.paths, &login)
    }
    #[cfg(not(windows))]
    {
        let _ = state;
        Err("Moodle sign-in storage is only available on Windows.".into())
    }
}

#[tauri::command]
pub fn moodle_decline_login(state: State<'_, AppState>) -> Result<(), String> {
    #[cfg(windows)]
    {
        win::clear_pending_login();
    }
    crate::secret_store::set_moodle_login_declined(&state.paths, true)
}

#[tauri::command]
pub fn moodle_clear_login(state: State<'_, AppState>) -> Result<(), String> {
    #[cfg(windows)]
    {
        win::clear_pending_login();
    }
    crate::secret_store::clear_moodle_login(&state.paths)
}
