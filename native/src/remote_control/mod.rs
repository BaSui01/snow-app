//! 手机远控服务的生命周期编排（原生侧）。
//!
//! 由 Node 侧 remoteControlLifecycle.ts 触发：创建 / 停止局域网监听器、
//! 管理公网回环监听器与配对状态。所有网络、磁盘与鉴权工作都在 Rust 完成，
//! Node 只负责总开关持久化与把渲染进程桥注册进来。

pub mod assets;
pub mod attachments;
pub mod auth;
pub mod bridge;
pub mod server;
pub mod unauthorized;

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, RwLock};
use std::time::Duration;

use tokio::net::TcpListener;
use tokio::sync::Mutex as AsyncMutex;

use auth::{random_token, WanAuth};
use server::{ServerContext, ServerPolicy};

/// 监听器关闭的等待上限（超过后强制中止任务）。
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(3);
/// 公网回环监听地址：只接受本机 frpc 转发过来的请求。
const WAN_HOST: &str = "127.0.0.1";

/// 启动参数（由 Node 侧解析环境变量与路径后传入）。
pub struct StartOptions {
    pub host: String,
    pub port: u16,
    /// 显式配置的局域网令牌；缺省时生成随机令牌。
    pub token: Option<String>,
    /// 移动页产物目录（out/mobile 或打包后的 unpacked 路径）。
    pub mobile_dir: PathBuf,
    /// 应用品牌图标（引导页 / favicon 共用）。
    pub icon_path: PathBuf,
    /// 可选的公网入口地址（设置了才会启动 WAN 监听器）。
    pub wan_public_origin: Option<String>,
    pub wan_port: u16,
}

/// 远控服务的对外状态快照（enabled 字段由 Node 侧补充）。
#[derive(Clone)]
pub struct RemoteControlState {
    pub running: bool,
    pub host: String,
    pub port: u16,
    pub token: String,
    pub generation: u64,
    pub wan: WanState,
}

#[derive(Clone)]
pub struct WanState {
    pub enabled: bool,
    pub local_port: u16,
    pub public_origin: String,
    pub pairing_url: String,
    pub pairing_expires_at: Option<i64>,
}

struct LanServer {
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
    join: tokio::task::JoinHandle<()>,
    host: String,
    port: u16,
    token: Arc<RwLock<String>>,
    generation: Arc<AtomicU64>,
    mobile_dir: PathBuf,
    icon_bytes: Option<Arc<Vec<u8>>>,
}

struct WanServer {
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
    join: tokio::task::JoinHandle<()>,
    port: u16,
    auth: Arc<WanAuth>,
}

static LAN_SLOT: OnceLock<Mutex<Option<LanServer>>> = OnceLock::new();
static WAN_SLOT: OnceLock<Mutex<Option<WanServer>>> = OnceLock::new();
/// 配对代数：令牌轮换 / 服务重启后自增，旧请求据此拒绝。
static GENERATION: OnceLock<Arc<AtomicU64>> = OnceLock::new();
/// 启停编排锁：start / stop / rotate / WAN 监听器操作串行执行。
static LIFECYCLE: OnceLock<AsyncMutex<()>> = OnceLock::new();

fn lan_slot() -> &'static Mutex<Option<LanServer>> {
    LAN_SLOT.get_or_init(|| Mutex::new(None))
}

fn wan_slot() -> &'static Mutex<Option<WanServer>> {
    WAN_SLOT.get_or_init(|| Mutex::new(None))
}

fn lock_lan() -> MutexGuard<'static, Option<LanServer>> {
    lan_slot()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn lock_wan() -> MutexGuard<'static, Option<WanServer>> {
    wan_slot()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn generation_counter() -> &'static Arc<AtomicU64> {
    GENERATION.get_or_init(|| Arc::new(AtomicU64::new(0)))
}

fn lifecycle() -> &'static AsyncMutex<()> {
    LIFECYCLE.get_or_init(|| AsyncMutex::new(()))
}

/// 按当前状态组装快照；查询时会为公网入口续期配对码（与旧实现一致）。
pub fn state() -> RemoteControlState {
    let (running, host, port, token) = {
        let lan = lock_lan();
        match lan.as_ref() {
            Some(server) => (
                true,
                server.host.clone(),
                server.port,
                server
                    .token
                    .read()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .clone(),
            ),
            None => (false, String::new(), 0, String::new()),
        }
    };
    let wan = {
        let wan = lock_wan();
        match wan.as_ref() {
            Some(server) => {
                let pairing = server
                    .auth
                    .current_pairing()
                    .unwrap_or_else(|| server.auth.issue_pairing());
                WanState {
                    enabled: true,
                    local_port: server.port,
                    public_origin: server.auth.origin().to_string(),
                    pairing_url: pairing.url,
                    pairing_expires_at: Some(pairing.expires_at),
                }
            }
            None => WanState {
                enabled: false,
                local_port: 0,
                public_origin: String::new(),
                pairing_url: String::new(),
                pairing_expires_at: None,
            },
        }
    };
    RemoteControlState {
        running,
        host,
        port,
        token,
        generation: generation_counter().load(Ordering::SeqCst),
        wan,
    }
}

