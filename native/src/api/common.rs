//! Shared helper functions used by all API provider modules
//! (anthropic, chat, gemini, responses).
//!
//! These utilities were previously duplicated across each provider file.
//! Centralising them here eliminates maintenance burden and ensures
//! consistent behaviour (token counting, JSON traversal, chunk emission).

use std::collections::HashMap;

use napi::bindgen_prelude::*;
use napi::threadsafe_function::ThreadsafeFunctionCallMode;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde_json::Value;

use crate::api::responses::{ResponsesApiStreamCallback, ResponsesApiStreamChunk};

// ---------------------------------------------------------------------------
// Stream chunk emission
// ---------------------------------------------------------------------------

/// Per-iteration thinking stream statistics.
///
/// Every provider's streaming loop owns one instance (alongside the
/// `stream_token_count` counter). `emit_stream_chunk` updates it on every
/// thinking delta: the token count is accumulated with the same `o200k_base`
/// tokenizer used for the total stream probe, and the first/last elapsed
/// timestamps bracket the thinking phase so the renderer (and the persisted
/// `chat_messages` row) can show how long the model spent thinking.
#[derive(Debug, Default)]
pub(crate) struct ThinkingStreamTracker {
    /// Cumulative token count across every thinking delta of this iteration.
    pub token_count: usize,
    /// Elapsed ms (relative to the stream start) of the first thinking delta.
    /// 0 means no thinking delta has arrived yet.
    pub first_elapsed_ms: i64,
    /// Elapsed ms of the most recent thinking delta.
    pub last_elapsed_ms: i64,
}

impl ThinkingStreamTracker {
    /// Duration of the thinking phase so far (0 when nothing has streamed).
    pub fn duration_ms(&self) -> i64 {
        if self.first_elapsed_ms == 0 {
            0
        } else {
            self.last_elapsed_ms - self.first_elapsed_ms
        }
    }

    fn record(&mut self, delta: &str, elapsed_ms: i64) {
        self.token_count += crate::api::token_counter::count_tokens(delta);
        if self.first_elapsed_ms == 0 {
            self.first_elapsed_ms = elapsed_ms.max(1);
        }
        self.last_elapsed_ms = elapsed_ms;
    }
}

/// Emit a streaming chunk to the JavaScript side via ThreadsafeFunction.
///
/// Only the delta strings are sent; the `content` and `thinking` fields are
/// left empty to avoid O(n²) data transfer. The renderer accumulates deltas
/// locally and the final complete text arrives via the resolved Promise.
///
/// `stream_token_count` is the cumulative token counter for the current
/// agent-loop iteration. The counter is mutated in place: each call adds the
/// token count of the delta text (content + thinking) so the renderer always
/// receives the up-to-date probe value.
///
/// `thinking_tracker` is updated on every thinking delta so the chunk can
/// carry the live thinking token count / duration alongside the totals.
pub(crate) fn emit_stream_chunk(
    on_chunk: &ResponsesApiStreamCallback,
    content_delta: String,
    thinking_delta: String,
    stream_token_count: &mut usize,
    thinking_tracker: &mut ThinkingStreamTracker,
    elapsed_ms: i64,
    ttft_ms: i64,
) {
    if content_delta.is_empty() && thinking_delta.is_empty() {
        return;
    }

    // Count tokens for the delta text only. Using `encode_ordinary` avoids
    // treating substrings as special tokens, matching the JS `tiktoken`
    // `encode_ordinary` behavior used by Snow CLI.
    let delta_text = if content_delta.is_empty() {
        &thinking_delta
    } else if thinking_delta.is_empty() {
        &content_delta
    } else {
        // Combine both deltas for a single encode pass. This branch is rare
        // (current callers always pass one empty string), but we handle it
        // for correctness.
        let combined = format!("{content_delta}{thinking_delta}");
        let count = crate::api::token_counter::count_tokens(&combined);
        *stream_token_count += count;
        if !thinking_delta.is_empty() {
            thinking_tracker.record(&thinking_delta, elapsed_ms);
        }
        on_chunk.call(
            ResponsesApiStreamChunk {
                content_delta,
                thinking_delta,
                content: String::new(),
                thinking: String::new(),
                retrying: false,
                retry_attempt: None,
                retry_error: None,
                stream_token_count: *stream_token_count as i64,
                thinking_token_count: thinking_tracker.token_count as i64,
                thinking_duration_ms: thinking_tracker.duration_ms(),
                elapsed_ms,
                ttft_ms,
                vision_status: None,
            },
            ThreadsafeFunctionCallMode::NonBlocking,
        );
        return;
    };

    let count = crate::api::token_counter::count_tokens(delta_text);
    *stream_token_count += count;
    if !thinking_delta.is_empty() {
        thinking_tracker.record(&thinking_delta, elapsed_ms);
    }

    on_chunk.call(
        ResponsesApiStreamChunk {
            content_delta,
            thinking_delta,
            content: String::new(),
            thinking: String::new(),
            retrying: false,
            retry_attempt: None,
            retry_error: None,
            stream_token_count: *stream_token_count as i64,
            thinking_token_count: thinking_tracker.token_count as i64,
            thinking_duration_ms: thinking_tracker.duration_ms(),
            elapsed_ms,
            ttft_ms,
            vision_status: None,
        },
        ThreadsafeFunctionCallMode::NonBlocking,
    );
}

