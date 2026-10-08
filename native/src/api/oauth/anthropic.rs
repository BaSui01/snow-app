use std::collections::HashMap;
use std::time::Duration;

use napi::bindgen_prelude::*;
use serde::Serialize;
use serde_json::Value;

use super::provider::{now_epoch_secs, OAuthClaims, OAuthTokenSet};
use crate::api::http_client::{build_proxied_client_with_timeout, load_proxy_config_sync};

pub const CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
pub const DEFAULT_MODEL: &str = "claude-sonnet-4-6";
pub const BACKEND_BASE_URL: &str = "https://api.anthropic.com";
pub const CALLBACK_PATH: &str = "/callback";
pub const CALLBACK_PORTS: &[u16] = &[54545];

const AUTHORIZE_URL: &str = "https://claude.ai/oauth/authorize";
const TOKEN_URL: &str = "https://platform.claude.com/v1/oauth/token";
const OAUTH_BETA: &str = "oauth-2025-04-20";
const ANTHROPIC_VERSION: &str = "2023-06-01";
const OAUTH_SCOPE: &str =
    "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
const OAUTH_TOKEN_PREFIX: &str = "sk-ant-oat";
const HTTP_TIMEOUT_SECS: u64 = 30;
const MODELS_TIMEOUT_SECS: u64 = 15;
const MODELS_LIMIT: u32 = 1000;

pub fn is_oauth_access_token(api_key: &str) -> bool {
    api_key.trim().starts_with(OAUTH_TOKEN_PREFIX)
}

pub fn build_authorize_url(redirect_uri: &str, challenge: &str, state: &str) -> Result<String> {
    let mut url = reqwest::Url::parse(AUTHORIZE_URL)
        .map_err(|error| Error::from_reason(format!("Invalid authorize URL: {error}")))?;
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("code", "true");
        query.append_pair("client_id", CLIENT_ID);
        query.append_pair("response_type", "code");
        query.append_pair("redirect_uri", redirect_uri);
        query.append_pair("scope", OAUTH_SCOPE);
        query.append_pair("code_challenge", challenge);
        query.append_pair("code_challenge_method", "S256");
        query.append_pair("state", state);
    }
    Ok(url.to_string())
}

fn split_code_and_state(raw: &str) -> (String, String) {
    let trimmed = raw.trim();
    match trimmed.split_once('#') {
        Some((code, state)) => (code.trim().to_string(), state.trim().to_string()),
        None => (trimmed.to_string(), String::new()),
    }
}

// 键序与 Claude Code 客户端保持一致，服务端按此形状识别请求。
#[derive(Serialize)]
struct AuthorizationCodeExchange<'a> {
    grant_type: &'a str,
    code: &'a str,
    redirect_uri: &'a str,
    client_id: &'a str,
    code_verifier: &'a str,
    state: &'a str,
}

#[derive(Serialize)]
struct RefreshTokenRequest<'a> {
    client_id: &'a str,
    grant_type: &'a str,
    refresh_token: &'a str,
    scope: &'a str,
}

fn apply_oauth_headers(
    request: reqwest::RequestBuilder,
) -> reqwest::RequestBuilder {
    request
        .header(reqwest::header::ACCEPT, "application/json, text/plain, */*")
        .header(reqwest::header::USER_AGENT, "axios/1.15.2")
        .header(reqwest::header::CONNECTION, "close")
}

pub async fn exchange_code(
    code: &str,
    redirect_uri: &str,
    code_verifier: &str,
    state: &str,
) -> Result<OAuthTokenSet> {
    let (code, embedded_state) = split_code_and_state(code);
    if code.is_empty() {
        return Err(Error::from_reason("Authorization code is empty"));
    }
    let state = if embedded_state.is_empty() {
        state.trim().to_string()
    } else {
        embedded_state
    };
    let body = AuthorizationCodeExchange {
        grant_type: "authorization_code",
        code: &code,
        redirect_uri,
        client_id: CLIENT_ID,
        code_verifier,
        state: &state,
    };
    let client = build_proxied_client_with_timeout(Duration::from_secs(HTTP_TIMEOUT_SECS)).await?;
    let response = apply_oauth_headers(client.post(TOKEN_URL))
        .json(&body)
        .send()
        .await
        .map_err(|error| Error::from_reason(format!("Token exchange request failed: {error}")))?;
    read_token_response(response).await
}

