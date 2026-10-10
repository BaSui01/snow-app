use napi::bindgen_prelude::*;
use serde_json::{json, Value};
use std::path::Path;

use super::super::service::McpService;
use super::super::tools::McpTool;

pub const SERVER_ID: &str = "config";
const TOOL_READ: &str = "logs-read";
const MAX_LIMIT: u64 = 100;
const MAX_FIELD_CHARS: usize = 4000;

pub struct AppLogsService;

impl AppLogsService {
    pub fn new() -> Self {
        Self
    }

    fn read_logs(&self, args: &Value) -> napi::Result<Value> {
        let level = optional_string(args, "level")?;
        if level
            .as_deref()
            .is_some_and(|value| !matches!(value, "DEBUG" | "INFO" | "WARN" | "ERROR"))
        {
            return Err(Error::new(
                Status::InvalidArg,
                "level must be DEBUG, INFO, WARN, or ERROR",
            ));
        }
        let module = optional_string(args, "module")?;
        let scope = optional_string(args, "scope")?.unwrap_or_else(|| "all".to_string());
        if !matches!(scope.as_str(), "all" | "current") {
            return Err(Error::new(
                Status::InvalidArg,
                "scope must be all or current",
            ));
        }
        let conversation_id = optional_string(args, "conversationId")?;
        if scope == "current" && conversation_id.is_none() {
            return Err(Error::new(
                Status::InvalidArg,
                "current scope requires the runtime-provided conversationId",
            ));
        }
        let max_field_chars = args
            .get("maxFieldChars")
            .and_then(Value::as_u64)
            .unwrap_or(MAX_FIELD_CHARS as u64)
            .clamp(1, 50_000) as usize;
        let since = optional_string(args, "since")?.map(|value| normalize_date_bound(value, false));
        let until = optional_string(args, "until")?.map(|value| normalize_date_bound(value, true));
        let limit = args
            .get("limit")
            .and_then(Value::as_u64)
            .unwrap_or(50)
            .clamp(1, MAX_LIMIT);
        let offset = args.get("offset").and_then(Value::as_u64).unwrap_or(0);

        let storage = crate::storage::initialize_app_storage()?;
        let database_path = Path::new(&storage.database_path);
        let connection =
            crate::storage::database::open_connection(database_path).map_err(|err| {
                Error::new(
                    Status::GenericFailure,
                    format!("Cannot open Snow App database: {err}"),
                )
            })?;

        let mut filters = Vec::new();
        let mut values: Vec<rusqlite::types::Value> = Vec::new();
        for (column, op, value) in [
            ("level", "=", level.as_deref()),
            ("module", "=", module.as_deref()),
            ("created_at", ">=", since.as_deref()),
            ("created_at", "<=", until.as_deref()),
        ] {
            if let Some(value) = value {
                filters.push(format!("{column} {op} ?"));
                values.push(rusqlite::types::Value::Text(value.to_string()));
            }
        }
        let summary_where = if filters.is_empty() {
            String::new()
        } else {
            format!(" WHERE {}", filters.join(" AND "))
        };
        // Public diagnostics are counts only. Never select free-text fields,
        // identifiers or payloads from unscoped rows (including legacy rows).
        let summary_sql = format!(
            "SELECT COUNT(*), \
             COUNT(CASE WHEN COALESCE(conversation_id, '') = '' THEN 1 END), \
             COUNT(CASE WHEN source = 'main' THEN 1 END), \
             COUNT(CASE WHEN source = 'renderer' THEN 1 END), \
             COUNT(CASE WHEN level = 'DEBUG' THEN 1 END), \
             COUNT(CASE WHEN level = 'INFO' THEN 1 END), \
             COUNT(CASE WHEN level = 'WARN' THEN 1 END), \
             COUNT(CASE WHEN level = 'ERROR' THEN 1 END) \
             FROM app_logs{summary_where}"
        );
        let system_summary = connection
            .query_row(
                &summary_sql,
                rusqlite::params_from_iter(values.iter()),
                |row| {
                    Ok(json!({
                        "scope": "application_counts_only",
                        "total": row.get::<_, i64>(0)?,
                        "withoutConversationId": row.get::<_, i64>(1)?,
                        "bySource": {
                            "main": row.get::<_, i64>(2)?,
                            "renderer": row.get::<_, i64>(3)?,
                        },
                        "byLevel": {
                            "DEBUG": row.get::<_, i64>(4)?,
                            "INFO": row.get::<_, i64>(5)?,
                            "WARN": row.get::<_, i64>(6)?,
                            "ERROR": row.get::<_, i64>(7)?,
                        },
                    }))
                },
            )
            .map_err(|err| {
                Error::new(
                    Status::GenericFailure,
                    format!("Cannot summarize app logs: {err}"),
                )
            })?;

        // Full-log scope is requested explicitly by the caller; current scope keeps the runtime conversation boundary.
        if scope == "current" {
            filters.push("conversation_id = ?".to_string());
            values.push(rusqlite::types::Value::Text(conversation_id.unwrap()));
        }
        let where_sql = if filters.is_empty() {
            String::new()
        } else {
            format!(" WHERE {}", filters.join(" AND "))
        };
        let count_sql = format!("SELECT COUNT(*) FROM app_logs{where_sql}");
        let total: i64 = connection
            .query_row(
                &count_sql,
                rusqlite::params_from_iter(values.iter()),
                |row| row.get(0),
            )
            .map_err(|err| {
                Error::new(
                    Status::GenericFailure,
                    format!("Cannot count app logs: {err}"),
                )
            })?;

        let query_sql = format!(
            "SELECT id, created_at, level, module, func, message, conversation_id, context, error, input, output, line, duration, source \
             FROM app_logs{where_sql} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?"
        );
        values.push(rusqlite::types::Value::Integer(limit as i64));
        values.push(rusqlite::types::Value::Integer(
            offset.min(i64::MAX as u64) as i64
        ));
        let api_keys: Vec<String> =
            crate::storage::services::api_configs::list_api_configs(database_path)
                .unwrap_or_default()
                .into_iter()
                .flat_map(|profile| [profile.api_key, profile.vision_api_key])
                .filter(|key| !key.is_empty())
                .collect();
        let mut statement = connection.prepare(&query_sql).map_err(|err| {
            Error::new(
                Status::GenericFailure,
                format!("Cannot prepare app log query: {err}"),
            )
        })?;
        let rows = statement
            .query_map(rusqlite::params_from_iter(values.iter()), |row| {
                let module: String = row.get(3)?;
                let input = redact_and_truncate(row.get::<_, String>(9)?, &api_keys, max_field_chars);
                let output = redact_and_truncate(row.get::<_, String>(10)?, &api_keys, max_field_chars);
                let error = redact_and_truncate(row.get::<_, String>(8)?, &api_keys, max_field_chars);
                let conversation_id: String = row.get(6)?;
                Ok(json!({
                    "id": row.get::<_, String>(0)?,
                    "traceKey": if conversation_id.is_empty() { row.get::<_, String>(0)? } else { conversation_id.clone() },
                    "createdAt": row.get::<_, String>(1)?,
                    "level": row.get::<_, String>(2)?,
                    "module": module,
                    "function": row.get::<_, String>(4)?,
                    "line": row.get::<_, Option<i32>>(11)?,
                    "message": redact_and_truncate(row.get::<_, String>(5)?, &api_keys, max_field_chars),
                    "conversationId": conversation_id,
                    "context": redact_and_truncate(row.get::<_, String>(7)?, &api_keys, max_field_chars),
                    "error": error,
                    "input": input,
                    "output": output,
                    "requestBody": if module == "api_request" { redact_and_truncate(row.get::<_, String>(9)?, &api_keys, max_field_chars) } else { String::new() },
                    "responseBody": if module == "api_response" { redact_and_truncate(row.get::<_, String>(10)?, &api_keys, max_field_chars) } else { String::new() },
                    "duration": row.get::<_, String>(12)?,
                    "source": row.get::<_, String>(13)?,
                }))
            })
            .map_err(|err| {
                Error::new(
                    Status::GenericFailure,
                    format!("Cannot query app logs: {err}"),
                )
            })?;
        let items = rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|err| {
            Error::new(
                Status::GenericFailure,
                format!("Cannot read app log rows: {err}"),
            )
        })?;

