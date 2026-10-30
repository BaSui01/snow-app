//! 决策模型客户端（TypeSafe System One / OpenAI Decisions）。
//!
//! 决策模型不生成文本，只对给定 state 逐条回答 choice 问题：代码库审查用它判定
//! 每条结果是否相关，敏感命令辅助用它判定命令能否直接执行并给出理由分类。
//!
//! 两种 provider 共用同一条链路：构建 state 与问题 -> 按 provider 生成请求体 ->
//! 把两种响应折叠成 `answers: { <name>: { choice, confidence } }` -> 同一段解释代码。
//! 任何传输或协议失败都返回错误，由调用方决定回退，本模块不做静默降级。
//!
//! 全部异步执行，不阻塞 Node.js 主线程。

use std::path::Path;
use std::time::Duration;

use napi::bindgen_prelude::*;
use reqwest::header::{HeaderMap, HeaderValue};
use serde_json::{json, Map, Value};

use crate::api::config::normalize_base_url;
use crate::api::model_health::{
    observe_call, post_json, ModelCallReport, ModelKind, ModelRequestError, CONNECTION_TEST_FUNC,
};
use crate::storage::services::codebase_index::SearchResult;
use crate::storage::services::system_settings::get_system_setting_value;
use crate::storage::SensitiveCommandMatchResult;

/// TypeSafe System One 官方端点（Base URL 留空时的回落值）。
const DEFAULT_TYPESAFE_BASE_URL: &str = "https://api.typesafe.ai/v1";

/// OpenAI Decisions 官方端点（Base URL 留空时的回落值）。
const DEFAULT_OPENAI_BASE_URL: &str = "https://api.openai.com/v1";

const CUSTOM_BASE_URL_MODE: &str = "custom";
const AUTO_BASE_URL_MODE: &str = "auto";

/// system_settings 里决策模型配置的 setting_code（与前端 decisionModels.ts 一致）。
pub const DECISION_MODELS_SETTING_CODE: &str = "decision_models";

/// 单次请求最多转换的结果数。
const MAX_QUESTIONS: usize = 40;

/// 每条结果摘录的最大字符数。
const MAX_EXCERPT_CHARS: usize = 800;

/// state 总字符预算（query + 全部摘录）。按 32k token 的 state 预算估算，留足余量。
const MAX_STATE_CHARS: usize = 40_000;

/// 请求超时：决策模型通常几十毫秒返回，短上限避免卡住搜索。
const REQUEST_TIMEOUT_SECS: u64 = 30;

/// 模型判定相关的选项值。
const RELEVANT_OPTION: &str = "relevant";
const ALLOW_OPTION: &str = "allow";
const DENY_OPTION: &str = "deny";

/// 敏感命令请求的问题 id；答案按同名的 name 返回。
const VERDICT_QUESTION_ID: &str = "verdict";
const REASON_QUESTION_ID: &str = "reason";

/// 答案缺失或选项未知时回退的理由分类。
const REASON_UNKNOWN: &str = "unclear";

/// 理由分类的稳定 key，前端负责本地化（`sensitiveCommand.decision.reason.<key>`）。
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

/// 决策模型协议类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DecisionProvider {
    Typesafe,
    Openai,
}

impl DecisionProvider {
    pub fn as_str(self) -> &'static str {
        match self {
            DecisionProvider::Typesafe => "typesafe",
            DecisionProvider::Openai => "openai",
        }
    }

    /// 未知值按 typesafe 处理：存量配置没有 provider 字段。
    #[allow(clippy::should_implement_trait)]
    pub fn from_str(value: &str) -> Self {
        match value.trim() {
            "openai" => DecisionProvider::Openai,
            _ => DecisionProvider::Typesafe,
        }
    }

    fn default_base_url(self) -> &'static str {
        match self {
            DecisionProvider::Typesafe => DEFAULT_TYPESAFE_BASE_URL,
            DecisionProvider::Openai => DEFAULT_OPENAI_BASE_URL,
        }
    }
}

/// 一次请求所需的配置；provider 决定端点、请求体与响应解析。
#[derive(Debug, Clone)]
pub struct DecisionModelConfig {
    pub base_url: String,
    pub base_url_mode: String,
    pub api_key: String,
    pub model: String,
    pub provider: DecisionProvider,
}

