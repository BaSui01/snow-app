use base64::Engine;
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use napi::bindgen_prelude::*;
use napi::threadsafe_function::ThreadsafeFunctionCallMode;
use reqwest::header::{
    HeaderMap, HeaderName, HeaderValue, ACCEPT_ENCODING, AUTHORIZATION, CONTENT_TYPE,
};
use serde_json::{json, Value};
use tokio::sync::RwLock;

use crate::api::config::{normalize_base_url, resolve_sdk_api_base_url};
use crate::api::conversation::images::{parse_chat_message_content, ChatImage};
use crate::api::responses::{ResponsesApiStreamCallback, ResponsesApiStreamChunk};
use crate::storage::services::chat_conversations::ChatContextMessage;
use crate::storage::ApiConfigRecord;

/// 视觉文本化的默认提示词前缀，引导视觉模型输出结构化描述。
const DEFAULT_VISION_PROMPT: &str = "Please describe this image in detail. Focus on text content, layout, visual elements, colors, and any notable features. If the image contains code, diagrams, or technical content, describe them precisely. Output in the same language as the user's prompt.";

/// 进程内缓存：避免同一张图片在多轮对话中重复调用视觉模型。
/// Key 为图片 base64 数据的 blake3 哈希，Value 为文本化结果。
type VisionCache = Arc<RwLock<HashMap<String, String>>>;

fn global_cache() -> &'static VisionCache {
    static CACHE: std::sync::OnceLock<VisionCache> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| Arc::new(RwLock::new(HashMap::new())))
}

/// 判断当前 API 配置是否需要视觉文本化。
///
/// 触发条件：主模型不支持视觉 (`supports_vision == false`) 且
/// 配置了有效的视觉 API（`vision_api_key` 非空、`vision_model` 非空、
/// `vision_request_method` 属于四种支持的类型）。
pub fn should_textify_images(api_config: &ApiConfigRecord) -> bool {
    if api_config.supports_vision {
        return false;
    }

    let api_key = api_config.vision_api_key.trim();
    let model = api_config.vision_model.trim();
    let request_method = api_config.vision_request_method.trim();

    if api_key.is_empty() || model.is_empty() {
        return false;
    }

    matches!(
        request_method,
        "chat" | "responses" | "anthropic" | "gemini"
    )
}

/// 对消息列表中的图片进行视觉文本化。
///
/// 当 `should_textify_images` 返回 false 或 `skip_context` 为 true 时直接返回原消息。
/// 否则遍历每条消息，解析其中的 `@@image:...@@` 标签，对每张图片调用视觉模型
/// 获取文本描述，然后将图片标签替换为文本描述。
///
/// 该函数是异步的，不会阻塞 Node.js 主线程。子代理和主对话共用此入口。
///
/// `custom_headers` 复用主 API 上下文已解析的自定义请求头，避免重复查询数据库。
///
/// `on_chunk` 为主对话的流回调（`None` 时静默跳过事件推送）：文本化每张
/// 图片期间会通过它推送 `vision_status` 进度事件（describing / cached /
/// done / error），让渲染进程在消息区显示"视觉模型正在分析图片"的中间状态。
pub async fn textify_images_in_messages(
    messages: &mut [ChatContextMessage],
    database_path: &Path,
    api_config: &ApiConfigRecord,
    custom_headers: &HashMap<String, String>,
    skip_context: bool,
    on_chunk: Option<&ResponsesApiStreamCallback>,
) -> Result<()> {
    if skip_context || !should_textify_images(api_config) {
        return Ok(());
    }

    let vision_config = VisionApiConfig::from(api_config, custom_headers)?;
    let client = crate::api::http_client::build_proxied_client()
        .await
        .map_err(|error| {
            Error::from_reason(format!("Failed to create vision HTTP client: {error}"))
        })?;

    for message in messages.iter_mut() {
        // 工具结果消息：视觉文本化必须同时作用到 `tool_results_json` 的每个
        // 结构化 result 块。各 provider 构造请求时（chat/payload.rs、
        // responses/payload.rs、anthropic/payload.rs、gemini/payload.rs 的
        // tool 分支）读取的是这里的 result 字符串，而不是 message.content；
        // 若只替换 content，截图 Base64 标签仍会原样进入主模型请求。
        if message.role.trim() == "tool" {
            if let Some(raw) = message.tool_results_json.clone() {
                let results =
                    crate::api::conversation::tool_messages::parse_tool_results_json(&raw);
                let mut updated = Vec::with_capacity(results.len());
                let mut changed = false;
                for (name, call_id, result) in results {
                    if result.contains("@@image:") {
                        let parsed = parse_chat_message_content(&result, database_path)?;
                        if !parsed.images.is_empty() {
                            // 工具结果（如截图）不是用户上传的参考图，不附加引用块。
                            let textified = textify_parsed_content(
                                &parsed,
                                &client,
                                &vision_config,
                                false,
                                on_chunk,
                            )
                            .await?;
                            updated.push((name, call_id, textified));
                            changed = true;
                            continue;
                        }
                    }
                    updated.push((name, call_id, result));
                }
                if changed {
                    // 与 tool_messages::ensure_tool_pairing 的写回格式保持一致：
                    // [{"name": ..., "callId": ..., "result": ...}]
                    let serialized: Vec<Value> = updated
                        .iter()
                        .map(|(name, call_id, result)| {
                            json!({
                                "name": name,
                                "callId": call_id,
                                "result": result,
                            })
                        })
                        .collect();
                    message.tool_results_json = serde_json::to_string(&serialized).ok();
                }
            }
        }

        let content = message.content.clone();
        if !content.contains("@@image:") {
            continue;
        }

        let parsed = parse_chat_message_content(&content, database_path)?;
        if parsed.images.is_empty() {
            continue;
        }

        // 用户消息附带参考图引用块：纯文本主模型无法直接接收图片，但
        // imagegen-generate 支持按 `path`（upload 相对路径）引用图片，
        // 因此文本化时把每张图的引用信息一并给出，模型调用图生图工具时
        // 可直接复制。工具结果消息（截图等）不附加，避免上下文膨胀。
        let textified = textify_parsed_content(
            &parsed,
            &client,
            &vision_config,
            message.role.trim() == "user",
            on_chunk,
        )
        .await?;
        message.content = textified;
    }

    Ok(())
}

