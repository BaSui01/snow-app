use serde_json::Value;
use std::path::PathBuf;

use napi::bindgen_prelude::*;
use napi_derive::napi;
use tokio_util::sync::CancellationToken;

use crate::api::config::get_api_config_custom_headers;
use crate::api::conversation::create_response_stream as create_conversation_response_stream;
use crate::api::file_search_agent::{
    run_file_search_agent as run_agent, FileSearchAgentProgressCallback,
};
use crate::api::models::{
    fetch_available_models as fetch_models_with_config, fetch_available_models_for_active_config,
    ApiConfigForModels, Model,
};
use crate::api::responses::{ResponsesApiRequest, ResponsesApiResult, ResponsesApiStreamCallback};
use crate::api::summary::generate_conversation_summary as generate_summary;
use crate::api::theme_palette::generate_theme_palette_stream;
use crate::mcp::servers::app_control::AppControlCallback;
use crate::mcp::servers::bash::{
    authorize_sensitive_command as authorize_command,
    write_interactive_stdin as write_interactive_stdin_impl, BashStreamCallback,
};
use crate::mcp::servers::browser::BrowserCommandCallback;
use crate::mcp::servers::remote_workspace::RemoteWorkspaceCallback;
use crate::mcp::servers::skills::{ProjectSkillDefinition, SkillDefinition, SkillsService};
use crate::mcp::servers::terminal::TerminalCommandCallback;
use crate::mcp::servers::user_interaction::UserQuestionCallback;
use crate::mcp::servers::websearch::WebSearchCommandCallback;
use crate::mcp::servers::workflow::validate_graph as validate_workflow_graph_impl;
use crate::mcp::tools::{
    call_mcp_tool as call_tool, list_mcp_project_server_tools as list_project_server_tools,
    list_mcp_project_servers as list_project_servers,
    list_mcp_project_servers_cached as list_cached_project_servers,
    list_mcp_server_tools as list_server_tools, list_mcp_tools as list_all_mcp_tools,
    set_mcp_project_server_enabled as set_project_server_enabled,
    set_mcp_project_tool_enabled as set_project_tool_enabled,
    set_mcp_project_tools_enabled as set_project_tools_enabled,
    set_mcp_tool_enabled as set_tool_enabled,
    set_mcp_tools_enabled as set_tools_enabled, McpProjectServerStatus, McpProjectToolStatus,
    McpToolDefinition, McpToolStatus,
};
use crate::storage::initialize_app_storage;
use crate::storage::services::fs_explorer::FileSearchResult;
use crate::storage::SensitiveCommandDecisionRecord;

#[napi]
pub async fn fetch_available_models() -> napi::Result<Vec<Model>> {
    // 使用 spawn_blocking 确保 HTTP 请求和 SQLite I/O 不阻塞 Node.js 主线程
    tokio::task::spawn_blocking(move || fetch_available_models_for_active_config())
        .await
        .map_err(|e| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to execute fetch_available_models: {}", e),
            )
        })?
}

#[napi]
pub async fn fetch_available_models_for_config(
    config: ApiConfigForModels,
) -> napi::Result<Vec<Model>> {
    // 使用 spawn_blocking 确保 HTTP 请求和 SQLite I/O 不阻塞 Node.js 主线程
    tokio::task::spawn_blocking(move || {
        let storage_info = initialize_app_storage()?;
        let database_path = PathBuf::from(storage_info.database_path);
        let custom_header_schemes =
            crate::storage::services::custom_header_schemes::list_custom_header_schemes(
                &database_path,
            )?;
        let custom_headers =
            get_api_config_custom_headers(&custom_header_schemes, &config.custom_header_scheme_id);

        fetch_models_with_config(&config, &custom_headers)
    })
    .await
    .map_err(|e| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to execute fetch_available_models_for_config: {}", e),
        )
    })?
}

