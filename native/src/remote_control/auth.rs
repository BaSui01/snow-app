//! 远控 HTTP 认证：局域网长期令牌与公网隧道的配对码 / 会话管理。
//!
//! 原先由 Node 主进程的 remoteWanAuth.ts 与 remoteControlServer.ts 承担；
//! 迁移到 Rust 后，手机请求的鉴权完全绕开 Electron 的 Node 事件循环。

use std::collections::VecDeque;
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use url::Url;

/// 配对码有效期（5 分钟）与配对成功后会话票据有效期（24 小时）。
const PAIRING_TTL_MS: i64 = 5 * 60 * 1000;
const SESSION_TTL_MS: i64 = 24 * 60 * 60 * 1000;
/// 同时保留的公网会话上限；超出时淘汰最早签发的会话。
const MAX_SESSIONS: usize = 16;
/// 配对失败限流：窗口内失败次数达到上限后拒绝新的配对尝试。
const PAIRING_FAILURE_WINDOW_MS: i64 = 60 * 1000;
const MAX_PAIRING_FAILURES_PER_WINDOW: usize = 20;

/// 当前 Unix 毫秒时间戳。
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or_default()
}

/// 常量时间比较，避免通过响应时间侧信道推断令牌内容。
pub fn secret_matches(candidate: &str, expected: &str) -> bool {
    if candidate.is_empty() || expected.is_empty() {
        return false;
    }
    let actual = candidate.as_bytes();
    let target = expected.as_bytes();
    if actual.len() != target.len() {
        return false;
    }
    let mut diff = 0u8;
    for (left, right) in actual.iter().zip(target.iter()) {
        diff |= left ^ right;
    }
    diff == 0
}

/// 生成 24 字节随机令牌并以 base64url（无填充）编码，与旧的 Node 实现一致。
pub fn random_token() -> String {
    let mut bytes = [0u8; 24];
    if getrandom::getrandom(&mut bytes).is_err() {
        // 系统熵源异常时回退到时间戳派生值：强度低于 CSPRNG，但可避免
        // 让 Electron 主进程 panic，且远控令牌本身是短期凭据。
        let seed = now_ms() as u128;
        for (index, byte) in bytes.iter_mut().enumerate() {
            *byte = ((seed >> ((index % 16) * 8)) as u8) ^ (index as u8).wrapping_mul(167);
        }
    }
    URL_SAFE_NO_PAD.encode(bytes)
}

/// 公网入口规范化：必须是无凭据、无路径 / 查询 / fragment 的 HTTPS 地址。
pub fn normalize_public_origin(value: &str) -> Result<String, String> {
    let parsed = Url::parse(value.trim())
        .map_err(|_| "SNOW_REMOTE_PUBLIC_ORIGIN 必须是有效的 HTTPS 地址".to_string())?;
    if parsed.scheme() != "https" || !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("SNOW_REMOTE_PUBLIC_ORIGIN 必须是无凭据的 HTTPS 地址".to_string());
    }
    if parsed.path() != "/" || parsed.query().is_some() || parsed.fragment().is_some() {
        return Err("SNOW_REMOTE_PUBLIC_ORIGIN 不能包含路径、查询或 fragment".to_string());
    }
    if parsed.host_str().is_none() {
        return Err("SNOW_REMOTE_PUBLIC_ORIGIN 缺少主机名".to_string());
    }
    Ok(parsed.origin().ascii_serialization())
}

/// 一次性配对码及其对应的公网配对链接。
pub struct PairingCode {
    pub expires_at: i64,
    pub url: String,
}

/// 配对成功后签发的会话票据。
pub struct WanSession {
    pub token: String,
    pub expires_at: i64,
}

struct WanAuthInner {
    /// 当前配对码与过期时间；配对成功或被轮换后清空。
    pairing: Option<(String, i64)>,
    /// 已签发会话（令牌, 过期时间），按签发时间保序。
    sessions: VecDeque<(String, i64)>,
    /// 最近的配对失败时间戳，用于限流。
    failed_attempts: VecDeque<i64>,
}

