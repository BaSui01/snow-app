//! 手机远控 HTTP 服务：局域网与公网两个监听器共用同一套请求处理。
//!
//! 原先整套服务由 Node 主进程的 remoteControlServer.ts 承担（node:http、
//! 手写路由与鉴权）。迁移到 Rust 后，TCP 监听、HTTP 解析、鉴权、静态资源、
//! 附件落盘与图片解析全部在原生侧完成；只有需要桌面 UI 实时状态的操作
//! 通过 bridge 派发给 Node → 渲染进程。

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, RwLock};
use std::time::Duration;

use axum::body::Body;
use axum::extract::State;
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, Method, Request, Response, StatusCode};
use axum::Router;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use serde_json::{json, Value};
use url::Url;

use super::assets::{self, MOBILE_ASSET_PATH_PREFIX};
use super::attachments::{self, AttachError, AttachmentKind, RemoteAttachmentContext};
use super::auth::{secret_matches, WanAuth};
use super::bridge::{self, BridgeError};
use super::unauthorized;

/// 请求体上限（JSON 接口）。
const MAX_BODY_BYTES: usize = 64 * 1024;
/// 局域网令牌 Cookie 与请求头名称。
const COOKIE_NAME: &str = "snowRemoteToken";
/// 公网会话 Cookie 名称。
const WAN_COOKIE_NAME: &str = "snowRemoteSession";
const TOKEN_HEADER: &str = "x-snow-remote-token";
/// 会话图片允许的最大字节数（与手机端上传通道一致）。
const MAX_MESSAGE_IMAGE_BYTES: usize = 10 * 1024 * 1024;
/// 消息图片支持的 MIME 白名单。
const MESSAGE_IMAGE_TYPES: [&str; 4] = ["image/png", "image/jpeg", "image/gif", "image/webp"];
/// 标识符类字段（模型 id / Profile 名 / 指令 id / 思考强度）的长度上限。
const MAX_IDENTIFIER_LENGTH: usize = 200;
/// 待办内容长度上限（与 Renderer 桥、移动端输入框 maxlength 保持一致）。
const MAX_TODO_CONTENT_LENGTH: usize = 500;
/// WorkFlow 反馈内容长度上限（与 Renderer 桥、移动端输入框 maxlength 保持一致）。
const MAX_WORKFLOW_REPLY_LENGTH: usize = 2_000;
/// 可远程切换的代理行为模式白名单（必须与 renderer/types/remoteControl.ts 一致）。
const REMOTE_MODES: [&str; 6] = ["plan", "goal", "worktree", "workflow", "yolo", "lite"];
/// 已完成 send 请求的去重缓存容量。
const COMPLETED_SEND_CAPACITY: usize = 200;
/// 等待 send 派发空窗的上限（轮换凭据 / 停止服务时使用）。
const SEND_IDLE_TIMEOUT: Duration = Duration::from_secs(5);
/// 单次 send 请求内最多携带的附件数（与附件存储一致）。
const MAX_SEND_ATTACHMENTS: usize = 4;

/// percent-encode 集合：与 JS 的 encodeURIComponent 保留字符一致。
const URI_COMPONENT_SET: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'!')
    .remove(b'~')
    .remove(b'*')
    .remove(b'\'')
    .remove(b'(')
    .remove(b')');

/// 监听器策略：局域网（长期令牌）或公网（配对会话）。
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum ServerPolicy {
    Lan,
    Wan,
}

/// 单个监听器的共享上下文。
pub struct ServerContext {
    pub policy: ServerPolicy,
    pub mobile_dir: PathBuf,
    pub icon_bytes: Option<Arc<Vec<u8>>>,
    /// 局域网令牌（轮换时原地替换）。
    pub lan_token: Option<Arc<RwLock<String>>>,
    /// 公网入口认证；配对状态查询会就地续期配对码。
    pub wan_auth: Option<Arc<WanAuth>>,
    /// 配对代数：令牌轮换 / 服务重启后自增，旧请求据此拒绝。
    pub generation: Arc<AtomicU64>,
}

impl ServerContext {
    fn is_wan(&self) -> bool {
        self.policy == ServerPolicy::Wan
    }

    fn current_token(&self) -> String {
        self.lan_token
            .as_ref()
            .map(|token| {
                token
                    .read()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .clone()
            })
            .unwrap_or_default()
    }

    fn generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }
}

/// 统一的接口错误：状态码 + 中文文案（JSON `{ error }` 契约与旧实现一致）。
pub struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }

    fn bad_request(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, message)
    }

    fn conflict(message: impl Into<String>) -> Self {
        Self::new(StatusCode::CONFLICT, message)
    }

    fn service_unavailable() -> Self {
        Self::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "Snow 暂时无法处理该请求",
        )
    }

    fn into_response(self) -> Response<Body> {
        json_response(self.status, &json!({ "error": self.message }), Vec::new())
    }
}

/// send 派发并发计数：轮换凭据 / 停止服务前需要等待在途发送结束。
mod send_tracker {
    use super::*;
    use tokio::sync::oneshot;

    struct Tracker {
        active: usize,
        waiters: Vec<oneshot::Sender<()>>,
    }

    static TRACKER: OnceLock<Mutex<Tracker>> = OnceLock::new();

    fn tracker() -> &'static Mutex<Tracker> {
        TRACKER.get_or_init(|| {
            Mutex::new(Tracker {
                active: 0,
                waiters: Vec::new(),
            })
        })
    }

    fn lock() -> MutexGuard<'static, Tracker> {
        tracker()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// 进入一次远程变更操作。
    pub fn acquire() {
        lock().active += 1;
    }

    /// 结束一次远程变更操作；最后一个离开者唤醒全部等待者。
    pub fn release() {
        let mut guard = lock();
        guard.active = guard.active.saturating_sub(1);
        if guard.active == 0 {
            for waiter in guard.waiters.drain(..) {
                let _ = waiter.send(());
            }
        }
    }

    /// 等待所有远程变更操作结束（超时兜底，避免永久阻塞）。
    pub async fn wait_idle(timeout: Duration) {
        let receiver = {
            let mut guard = lock();
            if guard.active == 0 {
                return;
            }
            let (sender, receiver) = oneshot::channel();
            guard.waiters.push(sender);
            receiver
        };
        let _ = tokio::time::timeout(timeout, receiver).await;
    }
}

/// 已完成 send 请求的幂等缓存（requestId → 结果）。
static COMPLETED_SENDS: OnceLock<Mutex<VecDeque<(String, u64, Value)>>> = OnceLock::new();

fn completed_sends() -> &'static Mutex<VecDeque<(String, u64, Value)>> {
    COMPLETED_SENDS.get_or_init(|| Mutex::new(VecDeque::new()))
}

fn completed_send_result(request_id: &str, generation: u64) -> Option<Value> {
    let queue = completed_sends()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    queue
        .iter()
        .rev()
        .find(|(id, recorded, _)| id == request_id && *recorded == generation)
        .map(|(_, _, value)| value.clone())
}

fn store_completed_send(request_id: String, generation: u64, result: Value) {
    let mut queue = completed_sends()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    queue.retain(|(id, _, _)| id != &request_id);
    queue.push_back((request_id, generation, result));
    while queue.len() > COMPLETED_SEND_CAPACITY {
        queue.pop_front();
    }
}

