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
//! It reuses the same chat/responses/anthropic/gemini dispatch pattern as
//! `summary.rs`; the responses protocol is streamed and its text collected
//! from the event stream.

use std::collections::HashMap;
use std::path::PathBuf;

use napi::bindgen_prelude::*;
use serde_json::Value;

use crate::api::common::truncate_chars;
use crate::api::config::{get_active_api_request_context, resolve_basic_model};
use crate::api::jev::JevConfig;
use crate::api::responses::{ResponsesApiMessage, ResponsesApiRequest};
use crate::storage::services::codebase_index::SearchResult;
use tokio_util::sync::CancellationToken;

const REVIEW_SYSTEM_PROMPT: &str = "You are a code search relevance reviewer. Given a user's search query and a list of code search results, your job is to identify which results are actually relevant to the query and which are irrelevant noise.\n\nYou will receive the query and a numbered list of code snippets. Respond with ONLY a JSON object in this exact format:\n{\"relevant\": [1, 3, 5], \"refined_query\": \"optional better search query\"}\n\nRules:\n- \"relevant\" is an array of 1-based result indices that are genuinely relevant to the query.\n- \"refined_query\" should be a better search query ONLY if many results are irrelevant. If results are mostly relevant, set it to empty string \"\".\n- Do not include any explanation, only the JSON object.";

const REFINE_QUERY_SYSTEM_PROMPT: &str = "You are a code search query rewriter. The developer's search query returned mostly irrelevant code search results. Write a better search query that is more likely to find the code they are actually looking for.\n\nRules:\n- Output ONLY the new search query on a single line: no quotes, no explanation, no markdown, no JSON.\n- Keep the same language as the original query.\n- Keep it short and specific: focus on the concrete identifiers, concepts or file names behind the original query.\n- If no better query exists, repeat the original query unchanged.";

const MAX_REVIEW_ATTEMPTS: u32 = 3;

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
fn resolve_review_llm_context() -> Result<(
    PathBuf,
    crate::storage::ApiConfigRecord,
    HashMap<String, String>,
    String,
)> {
    let context = get_active_api_request_context()?;
    let database_path = context.database_path;
    let api_config = context.api_config;

    if api_config.api_key.trim().is_empty() {
        return Err(Error::from_reason(
            "API key not configured. Please configure API settings first.",
        ));
    }

    let model = resolve_basic_model(None, &api_config.basic_model)?;

    Ok((database_path, api_config, context.custom_headers, model))
}

/// Send a review request through the active API config and return the
/// assistant text.
///
/// `system_prompt` is the only difference between the two LLM jobs of the
/// review loop: judging the results, or writing a refined query.
async fn request_review_text(
    database_path: PathBuf,
    api_config: crate::storage::ApiConfigRecord,
    custom_headers: HashMap<String, String>,
    model: &str,
    system_prompt: &str,
    user_content: &str,
) -> Result<String> {
    let request = ResponsesApiRequest {
        messages: vec![
            ResponsesApiMessage {
                role: "system".to_string(),
                content: system_prompt.to_string(),
                tool_results_json: None,
                thinking: None,
                thinking_blocks_json: None,
            },
            ResponsesApiMessage {
                role: "user".to_string(),
                content: user_content.to_string(),
                tool_results_json: None,
                thinking: None,
                thinking_blocks_json: None,
            },
        ],
        model: Some(model.to_string()),
        api_profile: None,
        conversation_id: None,
        previous_response_id: None,
        directory_id: None,
        analysis_workspace_root: None,
        checkpoint_id: None,
        context_compaction: None,
        resume_after_compaction: None,
        sub_agent_tools_json: None,
        sub_agent_system_prompt: None,
        sub_agent_config_profile: None,
        skip_context: Some(true),
        disable_tools: Some(true),
        internal_recovery_prompt: None,
        plan_mode: None,
        goal_mode: None,
        worktree_mode: None,
        workflow_mode: None,
        thinking_strength: Some("none".to_string()),
        responses_fast_mode: None,
        remote_role_content: None,
        remote_include_global_rules: None,
        execution_workspace_root: None,
        worktree_id: None,
    };

    let method = api_config.request_method.clone();
    let cancel_token = CancellationToken::new();
    let result = crate::api::ephemeral::run(request, move |request| async move {
        match method.as_str() {
            "responses" => crate::api::responses::create_response_stream_with_context(
                request,
                database_path,
                api_config,
                custom_headers,
                None,
                cancel_token,
            )
            .await,
            "anthropic" => crate::api::anthropic::create_anthropic_response_stream(
                request,
                database_path,
                api_config,
                custom_headers,
                None,
                cancel_token,
            )
            .await,
            "gemini" | "interactions" => crate::api::gemini::create_gemini_response_stream(
                request,
                database_path,
                api_config,
                custom_headers,
                None,
                cancel_token,
            )
            .await,
            _ => crate::api::chat::create_chat_completion_response_stream(
                request,
                database_path,
                api_config,
                custom_headers,
                None,
                cancel_token,
            )
            .await,
        }
    })
    .await?;

    let text = result.content.trim().to_string();
    if text.is_empty() {
        return Err(Error::from_reason("Review backend returned no usable text."));
    }

    Ok(text)
}

/// Send the current results to the basic model for relevance review.
async fn review_via_llm(query: &str, results: &[SearchResult]) -> Result<ReviewOutcome> {
    let (database_path, api_config, custom_headers, model) = resolve_review_llm_context()?;
    let user_content = build_review_user_content(query, results);

    let review_text = request_review_text(
        database_path,
        api_config,
        custom_headers,
        &model,
        REVIEW_SYSTEM_PROMPT,
        &user_content,
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
    let (database_path, api_config, custom_headers, model) = resolve_review_llm_context()?;
    let user_content = build_review_user_content(query, results);

    let text = request_review_text(
        database_path,
        api_config,
        custom_headers,
        &model,
        REFINE_QUERY_SYSTEM_PROMPT,
        &user_content,
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

