#![allow(non_snake_case)]

//! Local browser credential import: probe installed browsers (Chrome /
//! Edge / Chromium / Firefox) and decrypt their saved passwords and cookies.
//!
//! Decryption follows each browser's official algorithm:
//!
//! - Chrome family on macOS: key from the system Keychain item
//!   "Chrome Safe Storage" / "Microsoft Edge Safe Storage", then
//!   PBKDF2-HMAC-SHA1(salt = "saltysalt", 1003 rounds) -> AES-128-CBC
//!   (IV = 16 spaces) over the "v10"-prefixed payload.
//!   Cookie 库 schema v24+（Chrome 133+）的解密明文还附加了 32 字节
//!   SHA-256 哈希前缀，写入前需要剥离。
//! - Chrome family on Windows: DPAPI-unprotect the `encrypted_key` stored in
//!   `Local State`, then AES-256-GCM (nonce 12 + tag 16) over the payload.
//! - Firefox: SHA1(global-salt + master-password) iterated 20 times yields
//!   the HP key (extended to 24 bytes), which 3DES-CBC-decrypts the `a11`
//!   key blob from key4.db; login blobs from logins.json are then
//!   3DES-CBC-decrypted with that 24-byte key.
//!
//! All heavy synchronous work (SQLite + crypto) runs inside
//! `tokio::task::spawn_blocking` so the Node.js event loop is never blocked.

use std::path::{Path, PathBuf};

use aes_gcm::aead::{Aead, KeyInit};
use base64::Engine;
use cipher::{BlockDecryptMut, KeyIvInit};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use pbkdf2::pbkdf2_hmac;
use rusqlite::Connection;
use serde_json::Value;
use sha1::{Digest, Sha1};

// ---------------------------------------------------------------------------
// Public napi types
// ---------------------------------------------------------------------------

#[napi(object)]
#[allow(non_snake_case)]
pub struct ImportSourceInfo {
    /// Stable id: "chrome" | "edge" | "chromium" | "firefox"
    pub id: String,
    /// Display name, e.g. "Google Chrome"
    pub name: String,
    /// Profile name, e.g. "Default" / "Profile 1" / "abcd1234.default-release"
    pub profile: String,
    /// Browser account username (Chrome: Preferences account_info email,
    /// Firefox: services.sync.username), empty when signed out.
    pub accountName: String,
    /// Absolute path of the password database ("" when not applicable)
    pub passwordDb: String,
    /// Absolute path of the cookie database ("" when not applicable)
    pub cookieDb: String,
    /// Number of password records (counted without decrypting)
    pub passwordCount: i32,
    /// Number of cookie records
    pub cookieCount: i32,
    /// Human-readable caveat, e.g. unsupported encryption on this platform
    pub note: String,
}

#[napi(object)]
#[allow(non_snake_case)]
pub struct ImportedPassword {
    /// Normalized origin, e.g. "https://accounts.google.com"
    pub origin: String,
    pub username: String,
    pub password: String,
}

#[napi(object)]
#[allow(non_snake_case)]
pub struct ImportedCookie {
    pub domain: String,
    pub path: String,
    pub name: String,
    pub value: String,
    /// Unix seconds; None for session cookies
    pub expires: Option<i64>,
    pub httpOnly: bool,
    pub secure: bool,
    /// "None" | "Lax" | "Strict" | "unspecified"
    pub sameSite: String,
}

// ---------------------------------------------------------------------------
// Path discovery
// ---------------------------------------------------------------------------

fn home_dir() -> PathBuf {
    dirs_next::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

/// Candidate (id, display name, browser root dir).
fn chromium_roots() -> Vec<(String, String, PathBuf)> {
    let home = home_dir();
    let mut roots: Vec<(String, String, PathBuf)> = Vec::new();
    if cfg!(target_os = "macos") {
        let base = home.join("Library/Application Support");
        roots.push(("chrome".into(), "Google Chrome".into(), base.join("Google/Chrome")));
        roots.push(("edge".into(), "Microsoft Edge".into(), base.join("Microsoft Edge")));
        roots.push(("chromium".into(), "Chromium".into(), base.join("Chromium")));
    } else if cfg!(target_os = "windows") {
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            let base = PathBuf::from(local);
            roots.push(("chrome".into(), "Google Chrome".into(), base.join("Google/Chrome/User Data")));
            roots.push(("edge".into(), "Microsoft Edge".into(), base.join("Microsoft/Edge/User Data")));
            roots.push(("chromium".into(), "Chromium".into(), base.join("Chromium/User Data")));
        }
    } else {
        let base = home.join(".config");
        roots.push(("chrome".into(), "Google Chrome".into(), base.join("google-chrome")));
        roots.push(("edge".into(), "Microsoft Edge".into(), base.join("microsoft-edge")));
        roots.push(("chromium".into(), "Chromium".into(), base.join("chromium")));
    }
    roots
}

/// Chromium profile subdirectories ("Default" or "Profile N").
fn chromium_profiles(root: &Path) -> Vec<(String, PathBuf)> {
    let mut profiles: Vec<(String, PathBuf)> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(root) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if name == "Default" || name.starts_with("Profile ") {
                profiles.push((name, path));
            }
        }
    }
    if profiles.is_empty() && root.join("Default").is_dir() {
        profiles.push(("Default".into(), root.join("Default")));
    }
    profiles.sort_by(|a, b| a.0.cmp(&b.0));
    profiles
}

