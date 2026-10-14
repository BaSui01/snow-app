use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::api::oauth::provider::{refresh_if_needed, OAuthProviderId};
use crate::api::oauth::quota::{self, QuotaSnapshot};
use crate::api::oauth::sessions;
use crate::storage::services::api_configs as api_configs_service;
use crate::storage::{ensure_database_file, ApiConfigRecord};

#[napi(object)]
pub struct OAuthProviderInfo {
    pub id: String,
    pub display_name: String,
    pub default_model: String,
    pub default_max_context_tokens: i32,
}

#[napi(object)]
pub struct OAuthLoginStart {
    pub session_id: String,
    pub provider: String,
    pub auth_url: String,
    pub port: u32,
    pub manual_mode: bool,
    pub default_model: String,
}

#[napi(object)]
pub struct OAuthLoginStatus {
    pub provider: String,
    pub status: String,
    pub error: Option<String>,
    pub profile_name: Option<String>,
    pub display_name: Option<String>,
    pub email: Option<String>,
    pub plan_type: Option<String>,
    pub available_models: Vec<String>,
    pub auth_url: String,
    pub manual_mode: bool,
}

fn to_status(view: sessions::OAuthStatusView) -> OAuthLoginStatus {
    let outcome = view.outcome;
    OAuthLoginStatus {
        provider: view.provider.as_str().to_string(),
        status: view.status.to_string(),
        error: view.error,
        profile_name: outcome.as_ref().map(|outcome| outcome.profile_name.clone()),
        display_name: outcome.as_ref().map(|outcome| outcome.display_name.clone()),
        email: outcome.as_ref().map(|outcome| outcome.email.clone()),
        plan_type: outcome.as_ref().map(|outcome| outcome.plan_type.clone()),
        available_models: outcome
            .as_ref()
            .map(|outcome| outcome.available_models.clone())
            .unwrap_or_default(),
        auth_url: view.auth_url,
        manual_mode: view.manual_mode,
    }
}

fn parse_provider(value: &str) -> Result<OAuthProviderId> {
    OAuthProviderId::parse(value).ok_or_else(|| {
        Error::from_reason(format!("Unsupported OAuth provider: {}", value.trim()))
    })
}

#[napi(js_name = "listOAuthProviders")]
pub fn list_oauth_providers() -> Vec<OAuthProviderInfo> {
    OAuthProviderId::all()
        .iter()
        .map(|provider| OAuthProviderInfo {
            id: provider.as_str().to_string(),
            display_name: provider.display_name().to_string(),
            default_model: provider.default_model().to_string(),
            default_max_context_tokens: provider.default_max_context_tokens(),
        })
        .collect()
}

#[napi(js_name = "startOAuthLogin")]
pub async fn start_oauth_login(
    provider: String,
    advanced_model: Option<String>,
    basic_model: Option<String>,
) -> Result<OAuthLoginStart> {
    let provider = parse_provider(&provider)?;
    let result = sessions::start_login(provider, advanced_model, basic_model).await?;
    Ok(OAuthLoginStart {
        session_id: result.session_id,
        provider: result.provider.as_str().to_string(),
        auth_url: result.auth_url,
        port: result.port as u32,
        manual_mode: result.manual_mode,
        default_model: result.default_model,
    })
}

#[napi(js_name = "getOAuthLoginStatus")]
pub async fn get_oauth_login_status(session_id: String) -> Result<Option<OAuthLoginStatus>> {
    Ok(sessions::get_status(session_id.trim()).map(to_status))
}

#[napi(js_name = "submitOAuthCallback")]
pub async fn submit_oauth_callback(
    session_id: String,
    callback_url: String,
) -> Result<OAuthLoginStatus> {
    let session_id = session_id.trim().to_string();
    let Some(session) = sessions::get_session(&session_id) else {
        return Err(Error::from_reason("Login session not found or expired"));
    };

    let params = sessions::parse_callback_input(&callback_url);
    if params.is_empty() {
        return Err(Error::from_reason("The callback URL is empty or invalid"));
    }

    sessions::handle_callback_request(&session, &params)
        .await
        .map_err(Error::from_reason)?;

    sessions::get_status(&session_id)
        .map(to_status)
        .ok_or_else(|| Error::from_reason("Login session not found or expired"))
}

#[napi(js_name = "cancelOAuthLogin")]
pub async fn cancel_oauth_login(session_id: String) -> Result<bool> {
    Ok(sessions::cancel_login(session_id.trim()))
}

#[napi(object)]
pub struct OAuthQuotaBucket {
    pub key: String,
    pub label: String,
    pub remaining_percent: Option<f64>,
    pub reset_at_ms: Option<f64>,
}

#[napi(object)]
pub struct OAuthQuotaGroup {
    pub id: String,
    pub label: String,
    pub buckets: Vec<OAuthQuotaBucket>,
}

#[napi(object)]
pub struct OAuthQuotaSnapshot {
    pub provider: String,
    pub plan: Option<String>,
    pub groups: Vec<OAuthQuotaGroup>,
    pub fetched_at_ms: f64,
}

fn to_quota_snapshot(snapshot: QuotaSnapshot) -> OAuthQuotaSnapshot {
    OAuthQuotaSnapshot {
        provider: snapshot.provider,
        plan: snapshot.plan,
        groups: snapshot
            .groups
            .into_iter()
            .map(|group| OAuthQuotaGroup {
                id: group.id,
                label: group.label,
                buckets: group
                    .buckets
                    .into_iter()
                    .map(|bucket| OAuthQuotaBucket {
                        key: bucket.key,
                        label: bucket.label,
                        remaining_percent: bucket.remaining_percent,
                        reset_at_ms: bucket.reset_at_ms,
                    })
                    .collect(),
            })
            .collect(),
        fetched_at_ms: snapshot.fetched_at_ms,
    }
}

async fn load_api_config(profile_name: String) -> Result<ApiConfigRecord> {
    tokio::task::spawn_blocking(move || -> Result<ApiConfigRecord> {
        let database_path = ensure_database_file()?;
        api_configs_service::list_api_configs(&database_path)?
            .into_iter()
            .find(|config| config.profile_name == profile_name)
            .ok_or_else(|| Error::from_reason("API profile not found"))
    })
    .await
    .map_err(|error| Error::from_reason(format!("Failed to load API profile: {error}")))?
}

#[napi(js_name = "getOAuthQuota")]
pub async fn get_oauth_quota(profile_name: String) -> Result<OAuthQuotaSnapshot> {
    let config = load_api_config(profile_name.trim().to_string()).await?;
    let config = refresh_if_needed(config).await?;
    let snapshot = quota::fetch_snapshot(&config).await?;
    Ok(to_quota_snapshot(snapshot))
}
