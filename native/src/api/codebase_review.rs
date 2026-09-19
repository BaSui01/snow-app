//! Agent review for codebase search results.
//!
//! Two review backends share the same loop:
//!
//! * **LLM** (default) — the active API config's **basic model** reviews the
//!   vector search results and removes irrelevant chunks. If more than 50% of
//!   the results are deemed irrelevant, the model is asked to generate a
//!   refined search query and the search is retried (up to 3 attempts total).
//! * **Jev** (TypeSafe System One) — a decision model answers one yes/no
//!   question per result and returns a calibrated probability, which is
//!   cheaper and faster than a generative review. Its verdict *is* the review:
//!   the LLM is never asked to judge the same results again. Jev cannot write
//!   a refined query, so when its verdict sends the loop into a re-search the
//!   LLM is used for that single job — writing the refined query — and Jev
//!   then judges the re-searched results. Only a Jev failure (transport,
//!   protocol, missing configuration) falls back to the full LLM review path.
//!
//! On the 3rd attempt, all results are returned regardless of how many
//! were deemed irrelevant — this guarantees the caller always gets
//! *something* back.
//!
//! This module is fully async and never blocks the Node.js main thread.
//! It reuses the same non-streaming chat/responses/anthropic/gemini
//! dispatch pattern as `summary.rs`.

use std::collections::HashMap;

use napi::bindgen_prelude::*;
use reqwest::header::{
    HeaderMap, HeaderName, HeaderValue, ACCEPT_ENCODING, AUTHORIZATION, CONTENT_TYPE,
};
use serde_json::{json, Value};

use crate::api::chat::payload::build_chat_reasoning_effort;
use crate::api::common::truncate_chars;
use crate::api::config::{
    get_active_api_request_context, normalize_base_url, resolve_basic_model,
    resolve_sdk_api_base_url, DEFAULT_ANTHROPIC_BASE_URL, DEFAULT_GEMINI_BASE_URL,
    DEFAULT_OPENAI_BASE_URL,
};
use crate::api::jev::JevConfig;
use crate::api::responses::payload::build_responses_reasoning;
use crate::api::retry::{should_retry, RetryOptions};
use crate::api::summary::{
    extract_anthropic_content, extract_chat_content, extract_responses_content,
};
use crate::storage::services::codebase_index::SearchResult;

const REVIEW_SYSTEM_PROMPT: &str = "You are a code search relevance reviewer. Given a user's search query and a list of code search results, your job is to identify which results are actually relevant to the query and which are irrelevant noise.\n\nYou will receive the query and a numbered list of code snippets. Respond with ONLY a JSON object in this exact format:\n{\"relevant\": [1, 3, 5], \"refined_query\": \"optional better search query\"}\n\nRules:\n- \"relevant\" is an array of 1-based result indices that are genuinely relevant to the query.\n- \"refined_query\" should be a better search query ONLY if many results are irrelevant. If results are mostly relevant, set it to empty string \"\".\n- Do not include any explanation, only the JSON object.";

const REFINE_QUERY_SYSTEM_PROMPT: &str = "You are a code search query rewriter. The developer's search query returned mostly irrelevant code search results. Write a better search query that is more likely to find the code they are actually looking for.\n\nRules:\n- Output ONLY the new search query on a single line: no quotes, no explanation, no markdown, no JSON.\n- Keep the same language as the original query.\n- Keep it short and specific: focus on the concrete identifiers, concepts or file names behind the original query.\n- If no better query exists, repeat the original query unchanged.";

const MAX_REVIEW_ATTEMPTS: u32 = 3;

/// Output-token budget used when the active API config leaves `maxTokens` unset
/// and the backend requires an explicit limit — the Anthropic Messages API
/// rejects a request without `max_tokens`.
const DEFAULT_MAX_OUTPUT_TOKENS: i32 = 4096;

/// Maximum characters of a raw review response echoed in an error message.
const RAW_RESPONSE_PREVIEW_CHARS: usize = 500;

/// Threshold: if the fraction of irrelevant results exceeds this value,
/// a refined query is requested and the search is retried.
const IRRELEVANT_FRACTION_THRESHOLD: f64 = 0.5;

/// Result of an agent review pass.
struct ReviewOutcome {
    /// Indices (0-based) of results deemed relevant.
    relevant_indices: Vec<usize>,
    /// A refined query if the model suggested one, empty otherwise.
    refined_query: String,
}