/// Firefox profile directories containing logins.json or cookies.sqlite.
fn firefox_profiles() -> Vec<(String, PathBuf)> {
    let home = home_dir();
    let roots: Vec<PathBuf> = if cfg!(target_os = "macos") {
        vec![home.join("Library/Application Support/Firefox/Profiles")]
    } else if cfg!(target_os = "windows") {
        std::env::var_os("APPDATA")
            .map(|dir| PathBuf::from(dir).join("Mozilla/Firefox/Profiles"))
            .into_iter()
            .collect()
    } else {
        vec![home.join(".mozilla/firefox")]
    };
    let mut profiles: Vec<(String, PathBuf)> = Vec::new();
    for root in roots {
        if let Ok(entries) = std::fs::read_dir(&root) {
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_dir() {
                    continue;
                }
                if path.join("logins.json").exists() || path.join("cookies.sqlite").exists() {
                    profiles.push((entry.file_name().to_string_lossy().to_string(), path));
                }
            }
        }
    }
    profiles.sort_by(|a, b| a.0.cmp(&b.0));
    profiles
}

/// 打开 SQLite 数据库（只读），返回 `(连接, 是否使用了 immutable 回退)`。
///
/// 浏览器运行期间其数据库（尤其是 Chrome 的 Login Data）可能持有
/// WAL 锁，常规只读连接打开成功但真实表查询会得到 SQLITE_BUSY。
/// 因此调用方必须对真实查询做"常规 → immutable"双尝试：
/// `immutable=1` URI 让 SQLite 跳过锁检查与 WAL 文件、直接读主库文件
/// （可能缺少未 checkpoint 的最新变更，由调用方在 note 中提示用户）。
///
/// 生成只读连接尝试序列（常规 → immutable 回退），供读取函数双尝试。
fn readonly_attempts(path: &Path) -> Vec<(Connection, bool)> {
    let flags = rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY
        | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let mut attempts = Vec::new();
    if let Ok(conn) = Connection::open_with_flags(path, flags) {
        let _ = conn.busy_timeout(std::time::Duration::from_millis(1500));
        attempts.push((conn, false));
    }
    let uri = format!("file:{}?mode=ro&immutable=1", path.display());
    if let Ok(conn) =
        Connection::open_with_flags(uri, flags | rusqlite::OpenFlags::SQLITE_OPEN_URI)
    {
        attempts.push((conn, true));
    }
    attempts
}

/// 对真实查询执行"常规 → immutable"双尝试，返回 (结果, 是否 immutable)。
fn query_with_retry<T>(
    path: &Path,
    query: impl Fn(&Connection) -> rusqlite::Result<T>,
) -> (Option<T>, bool) {
    for (conn, immutable) in readonly_attempts(path) {
        if let Ok(value) = query(&conn) {
            return (Some(value), immutable);
        }
    }
    (None, false)
}

/// Browser account username for Chromium profiles: the `account_info` array
/// in `Preferences` (email of the first signed-in account).
fn chromium_account_name(profile_dir: &Path) -> String {
    let Ok(text) = std::fs::read_to_string(profile_dir.join("Preferences")) else {
        return String::new();
    };
    let Ok(json) = serde_json::from_str::<Value>(&text) else {
        return String::new();
    };
    let Some(accounts) = json.pointer("/account_info").and_then(Value::as_array) else {
        return String::new();
    };
    for account in accounts {
        if let Some(email) = account.get("email").and_then(Value::as_str) {
            if !email.trim().is_empty() {
                return email.trim().to_string();
            }
        }
    }
    String::new()
}

/// Browser account username for Firefox profiles: `services.sync.username`
/// in prefs.js.
fn firefox_account_name(profile_dir: &Path) -> String {
    let Ok(text) = std::fs::read_to_string(profile_dir.join("prefs.js")) else {
        return String::new();
    };
    for line in text.lines() {
        if !line.contains("services.sync.username") {
            continue;
        }
        // Format: user_pref("services.sync.username", "user@example.com");
        // 4th double-quoted segment is the value.
        let mut segments = line.split('"');
        segments.next(); // user_pref(
        segments.next(); // services.sync.username
        segments.next(); // ", 
        if let Some(value) = segments.next() {
            if !value.trim().is_empty() {
                return value.trim().to_string();
            }
        }
    }
    String::new()
}

// ---------------------------------------------------------------------------
// Crypto helpers
// ---------------------------------------------------------------------------

fn sha1_digest(data: &[u8]) -> Vec<u8> {
    Sha1::digest(data).to_vec()
}

/// AES-128-CBC with IV of 16 spaces (Chrome on macOS/Linux pre-v10-era scheme).
fn aes128_cbc_decrypt(key: &[u8], payload: &[u8]) -> Option<Vec<u8>> {
    let iv = [0x20u8; 16];
    let cipher = cbc::Decryptor::<aes::Aes128>::new_from_slices(key, &iv).ok()?;
    let mut buf = payload.to_vec();
    let plain = cipher.decrypt_padded_mut::<cipher::block_padding::Pkcs7>(&mut buf).ok()?;
    Some(plain.to_vec())
}

/// AES-256-GCM with 12-byte nonce + 16-byte tag (Chrome on Windows).
fn aes256_gcm_decrypt(key: &[u8], payload: &[u8]) -> Option<Vec<u8>> {
    if payload.len() < 12 + 16 {
        return None;
    }
    let (nonce, rest) = payload.split_at(12);
    let cipher = aes_gcm::Aes256Gcm::new(aes_gcm::Key::<aes_gcm::Aes256Gcm>::from_slice(key));
    cipher.decrypt(aes_gcm::Nonce::from_slice(nonce), rest).ok()
}

