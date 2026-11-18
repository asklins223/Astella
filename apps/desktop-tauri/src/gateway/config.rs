use std::collections::HashMap;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::{Deserialize, Serialize};

use super::{API_SERVICE_ID, CONTRACT_VERSION};

const DEFAULT_API_ORIGIN: &str = "http://127.0.0.1:4000";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OriginKind {
    LocalLoopback,
    RemoteHttps,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GatewayConfig {
    pub api_origin: String,
    pub origin_kind: OriginKind,
    pub expected_domain_schema_revision: String,
    pub config_revision: String,
    pub pairing_key_id: Option<String>,
    pub pairing_secret: Option<Vec<u8>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConfigurationError {
    Missing,
    Invalid,
}

impl ConfigurationError {
    /// 落到 `configuration_error.reason` 的枚举值（与 Electron 版同字面量）。
    pub fn reason(self) -> &'static str {
        match self {
            ConfigurationError::Missing => "pairing_secret_missing",
            ConfigurationError::Invalid => "invalid_deployment_config",
        }
    }
}

/// 读配对密钥：`base64url`（无填充）且解码后至少 32 字节，且必须**规范**——
/// 非规范编码解出来是同一串字节，但两台机器对同一份配置算出的判据不同。
fn read_pairing_secret(value: Option<&str>) -> Option<Vec<u8>> {
    let value = value?;
    if value.is_empty() || !value.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') {
        return None;
    }
    let secret = URL_SAFE_NO_PAD.decode(value).ok()?;
    if secret.len() < 32 || URL_SAFE_NO_PAD.encode(&secret) != value {
        return None;
    }
    Some(secret)
}

fn origin_only(raw: &str) -> Option<String> {
    let url = reqwest::Url::parse(raw).ok()?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return None;
    }
    if url.path() != "/" || url.query().is_some() || url.fragment().is_some() || !url.username().is_empty() {
        return None;
    }
    Some(url.origin().ascii_serialization())
}

/// 打包安装时随资源附带的部署默认值（`deployment.json`）。生产必须是 HTTPS；
/// 字段与 Electron `desktopDeploymentEnvironment` 同一份。
pub fn apply_deployment_defaults(env: &mut HashMap<String, String>, document: &str) -> Result<(), ConfigurationError> {
    let value: serde_json::Value = serde_json::from_str(document).map_err(|_| ConfigurationError::Invalid)?;
    if value.get("version").and_then(serde_json::Value::as_u64) != Some(1) {
        return Err(ConfigurationError::Invalid);
    }
    if value.get("mode").and_then(serde_json::Value::as_str) != Some("remote_https") {
        return Err(ConfigurationError::Invalid);
    }
    let api_origin = value.get("apiOrigin").and_then(serde_json::Value::as_str).ok_or(ConfigurationError::Invalid)?;
    if !api_origin.starts_with("https://") {
        return Err(ConfigurationError::Invalid);
    }
    let revision = value
        .get("expectedDomainSchemaRevision")
        .and_then(serde_json::Value::as_str)
        .ok_or(ConfigurationError::Invalid)?;
    let config_revision = value.get("configRevision").and_then(serde_json::Value::as_str).unwrap_or("desktop-prod-v1");
    env.entry("DESKTOP_API_ORIGIN".to_string()).or_insert_with(|| api_origin.to_string());
    env.entry("ASTELLA_DOMAIN_SCHEMA_REVISION".to_string()).or_insert_with(|| revision.to_string());
    env.entry("DESKTOP_DEPLOYMENT_CONFIG_REVISION".to_string()).or_insert_with(|| config_revision.to_string());
    Ok(())
}

pub fn read_configuration(env: &HashMap<String, String>) -> Result<GatewayConfig, ConfigurationError> {
    let get = |key: &str| env.get(key).map(String::as_str).map(str::trim).filter(|v| !v.is_empty());
    let raw_origin = get("DESKTOP_API_ORIGIN").unwrap_or(DEFAULT_API_ORIGIN);
    let expected_domain_schema_revision = get("ASTELLA_DOMAIN_SCHEMA_REVISION").ok_or(ConfigurationError::Missing)?;
    let config_revision = get("DESKTOP_DEPLOYMENT_CONFIG_REVISION")
        .unwrap_or("desktop-dev-config-v1")
        .to_string();
    let api_origin = origin_only(raw_origin).ok_or(ConfigurationError::Invalid)?;

    if api_origin.starts_with("https://") {
        return Ok(GatewayConfig {
            api_origin,
            origin_kind: OriginKind::RemoteHttps,
            expected_domain_schema_revision: expected_domain_schema_revision.to_string(),
            config_revision,
            pairing_key_id: None,
            pairing_secret: None,
        });
    }

    // 明文 origin 只允许本机回环：配对密钥是这条链路上唯一可信的判据。
    let loopback = reqwest::Url::parse(&api_origin)
        .ok()
        .map(|url| matches!(url.host_str(), Some("127.0.0.1") | Some("::1") | Some("localhost")))
        .unwrap_or(false);
    if !loopback {
        return Err(ConfigurationError::Invalid);
    }
    let pairing_key_id = get("ASTELLA_DESKTOP_PAIRING_KEY_ID")
        .ok_or(ConfigurationError::Missing)?
        .to_string();
    let pairing_secret = read_pairing_secret(get("ASTELLA_DESKTOP_PAIRING_SECRET")).ok_or(ConfigurationError::Missing)?;
    Ok(GatewayConfig {
        api_origin,
        origin_kind: OriginKind::LocalLoopback,
        expected_domain_schema_revision: expected_domain_schema_revision.to_string(),
        config_revision,
        pairing_key_id: Some(pairing_key_id),
        pairing_secret: Some(pairing_secret),
    })
}

