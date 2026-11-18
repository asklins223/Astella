use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde_json::{json, Value};

use crate::gateway::Gateway;

/**
 * Markdown 包的「先看一眼、再真的传」两步（Electron `markdown-bundle-import` 的目录版）。
 *
 * 本机读包 → 图片走 `POST /uploads/import-images` 换成站内地址 → 把改写好的正文交回渲染层，
 * 建来源/解析/建笔记仍走既有的 `source.create`。zip 包尚未移植（通道明确回
 * `unsupported_contract`）；`http:` 明文外链、包外绝对路径、缺文件/超限的图片逐条进
 * `issues`，不静默跳过。
 */
const MAX_FILES: usize = 50;
const MAX_ENTRIES: usize = 5_000;
const MAX_DEPTH: usize = 5;
const MAX_TEXT_BYTES: u64 = 100 * 1024 * 1024;
const MAX_IMAGE_BYTES: u64 = 100 * 1024 * 1024;
const MAX_CONTENT_CHARS: usize = 10_000_000;
const MAX_ZIP_BYTES: u64 = 400 * 1024 * 1024;
const MAX_ISSUES: usize = 50;
const MAX_ISSUE_SRC: usize = 2_000;
const MAX_ISSUE_MESSAGE: usize = 480;
const IGNORED_SEGMENTS: &[&str] = &[".git", "node_modules", "__MACOSX"];

static LAST_BUNDLE: OnceLock<Mutex<Option<String>>> = OnceLock::new();

fn last_bundle() -> &'static Mutex<Option<String>> {
    LAST_BUNDLE.get_or_init(|| Mutex::new(None))
}

fn issue(src: &str, message: &str) -> Value {
    json!({
        "src": src.chars().take(MAX_ISSUE_SRC).collect::<String>(),
        "message": message.chars().take(MAX_ISSUE_MESSAGE).collect::<String>(),
    })
}

fn image_mime(path: &Path) -> Option<&'static str> {
    let extension = path.extension().and_then(|value| value.to_str()).map(str::to_ascii_lowercase)?;
    match extension.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

fn mime_for_name(name: &str) -> Option<&'static str> {
    image_mime(Path::new(name))
}

fn is_ignored_path(relative: &str) -> bool {
    relative.split('/').any(|segment| IGNORED_SEGMENTS.contains(&segment))
}

fn is_markdown_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".md") || lower.ends_with(".markdown")
}

struct BundleData {
    markdown: Vec<String>,
    /// 包内图片的相对路径 → (字节数, 读取器)。
    images: HashMap<String, u64>,
    /// 目录包：每个 md 的绝对路径。
    folder_paths: HashMap<String, PathBuf>,
    /// 目录包：每张图的绝对路径（字节数另存于 `images`）。
    folder_images: HashMap<String, PathBuf>,
    /// zip 包：整份字节；按需打开归档取条目。
    zip_bytes: Option<Vec<u8>>,
    overflow: usize,
}

impl BundleData {
    fn open_folder(root: &Path) -> BundleData {
        fn walk(directory: &Path, root: &Path, depth: usize, entries: &mut usize, data: &mut BundleData) {
            if depth > MAX_DEPTH || *entries >= MAX_ENTRIES {
                return;
            }
            let Ok(read) = std::fs::read_dir(directory) else { return };
            let mut children: Vec<_> = read.flatten().collect();
            children.sort_by_key(|entry| entry.file_name());
            for entry in children {
                if *entries >= MAX_ENTRIES {
                    return;
                }
                let name = entry.file_name().to_string_lossy().to_string();
                if IGNORED_SEGMENTS.contains(&name.as_str()) {
                    continue;
                }
                *entries += 1;
                let path = entry.path();
                if path.is_dir() {
                    walk(&path, root, depth + 1, entries, data);
                } else if path.is_file() {
                    let relative = path.strip_prefix(root).unwrap_or(&path).to_string_lossy().replace('\\', "/");
                    if is_markdown_name(&name) {
                        if data.markdown.len() < MAX_FILES {
                            data.folder_paths.insert(relative.clone(), path.clone());
                            data.markdown.push(relative);
                        } else {
                            data.overflow += 1;
                        }
                    } else if image_mime(&path).is_some() {
                        let size = std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
                        data.folder_images.insert(relative.clone(), path);
                        data.images.insert(relative, size);
                    }
                }
            }
        }
        let mut data = BundleData {
            markdown: Vec::new(),
            images: HashMap::new(),
            folder_paths: HashMap::new(),
            folder_images: HashMap::new(),
            zip_bytes: None,
            overflow: 0,
        };
        let mut entries = 0usize;
        walk(root, root, 0, &mut entries, &mut data);
        data
    }