/// Final outcome of the agent review process.
pub struct AgentReviewResult {
    /// The final set of search results after review (irrelevant ones removed).
    pub results: Vec<SearchResult>,
    /// The query that produced the final results (may differ from the
    /// original if a refined query was used).
    pub effective_query: String,
    /// How many review attempts were made (1..=3).
    pub attempts: u32,
}

/// A progress event emitted during the agent review loop.
///
/// Each event describes what the review loop is currently doing, so the
/// UI can show real-time feedback instead of a static "processing..."
/// spinner.
#[derive(Debug, Clone)]
pub struct ReviewProgress {
    /// What phase the review loop is in.
    pub phase: ReviewPhase,
    /// 1-based attempt number (1..=3).
    pub attempt: u32,
    /// The query used for the current attempt.
    pub query: String,
    /// Total number of results being reviewed in the current attempt.
    pub total_count: usize,
    /// Number of results deemed relevant (only set after review completes).
    pub relevant_count: Option<usize>,
    /// The refined query suggested by the model (only set when retrying).
    pub refined_query: Option<String>,
}

/// The phase of the agent review loop.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReviewPhase {
    /// The model is currently reviewing the search results.
    Reviewing,
    /// The model suggested a refined query and we are re-searching.
    ReSearching,
    /// The review loop has completed (either results accepted or max
    /// attempts reached).
    Completed,
}

impl ReviewPhase {
    pub fn as_str(&self) -> &'static str {
        match self {
            ReviewPhase::Reviewing => "reviewing",
            ReviewPhase::ReSearching => "re_searching",
            ReviewPhase::Completed => "completed",
        }
    }
}

/// Run the agent review loop on a set of search results.
///
/// `initial_results` are the results from the first vector search.
/// `jev_config` selects the review backend: `Some` asks Jev for a per-result
/// relevance verdict and only uses the LLM to write a refined query when a
/// re-search is needed, `None` always uses the LLM for the whole review.
/// `re_search_fn` is a closure that takes a query string and returns a
/// new set of search results — this is called when the model suggests a
/// refined query.
/// `on_progress` is called at each step of the review loop so the caller
/// can report progress to the UI.
///
/// Behavior:
/// 1. Send results to the configured review backend.
/// 2. If >50% are irrelevant AND we haven't hit MAX_REVIEW_ATTEMPTS,
///    use the refined query to re-search and review again.
/// 3. On the final attempt, return all results regardless of relevance.
pub async fn run_agent_review<F, Fut, P>(
    initial_query: String,
    initial_results: Vec<SearchResult>,
    jev_config: Option<JevConfig>,
    re_search_fn: F,
    on_progress: P,
) -> Result<AgentReviewResult>
where
    F: Fn(String) -> Fut,
    Fut: std::future::Future<Output = Result<Vec<SearchResult>>>,
    P: Fn(ReviewProgress),
{
    let mut current_query = initial_query.clone();
    let mut current_results = initial_results;
    let mut attempts = 0u32;

    loop {
        attempts += 1;

        if current_results.is_empty() {
            on_progress(ReviewProgress {
                phase: ReviewPhase::Completed,
                attempt: attempts,
                query: current_query.clone(),
                total_count: 0,
                relevant_count: Some(0),
                refined_query: None,
            });
            return Ok(AgentReviewResult {
                results: current_results,
                effective_query: current_query,
                attempts,
            });
        }

        // On the final attempt, skip review and return everything.
        if attempts >= MAX_REVIEW_ATTEMPTS {
            let total = current_results.len();
            on_progress(ReviewProgress {
                phase: ReviewPhase::Completed,
                attempt: attempts,
                query: current_query.clone(),
                total_count: total,
                relevant_count: Some(total),
                refined_query: None,
            });
            return Ok(AgentReviewResult {
                results: current_results,
                effective_query: current_query,
                attempts,
            });
        }

        // Notify: starting review for this attempt.
        on_progress(ReviewProgress {
            phase: ReviewPhase::Reviewing,
            attempt: attempts,
            query: current_query.clone(),
            total_count: current_results.len(),
            relevant_count: None,
            refined_query: None,
});

        let outcome = review_results(&current_query, &current_results, jev_config.as_ref()).await?;

        let total = current_results.len();
        let relevant_count = outcome.relevant_indices.len();
        let irrelevant_count = total.saturating_sub(relevant_count);
        let irrelevant_fraction = irrelevant_count as f64 / total as f64;

        // Filter to relevant results.
        let filtered: Vec<SearchResult> = outcome
            .relevant_indices
            .iter()
            .filter_map(|&i| current_results.get(i).cloned())
            .collect();

        // If irrelevant fraction is within threshold, return filtered results.
        if irrelevant_fraction <= IRRELEVANT_FRACTION_THRESHOLD {
            on_progress(ReviewProgress {
                phase: ReviewPhase::Completed,
                attempt: attempts,
                query: current_query.clone(),
                total_count: total,
                relevant_count: Some(relevant_count),
                refined_query: None,
            });
            return Ok(AgentReviewResult {
                results: filtered,
                effective_query: current_query,
                attempts,
            });
        }

        // Too many irrelevant results — try a refined query if one was suggested.
        let refined = outcome.refined_query.trim().to_string();
        if refined.is_empty() || refined == current_query {
            // No refinement suggested — return filtered results.
            on_progress(ReviewProgress {
                phase: ReviewPhase::Completed,
                attempt: attempts,
                query: current_query.clone(),
                total_count: total,
                relevant_count: Some(relevant_count),
                refined_query: None,
            });
            return Ok(AgentReviewResult {
                results: filtered,
                effective_query: current_query,
                attempts,
            });
        }

        // Notify: re-searching with the refined query.
        on_progress(ReviewProgress {
            phase: ReviewPhase::ReSearching,
            attempt: attempts,
            query: current_query.clone(),
            total_count: total,
            relevant_count: Some(relevant_count),
            refined_query: Some(refined.clone()),
        });

        // Re-search with the refined query.
        current_query = refined;
        current_results = re_search_fn(current_query.clone()).await?;
    }
}

