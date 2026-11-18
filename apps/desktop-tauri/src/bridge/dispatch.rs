use serde_json::{json, Value};
use yrs::Map;

use crate::gateway::{ConnectionState, Gateway, GatewayFailure, CONTRACT_VERSION};

use std::sync::Arc;

use super::{contract, session};
use crate::companion_model::{ModelRegistry, Progress, MODEL_IDS};
use tauri::Manager;

const APP_ID: &str = "com.astella.desktop";

/**
 * 渲染层通道分发（迁移切片 3）。
 *
 * 一条入口 `astella_invoke(channel, input)`：`window.astella` 的每个方法都落到
 * 这里，按 Electron 的通道名分派。返回信封与 `GatewayResultV1` 同形——
 * 渲染层的 `unwrapGatewayResult` 与错误分类表只认这个形状。
 *
 * 未移植的通道一律 `feature_disabled`（"这项能力当前未在本环境启用"），
 * 而不是假装服务不可用：那是诚实的缺口，不会让人去查网络。
 */
pub async fn invoke(
    gateway: &mut Gateway,
    models: &Arc<ModelRegistry>,
    app: Option<&tauri::AppHandle>,
    channel: &str,
    input: &Value,
) -> Value {
    let meta = input.get("meta").cloned().unwrap_or(Value::Null);
    match channel {
        "astella.v1.runtime.getSnapshot" => ok(&meta, runtime_snapshot(gateway)),
        "astella.v1.runtime.retryApiConnection" => match gateway.connect().await {
            Ok(()) => ok(&meta, connection_json(gateway.connection())),
            Err(failure) => err(&meta, &failure),
        },
        "astella.v1.runtime.getHealth" => match gateway.ensure_connected().await {
            Ok(()) => match gateway.request_json(reqwest::Method::GET, "/health", None, false).await {
                Ok((_status, body)) => ok(&meta, body),
                Err(failure) => err(&meta, &failure),
            },
            Err(failure) => err(&meta, &failure),
        },
        "astella.v1.auth.getState" => auth_state(gateway, &meta).await,
        "astella.v1.auth.login" => login(gateway, input, &meta).await,
        "astella.v1.auth.logout" => auth_logout(gateway, input, &meta).await,
        "astella.v1.auth.register" => auth_register(gateway, input, &meta).await,
        "astella.v1.auth.joinWorkspace" => auth_join_workspace(gateway, input, &meta).await,
        "astella.v1.auth.leaveWorkspace" => auth_leave_workspace(gateway, input, &meta).await,
        "astella.v1.auth.changePassword" => auth_change_password(gateway, input, &meta).await,
        "astella.v1.auth.getProfile" => auth_get_profile(gateway, &meta).await,
        "astella.v1.auth.updateProfile" => auth_update_profile(gateway, input, &meta).await,
        "astella.v1.auth.getAvatar" => auth_get_avatar(gateway, input, &meta).await,
        "astella.v1.auth.uploadAvatar" => auth_upload_avatar(gateway, input, &meta).await,
        "astella.v1.auth.getRememberedAccount" => ok(&meta, Value::Null),
        "astella.v1.auth.forgetRememberedAccount" => ok(&meta, json!({ "forgotten": true })),
        "astella.v1.auth.resumeRememberedAccount" => err(&meta, &GatewayFailure::new("auth_required", "user_action")),
        "astella.v1.companion.model.state" => companion_model_state(models, input, &meta).await,
        "astella.v1.companion.model.download" => companion_model_download(gateway, models, input, &meta).await,
        "astella.v1.companion.model.cancel" => companion_model_cancel(models, input, &meta).await,
        "astella.v1.companion.model.remove" => companion_model_remove(models, input, &meta).await,
        "astella.v1.room.getProjection" => room_projection(gateway, &meta).await,
        "astella.v1.companion.home.getProjection" => api_get(gateway, &meta, "/companion/home-projection".to_string()).await,
        "astella.v1.companion.persona.get" => api_get(gateway, &meta, "/companion/pet-profile".to_string()).await,
        "astella.v1.companion.persona.patch" => api_write(gateway, &meta, reqwest::Method::PATCH, "/companion/pet-profile", input).await,
        "astella.v1.companion.voicePreference.patch" => api_write(gateway, &meta, reqwest::Method::PATCH, "/voice/preference", input).await,
        "astella.v1.companion.answerMode.patch" => api_write(gateway, &meta, reqwest::Method::PATCH, "/me/companion/answer-mode-preference", input).await,
        "astella.v1.companion.voicePreference.get" => api_get(gateway, &meta, "/voice/preference".to_string()).await,
        "astella.v1.companion.answerMode.get" => api_get(gateway, &meta, "/me/companion/answer-mode-preference".to_string()).await,
        "astella.v1.companion.file.upload" => {
            let Some(request) = input.get("request") else {
                return err(&meta, &GatewayFailure::new("validation", "user_action"));
            };
            let (Some(path), Some(name)) = (
                request.get("path").and_then(Value::as_str).filter(|value| !value.is_empty()),
                request.get("name").and_then(Value::as_str).filter(|value| !value.is_empty()),
            ) else {
                return err(&meta, &GatewayFailure::new("validation", "user_action"));
            };
            const COMPANION_FILE_MAX_BYTES: u64 = 8 * 1024 * 1024;
            let bytes = match tokio::fs::read(path).await {
                Ok(bytes) => bytes,
                Err(_) => return err(&meta, &GatewayFailure::new("not_found", "user_action")),
            };
            if bytes.is_empty() || bytes.len() as u64 > COMPANION_FILE_MAX_BYTES {
                return err(&meta, &GatewayFailure::new("validation", "user_action"));
            }
            if let Err(failure) = gateway.ensure_connected().await {
                return err(&meta, &failure);
            }
            match gateway.post_companion_file(name, bytes).await {
                Ok(body) => {
                    let url = body.get("url").and_then(Value::as_str).unwrap_or("");
                    let byte_length = body.get("byteLength").and_then(Value::as_u64).unwrap_or(0);
                    if !url.starts_with("/api/uploads/") || byte_length == 0 {
                        err(&meta, &GatewayFailure::new("unsupported_contract", "user_action"))
                    } else {
                        ok(&meta, json!({ "version": 1, "url": url, "byteLength": byte_length }))
                    }
                }
                Err(failure) => err(&meta, &failure),
            }
        },
        "astella.v1.companion.bridge.setContext" => match input.get("page").filter(|value| value.is_object()).cloned() {
            Some(page) => match crate::bridge_context::set_context(gateway, page).await {
                Ok(state) => ok(&meta, state),
                Err(failure) => err(&meta, &failure),
            },
            None => err(&meta, &GatewayFailure::new("validation", "user_action")),
        },
        "astella.v1.companion.bridge.clearContext" => ok(&meta, crate::bridge_context::clear_context(gateway).await),
        "astella.v1.companion.chat.ensureConversation" => {
            if let Err(failure) = gateway.ensure_connected().await {
                err(&meta, &failure)
            } else {
                match gateway.request_json(reqwest::Method::POST, "/companion/inbox/ensure", Some(json!({})), true).await {
                    Ok((status, body)) => {
                        if body.get("kind").and_then(Value::as_str) != Some("inbox") {
                            err(&meta, &GatewayFailure::new("unsupported_contract", "user_action"))
                        } else {
                            ok(&meta, json!({ "version": 1, "conversation": body, "created": status == 201 }))
                        }
                    }
                    Err(failure) => err(&meta, &failure),
                }
            }
        },
        "astella.v1.companion.chat.sendTurn" => {
            match (
                input.get("request").filter(|value| value.is_object()),
                input.get("request").and_then(|request| uuid_field(request, "conversationId")),
                input.get("request").and_then(|request| request.get("turn")).filter(|value| value.is_object()).cloned(),
                input.get("request").and_then(|request| request.get("idempotencyKey")).and_then(Value::as_str).filter(|key| !key.is_empty()),
            ) {
                (Some(_), Some(conversation_id), Some(turn), Some(key)) => {
                    if let Err(failure) = gateway.ensure_connected().await {
                        err(&meta, &failure)
                    } else {
                        match gateway.request_json_with_key(
                            reqwest::Method::POST,
                            &format!("/companion/conversations/{conversation_id}/turns"),
                            Some(turn),
                            true,
                            key,
                        ).await {
                            Ok((_status, body)) => ok(&meta, body),
                            Err(failure) => err(&meta, &failure),
                        }
                    }
                }
                _ => err(&meta, &GatewayFailure::new("validation", "user_action")),
            }
        },
        "astella.v1.companion.chat.listMessages" => match input.get("request").and_then(|request| uuid_field(request, "conversationId")) {
            Some(conversation_id) => {
                let mut params: Vec<String> = Vec::new();
                if let Some(limit) = input.get("request").and_then(|request| request.get("limit")).and_then(Value::as_u64) {
                    params.push(format!("limit={limit}"));
                }
                if let Some(before) = input.get("request").and_then(|request| request.get("beforeSeq")).and_then(Value::as_u64) {
                    params.push(format!("beforeSeq={before}"));
                }
                let suffix = if params.is_empty() { String::new() } else { format!("?{}", params.join("&")) };
                api_get(gateway, &meta, format!("/companion/conversations/{conversation_id}/messages{suffix}")).await
            }
            None => err(&meta, &GatewayFailure::new("validation", "user_action")),
        },
        "astella.v1.companion.chat.proposal.get" => match input.get("request").and_then(|request| uuid_field(request, "proposalId")) {
            Some(proposal_id) => api_get(gateway, &meta, format!("/companion/proposals/{proposal_id}")).await,
            None => err(&meta, &GatewayFailure::new("validation", "user_action")),
        },
        "astella.v1.companion.chat.proposal.decide" => {
            let request = input.get("request").filter(|value| value.is_object());
            match (
                request,
                request.and_then(|request| uuid_field(request, "proposalId")),
                request.and_then(|request| request.get("decision").and_then(Value::as_str)),
                request.and_then(|request| request.get("idempotencyKey")).and_then(Value::as_str).filter(|key| !key.is_empty()),
            ) {
                (Some(request), Some(proposal_id), Some(decision), Some(key)) => {
                    let mut body = json!({
                        "version": 1,
                        "proposalId": proposal_id,
                        "decision": decision,
                        "idempotencyKey": key,
                    });
                    if let Some(expected) = request.get("expectedPayloadSha256") {
                        body["expectedPayloadSha256"] = expected.clone();
                    }
                    if let Err(failure) = gateway.ensure_connected().await {
                        err(&meta, &failure)
                    } else {
                        match gateway.request_json_with_key(
                            reqwest::Method::POST,
                            &format!("/companion/proposals/{proposal_id}/decision"),
                            Some(body),
                            true,
                            key,
                        ).await {
                            Ok((_status, body)) => ok(&meta, body),
                            Err(failure) => err(&meta, &failure),
                        }
                    }
                }
                _ => err(&meta, &GatewayFailure::new("validation", "user_action")),
            }
        },
        "astella.v1.companion.chat.agentRoutes.list" => match input.get("request").and_then(|request| uuid_field(request, "conversationId")) {
            Some(conversation_id) => {
                let after = input.get("request").and_then(|request| request.get("afterSeq")).and_then(Value::as_u64).unwrap_or(0);
                api_get(gateway, &meta, format!("/companion/conversations/{conversation_id}/agent-routes?after={after}")).await
            }
            None => err(&meta, &GatewayFailure::new("validation", "user_action")),
        },
        "astella.v1.companion.chat.runNodes.list" => match input.get("request").and_then(|request| uuid_field(request, "conversationId")) {
            Some(conversation_id) => {
                let request = input.get("request").cloned().unwrap_or(Value::Null);
                let after = request.get("after").and_then(Value::as_u64).unwrap_or(0);
                let mut path = format!("/companion/conversations/{conversation_id}/run-nodes?after={after}");
                if request.get("includeThinking").and_then(Value::as_bool) == Some(true) {
                    path.push_str("&includeThinking=true");
                }
                if let Some(run_ids) = request.get("runIds").and_then(Value::as_array) {
                    let joined: Vec<String> = run_ids.iter().filter_map(Value::as_str).map(str::to_string).collect();
                    if !joined.is_empty() {
                        path.push_str(&format!("&runIds={}", encode_query_value(&joined.join(","))));
                    }
                }
                api_get(gateway, &meta, path).await
            }
            None => err(&meta, &GatewayFailure::new("validation", "user_action")),
        },
        "astella.v1.companion.chat.runVoiceSegments.list" => match input.get("request").and_then(|request| uuid_field(request, "runId")) {
            Some(run_id) => api_get(gateway, &meta, format!("/companion/runs/{run_id}/voice-segments")).await,
            None => err(&meta, &GatewayFailure::new("validation", "user_action")),
        },
        "astella.v1.companion.chat.cancelRun" => {
            let request = input.get("request").filter(|value| value.is_object());
            match (request.and_then(|request| uuid_field(request, "runId")), request.and_then(|request| request.get("generation")).and_then(Value::as_u64)) {
                (Some(run_id), Some(generation)) => api_post_json(
                    gateway, &meta,
                    format!("/companion/runs/{run_id}/cancel"),
                    Some(json!({ "version": 1, "generation": generation, "reason": "user" })),
                ).await,
                _ => err(&meta, &GatewayFailure::new("validation", "user_action")),
            }
        },
        "astella.v1.companion.chat.resumeRun" => {
            let Some(request) = input.get("request").filter(|value| value.is_object()).cloned() else {
                return err(&meta, &GatewayFailure::new("validation", "user_action"));
            };
            let Some(run_id) = uuid_field(&request, "runId") else {
                return err(&meta, &GatewayFailure::new("validation", "user_action"));
            };
            let mut body = request;
            if let Some(object) = body.as_object_mut() {
                object.remove("runId");
            }
            api_post_json(gateway, &meta, format!("/companion/runs/{run_id}/resume"), Some(body)).await
        },
        "astella.v1.companion.image.upload" => {
            let request = input.get("request").filter(|value| value.is_object());
            match (
                request.and_then(|request| request.get("fileName").and_then(Value::as_str)).filter(|name| !name.is_empty() && name.len() <= 255),
                request.and_then(|request| request.get("mimeType").and_then(Value::as_str)),
                request.and_then(|request| request.get("bytesBase64").and_then(Value::as_str)),
            ) {
                (Some(file_name), Some(mime_type), Some(encoded)) => {
                    use base64::Engine;
                    let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(encoded) else {
                        return err(&meta, &GatewayFailure::new("validation", "user_action"));
                    };
                    const TRANSFER_MAX_BYTES: usize = 100 * 1024 * 1024;
                    if bytes.is_empty() || bytes.len() > TRANSFER_MAX_BYTES {
                        return err(&meta, &GatewayFailure::new("validation", "user_action"));
                    }
                    if let Err(failure) = gateway.ensure_connected().await {
                        return err(&meta, &failure);
                    }
                    match gateway.post_companion_image(file_name, mime_type, bytes).await {
                        Ok(body) => ok(&meta, body),
                        Err(failure) => err(&meta, &failure),
                    }
                }
                _ => err(&meta, &GatewayFailure::new("validation", "user_action")),
            }
        },
        "astella.v1.companion.data.export" => companion_data_export(gateway, input, &meta, app).await,
        "astella.v1.companion.audit.delete" => {
            if let Err(failure) = gateway.ensure_connected().await {
                err(&meta, &failure)
            } else {
                match gateway.request_json(reqwest::Method::DELETE, "/me/companion/audit", None, true).await {
                    Ok((_status, body)) => ok(&meta, body),
                    Err(failure) => err(&meta, &failure),
                }
            }
        },
        "astella.v1.companion.activity.present" => activity_present(gateway, input, &meta).await,
        "astella.v1.companion.activity.ack" => activity_ack(gateway, input, &meta).await,
        "astella.v1.companion.activity.timeline" => {
            let cursor = input
                .get("before")
                .and_then(Value::as_u64)
                .filter(|value| *value > 0)
                .map(|value| format!("&before={value}"))
                .unwrap_or_default();
            if let Err(failure) = gateway.ensure_connected().await {
                err(&meta, &failure)
            } else {
                match gateway
                    .request_json(reqwest::Method::GET, &format!("/companion/deliveries/timeline?limit=50{cursor}"), None, true)
                    .await
                {
                    Ok((_status, body)) => {
                        let items: Vec<Value> = body
                            .get("items")
                            .and_then(Value::as_array)
                            .map(|rows| rows.iter().take(100).map(project_delivery).collect())
                            .unwrap_or_default();
                        ok(&meta, json!({
                            "version": 1,
                            "items": items,
                            "nextCursor": body.get("nextCursor").cloned().unwrap_or(json!(0)),
                            "serverTime": body.get("serverTime").cloned().unwrap_or(Value::Null),
                        }))
                    }
                    Err(failure) => err(&meta, &failure),
                }
            }
        },
        "astella.v1.companion.account.getState" => {
            api_get(gateway, &meta, "/me/companion".to_string()).await
        },
        "astella.v1.companion.account.patchState" => agent_write(gateway, input, &meta, reqwest::Method::PATCH, "/me/companion".to_string()).await,
        "astella.v1.companion.onboarding.transition" => {
            let version = input.get("version").and_then(Value::as_str).unwrap_or("");
            let valid_version = !version.is_empty()
                && version.len() <= 100
                && version.chars().next().map(|c| c.is_ascii_alphanumeric()).unwrap_or(false)
                && version.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
            match (valid_version, input.get("request").filter(|value| value.is_object()).cloned()) {
                (true, Some(body)) => agent_call(
                    gateway, input, &meta, reqwest::Method::POST,
                    format!("/me/companion/onboarding/{}/transition", encode_query_value(version)), Some(body),
                ).await,
                _ => err(&meta, &GatewayFailure::new("validation", "user_action")),
            }
        },
        "astella.v1.companion.discovery.get" => {
            api_get(gateway, &meta, "/companion/discovery".to_string()).await
        },
        "astella.v1.companion.discovery.collect" => discovery_write(gateway, input, &meta, "collect").await,
        "astella.v1.companion.discovery.uncollect" => discovery_write(gateway, input, &meta, "uncollect").await,
        "astella.v1.companion.discovery.annotate" => discovery_write(gateway, input, &meta, "annotate").await,
        "astella.v1.companion.discovery.state" => {
            let field = |key: &str| input.get(key).and_then(Value::as_str).filter(|value| !value.is_empty()).map(str::to_string);
            match (field("kind"), field("source"), field("sourceId")) {
                (Some(kind), Some(source), Some(source_id)) => api_get(
                    gateway, &meta,
                    format!(
                        "/companion/discovery/state?kind={}&source={}&sourceId={}",
                        encode_query_value(&kind), encode_query_value(&source), encode_query_value(&source_id),
                    ),
                ).await,
                _ => err(&meta, &GatewayFailure::new("validation", "user_action")),
            }
        },
        "astella.v1.companion.journey.bootstrap" => {
            api_get(gateway, &meta, "/companion/journey/bootstrap".to_string()).await
        },
        "astella.v1.companion.journey.get" => match uuid_field(input, "journeyId") {
            Some(journey_id) => api_get(gateway, &meta, format!("/companion/journeys/{journey_id}")).await,
            None => err(&meta, &GatewayFailure::new("validation", "user_action")),
        },
        "astella.v1.companion.journey.action" => match uuid_field(input, "journeyId") {
            Some(journey_id) => journey_write(gateway, input, &meta, &format!("/companion/journeys/{journey_id}/actions")).await,
            None => err(&meta, &GatewayFailure::new("validation", "user_action")),
        },
        "astella.v1.companion.invitation.action" => {
            journey_write(gateway, input, &meta, "/companion/invitation/actions").await
        },
        "astella.v1.companion.initiative.getPreferences" => {
            api_get(gateway, &meta, "/me/companion/participation".to_string()).await
        },
        "astella.v1.companion.initiative.setPreferences" => match input.get("request").filter(|value| value.is_object()).cloned() {
            Some(body) => {
                if let Err(failure) = gateway.ensure_connected().await {
                    return err(&meta, &failure);
                }
                match gateway.request_json(reqwest::Method::PUT, "/me/companion/participation", Some(body), true).await {
                    Ok((_status, body)) => ok(&meta, body),
                    Err(failure) => err(&meta, &failure),
                }
            }
            None => err(&meta, &GatewayFailure::new("validation", "user_action")),
        },
        "astella.v1.companion.history.list" => {
            let mut params: Vec<String> = Vec::new();
            if let Some(query) = input.get("query").and_then(Value::as_object) {
                for key in ["before", "throughMessageId", "runId"] {
                    if let Some(value) = query.get(key).and_then(Value::as_str).filter(|value| !value.is_empty()) {
                        params.push(format!("{key}={}", encode_query_value(value)));
                    }
                }
                if let Some(limit) = query.get("limit").and_then(Value::as_u64) {
                    params.push(format!("limit={limit}"));
                }
            }
            let suffix = if params.is_empty() { String::new() } else { format!("?{}", params.join("&")) };
            api_get(gateway, &meta, format!("/companion/history{suffix}")).await
        },
        "astella.v1.companion.history.search" => match input.get("query").and_then(|query| query.get("q")).and_then(Value::as_str).filter(|q| !q.is_empty()) {
            Some(q) => {
                let mut path = format!("/companion/history/search?q={}", encode_query_value(q));
                if let Some(limit) = input.get("query").and_then(|query| query.get("limit")).and_then(Value::as_u64) {
                    path.push_str(&format!("&limit={limit}"));
                }
                api_get(gateway, &meta, path).await
            }
            None => err(&meta, &GatewayFailure::new("validation", "user_action")),
        },
        "astella.v1.companion.history.clear" => {
            if let Err(failure) = gateway.ensure_connected().await {
                err(&meta, &failure)
            } else {
                match gateway.request_json(reqwest::Method::DELETE, "/companion/history", None, true).await {
                    Ok((_status, body)) => ok(&meta, body),
                    Err(failure) => err(&meta, &failure),
                }
            }
        },
        "astella.v1.companion.daily.get" => {
            let suffix = match date_field(input, "date") {
                Ok(Some(date)) => format!("?date={date}"),
                Ok(None) => String::new(),
                Err(()) => return err(&meta, &GatewayFailure::new("validation", "user_action")),
            };
            api_get(gateway, &meta, format!("/companion/daily{suffix}")).await
        },
        "astella.v1.companion.daily.month" => match month_field(input, "month") {
            Some(month) => api_get(gateway, &meta, format!("/companion/daily/month?month={month}")).await,
            None => err(&meta, &GatewayFailure::new("validation", "user_action")),
        },
        "astella.v1.companion.daily.hide" => daily_visibility(gateway, input, &meta, "hide").await,
        "astella.v1.companion.daily.unhide" => daily_visibility(gateway, input, &meta, "unhide").await,
        "astella.v1.companion.daily.delete" => daily_visibility(gateway, input, &meta, "delete").await,
        "astella.v1.companion.memory.create" => {
            let Some(request) = input.get("request").filter(|value| value.is_object()).cloned() else {
                return err(&meta, &GatewayFailure::new("validation", "user_action"));
            };
            let mut body = request;
            body["userStated"] = json!(true);
            body["candidate"] = json!(false);
            body["sourceType"] = json!("user_stated");
            api_post_json(gateway, &meta, "/companion/memory".to_string(), Some(body)).await
        },
        "astella.v1.companion.memory.correct" => match uuid_field(input, "memoryId") {
            Some(memory_id) => agent_write(gateway, input, &meta, reqwest::Method::POST, format!("/companion/memory/{memory_id}/correct")).await,
            None => err(&meta, &GatewayFailure::new("validation", "user_action")),
        },
        "astella.v1.companion.memory.revisions" => match uuid_field(input, "memoryId") {
            Some(memory_id) => api_get(gateway, &meta, format!("/companion/memory/{memory_id}/revisions")).await,
            None => err(&meta, &GatewayFailure::new("validation", "user_action")),
        },
        "astella.v1.companion.memory.dispute" => match (uuid_field(input, "memoryId"), input.get("expectedRevision").and_then(Value::as_u64)) {
            (Some(memory_id), Some(expected)) if expected >= 1 => {
                api_post_json(gateway, &meta, format!("/companion/memory/{memory_id}/dispute"), Some(json!({ "expectedRevision": expected }))).await
            }
            _ => err(&meta, &GatewayFailure::new("validation", "user_action")),
        },
        "astella.v1.companion.memory.restore-deleted" => match uuid_field(input, "memoryId") {
            Some(memory_id) => api_post_json(gateway, &meta, format!("/companion/memory/{memory_id}/restore-deleted"), Some(json!({}))).await,
            None => err(&meta, &GatewayFailure::new("validation", "user_action")),
        },
        "astella.v1.companion.memory.dismiss" => match uuid_field(input, "memoryId") {
            Some(memory_id) => api_post_json(gateway, &meta, format!("/companion/memory/{memory_id}/dismiss"), Some(json!({}))).await,
            None => err(&meta, &GatewayFailure::new("validation", "user_action")),
        },
        "astella.v1.companion.memory.delete" => match uuid_field(input, "memoryId") {
            Some(memory_id) => {
                if let Err(failure) = gateway.ensure_connected().await {
                    err(&meta, &failure)
                } else {
                    match gateway.request_json(reqwest::Method::DELETE, &format!("/companion/memory/{memory_id}"), None, true).await {
                        Ok(_) => ok(&meta, json!({ "memoryItemId": memory_id })),
                        Err(failure) => err(&meta, &failure),
                    }
                }
            }
            None => err(&meta, &GatewayFailure::new("validation", "user_action")),
        },
        "astella.v1.companion.memory.erase" => match uuid_field(input, "memoryId") {
            Some(memory_id) => {
                if let Err(failure) = gateway.ensure_connected().await {
                    err(&meta, &failure)
                } else {
                    match gateway.request_json(reqwest::Method::DELETE, &format!("/companion/memory/{memory_id}/erase"), None, true).await {
                        Ok(_) => ok(&meta, json!({})),
                        Err(failure) => err(&meta, &failure),
                    }
                }
            }
            None => err(&meta, &GatewayFailure::new("validation", "user_action")),
        },
        "astella.v1.companion.memory.clear" => {
            if let Err(failure) = gateway.ensure_connected().await {
                err(&meta, &failure)
            } else {
                match gateway.request_json(reqwest::Method::DELETE, "/companion/memory", None, true).await {
                    Ok((_status, body)) => ok(&meta, body),
                    Err(failure) => err(&meta, &failure),
                }
            }
        },
        "astella.v1.companion.derivedData.clear" => {
            if let Err(failure) = gateway.ensure_connected().await {
                err(&meta, &failure)
            } else {
                match gateway.request_json(reqwest::Method::DELETE, "/companion/derived-data", None, true).await {
                    Ok((_status, body)) => ok(&meta, body),
                    Err(failure) => err(&meta, &failure),
                }
            }
        },
        "astella.v1.companion.memory.rebuildEmbeddings" => {
            api_post_json(gateway, &meta, "/companion/memory/rebuild-embeddings".to_string(), Some(json!({}))).await
        },
        "astella.v1.companion.memory.confirm" => memory_action(gateway, input, &meta, "confirm").await,
        "astella.v1.companion.memory.pin" => memory_action(gateway, input, &meta, "pin").await,
        "astella.v1.companion.memory.unpin" => memory_action(gateway, input, &meta, "unpin").await,
        "astella.v1.companion.memory.archive" => memory_action(gateway, input, &meta, "archive").await,
        "astella.v1.companion.memory.restore" => memory_action(gateway, input, &meta, "restore").await,
        "astella.v1.companion.memory.summarizeRecent" => {
            match ensure_inbox_id(gateway).await {
                Ok(conversation_id) => api_post_json(
                    gateway, &meta,
                    format!("/companion/conversations/{conversation_id}/summarize"),
                    Some(json!({})),
                ).await,
                Err(failure) => err(&meta, &failure),
            }
        },
        "astella.v1.companion.room.patchProfile" => match input.get("request").filter(|value| value.is_object()).cloned() {
            Some(body) => agent_call(gateway, input, &meta, reqwest::Method::PATCH, "/companion/room-profile".to_string(), Some(body)).await,
            None => err(&meta, &GatewayFailure::new("validation", "user_action")),
        },
        "astella.v1.companion.persona.versions" => {
            api_get(gateway, &meta, "/companion/pet-profile/versions".to_string()).await
        },
        "astella.v1.companion.persona.pending" => {
            api_get(gateway, &meta, "/companion/pet-profile/pending".to_string()).await
        },
        "astella.v1.companion.persona.restore" => match input.get("request").filter(|value| value.is_object()).cloned() {
            Some(body) => api_post_json(gateway, &meta, "/companion/pet-profile/restore".to_string(), Some(body)).await,
            None => err(&meta, &GatewayFailure::new("validation", "user_action")),
        },
        "astella.v1.companion.persona.reset" => match input.get("revision").and_then(Value::as_u64) {
            Some(revision) => api_post_json(gateway, &meta, "/companion/pet-profile/reset".to_string(), Some(json!({ "revision": revision }))).await,
            None => err(&meta, &GatewayFailure::new("validation", "user_action")),
        },
        "astella.v1.companion.persona.stage" => match input.get("request").filter(|value| value.is_object()).cloned() {
            Some(body) => api_post_json(gateway, &meta, "/companion/pet-profile/stage".to_string(), Some(body)).await,
            None => err(&meta, &GatewayFailure::new("validation", "user_action")),
        },
        "astella.v1.companion.persona.activate" => match input.get("revision").and_then(Value::as_u64) {
            Some(revision) => {
                let mut body = json!({ "revision": revision });
                if let Some(pending) = input.get("pendingRevision").and_then(Value::as_u64) {
                    body["pendingRevision"] = json!(pending);
                }
                api_post_json(gateway, &meta, "/companion/pet-profile/activate".to_string(), Some(body)).await
            }
            None => err(&meta, &GatewayFailure::new("validation", "user_action")),
        },
        "astella.v1.companion.memory.list" => {
            let mut params: Vec<String> = Vec::new();
            if let Some(query) = input.get("query").and_then(Value::as_object) {
                for key in ["focusMemoryId", "kind", "q", "scope"] {
                    if let Some(value) = query.get(key).and_then(Value::as_str).filter(|value| !value.is_empty()) {
                        params.push(format!("{key}={}", encode_query_value(value)));
                    }
                }
                for key in ["includeCandidates", "includeArchived"] {
                    if query.get(key).and_then(Value::as_bool) == Some(true) {
                        params.push(format!("{key}=true"));
                    }
                }
            }
            let suffix = if params.is_empty() { String::new() } else { format!("?{}", params.join("&")) };
            api_get(gateway, &meta, format!("/companion/memory{suffix}")).await
        },
        "astella.v1.companion.memory.budget" => {
            api_get(gateway, &meta, "/companion/memory/budget".to_string()).await
        },
        "astella.v1.companion.memory.starMap" => {
            api_get(gateway, &meta, "/companion/memory/star-map".to_string()).await
        },
        "astella.v1.companion.memory.recycle-list" => {
            api_get(gateway, &meta, "/companion/memory/recycle".to_string()).await
        },
        "astella.v1.companion.memory.conflicts" => {
            api_get(gateway, &meta, "/companion/memory/conflicts".to_string()).await
        },
        "astella.v1.companion.memory.budgetMove" => match uuid_field(input, "memoryId") {
            Some(memory_id) => {
                let tier = input.get("tier").and_then(Value::as_str).unwrap_or("");
                if !matches!(tier, "resident" | "active" | "archived") {
                    err(&meta, &GatewayFailure::new("validation", "user_action"))
                } else {
                    match budget_move(gateway, &meta, &memory_id, tier).await {
                        Some(body) => body,
                        None => err(&meta, &GatewayFailure::new("safe_internal_error", "never")),
                    }
                }
            }
            None => err(&meta, &GatewayFailure::new("validation", "user_action")),
        },
        "astella.v1.companion.memory.resolveConflict" => match (uuid_field(input, "memoryId"), uuid_field(input, "removeId")) {
            (Some(memory_id), Some(remove_id)) => {
                api_post_json(
                    gateway, &meta,
                    format!("/companion/memory/{memory_id}/resolve-conflict"),
                    Some(json!({ "removeId": remove_id })),
                ).await
            }
            _ => err(&meta, &GatewayFailure::new("validation", "user_action")),
        },
        "astella.v1.agent.long-goals.list" => agent_call(
            gateway, input, &meta, reqwest::Method::GET,
            format!("/agent/long-goals{}", query_of(input)), None,
        ).await,
        "astella.v1.agent.runs.list" => agent_call(
            gateway, input, &meta, reqwest::Method::GET,
            format!("/agent/runs{}", query_of(input)), None,
        ).await,
        "astella.v1.agent.runs.history" => match uuid_field(input, "runId") {
            Some(run_id) => agent_call(
                gateway, input, &meta, reqwest::Method::GET,
                format!("/agent/runs/{run_id}/history{}", query_of(input)), None,
            ).await,
            None => err(&meta, &GatewayFailure::new("validation", "user_action")),
        },
        "astella.v1.agent.run.get" => match uuid_field(input, "runId") {
            Some(run_id) => agent_call(gateway, input, &meta, reqwest::Method::GET, format!("/agent/runs/{run_id}"), None).await,
            None => err(&meta, &GatewayFailure::new("validation", "user_action")),
        },
        "astella.v1.agent.runs.create" => agent_write(gateway, input, &meta, reqwest::Method::POST, "/agent/runs".to_string()).await,
        "astella.v1.agent.runs.revise" => match uuid_field(input, "runId") {
            Some(run_id) => agent_write(gateway, input, &meta, reqwest::Method::PATCH, format!("/agent/runs/{run_id}")).await,
            None => err(&meta, &GatewayFailure::new("validation", "user_action")),
        },
        "astella.v1.agent.runs.control" => match uuid_field(input, "runId") {
            Some(run_id) => agent_write(gateway, input, &meta, reqwest::Method::POST, format!("/agent/runs/{run_id}/control")).await,
            None => err(&meta, &GatewayFailure::new("validation", "user_action")),
        },
        "astella.v1.agent.selfNotes.list" => agent_call(gateway, input, &meta, reqwest::Method::GET, "/agent/self-notes".to_string(), None).await,
        "astella.v1.agent.selfNotes.history" => match input.get("key").and_then(Value::as_str).filter(|key| !key.is_empty()) {
            Some(key) => agent_call(
                gateway, input, &meta, reqwest::Method::GET,
                format!("/agent/self-notes/history?key={}", encode_query_value(key)), None,
            ).await,
            None => err(&meta, &GatewayFailure::new("validation", "user_action")),
        },
        "astella.v1.agent.selfNotes.write" => agent_write(gateway, input, &meta, reqwest::Method::PATCH, "/agent/self-notes".to_string()).await,
        "astella.v1.agent.selfNotes.control" => agent_write(gateway, input, &meta, reqwest::Method::POST, "/agent/self-notes/control".to_string()).await,
        "astella.v1.agent.methods.list" => agent_call(gateway, input, &meta, reqwest::Method::GET, "/agent/methods".to_string(), None).await,
        "astella.v1.agent.method.propose" => agent_write(gateway, input, &meta, reqwest::Method::POST, "/agent/methods".to_string()).await,
        "astella.v1.agent.method.revise" => match uuid_field(input, "methodId") {
            Some(method_id) => agent_write(gateway, input, &meta, reqwest::Method::PATCH, format!("/agent/methods/{method_id}")).await,
            None => err(&meta, &GatewayFailure::new("validation", "user_action")),
        },
        "astella.v1.agent.method.control" => match uuid_field(input, "methodId") {
            Some(method_id) => agent_write(gateway, input, &meta, reqwest::Method::POST, format!("/agent/methods/{method_id}/control")).await,
            None => err(&meta, &GatewayFailure::new("validation", "user_action")),
        },
        "astella.v1.agent.method.history" => match uuid_field(input, "methodId") {
            Some(method_id) => agent_call(gateway, input, &meta, reqwest::Method::GET, format!("/agent/methods/{method_id}/history"), None).await,
            None => err(&meta, &GatewayFailure::new("validation", "user_action")),
        },
        "astella.v1.agent.method.uses" => match uuid_field(input, "methodId") {
            Some(method_id) => agent_call(gateway, input, &meta, reqwest::Method::GET, format!("/agent/methods/{method_id}/uses"), None).await,
            None => err(&meta, &GatewayFailure::new("validation", "user_action")),
        },
        "astella.v1.agent.method.feedback" => match uuid_field(input, "useId") {
            Some(use_id) => agent_write(gateway, input, &meta, reqwest::Method::POST, format!("/agent/method-uses/{use_id}/feedback")).await,
            None => err(&meta, &GatewayFailure::new("validation", "user_action")),
        },
        "astella.v1.invite.create" => invite_create(gateway, input, &meta).await,
        "astella.v1.invite.list" => invite_list(gateway, &meta).await,
        "astella.v1.invite.revoke" => invite_revoke(gateway, input, &meta).await,
        "astella.v1.member.list" => member_list(gateway, &meta).await,
        "astella.v1.member.remove" => member_remove(gateway, input, &meta).await,
        "astella.v1.noteLearningCard.get" => learning_card_get(gateway, input, &meta).await,
        "astella.v1.noteExpansion.getTask" => note_task_get(gateway, input, &meta, "expansion-tasks").await,
        "astella.v1.noteLearningArtifact.taskGet" => note_task_get(gateway, input, &meta, "learning-artifact-tasks").await,
        "astella.v1.noteOverview.getTask" => note_task_get(gateway, input, &meta, "overview-tasks").await,
        "astella.v1.noteAnnotation.list" => match uuid_field(input, "noteId") {
            Some(note_id) => {
                let mut params: Vec<String> = Vec::new();
                if let Some(version) = input.get("noteVersionId").and_then(Value::as_str).filter(|value| is_uuid(value)) {
                    params.push(format!("noteVersionId={version}"));
                }
                if let Some(before) = input.get("before").and_then(Value::as_str).filter(|value| is_uuid(value)) {
                    params.push(format!("before={before}"));
                }
                let suffix = if params.is_empty() { String::new() } else { format!("?{}", params.join("&")) };
                api_get(gateway, &meta, format!("/v2/notes/{note_id}/annotations{suffix}")).await
            }
            None => err(&meta, &GatewayFailure::new("validation", "user_action")),
        },
        "astella.v1.noteLearningCard.generate" => learning_card_generate(gateway, input, &meta).await,
        "astella.v1.noteLearningCard.startAttempt" => learning_card_attempt_start(gateway, input, &meta).await,
        "astella.v1.noteLearningCard.answer" => learning_card_answer(gateway, input, &meta).await,
        "astella.v1.noteLearningCard.complete" => learning_card_complete(gateway, input, &meta).await,
        "astella.v1.noteLearningCard.history" => learning_card_history(gateway, input, &meta).await,
        "astella.v1.noteMindMap.getTask" => mind_map_task(gateway, input, &meta).await,
        "astella.v1.noteMindMap.source" => mind_map_source(gateway, input, &meta).await,
        "astella.v1.understanding.getTopology" => api_get(gateway, &meta, "/v3/understanding/topology".to_string()).await,
        "astella.v1.understanding.getNoteDeepening" => note_deepening(gateway, input, &meta).await,
        "astella.v1.artifact.ensure" => artifact_ensure(gateway, input, &meta, app).await,
        "astella.v1.navigation.resolve" => navigation_resolve(gateway, input, &meta),
        "astella.v1.navigation.go" => navigation_go(gateway, input, &meta),
        "astella.v1.navigation.back" => navigation_back(&meta),
        "astella.v1.navigation.restore" => navigation_restore(&meta),
        "astella.v1.workspace.list" => workspace_list(gateway, &meta).await,
        "astella.v1.workspace.switch" => workspace_switch(gateway, input, &meta).await,
        "astella.v1.workspace.create" => workspace_create(gateway, input, &meta).await,
        "astella.v1.workspace.rename" => workspace_rename(gateway, input, &meta).await,
        "astella.v1.workspace.dissolvePreview" => workspace_dissolve_preview(gateway, input, &meta).await,
        "astella.v1.workspace.dissolve" => workspace_dissolve(gateway, input, &meta).await,
        "astella.v1.workspace.transferOwnership" => workspace_transfer(gateway, input, &meta).await,
        "astella.v1.workspace.getAiAuditLog" => workspace_ai_audit_log(gateway, input, &meta).await,
        "astella.v1.workspace.export" => workspace_export(gateway, &meta, app).await,
        "astella.v1.notes.markdownExport" => notes_markdown_export(gateway, &meta, app).await,
        "astella.v1.workspace.getAiSettings" => api_get(gateway, &meta, "/me/ai-settings".to_string()).await,
        "astella.v1.workspace.updateAiConsent" => ai_consent(gateway, input, &meta).await,
        "astella.v1.workspace.updateAiDataPolicy" => match input.get("request").filter(|value| value.is_object()) {
            Some(body) => api_write_body(gateway, &meta, reqwest::Method::PUT, "/me/ai-data-policy", body.clone()).await,
            None => err(&meta, &GatewayFailure::new("validation", "user_action")),
        },
        "astella.v1.search.drift" => api_get(gateway, &meta, "/search/drift".to_string()).await,
        "astella.v1.search.reindex" => api_post_json(gateway, &meta, "/search/reindex".to_string(), Some(json!({}))).await,
        "astella.v1.search.global" => api_get(gateway, &meta, search_path(input)).await,
        "astella.v1.capabilities.get" => api_get(gateway, &meta, "/v1/auth/capabilities".to_string()).await,
        "astella.v1.note.list" => api_get(gateway, &meta, note_list_path(input)).await,
        "astella.v1.note.get" => match note_detail_path(input) {
            Some(path) => api_get(gateway, &meta, path).await,
            None => err(&meta, &GatewayFailure::new("validation", "user_action")),
        },
        "astella.v1.note.create" => note_create(gateway, input, &meta).await,
        "astella.v1.note.delete" => note_mutation(gateway, input, &meta, reqwest::Method::DELETE, "deleted").await,
        "astella.v1.note.restore" => note_mutation(gateway, input, &meta, reqwest::Method::POST, "restored").await,
        "astella.v1.note.presenceList" => api_get(gateway, &meta, "/notes/presence".to_string()).await,
        "astella.v1.source.archive" => match uuid_field(input, "sourceId") {
            Some(source_id) => {
                if let Err(failure) = gateway.ensure_connected().await {
                    err(&meta, &failure)
                } else {
                    match gateway.request_json(reqwest::Method::DELETE, &format!("/sources/{source_id}"), None, true).await {
                        Ok((_status, body)) => ok(&meta, body),
                        Err(failure) => err(&meta, &failure),
                    }
                }
            }
            None => err(&meta, &GatewayFailure::new("validation", "user_action")),
        },
        "astella.v1.source.createNote" => match uuid_field(input, "sourceId") {
            Some(source_id) => {
                let force = input.get("force").and_then(Value::as_bool).unwrap_or(false);
                let suffix = if force { "?force=true" } else { "" };
                api_post_json(gateway, &meta, format!("/sources/{source_id}/create-note{suffix}"), None).await
            }
            None => err(&meta, &GatewayFailure::new("validation", "user_action")),
        },
        "astella.v1.source.reparse" => match uuid_field(input, "sourceId") {
            Some(source_id) => api_post_json(gateway, &meta, format!("/sources/{source_id}/reparse"), None).await,
            None => err(&meta, &GatewayFailure::new("validation", "user_action")),
        },
        "astella.v1.source.notes" => match uuid_field(input, "sourceId") {
            Some(source_id) => api_get(gateway, &meta, format!("/sources/{source_id}/notes")).await,
            None => err(&meta, &GatewayFailure::new("validation", "user_action")),
        },
        "astella.v1.source.bundleImport" => match crate::bundle_import::run(gateway, input, app).await {
            Ok(body) => ok(&meta, body),
            Err(code) => {
                let retry = match code {
                    "unavailable" => "safe_retry",
                    "local_storage_unavailable" => "user_action",
                    _ => "user_action",
                };
                let mapped = if code == "unavailable" { "api_unavailable" } else { code };
                err(&meta, &GatewayFailure::new(mapped, retry))
            }
        },
        "astella.v1.source.list" => api_get(gateway, &meta, source_list_path(input)).await,
        "astella.v1.source.getImage" => source_get_image(gateway, input, &meta).await,
        "astella.v1.source.get" => match source_detail_path(input) {
            Some(path) => api_get(gateway, &meta, path).await,
            None => err(&meta, &GatewayFailure::new("validation", "user_action")),
        },
        "astella.v1.clipboard.readLinks" => clipboard_read_links(app, &meta),
        "astella.v1.clipboard.writeText" => clipboard_write_text(app, input, &meta),
        "astella.v1.shell.openExternal" => shell_open_external(input, &meta),
        "astella.v1.update.getState" => ok(&meta, crate::update::bridge().state().await),
        "astella.v1.update.check" => ok(&meta, crate::update::bridge().check(true).await),
        "astella.v1.update.download" => match app.and_then(|handle| handle.path().app_data_dir().ok()) {
            Some(dir) => {
                crate::update::bridge().start_download(dir.join("updates"));
                ok(&meta, crate::update::bridge().state().await)
            }
            None => err(&meta, &GatewayFailure::new("local_storage_unavailable", "user_action")),
        },
        "astella.v1.update.install" => ok(&meta, crate::update::bridge().install().await),
        "astella.v1.update.acknowledgeInstalled" => ok(&meta, crate::update::bridge().state().await),
        "astella.v1.companion.voice.transcribe" => voice_transcribe(input, &meta).await,
        "astella.v1.companion.voice.asrModel.state" => asr_model(&meta, None),
        "astella.v1.companion.voice.asrModel.download" => asr_model(&meta, Some("download")),
        "astella.v1.companion.voice.asrModel.cancel" => asr_model(&meta, Some("cancel")),
        "astella.v1.companion.voice.asrModel.remove" => asr_model(&meta, Some("remove")),
        "astella.v1.note.image.upload" => note_image_upload(gateway, input, &meta).await,
        "astella.v1.noteWriting.perform" => {
            let action_input = input.get("request").cloned().unwrap_or_else(|| input.clone());
            let is_pdf_export = action_input.get("action").and_then(Value::as_str) == Some("export")
                && action_input.get("format").and_then(Value::as_str) == Some("pdf");
            let result = if is_pdf_export {
                crate::note_writing::export_pdf(&action_input, app).await
            } else {
                crate::note_writing::perform(&action_input, app)
            };
            match result {
                Ok(outcome) => ok(&meta, outcome.body),
                Err("canceled") => ok(&meta, json!({ "canceled": true })),
                Err(code) => {
                    let retry = match code {
                        "conflict" => "resync_first",
                        "api_unavailable" => "safe_retry",
                        _ => "user_action",
                    };
                    err(&meta, &GatewayFailure::new(code, retry))
                }
            }
        },
        "astella.v1.note.save" => match note_id_of(input).map(|id| format!("/v2/notes/{id}")) {
            Some(path) => api_write(gateway, &meta, reqwest::Method::PATCH, &path, input).await,
            None => err(&meta, &GatewayFailure::new("validation", "user_action")),
        },
        "astella.v1.note.setShareScope" => match note_id_of(input).map(|id| format!("/v2/notes/{id}/share-scope")) {
            Some(path) => api_write(gateway, &meta, reqwest::Method::PATCH, &path, input).await,
            None => err(&meta, &GatewayFailure::new("validation", "user_action")),
        },
        "astella.v1.note.doc.state" => note_doc_state(gateway, input, &meta).await,
        "astella.v1.note.doc.syncUpdate" => note_doc_sync_update(gateway, input, &meta).await,
        "astella.v1.note.doc.syncTitle" => note_doc_sync_title(gateway, input, &meta).await,
        "astella.v1.note.doc.presence" => note_doc_presence(gateway, input, &meta).await,
        "astella.v1.note.doc.draft.save" => note_draft(gateway, app, input, &meta, "save"),
        "astella.v1.note.doc.draft.get" => note_draft(gateway, app, input, &meta, "get"),
        "astella.v1.note.doc.draft.clear" => note_draft(gateway, app, input, &meta, "clear"),
        "astella.v1.openedFile.take" => ok(&meta, crate::opened_files::broker().take().unwrap_or(Value::Null)),
        "astella.v1.openedFile.reveal" => {
            let path = input.get("request").and_then(|request| request.get("path")).and_then(Value::as_str).unwrap_or("");
            let revealed = if path.is_empty() { false } else { crate::opened_files::broker().reveal(path) };
            ok(&meta, json!({ "version": 1, "revealed": revealed }))
        }
        "astella.v1.openedFile.prepareImport" => err(&meta, &GatewayFailure::new("feature_disabled", "never")),
        "astella.v1.window.getState" => ok(&meta, json!({ "version": 1, "state": "visible", "revision": 1 })),
        "astella.v1.subscriptions.subscribe" => note_doc_subscribe(gateway, input, &meta).await,
        "astella.v1.note.doc.pollUpdates" => note_doc_poll(input, &meta),
        "astella.v1.companion.chat.pollEvents" => {
            let Some(subscription_id) = input.get("subscriptionId").and_then(Value::as_str) else {
                return err(&meta, &GatewayFailure::new("validation", "user_action"));
            };
            match crate::chat_stream::drain(subscription_id) {
                Some((events, closed)) => ok(&meta, json!({ "events": events, "closed": closed })),
                None => ok(&meta, json!({ "events": [], "closed": true })),
            }
        },
        "astella.v1.subscriptions.unsubscribe" => subscription_unsubscribe(input, &meta),
        _ => err(&meta, &GatewayFailure::new("feature_disabled", "never")),
    }
}

