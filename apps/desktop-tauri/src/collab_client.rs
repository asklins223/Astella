use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use yrs::updates::decoder::Decode;
use yrs::updates::encoder::Encode;
use yrs::{Doc, Map, StateVector, Transact};

use crate::collab;

/**
 * hocuspocus 同步客户端（2026-11-18，Yjs 路线=Rust 兼容 CRDT）。
 *
 * 线格式（与 `@hocuspocus/provider` 一致，全部 lib0 编码）：
 *   每帧 = varString(documentName) + varUint(messageType) + payload
 *   Auth(2)：varUint(0=Token) + varString(token) + varString(providerVersion)
 *   Sync(0)：varUint(syncType) + varUint8Array(update|stateVector)
 *            syncType：0=step1(SV)、1=step2(update)、2=update
 *
 * 本文档只做「一条连接服务一篇笔记」的最小闭环：鉴权 → step1/step2 互换 →
 * 收发 update。在场（awareness）与草稿属于下一层。
 */
pub const NOTE_DOC_PATH: &str = "/note-doc";
pub const NOTE_DOC_PREFIX: &str = "note:";

const MSG_SYNC: u32 = 0;
const MSG_AWARENESS: u32 = 1;
const MSG_AUTH: u32 = 2;
const MSG_QUERY_AWARENESS: u32 = 3;
const SYNC_STEP1: u32 = 0;
const SYNC_STEP2: u32 = 1;
const SYNC_UPDATE: u32 = 2;
const AUTH_TOKEN: u32 = 0;
const AUTH_DENIED: u32 = 1;
const AUTH_OK: u32 = 2;

fn write_varuint(out: &mut Vec<u8>, mut value: u64) {
    loop {
        let byte = (value & 0x7f) as u8;
        value >>= 7;
        if value == 0 {
            out.push(byte);
            return;
        }
        out.push(byte | 0x80);
    }
}

fn read_varuint(bytes: &[u8], cursor: &mut usize) -> Option<u64> {
    let mut value: u64 = 0;
    let mut shift = 0;
    loop {
        let byte = *bytes.get(*cursor)?;
        *cursor += 1;
        value |= ((byte & 0x7f) as u64) << shift;
        if byte & 0x80 == 0 {
            return Some(value);
        }
        shift += 7;
        if shift > 63 {
            return None;
        }
    }
}

fn write_var_bytes(out: &mut Vec<u8>, bytes: &[u8]) {
    write_varuint(out, bytes.len() as u64);
    out.extend_from_slice(bytes);
}

fn read_var_bytes<'a>(bytes: &'a [u8], cursor: &mut usize) -> Option<&'a [u8]> {
    let length = read_varuint(bytes, cursor)? as usize;
    let slice = bytes.get(*cursor..(*cursor).checked_add(length)?)?;
    *cursor += length;
    Some(slice)
}

fn write_var_string(out: &mut Vec<u8>, value: &str) {
    write_var_bytes(out, value.as_bytes());
}

fn read_var_string(bytes: &[u8], cursor: &mut usize) -> Option<String> {
    String::from_utf8(read_var_bytes(bytes, cursor)?.to_vec()).ok()
}

/// 一帧的公共头：文档名 + 消息类型。
fn frame(document_name: &str, message_type: u32) -> Vec<u8> {
    let mut out = Vec::new();
    write_var_string(&mut out, document_name);
    write_varuint(&mut out, message_type as u64);
    out
}

pub fn authentication_frame(document_name: &str, token: &str) -> Vec<u8> {
    let mut out = frame(document_name, MSG_AUTH);
    write_varuint(&mut out, AUTH_TOKEN as u64);
    write_var_string(&mut out, token);
    write_var_string(&mut out, "tauri-shell-0.1");
    out
}

pub fn sync_step1_frame(document_name: &str, state_vector: &[u8]) -> Vec<u8> {
    let mut out = frame(document_name, MSG_SYNC);
    write_varuint(&mut out, SYNC_STEP1 as u64);
    write_var_bytes(&mut out, state_vector);
    out
}

pub fn sync_step2_frame(document_name: &str, update: &[u8]) -> Vec<u8> {
    let mut out = frame(document_name, MSG_SYNC);
    write_varuint(&mut out, SYNC_STEP2 as u64);
    write_var_bytes(&mut out, update);
    out
}

pub fn update_frame(document_name: &str, update: &[u8]) -> Vec<u8> {
    let mut out = frame(document_name, MSG_SYNC);
    write_varuint(&mut out, SYNC_UPDATE as u64);
    write_var_bytes(&mut out, update);
    out
}

/// y-protocols/awareness 的负载：`varUint(人数)` + 每人 `varUint(clientId) varUint(clock) varString(json)`。
pub fn encode_awareness(states: &[(u64, u64, String)]) -> Vec<u8> {
    let mut out = Vec::new();
    write_varuint(&mut out, states.len() as u64);
    for (client_id, clock, state) in states {
        write_varuint(&mut out, *client_id);
        write_varuint(&mut out, *clock);
        write_var_string(&mut out, state);
    }
    out
}

pub fn decode_awareness(bytes: &[u8]) -> Vec<(u64, u64, String)> {
    let mut cursor = 0usize;
    let Some(count) = read_varuint(bytes, &mut cursor) else { return Vec::new() };
    let mut states = Vec::new();
    for _ in 0..count.min(64) {
        let (Some(client_id), Some(clock), Some(state)) = (
            read_varuint(bytes, &mut cursor),
            read_varuint(bytes, &mut cursor),
            read_var_string(bytes, &mut cursor),
        ) else { break };
        if serde_json::from_str::<serde_json::Value>(&state).is_ok() {
            states.push((client_id, clock, state));
        }
    }
    states
}