#[napi(
    ts_args_type = "request: ResponsesApiRequest, onChunk: (chunk: ResponsesApiStreamChunk) => void, streamId: string",
    ts_return_type = "Promise<ResponsesApiResult>"
)]
pub async fn create_response_stream(
    request: ResponsesApiRequest,
    on_chunk: ResponsesApiStreamCallback,
    stream_id: String,
) -> napi::Result<ResponsesApiResult> {
    create_conversation_response_stream(request, on_chunk, stream_id).await
}

#[napi]
pub fn abort_response_stream(stream_id: String) -> napi::Result<bool> {
    Ok(crate::api::cancel::cancel_stream(&stream_id))
}

/// Abort an in-flight tool execution (e.g. a bash subprocess) by the
/// execution id that was streamed to the frontend as a `tool_execution`
/// chunk.  The executing service races its wait against this cancellation
/// and kills the process tree.  `reason` records why the abort happened
/// ("user" stop button / session abort, "timeout" renderer countdown
/// watchdog, or "shutdown") so the executor can report the real
/// termination reason; unknown values fall back to "user".
/// Returns `true` if a running execution was found and cancelled.
#[napi(ts_args_type = "toolExecutionId: string, reason?: string")]
pub fn abort_tool_execution(
    tool_execution_id: String,
    reason: Option<String>,
) -> napi::Result<bool> {
    let trimmed = tool_execution_id.trim();
    if trimmed.is_empty() {
        return Err(Error::new(
            Status::InvalidArg,
            "Tool execution ID is required".to_string(),
        ));
    }
    let normalized_reason = match reason.as_deref() {
        Some("timeout") => "timeout",
        Some("shutdown") => "shutdown",
        _ => "user",
    };
    Ok(crate::api::cancel::cancel_tool_execution_with_reason(
        trimmed,
        normalized_reason,
    ))
}

/// Generate a theme palette JSON from a background image using the selected
/// API config's **advanced model** (must support vision). Dispatches to
/// whichever provider (chat / responses / anthropic / gemini) the config
/// specifies.
///
/// - `imagePath`: absolute path to the background image file
/// - `profileName`: API config profile name. Empty string means "use the
///   active profile".
/// - `onChunk`: streaming callback receiving `ResponsesApiStreamChunk`
/// - `streamId`: unique stream id for cancellation support
///
/// Returns the full `ResponsesApiResult` (`.content` holds the JSON palette).
#[napi(
    ts_args_type = "imagePath: string, profileName: string, onChunk: (chunk: ResponsesApiStreamChunk) => void, streamId: string",
    ts_return_type = "Promise<ResponsesApiResult>"
)]
pub async fn generate_theme_palette(
    image_path: String,
    profile_name: String,
    on_chunk: ResponsesApiStreamCallback,
    stream_id: String,
) -> napi::Result<ResponsesApiResult> {
    // 1. Register cancellation token
    let cancel_token = crate::api::cancel::create_and_register(&stream_id);

    // 2. Stream theme palette generation
    let result =
        generate_theme_palette_stream(image_path, profile_name, on_chunk, cancel_token).await;

    // 3. Unregister stream
    crate::api::cancel::unregister_stream(&stream_id);

    result
}

/// Generate a conversation summary (title) for the given conversation id.
///
/// Registers a cancellation token so the in-flight non-streaming HTTP
/// request can be aborted via `cancel_conversation_summary`. When cancelled,
/// the summary returns an empty string WITHOUT writing to the database,
/// releasing the SQLite lock for a subsequent delete/truncate.
#[napi(
    ts_args_type = "conversationId: string, basicModel?: string",
    ts_return_type = "Promise<string>"
)]
pub async fn generate_conversation_summary(
    conversation_id: String,
    basic_model: Option<String>,
) -> napi::Result<String> {
    let token = CancellationToken::new();
    crate::api::cancel::register_summary(&conversation_id, token.clone());
    let result = generate_summary(conversation_id.clone(), basic_model, token).await;
    crate::api::cancel::unregister_summary(&conversation_id);
    result
}