/// 一个决策模型配置项（system_settings 的 `decision_models`，camelCase 与前端一致）。
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct DecisionModel {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub base_url_mode: String,
    pub api_key: String,
    pub model: String,
    pub enabled: bool,
    /// "typesafe" | "openai"；存量条目没有该字段，缺省为 typesafe。
    #[serde(default = "default_provider")]
    pub provider: String,
}

fn default_provider() -> String {
    DecisionProvider::Typesafe.as_str().to_string()
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

impl DecisionModelConfig {
    /// 由原始配置字段构造请求配置。
    ///
    /// 配置不完整（API Key / 模型名为空，自定义模式下请求地址为空）时返回原因，
    /// 供调用方展示「决策模型不可用」而不再静默跳过。
    pub fn new(
        base_url: &str,
        base_url_mode: &str,
        api_key: &str,
        model: &str,
        provider: DecisionProvider,
    ) -> std::result::Result<Self, String> {
        let api_key = api_key.trim();
        let model = model.trim();

        if api_key.is_empty() {
            return Err("The decision model API key is empty".to_string());
        }
        if model.is_empty() {
            return Err("The decision model name is empty".to_string());
        }

        let base_url_mode = normalize_base_url_mode(base_url_mode);
        let base_url = resolve_base_url(base_url, &base_url_mode, provider);

        if base_url.is_empty() {
            return Err("The decision model request URL is empty".to_string());
        }

        Ok(Self {
            base_url,
            base_url_mode,
            api_key: api_key.to_string(),
            model: model.to_string(),
            provider,
        })
    }

    /// 当前 provider 的完整请求端点。
    pub fn endpoint(&self) -> String {
        resolve_provider_endpoint(&self.base_url, &self.base_url_mode, self.provider)
    }
}

/// 选中的决策模型能否使用。
pub enum DecisionModelResolution {
    /// 没有选择决策模型（使用方按「未启用」处理）。
    NotSelected,
    /// 选择了决策模型，但它已被删除、停用或请求信息不完整。
    Unavailable { name: String, reason: String },
    /// 可以发起请求。
    Ready {
        name: String,
        config: DecisionModelConfig,
    },
}

/// 按 id 解析选中的决策模型，并说明不可用的原因（供使用方展示回退原因）。
pub fn resolve_decision_model(models: &[DecisionModel], model_id: &str) -> DecisionModelResolution {
    let model_id = model_id.trim();
    if model_id.is_empty() {
        return DecisionModelResolution::NotSelected;
    }

    let Some(selected) = models.iter().find(|item| item.id == model_id) else {
        return DecisionModelResolution::Unavailable {
            name: model_id.to_string(),
            reason: "The selected decision model no longer exists".to_string(),
        };
    };

    let name = if selected.name.trim().is_empty() {
        selected.model.trim().to_string()
    } else {
        selected.name.trim().to_string()
    };

    if !selected.enabled {
        return DecisionModelResolution::Unavailable {
            name,
            reason: "The selected decision model is disabled".to_string(),
        };
    }

    match DecisionModelConfig::new(
        &selected.base_url,
        &selected.base_url_mode,
        &selected.api_key,
        &selected.model,
        DecisionProvider::from_str(&selected.provider),
    ) {
        Ok(config) => DecisionModelResolution::Ready { name, config },
        Err(reason) => DecisionModelResolution::Unavailable { name, reason },
    }
}

/// 按配置字段解析请求端点（连接自检在配置不完整时也要能展示端点）。
pub fn resolve_endpoint(
    base_url: &str,
    base_url_mode: &str,
    provider: DecisionProvider,
) -> String {
    let base_url_mode = normalize_base_url_mode(base_url_mode);
    let base_url = resolve_base_url(base_url, &base_url_mode, provider);
    resolve_provider_endpoint(&base_url, &base_url_mode, provider)
}

fn resolve_provider_endpoint(
    base_url: &str,
    base_url_mode: &str,
    provider: DecisionProvider,
) -> String {
    match provider {
        DecisionProvider::Typesafe => resolve_systemone_endpoint(base_url, base_url_mode),
        DecisionProvider::Openai => resolve_decisions_endpoint(base_url),
    }
}

fn normalize_base_url_mode(base_url_mode: &str) -> String {
    if base_url_mode.trim() == CUSTOM_BASE_URL_MODE {
        CUSTOM_BASE_URL_MODE.to_string()
    } else {
        AUTO_BASE_URL_MODE.to_string()
    }
}

/// 规范化后的 Base URL；自动模式下留空回落到该 provider 的官方地址。
fn resolve_base_url(
    base_url: &str,
    base_url_mode: &str,
    provider: DecisionProvider,
) -> String {
    let normalized = normalize_base_url(base_url);

    if base_url_mode == CUSTOM_BASE_URL_MODE {
        return normalized;
    }

    if normalized.is_empty() {
        provider.default_base_url().to_string()
    } else {
        normalized
    }
}

/// 询问决策模型：哪些搜索结果与 query 相关。
///
/// 每条结果变成一个 `relevant` / `irrelevant` 的 choice 问题，由模型自己的答案决定，
/// 不引入用户可调阈值。超出 state 预算或问题上限的结果、以及答案缺失的结果都按
/// 相关保留，审查始终保守。
pub async fn evaluate_relevance(
    config: &DecisionModelConfig,
    query: &str,
    results: &[SearchResult],
) -> Result<Vec<usize>> {
    if results.is_empty() {
        return Ok(Vec::new());
    }

    let (state, asked) = build_state(query, results);

    // 没有任何结果进入预算：全部按相关返回，避免只拿空列表去问模型。
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
    let questions = Value::Object(questions);

    let parsed = evaluate_state(
        config,
        "evaluate_relevance",
        &state,
        &questions,
        |parsed| Ok(parsed),
    )
    .await
    .into_result()?;

    let answers = parsed.get("answers").and_then(Value::as_object);

    let mut asked_indices: Vec<usize> = Vec::with_capacity(asked.len());
    let mut relevant: Vec<usize> = Vec::with_capacity(results.len());

    for (index, id) in &asked {
        let verdict = answers
            .and_then(|map| map.get(id))
            .and_then(|answer| answer.get("choice"))
            .and_then(Value::as_str);

        // 模型判定决定去留；答案缺失时保留该结果，审查不丢弃未判定的内容。
        if verdict.is_none() || verdict == Some(RELEVANT_OPTION) {
            relevant.push(*index);
        }
        asked_indices.push(*index);
    }

    // 未进入问题列表（问题上限 / state 预算）的结果同样保留。
    for index in 0..results.len() {
        if !asked_indices.contains(&index) {
            relevant.push(index);
        }
    }

    relevant.sort_unstable();
    Ok(relevant)
}

/// 决策模型对一条命中敏感规则命令的判定。
pub struct CommandDecision {
    /// 是否可以直接执行，无需用户确认。
    pub allow: bool,
    /// 理由分类 key（`REASON_CATEGORIES` 之一），前端本地化。
    pub reason: String,
    /// 模型对判定的置信度（0-1）。
    pub confidence: f64,
}

/// 一条命令的判定上下文：命令文本、模型写的说明与实际执行目录。
pub struct CommandContext<'a> {
    /// 完整命令文本。
    pub command: &'a str,
    /// 模型为命令写的一行说明（`bash-terminal-execute` 的 `description`）。
    pub description: &'a str,
    /// 命令的实际执行目录。
    pub working_directory: &'a str,
    /// 命中的敏感规则（模式 + 说明），只作为「被规则命中」的证据。
    pub matched_rules: &'a [SensitiveCommandMatchResult],
}

