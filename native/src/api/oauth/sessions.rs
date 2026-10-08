use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use napi::bindgen_prelude::*;
use tokio::sync::oneshot;

use super::{anthropic, antigravity, codex};
use super::provider::{self, OAuthProfileMetadata, OAuthProviderId};
use crate::storage::ensure_database_file;

const LOGIN_SESSION_TIMEOUT_SECS: u64 = 15 * 60;

#[derive(Clone)]
pub struct OAuthLoginSession {
    pub session_id: String,
    pub provider: OAuthProviderId,
    pub state: String,
    pub code_verifier: String,
    pub redirect_uri: String,
    pub auth_url: String,
    pub local_port: u16,
    pub advanced_model: String,
    pub basic_model: String,
}

#[derive(Clone)]
pub struct OAuthLoginOutcome {
    pub provider: OAuthProviderId,
    pub profile_name: String,
    pub display_name: String,
    pub email: String,
    pub plan_type: String,
    pub account_id: String,
    pub available_models: Vec<String>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum OAuthLoginStatus {
    Pending,
    Success,
    Error,
    Cancelled,
}

impl OAuthLoginStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            OAuthLoginStatus::Pending => "pending",
            OAuthLoginStatus::Success => "success",
            OAuthLoginStatus::Error => "error",
            OAuthLoginStatus::Cancelled => "cancelled",
        }
    }
}

pub struct OAuthLoginEntry {
    pub session: OAuthLoginSession,
    pub status: OAuthLoginStatus,
    pub error: Option<String>,
    pub outcome: Option<OAuthLoginOutcome>,
    pub shutdown: Option<oneshot::Sender<()>>,
    pub completing: bool,
}

static SESSIONS: LazyLock<Mutex<HashMap<String, OAuthLoginEntry>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn lock_sessions() -> std::sync::MutexGuard<'static, HashMap<String, OAuthLoginEntry>> {
    SESSIONS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub struct StartLoginResult {
    pub session_id: String,
    pub provider: OAuthProviderId,
    pub auth_url: String,
    pub port: u16,
    pub manual_mode: bool,
    pub default_model: String,
}

pub async fn start_login(
    provider: OAuthProviderId,
    advanced_model: Option<String>,
    basic_model: Option<String>,
) -> Result<StartLoginResult> {
    let pkce = provider::generate_pkce()?;
    let state = provider::generate_state()?;
    let session_id = uuid::Uuid::new_v4().to_string();

    let preferred_ports = provider.callback_ports();
    let mut listener = None;
    let mut port = 0u16;
    for candidate in preferred_ports {
        if let Ok(bound) = tokio::net::TcpListener::bind(("127.0.0.1", *candidate)).await {
            listener = Some(bound);
            port = *candidate;
            break;
        }
    }
    let manual_mode = listener.is_none();
    if port == 0 {
        if let Some(first) = preferred_ports.first() {
            port = *first;
        }
    }

    let redirect_uri = if port > 0 {
        format!(
            "http://{}:{}{}",
            provider.redirect_host(),
            port,
            provider.callback_path()
        )
    } else {
        format!(
            "http://{}{}",
            provider.redirect_host(),
            provider.callback_path()
        )
    };
    let auth_url = provider::build_authorize_url(provider, &redirect_uri, &pkce, &state)?;

    let session = OAuthLoginSession {
        session_id: session_id.clone(),
        provider,
        state,
        code_verifier: pkce.verifier,
        redirect_uri,
        auth_url: auth_url.clone(),
        local_port: if manual_mode { 0 } else { port },
        advanced_model: advanced_model.unwrap_or_default().trim().to_string(),
        basic_model: basic_model.unwrap_or_default().trim().to_string(),
    };

    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    if let Some(listener) = listener {
        let server_session = session.clone();
        tokio::spawn(super::server::serve_callback(
            listener,
            server_session,
            shutdown_rx,
        ));
    } else {
        drop(shutdown_rx);
    }

    {
        let mut sessions = lock_sessions();
        sessions.insert(
            session_id.clone(),
            OAuthLoginEntry {
                session,
                status: OAuthLoginStatus::Pending,
                error: None,
                outcome: None,
                shutdown: Some(shutdown_tx),
                completing: false,
            },
        );
    }

    let timeout_session_id = session_id.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(LOGIN_SESSION_TIMEOUT_SECS)).await;
        let still_pending = {
            let sessions = lock_sessions();
            sessions
                .get(&timeout_session_id)
                .map(|entry| entry.status == OAuthLoginStatus::Pending)
                .unwrap_or(false)
        };
        if still_pending {
            cancel_login(&timeout_session_id);
        }
    });

    Ok(StartLoginResult {
        session_id,
        provider,
        auth_url,
        port,
        manual_mode,
        default_model: provider.default_model().to_string(),
    })
}

