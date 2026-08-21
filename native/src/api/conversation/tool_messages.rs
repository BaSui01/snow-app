use std::collections::HashSet;
use std::path::Path;

use serde_json::Value;

use crate::api::conversation::images::{parse_chat_message_content, ChatImage};
use crate::storage::services::chat_conversations::ChatContextMessage;

/// Convert stored tool_calls_json (any provider format) into Anthropic
/// tool_use content blocks.
///
/// The storage layer persists whichever native format the originating
/// provider returned, so this function must accept all of them:
/// - **OpenAI Chat**: `{"id":"...","type":"function","function":{"name":"...","arguments":"..."}}`
/// - **OpenAI Responses**: `{"type":"function_call","call_id":"...","name":"...","arguments":"..."}`
/// - **Anthropic**: `{"type":"tool_use","id":"...","name":"...","input":{...}}`
/// - **Gemini**: `{"functionCall":{"name":"...","args":{...}}}`
pub fn tool_calls_as_anthropic_blocks(tool_calls_json: &str) -> Vec<Value> {
    normalize_tool_calls(tool_calls_json)
        .into_iter()
        .map(|entry| {
            serde_json::json!({
                "type": "tool_use",
                "id": entry.id,
                "name": entry.name,
                "input": entry.input,
            })
        })
        .collect()
}

/// Convert stored tool_calls_json (any provider format) into Gemini
/// functionCall parts.
pub fn tool_calls_as_gemini_parts(tool_calls_json: &str) -> Vec<Value> {
    normalize_tool_calls(tool_calls_json)
        .into_iter()
        .map(|entry| {
            serde_json::json!({
                "functionCall": {
                    "name": entry.name,
                    "args": entry.input,
                }
            })
        })
        .collect()
}

/// Convert stored tool_calls_json (any provider format) into OpenAI Chat
/// Completions `tool_calls` entries.
///
/// Chat Completions requires the nested shape
/// `{"id":"...","type":"function","function":{"name":"...","arguments":"..."}}`
/// with `arguments` serialized as a JSON string. Stored history may come
/// from any provider — notably OpenAI Responses items
/// (`{"type":"function_call","call_id":"...","name":"...","arguments":"..."}`),
/// which Chat Completions endpoints reject with
/// `unknown variant function_call, expected function` when passed through
/// verbatim (see issue #26: switching from a Responses-model conversation
/// to a Chat-model one). Normalizing here keeps the tool calls (including
/// their arguments) intact across request-method switches.
pub fn tool_calls_as_chat_completions(tool_calls_json: &str) -> Vec<Value> {
    normalize_tool_calls(tool_calls_json)
        .into_iter()
        .map(|entry| {
            let arguments =
                serde_json::to_string(&entry.input).unwrap_or_else(|_| "{}".to_string());
            serde_json::json!({
                "id": entry.id,
                "type": "function",
                "function": {
                    "name": entry.name,
                    "arguments": arguments,
                }
            })
        })
        .collect()
}

/// Parse tool_results_json into (name, callId, result) tuples.
pub fn parse_tool_results_json(raw: &str) -> Vec<(String, String, String)> {
    parse_tool_result_records(raw)
        .into_iter()
        .map(|record| (record.name, record.call_id, record.result))
        .collect()
}

struct ToolResultRecord {
    name: String,
    call_id: String,
    result: String,
    has_valid_shape: bool,
}

fn parse_tool_result_records(raw: &str) -> Vec<ToolResultRecord> {
    serde_json::from_str::<Vec<Value>>(raw)
        .unwrap_or_default()
        .into_iter()
        .map(|v| {
            let parsed_name = v.get("name").and_then(|x| x.as_str());
            let parsed_call_id = v.get("callId").and_then(|x| x.as_str());
            let parsed_result = v.get("result").and_then(|x| x.as_str());
            ToolResultRecord {
                name: parsed_name.unwrap_or("").to_string(),
                call_id: parsed_call_id.unwrap_or("").to_string(),
                result: parsed_result.unwrap_or("").to_string(),
                has_valid_shape: parsed_name.is_some_and(|name| !name.trim().is_empty())
                    && parsed_call_id.is_some_and(|call_id| !call_id.trim().is_empty())
                    && parsed_result.is_some(),
            }
        })
        .collect()
}