/// 清空 send 幂等缓存（轮换凭据 / 停止服务时调用）。
pub fn clear_completed_sends() {
    completed_sends()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clear();
}

/// 构建远控 HTTP 应用（两个监听器共用同一套路由）。
pub fn router(context: Arc<ServerContext>) -> Router {
    Router::new().fallback(handle).with_state(context)
}

async fn handle(State(context): State<Arc<ServerContext>>, request: Request<Body>) -> Response<Body> {
    match process(&context, request).await {
        Ok(response) => response,
        Err(error) => error.into_response(),
    }
}

// ─── 响应构造 ──────────────────────────────────────────────────────────────

fn build_response(
    status: StatusCode,
    content_type: &str,
    body: Vec<u8>,
    extra: Vec<(&'static str, String)>,
) -> Response<Body> {
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(content_type).unwrap_or_else(|_| HeaderValue::from_static("text/plain; charset=utf-8")),
    );
    headers.insert(
        header::CONTENT_LENGTH,
        HeaderValue::from_str(&body.len().to_string())
            .unwrap_or_else(|_| HeaderValue::from_static("0")),
    );
    for (name, value) in extra {
        if let (Ok(name), Ok(value)) = (
            HeaderName::from_bytes(name.as_bytes()),
            HeaderValue::from_str(&value),
        ) {
            headers.insert(name, value);
        }
    }
    Response::builder()
        .status(status)
        .body(Body::from(body))
        .map(|mut response| {
            *response.headers_mut() = headers;
            response
        })
        .unwrap_or_else(|_| Response::new(Body::empty()))
}

fn json_response(
    status: StatusCode,
    value: &Value,
    extra: Vec<(&'static str, String)>,
) -> Response<Body> {
    let body = serde_json::to_vec(value).unwrap_or_else(|_| b"{}".to_vec());
    let mut headers = vec![
        ("Cache-Control", "no-store".to_string()),
        ("X-Content-Type-Options", "nosniff".to_string()),
        ("Referrer-Policy", "no-referrer".to_string()),
    ];
    headers.extend(extra);
    build_response(status, "application/json; charset=utf-8", body, headers)
}

/// 移动页 HTML：无内联脚本权限（脚本 / 样式均为同源独立资源）。
const MOBILE_PAGE_CSP: &str = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data: blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
/// 引导页 HTML：无脚本、无外部资源。
const UNAUTHORIZED_PAGE_CSP: &str = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

fn html_response(
    status: StatusCode,
    html: String,
    extra: Vec<(&'static str, String)>,
    bodyless: bool,
) -> Response<Body> {
    let body = html.into_bytes();
    let content_length = body.len();
    let mut headers = vec![
        ("Cache-Control", "no-store".to_string()),
        ("X-Content-Type-Options", "nosniff".to_string()),
        ("X-Frame-Options", "DENY".to_string()),
        ("Referrer-Policy", "no-referrer".to_string()),
    ];
    headers.extend(extra);
    let mut response = build_response(
        status,
        "text/html; charset=utf-8",
        if bodyless { Vec::new() } else { body },
        headers,
    );
    if bodyless {
        // HEAD 只回响应头：Content-Length 保留完整 HTML 长度，但不带正文。
        if let Ok(value) = HeaderValue::from_str(&content_length.to_string()) {
            response.headers_mut().insert(header::CONTENT_LENGTH, value);
        }
    }
    response
}

// ─── 请求解析辅助 ──────────────────────────────────────────────────────────

fn parse_url(uri: &str) -> Option<Url> {
    Url::parse(&format!("http://localhost{}", uri)).ok()
}

fn header_text(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
}

/// 解析 Cookie 头（decodeURIComponent 语义，失败时忽略该项）。
fn parse_cookies(header: Option<&str>) -> Vec<(String, String)> {
    let mut cookies = Vec::new();
    for part in header.unwrap_or_default().split(';') {
        let Some(separator) = part.find('=') else {
            continue;
        };
        if separator == 0 {
            continue;
        }
        let name = part[..separator].trim().to_string();
        let raw = part[separator + 1..].trim();
        let value = percent_encoding::percent_decode_str(raw)
            .decode_utf8()
            .map(|decoded| decoded.into_owned())
            .unwrap_or_else(|_| raw.to_string());
        cookies.push((name, value));
    }
    cookies
}

fn cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    let raw = header_text(headers, "cookie");
    parse_cookies(raw.as_deref())
        .into_iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value)
}

fn is_json_request(headers: &HeaderMap) -> bool {
    header_text(headers, "content-type")
        .map(|value| value.to_ascii_lowercase().starts_with("application/json"))
        .unwrap_or(false)
}

/// GET/HEAD 且声明接受 HTML：典型的浏览器导航（区别于页面内 fetch 与 API 客户端）。
fn is_browser_navigation(method: &Method, headers: &HeaderMap) -> bool {
    (*method == Method::GET || *method == Method::HEAD)
        && header_text(headers, "accept")
            .map(|value| value.contains("text/html"))
            .unwrap_or(false)
}

fn is_bounded_string(value: &str, allow_empty: bool) -> bool {
    value.chars().count() <= MAX_IDENTIFIER_LENGTH && (allow_empty || !value.trim().is_empty())
}

fn is_todo_content(value: &str) -> bool {
    !value.trim().is_empty() && value.chars().count() <= MAX_TODO_CONTENT_LENGTH
}

fn is_todo_status(value: &str) -> bool {
    matches!(value, "pending" | "inProgress" | "completed")
}

fn is_workflow_reply(value: &str) -> bool {
    !value.trim().is_empty() && value.chars().count() <= MAX_WORKFLOW_REPLY_LENGTH
}

fn is_remote_mode(value: &str) -> bool {
    REMOTE_MODES.contains(&value)
}

fn truncate_chars(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}

async fn read_json_body(body: Option<Body>) -> Result<Value, ApiError> {
    let body = body.unwrap_or_else(Body::empty);
    let bytes = axum::body::to_bytes(body, MAX_BODY_BYTES)
        .await
        .map_err(|_| ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "请求体超过 64 KiB"))?;
    if bytes.is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| ApiError::new(StatusCode::BAD_REQUEST, "JSON 格式无效"))
}

fn ensure_current_pairing(context: &ServerContext, snapshot: u64) -> Result<(), ApiError> {
    if snapshot != context.generation() {
        return Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "配对凭据已轮换，请重新配对",
        ));
    }
    Ok(())
}

fn api_error_from_bridge(error: BridgeError) -> ApiError {
    match error {
        BridgeError::NotReady => ApiError::conflict("远程控制桥尚未就绪"),
        BridgeError::Renderer(message) => {
            let reason = truncate_chars(message.trim(), MAX_IDENTIFIER_LENGTH);
            ApiError::conflict(if reason.is_empty() {
                "Snow 暂时无法处理该请求".to_string()
            } else {
                reason
            })
        }
        BridgeError::Dispatch => ApiError::service_unavailable(),
    }
}

async fn bridge_call(action: &str, args: Value) -> Result<Value, ApiError> {
    bridge::call(action, args)
        .await
        .map_err(api_error_from_bridge)
}

