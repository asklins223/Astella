use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use futures_util::StreamExt;
use serde_json::{json, Value};
use tokio::sync::watch;

/**
 * 伴星聊天的 SSE 下行（Electron companionBridge 的同一条线）：
 * `GET /companion/conversations/:id/events?after=<seq>` 拉 `event: companion` 帧，
 * 把服务端行投影成渲染层认识的 `companion_chat_event`，按订阅排队等 shim 轮询取走。
 *
 * 断流不自动重连：渲染层本来就有兜底轮询，重连留给下一轮（重新订阅时带新 cursor）。
 */
pub struct ChatStreamSession {
    events: Arc<Mutex<Vec<Value>>>,
    closed: Arc<AtomicBool>,
    shutdown: Arc<watch::Sender<bool>>,
}

static STREAMS: OnceLock<Mutex<HashMap<String, Arc<ChatStreamSession>>>> = OnceLock::new();

fn streams() -> &'static Mutex<HashMap<String, Arc<ChatStreamSession>>> {
    STREAMS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn subscription_id(conversation_id: &str) -> String {
    format!("companion-chat:{conversation_id}")
}

fn push_frame(buffer: &mut String, conversation_id: &str, events: &Arc<Mutex<Vec<Value>>>) {
    while let Some(position) = buffer.find("\n\n") {
        let frame: String = buffer.drain(..position + 2).collect();
        for line in frame.lines() {
            let Some(data) = line.strip_prefix("data: ") else { continue };
            let Ok(payload) = serde_json::from_str::<Value>(data) else { continue };
            let event = json!({
                "version": 1,
                "data": {
                    "kind": "companion_chat_event",
                    "conversationId": conversation_id,
                    "event": {
                        "seq": payload.get("seq").cloned().unwrap_or(json!(0)),
                        "runId": payload.get("runId").cloned().unwrap_or(Value::Null),
                        "generation": payload.get("generation").cloned().unwrap_or(json!(0)),
                        "eventType": payload.get("type").cloned().unwrap_or(Value::Null),
                        "payload": payload.get("payload").cloned().unwrap_or(json!({})),
                    },
                },
            });
            if let Ok(mut queue) = events.lock() {
                if queue.len() < 512 {
                    queue.push(event);
                }
            }
        }
    }
}

pub fn open(
    api_origin: &str,
    token: &str,
    conversation_id: &str,
    after: u64,
    voice_output: bool,
) -> Result<String, String> {
    let url = format!(
        "{api_origin}/companion/conversations/{conversation_id}/events?after={after}&voiceOutput={}",
        if voice_output { 1 } else { 0 }
    );
    let client = reqwest::Client::builder().build().map_err(|error| error.to_string())?;
    let events: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
    let closed = Arc::new(AtomicBool::new(false));
    let (shutdown_tx, mut shutdown_rx) = watch::channel(false);
    let id = subscription_id(conversation_id);
    streams().lock().map_err(|_| "chat_stream_poisoned".to_string())?.insert(
        id.clone(),
        Arc::new(ChatStreamSession {
            events: Arc::clone(&events),
            closed: Arc::clone(&closed),
            shutdown: Arc::new(shutdown_tx),
        }),
    );

    let bearer = token.to_string();
    let conversation = conversation_id.to_string();
    let events_writer = Arc::clone(&events);
    let closed_writer = Arc::clone(&closed);
    tauri::async_runtime::spawn(async move {
        let response = client
            .get(&url)
            .header("Accept", "text/event-stream")
            .bearer_auth(&bearer)
            .send()
            .await;
        let Ok(response) = response else {
            closed_writer.store(true, Ordering::Relaxed);
            return;
        };
        if !response.status().is_success() {
            closed_writer.store(true, Ordering::Relaxed);
            return;
        }
        let mut stream = response.bytes_stream();
        let mut buffer = String::new();
        loop {
            tokio::select! {
                chunk = stream.next() => match chunk {
                    Some(Ok(bytes)) => {
                        buffer.push_str(&String::from_utf8_lossy(&bytes));
                        push_frame(&mut buffer, &conversation, &events_writer);
                    }
                    _ => break,
                },
                _ = shutdown_rx.changed() => break,
            }
        }
        closed_writer.store(true, Ordering::Relaxed);
    });
    Ok(id)
}

/// 取走已到达的帧；未知订阅返回 None。第二个返回值表示流是否已结束。
pub fn drain(subscription_id: &str) -> Option<(Vec<Value>, bool)> {
    let session = streams().lock().ok()?.get(subscription_id).map(Arc::clone)?;
    let events = session.events.lock().map(|mut queue| queue.drain(..).collect()).unwrap_or_default();
    Some((events, session.closed.load(Ordering::Relaxed)))
}

pub fn close(subscription_id: &str) {
    if let Some(session) = streams().lock().ok().and_then(|mut map| map.remove(subscription_id)) {
        let _ = session.shutdown.send(true);
    }
}

/// 退登/换空间：所有聊天流一起断。
pub fn close_all() {
    let drained: Vec<Arc<ChatStreamSession>> = streams()
        .lock()
        .map(|mut map| map.drain().map(|(_, session)| session).collect())
        .unwrap_or_default();
    for session in drained {
        let _ = session.shutdown.send(true);
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn frame_projection_maps_server_fields() {
        let events = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let mut buffer = String::from(
            "id: conv:7\nevent: companion\ndata: {\"version\":1,\"seq\":7,\"runId\":\"r-1\",\"generation\":2,\"type\":\"assistant.delta\",\"payload\":{\"text\":\"hi\"}}\n\n",
        );
        super::push_frame(&mut buffer, "conv", &events);
        let queue = events.lock().unwrap();
        assert_eq!(queue.len(), 1);
        let event = &queue[0]["data"]["event"];
        assert_eq!(event["seq"], 7);
        assert_eq!(event["runId"], "r-1");
        assert_eq!(event["eventType"], "assistant.delta");
        assert_eq!(event["payload"]["text"], "hi");
        assert_eq!(queue[0]["data"]["kind"], "companion_chat_event");
    }
}