    fn open_zip(path: &Path) -> Result<BundleData, &'static str> {
        let bytes = std::fs::read(path).map_err(|_| "not_found")?;
        if bytes.len() as u64 > MAX_ZIP_BYTES {
            return Err("validation");
        }
        let mut markdown: Vec<String> = Vec::new();
        let mut images: HashMap<String, u64> = HashMap::new();
        let mut overflow = 0usize;
        {
            let mut reader = zip::ZipArchive::new(std::io::Cursor::new(bytes.as_slice()))
                .map_err(|_| "unsupported_contract")?;
            let mut count = 0usize;
            for index in 0..reader.len() {
                if count >= MAX_ENTRIES {
                    break;
                }
                let entry = reader.by_index(index).map_err(|_| "unsupported_contract")?;
                if entry.is_dir() {
                    continue;
                }
                let name = entry.name().replace('\\', "/");
                if is_ignored_path(&name) {
                    continue;
                }
                count += 1;
                if is_markdown_name(&name) {
                    if markdown.len() < MAX_FILES {
                        markdown.push(name);
                    } else {
                        overflow += 1;
                    }
                } else if mime_for_name(&name).is_some() {
                    images.insert(name, entry.size());
                }
            }
        }
        Ok(BundleData { markdown, images, folder_paths: HashMap::new(), folder_images: HashMap::new(), zip_bytes: Some(bytes), overflow })
    }

    fn read_markdown(&self, relative: &str) -> Option<Vec<u8>> {
        if let Some(path) = self.folder_paths.get(relative) {
            let metadata = std::fs::metadata(path).ok()?;
            if metadata.len() > MAX_TEXT_BYTES {
                return None;
            }
            return std::fs::read(path).ok();
        }
        let bytes = self.zip_bytes.as_ref()?;
        let mut reader = zip::ZipArchive::new(std::io::Cursor::new(bytes.as_slice())).ok()?;
        let mut entry = reader.by_name(relative).ok()?;
        if entry.size() > MAX_TEXT_BYTES {
            return None;
        }
        let mut buffer = Vec::new();
        std::io::Read::read_to_end(&mut entry, &mut buffer).ok()?;
        Some(buffer)
    }

    fn read_image(&self, relative: &str) -> Option<Vec<u8>> {
        let limit = self.images.get(relative)?;
        if *limit == 0 || *limit > MAX_IMAGE_BYTES {
            return None;
        }
        if let Some(path) = self.folder_images.get(relative) {
            return std::fs::read(path).ok();
        }
        let bytes = self.zip_bytes.as_ref()?;
        let mut reader = zip::ZipArchive::new(std::io::Cursor::new(bytes.as_slice())).ok()?;
        let mut entry = reader.by_name(relative).ok()?;
        let mut buffer = Vec::new();
        std::io::Read::read_to_end(&mut entry, &mut buffer).ok()?;
        Some(buffer)
    }
}

fn decode_reference(src: &str) -> String {
    let trimmed = src.split(['?', '#']).next().unwrap_or(src);
    percent_encoding::percent_decode_str(trimmed).decode_utf8_lossy().to_string()
}