fn api_error_from_attach(error: AttachError) -> ApiError {
    match error {
        AttachError::Code(code) => match code {
            attachments::ERR_INVALID_KIND => ApiError::new(StatusCode::BAD_REQUEST, "附件类型无效"),
            attachments::ERR_INVALID_MIME => {
                ApiError::new(StatusCode::UNSUPPORTED_MEDIA_TYPE, "附件 Content-Type 无效")
            }
            attachments::ERR_UNSUPPORTED_IMAGE_TYPE => ApiError::new(
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                "仅支持 PNG、JPEG、GIF 和 WebP 图片",
            ),
            attachments::ERR_TOO_MANY_ATTACHMENTS => {
                ApiError::new(StatusCode::BAD_REQUEST, "每次最多选择 4 个附件")
            }
            attachments::ERR_ATTACHMENT_TOO_LARGE => {
                ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "附件超过大小或总容量限制")
            }
            attachments::ERR_EMPTY_ATTACHMENT => {
                ApiError::new(StatusCode::BAD_REQUEST, "附件不能为空")
            }
            attachments::ERR_IMAGE_SIGNATURE_MISMATCH => {
                ApiError::new(StatusCode::BAD_REQUEST, "图片内容与格式不匹配")
            }
            attachments::ERR_IMAGE_DIMENSIONS_INVALID => {
                ApiError::new(StatusCode::BAD_REQUEST, "无法读取图片尺寸")
            }
            attachments::ERR_IMAGE_TOO_LARGE => {
                ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "图片像素尺寸过大")
            }
            attachments::ERR_INVALID_ATTACHMENT_IDS => {
                ApiError::new(StatusCode::BAD_REQUEST, "附件列表无效")
            }
            attachments::ERR_ATTACHMENT_NOT_AVAILABLE => {
                ApiError::new(StatusCode::CONFLICT, "附件已失效，请重新选择")
            }
            _ => ApiError::service_unavailable(),
        },
        AttachError::Internal(_) => ApiError::service_unavailable(),
    }
}

fn has_expected_wan_host(headers: &HeaderMap, context: &ServerContext) -> bool {
    let Some(auth) = &context.wan_auth else {
        return false;
    };
    header_text(headers, "host")
        .map(|host| host.eq_ignore_ascii_case(&auth.expected_host()))
        .unwrap_or(false)
}

fn has_expected_wan_origin(headers: &HeaderMap, context: &ServerContext) -> bool {
    let Some(auth) = &context.wan_auth else {
        return false;
    };
    header_text(headers, "origin")
        .map(|origin| origin == auth.origin())
        .unwrap_or(false)
}

fn is_authorized(context: &ServerContext, headers: &HeaderMap, url: &Url, request_token: &str) -> bool {
    match context.policy {
        ServerPolicy::Lan => {
            if request_token.is_empty() {
                return false;
            }
            let header_match = header_text(headers, TOKEN_HEADER)
                .map(|value| secret_matches(&value, request_token))
                .unwrap_or(false);
            let cookie_match = cookie_value(headers, COOKIE_NAME)
                .map(|value| secret_matches(&value, request_token))
                .unwrap_or(false);
            let query_match = url
                .query_pairs()
                .find(|(key, _)| key == "token")
                .map(|(_, value)| secret_matches(&value, request_token))
                .unwrap_or(false);
            header_match || cookie_match || query_match
        }
        ServerPolicy::Wan => context
            .wan_auth
            .as_ref()
            .map(|auth| auth.authorize(cookie_value(headers, WAN_COOKIE_NAME).as_deref()))
            .unwrap_or(false),
    }
}

// ─── 主流程 ────────────────────────────────────────────────────────────────

async fn process(
    context: &Arc<ServerContext>,
    request: Request<Body>,
) -> Result<Response<Body>, ApiError> {
    let (parts, body) = request.into_parts();
    let method = parts.method.clone();
    let headers = parts.headers.clone();
    let mut body = Some(body);

    let uri = parts
        .uri
        .path_and_query()
        .map(|value| value.as_str().to_string())
        .unwrap_or_else(|| "/".to_string());
    let url = parse_url(&uri).ok_or_else(|| ApiError::bad_request("请求无效"))?;
    let path = url.path().to_string();

    let request_generation = context.generation();
    let request_token = context.current_token();

    if context.is_wan() && !has_expected_wan_host(&headers, context) {
        return Ok(json_response(
            StatusCode::MISDIRECTED_REQUEST,
            &json!({ "error": "公网入口域名不匹配" }),
            Vec::new(),
        ));
    }

    if context.is_wan() && method == Method::POST && path == "/api/pair" {
        return handle_wan_pair(context, &headers, body.take()).await;
    }

    let authorized = is_authorized(context, &headers, &url, &request_token);
    // 公网未配对时也允许读取配对页（HTML / 静态资源 / 品牌 logo），
    // 否则首屏既加载不了页面脚本，图片资源也会裂开。
    let is_wan_public_page = context.is_wan()
        && method == Method::GET
        && (path == "/" || path == "/icon.png" || path.starts_with(MOBILE_ASSET_PATH_PREFIX));
    if !authorized && !is_wan_public_page {
        if is_browser_navigation(&method, &headers) {
            let desktop_locale = assets::read_desktop_locale().await;
            let locale = unauthorized::resolve_locale(
                desktop_locale,
                header_text(&headers, "accept-language").as_deref(),
            );
            let html = unauthorized::render_unauthorized_page(
                locale,
                context.icon_bytes.as_ref().map(|bytes| bytes.as_slice()),
            );
            return Ok(html_response(
                StatusCode::UNAUTHORIZED,
                html,
                vec![("Content-Security-Policy", UNAUTHORIZED_PAGE_CSP.to_string())],
                method == Method::HEAD,
            ));
        }
        return Ok(json_response(
            StatusCode::UNAUTHORIZED,
            &json!({ "error": "未授权：请使用 Snow 设置中显示的配对链接" }),
            Vec::new(),
        ));
    }

    if context.is_wan()
        && method != Method::GET
        && method != Method::HEAD
        && !has_expected_wan_origin(&headers, context)
    {
        return Ok(json_response(
            StatusCode::FORBIDDEN,
            &json!({ "error": "请求来源无效" }),
            Vec::new(),
        ));
    }

    if method == Method::GET && path == "/" {
        let Some(html) = assets::read_mobile_index_html(&context.mobile_dir).await else {
            return Ok(json_response(
                StatusCode::SERVICE_UNAVAILABLE,
                &json!({ "error": "移动端页面资源尚未构建，请先运行 npm run build / npm run dev" }),
                Vec::new(),
            ));
        };
        let mut extra = vec![("Content-Security-Policy", MOBILE_PAGE_CSP.to_string())];
        if !context.is_wan() {
            let token_from_query = url
                .query_pairs()
                .find(|(key, _)| key == "token")
                .map(|(_, value)| value.into_owned());
            if let Some(candidate) = token_from_query {
                if secret_matches(&candidate, &request_token) {
                    extra.push((
                        "Set-Cookie",
                        format!(
                            "{COOKIE_NAME}={}; Path=/; HttpOnly; SameSite=Strict",
                            utf8_percent_encode(&request_token, URI_COMPONENT_SET)
                        ),
                    ));
                }
            }
        }
        return Ok(html_response(StatusCode::OK, html, extra, false));
    }

    if method == Method::GET && path == "/icon.png" {
        let Some(icon) = context.icon_bytes.clone() else {
            return Ok(json_response(
                StatusCode::NOT_FOUND,
                &json!({ "error": "图标资源不可用" }),
                Vec::new(),
            ));
        };
        return Ok(build_response(
            StatusCode::OK,
            "image/png",
            (*icon).clone(),
            vec![
                ("Cache-Control", "public, max-age=86400".to_string()),
                ("X-Content-Type-Options", "nosniff".to_string()),
            ],
        ));
    }

    if method == Method::GET && path.starts_with(MOBILE_ASSET_PATH_PREFIX) {
        let Some((bytes, content_type)) =
            assets::read_mobile_asset(&context.mobile_dir, &path).await
        else {
            return Ok(json_response(
                StatusCode::NOT_FOUND,
                &json!({ "error": "资源不存在" }),
                Vec::new(),
            ));
        };
        return Ok(build_response(
            StatusCode::OK,
            content_type,
            bytes,
            vec![
                // 文件名带内容哈希：URL 变化即自动失效，可放心交给浏览器长缓存。
                (
                    "Cache-Control",
                    "public, max-age=31536000, immutable".to_string(),
                ),
                ("X-Content-Type-Options", "nosniff".to_string()),
            ],
        ));
    }

    if method == Method::GET && path == "/health" {
        return Ok(json_response(
            StatusCode::OK,
            &json!({ "ok": true, "rendererReady": bridge::is_registered() }),
            Vec::new(),
        ));
    }

    handle_api(
        context,
        &method,
        &path,
        &url,
        &headers,
        &mut body,
        request_generation,
    )
    .await
}