pub fn runtime_snapshot(gateway: &Gateway) -> Value {
    json!({
        "version": 1,
        "contractVersion": CONTRACT_VERSION,
        "appId": APP_ID,
        "appVersion": env!("CARGO_PKG_VERSION"),
        "platform": "darwin",
        "windowState": { "version": 1, "state": "visible", "revision": 1 },
        "apiConnection": connection_json(gateway.connection()),
        "nativeCapabilities": {
            "filePicker": "available",
            "clipboard": "available",
            "notifications": "available",
            "asr": "unavailable",
            "updates": "unavailable",
            "live2d": "available",
        },
        "reducedMotion": false,
        "startupRevision": 1,
        "sessionCredential": {
            "persistence": "local_file",
            "stored": gateway.has_stored_credential(),
        },
    })
}

fn connection_json(state: &ConnectionState) -> Value {
    match state {
        ConnectionState::NotConfigured => json!({ "version": 1, "kind": "not_configured" }),
        ConnectionState::ConfigurationError { reason } => {
            json!({ "version": 1, "kind": "configuration_error", "reason": reason })
        }
        ConnectionState::Checking { origin_kind } => json!({
            "version": 1,
            "kind": "checking",
            "originKind": match origin_kind {
                crate::gateway::OriginKind::LocalLoopback => "local_loopback",
                crate::gateway::OriginKind::RemoteHttps => "remote_https",
            },
        }),
        ConnectionState::ApiUnavailable => json!({ "version": 1, "kind": "api_unavailable" }),
        ConnectionState::ApiUntrusted { reason } => {
            json!({ "version": 1, "kind": "api_untrusted", "reason": reason })
        }
        ConnectionState::Ready { instance_id, schema_revision } => json!({
            "version": 1,
            "kind": "ready",
            "instanceId": instance_id,
            "schemaRevision": schema_revision,
        }),
    }
}

/** 活动投递的 wire → 渲染层投影：标签与跳转目标由 `payloadRef.kind` 决定（Electron 同形）。 */
fn project_delivery(item: &Value) -> Value {
    let payload = item.get("payloadRef").cloned().unwrap_or(Value::Null);
    let kind = payload.get("kind").and_then(Value::as_str).unwrap_or("");
    let label = match kind {
        "system_event" => payload.get("text").and_then(Value::as_str).unwrap_or("伴星状态已更新"),
        "memory_item" => payload.get("contentPreview").and_then(Value::as_str).unwrap_or("有一条记忆候选等待查看"),
        "proposal" => "有一项操作等待你确认",
        "action_result" => "伴星操作已有结果",
        _ => "收到一条伴星消息",
    };
    let target = match kind {
        "message" => json!({ "kind": "dialogue", "messageId": payload.get("messageId").cloned().unwrap_or(Value::Null) }),
        "proposal" | "action_result" => json!({ "kind": "proposal", "proposalId": payload.get("proposalId").cloned().unwrap_or(Value::Null) }),
        "memory_item" => json!({ "kind": "memory", "memoryId": payload.get("memoryItemId").cloned().unwrap_or(Value::Null) }),
        "system_event" => match payload.get("initiative").and_then(|initiative| initiative.get("messageId")) {
            Some(message_id) => json!({ "kind": "dialogue", "messageId": message_id }),
            None => json!({ "kind": "none" }),
        },
        _ => json!({ "kind": "none" }),
    };
    json!({
        "version": 1,
        "deliveryId": item.get("deliveryId").cloned().unwrap_or(Value::Null),
        "inboxSequence": item.get("inboxSequence").cloned().unwrap_or(Value::Null),
        "state": item.get("state").cloned().unwrap_or(Value::Null),
        "kind": item.get("kind").cloned().unwrap_or(Value::Null),
        "label": label,
        "target": target,
        "expired": item.get("expired").cloned().unwrap_or(json!(false)),
        "createdAt": item.get("createdAt").cloned().unwrap_or(Value::Null),
        "expiresAt": item.get("expiresAt").cloned().unwrap_or(Value::Null),
    })
}

/// 发现簿写通道：服务端要 `{ meta: { requestId }, request }` 这层包装（Electron 同形）。
async fn discovery_write(gateway: &mut Gateway, input: &Value, meta: &Value, action: &str) -> Value {
    let Some(request) = input.get("request").filter(|value| value.is_object()).cloned() else {
        return err(meta, &GatewayFailure::new("validation", "user_action"));
    };
    if let Err(failure) = gateway.ensure_connected().await {
        return err(meta, &failure);
    }
    let request_id = meta.get("requestId").cloned().unwrap_or(Value::Null);
    let path = if action == "collect" {
        "/companion/discovery".to_string()
    } else {
        format!("/companion/discovery/{action}")
    };
    match gateway
        .request_json(reqwest::Method::POST, &path, Some(json!({ "meta": { "requestId": request_id }, "request": request })), true)
        .await
    {
        Ok((_status, body)) => ok(meta, body),
        Err(failure) => err(meta, &failure),
    }
}

/// 旅程/邀请动作：体就是 `request` 本身。
async fn journey_write(gateway: &mut Gateway, input: &Value, meta: &Value, path: &str) -> Value {
    let Some(body) = input.get("request").filter(|value| value.is_object()).cloned() else {
        return err(meta, &GatewayFailure::new("validation", "user_action"));
    };
    api_post_json(gateway, meta, path.to_string(), Some(body)).await
}

fn is_date_segment(text: &str, length: usize, dash_at: &[usize]) -> bool {
    text.len() == length
        && text.as_bytes().iter().enumerate().all(|(index, byte)| {
            if dash_at.contains(&index) { *byte == b'-' } else { byte.is_ascii_digit() }
        })
}

/// 本地日期（YYYY-MM-DD）；缺失与非法分开报，避免把空字符串当合法日期。
fn date_field(input: &Value, key: &str) -> Result<Option<String>, ()> {
    match input.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) if is_date_segment(text, 10, &[4, 7]) => Ok(Some(text.clone())),
        Some(Value::String(_)) => Err(()),
        Some(_) => Err(()),
    }
}

/// 月份（YYYY-MM）。
fn month_field(input: &Value, key: &str) -> Option<String> {
    input
        .get(key)
        .and_then(Value::as_str)
        .filter(|text| is_date_segment(text, 7, &[4]))
        .map(str::to_string)
}

async fn daily_visibility(gateway: &mut Gateway, input: &Value, meta: &Value, action: &str) -> Value {
    let Ok(Some(date)) = date_field(input, "date") else {
        return err(meta, &GatewayFailure::new("validation", "user_action"));
    };
    if let Err(failure) = gateway.ensure_connected().await {
        return err(meta, &failure);
    }
    match gateway
        .request_json(
            reqwest::Method::POST,
            &format!("/companion/daily/{date}/{action}"),
            Some(json!({})),
            true,
        )
        .await
    {
        Ok((_status, body)) => ok(meta, body),
        Err(failure) => err(meta, &failure),
    }
}

/** 伴星数据导出：服务端给整包字节，落 `Downloads/Astella/伴星/`（先写 .partial 再改名，
 *  与 Electron 同一条"写全了才发布"的两步法）；回执只带文件名，不暴露本机完整路径。 */
