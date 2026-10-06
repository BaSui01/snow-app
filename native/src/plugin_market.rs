//! Snow App 插件市场：索引拉取与「从市场安装插件」链路。
//!
//! 索引来自 snow-plugin-store 仓库的 app/registry.json。拉取优先按最新
//! commit SHA 内容寻址（raw 直连 + jsDelivr 镜像），绕开分支引用地址的
//! CDN 长缓存；解析失败时回退分支引用地址（强制刷新先清理 jsDelivr 镜像
//! 缓存）。成功后写入磁盘缓存，网络不可用时回退上一次成功的缓存。
//!
//! 安装链路（全部在 spawn_blocking 内执行，不阻塞 Node 主线程）：
//! 下载 zip -> SHA256 校验 -> 解压到临时目录 -> 校验 plugin.json 的 id ->
//! 复用存储层 `install_plugin_with_source`（source_path 记录仓库地址）。

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use napi::bindgen_prelude::*;

use crate::storage::{PluginRecord, UserscriptRecord};

/// 插件市场索引的候选地址，按序尝试。
/// 主地址为 GitHub raw；镜像地址走 jsDelivr CDN，改善国内网络可达性。
const MARKET_REGISTRY_SOURCES: [&str; 2] = [
    "https://raw.githubusercontent.com/MayDay-wpf/snow-plugin-store/main/app/registry.json",
    "https://cdn.jsdelivr.net/gh/MayDay-wpf/snow-plugin-store@main/app/registry.json",
];

/// 内容寻址拉取的地址前缀：拼接 commit SHA 组成不可变直链。
const MARKET_REGISTRY_RAW_PREFIX: &str =
    "https://raw.githubusercontent.com/MayDay-wpf/snow-plugin-store/";
const MARKET_REGISTRY_CDN_PREFIX: &str =
    "https://cdn.jsdelivr.net/gh/MayDay-wpf/snow-plugin-store@";
/// 解析索引仓库最新 commit SHA 的两个地址：
/// GitHub commits API（匿名限流 60 次/小时）与 commits atom 订阅源（无限流）。
const MARKET_REGISTRY_COMMIT_API: &str =
    "https://api.github.com/repos/MayDay-wpf/snow-plugin-store/commits/main";
const MARKET_REGISTRY_COMMIT_ATOM: &str =
    "https://github.com/MayDay-wpf/snow-plugin-store/commits/main.atom";

/// 内存缓存有效期：刷新按钮以外的重复进入复用最近一次结果。
const REGISTRY_CACHE_TTL: Duration = Duration::from_secs(60);
/// SHA 解析请求的超时上限。
const REGISTRY_SHA_RESOLVE_TIMEOUT: Duration = Duration::from_secs(8);
/// SHA 解析失败后的退避时长：避免不可达网络下反复等待。
const REGISTRY_SHA_RESOLVE_BACKOFF: Duration = Duration::from_secs(120);
/// 插件归档（zip）大小上限，与存储层复制上限保持一致。
const MAX_PLUGIN_ARCHIVE_BYTES: u64 = 128 * 1024 * 1024;
/// 解压后总大小上限（防 zip 炸弹）。
const MAX_PLUGIN_EXTRACT_BYTES: u64 = 512 * 1024 * 1024;
/// 用户脚本文件（.user.js）大小上限。
const MAX_USERSCRIPT_BYTES: u64 = 10 * 1024 * 1024;

static REGISTRY_MEMORY_CACHE: OnceLock<Mutex<Option<(Instant, String)>>> = OnceLock::new();
static REGISTRY_SHA_RESOLVE_BACKOFF_UNTIL: OnceLock<Mutex<Option<Instant>>> = OnceLock::new();

fn memory_cache() -> &'static Mutex<Option<(Instant, String)>> {
    REGISTRY_MEMORY_CACHE.get_or_init(|| Mutex::new(None))
}

fn sha_resolve_backoff_cell() -> &'static Mutex<Option<Instant>> {
    REGISTRY_SHA_RESOLVE_BACKOFF_UNTIL.get_or_init(|| Mutex::new(None))
}

fn marketplace_dir() -> Result<PathBuf> {
    Ok(crate::storage::paths::app_storage_dir()?.join("plugin-market"))
}