pub fn awareness_frame(document_name: &str, states: &[(u64, u64, String)]) -> Vec<u8> {
    let mut out = frame(document_name, MSG_AWARENESS);
    write_var_bytes(&mut out, &encode_awareness(states));
    out
}

/// 向服务端要一次全量在场状态（Hocuspocus `QueryAwareness`：地址 + 类型 3，无负载）。
/// 服务端以一条 Awareness 帧回全部已知状态；新加入的连接靠它回填别人的在场。
pub fn query_awareness_frame(document_name: &str) -> Vec<u8> {
    frame(document_name, MSG_QUERY_AWARENESS)
}

/// 把服务端给的在场状态转成发给渲染层的事件；剔除自己，空列表不出事件。
fn presence_event(client_id: u64, states: &[(u64, u64, String)]) -> Option<serde_json::Value> {
    let remote: Vec<serde_json::Value> = states
        .iter()
        .filter(|(id, _, _)| *id != client_id)
        .map(|(id, _, state)| serde_json::json!({
            "clientId": *id,
            "state": serde_json::from_str::<serde_json::Value>(state).unwrap_or_else(|_| serde_json::json!({})),
        }))
        .collect();
    if remote.is_empty() {
        return None;
    }
    Some(serde_json::json!({ "type": "presence", "states": remote }))
}

fn queue_presence(queue: &Arc<Mutex<Vec<serde_json::Value>>>, event: Option<serde_json::Value>) {
    if let (Some(event), Ok(mut queue)) = (event, queue.lock()) {
        if queue.len() < 256 {
            queue.push(event);
        }
    }
}

#[derive(Debug, PartialEq)]
pub enum IncomingFrame {
    Authenticated(String),
    PermissionDenied(String),
    /// 对端声明它缺什么：回 step2（本机补差）。
    SyncStep1(Vec<u8>),
    /// 对端把增量送来了。
    Update(Vec<u8>),
    /// 在场状态：`(clientId, clock, stateJson)` 列表（已剔除非 JSON 的条目）。
    Awareness(Vec<(u64, u64, String)>),
    Other(u32),
}

pub fn parse_frame(bytes: &[u8]) -> Option<(String, IncomingFrame)> {
    let mut cursor = 0usize;
    let document_name = read_var_string(bytes, &mut cursor)?;
    let message_type = read_varuint(bytes, &mut cursor)? as u32;
    let incoming = match message_type {
        MSG_AUTH => {
            let auth_type = read_varuint(bytes, &mut cursor)? as u32;
            match auth_type {
                AUTH_OK => IncomingFrame::Authenticated(read_var_string(bytes, &mut cursor)?),
                AUTH_DENIED => IncomingFrame::PermissionDenied(read_var_string(bytes, &mut cursor)?),
                AUTH_TOKEN => IncomingFrame::Other(message_type),
                _ => IncomingFrame::Other(message_type),
            }
        }
        MSG_SYNC => {
            let sync_type = read_varuint(bytes, &mut cursor)? as u32;
            match sync_type {
                SYNC_STEP1 => IncomingFrame::SyncStep1(read_var_bytes(bytes, &mut cursor)?.to_vec()),
                SYNC_STEP2 | SYNC_UPDATE => IncomingFrame::Update(read_var_bytes(bytes, &mut cursor)?.to_vec()),
                _ => IncomingFrame::Other(message_type),
            }
        }
        MSG_AWARENESS => {
            let payload = read_var_bytes(bytes, &mut cursor)?;
            IncomingFrame::Awareness(decode_awareness(payload))
        }
        other => IncomingFrame::Other(other),
    };
    Some((document_name, incoming))
}

/// 一条连接同步一篇笔记。`run` 返回时连接已关闭。
pub struct NoteDocSession {
    pub document_name: String,
    pub doc: Doc,
}

impl NoteDocSession {
    pub fn new(note_id: &str) -> Self {
        Self { document_name: format!("{NOTE_DOC_PREFIX}{note_id}"), doc: collab::new_doc() }
    }

    pub fn local_update(&self) -> Vec<u8> {
        collab::encode_update(&self.doc)
    }
}

pub fn ws_url(api_origin: &str) -> Option<String> {
    let url = reqwest::Url::parse(api_origin).ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    let scheme = if url.scheme() == "https" { "wss" } else { "ws" };
    let host = url.host_str()?;
    match url.port() {
        Some(port) => Some(format!("{scheme}://{host}:{port}{NOTE_DOC_PATH}")),
        None => Some(format!("{scheme}://{host}{NOTE_DOC_PATH}")),
    }
}

/// 打开一条笔记的同步连接（未鉴权；调用方先发 `authentication_frame`）。
pub async fn connect(
    api_origin: &str,
) -> Result<tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>, String> {
    let url = ws_url(api_origin).ok_or_else(|| "note_doc_origin_invalid".to_string())?;
    let (stream, _response) = connect_async(url).await.map_err(|error| format!("note_doc_connect_failed: {error}"))?;
    Ok(stream)
}

/// 发一帧（二进制）。
pub async fn send(
    stream: &mut tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    frame: Vec<u8>,
) -> Result<(), String> {
    stream.send(WsMessage::Binary(frame)).await.map_err(|error| format!("note_doc_send_failed: {error}"))
}

/// 收一帧并解析；忽略非二进制帧与无关文档。
pub async fn receive(
    stream: &mut tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    document_name: &str,
) -> Result<IncomingFrame, String> {
    receive_from(stream, document_name).await
}

