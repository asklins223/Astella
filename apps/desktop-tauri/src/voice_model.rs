use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

/**
 * 本机语音识别模型的仓库（迁移切片 4）。与 Electron `VoiceAsrModelStore` 同一语义：
 * 两个文件（239MB + 315KB）**多源按序尝试**，逐文件核对字节数与 SHA-256，
 * 半截文件永不算装好。模型本身不进安装包，用户在设置页自己下。
 *
 * 异步解码引擎（sherpa-onnx）是独立切片：路线见 docs 计划文档。这里只把
 * 「模型在不在、下到哪、失败在哪一类」这条设备级通道补齐。
 */
pub const MODEL_ID: &str = "sensevoice-int8-zh-en-ja-ko-yue";
const MOUNT_URL: &str = "astella-app://bundle/device/asr/";

#[derive(Clone)]
pub struct FileSpec {
    pub name: &'static str,
    pub bytes: u64,
    pub sha256: &'static str,
}

pub const FILES: &[FileSpec] = &[
    FileSpec { name: "model.int8.onnx", bytes: 239_233_841, sha256: "c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51" },
    FileSpec { name: "tokens.txt", bytes: 315_894, sha256: "f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc" },
];

#[derive(Clone)]
pub struct Source {
    pub id: &'static str,
    pub name: &'static str,
    pub base_url: &'static str,
}

pub const SOURCES: &[Source] = &[
    Source { id: "modelscope", name: "魔搭社区", base_url: "https://modelscope.cn/models/pengzhendong/sherpa-onnx-sense-voice-zh-en-ja-ko-yue/resolve/master" },
    Source { id: "hf-mirror", name: "hf-mirror 国内镜像", base_url: "https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main" },
    Source { id: "huggingface", name: "Hugging Face 官方库", base_url: "https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main" },
];

static STORE: std::sync::OnceLock<std::sync::Arc<VoiceModelStore>> = std::sync::OnceLock::new();

pub fn install(app_data: &Path) {
    let _ = STORE.set(std::sync::Arc::new(VoiceModelStore::new(app_data)));
}

pub fn store() -> Option<&'static std::sync::Arc<VoiceModelStore>> {
    STORE.get()
}

pub struct VoiceModelStore {
    directory: PathBuf,
    files: Vec<FileSpec>,
    sources: Vec<Source>,
    active: AtomicBool,
    abort: AtomicBool,
    received: Arc<AtomicU64>,
    failure: Mutex<Option<&'static str>>,
    active_source: Mutex<Option<String>>,
    client: reqwest::Client,
}

impl VoiceModelStore {
    pub fn new(app_data: &Path) -> Self {
        Self::with_specs(app_data, FILES.to_vec(), SOURCES.to_vec())
    }

    fn with_specs(app_data: &Path, files: Vec<FileSpec>, sources: Vec<Source>) -> Self {
        Self {
            directory: app_data.join("voice-models"),
            files,
            sources,
            active: AtomicBool::new(false),
            abort: AtomicBool::new(false),
            received: Arc::new(AtomicU64::new(0)),
            failure: Mutex::new(None),
            active_source: Mutex::new(None),
            client: reqwest::Client::builder()
                .user_agent("Astella-Desktop-Tauri")
                .connect_timeout(std::time::Duration::from_secs(15))
                .build()
                .expect("voice http client"),
        }
    }

    fn expected_bytes(&self) -> u64 {
        self.files.iter().map(|file| file.bytes).sum()
    }

    fn file_state(&self, file: &FileSpec) -> Value {
        let path = self.directory.join(file.name);
        let actual = std::fs::metadata(&path).map(|info| info.len()).unwrap_or(0);
        let complete = actual == file.bytes;
        json!({
            "name": file.name,
            "bytes": if complete { actual } else { 0 },
            "expectedBytes": file.bytes,
            "complete": complete,
        })
    }