/// 通过主对话流回调推送一条视觉文本化进度事件。
///
/// 事件体为 JSON 字符串，`phase` 取值：
/// - `describing`：即将调用外挂视觉 API 描述第 index/total 张图片；
/// - `cached`：命中进程内 blake3 缓存，直接复用已有描述；
/// - `done`：单张图片文本化完成；
/// - `error`：单张图片文本化失败（随后整个请求将失败）。
///
/// 渲染进程据此在消息区显示"视觉模型正在分析图片"的中间状态卡片。
fn emit_vision_status(
    on_chunk: Option<&ResponsesApiStreamCallback>,
    phase: &str,
    index: usize,
    total: usize,
    model: &str,
    error: Option<&str>,
) {
    let Some(on_chunk) = on_chunk else {
        return;
    };
    let mut payload = json!({
        "phase": phase,
        "index": index,
        "total": total,
    });
    if !model.is_empty() {
        payload["model"] = json!(model);
    }
    if let Some(error) = error {
        payload["error"] = json!(error);
    }
    on_chunk.call(
        ResponsesApiStreamChunk {
            content_delta: String::new(),
            thinking_delta: String::new(),
            content: String::new(),
            thinking: String::new(),
            retrying: false,
            retry_attempt: None,
            retry_error: None,
            stream_token_count: 0,
            elapsed_ms: 0,
            ttft_ms: 0,
            vision_status: Some(payload.to_string()),
        },
        ThreadsafeFunctionCallMode::NonBlocking,
    );
}

struct VisionApiConfig {
    request_method: String,
    base_url: String,
    base_url_mode: String,
    api_key: String,
    model: String,
    custom_headers: HashMap<String, String>,
    /// gemini 视觉请求是否注入 google_search 工具（snowcfg.visionGoogleSearch）
    google_search: bool,
}

impl VisionApiConfig {
    fn from(
        api_config: &ApiConfigRecord,
        custom_headers: &HashMap<String, String>,
    ) -> Result<Self> {
        let request_method = api_config.vision_request_method.trim().to_string();
        let base_url = api_config.vision_base_url.trim().to_string();
        let base_url_mode = api_config.vision_base_url_mode.trim().to_string();
        let api_key = api_config.vision_api_key.trim().to_string();
        let model = api_config.vision_model.trim().to_string();

        if base_url.is_empty() {
            return Err(Error::from_reason(
                "Vision base URL is not configured. Please configure the vision API settings first.",
            ));
        }

        // 读取 snowcfg.visionGoogleSearch：gemini 视觉（图片模型）联网搜索开关
        let google_search = serde_json::from_str::<Value>(&api_config.config_json)
            .ok()
            .and_then(|parsed| parsed.get("snowcfg")?.get("visionGoogleSearch")?.as_bool())
            .unwrap_or(false);

        Ok(Self {
            request_method,
            base_url,
            base_url_mode,
            api_key,
            model,
            custom_headers: custom_headers.clone(),
            google_search,
        })
    }
}

