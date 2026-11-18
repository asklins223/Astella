use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

use rand::RngCore;
use serde_json::{json, Value};

/**
 * 系统「打开方式」交来的 Markdown 文件（迁移切片 4）。
 *
 * 与 Electron 的 `OpenedFileBroker` 同一语义：只收扩展名在白名单里的普通文件，
 * 规范化后去重；渲染层挂载前攒在 pending 里，`take` 一次性取走；之后的文件
 * 由渲染层轮询同一个 `take` 拿（Electron 用推送，这里用轮询，合同不变）。
 * `reveal` 只允许对**系统真的交过**的路径执行——这是本地文件的一条边界。
 */
const MARKDOWN_EXTENSIONS: &[&str] = &[".md", ".markdown", ".mdown", ".mkd"];
const MAX_BATCH_FILES: usize = 20;

pub struct OpenedFileBroker {
    pending: Mutex<Vec<Value>>,
    authorized: Mutex<HashSet<String>>,
    ready: AtomicBool,
}

pub fn broker() -> &'static OpenedFileBroker {
    static BROKER: OnceLock<OpenedFileBroker> = OnceLock::new();
    BROKER.get_or_init(|| OpenedFileBroker {
        pending: Mutex::new(Vec::new()),
        authorized: Mutex::new(HashSet::new()),
        ready: AtomicBool::new(false),
    })
}

pub(crate) fn uuid_v4() -> String {
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: Vec<String> = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        hex[0..4].join(""),
        hex[4..6].join(""),
        hex[6..8].join(""),
        hex[8..10].join(""),
        hex[10..16].join("")
    )
}

fn identity(path: &Path) -> Option<Value> {
    let canonical = std::fs::canonicalize(path).ok()?;
    let info = std::fs::metadata(&canonical).ok()?;
    if !info.is_file() {
        return None;
    }
    let extension = canonical.extension().and_then(|value| value.to_str()).map(|value| format!(".{}", value.to_ascii_lowercase()))?;
    if !MARKDOWN_EXTENSIONS.contains(&extension.as_str()) {
        return None;
    }
    let modified_at = info.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_millis() as i64;
    Some(json!({
        "version": 1,
        "id": uuid_v4(),
        "path": canonical.to_string_lossy(),
        "name": canonical.file_name().and_then(|value| value.to_str()).unwrap_or("untitled.md"),
        "size": info.len(),
        "modifiedAt": modified_at,
    }))
}

impl OpenedFileBroker {
    /// 系统交来一批路径：过滤、去重、记账（授权集合）、入 pending。
    pub fn receive(&self, paths: Vec<PathBuf>) {
        let mut pending = self.pending.lock().expect("pending lock");
        for path in paths {
            if pending.len() >= MAX_BATCH_FILES {
                break;
            }
            let Some(file) = identity(&path) else { continue };
            let canonical = file["path"].as_str().unwrap_or_default().to_string();
            self.authorized.lock().expect("authorized lock").insert(canonical.clone());
            if pending.iter().any(|entry| entry["path"] == canonical) {
                continue;
            }
            pending.push(file);
        }
    }

    /// 渲染层取走积攒的文件；第一次调用同时把「可以接推送」立起来。
    pub fn take(&self) -> Option<Value> {
        self.ready.store(true, Ordering::Relaxed);
        let mut pending = self.pending.lock().expect("pending lock");
        if pending.is_empty() {
            return None;
        }
        let files: Vec<Value> = pending.drain(..).collect();
        Some(json!({ "version": 1, "batchId": uuid_v4(), "files": files }))
    }

    pub fn is_authorized(&self, path: &str) -> bool {
        self.authorized.lock().expect("authorized lock").contains(path)
    }

    /// 目录本身也记一笔：选过文件夹后，里面的文件/子目录都算授权范围。
    pub fn grant_dir(&self, directory: &Path) {
        let canonical = directory.canonicalize().unwrap_or_else(|_| directory.to_path_buf());
        if let Ok(mut set) = self.authorized.lock() {
            set.insert(canonical.to_string_lossy().to_string());
        }
    }

    /// 与 Electron 的目录授权同义：系统交过这个目录里的某个文件，就允许读这里同级的资源
    /// （随文图片等）。只比对父目录，不向上递归。
    pub fn is_in_authorized_dir(&self, path: &str) -> bool {
        let Some(directory) = Path::new(path).parent() else { return false };
        self.authorized
            .lock()
            .map(|set| {
                set.iter().any(|entry| {
                    let entry = Path::new(entry);
                    entry == directory || entry.parent() == Some(directory)
                })
            })
            .unwrap_or(false)
    }

    /// 在文件管理器中显出这一份（只对系统交过的路径生效）。
    pub fn reveal(&self, path: &str) -> bool {
        if !self.is_authorized(path) {
            return false;
        }
        #[cfg(target_os = "macos")]
        {
            return std::process::Command::new("/usr/bin/open").arg("-R").arg(path).spawn().is_ok();
        }
        #[cfg(target_os = "windows")]
        {
            return std::process::Command::new("explorer").arg(format!("/select,{path}")).spawn().is_ok();
        }
        #[allow(unreachable_code)]
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "astella-opened-files-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn receives_markdown_only_and_drains_once() {
        let dir = scratch_dir();
        let note = dir.join("note.md");
        std::fs::write(&note, "# hi").unwrap();
        let ignored = dir.join("image.png");
        std::fs::write(&ignored, [0u8]).unwrap();
        let broker = OpenedFileBroker {
            pending: Mutex::new(Vec::new()),
            authorized: Mutex::new(HashSet::new()),
            ready: AtomicBool::new(false),
        };
        broker.receive(vec![note.clone(), ignored, dir.join("missing.md")]);
        let batch = broker.take().expect("batch");
        assert_eq!(batch["files"].as_array().unwrap().len(), 1);
        assert_eq!(batch["files"][0]["name"], "note.md");
        assert!(batch["files"][0]["size"].as_u64().unwrap() > 0);
        assert!(broker.take().is_none(), "second take is empty");
        let canonical = std::fs::canonicalize(&note).unwrap().to_string_lossy().to_string();
        assert!(broker.is_authorized(&canonical));
        assert!(!broker.is_authorized("/etc/passwd"));
        std::fs::remove_dir_all(&dir).ok();
    }
}