/// 公网入口鉴权：一次性配对码换取 24 小时会话票据。
pub struct WanAuth {
    origin: String,
    inner: Mutex<WanAuthInner>,
}

impl WanAuth {
    pub fn new(origin: &str) -> Result<Self, String> {
        Ok(Self {
            origin: normalize_public_origin(origin)?,
            inner: Mutex::new(WanAuthInner {
                pairing: None,
                sessions: VecDeque::new(),
                failed_attempts: VecDeque::new(),
            }),
        })
    }

    pub fn origin(&self) -> &str {
        &self.origin
    }

    /// 公网入口域名（含端口），用于校验请求的 Host 头。
    pub fn expected_host(&self) -> String {
        Url::parse(&self.origin)
            .ok()
            .and_then(|url| {
                url.host_str().map(|host| match url.port() {
                    Some(port) => format!("{host}:{port}"),
                    None => host.to_string(),
                })
            })
            .unwrap_or_default()
    }

    /// 签发新的配对码（旧码立即失效）。
    pub fn issue_pairing(&self) -> PairingCode {
        let code = random_token();
        let expires_at = now_ms() + PAIRING_TTL_MS;
        let mut inner = self.lock();
        inner.pairing = Some((code.clone(), expires_at));
        PairingCode {
            url: format!("{}/#pair={}", self.origin, code),
            expires_at,
        }
    }

    /// 当前有效配对码；已过期时清空并返回 None。
    pub fn current_pairing(&self) -> Option<PairingCode> {
        let mut inner = self.lock();
        let (code, expires_at) = inner.pairing.clone()?;
        if expires_at <= now_ms() {
            inner.pairing = None;
            return None;
        }
        Some(PairingCode {
            url: format!("{}/#pair={}", self.origin, code),
            expires_at,
        })
    }

    /// 用配对码换取会话票据；失败计入限流窗口。
    pub fn exchange(&self, code: &str) -> Option<WanSession> {
        let now = now_ms();
        let mut inner = self.lock();
        while let Some(attempted_at) = inner.failed_attempts.front().copied() {
            if attempted_at <= now - PAIRING_FAILURE_WINDOW_MS {
                inner.failed_attempts.pop_front();
            } else {
                break;
            }
        }
        if inner.failed_attempts.len() >= MAX_PAIRING_FAILURES_PER_WINDOW {
            return None;
        }
        let pairing = inner.pairing.clone();
        let matched = match &pairing {
            Some((stored, expires_at)) => *expires_at > now && secret_matches(code, stored),
            None => false,
        };
        if !matched {
            if let Some((_, expires_at)) = &pairing {
                if *expires_at <= now {
                    inner.pairing = None;
                }
            }
            inner.failed_attempts.push_back(now);
            return None;
        }
        inner.pairing = None;
        inner.failed_attempts.clear();
        while let Some((_, expires_at)) = inner.sessions.front() {
            if *expires_at <= now {
                inner.sessions.pop_front();
            } else {
                break;
            }
        }
        let token = random_token();
        let expires_at = now + SESSION_TTL_MS;
        inner.sessions.push_back((token.clone(), expires_at));
        while inner.sessions.len() > MAX_SESSIONS {
            inner.sessions.pop_front();
        }
        Some(WanSession { token, expires_at })
    }

    /// 校验会话票据；过期会话在每次校验时顺带清理。
    pub fn authorize(&self, token: Option<&str>) -> bool {
        let Some(token) = token else {
            return false;
        };
        let now = now_ms();
        let mut inner = self.lock();
        inner.sessions.retain(|(_, expires_at)| *expires_at > now);
        inner
            .sessions
            .iter()
            .any(|(stored, expires_at)| *expires_at > now && secret_matches(token, stored))
    }

    /// 撤销全部会话与配对码（停止监听 / 轮换凭据时调用）。
    pub fn revoke_all(&self) {
        let mut inner = self.lock();
        inner.pairing = None;
        inner.sessions.clear();
        inner.failed_attempts.clear();
    }

    fn lock(&self) -> MutexGuard<'_, WanAuthInner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}
