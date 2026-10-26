//! GIF search for the insert panel. The grid shows remote previews;
//! the chosen file is downloaded here and embedded in the note.
//!
//! Tenor's public API was discontinued (the old v1 key and the documented
//! v2 quickstart key both fail). Search uses GifSnap's keyless endpoints,
//! which return GIF files on media.gifsnap.com.

use std::io::Read;

use base64::Engine;
use serde::Serialize;

const SEARCH_LIMIT: &str = "24";

#[derive(Clone, Serialize)]
pub struct GifHit {
    pub id: String,
    pub preview: String,
    pub url: String,
    pub w: u32,
    pub h: u32,
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(12))
        .build()
}

fn https_gif(raw: &str) -> Result<String, String> {
    let url = url::Url::parse(raw).map_err(|_| "That link isn't a GIF.".to_string())?;
    if url.scheme() != "https" {
        return Err("GIF links need to start with https.".into());
    }
    let host = url.host_str().unwrap_or("").to_ascii_lowercase();
    let ok = host == "media.tenor.com"
        || host.ends_with(".tenor.com")
        || host == "media.giphy.com"
        || host.ends_with(".giphy.com")
        || host == "i.giphy.com"
        || host == "media.gifsnap.com"
        || host.ends_with(".gifsnap.com");
    if !ok {
        return Err("That link isn't from a GIF host Paperlike can save.".into());
    }
    Ok(url.to_string())
}

fn https_preview(raw: &str) -> Option<String> {
    let url = url::Url::parse(raw).ok()?;
    if url.scheme() != "https" {
        return None;
    }
    Some(url.to_string())
}

fn dim(row: &serde_json::Value, key: &str) -> u32 {
    row.get(key).and_then(|n| n.as_u64()).unwrap_or(0) as u32
}

fn brief(s: &str) -> Option<&str> {
    let s = s.trim();
    if s.is_empty() || s.len() > 80 || s.chars().any(|c| c.is_control()) {
        None
    } else {
        Some(s)
    }
}

/// GifSnap list item. `url` is the full GIF. `preview_url` is the small
/// rendition (often WebP). `animated_preview.url` is used when present.
fn hit_from_row(row: &serde_json::Value, i: usize) -> Option<GifHit> {
    let url = https_gif(row.get("url")?.as_str()?).ok()?;
    let preview = row
        .get("animated_preview")
        .and_then(|p| p.get("url"))
        .and_then(|u| u.as_str())
        .and_then(https_preview)
        .or_else(|| {
            row.get("preview_url")
                .and_then(|u| u.as_str())
                .and_then(https_preview)
        })
        .unwrap_or_else(|| url.clone());
    let id = row
        .get("id")
        .and_then(|s| s.as_str())
        .unwrap_or("")
        .to_string();
    Some(GifHit {
        id: if id.is_empty() {
            format!("gif-{i}")
        } else {
            id
        },
        preview,
        url,
        w: dim(row, "width"),
        h: dim(row, "height"),
    })
}

fn parse_search(body: &str) -> Result<Vec<GifHit>, String> {
    let v: serde_json::Value = serde_json::from_str(body)
        .map_err(|_| "GIF search returned something unreadable.".to_string())?;
    let Some(results) = v.get("data").and_then(|d| d.as_array()) else {
        if let Some(msg) = v.get("error").and_then(|e| e.as_str()).and_then(brief) {
            return Err(format!("GIF search failed ({msg})."));
        }
        return Err("GIF search returned something unexpected.".into());
    };
    let mut out = Vec::new();
    for (i, row) in results.iter().enumerate() {
        if let Some(hit) = hit_from_row(row, i) {
            out.push(hit);
        }
    }
    Ok(out)
}

fn search_url(query: &str) -> String {
    if query.is_empty() {
        format!("https://gifsnap.com/api/v1/gifs/trending?page=1&limit={SEARCH_LIMIT}")
    } else {
        format!(
            "https://gifsnap.com/api/v1/gifs/search?q={}&page=1&limit={SEARCH_LIMIT}",
            urlencoding_query(query)
        )
    }
}

fn transport_reason(t: &ureq::Transport) -> &'static str {
    match t.kind() {
        ureq::ErrorKind::Dns => "DNS failed",
        ureq::ErrorKind::ConnectionFailed => "connection failed",
        ureq::ErrorKind::TooManyRedirects => "too many redirects",
        _ => "network error",
    }
}

