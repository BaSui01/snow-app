//! OpenAI Responses API WebSocket 传输（`snowcfg.responsesWebSocket`）。
//!
//! WebSocket 模式与 SSE 模式共用同一套 payload 构造、事件解析
//! （`event::process_responses_sse_event_block`）与阶段感知恢复策略
//! （`retry::decide_stream_recovery`），区别只在传输层：一次 `response.create`
//! 帧换一条 WebSocket 连接，收到的每一帧与 SSE 的 `data:` 行是同一套 Responses
//! 事件（`stream` 字段在 WebSocket 下是隐式的，不随帧发送）。
//!
//! 连接按「endpoint + API Key + 自定义请求头」缓存复用——服务端允许一条连接
//! 承载多次 `response.create`，多轮对话因此不必反复付出 TCP + TLS 握手成本；
//! 空闲过久、寿命接近服务端 60 分钟上限、或发生过任何传输故障的连接一律丢弃
//! 重建。代理设置与 HTTP 传输保持一致（`http_client::load_proxy_config`）：
//! 先经 `CONNECT` 建立隧道，再在隧道上完成 TLS 握手。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use futures::SinkExt;
use napi::bindgen_prelude::*;
use napi::threadsafe_function::ThreadsafeFunctionCallMode;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::Mutex;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::header::{HeaderName, HeaderValue};
use tokio_tungstenite::tungstenite::http::Request;
use tokio_tungstenite::tungstenite::{Error as WsError, Message};
use tokio_tungstenite::{client_async, WebSocketStream};
use tokio_util::either::Either;
use tokio_util::sync::CancellationToken;
use url::Url;

use crate::api::common::{emit_stream_chunk, emit_tool_args_probe, ThinkingStreamTracker};
use crate::api::http_client::{app_user_agent, load_proxy_config};
use crate::api::responses::{ResponsesApiStreamCallback, ResponsesApiStreamChunk};
use crate::api::retry::{
    decide_stream_recovery, is_retriable_error, next_stream_item_with_idle,
    should_retry_empty_response, stream_idle_timeout_error, wait_before_retry, RetryOptions,
    StreamEndCause, StreamReadOutcome, StreamRecoveryDecision, EMPTY_RESPONSE_RETRY_ERROR,
};
use crate::api::sse::SseStreamEnd;
use crate::storage::services::app_logs::log_api_warning;

use super::stream::{
    cancelled_stream_result, finalize_attempt_result, finalize_transport_interruption,
    ResponsesAttemptState, StreamingResponseResult,
};

/// 复用连接的最长空闲时长：超过后不再复用（服务端可能已静默回收）。
const POOL_IDLE_TTL: Duration = Duration::from_secs(240);
/// 复用连接的绝对寿命上限：服务端 60 分钟会强制断开，提前换新连接。
const POOL_MAX_AGE: Duration = Duration::from_secs(50 * 60);
/// 代理 CONNECT 响应头的字节上限，防御异常代理无限发送。
const MAX_PROXY_HEADER_BYTES: usize = 8 * 1024;
/// 握手请求中由 WebSocket 协议（或传输层）决定、不允许自定义头覆盖的请求头。
const SKIPPED_HANDSHAKE_HEADERS: &[&str] = &[
    "host",
    "connection",
    "upgrade",
    "content-type",
    "content-length",
    "accept-encoding",
    "sec-websocket-key",
    "sec-websocket-version",
    "sec-websocket-protocol",
    "sec-websocket-extensions",
];

/// 一条 WebSocket 连接的底层字节流：直连 TCP，或经代理隧道后的 TLS 流。
type WsByteStream = Either<TcpStream, tokio_native_tls::TlsStream<TcpStream>>;
type WsSocket = WebSocketStream<WsByteStream>;

// ---------------------------------------------------------------------------
// 连接池
// ---------------------------------------------------------------------------

/// 池中的空闲连接（同一 endpoint 只保留一条）。
struct PooledSocket {
    socket: WsSocket,
    /// 归还时的代次，用于让到期回收任务只回收自己那一份。
    generation: u64,
    /// 连接最初建立的时间：复用不会刷新它，避免连接无限续命。
    created_at: Instant,
    idle_since: Instant,
}

static POOL: OnceLock<Mutex<HashMap<String, PooledSocket>>> = OnceLock::new();
static NEXT_GENERATION: AtomicU64 = AtomicU64::new(1);

