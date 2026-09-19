//! Decision model (TypeSafe System One / Jev) client, used by the codebase
//! agent-review loop and the sensitive-command gate.
//!
//! A decision model is not a text generator: it evaluates a `state`
//! against a map of typed questions and answers each one. Here it is used for
//! two jobs — asking a `choice` question per search result ("relevant" vs
//! "irrelevant"), and asking whether a command that matched a sensitive rule
//! may run without user confirmation plus one reason category. The verdict is
//! the model's own: there is no user-tuned probability threshold, so a single
//! request replaces the JSON-producing LLM review for the common case.
//!
//! Design constraints (https://docs.typesafe.ai/api):
//! - The state plus every question must fit the model's context (32k tokens for
//!   the state), so the state is built under a hard character budget. Results
//!   that do not fit are kept as relevant instead of being silently dropped.
//! - Jev cannot produce a refined search query. When its verdict triggers a
//!   re-search, the caller asks the LLM for that query only; a Jev failure
//!   falls back to the LLM review path.
//! - Any transport or protocol failure returns an error so the caller can fall
//!   back: this module never degrades the search on its own.
//!
//! Everything here is async and never blocks the Node.js main thread.

use std::path::Path;
use std::time::Duration;

use napi::bindgen_prelude::*;
use reqwest::header::{HeaderMap, HeaderValue};
use serde_json::{json, Map, Value};

use crate::api::common::truncate_chars;
use crate::api::config::normalize_base_url;
use crate::storage::services::codebase_index::SearchResult;
use crate::storage::services::system_settings::get_system_setting_value;
use crate::storage::SensitiveCommandMatchResult;

/// Official TypeSafe endpoint host, used when the user leaves the base URL
/// empty in the decision model configuration.
const DEFAULT_BASE_URL: &str = "https://api.typesafe.ai/v1";

/// system_settings 里决策模型配置的 setting_code（与前端
/// `src/renderer/constants/decisionModels.ts` 保持一致）。
pub const DECISION_MODELS_SETTING_CODE: &str = "decision_models";

/// Maximum number of results turned into questions in a single request.
const MAX_QUESTIONS: usize = 40;

/// Maximum characters of each result excerpt sent as part of the state.
const MAX_EXCERPT_CHARS: usize = 800;

/// Maximum characters of the whole state (query + all excerpts). Jev's budget is
/// 32k tokens for the state plus the longest question; a character budget with a
/// wide safety margin keeps code excerpts (roughly 4 characters per token)
/// comfortably inside it.
const MAX_STATE_CHARS: usize = 40_000;

/// Request timeout. Jev answers in tens of milliseconds; a short ceiling keeps
/// a stalled endpoint from holding up the search.
const REQUEST_TIMEOUT_SECS: u64 = 30;

/// Option the model picks for a result it judges relevant. The other option is
/// `irrelevant`; the two are the only values of the question's criteria.
const RELEVANT_OPTION: &str = "relevant";

/// Sensitive-command verdict: the command may run without user confirmation.
const ALLOW_OPTION: &str = "allow";

/// Sensitive-command verdict: the user has to confirm the command first.
const DENY_OPTION: &str = "deny";

/// Question ids of the sensitive-command request; the answers come back under
/// the same keys.
const VERDICT_QUESTION_ID: &str = "verdict";
const REASON_QUESTION_ID: &str = "reason";

/// Fallback reason category used when the model's answer is missing or names
/// an option we do not know.
const REASON_UNKNOWN: &str = "unclear";

/// Reason categories of a sensitive-command verdict. The keys are stable — the
/// frontend localizes them (`sensitiveCommand.decision.reason.<key>`), so the
/// model never writes user-facing text.
const REASON_CATEGORIES: &[(&str, &str)] = &[
    (
        "readOnly",
        "Only reads information; files, system state and remote state stay untouched",
    ),
    (
        "regenerable",
        "Touches only generated or regenerable artifacts (build output, caches, temporary files, dependencies)",
    ),
    (
        "scopedChange",
        "Changes stay inside the working directory and can be undone (edit, rename, move)",
    ),
    (
        "dataLoss",
        "Deletes or overwrites data that cannot be recovered",
    ),
    (
        "systemState",
        "Changes system or environment state (permissions, packages, services, processes)",
    ),
    (
        "externalEffect",
        "Publishes or sends data outside this machine (git push, upload, network write)",
    ),
    (
        REASON_UNKNOWN,
        "The target or the blast radius of the command is unclear",
    ),
];

/// Configuration for the decision-model evaluation endpoint.
#[derive(Debug, Clone)]
pub struct JevConfig {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
}

