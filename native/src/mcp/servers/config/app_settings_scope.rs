//! config 服务 `appSettings` 作用域：把散落在 system_settings 的零散开关集中
//! 到一个域，便于 AI 排障时查看与调整。
//!
//! key = `liteMode` | `autoFormat` | `terminal` | `proxyBrowser` | `imageLibraryDir`
//!        | `yoloMode`（只读）
//!
//! - `liteMode` / `autoFormat`：布尔开关（精简模式禁用 Browser/App Control/Terminal
//!   三个内置 MCP 服务器；自动格式化在编辑文件后用 Prettier 整理）。
//! - `terminal` / `proxyBrowser`：UI 整体读写的 JSON blob，本域按**白名单字段 merge**
//!   写入（未提供的字段与不属于白名单的字段——例如站点拦截规则 `blockedPatterns`
//!   ——保持原值，后者由 app-control 工具维护）。
//! - `imageLibraryDir`：图片库自定义目录，空字符串表示用默认目录。
//! - `yoloMode`：全自动免确认开关，**故意只读**（安全红线）。UI「隐私/工具授权」
//!   与授权流程是唯一写入口，避免 AI 自行关闭工具的确认要求。

use std::path::Path;

use napi::bindgen_prelude::*;
use serde_json::{json, Map, Value};

use crate::storage::services::system_settings::{
    get_auto_format, get_image_library_dir, get_lite_mode, get_system_setting_value,
    set_auto_format, set_image_library_dir, set_lite_mode, set_system_setting,
};

const TOOL_GET: &str = "get";
const TOOL_SET: &str = "set";
const TOOL_DELETE: &str = "delete";

const LITE_MODE_KEY: &str = "liteMode";
const AUTO_FORMAT_KEY: &str = "autoFormat";
const TERMINAL_KEY: &str = "terminal";
const PROXY_BROWSER_KEY: &str = "proxyBrowser";
const IMAGE_LIBRARY_DIR_KEY: &str = "imageLibraryDir";
const YOLO_MODE_KEY: &str = "yoloMode";

/// terminal_settings 的 setting_code 与名称（与 UI 同源）。
const TERMINAL_SETTING_NAME: &str = "Terminal settings";
const TERMINAL_SETTING_CODE: &str = "terminal_settings";
/// proxy_browser_settings 的 setting_code 与名称（与 UI 同源）。
const PROXY_BROWSER_SETTING_NAME: &str = "Proxy and browser settings";
const PROXY_BROWSER_SETTING_CODE: &str = "proxy_browser_settings";

/// 允许通过本域写入的终端字段（其余字段原样保留）。
const TERMINAL_WRITABLE_FIELDS: &[&str] = &[
    "shellPath",
    "fontFamily",
    "fontSize",
    "fontWeight",
    "lineHeight",
];

/// 允许通过本域写入的代理/浏览器字段。`blockedPatterns`（站点拦截规则）刻意不在
/// 白名单内：它由 app-control-getBlockedPatterns / updateBlockedPatterns 维护。
const PROXY_BROWSER_WRITABLE_FIELDS: &[&str] = &[
    "enabled",
    "host",
    "port",
    "browserPath",
    "browserDebugPort",
    "searchEngine",
];

const YOLO_MODE_NOTE: &str = "yoloMode is read-only here: the full-auto (no confirmation) switch must be changed by the user in the app UI (Privacy / Tool authorization), so an agent can never silently disable tool confirmation.";

fn read_blob(db_path: &Path, code: &str) -> Result<Value> {
    match get_system_setting_value(db_path, code)? {
        Some(raw) => serde_json::from_str::<Value>(&raw).map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to parse {code} settings: {error}"),
            )
        }),
        None => Ok(json!({})),
    }
}

