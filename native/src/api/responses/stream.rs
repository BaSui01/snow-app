//! Responses API streaming response collection — HTTP request, retry loop,
//! idle-timeout reconnection, and SSE event dispatch.
//!
//! Uses raw reqwest `bytes_stream()` instead of the `async_openai` SDK so that
//! the streaming behaviour (idle timeout, non-SSE detection, partial tool-call
//! reconstruction) is identical to the Chat Completions and Anthropic
//! providers.

use std::collections::HashMap;
use std::time::Duration;

use napi::bindgen_prelude::*;
use napi::threadsafe_function::ThreadsafeFunctionCallMode;
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use crate::api::common::emit_stream_chunk;
use crate::api::responses::{ResponsesApiStreamCallback, ResponsesApiStreamChunk};
use crate::api::retry::{
    decide_stream_recovery, is_retriable_stream_read_error, next_stream_item_with_idle,
    should_retry, stream_idle_timeout_error, visible_content_char_count, wait_before_retry,
    StreamAttemptProgress, StreamEndCause, StreamInterruptionReason, StreamReadOutcome,
    StreamRecoveryDecision, StreamRecoveryOutcome, RetryOptions,
};
use crate::api::sse::find_sse_separator;
use crate::storage::services::chat_conversations::ChatTokenUsage;

use super::event::{
    collect_reasoning_items, collect_tool_calls, extract_output_text, extract_response_error,
    extract_response_thinking, process_responses_sse_event_block,
};