/// Emit a probe-only chunk that carries just the updated token count.
///
/// Used for tool-call argument deltas, where the argument text is assembled
/// separately and must NOT be appended to the assistant message body. The
/// probe still needs to update so the renderer reflects long tool arguments
/// in real time. The thinking tracker is forwarded read-only so the emitted
/// chunk keeps reporting the latest thinking statistics.
pub(crate) fn emit_tool_args_probe(
    on_chunk: &ResponsesApiStreamCallback,
    stream_token_count: &mut usize,
    thinking_tracker: &ThinkingStreamTracker,
    args_delta: &str,
    elapsed_ms: i64,
    ttft_ms: i64,
) {
    if args_delta.is_empty() {
        return;
    }
    let count = crate::api::token_counter::count_tokens(args_delta);
    *stream_token_count += count;
    on_chunk.call(
        ResponsesApiStreamChunk {
            content_delta: String::new(),
            thinking_delta: String::new(),
            content: String::new(),
            thinking: String::new(),
            retrying: false,
            retry_attempt: None,
            retry_error: None,
            stream_token_count: *stream_token_count as i64,
            thinking_token_count: thinking_tracker.token_count as i64,
            thinking_duration_ms: thinking_tracker.duration_ms(),
            elapsed_ms,
            ttft_ms,
            vision_status: None,
        },
        ThreadsafeFunctionCallMode::NonBlocking,
    );
}

// ---------------------------------------------------------------------------
// JSON value helpers
// ---------------------------------------------------------------------------

/// Push a non-empty trimmed string from a JSON value into a chunk vector.
pub(crate) fn push_trimmed_string(value: Option<&Value>, chunks: &mut Vec<String>) {
    if let Some(text) = value
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
    {
        chunks.push(text.to_string());
    }
}

/// Truncate a string to at most `max_bytes` bytes without splitting a UTF-8
/// character in half. Returns a slice of the original string; use `.to_string()`
/// if an owned value is needed.
///
/// Slicing `&value[..value.len().min(max_bytes)]` directly panics when the cut
/// lands inside a multi-byte character (e.g. CJK text), which can abort the
/// whole streaming task. This helper always walks back to a char boundary.
pub(crate) fn truncate_utf8_safe(value: &str, max_bytes: usize) -> &str {
    if value.len() <= max_bytes {
        return value;
    }
    let mut end = max_bytes;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    &value[..end]
}

/// Truncate a string to at most `max_chars` characters (not bytes) and append
/// an ellipsis when text is dropped.
///
/// [`truncate_utf8_safe`] slices by byte budget and returns a borrowed slice;
/// this helper is for display/log strings where a character budget reads better
/// (and multi-byte text is counted the way a human would count it).
pub(crate) fn truncate_chars(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    let head: String = value.chars().take(max_chars).collect();
    format!("{head}...")
}