/// 任意可拆分的可读半边（读线程用）。
pub async fn receive_from<S>(stream: &mut S, document_name: &str) -> Result<IncomingFrame, String>
where
    S: futures_util::Stream<Item = Result<WsMessage, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    loop {
        let message = stream.next().await.ok_or_else(|| "note_doc_closed".to_string())?
            .map_err(|error| format!("note_doc_receive_failed: {error}"))?;
        match message {
            WsMessage::Binary(bytes) => {
                if let Some((name, incoming)) = parse_frame(&bytes) {
                    if name == document_name {
                        return Ok(incoming);
                    }
                }
            }
            WsMessage::Close(_) => return Err("note_doc_closed".to_string()),
            _ => continue,
        }
    }
}

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

/// 一条活着的协同会话：文档 + 上行通道。读线程在后台把远端增量并进文档。
pub struct LiveSession {
    pub doc: Arc<Mutex<Doc>>,
    document_name: String,
    sender: tokio::sync::mpsc::UnboundedSender<Vec<u8>>,
    pending_remote: Arc<Mutex<Vec<String>>>,
    pending_presence: Arc<Mutex<Vec<serde_json::Value>>>,
    /// 读线程退出即置 false；`is_alive` 据此触发重连（发送端未必同步关闭）。
    alive: Arc<std::sync::atomic::AtomicBool>,
    /// 主动关闭（退登/换空间/重连替换）：两个后台任务都监听它，断得干净。
    shutdown: Arc<tokio::sync::watch::Sender<bool>>,
    /// 服务端给的授权档位：只读成员照样能实时看到别人的编辑，但写入一律拒绝。
    read_only: bool,
    client_id: u64,
    presence_clock: std::sync::atomic::AtomicU64,
}

static SESSIONS: OnceLock<tokio::sync::Mutex<HashMap<String, Arc<LiveSession>>>> = OnceLock::new();

fn sessions() -> &'static tokio::sync::Mutex<HashMap<String, Arc<LiveSession>>> {
    SESSIONS.get_or_init(|| tokio::sync::Mutex::new(HashMap::new()))
}

/// 打开（或复用）一篇笔记的活会话：鉴权 → step1/step2 → 后台读循环。
pub async fn open_live_session(
    api_origin: &str,
    note_id: &str,
    token: &str,
) -> Result<Arc<LiveSession>, String> {
    let mut registry = sessions().lock().await;
    if let Some(existing) = registry.get(note_id) {
        if existing.is_alive() {
            return Ok(Arc::clone(existing));
        }
        registry.remove(note_id);
    }
    let session = NoteDocSession::new(note_id);
    let mut stream = connect(api_origin).await?;
    send(&mut stream, authentication_frame(&session.document_name, token)).await?;

    // 等到服务端确认鉴权并完成首次同步：Authenticated 后发 step1；收到第一条 Sync
    // （step2/update）即视为起点就绪。在场状态可能先于 update 到达，一并收进队列。
    let mut doc = session.doc;
    let mut read_only = false;
    let client_id = doc.client_id();
    let pending_presence: Arc<Mutex<Vec<serde_json::Value>>> = Arc::new(Mutex::new(Vec::new()));
    let ready = tokio::time::timeout(std::time::Duration::from_secs(15), async {
        loop {
            let frame = receive(&mut stream, &session.document_name).await?;
            match frame {
                IncomingFrame::Authenticated(scope) => {
                    read_only = scope == "readonly";
                    let sv = collab::state_vector(&doc);
                    send(&mut stream, sync_step1_frame(&session.document_name, &sv)).await?;
                    // 建连时服务端只推它当时已有的状态；补一次全量查询以免错过。
                    send(&mut stream, query_awareness_frame(&session.document_name)).await?;
                }
                IncomingFrame::PermissionDenied(_) => return Err("permission_denied".to_string()),
                IncomingFrame::SyncStep1(remote_sv) => {
                    let missing = collab::diff_update(&doc, &remote_sv)?;
                    send(&mut stream, sync_step2_frame(&session.document_name, &missing)).await?;
                }
                IncomingFrame::Update(update) => {
                    collab::apply_update(&mut doc, &update)?;
                    break;
                }
                IncomingFrame::Awareness(states) => {
                    queue_presence(&pending_presence, presence_event(client_id, &states));
                }
                _ => {}
            }
        }
        Ok::<Doc, String>(doc)
    })
    .await
    .map_err(|_| "note_doc_sync_timeout".to_string())??;

    let doc = Arc::new(Mutex::new(ready));
    let (sender, receiver) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
    let document_name = session.document_name.clone();
    let (sink, reader) = futures_util::StreamExt::split(stream);
    let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
    let shutdown = Arc::new(shutdown_tx);
    spawn_frame_pump(sink, receiver, shutdown_rx.clone());
    let pending_remote: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let alive = Arc::new(std::sync::atomic::AtomicBool::new(true));
    spawn_live_reader(
        reader,
        document_name.clone(),
        Arc::clone(&doc),
        Arc::clone(&pending_remote),
        Arc::clone(&pending_presence),
        Arc::clone(&alive),
        shutdown_rx,
        client_id,
        sender.clone(),
    );

    let live = Arc::new(LiveSession {
        doc,
        document_name: session.document_name.clone(),
        sender,
        pending_remote,
        pending_presence,
        read_only,
        client_id,
        presence_clock: std::sync::atomic::AtomicU64::new(0),
        alive,
        shutdown,
    });
    registry.insert(note_id.to_string(), Arc::clone(&live));
    Ok(live)
}