/// 文本化一段消息内容：把每张图片替换为视觉模型的文本描述。
///
/// `include_reference_blocks` 为 true 时（用户消息），还会为每张图片附加
/// 一行 `[Reference image #N for imagegen-generate: ...]` 引用块，让纯文本
/// 主模型在需要图生图/编辑时能把图片引用直接填进 imagegen-generate 的
/// `images` 参数。优先使用磁盘相对路径（`path`，几十字节）；仅对未持久化
/// 的内联 data URL 图片回退到完整 base64（`data`）。
async fn textify_parsed_content(
    parsed: &crate::api::conversation::images::ParsedChatMessageContent,
    client: &reqwest::Client,
    vision_config: &VisionApiConfig,
    include_reference_blocks: bool,
    on_chunk: Option<&ResponsesApiStreamCallback>,
) -> Result<String> {
    let mut result = String::with_capacity(parsed.text.len() + parsed.images.len() * 256);
    result.push_str(&parsed.text);

    if include_reference_blocks && !parsed.images.is_empty() {
        if !result.is_empty() && !result.ends_with('\n') {
            result.push('\n');
        }
        result.push_str(&format!(
            "[The user attached {} reference image(s). When the user asks to generate or edit an image based on them, call the imagegen-generate tool and pass the corresponding JSON object(s) below in its \"images\" parameter (image-to-image) — do NOT generate from the text description alone.]",
            parsed.images.len()
        ));
    }

    let total = parsed.images.len();
    for (index, image) in parsed.images.iter().enumerate() {
        // 命中 blake3 内容缓存时直接复用已有描述（describe_image 内部仍会
        // 二次确认，此处预查仅为让进度事件准确区分 cached / describing）。
        let cache_key = blake3::hash(image.data.as_bytes()).to_hex().to_string();
        let cached = global_cache().read().await.contains_key(&cache_key);
        emit_vision_status(
            on_chunk,
            if cached { "cached" } else { "describing" },
            index + 1,
            total,
            &vision_config.model,
            None,
        );

        let description =
            match describe_image(client, vision_config, image, &parsed.text).await {
                Ok(description) => description,
                Err(error) => {
                    // 失败时先推送 error 事件（渲染进程据此清除状态卡），
                    // 再向上传播错误 —— 视觉文本化失败会使整个请求失败，
                    // 与现状行为保持一致。
                    emit_vision_status(
                        on_chunk,
                        "error",
                        index + 1,
                        total,
                        &vision_config.model,
                        Some(&error.to_string()),
                    );
                    return Err(error);
                }
            };
        emit_vision_status(on_chunk, "done", index + 1, total, &vision_config.model, None);
        if !result.is_empty() && !result.ends_with('\n') {
            result.push('\n');
        }
        result.push_str("[Image description: ");
        result.push_str(&description);
        result.push(']');

        if include_reference_blocks {
            result.push('\n');
            result.push_str(&format!(
                "[Reference image #{} for imagegen-generate: {}]",
                index + 1,
                reference_image_json(image)
            ));
        }
    }

    Ok(result.trim().to_string())
}

/// 生成参考图的 JSON 引用对象（可直接作为 imagegen-generate `images` 数组元素）。
///
/// 优先 `path`（磁盘相对路径），上下文占用极小；仅在没有持久化路径时回退
/// 到完整 base64 `data`。
fn reference_image_json(image: &crate::api::conversation::images::ChatImage) -> String {
    match &image.source {
        Some(source) => {
            let normalized = source.replace('\\', "/");
            format!(
                "{{\"path\":\"{}\",\"mimeType\":\"{}\"}}",
                normalized, image.media_type
            )
        }
        None => format!(
            "{{\"data\":\"{}\",\"mimeType\":\"{}\"}}",
            image.data, image.media_type
        ),
    }
}

async fn describe_image(
    client: &reqwest::Client,
    vision_config: &VisionApiConfig,
    image: &ChatImage,
    user_prompt: &str,
) -> Result<String> {
    let cache_key = blake3::hash(image.data.as_bytes()).to_hex().to_string();

    if let Some(cached) = global_cache().read().await.get(&cache_key) {
        return Ok(cached.clone());
    }

    let result = match vision_config.request_method.as_str() {
        "chat" => describe_image_via_chat(client, vision_config, image, user_prompt).await?,
        "responses" => {
            describe_image_via_responses(client, vision_config, image, user_prompt).await?
        }
        "anthropic" => {
            describe_image_via_anthropic(client, vision_config, image, user_prompt).await?
        }
        "gemini" => describe_image_via_gemini(client, vision_config, image, user_prompt).await?,
        method => {
            return Err(Error::from_reason(format!(
                "Unsupported vision request method: {method}. Supported: chat, responses, anthropic, gemini."
            )));
        }
    };

    let trimmed = result.text.trim().to_string();
    if result.partial {
        // 截断重试后仍只拿到部分内容：返回可用文本，但绝不写入缓存，
        // 避免后续对话复用残缺描述（issue #58 的缓存污染风险）。
        eprintln!(
            "Vision image description is partial (truncated after retry); not cached: hash {}...",
            cache_key.chars().take(16).collect::<String>()
        );
        return Ok(trimmed);
    }
    global_cache()
        .write()
        .await
        .insert(cache_key, trimmed.clone());
    Ok(trimmed)
}

fn build_vision_prompt(user_prompt: &str) -> String {
    let user_prompt = user_prompt.trim();
    if user_prompt.is_empty() {
        return DEFAULT_VISION_PROMPT.to_string();
    }
    format!(
        "{DEFAULT_VISION_PROMPT}\n\nUser context (use as additional guidance for what to focus on):\n{user_prompt}"
    )
}

async fn describe_image_via_chat(
    client: &reqwest::Client,
    vision_config: &VisionApiConfig,
    image: &ChatImage,
    user_prompt: &str,
) -> Result<VisionResult> {
    let endpoint = resolve_chat_endpoint(vision_config);
    let prompt = build_vision_prompt(user_prompt);
    let mut payload = json!({
        "model": vision_config.model,
        "messages": [{
            "role": "user",
            "content": [
                { "type": "text", "text": prompt },
                { "type": "image_url", "image_url": { "url": image.data_url } },
            ],
        }],
        "max_tokens": 4096,
        "stream": false,
    });

    let headers = build_bearer_headers(&vision_config.api_key, &vision_config.custom_headers)?;
    vision_request_with_retry(
        client,
        &endpoint,
        headers,
        &mut payload,
        "chat",
        extract_chat_content,
        |payload| {
            payload["max_tokens"] = json!(8192);
        },
    )
    .await
}