/// Cancel an in-flight conversation summary generation.
///
/// Returns `true` if a summary was found and cancelled, `false` otherwise.
/// Call this from `handleAbort` / `handleRollback` so the summary's
/// `update_conversation_summary` write transaction is skipped before the
/// delete/truncate runs, avoiding a "database is locked" race.
#[napi]
pub fn cancel_conversation_summary(conversation_id: String) -> napi::Result<bool> {
    Ok(crate::api::cancel::cancel_summary(&conversation_id))
}

/// Run a natural-language file search agent over a workspace.
///
/// The agent drives the configured basic model with the read-only MCP tools
/// (`grep-search`, `filesystem-read`) in a loop of at most 10 tool-call
/// rounds, then returns the matching files as `FileSearchResult` entries.
/// Request scheme follows the active API config (chat / responses /
/// anthropic / gemini). `onProgress` is invoked after every tool execution
/// so the UI can display the search process.
#[napi(
    ts_args_type = "query: string, workspacePath: string, onProgress: ((chunk: FileSearchAgentProgress) => void) | undefined"
)]
pub async fn search_files_by_agent(
    query: String,
    workspace_path: String,
    on_progress: Option<FileSearchAgentProgressCallback>,
) -> napi::Result<Vec<FileSearchResult>> {
    let token = CancellationToken::new();
    run_agent(query, workspace_path, token, on_progress).await
}

#[napi]
pub async fn list_mcp_tools() -> napi::Result<Vec<McpToolDefinition>> {
    list_all_mcp_tools().await
}

#[napi]
pub async fn list_available_skills(
    project_id: Option<String>,
) -> napi::Result<Vec<SkillDefinition>> {
    SkillsService::new()
        .list_available(project_id.as_deref())
        .await
}

#[napi]
pub async fn set_skill_enabled(
    project_id: Option<String>,
    skill_id: String,
    enabled: bool,
) -> napi::Result<()> {
    SkillsService::new()
        .set_enabled(project_id.as_deref(), &skill_id, enabled)
        .await
}

#[napi]
pub async fn list_project_skills(project_id: String) -> napi::Result<Vec<ProjectSkillDefinition>> {
    SkillsService::new().list_project(&project_id).await
}

#[napi]
pub async fn set_project_skill_enabled(
    project_id: String,
    skill_id: String,
    enabled: bool,
) -> napi::Result<()> {
    SkillsService::new()
        .set_project_enabled(&project_id, &skill_id, enabled)
        .await
}

#[napi]
pub async fn list_mcp_server_tools(
    config_server_id: String,
) -> napi::Result<Vec<McpToolStatus>> {
    list_server_tools(config_server_id).await
}

#[napi]
pub async fn list_mcp_project_servers(
    project_id: String,
) -> napi::Result<Vec<McpProjectServerStatus>> {
    list_project_servers(project_id).await
}

/// 项目 MCP 服务器快速列表：外部服务器工具只读进程内缓存（不连接服务器），
/// 未命中的服务器以 `toolsPending` 标记，交给前端后台补发现。保存 / 启停 /
/// 删除配置后的列表刷新使用它，避免被慢服务器的 connect + tools/list 阻塞。
#[napi]
pub async fn list_mcp_project_servers_cached(
    project_id: String,
) -> napi::Result<Vec<McpProjectServerStatus>> {
    list_cached_project_servers(project_id).await
}

/// 返回仍注册在案的只读内置工具全名（UI 权限面板默认授权用）。
#[napi]
pub fn list_readonly_tools() -> Vec<String> {
    crate::mcp::builtin::list_readonly_tools()
}

#[napi]
pub async fn list_mcp_project_server_tools(
    project_id: String,
    server_id: String,
) -> napi::Result<Vec<McpProjectToolStatus>> {
    list_project_server_tools(project_id, server_id).await
}