pub(super) struct StreamingResponseResult {
    pub id: String,
    pub content: String,
    pub thinking: String,
    /// JSON array of reasoning output items captured from
    /// `response.output_item.done` events (each containing type=reasoning,
    /// summary, and encrypted_content). Persisted so the next request can
    /// round-trip reasoning verbatim when store:false.
    pub reasoning_items_json: String,
    pub model: String,
    pub status: String,
    pub interruption_reason: Option<StreamInterruptionReason>,
    pub recovery_outcome: Option<StreamRecoveryOutcome>,
    pub token_usage: ChatTokenUsage,
    pub tool_calls_json: String,
    pub tool_parse_errors: Vec<String>,
    pub total_duration_ms: i64,
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn collect_streaming_response(
    client: &reqwest::Client,
    endpoint: &str,
    api_key: &str,
    custom_headers: &HashMap<String, String>,
    payload: Value,
    on_chunk: &ResponsesApiStreamCallback,
    cancel_token: &CancellationToken,
    retry_options: &RetryOptions,
    stream_idle_timeout_sec: u64,
) -> Result<StreamingResponseResult> {
    let mut attempt: u32 = 0;
    let mut stream_token_count: usize = 0;
    let stream_start = std::time::Instant::now();
    let mut ttft_ms: i64 = 0;

    // State accumulated across the stream of a single HTTP response. These are
    // declared outside the main loop so that, when the stream idle timeout
    // fires mid-stream, we can discard the partial result and reset them
    // before re-issuing the request with the original parameters.
    let mut raw_events: Vec<Value> = Vec::new();
    let mut content_chunks: Vec<String> = Vec::new();
    let mut thinking_chunks: Vec<String> = Vec::new();
    let mut tool_calls: Vec<Value> = Vec::new();
    let mut reasoning_items: Vec<Value> = Vec::new();
    let mut tool_parse_errors: Vec<String> = Vec::new();
    let mut streaming_tool_items: HashMap<u64, (Value, String)> = HashMap::new();
    let mut response_id = String::new();
    let mut response_model = String::new();
    let mut response_status;
    let mut token_usage: ChatTokenUsage;
    let mut byte_buffer: Vec<u8> = Vec::new();

    let idle_timeout = Duration::from_secs(stream_idle_timeout_sec);
    let mut stream_completed_normally = false;
    let mut reasoning_text_streamed = false;
    let mut interruption_reason = None;
    let mut recovery_outcome = None;

    'attempt_loop: loop {
        // ---- Phase 1: send the request (with retry on connect errors) ----
        let header_map = super::payload::build_header_map(api_key, custom_headers)?;
        let response = loop {
            if cancel_token.is_cancelled() {
                return Ok(StreamingResponseResult {
                    id: String::new(),
                    content: String::new(),
                    thinking: String::new(),
                    reasoning_items_json: "[]".to_string(),
                    model: String::new(),
                    status: String::from("cancelled"),
                    interruption_reason: None,
                    recovery_outcome: None,
                    token_usage: ChatTokenUsage {
                        input_tokens: 0,
                        output_tokens: 0,
                        cache_creation_input_tokens: 0,
                        cache_read_input_tokens: 0,
                    },
                    tool_calls_json: "[]".to_string(),
                    tool_parse_errors: Vec::new(),
                    total_duration_ms: stream_start.elapsed().as_millis() as i64,
                });
            }

            let send_future = client
                .post(endpoint)
                .headers(header_map.clone())
                .json(&payload)
                .send();

            let result = tokio::select! {
                biased;
                _ = cancel_token.cancelled() => {
                    return Ok(StreamingResponseResult {
                        id: String::new(),
                        content: String::new(),
                        thinking: String::new(),
                        reasoning_items_json: "[]".to_string(),
                        model: String::new(),
                        status: String::from("cancelled"),
                        interruption_reason: None,
                        recovery_outcome: None,
                        token_usage: ChatTokenUsage {
                            input_tokens: 0,
                            output_tokens: 0,
                            cache_creation_input_tokens: 0,
                            cache_read_input_tokens: 0,
                        },
                        tool_calls_json: "[]".to_string(),
                        tool_parse_errors: Vec::new(),
                        total_duration_ms: stream_start.elapsed().as_millis() as i64,
                    });
                }
                result = send_future => {
                    result.map_err(|error| Error::from_reason(format!("Failed to create response stream: {error}")))
                }
            };

            match result {
                Ok(response) => {
                    let status = response.status();
                    if !status.is_success() {
                        let error_body = response.text().await.unwrap_or_default();
                        let error = Error::from_reason(format!(
                            "Responses API request failed: {} {}",
                            status, error_body
                        ));

                        if !should_retry(&error, attempt, retry_options) {
                            return Err(error);
                        }

                        // Emit retry status to frontend
                        on_chunk.call(
                            ResponsesApiStreamChunk {
                                content_delta: String::new(),
                                thinking_delta: String::new(),
                                content: String::new(),
                                thinking: String::new(),
                                retrying: true,
                                retry_attempt: Some((attempt + 1) as i32),
                                retry_error: Some(error.reason.clone()),
                                stream_token_count: stream_token_count as i64,
                                elapsed_ms: stream_start.elapsed().as_millis() as i64,
                                ttft_ms,
                                vision_status: None,
                            },
                            ThreadsafeFunctionCallMode::NonBlocking,
                        );

                        match wait_before_retry(retry_options, cancel_token, attempt).await {
                            Ok(()) => {
                                attempt += 1;
                                continue;
                            }
                            Err(e) => return Err(e),
                        }
                    }
                    break response;
                }
                Err(error) => {
                    if !should_retry(&error, attempt, retry_options) {
                        return Err(error);
                    }

                    // Emit retry status to frontend
                    on_chunk.call(
                        ResponsesApiStreamChunk {
                            content_delta: String::new(),
                            thinking_delta: String::new(),
                            content: String::new(),
                            thinking: String::new(),
                            retrying: true,
                            retry_attempt: Some((attempt + 1) as i32),
                            retry_error: Some(error.reason.clone()),
                            stream_token_count: stream_token_count as i64,
                            elapsed_ms: stream_start.elapsed().as_millis() as i64,
                            ttft_ms,
                            vision_status: None,
                        },
                        ThreadsafeFunctionCallMode::NonBlocking,
                    );

                    match wait_before_retry(retry_options, cancel_token, attempt).await {
                        Ok(()) => {
                            attempt += 1;
                            continue;
                        }
                        Err(e) => return Err(e),
                    }
                }
            }
        };

        // ---- Phase 2: read one complete Provider attempt ----
        // All retry paths return to this single reset point. Pending tool
        // fragments are attempt-local and are never promoted during reset or
        // finalization.
        raw_events.clear();
        content_chunks.clear();
        thinking_chunks.clear();
        tool_calls.clear();
        reasoning_items.clear();
        tool_parse_errors.clear();
        streaming_tool_items.clear();
        response_id.clear();
        response_model.clear();
        response_status = String::from("completed");
        token_usage = ChatTokenUsage::default();
        byte_buffer.clear();
        stream_completed_normally = false;
        reasoning_text_streamed = false;
        interruption_reason = None;
        recovery_outcome = None;

        let mut completed_response: Option<Value> = None;
        let mut stream = response.bytes_stream();
        let mut end_cause: Option<(StreamEndCause, bool, String)> = None;

        macro_rules! process_event_block {
            ($event_block:expr) => {{
                let (content_delta, thinking_delta) = process_responses_sse_event_block(
                    $event_block,
                    &mut raw_events,
                    &mut content_chunks,
                    &mut thinking_chunks,
                    &mut tool_calls,
                    &mut reasoning_items,
                    &mut streaming_tool_items,
                    &mut response_id,
                    &mut response_model,
                    &mut response_status,
                    &mut token_usage,
                    &mut completed_response,
                    &mut stream_completed_normally,
                    &mut reasoning_text_streamed,
                );
                if ttft_ms == 0 {
                    ttft_ms = stream_start.elapsed().as_millis() as i64;
                }
                emit_stream_chunk(
                    on_chunk,
                    content_delta,
                    thinking_delta,
                    &mut stream_token_count,
                    stream_start.elapsed().as_millis() as i64,
                    ttft_ms,
                );
            }};
        }

        'read_loop: loop {
            match next_stream_item_with_idle(&mut stream, cancel_token, idle_timeout).await {
                StreamReadOutcome::Cancelled => {
                    response_status = String::from("cancelled");
                    break 'read_loop;
                }
                StreamReadOutcome::Data(chunk) => {
                    byte_buffer.extend_from_slice(&chunk);
                    while let Some((separator_index, separator_len)) =
                        find_sse_separator(&byte_buffer)
                    {
                        let event_block =
                            String::from_utf8_lossy(&byte_buffer[..separator_index]).to_string();
                        byte_buffer = byte_buffer[separator_index + separator_len..].to_vec();
                        process_event_block!(&event_block);
                        if stream_completed_normally {
                            break;
                        }
                    }
                    if stream_completed_normally {
                        break 'read_loop;
                    }
                }
                StreamReadOutcome::ReadError(error) => {
                    let stream_error = Error::from_reason(error.to_string());
                    let retriable = is_retriable_stream_read_error(&stream_error);
                    end_cause = Some((
                        StreamEndCause::ReadError,
                        retriable,
                        stream_error.reason.clone(),
                    ));
                    break 'read_loop;
                }
                StreamReadOutcome::Eof => {
                    // Parse a final event even when the upstream omitted the
                    // usual blank-line separator before deciding terminal is
                    // absent.
                    let trailing_bytes = std::mem::take(&mut byte_buffer);
                    if !trailing_bytes.is_empty() {
                        let trailing_buffer = String::from_utf8_lossy(&trailing_bytes).to_string();
                        if !trailing_buffer.trim().is_empty() {
                            process_event_block!(&trailing_buffer);
                        }
                    }
                    if stream_completed_normally {
                        break 'read_loop;
                    }
                    end_cause = Some((
                        StreamEndCause::UnexpectedEof,
                        true,
                        "Stream ended before a Responses terminal event".to_string(),
                    ));
                    break 'read_loop;
                }
                StreamReadOutcome::IdleTimeout => {
                    end_cause = Some((
                        StreamEndCause::IdleTimeout,
                        true,
                        stream_idle_timeout_error().reason.clone(),
                    ));
                    break 'read_loop;
                }
            }
        }