async fn describe_image_via_responses(
    client: &reqwest::Client,
    vision_config: &VisionApiConfig,
    image: &ChatImage,
    user_prompt: &str,
) -> Result<VisionResult> {
    let endpoint = resolve_responses_endpoint(vision_config);
    let prompt = build_vision_prompt(user_prompt);
    let mut payload = json!({
        "model": vision_config.model,
        "input": [{
            "type": "message",
            "role": "user",
            "content": [
                { "type": "input_text", "text": prompt },
                { "type": "input_image", "image_url": image.data_url },
            ],
        }],
        "max_output_tokens": 4096,
        "stream": false,
        "store": false,
    });

    let headers = build_bearer_headers(&vision_config.api_key, &vision_config.custom_headers)?;
    vision_request_with_retry(
        client,
        &endpoint,
        headers,
        &mut payload,
        "responses",
        extract_responses_content,
        |payload| {
            payload["max_output_tokens"] = json!(8192);
        },
    )
    .await
}

async fn describe_image_via_anthropic(
    client: &reqwest::Client,
    vision_config: &VisionApiConfig,
    image: &ChatImage,
    user_prompt: &str,
) -> Result<VisionResult> {
    let endpoint = resolve_anthropic_endpoint(vision_config);
    let prompt = build_vision_prompt(user_prompt);
    let mut payload = json!({
        "model": vision_config.model,
        "max_tokens": 4096,
        "messages": [{
            "role": "user",
            "content": [
                { "type": "text", "text": prompt },
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": image.media_type,
                        "data": image.data,
                    },
                },
            ],
        }],
        "stream": false,
    });

    let headers = build_anthropic_headers(&vision_config.api_key, &vision_config.custom_headers)?;
    vision_request_with_retry(
        client,
        &endpoint,
        headers,
        &mut payload,
        "anthropic",
        extract_anthropic_content,
        |payload| {
            payload["max_tokens"] = json!(8192);
        },
    )
    .await
}

async fn describe_image_via_gemini(
    client: &reqwest::Client,
    vision_config: &VisionApiConfig,
    image: &ChatImage,
    user_prompt: &str,
) -> Result<VisionResult> {
    let endpoint = resolve_gemini_endpoint(vision_config, &vision_config.api_key);
    let prompt = build_vision_prompt(user_prompt);
    let mut payload = json!({
        "contents": [{
            "role": "user",
            "parts": [
                { "text": prompt },
                {
                    "inlineData": {
                        "mimeType": image.media_type,
                        "data": image.data,
                    },
                },
            ],
        }],
        "generationConfig": { "maxOutputTokens": 4096 },
    });

    // 谷歌搜索联网（Gemini 原生 grounding）：配置开启时注入 google_search 工具
    if vision_config.google_search {
        payload["tools"] = json!([{ "google_search": {} }]);
    }

    let headers = build_gemini_headers(&vision_config.custom_headers)?;
    vision_request_with_retry(
        client,
        &endpoint,
        headers,
        &mut payload,
        "gemini",
        extract_gemini_content,
        |payload| {
            payload["generationConfig"]["maxOutputTokens"] = json!(8192);
        },
    )
    .await
}

fn resolve_chat_endpoint(vision_config: &VisionApiConfig) -> String {
    let normalized = normalize_base_url(&vision_config.base_url);
    if vision_config.base_url_mode == "endpoint" {
        return normalized;
    }
    format!(
        "{}/chat/completions",
        resolve_sdk_api_base_url(&normalized, &vision_config.base_url_mode)
    )
}

fn resolve_responses_endpoint(vision_config: &VisionApiConfig) -> String {
    let normalized = normalize_base_url(&vision_config.base_url);
    if vision_config.base_url_mode == "endpoint" {
        return normalized;
    }
    format!(
        "{}/responses",
        resolve_sdk_api_base_url(&normalized, &vision_config.base_url_mode)
    )
}

fn resolve_anthropic_endpoint(vision_config: &VisionApiConfig) -> String {
    let normalized = normalize_base_url(&vision_config.base_url);
    if vision_config.base_url_mode == "endpoint" {
        return normalized;
    }
    format!(
        "{}/messages",
        resolve_sdk_api_base_url(&normalized, &vision_config.base_url_mode)
    )
}

fn resolve_gemini_endpoint(vision_config: &VisionApiConfig, api_key: &str) -> String {
    let normalized = normalize_base_url(&vision_config.base_url);
    let resolved_base = if vision_config.base_url_mode == "endpoint" {
        normalized
    } else {
        resolve_sdk_api_base_url(&normalized, &vision_config.base_url_mode)
    };

    let clean_model = vision_config
        .model
        .strip_prefix("models/")
        .unwrap_or(&vision_config.model);

    let mut url = format!("{}/models/{}:generateContent", resolved_base, clean_model);

    if !api_key.is_empty() {
        url.push_str(&format!("?key={}", api_key));
    }
    url
}

fn build_bearer_headers(
    api_key: &str,
    custom_headers: &HashMap<String, String>,
) -> Result<HeaderMap> {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(ACCEPT_ENCODING, HeaderValue::from_static("identity"));
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {}", api_key)).map_err(|error| {
            Error::from_reason(format!(
                "Invalid vision authorization header value: {error}"
            ))
        })?,
    );
    merge_custom_headers(
        &mut headers,
        custom_headers,
        &["content-type", "accept-encoding", "authorization"],
    );
    Ok(headers)
}