/// Review the current results with the configured backend.
///
/// Jev runs first when configured. Its verdict is the review, so the LLM is
/// only consulted for the one thing Jev cannot do: writing a refined query when
/// the verdict sends the loop into a re-search. Any Jev failure falls back to
/// the full LLM review, so the search never degrades because of the review
/// backend.
async fn review_results(
    query: &str,
    results: &[SearchResult],
    jev_config: Option<&JevConfig>,
) -> Result<ReviewOutcome> {
    let Some(config) = jev_config else {
        return review_via_llm(query, results).await;
    };

    let outcome = match review_via_jev(config, query, results).await {
        Ok(outcome) => outcome,
        Err(error) => {
            log_review_fallback(
                query,
                "Jev agent review failed, falling back to the LLM review",
                &error.reason,
            )
            .await;
            return review_via_llm(query, results).await;
        }
    };

    let total = results.len();
    let irrelevant = total.saturating_sub(outcome.relevant_indices.len());
    let needs_research =
        total > 0 && (irrelevant as f64 / total as f64) > IRRELEVANT_FRACTION_THRESHOLD;

    if !needs_research {
        return Ok(outcome);
    }

    // The verdict stands — only the query has to be rewritten, and that is the
    // one job Jev cannot do. When even that fails the verdict is still a
    // complete review, so the loop keeps it instead of failing outright.
    match write_refined_query(query, results).await {
        Ok(refined_query) => Ok(ReviewOutcome {
            relevant_indices: outcome.relevant_indices,
            refined_query,
        }),
        Err(error) => {
            log_review_fallback(
                query,
                "Refined query generation failed, keeping the Jev verdict",
                &error.reason,
            )
            .await;
            Ok(outcome)
        }
    }
}

/// Ask Jev for the relevance verdict of every result.
async fn review_via_jev(
    config: &JevConfig,
    query: &str,
    results: &[SearchResult],
) -> Result<ReviewOutcome> {
    let relevant_indices = crate::api::jev::evaluate_relevance(config, query, results).await?;

    Ok(ReviewOutcome {
        relevant_indices,
        // Jev is a decision model: it cannot write a refined query, so the
        // review loop always starts with an empty one. The caller asks the LLM
        // for a refined query when the verdict requires a re-search.
        refined_query: String::new(),
    })
}