#[napi]
pub async fn set_mcp_project_server_enabled(
    project_id: String,
    server_id: String,
    enabled: bool,
) -> napi::Result<()> {
    set_project_server_enabled(project_id, server_id, enabled).await
}

#[napi]
pub async fn set_mcp_project_tool_enabled(
    project_id: String,
    tool_name: String,
    enabled: bool,
) -> napi::Result<()> {
    set_project_tool_enabled(project_id, tool_name, enabled).await
}

#[napi]
pub async fn set_mcp_tool_enabled(tool_name: String, enabled: bool) -> napi::Result<()> {
    set_tool_enabled(tool_name, enabled).await
}

#[napi]
pub async fn set_mcp_tools_enabled(tool_names: Vec<String>, enabled: bool) -> napi::Result<()> {
    set_tools_enabled(tool_names, enabled).await
}

#[napi]
pub async fn set_mcp_project_tools_enabled(
    project_id: String,
    tool_names: Vec<String>,
    enabled: bool,
) -> napi::Result<()> {
    set_project_tools_enabled(project_id, tool_names, enabled).await
}

#[napi]
pub async fn authorize_sensitive_command(command: String, token: String) -> napi::Result<()> {
    authorize_command(command, token).await
}

/// Evaluate a command that matched a sensitive rule with the configured decision
/// model (TypeSafe System One / Jev).
///
/// The verdict is a risk judgement of the command's real effect in
/// `workingDirectory` (with the model's own `description` as context) — a rule
/// match alone never decides it. Returns `None` when the assist is disabled,
/// the command matches no rule, or no usable decision model is selected — the
/// caller then keeps the plain confirmation prompt. Transport / protocol
/// failures are reported as errors so the caller can fall back the same way
/// instead of acting on a guess.
#[napi]
pub async fn evaluate_sensitive_command_decision(
    command: String,
    project_id: Option<String>,
    working_directory: Option<String>,
    description: Option<String>,
) -> napi::Result<Option<SensitiveCommandDecisionRecord>> {
    let command = command.trim().to_string();
    if command.is_empty() {
        return Ok(None);
    }

    let working_directory = working_directory.unwrap_or_default().trim().to_string();
    let description = description.unwrap_or_default().trim().to_string();

    let database_path = PathBuf::from(initialize_app_storage()?.database_path);

    // 设置、规则表与决策模型配置都是同步 SQLite 读取，放入阻塞线程执行，
    // 避免阻塞 Node.js 主线程。
    let (assist, matched_rules, decision_models) = {
        let db_path = database_path.clone();
        let candidate = command.clone();
        tokio::task::spawn_blocking(move || {
            let assist =
                crate::storage::services::system_settings::get_sensitive_command_assist(&db_path)?;
            let matched_rules =
                crate::storage::check_sensitive_command_match(vec![(candidate, None)], project_id)?;
            let decision_models = crate::api::jev::load_decision_models(&db_path);
            Ok::<_, Error>((assist, matched_rules, decision_models))
        })
        .await
        .map_err(|e| {
            Error::from_reason(format!(
                "Failed to load sensitive command decision context: {e}"
            ))
        })?
    }?;

    // 未开启辅助、未命中规则、或选中的决策模型不可用时，保持原有确认流程。
    if !assist.enabled || matched_rules.is_empty() {
        return Ok(None);
    }

    let Some(selected) =
        crate::api::jev::find_enabled_decision_model(&decision_models, &assist.model_id)
    else {
        return Ok(None);
    };
    let model_name = if selected.name.trim().is_empty() {
        selected.model.clone()
    } else {
        selected.name.trim().to_string()
    };

    let Some(config) =
        crate::api::jev::JevConfig::from_decision_model(&decision_models, &assist.model_id)
    else {
        return Ok(None);
    };

    let verdict = crate::api::jev::evaluate_command(
        &config,
        &crate::api::jev::CommandContext {
            command: &command,
            description: &description,
            working_directory: &working_directory,
            matched_rules: &matched_rules,
        },
    )
    .await?;

    Ok(Some(SensitiveCommandDecisionRecord {
        allow: verdict.allow,
        reason: verdict.reason,
        confidence: verdict.confidence,
        delegate: assist.delegate,
        model_name,
    }))
}