    pub fn snapshot(&self) -> Value {
        let states: Vec<Value> = self.files.iter().map(|file| self.file_state(file)).collect();
        let installed: u64 = states.iter().filter_map(|state| state["bytes"].as_u64()).sum();
        let ready = states.iter().all(|state| state["complete"] == true);
        let active = self.active.load(Ordering::Relaxed);
        let failure = *self.failure.lock().expect("failure lock");
        let status = if ready {
            "ready"
        } else if active {
            "downloading"
        } else if failure.is_some_and(|value| value != "cancelled") {
            "error"
        } else {
            "absent"
        };
        let installed_at = if ready {
            std::fs::metadata(self.directory.join(self.files[0].name))
                .ok()
                .and_then(|info| info.modified().ok())
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|since| format_iso(since.as_secs()))
        } else {
            None
        };
        json!({
            "version": 1,
            "modelId": MODEL_ID,
            "mountUrl": MOUNT_URL,
            "status": status,
            "expectedBytes": self.expected_bytes(),
            "receivedBytes": installed + if active { self.received.load(Ordering::Relaxed) } else { 0 },
            "installedBytes": installed,
            "files": states,
            "sources": self.sources.iter().map(|source| source.name).collect::<Vec<_>>(),
            "activeSource": self.active_source.lock().expect("source lock").clone(),
            "failure": if status == "ready" || status == "downloading" { None } else { failure },
            "installedAt": installed_at,
        })
    }

    pub fn start(self: &Arc<Self>) {
        if self.active.swap(true, Ordering::SeqCst) {
            return;
        }
        self.abort.store(false, Ordering::SeqCst);
        self.received.store(0, Ordering::Relaxed);
        *self.failure.lock().expect("failure lock") = None;
        let store = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            let outcome = store.run().await;
            *store.failure.lock().expect("failure lock") = match outcome {
                Ok(()) => None,
                Err(kind) => Some(kind),
            };
            if store.abort.load(Ordering::SeqCst) {
                *store.failure.lock().expect("failure lock") = Some("cancelled");
            }
            store.active.store(false, Ordering::SeqCst);
        });
    }

    async fn run(self: &Arc<Self>) -> Result<(), &'static str> {
        if let Err(error) = tokio::fs::create_dir_all(&self.directory).await {
            let _ = error;
            return Err("storage");
        }
        for file in &self.files {
            if self.file_state(file)["complete"] == true {
                continue;
            }
            let mut last = "network";
            let mut done = false;
            for source in &self.sources {
                if self.abort.load(Ordering::SeqCst) {
                    return Err("cancelled");
                }
                *self.active_source.lock().expect("source lock") = Some(source.name.to_string());
                match self.download(file, source).await {
                    Ok(()) => {
                        done = true;
                        break;
                    }
                    Err("cancelled") => return Err("cancelled"),
                    Err(kind) if kind == "storage" => return Err("storage"),
                    Err(kind) => last = kind,
                }
            }
            if !done {
                return Err(last);
            }
        }
        Ok(())
    }

    async fn download(&self, file: &FileSpec, source: &Source) -> Result<(), &'static str> {
        let url = format!("{}/{}", source.base_url.trim_end_matches('/'), file.name);
        let response = self.client.get(&url).send().await.map_err(|_| "network")?;
        if !response.status().is_success() {
            return Err("network");
        }
        let part = self.directory.join(format!("{}.part", file.name));
        let mut handle = tokio::fs::File::create(&part).await.map_err(|_| "storage")?;
        use tokio::io::AsyncWriteExt;
        let mut hash = Sha256::new();
        let mut written: u64 = 0;
        let mut response = response;
        while let Some(chunk) = response.chunk().await.map_err(|_| {
            let _ = std::fs::remove_file(&part);
            "network"
        })? {
            if self.abort.load(Ordering::SeqCst) {
                let _ = std::fs::remove_file(&part);
                return Err("cancelled");
            }
            written += chunk.len() as u64;
            if written > file.bytes {
                let _ = std::fs::remove_file(&part);
                return Err("size_mismatch");
            }
            hash.update(&chunk);
            handle.write_all(&chunk).await.map_err(|_| "storage")?;
            self.received.fetch_add(chunk.len() as u64, Ordering::Relaxed);
        }
        drop(handle);
        if written != file.bytes || hex::encode(hash.finalize()) != file.sha256 {
            let _ = std::fs::remove_file(&part);
            return Err("size_mismatch");
        }
        tokio::fs::rename(&part, self.directory.join(file.name)).await.map_err(|_| "storage")?;
        Ok(())
    }

    pub fn cancel(&self) {
        self.abort.store(true, Ordering::SeqCst);
    }

    pub fn remove(&self) {
        self.cancel();
        for file in &self.files {
            let _ = std::fs::remove_file(self.directory.join(file.name));
            let _ = std::fs::remove_file(self.directory.join(format!("{}.part", file.name)));
        }
        self.received.store(0, Ordering::Relaxed);
        *self.failure.lock().expect("failure lock") = None;
    }
}

fn format_iso(seconds: u64) -> String {
    // 只用于展示"装好于"；精度到秒即可。
    let time = std::time::UNIX_EPOCH + std::time::Duration::from_secs(seconds);
    let datetime: chrono_like = chrono_like { time };
    datetime.to_rfc3339()
}

struct chrono_like {
    time: std::time::SystemTime,
}

impl chrono_like {
    fn to_rfc3339(&self) -> String {
        let since = self.time.duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
        let seconds = since.as_secs();
        let days = seconds / 86_400;
        let remainder = seconds % 86_400;
        let (hour, minute, second) = (remainder / 3_600, (remainder % 3_600) / 60, remainder % 60);
        // 1970-01-01 + days（民用日期换算）。
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
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> PathBuf {
        static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let tick = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "astella-voice-model-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos(),
            tick
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn tiny_store(root: &Path) -> VoiceModelStore {
        VoiceModelStore::with_specs(
            root,
            vec![
                FileSpec { name: "a.bin", bytes: 4, sha256: "" },
                FileSpec { name: "b.txt", bytes: 2, sha256: "" },
            ],
            vec![Source { id: "s", name: "源一", base_url: "https://example.invalid" }],
        )
    }

    #[test]
    fn snapshot_states_absent_ready_and_remove() {
        let root = scratch();
        let store = tiny_store(&root);
        let absent = store.snapshot();
        assert_eq!(absent["status"], "absent");
        assert_eq!(absent["files"].as_array().unwrap().len(), 2);
        assert_eq!(absent["sources"][0], "源一");

        std::fs::create_dir_all(root.join("voice-models")).unwrap();
        std::fs::write(root.join("voice-models").join("a.bin"), [1, 2, 3, 4]).unwrap();
        std::fs::write(root.join("voice-models").join("b.txt"), [1, 2]).unwrap();
        let ready = store.snapshot();
        assert_eq!(ready["status"], "ready");
        assert_eq!(ready["installedBytes"], 6);
        assert!(ready["installedAt"].is_string());

        store.remove();
        assert_eq!(store.snapshot()["status"], "absent");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn half_file_is_not_complete() {
        let root = scratch();
        let store = tiny_store(&root);
        std::fs::create_dir_all(root.join("voice-models")).unwrap();
        std::fs::write(root.join("voice-models").join("a.bin"), [1, 2]).unwrap();
        std::fs::write(root.join("voice-models").join("b.txt"), [1, 2]).unwrap();
        let snapshot = store.snapshot();
        assert_eq!(snapshot["status"], "absent");
        assert_eq!(snapshot["files"][0]["complete"], false);
        std::fs::remove_dir_all(&root).ok();
    }
}