fn pool() -> &'static Mutex<HashMap<String, PooledSocket>> {
    POOL.get_or_init(|| Mutex::new(HashMap::new()))
}

fn next_generation() -> u64 {
    NEXT_GENERATION.fetch_add(1, Ordering::Relaxed)
}

/// 连接池键：endpoint + API Key + 自定义请求头的摘要。
/// 凭证或请求头变化后旧连接不再可用（授权信息已固化在握手里），必须分开存放。
fn build_pool_key(
    endpoint: &str,
    api_key: &str,
    custom_headers: &HashMap<String, String>,
) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(api_key.as_bytes());
    let mut headers: Vec<(&String, &String)> = custom_headers.iter().collect();
    headers.sort();
    for (name, value) in headers {
        hasher.update(name.to_ascii_lowercase().as_bytes());
        hasher.update(b":");
        hasher.update(value.as_bytes());
        hasher.update(b"\n");
    }
    format!("{endpoint}\n{}", hasher.finalize().to_hex())
}

/// 取出一条可复用的空闲连接；不存在或已超过复用期限时返回 `None`
/// （超期连接在此被丢弃，不会再被使用）。
async fn take_pooled_socket(pool_key: &str) -> Option<(WsSocket, Instant)> {
    let mut pool = pool().lock().await;
    let entry = pool.remove(pool_key)?;
    if entry.idle_since.elapsed() > POOL_IDLE_TTL || entry.created_at.elapsed() > POOL_MAX_AGE {
        return None;
    }
    Some((entry.socket, entry.created_at))
}

/// 把连接放回池中等待下一次复用；同一键上的旧空闲连接被直接丢弃。
/// 同时派生一个到期回收任务，保证长时间不用时不会残留空闲连接。
async fn return_socket(pool_key: String, socket: WsSocket, created_at: Instant) {
    let generation = next_generation();
    let expiry_key = pool_key.clone();
    {
        let mut pool = pool().lock().await;
        pool.insert(
            pool_key,
            PooledSocket {
                socket,
                generation,
                created_at,
                idle_since: Instant::now(),
            },
        );
    }

    tokio::spawn(async move {
        tokio::time::sleep(POOL_IDLE_TTL).await;
        let mut pool = pool().lock().await;
        if pool
            .get(&expiry_key)
            .is_some_and(|entry| entry.generation == generation)
        {
            pool.remove(&expiry_key);
        }
    });
}

// ---------------------------------------------------------------------------
// 建立连接
// ---------------------------------------------------------------------------

/// 一次尝试的开始阶段（连接就绪且 `response.create` 已发出）的产物。
struct StartedAttempt {
    socket: WsSocket,
    /// 连接最初建立的时间（复用连接沿用首次建立时间，用于寿命上限判断）。
    created_at: Instant,
}

/// 开始阶段的失败。
struct StartFailure {
    error: Error,
    /// 是否值得重试：传输层故障恒为 true，握手 HTTP 状态按 `is_retriable_error` 判定。
    retriable: bool,
    /// 失败是否发生在一条复用的空闲连接上。
    reused: bool,
}

impl StartFailure {
    /// 传输层瞬时故障（TCP / TLS / 帧发送失败）。措辞与 SSE 传输的 connect
    /// 错误保持一致，便于日志比对。
    fn transport(message: String) -> Self {
        Self {
            error: Error::from_reason(message),
            retriable: true,
            reused: false,
        }
    }
}

/// 复用池中的空闲连接，没有可用连接时新建，随后发送本次 `response.create` 帧。
async fn start_attempt(
    pool_key: &str,
    endpoint: &str,
    api_key: &str,
    custom_headers: &HashMap<String, String>,
    frame_json: &str,
    retry_options: &RetryOptions,
) -> std::result::Result<StartedAttempt, StartFailure> {
    let (mut socket, reused, created_at) = match take_pooled_socket(pool_key).await {
        Some((socket, created_at)) => (socket, true, created_at),
        None => match connect_socket(endpoint, api_key, custom_headers, retry_options).await {
            Ok(socket) => (socket, false, Instant::now()),
            Err(failure) => {
                return Err(StartFailure {
                    reused: false,
                    ..failure
                })
            }
        },
    };

    if let Err(error) = socket.send(Message::Text(frame_json.to_string())).await {
        return Err(StartFailure {
            error: Error::from_reason(format!(
                "Failed to create response stream: sending response.create over WebSocket failed: {error}"
            )),
            retriable: true,
            reused,
        });
    }

    Ok(StartedAttempt { socket, created_at })
}