/// 通道里是**完整帧**：上行 update 与读线程的 step2 应答共用这一条出口。
fn spawn_frame_pump(
    mut sink: futures_util::stream::SplitSink<
        tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
        WsMessage,
    >,
    mut receiver: tokio::sync::mpsc::UnboundedReceiver<Vec<u8>>,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
) {
    tokio::spawn(async move {
        loop {
            if *shutdown.borrow() {
                break;
            }
            tokio::select! {
                frame = receiver.recv() => match frame {
                    Some(frame) => {
                        if sink.send(WsMessage::Binary(frame)).await.is_err() {
                            break;
                        }
                    }
                    None => break,
                },
                _ = shutdown.changed() => {}
            }
        }
        // 主动关闭时补一个 Close 帧，读端随之退出；两个半连接都放下后套接字才真正关。
        let _ = sink.close().await;
    });
}

fn spawn_live_reader<S>(
    mut reader: S,
    document_name: String,
    doc: Arc<Mutex<Doc>>,
    pending_remote: Arc<Mutex<Vec<String>>>,
    pending_presence: Arc<Mutex<Vec<serde_json::Value>>>,
    alive: Arc<std::sync::atomic::AtomicBool>,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
    client_id: u64,
    reply: tokio::sync::mpsc::UnboundedSender<Vec<u8>>,
) where
    S: futures_util::Stream<Item = Result<WsMessage, tokio_tungstenite::tungstenite::Error>> + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        loop {
            if *shutdown.borrow() {
                break;
            }
            let incoming = tokio::select! {
                frame = receive_from(&mut reader, &document_name) => frame,
                _ = shutdown.changed() => break,
            };
            match incoming {
                Ok(IncomingFrame::Update(update)) => {
                    if let Ok(mut guard) = doc.lock() {
                        let _ = collab::apply_update(&mut guard, &update);
                    }
                    use base64::Engine;
                    if let Ok(mut queue) = pending_remote.lock() {
                        if queue.len() < 256 {
                            queue.push(base64::engine::general_purpose::STANDARD.encode(&update));
                        }
                    }
                }
                Ok(IncomingFrame::SyncStep1(remote_sv)) => {
                    if let Ok(guard) = doc.lock() {
                        if let Ok(missing) = collab::diff_update(&guard, &remote_sv) {
                            let frame = sync_step2_frame(&document_name, &missing);
                            if reply.send(frame).is_err() {
                                break;
                            }
                        }
                    }
                }
                Ok(IncomingFrame::Awareness(states)) => {
                    queue_presence(&pending_presence, presence_event(client_id, &states));
                }
                Ok(_) => {}
                Err(_) => break,
            }
        }
        alive.store(false, std::sync::atomic::Ordering::Relaxed);
    });
}

/// 拿一篇笔记的活会话：活着就复用；断了就在**同一份本机文档**上重连，
/// 重连握手会把离线期间的本地增量补上行、把远端增量并进来。
pub async fn ensure_live_session(
    api_origin: &str,
    note_id: &str,
    token: &str,
) -> Result<Arc<LiveSession>, String> {
    let existing = {
        let registry = sessions().lock().await;
        registry.get(note_id).map(Arc::clone)
    };
    match existing {
        Some(session) if session.is_alive() => Ok(session),
        Some(dead) => reconnect_live_session(note_id, dead, api_origin, token).await,
        None => open_live_session(api_origin, note_id, token).await,
    }
}

async fn reconnect_live_session(
    note_id: &str,
    existing: Arc<LiveSession>,
    api_origin: &str,
    token: &str,
) -> Result<Arc<LiveSession>, String> {
    let document_name = existing.document_name.clone();
    let doc = Arc::clone(&existing.doc);
    let pending_remote = Arc::clone(&existing.pending_remote);
    let pending_presence = Arc::clone(&existing.pending_presence);
    let client_id = existing.client_id;
    let presence_tick = existing.presence_clock.load(std::sync::atomic::Ordering::Relaxed);
    let mut read_only = existing.read_only;
    existing.alive.store(false, std::sync::atomic::Ordering::Relaxed);
    let _ = existing.shutdown.send(true);

    let mut stream = connect(api_origin).await?;
    send(&mut stream, authentication_frame(&document_name, token)).await?;
    tokio::time::timeout(std::time::Duration::from_secs(15), async {
        loop {
            match receive(&mut stream, &document_name).await? {
                IncomingFrame::Authenticated(scope) => {
                    read_only = scope == "readonly";
                    let sv = {
                        let guard = doc.lock().map_err(|_| "note_doc_poisoned".to_string())?;
                        collab::state_vector(&guard)
                    };
                    send(&mut stream, sync_step1_frame(&document_name, &sv)).await?;
                    send(&mut stream, query_awareness_frame(&document_name)).await?;
                }
                IncomingFrame::PermissionDenied(_) => return Err("permission_denied".to_string()),
                IncomingFrame::SyncStep1(remote_sv) => {
                    let missing = {
                        let guard = doc.lock().map_err(|_| "note_doc_poisoned".to_string())?;
                        collab::diff_update(&guard, &remote_sv)?
                    };
                    send(&mut stream, sync_step2_frame(&document_name, &missing)).await?;
                }
                IncomingFrame::Update(update) => {
                    {
                        let mut guard = doc.lock().map_err(|_| "note_doc_poisoned".to_string())?;
                        collab::apply_update(&mut guard, &update)?;
                    }
                    break;
                }
                IncomingFrame::Awareness(states) => {
                    queue_presence(&pending_presence, presence_event(client_id, &states));
                }
                _ => {}
            }
        }
        Ok::<(), String>(())
    })
    .await
    .map_err(|_| "note_doc_sync_timeout".to_string())??;

    let (sender, receiver) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
    let (sink, reader) = futures_util::StreamExt::split(stream);
    let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
    let shutdown = Arc::new(shutdown_tx);
    spawn_frame_pump(sink, receiver, shutdown_rx.clone());
    let alive = Arc::new(std::sync::atomic::AtomicBool::new(true));
    spawn_live_reader(
        reader,
        document_name.clone(),
        Arc::clone(&doc),
        Arc::clone(&pending_remote),
        Arc::clone(&pending_presence),
        Arc::clone(&alive),
        shutdown_rx,
        client_id,
        sender.clone(),
    );

    let live = Arc::new(LiveSession {
        doc,
        document_name,
        sender,
        pending_remote,
        pending_presence,
        read_only,
        client_id,
        presence_clock: std::sync::atomic::AtomicU64::new(presence_tick),
        alive,
        shutdown,
    });
    sessions().lock().await.insert(note_id.to_string(), Arc::clone(&live));
    Ok(live)
}