/// A tool result split into plain text and multimodal image blocks.
///
/// Screenshot tools (`browser-screenshot`) embed their PNG base64 payload as
/// `@@image:data:image/png;base64,...@@` tags inside the stored result string
/// (see `formatMcpToolResultForModel` in the renderer). Each provider payload
/// builder must emit those images as native multimodal content blocks
/// (`image_url` / `input_image` / `image` / `inlineData`) instead of leaking
/// the base64 into a plain-text tool result field, which wastes context and
/// cannot be interpreted as vision input by the model.
pub struct ParsedToolResult {
    pub name: String,
    pub call_id: String,
    pub text: String,
    pub images: Vec<ChatImage>,
    pub(crate) has_valid_shape: bool,
}

/// Parse tool_results_json and split `@@image:...@@` tags out of each result
/// into structured [`ChatImage`] blocks.
///
/// `skip_image_parsing` mirrors the per-request context skipping flag: when
/// set, results are passed through verbatim so no file I/O happens.
pub fn parse_tool_results_with_images(
    raw: &str,
    database_path: &Path,
    skip_image_parsing: bool,
) -> Vec<ParsedToolResult> {
    parse_tool_result_records(raw)
        .into_iter()
        .map(|record| {
            let ToolResultRecord {
                name,
                call_id,
                result,
                has_valid_shape,
            } = record;
            if skip_image_parsing || !result.contains("@@image:") {
                return ParsedToolResult {
                    name,
                    call_id,
                    text: result,
                    images: Vec::new(),
                    has_valid_shape,
                };
            }
            match parse_chat_message_content(&result, database_path) {
                Ok(parsed) => ParsedToolResult {
                    name,
                    call_id,
                    text: parsed.text,
                    images: parsed.images,
                    has_valid_shape,
                },
                Err(_) => ParsedToolResult {
                    name,
                    call_id,
                    text: result,
                    images: Vec::new(),
                    has_valid_shape,
                },
            }
        })
        .collect()
}

/// A provider-agnostic representation of a single tool call extracted from
/// the stored `tool_calls_json`. All conversion functions go through this
/// intermediate type so they automatically support every provider format.
pub(crate) struct NormalizedToolCall {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) input: Value,
    pub(crate) has_valid_name: bool,
    pub(crate) has_valid_input: bool,
}