/// 启动局域网远控服务；已运行时直接返回当前状态。
pub async fn start_server(options: StartOptions) -> Result<RemoteControlState, String> {
    let _guard = lifecycle().lock().await;
    if lock_lan().is_some() {
        return Ok(state());
    }
    if let Some(configured) = &options.token {
        if configured.chars().count() < 24 {
            return Err("SNOW_REMOTE_TOKEN 至少需要 24 个字符".to_string());
        }
    }
    let token = options
        .token
        .clone()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(random_token);
    let generation = generation_counter().clone();
    generation.fetch_add(1, Ordering::SeqCst);
    let icon_bytes = tokio::fs::read(&options.icon_path)
        .await
        .ok()
        .map(Arc::new);
    // 令牌读写共享给服务上下文：轮换后立即对后续请求生效。
    let token_shared = Arc::new(RwLock::new(token));

    let listener = TcpListener::bind((options.host.as_str(), options.port))
        .await
        .map_err(|error| format!("监听 {host}:{port} 失败：{error}", host = options.host, port = options.port))?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("读取监听端口失败：{error}"))?
        .port();

    let context = Arc::new(ServerContext {
        policy: ServerPolicy::Lan,
        mobile_dir: options.mobile_dir.clone(),
        icon_bytes: icon_bytes.clone(),
        lan_token: Some(token_shared.clone()),
        wan_auth: None,
        generation: generation.clone(),
    });
    let (shutdown, shutdown_rx) = tokio::sync::oneshot::channel();
    let app = server::router(context);
    let join = tokio::spawn(async move {
        let _ = axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await;
    });

    *lock_lan() = Some(LanServer {
        shutdown: Some(shutdown),
        join,
        host: options.host,
        port,
        token: token_shared,
        generation,
        mobile_dir: options.mobile_dir,
        icon_bytes,
    });

    if let Some(origin) = options.wan_public_origin {
        // 公网入口是可选项：配置错误或端口占用不能拖垮已就绪的局域网服务。
        let _ = start_wan_listener_locked(&origin, options.wan_port).await;
    }
    Ok(state())
}

/// 停止局域网服务与公网监听器，并失效全部在途凭据。
pub async fn stop_server() -> Result<(), String> {
    let _guard = lifecycle().lock().await;
    let lan = lock_lan().take();
    generation_counter().fetch_add(1, Ordering::SeqCst);
    server::clear_completed_sends();
    stop_wan_listener_locked().await;
    attachments::invalidate_all().await;
    if let Some(server) = lan {
        shutdown_task(server.shutdown, server.join).await;
    }
    Ok(())
}

/// 轮换局域网令牌与公网会话：等待在途发送结束后整体失效。
pub async fn rotate_token() -> Result<RemoteControlState, String> {
    let _guard = lifecycle().lock().await;
    if lock_lan().is_none() {
        return Err("手机遥控服务尚未启动".to_string());
    }
    server::wait_send_idle().await;
    {
        let mut lan = lock_lan();
        let Some(server) = lan.as_mut() else {
            return Err("手机遥控服务尚未启动".to_string());
        };
        let next_token = random_token();
        *server
            .token
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = next_token;
        server.generation.fetch_add(1, Ordering::SeqCst);
    }
    if let Some(wan) = lock_wan().as_ref() {
        wan.auth.revoke_all();
        wan.auth.issue_pairing();
    }
    server::clear_completed_sends();
    attachments::invalidate_all().await;
    Ok(state())
}

/// 启动（或替换）公网回环监听器；公网入口变更时会重新配对。
pub async fn start_wan_listener(
    public_origin: String,
    preferred_port: u16,
) -> Result<RemoteControlState, String> {
    let _guard = lifecycle().lock().await;
    start_wan_listener_locked(&public_origin, preferred_port).await?;
    Ok(state())
}

/// 停止公网回环监听器并撤销全部公网会话；局域网不受影响。
pub async fn stop_wan_listener() -> Result<(), String> {
    let _guard = lifecycle().lock().await;
    stop_wan_listener_locked().await;
    Ok(())
}

async fn start_wan_listener_locked(
    public_origin: &str,
    preferred_port: u16,
) -> Result<(), String> {
    let normalized = auth::normalize_public_origin(public_origin)?;
    let (mobile_dir, icon_bytes, generation) = {
        let lan = lock_lan();
        let Some(server) = lan.as_ref() else {
            return Err("手机遥控服务尚未启动".to_string());
        };
        (
            server.mobile_dir.clone(),
            server.icon_bytes.clone(),
            server.generation.clone(),
        )
    };
    {
        let wan = lock_wan();
        if let Some(existing) = wan.as_ref() {
            if existing.auth.origin() == normalized
                && (preferred_port == 0 || preferred_port == existing.port)
            {
                return Ok(());
            }
        }
    }

    stop_wan_listener_locked().await;
    let wan_auth = Arc::new(WanAuth::new(&normalized)?);
    let listener = TcpListener::bind((WAN_HOST, preferred_port))
        .await
        .map_err(|error| format!("监听公网隧道入口失败：{error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("读取公网隧道端口失败：{error}"))?
        .port();
    let context = Arc::new(ServerContext {
        policy: ServerPolicy::Wan,
        mobile_dir,
        icon_bytes,
        lan_token: None,
        wan_auth: Some(wan_auth.clone()),
        generation,
    });
    let (shutdown, shutdown_rx) = tokio::sync::oneshot::channel();
    let app = server::router(context);
    let join = tokio::spawn(async move {
        let _ = axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await;
    });
    wan_auth.issue_pairing();
    *lock_wan() = Some(WanServer {
        shutdown: Some(shutdown),
        join,
        port,
        auth: wan_auth,
    });
    Ok(())
}

async fn stop_wan_listener_locked() {
    let wan = lock_wan().take();
    if let Some(server) = wan {
        server.auth.revoke_all();
        shutdown_task(server.shutdown, server.join).await;
    }
}

/// 发送优雅关闭信号并等待任务退出；超时后强制中止。
async fn shutdown_task(
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
    mut join: tokio::task::JoinHandle<()>,
) {
    if let Some(sender) = shutdown {
        let _ = sender.send(());
    }
    if tokio::time::timeout(SHUTDOWN_TIMEOUT, &mut join)
        .await
        .is_err()
    {
        join.abort();
    }
}
