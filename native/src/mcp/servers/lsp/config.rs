//! 配置加载：从 lsp_server_configs 表读取并解析。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use napi::bindgen_prelude::*;
use serde_json::Value;

use super::super::remote_workspace::is_ssh_path;
use super::types::ServerConfig;
use crate::storage::services::workspace_directories::get_workspace_directory_path;

/// collect 阶段工具暴露与 description 摘要（一次配置读取 + 一次探测循环）。
pub struct LspToolExposure {
    pub tools: Vec<String>,
    pub summary: Option<String>,
}

/// 探测结果 TTL 缓存：`collect_all_mcp_tools` 每轮对话都会执行（工具列表
/// 要发给模型），PATH 扫描有真实 stat 成本（Windows 上 PATHEXT × PATH 目录
/// 每命令可达上百次），短 TTL 避免每轮重复全量扫描；配置热更新后最多 10s
/// 内反映新状态，可接受。
const PROBE_TTL: Duration = Duration::from_secs(10);
static PROBE_CACHE: OnceLock<Mutex<HashMap<String, (bool, Instant)>>> = OnceLock::new();

/// 命令安装探测（带 TTL 缓存）。pub(crate)：collect 阶段（tool_exposure）
/// 与系统提示词构建（build_system_prompt_section）复用同一缓存，避免每轮
/// 请求重复全量 PATH 扫描。
pub(crate) fn is_command_installed_cached(command: &str) -> bool {
    let cache = PROBE_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let now = Instant::now();
    {
        let guard = cache.lock().expect("probe cache poisoned");
        if let Some((installed, at)) = guard.get(command) {
            if now.duration_since(*at) < PROBE_TTL {
                return *installed;
            }
        }
    }
    let installed = super::probe::is_command_installed(command);
    cache
        .lock()
        .expect("probe cache poisoned")
        .insert(command.to_string(), (installed, now));
    installed
}

/// 从表加载有效语言服务器配置（项目配置覆盖全局同 lang，§8.5；
/// spawn_blocking 包裹，不阻塞 Node 主线程）。
pub async fn load_configs(project_id: Option<&str>) -> napi::Result<Vec<ServerConfig>> {
    let project_id = project_id.map(str::to_string);
    tokio::task::spawn_blocking(move || {
        let records = crate::storage::list_effective_lsp_server_configs(project_id)?;
        Ok(records.into_iter().filter_map(|record| parse_record(record).ok()).collect())
    })
    .await
    .map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to load LSP server configs: {error}"),
        )
    })?
}

/// 工具暴露与 description 摘要（collect 阶段一次性计算，§8.0/§8.7）。
///
/// `project_id` 决定按哪个作用域的有效配置判断（项目配置覆盖全局同 lang，
/// §8.5）——与工具调用阶段一致：全局未配置但项目级配置了服务器时，
/// lsp-* 工具照常暴露；项目覆盖禁用时对应能力不再暴露。
///
/// 项目感知（§8.7.2）：`lsp-type-hierarchy` 仅 go/java 服务器支持，除能力
/// 条件外还要求当前项目根目录检测到 Go/Java 技术栈（detect.rs 深度 ≤2 扫描
/// go.mod / pom.xml / build.gradle(.kts)），否则不暴露——避免在无关项目里
/// 诱导 AI 安装 gopls/jdtls（2026-08-15 用户反馈）。
///
/// 单次配置读取 + 单次探测循环（TTL 缓存），避免每轮 collect 重复 DB 读
/// 与 PATH 全量扫描。返回完整工具名（`lsp-` 前缀），保序去重（prompt
/// cache 红线：工具列表顺序稳定）。
pub async fn tool_exposure(project_id: Option<&str>) -> napi::Result<LspToolExposure> {
    // 项目根：SSH 过滤 + 语言一致性过滤用；无项目上下文 / 查询失败 → None
    //（跳过这两项过滤，与全局工具暴露行为一致）。
    let project_root = resolve_project_root_str(project_id).await?;
    // SSH 远程项目：lsp 仅支持本地项目，不暴露任何 lsp-* 工具（调用必然
    // RemoteNotSupported，避免误导 AI 尝试必然失败的调用）。
    if project_root.as_deref().is_some_and(is_ssh_path) {
        return Ok(LspToolExposure {
            tools: Vec::new(),
            summary: None,
        });
    }

    let mut tools: Vec<String> = Vec::new();
    let mut parts: Vec<String> = Vec::new();
    for config in load_configs(project_id).await? {
        // 无效配置（未启用 / 扩展名为空永不匹配 / 命令未安装）不暴露。
        if !config.enabled
            || config.file_extensions.is_empty()
            || !is_command_installed_cached(&config.command)
        {
            continue;
        }
        // 项目语言一致性（2026-08-15）：有项目根时只暴露与项目实际语言
        // 匹配的服务器——项目无编程语言、或服务器语言与项目不一致时不
        // 暴露（与系统提示词注入共用 server_matches_project，单一事实
        // 来源，检测结果走 60s TTL 缓存）。
        if let Some(ref root) = project_root {
            if !super::server_matches_project(&config, std::path::Path::new(root)) {
                continue;
            }
        }
        for tool in super::capabilities::supported_tools_for_lang(&config.lang) {
            let full = format!("lsp-{tool}");
            if !tools.contains(&full) {
                tools.push(full);
            }
        }
        parts.push(format!("{} ({})", config.lang, config.command));
    }
    // §8.7.2 项目感知过滤：type-hierarchy 仅 go/java 支持，当前项目检测不到
    // 对应技术栈（或无项目上下文/SSH 远程）时移除，避免无关项目暴露该工具。
    if tools.iter().any(|t| t == "lsp-type-hierarchy")
        && !project_has_lang_stack(project_id, &["go", "java"]).await?
    {
        tools.retain(|t| t != "lsp-type-hierarchy");
    }
    let summary = if parts.is_empty() {
        None
    } else {
        Some(format!("Enabled language servers: {}", parts.join(", ")))
    };
    Ok(LspToolExposure { tools, summary })
}