async fn companion_data_export(
    gateway: &mut Gateway,
    input: &Value,
    meta: &Value,
    app: Option<&tauri::AppHandle>,
) -> Value {
    let kind = input.get("kind").and_then(Value::as_str).unwrap_or("all");
    if !matches!(kind, "all" | "memory" | "audit") {
        return err(meta, &GatewayFailure::new("validation", "user_action"));
    }
    let downloads = match app.and_then(|handle| handle.path().download_dir().ok()) {
        Some(dir) => dir,
        None => match std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")) {
            Ok(home) => std::path::PathBuf::from(home).join("Downloads"),
            Err(_) => return err(meta, &GatewayFailure::new("local_storage_unavailable", "user_action")),
        },
    };
    let (path, accept, extension) = match kind {
        "all" => ("/companion/export", "application/x-ndjson", "ndjson"),
        "memory" => ("/companion/memory/export", "application/json", "json"),
        _ => ("/me/companion/audit/export", "application/json", "json"),
    };
    if let Err(failure) = gateway.ensure_connected().await {
        return err(meta, &failure);
    }
    let (_content_type, bytes) = match gateway.request_bytes(path, accept, "application/", 256 * 1024 * 1024).await {
        Ok(result) => result,
        Err(failure) => return err(meta, &failure),
    };
    let date = &crate::collab_client::iso_now()[..10];
    let suffix = hex::encode(rand::random::<[u8; 6]>());
    let file_name = if kind == "all" {
        format!("astella-companion-{date}-{suffix}.{extension}")
    } else {
        format!("astella-companion-{kind}-{date}-{suffix}.{extension}")
    };
    let directory = downloads.join("Astella").join("伴星");
    if tokio::fs::create_dir_all(&directory).await.is_err() {
        return err(meta, &GatewayFailure::new("local_storage_unavailable", "user_action"));
    }
    let file_path = directory.join(&file_name);
    let partial_path = directory.join(format!("{file_name}.partial"));
    let written = async {
        use tokio::io::AsyncWriteExt;
        let mut options = tokio::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&partial_path).await?;
        file.write_all(&bytes).await?;
        file.sync_all().await?;
        drop(file);
        tokio::fs::rename(&partial_path, &file_path).await
    }
    .await;
    match written {
        Ok(()) => ok(meta, json!({
            "version": 1,
            "saved": true,
            "canceled": false,
            "fileName": file_name,
            "bytes": bytes.len(),
        })),
        Err(_) => {
            let _ = tokio::fs::remove_file(&partial_path).await;
            err(meta, &GatewayFailure::new("local_storage_unavailable", "user_action"))
        }
    }
}

/// 记忆动作五连（confirm/pin/unpin/archive/restore）：同一形状，回记忆条目。
async fn memory_action(gateway: &mut Gateway, input: &Value, meta: &Value, action: &str) -> Value {
    let Some(memory_id) = uuid_field(input, "memoryId") else {
        return err(meta, &GatewayFailure::new("validation", "user_action"));
    };
    api_post_json(gateway, meta, format!("/companion/memory/{memory_id}/{action}"), Some(json!({}))).await
}

/// 收件箱会话 ID：ensure 一次拿 `id`（最近摘要等"先有会话再说"的通道共用）。
async fn ensure_inbox_id(gateway: &mut Gateway) -> Result<String, GatewayFailure> {
    gateway.ensure_connected().await?;
    let (_status, body) = gateway.request_json(reqwest::Method::POST, "/companion/inbox/ensure", Some(json!({})), true).await?;
    body.get("id")
        .and_then(Value::as_str)
        .filter(|value| is_uuid(value))
        .map(str::to_string)
        .ok_or_else(|| GatewayFailure::new("unsupported_contract", "user_action"))
}

/// 记忆预算迁移：服务端把结果包在 `result` 里，Electron 也只取那一层。
async fn budget_move(gateway: &mut Gateway, meta: &Value, memory_id: &str, tier: &str) -> Option<Value> {
    if let Err(failure) = gateway.ensure_connected().await {
        return Some(err(meta, &failure));
    }
    match gateway
        .request_json(
            reqwest::Method::POST,
            &format!("/companion/memory/{memory_id}/budget-tier"),
            Some(json!({ "tier": tier })),
            true,
        )
        .await
    {
        Ok((_status, body)) => Some(ok(meta, body.get("result").cloned().unwrap_or(Value::Null))),
        Err(failure) => Some(err(meta, &failure)),
    }
}

/* ── Agent（伴星目标/方法/记事）：Electron 侧全是 REST 直通，形状由共享合同解析。 ── */

fn encode_query_value(value: &str) -> String {
    use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
    utf8_percent_encode(value, NON_ALPHANUMERIC).to_string()
}

/// 读通道的 query 对象：跳过空值，值按 URL 安全编码（URLSearchParams 同义）。
fn query_of(input: &Value) -> String {
    let Some(query) = input.get("query").and_then(Value::as_object) else {
        return String::new();
    };
    let mut parts: Vec<String> = Vec::new();
    for (key, value) in query {
        if value.is_null() {
            continue;
        }
        let text = match value {
            Value::String(text) => text.clone(),
            other => other.to_string(),
        };
        parts.push(format!("{key}={}", encode_query_value(&text)));
    }
    if parts.is_empty() {
        String::new()
    } else {
        format!("?{}", parts.join("&"))
    }
}

/// 写通道统一从 `request` 取对象体（与 Electron schema 同名）。
async fn agent_write(
    gateway: &mut Gateway,
    input: &Value,
    meta: &Value,
    method: reqwest::Method,
    path: String,
) -> Value {
    let Some(body) = input.get("request").filter(|value| value.is_object()).cloned() else {
        return err(meta, &GatewayFailure::new("validation", "user_action"));
    };
    agent_call(gateway, input, meta, method, path, Some(body)).await
}

async fn agent_call(
    gateway: &mut Gateway,
    _input: &Value,
    meta: &Value,
    method: reqwest::Method,
    path: String,
    body: Option<Value>,
) -> Value {
    if let Err(failure) = assert_navigation_epoch(gateway, meta) {
        return err(meta, &failure);
    }
    if let Err(failure) = gateway.ensure_connected().await {
        return err(meta, &failure);
    }
    match gateway.request_json(method, &path, body, true).await {
        Ok((_status, body)) => ok(meta, body),
        Err(failure) => err(meta, &failure),
    }
}

/* ── 邀请与成员（Owner）：条目形状按合同转换；角色判断由服务端收口，Member 调用只得 forbidden。 ── */

async fn invite_create(gateway: &mut Gateway, input: &Value, meta: &Value) -> Value {
    let role = match input.get("role").and_then(Value::as_str) {
        Some(role @ ("member" | "owner")) => role,
        Some(_) => return err(meta, &GatewayFailure::new("validation", "user_action")),
        None => "member",
    };
    let mut body = json!({ "role": role });
    if let Some(hours) = input.get("expiresInHours").and_then(Value::as_u64) {
        body["expiresInHours"] = json!(hours);
    }
    if let Err(failure) = gateway.ensure_connected().await {
        return err(meta, &failure);
    }
    match gateway.request_json(reqwest::Method::POST, "/invites", Some(body), true).await {
        Ok((_status, payload)) => ok(meta, json!({
            "version": 1,
            "id": payload.get("id").cloned().unwrap_or(Value::Null),
            "token": payload.get("token").cloned().unwrap_or(Value::Null),
            "tokenHint": payload.get("tokenHint").cloned().unwrap_or(Value::Null),
            "role": payload.get("role").cloned().unwrap_or(Value::Null),
            "expiresAt": payload.get("expiresAt").cloned().unwrap_or(Value::Null),
        })),
        Err(failure) => err(meta, &failure),
    }
}

async fn invite_list(gateway: &mut Gateway, meta: &Value) -> Value {
    if let Err(failure) = gateway.ensure_connected().await {
        return err(meta, &failure);
    }
    match gateway.request_json(reqwest::Method::GET, "/invites?limit=100", None, true).await {
        Ok((_status, payload)) => {
            let items: Vec<Value> = payload
                .get("items")
                .and_then(Value::as_array)
                .map(|rows| {
                    rows.iter()
                        .map(|row| json!({
                            "version": 1,
                            "id": row.get("id").cloned().unwrap_or(Value::Null),
                            "tokenHint": row.get("tokenHint").cloned().unwrap_or(Value::Null),
                            "role": row.get("role").cloned().unwrap_or(Value::Null),
                            "status": row.get("status").cloned().unwrap_or(Value::Null),
                            "createdAt": row.get("createdAt").cloned().unwrap_or(Value::Null),
                            "expiresAt": row.get("expiresAt").cloned().unwrap_or(Value::Null),
                            "consumedAt": row.get("consumedAt").cloned().unwrap_or(Value::Null),
                            "consumedByEmail": row.get("consumedBy").cloned().unwrap_or(Value::Null),
                            "revokedAt": row.get("revokedAt").cloned().unwrap_or(Value::Null),
                        }))
                        .collect()
                })
                .unwrap_or_default();
            ok(meta, json!({
                "version": 1,
                "items": items,
                "total": payload.get("total").cloned().unwrap_or(json!(items.len())),
            }))
        }
        Err(failure) => err(meta, &failure),
    }
}

async fn invite_revoke(gateway: &mut Gateway, input: &Value, meta: &Value) -> Value {
    let Some(invite_id) = uuid_field(input, "inviteId") else {
        return err(meta, &GatewayFailure::new("validation", "user_action"));
    };
    if let Err(failure) = gateway.ensure_connected().await {
        return err(meta, &failure);
    }
    match gateway.request_json(reqwest::Method::DELETE, &format!("/invites/{invite_id}"), None, true).await {
        Ok(_) => ok(meta, json!({ "revoked": true })),
        Err(failure) => err(meta, &failure),
    }
}

async fn member_list(gateway: &mut Gateway, meta: &Value) -> Value {
    if let Err(failure) = gateway.ensure_connected().await {
        return err(meta, &failure);
    }
    match gateway.request_json(reqwest::Method::GET, "/members?limit=200", None, true).await {
        Ok((_status, payload)) => {
            let items: Vec<Value> = payload
                .get("items")
                .and_then(Value::as_array)
                .map(|rows| {
                    rows.iter()
                        .map(|row| json!({
                            "version": 1,
                            "userId": row.get("userId").cloned().unwrap_or(Value::Null),
                            "email": row.get("email").cloned().unwrap_or(Value::Null),
                            "role": row.get("role").cloned().unwrap_or(Value::Null),
                            "joinedAt": row.get("joinedAt").cloned().unwrap_or(Value::Null),
                        }))
                        .collect()
                })
                .unwrap_or_default();
            ok(meta, json!({
                "version": 1,
                "items": items,
                "total": payload.get("total").cloned().unwrap_or(json!(items.len())),
            }))
        }
        Err(failure) => err(meta, &failure),
    }
}

async fn member_remove(gateway: &mut Gateway, input: &Value, meta: &Value) -> Value {
    let Some(user_id) = uuid_field(input, "userId") else {
        return err(meta, &GatewayFailure::new("validation", "user_action"));
    };
    if let Err(failure) = gateway.ensure_connected().await {
        return err(meta, &failure);
    }
    match gateway.request_json(reqwest::Method::DELETE, &format!("/members/{user_id}"), None, true).await {
        Ok(_) => ok(meta, json!({ "removed": true })),
        Err(failure) => err(meta, &failure),
    }
}

/// 笔记生成任务轮询：expansions / learning artifact / overview 三条任务表同形。
async fn note_task_get(gateway: &mut Gateway, input: &Value, meta: &Value, segment: &str) -> Value {
    let (Some(note_id), Some(task_id)) = (uuid_field(input, "noteId"), uuid_field(input, "taskId")) else {
        return err(meta, &GatewayFailure::new("validation", "user_action"));
    };
    api_get(gateway, meta, format!("/v2/notes/{note_id}/{segment}/{task_id}")).await
}

/* ── 学习卡 / 脑图 / 星图 / 学习产物：Electron 侧都是 REST 直通，路径与体形逐条对齐。 ── */

fn uuid_field(input: &Value, key: &str) -> Option<String> {
    input.get(key).and_then(Value::as_str).filter(|value| is_uuid(value)).map(str::to_string)
}

async fn api_post_json(gateway: &mut Gateway, meta: &Value, path: String, body: Option<Value>) -> Value {
    if let Err(failure) = gateway.ensure_connected().await {
        return err(meta, &failure);
    }
    match gateway.request_json(reqwest::Method::POST, &path, body, true).await {
        Ok((_status, body)) => ok(meta, body),
        Err(failure) => err(meta, &failure),
    }
}

async fn learning_card_get(gateway: &mut Gateway, input: &Value, meta: &Value) -> Value {
    let Some(note_id) = uuid_field(input, "noteId") else {
        return err(meta, &GatewayFailure::new("validation", "user_action"));
    };
    let path = match input.get("cardId") {
        None | Some(Value::Null) => format!("/v2/notes/{note_id}/learning-card"),
        Some(card) => match card.as_str().filter(|value| is_uuid(value)) {
            Some(card_id) => format!("/v2/notes/{note_id}/learning-card?cardId={card_id}"),
            None => return err(meta, &GatewayFailure::new("validation", "user_action")),
        },
    };
    api_get(gateway, meta, path).await
}

async fn learning_card_generate(gateway: &mut Gateway, input: &Value, meta: &Value) -> Value {
    let Some(note_id) = uuid_field(input, "noteId") else {
        return err(meta, &GatewayFailure::new("validation", "user_action"));
    };
    let Some(note_version_id) = uuid_field(input, "noteVersionId") else {
        return err(meta, &GatewayFailure::new("validation", "user_action"));
    };
    let mut body = json!({ "noteVersionId": note_version_id });
    if let Some(options) = input.get("options").filter(|value| value.is_object()) {
        body["options"] = options.clone();
    }
    api_post_json(gateway, meta, format!("/v2/notes/{note_id}/learning-card/generate"), Some(body)).await
}

async fn learning_card_attempt_start(gateway: &mut Gateway, input: &Value, meta: &Value) -> Value {
    let Some(card_id) = uuid_field(input, "cardId") else {
        return err(meta, &GatewayFailure::new("validation", "user_action"));
    };
    api_post_json(gateway, meta, format!("/v2/learning-cards/{card_id}/attempts"), None).await
}

async fn learning_card_answer(gateway: &mut Gateway, input: &Value, meta: &Value) -> Value {
    let (Some(card_id), Some(attempt_id), Some(question_id)) = (
        uuid_field(input, "cardId"),
        uuid_field(input, "attemptId"),
        uuid_field(input, "questionId"),
    ) else {
        return err(meta, &GatewayFailure::new("validation", "user_action"));
    };
    let Some(answer) = input.get("answer") else {
        return err(meta, &GatewayFailure::new("validation", "user_action"));
    };
    let mut body = json!({ "questionId": question_id, "answer": answer });
    if input.get("usedHint").and_then(Value::as_bool) == Some(true) {
        body["usedHint"] = json!(true);
    }
    api_post_json(
        gateway,
        meta,
        format!("/v2/learning-cards/{card_id}/attempts/{attempt_id}/answers"),
        Some(body),
    ).await
}

async fn learning_card_complete(gateway: &mut Gateway, input: &Value, meta: &Value) -> Value {
    let (Some(card_id), Some(attempt_id)) = (uuid_field(input, "cardId"), uuid_field(input, "attemptId")) else {
        return err(meta, &GatewayFailure::new("validation", "user_action"));
    };
    let body = (input.get("summaryOnly").and_then(Value::as_bool) == Some(true)).then(|| json!({ "summaryOnly": true }));
    api_post_json(
        gateway,
        meta,
        format!("/v2/learning-cards/{card_id}/attempts/{attempt_id}/complete"),
        body,
    ).await
}

async fn learning_card_history(gateway: &mut Gateway, input: &Value, meta: &Value) -> Value {
    let Some(card_id) = uuid_field(input, "cardId") else {
        return err(meta, &GatewayFailure::new("validation", "user_action"));
    };
    api_get(gateway, meta, format!("/v2/learning-cards/{card_id}/attempts")).await
}

async fn mind_map_task(gateway: &mut Gateway, input: &Value, meta: &Value) -> Value {
    let (Some(note_id), Some(task_id)) = (uuid_field(input, "noteId"), uuid_field(input, "taskId")) else {
        return err(meta, &GatewayFailure::new("validation", "user_action"));
    };
    api_get(gateway, meta, format!("/v2/notes/{note_id}/mind-map-tasks/{task_id}")).await
}

async fn mind_map_source(gateway: &mut Gateway, input: &Value, meta: &Value) -> Value {
    let (Some(note_id), Some(mind_map_id)) = (uuid_field(input, "noteId"), uuid_field(input, "mindMapId")) else {
        return err(meta, &GatewayFailure::new("validation", "user_action"));
    };
    api_get(gateway, meta, format!("/v2/notes/{note_id}/mind-maps/{mind_map_id}/source")).await
}

async fn note_deepening(gateway: &mut Gateway, input: &Value, meta: &Value) -> Value {
    let Some(note_id) = uuid_field(input, "noteId") else {
        return err(meta, &GatewayFailure::new("validation", "user_action"));
    };
    let mut path = format!("/v3/understanding/notes/{note_id}/deepening");
    if let Some(limit) = input.get("limit").and_then(Value::as_u64).filter(|value| (1..=500).contains(value)) {
        path.push_str(&format!("?limit={limit}"));
    }
    api_get(gateway, meta, path).await
}

/** 学习产物（互动演示/速看模板）要落到本机 `artifacts/<id>.html`，`astella-app://artifact/<id>`
 *  才端得出来：先按来源取 HTML（三种来源各一条服务端路径），再原子替换落盘。 */
async fn artifact_ensure(
    gateway: &mut Gateway,
    input: &Value,
    meta: &Value,
    app: Option<&tauri::AppHandle>,
) -> Value {
    let Some(artifact_id) = uuid_field(input, "artifactId") else {
        return err(meta, &GatewayFailure::new("validation", "user_action"));
    };
    let path = match input.get("origin").and_then(Value::as_str).unwrap_or("round") {
        "note_learning" => format!("/v2/note-learning-artifacts/{artifact_id}"),
        "note_learning_card" => format!("/v2/note-learning-card-operation-artifacts/{artifact_id}"),
        "round" => format!("/v2/note-learning-round-artifacts/{artifact_id}"),
        _ => return err(meta, &GatewayFailure::new("validation", "user_action")),
    };
    let Some(app) = app else {
        return err(meta, &GatewayFailure::new("local_storage_unavailable", "user_action"));
    };
    let Ok(app_data) = app.path().app_data_dir() else {
        return err(meta, &GatewayFailure::new("local_storage_unavailable", "user_action"));
    };
    if let Err(failure) = gateway.ensure_connected().await {
        return err(meta, &failure);
    }
    let (content_type, bytes) = match gateway.request_bytes(&path, "text/html", "text/html", usize::MAX).await {
        Ok(result) => result,
        Err(failure) => return err(meta, &failure),
    };
    if !content_type.starts_with("text/html") {
        return err(meta, &GatewayFailure::new("unsupported_contract", "user_action"));
    }
    let dir = app_data.join("artifacts");
    let tmp = dir.join(format!("{artifact_id}.html.tmp"));
    let file = dir.join(format!("{artifact_id}.html"));
    let stored = tokio::fs::create_dir_all(&dir).await.is_ok()
        && tokio::fs::write(&tmp, &bytes).await.is_ok()
        && tokio::fs::rename(&tmp, &file).await.is_ok();
    if !stored {
        let _ = tokio::fs::remove_file(&tmp).await;
        return err(meta, &GatewayFailure::new("local_storage_unavailable", "user_action"));
    }
    ok(meta, json!({ "stored": true }))
}

/* ── 导航（Electron `NavigationState` 的进程内镜像）：每个窗口一条栈，最近一条即 current。 ── */

struct NavigationState {
    entries: Vec<Value>,
    revision: u64,
}

static NAVIGATION: std::sync::OnceLock<std::sync::Mutex<NavigationState>> = std::sync::OnceLock::new();

const NAVIGATION_ENTRY_KINDS: &[&str] = &["startup", "user", "deep_link", "notification", "compat", "restore"];

fn meta_correlation(meta: &Value) -> Value {
    meta.get("correlationId").cloned().unwrap_or_else(|| json!("tauri-bridge"))
}

fn navigation_entry(
    route: &Value,
    meta: &Value,
    entry_kind: &str,
    identity: Option<(&str, &str)>,
    workspace_epoch: u64,
) -> Result<Value, GatewayFailure> {
    if !NAVIGATION_ENTRY_KINDS.contains(&entry_kind) {
        return Err(GatewayFailure::new("validation", "user_action"));
    }
    let Some(kind) = route.get("kind").and_then(Value::as_str) else {
        return Err(GatewayFailure::new("validation", "user_action"));
    };
    if kind == "auth.login" || kind == "auth.register" {
        return Ok(json!({
            "version": 1,
            "scope": "gate",
            "historyKey": format!("gate-{kind}"),
            "route": route,
            "entryKind": entry_kind,
            "correlationId": meta_correlation(meta),
        }));
    }
    if !crate::bridge::contract::ROUTES.contains(&kind) {
        return Err(GatewayFailure::new("route_not_available", "user_action"));
    }
    let Some((_, workspace_id)) = identity else {
        return Err(GatewayFailure::new("auth_required", "user_action"));
    };
    if workspace_epoch < 1 {
        return Err(GatewayFailure::new("auth_required", "user_action"));
    }
    Ok(json!({
        "version": 1,
        "scope": "workspace",
        "historyKey": format!("workspace-{kind}"),
        "workspaceId": workspace_id,
        "workspaceEpoch": workspace_epoch,
        "route": route,
        "level": if kind == "room.home" { "L0" } else { "L2" },
        "entryKind": entry_kind,
        "navigationOrigin": entry_kind,
        "focusReturnKey": kind,
        "correlationId": meta_correlation(meta),
    }))
}

fn navigation_snapshot(state: &NavigationState) -> Value {
    json!({
        "version": 1,
        "current": state.entries.last().cloned().unwrap_or(Value::Null),
        "stackRevision": state.revision,
        "canBack": state.entries.len() > 1,
    })
}

fn navigation_state(meta: &Value) -> &'static std::sync::Mutex<NavigationState> {
    NAVIGATION.get_or_init(|| {
        std::sync::Mutex::new(NavigationState {
            entries: vec![json!({
                "version": 1,
                "scope": "gate",
                "historyKey": "gate-auth.login",
                "route": { "kind": "auth.login" },
                "entryKind": "startup",
                "correlationId": meta_correlation(meta),
            })],
            revision: 0,
        })
    })
}

fn assert_navigation_epoch(gateway: &Gateway, meta: &Value) -> Result<(), GatewayFailure> {
    if let Some(epoch) = meta.get("workspaceEpoch").and_then(Value::as_u64) {
        if epoch != gateway.workspace_epoch() {
            return Err(GatewayFailure::new("stale_workspace", "resync_first"));
        }
    }
    Ok(())
}

fn navigation_resolve(gateway: &Gateway, input: &Value, meta: &Value) -> Value {
    if let Err(failure) = assert_navigation_epoch(gateway, meta) {
        return err(meta, &failure);
    }
    let route = input.get("route").cloned().unwrap_or(Value::Null);
    let state = navigation_state(meta).lock();
    let Ok(state) = state else { return err(meta, &GatewayFailure::new("safe_internal_error", "never")) };
    let entry = match navigation_entry(&route, meta, "user", gateway.identity(), gateway.workspace_epoch()) {
        Ok(entry) => entry,
        Err(failure) => return err(meta, &failure),
    };
    ok(meta, json!({
        "version": 1,
        "current": entry,
        "stackRevision": state.revision,
        "canBack": state.entries.len() > 1,
    }))
}

fn navigation_go(gateway: &Gateway, input: &Value, meta: &Value) -> Value {
    if let Err(failure) = assert_navigation_epoch(gateway, meta) {
        return err(meta, &failure);
    }
    let route = input.get("route").cloned().unwrap_or(Value::Null);
    let entry_kind = input.get("entryKind").and_then(Value::as_str).unwrap_or("user");
    let state = navigation_state(meta).lock();
    let Ok(mut state) = state else { return err(meta, &GatewayFailure::new("safe_internal_error", "never")) };
    let entry = match navigation_entry(&route, meta, entry_kind, gateway.identity(), gateway.workspace_epoch()) {
        Ok(entry) => entry,
        Err(failure) => return err(meta, &failure),
    };
    state.entries.push(entry);
    state.revision += 1;
    ok(meta, navigation_snapshot(&state))
}

fn navigation_back(meta: &Value) -> Value {
    let state = navigation_state(meta).lock();
    let Ok(mut state) = state else { return err(meta, &GatewayFailure::new("safe_internal_error", "never")) };
    if state.entries.len() > 1 {
        state.entries.pop();
        state.revision += 1;
    }
    ok(meta, navigation_snapshot(&state))
}

fn navigation_restore(meta: &Value) -> Value {
    let state = navigation_state(meta).lock();
    let Ok(state) = state else { return err(meta, &GatewayFailure::new("safe_internal_error", "never")) };
    ok(meta, navigation_snapshot(&state))
}

/// 认证成功后的统一收尾：读 `/auth/me` → 合同会话 → 记身份与纪元。
async fn current_session(gateway: &mut Gateway, meta: &Value, persistence: &str) -> Value {
    let deployment_ref = gateway
        .configuration()
        .map(|config| config.api_origin.clone())
        .unwrap_or_else(|_| "unconfigured".to_string());
    match gateway.request_json(reqwest::Method::GET, "/auth/me", None, true).await {
        Ok((_status, body)) => match session::authenticated_session(&body, persistence, &deployment_ref) {
            Some(value) => {
                if let Some(epoch) = value.get("workspaceEpoch").and_then(Value::as_u64) {
                    gateway.set_workspace_epoch(epoch);
                }
                if let (Some(user), Some(workspace)) = (
                    value.pointer("/user/userId").and_then(Value::as_str),
                    value.pointer("/workspace/workspaceId").and_then(Value::as_str),
                ) {
                    gateway.set_identity(user, workspace);
                }
                ok(meta, value)
            }
            None => err(meta, &GatewayFailure::new("unsupported_contract", "user_action")),
        },
        Err(failure) => err(meta, &failure),
    }
}

fn profile_result(body: &Value) -> Value {
    json!({
        "version": 1,
        "displayName": body.get("displayName").cloned().unwrap_or(Value::Null),
        "avatarUrl": body.get("avatarUrl").cloned().unwrap_or(Value::Null),
    })
}

async fn auth_register(gateway: &mut Gateway, input: &Value, meta: &Value) -> Value {
    let email = input.get("email").and_then(Value::as_str).unwrap_or("");
    let password = input.get("password").and_then(Value::as_str).unwrap_or("");
    if email.is_empty() || password.is_empty() {
        return err(meta, &GatewayFailure::new("validation", "user_action"));
    }
    let remember = input.get("remember").and_then(Value::as_bool).unwrap_or(true);
    let mut body = json!({ "email": email, "password": password });
    for key in ["inviteToken", "displayName", "emailCode"] {
        if let Some(value) = input.get(key).and_then(Value::as_str).filter(|value| !value.is_empty()) {
            body[key] = json!(value);
        }
    }
    if let Err(failure) = gateway.ensure_connected().await {
        return err(meta, &failure);
    }
    let result = gateway.request_json(reqwest::Method::POST, "/auth/register-v2", Some(body), false).await;
    let payload = match result {
        Ok((_status, payload)) => payload,
        Err(failure) if failure.http_status == Some(401) => {
            return err(meta, &GatewayFailure::new("invalid_credentials", "user_action"));
        }
        Err(failure) => return err(meta, &failure),
    };
    let Some(token) = payload.get("token").and_then(Value::as_str).filter(|value| !value.is_empty()) else {
        return err(meta, &GatewayFailure::new("unsupported_contract", "user_action"));
    };
    gateway.set_token(Some(token.to_string()));
    if remember {
        if let Err(failure) = gateway.persist_token(token).await {
            return err(meta, &failure);
        }
    } else {
        gateway.forget_stored_credential().await;
    }
    current_session(gateway, meta, if remember { "local_file" } else { "memory" }).await
}

async fn auth_join_workspace(gateway: &mut Gateway, input: &Value, meta: &Value) -> Value {
    let Some(invite_token) = input.get("inviteToken").and_then(Value::as_str).filter(|value| !value.is_empty()) else {
        return err(meta, &GatewayFailure::new("validation", "user_action"));
    };
    if let Err(failure) = gateway.ensure_connected().await {
        return err(meta, &failure);
    }
    match gateway
        .request_json(reqwest::Method::POST, "/auth/join-workspace", Some(json!({ "inviteToken": invite_token })), true)
        .await
    {
        Ok(_) => {
            let persistence = if gateway.has_stored_credential() { "local_file" } else { "memory" };
            current_session(gateway, meta, persistence).await
        }
        Err(failure) => err(meta, &failure),
    }
}

async fn auth_leave_workspace(gateway: &mut Gateway, input: &Value, meta: &Value) -> Value {
    let Some(workspace_id) = uuid_field(input, "workspaceId") else {
        return err(meta, &GatewayFailure::new("validation", "user_action"));
    };
    if let Err(failure) = gateway.ensure_connected().await {
        return err(meta, &failure);
    }
    match gateway
        .request_json(reqwest::Method::POST, "/auth/leave-workspace", Some(json!({ "workspaceId": workspace_id })), true)
        .await
    {
        Ok(_) => {
            let persistence = if gateway.has_stored_credential() { "local_file" } else { "memory" };
            current_session(gateway, meta, persistence).await
        }
        Err(failure) => err(meta, &failure),
    }
}