fn build_anthropic_headers(
    api_key: &str,
    custom_headers: &HashMap<String, String>,
) -> Result<HeaderMap> {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(ACCEPT_ENCODING, HeaderValue::from_static("identity"));
    headers.insert(
        HeaderName::from_static("x-api-key"),
        HeaderValue::from_str(api_key).map_err(|error| {
            Error::from_reason(format!("Invalid vision API key header value: {error}"))
        })?,
    );
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {}", api_key)).map_err(|error| {
            Error::from_reason(format!(
                "Invalid vision authorization header value: {error}"
            ))
        })?,
    );
    merge_custom_headers(
        &mut headers,
        custom_headers,
        &[
            "content-type",
            "accept-encoding",
            "authorization",
            "x-api-key",
        ],
    );
    Ok(headers)
}

fn build_gemini_headers(custom_headers: &HashMap<String, String>) -> Result<HeaderMap> {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(ACCEPT_ENCODING, HeaderValue::from_static("identity"));
    merge_custom_headers(
        &mut headers,
        custom_headers,
        &["content-type", "accept-encoding"],
    );
    Ok(headers)
}

fn merge_custom_headers(
    headers: &mut HeaderMap,
    custom_headers: &HashMap<String, String>,
    reserved: &[&str],
) {
    for (key, value) in custom_headers {
        let trimmed_key = key.trim();
        let trimmed_value = value.trim();
        if trimmed_key.is_empty() || trimmed_value.is_empty() {
            continue;
        }
        if reserved
            .iter()
            .any(|reserved| trimmed_key.eq_ignore_ascii_case(reserved))
        {
            continue;
        }
        if let (Ok(name), Ok(val)) = (
            trimmed_key.parse::<HeaderName>(),
            HeaderValue::from_str(trimmed_value),
        ) {
            headers.insert(name, val);
        }
    }
}

async fn send_vision_request(
    client: &reqwest::Client,
    endpoint: &str,
    headers: HeaderMap,
    payload: &Value,
) -> Result<Value> {
    let response = client
        .post(endpoint)
        .headers(headers)
        .json(payload)
        .send()
        .await
        .map_err(|error| Error::from_reason(format!("Failed to call vision API: {error}")))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();

    if !status.is_success() {
        // 失败时把请求体一并带出，便于定位问题（例如上游报
        // "Invalid 'image_url' ... invalid base64-encoded value" 时，
        // 可以直接看到实际发出的 data URL 内容）。
        return Err(Error::from_reason(format!(
            "Vision API request failed: {} {}\n--- Request body ---\n{}",
            status,
            body.chars().take(500).collect::<String>(),
            summarize_vision_payload(payload)
        )));
    }

    serde_json::from_str::<Value>(&body).map_err(|error| {
        Error::from_reason(format!(
            "Failed to parse vision API response: {error}. Body: {}",
            body.chars().take(500).collect::<String>()
        ))
    })
}

/// 生成请求体的精简预览，用于失败时定位问题。
///
/// 覆盖四种协议格式：
/// - chat:      `messages[].content[].image_url.url`
/// - responses: `input[].content[].image_url`（字符串形式）
/// - anthropic: `messages[].content[].source.data`
/// - gemini:    `contents[].parts[].inlineData.data`
///
/// 只输出每张图片 URL 的前 300 字符，避免把整张 base64 图片塞进错误信息。
/// 同时避免在错误路径上持有完整 base64 字符串：仅保存 (完整长度, 预览)。
fn summarize_vision_payload(payload: &Value) -> String {
    let mut images: Vec<(usize, String)> = Vec::new();

    // chat / anthropic 共用 messages[].content[]
    if let Some(messages) = payload.get("messages").and_then(|m| m.as_array()) {
        for msg in messages {
            let Some(content) = msg.get("content").and_then(|c| c.as_array()) else {
                continue;
            };
            for block in content {
                if let Some(url) = block.get("image_url") {
                    // chat: { "image_url": { "url": ... } }
                    if let Some(url_str) = url.get("url").and_then(|u| u.as_str()) {
                        let preview: String = url_str.chars().take(300).collect();
                        images.push((url_str.len(), preview));
                    } else if let Some(url_str) = url.as_str() {
                        let preview: String = url_str.chars().take(300).collect();
                        images.push((url_str.len(), preview));
                    }
                }
                // anthropic: { "source": { "media_type": ..., "data": ... } }
                if let Some(source) = block.get("source") {
                    if let Some(data) = source.get("data").and_then(|d| d.as_str()) {
                        let media_type = source
                            .get("media_type")
                            .and_then(|m| m.as_str())
                            .unwrap_or("unknown");
                        let preview: String = data.chars().take(300).collect();
                        images.push((data.len(), format!("data:{media_type};base64,{preview}")));
                    }
                }
            }
        }
    }

    // responses: input[].content[].image_url（字符串）
    if let Some(input) = payload.get("input").and_then(|i| i.as_array()) {
        for item in input {
            let Some(content) = item.get("content").and_then(|c| c.as_array()) else {
                continue;
            };
            for block in content {
                if let Some(url) = block.get("image_url").and_then(|u| u.as_str()) {
                    let preview: String = url.chars().take(300).collect();
                    images.push((url.len(), preview));
                }
            }
        }
    }

    // gemini: contents[].parts[].inlineData
    if let Some(contents) = payload.get("contents").and_then(|c| c.as_array()) {
        for item in contents {
            let Some(parts) = item.get("parts").and_then(|p| p.as_array()) else {
                continue;
            };
            for part in parts {
                if let Some(inline) = part.get("inlineData") {
                    if let Some(data) = inline.get("data").and_then(|d| d.as_str()) {
                        let mime_type = inline
                            .get("mimeType")
                            .and_then(|m| m.as_str())
                            .unwrap_or("unknown");
                        let preview: String = data.chars().take(300).collect();
                        images.push((data.len(), format!("data:{mime_type};base64,{preview}")));
                    }
                }
            }
        }
    }

    if images.is_empty() {
        return format!(
            "payload_size={} bytes, image_url fields not found in payload",
            payload.to_string().len()
        );
    }

    let mut summary = format!(
        "payload_size={} bytes, {} image(s)",
        payload.to_string().len(),
        images.len()
    );
    for (i, (full_len, preview)) in images.iter().enumerate() {
        summary.push_str(&format!(
            "\nimage[{i}] url_len={full_len} preview={preview:?}"
        ));
    }
    summary
}