/// 3DES-CBC (EDE3) with PKCS7 padding, used by Firefox (NSS).
fn des3_cbc_decrypt(key: &[u8], iv: &[u8], payload: &[u8]) -> Option<Vec<u8>> {
    let cipher = cbc::Decryptor::<des::TdesEde3>::new_from_slices(key, iv).ok()?;
    let mut buf = payload.to_vec();
    let plain = cipher.decrypt_padded_mut::<cipher::block_padding::Pkcs7>(&mut buf).ok()?;
    Some(plain.to_vec())
}

/// macOS Keychain lookup, e.g. `security find-generic-password -w -s "Chrome Safe Storage"`.
#[cfg(target_os = "macos")]
fn macos_keychain_password(service: &str) -> Option<String> {
    let output = std::process::Command::new("security")
        .args(["find-generic-password", "-w", "-s", service])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8(output.stdout).ok()?;
    Some(value.trim().to_string())
}

/// Chrome master key on macOS: PBKDF2-HMAC-SHA1 of the Keychain password.
#[cfg(target_os = "macos")]
fn chrome_master_key_macos(service: &str) -> Option<Vec<u8>> {
    let password = macos_keychain_password(service)?;
    let mut key = [0u8; 16];
    pbkdf2_hmac::<Sha1>(password.as_bytes(), b"saltysalt", 1003, &mut key);
    Some(key.to_vec())
}

/// DPAPI unprotect (Windows only).
#[cfg(windows)]
fn windows_dpapi_decrypt(data: &[u8]) -> Option<Vec<u8>> {
    // windows-sys >= 0.59: DATA_BLOB 已更名为 CRYPT_INTEGER_BLOB（字段相同），
    // LocalFree 移至 Win32::Foundation。
    use windows_sys::Win32::Security::Cryptography::{
        CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };
    use windows_sys::Win32::Foundation::LocalFree;

    let mut in_blob = CRYPT_INTEGER_BLOB {
        cbData: data.len() as u32,
        pbData: data.as_ptr() as *mut u8,
    };
    let mut out_blob = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    // SAFETY: standard Win32 call; blobs point at valid memory.
    let ok = unsafe {
        CryptUnprotectData(
            &mut in_blob,
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out_blob,
        )
    };
    if ok == 0 || out_blob.pbData.is_null() {
        return None;
    }
    // SAFETY: out_blob is owned by DPAPI and must be released with LocalFree.
    let out = unsafe { std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize) }.to_vec();
    unsafe {
        LocalFree(out_blob.pbData as *mut _);
    }
    Some(out)
}

/// Chrome master key on Windows: DPAPI-decrypt the key from `Local State`.
#[cfg(windows)]
fn chrome_master_key_windows(root: &Path) -> Option<Vec<u8>> {
    let text = std::fs::read_to_string(root.join("Local State")).ok()?;
    let json: Value = serde_json::from_str(&text).ok()?;
    let encrypted = json.pointer("/os_crypt/encrypted_key")?.as_str()?;
    let raw = base64::engine::general_purpose::STANDARD.decode(encrypted).ok()?;
    let payload = raw.strip_prefix(b"DPAPI")?;
    windows_dpapi_decrypt(payload)
}