async fn auth_change_password(gateway: &mut Gateway, input: &Value, meta: &Value) -> Value {
    let (Some(current_password), Some(new_password)) = (
        input.get("currentPassword").and_then(Value::as_str).filter(|value| !value.is_empty()),
        input.get("newPassword").and_then(Value::as_str).filter(|value| !value.is_empty()),
    ) else {
        return err(meta, &GatewayFailure::new("validation", "user_action"));
    };
    if let Err(failure) = gateway.ensure_connected().await {
        return err(meta, &failure);
    }
    match gateway
        .request_json(
            reqwest::Method::POST,
            "/auth/change-password",
            Some(json!({ "currentPassword": current_password, "newPassword": new_password })),
            true,
        )
        .await
    {
        Ok(_) => {
            crate::collab_client::close_all_live_sessions().await;
            crate::chat_stream::close_all();
            crate::bridge_context::clear_local();
            gateway.set_token(None);
            gateway.clear_identity();
            gateway.forget_stored_credential().await;
            ok(meta, json!({ "changed": true, "sessionsRevoked": true }))
        }
        Err(failure) => err(meta, &failure),
    }
}

async fn auth_get_profile(gateway: &mut Gateway, meta: &Value) -> Value {
    if let Err(failure) = gateway.ensure_connected().await {
        return err(meta, &failure);
    }
    match gateway.request_json(reqwest::Method::GET, "/auth/me", None, true).await {
        Ok((_status, body)) => ok(meta, profile_result(&body)),
        Err(failure) => err(meta, &failure),
    }
}

async fn auth_update_profile(gateway: &mut Gateway, input: &Value, meta: &Value) -> Value {
    let mut body = serde_json::Map::new();
    if let Some(value) = input.get("displayName") {
        body.insert("displayName".to_string(), value.clone());
    }
    if let Some(value) = input.get("avatarUrl") {
        body.insert("avatarUrl".to_string(), value.clone());
    }
    if body.is_empty() {
        return err(meta, &GatewayFailure::new("validation", "user_action"));
    }
    if let Err(failure) = gateway.ensure_connected().await {
        return err(meta, &failure);
    }
    match gateway
        .request_json(reqwest::Method::PUT, "/auth/profile", Some(Value::Object(body)), true)
        .await
    {
        Ok(_) => match gateway.request_json(reqwest::Method::GET, "/auth/me", None, true).await {
            Ok((_status, body)) => ok(meta, profile_result(&body)),
            Err(failure) => err(meta, &failure),
        },
        Err(failure) => err(meta, &failure),
    }
}

fn avatar_key_valid(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 512
        && !key.contains("..")
        && key.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '_' | '-' | '.'))
}

async fn auth_get_avatar(gateway: &mut Gateway, input: &Value, meta: &Value) -> Value {
    let object_key = input
        .get("request")
        .and_then(|request| request.get("objectKey"))
        .and_then(Value::as_str)
        .or_else(|| input.get("objectKey").and_then(Value::as_str))
        .unwrap_or("");
    if !avatar_key_valid(object_key) {
        return err(meta, &GatewayFailure::new("validation", "user_action"));
    }
    if let Err(failure) = gateway.ensure_connected().await {
        return err(meta, &failure);
    }
    match gateway.request_bytes(&format!("/uploads/{object_key}"), "image/*", "image/", 100 * 1024 * 1024).await {
        Ok((content_type, bytes)) => {
            let mime = content_type.split(';').next().unwrap_or("").trim().to_string();
            if !mime.starts_with("image/") {
                return err(meta, &GatewayFailure::new("unsupported_contract", "user_action"));
            }
            use base64::Engine;
            ok(meta, json!({
                "version": 1,
                "mimeType": mime,
                "imageBase64": base64::engine::general_purpose::STANDARD.encode(&bytes),
                "byteLength": bytes.len(),
            }))
        }
        Err(failure) => err(meta, &failure),
    }
}

async fn auth_upload_avatar(gateway: &mut Gateway, input: &Value, meta: &Value) -> Value {
    let request = input.get("request").filter(|value| value.is_object());
    match (
        request.and_then(|request| request.get("fileName").and_then(Value::as_str)).filter(|name| !name.is_empty() && name.len() <= 255),
        request.and_then(|request| request.get("mimeType").and_then(Value::as_str)),
        request.and_then(|request| request.get("bytesBase64").and_then(Value::as_str)),
    ) {
        (Some(file_name), Some(mime_type), Some(encoded)) => {
            use base64::Engine;
            let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(encoded) else {
                return err(meta, &GatewayFailure::new("validation", "user_action"));
            };
            if bytes.is_empty() || bytes.len() > 100 * 1024 * 1024 {
                return err(meta, &GatewayFailure::new("validation", "user_action"));
            }
            if let Err(failure) = gateway.ensure_connected().await {
                return err(meta, &failure);
            }
            match gateway.post_avatar(file_name, mime_type, bytes).await {
                Ok(payload) => {
                    let object_key = payload.get("objectKey").and_then(Value::as_str).unwrap_or("");
                    if !avatar_key_valid(object_key) {
                        return err(meta, &GatewayFailure::new("unsupported_contract", "user_action"));
                    }
                    ok(meta, json!({
                        "version": 1,
                        "url": payload.get("url").cloned().unwrap_or(Value::Null),
                        "objectKey": object_key,
                    }))
                }
                Err(failure) => err(meta, &failure),
            }
        }
        _ => err(meta, &GatewayFailure::new("validation", "user_action")),
    }
}

/** 本地退登是权威动作：先清本机凭据，服务端吊销失败也不回滚（Electron 同一条边界）。
 *  `keepQuickLogin` 时保留凭据文件、跳过服务端吊销，下次启动仍可免密恢复。 */
async fn auth_logout(gateway: &mut Gateway, input: &Value, meta: &Value) -> Value {
    let keep_quick_login = input.get("keepQuickLogin").and_then(Value::as_bool).unwrap_or(false);
    let token = gateway.token().map(str::to_string);
    crate::collab_client::close_all_live_sessions().await;
    crate::chat_stream::close_all();
    crate::bridge_context::clear_local();
    gateway.clear_identity();
    let quick_login_available = keep_quick_login && gateway.has_stored_credential();
    if !quick_login_available {
        gateway.forget_stored_credential().await;
    }
    let server_revoked = if quick_login_available || token.is_none() {
        false
    } else {
        gateway.set_token(token);
        match gateway.ensure_connected().await {
            Ok(()) => gateway.request_json(reqwest::Method::POST, "/auth/logout", None, true).await.is_ok(),
            Err(_) => false,
        }
    };
    gateway.set_token(None);
    ok(meta, json!({
        "loggedOut": true,
        "serverRevoked": server_revoked,
        "quickLoginAvailable": quick_login_available,
    }))
}

/// 切空间：服务端换发令牌 → 记盘（按既有持久化档位）→ 纪元+1 → 断协同/聊天/桥 → 重读会话。
async fn workspace_switch(gateway: &mut Gateway, input: &Value, meta: &Value) -> Value {
    let Some(workspace_id) = uuid_field(input, "workspaceId") else {
        return err(meta, &GatewayFailure::new("validation", "user_action"));
    };
    if let Err(failure) = gateway.ensure_connected().await {
        return err(meta, &failure);
    }
    let persistence = if gateway.has_stored_credential() { "local_file" } else { "memory" };
    let payload = match gateway
        .request_json(reqwest::Method::POST, "/auth/switch-workspace", Some(json!({ "workspaceId": workspace_id })), true)
        .await
    {
        Ok((_status, payload)) => payload,
        Err(failure) => return err(meta, &failure),
    };
    let Some(token) = payload.get("token").and_then(Value::as_str).filter(|value| !value.is_empty()) else {
        return err(meta, &GatewayFailure::new("unsupported_contract", "user_action"));
    };
    crate::collab_client::close_all_live_sessions().await;
    crate::chat_stream::close_all();
    crate::bridge_context::clear_local();
    gateway.set_token(Some(token.to_string()));
    if persistence == "local_file" {
        if let Err(failure) = gateway.persist_token(token).await {
            return err(meta, &failure);
        }
    } else {
        gateway.forget_stored_credential().await;
    }
    gateway.set_workspace_epoch(gateway.workspace_epoch() + 1);
    current_session(gateway, meta, persistence).await
}

async fn workspace_create(gateway: &mut Gateway, input: &Value, meta: &Value) -> Value {
    let Some(name) = input.get("name").and_then(Value::as_str).map(str::trim).filter(|name| !name.is_empty() && name.len() <= 50) else {
        return err(meta, &GatewayFailure::new("validation", "user_action"));
    };
    if let Err(failure) = gateway.ensure_connected().await {
        return err(meta, &failure);
    }
    let payload = match gateway
        .request_json(reqwest::Method::POST, "/workspaces", Some(json!({ "name": name })), true)
        .await
    {
        Ok((_status, payload)) => payload,
        Err(failure) => return err(meta, &failure),
    };
    let Some(workspace_id) = payload.get("workspaceId").and_then(Value::as_str).filter(|value| is_uuid(value)) else {
        return err(meta, &GatewayFailure::new("unsupported_contract", "user_action"));
    };
    let switched = workspace_switch(gateway, &json!({ "workspaceId": workspace_id }), meta).await;
    if switched.get("ok").and_then(Value::as_bool) != Some(true) {
        return switched;
    }
    ok(meta, json!({
        "version": 1,
        "workspaceId": workspace_id,
        "name": payload.get("workspaceName").and_then(Value::as_str).unwrap_or(name),
    }))
}

async fn workspace_rename(gateway: &mut Gateway, input: &Value, meta: &Value) -> Value {
    let (Some(workspace_id), Some(name)) = (
        uuid_field(input, "workspaceId"),
        input.get("name").and_then(Value::as_str).map(str::trim).filter(|name| !name.is_empty() && name.len() <= 50),
    ) else {
        return err(meta, &GatewayFailure::new("validation", "user_action"));
    };
    if let Err(failure) = gateway.ensure_connected().await {
        return err(meta, &failure);
    }
    match gateway
        .request_json(
            reqwest::Method::PATCH,
            &format!("/workspaces/{workspace_id}/name"),
            Some(json!({ "name": name })),
            true,
        )
        .await
    {
        Ok((_status, body)) => ok(meta, json!({
            "version": 1,
            "workspaceId": workspace_id,
            "name": body.get("workspaceName").and_then(Value::as_str).unwrap_or(name),
        })),
        Err(failure) => err(meta, &failure),
    }
}

async fn workspace_dissolve_preview(gateway: &mut Gateway, input: &Value, meta: &Value) -> Value {
    let Some(workspace_id) = uuid_field(input, "workspaceId") else {
        return err(meta, &GatewayFailure::new("validation", "user_action"));
    };
    if let Err(failure) = gateway.ensure_connected().await {
        return err(meta, &failure);
    }
    match gateway
        .request_json(reqwest::Method::GET, &format!("/workspaces/{workspace_id}/dissolve-preview"), None, true)
        .await
    {
        Ok((_status, body)) => ok(meta, json!({
            "version": 1,
            "workspaceId": workspace_id,
            "counts": body.get("counts").cloned().unwrap_or(json!({})),
        })),
        Err(failure) => err(meta, &failure),
    }
}

async fn workspace_dissolve(gateway: &mut Gateway, input: &Value, meta: &Value) -> Value {
    let Some(workspace_id) = uuid_field(input, "workspaceId") else {
        return err(meta, &GatewayFailure::new("validation", "user_action"));
    };
    if let Err(failure) = gateway.ensure_connected().await {
        return err(meta, &failure);
    }
    let result = gateway
        .request_json(reqwest::Method::DELETE, &format!("/workspaces/{workspace_id}"), None, true)
        .await;
    match result {
        Ok((_status, body)) => {
            crate::collab_client::close_all_live_sessions().await;
            crate::chat_stream::close_all();
            crate::bridge_context::clear_local();
            gateway.clear_identity();
            ok(meta, json!({
                "version": 1,
                "workspaceId": workspace_id,
                "counts": body.get("counts").cloned().unwrap_or(json!({})),
            }))
        }
        Err(failure) => err(meta, &failure),
    }
}

async fn workspace_transfer(gateway: &mut Gateway, input: &Value, meta: &Value) -> Value {
    let (Some(workspace_id), Some(to_user_id)) = (uuid_field(input, "workspaceId"), uuid_field(input, "toUserId")) else {
        return err(meta, &GatewayFailure::new("validation", "user_action"));
    };
    if let Err(failure) = gateway.ensure_connected().await {
        return err(meta, &failure);
    }
    match gateway
        .request_json(
            reqwest::Method::POST,
            &format!("/workspaces/{workspace_id}/transfer-ownership"),
            Some(json!({ "toUserId": to_user_id })),
            true,
        )
        .await
    {
        Ok((_status, body)) => {
            gateway.clear_identity();
            ok(meta, json!({
                "version": 1,
                "workspaceId": workspace_id,
                "newOwnerUserId": body.get("newOwnerUserId").and_then(Value::as_str).unwrap_or(&to_user_id),
            }))
        }
        Err(failure) => err(meta, &failure),
    }
}

/// 取一张站内图片（按 objectKey）：回字节与按扩展名的小写后缀，失败即 None（不阻断导出）。
async fn fetch_export_image(gateway: &mut Gateway, object_key: &str) -> Option<(Vec<u8>, String)> {
    let extension = object_key.rsplit('.').next().map(|ext| format!(".{}", ext.to_ascii_lowercase()))?;
    match gateway
        .request_bytes(&format!("/uploads/{object_key}"), "image/*", "image/", 100 * 1024 * 1024)
        .await
    {
        Ok((content_type, bytes)) if content_type.starts_with("image/") && !bytes.is_empty() => Some((bytes, extension)),
        _ => None,
    }
}

/// 导出文件名主干：非法字符换空格、折叠空白、去尾点/空格、限长 120；
/// 清空或撞 Windows 保留设备名时退回 `笔记 <id 前 8 位>`（与 Electron 同判据）。
fn markdown_file_stem(title: &str, note_id: &str) -> String {
    let cleaned: String = title
        .chars()
        .map(|c| {
            if matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || (c as u32) < 0x20 {
                ' '
            } else {
                c
            }
        })
        .collect();
    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = collapsed.trim_end_matches(['.', ' ']).to_string();
    let base: String = trimmed.chars().take(120).collect();
    let base = base.trim_end_matches(['.', ' ']).to_string();
    let lower = base.to_ascii_lowercase();
    let reserved_device = matches!(lower.as_str(), "con" | "prn" | "aux" | "nul")
        || (matches!(lower.get(..3), Some("com" | "lpt")) && lower.len() == 4 && lower.as_bytes()[3].is_ascii_digit());
    if base.is_empty() || reserved_device {
        return format!("笔记 {}", note_id.chars().take(8).collect::<String>());
    }
    base
}

/// 撞名只增不改：`标题.md`、`标题 (2).md`…（比较统一按小写，macOS 大小写不敏感）。
fn allocate_markdown_name(stem: &str, taken: &mut std::collections::HashSet<String>) -> String {
    let candidate = format!("{stem}.md");
    if !taken.contains(&candidate.to_lowercase()) {
        taken.insert(candidate.to_lowercase());
        return candidate;
    }
    for index in 2..10_000 {
        let next = format!("{stem} ({index}).md");
        if !taken.contains(&next.to_lowercase()) {
            taken.insert(next.to_lowercase());
            return next;
        }
    }
    let fallback = format!("{stem}-{}", &crate::opened_files::uuid_v4()[..6]);
    taken.insert(fallback.to_lowercase());
    fallback
}

/// 笔记导出为 Markdown 目录（第一阶段）：服务端给正文，本机负责选目录、起名、落盘。
/// 图片本地化（`assets/…` + AST 重写）尚未移植——正文里的站内图片地址保持原样。
async fn notes_markdown_export(gateway: &mut Gateway, meta: &Value, app: Option<&tauri::AppHandle>) -> Value {
    if let Err(failure) = gateway.ensure_connected().await {
        return err(meta, &failure);
    }
    let directory = match std::env::var("ASTELLA_EXPORT_DIRECTORY").ok().filter(|value| !value.is_empty()) {
        Some(path) => std::path::PathBuf::from(path),
        None => {
            use tauri_plugin_dialog::DialogExt;
            let Some(app) = app else {
                return err(meta, &GatewayFailure::new("local_storage_unavailable", "user_action"));
            };
            match app.dialog().file().blocking_pick_folder().and_then(|file| file.into_path().ok()) {
                Some(path) => path,
                None => return ok(meta, json!({
                    "version": 1, "canceled": true, "directory": Value::Null,
                    "total": 0, "exported": 0, "failed": 0,
                })),
            }
        }
    };
    if tokio::fs::create_dir_all(&directory).await.is_err() {
        return err(meta, &GatewayFailure::new("local_storage_unavailable", "user_action"));
    }
    let mut taken: std::collections::HashSet<String> = std::collections::HashSet::new();
    if let Ok(mut entries) = tokio::fs::read_dir(&directory).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            taken.insert(entry.file_name().to_string_lossy().to_lowercase());
        }
    }
    let mut notes: Vec<(String, String)> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut cursor: Option<String> = None;
    loop {
        let mut path = "/notes?limit=100&trashed=false".to_string();
        if let Some(cursor) = &cursor {
            path.push_str(&format!("&cursor={}", encode_query_value(cursor)));
        }
        let body = match gateway.request_json(reqwest::Method::GET, &path, None, true).await {
            Ok((_status, body)) => body,
            Err(failure) => return err(meta, &failure),
        };
        if let Some(items) = body.get("items").and_then(Value::as_array) {
            for item in items {
                let Some(id) = item.get("id").and_then(Value::as_str) else { continue };
                if !seen.insert(id.to_string()) {
                    continue;
                }
                let title = item.get("title").and_then(Value::as_str).unwrap_or("").to_string();
                notes.push((id.to_string(), title));
            }
        }
        let next = body.get("nextCursor").and_then(Value::as_str).filter(|value| !value.is_empty()).map(str::to_string);
        match next {
            Some(next) if Some(next.clone()) != cursor => cursor = Some(next),
            _ => break,
        }
    }
    let total = notes.len();
    let mut exported = 0usize;
    let mut failed = 0usize;
    let mut image_names: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut image_failures = 0usize;
    let mut image_cache: std::collections::HashMap<String, Option<String>> = std::collections::HashMap::new();
    let object_key_pattern = regex::Regex::new(
        r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/(?:(?:notes|sources|imports)/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|companion/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(?:png|jpg|jpeg|gif|webp)$",
    )
    .expect("object key pattern");
    for (note_id, title) in notes {
        let markdown_bytes = match gateway
            .request_bytes(&format!("/export/notes/{note_id}"), "text/markdown", "text/", 100 * 1024 * 1024)
            .await
        {
            Ok((_content_type, bytes)) => bytes,
            Err(_) => {
                failed += 1;
                continue;
            }
        };
        let mut markdown = String::from_utf8_lossy(&markdown_bytes).to_string();
        let sources = crate::markdown_images::image_sources(&markdown);
        let mut replacements: std::collections::HashMap<String, String> = std::collections::HashMap::new();
        for src in sources {
            let Some(object_key) = src.strip_prefix("/api/uploads/").filter(|key| object_key_pattern.is_match(key)) else {
                continue;
            };
            if !image_cache.contains_key(object_key) {
                let fetched = fetch_export_image(gateway, object_key).await;
                let name = match fetched {
                    Some((bytes, extension)) => {
                        use sha2::{Digest, Sha256};
                        let digest = hex::encode(Sha256::digest(&bytes));
                        let name = format!("{}{}", &digest[..20], extension);
                        let assets_directory = directory.join("assets");
                        let written = tokio::fs::create_dir_all(&assets_directory).await.is_ok()
                            && tokio::fs::write(assets_directory.join(&name), &bytes).await.is_ok();
                        written.then_some(name)
                    }
                    None => None,
                };
                if name.is_none() {
                    image_failures += 1;
                }
                image_cache.insert(object_key.to_string(), name);
            }
            if let Some(Some(name)) = image_cache.get(object_key) {
                image_names.insert(name.clone());
                replacements.insert(src, format!("assets/{}", crate::markdown_images::encode_url_segment(name)));
            }
        }
        if !replacements.is_empty() {
            markdown = crate::markdown_images::rewrite_image_paths(&markdown, &replacements);
        }
        let stem = markdown_file_stem(&title, &note_id);
        let name = allocate_markdown_name(&stem, &mut taken);
        if tokio::fs::write(directory.join(&name), markdown.as_bytes()).await.is_ok() {
            exported += 1;
        } else {
            failed += 1;
        }
    }
    ok(meta, json!({
        "version": 1,
        "canceled": false,
        "directory": directory.to_string_lossy(),
        "total": total,
        "exported": exported,
        "failed": failed,
        "images": image_names.len(),
        "imageFailures": image_failures,
    }))
}

/// 整库导出：服务端给一份 JSON，保存对话框选位置后原样落盘。
/// `ASTELLA_EXPORT_PATH` 是显式的测试注入点（live 用例写临时文件），不是隐藏分支。
fn pick_export_path(app: Option<&tauri::AppHandle>, default_name: &str) -> Option<std::path::PathBuf> {
    if let Ok(path) = std::env::var("ASTELLA_EXPORT_PATH") {
        if !path.is_empty() {
            return Some(std::path::PathBuf::from(path));
        }
    }
    use tauri_plugin_dialog::DialogExt;
    let app = app?;
    app.dialog()
        .file()
        .set_file_name(default_name)
        .add_filter("JSON", &["json"])
        .blocking_save_file()
        .and_then(|file| file.into_path().ok())
}

async fn workspace_export(gateway: &mut Gateway, meta: &Value, app: Option<&tauri::AppHandle>) -> Value {
    if let Err(failure) = gateway.ensure_connected().await {
        return err(meta, &failure);
    }
    let payload = match gateway.request_json(reqwest::Method::GET, "/export/workspace", None, true).await {
        Ok((_status, payload)) => payload,
        Err(failure) => return err(meta, &failure),
    };
    if !payload.is_object() {
        return err(meta, &GatewayFailure::new("unsupported_contract", "user_action"));
    }
    let date = &crate::collab_client::iso_now()[..10];
    let default_name = format!("astella-workspace-{date}.json");
    let Some(path) = pick_export_path(app, &default_name) else {
        return ok(meta, json!({ "version": 1, "saved": false, "canceled": true, "filePath": Value::Null, "bytes": 0 }));
    };
    let text = serde_json::to_string_pretty(&payload).unwrap_or_else(|_| "{}".to_string());
    if tokio::fs::write(&path, text.as_bytes()).await.is_err() {
        return err(meta, &GatewayFailure::new("safe_internal_error", "user_action"));
    }
    ok(meta, json!({
        "version": 1,
        "saved": true,
        "canceled": false,
        "filePath": path.to_string_lossy(),
        "bytes": text.len(),
    }))
}

async fn workspace_ai_audit_log(gateway: &mut Gateway, input: &Value, meta: &Value) -> Value {
    let limit = input.get("limit").and_then(Value::as_u64).map(|value| value.clamp(1, 100)).unwrap_or(20);
    let offset = input.get("offset").and_then(Value::as_u64).unwrap_or(0);
    api_get(gateway, meta, format!("/workspace/ai-audit-log?limit={limit}&offset={offset}")).await
}

/** 空间列表：原始条目只有 workspaceName，按合同转成 WorkspaceSummaryV1（版本号+改名+丢 leftAt）。 */
async fn workspace_list(gateway: &mut Gateway, meta: &Value) -> Value {
    if let Err(failure) = gateway.ensure_connected().await {
        return err(meta, &failure);
    }
    match gateway.request_json(reqwest::Method::GET, "/auth/workspaces", None, true).await {
        Ok((_status, body)) => {
            let workspaces: Vec<Value> = body
                .get("workspaces")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .map(|item| json!({
                            "version": 1,
                            "workspaceId": item.get("workspaceId").cloned().unwrap_or(Value::Null),
                            "name": item.get("workspaceName").cloned().unwrap_or(Value::Null),
                            "role": item.get("role").cloned().unwrap_or(Value::Null),
                            "workspaceType": item.get("workspaceType").cloned().unwrap_or(Value::Null),
                            "isPersonal": item.get("isPersonal").cloned().unwrap_or(json!(false)),
                        }))
                        .collect()
                })
                .unwrap_or_default();
            ok(meta, json!({ "workspaces": workspaces }))
        }
        Err(failure) => err(meta, &failure),
    }
}

async fn auth_state(gateway: &mut Gateway, meta: &Value) -> Value {
    gateway.restore_stored_credential().await;
    if gateway.token().is_none() {
        return ok(meta, session::anonymous_session());
    }
    if let Err(failure) = gateway.ensure_connected().await {
        return err(meta, &failure);
    }
    let deployment_ref = gateway
        .configuration()
        .map(|config| config.api_origin.clone())
        .unwrap_or_else(|_| "unconfigured".to_string());
    match gateway.request_json(reqwest::Method::GET, "/auth/me", None, true).await {
        Ok((_status, body)) => {
            let persistence = if gateway.has_stored_credential() { "local_file" } else { "memory" };
            match session::authenticated_session(&body, persistence, &deployment_ref) {
                Some(value) => {
                    if let Some(epoch) = value.get("workspaceEpoch").and_then(Value::as_u64) {
                        gateway.set_workspace_epoch(epoch);
                    }
                    if let (Some(user), Some(workspace)) = (
                        value.pointer("/user/userId").and_then(Value::as_str),
                        value.pointer("/workspace/workspaceId").and_then(Value::as_str),
                    ) {
                        gateway.set_identity(user, workspace);
                    }
                    ok(meta, value)
                }
                None => err(meta, &GatewayFailure::new("unsupported_contract", "user_action")),
            }
        }
        Err(failure) if failure.code == "auth_required" => {
            // 令牌已被服务端否定：本机那份跟着作废（request_json 已清），
            // 界面按匿名处理，回到登录表单而不是显示一次失败。
            ok(meta, session::anonymous_session())
        }
        Err(failure) => err(meta, &failure),
    }
}

async fn login(gateway: &mut Gateway, input: &Value, meta: &Value) -> Value {
    let email = input.get("email").and_then(Value::as_str).unwrap_or("").to_string();
    let password = input.get("password").and_then(Value::as_str).unwrap_or("").to_string();
    let remember = input.get("remember").and_then(Value::as_bool).unwrap_or(true);
    if email.is_empty() || password.is_empty() {
        return err(meta, &GatewayFailure::new("validation", "user_action"));
    }
    if let Err(failure) = gateway.ensure_connected().await {
        return err(meta, &failure);
    }
    let body = json!({ "email": email, "password": password, "remember": remember });
    let result = gateway.request_json(reqwest::Method::POST, "/auth/login", Some(body), false).await;
    let (_, payload) = match result {
        Ok(value) => value,
        Err(failure) if failure.http_status == Some(401) => {
            return err(meta, &GatewayFailure::new("invalid_credentials", "user_action"));
        }
        Err(failure) => return err(meta, &failure),
    };
    let Some(token) = payload.get("token").and_then(Value::as_str).filter(|value| !value.is_empty()) else {
        return err(meta, &GatewayFailure::new("unsupported_contract", "user_action"));
    };
    gateway.set_token(Some(token.to_string()));
    if remember {
        if let Err(failure) = gateway.persist_token(token).await {
            return err(meta, &failure);
        }
    } else {
        gateway.forget_stored_credential().await;
    }
    let deployment_ref = gateway
        .configuration()
        .map(|config| config.api_origin.clone())
        .unwrap_or_else(|_| "unconfigured".to_string());
    match gateway.request_json(reqwest::Method::GET, "/auth/me", None, true).await {
        Ok((_status, body)) => {
            let persistence = if remember { "local_file" } else { "memory" };
            match session::authenticated_session(&body, persistence, &deployment_ref) {
                Some(value) => {
                    if let Some(epoch) = value.get("workspaceEpoch").and_then(Value::as_u64) {
                        gateway.set_workspace_epoch(epoch);
                    }
                    if let (Some(user), Some(workspace)) = (
                        value.pointer("/user/userId").and_then(Value::as_str),
                        value.pointer("/workspace/workspaceId").and_then(Value::as_str),
                    ) {
                        gateway.set_identity(user, workspace);
                    }
                    ok(meta, value)
                }
                None => err(meta, &GatewayFailure::new("unsupported_contract", "user_action")),
            }
        }
        Err(failure) => err(meta, &failure),
    }
}

async fn room_projection(gateway: &mut Gateway, meta: &Value) -> Value {
    if let Err(failure) = gateway.ensure_connected().await {
        return err(meta, &failure);
    }
    let notes = gateway.request_json(reqwest::Method::GET, "/notes?limit=20", None, true).await;
    let sources = gateway.request_json(reqwest::Method::GET, "/sources?limit=1", None, true).await;
    match (notes, sources) {
        (Ok((_, notes)), Ok((_, sources))) => ok(meta, project_room(&notes, &sources, gateway.workspace_epoch())),
        (Err(failure), _) | (_, Err(failure)) => err(meta, &failure),
    }
}