pub struct OAuthStatusView {
    pub provider: OAuthProviderId,
    pub status: &'static str,
    pub error: Option<String>,
    pub outcome: Option<OAuthLoginOutcome>,
    pub auth_url: String,
    pub manual_mode: bool,
}

pub fn get_status(session_id: &str) -> Option<OAuthStatusView> {
    let sessions = lock_sessions();
    let entry = sessions.get(session_id)?;
    Some(OAuthStatusView {
        provider: entry.session.provider,
        status: entry.status.as_str(),
        error: entry.error.clone(),
        outcome: entry.outcome.clone(),
        auth_url: entry.session.auth_url.clone(),
        manual_mode: entry.session.local_port == 0,
    })
}

pub fn get_session(session_id: &str) -> Option<OAuthLoginSession> {
    let sessions = lock_sessions();
    sessions.get(session_id).map(|entry| entry.session.clone())
}

pub fn cancel_login(session_id: &str) -> bool {
    let mut sessions = lock_sessions();
    let Some(entry) = sessions.get_mut(session_id) else {
        return false;
    };
    if entry.status != OAuthLoginStatus::Pending {
        return false;
    }
    if let Some(sender) = entry.shutdown.take() {
        let _ = sender.send(());
    }
    entry.status = OAuthLoginStatus::Cancelled;
    true
}

pub fn parse_callback_input(raw: &str) -> HashMap<String, String> {
    let trimmed = raw.trim();
    let mut params = HashMap::new();
    if trimmed.is_empty() {
        return params;
    }

    let query = trimmed
        .split_once('?')
        .map(|(_, rest)| rest)
        .unwrap_or(trimmed);
    let query = query.split('#').next().unwrap_or(query);

    if query.contains('=') {
        for pair in query.split('&') {
            let Some((key, value)) = pair.split_once('=') else {
                continue;
            };
            let decoded = url::form_urlencoded::parse(value.as_bytes())
                .map(|(value, _)| value.into_owned())
                .collect::<String>();
            if !key.is_empty() {
                params.insert(key.to_string(), decoded);
            }
        }
    } else {
        let state = trimmed
            .split_once('#')
            .map(|(_, state)| state.trim())
            .filter(|state| !state.is_empty());
        if !query.is_empty() {
            params.insert("raw_code".to_string(), query.to_string());
        }
        if let Some(state) = state {
            params.insert("state".to_string(), state.to_string());
        }
    }

    params
}