/// 公网配对：校验来源与内容类型后，用一次性配对码换取会话 Cookie。
async fn handle_wan_pair(
    context: &ServerContext,
    headers: &HeaderMap,
    body: Option<Body>,
) -> Result<Response<Body>, ApiError> {
    if !has_expected_wan_origin(headers, context) {
        return Ok(json_response(
            StatusCode::FORBIDDEN,
            &json!({ "error": "请求来源无效" }),
            Vec::new(),
        ));
    }
    if !is_json_request(headers) {
        return Ok(json_response(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            &json!({ "error": "Content-Type 必须是 application/json" }),
            Vec::new(),
        ));
    }
    let payload = read_json_body(body).await?;
    let Some(code) = payload.get("code").and_then(Value::as_str) else {
        return Ok(json_response(
            StatusCode::BAD_REQUEST,
            &json!({ "error": "配对码无效" }),
            Vec::new(),
        ));
    };
    if code.chars().count() > MAX_IDENTIFIER_LENGTH {
        return Ok(json_response(
            StatusCode::BAD_REQUEST,
            &json!({ "error": "配对码无效" }),
            Vec::new(),
        ));
    }
    let Some(auth) = &context.wan_auth else {
        return Ok(json_response(
            StatusCode::UNAUTHORIZED,
            &json!({ "error": "配对码无效或已过期" }),
            Vec::new(),
        ));
    };
    let Some(session) = auth.exchange(code) else {
        return Ok(json_response(
            StatusCode::UNAUTHORIZED,
            &json!({ "error": "配对码无效或已过期" }),
            Vec::new(),
        ));
    };
    Ok(json_response(
        StatusCode::OK,
        &json!({ "ok": true, "expiresAt": session.expires_at }),
        vec![(
            "Set-Cookie",
            format!(
                "{WAN_COOKIE_NAME}={}; Path=/; Max-Age=86400; Secure; HttpOnly; SameSite=Strict",
                utf8_percent_encode(&session.token, URI_COMPONENT_SET)
            ),
        )],
    ))
}

// ─── API 路由 ──────────────────────────────────────────────────────────────

fn percent_decode(value: &str) -> Option<String> {
    percent_encoding::percent_decode_str(value)
        .decode_utf8()
        .ok()
        .map(|decoded| decoded.into_owned())
}

/// 读取查询参数（URLSearchParams 语义：缺失返回 None，空串返回 Some("")）。
fn query_param(url: &Url, name: &str) -> Option<String> {
    url.query_pairs()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.into_owned())
}

/// 校验字符串数组字段：缺失 / null 视为空数组，非字符串元素视为非法。
fn string_array_field(value: Option<&Value>) -> Option<Vec<String>> {
    match value {
        None | Some(Value::Null) => Some(Vec::new()),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| item.as_str().map(str::to_string))
            .collect(),
        Some(_) => None,
    }
}

