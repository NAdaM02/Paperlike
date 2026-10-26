//! Optional saved email for the chat panes.
//!
//! The Google session itself stays in the local WebView2 profile.

use serde::Serialize;

use crate::state::AppPaths;

#[derive(Clone, Serialize)]
pub struct GoogleStatus {
    pub linked: bool,
    pub pending: bool,
    pub email: String,
}

#[derive(serde::Serialize, serde::Deserialize, Default)]
struct Stored {
    #[serde(default)]
    email: String,
    #[serde(default)]
    pending: bool,
}

fn path(paths: &AppPaths) -> std::path::PathBuf {
    paths.root.join("google.json")
}

fn load(paths: &AppPaths) -> Stored {
    std::fs::read_to_string(path(paths))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save(paths: &AppPaths, stored: &Stored) -> Result<(), String> {
    paths.ensure().map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(stored).map_err(|e| e.to_string())?;
    crate::atomic::atomic_write_string(&path(paths), &json, false).map_err(|e| e.to_string())
}

pub fn status(paths: &AppPaths) -> GoogleStatus {
    let stored = load(paths);
    let email = clean_email(&stored.email).unwrap_or_default();
    GoogleStatus {
        linked: !email.is_empty(),
        pending: stored.pending && email.is_empty(),
        email,
    }
}

pub fn prepare(paths: &AppPaths) -> Result<(), String> {
    let mut stored = load(paths);
    if clean_email(&stored.email).is_none() {
        stored.email.clear();
        stored.pending = true;
        save(paths, &stored)?;
    }
    Ok(())
}

pub fn finish(paths: &AppPaths, raw_email: &str) -> Result<String, String> {
    let email = clean_email(raw_email).ok_or("That page did not show a Google email address.")?;
    register_device(&email)?;
    save(
        paths,
        &Stored {
            email: email.clone(),
            pending: false,
        },
    )?;
    Ok(email)
}

pub fn forget(paths: &AppPaths) -> Result<String, String> {
    let email = status(paths).email;
    let _ = std::fs::remove_file(path(paths));
    if email.is_empty() {
        return Ok("Removed from this PC.".into());
    }
    match unregister_device(&email) {
        Ok(()) => Ok("Removed from this PC.".into()),
        Err(err) => Ok(format!("Removed from this PC. {err}")),
    }
}

fn clean_email(raw: &str) -> Option<String> {
    let email = raw.trim().to_ascii_lowercase();
    let (name, domain) = email.split_once('@')?;
    if name.is_empty() || email.len() > 200 || email.contains(' ') {
        return None;
    }
    if !domain.contains('.') || domain.starts_with('.') || domain.ends_with('.') {
        return None;
    }
    if !email
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '@' | '.' | '_' | '+' | '-'))
    {
        return None;
    }
    Some(email)
}

fn register_device(_email: &str) -> Result<(), String> {
    Ok(())
}

fn unregister_device(_email: &str) -> Result<(), String> {
    Ok(())
}