impl LiveSession {
    /// 把界面交来的增量并进本机文档，并转发给服务端。
    pub fn apply_and_forward(&self, update_base64: &str) -> Result<(), String> {
        if self.read_only {
            return Err("forbidden".to_string());
        }
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(update_base64)
            .map_err(|_| "invalid_update".to_string())?;
        {
            let mut guard = self.doc.lock().map_err(|_| "note_doc_poisoned".to_string())?;
            collab::apply_update(&mut guard, &bytes)?;
        }
        let frame = update_frame(&self.document_name, &bytes);
        self.sender.send(frame).map_err(|_| "connection_lost".to_string())
    }

    /// 取走尚未交给渲染层的远端增量（base64，按到达顺序）。
    pub fn drain_remote(&self) -> Vec<String> {
        self.pending_remote.lock().map(|mut queue| queue.drain(..).collect()).unwrap_or_default()
    }

    /// 取走尚未交给渲染层的在场事件。
    pub fn drain_presence(&self) -> Vec<serde_json::Value> {
        self.pending_presence.lock().map(|mut queue| queue.drain(..).collect()).unwrap_or_default()
    }

    /// 上报本机在场状态（读/写档位与光标块，JSON 字符串由渲染层给）。
    pub fn report_presence(&self, state: &str) -> Result<(), String> {
        if serde_json::from_str::<serde_json::Value>(state).is_err() {
            return Err("invalid_presence_state".to_string());
        }
        let clock = self.presence_clock.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
        let states = vec![(self.client_id, clock, state.to_string())];
        let frame = awareness_frame(&self.document_name, &states);
        self.sender.send(frame).map_err(|_| "connection_lost".to_string())
    }

    pub fn is_read_only(&self) -> bool {
        self.read_only
    }

    /// 会话是否仍然可用（读线程活着且发送通道未关）。
    pub fn is_alive(&self) -> bool {
        self.alive.load(std::sync::atomic::Ordering::Relaxed) && !self.sender.is_closed()
    }

    pub fn current_update_base64(&self) -> String {
        use base64::Engine;
        let guard = self.doc.lock().expect("doc lock");
        base64::engine::general_purpose::STANDARD.encode(collab::encode_update(&guard))
    }

    /// 只改标题：往 `meta` 里合并 title/titleSource，走同一条增量上行。
    pub fn set_title(&self, title: &str, title_source: &str) -> Result<(), String> {
        if self.read_only {
            return Err("forbidden".to_string());
        }
        use base64::Engine;
        let bytes = {
            let mut guard = self.doc.lock().map_err(|_| "note_doc_poisoned".to_string())?;
            let before = collab::state_vector(&guard);
            {
                use yrs::Transact;
                let meta = guard.get_or_insert_map(collab::META_ROOT);
                let mut txn = guard.transact_mut();
                if meta.get(&txn, "title").map(|value| value.to_string(&txn)) != Some(title.to_string()) {
                    meta.insert(&mut txn, "title", title.to_string());
                }
                if meta.get(&txn, "titleSource").map(|value| value.to_string(&txn)) != Some(title_source.to_string()) {
                    meta.insert(&mut txn, "titleSource", title_source.to_string());
                }
            }
            collab::diff_update(&guard, &before)?
        };
        if bytes.is_empty() {
            return Ok(());
        }
        let frame = update_frame(&self.document_name, &bytes);
        self.sender.send(frame).map_err(|_| "connection_lost".to_string())
    }
}

/// 取一篇笔记现成的活会话（没有就返回 None，不发起连接）。
pub fn live_session_snapshot(note_id: &str) -> Option<Arc<LiveSession>> {
    sessions().try_lock().ok()?.get(note_id).map(Arc::clone)
}

/// 关闭并丢弃一篇笔记的活会话（登出/切换空间时用）。
pub async fn close_live_session(note_id: &str) {
    if let Some(session) = sessions().lock().await.remove(note_id) {
        let _ = session.shutdown.send(true);
    }
}

/// 退登：把全部活会话断开并移出注册表（socket 两半都放下才算真关）。
pub async fn close_all_live_sessions() {
    let drained: Vec<Arc<LiveSession>> = sessions().lock().await.drain().map(|(_, session)| session).collect();
    for session in drained {
        let _ = session.shutdown.send(true);
    }
}

pub fn iso_now() -> String {
    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let days = seconds / 86_400;
    let remainder = seconds % 86_400;
    let (hour, minute, second) = (remainder / 3_600, (remainder % 3_600) / 60, remainder % 60);
    let mut year = 1970i64;
    let mut day = days as i64;
    loop {
        let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
        let length = if leap { 366 } else { 365 };
        if day < length {
            break;
        }
        day -= length;
        year += 1;
    }
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let months = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let mut month = 0usize;
    while month < 12 && day >= months[month] {
        day -= months[month];
        month += 1;
    }
    format!("{year:04}-{:02}-{:02}T{hour:02}:{minute:02}:{second:02}Z", month + 1, day + 1)
}

