//! Gemini payload construction and endpoint resolution.

use std::collections::{HashMap, VecDeque};
use std::path::Path;

use napi::bindgen_prelude::*;
use serde_json::{json, Value};

use crate::api::config::{
    normalize_base_url, resolve_sdk_api_base_url, DEFAULT_GEMINI_BASE_URL, DEFAULT_OPENAI_BASE_URL,
};
use crate::api::conversation::parse_chat_message_content;
use crate::api::conversation::tool_messages::{
    extract_tool_call_entries, parse_tool_results_with_images, ParsedToolResult,
};
use crate::api::responses::ResponsesApiRequest;
use crate::storage::services::chat_conversations::ChatContextMessage;
use crate::storage::ApiConfigRecord;

pub(crate) fn resolve_gemini_endpoint(
    api_config: &ApiConfigRecord,
    model: &str,
    api_key: &str,
) -> String {
    let normalized_base_url = normalize_base_url(&api_config.base_url);
    if normalized_base_url.is_empty() {
        return String::new();
    }

    let base_url = if normalized_base_url == DEFAULT_OPENAI_BASE_URL {
        DEFAULT_GEMINI_BASE_URL.to_string()
    } else {
        normalized_base_url
    };

    let resolved_base = if api_config.base_url_mode == "endpoint" {
        base_url
    } else {
        resolve_sdk_api_base_url(&base_url, &api_config.base_url_mode)
    };

    let clean_model = model.strip_prefix("models/").unwrap_or(model);

    let mut url = format!(
        "{}/models/{}:streamGenerateContent?alt=sse",
        resolved_base, clean_model
    );

    if !api_key.is_empty() {
        url.push_str(&format!("&key={}", api_key));
    }

    url
}