/// 白名单字段 merge：只覆盖提供且在白名单内的字段，其余（含未知字段）保留。
fn merge_blob_fields(
    existing: &Value,
    incoming: &Value,
    writable: &[&str],
    code: &str,
) -> Result<Value> {
    let Some(patch) = incoming.as_object() else {
        return Err(Error::new(
            Status::InvalidArg,
            format!("{code} value must be an object"),
        ));
    };
    let mut merged = match existing.as_object() {
        Some(object) => object.clone(),
        None => Map::new(),
    };
    for (key, value) in patch {
        if !writable.contains(&key.as_str()) {
            return Err(Error::new(
                Status::InvalidArg,
                format!(
                    "{key} is not writable in this scope; allowed fields: {}",
                    writable.join(", ")
                ),
            ));
        }
        merged.insert(key.clone(), value.clone());
    }
    Ok(Value::Object(merged))
}

fn write_blob(db_path: &Path, name: &str, code: &str, value: &Value) -> Result<()> {
    let serialized = serde_json::to_string(value).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to serialize {code} settings: {error}"),
        )
    })?;
    set_system_setting(db_path, name, code, &serialized)
}

fn state_for(db_path: &Path, key: &str) -> Result<Option<Value>> {
    let value = match key {
        LITE_MODE_KEY => json!(get_lite_mode(db_path)?),
        AUTO_FORMAT_KEY => json!(get_auto_format(db_path)?),
        TERMINAL_KEY => read_blob(db_path, TERMINAL_SETTING_CODE)?,
        PROXY_BROWSER_KEY => read_blob(db_path, PROXY_BROWSER_SETTING_CODE)?,
        IMAGE_LIBRARY_DIR_KEY => json!(get_image_library_dir(db_path)?),
        YOLO_MODE_KEY => json!(crate::storage::get_yolo_mode()?),
        _ => return Ok(None),
    };
    Ok(Some(value))
}

fn all_keys() -> Vec<Value> {
    vec![
        json!({ "key": LITE_MODE_KEY, "type": "boolean", "sensitive": false, "readOnly": false }),
        json!({ "key": AUTO_FORMAT_KEY, "type": "boolean", "sensitive": false, "readOnly": false }),
        json!({ "key": TERMINAL_KEY, "type": "object", "sensitive": false, "readOnly": false }),
        json!({ "key": PROXY_BROWSER_KEY, "type": "object", "sensitive": false, "readOnly": false }),
        json!({ "key": IMAGE_LIBRARY_DIR_KEY, "type": "string", "sensitive": false, "readOnly": false }),
        json!({ "key": YOLO_MODE_KEY, "type": "boolean", "sensitive": false, "readOnly": true }),
    ]
}

fn write_setting(db_path: &Path, key: &str, value: &Value) -> Result<Value> {
    match key {
        LITE_MODE_KEY => {
            let enabled = value.as_bool().ok_or_else(|| {
                Error::new(Status::InvalidArg, "liteMode must be a boolean".to_string())
            })?;
            set_lite_mode(db_path, enabled)?;
        }
        AUTO_FORMAT_KEY => {
            let enabled = value.as_bool().ok_or_else(|| {
                Error::new(Status::InvalidArg, "autoFormat must be a boolean".to_string())
            })?;
            set_auto_format(db_path, enabled)?;
        }
        TERMINAL_KEY => {
            let existing = read_blob(db_path, TERMINAL_SETTING_CODE)?;
            let merged = merge_blob_fields(
                &existing,
                value,
                TERMINAL_WRITABLE_FIELDS,
                TERMINAL_SETTING_CODE,
            )?;
            write_blob(
                db_path,
                TERMINAL_SETTING_NAME,
                TERMINAL_SETTING_CODE,
                &merged,
            )?;
        }
        PROXY_BROWSER_KEY => {
            let existing = read_blob(db_path, PROXY_BROWSER_SETTING_CODE)?;
            let merged = merge_blob_fields(
                &existing,
                value,
                PROXY_BROWSER_WRITABLE_FIELDS,
                PROXY_BROWSER_SETTING_CODE,
            )?;
            write_blob(
                db_path,
                PROXY_BROWSER_SETTING_NAME,
                PROXY_BROWSER_SETTING_CODE,
                &merged,
            )?;
        }
        IMAGE_LIBRARY_DIR_KEY => {
            let dir = value.as_str().ok_or_else(|| {
                Error::new(
                    Status::InvalidArg,
                    "imageLibraryDir must be a string (empty string restores the default directory)"
                        .to_string(),
                )
            })?;
            set_image_library_dir(db_path, dir.trim())?;
        }
        YOLO_MODE_KEY => {
            return Err(Error::new(Status::InvalidArg, YOLO_MODE_NOTE.to_string()));
        }
        other => {
            return Err(Error::new(
                Status::InvalidArg,
                format!("Unknown appSettings key \"{other}\""),
            ));
        }
    }

    Ok(json!({
        "scope": "appSettings",
        "key": key,
        "value": state_for(db_path, key)?,
    }))
}