/// 询问决策模型：命中敏感规则的命令能否直接执行，以及理由分类。
///
/// verdict 是模型在真实执行上下文下给出的 `allow` / `deny`；规则命中只是提示。
/// 第二个问题从固定理由分类中选一个，调用方据此用用户语言解释判定。
/// 两个答案来自同一次请求；verdict 缺失按错误处理，调用方保持人工确认。
pub async fn evaluate_command(
    config: &DecisionModelConfig,
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
    let state = Value::Object(state);
    let provider = config.provider;

    evaluate_state(
        config,
        "evaluate_command",
        &state,
        &questions,
        move |parsed| {
            let answers = parsed.get("answers").and_then(Value::as_object);
            let verdict_answer = answers.and_then(|map| map.get(VERDICT_QUESTION_ID));
            let verdict = verdict_answer
                .and_then(|answer| answer.get("choice"))
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    format!(
                        "The {} decision model did not answer the sensitive command verdict",
                        provider.as_str()
                    )
                })?;

            // 未知或缺失的理由分类降级为 unclear：判定仍有效，只是解释不够具体。
            let reason = answers
                .and_then(|map| map.get(REASON_QUESTION_ID))
                .and_then(|answer| answer.get("choice"))
                .and_then(Value::as_str)
                .filter(|choice| REASON_CATEGORIES.iter().any(|(key, _)| key == choice))
                .unwrap_or(REASON_UNKNOWN)
                .to_string();

            Ok(CommandDecision {
                // 只有明确的 allow 才放行，其它情况都保留确认提示。
                allow: verdict == ALLOW_OPTION,
                reason,
                confidence: verdict_answer
                    .and_then(|answer| answer.get("confidence"))
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0)
                    .clamp(0.0, 1.0),
            })
        },
    )
    .await
    .into_result()
}