        if response_status == "cancelled" {
            tool_calls.clear();
            streaming_tool_items.clear();
            tool_parse_errors.clear();
            interruption_reason = None;
            recovery_outcome = None;
            break 'attempt_loop;
        }

        // Provider terminal wins over transport recovery. Completed payloads
        // may supply trusted fallback output, while pending streaming tool
        // fragments are always discarded.
        if stream_completed_normally {
            streaming_tool_items.clear();

            if let Some(response) = completed_response.as_ref() {
                if content_chunks.is_empty() {
                    let content = extract_output_text(response);
                    if !content.is_empty() {
                        content_chunks.push(content);
                    }
                }

                if thinking_chunks.is_empty() {
                    let thinking = extract_response_thinking(response);
                    if !thinking.is_empty() {
                        thinking_chunks.push(thinking);
                    }
                }

                // Only a trusted `response.completed` payload may act as a
                // fallback source of executable tool calls. Incomplete or
                // failed payloads never promote their output tree.
                if response_status == "completed" && tool_calls.is_empty() {
                    collect_tool_calls(response.get("output"), &mut tool_calls);
                }

                if reasoning_items.is_empty() {
                    collect_reasoning_items(response.get("output"), &mut reasoning_items);
                }
            }

            // Preserve the existing Provider-level retry for terminal transient
            // failures. It is separate from transport recovery and never leaves
            // interruption metadata on a later successful response.
            if response_status == "failed"
                && content_chunks.is_empty()
                && thinking_chunks.is_empty()
                && tool_calls.is_empty()
                && reasoning_items.is_empty()
            {
                let error_message = completed_response
                    .as_ref()
                    .and_then(extract_response_error)
                    .unwrap_or_else(|| {
                        "Responses API returned failed status without error details".to_string()
                    });
                let error = Error::from_reason(error_message);

                if !should_retry(&error, attempt, retry_options) {
                    return Err(error);
                }

                on_chunk.call(
                    ResponsesApiStreamChunk {
                        content_delta: String::new(),
                        thinking_delta: String::new(),
                        content: String::new(),
                        thinking: String::new(),
                        retrying: true,
                        retry_attempt: Some((attempt + 1) as i32),
                        retry_error: Some(error.reason.clone()),
                        stream_token_count: stream_token_count as i64,
                        elapsed_ms: stream_start.elapsed().as_millis() as i64,
                        ttft_ms,
                        vision_status: None,
                    },
                    ThreadsafeFunctionCallMode::NonBlocking,
                );

                match wait_before_retry(retry_options, cancel_token, attempt).await {
                    Ok(()) => {
                        attempt += 1;
                        continue 'attempt_loop;
                    }
                    Err(_wait_error) if cancel_token.is_cancelled() => {
                        response_status = String::from("cancelled");
                        tool_calls.clear();
                        tool_parse_errors.clear();
                        interruption_reason = None;
                        recovery_outcome = None;
                        break 'attempt_loop;
                    }
                    Err(wait_error) => return Err(wait_error),
                }
            }

            if response_status == "incomplete" {
                interruption_reason = Some(StreamInterruptionReason::ExplicitIncomplete);
                recovery_outcome = None;
                tool_parse_errors.clear();
            } else {
                interruption_reason = None;
                recovery_outcome = None;
            }
            break 'attempt_loop;
        }

