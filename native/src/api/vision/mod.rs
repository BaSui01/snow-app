pub(crate) use base64::Engine;
pub(crate) use std::collections::HashMap;
pub(crate) use std::path::Path;
pub(crate) use std::sync::Arc;

pub(crate) use napi::bindgen_prelude::*;
pub(crate) use napi::threadsafe_function::ThreadsafeFunctionCallMode;
pub(crate) use reqwest::header::{
    HeaderMap, HeaderName, HeaderValue, ACCEPT_ENCODING, AUTHORIZATION, CONTENT_TYPE,
};
pub(crate) use serde_json::{json, Value};
pub(crate) use tokio::sync::RwLock;
pub(crate) use tokio_util::sync::CancellationToken;

pub(crate) use crate::api::config::{normalize_base_url, resolve_sdk_api_base_url};
pub(crate) use crate::api::conversation::{parse_chat_message_content, ChatImage};
pub(crate) use crate::api::responses::{ResponsesApiStreamCallback, ResponsesApiStreamChunk};
pub(crate) use crate::api::retry::{
    log_retry_attempt_best_effort, retry_backoff_ms, should_retry, wait_before_retry, RetryOptions,
};
pub(crate) use crate::storage::services::chat_conversations::ChatContextMessage;
pub(crate) use crate::storage::ApiConfigRecord;

mod file_read;
mod image_parsing;
mod providers;

pub(crate) use file_read::describe_image_file;
pub(crate) use image_parsing::{global_cache, textify_parsed_content};
pub(crate) use providers::{describe_image, vision_cache_key};

/// 视觉文本化的默认提示词前缀，引导视觉模型输出结构化描述。
pub(crate) const DEFAULT_VISION_PROMPT: &str = "Please describe this image in detail. Focus on text content, layout, visual elements, colors, and any notable features. If the image contains code, diagrams, or technical content, describe them precisely. Output in the same language as the user's prompt.";

/// 视觉流式响应的空闲超时（秒）。超过此时长未收到任何数据则视为上游挂起，
/// 中止流并报错——否则 textify 会无限阻塞整个主对话请求。
pub(crate) const VISION_STREAM_IDLE_TIMEOUT_SEC: u64 = 60;

/// 进程内缓存：避免同一张图片在多轮对话中重复调用视觉模型。
/// Key 为图片 base64 数据 + 提示词的 blake3 哈希，Value 为文本化结果。
pub(crate) type VisionCache = Arc<RwLock<HashMap<String, String>>>;

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
        "chat" | "responses" | "anthropic" | "gemini" | "interactions"
    )
}

/// 图片标签前缀：`@@image:<data URL 或 upload 相对路径>@@`。
const IMAGE_TAG_PREFIX: &str = "@@image:";

/// 路径注解块的固定前缀：用于幂等判断，避免同一请求重复注入。
const IMAGE_PATH_ANNOTATION_PREFIX: &str = "[The user attached ";

/// 提取内容中所有 `@@image:...@@` 标签的值（保持出现顺序）。
///
/// base64 字符集不含 `@@`，因此以第一个 `@@` 作为终止符是安全的。
fn image_tag_values(content: &str) -> Vec<&str> {
    let mut values = Vec::new();
    let mut rest = content;
    while let Some(start) = rest.find(IMAGE_TAG_PREFIX) {
        let after_prefix = &rest[start + IMAGE_TAG_PREFIX.len()..];
        let Some(end) = after_prefix.find("@@") else {
            break;
        };
        values.push(after_prefix[..end].trim());
        rest = &after_prefix[end + 2..];
    }
    values
}