/// 房间投影的合成规则与 Electron `getRoomProjection` 逐条对齐（最近笔记/来源计数/首用态）。
fn project_room(notes: &Value, sources: &Value, workspace_epoch: u64) -> Value {
    let items = notes.get("items").and_then(Value::as_array).cloned().unwrap_or_default();
    let total = notes.get("total").and_then(Value::as_u64).unwrap_or(items.len() as u64);
    let source_total = sources.get("total").and_then(Value::as_u64).unwrap_or(0);
    let latest = items.first();
    let latest_id = latest.and_then(|note| note.get("id")).and_then(Value::as_str).unwrap_or("none");
    let recent_note = latest
        .and_then(|note| {
            let id = note.get("id")?.as_str()?;
            let version = note.get("currentVersionId")?.as_str()?;
            let title = note.get("title").and_then(Value::as_str).unwrap_or("");
            Some(json!({ "noteId": id, "noteVersionId": version, "title": title }))
        });
    let activities: Vec<Value> = items
        .iter()
        .take(6)
        .filter_map(|note| {
            Some(json!({
                "activityId": note.get("id")?.as_str()?,
                "kind": "note.updated",
                "occurredAt": note.get("updatedAt")?.as_str()?,
            }))
        })
        .collect();
    let summary = if activities.is_empty() {
        json!({ "state": "empty" })
    } else {
        json!({ "state": "data", "data": { "items": activities } })
    };
    json!({
        "version": 1,
        "workspaceEpoch": workspace_epoch,
        "snapshotAt": "2026-11-18T00:00:00Z",
        "dashboardRevision": format!("room-{total}-{source_total}-{latest_id}"),
        "mode": if total > 0 { "notes" } else { "first_use" },
        "recentNote": recent_note,
        "recentActivitySummary": summary,
        "captureCapability": { "state": "enabled" },
        "sectionStates": { "recentActivitySummary": { "state": if activities.is_empty() { "empty" } else { "data" } } },
        "degradation": null,
    })
}

/// 站内图片：带会话取原始字节，按合同投影成 `{version,mimeType,imageBase64,byteLength}`。
/// 渲染层拿不到令牌，也不直连 API——与 Electron `getSourceImage` 同一条边界。
async fn source_get_image(gateway: &mut Gateway, input: &Value, meta: &Value) -> Value {
    let Some(object_key) = input
        .get("request")
        .and_then(|request| request.get("objectKey"))
        .and_then(Value::as_str)
    else {
        return err(meta, &GatewayFailure::new("validation", "user_action"));
    };
    let key_pattern = regex::Regex::new(
        r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/(?:(?:notes|sources|imports)/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|companion/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(?:png|jpg|jpeg|gif|webp)$",
    )
    .expect("object key pattern");
    if object_key.len() > 512 || !key_pattern.is_match(object_key) {
        return err(meta, &GatewayFailure::new("validation", "user_action"));
    }
    if let Err(failure) = gateway.ensure_connected().await {
        return err(meta, &failure);
    }
    let path = format!("/uploads/{object_key}");
    match gateway.request_bytes(&path, "image/*", "image/", 100 * 1024 * 1024).await {
        Ok((content_type, bytes)) => {
            let mime = content_type.split(';').next().unwrap_or("").trim().to_string();
            if !matches!(mime.as_str(), "image/png" | "image/jpeg" | "image/gif" | "image/webp") {
                return err(meta, &GatewayFailure::new("unsupported_contract", "user_action"));
            }
            use base64::Engine;
            let image_base64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
            ok(meta, json!({
                "version": 1,
                "mimeType": mime,
                "imageBase64": image_base64,
                "byteLength": bytes.len(),
            }))
        }
        Err(failure) => err(meta, &failure),
    }
}

/// 删除/恢复一篇笔记：两条都是「发出去成功即回执」，服务端没有额外正文。
async fn note_mutation(
    gateway: &mut Gateway,
    input: &Value,
    meta: &Value,
    method: reqwest::Method,
    status: &'static str,
) -> Value {
    let Some(note_id) = string_param(input, "noteId") else {
        return err(meta, &GatewayFailure::new("validation", "user_action"));
    };
    if !is_uuid(note_id) {
        return err(meta, &GatewayFailure::new("validation", "user_action"));
    }
    if let Err(failure) = gateway.ensure_connected().await {
        return err(meta, &failure);
    }
    let path = if status == "restored" {
        format!("/notes/{note_id}/restore")
    } else {
        format!("/notes/{note_id}")
    };
    match gateway.request_json(method, &path, None, true).await {
        Ok(_) => ok(meta, json!({ "noteId": note_id, "status": status })),
        Err(failure) => err(meta, &failure),
    }
}

/// 建笔记（与 Electron `createNote` 同一步：POST 取回 id，再读一次详情）。
/// 两步之间失败按 `result_unknown` 处理——笔记可能已经建好，客户端不得自动重发。
async fn note_create(gateway: &mut Gateway, input: &Value, meta: &Value) -> Value {
    let Some(request) = input.get("request").filter(|value| value.is_object()) else {
        return err(meta, &GatewayFailure::new("validation", "user_action"));
    };
    if let Err(failure) = gateway.ensure_connected().await {
        return err(meta, &failure);
    }
    let created = gateway.request_json(reqwest::Method::POST, "/notes", Some(request.clone()), true).await;
    let note_id = match created {
        Ok((_status, body)) => body
            .get("note")
            .and_then(|note| note.get("id"))
            .and_then(Value::as_str)
            .filter(|id| is_uuid(id))
            .map(str::to_string),
        Err(failure) => return err(meta, &failure),
    };
    let Some(note_id) = note_id else {
        return err(meta, &GatewayFailure::new("unsupported_contract", "user_action"));
    };
    match gateway.request_json(reqwest::Method::GET, &format!("/v2/notes/{note_id}"), None, true).await {
        Ok((_status, body)) => ok(meta, body),
        Err(_) => err(meta, &GatewayFailure::new("result_unknown", "resync_first")),
    }
}

/// AI 同意：写同意版本后重读整份 AI 设置（界面显示服务端当前状态，不在客户端拼）。
async fn ai_consent(gateway: &mut Gateway, input: &Value, meta: &Value) -> Value {
    let body = match input.get("request").filter(|value| value.is_object()) {
        Some(body) => body.clone(),
        None => match input.get("consentVersion").and_then(Value::as_str) {
            Some(version) => json!({ "consentVersion": version }),
            None => return err(meta, &GatewayFailure::new("validation", "user_action")),
        },
    };
    let written = api_write_body(gateway, meta, reqwest::Method::PUT, "/me/ai-consent", body).await;
    if written.get("ok").and_then(Value::as_bool) != Some(true) {
        return written;
    }
    api_get(gateway, meta, "/me/ai-settings".to_string()).await
}

async fn api_write_body(gateway: &mut Gateway, meta: &Value, method: reqwest::Method, path: &str, body: Value) -> Value {
    if let Err(failure) = gateway.ensure_connected().await {
        return err(meta, &failure);
    }
    match gateway.request_json(method, path, Some(body), true).await {
        Ok((_status, value)) => ok(meta, value),
        Err(failure) => err(meta, &failure),
    }
}

/// 写通道：请求体来自渲染层（已按共享合同构造），服务端执法；这里只做身份与错误映射。
async fn api_write(gateway: &mut Gateway, meta: &Value, method: reqwest::Method, path: &str, input: &Value) -> Value {
    let Some(body) = input.get("request").filter(|value| value.is_object()) else {
        return err(meta, &GatewayFailure::new("validation", "user_action"));
    };
    if let Err(failure) = gateway.ensure_connected().await {
        return err(meta, &failure);
    }
    match gateway.request_json(method, path, Some(body.clone()), true).await {
        Ok((_status, value)) => ok(meta, value),
        Err(failure) => err(meta, &failure),
    }
}

/// 只做「连上 → 带上会话 GET → 把服务端正文原样交回」的读通道。
/// 形状校验留在渲染层的合同 schema：这里的职责是身份与错误映射，不是重新解释数据。
async fn api_get(gateway: &mut Gateway, meta: &Value, path: String) -> Value {
    if let Err(failure) = gateway.ensure_connected().await {
        return err(meta, &failure);
    }
    match gateway.request_json(reqwest::Method::GET, &path, None, true).await {
        Ok((_status, body)) => ok(meta, body),
        Err(failure) => err(meta, &failure),
    }
}

fn is_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    for (index, byte) in bytes.iter().enumerate() {
        let ok = (matches!(index, 8 | 13 | 18 | 23) && *byte == b'-') || (*byte != b'-' && byte.is_ascii_hexdigit());
        if !ok {
            return false;
        }
    }
    true
}

fn string_param<'a>(input: &'a Value, key: &str) -> Option<&'a str> {
    input.get(key).and_then(Value::as_str).filter(|value| !value.is_empty())
}

fn search_path(input: &Value) -> String {
    let Some(query) = input.get("query").and_then(Value::as_str) else {
        return "/search?q=".to_string();
    };
    let mut url = reqwest::Url::parse("http://search.invalid/search").expect("search url");
    {
        let mut pairs = url.query_pairs_mut();
        pairs.append_pair("q", query);
        if let Some(kind) = input.get("type").and_then(Value::as_str) {
            pairs.append_pair("type", kind);
        }
        if let Some(limit) = input.get("limit").and_then(Value::as_u64) {
            pairs.append_pair("limit", &limit.to_string());
        }
        if let Some(cursor) = input.get("cursor").and_then(Value::as_str) {
            pairs.append_pair("cursor", cursor);
        }
    }
    format!("/search?{}", url.query().unwrap_or(""))
}

fn note_list_path(input: &Value) -> String {
    let mut query: Vec<String> = Vec::new();
    if let Some(cursor) = string_param(input, "cursor") {
        query.push(format!("cursor={cursor}"));
    }
    if let Some(limit) = input.get("limit").and_then(Value::as_u64) {
        query.push(format!("limit={limit}"));
    }
    if let Some(trashed) = input.get("trashed").and_then(Value::as_bool) {
        query.push(format!("trashed={trashed}"));
    }
    if query.is_empty() { "/notes".to_string() } else { format!("/notes?{}", query.join("&")) }
}

fn note_detail_path(input: &Value) -> Option<String> {
    let note_id = string_param(input, "noteId")?;
    if !is_uuid(note_id) {
        return None;
    }
    match string_param(input, "noteVersionId") {
        Some(version) if is_uuid(version) => Some(format!("/v2/notes/{note_id}?noteVersionId={version}")),
        Some(_) => None,
        None => Some(format!("/v2/notes/{note_id}")),
    }
}

fn source_list_path(input: &Value) -> String {
    let mut query: Vec<String> = Vec::new();
    if let Some(status) = string_param(input, "status") {
        query.push(format!("status={status}"));
    }
    if let Some(cursor) = string_param(input, "cursor") {
        query.push(format!("cursor={cursor}"));
    }
    if let Some(limit) = input.get("limit").and_then(Value::as_u64) {
        query.push(format!("limit={limit}"));
    }
    if query.is_empty() { "/sources".to_string() } else { format!("/sources?{}", query.join("&")) }
}

fn source_detail_path(input: &Value) -> Option<String> {
    let source_id = string_param(input, "sourceId")?;
    is_uuid(source_id).then(|| format!("/sources/{source_id}"))
}

fn note_id_of(input: &Value) -> Option<&str> {
    input.get("noteId").and_then(Value::as_str).filter(|id| is_uuid(id))
}

async fn doc_state_body(gateway: &mut Gateway, note_id: &str) -> Result<Value, GatewayFailure> {
    gateway.ensure_connected().await?;
    let (_, body) = gateway
        .request_json(reqwest::Method::GET, &format!("/v2/notes/{note_id}/doc-state"), None, true)
        .await?;
    Ok(body)
}

async fn note_doc_subscribe(gateway: &mut Gateway, input: &Value, meta: &Value) -> Value {
    let topic = input.get("topic").cloned().unwrap_or(Value::Null);
    if topic.get("kind").and_then(Value::as_str) == Some("companionChat") {
        let Some(conversation_id) = topic.get("conversationId").and_then(Value::as_str).filter(|value| is_uuid(value)) else {
            return err(meta, &GatewayFailure::new("validation", "user_action"));
        };
        let Some(token) = gateway.token() else {
            return err(meta, &GatewayFailure::new("auth_required", "user_action"));
        };
        let after = topic.get("eventCursor").and_then(Value::as_u64).unwrap_or(0);
        let voice_output = topic.get("voiceOutput").and_then(Value::as_bool).unwrap_or(false);
        return match crate::chat_stream::open(&gateway.api_origin(), token, conversation_id, after, voice_output) {
            Ok(subscription_id) => ok(meta, json!({ "subscriptionId": subscription_id })),
            Err(_) => err(meta, &GatewayFailure::new("connection_lost", "safe_retry")),
        };
    }
    if topic.get("kind").and_then(Value::as_str) != Some("noteDoc") {
        // runtime 等其它主题沿用占位回执（事件下行走各自的轮询/推送）。
        return ok(meta, json!({ "subscriptionId": "tauri-runtime" }));
    }
    let Some(note_id) = topic.get("noteId").and_then(Value::as_str).filter(|id| is_uuid(id)) else {
        return err(meta, &GatewayFailure::new("validation", "user_action"));
    };
    if let Err(failure) = gateway.ensure_connected().await {
        return err(meta, &failure);
    }
    let origin = gateway.api_origin();
    let Some(token) = gateway.token() else {
        return err(meta, &GatewayFailure::new("auth_required", "user_action"));
    };
    match crate::collab_client::ensure_live_session(&origin, note_id, token).await {
        Ok(session) => ok(meta, json!({
            "subscriptionId": format!("note-doc:{note_id}"),
            "authorizedScope": if session.is_read_only() { "readonly" } else { "read-write" },
        })),
        Err(reason) => {
            let code = match reason.as_str() {
                "permission_denied" => "forbidden",
                "note_doc_sync_timeout" => "api_unavailable",
                _ => "connection_lost",
            };
            err(meta, &GatewayFailure::new(code, "safe_retry"))
        }
    }
}

/* ── 投递租约：present = 先租后 ack(displayed)；冲突时换租重试一次（Electron 同形）。 ── */

static DELIVERY_LEASES: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, (u64, String)>>> =
    std::sync::OnceLock::new();

fn delivery_leases() -> &'static std::sync::Mutex<std::collections::HashMap<String, (u64, String)>> {
    DELIVERY_LEASES.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

async fn claim_delivery_lease(
    gateway: &mut Gateway,
    delivery_id: &str,
    inbox_sequence: u64,
) -> Result<(), GatewayFailure> {
    let lease_token = crate::opened_files::uuid_v4();
    gateway
        .request_json(
            reqwest::Method::POST,
            &format!("/companion/deliveries/{delivery_id}/lease"),
            Some(json!({
                "version": 2,
                "deviceSessionId": crate::bridge_context::device_session_id(),
                "leaseToken": lease_token,
                "idempotencyKey": crate::opened_files::uuid_v4(),
            })),
            true,
        )
        .await?;
    if let Ok(mut leases) = delivery_leases().lock() {
        leases.insert(delivery_id.to_string(), (inbox_sequence, lease_token));
    }
    Ok(())
}

async fn send_delivery_ack(
    gateway: &mut Gateway,
    delivery_id: &str,
    inbox_sequence: u64,
    transition: &str,
    lease_token: &str,
) -> Result<Value, GatewayFailure> {
    let (_status, body) = gateway
        .request_json(
            reqwest::Method::POST,
            &format!("/companion/deliveries/{delivery_id}/ack"),
            Some(json!({
                "version": 2,
                "deliveryId": delivery_id,
                "inboxSequence": inbox_sequence,
                "deviceSessionId": crate::bridge_context::device_session_id(),
                "leaseToken": lease_token,
                "transition": transition,
                "idempotencyKey": crate::opened_files::uuid_v4(),
            })),
            true,
        )
        .await?;
    Ok(body)
}

async fn ack_with_lease(
    gateway: &mut Gateway,
    delivery_id: &str,
    inbox_sequence: u64,
    transition: &str,
    allow_claim: bool,
) -> Result<Value, GatewayFailure> {
    let lease = delivery_leases().lock().ok().and_then(|leases| leases.get(delivery_id).cloned());
    let body = match lease {
        Some((sequence, token)) if sequence == inbox_sequence => {
            match send_delivery_ack(gateway, delivery_id, inbox_sequence, transition, &token).await {
                Ok(body) => body,
                Err(failure) if failure.code == "conflict" => {
                    if let Ok(mut leases) = delivery_leases().lock() {
                        leases.remove(delivery_id);
                    }
                    claim_delivery_lease(gateway, delivery_id, inbox_sequence).await?;
                    let renewed = delivery_leases()
                        .lock()
                        .ok()
                        .and_then(|leases| leases.get(delivery_id).map(|(_, token)| token.clone()))
                        .ok_or_else(|| GatewayFailure::new("conflict", "resync_first"))?;
                    send_delivery_ack(gateway, delivery_id, inbox_sequence, transition, &renewed).await?
                }
                Err(failure) => return Err(failure),
            }
        }
        _ if allow_claim => {
            claim_delivery_lease(gateway, delivery_id, inbox_sequence).await?;
            let token = delivery_leases()
                .lock()
                .ok()
                .and_then(|leases| leases.get(delivery_id).map(|(_, token)| token.clone()))
                .ok_or_else(|| GatewayFailure::new("safe_internal_error", "never"))?;
            send_delivery_ack(gateway, delivery_id, inbox_sequence, transition, &token).await?
        }
        _ => return Err(GatewayFailure::new("conflict", "resync_first")),
    };
    if matches!(transition, "acted" | "dismissed") {
        if let Ok(mut leases) = delivery_leases().lock() {
            leases.remove(delivery_id);
        }
    }
    Ok(body)
}

async fn activity_present(gateway: &mut Gateway, input: &Value, meta: &Value) -> Value {
    let (Some(delivery_id), Some(inbox_sequence)) = (
        uuid_field(input, "deliveryId"),
        input.get("inboxSequence").and_then(Value::as_u64),
    ) else {
        return err(meta, &GatewayFailure::new("validation", "user_action"));
    };
    if let Err(failure) = gateway.ensure_connected().await {
        return err(meta, &failure);
    }
    match ack_with_lease(gateway, &delivery_id, inbox_sequence, "displayed", true).await {
        Ok(delivery) => ok(meta, project_delivery(&delivery)),
        Err(failure) => err(meta, &failure),
    }
}

async fn activity_ack(gateway: &mut Gateway, input: &Value, meta: &Value) -> Value {
    let request = input.get("request").filter(|value| value.is_object());
    let (Some(delivery_id), Some(inbox_sequence), Some(transition)) = (
        request.and_then(|request| uuid_field(request, "deliveryId")),
        request.and_then(|request| request.get("inboxSequence")).and_then(Value::as_u64),
        request.and_then(|request| request.get("transition")).and_then(Value::as_str),
    ) else {
        return err(meta, &GatewayFailure::new("validation", "user_action"));
    };
    if !matches!(transition, "displayed" | "acted" | "dismissed") {
        return err(meta, &GatewayFailure::new("validation", "user_action"));
    }
    if let Err(failure) = gateway.ensure_connected().await {
        return err(meta, &failure);
    }
    match ack_with_lease(gateway, &delivery_id, inbox_sequence, transition, false).await {
        Ok(delivery) => ok(meta, project_delivery(&delivery)),
        Err(failure) => err(meta, &failure),
    }
}

fn subscription_unsubscribe(input: &Value, meta: &Value) -> Value {
    if let Some(subscription_id) = input.get("subscriptionId").and_then(Value::as_str) {
        if subscription_id.starts_with("companion-chat:") {
            crate::chat_stream::close(subscription_id);
        }
    }
    ok(meta, json!({}))
}

fn note_doc_poll(input: &Value, meta: &Value) -> Value {
    let Some(note_id) = note_id_of(input) else {
        return err(meta, &GatewayFailure::new("validation", "user_action"));
    };
    match crate::collab_client::live_session_snapshot(note_id) {
        Some(session) if session.is_alive() => ok(meta, json!({
            "updates": session.drain_remote(),
            "presence": session.drain_presence(),
        })),
        _ => ok(meta, json!({ "updates": [], "presence": [] })),
    }
}

async fn note_doc_state(gateway: &mut Gateway, input: &Value, meta: &Value) -> Value {
    let Some(note_id) = note_id_of(input) else {
        return err(meta, &GatewayFailure::new("validation", "user_action"));
    };
    match doc_state_body(gateway, note_id).await {
        Ok(body) => ok(meta, json!({
            "update": body.get("update").cloned().unwrap_or(Value::Null),
            "revision": body.get("revision").cloned().unwrap_or(Value::Null),
            "backfilled": body.get("backfilled").cloned().unwrap_or(json!(false)),
            "shareScope": body.get("shareScope").cloned().unwrap_or(json!("private")),
        })),
        Err(failure) => err(meta, &failure),
    }
}

async fn note_doc_sync_update(gateway: &mut Gateway, input: &Value, meta: &Value) -> Value {
    let Some(note_id) = note_id_of(input) else {
        return err(meta, &GatewayFailure::new("validation", "user_action"));
    };
    let update = input.get("update").and_then(Value::as_str).unwrap_or("");
    if update.is_empty() {
        return ok(meta, json!({ "via": "unchanged", "revision": Value::Null, "savedAt": crate::collab_client::iso_now() }));
    }
    let state = match doc_state_body(gateway, note_id).await {
        Ok(state) => state,
        Err(failure) => return err(meta, &failure),
    };
    let shared = state.get("shareScope").and_then(Value::as_str) == Some("shared");
    if shared {
        let origin = gateway.api_origin();
        let Some(token) = gateway.token() else {
            return err(meta, &GatewayFailure::new("auth_required", "user_action"));
        };
        match crate::collab_client::ensure_live_session(&origin, note_id, token).await {
            Ok(session) if session.is_read_only() => {
                err(meta, &GatewayFailure::new("forbidden", "user_action"))
            }
            Ok(session) => match session.apply_and_forward(update) {
                Ok(()) => ok(meta, json!({ "via": "stream", "revision": Value::Null, "savedAt": crate::collab_client::iso_now() })),
                Err(reason) if reason == "forbidden" => err(meta, &GatewayFailure::new("forbidden", "user_action")),
                Err(_) => err(meta, &GatewayFailure::new("connection_lost", "safe_retry")),
            },
            Err(reason) => err(meta, &GatewayFailure::new(if reason == "permission_denied" { "forbidden" } else { "api_unavailable" }, "safe_retry")),
        }
    } else {
        match gateway.request_json(
            reqwest::Method::POST,
            &format!("/v2/notes/{note_id}/doc-update"),
            Some(json!({ "update": update })),
            true,
        ).await {
            Ok((_status, body)) => ok(meta, json!({
                "via": "uploaded",
                "revision": body.get("revision").cloned().unwrap_or(Value::Null),
                "savedAt": body.get("savedAt").cloned().unwrap_or(json!(crate::collab_client::iso_now())),
            })),
            Err(failure) => err(meta, &failure),
        }
    }
}

async fn note_doc_sync_title(gateway: &mut Gateway, input: &Value, meta: &Value) -> Value {
    let Some(note_id) = note_id_of(input) else {
        return err(meta, &GatewayFailure::new("validation", "user_action"));
    };
    let Some(title) = input.get("title").and_then(Value::as_str).filter(|value| !value.is_empty()) else {
        return err(meta, &GatewayFailure::new("validation", "user_action"));
    };
    let title_source = input.get("titleSource").and_then(Value::as_str).unwrap_or("manual");
    let state = match doc_state_body(gateway, note_id).await {
        Ok(state) => state,
        Err(failure) => return err(meta, &failure),
    };
    if state.get("shareScope").and_then(Value::as_str) == Some("shared") {
        let origin = gateway.api_origin();
        let Some(token) = gateway.token() else {
            return err(meta, &GatewayFailure::new("auth_required", "user_action"));
        };
        return match crate::collab_client::ensure_live_session(&origin, note_id, token).await {
            Ok(session) if session.is_read_only() => err(meta, &GatewayFailure::new("forbidden", "user_action")),
            Ok(session) => match session.set_title(title, title_source) {
                Ok(()) => ok(meta, json!({ "via": "stream", "revision": Value::Null, "savedAt": crate::collab_client::iso_now() })),
                Err(reason) if reason == "forbidden" => err(meta, &GatewayFailure::new("forbidden", "user_action")),
                Err(_) => err(meta, &GatewayFailure::new("connection_lost", "safe_retry")),
            },
            Err(_) => err(meta, &GatewayFailure::new("api_unavailable", "safe_retry")),
        };
    }
    // private：在本机临时文档上改 meta，再走 HTTP 增量上送。
    use base64::Engine;
    let Some(encoded) = state.get("update").and_then(Value::as_str) else {
        return err(meta, &GatewayFailure::new("unsupported_contract", "user_action"));
    };
    let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(encoded) else {
        return err(meta, &GatewayFailure::new("unsupported_contract", "user_action"));
    };
    let mut doc = crate::collab::new_doc();
    if crate::collab::apply_update(&mut doc, &bytes).is_err() {
        return err(meta, &GatewayFailure::new("unsupported_contract", "user_action"));
    }
    use yrs::Transact;
    let before = crate::collab::state_vector(&doc);
    {
        let map = doc.get_or_insert_map(crate::collab::META_ROOT);
        let mut txn = doc.transact_mut();
        map.insert(&mut txn, "title", title.to_string());
        map.insert(&mut txn, "titleSource", title_source.to_string());
    }
    let Ok(diff) = crate::collab::diff_update(&doc, &before) else {
        return err(meta, &GatewayFailure::new("safe_internal_error", "safe_retry"));
    };
    let update = base64::engine::general_purpose::STANDARD.encode(diff);
    match gateway.request_json(
        reqwest::Method::POST,
        &format!("/v2/notes/{note_id}/doc-update"),
        Some(json!({ "update": update })),
        true,
    ).await {
        Ok((_status, body)) => ok(meta, json!({
            "via": "uploaded",
            "revision": body.get("revision").cloned().unwrap_or(Value::Null),
            "savedAt": body.get("savedAt").cloned().unwrap_or(json!(crate::collab_client::iso_now())),
        })),
        Err(failure) => err(meta, &failure),
    }
}

async fn note_doc_presence(gateway: &mut Gateway, input: &Value, meta: &Value) -> Value {
    let Some(note_id) = note_id_of(input) else {
        return err(meta, &GatewayFailure::new("validation", "user_action"));
    };
    if let Some(state) = input.get("state").and_then(Value::as_str) {
        // 有活会话就走 awareness 上行；断了就在同一份本机文档上重连接着报。
        if crate::collab_client::live_session_snapshot(note_id).is_some() {
            let origin = gateway.api_origin();
            let Some(token) = gateway.token() else {
                return err(meta, &GatewayFailure::new("auth_required", "user_action"));
            };
            return match crate::collab_client::ensure_live_session(&origin, note_id, token).await {
                Ok(session) => match session.report_presence(state) {
                    Ok(()) => ok(meta, json!({ "shared": true })),
                    Err(_) => err(meta, &GatewayFailure::new("connection_lost", "safe_retry")),
                },
                Err(_) => ok(meta, json!({ "shared": false })),
            };
        }
        return ok(meta, json!({ "shared": false }));
    }
    match doc_state_body(gateway, note_id).await {
        Ok(state) => ok(meta, json!({ "shared": state.get("shareScope").and_then(Value::as_str) == Some("shared") })),
        Err(failure) => err(meta, &failure),
    }
}

fn draft_path(gateway: &Gateway, app: Option<&tauri::AppHandle>, note_id: &str) -> Option<std::path::PathBuf> {
    use tauri::Manager;
    let (subject, workspace) = gateway.identity()?;
    // 身份指纹进目录名：换账号/换空间读不到别人的草稿（Electron 同一条边界）。
    let scope = {
        use sha2::{Digest, Sha256};
        let mut hash = Sha256::new();
        hash.update(subject.as_bytes());
        hash.update(b":");
        hash.update(workspace.as_bytes());
        hex::encode(hash.finalize())[..16].to_string()
    };
    let app = app?;
    let dir = app.path().app_data_dir().ok()?.join("note-drafts").join(scope);
    Some(dir.join(format!("{note_id}.json")))
}

