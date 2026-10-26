//! Feedback mailbox. Messages go to the Paperlike site, which mails them on.

use std::fs;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::state::AppPaths;

const SERVER: &str = "https://paperlike.duckdns.org";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct MailboxFile {
    id: String,
}

fn mailbox_path(paths: &AppPaths) -> std::path::PathBuf {
    paths.root.join("mailbox.json")
}

pub fn mailbox_id(paths: &AppPaths) -> String {
    if let Ok(s) = fs::read_to_string(mailbox_path(paths)) {
        if let Ok(m) = serde_json::from_str::<MailboxFile>(&s) {
            if !m.id.is_empty() {
                return m.id;
            }
        }
    }
    let id = Uuid::new_v4().to_string();
    let _ = paths.ensure();
    if let Ok(json) = serde_json::to_string(&MailboxFile { id: id.clone() }) {
        let _ = crate::atomic::atomic_write_string(&mailbox_path(paths), &json, false);
    }
    id
}

fn url(path: &str) -> String {
    format!("{SERVER}{path}")
}

pub fn send(paths: &AppPaths, body: &str) -> Result<serde_json::Value, String> {
    let id = mailbox_id(paths);
    let resp = ureq::post(&url("/v1/feedback"))
        .send_json(serde_json::json!({ "mailbox": id, "body": body }))
        .map_err(|e| e.to_string())?;
    resp.into_json().map_err(|e| e.to_string())
}

pub fn list(paths: &AppPaths) -> Result<serde_json::Value, String> {
    let id = mailbox_id(paths);
    let resp = ureq::get(&url(&format!("/v1/feedback?mailbox={id}")))
        .call()
        .map_err(|e| e.to_string())?;
    resp.into_json().map_err(|e| e.to_string())
}

pub fn seen(paths: &AppPaths, thread_id: &str) -> Result<(), String> {
    let id = mailbox_id(paths);
    ureq::post(&url("/v1/feedback/seen"))
        .send_json(serde_json::json!({ "mailbox": id, "thread_id": thread_id }))
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn reply(paths: &AppPaths, thread_id: &str, body: &str) -> Result<serde_json::Value, String> {
    let id = mailbox_id(paths);
    let resp = ureq::post(&url("/v1/feedback/reply"))
        .send_json(serde_json::json!({ "mailbox": id, "thread_id": thread_id, "body": body }))
        .map_err(|e| e.to_string())?;
    resp.into_json().map_err(|e| e.to_string())
}
