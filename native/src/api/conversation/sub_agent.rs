use napi::bindgen_prelude::*;

use crate::api::responses::ResponsesApiRequest;
use crate::mcp::tools::{
    collect_all_mcp_tools_for_workspace, collect_allowed_mcp_tools_for_workspace,
    collect_restricted_mcp_tools_for_workspace, McpTool,
};

/// Resolve the MCP tool set for a request.
///
/// Resolution order:
/// 1. `sub_agent_tools_json` (sub-agent request): whitelist filtering. Wildcard
///    legality (agent_general only) is enforced on save and when the renderer
///    resolves the runtime config by agentId.
/// 2. `allowed_tools_json` (request-scoped whitelist without sub-agent
///    semantics, e.g. the desktop pet chat): restricted set that survives
///    `skip_context` and never carries teammate/sub-agent management tools.
/// 3. Otherwise all project-scoped tools (the normal main-conversation path).
///
/// The dedicated Plan Mode approval tool is injected only into Plan Mode main
/// conversation requests and is never added to a whitelist implicitly.
pub async fn resolve_request_tools(request: &ResponsesApiRequest) -> Result<Vec<McpTool>> {
    let analysis_root = request
        .analysis_workspace_root
        .as_deref()
        .map(std::path::Path::new);
    match request.sub_agent_tools_json.as_deref() {
        Some(tools_json) if !tools_json.trim().is_empty() => {
            collect_allowed_mcp_tools_for_workspace(
                request.directory_id.as_deref(),
                analysis_root,
                tools_json,
                true,
            )
            .await
        }
        _ => match request.allowed_tools_json.as_deref() {
            Some(tools_json) if !tools_json.trim().is_empty() => {
                collect_restricted_mcp_tools_for_workspace(
                    request.directory_id.as_deref(),
                    analysis_root,
                    tools_json,
                )
                .await
            }
            _ => {
                let mut tools = collect_all_mcp_tools_for_workspace(
                    request.directory_id.as_deref(),
                    analysis_root,
                    request.plan_mode.unwrap_or(false),
                    request.workflow_mode.unwrap_or(false),
                )
                .await?;
                apply_sub_agent_tool_policy(request, &mut tools).await?;
                Ok(tools)
            }
        },
    }
}