/// Record a review fallback in the app log (best effort). The database
/// initialization/IO runs on a blocking worker so the async reviewer is never
/// blocked by it.
async fn log_review_fallback(query: &str, message: &str, reason: &str) {
    let Ok(Ok(database_path)) =
        tokio::task::spawn_blocking(crate::storage::ensure_database_file).await
    else {
        return;
    };

    crate::storage::services::app_logs::log_api_warning(
        &database_path,
        "codebase_review",
        message,
        &format!(
            "query: {}; reason: {}",
            truncate_chars(query, 200),
            truncate_chars(reason, 300)
        ),
    )
    .await;
}

/// Resolve the LLM context shared by the two LLM jobs of the review loop: the
/// active API config, its custom headers (a review belongs to no conversation,
/// so session-scoped header placeholders are dropped instead of sending the
/// literal template) and the resolved basic model.
fn resolve_review_llm_context(
) -> Result<(crate::storage::ApiConfigRecord, HashMap<String, String>, String)> {
    let context = get_active_api_request_context()?;
    let api_config = context.api_config;

    if api_config.api_key.trim().is_empty() {
        return Err(Error::from_reason(
            "API key not configured. Please configure API settings first.",
        ));
    }

    let mut custom_headers = context.custom_headers;
    crate::api::common::expand_custom_header_session_id(&mut custom_headers, "");

    let model = resolve_basic_model(None, &api_config.basic_model)?;

    Ok((api_config, custom_headers, model))
}

/// Retry policy of the active API config, shared by every review request.
fn retry_options_for(api_config: &crate::storage::ApiConfigRecord) -> RetryOptions {
    RetryOptions::from_config(
        api_config.max_retries,
        api_config.retry_base_delay_ms,
        api_config.partial_retry_max_chars,
    )
}

/// Send a non-streaming request through the API method of the active config and
/// return the assistant text.
///
/// `system_prompt` is the only difference between the two LLM jobs of the
/// review loop: judging the results, or writing a refined query.
async fn request_review_text(
    api_config: &crate::storage::ApiConfigRecord,
    custom_headers: &HashMap<String, String>,
    model: &str,
    system_prompt: &str,
    user_content: &str,
    retry_options: &RetryOptions,
) -> Result<String> {
    let api_key = api_config.api_key.trim();

    match api_config.request_method.as_str() {
        "responses" => {
            review_via_responses(
                api_config,
                api_key,
                custom_headers,
                model,
                system_prompt,
                user_content,
                retry_options,
            )
            .await
        }
        "anthropic" => {
            review_via_anthropic(
                api_config,
                api_key,
                custom_headers,
                model,
                system_prompt,
                user_content,
                retry_options,
            )
            .await
        }
        "gemini" | "interactions" => {
            review_via_gemini(
                api_config,
                api_key,
                custom_headers,
                model,
                system_prompt,
                user_content,
                retry_options,
            )
            .await
        }
        _ => {
            review_via_chat(
                api_config,
                api_key,
                custom_headers,
                model,
                system_prompt,
                user_content,
                retry_options,
            )
            .await
        }
    }
}

/// Send the current results to the basic model for relevance review.
async fn review_via_llm(query: &str, results: &[SearchResult]) -> Result<ReviewOutcome> {
    let (api_config, custom_headers, model) = resolve_review_llm_context()?;
    let retry_options = retry_options_for(&api_config);
    let user_content = build_review_user_content(query, results);

    let review_text = request_review_text(
        &api_config,
        &custom_headers,
        &model,
        REVIEW_SYSTEM_PROMPT,
        &user_content,
        &retry_options,
    )
    .await?;

    parse_review_response(&review_text, results.len())
}

/// Ask the basic model for a better search query.
///
/// Jev cannot rewrite the query, so when its verdict sends the review loop into
/// a re-search this is the only job the LLM gets: writing the refined query. It
/// never reviews the results a second time.
async fn write_refined_query(query: &str, results: &[SearchResult]) -> Result<String> {
    let (api_config, custom_headers, model) = resolve_review_llm_context()?;
    let retry_options = retry_options_for(&api_config);
    let user_content = build_review_user_content(query, results);

    let text = request_review_text(
        &api_config,
        &custom_headers,
        &model,
        REFINE_QUERY_SYSTEM_PROMPT,
        &user_content,
        &retry_options,
    )
    .await?;

    Ok(normalize_refined_query(&text))
}