/// Push reasoning/thinking text from a Chat Completions delta or message object
/// into a chunk vector, normalising the three field shapes providers emit:
///
/// - `reasoning_content` (DeepSeek official, plain string)
/// - `reasoning` (OpenRouter normalised, plain string)
/// - `reasoning_details` (OpenRouter structured array; each item may be a
///   `reasoning.text` / `reasoning.summary` block carrying a text-like field)
///
/// All three are checked so a single call works across DeepSeek-direct,
/// OpenRouter, and any provider that mimics either convention.
pub(crate) fn push_reasoning_text(value: Option<&Value>, chunks: &mut Vec<String>) {
    let Some(object) = value.and_then(Value::as_object) else {
        // Fallback: a bare string value (rare, but some relays do this).
        push_trimmed_string(value, chunks);
        return;
    };

    // 1. DeepSeek official field (also used as an alias by some relays).
    let before = chunks.len();
    push_trimmed_string(object.get("reasoning_content"), chunks);

    // 2. OpenRouter flat alias. Per the OpenRouter convention the flat field
    //    and `reasoning_details` are two representations of the SAME text, so
    //    only fall back to this when the canonical field carried nothing.
    if chunks.len() == before {
        push_trimmed_string(object.get("reasoning"), chunks);
    }

    // 3. OpenRouter structured reasoning_details array. Only used when no flat
    //    field was present, otherwise providers emitting both would be read
    //    twice and every streamed chunk duplicated. Each item is one of:
    //    { "type": "reasoning.text",    "text": "..." }
    //    { "type": "reasoning.summary", "summary": "..." }
    //    { "type": "reasoning.encrypted", "data": "..." }  (ignored — opaque)
    if chunks.len() != before {
        return;
    }
    if let Some(details) = object.get("reasoning_details").and_then(Value::as_array) {
        for detail in details {
            let detail_obj = match detail.as_object() {
                Some(obj) => obj,
                None => continue,
            };
            let item_type = detail_obj.get("type").and_then(Value::as_str).unwrap_or("");
            // Only harvest human-readable text; skip encrypted/redacted blobs.
            if item_type == "reasoning.encrypted" {
                continue;
            }
            // A single item carries either `text` or `summary`, never both.
            let before_detail = chunks.len();
            push_trimmed_string(detail_obj.get("text"), chunks);
            if chunks.len() == before_detail {
                push_trimmed_string(detail_obj.get("summary"), chunks);
            }
        }
    }
}

/// Read a string field from a JSON object.
pub(crate) fn read_string(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

/// Traverse a dotted path in a JSON value and return the leaf as `i64`.
pub(crate) fn read_path_i64(value: &Value, path: &[&str]) -> Option<i64> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    value_as_i64(current)
}

/// Convert a JSON value to `i64`, handling i64/u64/f64 representations.
pub(crate) fn value_as_i64(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_u64().and_then(|number| i64::try_from(number).ok()))
        .or_else(|| value.as_f64().map(|number| number as i64))
}