/// 给用户消息追加「图片已落盘」的路径注解（仅主模型自带视觉时调用）。
///
/// 视觉主模型收到的是图片二进制，消息文本里没有任何路径；用户要求「基于这张图
/// 编辑」时只能去 `upload` 目录里翻找，而文件名是内容哈希、无法推测。这里把
/// 解析后的绝对路径（统一正斜杠，Windows / macOS 通用）写进请求消息文本，模型
/// 可直接填进 `imagegen-generate` 的 `images[].path`，零搜索。
///
/// 只处理 `role == "user"`：工具结果（截图等）数量多，且不参与图生图引用。
/// 仍是内联 `data:`、尚未落盘的图片没有确定路径，跳过。
fn annotate_attached_image_paths(messages: &mut [ChatContextMessage], database_path: &Path) {
    // 辅助草稿 / 历史改写等临时通道按字面文本处理，不注入注解。
    if crate::api::ephemeral::is_active() {
        return;
    }

    let base_dir = database_path.parent().unwrap_or_else(|| Path::new("."));
    for message in messages.iter_mut() {
        if message.role.trim() != "user" || !message.content.contains(IMAGE_TAG_PREFIX) {
            continue;
        }
        // 同一请求可能被重试路径再次处理，注解只注入一次。
        if message.content.contains(IMAGE_PATH_ANNOTATION_PREFIX) {
            continue;
        }

        let mut seen: Vec<String> = Vec::new();
        let mut entries: Vec<String> = Vec::new();
        for (index, value) in image_tag_values(&message.content).into_iter().enumerate() {
            if value.is_empty() || value.starts_with("data:") || value.contains('{') {
                continue;
            }
            // 统一正斜杠：与 imagegen 的 path 约定一致，跨平台可读。
            let absolute = base_dir.join(value).to_string_lossy().replace('\\', "/");
            if seen.iter().any(|existing| existing == &absolute) {
                continue;
            }
            let media_type = crate::api::conversation::images::media_type_for_upload_path(value)
                .unwrap_or("image/*");
            entries.push(format!("#{} {} ({})", index + 1, absolute, media_type));
            seen.push(absolute);
        }

        if entries.is_empty() {
            continue;
        }
        if !message.content.ends_with('\n') {
            message.content.push('\n');
        }
        message.content.push_str(&format!(
            "[The user attached {} image(s) already saved on disk: {}. When the user asks to edit or generate from one of them, pass that path in imagegen-generate \"images\" as {{\"path\": \"<path>\", \"mimeType\": \"<mimeType>\"}}; no need to search the upload directory.]",
            entries.len(),
            entries.join("; ")
        ));
    }
}

/// 对消息列表中的图片进行视觉文本化。
///
/// `skip_context` 为 true 时直接返回原消息。主模型自带视觉（无需文本化）时
/// 只追加图片落盘路径注解（见 [`annotate_attached_image_paths`]），不调用视觉
/// API；否则遍历每条消息，解析其中的 `@@image:...@@` 标签，对每张图片调用视觉
/// 模型获取文本描述，然后将图片标签替换为文本描述。
///
/// 该函数是异步的，不会阻塞 Node.js 主线程。子代理和主对话共用此入口。
///
/// `custom_headers` 复用主 API 上下文已解析的自定义请求头，避免重复查询数据库。
///
/// `on_chunk` 为主对话的流回调（`None` 时静默跳过事件推送）：文本化每张
/// 图片期间会通过它推送 `vision_status` 进度事件（describing / cached /
/// done / error / cancel），让渲染进程在消息区显示"视觉模型正在分析图片"
/// 的中间状态，并在全部完成、出错或用户取消时清除该状态卡。
///
/// `cancel_token` 为请求级取消令牌（流尚未注册时由 `create_and_register`
/// 生成的已取消令牌）：用户在中途中断时，文本化会在下一张图片前或正在
/// 进行的视觉 HTTP 请求中（`send_vision_stream` 的 `tokio::select!`）立即
/// 停止，并推送一条 `cancel` 事件让渲染进程回收状态卡，而不是继续消耗
/// 视觉 API 调用。`None` 表示不参与取消（如无请求上下文的工具入口）。
pub async fn textify_images_in_messages(
    messages: &mut [ChatContextMessage],
    database_path: &Path,
    api_config: &ApiConfigRecord,
    custom_headers: &HashMap<String, String>,
    skip_context: bool,
    conversation_id: Option<&str>,
    on_chunk: Option<&ResponsesApiStreamCallback>,
    cancel_token: Option<&CancellationToken>,
) -> Result<()> {
    if skip_context {
        return Ok(());
    }

    if !should_textify_images(api_config) {
        // 视觉主模型不会走文本化分支，图片只以二进制形式进入请求；不在这里补上
        // 落盘路径，模型就只能搜索 upload 目录（文件名是内容哈希，猜不到）。
        annotate_attached_image_paths(messages, database_path);
        return Ok(());
    }

    let mut vision_config = VisionApiConfig::from(api_config, custom_headers)?;
    // 与主流程一致：按会话绑定解析用户系统提示词（含项目级提示词）
    vision_config.system_prompts =
        crate::api::conversation::context::resolve_configured_system_prompts(
            &api_config.system_prompt_ids_json,
            conversation_id,
        )
        .await;
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
                                cancel_token,
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
            cancel_token,
        )
        .await?;
        message.content = textified;
    }

    Ok(())
}