/// Clean the model's refined query down to a single bare line: models often
/// wrap the query in quotes or a code fence, and any of the surrounding prose
/// would be sent to the embedding model as-is. An empty result means "no
/// refinement", which keeps the current query.
fn normalize_refined_query(text: &str) -> String {
    let line = text
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or_default();

    line.trim_matches(|ch: char| matches!(ch, '"' | '\'' | '`' | '“' | '”'))
        .trim()
        .to_string()
}

fn build_review_user_content(query: &str, results: &[SearchResult]) -> String {
    let mut content = format!("Search query: {}\n\nResults:\n", query);
    for (i, result) in results.iter().enumerate() {
        // Truncate content to keep the prompt manageable.
        let truncated: String = result.content.chars().take(800).collect();
        content.push_str(&format!(
            "[{}] {} (lines {}-{}, score {:.3}):\n{}\n\n",
            i + 1,
            result.relative_path,
            result.start_line,
            result.end_line,
            result.score,
            truncated
        ));
    }
    content
}

async fn review_via_chat(
    api_config: &crate::storage::ApiConfigRecord,
    api_key: &str,
    custom_headers: &HashMap<String, String>,
    model: &str,
    system_prompt: &str,
    user_content: &str,
    retry_options: &RetryOptions,
) -> Result<String> {
    let endpoint = resolve_chat_endpoint(api_config);
    if endpoint.is_empty() {
        return Err(Error::from_reason(
            "Base URL not configured. Please configure API settings first.",
        ));
    }

    let mut payload = json!({
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content}
        ],
        "stream": false,
    });

    // max_tokens 遵循用户配置（留空时不传该参数，由服务端决定默认值），与主会话
    // （api/chat/payload.rs）保持一致：写死的小额度会被推理模型的思考内容吃光，
    // 正文就会变成空的。
    if let Some(max_tokens) = api_config.max_tokens {
        if max_tokens > 0 {
            payload["max_tokens"] = json!(max_tokens);
        }
    }

    // 审查与改写查询只需要一段文本：跟随用户 chatThinking 配置，关闭思考时不发送
    // reasoning_effort，避免供应商 400。
    if let Some(reasoning_effort) = build_chat_reasoning_effort(&api_config.config_json) {
        payload["reasoning_effort"] = json!(reasoning_effort);
    }

    let client = crate::api::http_client::build_proxied_client().await?;

    let body: Value = send_review_request_with_retry(
        &client,
        &endpoint,
        build_header_map(api_key, custom_headers)?,
        &payload,
        retry_options,
    )
    .await?;

    ensure_review_text(extract_chat_content(&body), &body)
}

async fn review_via_responses(
    api_config: &crate::storage::ApiConfigRecord,
    api_key: &str,
    custom_headers: &HashMap<String, String>,
    model: &str,
    system_prompt: &str,
    user_content: &str,
    retry_options: &RetryOptions,
) -> Result<String> {
    let base_url = normalize_base_url(&api_config.base_url);
    if base_url.is_empty() {
        return Err(Error::from_reason(
            "Base URL not configured. Please configure API settings first.",
        ));
    }

    let resolved_base = resolve_sdk_api_base_url(&base_url, &api_config.base_url_mode);
    let endpoint = format!("{}/responses", resolved_base);

    let mut payload = json!({
        "model": model,
        "input": [
            {"type": "message", "role": "system", "content": system_prompt},
            {"type": "message", "role": "user", "content": user_content}
        ],
        "stream": false,
    });

    // max_output_tokens / reasoning 均遵循用户配置，与主流程
    // （api/responses/payload.rs）保持一致。
    if let Some(max_tokens) = api_config.max_tokens {
        if max_tokens > 0 {
            payload["max_output_tokens"] = json!(max_tokens);
        }
    }
    if let Some(reasoning) = build_responses_reasoning(&api_config.config_json) {
        payload["reasoning"] = reasoning;
    }

    let client = crate::api::http_client::build_proxied_client().await?;

    let body: Value = send_review_request_with_retry(
        &client,
        &endpoint,
        build_header_map(api_key, custom_headers)?,
        &payload,
        retry_options,
    )
    .await?;

    ensure_review_text(extract_responses_content(&body), &body)
}

