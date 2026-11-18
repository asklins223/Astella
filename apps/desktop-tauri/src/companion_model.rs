use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

/**
 * 伴星 Live2D 模型的**本机仓库**（迁移切片 4，Tauri 版）。
 *
 * 与 Electron 版同一条磁盘格式：`<appData>/companion-models/<modelId>/`，
 * `installed.json` 是「整份装好」的唯一凭据，也是 `device/models/` 路由的准入名单
 * （见 `protocol.rs`）。差异只在进程内形态：这里用一个表管进度与后台任务。
 *
 * 下载经已登录会话：先取服务端清单（每个文件带字节数/SHA-256 与下载描述），
 * 逐文件校验后才落正式文件；任何一步失败整份丢弃。**入口只认整份装好**。
 */
pub const MODEL_IDS: &[&str] = &["companion-live2d-whale-v3", "companion-live2d-fatfish-v4"];

#[derive(Clone, Debug, PartialEq)]
pub struct Progress {
    pub status: &'static str,
    pub received: u64,
    pub total: u64,
    pub installed_version: Option<String>,
    pub failure: Option<&'static str>,
}

impl Default for Progress {
    fn default() -> Self {
        Self { status: "absent", received: 0, total: 0, installed_version: None, failure: None }
    }
}

#[derive(Clone)]
pub struct FileSpec {
    pub path: String,
    pub content_type: String,
    pub byte_length: u64,
    pub sha256: String,
    pub url: String,
    pub session: bool,
}

pub struct ModelRegistry {
    root: PathBuf,
    client: reqwest::Client,
    slots: tokio::sync::Mutex<HashMap<String, Slot>>,
}

#[derive(Default)]
struct Slot {
    progress: Progress,
    active: bool,
    received: std::sync::Arc<std::sync::atomic::AtomicU64>,
}

impl ModelRegistry {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            client: reqwest::Client::builder()
                .connect_timeout(std::time::Duration::from_secs(10))
                .timeout(std::time::Duration::from_secs(120))
                .build()
                .expect("model http client"),
            slots: tokio::sync::Mutex::new(HashMap::new()),
        }
    }

    pub fn model_dir(&self, model_id: &str) -> PathBuf {
        self.root.join(model_id)
    }

    /** 启动时清掉装了一半的目录（判据是安装标记本身）。 */
    pub async fn sweep(&self) {
        for model_id in MODEL_IDS {
            let dir = self.model_dir(model_id);
            if read_marker(&dir, model_id).is_none() {
                let _ = fs::remove_dir_all(&dir);
            }
        }
    }

    pub async fn snapshot(&self, model_id: &str) -> Progress {
        let dir = self.model_dir(model_id);
        let mut slots = self.slots.lock().await;
        if let Some(slot) = slots.get(model_id) {
            if slot.active {
                let mut progress = slot.progress.clone();
                progress.received = slot.received.load(std::sync::atomic::Ordering::Relaxed).min(progress.total);
                return progress;
            }
            if slot.progress.status == "failed" && slot.progress.failure.is_some() {
                return slot.progress.clone();
            }
        }
        match read_marker(&dir, model_id) {
            Some(marker) => {
                let bytes = marker
                    .get("files")
                    .and_then(Value::as_array)
                    .map(|files| files.iter().filter_map(|file| file.get("byteLength").and_then(Value::as_u64)).sum())
                    .unwrap_or(0);
                let progress = Progress {
                    status: "ready",
                    received: bytes,
                    total: bytes,
                    installed_version: marker.get("modelVersion").and_then(Value::as_str).map(str::to_string),
                    failure: None,
                };
                slots.insert(model_id.to_string(), Slot { progress: progress.clone(), active: false, received: Default::default() });
                progress
            }
            None => slots
                .get(model_id)
                .filter(|slot| slot.progress.failure.is_some())
                .map(|slot| slot.progress.clone())
                .unwrap_or_default(),
        }
    }

    pub async fn start(self: &std::sync::Arc<Self>, model_id: &str, manifest: &Value, origin: &str, token: Option<String>) -> Progress {
        let files = match parse_manifest(model_id, manifest) {
            Ok(files) => files,
            Err(failure) => return self.fail(model_id, failure).await,
        };
        let total: u64 = files.iter().map(|file| file.byte_length).sum();
        {
            let mut slots = self.slots.lock().await;
            let slot = slots.entry(model_id.to_string()).or_default();
            if slot.active {
                return slot.progress.clone();
            }
            slot.active = true;
            slot.received = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
            slot.progress = Progress { status: "downloading", received: 0, total, installed_version: None, failure: None };
        }
        let dir = self.model_dir(model_id);
        let client = self.client.clone();
        let origin = origin.to_string();
        let model_version = manifest.get("modelVersion").and_then(Value::as_str).unwrap_or("unknown").to_string();
        let files_for_task = files.clone();
        let registry = std::sync::Arc::clone(self);
        let model_id = model_id.to_string();
        let received = {
            let mut slots = self.slots.lock().await;
            slots.get_mut(model_id.as_str()).map(|slot| slot.received.clone()).expect("slot registered")
        };
        tokio::spawn(async move {
            let result = install_model(&client, &dir, &model_version, &origin, token.as_deref(), &files_for_task, &received).await;
            let mut slots = registry.slots.lock().await;
            if let Some(slot) = slots.get_mut(&model_id) {
                slot.active = false;
                match result {
                    Ok(()) => {
                        let bytes = slot.progress.total;
                        slot.progress = Progress { status: "ready", received: bytes, total: bytes, installed_version: Some(model_version), failure: None };
                    }
                    Err(failure) => {
                        slot.progress = Progress { status: "failed", received: 0, total, installed_version: None, failure: Some(failure) };
                    }
                }
            }
        });
        Progress { status: "downloading", received: 0, total, installed_version: None, failure: None }
    }

    async fn fail(&self, model_id: &str, failure: &'static str) -> Progress {
        let mut slots = self.slots.lock().await;
        let slot = slots.entry(model_id.to_string()).or_default();
        slot.progress = Progress { status: "failed", received: 0, total: 0, installed_version: None, failure: Some(failure) };
        slot.progress.clone()
    }

    pub async fn remove(&self, model_id: &str) -> Progress {
        let _ = fs::remove_dir_all(self.model_dir(model_id));
        let mut slots = self.slots.lock().await;
        slots.insert(model_id.to_string(), Slot::default());
        Progress::default()
    }

    pub async fn cancel(&self, model_id: &str) -> Progress {
        // 首个版本不支持中途取消：下载在几秒内完成，取消按钮按“暂不可用”处理。
        self.snapshot(model_id).await
    }
}