fn note_draft(gateway: &Gateway, app: Option<&tauri::AppHandle>, input: &Value, meta: &Value, action: &str) -> Value {
    let Some(note_id) = note_id_of(input) else {
        return err(meta, &GatewayFailure::new("validation", "user_action"));
    };
    if gateway.identity().is_none() {
        // 没有身份就没有草稿格：不把这一篇写进"下一个人也看得到"的位置。
        return err(meta, &GatewayFailure::new("auth_required", "user_action"));
    }
    let Some(path) = draft_path(gateway, app, note_id) else {
        return err(meta, &GatewayFailure::new("local_storage_unavailable", "user_action"));
    };
    match action {
        "save" => {
            let update = input.get("update").and_then(Value::as_str).unwrap_or("");
            if update.is_empty() {
                return ok(meta, json!({ "saved": false }));
            }
            if let Some(parent) = path.parent() {
                if std::fs::create_dir_all(parent).is_err() {
                    return err(meta, &GatewayFailure::new("local_storage_unavailable", "user_action"));
                }
            }
            let body = json!({ "update": update, "savedAt": crate::collab_client::iso_now() });
            match std::fs::write(&path, body.to_string()) {
                Ok(()) => ok(meta, json!({ "saved": true })),
                Err(_) => err(meta, &GatewayFailure::new("local_storage_unavailable", "user_action")),
            }
        }
        "get" => {
            let draft = std::fs::read_to_string(&path).ok()
                .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
                .filter(|value| value.get("update").and_then(Value::as_str).is_some_and(|update| !update.is_empty()));
            ok(meta, json!({ "draft": draft.unwrap_or(Value::Null) }))
        }
        _ => match std::fs::remove_file(&path) {
            Ok(()) => ok(meta, json!({ "cleared": true })),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => ok(meta, json!({ "cleared": true })),
            Err(_) => err(meta, &GatewayFailure::new("local_storage_unavailable", "user_action")),
        },
    }
}

async fn note_image_upload(gateway: &mut Gateway, input: &Value, meta: &Value) -> Value {
    let Some(note_id) = string_param(input, "noteId") else {
        return err(meta, &GatewayFailure::new("validation", "user_action"));
    };
    if !is_uuid(note_id) {
        return err(meta, &GatewayFailure::new("validation", "user_action"));
    }
    let Some(request) = input.get("request") else {
        return err(meta, &GatewayFailure::new("validation", "user_action"));
    };
    let file_name = request.get("fileName").and_then(Value::as_str).unwrap_or("");
    let mime_type = request.get("mimeType").and_then(Value::as_str).unwrap_or("");
    let encoded = request.get("bytesBase64").and_then(Value::as_str).unwrap_or("");
    if file_name.is_empty() || file_name.chars().count() > 255 {
        return err(meta, &GatewayFailure::new("validation", "user_action"));
    }
    if !matches!(mime_type, "image/png" | "image/jpeg" | "image/gif" | "image/webp") {
        return err(meta, &GatewayFailure::new("validation", "user_action"));
    }
    use base64::Engine;
    let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(encoded) else {
        return err(meta, &GatewayFailure::new("validation", "user_action"));
    };
    if bytes.is_empty() || bytes.len() > 100 * 1024 * 1024 {
        return err(meta, &GatewayFailure::new("validation", "user_action"));
    }
    if let Err(failure) = gateway.ensure_connected().await {
        return err(meta, &failure);
    }
    match gateway.post_note_image(note_id, file_name, mime_type, bytes).await {
        Ok(payload) => ok(meta, json!({
            "version": 1,
            "url": payload.get("url").cloned().unwrap_or(Value::Null),
            "byteLength": payload.get("size").cloned().unwrap_or(Value::Null),
            "mimeType": payload.get("mimeType").cloned().unwrap_or(Value::Null),
            "width": payload.get("width").cloned().unwrap_or(Value::Null),
            "height": payload.get("height").cloned().unwrap_or(Value::Null),
        })),
        Err(failure) => err(meta, &failure),
    }
}

async fn voice_transcribe(input: &Value, meta: &Value) -> Value {
    let request = input.get("request").cloned().unwrap_or(Value::Null);
    let sample_rate = request.get("sampleRate").and_then(Value::as_u64).unwrap_or(0) as u32;
    let encoded = request.get("pcmBase64").and_then(Value::as_str).unwrap_or("");
    use base64::Engine;
    let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(encoded) else {
        return err(meta, &GatewayFailure::new("validation", "user_action"));
    };
    if bytes.len() < 2 || bytes.len() % 2 != 0 {
        return err(meta, &GatewayFailure::new("validation", "user_action"));
    }
    let pcm: Vec<i16> = bytes
        .chunks_exact(2)
        .map(|chunk| i16::from_le_bytes([chunk[0], chunk[1]]))
        .collect();
    let joined = tauri::async_runtime::spawn_blocking(move || crate::voice_engine::transcribe(&pcm, sample_rate))
        .await
        .unwrap_or(Err("voice_engine_unavailable"));
    match joined {
        Ok(text) => ok(meta, json!({ "text": text })),
        Err("validation") => err(meta, &GatewayFailure::new("validation", "user_action")),
        Err(_) => err(meta, &GatewayFailure::new("voice_engine_unavailable", "user_action")),
    }
}

fn asr_model(meta: &Value, action: Option<&str>) -> Value {
    let Some(store) = crate::voice_model::store() else {
        return err(meta, &GatewayFailure::new("feature_disabled", "never"));
    };
    match action {
        Some("download") => store.start(),
        Some("cancel") => store.cancel(),
        Some("remove") => store.remove(),
        _ => {}
    }
    ok(meta, store.snapshot())
}

fn clipboard_read_links(app: Option<&tauri::AppHandle>, meta: &Value) -> Value {
    let Some(app) = app else { return err(meta, &GatewayFailure::new("feature_disabled", "never")) };
    let Some(text) = crate::devices::read_clipboard_text(app) else { return ok(meta, json!({ "urls": [] })) };
    let urls = crate::devices::extract_candidate_links(&text.chars().take(4000).collect::<String>());
    ok(meta, json!({ "urls": urls }))
}

fn clipboard_write_text(app: Option<&tauri::AppHandle>, input: &Value, meta: &Value) -> Value {
    let Some(app) = app else { return err(meta, &GatewayFailure::new("feature_disabled", "never")) };
    let Some(text) = input.get("request").and_then(|request| request.get("text")).and_then(Value::as_str) else {
        return err(meta, &GatewayFailure::new("validation", "user_action"));
    };
    if text.is_empty() || text.len() > 1_000_000 {
        return err(meta, &GatewayFailure::new("validation", "user_action"));
    }
    if crate::devices::write_clipboard_text(app, text.to_string()) {
        ok(meta, json!({ "written": true }))
    } else {
        err(meta, &GatewayFailure::new("local_storage_unavailable", "user_action"))
    }
}

fn shell_open_external(input: &Value, meta: &Value) -> Value {
    let Some(url) = input.get("request").and_then(|request| request.get("url")).and_then(Value::as_str) else {
        return err(meta, &GatewayFailure::new("validation", "user_action"));
    };
    if !crate::devices::is_web_link(url) {
        return err(meta, &GatewayFailure::new("validation", "user_action"));
    }
    if crate::devices::open_external(url) {
        ok(meta, json!({ "opened": true }))
    } else {
        err(meta, &GatewayFailure::new("safe_internal_error", "safe_retry"))
    }
}

fn requested_model_id(input: &Value) -> Option<&str> {
    let model_id = input.get("modelId")?.as_str()?;
    MODEL_IDS.contains(&model_id).then_some(model_id)
}

fn model_snapshot_json(model_id: &str, progress: &Progress) -> Value {
    json!({
        "version": 1,
        "modelId": model_id,
        "mountUrl": format!("astella-app://bundle/device/models/{model_id}/"),
        "status": progress.status,
        "receivedBytes": progress.received,
        "totalBytes": progress.total,
        "installedVersion": progress.installed_version,
        "failure": progress.failure,
    })
}

async fn companion_model_state(models: &Arc<ModelRegistry>, input: &Value, meta: &Value) -> Value {
    match requested_model_id(input) {
        Some(model_id) => ok(meta, model_snapshot_json(model_id, &models.snapshot(model_id).await)),
        None => err(meta, &GatewayFailure::new("validation", "user_action")),
    }
}

async fn companion_model_download(gateway: &mut Gateway, models: &Arc<ModelRegistry>, input: &Value, meta: &Value) -> Value {
    let Some(model_id) = requested_model_id(input) else {
        return err(meta, &GatewayFailure::new("validation", "user_action"));
    };
    let manifest = match gateway.fetch_companion_model_manifest(model_id).await {
        Ok(manifest) => manifest,
        Err(failure) => return err(meta, &failure),
    };
    let origin = gateway.api_origin();
    let token = gateway.token().map(str::to_string);
    let progress = models.start(model_id, &manifest, &origin, token).await;
    ok(meta, model_snapshot_json(model_id, &progress))
}

async fn companion_model_cancel(models: &Arc<ModelRegistry>, input: &Value, meta: &Value) -> Value {
    match requested_model_id(input) {
        Some(model_id) => ok(meta, model_snapshot_json(model_id, &models.cancel(model_id).await)),
        None => err(meta, &GatewayFailure::new("validation", "user_action")),
    }
}

async fn companion_model_remove(models: &Arc<ModelRegistry>, input: &Value, meta: &Value) -> Value {
    match requested_model_id(input) {
        Some(model_id) => ok(meta, model_snapshot_json(model_id, &models.remove(model_id).await)),
        None => err(meta, &GatewayFailure::new("validation", "user_action")),
    }
}

#[cfg(test)]
fn test_temp_dir(prefix: &str) -> std::path::PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let dir = std::env::temp_dir().join(format!(
        "{prefix}-{}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn ok(meta: &Value, data: Value) -> Value {
    envelope(meta, true, Some(data), None)
}

fn err(meta: &Value, failure: &GatewayFailure) -> Value {
    envelope(meta, false, None, Some(failure))
}

fn envelope(meta: &Value, success: bool, data: Option<Value>, failure: Option<&GatewayFailure>) -> Value {
    let request_id = meta.get("requestId").cloned().unwrap_or_else(|| json!("tauri-bridge"));
    let correlation_id = meta.get("correlationId").cloned().unwrap_or_else(|| json!("tauri-bridge"));
    if success {
        json!({
            "version": 1,
            "ok": true,
            "data": data.unwrap_or(Value::Null),
            "requestId": request_id,
            "correlationId": correlation_id,
            "schemaRevision": CONTRACT_VERSION,
        })
    } else {
        let failure = failure.expect("error envelope needs a failure");
        json!({
            "version": 1,
            "ok": false,
            "error": {
                "code": failure.code,
                "safeMessageKey": format!("error.{}", failure.code),
                "retry": failure.retry,
            },
            "requestId": request_id,
            "correlationId": correlation_id,
            "schemaRevision": CONTRACT_VERSION,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn envelopes_echo_the_request_identity() {
        let meta = json!({ "requestId": "r-1", "correlationId": "c-1" });
        let success = ok(&meta, json!({ "hello": 1 }));
        assert_eq!(success["ok"], true);
        assert_eq!(success["requestId"], "r-1");
        assert_eq!(success["schemaRevision"], CONTRACT_VERSION);

        let failure = err(&meta, &GatewayFailure::new("feature_disabled", "never"));
        assert_eq!(failure["ok"], false);
        assert_eq!(failure["error"]["code"], "feature_disabled");
        assert_eq!(failure["error"]["retry"], "never");
        assert_eq!(failure["error"]["safeMessageKey"], "error.feature_disabled");
    }

    #[test]
    fn runtime_snapshot_matches_the_contract_shape() {
        let gateway = Gateway::new(Err(crate::gateway::ConfigurationError::Missing), None);
        let snapshot = runtime_snapshot(&gateway);
        assert_eq!(snapshot["contractVersion"], CONTRACT_VERSION);
        assert_eq!(snapshot["platform"], "darwin");
        assert_eq!(snapshot["apiConnection"]["kind"], "configuration_error");
        assert_eq!(snapshot["sessionCredential"]["stored"], false);
    }
}

/// 端到端（本地 mock API）：信任握手、登录、凭据落盘、重启恢复。
/// 直接对 `Gateway` 跑真实 HTTP——不依赖 Docker，可进 CI；真实服务栈的联调见任务 #11。
#[cfg(test)]
mod e2e_tests {
    use std::collections::HashMap;
    use std::path::PathBuf;

    use hmac::{Hmac, Mac};
    use serde_json::{json, Value};
    use sha2::Sha256;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};

    use crate::gateway::{FileSessionCredentialStore, Gateway, GatewayConfig, OriginKind};

    const SECRET: [u8; 32] = [9u8; 32];

    fn test_models() -> std::sync::Arc<crate::companion_model::ModelRegistry> {
        std::sync::Arc::new(crate::companion_model::ModelRegistry::new(scratch()))
    }

    fn scratch() -> PathBuf {
        super::test_temp_dir("astella-tauri-e2e")
    }

    async fn read_request(socket: &mut TcpStream) -> Option<(String, String, HashMap<String, String>, Vec<u8>)> {
        let mut buffer = Vec::new();
        let mut chunk = [0u8; 4096];
        let header_end = loop {
            let read = socket.read(&mut chunk).await.ok()?;
            if read == 0 {
                return None;
            }
            buffer.extend_from_slice(&chunk[..read]);
            if let Some(position) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
                break position + 4;
            }
        };
        let head = String::from_utf8_lossy(&buffer[..header_end]).to_string();
        let mut lines = head.split("\r\n");
        let request_line = lines.next()?.to_string();
        let mut headers = HashMap::new();
        for line in lines {
            if let Some((name, value)) = line.split_once(':') {
                headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
            }
        }
        let length: usize = headers.get("content-length").and_then(|value| value.parse().ok()).unwrap_or(0);
        let mut body = buffer[header_end..].to_vec();
        while body.len() < length {
            let read = socket.read(&mut chunk).await.ok()?;
            if read == 0 {
                break;
            }
            body.extend_from_slice(&chunk[..read]);
        }
        Some((request_line, head, headers, body))
    }

    async fn respond(socket: &mut TcpStream, status: u16, body: &Value) {
        let body = body.to_string();
        let head = format!(
            "HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        let _ = socket.write_all(head.as_bytes()).await;
        let _ = socket.write_all(body.as_bytes()).await;
        let _ = socket.flush().await;
    }

    fn sign(nonce: &str, revision: &str, key_id: &str) -> String {
        let message = crate::gateway::config::trust_signature_message(nonce, crate::gateway::API_SERVICE_ID, revision, key_id, "instance-1");
        let mut mac = Hmac::<Sha256>::new_from_slice(&SECRET).unwrap();
        mac.update(message.as_bytes());
        hex::encode(mac.finalize().into_bytes())
    }

    async fn serve_api(listener: TcpListener) {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else { return };
            let Some((request_line, _head, headers, body)) = read_request(&mut socket).await else { continue };
            let path = request_line.split_whitespace().nth(1).unwrap_or("").to_string();
            let parsed: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
            let response = match path.as_str() {
                "/_astella/desktop/trust/v1/challenge" => {
                    let nonce = parsed["nonce"].as_str().unwrap_or("").to_string();
                    json!({
                        "version": 1,
                        "nonce": nonce,
                        "serviceId": crate::gateway::API_SERVICE_ID,
                        "ipcContractVersion": crate::gateway::CONTRACT_VERSION,
                        "domainSchemaRevision": "domain-r1",
                        "pairingKeyId": parsed["pairingKeyId"],
                        "instanceId": "instance-1",
                        "signature": sign(&nonce, "domain-r1", parsed["pairingKeyId"].as_str().unwrap_or("")),
                    })
                }
                "/health" => json!({ "status": "ok", "service": "api", "timestamp": "2026-11-18T00:00:00Z" }),
                "/auth/login" => {
                    assert_eq!(headers.get("authorization"), None, "login must be unauthenticated");
                    assert_eq!(parsed["email"], "learner@example.com");
                    assert_eq!(parsed["password"], "correct-horse");
                    json!({
                        "token": "tok-1",
                        "ctx": {
                            "userId": "11111111-2222-4333-8444-555555555555",
                            "workspaceId": "11111111-2222-4333-8444-666666666666",
                        },
                    })
                }
                "/auth/me" => {
                    assert_eq!(headers.get("authorization").map(String::as_str), Some("Bearer tok-1"));
                    json!({
                        "userId": "11111111-2222-4333-8444-555555555555",
                        "workspaceId": "11111111-2222-4333-8444-666666666666",
                        "email": "learner@example.com",
                        "role": "owner",
                        "displayName": "拾星",
                        "avatarUrl": null,
                        "workspaceName": "我的书房",
                        "workspaceType": "personal",
                        "isPersonal": true,
                        "personalWorkspaceId": null,
                        "workspaceEpoch": 7,
                    })
                }
                _ => json!({ "error": "not_found" }),
            };
            respond(&mut socket, 200, &response).await;
        }
    }

    fn config(origin: String) -> GatewayConfig {
        GatewayConfig {
            api_origin: origin,
            origin_kind: OriginKind::LocalLoopback,
            expected_domain_schema_revision: "domain-r1".into(),
            config_revision: "desktop-dev-config-v1".into(),
            pairing_key_id: Some("probe-key".into()),
            pairing_secret: Some(SECRET.to_vec()),
        }
    }

    #[tokio::test]
    async fn trust_login_persist_and_restore_round_trip() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(serve_api(listener));

        let dir = scratch();
        let mut gateway = Gateway::new(Ok(config(origin.clone())), Some(FileSessionCredentialStore::new(&dir)));
        gateway.ensure_connected().await.expect("trust handshake + health");
        assert!(matches!(gateway.connection(), crate::gateway::ConnectionState::Ready { .. }));

        let meta = json!({ "requestId": "e2e-1", "correlationId": "e2e-1" });
        let login = super::invoke(&mut gateway, &test_models(), None, "astella.v1.auth.login", &json!({
            "meta": meta,
            "email": "learner@example.com",
            "password": "correct-horse",
            "remember": true,
        })).await;
        assert_eq!(login["ok"], true, "{login}");
        assert_eq!(login["data"]["status"], "authenticated");
        assert_eq!(login["data"]["user"]["email"], "learner@example.com");
        assert_eq!(login["data"]["workspaceEpoch"], 7);
        assert!(dir.join("session-credential-tauri-v1.txt").exists(), "remember=true must persist");

        // 重启：新实例、同一目录——令牌恢复后直接 /auth/me。
        let mut restarted = Gateway::new(Ok(config(origin)), Some(FileSessionCredentialStore::new(&dir)));
        let state = super::invoke(&mut restarted, &test_models(), None, "astella.v1.auth.getState", &json!({ "meta": meta })).await;
        assert_eq!(state["ok"], true, "{state}");
        assert_eq!(state["data"]["status"], "authenticated");
        assert_eq!(state["data"]["credentialPersistence"], "local_file");

        server.abort();
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn rejected_login_maps_to_invalid_credentials() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else { return };
                let Some((request_line, _head, _headers, body)) = read_request(&mut socket).await else { continue };
                let path = request_line.split_whitespace().nth(1).unwrap_or("").to_string();
                let parsed: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
                match path.as_str() {
                    "/_astella/desktop/trust/v1/challenge" => {
                        let nonce = parsed["nonce"].as_str().unwrap_or("").to_string();
                        respond(&mut socket, 200, &json!({
                            "version": 1,
                            "nonce": nonce,
                            "serviceId": crate::gateway::API_SERVICE_ID,
                            "ipcContractVersion": crate::gateway::CONTRACT_VERSION,
                            "domainSchemaRevision": "domain-r1",
                            "pairingKeyId": parsed["pairingKeyId"],
                            "instanceId": "instance-1",
                            "signature": sign(&nonce, "domain-r1", parsed["pairingKeyId"].as_str().unwrap_or("")),
                        })).await;
                    }
                    "/health" => respond(&mut socket, 200, &json!({ "status": "ok", "service": "api" })).await,
                    _ => respond(&mut socket, 401, &json!({ "error": "invalid_credentials" })).await,
                }
            }
        });

        let dir = scratch();
        let mut gateway = Gateway::new(Ok(config(origin)), Some(FileSessionCredentialStore::new(&dir)));
        let result = super::invoke(&mut gateway, &test_models(), None, "astella.v1.auth.login", &json!({
            "meta": json!({ "requestId": "e2e-2" }),
            "email": "learner@example.com",
            "password": "wrong",
            "remember": true,
        })).await;
        assert_eq!(result["ok"], false);
        assert_eq!(result["error"]["code"], "invalid_credentials");
        assert!(!dir.join("session-credential-tauri-v1.txt").exists(), "failed login must not persist");

        server.abort();
        std::fs::remove_dir_all(&dir).ok();
    }
}

/// 真实服务栈联调（默认忽略）：需要本地 API 与 .env 里的配对配置。
/// 运行：ASTELLA_LIVE_EMAIL=… ASTELLA_LIVE_PASSWORD=… cargo test live_trust_login -- --ignored
#[cfg(test)]
mod live_tests {
    use std::collections::HashMap;

    use serde_json::json;

    use crate::gateway::{FileSessionCredentialStore, Gateway};

    fn test_models() -> std::sync::Arc<crate::companion_model::ModelRegistry> {
        std::sync::Arc::new(crate::companion_model::ModelRegistry::new(scratch()))
    }

    fn scratch() -> std::path::PathBuf {
        super::test_temp_dir("astella-tauri-live")
    }

    #[tokio::test]
    #[ignore = "needs the local API stack and pairing env"]
    async fn live_trust_login_against_local_api() {
        let email = std::env::var("ASTELLA_LIVE_EMAIL").expect("ASTELLA_LIVE_EMAIL");
        let password = std::env::var("ASTELLA_LIVE_PASSWORD").expect("ASTELLA_LIVE_PASSWORD");
        let env: HashMap<String, String> = std::env::vars().collect();
        let config = crate::gateway::config::read_configuration(&env).expect("pairing env");
        let dir = scratch();
        let mut gateway = Gateway::new(Ok(config), Some(FileSessionCredentialStore::new(&dir)));
        gateway.ensure_connected().await.expect("live trust handshake + health");

        let result = super::invoke(&mut gateway, &test_models(), None, "astella.v1.auth.login", &json!({
            "meta": json!({ "requestId": "live-1", "correlationId": "live-1" }),
            "email": email,
            "password": password,
            "remember": true,
        })).await;
        assert_eq!(result["ok"], true, "{result}");
        assert_eq!(result["data"]["status"], "authenticated", "{result}");
        assert_eq!(result["data"]["credentialPersistence"], "local_file");
        assert!(dir.join("session-credential-tauri-v1.txt").exists());

        // 重启恢复：同一目录的新实例直接读 /auth/me。
        let env2: HashMap<String, String> = std::env::vars().collect();
        let config2 = crate::gateway::config::read_configuration(&env2).expect("pairing env");
        let mut restarted = Gateway::new(Ok(config2), Some(FileSessionCredentialStore::new(&dir)));
        let state = super::invoke(&mut restarted, &test_models(), None, "astella.v1.auth.getState", &json!({
            "meta": json!({ "requestId": "live-2" }),
        })).await;
        assert_eq!(state["ok"], true, "{state}");
        assert_eq!(state["data"]["status"], "authenticated", "{state}");

        std::fs::remove_dir_all(&dir).ok();
    }
}

/// 模型分发联调（默认忽略）：需要本地 API + MinIO 且模型已入库。
#[cfg(test)]
mod model_live_tests {
    use std::collections::HashMap;
    use std::sync::Arc;

    use serde_json::json;

    use crate::companion_model::ModelRegistry;
    use crate::gateway::{FileSessionCredentialStore, Gateway};

    fn scratch() -> std::path::PathBuf {
        super::test_temp_dir("astella-tauri-model-live")
    }

    #[tokio::test]
    #[ignore = "needs the local API stack, MinIO and an ingested model"]
    async fn live_model_download_and_route() {
        let model_id = std::env::var("ASTELLA_LIVE_MODEL_ID").unwrap_or_else(|_| "companion-live2d-fatfish-v4".to_string());
        let email = std::env::var("ASTELLA_LIVE_EMAIL").expect("email");
        let password = std::env::var("ASTELLA_LIVE_PASSWORD").expect("password");
        let env: HashMap<String, String> = std::env::vars().collect();
        let config = crate::gateway::config::read_configuration(&env).expect("pairing env");

        let root = std::env::var("ASTELLA_LIVE_MODEL_ROOT").map(std::path::PathBuf::from).unwrap_or_else(|_| scratch());
        std::fs::create_dir_all(&root).ok();
        let registry = Arc::new(ModelRegistry::new(root.join("companion-models")));
        let mut gateway = Gateway::new(Ok(config), Some(FileSessionCredentialStore::new(&root)));
        let meta = json!({ "requestId": "model-live-1", "correlationId": "model-live-1" });

        let login = super::invoke(&mut gateway, &registry, None, "astella.v1.auth.login", &json!({
            "meta": meta, "email": email, "password": password, "remember": true,
        })).await;
        assert_eq!(login["ok"], true, "{login}");

        let started = super::invoke(&mut gateway, &registry, None, "astella.v1.companion.model.download", &json!({
            "meta": meta, "modelId": model_id,
        })).await;
        assert_eq!(started["ok"], true, "{started}");
        assert!(started["data"]["totalBytes"].as_u64().unwrap_or(0) > 0, "{started}");

        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(180);
        let final_state = loop {
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            let state = super::invoke(&mut gateway, &registry, None, "astella.v1.companion.model.state", &json!({
                "meta": meta, "modelId": model_id,
            })).await;
            match state["data"]["status"].as_str().unwrap_or("") {
                "ready" => break state,
                "failed" => panic!("model download failed: {state}"),
                _ if tokio::time::Instant::now() > deadline => panic!("model download timed out: {state}"),
                _ => continue,
            }
        };
        assert_eq!(final_state["data"]["installedVersion"].is_string(), true, "{final_state}");

        let marker_raw = std::fs::read_to_string(root.join("companion-models").join(&model_id).join("installed.json")).expect("marker");
        let marker: serde_json::Value = serde_json::from_str(&marker_raw).unwrap();
        let first_file = marker["files"][0]["path"].as_str().expect("file entry").to_string();
        let resolved = crate::protocol::resolve_companion_model_file(&root, &format!("{model_id}/{first_file}"));
        assert!(resolved.is_some(), "device/models route must serve an installed file");

        if std::env::var("ASTELLA_LIVE_MODEL_ROOT").is_err() {
            std::fs::remove_dir_all(&root).ok();
        }
    }
}

/// 读通道联调（默认忽略）：能力投影 / 笔记列表 / 房间投影。
#[cfg(test)]
mod read_live_tests {
    use std::collections::HashMap;
    use std::sync::Arc;

    use serde_json::json;

    use crate::companion_model::ModelRegistry;
    use crate::gateway::{FileSessionCredentialStore, Gateway};

    fn scratch() -> std::path::PathBuf {
        super::test_temp_dir("astella-tauri-read-live")
    }

    #[tokio::test]
    #[ignore = "needs the local API stack"]
    async fn live_read_channels() {
        let email = std::env::var("ASTELLA_LIVE_EMAIL").expect("email");
        let password = std::env::var("ASTELLA_LIVE_PASSWORD").expect("password");
        let env: HashMap<String, String> = std::env::vars().collect();
        let config = crate::gateway::config::read_configuration(&env).expect("pairing env");
        let root = scratch();
        let models = Arc::new(ModelRegistry::new(root.join("companion-models")));
        let mut gateway = Gateway::new(Ok(config), Some(FileSessionCredentialStore::new(&root)));
        let meta = json!({ "requestId": "read-live", "correlationId": "read-live" });

        let login = super::invoke(&mut gateway, &models, None, "astella.v1.auth.login", &json!({
            "meta": meta, "email": email, "password": password, "remember": true,
        })).await;
        assert_eq!(login["ok"], true, "{login}");

        let capabilities = super::invoke(&mut gateway, &models, None, "astella.v1.capabilities.get", &json!({ "meta": meta })).await;
        assert_eq!(capabilities["ok"], true, "{capabilities}");

        let notes = super::invoke(&mut gateway, &models, None, "astella.v1.note.list", &json!({ "meta": meta, "limit": 5 })).await;
        assert_eq!(notes["ok"], true, "{notes}");
        assert!(notes["data"]["items"].is_array(), "{notes}");

        let sources = super::invoke(&mut gateway, &models, None, "astella.v1.source.list", &json!({ "meta": meta, "limit": 1 })).await;
        assert_eq!(sources["ok"], true, "{sources}");

        let room = super::invoke(&mut gateway, &models, None, "astella.v1.room.getProjection", &json!({ "meta": meta })).await;
        assert_eq!(room["ok"], true, "{room}");
        assert!(matches!(room["data"]["mode"].as_str(), Some("notes") | Some("first_use")), "{room}");

        let answer = super::invoke(&mut gateway, &models, None, "astella.v1.companion.answerMode.get", &json!({ "meta": meta })).await;
        assert_eq!(answer["ok"], true, "{answer}");
        let preference = answer["data"]["preference"].clone();
        let patched = super::invoke(&mut gateway, &models, None, "astella.v1.companion.answerMode.patch", &json!({
            "meta": meta,
            "request": { "version": 1, "preference": preference },
        })).await;
        assert_eq!(patched["ok"], true, "{patched}");

        std::fs::remove_dir_all(&root).ok();
    }
}

