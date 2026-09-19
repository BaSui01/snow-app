//! config 服务 `codebase` 作用域：代码库索引配置（全局）+ 项目级索引作用域。
//!
//! 全局（不带 projectId，或显式 `projectId: ""`）：
//!   key = `settings`，真源是 system_settings 的 `codebase_settings`，包含
//!   embedding 模型/密钥/维度、批量与分块参数、reranking 配置，以及 agent
//!   review 选用的决策模型 id（`agentReviewModelId`，空 = 使用基础 LLM 模型；
//!   决策模型自身的 baseUrl / apiKey / model 存在 system_settings 的
//!   `decision_models`，由「API 配置 → 决策模型」页面维护）。本域按
//!   **白名单字段 merge** 写入，未列出的字段原样保留；`embeddingApiKey` /
//!   `rerankingApiKey` 读取时掩码，写入时省略或传空字符串表示保留旧值。
//!
//! 项目级（projectId 非空）：key = `scope`，三态开关
//! `{enabled?, enableAgentReview?, enableReranking?}`——`null` 表示继承全局，
//! 保存在 system_settings 的 `project_codebase_scope_<blake3(projectId)>`。
//!
//! ⚠️ 修改 embedding 模型 / baseUrl / 维度 / 密钥后，已索引的文件不会自动更新，
//! 需要在「代码库」设置页重建索引才会用新配置生效（响应内附同样提示）。

use std::path::Path;

use napi::bindgen_prelude::*;
use serde_json::{json, Map, Value};

use crate::storage::services::system_settings::{
    get_codebase_project_scope_settings, get_system_setting_value,
    set_codebase_project_agent_review, set_codebase_project_enabled,
    set_codebase_project_reranking, set_system_setting, CodebaseProjectScopeSettings,
};

const TOOL_GET: &str = "get";
const TOOL_SET: &str = "set";
const TOOL_DELETE: &str = "delete";

const SETTINGS_KEY: &str = "settings";
const SCOPE_KEY: &str = "scope";

const CODEBASE_SETTING_NAME: &str = "Codebase settings";
const CODEBASE_SETTING_CODE: &str = "codebase_settings";

/// 允许通过本域写入的全局字段（其余字段原样保留）。
const WRITABLE_FIELDS: &[&str] = &[
    "profileName",
    "embeddingType",
    "embeddingModelName",
    "embeddingBaseUrl",
    "embeddingApiKey",
    "embeddingDimensions",
    "batchMaxLines",
    "batchConcurrency",
    "chunkingMaxLinesPerChunk",
    "chunkingMinLinesPerChunk",
    "chunkingMinCharsPerChunk",
    "chunkingOverlapLines",
    "modelContextLength",
    "rerankingModelName",
    "rerankingBaseUrl",
    "rerankingApiKey",
    "rerankingContextLength",
    "rerankingTopN",
    "agentReviewModelId",
    "configJson",
    "source",
];

/// 读取时需要掩码的密钥字段；写入时这些字段的空值表示保留旧值。
const SECRET_FIELDS: &[&str] = &["embeddingApiKey", "rerankingApiKey"];

const REINDEX_NOTE: &str = "Embedding model / baseUrl / dimension / key changes only affect files indexed AFTER the change; rebuild the codebase index in the UI (Codebase settings) for existing files.";

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

fn read_global(db_path: &Path) -> Result<Value> {
    let raw = get_system_setting_value(db_path, CODEBASE_SETTING_CODE)?.unwrap_or_default();
    let parsed = if raw.trim().is_empty() {
        json!({})
    } else {
        serde_json::from_str::<Value>(&raw).map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to parse codebase settings: {error}"),
            )
        })?
    };
    let Some(object) = parsed.as_object() else {
        return Ok(json!({}));
    };

    let mut masked = Map::new();
    for (key, value) in object {
        let masked_value = match (SECRET_FIELDS.contains(&key.as_str()), value.as_str()) {
            (true, Some(text)) => mask_secret(text),
            _ => value.clone(),
        };
        masked.insert(key.clone(), masked_value);
    }
    Ok(Value::Object(masked))
}

fn write_global(db_path: &Path, value: &Value) -> Result<()> {
    let Some(patch) = value.as_object() else {
        return Err(Error::new(
            Status::InvalidArg,
            "codebase settings value must be an object".to_string(),
        ));
    };

    let raw = get_system_setting_value(db_path, CODEBASE_SETTING_CODE)?.unwrap_or_default();
    let mut merged = if raw.trim().is_empty() {
        Map::new()
    } else {
        serde_json::from_str::<Value>(&raw)
            .map_err(|error| {
                Error::new(
                    Status::GenericFailure,
                    format!("Failed to parse codebase settings: {error}"),
                )
            })?
            .as_object()
            .cloned()
            .unwrap_or_default()
    };

    for (key, field_value) in patch {
        if !WRITABLE_FIELDS.contains(&key.as_str()) {
            return Err(Error::new(
                Status::InvalidArg,
                format!(
                    "{key} is not writable in the codebase scope; allowed fields: {}",
                    WRITABLE_FIELDS.join(", ")
                ),
            ));
        }
        if SECRET_FIELDS.contains(&key.as_str()) {
            // 省略/空字符串 = 保留旧密钥，避免用占位符覆盖真实值。
            match field_value.as_str().map(str::trim) {
                None | Some("") => continue,
                Some(secret) => {
                    merged.insert(key.clone(), json!(secret));
                    continue;
                }
            }
        }
        merged.insert(key.clone(), field_value.clone());
    }

    let serialized = serde_json::to_string(&Value::Object(merged)).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to serialize codebase settings: {error}"),
        )
    })?;
    set_system_setting(
        db_path,
        CODEBASE_SETTING_NAME,
        CODEBASE_SETTING_CODE,
        &serialized,
    )
}

