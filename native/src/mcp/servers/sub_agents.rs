use napi::bindgen_prelude::*;
use serde_json::{json, Value};

use super::super::service::McpService;
use super::super::tools::McpTool;

const SERVER_ID: &str = "sub-agents";
const TOOL_NAME: &str = "activate";

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
        vec![McpTool {
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
        }]
    }

    fn execute(&self, tool_name: &str, _args: &Value) -> napi::Result<Value> {
        match tool_name {
            TOOL_NAME => Err(Error::new(
                Status::GenericFailure,
                "sub-agents activate must be executed through the asynchronous Electron interaction bridge"
                    .to_string(),
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
