use std::time::Duration;

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine};
use napi::bindgen_prelude::*;
use napi::threadsafe_function::ThreadsafeFunction;
use napi_derive::napi;
use regex::Regex;
use reqwest::{Client, Url};
use serde_json::{json, Value};

use super::super::service::McpService;
use super::super::tools::McpTool;

const SERVER_ID: &str = "websearch";
const PROXY_BROWSER_SETTING_CODE: &str = "proxy_browser_settings";
const REQUEST_TIMEOUT_SECS: u64 = 30;
const DEFAULT_MAX_CONTENT_LENGTH: usize = 50_000;
const MIN_MAX_CONTENT_LENGTH: usize = 1_000;
const MAX_MAX_CONTENT_LENGTH: usize = 100_000;
const MAX_IMAGE_BYTES: usize = 20 * 1024 * 1024;
const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/// 转发给 Electron 主进程执行的 Web 搜索命令。
#[napi(object)]
pub struct WebSearchCommand {
    pub operation: String,
    pub args_json: String,
}

pub type WebSearchCommandCallback =
    ThreadsafeFunction<WebSearchCommand, Promise<String>, WebSearchCommand, Status, false>;

pub struct WebSearchService;

impl WebSearchService {
    pub fn new() -> Self {
        WebSearchService
    }

    /// 通过异步执行器执行搜索工具：把命令转发给 Electron 主进程，
    /// 由主进程的 puppeteer 服务驱动真实浏览器搜索（可绕过 JS 反爬）。
    pub async fn execute_async(
        &self,
        tool_name: &str,
        args: &Value,
        on_command: &WebSearchCommandCallback,
    ) -> napi::Result<Value> {
        let command = WebSearchCommand {
            operation: tool_name.to_string(),
            args_json: serde_json::to_string(args).map_err(|error| {
                Error::new(
                    Status::GenericFailure,
                    format!("Failed to serialize web search command: {error}"),
                )
            })?,
        };

        let promise = on_command
            .call_async_catch(command)
            .await
            .map_err(|error| {
                Error::new(
                    Status::GenericFailure,
                    format!("Failed to dispatch web search command to Electron: {error}"),
                )
            })?;
        let result_json = promise.await.map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("Web search command failed: {error}"),
            )
        })?;

        serde_json::from_str(&result_json).map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("Web search command returned invalid JSON: {error}"),
            )
        })
    }

    pub async fn execute_fetch(&self, args: &Value) -> napi::Result<Value> {
        let url = required_string(args, "url", "websearch-websearch-fetch")?;
        validate_web_url(url)?;

        // 站点屏蔽规则：命中用户配置的正则时直接拒绝抓取。
        let blocked_patterns = load_blocked_patterns().await;
        if let Some(pattern) = blocked_patterns.iter().find(|pattern| {
            Regex::new(pattern)
                .map(|regex| regex.is_match(url))
                .unwrap_or(false)
        }) {
            return Err(generic_error(format!(
                "URL blocked by user rule (matched regex: {pattern})"
            )));
        }

        let max_length = bounded_usize(
            args.get("maxLength").and_then(Value::as_u64),
            DEFAULT_MAX_CONTENT_LENGTH,
            MIN_MAX_CONTENT_LENGTH,
            MAX_MAX_CONTENT_LENGTH,
        );
        let proxy_config = crate::api::http_client::load_proxy_config().await?;
        let client = build_http_client(&proxy_config)?;
        let response = client
            .get(url)
            .send()
            .await
            .map_err(|error| generic_error(format!("Failed to fetch page: {error}")))?;
        let status = response.status();
        if !status.is_success() {
            return Err(generic_error(format!(
                "Failed to fetch page: {} {}",
                status.as_u16(),
                status.canonical_reason().unwrap_or("Unknown status")
            )));
        }

        let final_url = response.url().to_string();
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_ascii_lowercase();

        if is_image_response(url, &content_type) {
            let mime_type = image_mime_type(url, &content_type)
                .ok_or_else(|| generic_error("Unable to determine image MIME type".to_string()))?;
            let bytes = response.bytes().await.map_err(|error| {
                generic_error(format!("Failed to read image response: {error}"))
            })?;
            if bytes.len() > MAX_IMAGE_BYTES {
                return Err(generic_error(format!(
                    "Image is too large to return ({}, maximum {} bytes)",
                    bytes.len(),
                    MAX_IMAGE_BYTES
                )));
            }

            let text = format!("Image URL fetched successfully: {final_url} ({mime_type})");
            return Ok(json!({
                "url": final_url,
                "title": "Image",
                "content": [
                    { "type": "text", "text": text },
                    {
                        "type": "image",
                        "data": BASE64_STANDARD.encode(bytes),
                        "mimeType": mime_type,
                    }
                ],
                "textLength": text.len(),
                "contentPreview": text,
            }));
        }

        let html = response
            .text()
            .await
            .map_err(|error| generic_error(format!("Failed to read page content: {error}")))?;
        let title = extract_title(&html);
        let content = extract_page_text(&html, max_length);
        let content_preview = truncate_text(&content, 500);

        Ok(json!({
            "url": final_url,
            "title": title,
            "content": content,
            "textLength": content.len(),
            "contentPreview": content_preview,
        }))
    }
}