fn registry_cache_path() -> Result<PathBuf> {
    Ok(marketplace_dir()?.join("registry.json"))
}

fn cached_registry_from_memory() -> Option<String> {
    let guard = memory_cache().lock().ok()?;
    let (stored_at, text) = guard.as_ref()?;
    (stored_at.elapsed() < REGISTRY_CACHE_TTL).then(|| text.clone())
}

fn store_registry_memory_cache(text: &str) {
    if let Ok(mut guard) = memory_cache().lock() {
        *guard = Some((Instant::now(), text.to_string()));
    }
}

fn store_registry_disk_cache(text: &str) {
    let Ok(path) = registry_cache_path() else {
        return;
    };
    if let Some(parent) = path.parent() {
        if fs::create_dir_all(parent).is_err() {
            return;
        }
    }
    let _ = fs::write(&path, text);
}

fn read_registry_disk_cache() -> Option<String> {
    let path = registry_cache_path().ok()?;
    fs::read_to_string(&path)
        .ok()
        .filter(|text| !text.trim().is_empty())
}

fn build_blocking_client() -> Result<reqwest::blocking::Client> {
    let proxy = crate::api::http_client::load_proxy_config_sync().unwrap_or_default();
    let builder = reqwest::blocking::Client::builder()
        .user_agent(crate::api::http_client::app_user_agent())
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(120));
    let builder = proxy.apply_blocking(builder)?;
    builder
        .build()
        .map_err(|error| Error::from_reason(format!("Failed to create HTTP client: {error}")))
}

fn fetch_registry_source(url: &str) -> std::result::Result<String, String> {
    let client = build_blocking_client().map_err(|error| error.to_string())?;
    let response = client
        .get(url)
        .send()
        .map_err(|error| format!("{url}: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("{url}: HTTP {}", response.status().as_u16()));
    }
    let text = response
        .text()
        .map_err(|error| format!("{url}: {error}"))?;
    let parsed: serde_json::Value =
        serde_json::from_str(&text).map_err(|error| format!("{url}: invalid JSON ({error})"))?;
    if !parsed
        .get("plugins")
        .map(serde_json::Value::is_array)
        .unwrap_or(false)
    {
        return Err(format!("{url}: response is missing the plugins array"));
    }
    Ok(text)
}

/// 校验字符串是否为 40 位十六进制 commit SHA。
fn is_commit_sha(value: &str) -> bool {
    value.len() == 40 && value.chars().all(|character| character.is_ascii_hexdigit())
}

/// 通过 GitHub commits API 解析索引仓库 main 分支最新 commit SHA。
fn resolve_sha_via_github_api(client: &reqwest::blocking::Client) -> Option<String> {
    let response = client
        .get(MARKET_REGISTRY_COMMIT_API)
        .timeout(REGISTRY_SHA_RESOLVE_TIMEOUT)
        .send()
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let body = response.text().ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&body).ok()?;
    let sha = parsed.get("sha")?.as_str()?.trim().to_string();
    is_commit_sha(&sha).then_some(sha)
}

/// 通过 commits atom 订阅源解析最新 commit SHA（API 不可用时的备用通道）。
fn resolve_sha_via_commits_atom(client: &reqwest::blocking::Client) -> Option<String> {
    let response = client
        .get(MARKET_REGISTRY_COMMIT_ATOM)
        .timeout(REGISTRY_SHA_RESOLVE_TIMEOUT)
        .send()
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let body = response.text().ok()?;
    let marker = "Grit::Commit/";
    let marker_index = body.find(marker)?;
    let sha: String = body[marker_index + marker.len()..].chars().take(40).collect();
    is_commit_sha(&sha).then_some(sha)
}

/// 解析索引仓库最新 commit SHA；失败后短时间退避，避免不可达网络下反复等待。
fn resolve_registry_commit_sha() -> Option<String> {
    if let Ok(guard) = sha_resolve_backoff_cell().lock() {
        if let Some(until) = *guard {
            if Instant::now() < until {
                return None;
            }
        }
    }

    let sha = build_blocking_client().ok().and_then(|client| {
        resolve_sha_via_github_api(&client).or_else(|| resolve_sha_via_commits_atom(&client))
    });

    if let Ok(mut guard) = sha_resolve_backoff_cell().lock() {
        *guard = sha
            .is_none()
            .then(|| Instant::now() + REGISTRY_SHA_RESOLVE_BACKOFF);
    }
    sha
}