fn scope_view(settings: &CodebaseProjectScopeSettings) -> Value {
    json!({
        "projectId": settings.project_id,
        "enabled": settings.enabled,
        "enableAgentReview": settings.enable_agent_review,
        "enableReranking": settings.enable_reranking,
    })
}

fn write_project_scope(db_path: &Path, project_id: &str, value: &Value) -> Result<()> {
    let Some(patch) = value.as_object() else {
        return Err(Error::new(
            Status::InvalidArg,
            "project codebase scope value must be an object like { enabled: true }".to_string(),
        ));
    };
    if patch.is_empty() {
        return Err(Error::new(
            Status::InvalidArg,
            "project codebase scope value must contain at least one of: enabled, enableAgentReview, enableReranking"
                .to_string(),
        ));
    }

    for (field, field_value) in patch {
        let flag = field_value.as_bool().ok_or_else(|| {
            Error::new(
                Status::InvalidArg,
                format!("{field} must be a boolean (or null to inherit the global default)"),
            )
        })?;
        match field.as_str() {
            "enabled" => set_codebase_project_enabled(db_path, project_id, flag)?,
            "enableAgentReview" => set_codebase_project_agent_review(db_path, project_id, flag)?,
            "enableReranking" => set_codebase_project_reranking(db_path, project_id, flag)?,
            other => {
                return Err(Error::new(
                    Status::InvalidArg,
                    format!(
                        "Unknown project codebase scope field \"{other}\"; available fields: enabled, enableAgentReview, enableReranking"
                    ),
                ))
            }
        }
    }
    Ok(())
}

/// Dispatches `config-list/get/set/delete` for the `codebase` scope.
pub(crate) fn execute_codebase_scope(
    tool_name: &str,
    args: &Value,
    db_path: &Path,
    project_id: Option<&str>,
) -> Result<Value> {
    match (tool_name, project_id) {
        ("list", Some(project_id)) => Ok(json!({
            "scope": "codebase",
            "file": null,
            "scoped": "project",
            "projectId": project_id,
            "keys": [{
                "key": SCOPE_KEY,
                "type": "object",
                "sensitive": false,
                "configured": true,
                "value": scope_view(&get_codebase_project_scope_settings(db_path, project_id)?),
            }],
        })),
        ("list", None) => Ok(json!({
            "scope": "codebase",
            "file": null,
            "scoped": "global",
            "projectId": Value::Null,
            "note": REINDEX_NOTE,
            "keys": [{
                "key": SETTINGS_KEY,
                "type": "object",
                "sensitive": true,
                "configured": true,
                "value": read_global(db_path)?,
            }],
        })),
        (TOOL_GET, Some(project_id)) => {
            let key = args.get("key").and_then(Value::as_str).unwrap_or("");
            if key != SCOPE_KEY {
                return Err(Error::new(
                    Status::InvalidArg,
                    format!("project codebase scope only defines the key \"{SCOPE_KEY}\""),
                ));
            }
            Ok(json!({
                "scope": "codebase",
                "key": key,
                "scoped": "project",
                "projectId": project_id,
                "value": scope_view(&get_codebase_project_scope_settings(db_path, project_id)?),
            }))
        }
        (TOOL_GET, None) => {
            let key = args.get("key").and_then(Value::as_str).unwrap_or("");
            if key != SETTINGS_KEY {
                return Err(Error::new(
                    Status::InvalidArg,
                    format!("codebase (global) only defines the key \"{SETTINGS_KEY}\"; project sessions inject projectId - pass projectId: \"\" for the global view"),
                ));
            }
            Ok(json!({
                "scope": "codebase",
                "key": key,
                "scoped": "global",
                "note": REINDEX_NOTE,
                "value": read_global(db_path)?,
            }))
        }
        (TOOL_SET, Some(project_id)) => {
            let key = args.get("key").and_then(Value::as_str).unwrap_or("");
            if key != SCOPE_KEY {
                return Err(Error::new(
                    Status::InvalidArg,
                    format!("project codebase scope only defines the key \"{SCOPE_KEY}\""),
                ));
            }
            let value = args.get("value").cloned().ok_or_else(|| {
                Error::new(
                    Status::InvalidArg,
                    "value is required for config-set".to_string(),
                )
            })?;
            write_project_scope(db_path, project_id, &value)?;
            Ok(json!({
                "scope": "codebase",
                "key": key,
                "scoped": "project",
                "projectId": project_id,
                "value": scope_view(&get_codebase_project_scope_settings(db_path, project_id)?),
            }))
        }
        (TOOL_SET, None) => {
            let key = args.get("key").and_then(Value::as_str).unwrap_or("");
            if key != SETTINGS_KEY {
                return Err(Error::new(
                    Status::InvalidArg,
                    format!("codebase (global) only defines the key \"{SETTINGS_KEY}\""),
                ));
            }
            let value = args.get("value").cloned().ok_or_else(|| {
                Error::new(
                    Status::InvalidArg,
                    "value is required for config-set".to_string(),
                )
            })?;
            write_global(db_path, &value)?;
            Ok(json!({
                "scope": "codebase",
                "key": key,
                "scoped": "global",
                "note": REINDEX_NOTE,
                "value": read_global(db_path)?,
            }))
        }
        (TOOL_DELETE, _) => Err(Error::new(
            Status::InvalidArg,
            "codebase does not support delete; write explicit values with config-set instead (project-level fields accept true/false to override and re-writing the previous value to change them back)"
                .to_string(),
        )),
        (other, _) => Err(Error::new(
            Status::InvalidArg,
            format!("Unsupported config tool for scope codebase: {other}"),
        )),
    }
}