impl McpService for WebSearchService {
    fn id(&self) -> &str {
        SERVER_ID
    }

    fn tools(&self) -> Vec<McpTool> {
        vec![
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "websearch-search".to_string(),
                description: "Search the web using the configured search engine (DuckDuckGo or Bing). Returns a list of search results with titles, URLs, and snippets. Best for finding current information, documentation, news, or general web content. IMPORTANT WORKFLOW: After getting search results, analyze them and choose ONLY ONE most credible and relevant page to fetch. Do NOT fetch multiple pages - reading one high-quality source is sufficient and more efficient.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "Search query string (e.g., \"Claude latest model\", \"TypeScript best practices\")"
                        },
                        "maxResults": {
                            "type": "number",
                            "description": "Maximum number of results to return (default: 10, max: 20)",
                            "default": 10,
                            "minimum": 1,
                            "maximum": 20
                        }
                    },
                    "required": ["query"]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "websearch-fetch".to_string(),
                description: "Fetch and read the full content of a web page or a direct image URL. For HTML pages, automatically cleans and extracts main text content. For direct image URLs (detected by image content-type or image file extension), downloads the image and returns a base64 image block for the model to inspect. RENDERING TIP: When the fetched result contains valid image information (a direct image URL or image data), present it to the user using Markdown image syntax, e.g. ![description](https://example.com/image.png), so the image is rendered inline. USAGE RULE: Only fetch ONE page per search - choose the most credible and relevant result (prefer official documentation, reputable tech sites, or well-known sources).".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "url": {
                            "type": "string",
                            "description": "Full URL of the web page or direct image to fetch (e.g., \"https://example.com/article\" or \"https://example.com/image.png\")"
                        },
                        "maxLength": {
                            "type": "number",
                            "description": "Maximum content length in characters for HTML pages (default: 50000, max: 100000). Ignored for direct image URLs.",
                            "default": 50000,
                            "minimum": 1000,
                            "maximum": 100000
                        },
                        "isUserProvided": {
                            "type": "boolean",
                            "description": "Whether the URL is directly provided by the user. This value is accepted for Snow CLI compatibility.",
                            "default": false
                        },
                        "enableAiSummary": {
                            "type": "boolean",
                            "description": "Reserved for Snow CLI compatibility. The Rust backend returns cleaned source content directly.",
                            "default": false
                        },
                        "userQuery": {
                            "type": "string",
                            "description": "Original user query. Reserved for Snow CLI compatibility."
                        }
                    },
                    "required": ["url"]
                }),
            },
        ]
    }

    fn execute(&self, tool_name: &str, _args: &Value) -> napi::Result<Value> {
        match tool_name {
            "websearch-search" => Err(generic_error(
                "The WebSearch tool must be executed through the asynchronous executor"
                    .to_string(),
            )),
            "websearch-fetch" => Err(generic_error(
                "The WebSearch tool must be executed through the asynchronous executor"
                    .to_string(),
            )),
            _ => Err(generic_error(format!(
                "Unknown tool: \"{tool_name}\" for MCP server \"websearch\". Available tools: [websearch-websearch-search, websearch-websearch-fetch]"
            ))),
        }
    }
}

/// 从数据库异步加载站点屏蔽正则列表。
///
/// 使用 `spawn_blocking` 读取数据库，不会阻塞 Node.js 主线程；
/// 与 `crate::api::http_client::load_proxy_config` 使用相同的存储路径。
async fn load_blocked_patterns() -> Vec<String> {
    tokio::task::spawn_blocking(|| {
        let storage_info = crate::storage::initialize_app_storage().ok()?;
        let database_path = std::path::PathBuf::from(storage_info.database_path);

        let raw = crate::storage::services::system_settings::get_system_setting_value(
            &database_path,
            PROXY_BROWSER_SETTING_CODE,
        )
        .ok()?
        .unwrap_or_default();

        Some(parse_blocked_patterns(&raw))
    })
    .await
    .unwrap_or_default()
    .unwrap_or_default()
}