#[allow(clippy::too_many_arguments)]
async fn handle_api(
    context: &Arc<ServerContext>,
    method: &Method,
    path: &str,
    url: &Url,
    headers: &HeaderMap,
    body: &mut Option<Body>,
    request_generation: u64,
) -> Result<Response<Body>, ApiError> {
    if method == Method::GET && path == "/api/state" {
        ensure_current_pairing(context, request_generation)?;
        let value = bridge_call("getState", json!([])).await?;
        return Ok(json_response(StatusCode::OK, &value, Vec::new()));
    }

    if method == Method::GET && path.starts_with("/api/message-images/") {
        let parts: Vec<&str> = path["/api/message-images/".len()..].split('/').collect();
        let message_id = if parts.len() == 2 {
            percent_decode(parts[0])
        } else {
            None
        };
        let image_index = if parts.len() == 2 {
            parts[1].parse::<i64>().ok()
        } else {
            None
        };
        let (Some(message_id), Some(image_index)) = (message_id, image_index) else {
            return Ok(json_response(
                StatusCode::BAD_REQUEST,
                &json!({ "error": "图片标识无效" }),
                Vec::new(),
            ));
        };
        if !is_bounded_string(&message_id, false) || !(0..=20).contains(&image_index) {
            return Ok(json_response(
                StatusCode::BAD_REQUEST,
                &json!({ "error": "图片标识无效" }),
                Vec::new(),
            ));
        }
        ensure_current_pairing(context, request_generation)?;
        let image = resolve_message_image(&message_id, image_index).await;
        ensure_current_pairing(context, request_generation)?;
        let Some((mime_type, bytes)) = image else {
            return Ok(json_response(
                StatusCode::NOT_FOUND,
                &json!({ "error": "图片不可用" }),
                Vec::new(),
            ));
        };
        if bytes.is_empty() || bytes.len() > MAX_MESSAGE_IMAGE_BYTES {
            return Ok(json_response(
                StatusCode::NOT_FOUND,
                &json!({ "error": "图片不可用" }),
                Vec::new(),
            ));
        }
        return Ok(build_response(
            StatusCode::OK,
            &mime_type,
            bytes,
            vec![
                ("Cache-Control", "private, no-store".to_string()),
                ("X-Content-Type-Options", "nosniff".to_string()),
                ("Referrer-Policy", "no-referrer".to_string()),
            ],
        ));
    }

    if method == Method::GET && path == "/api/skills" {
        ensure_current_pairing(context, request_generation)?;
        let value = bridge_call("getSkills", json!([])).await?;
        return Ok(json_response(StatusCode::OK, &value, Vec::new()));
    }

    if method == Method::POST && path == "/api/skills" {
        if !is_json_request(headers) {
            return Ok(json_response(
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                &json!({ "error": "Content-Type 必须是 application/json" }),
                Vec::new(),
            ));
        }
        let payload = read_json_body(body.take()).await?;
        let skill_id = payload.get("skillId").and_then(Value::as_str);
        let enabled = payload.get("enabled").and_then(Value::as_bool);
        let directory_id = payload.get("directoryId");
        let directory_valid = match directory_id {
            None | Some(Value::Null) => true,
            Some(value) => value
                .as_str()
                .map(|text| is_bounded_string(text, false))
                .unwrap_or(false),
        };
        let valid = skill_id.map(|text| is_bounded_string(text, false)).unwrap_or(false)
            && enabled.is_some()
            && directory_valid;
        if !valid {
            return Ok(json_response(
                StatusCode::BAD_REQUEST,
                &json!({ "error": "Skill 请求无效" }),
                Vec::new(),
            ));
        }
        ensure_current_pairing(context, request_generation)?;
        let directory_arg = match directory_id {
            Some(Value::String(text)) => Value::String(text.clone()),
            _ => Value::Null,
        };
        let value = bridge_call(
            "setSkillEnabled",
            json!([skill_id, enabled, directory_arg]),
        )
        .await?;
        return Ok(json_response(StatusCode::OK, &value, Vec::new()));
    }

    if method == Method::GET && path == "/api/mcp" {
        ensure_current_pairing(context, request_generation)?;
        let value = bridge_call("getMcpServers", json!([])).await?;
        return Ok(json_response(StatusCode::OK, &value, Vec::new()));
    }

    if method == Method::GET && path == "/api/messages" {
        ensure_current_pairing(context, request_generation)?;
        let conversation_id = query_param(url, "conversationId").unwrap_or_default();
        let before_message_id = query_param(url, "beforeMessageId").unwrap_or_default();
        let limit = match query_param(url, "limit") {
            None => Some(20i64),
            Some(raw) => raw.parse::<i64>().ok(),
        };
        let Some(limit) = limit else {
            return Ok(json_response(
                StatusCode::BAD_REQUEST,
                &json!({ "error": "消息分页参数无效" }),
                Vec::new(),
            ));
        };
        if !is_bounded_string(&conversation_id, false)
            || !is_bounded_string(&before_message_id, true)
            || !(1..=50).contains(&limit)
        {
            return Ok(json_response(
                StatusCode::BAD_REQUEST,
                &json!({ "error": "消息分页参数无效" }),
                Vec::new(),
            ));
        }
        let value = bridge_call(
            "getMessages",
            json!([conversation_id, before_message_id, limit]),
        )
        .await?;
        return Ok(json_response(StatusCode::OK, &value, Vec::new()));
    }

    if method == Method::GET && path == "/api/conversations" {
        ensure_current_pairing(context, request_generation)?;
        let directory_id = query_param(url, "directoryId").unwrap_or_default();
        let offset = match query_param(url, "offset") {
            None => Some(0i64),
            Some(raw) => raw.parse::<i64>().ok(),
        };
        let limit = match query_param(url, "limit") {
            None => Some(20i64),
            Some(raw) => raw.parse::<i64>().ok(),
        };
        let (Some(offset), Some(limit)) = (offset, limit) else {
            return Ok(json_response(
                StatusCode::BAD_REQUEST,
                &json!({ "error": "会话分页参数无效" }),
                Vec::new(),
            ));
        };
        if !is_bounded_string(&directory_id, false)
            || !(0..=100_000).contains(&offset)
            || !(1..=100).contains(&limit)
        {
            return Ok(json_response(
                StatusCode::BAD_REQUEST,
                &json!({ "error": "会话分页参数无效" }),
                Vec::new(),
            ));
        }
        let value = bridge_call(
            "getConversations",
            json!([directory_id, limit, offset]),
        )
        .await?;
        return Ok(json_response(StatusCode::OK, &value, Vec::new()));
    }

    if method == Method::GET && path == "/api/changes" {
        ensure_current_pairing(context, request_generation)?;
        let conversation_id = query_param(url, "conversationId");
        if let Some(value) = &conversation_id {
            if !is_bounded_string(value, false) {
                return Ok(json_response(
                    StatusCode::BAD_REQUEST,
                    &json!({ "error": "会话标识无效" }),
                    Vec::new(),
                ));
            }
        }
        let argument = conversation_id.map(Value::String).unwrap_or(Value::Null);
        let value = bridge_call("getChanges", json!([argument])).await?;
        return Ok(json_response(StatusCode::OK, &value, Vec::new()));
    }

    if method == Method::GET && path == "/api/sensitive-commands" {
        ensure_current_pairing(context, request_generation)?;
        let value = bridge_call("getSensitiveCommands", json!([])).await?;
        return Ok(json_response(StatusCode::OK, &value, Vec::new()));
    }

    if method == Method::GET && path == "/api/review" {
        ensure_current_pairing(context, request_generation)?;
        let value = bridge_call("getReview", json!([])).await?;
        return Ok(json_response(StatusCode::OK, &value, Vec::new()));
    }

    if method == Method::GET && path == "/api/codebase" {
        ensure_current_pairing(context, request_generation)?;
        let value = bridge_call("getCodebase", json!([])).await?;
        return Ok(json_response(StatusCode::OK, &value, Vec::new()));
    }

    if method == Method::GET && path == "/api/role" {
        ensure_current_pairing(context, request_generation)?;
        let value = bridge_call("getRole", json!([])).await?;
        return Ok(json_response(StatusCode::OK, &value, Vec::new()));
    }

    if method == Method::GET && path == "/api/permissions" {
        ensure_current_pairing(context, request_generation)?;
        let value = bridge_call("getPermissions", json!([])).await?;
        return Ok(json_response(StatusCode::OK, &value, Vec::new()));
    }

    if method == Method::POST && path == "/api/mcp" {
        if !is_json_request(headers) {
            return Ok(json_response(
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                &json!({ "error": "Content-Type 必须是 application/json" }),
                Vec::new(),
            ));
        }
        let payload = read_json_body(body.take()).await?;
        let target = payload.get("target").and_then(Value::as_str);
        let id = payload.get("id").and_then(Value::as_str);
        let enabled = payload.get("enabled").and_then(Value::as_bool);
        let directory_id = payload.get("directoryId").and_then(Value::as_str);
        let valid = matches!(target, Some("server") | Some("tool"))
            && id.map(|text| is_bounded_string(text, false)).unwrap_or(false)
            && enabled.is_some()
            && directory_id
                .map(|text| is_bounded_string(text, false))
                .unwrap_or(false);
        if !valid {
            return Ok(json_response(
                StatusCode::BAD_REQUEST,
                &json!({ "error": "MCP 请求无效" }),
                Vec::new(),
            ));
        }
        ensure_current_pairing(context, request_generation)?;
        let value = bridge_call("setMcpEnabled", json!([target, id, enabled, directory_id])).await?;
        return Ok(json_response(StatusCode::OK, &value, Vec::new()));
    }

    if method == Method::POST && path == "/api/attachments" {
        send_tracker::acquire();
        let result = async {
            let remote_state = bridge_call("getState", json!([])).await?;
            ensure_current_pairing(context, request_generation)?;
            let attachment_context = RemoteAttachmentContext::from_state(&remote_state);
            let kind = header_text(headers, "x-snow-attachment-kind")
                .and_then(|value| AttachmentKind::from_header(&value))
                .ok_or_else(|| api_error_from_attach(AttachError::Code(attachments::ERR_INVALID_KIND)))?;
            let mime_type = header_text(headers, "content-type")
                .unwrap_or_default()
                .split(';')
                .next()
                .unwrap_or_default()
                .trim()
                .to_ascii_lowercase();
            let file_name =
                header_text(headers, "x-snow-file-name").unwrap_or_else(|| "attachment".to_string());
            let declared_length = match header_text(headers, "content-length") {
                None => None,
                Some(raw) => raw.trim().parse::<u64>().ok(),
            };
            let body = body.take().unwrap_or_else(Body::empty);
            let summary = attachments::save_attachment(
                kind,
                &mime_type,
                &file_name,
                declared_length,
                body,
                attachment_context,
                request_generation,
            )
            .await
            .map_err(api_error_from_attach)?;
            ensure_current_pairing(context, request_generation)?;
            Ok::<Response<Body>, ApiError>(json_response(
                StatusCode::CREATED,
                &summary.to_json(),
                Vec::new(),
            ))
        }
        .await;
        send_tracker::release();
        return result;
    }

    if method == Method::DELETE && path.starts_with("/api/attachments/") {
        let Some(id) = percent_decode(&path["/api/attachments/".len()..]) else {
            return Ok(json_response(
                StatusCode::BAD_REQUEST,
                &json!({ "error": "附件标识无效" }),
                Vec::new(),
            ));
        };
        if !is_bounded_string(&id, false) {
            return Ok(json_response(
                StatusCode::BAD_REQUEST,
                &json!({ "error": "附件标识无效" }),
                Vec::new(),
            ));
        }
        let remote_state = bridge_call("getState", json!([])).await?;
        ensure_current_pairing(context, request_generation)?;
        let attachment_context = RemoteAttachmentContext::from_state(&remote_state);
        attachments::discard(&id, &attachment_context, request_generation).await;
        return Ok(json_response(
            StatusCode::OK,
            &json!({ "ok": true }),
            Vec::new(),
        ));
    }

    if method == Method::POST && path == "/api/send" {
        if !is_json_request(headers) {
            return Ok(json_response(
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                &json!({ "error": "Content-Type 必须是 application/json" }),
                Vec::new(),
            ));
        }
        let payload = read_json_body(body.take()).await?;
        let Some(text) = payload.get("text").and_then(Value::as_str) else {
            return Ok(json_response(
                StatusCode::BAD_REQUEST,
                &json!({ "error": "text 必须是字符串" }),
                Vec::new(),
            ));
        };
        let attachment_ids = match string_array_field(payload.get("attachmentIds")) {
            Some(items) => items,
            None => {
                return Ok(json_response(
                    StatusCode::BAD_REQUEST,
                    &json!({ "error": "附件或请求标识无效" }),
                    Vec::new(),
                ))
            }
        };
        let request_id = payload.get("requestId").and_then(Value::as_str);
        let ids_valid = attachment_ids
            .iter()
            .all(|id| is_bounded_string(id, false))
            && attachment_ids.len() <= MAX_SEND_ATTACHMENTS;
        let valid = ids_valid
            && request_id
                .map(|value| is_bounded_string(value, false))
                .unwrap_or(false);
        if !valid {
            return Ok(json_response(
                StatusCode::BAD_REQUEST,
                &json!({ "error": "附件或请求标识无效" }),
                Vec::new(),
            ));
        }
        let request_id = request_id.unwrap_or_default().to_string();
        ensure_current_pairing(context, request_generation)?;
        if let Some(cached) = completed_send_result(&request_id, request_generation) {
            return Ok(json_response(StatusCode::OK, &cached, Vec::new()));
        }
        let result = dispatch_remote_send(
            context,
            text.to_string(),
            attachment_ids,
            request_id,
            request_generation,
        )
        .await?;
        return Ok(json_response(StatusCode::OK, &result, Vec::new()));
    }

    if method == Method::POST && path == "/api/abort" {
        if !is_json_request(headers) {
            return Ok(json_response(
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                &json!({ "error": "Content-Type 必须是 application/json" }),
                Vec::new(),
            ));
        }
        let _ = read_json_body(body.take()).await?;
        let value = bridge_call("abort", json!([])).await?;
        return Ok(json_response(StatusCode::OK, &value, Vec::new()));
    }

    if method == Method::POST && path == "/api/pending" {
        if !is_json_request(headers) {
            return Ok(json_response(
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                &json!({ "error": "Content-Type 必须是 application/json" }),
                Vec::new(),
            ));
        }
        let payload = read_json_body(body.take()).await?;
        let action = payload.get("action").and_then(Value::as_str);
        let index = payload.get("index").and_then(Value::as_i64);
        let queue_key = payload.get("queueKey");
        let valid_action = matches!(action, Some("send-now") | Some("withdraw"));
        if !valid_action {
            return Ok(json_response(
                StatusCode::BAD_REQUEST,
                &json!({ "error": "action 必须是 send-now 或 withdraw" }),
                Vec::new(),
            ));
        }
        let Some(index) = index.filter(|value| *value >= 0) else {
            return Ok(json_response(
                StatusCode::BAD_REQUEST,
                &json!({ "error": "index 必须是非负整数" }),
                Vec::new(),
            ));
        };
        let queue_key = match queue_key {
            None | Some(Value::Null) => Value::Null,
            Some(Value::String(text)) if is_bounded_string(text, false) => {
                Value::String(text.clone())
            }
            _ => {
                return Ok(json_response(
                    StatusCode::BAD_REQUEST,
                    &json!({ "error": "queueKey 必须是字符串或 null" }),
                    Vec::new(),
                ))
            }
        };
        ensure_current_pairing(context, request_generation)?;
        let bridge_action = if action == Some("send-now") {
            "sendPendingNow"
        } else {
            "withdrawPending"
        };
        let value = bridge_call(bridge_action, json!([index, queue_key])).await?;
        return Ok(json_response(StatusCode::OK, &value, Vec::new()));
    }

    if method == Method::POST && path == "/api/new-chat" {
        if !is_json_request(headers) {
            return Ok(json_response(
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                &json!({ "error": "Content-Type 必须是 application/json" }),
                Vec::new(),
            ));
        }
        let _ = read_json_body(body.take()).await?;
        let value = bridge_call("newChat", json!([])).await?;
        return Ok(json_response(StatusCode::OK, &value, Vec::new()));
    }

    if method == Method::POST && path == "/api/todos" {
        if !is_json_request(headers) {
            return Ok(json_response(
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                &json!({ "error": "Content-Type 必须是 application/json" }),
                Vec::new(),
            ));
        }
        let payload = read_json_body(body.take()).await?;
        let action = payload.get("action").and_then(Value::as_str);
        let content = payload.get("content").and_then(Value::as_str);
        let todo_id = payload.get("todoId").and_then(Value::as_str);
        let status = payload.get("status").and_then(Value::as_str);
        let is_add = action == Some("add");
        let is_update = action == Some("update");
        let is_delete = action == Some("delete");
        let valid = (is_add || is_update || is_delete)
            && (!is_add || content.map(is_todo_content).unwrap_or(false))
            && (is_add || todo_id.map(|value| is_bounded_string(value, false)).unwrap_or(false))
            && (!is_update || status.map(is_todo_status).unwrap_or(false));
        if !valid {
            return Ok(json_response(
                StatusCode::BAD_REQUEST,
                &json!({ "error": "待办请求无效" }),
                Vec::new(),
            ));
        }
        ensure_current_pairing(context, request_generation)?;
        // 未提供的字段直接省略（与旧实现 undefined 字段被 JSON 丢弃一致）。
        let mut payload_object = serde_json::Map::new();
        if is_add {
            if let Some(value) = content {
                payload_object.insert("content".to_string(), Value::String(value.to_string()));
            }
        } else {
            if let Some(value) = todo_id {
                payload_object.insert("todoId".to_string(), Value::String(value.to_string()));
            }
            if is_update {
                if let Some(value) = status {
                    payload_object.insert("status".to_string(), Value::String(value.to_string()));
                }
            }
        }
        let value = bridge_call(
            "mutateTodos",
            json!([action, Value::Object(payload_object)]),
        )
        .await?;
        return Ok(json_response(StatusCode::OK, &value, Vec::new()));
    }

    if method == Method::POST && path == "/api/workflow" {
        if !is_json_request(headers) {
            return Ok(json_response(
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                &json!({ "error": "Content-Type 必须是 application/json" }),
                Vec::new(),
            ));
        }
        let payload = read_json_body(body.take()).await?;
        let action = payload.get("action").and_then(Value::as_str);
        let flow_id = payload.get("flowId").and_then(Value::as_str);
        let message = payload.get("message").and_then(Value::as_str);
        let is_run = action == Some("run");
        let is_reply = action == Some("reply");
        let valid = (is_run || is_reply)
            && flow_id
                .map(|value| is_bounded_string(value, false))
                .unwrap_or(false)
            && (!is_reply || message.map(is_workflow_reply).unwrap_or(false));
        if !valid {
            return Ok(json_response(
                StatusCode::BAD_REQUEST,
                &json!({ "error": "工作流请求无效" }),
                Vec::new(),
            ));
        }
        ensure_current_pairing(context, request_generation)?;
        // 执行在渲染进程后台运行（立即返回，进度由 /api/state 轮询），
        // 反馈直接结算挂起的工具调用；两者都与桌面卡片按钮同语义。
        let value = if is_run {
            bridge_call("runWorkflow", json!([flow_id])).await?
        } else {
            bridge_call("replyWorkflow", json!([flow_id, message])).await?
        };
        return Ok(json_response(StatusCode::OK, &value, Vec::new()));
    }

    if method == Method::POST && path == "/api/mode" {
        if !is_json_request(headers) {
            return Ok(json_response(
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                &json!({ "error": "Content-Type 必须是 application/json" }),
                Vec::new(),
            ));
        }
        let payload = read_json_body(body.take()).await?;
        let mode = payload.get("mode").and_then(Value::as_str);
        let Some(mode) = mode.filter(|value| is_remote_mode(value)) else {
            return Ok(json_response(
                StatusCode::BAD_REQUEST,
                &json!({ "error": format!("mode 必须是 {} 之一", REMOTE_MODES.join(" / ")) }),
                Vec::new(),
            ));
        };
        let enabled = match payload.get("enabled") {
            None => true,
            Some(Value::Bool(value)) => *value,
            Some(_) => {
                return Ok(json_response(
                    StatusCode::BAD_REQUEST,
                    &json!({ "error": "enabled 必须是布尔值" }),
                    Vec::new(),
                ))
            }
        };
        let value = bridge_call("setMode", json!([mode, enabled])).await?;
        return Ok(json_response(StatusCode::OK, &value, Vec::new()));
    }

    if method == Method::POST && path == "/api/command" {
        if !is_json_request(headers) {
            return Ok(json_response(
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                &json!({ "error": "Content-Type 必须是 application/json" }),
                Vec::new(),
            ));
        }
        let payload = read_json_body(body.take()).await?;
        let command_id = payload.get("commandId").and_then(Value::as_str);
        if command_id.map(|value| is_bounded_string(value, false)) != Some(true) {
            return Ok(json_response(
                StatusCode::BAD_REQUEST,
                &json!({ "error": format!("commandId 必须是长度不超过 {MAX_IDENTIFIER_LENGTH} 的非空字符串") }),
                Vec::new(),
            ));
        }
        let value = bridge_call("runCommand", json!([command_id])).await?;
        return Ok(json_response(StatusCode::OK, &value, Vec::new()));
    }

    if method == Method::POST && path == "/api/model" {
        if !is_json_request(headers) {
            return Ok(json_response(
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                &json!({ "error": "Content-Type 必须是 application/json" }),
                Vec::new(),
            ));
        }
        let payload = read_json_body(body.take()).await?;
        let provided: Vec<&str> = ["model", "profile", "thinkingStrength", "responsesFastMode"]
            .into_iter()
            .filter(|key| payload.get(*key).is_some())
            .collect();
        if provided.len() != 1 {
            return Ok(json_response(
                StatusCode::BAD_REQUEST,
                &json!({ "error": "每次只能修改 model / profile / thinkingStrength / responsesFastMode 中的一项" }),
                Vec::new(),
            ));
        }
        match provided[0] {
            "model" => {
                let model = payload.get("model").and_then(Value::as_str);
                if model.map(|value| is_bounded_string(value, false)) != Some(true) {
                    return Ok(json_response(
                        StatusCode::BAD_REQUEST,
                        &json!({ "error": format!("model 必须是长度不超过 {MAX_IDENTIFIER_LENGTH} 的非空字符串") }),
                        Vec::new(),
                    ));
                }
                let value = bridge_call("setModel", json!([model])).await?;
                return Ok(json_response(StatusCode::OK, &value, Vec::new()));
            }
            "profile" => {
                let profile = payload.get("profile").and_then(Value::as_str);
                if profile.map(|value| is_bounded_string(value, false)) != Some(true) {
                    return Ok(json_response(
                        StatusCode::BAD_REQUEST,
                        &json!({ "error": format!("profile 必须是长度不超过 {MAX_IDENTIFIER_LENGTH} 的非空字符串") }),
                        Vec::new(),
                    ));
                }
                let value = bridge_call("setApiProfile", json!([profile])).await?;
                return Ok(json_response(StatusCode::OK, &value, Vec::new()));
            }
            "thinkingStrength" => {
                // 空串是合法值：表示继承 Profile 默认推理强度。
                let thinking = payload.get("thinkingStrength").and_then(Value::as_str);
                if thinking.map(|value| is_bounded_string(value, true)) != Some(true) {
                    return Ok(json_response(
                        StatusCode::BAD_REQUEST,
                        &json!({ "error": format!("thinkingStrength 必须是长度不超过 {MAX_IDENTIFIER_LENGTH} 的字符串") }),
                        Vec::new(),
                    ));
                }
                let value = bridge_call("setThinking", json!([thinking])).await?;
                return Ok(json_response(StatusCode::OK, &value, Vec::new()));
            }
            _ => {
                let Some(fast_mode) = payload.get("responsesFastMode").and_then(Value::as_bool)
                else {
                    return Ok(json_response(
                        StatusCode::BAD_REQUEST,
                        &json!({ "error": "responsesFastMode 必须是布尔值" }),
                        Vec::new(),
                    ));
                };
                let value = bridge_call("toggleResponsesFastMode", json!([fast_mode])).await?;
                return Ok(json_response(StatusCode::OK, &value, Vec::new()));
            }
        }
    }

    if method == Method::POST && path == "/api/select" {
        if !is_json_request(headers) {
            return Ok(json_response(
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                &json!({ "error": "Content-Type 必须是 application/json" }),
                Vec::new(),
            ));
        }
        let payload = read_json_body(body.take()).await?;
        let conversation_id = payload.get("conversationId").and_then(Value::as_str);
        let directory_arg = match payload.get("directoryId") {
            None => Value::Null,
            Some(Value::String(text)) => Value::String(text.clone()),
            Some(_) => Value::Null,
        };
        let directory_valid = match payload.get("directoryId") {
            None => true,
            Some(Value::String(_)) => true,
            Some(_) => false,
        };
        if conversation_id.is_none() || !directory_valid {
            return Ok(json_response(
                StatusCode::BAD_REQUEST,
                &json!({ "error": "会话参数无效" }),
                Vec::new(),
            ));
        }
        let value = bridge_call("select", json!([conversation_id, directory_arg])).await?;
        return Ok(json_response(StatusCode::OK, &value, Vec::new()));
    }

    if method == Method::POST && path == "/api/authorization" {
        if !is_json_request(headers) {
            return Ok(json_response(
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                &json!({ "error": "Content-Type 必须是 application/json" }),
                Vec::new(),
            ));
        }
        let payload = read_json_body(body.take()).await?;
        let authorization_id = payload.get("authorizationId").and_then(Value::as_str);
        let decision = payload.get("decision").and_then(Value::as_str);
        let reason = match payload.get("reason") {
            None => None,
            Some(Value::String(text)) => Some(text.clone()),
            Some(_) => {
                return Ok(json_response(
                    StatusCode::BAD_REQUEST,
                    &json!({ "error": "授权参数无效" }),
                    Vec::new(),
                ))
            }
        };
        let valid = authorization_id.is_some() && matches!(decision, Some("approve") | Some("reject"));
        if !valid {
            return Ok(json_response(
                StatusCode::BAD_REQUEST,
                &json!({ "error": "授权参数无效" }),
                Vec::new(),
            ));
        }
        let value = if decision == Some("approve") {
            bridge_call("approve", json!([authorization_id])).await?
        } else {
            bridge_call("reject", json!([authorization_id, reason])).await?
        };
        return Ok(json_response(StatusCode::OK, &value, Vec::new()));
    }

    if method == Method::POST && path == "/api/question" {
        if !is_json_request(headers) {
            return Ok(json_response(
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                &json!({ "error": "Content-Type 必须是 application/json" }),
                Vec::new(),
            ));
        }
        let payload = read_json_body(body.take()).await?;
        let question_id = payload.get("questionId").and_then(Value::as_str);
        let action = payload.get("action").and_then(Value::as_str);
        let selected_options = string_array_field(payload.get("selectedOptions"));
        let custom_answers = string_array_field(payload.get("customAnswers"));
        let valid = question_id.is_some()
            && matches!(action, Some("answer") | Some("cancel"))
            && selected_options
                .as_ref()
                .map(|items| items.len() <= 20)
                .unwrap_or(false)
            && custom_answers
                .as_ref()
                .map(|items| items.len() <= 20)
                .unwrap_or(false);
        if !valid {
            return Ok(json_response(
                StatusCode::BAD_REQUEST,
                &json!({ "error": "回答参数无效" }),
                Vec::new(),
            ));
        }
        let value = if action == Some("cancel") {
            bridge_call("cancelQuestion", json!([question_id])).await?
        } else {
            bridge_call(
                "answer",
                json!([question_id, selected_options, custom_answers]),
            )
            .await?
        };
        return Ok(json_response(StatusCode::OK, &value, Vec::new()));
    }

    Ok(json_response(
        StatusCode::NOT_FOUND,
        &json!({ "error": "接口不存在" }),
        Vec::new(),
    ))
}

