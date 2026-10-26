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
    Ok(())
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
    for p in [vault_path(paths), declined_path(paths)] {
        if p.exists() {
            fs::remove_file(&p).map_err(|e| e.to_string())?;
        }
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