/// 内容寻址的索引候选地址：按 commit SHA 直链拉取不可变文件，
/// CDN 不会返回陈旧的分支引用缓存。
fn commit_addressed_sources(sha: &str) -> [String; 2] {
    [
        format!("{MARKET_REGISTRY_RAW_PREFIX}{sha}/app/registry.json"),
        format!("{MARKET_REGISTRY_CDN_PREFIX}{sha}/app/registry.json"),
    ]
}

/// 构造 jsDelivr 镜像的缓存清理地址（purge）：
/// `https://cdn.jsdelivr.net/{path}` -> `https://purge.jsdelivr.net/{path}`。
fn jsdelivr_purge_url(cdn_url: &str) -> Option<String> {
    let path = cdn_url.strip_prefix("https://cdn.jsdelivr.net/")?;
    Some(format!("https://purge.jsdelivr.net/{path}"))
}

/// 清理 jsDelivr 镜像缓存；返回 true 表示该地址随后的拉取不会再命中镜像旧缓存。
fn purge_jsdelivr_cache(cdn_url: &str) -> bool {
    let Some(purge_url) = jsdelivr_purge_url(cdn_url) else {
        return false;
    };
    let Ok(client) = build_blocking_client() else {
        return false;
    };
    let Ok(response) = client
        .get(&purge_url)
        .timeout(Duration::from_secs(10))
        .send()
    else {
        return false;
    };
    if !response.status().is_success() {
        return false;
    }
    let Ok(body) = response.text() else {
        return false;
    };
    // jsDelivr 对同一路径的 purge 有频率限制：被限流时同样返回
    // status=finished，但 paths 下会带 throttled=true，此时缓存并未清理。
    serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .map(|value| {
            let finished = value
                .get("status")
                .and_then(serde_json::Value::as_str)
                .map(|status| status == "finished")
                .unwrap_or(false);
            let throttled = value
                .get("paths")
                .and_then(serde_json::Value::as_object)
                .map(|paths| {
                    paths.values().any(|entry| {
                        entry
                            .get("throttled")
                            .and_then(serde_json::Value::as_bool)
                            .unwrap_or(false)
                    })
                })
                .unwrap_or(false);
            finished && !throttled
        })
        .unwrap_or(false)
}

/// 拉取插件市场索引 JSON 文本（带内存 / 磁盘缓存与镜像降级）。
///
/// 索引文件更新后分支引用地址会被 CDN 缓存数分钟到数小时（GitHub raw
/// 约 5 分钟、jsDelivr 最长 12 小时），因此优先解析最新 commit SHA 并按
/// SHA 直链拉取不可变文件；解析失败时回退分支引用地址（`force_refresh`
/// 为 true 时先清理 jsDelivr 镜像缓存并把清理成功的镜像提到候选首位）。
pub fn fetch_registry_blocking(force_refresh: bool) -> Result<String> {
    if !force_refresh {
        if let Some(text) = cached_registry_from_memory() {
            return Ok(text);
        }
    }

    let mut last_error = String::new();

    if let Some(sha) = resolve_registry_commit_sha() {
        for source in commit_addressed_sources(&sha) {
            match fetch_registry_source(&source) {
                Ok(text) => {
                    store_registry_memory_cache(&text);
                    store_registry_disk_cache(&text);
                    return Ok(text);
                }
                Err(error) => last_error = error,
            }
        }
    }

    let mut sources: Vec<&str> = MARKET_REGISTRY_SOURCES.to_vec();
    if force_refresh {
        let mirrored = sources
            .iter()
            .position(|source| jsdelivr_purge_url(source).is_some());
        if let Some(index) = mirrored {
            if purge_jsdelivr_cache(sources[index]) {
                let source = sources.remove(index);
                sources.insert(0, source);
            }
        }
    }

    for source in sources {
        match fetch_registry_source(source) {
            Ok(text) => {
                store_registry_memory_cache(&text);
                store_registry_disk_cache(&text);
                return Ok(text);
            }
            Err(error) => last_error = error,
        }
    }

    if let Some(text) = read_registry_disk_cache() {
        store_registry_memory_cache(&text);
        return Ok(text);
    }

    Err(Error::from_reason(format!(
        "Failed to fetch the plugin market index. Last error: {last_error}"
    )))
}