/// Resolve the Chrome-family decryption key for the platform.
/// Returns (key, note) where note explains why decryption is unavailable.
fn chrome_master_key(root: &Path, source_id: &str) -> (Option<Vec<u8>>, String) {
    #[cfg(target_os = "macos")]
    {
        let _ = root;
        let service = match source_id {
            "edge" => "Microsoft Edge Safe Storage",
            _ => "Chrome Safe Storage",
        };
        match chrome_master_key_macos(service) {
            Some(key) => (Some(key), String::new()),
            None => (
                None,
                "Keychain 中未找到浏览器安全存储密钥（可能从未在该浏览器保存过密码，或 Keychain 访问被拒绝）".to_string(),
            ),
        }
    }
    #[cfg(windows)]
    {
        match chrome_master_key_windows(root) {
            Some(key) => (Some(key), String::new()),
            None => (
                None,
                "无法解密 Windows 凭据（DPAPI 调用失败或 Local State 缺失）".to_string(),
            ),
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        // Linux Chrome keeps its key in gnome-keyring/kwallet; unsupported here.
        let _ = (root, source_id);
        (
            None,
            "Linux 上 Chrome 系浏览器使用系统密钥环加密，暂不支持解密；Firefox 可用".to_string(),
        )
    }
}

/// Decrypt a single Chrome-family credential blob ("v10" prefix stripped).
fn chrome_decrypt(payload: &[u8], key: &[u8]) -> Option<Vec<u8>> {
    let body = payload.strip_prefix(b"v10").unwrap_or(payload);
    if body.is_empty() {
        return None;
    }
    if key.len() == 16 {
        aes128_cbc_decrypt(key, body)
    } else {
        aes256_gcm_decrypt(key, body)
    }
}

/// 是否包含 ASCII 控制字符（Chromium 禁止 Cookie 值中出现此类字节）。
fn has_ascii_control(bytes: &[u8]) -> bool {
    bytes.iter().any(|&b| b < 0x20 || b == 0x7f)
}

/// 规范化解密后的 Cookie 明文：Chrome 133+（Cookie 库 schema v24+）会在
/// 解密明文前附加 32 字节 SHA-256 哈希前缀，剥离后才是真实值；同时剥离
/// 前导控制字符（合法 Cookie 值不可能以控制字符开头，但解密产物可能残留）。
///
/// `strip_hash_prefix` 为 `None`（meta 表不可读，如浏览器运行中锁竞争导致
/// SQLITE_BUSY）时回退到启发式判定：前 32 字节含控制字符、32 字节后不含，
/// 则判定前 32 字节为哈希前缀并剥离。随机哈希 32 字节全可打印的概率约 1.4%，
/// 该兜底仅在 meta 查询失败时启用，正常路径仍以 meta 版本精确判定。
fn decode_chromium_value_plaintext(plain: &[u8], strip_hash_prefix: Option<bool>) -> String {
    let strip = match strip_hash_prefix {
        Some(value) => value,
        None => {
            plain.len() >= 32
                && has_ascii_control(&plain[..32])
                && !has_ascii_control(&plain[32..])
        }
    };
    let bytes = if strip && plain.len() >= 32 {
        &plain[32..]
    } else {
        plain
    };
    let text = String::from_utf8_lossy(bytes);
    text.trim_start_matches(|c: char| (c as u32) < 0x20)
        .to_string()
}

/// 解密单条 Chromium Cookie 值：`v10` 前缀为 AES 密文；无前缀时按明文处理
/// （macOS 上部分 Cookie 值明文存储在 encrypted_value）。
/// 返回 None 表示无法解密（如 Windows 的 v20 应用绑定加密），调用方应跳过该条。
fn decrypt_chromium_cookie_value(
    payload: &[u8],
    key: Option<&[u8]>,
    strip_hash_prefix: Option<bool>,
) -> Option<String> {
    if let Some(body) = payload.strip_prefix(b"v10") {
        let plain = if key.map_or(16, |k| k.len()) == 16 {
            aes128_cbc_decrypt(key?, body)?
        } else {
            aes256_gcm_decrypt(key?, body)?
        };
        Some(decode_chromium_value_plaintext(&plain, strip_hash_prefix))
    } else {
        // 明文存储路径：不剥离哈希前缀（明文本身不带前缀）。
        Some(decode_chromium_value_plaintext(payload, Some(false)))
    }
}

// ---------------------------------------------------------------------------
// Chromium (Chrome / Edge / Chromium) readers
// ---------------------------------------------------------------------------

/// Chrome password table is only meaningful when the profile has one.
/// Returns (count, note) — note explains when data may be stale (browser
/// running, immutable fallback used).
fn chromium_password_count(profile_dir: &Path) -> (i32, String) {
    let db = profile_dir.join("Login Data");
    let (count, immutable) = query_with_retry(&db, |conn| {
        conn.query_row("SELECT COUNT(*) FROM logins", [], |row| row.get::<_, i64>(0))
    });
    (
        count.unwrap_or(0) as i32,
        if immutable {
            "浏览器正在运行，密码数据可能不是最新，建议关闭浏览器后重试".to_string()
        } else {
            String::new()
        },
    )
}

fn chromium_cookie_count(profile_dir: &Path) -> (i32, String) {
    let db = profile_dir.join("Cookies");
    let (count, immutable) = query_with_retry(&db, |conn| {
        conn.query_row("SELECT COUNT(*) FROM cookies", [], |row| row.get::<_, i64>(0))
    });
    (
        count.unwrap_or(0) as i32,
        if immutable {
            "浏览器正在运行，Cookie 数据可能不是最新，建议关闭浏览器后重试".to_string()
        } else {
            String::new()
        },
    )
}

fn normalize_origin(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    // Only http(s) origins can be replayed by the embedded browser.
    if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
        return None;
    }
    reqwest::Url::parse(trimmed)
        .ok()
        .map(|url| url.origin().ascii_serialization())
}

fn read_chromium_passwords(source_id: &str, profile_dir: &Path) -> Result<Vec<ImportedPassword>> {
    let db = profile_dir.join("Login Data");
    if !db.exists() {
        return Ok(Vec::new());
    }
    // 常规 → immutable 双尝试：浏览器运行中锁定 WAL 时回退读主库文件。
    let mut last_error: Option<Error> = None;
    for (conn, _immutable) in readonly_attempts(&db) {
        match read_chromium_passwords_with(&conn, source_id, profile_dir) {
            Ok(items) => return Ok(items),
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error.unwrap_or_else(|| {
        Error::from_reason(format!(
            "无法以只读方式打开密码数据库（浏览器可能正在运行，请关闭后重试）: {}",
            db.display()
        ))
    }))
}

fn read_chromium_passwords_with(
    conn: &Connection,
    source_id: &str,
    profile_dir: &Path,
) -> Result<Vec<ImportedPassword>> {
    let (key, note) = chrome_master_key(
        profile_dir.parent().unwrap_or(profile_dir),
        source_id,
    );
    let Some(key) = key else {
        return Err(Error::from_reason(note));
    };

    let mut stmt = conn
        .prepare(
            "SELECT origin_url, username_value, password_value FROM logins \
             WHERE username_value != '' OR password_value IS NOT NULL",
        )
        .map_err(|error| Error::from_reason(format!("读取登录记录失败: {error}")))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Vec<u8>>(2)?,
            ))
        })
        .map_err(|error| Error::from_reason(format!("查询登录记录失败: {error}")))?;

    let mut passwords: Vec<ImportedPassword> = Vec::new();
    let mut seen: std::collections::HashSet<(String, String)> = std::collections::HashSet::new();
    for row in rows.flatten() {
        let (origin_url, username, encrypted) = row;
        let Some(origin) = normalize_origin(&origin_url) else {
            continue;
        };
        if encrypted.is_empty() {
            continue;
        }
        let Some(plain) = chrome_decrypt(&encrypted, &key) else {
            continue;
        };
        let password = String::from_utf8_lossy(&plain).into_owned();
        if password.is_empty() {
            continue;
        }
        let username = username.trim().to_string();
        // A single origin may store duplicates; keep the last non-empty pair.
        if !seen.insert((origin.clone(), username.clone())) {
            continue;
        }
        passwords.push(ImportedPassword {
            origin,
            username,
            password,
        });
    }
    Ok(passwords)
}

