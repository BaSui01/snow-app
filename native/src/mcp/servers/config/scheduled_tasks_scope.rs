//! config 服务 `scheduledTasks` 作用域：读取定时任务定义、状态与运行历史。
//!
//! 调度器运行在渲染进程，任务 store 只在启动时 hydrate，直接写表不会生效：
//!   - 新建：`config-set key="new"` 在 tools/call.rs 路由到渲染端（立即注册定时器）；
//!   - 修改/暂停/删除：界面「定时任务」面板；本模块对其余写操作一律拒绝。

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

/// 非 key="new" 的写操作统一拒绝并给出正确通道。
const WRITE_GUIDANCE: &str = "scheduledTasks only supports creating tasks via config-set key=\"new\" (see createGuidance from config-list scope=scheduledTasks). The scheduler runs in the renderer process and the task store hydrates from the database only at app startup, so editing, pausing or deleting tasks must be done in the app's Scheduled Tasks panel.";

/// 创建契约（原 createScheduledTask 的参数说明）。
fn create_guidance() -> Value {
    json!({
        "call": "config-set scope=scheduledTasks key=\"new\" value={...}",
        "behavior": "Tasks are saved in the local database and survive restarts. Each run sends `prompt` to a NEW auto-sent chat conversation with access to all tools. Runs missed while the app is closed are skipped unless schedule.wakeWhenClosed is true. The task binds to the active project (global when none).",
        "fields": {
            "id": "optional idempotency key (max 128 chars); retrying with the same id returns the existing task instead of a duplicate",
            "name": "required, human-readable name",
            "prompt": "required, prompt sent on each run; may contain {{SCRIPT_OUTPUT}}",
            "schedule": {
                "type": "required: \"once\" | \"recurring\"",
                "executeAt": "type=once: ISO 8601 timestamp WITH timezone offset, e.g. 2026-08-12T10:00:00+08:00",
                "mode": "type=recurring: \"interval\" | \"daily\"",
                "intervalMs": "mode=interval: integer ms, 60000 (1 minute) to 366 days",
                "hour": "mode=daily: 0-23",
                "minute": "mode=daily: 0-59",
                "wakeWhenClosed": "optional bool: the OS scheduler relaunches the app in the background before the run time; a run missed while the computer was off runs once on the next launch"
            },
            "apiProfile": "optional API profile name for the fired conversation (default: active profile)",
            "model": "optional model id for the fired conversation (default: the profile's model)",
            "basicModel": "optional base model id, kept for display/config alignment only",
            "thinkingStrength": "optional per-run thinking override, e.g. none | low | medium | high",
            "preScript": "optional shell command run in the project directory before the AI Loop",
            "preScriptTimeoutMs": "optional 1000-300000 (default 60000); timeout counts as a script error",
            "runOnScriptError": "optional bool (default false): still run the AI Loop when the script fails"
        },
        "preScriptProtocol": "exit 0 = run, exit 1 = skip this round; or print a JSON object as the LAST stdout line: {\"run\":false,\"reason\":\"...\"} skips and records the reason, {\"run\":true,\"output\":\"...\"} injects output into {{SCRIPT_OUTPUT}}, {\"prompt\":\"...\"} fully overrides the prompt. Any other exit code, timeout or spawn failure is a script error.",
        "examples": [
            {"name": "Daily report", "prompt": "Summarize yesterday's commits", "schedule": {"type": "recurring", "mode": "daily", "hour": 9, "minute": 0}},
            {"name": "Reminder", "prompt": "Remind me to review PRs", "schedule": {"type": "once", "executeAt": "2026-08-12T10:00:00+08:00"}}
        ]
    })
}

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

/// Dispatches `config-list/get` for the `scheduledTasks` scope（创建由 call.rs 路由）。
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
                "note": WRITE_GUIDANCE,
                "createGuidance": create_guidance(),
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