fn download_to_file(
    client: &reqwest::blocking::Client,
    url: &str,
    destination: &Path,
    max_bytes: u64,
    label: &str,
) -> Result<()> {
    let mut response = client.get(url).send().map_err(|error| {
        Error::from_reason(format!("Failed to download {label}: {error}"))
    })?;
    if !response.status().is_success() {
        return Err(Error::from_reason(format!(
            "Failed to download {label}: HTTP {}",
            response.status().as_u16()
        )));
    }
    if let Some(length) = response.content_length() {
        if length > max_bytes {
            return Err(Error::from_reason(format!(
                "The {label} exceeds the {} MB limit",
                max_bytes / (1024 * 1024)
            )));
        }
    }

    let mut file = fs::File::create(destination)
        .map_err(|error| Error::from_reason(format!("Failed to create the {label} file: {error}")))?;
    let mut buffer = [0u8; 64 * 1024];
    let mut total: u64 = 0;
    loop {
        let read = response
            .read(&mut buffer)
            .map_err(|error| Error::from_reason(format!("Failed to read the {label}: {error}")))?;
        if read == 0 {
            break;
        }
        total += read as u64;
        if total > max_bytes {
            return Err(Error::from_reason(format!(
                "The {label} exceeds the {} MB limit",
                max_bytes / (1024 * 1024)
            )));
        }
        file.write_all(&buffer[..read])
            .map_err(|error| Error::from_reason(format!("Failed to write the {label}: {error}")))?;
    }
    Ok(())
}

/// 将 GitHub raw 直链映射为 jsDelivr 镜像（仅对 raw.githubusercontent.com 生效）：
/// `https://raw.githubusercontent.com/{owner}/{repo}/{ref}/{path...}`
/// -> `https://cdn.jsdelivr.net/gh/{owner}/{repo}@{ref}/{path...}`
fn raw_github_mirror_url(url: &str) -> Option<String> {
    let rest = url.strip_prefix("https://raw.githubusercontent.com/")?;
    let mut segments = rest.splitn(4, '/');
    let owner = segments.next().filter(|segment| !segment.is_empty())?;
    let repo = segments.next().filter(|segment| !segment.is_empty())?;
    let reference = segments.next().filter(|segment| !segment.is_empty())?;
    let path = segments.next().filter(|segment| !segment.is_empty())?;
    Some(format!(
        "https://cdn.jsdelivr.net/gh/{owner}/{repo}@{reference}/{path}"
    ))
}

/// 下载文件；主地址失败且为 GitHub raw 直链时，自动改用 jsDelivr 镜像重试一次。
fn download_with_mirror(
    client: &reqwest::blocking::Client,
    url: &str,
    destination: &Path,
    max_bytes: u64,
    label: &str,
) -> Result<()> {
    match download_to_file(client, url, destination, max_bytes, label) {
        Ok(()) => Ok(()),
        Err(primary_error) => {
            let Some(mirror) = raw_github_mirror_url(url) else {
                return Err(primary_error);
            };
            download_to_file(client, &mirror, destination, max_bytes, label).map_err(
                |mirror_error| {
                    Error::from_reason(format!(
                        "{primary_error}; jsDelivr mirror also failed: {mirror_error}"
                    ))
                },
            )
        }
    }
}

fn sha256_file_hex(path: &Path) -> Result<String> {
    use sha2::{Digest, Sha256};

    let mut file = fs::File::open(path).map_err(|error| {
        Error::from_reason(format!("Failed to open the plugin archive: {error}"))
    })?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher).map_err(|error| {
        Error::from_reason(format!("Failed to hash the plugin archive: {error}"))
    })?;
    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