#[cfg(test)]
mod codec_tests {
    use super::*;

    #[test]
    fn varuint_round_trips() {
        for value in [0u64, 1, 127, 128, 300, 16_384, u32::MAX as u64] {
            let mut out = Vec::new();
            write_varuint(&mut out, value);
            let mut cursor = 0;
            assert_eq!(read_varuint(&out, &mut cursor), Some(value));
            assert_eq!(cursor, out.len());
        }
    }

    #[test]
    fn auth_frame_parses_back() {
        let bytes = authentication_frame("note:abc", "token-1");
        let mut cursor = 0;
        assert_eq!(read_var_string(&bytes, &mut cursor).as_deref(), Some("note:abc"));
        assert_eq!(read_varuint(&bytes, &mut cursor), Some(MSG_AUTH as u64));
        assert_eq!(read_varuint(&bytes, &mut cursor), Some(AUTH_TOKEN as u64));
        assert_eq!(read_var_string(&bytes, &mut cursor).as_deref(), Some("token-1"));
        assert_eq!(read_var_string(&bytes, &mut cursor).as_deref(), Some("tauri-shell-0.1"));
    }

    #[test]
    fn incoming_frames_parse() {
        let mut auth = Vec::new();
        let mut header = frame("note:abc", MSG_AUTH);
        auth.append(&mut header);
        write_varuint(&mut auth, AUTH_OK as u64);
        write_var_string(&mut auth, "read-write");
        assert_eq!(
            parse_frame(&auth),
            Some(("note:abc".to_string(), IncomingFrame::Authenticated("read-write".to_string())))
        );

        let step = sync_step1_frame("note:abc", &[1, 2, 3]);
        assert_eq!(
            parse_frame(&step),
            Some(("note:abc".to_string(), IncomingFrame::SyncStep1(vec![1, 2, 3])))
        );

        let update = update_frame("note:abc", &[9, 9]);
        assert_eq!(
            parse_frame(&update),
            Some(("note:abc".to_string(), IncomingFrame::Update(vec![9, 9])))
        );
    }

    #[test]
    fn awareness_round_trips() {
        let states = vec![(7u64, 3u64, "{\"mode\":\"writing\",\"block\":2}".to_string())];
        let bytes = encode_awareness(&states);
        assert_eq!(decode_awareness(&bytes), states);
        let frame = awareness_frame("note:abc", &states);
        assert_eq!(
            parse_frame(&frame),
            Some(("note:abc".to_string(), IncomingFrame::Awareness(states)))
        );
    }

    #[test]
    fn query_awareness_frame_has_no_payload() {
        let bytes = query_awareness_frame("note:abc");
        let mut cursor = 0;
        assert_eq!(read_var_string(&bytes, &mut cursor).as_deref(), Some("note:abc"));
        assert_eq!(read_varuint(&bytes, &mut cursor), Some(MSG_QUERY_AWARENESS as u64));
        assert_eq!(cursor, bytes.len());
    }

    #[test]
    fn presence_event_filters_own_client() {
        let states = vec![
            (1u64, 1u64, "{\"mode\":\"writing\"}".to_string()),
            (2u64, 3u64, "{\"mode\":\"reading\"}".to_string()),
        ];
        let event = presence_event(1, &states).expect("event");
        let remote = event["states"].as_array().expect("states");
        assert_eq!(remote.len(), 1);
        assert_eq!(remote[0]["clientId"], 2);
        assert_eq!(remote[0]["state"]["mode"], "reading");
        assert!(presence_event(1, &states[..1]).is_none());
    }

    #[test]
    fn ws_url_switches_scheme_and_port() {
        assert_eq!(ws_url("http://127.0.0.1:4000").as_deref(), Some("ws://127.0.0.1:4000/note-doc"));
        assert_eq!(ws_url("https://api.example.com").as_deref(), Some("wss://api.example.com/note-doc"));
        assert_eq!(ws_url("ftp://x"), None);
    }
}


/// 真实协同联调（默认忽略）：WS 鉴权 → sync → 写入 → REST 读回。
#[cfg(test)]
mod live_collab_tests {
    use std::time::Duration;

    use serde_json::json;

    use crate::collab;
    use crate::gateway::{FileSessionCredentialStore, Gateway};