/// 建立一条到 Responses 端点的 WebSocket 连接（可选经代理 CONNECT 隧道 + TLS）。
async fn connect_socket(
    endpoint: &str,
    api_key: &str,
    custom_headers: &HashMap<String, String>,
    retry_options: &RetryOptions,
) -> std::result::Result<WsSocket, StartFailure> {
    let url = websocket_url(endpoint).map_err(|error| StartFailure {
        error,
        retriable: false,
        reused: false,
    })?;
    let host = url.host_str().unwrap_or_default().to_string();
    let port = url
        .port_or_known_default()
        .unwrap_or(if url.scheme() == "wss" { 443 } else { 80 });
    let request = build_handshake_request(&url, api_key, custom_headers)?;

    let tcp = connect_tcp(&host, port).await?;
    let stream = if url.scheme() == "wss" {
        Either::Right(tls_handshake(&host, tcp).await?)
    } else {
        Either::Left(tcp)
    };

    match client_async(request, stream).await {
        Ok((socket, _response)) => Ok(socket),
        Err(WsError::Http(response)) => {
            // 握手被 HTTP 状态码拒绝：措辞与 SSE 传输一致，从而复用同一套
            // 重试判定（429 / 5xx 重试，其余立即失败）。
            let status = response.status();
            let body = response
                .into_body()
                .map(|body| String::from_utf8_lossy(&body).to_string())
                .unwrap_or_default();
            let error =
                Error::from_reason(format!("Responses API request failed: {status} {body}"));
            let retriable = is_retriable_error(&error, retry_options);
            Err(StartFailure {
                error,
                retriable,
                reused: false,
            })
        }
        Err(error) => Err(StartFailure::transport(format!(
            "Failed to create response stream: WebSocket handshake failed: {error}"
        ))),
    }
}

/// 把 HTTP 端点 URL 转成 WebSocket 端点 URL（https → wss / http → ws）。
fn websocket_url(endpoint: &str) -> Result<Url> {
    let mut url = Url::parse(endpoint)
        .map_err(|error| Error::from_reason(format!("Invalid Responses endpoint URL: {error}")))?;
    let scheme = match url.scheme() {
        "https" => "wss",
        "http" => "ws",
        other => {
            return Err(Error::from_reason(format!(
                "Unsupported Responses endpoint scheme for WebSocket mode: {other}"
            )))
        }
    };
    let _ = url.set_scheme(scheme);
    Ok(url)
}

/// 建立到目标主机的 TCP 连接：启用代理且目标未被 `no_proxy` 排除时走 CONNECT 隧道。
async fn connect_tcp(host: &str, port: u16) -> std::result::Result<TcpStream, StartFailure> {
    let proxy = load_proxy_config()
        .await
        .map_err(|error| StartFailure::transport(format!("Failed to load proxy settings: {error}")))?;
    let proxy_url = match proxy.proxy_url() {
        Some(proxy_url) if !host_bypasses_proxy(host, &proxy.no_proxy_list()) => Some(proxy_url),
        _ => None,
    };

    match proxy_url {
        Some(proxy_url) => connect_through_proxy(&proxy_url, host, port).await,
        None => TcpStream::connect((host, port)).await.map_err(|error| {
            StartFailure::transport(format!(
                "Failed to create response stream: WebSocket connect failed: {error}"
            ))
        }),
    }
}