async fn review_via_anthropic(
    api_config: &crate::storage::ApiConfigRecord,
    api_key: &str,
    custom_headers: &HashMap<String, String>,
    model: &str,
    system_prompt: &str,
    user_content: &str,
    retry_options: &RetryOptions,
) -> Result<String> {
    let endpoint = resolve_anthropic_endpoint(api_config);
    if endpoint.is_empty() {
        return Err(Error::from_reason(
            "Base URL not configured. Please configure API settings first.",
        ));
    }

    // `[1M]` 后缀是 Claude Code 生态的本地上下文能力声明：发送前剥离，
    // 并附带 context-1m beta 头显式启用 1M 上下文（与主流程一致）。
    // 生效条件：模型名带标记，或档案开关 snowcfg.enable1mContext 开启。
    let enable_one_m_context = crate::api::anthropic::payload::has_one_m_context_marker(model)
        || crate::api::anthropic::payload::config_json_enables_one_m_context(
            &api_config.config_json,
        );
    let model = crate::api::anthropic::payload::strip_one_m_context_marker(model);

    // Anthropic Messages API 要求 max_tokens 必填：用户未配置时回落到默认额度。
    let max_tokens = api_config
        .max_tokens
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_MAX_OUTPUT_TOKENS);

    let payload = json!({
        "model": model,
        "max_tokens": max_tokens,
        "stream": false,
        // 审查不需要思考：显式关闭，避免思考内容吃掉正文额度（与标题生成一致）。
        "thinking": {"type": "disabled"},
        "system": system_prompt,
        "messages": [{"role": "user", "content": user_content}],
    });

    let client = crate::api::http_client::build_proxied_client().await?;

    let body: Value = send_review_request_with_retry(
        &client,
        &endpoint,
        build_anthropic_header_map(api_key, custom_headers, enable_one_m_context)?,
        &payload,
        retry_options,
    )
    .await?;

    ensure_review_text(extract_anthropic_content(&body), &body)
}

async fn review_via_gemini(
    api_config: &crate::storage::ApiConfigRecord,
    api_key: &str,
    custom_headers: &HashMap<String, String>,
    model: &str,
    system_prompt: &str,
    user_content: &str,
    retry_options: &RetryOptions,
) -> Result<String> {
    let endpoint = resolve_gemini_endpoint(api_config, model, api_key);
    if endpoint.is_empty() {
        return Err(Error::from_reason(
            "Base URL not configured. Please configure API settings first.",
        ));
    }

    // maxOutputTokens 遵循用户配置（留空时由服务端决定默认值），与主流程
    // （api/gemini/payload.rs）保持一致。
    let mut generation_config = json!({});
    if let Some(max_tokens) = api_config.max_tokens {
        if max_tokens > 0 {
            generation_config["maxOutputTokens"] = json!(max_tokens);
        }
    }

    let payload = json!({
        "systemInstruction": {
            "parts": [{"text": system_prompt}]
        },
        "contents": [{
            "role": "user",
            "parts": [{"text": user_content}]
        }],
        "generationConfig": generation_config
    });

    let client = crate::api::http_client::build_proxied_client().await?;

    let body: Value = send_review_request_with_retry(
        &client,
        &endpoint,
        build_gemini_header_map(custom_headers)?,
        &payload,
        retry_options,
    )
    .await?;

    ensure_review_text(extract_gemini_content(&body), &body)
}

/// Send a non-streaming review request with retry logic.
async fn send_review_request_with_retry(
    client: &reqwest::Client,
    endpoint: &str,
    headers: reqwest::header::HeaderMap,
    payload: &Value,
    retry_options: &RetryOptions,
) -> Result<Value> {
    let mut attempt: u32 = 0;
    loop {
        let response = client
            .post(endpoint)
            .headers(headers.clone())
            .json(payload)
            .send()
            .await
            .map_err(|error| Error::from_reason(format!("Review request failed: {}", error)));

        match response {
            Ok(response) => {
                let status = response.status();
                if !status.is_success() {
                    let error_body = response.text().await.unwrap_or_default();
                    let error = Error::from_reason(format!(
                        "Review request failed: {} {}",
                        status, error_body
                    ));

                    if !should_retry(&error, attempt, retry_options) {
                        return Err(error);
                    }

                    attempt += 1;
                    let delay = std::time::Duration::from_millis(retry_options.base_delay_ms);
                    tokio::time::sleep(delay).await;
                    continue;
                }

                let body: Value = response.json().await.map_err(|error| {
                    Error::from_reason(format!("Failed to parse review response: {}", error))
                })?;

                return Ok(body);
            }
            Err(error) => {
                if !should_retry(&error, attempt, retry_options) {
                    return Err(error);
                }

                attempt += 1;
                let delay = std::time::Duration::from_millis(retry_options.base_delay_ms);
                tokio::time::sleep(delay).await;
                continue;
            }
        }
    }
}