    fn scratch() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "astella-collab-live-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[tokio::test]
    #[ignore = "needs the local API stack; creates and deletes one probe note"]
    async fn live_note_doc_sync_round_trip() {
        let email = std::env::var("ASTELLA_LIVE_EMAIL").expect("email");
        let password = std::env::var("ASTELLA_LIVE_PASSWORD").expect("password");
        let env: std::collections::HashMap<String, String> = std::env::vars().collect();
        let config = crate::gateway::config::read_configuration(&env).expect("pairing env");
        let root = scratch();
        let mut gateway = Gateway::new(Ok(config), Some(FileSessionCredentialStore::new(&root)));
        gateway.ensure_connected().await.expect("trust");

        let login = gateway.request_json(
            reqwest::Method::POST,
            "/auth/login",
            Some(json!({ "email": email, "password": password, "remember": false })),
            false,
        ).await.expect("login");
        let token = login.1.get("token").and_then(serde_json::Value::as_str).expect("token").to_string();
        gateway.set_token(Some(token.clone()));

        let created = gateway.request_json(
            reqwest::Method::POST,
            "/notes",
            Some(json!({ "title": "Tauri 协同探针" })),
            true,
        ).await.expect("create note");
        let note_id = created.1.get("note").and_then(|note| note.get("id")).and_then(serde_json::Value::as_str)
            .expect("note id").to_string();
        // WS 传输只服务「已共享给空间」的笔记（服务端 4.5 门控）；探针必须显式共享。
        let shared = gateway.request_json(
            reqwest::Method::PATCH,
            &format!("/v2/notes/{note_id}/share-scope"),
            Some(json!({ "shareScope": "shared" })),
            true,
        ).await.expect("share scope");
        assert_eq!(shared.1.get("shareScope").and_then(serde_json::Value::as_str), Some("shared"));

        let origin = gateway.api_origin();
        let mut session = super::NoteDocSession::new(&note_id);
        let mut stream = super::connect(&origin).await.expect("ws connect");
        super::send(&mut stream, super::authentication_frame(&session.document_name, &token)).await.expect("auth send");

        let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
        let mut saw_sync = false;
        loop {
            assert!(tokio::time::Instant::now() < deadline, "collab sync timed out");
            let frame = tokio::time::timeout(Duration::from_secs(5), super::receive(&mut stream, &session.document_name)).await
                .expect("frame timeout").expect("frame");
            match frame {
                super::IncomingFrame::Authenticated(scope) => {
                    assert_eq!(scope, "read-write");
                    let sv = collab::state_vector(&session.doc);
                    super::send(&mut stream, super::sync_step1_frame(&session.document_name, &sv)).await.expect("step1");
                }
                super::IncomingFrame::PermissionDenied(reason) => panic!("permission denied: {reason}"),
                super::IncomingFrame::SyncStep1(remote_sv) => {
                    let missing = collab::diff_update(&session.doc, &remote_sv).expect("diff");
                    super::send(&mut stream, super::sync_step2_frame(&session.document_name, &missing)).await.expect("step2");
                }
                super::IncomingFrame::Update(update) => {
                    collab::apply_update(&mut session.doc, &update).expect("apply remote");
                    saw_sync = true;
                    break;
                }
                _ => {}
            }
        }
        assert!(saw_sync, "expected at least one sync payload from server");

        // 本机写一段，按 SV 差量上行。
        let before = collab::state_vector(&session.doc);
        collab::seed_paragraph(&mut session.doc, "tauri-collab-probe");
        let local = collab::diff_update(&session.doc, &before).expect("local diff");
        super::send(&mut stream, super::update_frame(&session.document_name, &local)).await.expect("update send");

        // 服务端 snapshot-on-idle 落盘后再读 REST。
        let rest_deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        let mut seen = false;
        while tokio::time::Instant::now() < rest_deadline {
            tokio::time::sleep(Duration::from_millis(500)).await;
            let detail = gateway.request_json(reqwest::Method::GET, &format!("/v2/notes/{note_id}"), None, true).await;
            if let Ok((_status, body)) = detail {
                if body.to_string().contains("tauri-collab-probe") {
                    seen = true;
                    break;
                }
            }
        }
        assert!(seen, "server did not project the collaborative write back into the note");

        let _ = gateway.request_json(reqwest::Method::DELETE, &format!("/notes/{note_id}"), None, true).await;
        let _ = stream.close(None).await;
        std::fs::remove_dir_all(&root).ok();
    }