fn search_failure(err: ureq::Error) -> String {
    match err {
        ureq::Error::Status(code, resp) => {
            let body = resp.into_string().unwrap_or_default();
            let msg = serde_json::from_str::<serde_json::Value>(&body)
                .ok()
                .and_then(|v| {
                    v.get("error")
                        .and_then(|e| e.as_str())
                        .and_then(brief)
                        .map(|s| s.to_string())
                });
            match msg {
                Some(msg) => format!("GIF search failed ({code}: {msg})."),
                None => format!("GIF search failed ({code})."),
            }
        }
        ureq::Error::Transport(t) => {
            format!("Couldn't reach GIF search ({}).", transport_reason(&t))
        }
    }
}

#[tauri::command]
pub fn gif_search(query: String) -> Result<Vec<GifHit>, String> {
    let url = search_url(query.trim());
    let resp = agent()
        .get(&url)
        .set("User-Agent", "paperlike")
        .call()
        .map_err(search_failure)?;
    let text = resp
        .into_string()
        .map_err(|_| "GIF search returned something unreadable.".to_string())?;
    parse_search(&text)
}

fn urlencoding_query(q: &str) -> String {
    let mut out = String::new();
    for b in q.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[tauri::command]
pub fn gif_fetch(url: String) -> Result<GifBytes, String> {
    let clean = https_gif(&url)?;
    let resp = agent()
        .get(&clean)
        .call()
        .map_err(|_| "Couldn't download that GIF.".to_string())?;
    let mut bytes = Vec::new();
    resp.into_reader()
        .take(12 * 1024 * 1024)
        .read_to_end(&mut bytes)
        .map_err(|_| "The download stopped.".to_string())?;
    if bytes.len() < 6 || &bytes[..3] != b"GIF" {
        return Err("That file isn't a GIF.".into());
    }
    if bytes.len() >= 12 * 1024 * 1024 {
        return Err("That GIF is too large.".into());
    }
    Ok(GifBytes {
        b64: base64::engine::general_purpose::STANDARD.encode(&bytes),
    })
}

#[derive(Serialize)]
pub struct GifBytes {
    pub b64: String,
}

#[cfg(test)]
mod tests {
    use super::parse_search;

    #[test]
    fn parses_tenor_media() {
        let body = r#"{
          "data": [{
            "id": "abc",
            "url": "https://media.gifsnap.com/gifs/a.gif",
            "preview_url": "https://media.gifsnap.com/thumbnails/a.webp",
            "width": 200,
            "height": 100
          }]
        }"#;
        let hits = parse_search(body).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, "abc");
        assert_eq!(hits[0].w, 200);
        assert_eq!(hits[0].h, 100);
        assert_eq!(hits[0].url, "https://media.gifsnap.com/gifs/a.gif");
        assert_eq!(
            hits[0].preview,
            "https://media.gifsnap.com/thumbnails/a.webp"
        );
    }

    #[test]
    fn parses_gifsnap_search() {
        let body = r#"{
          "data": [{
            "id": "giphy_8YOdPoTYpHhTkq34Kf",
            "title": "Good Night Dog GIF by HammyandBrody",
            "url": "https://media.gifsnap.com/gifs/giphy_8YOdPoTYpHhTkq34Kf.gif",
            "preview_url": "https://media.gifsnap.com/thumbnails/giphy_8YOdPoTYpHhTkq34Kf.webp",
            "width": 160,
            "height": 200,
            "type": "gif",
            "source": "tenor"
          }, {
            "id": "skip-me"
          }],
          "pagination": {"page": 1, "limit": 1, "total": 110, "has_next": true, "next_page": 2, "offset": 0},
          "query": "dog"
        }"#;
        let hits = parse_search(body).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, "giphy_8YOdPoTYpHhTkq34Kf");
        assert_eq!(hits[0].w, 160);
        assert_eq!(hits[0].h, 200);
        assert_eq!(
            hits[0].preview,
            "https://media.gifsnap.com/thumbnails/giphy_8YOdPoTYpHhTkq34Kf.webp"
        );
        assert_eq!(
            hits[0].url,
            "https://media.gifsnap.com/gifs/giphy_8YOdPoTYpHhTkq34Kf.gif"
        );

        let empty = parse_search(
            r#"{"data":[],"pagination":{"page":1,"limit":2,"total":0},"query":"zzzzqqqxxxnonexistent12345"}"#,
        )
        .unwrap();
        assert!(empty.is_empty());
    }
}