/// 一个决策模型配置项（system_settings 的 `decision_models`，字段名与前端
/// camelCase 一致）。
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct DecisionModel {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub enabled: bool,
}

#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
struct DecisionModelStore {
    models: Vec<DecisionModel>,
}

/// 读取全部决策模型配置。
///
/// 配置缺失、为空或解析失败时返回空列表：调用方随即退回 LLM 审查路径，
/// 不影响搜索本身。
pub fn load_decision_models(database_path: &Path) -> Vec<DecisionModel> {
    let raw = match get_system_setting_value(database_path, DECISION_MODELS_SETTING_CODE) {
        Ok(Some(value)) => value,
        _ => return Vec::new(),
    };

    if raw.trim().is_empty() {
        return Vec::new();
    }

    serde_json::from_str::<DecisionModelStore>(&raw)
        .map(|store| store.models)
        .unwrap_or_default()
}

impl JevConfig {
    /// Build a config from the decision model selected in the codebase settings.
    ///
    /// Returns `None` when nothing is selected, when the selected entry is
    /// missing or disabled, or when its request information (API key / model) is
    /// incomplete — the caller then keeps using the LLM review path.
    pub fn from_decision_model(models: &[DecisionModel], model_id: &str) -> Option<Self> {
        let selected = find_enabled_decision_model(models, model_id)?;
        let api_key = selected.api_key.trim();
        let model = selected.model.trim();

        if api_key.is_empty() || model.is_empty() {
            return None;
        }

        Some(Self {
            base_url: resolve_base_url(&selected.base_url),
            api_key: api_key.to_string(),
            model: model.to_string(),
        })
    }
}

/// 按 id 查找可用的决策模型（存在且已启用）。调用方据此读取展示名称，或
/// 交给 [`JevConfig::from_decision_model`] 解析请求配置。
pub fn find_enabled_decision_model<'a>(
    models: &'a [DecisionModel],
    model_id: &str,
) -> Option<&'a DecisionModel> {
    let model_id = model_id.trim();
    if model_id.is_empty() {
        return None;
    }

    models.iter().find(|item| item.id == model_id && item.enabled)
}

/// Normalized Base URL, falling back to the official TypeSafe endpoint.
fn resolve_base_url(base_url: &str) -> String {
    let normalized = normalize_base_url(base_url);

    if normalized.is_empty() {
        DEFAULT_BASE_URL.to_string()
    } else {
        normalized
    }
}

/// Ask Jev which of the given results are relevant to the query.
///
/// Returns the indices (into `results`) that Jev judged relevant. The verdict is
/// the model's own: every result becomes one `choice` question between
/// `relevant` and `irrelevant`, and the option Jev picks decides — no
/// user-tuned similarity threshold takes part in the decision. Results that
/// could not be asked about (state budget exhausted, question cap reached) and
/// results whose answer is missing are returned as relevant, so the review is
/// always conservative.
pub async fn evaluate_relevance(
    config: &JevConfig,
    query: &str,
    results: &[SearchResult],
) -> Result<Vec<usize>> {
    if results.is_empty() {
        return Ok(Vec::new());
    }

    let (state, asked) = build_state(query, results);

    // Nothing fit the state budget — report everything as relevant instead of
    // sending a request that only judges the query against an empty list.
    if asked.is_empty() {
        return Ok((0..results.len()).collect());
    }

    let mut questions = Map::new();
    for (_, id) in &asked {
        questions.insert(
            id.clone(),
            json!({
                "type": "choice",
                "instructions": format!("Is result [{id}] relevant to the developer's code search query?"),
                "criteria": {
                    "relevant": "The excerpt matches what the query is looking for",
                    "irrelevant": "An unrelated file, or generic boilerplate that only looks similar"
                }
            }),
        );
    }

    let parsed = evaluate_state(
        config,
        &json!({
            "state": state,
            "model": config.model,
            "questions": questions,
        }),
    )
    .await?;

    let answers = parsed.get("answers").and_then(Value::as_object);

    let mut asked_indices: Vec<usize> = Vec::with_capacity(asked.len());
    let mut relevant: Vec<usize> = Vec::with_capacity(results.len());

    for (index, id) in &asked {
        let verdict = answers
            .and_then(|map| map.get(id))
            .and_then(|answer| answer.get("choice"))
            .and_then(Value::as_str);

        // The model's verdict decides: "relevant" keeps the result, any other
        // option means irrelevant. A missing answer keeps the result as well —
        // the review never drops a result it could not judge.
        if verdict.is_none() || verdict == Some(RELEVANT_OPTION) {
            relevant.push(*index);
        }
        asked_indices.push(*index);
    }

    // Results that were never asked about (question cap / state budget) are
    // kept: an incomplete review must never delete results it did not judge.
    for index in 0..results.len() {
        if !asked_indices.contains(&index) {
            relevant.push(index);
        }
    }

    relevant.sort_unstable();
    Ok(relevant)
}