/// Try multiple JSON paths and return the first positive `i64` value.
pub(crate) fn read_first_i64(value: &Value, paths: &[&[&str]]) -> i64 {
    paths
        .iter()
        .find_map(|path| read_path_i64(value, path).filter(|number| *number > 0))
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Header building
// ---------------------------------------------------------------------------

/// Inject custom user-supplied headers into a `HeaderMap`, skipping entries
/// whose key matches any of the `reserved_keys` (case-insensitive).
///
/// Each provider calls this after setting its own authentication headers,
/// passing the keys it manages internally so user headers cannot override
/// them.
///
/// Entries whose value still carries an unexpanded session-id placeholder are
/// skipped as well (see [`expand_custom_header_session_id`]): a request without
/// conversation context must not send the literal template to the provider.
pub(crate) fn inject_custom_headers(
    headers: &mut HeaderMap,
    custom_headers: &HashMap<String, String>,
    reserved_keys: &[&str],
) -> Result<()> {
    for (key, value) in custom_headers {
        let trimmed_key = key.trim();
        let trimmed_value = value.trim();
        if trimmed_key.is_empty() || trimmed_value.is_empty() {
            continue;
        }

        if contains_session_id_placeholder(trimmed_value) {
            continue;
        }

        if reserved_keys
            .iter()
            .any(|reserved| trimmed_key.eq_ignore_ascii_case(reserved))
        {
            continue;
        }

        let header_name = trimmed_key.parse::<HeaderName>().map_err(|error| {
            Error::from_reason(format!(
                "Invalid custom header '{}': {}",
                trimmed_key, error
            ))
        })?;
        let header_value = HeaderValue::from_str(trimmed_value).map_err(|error| {
            Error::from_reason(format!(
                "Invalid custom header value for '{}': {}",
                trimmed_key, error
            ))
        })?;
        headers.insert(header_name, header_value);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Custom header placeholders
// ---------------------------------------------------------------------------

/// Placeholder tokens accepted inside custom header values for the session id
/// of the conversation that sends the request.
///
/// `{{session_id}}` follows the `{{NAME}}` convention already used by
/// scheduled-task prompts; the remaining spellings exist so users do not have
/// to memorize one exact form. All of them are replaced inside a longer value
/// as well, so `snow-app-{{session_id}}` works.
pub(crate) const SESSION_ID_PLACEHOLDER_TOKENS: &[&str] = &[
    "{{session_id}}",
    "{{sessionId}}",
    "{{conversation_id}}",
    "{{conversationId}}",
    "${session_id}",
    "${conversation_id}",
];

/// True when `value` still carries a session-id placeholder token.
pub(crate) fn contains_session_id_placeholder(value: &str) -> bool {
    SESSION_ID_PLACEHOLDER_TOKENS
        .iter()
        .any(|token| value.contains(token))
}

/// Expand session-id placeholders in custom header values.
///
/// `session_id` is the conversation id the request belongs to (the same id the
/// exchange is persisted under), so a scheme like `x-session: {{session_id}}`
/// addresses the conversation that is actually sending the request.
///
/// Passing an empty `session_id` (a request with no conversation context, such
/// as a model listing) clears the affected values instead of leaking the
/// literal template; empty values are skipped by every header builder, so the
/// header is simply omitted for those requests.
pub(crate) fn expand_custom_header_session_id(
    headers: &mut HashMap<String, String>,
    session_id: &str,
) {
    let session_id = session_id.trim();

    for value in headers.values_mut() {
        if !contains_session_id_placeholder(value) {
            continue;
        }

        if session_id.is_empty() {
            value.clear();
            continue;
        }

        let mut expanded = value.clone();
        for token in SESSION_ID_PLACEHOLDER_TOKENS {
            if expanded.contains(token) {
                expanded = expanded.replace(token, session_id);
            }
        }
        *value = expanded;
    }
}

#[cfg(test)]
mod tests {
    use super::{contains_session_id_placeholder, expand_custom_header_session_id};
    use std::collections::HashMap;

    fn headers(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
            .collect()
    }

    #[test]
    fn expands_session_id_placeholders_and_keeps_other_values() {
        let mut custom = headers(&[
            ("x-opencode-session", "{{session_id}}"),
            ("x-prefixed", "snow-app-{{session_id}}"),
            ("user-agent", "Snow-App/1.0 (coding-agent)"),
            ("x-dollar", "${session_id}"),
        ]);

        expand_custom_header_session_id(&mut custom, "conv-123-456");

        assert_eq!(
            custom.get("x-opencode-session").map(String::as_str),
            Some("conv-123-456")
        );
        assert_eq!(
            custom.get("x-prefixed").map(String::as_str),
            Some("snow-app-conv-123-456")
        );
        assert_eq!(
            custom.get("x-dollar").map(String::as_str),
            Some("conv-123-456")
        );
        assert_eq!(
            custom.get("user-agent").map(String::as_str),
            Some("Snow-App/1.0 (coding-agent)")
        );
    }

    #[test]
    fn clears_placeholder_values_without_conversation_context() {
        let mut custom = headers(&[
            ("x-session", "{{session_id}}"),
            ("x-static", "fixed"),
        ]);

        expand_custom_header_session_id(&mut custom, "   ");

        assert_eq!(custom.get("x-session").map(String::as_str), Some(""));
        assert_eq!(custom.get("x-static").map(String::as_str), Some("fixed"));
    }

    #[test]
    fn leaves_unknown_placeholders_untouched() {
        let mut custom = headers(&[("x-unknown", "{{unknown_token}}")]);

        expand_custom_header_session_id(&mut custom, "conv-123-456");

        assert_eq!(
            custom.get("x-unknown").map(String::as_str),
            Some("{{unknown_token}}")
        );
        assert!(!contains_session_id_placeholder("{{unknown_token}}"));
    }
}
