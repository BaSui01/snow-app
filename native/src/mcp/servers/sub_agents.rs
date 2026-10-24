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
const TOOL_GET_RESULT: &str = "getResult";
const TOOL_WAIT: &str = "wait";
const TOOL_CANCEL: &str = "cancel";

/// 所有子代理默认携带的队友通信工具全名（查询在线队友 / 向队友发消息）。
/// 仅子代理上下文可见：collect_all_mcp_tools（主会话工具集）不包含它们，
/// collect_allowed_mcp_tools 无条件追加，因此无需用户配置。
pub const SUB_AGENT_COMMS_TOOL_FULL_NAMES: &[&str] =
    &["sub-agents-listTeammates", "sub-agents-sendMessage"];

/// 主会话（父 agent）专用的子代理管理工具全名（查询当前会话子代理 /
/// 向子代理继续发送消息并重新激活）。仅主会话工具集可见：
/// collect_all_mcp_tools 正常包含它们，collect_allowed_mcp_tools（子代理
/// 工具集）显式过滤，因此子代理永远不会看到这些管理工具 —— 重新激活
/// 是父会话的职权，会话隔离由渲染进程执行时强制校验。
pub const SUB_AGENT_MAIN_TOOL_FULL_NAMES: &[&str] = &[
    "sub-agents-listSubAgents",
    "sub-agents-continue",
    "sub-agents-getResult",
    "sub-agents-wait",
    "sub-agents-cancel",
];

/// 子代理永远不会获得的工具（唯一来源）：主会话管理工具 + Plan Mode /
/// WorkFlow 专属工具 + 会话编排。保存校验、收集与执行三处共用。
pub const SUB_AGENT_RESERVED_TOOL_FULL_NAMES: &[&str] = &[
    "sub-agents-listSubAgents",
    "sub-agents-continue",
    "sub-agents-getResult",
    "sub-agents-wait",
    "sub-agents-cancel",
    "app-control-requestApproval",
    "app-control-conversation",
    "workflow-workflow-generate",
    "workflow-workflow-resume",
];