/// 经 HTTP 代理建立 CONNECT 隧道，返回已连通的原始 TCP 流。
async fn connect_through_proxy(
    proxy_url: &str,
    host: &str,
    port: u16,
) -> std::result::Result<TcpStream, StartFailure> {
    let proxy = Url::parse(proxy_url)
        .map_err(|error| StartFailure::transport(format!("Invalid proxy URL: {error}")))?;
    let proxy_host = proxy.host_str().unwrap_or("127.0.0.1").to_string();
    let proxy_port = proxy.port_or_known_default().unwrap_or(7890);

    let mut stream = TcpStream::connect((proxy_host.as_str(), proxy_port))
        .await
        .map_err(|error| {
            StartFailure::transport(format!(
                "Failed to create response stream: proxy connect failed: {error}"
            ))
        })?;

    let authority = format!("{host}:{port}");
    let request = format!(
        "CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\nProxy-Connection: Keep-Alive\r\n\r\n"
    );
    stream.write_all(request.as_bytes()).await.map_err(|error| {
        StartFailure::transport(format!("Failed to create response stream: {error}"))
    })?;

    // 逐字节读取响应头：多读一个字节就会吞掉紧随其后的 TLS ClientHello。
    let mut head = Vec::with_capacity(256);
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        if head.len() >= MAX_PROXY_HEADER_BYTES {
            return Err(StartFailure::transport(
                "Proxy CONNECT response header is too large".to_string(),
            ));
        }
        let read = stream.read(&mut byte).await.map_err(|error| {
            StartFailure::transport(format!("Failed to create response stream: {error}"))
        })?;
        if read == 0 {
            return Err(StartFailure::transport(
                "Proxy closed the connection during CONNECT".to_string(),
            ));
        }
        head.push(byte[0]);
    }

    let head = String::from_utf8_lossy(&head).to_string();
    let status = head
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse::<u16>().ok())
        .unwrap_or_default();
    if status != 200 {
        let status_line = head.lines().next().unwrap_or_default().trim().to_string();
        return Err(StartFailure {
            error: Error::from_reason(format!("Proxy CONNECT failed: {status_line}")),
            // 407 等代理侧的客户端错误重试没有意义，5xx / 429 仍按瞬时故障处理。
            retriable: status >= 500 || status == 429,
            reused: false,
        });
    }

    Ok(stream)
}

/// 在已连通的 TCP 流上完成 TLS 握手（SNI 与证书校验使用目标主机名）。
async fn tls_handshake(
    host: &str,
    stream: TcpStream,
) -> std::result::Result<tokio_native_tls::TlsStream<TcpStream>, StartFailure> {
    let connector = native_tls::TlsConnector::builder().build().map_err(|error| {
        StartFailure::transport(format!("Failed to create TLS connector: {error}"))
    })?;
    tokio_native_tls::TlsConnector::from(connector)
        .connect(host, stream)
        .await
        .map_err(|error| {
            StartFailure::transport(format!(
                "Failed to create response stream: TLS handshake failed: {error}"
            ))
        })
}

/// 构造 WebSocket 握手请求：URL 生成的协议必备头 + 应用 UA + 与 HTTP 传输
/// 完全相同的授权头与自定义头（协议自身的头不允许被覆盖）。
fn build_handshake_request(
    url: &Url,
    api_key: &str,
    custom_headers: &HashMap<String, String>,
) -> std::result::Result<Request<()>, StartFailure> {
    let mut request = url.as_str().into_client_request().map_err(|error| StartFailure {
        error: Error::from_reason(format!("Invalid WebSocket endpoint URL: {error}")),
        retriable: false,
        reused: false,
    })?;

    let headers = request.headers_mut();
    if let Ok(value) = HeaderValue::from_str(&app_user_agent()) {
        headers.insert(HeaderName::from_static("user-agent"), value);
    }

    // 复用 HTTP 传输的请求头构造（含 Authorization 与自定义头过滤规则）。
    let custom = super::payload::build_header_map(api_key, custom_headers).map_err(|error| {
        StartFailure {
            error,
            retriable: false,
            reused: false,
        }
    })?;
    for (name, value) in custom.iter() {
        if SKIPPED_HANDSHAKE_HEADERS
            .iter()
            .any(|skipped| name.as_str().eq_ignore_ascii_case(skipped))
        {
            continue;
        }
        let (Ok(name), Ok(value)) = (
            HeaderName::from_bytes(name.as_str().as_bytes()),
            HeaderValue::from_bytes(value.as_bytes()),
        ) else {
            continue;
        };
        headers.insert(name, value);
    }

    Ok(request)
}

/// 目标主机是否绕过代理。
///
/// `no_proxy` 支持通配 `*`、主机名与子域后缀（`example.com` / `.example.com`
/// / `*.example.com`）；回环地址恒绕过。CIDR 网段无法在纯字符串层面判断，
/// 交由代理处理（reqwest 的 HTTP 传输另行支持）。
fn host_bypasses_proxy(host: &str, no_proxy: &str) -> bool {
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    if let Ok(address) = host.parse::<std::net::IpAddr>() {
        if address.is_loopback() {
            return true;
        }
    }

    no_proxy
        .split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty() && !entry.contains('/'))
        .any(|entry| {
            if entry == "*" {
                return true;
            }
            let suffix = entry
                .strip_prefix("*.")
                .or_else(|| entry.strip_prefix('.'))
                .unwrap_or(entry);
            host.eq_ignore_ascii_case(suffix)
                || host
                    .to_ascii_lowercase()
                    .ends_with(&format!(".{}", suffix.to_ascii_lowercase()))
        })
}