fn extract_archive(archive_path: &Path, target_dir: &Path) -> Result<()> {
    let file = fs::File::open(archive_path).map_err(|error| {
        Error::from_reason(format!("Failed to open the plugin archive: {error}"))
    })?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|error| Error::from_reason(format!("Failed to read the plugin archive: {error}")))?;

    let mut total_uncompressed: u64 = 0;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|error| {
            Error::from_reason(format!("Failed to read a plugin archive entry: {error}"))
        })?;
        let Some(relative) = entry.enclosed_name() else {
            continue;
        };
        let destination = target_dir.join(&relative);
        if entry.is_dir() {
            fs::create_dir_all(&destination).map_err(|error| {
                Error::from_reason(format!("Failed to create plugin directory: {error}"))
            })?;
            continue;
        }
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                Error::from_reason(format!("Failed to create plugin directory: {error}"))
            })?;
        }
        let mut output = fs::File::create(&destination).map_err(|error| {
            Error::from_reason(format!("Failed to extract a plugin file: {error}"))
        })?;
        let mut entry_buffer = [0u8; 64 * 1024];
        loop {
            let read = entry.read(&mut entry_buffer).map_err(|error| {
                Error::from_reason(format!("Failed to extract a plugin file: {error}"))
            })?;
            if read == 0 {
                break;
            }
            total_uncompressed += read as u64;
            if total_uncompressed > MAX_PLUGIN_EXTRACT_BYTES {
                return Err(Error::from_reason(
                    "Plugin archive expands beyond the supported size".to_string(),
                ));
            }
            output.write_all(&entry_buffer[..read]).map_err(|error| {
                Error::from_reason(format!("Failed to extract a plugin file: {error}"))
            })?;
        }
    }
    Ok(())
}

/// 定位解压后的插件根目录：根目录直接含 plugin.json，或唯一的顶层子目录含之。
fn locate_plugin_root(extract_dir: &Path) -> Option<PathBuf> {
    if extract_dir.join("plugin.json").is_file() {
        return Some(extract_dir.to_path_buf());
    }
    let entries = fs::read_dir(extract_dir).ok()?;
    let mut candidates: Vec<PathBuf> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() && path.join("plugin.json").is_file() {
            candidates.push(path);
        }
    }
    if candidates.len() == 1 {
        candidates.pop()
    } else {
        None
    }
}

fn read_archive_plugin_id(plugin_root: &Path) -> Result<String> {
    let manifest_path = plugin_root.join("plugin.json");
    let raw = fs::read_to_string(&manifest_path).map_err(|error| {
        Error::from_reason(format!("Failed to read plugin.json from the archive: {error}"))
    })?;
    let parsed: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|error| Error::from_reason(format!("Invalid plugin.json in the archive: {error}")))?;
    Ok(parsed
        .get("id")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_string())
}

fn install_from_archive(
    plugin_id: &str,
    download_url: &str,
    expected_sha256: &str,
    source_url: &str,
    work_dir: &Path,
) -> Result<PluginRecord> {
    let client = build_blocking_client()?;
    let archive_path = work_dir.join("plugin.zip");
    download_with_mirror(
        &client,
        download_url,
        &archive_path,
        MAX_PLUGIN_ARCHIVE_BYTES,
        "plugin archive",
    )?;

    let actual_sha256 = sha256_file_hex(&archive_path)?;
    if actual_sha256 != expected_sha256 {
        return Err(Error::from_reason(format!(
            "Plugin archive SHA256 mismatch (expected {expected_sha256}, got {actual_sha256})"
        )));
    }

    let extract_dir = work_dir.join("extract");
    fs::create_dir_all(&extract_dir).map_err(|error| {
        Error::from_reason(format!("Failed to create the extraction directory: {error}"))
    })?;
    extract_archive(&archive_path, &extract_dir)?;

    let plugin_root = locate_plugin_root(&extract_dir).ok_or_else(|| {
        Error::from_reason("plugin.json was not found in the downloaded archive".to_string())
    })?;
    let archive_id = read_archive_plugin_id(&plugin_root)?;
    if archive_id != plugin_id {
        return Err(Error::from_reason(format!(
            "Plugin archive id '{archive_id}' does not match the market entry '{plugin_id}'"
        )));
    }

    let database_path = crate::storage::ensure_database_file()?;
    crate::storage::install_plugin_with_source(
        &database_path,
        &plugin_root.to_string_lossy(),
        source_url,
    )
}