/// Normalize a serialized tool_calls JSON array into [`NormalizedToolCall`]
/// entries, accepting any provider's native format:
/// - **OpenAI Chat**: `{"id":"...","type":"function","function":{"name":"...","arguments":"..."}}`
/// - **OpenAI Responses**: `{"type":"function_call","call_id":"...","name":"...","arguments":"..."}`
/// - **Anthropic**: `{"type":"tool_use","id":"...","name":"...","input":{...}}`
/// - **Gemini**: `{"functionCall":{"name":"...","args":{...}}}`
pub(crate) fn normalize_tool_calls(tool_calls_json: &str) -> Vec<NormalizedToolCall> {
    let Ok(parsed) = serde_json::from_str::<Value>(tool_calls_json) else {
        return Vec::new();
    };
    let Some(array) = parsed.as_array() else {
        return Vec::new();
    };

    array
        .iter()
        .filter_map(|call| {
            // --- id ---
            // OpenAI Responses uses "call_id" as the real function call
            // identifier; "id" is just the output item's ID (fc_ prefix).
            // Chat Completions / Anthropic use "id" directly. Try call_id
            // first so Responses items pair correctly with their results.
            let id = call
                .get("call_id")
                .and_then(Value::as_str)
                .or_else(|| call.get("id").and_then(Value::as_str))?
                .to_string();
            if id.is_empty() {
                return None;
            }

            // --- name ---
            // OpenAI Chat nests under "function.name"; the other providers
            // use a top-level "name". Gemini nests under
            // "functionCall.name".
            let parsed_name = call
                .get("name")
                .and_then(Value::as_str)
                .or_else(|| {
                    call.get("function")
                        .and_then(|f| f.get("name"))
                        .and_then(Value::as_str)
                })
                .or_else(|| {
                    call.get("functionCall")
                        .and_then(|f| f.get("name"))
                        .and_then(Value::as_str)
                })
                .filter(|name| !name.trim().is_empty());
            let has_valid_name = parsed_name.is_some();
            let name = parsed_name.unwrap_or("unknown_tool").to_string();

            // --- input ---
            // Anthropic stores an object under "input". OpenAI Chat nests a
            // JSON string under "function.arguments"; OpenAI Responses uses a
            // top-level "arguments". Gemini stores an object under
            // "functionCall.args".
            let (input, has_valid_input) = if let Some(input_val) = call.get("input") {
                if input_val.is_object() {
                    (input_val.clone(), true)
                } else if let Some(s) = input_val.as_str() {
                    match serde_json::from_str::<Value>(s) {
                        Ok(value) if value.is_object() => (value, true),
                        _ => (serde_json::json!({}), false),
                    }
                } else {
                    (serde_json::json!({}), false)
                }
            } else if let Some(arguments) = call
                .get("function")
                .and_then(|f| f.get("arguments"))
                .or_else(|| call.get("arguments"))
            {
                // OpenAI Chat nests a JSON string under "function.arguments";
                // OpenAI Responses uses a top-level "arguments" that is
                // sometimes a parsed object instead of a string.
                if arguments.is_object() {
                    (arguments.clone(), true)
                } else if let Some(s) = arguments.as_str() {
                    match serde_json::from_str::<Value>(s) {
                        Ok(value) if value.is_object() => (value, true),
                        _ => (serde_json::json!({}), false),
                    }
                } else {
                    (serde_json::json!({}), false)
                }
            } else if let Some(args) = call.get("functionCall").and_then(|f| f.get("args")) {
                if args.is_object() {
                    (args.clone(), true)
                } else {
                    (serde_json::json!({}), false)
                }
            } else {
                (serde_json::json!({}), false)
            };

            Some(NormalizedToolCall {
                id,
                name,
                input,
                has_valid_name,
                has_valid_input,
            })
        })
        .collect()
}

/// Extract (id, name) entries from a serialized tool_calls JSON array.
/// Supports all provider formats via [`normalize_tool_calls`].
///
/// Gemini function calls carry no id, so their entries come back with an
/// empty id and the raw functionCall name — callers pairing tool results
/// with calls must fall back to order-based matching for those entries.
pub fn extract_tool_call_entries(tool_calls_json: &str) -> Vec<(String, String)> {
    normalize_tool_calls(tool_calls_json)
        .into_iter()
        .map(|entry| (entry.id, entry.name))
        .collect()
}

/// Extract the call ID from a single tool call JSON value.
///
/// Prioritizes `call_id` (Responses API format) over `id` (Chat Completions
/// / Anthropic format) so that pairing logic uses the real function call
/// identifier, not the output item's internal ID.
fn extract_call_id_from_json(call: &Value) -> String {
    call.get("call_id")
        .and_then(Value::as_str)
        .or_else(|| call.get("id").and_then(Value::as_str))
        .unwrap_or("")
        .to_string()
}

