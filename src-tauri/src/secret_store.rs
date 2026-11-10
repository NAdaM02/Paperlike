//! Local secrets encrypted with Windows DPAPI (current user only).

use std::fs;
use std::path::{Path, PathBuf};
use std::ptr;

use serde::{Deserialize, Serialize};

use crate::state::AppPaths;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MoodleLogin {
    pub user: String,
    pub pass: String,
}

fn vault_path(paths: &AppPaths) -> PathBuf {
    paths.root.join("moodle_login.dpapi")
}

fn declined_path(paths: &AppPaths) -> PathBuf {
    paths.root.join("moodle_login.declined")
}

fn failures_path(paths: &AppPaths) -> PathBuf {
    paths.root.join("moodle_login.failures")
}

pub fn moodle_login_failures(paths: &AppPaths) -> u32 {
    let p = failures_path(paths);
    if !p.is_file() {
        return 0;
    }
    fs::read_to_string(&p)
        .ok()
        .and_then(|s| s.trim().parse::<u32>().ok())
        .unwrap_or(0)
}

pub fn increment_moodle_login_failures(paths: &AppPaths) -> u32 {
    let count = moodle_login_failures(paths).saturating_add(1);
    if paths.ensure().is_ok() {
        let _ = fs::write(failures_path(paths), count.to_string().as_bytes());
    }
    count
}