pub(crate) struct VisionApiConfig {
    request_method: String,
    base_url: String,
    base_url_mode: String,
    api_key: String,
    /// 已按会话解析的用户系统提示词，与主流程一致（各自成为一个系统块）。
    system_prompts: Vec<String>,
    model: String,
    custom_headers: HashMap<String, String>,
    /// gemini 视觉请求是否注入 google_search 工具（snowcfg.visionGoogleSearch）
    google_search: bool,
    /// 视觉请求是否开启思考（snowcfg.visionThinking.enabled，默认关闭）。
    /// chat / responses 注入 reasoning 字段，gemini 注入 thinkingConfig。
    thinking_enabled: bool,
    /// 思考强度（snowcfg.visionThinking.reasoning_effort，chat / responses 用）。
    thinking_effort: String,
    /// 最大输出 tokens（snowcfg.visionMaxTokens，默认 4096）。
    max_tokens: i64,
    /// 并行描述图片的最大并发数（snowcfg.visionMaxConcurrency，默认 8，夹在 1..=8）。
    max_concurrency: usize,
    /// 视觉请求失败重试配置：复用主 API 档案的 max_retries /
    /// retry_base_delay_ms / partial_retry_max_chars（retry::RetryOptions），
    /// 与主请求共用同一套重试分类与指数退避策略。
    retry_options: RetryOptions,
}