/// Dispatches `config-list/get/set/delete` for the `appSettings` scope.
pub(crate) fn execute_app_settings_scope(
    tool_name: &str,
    args: &Value,
    db_path: &Path,
) -> Result<Value> {
    match tool_name {
        "list" => {
            let mut keys = Vec::new();
            for spec in all_keys() {
                let key = spec
                    .get("key")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let mut entry = spec;
                entry["configured"] = json!(true);
                entry["value"] = state_for(db_path, &key)?.unwrap_or(Value::Null);
                if key == YOLO_MODE_KEY {
                    entry["note"] = json!(YOLO_MODE_NOTE);
                }
                keys.push(entry);
            }
            Ok(json!({
                "scope": "appSettings",
                "file": null,
                "keys": keys,
            }))
        }
        TOOL_GET => {
            let key = args
                .get("key")
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or("");
            let value = state_for(db_path, key)?.ok_or_else(|| {
                Error::new(
                    Status::InvalidArg,
                    format!("Unknown appSettings key \"{key}\"; available keys: liteMode, autoFormat, terminal, proxyBrowser, imageLibraryDir, yoloMode"),
                )
            })?;
            Ok(json!({
                "scope": "appSettings",
                "key": key,
                "readOnly": key == YOLO_MODE_KEY,
                "value": value,
            }))
        }
        TOOL_SET => {
            let key = args
                .get("key")
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or("");
            let value = args.get("value").cloned().ok_or_else(|| {
                Error::new(
                    Status::InvalidArg,
                    "value is required for config-set".to_string(),
                )
            })?;
            write_setting(db_path, key, &value)
        }
        TOOL_DELETE => Err(Error::new(
            Status::InvalidArg,
            "appSettings does not support delete; write the desired value with config-set instead (imageLibraryDir accepts an empty string to restore the default)"
                .to_string(),
        )),
        other => Err(Error::new(
            Status::InvalidArg,
            format!("Unsupported config tool for scope appSettings: {other}"),
        )),
    }
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blob_merge_keeps_other_fields_and_rejects_non_writable() {
        let existing = json!({ "shellPath": "bash", "fontSize": 14, "unknownField": "keep" });
        let merged = merge_blob_fields(
            &existing,
            &json!({ "fontSize": 16 }),
            TERMINAL_WRITABLE_FIELDS,
            "terminal_settings",
        )
        .unwrap();
        assert_eq!(merged.get("fontSize").and_then(Value::as_i64), Some(16));
        assert_eq!(merged.get("shellPath").and_then(Value::as_str), Some("bash"));
        assert_eq!(
            merged.get("unknownField").and_then(Value::as_str),
            Some("keep")
        );

        // blockedPatterns 由 app-control 维护，不属于本域白名单。
        assert!(merge_blob_fields(
            &existing,
            &json!({ "blockedPatterns": [] }),
            PROXY_BROWSER_WRITABLE_FIELDS,
            "proxy_browser_settings",
        )
        .is_err());
    }
}