fn parse_manifest(model_id: &str, manifest: &Value) -> Result<Vec<FileSpec>, &'static str> {
    if manifest.get("modelId").and_then(Value::as_str) != Some(model_id) {
        return Err("integrity");
    }
    let files = manifest.get("files").and_then(Value::as_array).ok_or("storage")?;
    let mut parsed = Vec::new();
    for file in files {
        let download = file.get("download").ok_or("storage")?;
        let url = download.get("url").and_then(Value::as_str).ok_or("storage")?.to_string();
        let session = download.get("authorization").and_then(Value::as_str) == Some("session");
        if !session && !url.starts_with("https://") && !url.starts_with("http://127.0.0.1") && !url.starts_with("http://localhost") {
            return Err("storage");
        }
        parsed.push(FileSpec {
            path: file.get("path").and_then(Value::as_str).ok_or("integrity")?.to_string(),
            content_type: file.get("contentType").and_then(Value::as_str).unwrap_or("application/octet-stream").to_string(),
            byte_length: file.get("byteLength").and_then(Value::as_u64).ok_or("integrity")?,
            sha256: file.get("sha256").and_then(Value::as_str).ok_or("integrity")?.to_string(),
            url,
            session,
        });
    }
    if parsed.is_empty() {
        return Err("integrity");
    }
    Ok(parsed)
}

async fn install_model(
    client: &reqwest::Client,
    dir: &Path,
    model_version: &str,
    origin: &str,
    token: Option<&str>,
    files: &[FileSpec],
    received: &std::sync::atomic::AtomicU64,
) -> Result<(), &'static str> {
    let _ = fs::remove_dir_all(dir);
    fs::create_dir_all(dir).map_err(|_| "disk")?;
    for file in files {
        let target = dir.join(&file.path);
        if !target.starts_with(dir) {
            return Err("integrity");
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|_| "disk")?;
        }
        let request = if file.session {
            let mut value = client.get(format!("{origin}{}", file.url));
            if let Some(token) = token {
                value = value.bearer_auth(token);
            }
            value
        } else {
            client.get(&file.url)
        };
        let mut response = request.send().await.map_err(|_| "network")?;
        if !response.status().is_success() {
            return Err("network");
        }
        let part = target.with_extension("part");
        let mut handle = fs::File::create(&part).map_err(|_| "disk")?;
        let mut hash = Sha256::new();
        let mut written: u64 = 0;
        while let Some(chunk) = response.chunk().await.map_err(|_| "network")? {
            written += chunk.len() as u64;
            if written > file.byte_length {
                let _ = fs::remove_file(&part);
                return Err("integrity");
            }
            hash.update(&chunk);
            handle.write_all(&chunk).map_err(|_| "disk")?;
            received.fetch_add(chunk.len() as u64, std::sync::atomic::Ordering::Relaxed);
        }
        drop(handle);
        if written != file.byte_length || hex::encode(hash.finalize()) != file.sha256 {
            let _ = fs::remove_file(&part);
            return Err("integrity");
        }
        fs::rename(&part, &target).map_err(|_| "disk")?;
    }
    let marker = json!({
        "version": 1,
        "modelId": dir.file_name().and_then(|name| name.to_str()).unwrap_or(""),
        "modelVersion": model_version,
        "installedAt": "2026-11-18T00:00:00Z",
        "files": files.iter().map(|file| json!({
            "path": file.path,
            "contentType": file.content_type,
            "byteLength": file.byte_length,
            "sha256": file.sha256,
        })).collect::<Vec<_>>(),
    });
    let marker_path = dir.join("installed.json");
    fs::write(&marker_path, marker.to_string()).map_err(|_| "disk")?;
    Ok(())
}

pub fn read_marker(dir: &Path, model_id: &str) -> Option<Value> {
    let raw = fs::read_to_string(dir.join("installed.json")).ok()?;
    let marker: Value = serde_json::from_str(&raw).ok()?;
    if marker.get("modelId").and_then(Value::as_str) != Some(model_id) {
        return None;
    }
    for file in marker.get("files")?.as_array()? {
        let relative = file.get("path")?.as_str()?;
        let bytes = file.get("byteLength")?.as_u64()?;
        let metadata = fs::metadata(dir.join(relative)).ok()?;
        if !metadata.is_file() || metadata.len() != bytes {
            return None;
        }
    }
    Some(marker)
}