pub async fn refresh_tokens(refresh_token: &str) -> Result<OAuthTokenSet> {
    let body = RefreshTokenRequest {
        client_id: CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token,
        scope: OAUTH_SCOPE,
    };
    let client = build_proxied_client_with_timeout(Duration::from_secs(HTTP_TIMEOUT_SECS)).await?;
    let response = apply_oauth_headers(client.post(TOKEN_URL))
        .json(&body)
        .send()
        .await
        .map_err(|error| Error::from_reason(format!("Token refresh failed: {error}")))?;
    read_token_response(response).await
}

async fn read_token_response(response: reqwest::Response) -> Result<OAuthTokenSet> {
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(Error::from_reason(format!(
            "Token request failed: {status} {body}"
        )));
    }
    parse_token_response(&body)
}

fn parse_token_response(body: &str) -> Result<OAuthTokenSet> {
    let parsed: Value = serde_json::from_str(body)
        .map_err(|error| Error::from_reason(format!("Invalid token response: {error}")))?;

    let access_token = parsed
        .get("access_token")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    if access_token.is_empty() {
        return Err(Error::from_reason(
            "Token response did not include an access token",
        ));
    }

    let expires_in = parsed
        .get("expires_in")
        .and_then(Value::as_i64)
        .unwrap_or(3600);
    let email = parsed
        .get("account")
        .and_then(|account| account.get("email_address"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();

    Ok(OAuthTokenSet {
        access_token,
        refresh_token: parsed
            .get("refresh_token")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        id_token: String::new(),
        email,
        plan_type: String::new(),
        project_id: String::new(),
        expires_at: now_epoch_secs() + expires_in,
    })
}

pub fn parse_claims(tokens: &OAuthTokenSet) -> OAuthClaims {
    OAuthClaims {
        email: tokens.email.trim().to_string(),
        account_id: String::new(),
        plan_type: String::new(),
    }
}

fn models_url(base_url: &str) -> String {
    let normalized = base_url.trim().trim_end_matches('/');
    let base = if normalized.is_empty() {
        BACKEND_BASE_URL
    } else {
        normalized
    };
    format!("{base}/v1/models?limit={MODELS_LIMIT}")
}

fn parse_models_payload(body: &str) -> Result<Vec<String>> {
    let parsed: Value = serde_json::from_str(body)
        .map_err(|error| Error::from_reason(format!("Invalid model list: {error}")))?;
    let items = parsed
        .get("data")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let mut models = Vec::new();
    for item in items {
        let id = item
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        if let Some(id) = id {
            if !models.contains(&id) {
                models.push(id);
            }
        }
    }
    Ok(models)
}

pub async fn fetch_models(access_token: &str) -> Result<Vec<String>> {
    let client = build_proxied_client_with_timeout(Duration::from_secs(HTTP_TIMEOUT_SECS)).await?;
    let response = client
        .get(models_url(BACKEND_BASE_URL))
        .header(reqwest::header::ACCEPT, "application/json")
        .header(
            reqwest::header::AUTHORIZATION,
            format!("Bearer {access_token}"),
        )
        .header("anthropic-version", ANTHROPIC_VERSION)
        .header("anthropic-beta", OAUTH_BETA)
        .send()
        .await
        .map_err(|error| Error::from_reason(format!("Model list request failed: {error}")))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(Error::from_reason(format!(
            "Model list request failed: {status} {body}"
        )));
    }

    parse_models_payload(&body)
}

pub fn fetch_models_blocking(base_url: &str, access_token: &str) -> Result<Vec<String>> {
    let proxy_config = load_proxy_config_sync()?;
    let client = proxy_config
        .apply_blocking(
            reqwest::blocking::Client::builder()
                .timeout(Duration::from_secs(MODELS_TIMEOUT_SECS)),
        )?
        .build()
        .map_err(|error| Error::from_reason(format!("Failed to create HTTP client: {error}")))?;

    let response = client
        .get(models_url(base_url))
        .header(reqwest::header::ACCEPT, "application/json")
        .header(
            reqwest::header::AUTHORIZATION,
            format!("Bearer {access_token}"),
        )
        .header("anthropic-version", ANTHROPIC_VERSION)
        .header("anthropic-beta", OAUTH_BETA)
        .send()
        .map_err(|error| Error::from_reason(format!("Model list request failed: {error}")))?;

    let status = response.status();
    let body = response.text().unwrap_or_default();
    if !status.is_success() {
        return Err(Error::from_reason(format!(
            "Model list request failed: {status} {body}"
        )));
    }

    parse_models_payload(&body)
}

pub fn apply_request_headers(headers: &mut HashMap<String, String>) {
    headers.insert(
        "anthropic-version".to_string(),
        ANTHROPIC_VERSION.to_string(),
    );
    headers.insert("anthropic-beta".to_string(), OAUTH_BETA.to_string());
}
