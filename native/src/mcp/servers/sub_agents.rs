use napi::bindgen_prelude::*;
use serde_json::{json, Value};

use super::super::service::McpService;
use super::super::tools::McpTool;

const SERVER_ID: &str = "sub-agents";
const TOOL_NAME: &str = "activate";
const TOOL_LIST_TEAMMATES: &str = "listTeammates";
const TOOL_SEND_MESSAGE: &str = "sendMessage";
const TOOL_LIST_SUB_AGENTS: &str = "listSubAgents";
const TOOL_CONTINUE: &str = "continue";

/// 所有子代理默认携带的队友通信工具全名（查询在线队友 / 向队友发消息）。
/// 仅子代理上下文可见：collect_all_mcp_tools（主会话工具集）不包含它们，
/// collect_allowed_mcp_tools 无条件追加，因此无需用户配置。
pub const SUB_AGENT_COMMS_TOOL_FULL_NAMES: &[&str] = &[
    "sub-agents-listTeammates",
    "sub-agents-sendMessage",
];

/// 主会话（父 agent）专用的子代理管理工具全名（查询当前会话子代理 /
/// 向子代理继续发送消息并重新激活）。仅主会话工具集可见：
/// collect_all_mcp_tools 正常包含它们，collect_allowed_mcp_tools（子代理
/// 工具集）显式过滤，因此子代理永远不会看到这两个工具 —— 重新激活
/// 是父会话的职权，会话隔离由渲染进程执行时强制校验。
pub const SUB_AGENT_MAIN_TOOL_FULL_NAMES: &[&str] = &[
    "sub-agents-listSubAgents",
    "sub-agents-continue",
];

/// 子代理默认携带的两个通信工具定义。执行由渲染进程完成（子代理运行时状态
/// 与 Pending 队列都在渲染进程），Rust 侧 execute 返回桥接错误。
pub fn sub_agent_comms_tools() -> Vec<McpTool> {
    vec![
        McpTool {
            server_id: SERVER_ID.to_string(),
            name: TOOL_LIST_TEAMMATES.to_string(),
            description: "Query the sub-agents currently online (running) in the SAME conversation session. Returns their conversationId, agentId and agentName. Only teammates of the same session are visible - sub-agents from other conversations are never exposed. Use the returned conversationId with sub-agents-sendMessage to talk to a teammate."
                .to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {},
                "additionalProperties": false
            }),
        },
        McpTool {
            server_id: SERVER_ID.to_string(),
            name: TOOL_SEND_MESSAGE.to_string(),
            description: "Send a message to a teammate sub-agent that is still running in the SAME conversation session (identified via sub-agents-listTeammates). The message is delivered as a Pending message: the target receives it automatically at the end of its current round, when it is ready to continue. The queued message is prefixed with the sender's identity so the target always knows where the message came from. Messages to sub-agents of other conversations are rejected (session isolation)."
                .to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "conversationId": {
                        "type": "string",
                        "description": "The target teammate sub-agent conversationId, as returned by sub-agents-listTeammates."
                    },
                    "message": {
                        "type": "string",
                        "description": "The message content to send. It will be queued and delivered to the target at its next round boundary."
                    }
                },
                "required": ["conversationId", "message"],
                "additionalProperties": false
            }),
        },
    ]
}

pub struct SubAgentsService;

impl SubAgentsService {
    pub fn new() -> Self {
        SubAgentsService
    }
}

impl McpService for SubAgentsService {
    fn id(&self) -> &str {
        SERVER_ID
    }

    fn tools(&self) -> Vec<McpTool> {
        vec![
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: TOOL_NAME.to_string(),
                description: "Activate a sub-agent to handle a complex task independently. The sub-agent runs its own AI loop with a restricted tool set and returns a final summary. Use this when a task requires focused, multi-step execution that benefits from isolation. The sub-agent has NO access to the main conversation history - all context must be provided in the prompt."
                    .to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "agentId": {
                            "type": "string",
                            "description": "The sub-agent configuration identifier, chosen from the available sub-agents listed in the system prompt's Sub-Agents section (query config-list scope=subAgents if uncertain). The built-in 'agent_general' is a generic fallback - prefer a task-specific agent when one is configured."
                        },
                        "prompt": {
                            "type": "string",
                            "description": "Complete task description with all required context, file paths, requirements, and constraints. The sub-agent has no access to the main conversation history."
                        }
                    },
                    "required": ["agentId", "prompt"]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: TOOL_LIST_SUB_AGENTS.to_string(),
                description: "List the sub-agents of the CURRENT conversation session, including finished ones (only those activated during this app run are listed). Returns conversationId, agentId, agentName, status (running/completed/failed/cancelled) and resumable for each. Only sub-agents belonging to the current conversation are returned (session isolation). Use sub-agents-continue with a returned conversationId to resume a finished sub-agent."
                    .to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {},
                    "additionalProperties": false
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: TOOL_CONTINUE.to_string(),
                description: "Send a message to a sub-agent of the CURRENT conversation session and resume it: if the target has finished it is reactivated and keeps its original configuration (model, tools, system prompt) and full conversation history; if it is still running the message is queued as a Pending message delivered at the end of its current round. The queued message is prefixed with the sender's identity. Only sub-agents belonging to the current conversation can be resumed - sub-agents of other conversations are rejected (session isolation)."
                    .to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "conversationId": {
                            "type": "string",
                            "description": "The target sub-agent conversationId, as returned by sub-agents-listSubAgents."
                        },
                        "message": {
                            "type": "string",
                            "description": "The message content to send. It resumes the sub-agent, or is queued for delivery at the end of its current round when the target is still running."
                        }
                    },
                    "required": ["conversationId", "message"],
                    "additionalProperties": false
                }),
            },
        ]
    }

    fn execute(&self, tool_name: &str, _args: &Value) -> napi::Result<Value> {
        match tool_name {
            TOOL_NAME => Err(Error::new(
                Status::GenericFailure,
                "sub-agents activate must be executed through the asynchronous Electron interaction bridge"
                    .to_string(),
            )),
            TOOL_LIST_TEAMMATES | TOOL_SEND_MESSAGE => Err(Error::new(
                Status::GenericFailure,
                format!(
                    "sub-agents {tool_name} must be executed through the sub-agent runtime in the renderer process (session isolation and the Pending message queue live there)"
                ),
            )),
            TOOL_LIST_SUB_AGENTS | TOOL_CONTINUE => Err(Error::new(
                Status::GenericFailure,
                format!(
                    "sub-agents {tool_name} must be executed through the sub-agent runtime in the renderer process (session isolation and the resume state live there)"
                ),
            )),
            _ => Err(unknown_tool_error(tool_name)),
        }
    }
}

fn unknown_tool_error(tool_name: &str) -> napi::Error {
    Error::new(
        Status::GenericFailure,
        format!("Unknown sub-agents tool: {tool_name}"),
    )
}