        let returned = items.len();
        Ok(json!({
            "source": "Snow App SQLite app_logs",
            "database": "~/.snowapp/snowapp.db",
            "items": items,
            "total": total,
            "limit": limit,
            "offset": offset,
            "hasMore": offset.saturating_add(returned as u64) < total as u64,
            "systemSummary": system_summary,
            "detailScope": if scope == "all" { "all_application_logs" } else { "current_conversation" },
            "maxFieldChars": max_field_chars,
            "traceHint": "Group by traceKey/conversationId, then order by createdAt; API request and response rows share the conversation trace when associated. Unassociated rows use their own id as traceKey; no dedicated per-request trace id is currently persisted.",
            "note": "Returns level, module, function/line, message, input/output, duration, source, context and error; API request/response bodies are exposed as input/output and requestBody/responseBody. scope=all includes all conversations and unassociated logs. Fields are capped by maxFieldChars. API payloads are redacted before persistence; log text outside payloads may also contain sensitive values."
        }))
    }
}

fn normalize_date_bound(value: String, upper_bound: bool) -> String {
    if value.len() == 10
        && value.as_bytes().get(4) == Some(&b'-')
        && value.as_bytes().get(7) == Some(&b'-')
    {
        format!(
            "{value} {}",
            if upper_bound { "23:59:59" } else { "00:00:00" }
        )
    } else {
        value
    }
}

