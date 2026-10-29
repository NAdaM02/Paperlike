//! RFC 6238 TOTP (SHA-1, 30 s, 6 digits) for the TUM two-factor step.
//! Self-contained so the code generator has no extra dependencies.

/// Accepts an `otpauth://totp/...` URI or a bare base32 key (spaces and dashes allowed).
/// Returns the normalized base32 key.
pub fn parse_secret(input: &str) -> Result<String, String> {
    let input = input.trim();
    let raw = if input.to_ascii_lowercase().starts_with("otpauth://") {
        let url = url::Url::parse(input).map_err(|_| "That authenticator link could not be read.".to_string())?;
        if url.host_str().map(|h| h.eq_ignore_ascii_case("totp")) != Some(true) {
            return Err("Only time-based (TOTP) codes are supported.".into());
        }
        let mut secret = None;
        for (k, v) in url.query_pairs() {
            match k.to_ascii_lowercase().as_str() {
                "secret" => secret = Some(v.into_owned()),
                "algorithm" if !v.eq_ignore_ascii_case("sha1") => {
                    return Err("This key uses an algorithm Paperlike does not support.".into())
                }
                "digits" if v != "6" => return Err("Only 6-digit codes are supported.".into()),
                "period" if v != "30" => return Err("Only 30-second codes are supported.".into()),
                _ => {}
            }
        }
        secret.ok_or_else(|| "The authenticator link has no key.".to_string())?
    } else {
        input.to_string()
    };
    let key: String = raw
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .collect::<String>()
        .trim_end_matches('=')
        .to_ascii_uppercase();
    match base32_decode(&key) {
        Some(bytes) if bytes.len() >= 10 => Ok(key),
        _ => Err("That doesn't look like a TOTP key. It should be letters A–Z and digits 2–7.".into()),
    }
}

/// Current code and the seconds it stays valid.
pub fn code_now(secret: &str) -> Result<(String, u64), String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs();
    Ok((code_at(secret, now)?, 30 - now % 30))
}

/// The current 30-second step and the seconds left in it.
pub fn step_now() -> Result<(u64, u64), String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs();
    Ok((now / 30, 30 - now % 30))
}

pub fn code_at(secret: &str, unix: u64) -> Result<String, String> {
    let key = base32_decode(secret).ok_or("Invalid TOTP key.")?;
    let mac = hmac_sha1(&key, &(unix / 30).to_be_bytes());
    let off = (mac[19] & 0x0f) as usize;
    let bin = u32::from_be_bytes([mac[off] & 0x7f, mac[off + 1], mac[off + 2], mac[off + 3]]);
    Ok(format!("{:06}", bin % 1_000_000))
}

fn base32_decode(s: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(s.len() * 5 / 8);
    let (mut buf, mut bits) = (0u64, 0u32);
    for c in s.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'2'..=b'7' => c - b'2' + 26,
            _ => return None,
        } as u64;
        buf = (buf << 5) | v;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
            buf &= (1 << bits) - 1;
        }
    }
    Some(out)
}

fn hmac_sha1(key: &[u8], msg: &[u8]) -> [u8; 20] {
    let mut k = [0u8; 64];
    if key.len() > 64 {
        k[..20].copy_from_slice(&sha1(key));
    } else {
        k[..key.len()].copy_from_slice(key);
    }
    let mut inner: Vec<u8> = k.iter().map(|b| b ^ 0x36).collect();
    inner.extend_from_slice(msg);
    let mut outer: Vec<u8> = k.iter().map(|b| b ^ 0x5c).collect();
    outer.extend_from_slice(&sha1(&inner));
    sha1(&outer)
}

fn sha1(data: &[u8]) -> [u8; 20] {
    let mut h: [u32; 5] = [0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0];
    let mut msg = data.to_vec();
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&((data.len() as u64) * 8).to_be_bytes());
    for chunk in msg.chunks(64) {
        let mut w = [0u32; 80];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([chunk[4 * i], chunk[4 * i + 1], chunk[4 * i + 2], chunk[4 * i + 3]]);
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
        }
        let [mut a, mut b, mut c, mut d, mut e] = h;
        for (i, wi) in w.iter().enumerate() {
            let (f, k) = match i {
                0..=19 => ((b & c) | (!b & d), 0x5A827999),
                20..=39 => (b ^ c ^ d, 0x6ED9EBA1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1BBCDC),
                _ => (b ^ c ^ d, 0xCA62C1D6),
            };
            let t = a.rotate_left(5).wrapping_add(f).wrapping_add(e).wrapping_add(k).wrapping_add(*wi);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = t;
        }
        for (x, y) in h.iter_mut().zip([a, b, c, d, e]) {
            *x = x.wrapping_add(y);
        }
    }
    let mut out = [0u8; 20];
    for (i, v) in h.iter().enumerate() {
        out[4 * i..4 * i + 4].copy_from_slice(&v.to_be_bytes());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    // RFC 6238 appendix B, SHA-1 key "12345678901234567890" (last 6 digits).
    const KEY: &str = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

    #[test]
    fn rfc6238_vectors() {
        assert_eq!(code_at(KEY, 59).unwrap(), "287082");
        assert_eq!(code_at(KEY, 1111111109).unwrap(), "081804");
        assert_eq!(code_at(KEY, 1234567890).unwrap(), "005924");
        assert_eq!(code_at(KEY, 20000000000).unwrap(), "353130");
    }

    #[test]
    fn parses_uri_and_spaced_key() {
        let uri = "otpauth://totp/TUM:ab12cde?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=TUM&algorithm=SHA1&digits=6&period=30";
        assert_eq!(parse_secret(uri).unwrap(), KEY);
        assert_eq!(parse_secret("gezd gnbv-gy3t qojq gezd gnbv gy3t qojq").unwrap(), KEY);
        assert!(parse_secret("hello world").is_err());
        assert!(parse_secret("otpauth://hotp/x?secret=GEZDGNBVGY3TQOJQ").is_err());
    }
}