pub(super) fn build_gemini_payload(
    messages: &[ChatContextMessage],
    database_path: &Path,
    request: &ResponsesApiRequest,
    api_config: &ApiConfigRecord,
    tools: Option<Value>,
    user_system_prompts: &[String],
) -> Result<Value> {
    let skip_image_parsing = request.skip_context.unwrap_or(false);
    let has_user_system_prompts = !user_system_prompts.is_empty();
    let mut builtin_system_parts = Vec::new();
    let mut contents = Vec::new();

    // Gemini relays reject histories whose functionResponse.name does not
    // exactly match the corresponding functionCall.name. The stored tool
    // result name can drift from the model-echoed call name (e.g. frontend
    // name normalization truncating relay formats like "server:tool"), so
    // functionResponse names are resolved from the conversation's own
    // functionCall names instead — mirroring Snow CLI's
    // `toolCallIdToFunctionName` map (see snow-cli/source/api/gemini.ts).
    // Calls carrying an id match by id; Gemini calls have no id, so their
    // names are queued and consumed in order (the renderer pushes exactly
    // one result per call, in call order).
    let mut call_id_to_name: HashMap<String, String> = HashMap::new();
    let mut pending_call_names: VecDeque<String> = VecDeque::new();

    for message in messages {
        let content = message.content.trim();
        let role = message.role.trim();

        // --- Tool result messages: emit as function role with functionResponse parts ---
        if role == "tool" {
            if content.is_empty() {
                continue;
            }
            let results = match message.tool_results_json {
                Some(ref raw) => {
                    parse_tool_results_with_images(raw, database_path, skip_image_parsing)
                }
                None => Vec::new(),
            };
            for tool_result in &results {
                let has_images = !tool_result.images.is_empty();
                let text = tool_result.text.clone();
                let response_content = if text.is_empty() {
                    if has_images {
                        serde_json::json!({"result": "[image attached]"})
                    } else {
                        serde_json::json!({"result": "ok"})
                    }
                } else {
                    serde_json::json!({"result": text})
                };
                let tool_name = resolve_function_response_name(
                    tool_result,
                    &mut call_id_to_name,
                    &mut pending_call_names,
                );
                contents.push(json!({
                    "role": "function",
                    "parts": [{
                        "functionResponse": {
                            "name": tool_name,
                            "response": response_content,
                        }
                    }],
                }));
                // functionResponse only accepts plain JSON, so the screenshot
                // base64 must travel in a following user message as inlineData
                // parts.
                if !tool_result.images.is_empty() {
                    let image_parts: Vec<Value> = tool_result
                        .images
                        .iter()
                        .map(|image| {
                            json!({
                                "inlineData": {
                                    "mimeType": image.media_type,
                                    "data": image.data,
                                }
                            })
                        })
                        .collect();
                    contents.push(json!({
                        "role": "user",
                        "parts": image_parts,
                    }));
                }
            }
            continue;
        }

        if content.is_empty() && message.tool_calls_json.is_none() {
            continue;
        }

        // --- Assistant messages with tool_calls ---
        if role == "assistant" {
            if let Some(ref tool_calls_raw) = message.tool_calls_json {
                let function_call_parts =
                    crate::api::conversation::tool_messages::tool_calls_as_gemini_parts(
                        tool_calls_raw,
                    );
                // 收集本消息 functionCall 的名称，供后续 functionResponse
                // 配对：有 id 的进映射，无 id 的（Gemini 原生格式）入队列。
                for (call_id, call_name) in extract_tool_call_entries(tool_calls_raw) {
                    if call_id.is_empty() {
                        pending_call_names.push_back(call_name);
                    } else {
                        call_id_to_name.insert(call_id, call_name);
                    }
                }
                if !function_call_parts.is_empty() {
                    let mut parts = Vec::new();
                    // Round-trip thinking as a thought text part so Gemini
                    // retains its prior reasoning across turns.
                    if let Some(ref thinking) = message.thinking {
                        if !thinking.is_empty() {
                            parts.push(json!({ "text": thinking, "thought": true }));
                        }
                    }
                    if !content.is_empty() {
                        parts.push(json!({ "text": content }));
                    }
                    parts.extend(function_call_parts);
                    contents.push(json!({
                        "role": "model",
                        "parts": parts,
                    }));
                    continue;
                }
            }
        }

        // --- System/developer messages ---
        if role == "system" || role == "developer" {
            if !content.is_empty() {
                builtin_system_parts.push(content.to_string());
            }
            continue;
        }

        // --- Regular user/model messages ---
        if content.is_empty() {
            continue;
        }
        if skip_image_parsing {
            contents.push(json!({
                "role": normalize_gemini_role(role),
                "parts": [{ "text": content }],
            }));
            continue;
        }

        let parsed_content = parse_chat_message_content(content, database_path)?;
        let mut parts = Vec::new();
        if !parsed_content.text.is_empty() {
            parts.push(json!({ "text": parsed_content.text }));
        }
        parts.extend(parsed_content.images.iter().map(|image| {
            json!({
                "inlineData": {
                    "mimeType": image.media_type,
                    "data": image.data,
                },
            })
        }));

        contents.push(json!({
            "role": normalize_gemini_role(role),
            "parts": parts,
        }));
    }

    // When user system prompts are present, they occupy `systemInstruction`
    // exclusively and the built-in prompt is demoted to a leading `user`
    // message (Snow CLI PR #127).
    if has_user_system_prompts && !builtin_system_parts.is_empty() {
        let builtin_text = builtin_system_parts.join("\n\n");
        let builtin_message = json!({
            "role": "user",
            "parts": [{ "text": builtin_text }],
        });
        contents.insert(0, builtin_message);
    }

    if contents.is_empty() {
        return Err(Error::from_reason("Chat message content is required"));
    }

    let mut payload = json!({
        "contents": contents,
    });

    // Build `systemInstruction`. When user system prompts are present they
    // occupy the field exclusively (each prompt as an independent part).
    // Otherwise the built-in system prompt parts are used.
    let system_parts: Vec<&String> = if has_user_system_prompts {
        user_system_prompts.iter().collect()
    } else {
        builtin_system_parts.iter().collect()
    };

    if !system_parts.is_empty() {
        let parts: Vec<Value> = system_parts
            .iter()
            .map(|text| json!({ "text": text }))
            .collect();
        payload["systemInstruction"] = json!({ "parts": parts });
    }

    let mut generation_config = json!({});

    if let Some(max_tokens) = api_config.max_tokens {
        if max_tokens > 0 {
            generation_config["maxOutputTokens"] = json!(max_tokens);
        }
    }

    if let Some(thinking_config) = build_gemini_thinking_config(&api_config.config_json) {
        generation_config["thinkingConfig"] = thinking_config;
    }

    if !generation_config
        .as_object()
        .map(|obj| obj.is_empty())
        .unwrap_or(true)
    {
        payload["generationConfig"] = generation_config;
    }

    if let Some(tools) = tools {
        if tools.as_array().is_some_and(|items| !items.is_empty()) {
            payload["tools"] = tools;
        }
    }

    // Google Search grounding（Gemini 原生联网搜索）：
    // 配置 snowcfg.googleSearch 开启时，合并注入 google_search。
    // 与 MCP function tools 共存时，放入同一个 Tool 对象并配置 tool_config.include_server_side_tool_invocations。
    if build_gemini_google_search_enabled(&api_config.config_json) {
        if let Some(tools_arr) = payload.get_mut("tools").and_then(Value::as_array_mut) {
            if let Some(first_tool) = tools_arr.first_mut().and_then(Value::as_object_mut) {
                first_tool.insert("google_search".to_string(), json!({}));
                payload["tool_config"] = json!({
                    "include_server_side_tool_invocations": true
                });
                payload["toolConfig"] = json!({
                    "includeServerSideToolInvocations": true
                });
            } else {
                tools_arr.push(json!({ "google_search": {} }));
            }
        } else {
            payload["tools"] = json!([{ "google_search": {} }]);
        }
    }

    Ok(payload)
}