impl VisionApiConfig {
    pub(crate) fn from(
        api_config: &ApiConfigRecord,
        custom_headers: &HashMap<String, String>,
    ) -> Result<Self> {
        let (request_method, base_url, base_url_mode, api_key, model) =
            if api_config.supports_vision {
                (
                    api_config.request_method.trim().to_string(),
                    api_config.base_url.trim().to_string(),
                    api_config.base_url_mode.trim().to_string(),
                    api_config.api_key.trim().to_string(),
                    api_config.advanced_model.trim().to_string(),
                )
            } else {
                (
                    api_config.vision_request_method.trim().to_string(),
                    api_config.vision_base_url.trim().to_string(),
                    api_config.vision_base_url_mode.trim().to_string(),
                    api_config.vision_api_key.trim().to_string(),
                    api_config.vision_model.trim().to_string(),
                )
            };

        if base_url.is_empty() {
            return Err(Error::from_reason(if api_config.supports_vision {
                "API base URL is not configured. Please configure the API settings first."
            } else {
                "Vision base URL is not configured. Please configure the vision API settings first."
            }));
        }

        if model.is_empty() {
            return Err(Error::from_reason(if api_config.supports_vision {
                "Advanced model is not configured. Please select or configure an advanced model in API settings."
            } else {
                "Vision model is not configured. Please configure the vision API settings first."
            }));
        }

        let snowcfg = serde_json::from_str::<Value>(&api_config.config_json)
            .ok()
            .and_then(|parsed| parsed.get("snowcfg").cloned())
            .unwrap_or_else(|| json!({}));

        // 读取 snowcfg.visionGoogleSearch：gemini 视觉（图片模型）联网搜索开关
        let google_search = snowcfg
            .get("visionGoogleSearch")
            .and_then(Value::as_bool)
            .unwrap_or(false);

        // 读取 snowcfg.visionThinking：思考开关 + 思考强度（默认关闭）
        let (thinking_enabled, thinking_effort) = snowcfg
            .get("visionThinking")
            .map(|thinking| {
                let enabled = thinking
                    .get("enabled")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let effort = thinking
                    .get("reasoning_effort")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim()
                    .to_string();
                (enabled, effort)
            })
            .unwrap_or((false, String::new()));

        // 读取 snowcfg.visionMaxTokens：最大输出 tokens（默认 4096，夹在 256..=32768）
        let max_tokens = snowcfg
            .get("visionMaxTokens")
            .and_then(Value::as_i64)
            .unwrap_or(4096)
            .clamp(256, 32768);

        // 读取 snowcfg.visionMaxConcurrency：并行描述图片的最大并发数
        // （默认 8，夹在 1..=8，避免过多并发请求触发上游限流）
        let max_concurrency = snowcfg
            .get("visionMaxConcurrency")
            .and_then(Value::as_i64)
            .unwrap_or(8)
            .clamp(1, 8) as usize;

        // 复用主 API 档案的重试配置：视觉请求失败与主请求共用同一套
        // retry::RetryOptions（max_retries / 退避基数 / partial 阈值）。
        let retry_options = RetryOptions::from_config(
            api_config.max_retries,
            api_config.retry_base_delay_ms,
            api_config.partial_retry_max_chars,
        );

        Ok(Self {
            request_method,
            base_url,
            base_url_mode,
            api_key,
            system_prompts: Vec::new(),
            model,
            custom_headers: custom_headers.clone(),
            google_search,
            thinking_enabled,
            thinking_effort,
            max_tokens,
            max_concurrency,
            retry_options,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user_message(content: &str) -> ChatContextMessage {
        ChatContextMessage {
            role: "user".to_string(),
            content: content.to_string(),
            tool_calls_json: None,
            tool_results_json: None,
            thinking: None,
            thinking_blocks_json: None,
        }
    }

    /// 固定成 `.snowapp/snowapp.db`，便于断言解析出的绝对路径。
    fn database_path() -> &'static Path {
        if cfg!(windows) {
            Path::new("C:/Users/test/.snowapp/snowapp.db")
        } else {
            Path::new("/home/test/.snowapp/snowapp.db")
        }
    }

    #[test]
    fn image_tag_values_keeps_order_and_skips_unterminated_tag() {
        let content = "a@@image:upload/2026-10-23/a.png@@b@@image:data:image/png;base64,QQ==@@@@image:unterminated";
        assert_eq!(
            image_tag_values(content),
            vec!["upload/2026-10-23/a.png", "data:image/png;base64,QQ=="]
        );
    }

    #[test]
    fn annotate_appends_resolved_absolute_path_for_user_images() {
        let mut messages = vec![user_message(
            "把这张图改成夜景 @@image:upload/2026-10-23/abc.png@@",
        )];
        annotate_attached_image_paths(&mut messages, database_path());

        let content = &messages[0].content;
        assert!(content.starts_with("把这张图改成夜景"));
        assert!(content.contains("already saved on disk:"));
        assert!(content.contains("upload/2026-10-23/abc.png (image/png)"));
        assert!(content.contains("imagegen-generate"));
        // 路径统一正斜杠，Windows / macOS 行为一致。
        assert!(!content.contains('\\'));
    }

    #[test]
    fn annotate_skips_inline_data_images_and_non_user_roles() {
        let mut messages = vec![
            user_message("@@image:data:image/png;base64,QQ==@@"),
            ChatContextMessage {
                role: "tool".to_string(),
                ..user_message("@@image:upload/2026-10-23/abc.png@@")
            },
        ];
        annotate_attached_image_paths(&mut messages, database_path());

        assert!(!messages[0].content.contains("already saved on disk:"));
        assert!(!messages[1].content.contains("already saved on disk:"));
    }

    #[test]
    fn annotate_is_idempotent_and_dedupes_repeated_images() {
        let mut messages = vec![user_message(
            "@@image:upload/2026-10-23/abc.png@@@@image:upload/2026-10-23/abc.png@@",
        )];
        annotate_attached_image_paths(&mut messages, database_path());
        annotate_attached_image_paths(&mut messages, database_path());

        let content = &messages[0].content;
        assert_eq!(content.matches("already saved on disk:").count(), 1);
        assert_eq!(content.matches("abc.png (image/png)").count(), 1);
    }
}