/// 派发一次远程发送：绑定当前上下文、消费附件并缓存幂等结果。
async fn dispatch_remote_send(
    context: &ServerContext,
    text: String,
    attachment_ids: Vec<String>,
    request_id: String,
    generation: u64,
) -> Result<Value, ApiError> {
    send_tracker::acquire();
    let result = async {
        ensure_current_pairing(context, generation)?;
        let remote_state = bridge_call("getState", json!([])).await?;
        ensure_current_pairing(context, generation)?;
        let attachment_context = RemoteAttachmentContext::from_state(&remote_state);
        let value = bridge_call(
            "send",
            json!([
                text,
                attachment_ids,
                request_id,
                attachment_context.to_json(),
                generation
            ]),
        )
        .await?;
        attachments::mark_consumed(&attachment_ids, &attachment_context, generation)
            .await
            .map_err(api_error_from_attach)?;
        store_completed_send(request_id, generation, value.clone());
        Ok::<Value, ApiError>(value)
    }
    .await;
    send_tracker::release();
    result
}

/// 校验桥返回的图片载荷（MIME 白名单 + 非空 base64）。
fn parse_image_payload(value: &Value) -> Option<(String, Vec<u8>)> {
    let mime_type = value.get("mimeType").and_then(Value::as_str)?;
    if !MESSAGE_IMAGE_TYPES.contains(&mime_type) {
        return None;
    }
    let base64 = value.get("base64").and_then(Value::as_str)?;
    if base64.is_empty() {
        return None;
    }
    let bytes = BASE64_STANDARD.decode(base64).ok()?;
    Some((mime_type.to_string(), bytes))
}

/// 解析消息图片：优先从桌面渲染进程的会话内存取（覆盖尚未落库的即时
/// 消息），失败时回退到 Rust 数据库 + upload 磁盘解析。
async fn resolve_message_image(message_id: &str, image_index: i64) -> Option<(String, Vec<u8>)> {
    if let Ok(value) = bridge::call("getMessageImage", json!([message_id, image_index])).await {
        if let Some(result) = parse_image_payload(&value) {
            return Some(result);
        }
    }
    let owned_id = message_id.to_string();
    let stored = tokio::task::spawn_blocking(move || {
        crate::storage::get_chat_message_image(owned_id, image_index as i32)
    })
    .await
    .ok()?
    .ok()??;
    if !MESSAGE_IMAGE_TYPES.contains(&stored.mime_type.as_str()) || stored.base64.is_empty() {
        return None;
    }
    let bytes = BASE64_STANDARD.decode(stored.base64).ok()?;
    Some((stored.mime_type, bytes))
}

/// 等待在途 send 派发结束（轮换凭据 / 停止服务时使用）。
pub async fn wait_send_idle() {
    send_tracker::wait_idle(SEND_IDLE_TIMEOUT).await;
}