/// Parse the model's review response into a ReviewOutcome.
///
/// Expected JSON: `{"relevant": [1, 3, 5], "refined_query": "new query"}`
/// Indices in the response are 1-based; we convert to 0-based.
fn parse_review_response(text: &str, total_results: usize) -> Result<ReviewOutcome> {
    let trimmed = text.trim();

    // Strip markdown code fences if present.
    let json_str = trimmed
        .strip_prefix("```json")
        .or_else(|| strip_prefix_ci(trimmed, "```json"))
        .map(|s| s.trim())
        .and_then(|s| s.strip_suffix("```").map(|s| s.trim()))
        .or_else(|| {
            trimmed
                .strip_prefix("```")
                .and_then(|s| s.strip_suffix("```"))
                .map(|s| s.trim())
        })
        .unwrap_or(trimmed);

    // Try to extract JSON from the text — the model may include extra text.
    let json_str = extract_json_object(json_str).unwrap_or(json_str);

    let parsed: Value = serde_json::from_str(json_str).map_err(|error| {
        Error::from_reason(format!(
            "Failed to parse review response as JSON: {}. Raw text: {}",
            error,
            truncate_chars(text, 300)
        ))
    })?;

    let relevant_indices: Vec<usize> = parsed
        .get("relevant")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_u64().map(|n| n as usize))
                .filter(|&i| i > 0 && i <= total_results)
                .map(|i| i - 1) // Convert to 0-based
                .collect()
        })
        .unwrap_or_else(|| {
            // If no "relevant" field, treat all as relevant.
            (0..total_results).collect()
        });

    let refined_query = parsed
        .get("refined_query")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    Ok(ReviewOutcome {
        relevant_indices,
        refined_query,
    })
}

/// Extract the first JSON object from a string that may contain extra text.
fn extract_json_object(text: &str) -> Option<&str> {
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    if end >= start {
        Some(&text[start..=end])
    } else {
        None
    }
}

fn strip_prefix_ci<'a>(s: &'a str, prefix: &str) -> Option<&'a str> {
    if s.len() >= prefix.len() && s[..prefix.len()].eq_ignore_ascii_case(prefix) {
        Some(&s[prefix.len()..])
    } else {
        None
    }
}

/// Extract the assistant text from a non-streaming Gemini response.
///
/// `thought: true` parts carry the model's internal reasoning and are skipped:
/// only the main text is the review answer.
fn extract_gemini_content(body: &Value) -> String {
    let Some(parts) = body
        .get("candidates")
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .and_then(|item| item.get("content"))
        .and_then(|content| content.get("parts"))
        .and_then(Value::as_array)
    else {
        return String::new();
    };

    for part in parts {
        if part
            .get("thought")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            continue;
        }
        if let Some(text) = part.get("text").and_then(Value::as_str) {
            if !text.trim().is_empty() {
                return text.to_string();
            }
        }
    }

    String::new()
}

/// Reject an empty answer from a review backend.
///
/// Without this check an empty body reaches `serde_json` and surfaces as a
/// meaningless "EOF while parsing a value" error; the response preview in the
/// message tells what the backend actually returned instead.
fn ensure_review_text(text: String, body: &Value) -> Result<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err(Error::from_reason(format!(
            "Review backend returned no usable text. Response body: {}",
            truncate_chars(&body.to_string(), RAW_RESPONSE_PREVIEW_CHARS)
        )));
    }

    Ok(trimmed.to_string())
}

fn resolve_anthropic_endpoint(api_config: &crate::storage::ApiConfigRecord) -> String {
    let normalized_base_url = normalize_base_url(&api_config.base_url);
    if normalized_base_url.is_empty() {
        return String::new();
    }

    let base_url = if normalized_base_url == DEFAULT_OPENAI_BASE_URL {
        DEFAULT_ANTHROPIC_BASE_URL.to_string()
    } else {
        normalized_base_url
    };

    if api_config.base_url_mode == "endpoint" {
        return base_url;
    }

    let resolved_base = resolve_sdk_api_base_url(&base_url, &api_config.base_url_mode);
    format!("{}/messages", resolved_base)
}