fn read_chromium_cookies(source_id: &str, profile_dir: &Path) -> Result<Vec<ImportedCookie>> {
    let db = profile_dir.join("Cookies");
    if !db.exists() {
        return Ok(Vec::new());
    }
    // 常规 → immutable 双尝试：浏览器运行中锁定 WAL 时回退读主库文件。
    let mut last_error: Option<Error> = None;
    for (conn, _immutable) in readonly_attempts(&db) {
        match read_chromium_cookies_with(&conn, source_id, profile_dir) {
            Ok(items) => return Ok(items),
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error.unwrap_or_else(|| {
        Error::from_reason(format!(
            "无法以只读方式打开 Cookie 数据库（浏览器可能正在运行，请关闭后重试）: {}",
            db.display()
        ))
    }))
}

fn read_chromium_cookies_with(
    conn: &Connection,
    source_id: &str,
    profile_dir: &Path,
) -> Result<Vec<ImportedCookie>> {
    // source_id 决定 macOS Keychain 服务名（Chrome 与 Edge 各自独立），
    // 传错会导致 Edge 的 Cookie 解密失败、值全部为空。
    let (key, _note) = chrome_master_key(
        profile_dir.parent().unwrap_or(profile_dir),
        source_id,
    );

    // Chrome 133+ 的 Cookie 库 schema v24+ 会在解密明文前附加 32 字节
    // SHA-256 哈希前缀，必须剥离，否则值里全是控制字符，目标浏览器会以
    // EXCLUDE_DISALLOWED_CHARACTER 拒绝写入（表现为导入几乎全部失败）。
    // 浏览器运行中 meta 查询可能因 SQLITE_BUSY 失败，此时保留 None，
    // 由解码端启发式兜底判定，而不是错误地当作旧库不剥离。
    let schema_version: Option<i64> = conn
        .query_row("SELECT value FROM meta WHERE key = 'version'", [], |row| row.get(0))
        .ok();
    let strip_hash_prefix = schema_version.map(|version| version >= 24);

    // 新版 Chromium（2025+）：值存放在 encrypted_value BLOB，sameSite 列名为
    // 小写 samesite；旧版：value TEXT + same_site。
    let modern_query = "SELECT host_key, name, value, encrypted_value, path, expires_utc, \
                        is_secure, is_httponly, samesite, has_expires FROM cookies";
    let legacy_query = "SELECT host_key, name, value, path, expires_utc, is_secure, \
                        is_httponly, same_site, has_expires FROM cookies";

    struct CookieRow {
        domain: String,
        name: String,
        value: String,
        encrypted: Vec<u8>,
        path: String,
        expires_utc: i64,
        is_secure: i64,
        is_httponly: i64,
        same_site: i64,
        has_expires: Option<i64>,
    }

    let rows: Vec<CookieRow> = if conn.prepare(modern_query).is_ok() {
        let mut stmt = conn
            .prepare(modern_query)
            .map_err(|error| Error::from_reason(format!("读取 Cookie 表失败: {error}")))?;
        let mapped = stmt
            .query_map([], |row| {
                Ok(CookieRow {
                    domain: row.get::<_, String>(0)?,
                    name: row.get::<_, String>(1)?,
                    value: row.get::<_, String>(2)?,
                    encrypted: row
                        .get::<_, Option<Vec<u8>>>(3)?
                        .unwrap_or_default(),
                    path: row.get::<_, String>(4)?,
                    expires_utc: row.get::<_, i64>(5)?,
                    is_secure: row.get::<_, i64>(6)?,
                    is_httponly: row.get::<_, i64>(7)?,
                    same_site: row.get::<_, i64>(8)?,
                    has_expires: row.get::<_, Option<i64>>(9)?,
                })
            })
            .map_err(|error| Error::from_reason(format!("查询 Cookie 表失败: {error}")))?;
        mapped.flatten().collect()
    } else {
        let mut stmt = conn
            .prepare(legacy_query)
            .map_err(|error| Error::from_reason(format!("读取 Cookie 表失败: {error}")))?;
        let mapped = stmt
            .query_map([], |row| {
                Ok(CookieRow {
                    domain: row.get::<_, String>(0)?,
                    name: row.get::<_, String>(1)?,
                    value: row.get::<_, String>(2)?,
                    encrypted: Vec::new(),
                    path: row.get::<_, String>(3)?,
                    expires_utc: row.get::<_, i64>(4)?,
                    is_secure: row.get::<_, i64>(5)?,
                    is_httponly: row.get::<_, i64>(6)?,
                    same_site: row.get::<_, i64>(7)?,
                    has_expires: row.get::<_, Option<i64>>(8)?,
                })
            })
            .map_err(|error| Error::from_reason(format!("查询 Cookie 表失败: {error}")))?;
        mapped.flatten().collect()
    };

    // Chromium stores expires_utc as microseconds since 1601-01-01.
    const WINDOWS_EPOCH_DELTA_SECS: i64 = 11_644_473_600;

    let mut cookies: Vec<ImportedCookie> = Vec::new();
    for row in rows {
        let CookieRow {
            domain,
            name,
            value,
            encrypted,
            path,
            expires_utc,
            is_secure,
            is_httponly,
            same_site,
            has_expires,
        } = row;
        // 新版 Chrome（schema v24+）值加密存入 encrypted_value、value 列为空；
        // 旧版（v10~v23）value 文本列直接存 v10 前缀密文。统一走解密入口，
        // 解密失败（如 Windows v20 应用绑定加密、密钥缺失）则跳过该条，
        // 避免把乱码/空值写入目标浏览器。
        let Some(value) = (if !encrypted.is_empty() {
            decrypt_chromium_cookie_value(&encrypted, key.as_deref(), strip_hash_prefix)
        } else if value.starts_with("v10") {
            decrypt_chromium_cookie_value(value.as_bytes(), key.as_deref(), strip_hash_prefix)
        } else {
            Some(value)
        }) else {
            continue;
        };
        let expires = if has_expires == Some(0) {
            None
        } else if has_expires == Some(1) && expires_utc <= 0 {
            None
        } else {
            let unix = expires_utc / 1_000_000 - WINDOWS_EPOCH_DELTA_SECS;
            (unix > 0).then_some(unix)
        };
        let same_site = match same_site {
            0 => "None",
            1 => "Lax",
            2 => "Strict",
            _ => "unspecified",
        };
        cookies.push(ImportedCookie {
            domain,
            path: if path.is_empty() { "/".to_string() } else { path },
            name,
            value,
            expires,
            httpOnly: is_httponly != 0,
            secure: is_secure != 0,
            sameSite: same_site.to_string(),
        });
    }
    Ok(cookies)
}

// ---------------------------------------------------------------------------
// Firefox readers
// ---------------------------------------------------------------------------

fn firefox_has_master_password(profile_dir: &Path) -> bool {
    let db = profile_dir.join("key4.db");
    let (has_master, _) = query_with_retry(&db, |conn| {
        conn.query_row("SELECT item1 FROM metaData WHERE id = 3", [], |row| {
            row.get::<_, Vec<u8>>(0)
        })
    });
    has_master.map(|value| !value.is_empty()).unwrap_or(false)
}

/// Derive the 24-byte 3DES key from key4.db (no master password).
fn firefox_3des_key(profile_dir: &Path) -> Result<Vec<u8>> {
    let key_db = profile_dir.join("key4.db");
    if !key_db.exists() {
        return Err(Error::from_reason("未找到 key4.db，Firefox 可能未初始化".to_string()));
    }
    // 常规 → immutable 双尝试。
    let mut last_error: Option<Error> = None;
    for (conn, _immutable) in readonly_attempts(&key_db) {
        match firefox_3des_key_with(&conn, profile_dir) {
            Ok(key) => return Ok(key),
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error.unwrap_or_else(|| {
        Error::from_reason(format!(
            "无法以只读方式打开 key4.db（Firefox 可能正在运行，请关闭后重试）: {}",
            key_db.display()
        ))
    }))
}

fn firefox_3des_key_with(conn: &Connection, profile_dir: &Path) -> Result<Vec<u8>> {
    if firefox_has_master_password(profile_dir) {
        return Err(Error::from_reason(
            "Firefox 已设置主密码，暂不支持导入；请临时取消主密码后重试".to_string(),
        ));
    }
    let global_salt: Vec<u8> = conn
        .query_row("SELECT item1 FROM metaData WHERE id = 1", [], |row| row.get(0))
        .map_err(|error| Error::from_reason(format!("读取 key4.db 失败: {error}")))?;
    let a11: Vec<u8> = conn
        .query_row(
            "SELECT a11 FROM nssPrivate WHERE a11 IS NOT NULL LIMIT 1",
            [],
            |row| row.get(0),
        )
        .map_err(|error| Error::from_reason(format!("读取加密密钥失败: {error}")))?;

    // HP = SHA1(global_salt) iterated 20 times; NSS pads the 20-byte digest
    // to 24 bytes by repeating the first 4 bytes for the 3DES key.
    let mut hp = sha1_digest(&global_salt);
    for _ in 0..20 {
        hp = sha1_digest(&hp);
    }
    let mut key = [0u8; 24];
    key[..20].copy_from_slice(&hp);
    key[20..24].copy_from_slice(&hp[..4]);

    // a11 blob: IV(16) + ciphertext -> plaintext = key(24) + checksum(20).
    let (iv, payload) = a11.split_at(16);
    let plain = des3_cbc_decrypt(&key, iv, payload)
        .ok_or_else(|| Error::from_reason("解密 Firefox 密钥失败（数据损坏）".to_string()))?;
    if plain.len() < 44 {
        return Err(Error::from_reason("Firefox 密钥数据格式异常".to_string()));
    }
    let derived = &plain[..24];
    let checksum = sha1_digest(derived);
    if checksum != plain[24..44] {
        return Err(Error::from_reason(
            "Firefox 密钥校验失败（可能设置了主密码或数据损坏）".to_string(),
        ));
    }
    Ok(derived.to_vec())
}

fn firefox_decrypt_login_blob(blob: &[u8], key: &[u8]) -> Option<String> {
    let (iv, payload) = blob.split_at(16);
    let plain = des3_cbc_decrypt(key, iv, payload)?;
    // Firefox 97+ prefixes plaintext with '~' to mark the format version.
    let text = if plain.first() == Some(&b'~') {
        String::from_utf8_lossy(&plain[1..]).into_owned()
    } else {
        String::from_utf8_lossy(&plain).into_owned()
    };
    Some(text)
}

fn read_firefox_passwords(profile_dir: &Path) -> Result<Vec<ImportedPassword>> {
    let logins_path = profile_dir.join("logins.json");
    if !logins_path.exists() {
        return Ok(Vec::new());
    }
    let key = firefox_3des_key(profile_dir)?;
    let text = std::fs::read_to_string(&logins_path)
        .map_err(|error| Error::from_reason(format!("读取 logins.json 失败: {error}")))?;
    let json: Value = serde_json::from_str(&text)
        .map_err(|error| Error::from_reason(format!("解析 logins.json 失败: {error}")))?;
    let logins = json
        .get("logins")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let mut passwords: Vec<ImportedPassword> = Vec::new();
    for login in logins {
        let Some(hostname) = login.get("hostname").and_then(Value::as_str) else {
            continue;
        };
        let Some(origin) = normalize_origin(hostname) else {
            continue;
        };
        let decrypt_field = |field: &str| -> Option<String> {
            let raw = login.get(field).and_then(Value::as_str)?;
            let blob = base64::engine::general_purpose::STANDARD.decode(raw).ok()?;
            firefox_decrypt_login_blob(&blob, &key)
        };
        let Some(password) = decrypt_field("encryptedPassword") else {
            continue;
        };
        let username = decrypt_field("encryptedUsername").unwrap_or_default();
        if password.is_empty() {
            continue;
        }
        passwords.push(ImportedPassword {
            origin,
            username,
            password,
        });
    }
    Ok(passwords)
}

fn read_firefox_cookies(profile_dir: &Path) -> Result<Vec<ImportedCookie>> {
    let db = profile_dir.join("cookies.sqlite");
    if !db.exists() {
        return Ok(Vec::new());
    }
    // 常规 → immutable 双尝试。
    let mut last_error: Option<Error> = None;
    for (conn, _immutable) in readonly_attempts(&db) {
        match read_firefox_cookies_with(&conn) {
            Ok(items) => return Ok(items),
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error.unwrap_or_else(|| {
        Error::from_reason(format!(
            "无法以只读方式打开 cookies.sqlite（Firefox 可能正在运行，请关闭后重试）: {}",
            db.display()
        ))
    }))
}

fn read_firefox_cookies_with(conn: &Connection) -> Result<Vec<ImportedCookie>> {
    let mut stmt = conn
        .prepare(
            "SELECT name, value, host, path, expiry, isSecure, isHttpOnly, sameSite \
             FROM moz_cookies",
        )
        .map_err(|error| Error::from_reason(format!("读取 Cookie 表失败: {error}")))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, i64>(6)?,
                row.get::<_, i64>(7)?,
            ))
        })
        .map_err(|error| Error::from_reason(format!("查询 Cookie 表失败: {error}")))?;

    let mut cookies: Vec<ImportedCookie> = Vec::new();
    for row in rows.flatten() {
        let (name, value, host, path, expiry, is_secure, is_http_only, same_site) = row;
        // Firefox moz_cookies.sameSite: 0 = 无限制（None），1 = Lax，2 = Strict。
        let same_site = match same_site {
            0 => "None",
            1 => "Lax",
            2 => "Strict",
            _ => "unspecified",
        };
        cookies.push(ImportedCookie {
            domain: host,
            path: if path.is_empty() { "/".to_string() } else { path },
            name,
            value,
            expires: (expiry > 0).then_some(expiry),
            httpOnly: is_http_only != 0,
            secure: is_secure != 0,
            sameSite: same_site.to_string(),
        });
    }
    Ok(cookies)
}