/// 发送一次判定请求，并把两种 provider 的响应折叠后交给 `interpret`。
///
/// 传输失败、HTTP 状态、响应格式错误与 `interpret` 拒绝的答案都写入返回的报告
/// （同时进系统日志，module = `decision_model`），调用方据此决定回退。
async fn evaluate_state<T, I>(
    config: &DecisionModelConfig,
    func: &str,
    state: &Value,
    questions: &Value,
    interpret: I,
) -> ModelCallReport<T>
where
    I: FnOnce(Value) -> std::result::Result<T, String>,
{
    let endpoint = config.endpoint();
    let endpoint_ref = endpoint.as_str();
    let body = build_request_body(config, state, questions);
    let provider = config.provider;

    observe_call(
        ModelKind::Decision,
        func,
        endpoint_ref,
        &config.model,
        async move {
            let (status, text) = post_json(
                ModelKind::Decision,
                endpoint_ref,
                build_headers(&config.api_key),
                &body,
                Duration::from_secs(REQUEST_TIMEOUT_SECS),
            )
            .await
            .map_err(|error| {
                ModelRequestError::new(
                    error.http_status,
                    format!("{} (provider: {})", error.message, provider.as_str()),
                )
            })?;

            let parsed: Value = serde_json::from_str(&text).map_err(|error| {
                ModelRequestError::new(
                    Some(status),
                    format!(
                        "Failed to parse the {} decision model response: {error}",
                        provider.as_str()
                    ),
                )
            })?;

            let answers = normalize_answers(provider, &parsed)
                .map_err(|message| ModelRequestError::new(Some(status), message))?;
            let normalized = json!({ "answers": answers });

            let value = interpret(normalized)
                .map_err(|message| ModelRequestError::new(Some(status), message))?;
            Ok((value, status))
        },
    )
    .await
}

/// 连接自检：发一条最小请求，响应必须带答案。
///
/// typesafe 要求 `answers` 是对象；openai 要求 `answers` 是非空数组。
pub async fn test_connection(config: &DecisionModelConfig) -> ModelCallReport<()> {
    let state = json!({ "purpose": "Snow App connection test" });
    let questions = json!({
        "probe": {
            "type": "choice",
            "instructions": "Is this request a connection test?",
            "criteria": {
                "yes": "The state says it is a connection test",
                "no": "The state describes something else"
            }
        },
    });
    let provider = config.provider;

    evaluate_state(
        config,
        CONNECTION_TEST_FUNC,
        &state,
        &questions,
        move |parsed| {
            let answers = parsed.get("answers").and_then(Value::as_object);
            match provider {
                DecisionProvider::Typesafe => {
                    if answers.is_some() {
                        Ok(())
                    } else {
                        Err(format!(
                            "The {} decision model response is missing the 'answers' object",
                            provider.as_str()
                        ))
                    }
                }
                DecisionProvider::Openai => {
                    if answers.map(|map| !map.is_empty()).unwrap_or(false) {
                        Ok(())
                    } else {
                        Err(format!(
                            "The {} decision model returned no answers",
                            provider.as_str()
                        ))
                    }
                }
            }
        },
    )
    .await
}

/// 按 provider 生成请求体。
///
/// 问题在内部统一保存为「id -> { type, instructions, criteria }」，openai 侧把
/// criteria 1:1 映射成 `choices`，state 放进 `input` 的 input_json 内容块。
fn build_request_body(
    config: &DecisionModelConfig,
    state: &Value,
    questions: &Value,
) -> Value {
    match config.provider {
        DecisionProvider::Typesafe => json!({
            "state": state,
            "model": config.model,
            "questions": questions,
        }),
        DecisionProvider::Openai => json!({
            "model": config.model,
            "input": [{
                "role": "user",
                "content": [{
                    "type": "input_json",
                    "data": state,
                }],
            }],
            "questions": choice_questions(questions),
        }),
    }
}