/// 解析项目根目录（workspace_directories 表）；无 project_id / 查不到 /
/// 查询失败 → None（调用方跳过 SSH 与语言一致性过滤，与 collect 全局
/// 工具暴露行为一致，不因 LSP 状态打挂工具列表收集）。
async fn resolve_project_root_str(project_id: Option<&str>) -> napi::Result<Option<String>> {
    let Some(pid) = project_id.map(str::trim).filter(|p| !p.is_empty()) else {
        return Ok(None);
    };
    let pid = pid.to_string();
    match tokio::task::spawn_blocking(move || -> napi::Result<Option<String>> {
        let Ok(storage_info) = crate::storage::initialize_app_storage() else {
            return Ok(None);
        };
        let database_path = std::path::PathBuf::from(storage_info.database_path);
        Ok(get_workspace_directory_path(&database_path, &pid)
            .ok()
            .flatten())
    })
    .await
    {
        Ok(result) => result,
        Err(error) => {
            // join 失败（闭包 panic/任务取消，实际几乎不发生）：按 M3 降级
            // 原则返回 None 跳过过滤，不因 LSP 状态打挂整个工具列表收集；
            // 原因写入应用日志（app_logs 表）。
            super::lsp_app_log(
                "warn",
                "resolve_project_root_str",
                "project root join failed, skipping SSH/language filters",
                Some(&error.to_string()),
            )
            .await;
            Ok(None)
        }
    }
}

/// §8.7.2 项目感知辅助：解析项目根目录（workspace_directories 表），用
/// `detect_project_stack`（深度 ≤2，跳过 node_modules/.git/target 等）检测
/// 技术栈，命中任一目标语言返回 true。无 project_id / 查不到根目录 / SSH
/// 远程 / 目录不可读 → false（保守不暴露；lsp 本身仅本地项目可用）。
async fn project_has_lang_stack(
    project_id: Option<&str>,
    langs: &[&str],
) -> napi::Result<bool> {
    let Some(pid) = project_id.filter(|p| !p.trim().is_empty()) else {
        return Ok(false);
    };
    let pid = pid.to_string();
    let langs: Vec<String> = langs.iter().map(|s| s.to_string()).collect();
    tokio::task::spawn_blocking(move || {
        // M3：DB/FS 瞬时故障必须降级为「不暴露」（Ok(false)），不得 `?` 传播
        // 打挂整个工具列表收集（collect_all_mcp_tools 每轮对话都会执行）。
        let Ok(storage_info) = crate::storage::initialize_app_storage() else {
            eprintln!(
                "[lsp] project_has_lang_stack: initialize_app_storage 失败，降级为不暴露 type-hierarchy 工具"
            );
            return Ok(false);
        };
        let database_path = PathBuf::from(storage_info.database_path);
        let Some(root) = get_workspace_directory_path(&database_path, &pid).ok().flatten() else {
            eprintln!(
                "[lsp] project_has_lang_stack: 查询项目根目录失败（project {pid}），降级为不暴露 type-hierarchy 工具"
            );
            return Ok(false);
        };
        if is_ssh_path(&root) {
            return Ok(false);
        }
        let detected = super::detect::detect_project_stack(&root);
        Ok(detected.iter().any(|d| langs.iter().any(|l| l == &d.lang)))
    })
    .await
    .map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to detect project stack: {error}"),
        )
    })?
}

/// 按文件扩展名匹配语言配置。
pub fn match_config<'a>(
    configs: &'a [ServerConfig],
    file_path: &Path,
) -> Option<(&'a ServerConfig, &'a str)> {
    let ext = file_path.extension()?.to_str()?.to_ascii_lowercase();
    configs
        .iter()
        .find(|config| {
            config.enabled
                && config
                    .file_extensions
                    .iter()
                    .any(|e| e.trim_start_matches('.').to_ascii_lowercase() == ext)
        })
        .map(|config| (config, config.lang.as_str()))
}

/// 解析表记录为 ServerConfig（JSON 字段解析失败时回退默认值）。
fn parse_record(record: crate::storage::LspServerConfigRecord) -> napi::Result<ServerConfig> {
    let args: Vec<String> = serde_json::from_str(&record.args_json).unwrap_or_default();
    let file_extensions: Vec<String> =
        serde_json::from_str(&record.file_extensions_json).unwrap_or_default();
    let initialization_options: Option<Value> = record
        .initialization_options_json
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok());
    Ok(ServerConfig {
        lang: record.lang,
        command: record.command,
        args,
        file_extensions,
        install_command: record.install_command,
        initialization_options,
        enabled: record.enabled,
    })
}