// ---------------------------------------------------------------------------
// 帧处理
// ---------------------------------------------------------------------------

/// 本次请求的流式进度（累计 token、思考统计、首字延迟），
/// 字段语义与 SSE 传输完全一致——渲染层只认这一套。
struct StreamProgress {
    token_count: usize,
    thinking: ThinkingStreamTracker,
    started_at: Instant,
    ttft_ms: i64,
}

impl StreamProgress {
    fn new() -> Self {
        Self {
            token_count: 0,
            thinking: ThinkingStreamTracker::default(),
            started_at: Instant::now(),
            ttft_ms: 0,
        }
    }

    fn elapsed_ms(&self) -> i64 {
        self.started_at.elapsed().as_millis() as i64
    }

    /// 处理到第一个事件时冻结首字延迟。
    fn observe_first_event(&mut self) {
        if self.ttft_ms == 0 {
            self.ttft_ms = self.elapsed_ms();
        }
    }

    /// 推送内容 / 思考增量。
    fn emit_deltas(
        &mut self,
        on_chunk: &ResponsesApiStreamCallback,
        content_delta: String,
        thinking_delta: String,
    ) {
        // 先取下只读量：`emit_stream_chunk` 需要同时借用计数器与思考统计。
        let elapsed_ms = self.elapsed_ms();
        let ttft_ms = self.ttft_ms;
        emit_stream_chunk(
            on_chunk,
            content_delta,
            thinking_delta,
            &mut self.token_count,
            &mut self.thinking,
            elapsed_ms,
            ttft_ms,
        );
    }

    /// 推送工具参数增量（只刷新 token 探针，不进入消息正文）。
    fn emit_tool_args(&mut self, on_chunk: &ResponsesApiStreamCallback, args_delta: &str) {
        let elapsed_ms = self.elapsed_ms();
        let ttft_ms = self.ttft_ms;
        emit_tool_args_probe(
            on_chunk,
            &mut self.token_count,
            &self.thinking,
            args_delta,
            elapsed_ms,
            ttft_ms,
        );
    }

    /// 推送一次「请求重试中」状态。
    fn emit_retry(&self, on_chunk: &ResponsesApiStreamCallback, attempt: u32, retry_error: &str) {
        on_chunk.call(
            ResponsesApiStreamChunk {
                content_delta: String::new(),
                thinking_delta: String::new(),
                content: String::new(),
                thinking: String::new(),
                retrying: true,
                retry_attempt: Some((attempt + 1) as i32),
                retry_error: Some(retry_error.to_string()),
                stream_token_count: self.token_count as i64,
                thinking_token_count: self.thinking.token_count as i64,
                thinking_duration_ms: self.thinking.duration_ms(),
                elapsed_ms: self.elapsed_ms(),
                ttft_ms: self.ttft_ms,
                vision_status: None,
            },
            ThreadsafeFunctionCallMode::NonBlocking,
        );
    }
}

/// 单帧处理结果。
enum FrameOutcome {
    /// 该帧已处理完，继续读取。
    Continue,
    /// 已收到 Provider 终态事件。
    Terminal,
    /// 连接级协议错误：当前连接已不可用。
    ConnectionError { error: Error, retriable: bool },
}

/// 一次 WebSocket 尝试的读取结束方式。
enum WsReadEnd {
    /// 传输层的结束方式（终态 / EOF / 读错误 / 空闲超时 / 取消）。
    Stream(SseStreamEnd<String>),
    /// 连接级协议错误（例如服务端 60 分钟连接上限）。
    ConnectionError { error: Error, retriable: bool },
}