fn optional_string(args: &Value, key: &str) -> napi::Result<Option<String>> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => {
            let value = value.trim();
            Ok((!value.is_empty()).then(|| value.to_string()))
        }
        Some(_) => Err(Error::new(
            Status::InvalidArg,
            format!("{key} must be a string"),
        )),
    }
}

fn redact_and_truncate(mut value: String, api_keys: &[String], limit: usize) -> String {
    for key in api_keys {
        value = value.replace(key, "[API_KEY_REDACTED]");
    }
    truncate(value, limit)
}

fn truncate(value: String, limit: usize) -> String {
    let mut chars = value.chars();
    let text: String = chars.by_ref().take(limit).collect();
    if chars.next().is_some() {
        format!("{text}… [truncated]")
    } else {
        text
    }
}

impl McpService for AppLogsService {
    fn id(&self) -> &str {
        SERVER_ID
    }

    fn tools(&self) -> Vec<McpTool> {
        vec![McpTool {
            server_id: SERVER_ID.to_string(),
            name: TOOL_READ.to_string(),
            description: "Read detailed Snow App SQLite system logs across conversations by default. Returns severity, module/function/line, timestamps, conversation trace key, messages, contexts, errors, inputs/outputs, API request/response bodies, duration and source. API payloads are redacted at persistence; text fields are bounded by maxFieldChars (up to 50000 chars). API bodies may contain prompts and user content, but stored API keys are redacted.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "scope": {"type":"string", "enum":["all","current"], "description":"Detail scope; defaults to all application logs, including rows from other conversations and unassociated system logs."},
                    "level": {"type":"string", "enum":["DEBUG","INFO","WARN","ERROR"], "description":"Optional exact severity level; omit this field to query all levels."},
                    "module": {"type":"string", "description":"Optional exact subsystem filter (for example api, api_request, api_response, lsp, hooks)."},
                    "conversationId": {"type":"string", "description":"Runtime-scoped by Snow App to the current conversation; any caller-supplied value is overwritten."},
                    "since": {"type":"string", "description":"Optional local datetime lower bound: YYYY-MM-DD or YYYY-MM-DD HH:MM:SS."},
                    "until": {"type":"string", "description":"Optional local datetime upper bound: YYYY-MM-DD or YYYY-MM-DD HH:MM:SS."},
                    "limit": {"type":"integer", "minimum":1, "maximum":100, "description":"Page size, defaults to 50."},
                    "offset": {"type":"integer", "minimum":0, "description":"Pagination offset, defaults to 0."},
                    "maxFieldChars": {"type":"integer", "minimum":1, "maximum":50000, "description":"Maximum characters for each text field; defaults to 4000."}
                }
            }),
        }]
    }

    fn execute(&self, tool_name: &str, args: &Value) -> napi::Result<Value> {
        match tool_name {
            TOOL_READ => self.read_logs(args),
            _ => Err(Error::new(
                Status::InvalidArg,
                format!("Unknown config logs tool: {tool_name}"),
            )),
        }
    }
}