/// Jev's verdict on a command that matched a sensitive rule.
pub struct CommandDecision {
    /// Whether the command may run without asking the user.
    pub allow: bool,
    /// Reason category key (one of `REASON_CATEGORIES`); the frontend localizes
    /// it, so the model never writes user-facing text.
    pub reason: String,
    /// The model's confidence in the verdict (0-1).
    pub confidence: f64,
}

/// 一条命令的判定上下文：命令本身的文本，加上模型写的一行说明与它实际
/// 执行的目录。上下文越完整，风险判断越准（同样是 `rm`，删构建产物和删
/// 源码目录的风险完全不同）。
pub struct CommandContext<'a> {
    /// 完整命令文本。
    pub command: &'a str,
    /// 模型为命令写的一行说明（`bash-terminal-execute` 的 `description`）。
    pub description: &'a str,
    /// 命令的实际执行目录。
    pub working_directory: &'a str,
    /// 命中的敏感规则（模式 + 说明），仅作为「这条命令被规则命中」的证据，
    /// 本身不构成风险。
    pub matched_rules: &'a [SensitiveCommandMatchResult],
}

/// Ask Jev whether a command that matched a sensitive rule may run without
/// user confirmation, and why.
///
/// The verdict is the model's own `choice` between `allow` and `deny`, judged
/// on the command's real effect in its working directory — a matched rule is
/// only a hint, never a verdict (rules also fire on file names, arguments and
/// commit messages). A second question picks one of the fixed reason categories
/// (`REASON_CATEGORIES`) so the caller can explain the verdict in the user's own
/// language. Both answers arrive in one request. A missing verdict is an error:
/// the caller then keeps the plain confirmation prompt instead of acting on a
/// guess.
pub async fn evaluate_command(
    config: &JevConfig,
    context: &CommandContext<'_>,
) -> Result<CommandDecision> {
    let mut state = Map::new();
    state.insert("command".to_string(), json!(context.command));
    if !context.description.trim().is_empty() {
        state.insert(
            "description".to_string(),
            json!(context.description.trim()),
        );
    }
    if !context.working_directory.trim().is_empty() {
        state.insert(
            "workingDirectory".to_string(),
            json!(context.working_directory.trim()),
        );
    }
    state.insert("platform".to_string(), json!(std::env::consts::OS));
    state.insert(
        "matchedRules".to_string(),
        json!(context
            .matched_rules
            .iter()
            .map(|rule| json!({
                "pattern": rule.pattern,
                "description": rule.description,
            }))
            .collect::<Vec<Value>>()),
    );

    let mut reason_criteria = Map::new();
    for (key, description) in REASON_CATEGORIES {
        reason_criteria.insert((*key).to_string(), json!(description));
    }

    let questions = json!({
        (VERDICT_QUESTION_ID): {
            "type": "choice",
            "instructions": "Judging the real effect of this exact command in this working directory, does it have to wait for the user's confirmation before it runs?",
            "criteria": {
                (ALLOW_OPTION): "Low risk — it can run unattended. It only reads, or it touches generated or regenerable artifacts (build output, caches, temporary files, package or dependency directories), or its effect stays inside the working directory and is easy to undo. A matched rule is not a risk by itself: rules also fire on file names, arguments and commit messages. Typical cases: inspecting files, builds, tests, formatting, cleaning build output, installing dependencies, git status/diff/add/commit inside the project.",
                (DENY_OPTION): "Real risk of an effect the user did not ask for and could not easily undo: deleting or overwriting source code, documents, databases or paths outside the working directory; wiping data that cannot be regenerated; changing system or environment state (permissions, packages, services, processes); publishing or sending data off this machine; or the target is unknown so the effect cannot be bounded. Typical cases: recursive deletion of unresolved paths, disk formatting, force push, dropping a database, piping local files to a remote host.",
            }
        },
        (REASON_QUESTION_ID): {
            "type": "choice",
            "instructions": "Which of these best describes the command's effect?",
            "criteria": reason_criteria,
        },
    });

    let parsed = evaluate_state(
        config,
        &json!({
            "state": state,
            "model": config.model,
            "questions": questions,
        }),
    )
    .await?;

    let answers = parsed.get("answers").and_then(Value::as_object);
    let verdict_answer = answers.and_then(|map| map.get(VERDICT_QUESTION_ID));
    let verdict = verdict_answer
        .and_then(|answer| answer.get("choice"))
        .and_then(Value::as_str)
        .ok_or_else(|| {
            Error::from_reason("Jev did not answer the sensitive command verdict".to_string())
        })?;

    // An unknown or missing reason category degrades to `unclear`: the verdict
    // still stands, only its explanation is less specific.
    let reason = answers
        .and_then(|map| map.get(REASON_QUESTION_ID))
        .and_then(|answer| answer.get("choice"))
        .and_then(Value::as_str)
        .filter(|choice| REASON_CATEGORIES.iter().any(|(key, _)| key == choice))
        .unwrap_or(REASON_UNKNOWN)
        .to_string();

    Ok(CommandDecision {
        // Anything but an explicit `allow` keeps the confirmation prompt.
        allow: verdict == ALLOW_OPTION,
        reason,
        confidence: verdict_answer
            .and_then(|answer| answer.get("confidence"))
            .and_then(Value::as_f64)
            .unwrap_or(0.0)
            .clamp(0.0, 1.0),
    })
}