pub fn is_sub_agent_reserved_tool(full_name: &str) -> bool {
    SUB_AGENT_RESERVED_TOOL_FULL_NAMES.contains(&full_name)
}

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
        let mut tools = vec![
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: TOOL_NAME.to_string(),
                description: "Activate a sub-agent to handle a complex task independently. The sub-agent runs its own AI loop with a restricted tool set and returns its final-turn text as summary, not a complete transcript; open the child conversation for intermediate reports. Acceptance evidence IDs prove execution-log provenance, not semantic relevance or business correctness; the parent must verify directly supporting tool results. Use this when a task requires focused, multi-step execution that benefits from isolation. The sub-agent has NO access to the main conversation history - all context must be provided in the prompt. SUMMARY: the required summary field is a short label for THIS activation - it becomes the sub-agent conversation's title and summary (shown in the sidebar sub-agent list), so make it specific enough to tell parallel siblings apart. PARALLEL ACTIVATION: ONE call activates ONE sub-agent; to run several sub-agents side by side, call this tool MULTIPLE TIMES in the SAME batch - one call per sub-agent, each with its own fully self-contained prompt. Sub-agents activated in one batch start concurrently, so do NOT wait for one activation to finish before starting the next independent one. OPTIONAL ACCEPTANCE CHECKLIST: pass acceptance [{ id, description, required? }] when the task has must-happen steps that a natural-language summary could hide (a submitted form, a verified total, a written file). The sub-agent must then end with a fenced acceptance JSON block reporting every item with a status and evidence ids from its real tool results; the host validates those ids against the execution log, downgrades completed without valid evidence to unverified, and returns an acceptance receipt with per-item status. Omit it for tasks that only need the natural-language summary."
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
                        },
                        "summary": {
                            "type": "string",
                            "description": "Short one-line summary of this activation (a few words to one sentence), written in the same language as the user's request. It becomes the sub-agent conversation's title and summary, and is what the user sees in the sidebar sub-agent list - keep several parallel sub-agents clearly distinguishable (e.g. 'Fix sidebar layout', 'Research Electron IPC')."
                        },
                        "executionMode": { "type": "string", "enum": ["sync", "async"], "description": "Compatibility parameter; the user's Sub-agent Settings execution mode is authoritative (default sync) and cannot be overridden by this argument. Sync waits for a final result; async returns a durable accepted receipt, not completion. Busy continue still queues a message immediately." },
                        "requestId": { "type": "string", "minLength": 1, "maxLength": 160, "description": "Stable logical request identity. The host derives one from the tool call when omitted; reuse it after an unknown receipt, use a new one only for an intentional new operation." },
                        "acceptance": {
                            "type": "array",
                            "description": "Optional acceptance checklist for this delegated task. The sub-agent must report every item with a status and evidence ids taken from its real tool results; the host validates those ids against the execution log, downgrades `completed` without valid evidence to `unverified`, and returns an acceptance receipt with per-item status. Omit it for tasks that only need the natural-language summary.",
                            "maxItems": 20,
                            "items": {
                                "type": "object",
                                "properties": {
                                    "id": {
                                        "type": "string",
                                        "description": "Stable short id (letters, digits, dot, underscore, colon or dash) cited back in the receipt."
                                    },
                                    "description": {
                                        "type": "string",
                                        "description": "What must actually be true for this item to count as done."
                                    },
                                    "required": {
                                        "type": "boolean",
                                        "description": "Defaults to true. Optional items are reported but never block acceptance."
                                    }
                                },
                                "required": ["id", "description"],
                                "additionalProperties": false
                            }
                        }
                    },
                    "required": ["agentId", "summary", "prompt"]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: TOOL_LIST_SUB_AGENTS.to_string(),
                description: "List sub-agents belonging to the CURRENT parent conversation, including durable run history when project-bound persistence is available. Returns legacy session information plus durable active/latest run identities and real run states; legacy sessions without run records are not fabricated. Use sub-agents-getResult with an exact runId for persisted outcome, acceptance and paged summary. Stored acceptance receipts survive restart, but nonterminal runs become interrupted and never resume automatically. Legacy no-project sync retains runtime-only history. Use sub-agents-continue with a returned conversationId to start an explicit new run after terminal completion; a busy target queues the message immediately. To continue independent sub-agents in parallel, call sub-agents-continue multiple times in the same batch. UI reads do not acknowledge delivery to the parent model."
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
                description: "Send a message to a sub-agent of the CURRENT conversation session and resume it: if the target has finished it is reactivated and keeps its original configuration (model, tools, system prompt) and full conversation history; if it is still running the message is queued as a Pending message delivered at the end of its current round. The queued message is prefixed with the sender's identity. Only sub-agents belonging to the current conversation can be resumed - sub-agents of other conversations are rejected (session isolation). PARALLEL RESUME: ONE call resumes ONE sub-agent; to reactivate several sub-agents, call this tool MULTIPLE TIMES in the SAME batch - one call per conversationId. A batch of continue calls runs concurrently (exactly like a batch of sub-agents-activate calls), so do NOT resume them one by one. ACCEPTANCE: pass acceptance [{ id, description, required? }] to add checklist items or refine their wording for this sub-agent; already recorded per-item status is preserved, and the resumed run updates the same acceptance receipt. Omitting acceptance keeps the current checklist; tasks without a checklist behave exactly as before."
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
                        },
                        "executionMode": { "type": "string", "enum": ["sync", "async"], "description": "Compatibility parameter; the user's Sub-agent Settings execution mode is authoritative (default sync) and cannot be overridden by this argument. Sync waits for a final result; async returns a durable accepted receipt, not completion. Busy continue still queues a message immediately." },
                        "requestId": { "type": "string", "minLength": 1, "maxLength": 160, "description": "Stable logical request identity. The host derives one from the tool call when omitted; reuse it after an unknown receipt, use a new one only for an intentional new operation." },
                        "acceptance": {
                            "type": "array",
                            "description": "Optional checklist additions or wording refinements for this sub-agent. Existing item ids keep their recorded status; new ids are appended. After the resumed run the sub-agent reports again and the same acceptance record is updated.",
                            "maxItems": 20,
                            "items": {
                                "type": "object",
                                "properties": {
                                    "id": {
                                        "type": "string",
                                        "description": "Stable short id (letters, digits, dot, underscore, colon or dash); reuse an existing id to refine its wording."
                                    },
                                    "description": {
                                        "type": "string",
                                        "description": "What must actually be true for this item to count as done."
                                    },
                                    "required": {
                                        "type": "boolean",
                                        "description": "Defaults to true. Optional items are reported but never block acceptance."
                                    }
                                },
                                "required": ["id", "description"],
                                "additionalProperties": false
                            }
                        }
                    },
                    "required": ["conversationId", "message"],
                    "additionalProperties": false
                }),
            },
        ];
        tools.extend(async_management_tools());
        tools
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
            TOOL_LIST_SUB_AGENTS | TOOL_CONTINUE | TOOL_GET_RESULT | TOOL_WAIT | TOOL_CANCEL => Err(Error::new(
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

/// These management operations remain desktop-parent-only, never delegated tools.
fn async_management_tools() -> Vec<McpTool> {
    vec![
        McpTool { server_id: SERVER_ID.into(), name: TOOL_GET_RESULT.into(),
            description: "Read one durable sub-agent run in this parent conversation. A running state is not completion. Terminal results include typed outcome, acceptance and errors; summary pages contain final-turn text, not the full transcript. Acceptance evidence establishes log provenance, not semantic relevance or business correctness. Optional cancellation metadata records the first accepted source; missing historical metadata is unknown. UI reads do not acknowledge model delivery. Do not repeatedly poll: use wait(any/all) for dependencies.".into(),
            input_schema: json!({"type":"object","properties":{
                "runId":{"type":"string","minLength":1},"offset":{"type":"integer","minimum":0},
                "limit":{"type":"integer","minimum":1,"maximum":64000,"default":16000}},"required":["runId"],"additionalProperties":false}) },
        McpTool { server_id: SERVER_ID.into(), name: TOOL_WAIT.into(),
            description: "Wait for any or all identified runs using one bounded deadline. Defaults any/30000ms. Both modes return snapshots for EVERY requested run: any succeeds when at least one is terminal, all when every run is terminal. Result count does not distinguish the modes. Timeout never cancels execution. All IDs must belong to this parent and project; unknown IDs fail. Use async dispatch plus wait(any) to process independent results, not repeated polling. Long synchronous tools retain their batch barrier.".into(),
            input_schema: json!({"type":"object","properties":{
                "runIds":{"type":"array","minItems":1,"maxItems":32,"uniqueItems":true,"items":{"type":"string","minLength":1}},
                "mode":{"type":"string","enum":["any","all"],"default":"any"},
                "timeoutMs":{"type":"integer","minimum":0,"maximum":120000,"default":30000}},"required":["runIds"],"additionalProperties":false}) },
        McpTool { server_id: SERVER_ID.into(), name: TOOL_CANCEL.into(),
            description: "Request cancellation of one run. requested is not confirmation of stopped execution; confirmed means cancelled, already_terminal preserves the terminal result, too_late means finalizing won the race. Optional cancellation metadata preserves the first accepted source/time, never the source of a later retry. Missing historical attribution is unknown. Never claim to undo files or external side effects.".into(),
            input_schema: json!({"type":"object","properties":{"runId":{"type":"string","minLength":1}},"required":["runId"],"additionalProperties":false}) },
    ]
}