/// 一次协议响应的解析结果。
struct VisionExtract {
    /// 提取到的文本；无文本（null / 空）时为 None。
    text: Option<String>,
    /// 是否因输出 token 预算耗尽被截断
    /// （chat `finish_reason=length` / responses `status=incomplete` /
    /// anthropic `stop_reason=max_tokens` / gemini `finishReason=MAX_TOKENS`）。
    truncated: bool,
}

/// 视觉调用的最终可用结果。
struct VisionResult {
    text: String,
    /// true 表示输出被截断、只拿到部分内容（不写入缓存）。
    partial: bool,
}

/// 发送视觉请求并解析；响应标记为截断时自动重试一次（max_tokens 翻倍）。
///
/// - 首次截断（无论是否带部分内容）→ 重试一次，`bump_max_tokens` 负责把
///   请求体中的 token 上限翻倍（各协议字段路径不同）。
/// - 重试后仍截断：有部分内容 → 返回部分内容（`partial = true`）；
///   无内容 → 报可读错误。
/// - 非截断但无内容 → 报可读错误（区分截断与非截断原因）。
///
/// 这是 issue #58 的核心修复：带 reasoning 的模型思考内容占满预算时，
/// 响应为 `finish_reason=length` + `content=null`，旧代码直接抛裸错误。
async fn vision_request_with_retry(
    client: &reqwest::Client,
    endpoint: &str,
    headers: HeaderMap,
    payload: &mut Value,
    protocol: &str,
    extract: impl Fn(&Value) -> Result<VisionExtract>,
    bump_max_tokens: impl Fn(&mut Value),
) -> Result<VisionResult> {
    let mut attempt = 0u32;
    loop {
        attempt += 1;
        let response = send_vision_request(client, endpoint, headers.clone(), payload).await?;
        let extracted = extract(&response)?;

        let Some(text) = extracted.text else {
            if extracted.truncated && attempt == 1 {
                eprintln!(
                    "Vision {protocol} response truncated (no content), retrying with doubled max_tokens (attempt {attempt})"
                );
                bump_max_tokens(payload);
                continue;
            }
            return Err(Error::from_reason(format!(
                "Vision {protocol} API returned empty content (truncated={}): {}",
                extracted.truncated,
                serde_json::to_string(&response)
                    .unwrap_or_default()
                    .chars()
                    .take(300)
                    .collect::<String>()
            )));
        };

        if extracted.truncated {
            if attempt == 1 {
                eprintln!(
                    "Vision {protocol} response truncated (partial content, {} chars), retrying with doubled max_tokens (attempt {attempt})",
                    text.chars().count()
                );
                bump_max_tokens(payload);
                continue;
            }
            eprintln!(
                "Vision {protocol} response still truncated after retry; using partial content ({} chars, not cached)",
                text.chars().count()
            );
            return Ok(VisionResult { text, partial: true });
        }

        return Ok(VisionResult { text, partial: false });
    }
}

fn extract_chat_content(response: &Value) -> Result<VisionExtract> {
    let choice = response
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first());
    let truncated = choice
        .and_then(|choice| choice.get("finish_reason"))
        .and_then(Value::as_str)
        .is_some_and(|reason| reason == "length");
    let text = choice
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string);
    Ok(VisionExtract { text, truncated })
}

fn extract_responses_content(response: &Value) -> Result<VisionExtract> {
    let mut truncated = response
        .get("status")
        .and_then(Value::as_str)
        .is_some_and(|status| status == "incomplete");

    let mut text = response
        .get("output_text")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string);

    if text.is_none() {
        let mut chunks = Vec::new();
        collect_responses_output_text(response.get("output"), &mut chunks);
        text = Some(chunks.join("\n").trim().to_string()).filter(|text| !text.is_empty());

        // 无 message 文本但 output 中存在 reasoning 项：思考内容占满预算，
        // 同样视为截断（reasoning 项可能已随输出返回，但正式回答尚未生成）。
        if !truncated {
            truncated = response
                .get("output")
                .and_then(Value::as_array)
                .is_some_and(|output| {
                    output.iter().any(|item| {
                        item.get("type")
                            .and_then(Value::as_str)
                            .is_some_and(|kind| kind == "reasoning")
                    })
                });
        }
    }

    Ok(VisionExtract { text, truncated })
}