// ---------------------------------------------------------------------------
// napi entry points (async, spawn_blocking inside)
// ---------------------------------------------------------------------------

#[napi]
pub async fn browser_import_list_sources() -> Result<Vec<ImportSourceInfo>> {
    tokio::task::spawn_blocking(|| -> Result<Vec<ImportSourceInfo>> {
        let mut sources: Vec<ImportSourceInfo> = Vec::new();
        for (id, name, root) in chromium_roots() {
            if !root.exists() {
                continue;
            }
            for (profile, dir) in chromium_profiles(&root) {
                let password_db = dir.join("Login Data");
                let cookie_db = dir.join("Cookies");
                let has_password_db = password_db.exists();
                let has_cookie_db = cookie_db.exists();
                if !has_password_db && !has_cookie_db {
                    continue;
                }
                let (password_count, password_note) = if has_password_db {
                    chromium_password_count(&dir)
                } else {
                    (0, String::new())
                };
                let (cookie_count, cookie_note) = if has_cookie_db {
                    chromium_cookie_count(&dir)
                } else {
                    (0, String::new())
                };
                let note = [password_note, cookie_note]
                    .into_iter()
                    .filter(|value| !value.is_empty())
                    .collect::<Vec<_>>()
                    .join("；");
                sources.push(ImportSourceInfo {
                    id: id.clone(),
                    name: name.clone(),
                    profile,
                    accountName: chromium_account_name(&dir),
                    passwordDb: if has_password_db {
                        password_db.display().to_string()
                    } else {
                        String::new()
                    },
                    cookieDb: if has_cookie_db {
                        cookie_db.display().to_string()
                    } else {
                        String::new()
                    },
                    passwordCount: password_count,
                    cookieCount: cookie_count,
                    note,
                });
            }
        }
        for (profile, dir) in firefox_profiles() {
            let has_logins = dir.join("logins.json").exists();
            let has_cookies = dir.join("cookies.sqlite").exists();
            if !has_logins && !has_cookies {
                continue;
            }
            let master = firefox_has_master_password(&dir);
            let password_count = if has_logins {
                std::fs::read_to_string(dir.join("logins.json"))
                    .ok()
                    .and_then(|text| serde_json::from_str::<Value>(&text).ok())
                    .and_then(|json| json.get("logins").and_then(Value::as_array).cloned())
                    .map(|logins| logins.len() as i32)
                    .unwrap_or(0)
            } else {
                0
            };
            sources.push(ImportSourceInfo {
                id: "firefox".to_string(),
                name: "Firefox".to_string(),
                profile,
                accountName: firefox_account_name(&dir),
                passwordDb: if has_logins {
                    dir.join("logins.json").display().to_string()
                } else {
                    String::new()
                },
                cookieDb: if has_cookies {
                    dir.join("cookies.sqlite").display().to_string()
                } else {
                    String::new()
                },
                passwordCount: password_count,
                cookieCount: if has_cookies {
                    let (count, _) = query_with_retry(&dir.join("cookies.sqlite"), |conn| {
                        conn.query_row("SELECT COUNT(*) FROM moz_cookies", [], |row| {
                            row.get::<_, i64>(0)
                        })
                    });
                    count.unwrap_or(0) as i32
                } else {
                    0
                },
                note: {
                    let mut notes: Vec<String> = Vec::new();
                    if master {
                        notes.push("Firefox 已设置主密码，导入密码前请临时取消主密码".to_string());
                    }
                    if has_cookies {
                        let (_, immutable) = query_with_retry(&dir.join("cookies.sqlite"), |conn| {
                            conn.query_row("SELECT COUNT(*) FROM moz_cookies", [], |row| {
                                row.get::<_, i64>(0)
                            })
                        });
                        if immutable {
                            notes.push(
                                "浏览器正在运行，Cookie 数据可能不是最新，建议关闭浏览器后重试"
                                    .to_string(),
                            );
                        }
                    }
                    notes.join("；")
                },
            });
        }
        Ok(sources)
    })
    .await
    .map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("浏览器源探测任务失败: {error}"),
        )
    })?
}

