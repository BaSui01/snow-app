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
        let conversation_id = optional_string(args, "conversationId")?
            .filter(|id| !id.is_empty())
            .ok_or_else(|| {
                Error::new(
                    Status::InvalidArg,
                    "config-logs-read requires an internally scoped conversationId",
                )
            })?;
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

        // The detailed query remains strictly scoped by the runtime-provided ID.
        filters.push("conversation_id = ?".to_string());
        values.push(rusqlite::types::Value::Text(conversation_id));
        let where_sql = format!(" WHERE {}", filters.join(" AND "));
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
            "SELECT id, created_at, level, module, func, message, conversation_id, context, error, input, output \
             FROM app_logs{where_sql} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?"
        );
        values.push(rusqlite::types::Value::Integer(limit as i64));
        values.push(rusqlite::types::Value::Integer(
            offset.min(i64::MAX as u64) as i64
        ));
        let mut statement = connection.prepare(&query_sql).map_err(|err| {
            Error::new(
                Status::GenericFailure,
                format!("Cannot prepare app log query: {err}"),
            )
        })?;
        let rows = statement
            .query_map(rusqlite::params_from_iter(values.iter()), |row| {
                let module: String = row.get(3)?;
                let error: String = row.get(8)?;
                let request_body = if module == "api_request" {
                    truncate(row.get::<_, String>(9)?, MAX_FIELD_CHARS)
                } else {
                    String::new()
                };
                let response_body = if module == "api_response" {
                    truncate(row.get::<_, String>(10)?, MAX_FIELD_CHARS)
                } else {
                    String::new()
                };
                let error = if module == "api" {
                    String::new()
                } else {
                    truncate(error, MAX_FIELD_CHARS)
                };
                Ok(json!({
                    "id": row.get::<_, String>(0)?,
                    "createdAt": row.get::<_, String>(1)?,
                    "level": row.get::<_, String>(2)?,
                    "module": module,
                    "function": row.get::<_, String>(4)?,
                    "message": row.get::<_, String>(5)?,
                    "conversationId": row.get::<_, String>(6)?,
                    "context": truncate(row.get::<_, String>(7)?, MAX_FIELD_CHARS),
                    "error": if module == "api" { String::new() } else { truncate(error, MAX_FIELD_CHARS) },
                    "requestBody": request_body,
                    "responseBody": response_body,
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
            "detailScope": "current_conversation",
            "note": "systemSummary contains application-wide counts only under the same level/module/time filters, without pagination. items/total/hasMore are restricted to the current conversation; unassociated system/legacy rows and other conversations are excluded from details. A zero detail total does not mean the application has no logs. API bodies are truncated and secret fields/API-key strings are redacted before persistence."
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
            description: "Read Snow App's SQLite system logs via config-logs-read. Read-only: systemSummary returns application-wide counts only (including unassociated/legacy logs), never other conversations' text, identifiers or payloads. items/total/hasMore remain restricted to the runtime-injected current conversation; total=0 does not mean there are no application logs. Supports level/module/time filters (empty strings mean omitted) and bounded detail pagination. Current-conversation API bodies are truncated; secret fields/API keys are redacted before persistence. Request logging is separately controlled by config-set scope=requestLogging with a default 5-minute expiry.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "level": {"type":"string", "enum":["","DEBUG","INFO","WARN","ERROR"], "description":"Optional exact log level; empty string means all levels."},
                    "module": {"type":"string", "description":"Optional exact module filter (for example api, lsp, hooks)."},
                    "conversationId": {"type":"string", "description":"Runtime-scoped by Snow App to the current conversation; any caller-supplied value is overwritten."},
                    "since": {"type":"string", "description":"Optional local datetime lower bound: YYYY-MM-DD or YYYY-MM-DD HH:MM:SS."},
                    "until": {"type":"string", "description":"Optional local datetime upper bound: YYYY-MM-DD or YYYY-MM-DD HH:MM:SS."},
                    "limit": {"type":"integer", "minimum":1, "maximum":100, "description":"Page size, defaults to 50."},
                    "offset": {"type":"integer", "minimum":0, "description":"Pagination offset, defaults to 0."}
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