fn collect_responses_output_text(value: Option<&Value>, chunks: &mut Vec<String>) {
    let Some(value) = value else {
        return;
    };
    match value {
        Value::Array(items) => {
            for item in items {
                collect_responses_output_text(Some(item), chunks);
            }
        }
        Value::Object(object) => {
            for key in ["text", "output_text", "value"] {
                if let Some(text) = object
                    .get(key)
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    chunks.push(text.to_string());
                    return;
                }
            }
            collect_responses_output_text(object.get("content"), chunks);
        }
        _ => {}
    }
}

fn extract_anthropic_content(response: &Value) -> Result<VisionExtract> {
    let truncated = response
        .get("stop_reason")
        .and_then(Value::as_str)
        .is_some_and(|reason| reason == "max_tokens");
    let mut chunks = Vec::new();
    if let Some(content) = response.get("content").and_then(Value::as_array) {
        for block in content {
            if block
                .get("type")
                .and_then(Value::as_str)
                .is_some_and(|value| value == "text")
            {
                if let Some(text) = block.get("text").and_then(Value::as_str) {
                    chunks.push(text.to_string());
                }
            }
        }
    }

    let text = chunks.join("\n").trim().to_string();
    let text = if text.is_empty() { None } else { Some(text) };
    Ok(VisionExtract { text, truncated })
}

fn extract_gemini_content(response: &Value) -> Result<VisionExtract> {
    let candidate = response
        .get("candidates")
        .and_then(Value::as_array)
        .and_then(|candidates| candidates.first());
    let truncated = candidate
        .and_then(|candidate| candidate.get("finishReason"))
        .and_then(Value::as_str)
        .is_some_and(|reason| reason == "MAX_TOKENS");
    let mut chunks = Vec::new();
    if let Some(parts) = candidate
        .and_then(|candidate| candidate.get("content"))
        .and_then(|content| content.get("parts"))
        .and_then(Value::as_array)
    {
        for part in parts {
            if let Some(text) = part.get("text").and_then(Value::as_str) {
                chunks.push(text.to_string());
            }
        }
    }

    let text = chunks.join("\n").trim().to_string();
    let text = if text.is_empty() { None } else { Some(text) };
    Ok(VisionExtract { text, truncated })
}

/// 读取磁盘上的图片并用视觉模型分析（`image-describe` 工具入口）。
///
/// 路径校验：
/// - 绝对路径：直接读取（用户本地任意目录的图片，如项目中的 UI 设计稿）；
/// - 相对路径：必须位于 `upload/` 目录内（相对数据库文件所在目录），拒绝穿越。
///
/// 限制：单张 20MB 上限；仅接受图片扩展名。视觉配置复用主 API 配置的
/// vision 通道（chat / responses / anthropic / gemini），结果走
/// [`describe_image`] 的 blake3 内容缓存。
pub(crate) async fn describe_image_file(path: &str, user_prompt: &str) -> Result<String> {
    use std::fs;

    let trimmed = path.trim().replace('\\', "/");
    if trimmed.is_empty() {
        return Err(Error::from_reason(
            "Image path must not be empty".to_string(),
        ));
    }

    // 1. 解析磁盘路径
    let file_path = if std::path::Path::new(&trimmed).is_absolute() {
        std::path::PathBuf::from(&trimmed)
    } else {
        if !trimmed.starts_with("upload/") || trimmed.contains("..") {
            return Err(Error::from_reason(format!(
                "Invalid image path: \"{path}\". Use an absolute file path (e.g. C:/path/to/design.png) or a relative path under the conversation's upload/ directory."
            )));
        }
        let storage_info = crate::storage::initialize_app_storage()?;
        let database_path = std::path::PathBuf::from(storage_info.database_path);
        database_path
            .parent()
            .unwrap_or_else(|| std::path::Path::new("."))
            .join(&trimmed)
    };

    // 2. 大小与类型校验
    const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;
    let metadata = fs::metadata(&file_path).map_err(|error| {
        Error::from_reason(format!("Cannot read image file \"{path}\": {error}"))
    })?;
    if metadata.len() > MAX_IMAGE_BYTES {
        return Err(Error::from_reason(format!(
            "Image file \"{path}\" exceeds the {}MB size limit",
            MAX_IMAGE_BYTES / 1024 / 1024
        )));
    }
    let bytes = fs::read(&file_path).map_err(|error| {
        Error::from_reason(format!("Cannot read image file \"{path}\": {error}"))
    })?;
    let mime_type = guess_image_mime(&file_path);
    if !mime_type.starts_with("image/") {
        return Err(Error::from_reason(format!(
            "File \"{path}\" is not a supported image (detected {mime_type})"
        )));
    }

    // 3. 复用视觉管线（配置 + 客户端 + 缓存）
    let context = crate::api::config::get_active_api_request_context()?;
    let vision_config = VisionApiConfig::from(&context.api_config, &context.custom_headers)?;
    let client = crate::api::http_client::build_proxied_client()
        .await
        .map_err(|error| {
            Error::from_reason(format!("Failed to create vision HTTP client: {error}"))
        })?;

    let image = crate::api::conversation::images::ChatImage {
        media_type: mime_type.clone(),
        data: base64::engine::general_purpose::STANDARD.encode(&bytes),
        data_url: String::new(),
        source: None,
    };
    describe_image(&client, &vision_config, &image, user_prompt).await
}