        let (cause, read_error_retriable, retry_error) = end_cause.unwrap_or((
            StreamEndCause::UnexpectedEof,
            true,
            "Stream ended before a Responses terminal event".to_string(),
        ));
        let progress = StreamAttemptProgress {
            visible_content_chars: visible_content_char_count(&content_chunks),
            has_tool_state: !tool_calls.is_empty(),
            has_pending_tool_fragments: !streaming_tool_items.is_empty(),
            provider_terminal: stream_completed_normally,
            user_cancelled: cancel_token.is_cancelled(),
        };
        let decision = decide_stream_recovery(
            cause,
            attempt,
            retry_options,
            read_error_retriable,
            progress,
        );

        match decision {
            StreamRecoveryDecision::Cancelled => {
                response_status = String::from("cancelled");
                tool_calls.clear();
                streaming_tool_items.clear();
                tool_parse_errors.clear();
                interruption_reason = None;
                recovery_outcome = None;
                break 'attempt_loop;
            }
            StreamRecoveryDecision::FinishProviderResult => break 'attempt_loop,
            StreamRecoveryDecision::Retry => {
                on_chunk.call(
                    ResponsesApiStreamChunk {
                        content_delta: String::new(),
                        thinking_delta: String::new(),
                        content: String::new(),
                        thinking: String::new(),
                        retrying: true,
                        retry_attempt: Some((attempt + 1) as i32),
                        retry_error: Some(retry_error),
                        stream_token_count: stream_token_count as i64,
                        elapsed_ms: stream_start.elapsed().as_millis() as i64,
                        ttft_ms,
                        vision_status: None,
                    },
                    ThreadsafeFunctionCallMode::NonBlocking,
                );

                match wait_before_retry(retry_options, cancel_token, attempt).await {
                    Ok(()) => {
                        attempt += 1;
                        continue 'attempt_loop;
                    }
                    Err(_wait_error) if cancel_token.is_cancelled() => {
                        response_status = String::from("cancelled");
                        tool_calls.clear();
                        streaming_tool_items.clear();
                        tool_parse_errors.clear();
                        interruption_reason = None;
                        recovery_outcome = None;
                        break 'attempt_loop;
                    }
                    Err(wait_error) => return Err(wait_error),
                }
            }
            StreamRecoveryDecision::KeepUsablePartial
            | StreamRecoveryDecision::SurfaceInterrupted => {
                response_status = String::from("incomplete");
                interruption_reason = Some(cause.interruption_reason());
                recovery_outcome = decision.recovery_outcome(cause, read_error_retriable);
                streaming_tool_items.clear();
                if matches!(decision, StreamRecoveryDecision::SurfaceInterrupted) {
                    // Display text/reasoning may survive a final interruption,
                    // but neither finalized nor pending tool state is trusted.
                    tool_calls.clear();
                    tool_parse_errors.clear();
                }
                break 'attempt_loop;
            }
        }
    }

    // If no structured reasoning item arrived, preserve streamed reasoning text
    // in the existing minimal round-trip shape.
    if reasoning_items.is_empty() {
        let thinking = thinking_chunks.join("").trim().to_string();
        if !thinking.is_empty() {
            reasoning_items.push(json!({
                "type": "reasoning",
                "reasoning_text": thinking,
            }));
        }
    }


    let content = content_chunks.join("").trim().to_string();
    let thinking = thinking_chunks.join("").trim().to_string();
    let tool_calls_json = serde_json::to_string(&tool_calls).unwrap_or_else(|_| "[]".to_string());
    let reasoning_items_json =
        serde_json::to_string(&reasoning_items).unwrap_or_else(|_| "[]".to_string());

    Ok(StreamingResponseResult {
        id: response_id,
        content,
        thinking,
        reasoning_items_json,
        model: response_model,
        status: response_status,
        interruption_reason,
        recovery_outcome,
        token_usage,
        tool_calls_json,
        tool_parse_errors,
        total_duration_ms: stream_start.elapsed().as_millis() as i64,
    })
}