fn normalize_gemini_role(role: &str) -> &str {
    match role.trim() {
        "assistant" => "model",
        _ => "user",
    }
}

/// Resolve the functionResponse name for a tool result so it exactly
/// matches the functionCall name the model emitted (Gemini relays reject
/// mismatched histories with a 400).
///
/// Priority: the call's own id mapping (OpenAI/Anthropic histories) → the
/// next unmatched id-less functionCall name in conversation order (Gemini
/// calls carry no id; the renderer pushes exactly one result per call in
/// call order) → the stored result name as a final fallback.
fn resolve_function_response_name(
    tool_result: &ParsedToolResult,
    call_id_to_name: &HashMap<String, String>,
    pending_call_names: &mut VecDeque<String>,
) -> String {
    if !tool_result.call_id.is_empty() {
        if let Some(name) = call_id_to_name.get(&tool_result.call_id) {
            return name.clone();
        }
    }
    if let Some(name) = pending_call_names.pop_front() {
        return name;
    }
    if tool_result.name.is_empty() {
        "unknown_tool".to_string()
    } else {
        tool_result.name.clone()
    }
}

pub(crate) fn build_gemini_thinking_config(config_json: &str) -> Option<Value> {
    let parsed = serde_json::from_str::<Value>(config_json).ok()?;
    let gemini_thinking = parsed.get("snowcfg")?.get("geminiThinking")?.as_object()?;
    let enabled = gemini_thinking
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    if !enabled {
        return None;
    }

    let thinking_level = gemini_thinking
        .get("thinkingLevel")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "none")?;

    Some(json!({ "thinkingLevel": thinking_level }))
}

/// 读取配置中的谷歌搜索联网开关（snowcfg.googleSearch）。
/// 开启时 gemini 请求会注入 google_search 工具（Gemini 原生 grounding）。
pub(crate) fn build_gemini_google_search_enabled(config_json: &str) -> bool {
    serde_json::from_str::<Value>(config_json)
        .ok()
        .and_then(|parsed| parsed.get("snowcfg")?.get("googleSearch")?.as_bool())
        .unwrap_or(false)
}