/// 相对引用 → 包内 posix 相对路径（解析 `..`，出界即 None）。
fn resolve_local(file_rel: &str, reference: &str) -> Option<String> {
    let base = file_rel.rsplit_once('/').map(|(dir, _)| dir).unwrap_or("");
    let mut stack: Vec<&str> = if base.is_empty() { Vec::new() } else { base.split('/').collect() };
    for segment in reference.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                stack.pop()?;
            }
            other => stack.push(other),
        }
    }
    if stack.is_empty() {
        None
    } else {
        Some(stack.join("/"))
    }
}

enum RefPlan {
    Local { src: String, relative: String },
    Issue { src: String, message: String },
}

fn plan_markdown(file_rel: &str, markdown: &str, images: &HashMap<String, u64>) -> Vec<RefPlan> {
    let mut plans = Vec::new();
    for src in crate::markdown_images::image_sources(markdown) {
        let trimmed = src.trim();
        if trimmed.is_empty() || trimmed.starts_with("data:") || trimmed.starts_with("/api/uploads/") {
            continue;
        }
        if trimmed.starts_with("http://") {
            plans.push(RefPlan::Issue { src: src.clone(), message: "明文 http 外链不受支持，请在原处换成 https 或本地文件。".to_string() });
            continue;
        }
        if trimmed.starts_with("https://") {
            plans.push(RefPlan::Issue { src: src.clone(), message: "外链图片的下载与上传尚未移植，这一张先保持原地址。".to_string() });
            continue;
        }
        if trimmed.starts_with('/') || trimmed.contains("://") {
            plans.push(RefPlan::Issue { src: src.clone(), message: "包外绝对路径不会导入，请把图片放进包目录里再引用。".to_string() });
            continue;
        }
        let decoded = decode_reference(trimmed);
        let Some(relative) = resolve_local(file_rel, &decoded) else {
            plans.push(RefPlan::Issue { src: src.clone(), message: "这一个相对路径走出了包目录，无法解析。".to_string() });
            continue;
        };
        match images.get(&relative) {
            Some(size) if mime_for_name(&relative).is_some() && *size > 0 && *size <= MAX_IMAGE_BYTES => {
                plans.push(RefPlan::Local { src, relative });
            }
            Some(_) => plans.push(RefPlan::Issue { src: src.clone(), message: "图片格式不支持，或为空/超过 100 MB 上限。".to_string() }),
            None => plans.push(RefPlan::Issue { src: src.clone(), message: "包里找不到这张图片，引用保持原样。".to_string() }),
        }
    }
    plans
}