/// 从插件市场安装（或更新）插件（blocking）。
/// `download_url` 为 zip 直链，`sha256` 为市场索引锁定的归档哈希，
/// `source_url` 为插件仓库地址（写入 source_path 供更新检查）。
pub fn install_from_market_blocking(
    plugin_id: &str,
    download_url: &str,
    sha256: &str,
    source_url: &str,
) -> Result<PluginRecord> {
    let plugin_id = plugin_id.trim();
    let download_url = download_url.trim();
    let source_url = source_url.trim();
    let expected_sha256 = sha256.trim().to_ascii_lowercase();

    if plugin_id.is_empty() {
        return Err(Error::from_reason("Plugin id is required".to_string()));
    }
    if !download_url.starts_with("https://") {
        return Err(Error::from_reason(
            "Plugin download URL must use https".to_string(),
        ));
    }
    if expected_sha256.len() != 64
        || !expected_sha256
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        return Err(Error::from_reason(
            "Plugin archive SHA256 is invalid".to_string(),
        ));
    }
    if !source_url.starts_with("https://") {
        return Err(Error::from_reason(
            "Plugin source URL must use https".to_string(),
        ));
    }

    let work_root = marketplace_dir()?.join("tmp");
    fs::create_dir_all(&work_root).map_err(|error| {
        Error::from_reason(format!("Failed to create the market temp directory: {error}"))
    })?;
    let work_dir = work_root.join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(&work_dir).map_err(|error| {
        Error::from_reason(format!("Failed to create the market temp directory: {error}"))
    })?;

    let result = install_from_archive(
        plugin_id,
        download_url,
        &expected_sha256,
        source_url,
        &work_dir,
    );
    let _ = fs::remove_dir_all(&work_dir);
    result
}

fn install_script_from_market_internal(
    script_id: &str,
    download_url: &str,
    expected_sha256: &str,
    work_dir: &Path,
) -> Result<UserscriptRecord> {
    let client = build_blocking_client()?;
    let script_path = work_dir.join("script.user.js");
    download_with_mirror(
        &client,
        download_url,
        &script_path,
        MAX_USERSCRIPT_BYTES,
        "userscript",
    )?;

    let actual_sha256 = sha256_file_hex(&script_path)?;
    if actual_sha256 != expected_sha256 {
        return Err(Error::from_reason(format!(
            "Userscript SHA256 mismatch (expected {expected_sha256}, got {actual_sha256})"
        )));
    }

    let raw = fs::read_to_string(&script_path)
        .map_err(|error| Error::from_reason(format!("Failed to read the userscript: {error}")))?;
    if !raw.contains("==UserScript==") {
        return Err(Error::from_reason(
            "Downloaded file is not a userscript".to_string(),
        ));
    }

    let database_path = crate::storage::ensure_database_file()?;
    crate::storage::install_market_userscript(&database_path, script_id, &raw)
}

/// 从插件市场安装（或更新）用户脚本（blocking）。
/// `download_url` 为 .user.js 直链，`sha256` 为市场索引锁定的文件哈希。
pub fn install_script_from_market_blocking(
    script_id: &str,
    download_url: &str,
    sha256: &str,
) -> Result<UserscriptRecord> {
    let script_id = script_id.trim();
    let download_url = download_url.trim();
    let expected_sha256 = sha256.trim().to_ascii_lowercase();

    if script_id.is_empty() {
        return Err(Error::from_reason("Userscript id is required".to_string()));
    }
    if !download_url.starts_with("https://") {
        return Err(Error::from_reason(
            "Userscript download URL must use https".to_string(),
        ));
    }
    if expected_sha256.len() != 64
        || !expected_sha256
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        return Err(Error::from_reason(
            "Userscript SHA256 is invalid".to_string(),
        ));
    }

    let work_root = marketplace_dir()?.join("tmp");
    fs::create_dir_all(&work_root).map_err(|error| {
        Error::from_reason(format!("Failed to create the market temp directory: {error}"))
    })?;
    let work_dir = work_root.join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(&work_dir).map_err(|error| {
        Error::from_reason(format!("Failed to create the market temp directory: {error}"))
    })?;

    let result =
        install_script_from_market_internal(script_id, download_url, &expected_sha256, &work_dir);
    let _ = fs::remove_dir_all(&work_dir);
    result
}