fn resolve_gemini_endpoint(
    api_config: &crate::storage::ApiConfigRecord,
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

    let mut url = format!("{}/models/{}:generateContent", resolved_base, clean_model);

    if !api_key.is_empty() {
        url.push_str(&format!("?key={}", api_key));
    }

    url
}

fn resolve_chat_endpoint(api_config: &crate::storage::ApiConfigRecord) -> String {
    let normalized_base_url = normalize_base_url(&api_config.base_url);
    if normalized_base_url.is_empty() {
        return String::new();
    }

    if api_config.base_url_mode == "endpoint" {
        normalized_base_url
    } else {
        format!(
            "{}/chat/completions",
            resolve_sdk_api_base_url(&normalized_base_url, &api_config.base_url_mode)
        )
    }
}

fn build_header_map(api_key: &str, custom_headers: &HashMap<String, String>) -> Result<HeaderMap> {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(ACCEPT_ENCODING, HeaderValue::from_static("identity"));
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {}", api_key)).map_err(|error| {
            Error::from_reason(format!("Invalid authorization header value: {}", error))
        })?,
    );

    for (key, value) in custom_headers {
        let trimmed_key = key.trim();
        let trimmed_value = value.trim();
        if trimmed_key.is_empty() || trimmed_value.is_empty() {
            continue;
        }

        if trimmed_key.eq_ignore_ascii_case("content-type")
            || trimmed_key.eq_ignore_ascii_case("accept-encoding")
            || trimmed_key.eq_ignore_ascii_case("authorization")
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

    Ok(headers)
}

fn build_anthropic_header_map(
    api_key: &str,
    custom_headers: &HashMap<String, String>,
    enable_one_m_context: bool,
) -> Result<HeaderMap> {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(ACCEPT_ENCODING, HeaderValue::from_static("identity"));
    headers.insert(
        HeaderName::from_static("x-api-key"),
        HeaderValue::from_str(api_key).map_err(|error| {
            Error::from_reason(format!("Invalid API key header value: {}", error))
        })?,
    );

    // 1M 上下文：模型名带 `[1M]` 标记时注入 context-1m beta 头（与主流程
    // api/anthropic/stream.rs 的 build_header_map 保持一致），并与用户
    // 自定义的 anthropic-beta 头逗号合并，避免互相覆盖。
    let mut reserved_keys: Vec<&str> = vec![
        "content-type",
        "accept-encoding",
        "x-api-key",
        "authorization",
    ];
    if enable_one_m_context {
        reserved_keys.push("anthropic-beta");
        let user_beta = custom_headers
            .iter()
            .find(|(key, _)| key.trim().eq_ignore_ascii_case("anthropic-beta"))
            .map(|(_, value)| value.trim())
            .filter(|value| !value.is_empty());
        let beta_value = match user_beta {
            Some(extra) => format!(
                "{},{}",
                crate::api::anthropic::payload::ANTHROPIC_ONE_M_CONTEXT_BETA,
                extra
            ),
            None => crate::api::anthropic::payload::ANTHROPIC_ONE_M_CONTEXT_BETA.to_string(),
        };
        headers.insert(
            HeaderName::from_static("anthropic-beta"),
            HeaderValue::from_str(&beta_value).map_err(|error| {
                Error::from_reason(format!("Invalid anthropic-beta header value: {}", error))
            })?,
        );
    }

    for (key, value) in custom_headers {
        let trimmed_key = key.trim();
        let trimmed_value = value.trim();
        if trimmed_key.is_empty() || trimmed_value.is_empty() {
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

    Ok(headers)
}

fn build_gemini_header_map(custom_headers: &HashMap<String, String>) -> Result<HeaderMap> {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(ACCEPT_ENCODING, HeaderValue::from_static("identity"));

    for (key, value) in custom_headers {
        let trimmed_key = key.trim();
        let trimmed_value = value.trim();
        if trimmed_key.is_empty() || trimmed_value.is_empty() {
            continue;
        }

        if trimmed_key.eq_ignore_ascii_case("content-type")
            || trimmed_key.eq_ignore_ascii_case("accept-encoding")
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

    Ok(headers)
}