/// Request-only policy: intersect with discovery, never enable a disabled tool
/// or overwrite user MCP preferences. Existing runs keep their captured mode.
async fn apply_sub_agent_tool_policy(
    request: &ResponsesApiRequest,
    tools: &mut Vec<McpTool>,
) -> Result<()> {
    if !tools.iter().any(|tool| tool.server_id == "sub-agents") {
        return Ok(());
    }
    let project_id = request
        .directory_id
        .clone()
        .filter(|id| !id.trim().is_empty());
    let conversation_id = request
        .conversation_id
        .clone()
        .filter(|id| !id.trim().is_empty());
    let policy = tokio::task::spawn_blocking(move || -> Result<_> {
        use crate::storage::services::{chat_conversations, system_settings};
        let storage = crate::storage::initialize_app_storage()?;
        let path = std::path::Path::new(&storage.database_path);
        let mode = system_settings::get_system_setting_value(path, "sub_agent_execution_mode")?;
        let asynchronous = match mode.as_deref() {
            None | Some("") | Some("sync") => false,
            Some("async") => true,
            _ => {
                return Err(Error::from_reason(
                    "CONFIGURATION_ERROR: invalid sub-agent execution mode setting",
                ))
            }
        };
        let conversation = conversation_id
            .as_deref()
            .map(|id| chat_conversations::get_chat_conversation(path, id))
            .transpose()?
            .flatten();
        if conversation.as_ref().is_some_and(|record| {
            project_id
                .as_deref()
                .is_some_and(|project| record.directory_id != project)
        }) {
            return Err(Error::from_reason(
                "PERMISSION_DENIED: sub-agent tool scope mismatch",
            ));
        }
        let workflow_node = conversation
            .as_ref()
            .is_some_and(|record| record.conversation_type == "workflow_node");
        let supports_async = project_id.is_some() && !workflow_node;
        let (has_history, has_active) = if !asynchronous && supports_async {
            match (project_id.as_deref(), conversation.as_ref()) {
                (Some(project), Some(record)) => chat_conversations::sub_agent_async_tool_usage(
                    path,
                    project,
                    &record.conversation_id,
                )?,
                _ => (false, false),
            }
        } else {
            (false, false)
        };
        Ok((asynchronous, supports_async, has_history, has_active))
    })
    .await
    .map_err(|error| {
        Error::from_reason(format!("Failed to load sub-agent tool policy: {error}"))
    })??;
    let (asynchronous, supports_async, has_history, has_active) = policy;
    tools.retain(|tool| {
        if tool.server_id != "sub-agents" {
            return true;
        }
        match tool.name.as_str() {
            "getResult" => supports_async && (asynchronous || has_history),
            "wait" | "cancel" => supports_async && (asynchronous || has_active),
            "activate" | "continue" => !asynchronous || supports_async,
            _ => true,
        }
    });
    let has_result_tool = tools
        .iter()
        .any(|tool| tool.full_name() == "sub-agents-getResult");
    let has_wait_tool = tools
        .iter()
        .any(|tool| tool.full_name() == "sub-agents-wait");
    let has_continue_tool = tools
        .iter()
        .any(|tool| tool.full_name() == "sub-agents-continue");
    for tool in tools
        .iter_mut()
        .filter(|tool| tool.server_id == "sub-agents")
    {
        match tool.name.as_str() {
            "activate" | "continue" => {
                let policy = if asynchronous {
                    "Current user-selected execution mode: async. Returns durable acceptance, NOT completion. Tool arguments cannot override the setting."
                } else {
                    "Current user-selected execution mode: sync. Waits for the final result; no follow-up wait is needed for this dispatch. Busy continue only queues a message. Tool arguments cannot override the setting."
                };
                tool.description = format!("{policy}\n\n{}", tool.description);
            }
            "getResult" if !has_wait_tool => {
                tool.description = "Read one durable sub-agent run in this parent conversation. A running state is not completion. Terminal results include typed outcome, acceptance and errors; summary is paged. UI reads do not acknowledge model delivery. Do not repeatedly poll; this request does not expose the wait tool.".to_string();
            }
            "listSubAgents" => {
                tool.description = "List sub-agents belonging to the CURRENT parent conversation, with actual active/latest run identities when persistence is available. Legacy records do not invent runs or acceptance evidence. UI reads do not acknowledge model delivery. Restarted nonterminal runs become interrupted and never resume automatically.".to_string();
                if has_continue_tool {
                    tool.description.push_str(" Use sub-agents-continue with a returned conversationId to explicitly resume; a busy target only queues the message.");
                }
                if has_result_tool {
                    tool.description.push_str(" Use sub-agents-getResult with an exact runId for persisted outcome, acceptance and paged summary.");
                }
                if has_wait_tool {
                    tool.description.push_str(
                        " Use sub-agents-wait for dependencies instead of polling this list.",
                    );
                }
            }
            _ => {}
        }
    }
    Ok(())
}

/// Whether the request should resolve MCP tools at all.
///
/// `skip_context` suppresses tools only for requests WITHOUT an explicit
/// whitelist (lightweight single-shot completions such as the commit-message
/// generator). A request-scoped whitelist keeps its tools even when the
/// conversation context is skipped, which is what the desktop pet's stateless
/// side channel relies on.
pub fn should_resolve_tools(request: &ResponsesApiRequest) -> bool {
    !(request.context_compaction.unwrap_or(false)
        || request.disable_tools.unwrap_or(false)
        || (request.skip_context.unwrap_or(false) && !request.has_allowed_tools()))
}

/// Provider entry point: resolve this request's MCP tools, returning `None`
/// when the request must run without tools. Discovery failures log and degrade
/// to `None` so a broken tool discovery never fails the chat request.
pub async fn resolve_request_tools_optional(request: &ResponsesApiRequest) -> Option<Vec<McpTool>> {
    if !should_resolve_tools(request) {
        return None;
    }
    resolve_request_tools(request)
        .await
        .map_err(|error| {
            eprintln!("Failed to prepare request MCP tools: {error}");
        })
        .ok()
}