/// 处理一帧文本：解析事件、喂给共享解析器并推送增量。
fn process_frame(
    frame: &str,
    attempt_state: &mut ResponsesAttemptState,
    progress: &mut StreamProgress,
    on_chunk: &ResponsesApiStreamCallback,
) -> FrameOutcome {
    let Some(event) = parse_frame_event(frame) else {
        return FrameOutcome::Continue;
    };

    if event.get("type").and_then(Value::as_str) == Some("error") {
        // 已经流出内容的请求交给共享解析器按 failed 终态收尾，保留已显示的部分；
        // 否则连接级错误直接以失败结束本次请求。
        if !attempt_state.has_payload() {
            let (error, retriable) = websocket_error_event(&event);
            return FrameOutcome::ConnectionError { error, retriable };
        }
    }

    // 共享解析器按 SSE 事件块解析，这里把帧包装成一个 data 行，
    // 保证两条传输路径的事件语义（含终态判定）完全一致。
    let block = format!("data: {event}\n\n");
    let (content_delta, thinking_delta, tool_args_delta) =
        attempt_state.process_event_block(&block);
    progress.observe_first_event();
    progress.emit_deltas(on_chunk, content_delta, thinking_delta);
    progress.emit_tool_args(on_chunk, &tool_args_delta);

    if attempt_state.stream_completed_normally() {
        FrameOutcome::Terminal
    } else {
        FrameOutcome::Continue
    }
}

/// 把一帧文本解析成 Responses 事件。
///
/// 线协议本身就是 Responses 的流式事件对象；部分客户端封装会把事件再包一层
/// `{type:"message", message:{...}}`，这里一并解包以兼容两种形态。
fn parse_frame_event(frame: &str) -> Option<Value> {
    let value: Value = serde_json::from_str(frame).ok()?;
    if value.get("type").and_then(Value::as_str) == Some("message") {
        if let Some(inner) = value.get("message") {
            if inner.is_object() {
                return Some(inner.clone());
            }
        }
    }
    Some(value)
}

/// 顶层 `error` 事件 → 错误 + 是否可重试。
///
/// 连接级错误（服务端 60 分钟连接上限）意味着当前连接已不可用，换一条新连接
/// 即可继续；其余错误（鉴权、参数、模型不支持等）立即上抛。
fn websocket_error_event(event: &Value) -> (Error, bool) {
    let detail = event.get("error").unwrap_or(event);
    let code = detail
        .get("code")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let message = detail
        .get("message")
        .and_then(Value::as_str)
        .or_else(|| event.get("message").and_then(Value::as_str))
        .unwrap_or("Responses WebSocket request failed");
    let error = if code.is_empty() {
        Error::from_reason(format!("Responses WebSocket error: {message}"))
    } else {
        Error::from_reason(format!("Responses WebSocket error ({code}): {message}"))
    };

    let retriable = code == "websocket_connection_limit_reached";
    (error, retriable)
}