pub fn reset_moodle_login_failures(paths: &AppPaths) -> Result<(), String> {
    let p = failures_path(paths);
    if p.exists() {
        fs::remove_file(&p).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn moodle_login_exists(paths: &AppPaths) -> bool {
    vault_path(paths).is_file()
}

pub fn moodle_login_declined(paths: &AppPaths) -> bool {
    declined_path(paths).is_file()
}

pub fn set_moodle_login_declined(paths: &AppPaths, declined: bool) -> Result<(), String> {
    paths.ensure().map_err(|e| e.to_string())?;
    let p = declined_path(paths);
    if declined {
        fs::write(&p, b"1").map_err(|e| e.to_string())
    } else if p.exists() {
        fs::remove_file(&p).map_err(|e| e.to_string())
    } else {
        Ok(())
    }
}

pub fn save_moodle_login(paths: &AppPaths, login: &MoodleLogin) -> Result<(), String> {
    if login.user.trim().is_empty() || login.pass.is_empty() {
        return Err("Username and password are required.".into());
    }
    paths.ensure().map_err(|e| e.to_string())?;
    let json = serde_json::to_vec(login).map_err(|e| e.to_string())?;
    let sealed = dpapi_protect(&json)?;
    atomic_write(&vault_path(paths), &sealed)?;
    let _ = set_moodle_login_declined(paths, false);
    let _ = reset_moodle_login_failures(paths);
    Ok(())
}

pub fn update_moodle_password(paths: &AppPaths, new_pass: &str) -> Result<(), String> {
    let pass = new_pass.trim();
    if pass.is_empty() {
        return Err("Password cannot be empty.".into());
    }
    let Some(mut login) = load_moodle_login(paths)? else {
        return Err("No saved Moodle sign-in was found.".into());
    };
    login.pass = pass.to_string();
    save_moodle_login(paths, &login)
}

pub fn load_moodle_login(paths: &AppPaths) -> Result<Option<MoodleLogin>, String> {
    let p = vault_path(paths);
    if !p.is_file() {
        return Ok(None);
    }
    let sealed = fs::read(&p).map_err(|e| e.to_string())?;
    let json = dpapi_unprotect(&sealed)?;
    let login: MoodleLogin = serde_json::from_slice(&json).map_err(|e| e.to_string())?;
    if login.user.trim().is_empty() || login.pass.is_empty() {
        return Ok(None);
    }
    Ok(Some(login))
}

pub fn clear_moodle_login(paths: &AppPaths) -> Result<(), String> {
    for p in [vault_path(paths), declined_path(paths), failures_path(paths)] {
        if p.exists() {
            fs::remove_file(&p).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn totp_path(paths: &AppPaths) -> PathBuf {
    paths.root.join("moodle_totp.dpapi")
}

pub fn moodle_totp_exists(paths: &AppPaths) -> bool {
    totp_path(paths).is_file()
}

/// Stores a normalized base32 TOTP key, encrypted like the sign-in.
pub fn save_moodle_totp(paths: &AppPaths, secret: &str) -> Result<(), String> {
    paths.ensure().map_err(|e| e.to_string())?;
    let sealed = dpapi_protect(secret.as_bytes())?;
    atomic_write(&totp_path(paths), &sealed)
}

pub fn load_moodle_totp(paths: &AppPaths) -> Result<Option<String>, String> {
    let p = totp_path(paths);
    if !p.is_file() {
        return Ok(None);
    }
    let sealed = fs::read(&p).map_err(|e| e.to_string())?;
    let plain = dpapi_unprotect(&sealed)?;
    let key = String::from_utf8(plain).map_err(|e| e.to_string())?;
    Ok(if key.is_empty() { None } else { Some(key) })
}

pub fn clear_moodle_totp(paths: &AppPaths) -> Result<(), String> {
    let p = totp_path(paths);
    if p.exists() {
        fs::remove_file(&p).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("dpapi.tmp");
    fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

#[cfg(windows)]
fn dpapi_protect(plain: &[u8]) -> Result<Vec<u8>, String> {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::LocalFree;
    use windows::Win32::Security::Cryptography::{CryptProtectData, CRYPT_INTEGER_BLOB};

    unsafe {
        let mut input = CRYPT_INTEGER_BLOB {
            cbData: plain.len() as u32,
            pbData: plain.as_ptr() as *mut u8,
        };
        let mut output = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: ptr::null_mut(),
        };
        CryptProtectData(
            &mut input,
            PCWSTR::null(),
            None,
            None,
            None,
            0,
            &mut output,
        )
        .map_err(|e| e.to_string())?;
        if output.pbData.is_null() || output.cbData == 0 {
            return Err("Could not encrypt the sign-in.".into());
        }
        let slice = std::slice::from_raw_parts(output.pbData, output.cbData as usize);
        let out = slice.to_vec();
        let _ = LocalFree(Some(windows::Win32::Foundation::HLOCAL(
            output.pbData as *mut _,
        )));
        Ok(out)
    }
}

#[cfg(windows)]
fn dpapi_unprotect(sealed: &[u8]) -> Result<Vec<u8>, String> {
    use windows::Win32::Foundation::LocalFree;
    use windows::Win32::Security::Cryptography::{CryptUnprotectData, CRYPT_INTEGER_BLOB};

    unsafe {
        let mut input = CRYPT_INTEGER_BLOB {
            cbData: sealed.len() as u32,
            pbData: sealed.as_ptr() as *mut u8,
        };
        let mut output = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: ptr::null_mut(),
        };
        CryptUnprotectData(&mut input, None, None, None, None, 0, &mut output)
            .map_err(|e| e.to_string())?;
        if output.pbData.is_null() || output.cbData == 0 {
            return Err("Could not decrypt the sign-in.".into());
        }
        let slice = std::slice::from_raw_parts(output.pbData, output.cbData as usize);
        let out = slice.to_vec();
        let _ = LocalFree(Some(windows::Win32::Foundation::HLOCAL(
            output.pbData as *mut _,
        )));
        Ok(out)
    }
}

#[cfg(not(windows))]
fn dpapi_protect(_: &[u8]) -> Result<Vec<u8>, String> {
    Err("Moodle sign-in storage is only available on Windows.".into())
}

#[cfg(not(windows))]
fn dpapi_unprotect(_: &[u8]) -> Result<Vec<u8>, String> {
    Err("Moodle sign-in storage is only available on Windows.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_paths(name: &str) -> (AppPaths, PathBuf) {
        let dir = std::env::temp_dir().join(format!("paperlike-test-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::create_dir_all(&dir);
        let paths = AppPaths {
            settings: dir.join("settings.json"),
            home: dir.join("home.json"),
            ignored: dir.join("ignored.json"),
            ui_state: dir.join("ui-state.json"),
            icons: dir.join("icons"),
            recovery: dir.join("recovery"),
            backups: dir.join("backups"),
            index: dir.join("index"),
            root: dir.clone(),
        };
        (paths, dir)
    }

    #[test]
    fn failures_counter_workflow() {
        let (paths, dir) = test_paths("failures");
        assert_eq!(moodle_login_failures(&paths), 0);

        assert_eq!(increment_moodle_login_failures(&paths), 1);
        assert_eq!(moodle_login_failures(&paths), 1);

        assert_eq!(increment_moodle_login_failures(&paths), 2);
        assert_eq!(moodle_login_failures(&paths), 2);

        assert_eq!(increment_moodle_login_failures(&paths), 3);
        assert_eq!(moodle_login_failures(&paths), 3);

        assert!(reset_moodle_login_failures(&paths).is_ok());
        assert_eq!(moodle_login_failures(&paths), 0);
        assert!(!failures_path(&paths).exists());

        let _ = fs::remove_dir_all(&dir);
    }
}