pub async fn run(gateway: &mut Gateway, input: &Value, app: Option<&tauri::AppHandle>) -> Result<Value, &'static str> {
    let request = input.get("request").ok_or("validation")?;
    let action = request.get("action").and_then(Value::as_str).unwrap_or("");
    let kind = request.get("kind").and_then(Value::as_str).unwrap_or("folder");
    if !matches!(kind, "folder" | "zip") {
        return Err("validation");
    }
    if !matches!(action, "inspect" | "import") {
        return Err("validation");
    }
    let root: PathBuf = if action == "inspect" {
        let picked = match std::env::var("ASTELLA_BUNDLE_PATH").ok().filter(|value| !value.is_empty()) {
            Some(path) => Some(PathBuf::from(path)),
            None => {
                use tauri_plugin_dialog::DialogExt;
                let Some(app) = app else { return Err("local_storage_unavailable") };
                if kind == "zip" {
                    app.dialog().file().add_filter("ZIP", &["zip"]).blocking_pick_file().and_then(|file| file.into_path().ok())
                } else {
                    app.dialog().file().blocking_pick_folder().and_then(|file| file.into_path().ok())
                }
            }
        };
        let Some(picked) = picked else {
            return Ok(json!({
                "version": 1, "stage": "preview", "canceled": true, "files": 0, "overflow": 0,
                "referenced": 0, "localizable": 0, "imageBytes": 0, "toUpload": 0,
                "issues": [], "issueOverflow": 0,
            }));
        };
        if let Ok(mut last) = last_bundle().lock() {
            *last = Some(picked.to_string_lossy().to_string());
        }
        picked
    } else {
        let path = request.get("bundlePath").and_then(Value::as_str).filter(|value| !value.is_empty()).ok_or("validation")?;
        let approved = last_bundle().lock().ok().and_then(|last| last.clone());
        if approved.as_deref() != Some(path) {
            return Err("validation");
        }
        PathBuf::from(path)
    };

    let bundle = if kind == "zip" {
        if !root.is_file() {
            return Err("not_found");
        }
        BundleData::open_zip(&root)?
    } else {
        if !root.is_dir() {
            return Err("not_found");
        }
        BundleData::open_folder(&root)
    };
    let mut plans: Vec<(String, String, Vec<RefPlan>)> = Vec::new();
    let mut issues: Vec<Value> = Vec::new();
    for relative in &bundle.markdown {
        let Some(bytes) = bundle.read_markdown(relative) else {
            issues.push(issue(relative, "这一份正文读不出来或超过 100 MB 上限，没有收进来。"));
            continue;
        };
        let Ok(markdown) = crate::note_writing::decode_note_bytes(&bytes) else {
            issues.push(issue(relative, "这份正文既不是 UTF-8 也不是 GBK 能读出来的编码。"));
            continue;
        };
        let file_plans = plan_markdown(relative, &markdown, &bundle.images);
        for plan in &file_plans {
            if let RefPlan::Issue { src, message } = plan {
                issues.push(issue(src, message));
            }
        }
        plans.push((relative.clone(), markdown, file_plans));
    }
    let referenced = plans.iter().map(|(_, _, refs)| refs.len()).sum::<usize>();
    let local_refs: Vec<(&str, &str)> = plans
        .iter()
        .flat_map(|(_, _, refs)| refs.iter().filter_map(|plan| match plan {
            RefPlan::Local { src, relative } => Some((src.as_str(), relative.as_str())),
            RefPlan::Issue { .. } => None,
        }))
        .collect();
    let unique_targets: HashSet<&str> = local_refs.iter().map(|(_, relative)| *relative).collect();
    let image_bytes: u64 = unique_targets.iter().filter_map(|relative| bundle.images.get(*relative)).copied().sum();

    if action == "inspect" {
        let shown: Vec<Value> = issues.iter().take(MAX_ISSUES).cloned().collect();
        return Ok(json!({
            "version": 1, "stage": "preview", "kind": kind,
            "bundlePath": root.to_string_lossy(),
            "files": plans.len(), "overflow": bundle.overflow,
            "referenced": referenced, "localizable": local_refs.len(),
            "imageBytes": image_bytes, "toUpload": unique_targets.len(),
            "issues": shown, "issueOverflow": issues.len().saturating_sub(MAX_ISSUES),
        }));
    }

    if let Err(error) = gateway.ensure_connected().await {
        return Err(match error.code {
            "auth_required" => "forbidden",
            _ => "unavailable",
        });
    }
    let mut uploaded_urls: HashMap<String, String> = HashMap::new();
    let mut uploaded = 0usize;
    for relative in &unique_targets {
        let Some(bytes) = bundle.read_image(relative) else {
            issues.push(issue(relative, "读取这张图片失败，引用保持原样。"));
            continue;
        };
        let Some(mime) = mime_for_name(relative) else { continue };
        let file_name = relative.rsplit('/').next().unwrap_or("image").to_string();
        match gateway.post_import_image(&file_name, mime, bytes).await {
            Ok(url) => {
                uploaded_urls.insert((*relative).to_string(), url);
                uploaded += 1;
            }
            Err(_) => issues.push(issue(relative, "上传这张图片失败，引用保持原样。")),
        }
    }
    let mut tasks: Vec<Value> = Vec::new();
    let mut dropped: Vec<Value> = Vec::new();
    for (relative, markdown, refs) in plans {
        let mut replacements: HashMap<String, String> = HashMap::new();
        for plan in refs {
            if let RefPlan::Local { src, relative: target } = plan {
                if let Some(url) = uploaded_urls.get(&target) {
                    replacements.insert(src, url.clone());
                }
            }
        }
        let content = if replacements.is_empty() {
            markdown
        } else {
            crate::markdown_images::rewrite_image_paths(&markdown, &replacements)
        };
        if content.len() > MAX_CONTENT_CHARS || content.as_bytes().len() as u64 > MAX_TEXT_BYTES {
            dropped.push(issue(&relative, "改写之后正文超过单份上限，这一篇没有收进来。"));
            continue;
        }
        let title = relative
            .rsplit('/')
            .next()
            .unwrap_or(&relative)
            .rsplit_once('.')
            .map(|(stem, _)| stem.to_string())
            .filter(|stem| !stem.is_empty());
        let mut task = json!({ "name": relative, "content": content });
        if let Some(title) = title {
            task["title"] = json!(title);
        }
        tasks.push(task);
        if tasks.len() >= MAX_FILES {
            break;
        }
    }
    let shown: Vec<Value> = issues.iter().take(MAX_ISSUES).cloned().collect();
    Ok(json!({
        "version": 1, "stage": "imported", "kind": kind,
        "tasks": tasks, "uploaded": uploaded,
        "issues": shown, "issueOverflow": issues.len().saturating_sub(MAX_ISSUES),
        "dropped": dropped.into_iter().take(MAX_FILES).collect::<Vec<Value>>(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_relative_references_inside_the_bundle() {
        assert_eq!(super::resolve_local("a/note.md", &super::decode_reference("./img/pic%20one.png")).as_deref(), Some("a/img/pic one.png"));
        assert_eq!(super::resolve_local("a/note.md", "img/pic.png").as_deref(), Some("a/img/pic.png"));
        assert_eq!(super::resolve_local("note.md", "../escape.png"), None);
        assert_eq!(super::resolve_local("a/b/note.md", "../../pic.png").as_deref(), Some("pic.png"));
    }

    #[test]
    fn reads_zip_bundles() {
        use std::io::Write;
        let path = std::env::temp_dir().join(format!("bundle-zip-{}.zip", std::process::id()));
        {
            let mut writer = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
            let options: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default();
            writer.start_file("note.md", options).unwrap();
            writer.write_all(b"# zip note\n\n![a](./img/pic.png)\n").unwrap();
            writer.add_directory("img/", options).unwrap();
            writer.start_file("img/pic.png", options).unwrap();
            writer.write_all(b"png-bytes").unwrap();
            writer.finish().unwrap();
        }
        let bundle = super::BundleData::open_zip(&path).expect("open zip");
        assert_eq!(bundle.markdown, vec!["note.md".to_string()]);
        let markdown = bundle.read_markdown("note.md").expect("markdown");
        assert!(String::from_utf8_lossy(&markdown).contains("zip note"));
        let image = bundle.read_image("img/pic.png").expect("image");
        assert_eq!(image, b"png-bytes");
        let plans = super::plan_markdown("note.md", &String::from_utf8_lossy(&markdown), &bundle.images);
        assert_eq!(plans.iter().filter(|plan| matches!(plan, RefPlan::Local { .. })).count(), 1);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn plans_local_and_remote_references() {
        let root = std::env::temp_dir().join(format!("bundle-plan-{}", std::process::id()));
        std::fs::create_dir_all(root.join("img")).unwrap();
        std::fs::write(root.join("img/pic.png"), b"png").unwrap();
        let bundle = super::BundleData::open_folder(&root);
        let markdown = "![a](./img/pic.png) ![b](https://example.com/x.png) ![c](./img/missing.png)";
        let plans = super::plan_markdown("note.md", markdown, &bundle.images);
        let locals = plans.iter().filter(|plan| matches!(plan, RefPlan::Local { .. })).count();
        let issues = plans.len() - locals;
        assert_eq!(locals, 1);
        assert_eq!(issues, 2);
        std::fs::remove_dir_all(&root).ok();
    }
}