/// 把 HTTP 版 payload 转成 WebSocket 的 `response.create` 帧。
///
/// `stream` 在 WebSocket 下是隐式的（官方文档要求不发送），这里移除并按协议
/// 补上帧类型。`stream_id` 不发送：它只用于同一条连接上的多路复用，而本实现
/// 每条连接同一时刻只跑一个请求；且部分兼容网关会把它当成未知参数直接拒绝
/// （`Unsupported parameter: stream_id`），省略时走隐式默认 lane 即可。
fn build_create_frame(payload: &Value) -> Result<Value> {
    let mut frame = payload.clone();
    let Some(object) = frame.as_object_mut() else {
        return Err(Error::from_reason("Responses payload must be a JSON object"));
    };
    object.remove("stream");
    object.insert("type".to_string(), json!("response.create"));
    Ok(frame)
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/// 通过 WebSocket 传输执行一次 Responses 请求。
///
/// 与 `stream::collect_streaming_response` 的契约一致（连接阶段重试、传输
/// 中断恢复、取消、空响应重试），调用方无需区分传输。
#[allow(clippy::too_many_arguments)]
pub(super) async fn collect_streaming_response_ws(
    database_path: PathBuf,
    endpoint: &str,
    api_key: &str,
    custom_headers: &HashMap<String, String>,
    payload: Value,
    on_chunk: &ResponsesApiStreamCallback,
    cancel_token: &CancellationToken,
    retry_options: &RetryOptions,
    stream_idle_timeout_sec: u64,
) -> Result<StreamingResponseResult> {
    let pool_key = build_pool_key(endpoint, api_key, custom_headers);
    let frame_json = build_create_frame(&payload)?.to_string();
    let mut attempt: u32 = 0;
    let mut progress = StreamProgress::new();
    let idle_timeout = Duration::from_secs(stream_idle_timeout_sec);

    let (mut attempt_state, interruption_reason, recovery_outcome) = 'attempt_loop: loop {
        if cancel_token.is_cancelled() {
            return Ok(cancelled_stream_result(
                &progress.thinking,
                progress.started_at,
            ));
        }

        // ---- 阶段 1：复用/建立连接并发送 response.create 帧 ----
        let started = tokio::select! {
            biased;
            _ = cancel_token.cancelled() => {
                return Ok(cancelled_stream_result(&progress.thinking, progress.started_at));
            }
            result = start_attempt(&pool_key, endpoint, api_key, custom_headers, &frame_json, retry_options) => result,
        };

        let started = match started {
            Ok(started) => started,
            Err(failure) => {
                // 复用的连接在发送阶段就失效（服务端已回收）：立即换新连接重发，
                // 不等待退避——复用的收益不该被一条过期连接吃掉。
                if failure.reused {
                    continue 'attempt_loop;
                }
                if !failure.retriable || attempt >= retry_options.max_retries {
                    return Err(failure.error);
                }
                progress.emit_retry(on_chunk, attempt, &failure.error.reason);
                log_retry(&database_path, "connect", attempt, endpoint, &failure.error.reason)
                    .await;
                wait_before_retry(retry_options, cancel_token, attempt).await?;
                attempt += 1;
                continue 'attempt_loop;
            }
        };
        let mut socket = started.socket;

        // ---- 阶段 2：逐帧读取，直到终态或传输结束 ----
        let mut attempt_state = ResponsesAttemptState::default();
        let read_end = loop {
            let message = match next_stream_item_with_idle(&mut socket, cancel_token, idle_timeout)
                .await
            {
                StreamReadOutcome::Data(message) => message,
                StreamReadOutcome::ReadError(error) => {
                    break WsReadEnd::Stream(SseStreamEnd::ReadError(error.to_string()))
                }
                StreamReadOutcome::Eof => break WsReadEnd::Stream(SseStreamEnd::UnexpectedEof),
                StreamReadOutcome::IdleTimeout => {
                    break WsReadEnd::Stream(SseStreamEnd::IdleTimeout)
                }
                StreamReadOutcome::Cancelled => break WsReadEnd::Stream(SseStreamEnd::Cancelled),
            };

            match message {
                Message::Close(frame) => {
                    break WsReadEnd::Stream(match frame.as_ref() {
                        // 1000/1001 之外的服务端关闭视为读取失败（可重试）。
                        Some(frame) if !matches!(u16::from(frame.code), 1000 | 1001) => {
                            SseStreamEnd::ReadError(format!(
                                "WebSocket closed by server: {} {}",
                                u16::from(frame.code),
                                frame.reason
                            ))
                        }
                        // 对端正常关闭时缓冲区里不会再有事件：等价于流提前结束。
                        _ => SseStreamEnd::UnexpectedEof,
                    });
                }
                Message::Ping(payload) => {
                    // 服务端心跳：tungstenite 只会在下一次写入时补发 pong，
                    // 长时间只读的连接需要主动回应，避免被判为死连接。
                    if let Err(error) = socket.send(Message::Pong(payload)).await {
                        break WsReadEnd::Stream(SseStreamEnd::ReadError(format!(
                            "WebSocket pong reply failed: {error}"
                        )));
                    }
                }
                Message::Pong(_) | Message::Frame(_) => {}
                // 文本 / 二进制帧承载 JSON 事件（其余帧类型已在上方处理）。
                incoming => {
                    let text = incoming.to_text().unwrap_or_default();
                    match process_frame(text, &mut attempt_state, &mut progress, on_chunk) {
                        FrameOutcome::Continue => {}
                        FrameOutcome::Terminal => {
                            break WsReadEnd::Stream(SseStreamEnd::ProviderTerminal)
                        }
                        FrameOutcome::ConnectionError { error, retriable } => {
                            break WsReadEnd::ConnectionError { error, retriable };
                        }
                    }
                }
            }
        };

        // 拿到终态且连接本身健康的，归还连接池供后续请求复用；其余情况丢弃。
        if matches!(read_end, WsReadEnd::Stream(SseStreamEnd::ProviderTerminal)) {
            return_socket(pool_key.clone(), socket, started.created_at).await;
        }

        let stream_end = match read_end {
            WsReadEnd::ConnectionError { error, retriable } => {
                if !retriable || attempt >= retry_options.max_retries {
                    return Err(error);
                }
                progress.emit_retry(on_chunk, attempt, &error.reason);
                log_retry(&database_path, "connection_error", attempt, endpoint, &error.reason)
                    .await;
                wait_before_retry(retry_options, cancel_token, attempt).await?;
                attempt += 1;
                continue 'attempt_loop;
            }
            WsReadEnd::Stream(stream_end) => stream_end,
        };

        // 取消优先于 Provider 终态，且不留下任何中断元数据。
        if matches!(stream_end, SseStreamEnd::Cancelled) || cancel_token.is_cancelled() {
            attempt_state.finish_cancelled();
            break 'attempt_loop (attempt_state, None, None);
        }

        // Provider 终态优先于传输恢复。
        if let SseStreamEnd::ProviderTerminal = &stream_end {
            let (terminal_interruption_reason, terminal_recovery_outcome) =
                attempt_state.finalize_provider_terminal();
            if terminal_interruption_reason.is_none()
                && should_retry_empty_response(attempt, retry_options, attempt_state.has_payload())
            {
                progress.emit_retry(on_chunk, attempt, EMPTY_RESPONSE_RETRY_ERROR);
                wait_before_retry(retry_options, cancel_token, attempt).await?;
                attempt += 1;
                continue 'attempt_loop;
            }
            break 'attempt_loop (
                attempt_state,
                terminal_interruption_reason,
                terminal_recovery_outcome,
            );
        }

        let (cause, retry_error) = match stream_end {
            SseStreamEnd::ReadError(error) => (StreamEndCause::ReadError, error),
            SseStreamEnd::UnexpectedEof => (
                StreamEndCause::UnexpectedEof,
                "WebSocket closed before a Responses terminal event".to_string(),
            ),
            SseStreamEnd::IdleTimeout => (
                StreamEndCause::IdleTimeout,
                stream_idle_timeout_error().reason.clone(),
            ),
            SseStreamEnd::ProviderTerminal | SseStreamEnd::Cancelled => {
                unreachable!("terminal and cancellation are handled before transport recovery")
            }
        };
        let progress_snapshot = attempt_state.progress(cancel_token.is_cancelled());
        let decision = decide_stream_recovery(cause, attempt, retry_options, progress_snapshot);

        match decision {
            StreamRecoveryDecision::Cancelled => {
                attempt_state.finish_cancelled();
                break 'attempt_loop (attempt_state, None, None);
            }
            StreamRecoveryDecision::FinishProviderResult => {
                let (provider_reason, provider_outcome) = attempt_state.finalize_provider_terminal();
                if provider_reason.is_none()
                    && should_retry_empty_response(
                        attempt,
                        retry_options,
                        attempt_state.has_payload(),
                    )
                {
                    progress.emit_retry(on_chunk, attempt, EMPTY_RESPONSE_RETRY_ERROR);
                    wait_before_retry(retry_options, cancel_token, attempt).await?;
                    attempt += 1;
                    continue 'attempt_loop;
                }
                break 'attempt_loop (attempt_state, provider_reason, provider_outcome);
            }
            StreamRecoveryDecision::Retry => {
                progress.emit_retry(on_chunk, attempt, &retry_error);
                log_retry(
                    &database_path,
                    &format!("{cause:?}"),
                    attempt,
                    endpoint,
                    &retry_error,
                )
                .await;
                wait_before_retry(retry_options, cancel_token, attempt).await?;
                attempt += 1;
                continue 'attempt_loop;
            }
            StreamRecoveryDecision::KeepUsablePartial
            | StreamRecoveryDecision::SurfaceInterrupted => {
                let (transport_reason, transport_outcome) =
                    finalize_transport_interruption(&mut attempt_state, decision, cause);
                break 'attempt_loop (attempt_state, transport_reason, transport_outcome);
            }
        }
    };

    Ok(finalize_attempt_result(
        &mut attempt_state,
        interruption_reason,
        recovery_outcome,
        &progress.thinking,
        progress.started_at,
    ))
}

/// 记录一次重试（复用 log_api_warning：即使后续成功也留痕，便于对账）。
async fn log_retry(
    database_path: &Path,
    cause: &str,
    attempt: u32,
    endpoint: &str,
    error: &str,
) {
    log_api_warning(
        database_path,
        "create_response_stream_with_context",
        "Responses API WebSocket request retrying",
        &format!(
            "transport=websocket attempt={} cause={cause} endpoint={endpoint} error={error}",
            attempt + 1
        ),
    )
    .await;
}
