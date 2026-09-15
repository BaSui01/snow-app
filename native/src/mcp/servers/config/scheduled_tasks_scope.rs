//! config 服务 `scheduledTasks` 作用域（只读）：让 AI 看到定时任务的定义、
//! 状态与运行历史。
//!
//! ⚠️ 本作用域**刻意不提供写能力**：定时任务的调度器（定时器、tick 循环）运行在
//! 渲染进程，任务 store 只在 App 启动时从数据库 hydrate 一次，之后以内存状态为
//! 权威。直接写 `scheduled_tasks` 表不会在本次运行中生效（既不会创建定时器，
//! 也会被 UI 后续的内存回写覆盖），因此增删改必须走渲染进程通道：
//!   - 新建任务：`app-control-createScheduledTask`（渲染进程会立即注册定时器）；
//!   - 修改/暂停/删除：界面「定时任务」面板。
//! 读取（本作用域）没有这个问题：数据库就是运行历史的持久化真源。

use std::path::Path;

use napi::bindgen_prelude::*;
use serde_json::{json, Value};

use crate::storage::services::scheduled_tasks::list_scheduled_tasks;
use crate::storage::{ScheduledTaskRecord, ScheduledTaskRunRecord};

/// 列表视图中 prompt 预览的最大字符数（get 返回全文）。
const PROMPT_PREVIEW_CHARS: usize = 200;
/// get 返回的运行历史条数上限（数据库本身每个任务最多保留 20 条）。
const MAX_HISTORY_ROWS: usize = 20;

const TOOL_GET: &str = "get";
const TOOL_SET: &str = "set";

/// 写操作统一拒绝并给出正确通道，避免 AI 用"看起来生效但实际不会执行"的写法。
const WRITE_GUIDANCE: &str = "scheduledTasks is read-only because the scheduler runs in the renderer process and the task store hydrates from the database only at app startup. Create tasks with app-control-createScheduledTask (the renderer registers the timer immediately); edit, pause, or delete them in the app's Scheduled Tasks panel. Direct database writes would not take effect until the next app restart and can be overwritten by the UI.";

fn preview(text: &str, max_chars: usize) -> String {
    let mut chars = text.chars();
    let mut snippet = chars.by_ref().take(max_chars).collect::<String>();
    if chars.next().is_some() {
        snippet.push('…');
    }
    snippet
}

fn schedule_value(record: &ScheduledTaskRecord) -> Value {
    serde_json::from_str::<Value>(&record.schedule_json).unwrap_or_else(|_| {
        json!({
            "raw": record.schedule_json,
            "note": "scheduleJson could not be parsed as JSON",
        })
    })
}

fn run_json(run: &ScheduledTaskRunRecord) -> Value {
    json!({
        "runAt": run.run_at,
        "status": run.status,
        "durationMs": run.duration_ms,
        "error": run.error,
    })
}

fn task_summary(record: &ScheduledTaskRecord) -> Value {
    let history = record.history.as_slice();
    let last_run = history.last();

    json!({
        "id": record.id,
        "name": record.name,
        "directoryId": record.directory_id,
        "promptPreview": preview(&record.prompt, PROMPT_PREVIEW_CHARS),
        "promptChars": record.prompt.chars().count(),
        "schedule": schedule_value(record),
        "status": record.status,
        "paused": record.paused,
        "nextRunAt": record.next_run_at,
        "lastRunAt": record.last_run_at,
        "runCount": record.run_count,
        "lastError": record.last_error,
        "skipCount": record.skip_count,
        "lastSkippedAt": record.last_skipped_at,
        "lastSkipReason": record.last_skip_reason,
        "hasPreScript": record.pre_script.as_deref().map(|value| !value.trim().is_empty()).unwrap_or(false),
        "runOnScriptError": record.run_on_script_error.unwrap_or(false),
        "apiProfile": record.api_profile,
        "model": record.model,
        "basicModel": record.basic_model,
        "thinkingStrength": record.thinking_strength,
        "historyCount": history.len(),
        "lastRunStatus": last_run.map(|run| run.status.clone()),
        "updatedAt": record.updated_at,
        "createdAt": record.created_at,
    })
}

fn task_detail(record: &ScheduledTaskRecord) -> Value {
    let mut detail = task_summary(record);
    if let Value::Object(map) = &mut detail {
        map.insert("prompt".to_string(), json!(record.prompt));
        map.insert(
            "preScript".to_string(),
            json!(record.pre_script.clone().unwrap_or_default()),
        );
        map.insert(
            "preScriptTimeoutMs".to_string(),
            json!(record.pre_script_timeout_ms),
        );
        map.insert(
            "history".to_string(),
            json!(record
                .history
                .iter()
                .rev()
                .take(MAX_HISTORY_ROWS)
                .map(run_json)
                .collect::<Vec<_>>()),
        );
    }
    detail
}

/// Dispatches `config-list/get` for the `scheduledTasks` scope (read-only).
pub(crate) fn execute_scheduled_tasks_scope(
    tool_name: &str,
    args: &Value,
    db_path: &Path,
) -> Result<Value> {
    match tool_name {
        "list" => {
            let directory_filter = args
                .get("directoryId")
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or("");
            let mut tasks = list_scheduled_tasks(db_path)?;
            if !directory_filter.is_empty() {
                tasks.retain(|task| task.directory_id == directory_filter);
            }
            let items = tasks.iter().map(task_summary).collect::<Vec<_>>();
            Ok(json!({
                "scope": "scheduledTasks",
                "file": null,
                "readOnly": true,
                "note": WRITE_GUIDANCE,
                "count": items.len(),
                "keys": [{
                    "key": "tasks",
                    "type": "array",
                    "sensitive": false,
                    "configured": true,
                    "value": items,
                }],
            }))
        }
        TOOL_GET => {
            let key = args
                .get("key")
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or("");
            if key.is_empty() {
                return Err(Error::new(
                    Status::InvalidArg,
                    "scheduledTasks requires key = task id".to_string(),
                ));
            }
            let tasks = list_scheduled_tasks(db_path)?;
            let task = tasks
                .iter()
                .find(|task| task.id == key)
                .ok_or_else(|| {
                    Error::new(
                        Status::InvalidArg,
                        format!("Scheduled task not found: {key}"),
                    )
                })?;
            Ok(json!({
                "scope": "scheduledTasks",
                "key": key,
                "readOnly": true,
                "note": WRITE_GUIDANCE,
                "value": task_detail(task),
            }))
        }
        TOOL_SET => Err(Error::new(Status::InvalidArg, WRITE_GUIDANCE.to_string())),
        "delete" => Err(Error::new(Status::InvalidArg, WRITE_GUIDANCE.to_string())),
        other => Err(Error::new(
            Status::InvalidArg,
            format!("Unsupported config tool for scope scheduledTasks: {other}"),
        )),
    }
}