/// Send one evaluation request to Jev and return the parsed response body.
///
/// Every failure (transport, HTTP status, malformed body) is reported as an
/// error so the caller can decide what to fall back to.
async fn evaluate_state(config: &JevConfig, body: &Value) -> Result<Value> {
    let endpoint = resolve_systemone_endpoint(&config.base_url);

    // Request logging needs the database path; resolving it touches the
    // filesystem on first use, so it runs on a blocking worker instead of
    // stalling this async path.
    if let Ok(Ok(database_path)) =
        tokio::task::spawn_blocking(crate::storage::ensure_database_file).await
    {
        let request_json = serde_json::to_string(body).unwrap_or_default();
        crate::storage::services::app_logs::maybe_log_api_request(
            database_path,
            "jev".to_string(),
            endpoint.clone(),
            request_json,
        )
        .await;
    }

    let client = crate::api::http_client::build_proxied_client_with_timeout(Duration::from_secs(
        REQUEST_TIMEOUT_SECS,
    ))
    .await?;

    let response = client
        .post(&endpoint)
        .headers(build_headers(&config.api_key))
        .json(body)
        .send()
        .await
        .map_err(|error| Error::from_reason(format!("Jev request failed: {error}")))?;

    let status = response.status();
    let response_text = response
        .text()
        .await
        .map_err(|error| Error::from_reason(format!("Failed to read Jev response: {error}")))?;

    if !status.is_success() {
        return Err(Error::from_reason(format!(
            "Jev API returned status {}: {}",
            status,
            truncate_chars(&response_text, 500)
        )));
    }

    serde_json::from_str(&response_text)
        .map_err(|error| Error::from_reason(format!("Failed to parse Jev response: {error}")))
}

/// Build the evaluation state and the list of `(result index, question id)`
/// pairs that fit inside the state budget.
fn build_state(query: &str, results: &[SearchResult]) -> (Value, Vec<(usize, String)>) {
    let mut items: Vec<Value> = Vec::new();
    let mut asked: Vec<(usize, String)> = Vec::new();
    let mut used_chars = query.chars().count();

    for (index, result) in results.iter().enumerate() {
        if asked.len() >= MAX_QUESTIONS {
            break;
        }

        let excerpt: String = result.content.chars().take(MAX_EXCERPT_CHARS).collect();
        // Path, line range, id and the surrounding JSON keys also consume the
        // budget; approximate them with a small constant.
        let cost = excerpt.chars().count() + result.relative_path.chars().count() + 96;
        if used_chars + cost > MAX_STATE_CHARS {
            break;
        }
        used_chars += cost;

        let id = format!("result_{}", index + 1);
        items.push(json!({
            "id": id,
            "file": result.relative_path,
            "lines": format!("{}-{}", result.start_line, result.end_line),
            "excerpt": excerpt,
        }));
        asked.push((index, id));
    }

    (json!({ "query": query, "results": items }), asked)
}

fn resolve_systemone_endpoint(base_url: &str) -> String {
    let normalized = normalize_base_url(base_url);

    if normalized.is_empty() {
        return format!("{DEFAULT_BASE_URL}/systemone");
    }

    if normalized.ends_with("/systemone") {
        return normalized;
    }

    if normalized.ends_with("/v1") {
        return format!("{normalized}/systemone");
    }

    format!("{normalized}/v1/systemone")
}

fn build_headers(api_key: &str) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert("Content-Type", HeaderValue::from_static("application/json"));
    headers.insert("Accept", HeaderValue::from_static("application/json"));

    if let Ok(value) = HeaderValue::from_str(&format!("Bearer {api_key}")) {
        headers.insert("Authorization", value);
    }

    headers
}