/// 写入链路联调（默认忽略）：建笔记 → 列表可见 → 房间进入 notes 形态。
#[cfg(test)]
mod write_live_tests {
    use std::collections::HashMap;
    use std::sync::Arc;

    use serde_json::json;

    use crate::companion_model::ModelRegistry;
    use crate::gateway::{FileSessionCredentialStore, Gateway};

    fn scratch() -> std::path::PathBuf {
        super::test_temp_dir("astella-tauri-write-live")
    }

    #[tokio::test]
    #[ignore = "needs the local API stack; creates one note in the local dev database"]
    async fn live_create_note_updates_room_mode() {
        let email = std::env::var("ASTELLA_LIVE_EMAIL").expect("email");
        let password = std::env::var("ASTELLA_LIVE_PASSWORD").expect("password");
        let env: HashMap<String, String> = std::env::vars().collect();
        let config = crate::gateway::config::read_configuration(&env).expect("pairing env");
        let root = scratch();
        let models = Arc::new(ModelRegistry::new(root.join("companion-models")));
        let mut gateway = Gateway::new(Ok(config), Some(FileSessionCredentialStore::new(&root)));
        let meta = json!({ "requestId": "write-live", "correlationId": "write-live" });

        let login = super::invoke(&mut gateway, &models, None, "astella.v1.auth.login", &json!({
            "meta": meta, "email": email, "password": password, "remember": true,
        })).await;
        assert_eq!(login["ok"], true, "{login}");

        let created = super::invoke(&mut gateway, &models, None, "astella.v1.note.create", &json!({
            "meta": meta,
            "request": { "title": "Tauri 迁移验证" },
        })).await;
        assert_eq!(created["ok"], true, "{created}");
        let note_id = created["data"]["noteId"].as_str().or(created["data"]["id"].as_str());
        assert!(note_id.is_some(), "{created}");

        let list = super::invoke(&mut gateway, &models, None, "astella.v1.note.list", &json!({ "meta": meta, "limit": 5 })).await;
        assert_eq!(list["ok"], true, "{list}");
        assert!(list["data"]["total"].as_u64().unwrap_or(0) >= 1, "{list}");

        let room = super::invoke(&mut gateway, &models, None, "astella.v1.room.getProjection", &json!({ "meta": meta })).await;
        assert_eq!(room["ok"], true, "{room}");
        assert_eq!(room["data"]["mode"], "notes", "{room}");

        // 图片上传（1x1 PNG，本地 multipart 路径）。
        let upload = super::invoke(&mut gateway, &models, None, "astella.v1.note.image.upload", &json!({
            "meta": meta,
            "noteId": note_id.unwrap(),
            "request": {
                "version": 1,
                "fileName": "probe.png",
                "mimeType": "image/png",
                "bytesBase64": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
            },
        })).await;
        assert_eq!(upload["ok"], true, "{upload}");
        assert!(upload["data"]["url"].as_str().is_some(), "{upload}");

        // 清理：删掉这次验证写进去的那一篇（也顺带验证 DELETE 通道）。
        let deleted = super::invoke(&mut gateway, &models, None, "astella.v1.note.delete", &json!({
            "meta": meta, "noteId": note_id.unwrap(),
        })).await;
        assert_eq!(deleted["ok"], true, "{deleted}");
        assert_eq!(deleted["data"]["status"], "deleted", "{deleted}");

        std::fs::remove_dir_all(&root).ok();
    }
}

/// noteDoc 通道联调（默认忽略）：起点/私有上送/共享流式/改标题/在场。
#[cfg(test)]
mod live_note_doc_channels {
    use std::sync::Arc;

    use serde_json::json;

    use crate::companion_model::ModelRegistry;
    use crate::gateway::{FileSessionCredentialStore, Gateway};

    fn scratch() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "astella-notedoc-live-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[tokio::test]
    #[ignore = "needs the local API stack; creates and deletes one probe note"]
    async fn live_note_doc_channels_round_trip() {
        let email = std::env::var("ASTELLA_LIVE_EMAIL").expect("email");
        let password = std::env::var("ASTELLA_LIVE_PASSWORD").expect("password");
        let env: std::collections::HashMap<String, String> = std::env::vars().collect();
        let config = crate::gateway::config::read_configuration(&env).expect("pairing env");
        let root = scratch();
        let models = Arc::new(ModelRegistry::new(root.join("companion-models")));
        let mut gateway = Gateway::new(Ok(config), Some(FileSessionCredentialStore::new(&root)));
        let meta = json!({ "requestId": "notedoc-live", "correlationId": "notedoc-live" });

        let login = super::invoke(&mut gateway, &models, None, "astella.v1.auth.login", &json!({
            "meta": meta, "email": email, "password": password, "remember": true,
        })).await;
        assert_eq!(login["ok"], true, "{login}");

        // 空间列表：合同形状是 {version, workspaceId, name, role, workspaceType, isPersonal}。
        let workspaces = super::invoke(&mut gateway, &models, None, "astella.v1.workspace.list", &json!({
            "meta": meta,
        })).await;
        assert_eq!(workspaces["ok"], true, "{workspaces}");
        let list = workspaces["data"]["workspaces"].as_array().expect("workspace array");
        assert!(!list.is_empty(), "{workspaces}");
        assert_eq!(list[0]["version"], 1, "{workspaces}");
        assert!(list[0]["name"].is_string(), "{workspaces}");

        // 邀请与成员：Owner 能建/撤邀请、读成员；条目形状按合同转。
        let invite = super::invoke(&mut gateway, &models, None, "astella.v1.invite.create", &json!({
            "meta": meta, "role": "member",
        })).await;
        // 个人空间不许发邀请：服务端 409 落成 conflict，客户端不替它拦。
        assert_eq!(invite["ok"], false, "{invite}");
        assert_eq!(invite["error"]["code"], "conflict", "{invite}");
        let invites = super::invoke(&mut gateway, &models, None, "astella.v1.invite.list", &json!({
            "meta": meta,
        })).await;
        assert_eq!(invites["ok"], true, "{invites}");
        assert_eq!(invites["data"]["version"], 1, "{invites}");
        assert!(invites["data"]["items"].is_array(), "{invites}");
        let members = super::invoke(&mut gateway, &models, None, "astella.v1.member.list", &json!({
            "meta": meta,
        })).await;
        assert_eq!(members["ok"], true, "{members}");
        let roster = members["data"]["items"].as_array().expect("member items");
        assert!(!roster.is_empty(), "{members}");
        assert!(roster[0]["userId"].is_string(), "{members}");
        assert_eq!(roster[0]["version"], 1, "{members}");

        let goals = super::invoke(&mut gateway, &models, None, "astella.v1.agent.long-goals.list", &json!({
            "meta": meta,
        })).await;
        let runs = super::invoke(&mut gateway, &models, None, "astella.v1.agent.runs.list", &json!({
            "meta": meta,
        })).await;
        let notes = super::invoke(&mut gateway, &models, None, "astella.v1.agent.selfNotes.list", &json!({
            "meta": meta,
        })).await;
        let methods = super::invoke(&mut gateway, &models, None, "astella.v1.agent.methods.list", &json!({
            "meta": meta,
        })).await;
        // 四类 agent 读通道：空空间也要给合同形状（items 数组 + 版本）。
        for (label, response) in [("goals", &goals), ("runs", &runs), ("notes", &notes), ("methods", &methods)] {
            assert_eq!(response["ok"], true, "{label}: {response}");
            assert_eq!(response["data"]["version"], 1, "{label}: {response}");
            assert!(response["data"]["items"].is_array(), "{label}: {response}");
        }
        assert!(goals["data"].get("nextCursor").is_some(), "{goals}");
        assert!(runs["data"].get("nextCursor").is_some(), "{runs}");

        let memory_list = super::invoke(&mut gateway, &models, None, "astella.v1.companion.memory.list", &json!({
            "meta": meta, "query": { "includeCandidates": true, "includeArchived": true },
        })).await;
        let memory_budget = super::invoke(&mut gateway, &models, None, "astella.v1.companion.memory.budget", &json!({ "meta": meta })).await;
        let memory_map = super::invoke(&mut gateway, &models, None, "astella.v1.companion.memory.starMap", &json!({ "meta": meta })).await;
        let memory_recycle = super::invoke(&mut gateway, &models, None, "astella.v1.companion.memory.recycle-list", &json!({ "meta": meta })).await;
        let memory_conflicts = super::invoke(&mut gateway, &models, None, "astella.v1.companion.memory.conflicts", &json!({ "meta": meta })).await;
        // 记忆读通道：空空间也给合同形状。
        assert_eq!(memory_list["ok"], true, "{memory_list}");
        assert!(memory_list["data"]["items"].is_array(), "{memory_list}");
        assert_eq!(memory_list["data"]["version"], 2, "{memory_list}");
        assert_eq!(memory_budget["ok"], true, "{memory_budget}");
        assert!(memory_budget["data"]["resident"].is_object(), "{memory_budget}");
        assert!(memory_budget["data"]["active"].is_object(), "{memory_budget}");
        assert!(memory_budget["data"]["archived"].is_object(), "{memory_budget}");
        assert_eq!(memory_map["ok"], true, "{memory_map}");
        assert!(memory_map["data"]["nodes"].is_array(), "{memory_map}");
        assert_eq!(memory_recycle["ok"], true, "{memory_recycle}");
        assert!(memory_recycle["data"]["items"].is_array(), "{memory_recycle}");
        assert_eq!(memory_conflicts["ok"], true, "{memory_conflicts}");
        assert!(memory_conflicts["data"]["items"].is_array(), "{memory_conflicts}");

        let history = super::invoke(&mut gateway, &models, None, "astella.v1.companion.history.list", &json!({ "meta": meta })).await;
        let daily = super::invoke(&mut gateway, &models, None, "astella.v1.companion.daily.get", &json!({ "meta": meta })).await;
        let month = super::invoke(&mut gateway, &models, None, "astella.v1.companion.daily.month", &json!({ "meta": meta, "month": "2026-11" })).await;
        // 伴星历史与日记：空空间给合同形状。
        assert_eq!(history["ok"], true, "{history}");
        assert!(history["data"]["items"].is_array(), "{history}");
        assert_eq!(history["data"]["version"], 1, "{history}");
        assert_eq!(daily["ok"], true, "{daily}");
        assert_eq!(daily["data"]["status"], "not_generated", "{daily}");
        assert!(daily["data"]["blocks"].is_array(), "{daily}");
        assert_eq!(month["ok"], true, "{month}");
        assert!(month["data"]["days"].is_array(), "{month}");
        assert_eq!(month["data"]["month"], "2026-11", "{month}");

        let discovery = super::invoke(&mut gateway, &models, None, "astella.v1.companion.discovery.get", &json!({ "meta": meta })).await;
        let journey = super::invoke(&mut gateway, &models, None, "astella.v1.companion.journey.bootstrap", &json!({ "meta": meta })).await;
        let participation = super::invoke(&mut gateway, &models, None, "astella.v1.companion.initiative.getPreferences", &json!({ "meta": meta })).await;
        // 发现簿 / 旅程 / 参与偏好：空空间给合同形状（旅程可能带一份待回邀请）。
        assert_eq!(discovery["ok"], true, "{discovery}");
        assert!(discovery["data"]["entries"].is_array(), "{discovery}");
        assert_eq!(discovery["data"]["version"], 1, "{discovery}");
        assert_eq!(journey["ok"], true, "{journey}");
        assert!(journey["data"].get("journey").is_some(), "{journey}");
        assert!(journey["data"].get("invitation").is_some(), "{journey}");
        assert_eq!(participation["ok"], true, "{participation}");
        assert!(participation["data"]["enabled"].is_boolean(), "{participation}");
        assert_eq!(participation["data"]["version"], 1, "{participation}");

        let account = super::invoke(&mut gateway, &models, None, "astella.v1.companion.account.getState", &json!({ "meta": meta })).await;
        assert_eq!(account["ok"], true, "{account}");
        assert!(account["data"]["account"].is_object(), "{account}");
        assert!(account["data"]["onboardingStates"].is_array(), "{account}");

        let created_memory = super::invoke(&mut gateway, &models, None, "astella.v1.companion.memory.create", &json!({
            "meta": meta,
            "request": { "kind": "preference", "content": "tauri-memory-probe 喜欢简洁的排版" },
        })).await;
        // 生成任务轮询：随机任务号应回 not_found（证明路径接对）；批注列表可读。
        let probe_note = super::invoke(&mut gateway, &models, None, "astella.v1.note.create", &json!({
            "meta": meta, "request": { "title": "tauri-task-probe" },
        })).await;
        assert_eq!(probe_note["ok"], true, "{probe_note}");
        let probe_note_id = probe_note["data"]["noteId"].as_str().or(probe_note["data"]["id"].as_str()).expect("probe note id").to_string();
        let task_probe = super::invoke(&mut gateway, &models, None, "astella.v1.noteExpansion.getTask", &json!({
            "meta": meta, "noteId": probe_note_id, "taskId": "00000000-0000-4000-8000-000000000000",
        })).await;
        assert_eq!(task_probe["ok"], false, "{task_probe}");
        assert_eq!(task_probe["error"]["code"], "not_found", "{task_probe}");
        let annotations = super::invoke(&mut gateway, &models, None, "astella.v1.noteAnnotation.list", &json!({
            "meta": meta, "noteId": probe_note_id,
        })).await;
        assert_eq!(annotations["ok"], true, "{annotations}");
        let _ = super::invoke(&mut gateway, &models, None, "astella.v1.note.delete", &json!({
            "meta": meta, "noteId": probe_note_id,
        })).await;

        // 来源写面接线：随机来源号应回 not_found（路径通、对象不存在）。
        let source_notes = super::invoke(&mut gateway, &models, None, "astella.v1.source.notes", &json!({
            "meta": meta, "sourceId": "00000000-0000-4000-8000-000000000001",
        })).await;
        assert_eq!(source_notes["ok"], false, "{source_notes}");
        assert_eq!(source_notes["error"]["code"], "not_found", "{source_notes}");

        // 本地稿纸：系统授权后读/存/读同级图片；未授权路径一律 forbidden。
        let paper_dir = root.join("local-paper");
        std::fs::create_dir_all(&paper_dir).unwrap();
        let paper_path = paper_dir.join("paper.md");
        std::fs::write(&paper_path, "# 本地稿纸\n".as_bytes()).unwrap();
        crate::opened_files::broker().receive(vec![paper_path.clone()]);
        let paper_path_text = paper_path.to_string_lossy().to_string();
        let read_paper = super::invoke(&mut gateway, &models, None, "astella.v1.noteWriting.perform", &json!({
            "meta": meta, "request": { "action": "read", "path": paper_path_text },
        })).await;
        assert_eq!(read_paper["ok"], true, "{read_paper}");
        assert!(read_paper["data"]["markdown"].as_str().unwrap_or("").contains("本地稿纸"), "{read_paper}");
        let paper_revision = read_paper["data"]["revision"].clone();
        let saved_paper = super::invoke(&mut gateway, &models, None, "astella.v1.noteWriting.perform", &json!({
            "meta": meta,
            "request": { "action": "save", "path": paper_path_text, "markdown": "# 本地稿纸\n\n改过了。\n", "revision": paper_revision },
        })).await;
        assert_eq!(saved_paper["ok"], true, "{saved_paper}");
        let reread = super::invoke(&mut gateway, &models, None, "astella.v1.noteWriting.perform", &json!({
            "meta": meta, "request": { "action": "read", "path": paper_path_text },
        })).await;
        assert!(reread["data"]["markdown"].as_str().unwrap_or("").contains("改过了。"), "{reread}");
        let png_bytes = base64::engine::general_purpose::STANDARD
            .decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")
            .unwrap();
        let asset_path = paper_dir.join("asset.png");
        std::fs::write(&asset_path, &png_bytes).unwrap();
        let read_image = super::invoke(&mut gateway, &models, None, "astella.v1.noteWriting.perform", &json!({
            "meta": meta, "request": { "action": "image", "path": asset_path.to_string_lossy() },
        })).await;
        assert_eq!(read_image["ok"], true, "{read_image}");
        assert_eq!(read_image["data"]["mime"], "image/png", "{read_image}");
        let stranger_path = root.join("not-granted.md");
        std::fs::write(&stranger_path, "x".as_bytes()).unwrap();
        let stranger = super::invoke(&mut gateway, &models, None, "astella.v1.noteWriting.perform", &json!({
            "meta": meta, "request": { "action": "read", "path": stranger_path.to_string_lossy() },
        })).await;
        assert_eq!(stranger["ok"], false, "{stranger}");
        assert_eq!(stranger["error"]["code"], "forbidden", "{stranger}");

        // 伴星数据导出：落 Downloads/Astella/伴星，回执��带文件名；测完自删。
        let exported = super::invoke(&mut gateway, &models, None, "astella.v1.companion.data.export", &json!({
            "meta": meta, "kind": "memory",
        })).await;
        assert_eq!(exported["ok"], true, "{exported}");
        assert_eq!(exported["data"]["saved"], true, "{exported}");
        let export_name = exported["data"]["fileName"].as_str().expect("export file name").to_string();
        assert!(exported["data"]["bytes"].as_u64().unwrap_or(0) > 0, "{exported}");
        if let Ok(home) = std::env::var("HOME") {
            let export_path = std::path::Path::new(&home)
                .join("Downloads")
                .join("Astella")
                .join("伴星")
                .join(&export_name);
            assert!(export_path.is_file(), "export file missing: {export_path:?}");
            std::fs::remove_file(&export_path).ok();
        }

        // 记忆写闭环：创建 → 列表可见 → 删除进回收 → 恢复 → 彻底清除。
        assert_eq!(created_memory["ok"], true, "{created_memory}");
        let memory_id = created_memory["data"]["memoryItemId"].as_str().expect("memory id").to_string();
        assert_eq!(created_memory["data"]["kind"], "preference", "{created_memory}");
        let listed = super::invoke(&mut gateway, &models, None, "astella.v1.companion.memory.list", &json!({
            "meta": meta, "query": { "includeCandidates": true, "includeArchived": true },
        })).await;
        assert!(listed["data"]["items"].as_array().unwrap().iter().any(|item| item["memoryItemId"].as_str() == Some(memory_id.as_str())), "{listed}");
        for action in ["confirm", "pin", "unpin", "archive", "restore"] {
            let response = super::invoke(&mut gateway, &models, None, &format!("astella.v1.companion.memory.{action}"), &json!({
                "meta": meta, "memoryId": memory_id,
            })).await;
            assert_eq!(response["ok"], true, "{action}: {response}");
            assert_eq!(response["data"]["memoryItemId"], memory_id, "{action}: {response}");
        }
        let persona_versions = super::invoke(&mut gateway, &models, None, "astella.v1.companion.persona.versions", &json!({ "meta": meta })).await;
        assert_eq!(persona_versions["ok"], true, "{persona_versions}");
        let persona_pending = super::invoke(&mut gateway, &models, None, "astella.v1.companion.persona.pending", &json!({ "meta": meta })).await;
        assert_eq!(persona_pending["ok"], true, "{persona_pending}");
        let deleted = super::invoke(&mut gateway, &models, None, "astella.v1.companion.memory.delete", &json!({
            "meta": meta, "memoryId": memory_id,
        })).await;
        assert_eq!(deleted["ok"], true, "{deleted}");
        assert_eq!(deleted["data"]["memoryItemId"], memory_id, "{deleted}");
        let restored = super::invoke(&mut gateway, &models, None, "astella.v1.companion.memory.restore-deleted", &json!({
            "meta": meta, "memoryId": memory_id,
        })).await;
        assert_eq!(restored["ok"], true, "{restored}");
        let erased = super::invoke(&mut gateway, &models, None, "astella.v1.companion.memory.erase", &json!({
            "meta": meta, "memoryId": memory_id,
        })).await;
        assert_eq!(erased["ok"], true, "{erased}");
        // 伴星文件上传：本地稿纸原件走 multipart → 回 /api/uploads/ 相对 URL。
        let probe_file = root.join("companion-upload-probe.md");
        std::fs::write(&probe_file, "# 伴星上传探针\n\n这是本地稿纸。\n").expect("write probe file");
        let uploaded_file = super::invoke(&mut gateway, &models, None, "astella.v1.companion.file.upload", &json!({
            "meta": meta,
            "request": { "version": 1, "path": probe_file.to_string_lossy(), "name": "companion-upload-probe.md" },
        })).await;
        assert_eq!(uploaded_file["ok"], true, "{uploaded_file}");
        assert!(uploaded_file["data"]["url"].as_str().unwrap_or("").starts_with("/api/uploads/"), "{uploaded_file}");
        assert!(uploaded_file["data"]["byteLength"].as_u64().unwrap_or(0) > 0, "{uploaded_file}");
        std::fs::remove_file(&probe_file).ok();

        // 活动时间线：空收件箱也要给合同形状。
        let timeline = super::invoke(&mut gateway, &models, None, "astella.v1.companion.activity.timeline", &json!({
            "meta": meta,
        })).await;
        assert_eq!(timeline["ok"], true, "{timeline}");
        assert!(timeline["data"]["items"].is_array(), "{timeline}");
        assert!(timeline["data"].get("nextCursor").is_some(), "{timeline}");
        assert!(timeline["data"].get("serverTime").is_some(), "{timeline}");

        // 聊天 REST：收件箱会话 → 空消息列表 → 路由/节点读；图片上传走 multipart 回退。
        let ensured = super::invoke(&mut gateway, &models, None, "astella.v1.companion.chat.ensureConversation", &json!({
            "meta": meta,
        })).await;
        assert_eq!(ensured["ok"], true, "{ensured}");
        assert_eq!(ensured["data"]["version"], 1, "{ensured}");
        assert_eq!(ensured["data"]["conversation"]["kind"], "inbox", "{ensured}");
        let conversation_id = ensured["data"]["conversation"]["id"].as_str().expect("conversation id").to_string();
        let messages = super::invoke(&mut gateway, &models, None, "astella.v1.companion.chat.listMessages", &json!({
            "meta": meta, "request": { "version": 1, "conversationId": conversation_id, "limit": 50 },
        })).await;
        assert_eq!(messages["ok"], true, "{messages}");
        assert!(messages["data"]["items"].is_array(), "{messages}");
        let routes = super::invoke(&mut gateway, &models, None, "astella.v1.companion.chat.agentRoutes.list", &json!({
            "meta": meta, "request": { "version": 1, "conversationId": conversation_id, "afterSeq": 0 },
        })).await;
        assert_eq!(routes["ok"], true, "{routes}");
        let nodes = super::invoke(&mut gateway, &models, None, "astella.v1.companion.chat.runNodes.list", &json!({
            "meta": meta, "request": { "version": 1, "conversationId": conversation_id, "includeThinking": true },
        })).await;
        assert_eq!(nodes["ok"], true, "{nodes}");
        let uploaded_image = super::invoke(&mut gateway, &models, None, "astella.v1.companion.image.upload", &json!({
            "meta": meta,
            "request": {
                "version": 1,
                "fileName": "companion-image-probe.png",
                "mimeType": "image/png",
                "bytesBase64": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
            },
        })).await;
        assert_eq!(uploaded_image["ok"], true, "{uploaded_image}");
        assert!(uploaded_image["data"]["url"].as_str().map(|url| url.starts_with("/api/uploads/")).unwrap_or(false), "{uploaded_image}");

        // 发一轮真对话前先签 AI 同意（桌面端同一通道；dev 账号上签一次即持久）。
        let consent = super::invoke(&mut gateway, &models, None, "astella.v1.workspace.updateAiConsent", &json!({
            "meta": meta, "consentVersion": "desktop-tauri-live-probe",
        })).await;
        assert_eq!(consent["ok"], true, "{consent}");
        let client_message_id = "8f0c4a2e-1111-4f1a-9b1c-6d7e8f9a0b1c";
        let sent = super::invoke(&mut gateway, &models, None, "astella.v1.companion.chat.sendTurn", &json!({
            "meta": meta,
            "request": {
                "version": 1,
                "conversationId": conversation_id,
                "idempotencyKey": "9a1b2c3d-2222-4e2f-8a3b-7c8d9e0f1a2b",
                "turn": {
                    "version": 1,
                    "clientMessageId": client_message_id,
                    "inputKind": "text",
                    "blocks": [{ "type": "text", "text": "tauri 聊天探针：请只回一个字。" }],
                    "sourceSurface": "pet",
                },
            },
        })).await;
        assert_eq!(sent["ok"], true, "{sent}");
        println!("PROBE-SENT={sent}");
        let chat_deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(90);
        let mut last_messages = serde_json::Value::Null;
        let mut saw_user = false;
        let mut saw_assistant = false;
        while tokio::time::Instant::now() < chat_deadline {
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
            last_messages = super::invoke(&mut gateway, &models, None, "astella.v1.companion.chat.listMessages", &json!({
                "meta": meta, "request": { "version": 1, "conversationId": conversation_id, "limit": 50 },
            })).await;
            if let Some(items) = last_messages["data"]["items"].as_array() {
                for item in items {
                    let role = item["role"].as_str().unwrap_or("");
                    let text = item.to_string();
                    if role == "user" && text.contains("tauri 聊天探针") { saw_user = true; }
                    if role == "assistant" { saw_assistant = true; }
                }
            }
            if saw_user && saw_assistant { break; }
        }
        // 登录面：档案读、头像上传/读取。
        let profile = super::invoke(&mut gateway, &models, None, "astella.v1.auth.getProfile", &json!({
            "meta": meta,
        })).await;
        assert_eq!(profile["ok"], true, "{profile}");
        assert_eq!(profile["data"]["version"], 1, "{profile}");
        let avatar = super::invoke(&mut gateway, &models, None, "astella.v1.auth.uploadAvatar", &json!({
            "meta": meta,
            "request": {
                "version": 1,
                "fileName": "avatar-probe.png",
                "mimeType": "image/png",
                "bytesBase64": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
            },
        })).await;
        assert_eq!(avatar["ok"], true, "{avatar}");
        let object_key = avatar["data"]["objectKey"].as_str().expect("avatar key").to_string();
        let avatar_bytes = super::invoke(&mut gateway, &models, None, "astella.v1.auth.getAvatar", &json!({
            "meta": meta, "request": { "version": 1, "objectKey": object_key },
        })).await;
        assert_eq!(avatar_bytes["ok"], true, "{avatar_bytes}");
        assert!(avatar_bytes["data"]["byteLength"].as_u64().unwrap_or(0) > 0, "{avatar_bytes}");
        assert_eq!(avatar_bytes["data"]["mimeType"], "image/png", "{avatar_bytes}");

        // 伴星桥上下文：发布当前页 → 同页去重 → 撤下。
        let page_context = json!({
            "routeRef": { "kind": "home" },
            "pageKind": "other",
            "entityRefs": [],
            "interactionState": "idle",
            "capabilityHints": [],
            "sensitivity": "normal",
        });
        let bridged = super::invoke(&mut gateway, &models, None, "astella.v1.companion.bridge.setContext", &json!({
            "meta": meta, "page": page_context,
        })).await;
        assert_eq!(bridged["ok"], true, "{bridged}");
        assert_eq!(bridged["data"]["active"], true, "{bridged}");
        assert!(bridged["data"]["revision"].is_string(), "{bridged}");
        let cleared_bridge = super::invoke(&mut gateway, &models, None, "astella.v1.companion.bridge.clearContext", &json!({
            "meta": meta,
        })).await;
        assert_eq!(cleared_bridge["ok"], true, "{cleared_bridge}");
        assert_eq!(cleared_bridge["data"]["active"], false, "{cleared_bridge}");

        // SSE 流式订阅：从 cursor 0 重放既有事件（含刚结束的这一轮）。
        let subscribed = super::invoke(&mut gateway, &models, None, "astella.v1.subscriptions.subscribe", &json!({
            "meta": meta,
            "topic": { "kind": "companionChat", "conversationId": conversation_id, "eventCursor": 0, "voiceOutput": false },
        })).await;
        assert_eq!(subscribed["ok"], true, "{subscribed}");
        let stream_id = subscribed["data"]["subscriptionId"].as_str().expect("stream id").to_string();
        assert!(stream_id.starts_with("companion-chat:"), "{subscribed}");
        let stream_deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);
        let mut streamed = false;
        while tokio::time::Instant::now() < stream_deadline {
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
            let polled = super::invoke(&mut gateway, &models, None, "astella.v1.companion.chat.pollEvents", &json!({
                "meta": meta, "subscriptionId": stream_id,
            })).await;
            if let Some(events) = polled["data"]["events"].as_array() {
                for frame in events {
                    let event = &frame["data"]["event"];
                    if frame["data"]["kind"] == "companion_chat_event"
                        && event["eventType"].is_string()
                        && event["runId"].is_string()
                    {
                        streamed = true;
                    }
                }
            }
            if streamed { break; }
        }
        let unsubscribed = super::invoke(&mut gateway, &models, None, "astella.v1.subscriptions.unsubscribe", &json!({
            "meta": meta, "subscriptionId": stream_id,
        })).await;
        assert_eq!(unsubscribed["ok"], true, "{unsubscribed}");
        assert!(streamed, "no companion_chat_event arrived over SSE");
        assert!(saw_user, "user turn never showed up: {last_messages}");
        assert!(saw_assistant, "assistant reply never showed up: {last_messages}");