/// Ensure every tool call has a matching tool result and vice-versa.
///
/// AI APIs reject request bodies containing "orphan" tool entries — a
/// `tool_use`/`tool_calls` without a corresponding `tool_result`, or a
/// `tool_result` referencing a call id that never appeared. This can happen
/// when a conversation is interrupted mid-turn (e.g. the user stops
/// generation after the model emits tool calls but before results arrive) or
/// when history is truncated by context-window management.
///
/// Instead of synthesizing fake messages (which can confuse the model with
/// fabricated data), this function **removes** orphan entries:
/// - **Orphan calls** (call without result): the call is stripped from the
///   assistant message's `tool_calls_json`. If the message becomes empty
///   (no content, no thinking, no remaining calls), it is removed entirely.
/// - **Orphan results** (result without call): the result is stripped from
///   the tool message's `tool_results_json`. If the message becomes empty,
///   it is removed entirely.
pub fn ensure_tool_pairing(messages: &mut Vec<ChatContextMessage>) {
    // --- Pass 1: collect all known call ids and result call-ids ---
    let mut all_call_ids: HashSet<String> = HashSet::new();
    let mut all_result_ids: HashSet<String> = HashSet::new();

    for msg in messages.iter() {
        let role = msg.role.trim();
        if role == "assistant" {
            if let Some(ref raw) = msg.tool_calls_json {
                for (id, _name) in extract_tool_call_entries(raw) {
                    all_call_ids.insert(id);
                }
            }
        } else if role == "tool" {
            if let Some(ref raw) = msg.tool_results_json {
                for (_name, call_id, _result) in parse_tool_results_json(raw) {
                    if !call_id.is_empty() {
                        all_result_ids.insert(call_id);
                    }
                }
            }
        }
    }

    // Quick exit when everything is already paired.
    let has_orphan_calls = messages.iter().any(|msg| {
        msg.role.trim() == "assistant"
            && msg
                .tool_calls_json
                .as_deref()
                .map(|raw| {
                    extract_tool_call_entries(raw)
                        .iter()
                        .any(|(id, _)| !all_result_ids.contains(id))
                })
                .unwrap_or(false)
    });
    let has_orphan_results = messages.iter().any(|msg| {
        msg.role.trim() == "tool"
            && msg
                .tool_results_json
                .as_deref()
                .map(|raw| {
                    parse_tool_results_json(raw)
                        .iter()
                        .any(|(_n, cid, _r)| !cid.is_empty() && !all_call_ids.contains(cid))
                })
                .unwrap_or(false)
    });
    if !has_orphan_calls && !has_orphan_results {
        return;
    }

    // --- Pass 2: remove orphan entries (iterate backwards so removals
    //     don't shift indices of entries we haven't visited yet) ---
    let mut i = messages.len();
    while i > 0 {
        i -= 1;
        let role = messages[i].role.trim().to_string();

        if role == "assistant" {
            // Filter out orphan tool calls (calls without matching results).
            if let Some(ref raw) = messages[i].tool_calls_json {
                if let Ok(Value::Array(calls)) = serde_json::from_str::<Value>(raw) {
                    let filtered: Vec<Value> = calls
                        .into_iter()
                        .filter(|call| {
                            let id = extract_call_id_from_json(call);
                            !id.is_empty() && all_result_ids.contains(&id)
                        })
                        .collect();

                    if filtered.is_empty() {
                        messages[i].tool_calls_json = None;
                        // Remove the message entirely if it has no other content.
                        let has_content = !messages[i].content.trim().is_empty();
                        let has_thinking = messages[i]
                            .thinking
                            .as_deref()
                            .map(|t| !t.is_empty())
                            .unwrap_or(false);
                        let has_reasoning = messages[i]
                            .thinking_blocks_json
                            .as_deref()
                            .map(|raw| {
                                serde_json::from_str::<Value>(raw)
                                    .ok()
                                    .and_then(|v| v.as_array().map(|a| !a.is_empty()))
                                    .unwrap_or(false)
                            })
                            .unwrap_or(false);
                        if !has_content && !has_thinking && !has_reasoning {
                            messages.remove(i);
                        }
                    } else {
                        messages[i].tool_calls_json = serde_json::to_string(&filtered).ok();
                    }
                }
            }
        } else if role == "tool" {
            // Filter out orphan tool results (results without matching calls).
            if let Some(ref raw) = messages[i].tool_results_json {
                let results = parse_tool_results_json(raw);
                let filtered: Vec<(String, String, String)> = results
                    .into_iter()
                    .filter(|(_name, call_id, _result)| {
                        call_id.is_empty() || all_call_ids.contains(call_id)
                    })
                    .collect();

                if filtered.is_empty() {
                    messages[i].tool_results_json = None;
                    // Remove the message entirely if it has no other content.
                    if messages[i].content.trim().is_empty() {
                        messages.remove(i);
                    }
                } else {
                    let filtered_json: Vec<Value> = filtered
                        .iter()
                        .map(|(name, call_id, result)| {
                            serde_json::json!({
                                "name": name,
                                "callId": call_id,
                                "result": result,
                            })
                        })
                        .collect();
                    messages[i].tool_results_json = serde_json::to_string(&filtered_json).ok();
                }
            }
        }
    }
}