pub async fn handle_callback_request(
    session: &OAuthLoginSession,
    params: &HashMap<String, String>,
) -> std::result::Result<(), String> {
    if let Some(error) = params.get("error").filter(|value| !value.trim().is_empty()) {
        let description = params
            .get("error_description")
            .map(String::as_str)
            .unwrap_or("");
        let message = if description.trim().is_empty() {
            format!("Authorization failed: {error}")
        } else {
            format!("Authorization failed: {description}")
        };
        set_session_error(&session.session_id, message.clone());
        return Err(message);
    }

    let state = params.get("state").map(String::as_str).unwrap_or("");
    if !state.is_empty() && state != session.state {
        return Err("Authorization state mismatch; please restart the login".to_string());
    }

    let code = params
        .get("code")
        .or_else(|| params.get("raw_code"))
        .map(String::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Missing authorization code".to_string())?
        .to_string();

    complete_login(session, &code)
        .await
        .map(|_| ())
        .map_err(|error| error.reason.clone())
}

fn set_session_error(session_id: &str, message: String) {
    let mut sessions = lock_sessions();
    if let Some(entry) = sessions.get_mut(session_id) {
        if entry.status == OAuthLoginStatus::Pending {
            entry.status = OAuthLoginStatus::Error;
            entry.error = Some(message);
        }
    }
}

fn finish_session(session_id: &str, result: &Result<OAuthLoginOutcome>) {
    let mut sessions = lock_sessions();
    let Some(entry) = sessions.get_mut(session_id) else {
        return;
    };
    entry.completing = false;
    match result {
        Ok(outcome) => {
            entry.status = OAuthLoginStatus::Success;
            entry.outcome = Some(outcome.clone());
            entry.error = None;
        }
        Err(error) => {
            if entry.status == OAuthLoginStatus::Pending {
                entry.status = OAuthLoginStatus::Error;
                entry.error = Some(error.reason.clone());
            }
        }
    }
    if let Some(sender) = entry.shutdown.take() {
        let _ = sender.send(());
    }
}

async fn complete_login(
    session: &OAuthLoginSession,
    code: &str,
) -> Result<OAuthLoginOutcome> {
    {
        let mut sessions = lock_sessions();
        let Some(entry) = sessions.get_mut(&session.session_id) else {
            return Err(Error::from_reason("Login session not found or expired"));
        };
        if matches!(entry.status, OAuthLoginStatus::Success) {
            if let Some(outcome) = entry.outcome.clone() {
                return Ok(outcome);
            }
        }
        if entry.completing {
            return Err(Error::from_reason("Login is already being completed"));
        }
        entry.completing = true;
    }

    let result = perform_login(session, code).await;
    finish_session(&session.session_id, &result);
    result
}

async fn perform_login(session: &OAuthLoginSession, code: &str) -> Result<OAuthLoginOutcome> {
    let provider = session.provider;
    let tokens = provider::exchange_code(
        provider,
        code,
        &session.redirect_uri,
        &session.code_verifier,
        &session.state,
    )
    .await?;
    let claims = match provider {
        OAuthProviderId::Codex => codex::parse_claims(&tokens.id_token),
        OAuthProviderId::Anthropic => anthropic::parse_claims(&tokens),
        OAuthProviderId::Antigravity => antigravity::parse_claims(&tokens),
    };
    let metadata = OAuthProfileMetadata {
        provider,
        refresh_token: tokens.refresh_token.clone(),
        account_id: claims.account_id.clone(),
        email: claims.email.clone(),
        plan_type: claims.plan_type.clone(),
        expires_at: tokens.expires_at,
    };

    let available_models =
        match provider::fetch_models(provider, &tokens.access_token, &claims.account_id).await {
            Ok(models) => models,
            Err(_) => Vec::new(),
        };

    let advanced_model = pick_model(provider, &session.advanced_model, &available_models);
    let basic_model = pick_model(provider, &session.basic_model, &available_models);

    let prepared = provider::prepare_profile(
        provider,
        &claims,
        &metadata,
        &tokens.access_token,
        &advanced_model,
        &basic_model,
    );
    let database_path = ensure_database_file()?;
    provider::persist_profile(database_path, prepared.input).await?;

    Ok(OAuthLoginOutcome {
        provider,
        profile_name: prepared.profile_name,
        display_name: prepared.display_name,
        email: claims.email,
        plan_type: claims.plan_type,
        account_id: claims.account_id,
        available_models,
    })
}

fn pick_model(provider: OAuthProviderId, configured: &str, available: &[String]) -> String {
    let configured = configured.trim();
    if !configured.is_empty() {
        return configured.to_string();
    }
    if let Some(first) = available.first() {
        return first.clone();
    }
    provider.default_model().to_string()
}
