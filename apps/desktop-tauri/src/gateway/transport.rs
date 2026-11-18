use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use hmac::{Hmac, Mac};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::Sha256;

use super::config::{read_configuration, ConfigurationError, GatewayConfig, OriginKind};
use super::credentials::FileSessionCredentialStore;
use super::{API_SERVICE_ID, CONTRACT_VERSION};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GatewayFailure {
    pub code: &'static str,
    pub retry: &'static str,
    pub http_status: Option<u16>,
}

impl GatewayFailure {
    pub fn new(code: &'static str, retry: &'static str) -> Self {
        Self { code, retry, http_status: None }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ConnectionState {
    NotConfigured,
    ConfigurationError { reason: String },
    Checking { origin_kind: OriginKind },
    ApiUnavailable,
    ApiUntrusted { reason: String },
    Ready {
        #[serde(skip_serializing_if = "Option::is_none")]
        instance_id: Option<String>,
        schema_revision: String,
    },
}

#[derive(Deserialize)]
struct TrustChallengeResponse {
    nonce: String,
    #[serde(rename = "serviceId")]
    service_id: String,
    #[serde(rename = "ipcContractVersion")]
    ipc_contract_version: String,
    #[serde(rename = "domainSchemaRevision")]
    domain_schema_revision: String,
    #[serde(rename = "pairingKeyId")]
    pairing_key_id: String,
    #[serde(rename = "instanceId")]
    instance_id: String,
    signature: String,
}

/**
 * API 网关的传输层（迁移切片 2）。对应 Electron 的 `GatewayTransport` 中
 * 与出网、连接、凭据有关的那一半：切片 3 的 IPC 桥会把通道方法接到这里。
 *
 * 信任规则与旧壳同源：
 *  - `local_loopback`：HMAC 配对挑战 + `/health`，逐项核对 nonce/服务名/合同版本/
 *    schema 修订/配对键 id；签名用常量时间比较。
 *  - `remote_https`：TLS 之上先探 `/health`，服务名必须是 `api`。
 */
pub struct Gateway {
    config: Result<GatewayConfig, ConfigurationError>,
    credentials: Option<FileSessionCredentialStore>,
    client: reqwest::Client,
    token: Option<String>,
    connection: ConnectionState,
    instance_id: Option<String>,
    workspace_epoch: u64,
    subject_id: Option<String>,
    workspace_id: Option<String>,
}

impl Gateway {
    pub fn from_env(user_data_dir: &Path) -> Self {
        let env: HashMap<String, String> = std::env::vars().collect();
        Self::new(read_configuration(&env), Some(FileSessionCredentialStore::new(user_data_dir)))
    }

    pub fn new(config: Result<GatewayConfig, ConfigurationError>, credentials: Option<FileSessionCredentialStore>) -> Self {
        let connection = match &config {
            Ok(config) => ConnectionState::Checking { origin_kind: config.origin_kind },
            Err(error) => ConnectionState::ConfigurationError { reason: error.reason().to_string() },
        };
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("http client");
        Self { config, credentials, client, token: None, connection, instance_id: None, workspace_epoch: 1, subject_id: None, workspace_id: None }
    }

    pub fn configuration(&self) -> Result<&GatewayConfig, ConfigurationError> {
        self.config.as_ref().map_err(|error| *error)
    }

    pub fn connection(&self) -> &ConnectionState {
        &self.connection
    }

    pub fn token(&self) -> Option<&str> {
        self.token.as_deref()
    }

    pub fn workspace_epoch(&self) -> u64 {
        self.workspace_epoch
    }

    /// 当前会话的（账号, 空间）：本机草稿缓存的键由它组成，切换身份后不能串。
    pub fn identity(&self) -> Option<(&str, &str)> {
        match (&self.subject_id, &self.workspace_id) {
            (Some(subject), Some(workspace)) => Some((subject, workspace)),
            _ => None,
        }
    }

    pub fn set_identity(&mut self, subject_id: &str, workspace_id: &str) {
        self.subject_id = Some(subject_id.to_string());
        self.workspace_id = Some(workspace_id.to_string());
    }

    pub fn clear_identity(&mut self) {
        self.subject_id = None;
        self.workspace_id = None;
    }

    /** 服务端边界令牌：登录/会话读取后由调用方写回（与 Electron 的 transport.workspaceEpoch 同义）。 */
    pub fn set_workspace_epoch(&mut self, epoch: u64) {
        if epoch > self.workspace_epoch {
            self.workspace_epoch = epoch;
        }
    }

    /// 供后台续租等脱离 `&mut Gateway` 的长活任务克隆使用（Client 本身可共享）。
    pub fn http_client(&self) -> reqwest::Client {
        self.client.clone()
    }

    pub fn api_origin(&self) -> String {
        self.configuration().map(|config| config.api_origin.clone()).unwrap_or_default()
    }

    /** 伴星模型清单（切片 4）：经已登录会话向服务端要签名/会话授权下载描述。 */
    pub async fn fetch_companion_model_manifest(&mut self, model_id: &str) -> Result<serde_json::Value, GatewayFailure> {
        self.ensure_connected().await?;
        let (_, body) = self
            .request_json(reqwest::Method::GET, &format!("/companion/model/manifest?modelId={model_id}"), None, true)
            .await?;
        Ok(body)
    }

    pub fn set_token(&mut self, token: Option<String>) {
        self.token = token;
    }

    /// 运行快照里的 `sessionCredential`：本机是否有一份可恢复的会话。
    pub fn has_stored_credential(&self) -> bool {
        self.credentials.as_ref().map(FileSessionCredentialStore::has_stored).unwrap_or(false)
    }

    pub async fn restore_stored_credential(&mut self) {
        if self.token.is_some() {
            return;
        }
        if let Some(store) = &self.credentials {
            if let Some(token) = store.load().await {
                self.token = Some(token);
            }
        }
    }

    pub async fn persist_token(&self, token: &str) -> Result<(), GatewayFailure> {
        let store = self.credentials.as_ref().ok_or_else(|| GatewayFailure::new("local_storage_unavailable", "user_action"))?;
        store.save(token).await.map_err(|_| GatewayFailure::new("local_storage_unavailable", "user_action"))
    }

    /// 只清本机文件，保留内存里的令牌（「不记住」登录用）。
    pub async fn forget_stored_credential(&self) {
        if let Some(store) = &self.credentials {
            let _ = store.clear().await;
        }
    }

    pub async fn discard_token(&mut self) {
        self.token = None;
        if let Some(store) = &self.credentials {
            let _ = store.clear().await;
        }
    }

    pub async fn ensure_connected(&mut self) -> Result<(), GatewayFailure> {
        self.restore_stored_credential().await;
        if matches!(self.connection, ConnectionState::Ready { .. }) {
            return Ok(());
        }
        self.connect().await
    }

    pub async fn connect(&mut self) -> Result<(), GatewayFailure> {
        let config = match self.config.clone() {
            Ok(config) => config,
            Err(error) => {
                self.connection = ConnectionState::ConfigurationError { reason: error.reason().to_string() };
                return Err(GatewayFailure::new("configuration_error", "user_action"));
            }
        };
        self.connection = ConnectionState::Checking { origin_kind: config.origin_kind };
        let result = match config.origin_kind {
            OriginKind::LocalLoopback => self.perform_local_trust(&config).await,
            OriginKind::RemoteHttps => self.perform_remote_health(&config).await,
        };
        match result {
            Ok(()) => Ok(()),
            Err(failure) => {
                if failure.code == "api_unavailable" {
                    self.connection = ConnectionState::ApiUnavailable;
                }
                Err(failure)
            }
        }
    }

    async fn perform_local_trust(&mut self, config: &GatewayConfig) -> Result<(), GatewayFailure> {
        let (Some(pairing_key_id), Some(secret)) = (config.pairing_key_id.as_deref(), config.pairing_secret.as_deref()) else {
            return Err(GatewayFailure::new("configuration_error", "user_action"));
        };
        let mut nonce_bytes = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut nonce_bytes);
        let nonce = URL_SAFE_NO_PAD.encode(nonce_bytes);
        let challenge = json!({
            "version": 1,
            "nonce": nonce,
            "ipcContractVersion": CONTRACT_VERSION,
            "pairingKeyId": pairing_key_id,
        });
        let response = self
            .send(reqwest::Method::POST, "/_astella/desktop/trust/v1/challenge", Some(challenge), false)
            .await;
        let (status, body) = match response {
            Ok(value) => value,
            Err(failure) => {
                if failure.http_status.is_some_and(|status| (400..500).contains(&status)) {
                    let reason = if failure.http_status == Some(401) { "wrong_key" } else { "unsupported_contract" };
                    self.connection = ConnectionState::ApiUntrusted { reason: reason.to_string() };
                    return Err(GatewayFailure::new("api_untrusted", "user_action"));
                }
                return Err(failure);
            }
        };
        let parsed: TrustChallengeResponse = match serde_json::from_value(body) {
            Ok(value) => value,
            Err(_) => return self.untrusted("unsupported_contract"),
        };
        if parsed.nonce != nonce
            || parsed.service_id != API_SERVICE_ID
            || parsed.ipc_contract_version != CONTRACT_VERSION
            || parsed.pairing_key_id != pairing_key_id
            || parsed.domain_schema_revision != config.expected_domain_schema_revision
        {
            return self.untrusted("unsupported_contract");
        }
        let expected = signature(&parsed, secret)?;
        let received = match hex_decode(&parsed.signature) {
            Some(bytes) => bytes,
            None => return self.untrusted("bad_hmac"),
        };
        if expected.as_slice() != received.as_slice() {
            return self.untrusted("bad_hmac");
        }
        // `/health` 必须真的应答同一个服务：签名证明了对端握有配对密钥，
        // 这一步证明了它此刻确实在提供 API。
        let (health_status, health_body) = self.send(reqwest::Method::GET, "/health", None, false).await?;
        let health_ok = health_status < 300
            && health_body.get("status").and_then(Value::as_str) == Some("ok")
            && health_body.get("service").and_then(Value::as_str) == Some("api");
        if !health_ok {
            return self.untrusted("unsupported_contract");
        }
        self.instance_id = Some(parsed.instance_id.clone());
        self.connection = ConnectionState::Ready {
            instance_id: Some(parsed.instance_id),
            schema_revision: parsed.domain_schema_revision,
        };
        Ok(())
    }

    async fn perform_remote_health(&mut self, config: &GatewayConfig) -> Result<(), GatewayFailure> {
        let (status, body) = self.send(reqwest::Method::GET, "/health", None, false).await?;
        let healthy = status < 300
            && body.get("status").and_then(Value::as_str) == Some("ok")
            && body.get("service").and_then(Value::as_str) == Some("api");
        if !healthy {
            return self.untrusted("wrong_service");
        }
        self.connection = ConnectionState::Ready {
            instance_id: None,
            schema_revision: config.expected_domain_schema_revision.clone(),
        };
        Ok(())
    }

    fn untrusted<T>(&mut self, reason: &str) -> Result<T, GatewayFailure> {
        self.connection = ConnectionState::ApiUntrusted { reason: reason.to_string() };
        Err(GatewayFailure::new("api_untrusted", "user_action"))
    }

    /// 一个 JSON 请求。认证失败（401）会把本机保存的令牌一起作废：
    /// 服务端已经否定了它，留着只会让每个入口都再失败一次。
    pub async fn request_json(
        &mut self,
        method: reqwest::Method,
        path: &str,
        body: Option<Value>,
        authenticated: bool,
    ) -> Result<(u16, Value), GatewayFailure> {
        let result = self.send(method, path, body, authenticated).await;
        if let Err(failure) = &result {
            if authenticated && failure.code == "auth_required" {
                self.discard_token().await;
            }
        }
        result
    }

    /// 同 `request_json`，但带上幂等键（对话回合、提案决定用）。
    pub async fn request_json_with_key(
        &mut self,
        method: reqwest::Method,
        path: &str,
        body: Option<Value>,
        authenticated: bool,
        idempotency_key: &str,
    ) -> Result<(u16, Value), GatewayFailure> {
        let result = self.send_with_key(method, path, body, authenticated, Some(idempotency_key)).await;
        if let Err(failure) = &result {
            if authenticated && failure.code == "auth_required" {
                self.discard_token().await;
            }
        }
        result
    }

    /// 对话图片上传：与笔记图片同一条 multipart 管线（远程直传未移植时的本地存储路径）。
    pub async fn post_companion_image(
        &self,
        file_name: &str,
        mime_type: &str,
        bytes: Vec<u8>,
    ) -> Result<Value, GatewayFailure> {
        let config = self.configuration().map_err(|_| GatewayFailure::new("configuration_error", "user_action"))?;
        let part = reqwest::multipart::Part::bytes(bytes)
            .file_name(file_name.to_string())
            .mime_str(mime_type)
            .map_err(|_| GatewayFailure::new("validation", "user_action"))?;
        let form = reqwest::multipart::Form::new().part("file", part);
        let mut request = self.client.post(format!("{}/uploads/companion-images", config.api_origin)).multipart(form);
        if let Some(token) = &self.token {
            request = request.bearer_auth(token);
        }
        let response = request.send().await.map_err(|_| GatewayFailure::new("api_unavailable", "safe_retry"))?;
        let status = response.status();
        let payload: Value = response.json().await.unwrap_or(Value::Null);
        if !status.is_success() {
            let (code, retry) = match status.as_u16() {
                401 => ("auth_required", "user_action"),
                403 => ("forbidden", "user_action"),
                413 => ("invalid_request", "user_action"),
                415 => ("invalid_request", "user_action"),
                429 => ("rate_limited", "safe_retry"),
                _ => ("safe_internal_error", "safe_retry"),
            };
            return Err(GatewayFailure { code, retry, http_status: Some(status.as_u16()) });
        }
        Ok(json!({
            "version": 1,
            "url": payload.get("url").cloned().unwrap_or(Value::Null),
            "byteLength": payload.get("size").cloned().unwrap_or(Value::Null),
            "mimeType": payload.get("mimeType").cloned().unwrap_or(Value::Null),
            "width": payload.get("width").cloned().unwrap_or(Value::Null),
            "height": payload.get("height").cloned().unwrap_or(Value::Null),
        }))
    }

    /// Markdown 包导入附带的本机图片：multipart 回 `/uploads/import-images`，回站内地址。
    pub async fn post_import_image(&self, file_name: &str, mime_type: &str, bytes: Vec<u8>) -> Result<String, GatewayFailure> {
        let config = self.configuration().map_err(|_| GatewayFailure::new("configuration_error", "user_action"))?;
        let part = reqwest::multipart::Part::bytes(bytes)
            .file_name(file_name.to_string())
            .mime_str(mime_type)
            .map_err(|_| GatewayFailure::new("validation", "user_action"))?;
        let form = reqwest::multipart::Form::new().part("file", part);
        let mut request = self.client.post(format!("{}/uploads/import-images", config.api_origin)).multipart(form);
        if let Some(token) = &self.token {
            request = request.bearer_auth(token);
        }
        let response = request.send().await.map_err(|_| GatewayFailure::new("api_unavailable", "safe_retry"))?;
        let status = response.status();
        let body: Value = response.json().await.unwrap_or(Value::Null);
        if !status.is_success() {
            let (code, retry) = match status.as_u16() {
                401 => ("auth_required", "user_action"),
                403 => ("forbidden", "user_action"),
                413 => ("invalid_request", "user_action"),
                415 => ("invalid_request", "user_action"),
                429 => ("rate_limited", "safe_retry"),
                _ => ("safe_internal_error", "safe_retry"),
            };
            return Err(GatewayFailure { code, retry, http_status: Some(status.as_u16()) });
        }
        let url = body.get("url").and_then(Value::as_str).unwrap_or("");
        if !url.starts_with("/api/uploads/") {
            return Err(GatewayFailure::new("unsupported_contract", "user_action"));
        }
        Ok(url.to_string())
    }

    /// 头像上传：远程直传未移植时的 multipart 回退（与对话图片同一模式）。
    pub async fn post_avatar(&self, file_name: &str, mime_type: &str, bytes: Vec<u8>) -> Result<Value, GatewayFailure> {
        let config = self.configuration().map_err(|_| GatewayFailure::new("configuration_error", "user_action"))?;
        let part = reqwest::multipart::Part::bytes(bytes)
            .file_name(file_name.to_string())
            .mime_str(mime_type)
            .map_err(|_| GatewayFailure::new("validation", "user_action"))?;
        let form = reqwest::multipart::Form::new().part("file", part);
        let mut request = self.client.post(format!("{}/uploads/avatars", config.api_origin)).multipart(form);
        if let Some(token) = &self.token {
            request = request.bearer_auth(token);
        }
        let response = request.send().await.map_err(|_| GatewayFailure::new("api_unavailable", "safe_retry"))?;
        let status = response.status();
        let value: Value = response.json().await.unwrap_or(Value::Null);
        if !status.is_success() {
            let (code, retry) = match status.as_u16() {
                401 => ("auth_required", "user_action"),
                403 => ("forbidden", "user_action"),
                413 => ("invalid_request", "user_action"),
                415 => ("invalid_request", "user_action"),
                429 => ("rate_limited", "safe_retry"),
                _ => ("safe_internal_error", "safe_retry"),
            };
            return Err(GatewayFailure { code, retry, http_status: Some(status.as_u16()) });
        }
        Ok(value)
    }

    /// 笔记图片上传（本地/API 代理存储的 multipart 路径）。
    /// 远程对象存储的直传协议（storage transfers）未移植；那种部署下服务端会拒绝本路径。
    /// 对话文件上传：稿纸原件以 multipart 交给 `/uploads/companion-files`，字段 `file` + `name`。
    pub async fn post_companion_file(
        &self,
        name: &str,
        bytes: Vec<u8>,
    ) -> Result<Value, GatewayFailure> {
        let config = self.configuration().map_err(|_| GatewayFailure::new("configuration_error", "user_action"))?;
        let part = reqwest::multipart::Part::bytes(bytes)
            .file_name(name.to_string())
            .mime_str("text/markdown")
            .map_err(|_| GatewayFailure::new("validation", "user_action"))?;
        let form = reqwest::multipart::Form::new()
            .text("name", name.to_string())
            .part("file", part);
        let mut request = self.client.post(format!("{}/uploads/companion-files", config.api_origin)).multipart(form);
        if let Some(token) = &self.token {
            request = request.bearer_auth(token);
        }
        let response = request.send().await.map_err(|_| GatewayFailure::new("api_unavailable", "safe_retry"))?;
        let status = response.status();
        let value: Value = response.json().await.unwrap_or(Value::Null);
        if !status.is_success() {
            let (code, retry) = match status.as_u16() {
                401 => ("auth_required", "user_action"),
                403 => ("forbidden", "user_action"),
                413 => ("invalid_request", "user_action"),
                415 => ("invalid_request", "user_action"),
                429 => ("rate_limited", "safe_retry"),
                _ => ("safe_internal_error", "safe_retry"),
            };
            return Err(GatewayFailure { code, retry, http_status: Some(status.as_u16()) });
        }
        Ok(value)
    }

    pub async fn post_note_image(
        &self,
        note_id: &str,
        file_name: &str,
        mime_type: &str,
        bytes: Vec<u8>,
    ) -> Result<Value, GatewayFailure> {
        let config = self.configuration().map_err(|_| GatewayFailure::new("configuration_error", "user_action"))?;
        let part = reqwest::multipart::Part::bytes(bytes)
            .file_name(file_name.to_string())
            .mime_str(mime_type)
            .map_err(|_| GatewayFailure::new("validation", "user_action"))?;
        let form = reqwest::multipart::Form::new()
            .text("noteId", note_id.to_string())
            .part("file", part);
        let mut request = self.client.post(format!("{}/uploads/images", config.api_origin)).multipart(form);
        if let Some(token) = &self.token {
            request = request.bearer_auth(token);
        }
        let response = request.send().await.map_err(|_| GatewayFailure::new("api_unavailable", "safe_retry"))?;
        let status = response.status();
        let value: Value = response.json().await.unwrap_or(Value::Null);
        if !status.is_success() {
            let (code, retry) = match status.as_u16() {
                401 => ("auth_required", "user_action"),
                403 => ("forbidden", "user_action"),
                413 => ("invalid_request", "user_action"),
                415 => ("invalid_request", "user_action"),
                429 => ("rate_limited", "safe_retry"),
                _ => ("safe_internal_error", "safe_retry"),
            };
            return Err(GatewayFailure { code, retry, http_status: Some(status.as_u16()) });
        }
        Ok(value)
    }

    /// 取一段**已授权的二进制字节**（站内图片），校验内容类型前缀与大小上限。
    pub async fn request_bytes(
        &self,
        path: &str,
        accept: &str,
        content_type_prefix: &str,
        max_bytes: usize,
    ) -> Result<(String, Vec<u8>), GatewayFailure> {
        let config = self.configuration().map_err(|_| GatewayFailure::new("configuration_error", "user_action"))?;
        let url = format!("{}{}", config.api_origin, path);
        let mut request = self.client.request(reqwest::Method::GET, &url).header("Accept", accept);
        if let Some(token) = &self.token {
            request = request.bearer_auth(token);
        }
        let response = request.send().await.map_err(|_| GatewayFailure::new("api_unavailable", "safe_retry"))?;
        if !response.status().is_success() {
            let (code, retry) = match response.status().as_u16() {
                401 => ("auth_required", "user_action"),
                403 => ("forbidden", "user_action"),
                404 => ("not_found", "never"),
                429 => ("rate_limited", "safe_retry"),
                _ => ("safe_internal_error", "safe_retry"),
            };
            return Err(GatewayFailure { code, retry, http_status: Some(response.status().as_u16()) });
        }
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_string();
        if !content_type.to_ascii_lowercase().starts_with(content_type_prefix) {
            return Err(GatewayFailure::new("unsupported_contract", "user_action"));
        }
        if response.content_length().is_some_and(|length| length > max_bytes as u64) {
            return Err(GatewayFailure::new("unsupported_contract", "user_action"));
        }
        let bytes = response.bytes().await.map_err(|_| GatewayFailure::new("api_unavailable", "safe_retry"))?;
        if bytes.len() > max_bytes {
            return Err(GatewayFailure::new("unsupported_contract", "user_action"));
        }
        Ok((content_type, bytes.to_vec()))
    }

    async fn send(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<Value>,
        authenticated: bool,
    ) -> Result<(u16, Value), GatewayFailure> {
        self.send_with_key(method, path, body, authenticated, None).await
    }

    /// 终态请求（可能带 `Idempotency-Key`）：对话回合与提案决定要求它。
    async fn send_with_key(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<Value>,
        authenticated: bool,
        idempotency_key: Option<&str>,
    ) -> Result<(u16, Value), GatewayFailure> {
        let config = self.configuration().map_err(|_| GatewayFailure::new("configuration_error", "user_action"))?;
        let url = format!("{}{}", config.api_origin, path);
        let mut request = self.client.request(method, &url).header("Accept", "application/json");
        if let Some(body) = body {
            request = request.header("Content-Type", "application/json").body(body.to_string());
        }
        if let Some(key) = idempotency_key {
            request = request.header("Idempotency-Key", key);
        }
        if authenticated {
            if let Some(token) = &self.token {
                request = request.bearer_auth(token);
            }
        }
        let response = match request.send().await {
            Ok(response) => response,
            Err(error) => {
                if error.is_timeout() {
                    return Err(GatewayFailure { http_status: None, ..GatewayFailure::new("network_timeout", "safe_retry") });
                }
                return Err(GatewayFailure::new("api_unavailable", "safe_retry"));
            }
        };
        let status = response.status();
        if status.is_server_error() {
            return Err(GatewayFailure { http_status: Some(status.as_u16()), ..GatewayFailure::new("safe_internal_error", "safe_retry") });
        }
        let value: Value = if status == reqwest::StatusCode::NO_CONTENT {
            Value::Null
        } else {
            response.json().await.unwrap_or(Value::Null)
        };
        if !status.is_success() {
            let (code, retry) = match status.as_u16() {
                401 => ("auth_required", "user_action"),
                403 => ("forbidden", "user_action"),
                404 => ("not_found", "never"),
                409 => ("conflict", "resync_first"),
                413 => ("invalid_request", "user_action"),
                429 => ("rate_limited", "safe_retry"),
                _ => ("invalid_request", "user_action"),
            };
            return Err(GatewayFailure { code, retry, http_status: Some(status.as_u16()) });
        }
        Ok((status.as_u16(), value))
    }
}

fn signature(parsed: &TrustChallengeResponse, secret: &[u8]) -> Result<Vec<u8>, GatewayFailure> {
    let message = super::config::trust_signature_message(
        &parsed.nonce,
        &parsed.service_id,
        &parsed.domain_schema_revision,
        &parsed.pairing_key_id,
        &parsed.instance_id,
    );
    let mut mac = Hmac::<Sha256>::new_from_slice(secret).map_err(|_| GatewayFailure::new("configuration_error", "user_action"))?;
    mac.update(message.as_bytes());
    Ok(mac.finalize().into_bytes().to_vec())
}

fn hex_decode(value: &str) -> Option<Vec<u8>> {
    if value.len() % 2 != 0 || !value.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    (0..value.len()).step_by(2).map(|index| u8::from_str_radix(&value[index..index + 2], 16).ok()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_machine_serialises_like_the_contract() {
        let state = serde_json::to_value(ConnectionState::ApiUntrusted { reason: "bad_hmac".into() }).unwrap();
        assert_eq!(state["kind"], "api_untrusted");
        assert_eq!(state["reason"], "bad_hmac");
        let ready = serde_json::to_value(ConnectionState::Ready {
            instance_id: Some("i-1".into()),
            schema_revision: "domain-r1".into(),
        })
        .unwrap();
        assert_eq!(ready["kind"], "ready");
        assert_eq!(ready["schema_revision"], "domain-r1");
    }

    #[test]
    fn hex_decoding_rejects_bad_input() {
        assert!(hex_decode("zz").is_none());
        assert!(hex_decode("abc").is_none());
        assert_eq!(hex_decode("0aff").as_deref(), Some([0x0a, 0xff].as_slice()));
    }
}