        // 顺手清掉上一轮探针留下的同前缀条目（本地栈自洁）。
        let leftovers = super::invoke(&mut gateway, &models, None, "astella.v1.companion.memory.list", &json!({
            "meta": meta, "query": { "includeCandidates": true, "includeArchived": true },
        })).await;
        if let Some(items) = leftovers["data"]["items"].as_array() {
            for item in items {
                let content = item["content"].as_str().unwrap_or("");
                if let (Some(id), true) = (item["memoryItemId"].as_str(), content.starts_with("tauri-memory-probe")) {
                    let _ = super::invoke(&mut gateway, &models, None, "astella.v1.companion.memory.erase", &json!({
                        "meta": meta, "memoryId": id,
                    })).await;
                }
            }
        }

        let created = super::invoke(&mut gateway, &models, None, "astella.v1.note.create", &json!({
            "meta": meta, "request": { "title": "Tauri noteDoc 探针" },
        })).await;
        assert_eq!(created["ok"], true, "{created}");
        let note_id = created["data"]["noteId"].as_str().or(created["data"]["id"].as_str()).expect("note id").to_string();

        // 起点（private）。
        let state = super::invoke(&mut gateway, &models, None, "astella.v1.note.doc.state", &json!({
            "meta": meta, "noteId": note_id,
        })).await;
        assert_eq!(state["ok"], true, "{state}");
        assert_eq!(state["data"]["shareScope"], "private", "{state}");
        let base_update = state["data"]["update"].as_str().expect("update").to_string();

        use base64::Engine;
        let base_bytes = base64::engine::general_purpose::STANDARD.decode(&base_update).expect("b64");
        let mut doc = crate::collab::new_doc();
        crate::collab::apply_update(&mut doc, &base_bytes).expect("apply base");
        let before = crate::collab::state_vector(&doc);
        crate::collab::seed_paragraph(&mut doc, "tauri-notedoc-private-probe");
        let diff = crate::collab::diff_update(&doc, &before).expect("diff");
        let diff_b64 = base64::engine::general_purpose::STANDARD.encode(&diff);

        let uploaded = super::invoke(&mut gateway, &models, None, "astella.v1.note.doc.syncUpdate", &json!({
            "meta": meta, "commandId": "cmd-1", "noteId": note_id, "update": diff_b64,
        })).await;
        assert_eq!(uploaded["ok"], true, "{uploaded}");
        assert_eq!(uploaded["data"]["via"], "uploaded", "{uploaded}");

        // 共享后走流式。
        gateway.request_json(reqwest::Method::PATCH, &format!("/v2/notes/{note_id}/share-scope"),
            Some(json!({ "shareScope": "shared" })), true).await.expect("share");

        let shared_state = super::invoke(&mut gateway, &models, None, "astella.v1.note.doc.state", &json!({
            "meta": meta, "noteId": note_id,
        })).await;
        assert_eq!(shared_state["data"]["shareScope"], "shared", "{shared_state}");
        let base_bytes = base64::engine::general_purpose::STANDARD
            .decode(shared_state["data"]["update"].as_str().expect("update")).expect("b64");
        let mut doc = crate::collab::new_doc();
        crate::collab::apply_update(&mut doc, &base_bytes).expect("apply base");
        let before = crate::collab::state_vector(&doc);
        crate::collab::seed_paragraph(&mut doc, "tauri-notedoc-stream-probe");
        let diff_b64 = base64::engine::general_purpose::STANDARD.encode(crate::collab::diff_update(&doc, &before).expect("diff"));

        let streamed = super::invoke(&mut gateway, &models, None, "astella.v1.note.doc.syncUpdate", &json!({
            "meta": meta, "commandId": "cmd-2", "noteId": note_id, "update": diff_b64,
        })).await;
        assert_eq!(streamed["ok"], true, "{streamed}");
        assert_eq!(streamed["data"]["via"], "stream", "{streamed}");

        let presence = super::invoke(&mut gateway, &models, None, "astella.v1.note.doc.presence", &json!({
            "meta": meta, "noteId": note_id,
        })).await;
        assert_eq!(presence["data"]["shared"], true, "{presence}");

        // 学习卡：没有卡片时也要给合同形状（card:null + generating:false）。
        let card = super::invoke(&mut gateway, &models, None, "astella.v1.noteLearningCard.get", &json!({
            "meta": meta, "noteId": note_id,
        })).await;
        assert_eq!(card["ok"], true, "{card}");
        assert!(card["data"].get("card").is_some(), "{card}");
        assert_eq!(card["data"]["generating"], false, "{card}");

        // 星图总览：空空间也要能读（200 + 快照形状）。
        let topology = super::invoke(&mut gateway, &models, None, "astella.v1.understanding.getTopology", &json!({
            "meta": meta,
        })).await;
        assert_eq!(topology["ok"], true, "{topology}");

        // 上报本机在场：活会话存在时走 awareness 上行。
        let reported = super::invoke(&mut gateway, &models, None, "astella.v1.note.doc.presence", &json!({
            "meta": meta, "noteId": note_id, "state": "{\"mode\":\"writing\",\"block\":1}",
        })).await;
        assert_eq!(reported["ok"], true, "{reported}");

        let titled = super::invoke(&mut gateway, &models, None, "astella.v1.note.doc.syncTitle", &json!({
            "meta": meta, "commandId": "cmd-3", "noteId": note_id, "title": "改名后的探针", "titleSource": "manual",
        })).await;
        assert_eq!(titled["ok"], true, "{titled}");
        assert_eq!(titled["data"]["via"], "stream", "{titled}");

        // 推送：订阅建立活会话后，另一个客户端写入的增量必须出现在 pollUpdates。
        let subscribed = super::invoke(&mut gateway, &models, None, "astella.v1.subscriptions.subscribe", &json!({
            "meta": meta, "topic": { "kind": "noteDoc", "noteId": note_id },
        })).await;
        assert_eq!(subscribed["ok"], true, "{subscribed}");
        assert!(subscribed["data"]["subscriptionId"].as_str().unwrap_or("").starts_with("note-doc:"), "{subscribed}");

        {
            use base64::Engine;
            let state_now = super::invoke(&mut gateway, &models, None, "astella.v1.note.doc.state", &json!({
                "meta": meta, "noteId": note_id,
            })).await;
            let base = base64::engine::general_purpose::STANDARD
                .decode(state_now["data"]["update"].as_str().expect("state update")).expect("b64");
            let mut remote_doc = crate::collab::new_doc();
            crate::collab::apply_update(&mut remote_doc, &base).expect("apply base");
            let before = crate::collab::state_vector(&remote_doc);
            crate::collab::seed_paragraph(&mut remote_doc, "remote-push-probe");
            let remote_update = crate::collab::diff_update(&remote_doc, &before).expect("diff");

            // 第二个客户端：裸连接，不经过会话注册表。
            let origin = gateway.api_origin();
            let token = gateway.token().expect("token").to_string();
            let document_name = format!("{}", note_id);
            let mut stream = crate::collab_client::connect(&origin).await.expect("second connect");
            crate::collab_client::send(&mut stream, crate::collab_client::authentication_frame(
                &format!("note:{document_name}"), &token)).await.expect("auth");
            // 等鉴权并来回 step1/step2。
            for _ in 0..6 {
                match crate::collab_client::receive(&mut stream, &format!("note:{document_name}")).await {
                    Ok(crate::collab_client::IncomingFrame::Authenticated(_)) => {
                        let sv = crate::collab::state_vector(&crate::collab::new_doc());
                        crate::collab_client::send(&mut stream, crate::collab_client::sync_step1_frame(
                            &format!("note:{document_name}"), &sv)).await.expect("step1");
                    }
                    Ok(crate::collab_client::IncomingFrame::SyncStep1(remote_sv)) => {
                        let mut empty = crate::collab::new_doc();
                        crate::collab::apply_update(&mut empty, &base).expect("base");
                        let missing = crate::collab::diff_update(&empty, &remote_sv).expect("diff");
                        crate::collab_client::send(&mut stream, crate::collab_client::sync_step2_frame(
                            &format!("note:{document_name}"), &missing)).await.expect("step2");
                        break;
                    }
                    Ok(_) => {}
                    Err(_) => break,
                }
            }
            crate::collab_client::send(&mut stream, crate::collab_client::update_frame(
                &format!("note:{document_name}"), &remote_update)).await.expect("remote update");
            let _ = stream.close(None).await;
        }

        let poll_deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
        let mut pushed = 0usize;
        while tokio::time::Instant::now() < poll_deadline {
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
            let polled = super::invoke(&mut gateway, &models, None, "astella.v1.note.doc.pollUpdates", &json!({
                "meta": meta, "noteId": note_id,
            })).await;
            pushed += polled["data"]["updates"].as_array().map(|items| items.len()).unwrap_or(0);
            if pushed > 0 { break; }
        }
        assert!(pushed > 0, "remote update never reached the subscribed session");

        // REST 读回：流式写入与改名都要落进去。
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);
        let mut seen = false;
        while tokio::time::Instant::now() < deadline {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            if let Ok((_status, body)) = gateway.request_json(reqwest::Method::GET, &format!("/v2/notes/{note_id}"), None, true).await {
                let text = body.to_string();
                if text.contains("tauri-notedoc-stream-probe") && text.contains("改名后的探针") {
                    seen = true;
                    break;
                }
            }
        }
        assert!(seen, "server did not project streamed doc + title back into the note");

        let _ = gateway.request_json(reqwest::Method::DELETE, &format!("/notes/{note_id}"), None, true).await;

        // 空间面闭环：建探针空间（内部自动切入）→ 切回个人 → 解散探针空间（自清理）。
        let workspace_id = list[0]["workspaceId"].as_str().expect("workspace id").to_string();
        let created_ws = super::invoke(&mut gateway, &models, None, "astella.v1.workspace.create", &json!({
            "meta": meta, "name": "tauri-probe-space",
        })).await;
        assert_eq!(created_ws["ok"], true, "{created_ws}");
        let probe_workspace_id = created_ws["data"]["workspaceId"].as_str().expect("probe workspace id").to_string();
        let inside = super::invoke(&mut gateway, &models, None, "astella.v1.auth.getState", &json!({ "meta": meta })).await;
        assert_eq!(inside["data"]["workspace"]["workspaceId"], probe_workspace_id, "{inside}");
        let back = super::invoke(&mut gateway, &models, None, "astella.v1.workspace.switch", &json!({
            "meta": meta, "workspaceId": workspace_id,
        })).await;
        assert_eq!(back["ok"], true, "{back}");
        assert_eq!(back["data"]["workspace"]["workspaceId"], workspace_id, "{back}");
        let preview = super::invoke(&mut gateway, &models, None, "astella.v1.workspace.dissolvePreview", &json!({
            "meta": meta, "workspaceId": probe_workspace_id,
        })).await;
        assert_eq!(preview["ok"], true, "{preview}");
        assert!(preview["data"]["counts"].is_object(), "{preview}");
        let dissolved = super::invoke(&mut gateway, &models, None, "astella.v1.workspace.dissolve", &json!({
            "meta": meta, "workspaceId": probe_workspace_id,
        })).await;
        assert_eq!(dissolved["ok"], true, "{dissolved}");
        assert!(dissolved["data"]["counts"].is_object(), "{dissolved}");
        let audit = super::invoke(&mut gateway, &models, None, "astella.v1.workspace.getAiAuditLog", &json!({
            "meta": meta, "limit": 20, "offset": 0,
        })).await;
        assert_eq!(audit["ok"], true, "{audit}");
        let restored = super::invoke(&mut gateway, &models, None, "astella.v1.auth.getState", &json!({ "meta": meta })).await;
        assert_eq!(restored["ok"], true, "{restored}");
        assert_eq!(restored["data"]["workspace"]["workspaceId"], workspace_id, "{restored}");

        // 整库导出：经测试注入路径落到临时文件（真实路径走保存对话框）。
        let export_path = root.join("workspace-export.json");
        std::env::set_var("ASTELLA_EXPORT_PATH", export_path.to_string_lossy().to_string());
        let workspace_export = super::invoke(&mut gateway, &models, None, "astella.v1.workspace.export", &json!({
            "meta": meta,
        })).await;
        std::env::remove_var("ASTELLA_EXPORT_PATH");
        assert_eq!(workspace_export["ok"], true, "{workspace_export}");
        assert_eq!(workspace_export["data"]["saved"], true, "{workspace_export}");
        assert!(workspace_export["data"]["bytes"].as_u64().unwrap_or(0) > 0, "{workspace_export}");
        assert!(export_path.is_file(), "workspace export file missing");
        let exported_text = std::fs::read_to_string(&export_path).unwrap_or_default();
        assert!(exported_text.trim_start().starts_with('{'), "workspace export is not JSON");
        std::fs::remove_file(&export_path).ok();

        // 笔记导出为 Markdown 目录：落临时目录，撞名让位，测完自清理。
        let export_dir = root.join("markdown-export");
        std::fs::create_dir_all(&export_dir).unwrap();
        std::fs::write(export_dir.join("tauri-export-probe.md"), "占位").unwrap();
        let export_note = super::invoke(&mut gateway, &models, None, "astella.v1.note.create", &json!({
            "meta": meta, "request": { "title": "tauri-export-probe" },
        })).await;
        assert_eq!(export_note["ok"], true, "{export_note}");
        let export_note_id = export_note["data"]["noteId"].as_str().or(export_note["data"]["id"].as_str()).expect("export note id").to_string();
        std::env::set_var("ASTELLA_EXPORT_DIRECTORY", export_dir.to_string_lossy().to_string());
        let markdown_export = super::invoke(&mut gateway, &models, None, "astella.v1.notes.markdownExport", &json!({
            "meta": meta,
        })).await;
        std::env::remove_var("ASTELLA_EXPORT_DIRECTORY");
        assert_eq!(markdown_export["ok"], true, "{markdown_export}");
        assert_eq!(markdown_export["data"]["canceled"], false, "{markdown_export}");
        assert!(markdown_export["data"]["exported"].as_u64().unwrap_or(0) >= 1, "{markdown_export}");
        let moved_name = export_dir.join("tauri-export-probe (2).md");
        assert!(moved_name.is_file(), "collision rename missing: {moved_name:?}");
        let exported_markdown = std::fs::read_to_string(&moved_name).unwrap_or_default();
        assert!(!exported_markdown.is_empty(), "exported markdown is empty");
        let _ = super::invoke(&mut gateway, &models, None, "astella.v1.note.delete", &json!({
            "meta": meta, "noteId": export_note_id,
        })).await;
        std::fs::remove_dir_all(&export_dir).ok();

        // 导出 HTML：经测试注入路径落盘，标题与正文渲染成片段。
        let html_export_path = root.join("paper-export.html");
        std::env::set_var("ASTELLA_EXPORT_PATH", html_export_path.to_string_lossy().to_string());
        let html_export = super::invoke(&mut gateway, &models, None, "astella.v1.noteWriting.perform", &json!({
            "meta": meta,
            "request": { "action": "export", "format": "html", "title": "导出探针", "markdown": "# 导出探针\n\n正文。\n" },
        })).await;
        std::env::remove_var("ASTELLA_EXPORT_PATH");
        assert_eq!(html_export["ok"], true, "{html_export}");
        assert!(html_export_path.is_file(), "html export file missing");
        let exported_html = std::fs::read_to_string(&html_export_path).unwrap_or_default();
        assert!(exported_html.contains("<h1>导出探针</h1>"), "html export content wrong");
        std::fs::remove_file(&html_export_path).ok();

        // 导出 DOCX：经测试注入路径落盘（zip 魔数 + 非空），内容正确性由 docx 单测 + textutil 探针兜底。
        let docx_export_path = root.join("paper-export.docx");
        std::env::set_var("ASTELLA_EXPORT_PATH", docx_export_path.to_string_lossy().to_string());
        let docx_export = super::invoke(&mut gateway, &models, None, "astella.v1.noteWriting.perform", &json!({
            "meta": meta,
            "request": { "action": "export", "format": "docx", "title": "导出探针", "markdown": "# 导出探针\n\nWord 正文。\n" },
        })).await;
        std::env::remove_var("ASTELLA_EXPORT_PATH");
        assert_eq!(docx_export["ok"], true, "{docx_export}");
        let docx_bytes = std::fs::read(&docx_export_path).unwrap_or_default();
        assert!(docx_bytes.len() > 1_000, "docx export too small");
        assert_eq!(&docx_bytes[..2], b"PK", "docx export is not a zip package");
        std::fs::remove_file(&docx_export_path).ok();

        // 真图片节点导出：上传图 → yjs 放 paragraph>image → 增量上行 → 导出把图本地化到 assets/。
        let image_note = super::invoke(&mut gateway, &models, None, "astella.v1.note.create", &json!({
            "meta": meta, "request": { "title": "tauri-image-export-probe" },
        })).await;
        assert_eq!(image_note["ok"], true, "{image_note}");
        let image_note_id = image_note["data"]["noteId"].as_str().or(image_note["data"]["id"].as_str()).expect("image note id").to_string();
        let png_base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
        let image_upload = super::invoke(&mut gateway, &models, None, "astella.v1.note.image.upload", &json!({
            "meta": meta, "noteId": image_note_id,
            "request": { "version": 1, "fileName": "probe.png", "mimeType": "image/png", "bytesBase64": png_base64 },
        })).await;
        assert_eq!(image_upload["ok"], true, "{image_upload}");
        let image_url = image_upload["data"]["url"].as_str().expect("image url").to_string();
        assert!(image_url.starts_with("/api/uploads/"), "{image_upload}");
        let image_state = super::invoke(&mut gateway, &models, None, "astella.v1.note.doc.state", &json!({
            "meta": meta, "noteId": image_note_id,
        })).await;
        assert_eq!(image_state["ok"], true, "{image_state}");
        {
            use base64::Engine;
            let base = base64::engine::general_purpose::STANDARD
                .decode(image_state["data"]["update"].as_str().unwrap_or("")).expect("state update");
            let mut image_doc = crate::collab::new_doc();
            crate::collab::apply_update(&mut image_doc, &base).expect("apply base");
            let before = crate::collab::state_vector(&image_doc);
            crate::collab::seed_paragraph(&mut image_doc, "图片导出探针");
            crate::collab::seed_image(&mut image_doc, &image_url, "图");
            let diff = crate::collab::diff_update(&image_doc, &before).expect("image diff");
            let uploaded = super::invoke(&mut gateway, &models, None, "astella.v1.note.doc.syncUpdate", &json!({
                "meta": meta, "commandId": "image-export-cmd", "noteId": image_note_id,
                "update": base64::engine::general_purpose::STANDARD.encode(&diff),
            })).await;
            assert_eq!(uploaded["ok"], true, "{uploaded}");
        }
        let image_export_dir = root.join("image-export");
        std::env::set_var("ASTELLA_EXPORT_DIRECTORY", image_export_dir.to_string_lossy().to_string());
        let image_export = super::invoke(&mut gateway, &models, None, "astella.v1.notes.markdownExport", &json!({
            "meta": meta,
        })).await;
        std::env::remove_var("ASTELLA_EXPORT_DIRECTORY");
        assert_eq!(image_export["ok"], true, "{image_export}");
        assert_eq!(image_export["data"]["imageFailures"], 0, "{image_export}");
        assert!(image_export["data"]["images"].as_u64().unwrap_or(0) >= 1, "{image_export}");
        let localized = std::fs::read_dir(&image_export_dir)
            .map(|entries| {
                entries
                    .flatten()
                    .filter(|entry| entry.file_name().to_string_lossy().ends_with(".md"))
                    .filter_map(|entry| std::fs::read_to_string(entry.path()).ok())
                    .any(|text| text.contains("assets/"))
            })
            .unwrap_or(false);
        assert!(localized, "no exported markdown references assets/");
        let assets = std::fs::read_dir(image_export_dir.join("assets")).map(|entries| entries.flatten().count()).unwrap_or(0);
        assert!(assets >= 1, "assets directory empty");
        let _ = super::invoke(&mut gateway, &models, None, "astella.v1.note.delete", &json!({
            "meta": meta, "noteId": image_note_id,
        })).await;
        std::fs::remove_dir_all(&image_export_dir).ok();

        // Markdown 包：目录版 inspect → import（本地图上传、https 外链逐条报 issue）。
        let bundle_dir = root.join("bundle");
        std::fs::create_dir_all(bundle_dir.join("img")).unwrap();
        std::fs::write(bundle_dir.join("note-one.md"), "# 包内笔记\n\n![图](./img/pic.png)\n").unwrap();
        std::fs::write(bundle_dir.join("note-two.md"), "# 外链笔记\n\n![外](https://example.com/x.png)\n").unwrap();
        std::fs::write(
            bundle_dir.join("img/pic.png"),
            base64::engine::general_purpose::STANDARD
                .decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")
                .unwrap(),
        ).unwrap();
        std::env::set_var("ASTELLA_BUNDLE_PATH", bundle_dir.to_string_lossy().to_string());
        let bundle_preview = super::invoke(&mut gateway, &models, None, "astella.v1.source.bundleImport", &json!({
            "meta": meta, "request": { "version": 1, "action": "inspect", "kind": "folder" },
        })).await;
        std::env::remove_var("ASTELLA_BUNDLE_PATH");
        assert_eq!(bundle_preview["ok"], true, "{bundle_preview}");
        assert_eq!(bundle_preview["data"]["files"], 2, "{bundle_preview}");
        assert_eq!(bundle_preview["data"]["referenced"], 2, "{bundle_preview}");
        assert_eq!(bundle_preview["data"]["localizable"], 1, "{bundle_preview}");
        assert_eq!(bundle_preview["data"]["toUpload"], 1, "{bundle_preview}");
        assert!(bundle_preview["data"]["issueOverflow"].as_u64().unwrap_or(0) >= 0, "{bundle_preview}");
        assert_eq!(bundle_preview["data"]["issues"].as_array().map(|rows| rows.len()).unwrap_or(0), 1, "{bundle_preview}");
        let bundle_import = super::invoke(&mut gateway, &models, None, "astella.v1.source.bundleImport", &json!({
            "meta": meta,
            "request": { "version": 1, "action": "import", "kind": "folder", "bundlePath": bundle_dir.to_string_lossy() },
        })).await;
        assert_eq!(bundle_import["ok"], true, "{bundle_import}");
        assert_eq!(bundle_import["data"]["uploaded"], 1, "{bundle_import}");
        let tasks = bundle_import["data"]["tasks"].as_array().expect("bundle tasks");
        assert_eq!(tasks.len(), 2, "{bundle_import}");
        let local_task = tasks.iter().find(|task| task["name"].as_str().unwrap_or("").ends_with("note-one.md")).expect("local task");
        assert!(local_task["content"].as_str().unwrap_or("").contains("/api/uploads/"), "{local_task}");
        std::fs::remove_dir_all(&bundle_dir).ok();

        // zip 包：同一管线（内存读包），本地图照旧上传并改写。
        let zip_path = root.join("bundle.zip");
        {
            use std::io::Write;
            let mut writer = zip::ZipWriter::new(std::fs::File::create(&zip_path).unwrap());
            let options: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default();
            writer.start_file("zip-note.md", options).unwrap();
            writer.write_all("# zip 包笔记\n\n![图](./pic.png)\n".as_bytes()).unwrap();
            writer.start_file("pic.png", options).unwrap();
            writer.write_all(
                &base64::engine::general_purpose::STANDARD
                    .decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")
                    .unwrap(),
            ).unwrap();
            writer.finish().unwrap();
        }
        std::env::set_var("ASTELLA_BUNDLE_PATH", zip_path.to_string_lossy().to_string());
        let zip_preview = super::invoke(&mut gateway, &models, None, "astella.v1.source.bundleImport", &json!({
            "meta": meta, "request": { "version": 1, "action": "inspect", "kind": "zip" },
        })).await;
        std::env::remove_var("ASTELLA_BUNDLE_PATH");
        assert_eq!(zip_preview["ok"], true, "{zip_preview}");
        assert_eq!(zip_preview["data"]["files"], 1, "{zip_preview}");
        assert_eq!(zip_preview["data"]["toUpload"], 1, "{zip_preview}");
        let zip_import = super::invoke(&mut gateway, &models, None, "astella.v1.source.bundleImport", &json!({
            "meta": meta,
            "request": { "version": 1, "action": "import", "kind": "zip", "bundlePath": zip_path.to_string_lossy() },
        })).await;
        assert_eq!(zip_import["ok"], true, "{zip_import}");
        assert_eq!(zip_import["data"]["uploaded"], 1, "{zip_import}");
        let zip_tasks = zip_import["data"]["tasks"].as_array().expect("zip tasks");
        assert_eq!(zip_tasks.len(), 1, "{zip_import}");
        assert!(zip_tasks[0]["content"].as_str().unwrap_or("").contains("/api/uploads/"), "{zip_import}");
        std::fs::remove_file(&zip_path).ok();

        // 搜索维护：漂移读数 → 触发重建（Owner）。
        let drift = super::invoke(&mut gateway, &models, None, "astella.v1.search.drift", &json!({ "meta": meta })).await;
        assert_eq!(drift["ok"], true, "{drift}");
        assert!(drift["data"]["hasDrift"].is_boolean(), "{drift}");
        let reindex = super::invoke(&mut gateway, &models, None, "astella.v1.search.reindex", &json!({ "meta": meta })).await;
        assert_eq!(reindex["ok"], true, "{reindex}");

        // 退登：本机会话清空，getState 落回匿名。
        let logged_out = super::invoke(&mut gateway, &models, None, "astella.v1.auth.logout", &json!({
            "meta": meta, "keepQuickLogin": false,
        })).await;
        assert_eq!(logged_out["ok"], true, "{logged_out}");
        assert_eq!(logged_out["data"]["loggedOut"], true, "{logged_out}");
        let after = super::invoke(&mut gateway, &models, None, "astella.v1.auth.getState", &json!({
            "meta": meta,
        })).await;
        assert_eq!(after["ok"], true, "{after}");
        assert_eq!(after["data"]["status"], "anonymous", "{after}");
        std::fs::remove_dir_all(&root).ok();
    }
}

#[cfg(test)]
mod navigation_tests {
    use serde_json::json;

    #[test]
    fn navigation_entries_cover_gate_and_workspace_shapes() {
        let meta = json!({ "requestId": "nav-1", "correlationId": "nav-corr" });
        let gate = super::navigation_entry(&json!({ "kind": "auth.login" }), &meta, "startup", None, 0).expect("gate entry");
        assert_eq!(gate["scope"], "gate");
        assert_eq!(gate["historyKey"], "gate-auth.login");
        assert_eq!(gate["entryKind"], "startup");
        assert_eq!(gate["correlationId"], "nav-corr");

        let blocked = super::navigation_entry(&json!({ "kind": "note.detail", "noteId": "x" }), &meta, "user", None, 0);
        assert_eq!(blocked.expect_err("workspace route without identity").code, "auth_required");

        let workspace = super::navigation_entry(&json!({ "kind": "room.home" }), &meta, "user", Some(("subject", "ws-1")), 3)
            .expect("workspace entry");
        assert_eq!(workspace["scope"], "workspace");
        assert_eq!(workspace["level"], "L0");
        assert_eq!(workspace["workspaceId"], "ws-1");
        assert_eq!(workspace["workspaceEpoch"], 3);
        assert_eq!(workspace["navigationOrigin"], "user");

        let unknown = super::navigation_entry(&json!({ "kind": "legacy.tab" }), &meta, "user", Some(("subject", "ws-1")), 3);
        assert_eq!(unknown.expect_err("route outside the contract").code, "route_not_available");

        let bad_kind = super::navigation_entry(&json!({ "kind": "auth.login" }), &meta, "teleport", None, 0);
        assert_eq!(bad_kind.expect_err("unknown entry kind").code, "validation");
    }

    #[test]
    fn navigation_snapshot_reports_back_targets() {
        let state = super::NavigationState {
            entries: vec![json!({ "version": 1, "scope": "gate" }), json!({ "version": 1, "scope": "workspace" })],
            revision: 4,
        };
        let snapshot = super::navigation_snapshot(&state);
        assert_eq!(snapshot["version"], 1);
        assert_eq!(snapshot["current"]["scope"], "workspace");
        assert_eq!(snapshot["stackRevision"], 4);
        assert_eq!(snapshot["canBack"], true);
    }
}