/// 按扩展名猜测图片 MIME；不支持的类型返回 `application/octet-stream`。
fn guess_image_mime(path: &std::path::Path) -> String {
    let Some(ext) = path.extension().and_then(|e| e.to_str()) else {
        return "application/octet-stream".to_string();
    };
    match ext.to_ascii_lowercase().as_str() {
        "png" => "image/png".to_string(),
        "jpg" | "jpeg" => "image/jpeg".to_string(),
        "webp" => "image/webp".to_string(),
        "gif" => "image/gif".to_string(),
        "bmp" => "image/bmp".to_string(),
        "svg" => "image/svg+xml".to_string(),
        _ => "application/octet-stream".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::{extract_anthropic_content, extract_chat_content, extract_gemini_content, extract_responses_content};
    use serde_json::json;

    /// issue #58 原始场景：reasoning 模型思考内容占满预算，
    /// content=null + finish_reason=length → 标记为截断且无内容。
    #[test]
    fn chat_truncated_null_content_detected() {
        let response = json!({
            "choices": [{
                "finish_reason": "length",
                "index": 0,
                "message": {
                    "content": null,
                    "reasoning_content": "……（很长的思考过程）",
                },
            }],
        });

        let extracted = extract_chat_content(&response).unwrap();
        assert!(extracted.truncated);
        assert!(extracted.text.is_none());
    }

    #[test]
    fn chat_normal_content_not_truncated() {
        let response = json!({
            "choices": [{
                "finish_reason": "stop",
                "index": 0,
                "message": { "content": "这是一张登录页截图。" },
            }],
        });

        let extracted = extract_chat_content(&response).unwrap();
        assert!(!extracted.truncated);
        assert_eq!(extracted.text.as_deref(), Some("这是一张登录页截图。"));
    }

    /// content 非空但 finish_reason=length：同样应标记为截断，
    /// 避免静默接受残缺描述（旧代码的缓存污染场景）。
    #[test]
    fn chat_partial_content_with_length_flagged() {
        let response = json!({
            "choices": [{
                "finish_reason": "length",
                "index": 0,
                "message": { "content": "图片中包含登录表单，" },
            }],
        });

        let extracted = extract_chat_content(&response).unwrap();
        assert!(extracted.truncated);
        assert!(extracted.text.is_some());
    }

    #[test]
    fn responses_incomplete_status_detected() {
        let response = json!({
            "status": "incomplete",
            "output": [{
                "type": "reasoning",
                "summary": [{ "type": "summary_text", "text": "思考中……" }],
            }],
        });

        let extracted = extract_responses_content(&response).unwrap();
        assert!(extracted.truncated);
        assert!(extracted.text.is_none());
    }

    /// status 未标记 incomplete，但 output 只有 reasoning 项、无 message 文本：
    /// 同样视为截断（reasoning 占满输出预算）。
    #[test]
    fn responses_reasoning_only_detected() {
        let response = json!({
            "status": "completed",
            "output": [{
                "type": "reasoning",
                "summary": [{ "type": "summary_text", "text": "思考中……" }],
            }],
        });

        let extracted = extract_responses_content(&response).unwrap();
        assert!(extracted.truncated);
        assert!(extracted.text.is_none());
    }

    #[test]
    fn responses_normal_message_not_truncated() {
        let response = json!({
            "status": "completed",
            "output": [
                { "type": "message", "role": "assistant", "content": [{ "type": "output_text", "text": "正常描述" }] },
            ],
        });

        let extracted = extract_responses_content(&response).unwrap();
        assert!(!extracted.truncated);
        assert_eq!(extracted.text.as_deref(), Some("正常描述"));
    }

    #[test]
    fn anthropic_max_tokens_stop_reason_detected() {
        let response = json!({
            "stop_reason": "max_tokens",
            "content": [{ "type": "text", "text": "" }],
        });

        let extracted = extract_anthropic_content(&response).unwrap();
        assert!(extracted.truncated);
        assert!(extracted.text.is_none());
    }

    #[test]
    fn gemini_max_tokens_finish_reason_detected() {
        let response = json!({
            "candidates": [{
                "finishReason": "MAX_TOKENS",
                "content": { "parts": [{ "text": "" }] },
            }],
        });

        let extracted = extract_gemini_content(&response).unwrap();
        assert!(extracted.truncated);
        assert!(extracted.text.is_none());
    }

    #[test]
    fn gemini_normal_content_not_truncated() {
        let response = json!({
            "candidates": [{
                "finishReason": "STOP",
                "content": { "parts": [{ "text": "正常描述" }] },
            }],
        });

        let extracted = extract_gemini_content(&response).unwrap();
        assert!(!extracted.truncated);
        assert_eq!(extracted.text.as_deref(), Some("正常描述"));
    }
}