#[napi]
pub async fn browser_import_passwords(
    source_id: String,
    profile: String,
) -> Result<Vec<ImportedPassword>> {
    tokio::task::spawn_blocking(move || -> Result<Vec<ImportedPassword>> {
        if source_id == "firefox" {
            let dir = firefox_profile_dir(&profile)
                .ok_or_else(|| Error::from_reason("未找到指定 Firefox 配置文件".to_string()))?;
            read_firefox_passwords(&dir)
        } else {
            let (root, _name) = chromium_root_by_id(&source_id)
                .ok_or_else(|| Error::from_reason("不支持的浏览器类型".to_string()))?;
            let dir = root.join(&profile);
            if !dir.is_dir() {
                return Err(Error::from_reason(format!(
                    "未找到浏览器配置文件目录: {}",
                    dir.display()
                )));
            }
            read_chromium_passwords(&source_id, &dir)
        }
    })
    .await
    .map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("密码解析任务失败: {error}"),
        )
    })?
}

#[napi]
pub async fn browser_import_cookies(
    source_id: String,
    profile: String,
) -> Result<Vec<ImportedCookie>> {
    tokio::task::spawn_blocking(move || -> Result<Vec<ImportedCookie>> {
        if source_id == "firefox" {
            let dir = firefox_profile_dir(&profile)
                .ok_or_else(|| Error::from_reason("未找到指定 Firefox 配置文件".to_string()))?;
            read_firefox_cookies(&dir)
        } else {
            let (root, _name) = chromium_root_by_id(&source_id)
                .ok_or_else(|| Error::from_reason("不支持的浏览器类型".to_string()))?;
            let dir = root.join(&profile);
            if !dir.is_dir() {
                return Err(Error::from_reason(format!(
                    "未找到浏览器配置文件目录: {}",
                    dir.display()
                )));
            }
            read_chromium_cookies(&source_id, &dir)
        }
    })
    .await
    .map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Cookie 解析任务失败: {error}"),
        )
    })?
}

fn chromium_root_by_id(source_id: &str) -> Option<(PathBuf, String)> {
    chromium_roots()
        .into_iter()
        .find(|(id, _, _)| id == source_id)
        .map(|(_, name, root)| (root, name))
}

fn firefox_profile_dir(profile: &str) -> Option<PathBuf> {
    firefox_profiles()
        .into_iter()
        .find(|(name, _)| name == profile)
        .map(|(_, dir)| dir)
}
