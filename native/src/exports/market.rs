use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::storage::{PluginRecord, UserscriptRecord};

/// 拉取插件市场索引 JSON 文本（Rust 侧负责镜像降级与缓存）。
///
/// `forceRefresh` 为 true 时跳过内存缓存直接请求网络；网络失败时回退到
/// 最近一次成功写入磁盘的缓存。
#[napi]
pub async fn fetch_plugin_registry(force_refresh: Option<bool>) -> napi::Result<String> {
    let force_refresh = force_refresh.unwrap_or(false);
    tokio::task::spawn_blocking(move || {
        crate::plugin_market::fetch_registry_blocking(force_refresh)
    })
    .await
    .map_err(|error| Error::from_reason(format!("Fetch plugin registry task failed: {error}")))?
}

/// 从插件市场下载并安装（或更新）插件：
/// zip 下载 -> SHA256 校验 -> 解压 -> 校验 plugin.json id -> 存储层安装。
#[napi]
pub async fn install_plugin_from_market(
    plugin_id: String,
    download_url: String,
    sha256: String,
    source_url: String,
) -> napi::Result<PluginRecord> {
    tokio::task::spawn_blocking(move || {
        crate::plugin_market::install_from_market_blocking(
            &plugin_id,
            &download_url,
            &sha256,
            &source_url,
        )
    })
    .await
    .map_err(|error| Error::from_reason(format!("Install plugin from market task failed: {error}")))?
}

/// 从插件市场下载并安装（或更新）用户脚本：.user.js 下载 -> SHA256 校验 -> 写入脚本库。
#[napi]
pub async fn install_script_from_market(
    script_id: String,
    download_url: String,
    sha256: String,
) -> napi::Result<UserscriptRecord> {
    tokio::task::spawn_blocking(move || {
        crate::plugin_market::install_script_from_market_blocking(&script_id, &download_url, &sha256)
    })
    .await
    .map_err(|error| {
        Error::from_reason(format!(
            "Install userscript from market task failed: {error}"
        ))
    })?
}