/// 解析 `proxy_browser_settings` JSON 中的 `blockedPatterns` 字段。
fn parse_blocked_patterns(raw: &str) -> Vec<String> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) else {
        return Vec::new();
    };

    value
        .get("blockedPatterns")
        .and_then(serde_json::Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|pattern| !pattern.is_empty())
                .map(ToOwned::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

/// 构建带代理和超时设置的 HTTP 客户端。
///
/// 代理设置由 `ProxyConfig` 提供统一逻辑：启用时走 `http://127.0.0.1:{port}`，
/// 未启用时由 reqwest 默认跟随系统代理环境变量。
fn build_http_client(proxy_config: &crate::api::http_client::ProxyConfig) -> napi::Result<Client> {
    let builder = Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS));

    let builder = proxy_config.clone().apply(builder)?;

    builder
        .build()
        .map_err(|error| generic_error(format!("Failed to create HTTP client: {error}")))
}

fn extract_title(html: &str) -> String {
    let title_regex =
        Regex::new(r"(?is)<title[^>]*>(.*?)</title>").expect("title regex must compile");
    title_regex
        .captures(html)
        .and_then(|capture| capture.get(1))
        .map(|value| clean_html_text(value.as_str()))
        .unwrap_or_default()
}

fn extract_page_text(html: &str, max_length: usize) -> String {
    let mut document = html.to_string();
    for pattern in [
        r"(?is)<script[^>]*>.*?</script>",
        r"(?is)<style[^>]*>.*?</style>",
        r"(?is)<noscript[^>]*>.*?</noscript>",
        r"(?is)<svg[^>]*>.*?</svg>",
        r"(?is)<nav[^>]*>.*?</nav>",
        r"(?is)<footer[^>]*>.*?</footer>",
        r"(?is)<iframe[^>]*>.*?</iframe>",
    ] {
        let regex = Regex::new(pattern).expect("HTML cleanup regex must compile");

        document = regex.replace_all(&document, " ").into_owned();
    }

    let text = clean_html_text(&document);
    if text.chars().count() <= max_length {
        return text;
    }

    format!(
        "{}\n\n[Content truncated...]",
        truncate_text(&text, max_length)
    )
}

fn clean_html_text(value: &str) -> String {
    let tag_regex = Regex::new(r"(?is)<[^>]+>").expect("HTML tag regex must compile");
    let without_tags = tag_regex.replace_all(value, " ");
    normalize_whitespace(&decode_html_entities(&without_tags))
}

fn decode_html_entities(value: &str) -> String {
    value
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&nbsp;", " ")
}

fn normalize_whitespace(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn truncate_text(value: &str, max_length: usize) -> String {
    let mut truncated = value.chars().take(max_length).collect::<String>();
    if value.chars().count() > max_length {
        truncated.push_str("...");
    }
    truncated
}

fn image_mime_type(url: &str, content_type: &str) -> Option<String> {
    let normalized_content_type = content_type.split(';').next().unwrap_or("").trim();
    if normalized_content_type.starts_with("image/") {
        return Some(normalized_content_type.to_string());
    }

    let path = Url::parse(url).ok()?.path().to_ascii_lowercase();
    let mime_type = if path.ends_with(".png") {
        "image/png"
    } else if path.ends_with(".jpg") || path.ends_with(".jpeg") {
        "image/jpeg"
    } else if path.ends_with(".gif") {
        "image/gif"
    } else if path.ends_with(".webp") {
        "image/webp"
    } else if path.ends_with(".bmp") {
        "image/bmp"
    } else if path.ends_with(".svg") {
        "image/svg+xml"
    } else {
        return None;
    };
    Some(mime_type.to_string())
}

fn is_image_response(url: &str, content_type: &str) -> bool {
    content_type.starts_with("image/") || image_mime_type(url, "").is_some()
}

fn required_string<'a>(args: &'a Value, key: &str, tool_name: &str) -> napi::Result<&'a str> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            Error::new(
                Status::InvalidArg,
                format!("{key} is required for tool \"{tool_name}\""),
            )
        })
}

fn bounded_usize(value: Option<u64>, default: usize, min: usize, max: usize) -> usize {
    value
        .map(|value| value as usize)
        .unwrap_or(default)
        .clamp(min, max)
}

fn validate_web_url(url: &str) -> napi::Result<()> {
    if !is_http_url(url) {
        return Err(Error::new(
            Status::InvalidArg,
            "url must be a valid HTTP or HTTPS URL".to_string(),
        ));
    }
    Ok(())
}

fn is_http_url(url: &str) -> bool {
    Url::parse(url)
        .map(|parsed| matches!(parsed.scheme(), "http" | "https"))
        .unwrap_or(false)
}

fn generic_error(message: String) -> Error {
    Error::new(Status::GenericFailure, message)
}
