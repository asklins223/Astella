use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use serde_json::{json, Value};

use crate::gateway::{Gateway, GatewayFailure};
use crate::opened_files::uuid_v4;

/**
 * 伴星桥的页面上下文（Electron `CompanionBridge` 的 set/clear/renew 三件事）。
 *
 * - set：同页去重 → 先撤旧上下文 → 建新租约（10 秒续租一次；续租失败就撤掉，
 *   渲染层换页时会重新发布，和 Electron 的"自愈重发"口径一致但更保守）。
 * - clear：撤租约并清本地。
 * 设备/账号会话 ID 在进程内各生成一次——服务端只要求稳定可辨。
 */
struct BridgeContext {
    page: Value,
    context_id: String,
    page_instance_id: String,
    revision: Value,
    expires_at: Value,
}

static CONTEXT: OnceLock<Mutex<Option<BridgeContext>>> = OnceLock::new();
static GENERATION: AtomicU64 = AtomicU64::new(0);
static DEVICE_SESSION: OnceLock<String> = OnceLock::new();
static ACCOUNT_SESSION: OnceLock<String> = OnceLock::new();

/// 设备会话 ID：桥上下文与投递租约共用同一个（服务端按它认这具设备）。
pub fn device_session_id() -> String {
    DEVICE_SESSION.get_or_init(uuid_v4).clone()
}

fn context() -> &'static Mutex<Option<BridgeContext>> {
    CONTEXT.get_or_init(|| Mutex::new(None))
}

fn state(active: bool, revision: Value, expires_at: Value) -> Value {
    json!({ "version": 1, "active": active, "revision": revision, "expiresAt": expires_at })
}

fn inactive() -> Value {
    state(false, Value::Null, Value::Null)
}

pub async fn set_context(gateway: &mut Gateway, page: Value) -> Result<Value, GatewayFailure> {
    if !page.is_object() {
        return Err(GatewayFailure::new("validation", "user_action"));
    }
    {
        let guard = context().lock().map_err(|_| GatewayFailure::new("safe_internal_error", "never"))?;
        if let Some(current) = guard.as_ref() {
            if current.page == page {
                return Ok(state(true, current.revision.clone(), current.expires_at.clone()));
            }
        }
    }
    let previous = {
        let mut guard = context().lock().map_err(|_| GatewayFailure::new("safe_internal_error", "never"))?;
        guard.take()
    };
    if let Some(previous) = previous {
        let _ = delete_lease(gateway, &previous).await;
    }
    let generation = GENERATION.fetch_add(1, Ordering::Relaxed) + 1;
    let context_id = uuid_v4();
    let page_instance_id = uuid_v4();
    let device_session_id = DEVICE_SESSION.get_or_init(uuid_v4).clone();
    let account_session_id = ACCOUNT_SESSION.get_or_init(uuid_v4).clone();
    let (_status, body) = gateway
        .request_json(
            reqwest::Method::POST,
            "/companion/bridge/contexts",
            Some(json!({
                "contextId": context_id,
                "deviceSessionId": device_session_id,
                "pageInstanceId": page_instance_id,
                "accountSessionId": account_session_id,
                "page": page,
            })),
            true,
        )
        .await?;
    let returned_context_id = body.get("contextId").and_then(Value::as_str).unwrap_or(&context_id).to_string();
    let returned_page_instance = body.get("pageInstanceId").and_then(Value::as_str).unwrap_or(&page_instance_id).to_string();
    let revision = body.get("revision").cloned().unwrap_or(json!(1));
    let expires_at = body.get("expiresAt").cloned().unwrap_or(Value::Null);
    if body.get("contextId").is_none() && body.get("revision").is_none() {
        return Err(GatewayFailure::new("unsupported_contract", "user_action"));
    }
    let client = gateway.http_client();
    let origin = gateway.api_origin();
    let token = gateway.token().map(str::to_string);
    {
        let mut guard = context().lock().map_err(|_| GatewayFailure::new("safe_internal_error", "never"))?;
        if GENERATION.load(Ordering::Relaxed) != generation {
            return Ok(inactive());
        }
        *guard = Some(BridgeContext {
            page,
            context_id: returned_context_id.clone(),
            page_instance_id: returned_page_instance.clone(),
            revision: revision.clone(),
            expires_at: expires_at.clone(),
        });
    }
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(10)).await;
            if GENERATION.load(Ordering::Relaxed) != generation {
                return;
            }
            let expected = {
                let Ok(guard) = context().lock() else { return };
                match guard.as_ref() {
                    Some(current) if current.context_id == returned_context_id => current.revision.clone(),
                    _ => return,
                }
            };
            let mut request = client
                .post(format!("{origin}/companion/bridge/contexts/{returned_context_id}/renew"))
                .header("Accept", "application/json")
                .header("Content-Type", "application/json")
                .json(&json!({
                    "contextId": returned_context_id,
                    "pageInstanceId": returned_page_instance,
                    "expectedRevision": expected,
                }));
            if let Some(token) = &token {
                request = request.bearer_auth(token);
            }
            let Ok(response) = request.send().await else { break };
            if !response.status().is_success() {
                break;
            }
            let Ok(body) = response.json::<Value>().await else { continue };
            let Ok(mut guard) = context().lock() else { return };
            if let Some(current) = guard.as_mut() {
                if current.context_id == returned_context_id {
                    if let Some(revision) = body.get("revision") {
                        current.revision = revision.clone();
                    }
                    if let Some(expires) = body.get("expiresAt") {
                        current.expires_at = expires.clone();
                    }
                }
            }
        }
        if let Ok(mut guard) = context().lock() {
            if guard.as_ref().map(|current| current.context_id == returned_context_id).unwrap_or(false) {
                *guard = None;
            }
        }
    });
    Ok(state(true, revision, expires_at))
}

async fn delete_lease(gateway: &mut Gateway, current: &BridgeContext) -> Result<(), GatewayFailure> {
    gateway
        .request_json(
            reqwest::Method::DELETE,
            &format!("/companion/bridge/contexts/{}", current.context_id),
            Some(json!({
                "contextId": current.context_id,
                "pageInstanceId": current.page_instance_id,
                "expectedRevision": current.revision,
            })),
            true,
        )
        .await
        .map(|_| ())
}

pub async fn clear_context(gateway: &mut Gateway) -> Value {
    GENERATION.fetch_add(1, Ordering::Relaxed);
    let current = {
        let Ok(mut guard) = context().lock() else { return inactive() };
        guard.take()
    };
    if let Some(current) = current {
        let _ = delete_lease(gateway, &current).await;
    }
    inactive()
}

pub fn clear_local() {
    GENERATION.fetch_add(1, Ordering::Relaxed);
    if let Ok(mut guard) = context().lock() {
        *guard = None;
    }
}