/// 信任签名消息（与 `desktopTrustSignatureMessage` 同一份，逐行 join `\n`）。
pub fn trust_signature_message(
    nonce: &str,
    service_id: &str,
    schema_revision: &str,
    pairing_key_id: &str,
    instance_id: &str,
) -> String {
    [
        "astella-local-api-trust-v1",
        nonce,
        service_id,
        CONTRACT_VERSION,
        schema_revision,
        pairing_key_id,
        instance_id,
    ]
    .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn https_origin_is_remote_without_pairing() {
        let config = read_configuration(&env(&[
            ("DESKTOP_API_ORIGIN", "https://api.astella.example"),
            ("ASTELLA_DOMAIN_SCHEMA_REVISION", "domain-r1"),
        ]))
        .expect("valid remote config");
        assert_eq!(config.origin_kind, OriginKind::RemoteHttps);
        assert!(config.pairing_secret.is_none());
        assert_eq!(config.config_revision, "desktop-dev-config-v1");
    }

    #[test]
    fn loopback_origin_requires_pairing_material() {
        let missing = read_configuration(&env(&[
            ("DESKTOP_API_ORIGIN", "http://127.0.0.1:4000"),
            ("ASTELLA_DOMAIN_SCHEMA_REVISION", "domain-r1"),
        ]));
        assert_eq!(missing, Err(ConfigurationError::Missing));

        let secret = URL_SAFE_NO_PAD.encode([7u8; 32]);
        let ok = read_configuration(&env(&[
            ("DESKTOP_API_ORIGIN", "http://127.0.0.1:4000/"),
            ("ASTELLA_DOMAIN_SCHEMA_REVISION", "domain-r1"),
            ("ASTELLA_DESKTOP_PAIRING_KEY_ID", "key-1"),
            ("ASTELLA_DESKTOP_PAIRING_SECRET", &secret),
        ]))
        .expect("valid loopback config");
        assert_eq!(ok.origin_kind, OriginKind::LocalLoopback);
        assert_eq!(ok.api_origin, "http://127.0.0.1:4000");
        assert_eq!(ok.pairing_secret.as_deref(), Some([7u8; 32].as_slice()));
    }

    #[test]
    fn rejects_non_canonical_or_short_secrets() {
        assert!(read_pairing_secret(Some("")).is_none());
        assert!(read_pairing_secret(Some("not base64url!")).is_none());
        // 31 字节：不够。
        assert!(read_pairing_secret(Some(&URL_SAFE_NO_PAD.encode([1u8; 31]))).is_none());
        // 规范编码通过。
        assert!(read_pairing_secret(Some(&URL_SAFE_NO_PAD.encode([1u8; 32]))).is_some());
    }

    #[test]
    fn rejects_plain_http_to_remote_hosts() {
        let error = read_configuration(&env(&[
            ("DESKTOP_API_ORIGIN", "http://api.astella.example"),
            ("ASTELLA_DOMAIN_SCHEMA_REVISION", "domain-r1"),
            ("ASTELLA_DESKTOP_PAIRING_KEY_ID", "key-1"),
            ("ASTELLA_DESKTOP_PAIRING_SECRET", &URL_SAFE_NO_PAD.encode([7u8; 32])),
        ]));
        assert_eq!(error, Err(ConfigurationError::Invalid));
    }

    #[test]
    fn deployment_defaults_fill_missing_env_only() {
        let document = r#"{"version":1,"mode":"remote_https","apiOrigin":"https://api.astella.example","expectedDomainSchemaRevision":"domain-r1","configRevision":"cfg-9"}"#;
        let mut env = HashMap::new();
        apply_deployment_defaults(&mut env, document).expect("valid deployment");
        assert_eq!(env.get("DESKTOP_API_ORIGIN").map(String::as_str), Some("https://api.astella.example"));
        assert_eq!(env.get("ASTELLA_DOMAIN_SCHEMA_REVISION").map(String::as_str), Some("domain-r1"));
        // 已有 env 不被覆盖（开发/冒烟用环境变量）。
        let mut overridden: HashMap<String, String> = [("DESKTOP_API_ORIGIN".to_string(), "https://other.example".to_string())].into_iter().collect();
        apply_deployment_defaults(&mut overridden, document).expect("valid deployment");
        assert_eq!(overridden.get("DESKTOP_API_ORIGIN").map(String::as_str), Some("https://other.example"));
    }

    #[test]
    fn deployment_defaults_reject_plain_http() {
        let document = r#"{"version":1,"mode":"remote_https","apiOrigin":"http://api.example","expectedDomainSchemaRevision":"d"}"#;
        assert_eq!(apply_deployment_defaults(&mut HashMap::new(), document), Err(ConfigurationError::Invalid));
    }

    #[test]
    fn trust_message_matches_the_javascript_contract() {
        // 交叉验证：Node 侧同一消息 + 32 个 0 字节的 key 得到同一签名。
        use hmac::{Hmac, Mac};
        use sha2::Sha256;
        let secret = [0u8; 32];
        let message = trust_signature_message("nonce-vector-1", API_SERVICE_ID, "domain-rev-42", "pairing-key-1", "instance-1");
        let mut mac = Hmac::<Sha256>::new_from_slice(&secret).expect("hmac key");
        mac.update(message.as_bytes());
        let signature = hex::encode(mac.finalize().into_bytes());
        assert_eq!(signature, "7ac8d4fc1d15b83c8e3ee34f1d5c02e4bf2b6b90efed922d89ec7e1d8a12d652");
    }

    #[test]
    fn contract_constants_match_shared_contract() {
        assert_eq!(CONTRACT_VERSION, "desktop-ipc-v1");
        assert_eq!(API_SERVICE_ID, "astella-api");
    }
}