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
                collect_all_mcp_tools_for_workspace(
                    request.directory_id.as_deref(),
                    analysis_root,
                    request.plan_mode.unwrap_or(false),
                    request.workflow_mode.unwrap_or(false),
                )
                .await
            }
        },
    }
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
pub async fn resolve_request_tools_optional(
    request: &ResponsesApiRequest,
) -> Option<Vec<McpTool>> {
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