#[napi]
pub async fn write_interactive_stdin(session_id: String, input: String) -> napi::Result<()> {
    write_interactive_stdin_impl(session_id, input).await
}

#[napi(
    ts_args_type = "toolFullName: string, argsJson: string, projectId: string | undefined, checkpointIds: string[] | undefined, checkpointWorkDir: string | undefined, sensitiveAuthorizationToken: string | undefined, onChunk: (chunk: BashStreamChunk) => void, onBrowserCommand: (command: BrowserCommand) => Promise<string>, onWebSearchCommand: (command: WebSearchCommand) => Promise<string>, onUserQuestion: (question: UserQuestionCommand) => Promise<string>, onAppControl: (command: AppControlCommand) => Promise<string>, onRemoteWorkspaceCommand: (command: RemoteWorkspaceCommand) => Promise<string>, onTerminalCommand: (command: TerminalCommand) => Promise<string>, subAgentAllowedTools: string[] | undefined, planMode: boolean | undefined, planApproved: boolean | undefined, conversationId: string | undefined",
    ts_return_type = "Promise<string>"
)]
pub async fn call_mcp_tool(
    tool_full_name: String,
    args_json: String,
    project_id: Option<String>,
    checkpoint_ids: Option<Vec<String>>,
    checkpoint_work_dir: Option<String>,
    sensitive_authorization_token: Option<String>,
    on_chunk: BashStreamCallback,
    on_browser_command: BrowserCommandCallback,
    on_websearch_command: WebSearchCommandCallback,
    on_user_question: UserQuestionCallback,
    on_app_control: AppControlCallback,
    on_remote_workspace_command: RemoteWorkspaceCallback,
    on_terminal_command: TerminalCommandCallback,
    sub_agent_allowed_tools: Option<Vec<String>>,
    plan_mode: Option<bool>,
    plan_approved: Option<bool>,
    conversation_id: Option<String>,
) -> napi::Result<String> {
    call_tool(
        tool_full_name,
        args_json,
        project_id,
        checkpoint_ids.unwrap_or_default(),
        checkpoint_work_dir,
        sensitive_authorization_token,
        on_chunk,
        on_browser_command,
        on_websearch_command,
        on_user_question,
        on_app_control,
        on_remote_workspace_command,
        on_terminal_command,
        sub_agent_allowed_tools,
        plan_mode.unwrap_or(false),
        plan_approved.unwrap_or(false),
        conversation_id,
    )
    .await
}

#[napi(object)]
pub struct WorkflowGraphValidationResult {
    /// Topological execution order of node ids (Kahn's algorithm).
    pub order: Vec<String>,
    /// Structural validation problems; empty when the graph is valid.
    pub errors: Vec<String>,
}

/// Validate a WorkFlow graph and compute its topological execution order in
/// Rust — the single source of truth for topology. The renderer runner calls
/// this instead of re-implementing Kahn's algorithm / cycle detection, so the
/// executed order always matches the MCP tool's own validation.
#[napi]
pub async fn validate_workflow_graph(
    nodes_json: String,
    edges_json: String,
) -> napi::Result<WorkflowGraphValidationResult> {
    tokio::task::spawn_blocking(move || {
        let nodes: Vec<Value> = serde_json::from_str(&nodes_json).unwrap_or_default();
        let edges: Vec<Value> = serde_json::from_str(&edges_json).unwrap_or_default();
        let (order, errors) = validate_workflow_graph_impl(&nodes, &edges);
        Ok(WorkflowGraphValidationResult { order, errors })
    })
    .await
    .map_err(|e| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to execute validate_workflow_graph: {e}"),
        )
    })?
}
