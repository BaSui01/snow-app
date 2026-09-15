//! config 服务 `privacy` 作用域：隐私过滤设置（单例）。
//!
//! 真源是 system_settings 的 `privacy_settings`（与 UI「隐私」设置页同源）：
//! `{enabled, mode, api:{url, apiKey, model}, toolResults:{tools}}`。
//!
//! - `mode`：`local`（本地过滤）或 `api`（调用外部脱敏服务）。
//! - `api.apiKey`：读取时掩码；写入时省略或传空字符串表示**保留旧值**
//!   （与 apiProfiles 域一致），避免 AI 用占位符覆盖真实密钥。
//! - `toolResults.tools`：需要脱敏的工具名单，提供时整体替换。
//!
//! ⚠️ 启用后工具结果会经过隐私过滤（本地或远端），会改变后续请求内容；
//! 本域不提供 delete（用 `enabled=false` 关闭）。

use std::path::Path;

use napi::bindgen_prelude::*;
use serde_json::{json, Value};

use crate::storage::services::system_settings::PrivacySettings;

const TOOL_GET: &str = "get";
const TOOL_SET: &str = "set";
const TOOL_DELETE: &str = "delete";

const PRIVACY_KEY: &str = "settings";
const SUPPORTED_MODES: &[&str] = &["local", "api"];

fn mask_secret(value: &str) -> Value {
    let chars: Vec<char> = value.chars().collect();
    if chars.is_empty() {
        return json!("");
    }
    if chars.len() <= 8 {
        return json!("****");
    }
    let head: String = chars[..4].iter().collect();
    let tail: String = chars[chars.len() - 4..].iter().collect();
    json!(format!("{head}****{tail}"))
}

fn settings_view(settings: &PrivacySettings) -> Value {
    json!({
        "enabled": settings.enabled,
        "mode": settings.mode,
        "api": {
            "url": settings.api.url,
            "apiKey": mask_secret(&settings.api.api_key),
            "model": settings.api.model,
        },
        "toolResults": {
            "tools": settings.tool_results.tools,
        },
    })
}

fn apply_settings(value: &Value) -> Result<Value> {
    let Some(patch) = value.as_object() else {
        return Err(Error::new(
            Status::InvalidArg,
            "privacy value must be an object like { enabled: true, mode: \"local\", toolResults: { tools: [...] } }"
                .to_string(),
        ));
    };

    let mut settings = crate::storage::get_privacy_settings()?;

    if let Some(enabled) = patch.get("enabled") {
        settings.enabled = enabled.as_bool().ok_or_else(|| {
            Error::new(Status::InvalidArg, "enabled must be a boolean".to_string())
        })?;
    }

    if let Some(mode) = patch.get("mode") {
        let mode = mode
            .as_str()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                Error::new(
                    Status::InvalidArg,
                    "mode must be a non-empty string".to_string(),
                )
            })?;
        if !SUPPORTED_MODES.contains(&mode) {
            return Err(Error::new(
                Status::InvalidArg,
                format!("mode must be one of: {}", SUPPORTED_MODES.join(", ")),
            ));
        }
        settings.mode = mode.to_string();
    }

    if let Some(api) = patch.get("api") {
        let api = api.as_object().ok_or_else(|| {
            Error::new(Status::InvalidArg, "api must be an object".to_string())
        })?;
        if let Some(url) = api.get("url") {
            settings.api.url = url
                .as_str()
                .map(str::trim)
                .unwrap_or_default()
                .to_string();
        }
        if let Some(model) = api.get("model") {
            settings.api.model = model
                .as_str()
                .map(str::trim)
                .unwrap_or_default()
                .to_string();
        }
        match api.get("apiKey").and_then(Value::as_str).map(str::trim) {
            // 省略或空白 = 保留旧密钥，避免用占位符覆盖真实值。
            None | Some("") => {}
            Some(api_key) => settings.api.api_key = api_key.to_string(),
        }
    }

    if let Some(tool_results) = patch.get("toolResults") {
        let tool_results = tool_results.as_object().ok_or_else(|| {
            Error::new(Status::InvalidArg, "toolResults must be an object".to_string())
        })?;
        if let Some(tools) = tool_results.get("tools") {
            let tools = tools.as_array().ok_or_else(|| {
                Error::new(
                    Status::InvalidArg,
                    "toolResults.tools must be an array of tool names".to_string(),
                )
            })?;
            let mut names = Vec::new();
            for item in tools {
                let name = item
                    .as_str()
                    .map(str::trim)
                    .filter(|name| !name.is_empty())
                    .ok_or_else(|| {
                        Error::new(
                            Status::InvalidArg,
                            "toolResults.tools must be an array of tool names".to_string(),
                        )
                    })?;
                names.push(name.to_string());
            }
            settings.tool_results.tools = names;
        }
    }

    crate::storage::set_privacy_settings(settings.clone())?;

    Ok(json!({
        "scope": "privacy",
        "key": PRIVACY_KEY,
        "value": settings_view(&settings),
    }))
}

/// Dispatches `config-list/get/set/delete` for the `privacy` scope.
pub(crate) fn execute_privacy_scope(
    tool_name: &str,
    args: &Value,
    _db_path: &Path,
) -> Result<Value> {
    match tool_name {
        "list" => Ok(json!({
            "scope": "privacy",
            "file": null,
            "keys": [{
                "key": PRIVACY_KEY,
                "type": "object",
                "sensitive": true,
                "configured": true,
                "value": settings_view(&crate::storage::get_privacy_settings()?),
            }],
        })),
        TOOL_GET => {
            let key = args.get("key").and_then(Value::as_str).unwrap_or("");
            if key != PRIVACY_KEY {
                return Err(Error::new(
                    Status::InvalidArg,
                    format!("privacy only defines the key \"{PRIVACY_KEY}\""),
                ));
            }
            Ok(json!({
                "scope": "privacy",
                "key": key,
                "value": settings_view(&crate::storage::get_privacy_settings()?),
            }))
        }
        TOOL_SET => {
            let key = args.get("key").and_then(Value::as_str).unwrap_or("");
            if key != PRIVACY_KEY {
                return Err(Error::new(
                    Status::InvalidArg,
                    format!("privacy only defines the key \"{PRIVACY_KEY}\""),
                ));
            }
            let value = args.get("value").cloned().ok_or_else(|| {
                Error::new(
                    Status::InvalidArg,
                    "value is required for config-set".to_string(),
                )
            })?;
            apply_settings(&value)
        }
        TOOL_DELETE => Err(Error::new(
            Status::InvalidArg,
            "privacy does not support delete; use config-set with {\"enabled\": false} to turn filtering off"
                .to_string(),
        )),
        other => Err(Error::new(
            Status::InvalidArg,
            format!("Unsupported config tool for scope privacy: {other}"),
        )),
    }
}