/// 把内部的问题对象转换为 OpenAI Decisions 的 questions 数组。
fn choice_questions(questions: &Value) -> Value {
    let Some(map) = questions.as_object() else {
        return Value::Array(Vec::new());
    };

    Value::Array(
        map.iter()
            .map(|(name, question)| {
                let instructions = question
                    .get("instructions")
                    .cloned()
                    .unwrap_or(Value::Null);
                let choices = question
                    .get("criteria")
                    .and_then(Value::as_object)
                    .map(|criteria| {
                        criteria
                            .iter()
                            .map(|(value, description)| {
                                json!({ "value": value, "description": description })
                            })
                            .collect::<Vec<Value>>()
                    })
                    .unwrap_or_default();

                json!({
                    "type": "choice",
                    "name": name,
                    "instructions": instructions,
                    "choices": choices,
                })
            })
            .collect(),
    )
}

/// 把两种响应折叠成 `name -> { choice, confidence }`。
///
/// typesafe 的 answers 是对象；openai 的 answers 是数组，按 name 折叠。
/// refusal 答案按错误返回，绝不当作 allow。
fn normalize_answers(
    provider: DecisionProvider,
    parsed: &Value,
) -> std::result::Result<Map<String, Value>, String> {
    let answers = parsed.get("answers").ok_or_else(|| {
        format!(
            "The {} decision model response is missing the 'answers' field",
            provider.as_str()
        )
    })?;

    match provider {
        DecisionProvider::Typesafe => answers.as_object().cloned().ok_or_else(|| {
            format!(
                "The {} decision model response is missing the 'answers' object",
                provider.as_str()
            )
        }),
        DecisionProvider::Openai => {
            let items = answers.as_array().ok_or_else(|| {
                format!(
                    "The {} decision model response is missing the 'answers' array",
                    provider.as_str()
                )
            })?;

            let mut normalized = Map::new();
            for item in items {
                let name = item
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .trim();
                if name.is_empty() {
                    return Err(format!(
                        "The {} decision model returned an answer without a name",
                        provider.as_str()
                    ));
                }
                if item.get("type").and_then(Value::as_str) == Some("refusal") {
                    return Err(format!("Decision refused for {name}"));
                }
                normalized.insert(
                    name.to_string(),
                    json!({
                        "choice": item.get("choice").cloned().unwrap_or(Value::Null),
                        "confidence": item.get("confidence").cloned().unwrap_or(Value::Null),
                    }),
                );
            }
            Ok(normalized)
        }
    }
}

/// 构建 state 与进入问题列表的 `(结果下标, 问题 id)`。
fn build_state(query: &str, results: &[SearchResult]) -> (Value, Vec<(usize, String)>) {
    let mut items: Vec<Value> = Vec::new();
    let mut asked: Vec<(usize, String)> = Vec::new();
    let mut used_chars = query.chars().count();

    for (index, result) in results.iter().enumerate() {
        if asked.len() >= MAX_QUESTIONS {
            break;
        }

        let excerpt: String = result.content.chars().take(MAX_EXCERPT_CHARS).collect();
        // 路径、行号、id 与 JSON 键也占预算，用一个常量近似。
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

fn resolve_systemone_endpoint(base_url: &str, base_url_mode: &str) -> String {
    let normalized = normalize_base_url(base_url);

    if base_url_mode == CUSTOM_BASE_URL_MODE {
        return normalized;
    }

    if normalized.is_empty() {
        return format!("{DEFAULT_TYPESAFE_BASE_URL}/systemone");
    }

    if normalized.ends_with("/systemone") {
        return normalized;
    }

    if normalized.ends_with("/v1") {
        return format!("{normalized}/systemone");
    }

    format!("{normalized}/v1/systemone")
}

/// OpenAI Decisions 端点：尊重用户已填的完整地址，只补齐缺失的 /decisions。
fn resolve_decisions_endpoint(base_url: &str) -> String {
    let normalized = normalize_base_url(base_url);

    if normalized.is_empty() {
        return format!("{DEFAULT_OPENAI_BASE_URL}/decisions");
    }

    if normalized.ends_with("/decisions") {
        return normalized;
    }

    if normalized.ends_with("/v1") {
        return format!("{normalized}/decisions");
    }

    format!("{normalized}/v1/decisions")
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