    /// 两个客户端：A 先入房并上报在场；B 后加入，必须拿到 A 的既有在场（回填）。
    #[tokio::test]
    #[ignore = "needs the local API stack; creates and deletes one probe note"]
    async fn live_awareness_backfill_on_join() {
        let email = std::env::var("ASTELLA_LIVE_EMAIL").expect("email");
        let password = std::env::var("ASTELLA_LIVE_PASSWORD").expect("password");
        let env: std::collections::HashMap<String, String> = std::env::vars().collect();
        let config = crate::gateway::config::read_configuration(&env).expect("pairing env");
        let root = scratch();
        let mut gateway = Gateway::new(Ok(config), Some(FileSessionCredentialStore::new(&root)));
        gateway.ensure_connected().await.expect("trust");
        let login = gateway.request_json(
            reqwest::Method::POST,
            "/auth/login",
            Some(json!({ "email": email, "password": password, "remember": false })),
            false,
        ).await.expect("login");
        let token = login.1.get("token").and_then(serde_json::Value::as_str).expect("token").to_string();
        gateway.set_token(Some(token.clone()));
        let created = gateway.request_json(
            reqwest::Method::POST,
            "/notes",
            Some(json!({ "title": "Tauri 在场回填探针" })),
            true,
        ).await.expect("create note");
        let note_id = created.1.get("note").and_then(|note| note.get("id")).and_then(serde_json::Value::as_str)
            .expect("note id").to_string();
        gateway.request_json(
            reqwest::Method::PATCH,
            &format!("/v2/notes/{note_id}/share-scope"),
            Some(json!({ "shareScope": "shared" })),
            true,
        ).await.expect("share scope");

        let origin = gateway.api_origin();
        let document_name = format!("{}{}", super::NOTE_DOC_PREFIX, note_id);

        // 客户端 A：裸连接完成鉴权，把在场状态报到房间后保持在线。
        let mut peer = super::connect(&origin).await.expect("peer connect");
        super::send(&mut peer, super::authentication_frame(&document_name, &token)).await.expect("peer auth");
        let mut peer_ready = false;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        while !peer_ready {
            assert!(tokio::time::Instant::now() < deadline, "peer never finished the sync handshake");
            let frame = tokio::time::timeout(Duration::from_secs(5), super::receive(&mut peer, &document_name))
                .await.expect("peer frame timeout").expect("peer frame");
            match frame {
                super::IncomingFrame::Authenticated(_) => {
                    let sv = collab::state_vector(&collab::new_doc());
                    super::send(&mut peer, super::sync_step1_frame(&document_name, &sv)).await.expect("peer step1");
                }
                super::IncomingFrame::SyncStep1(remote_sv) => {
                    let empty = collab::new_doc();
                    let missing = collab::diff_update(&empty, &remote_sv).expect("peer diff");
                    super::send(&mut peer, super::sync_step2_frame(&document_name, &missing)).await.expect("peer step2");
                }
                super::IncomingFrame::Update(_) => peer_ready = true,
                super::IncomingFrame::PermissionDenied(reason) => panic!("peer denied: {reason}"),
                _ => {}
            }
        }
        super::send(&mut peer, super::awareness_frame(&document_name, &[(
            77,
            1,
            "{\"mode\":\"reading\",\"block\":7}".to_string(),
        )])).await.expect("peer awareness");

        // 客户端 B：经 open_live_session 入房，既有在场必须回填到队列。
        let session = super::open_live_session(&origin, &note_id, &token).await.expect("live session");
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        let mut backfilled = false;
        while tokio::time::Instant::now() < deadline {
            for event in session.drain_presence() {
                let text = event.to_string();
                if text.contains("\"mode\":\"reading\"") && text.contains("\"clientId\":77") {
                    backfilled = true;
                }
            }
            if backfilled {
                break;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        assert!(backfilled, "joined session never received the existing awareness state");

        super::close_live_session(&note_id).await;
        let _ = peer.close(None).await;
        let _ = gateway.request_json(reqwest::Method::DELETE, &format!("/notes/{note_id}"), None, true).await;
        std::fs::remove_dir_all(&root).ok();
    }

    /// 断线重连：离线期间的本地增量在同一份文档上保留，重连握手补上行。
    #[tokio::test]
    #[ignore = "needs the local API stack; creates and deletes one probe note"]
    async fn live_reconnect_preserves_offline_edits() {
        use std::sync::atomic::{AtomicBool, AtomicU64};
        use std::sync::{Arc, Mutex};

        let email = std::env::var("ASTELLA_LIVE_EMAIL").expect("email");
        let password = std::env::var("ASTELLA_LIVE_PASSWORD").expect("password");
        let env: std::collections::HashMap<String, String> = std::env::vars().collect();
        let config = crate::gateway::config::read_configuration(&env).expect("pairing env");
        let root = scratch();
        let mut gateway = Gateway::new(Ok(config), Some(FileSessionCredentialStore::new(&root)));
        gateway.ensure_connected().await.expect("trust");
        let login = gateway.request_json(
            reqwest::Method::POST,
            "/auth/login",
            Some(json!({ "email": email, "password": password, "remember": false })),
            false,
        ).await.expect("login");
        let token = login.1.get("token").and_then(serde_json::Value::as_str).expect("token").to_string();
        gateway.set_token(Some(token.clone()));
        let created = gateway.request_json(
            reqwest::Method::POST,
            "/notes",
            Some(json!({ "title": "Tauri 重连探针" })),
            true,
        ).await.expect("create note");
        let note_id = created.1.get("note").and_then(|note| note.get("id")).and_then(serde_json::Value::as_str)
            .expect("note id").to_string();
        gateway.request_json(
            reqwest::Method::PATCH,
            &format!("/v2/notes/{note_id}/share-scope"),
            Some(json!({ "shareScope": "shared" })),
            true,
        ).await.expect("share scope");

        let origin = gateway.api_origin();
        let state = gateway.request_json(
            reqwest::Method::GET,
            &format!("/v2/notes/{note_id}/doc-state"),
            None,
            true,
        ).await.expect("doc state").1;
        let mut doc = collab::new_doc();
        if let Some(encoded) = state.get("update").and_then(serde_json::Value::as_str) {
            use base64::Engine;
            let bytes = base64::engine::general_purpose::STANDARD.decode(encoded).expect("b64");
            collab::apply_update(&mut doc, &bytes).expect("apply base");
        }
        // 断线期间的本机编辑（还没上行）。
        collab::seed_paragraph(&mut doc, "offline-reconnect-probe");
        let client_id = doc.client_id();

        let (sender, receiver) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
        drop(receiver);
        let dead = Arc::new(super::LiveSession {
            doc: Arc::new(Mutex::new(doc)),
            document_name: format!("{}{}", super::NOTE_DOC_PREFIX, note_id),
            sender,
            pending_remote: Arc::new(Mutex::new(Vec::new())),
            pending_presence: Arc::new(Mutex::new(Vec::new())),
            read_only: false,
            client_id,
            presence_clock: AtomicU64::new(0),
            alive: Arc::new(AtomicBool::new(false)),
            shutdown: Arc::new(tokio::sync::watch::channel(false).0),
        });

        let live = super::reconnect_live_session(&note_id, dead, &origin, &token).await.expect("reconnect");
        assert!(live.is_alive(), "reconnected session should be alive");
        let mut registered = None;
        for _ in 0..20 {
            registered = super::live_session_snapshot(&note_id).map(|session| session.is_alive());
            if registered == Some(true) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        assert_eq!(registered, Some(true), "reconnected session not registered");

        // 重连握手要把离线段落补到服务端；等 idle 快照后 REST 读回。
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        let mut seen = false;
        while tokio::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(500)).await;
            if let Ok((_status, body)) = gateway.request_json(
                reqwest::Method::GET,
                &format!("/v2/notes/{note_id}"),
                None,
                true,
            ).await {
                if body.to_string().contains("offline-reconnect-probe") {
                    seen = true;
                    break;
                }
            }
        }
        assert!(seen, "reconnect never pushed the offline edit back to the server");

        super::close_live_session(&note_id).await;
        let _ = gateway.request_json(reqwest::Method::DELETE, &format!("/notes/{note_id}"), None, true).await;
        std::fs::remove_dir_all(&root).ok();
    }
}
