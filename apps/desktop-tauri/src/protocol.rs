use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use percent_encoding::percent_decode_str;
use serde_json::Value;
use tauri::http::Response;
use tauri::Manager;

/**
 * `astella-app://` 应用协议（迁移切片 4）。
 *
 * 为什么不用 Tauri 内置的 `tauri://localhost`：同源是硬前提——渲染层的
 * `resolveBundledAsset` 只接受与页面同源的资源，模型/识别文件的 CSP 也走 `'self'`。
 * 内置资产协议没有动态路由，所以整个页面挂在这个自定义 scheme 上（与 Electron 同构）：
 *
 *  - `astella-app://bundle/…`   前端静态资源（Tauri 资产解析器，打包/开发同源）
 *  - `astella-app://bundle/device/models/<modelId>/<path>`  伴星模型（准入名单=安装标记）
 *  - `astella-app://bundle/device/asr/<name>`               本机识别模型（两个文件名）
 *  - `astella-app://artifact/<id>`                         隔离产物 frame（未移植，404）
 *
 * 设备文件全部从 Tauri 的 app data 目录读：`<appData>/companion-models/`、`<appData>/voice-models/`。
 */
const ASR_MODEL_FILES: &[(&str, u64, &str)] = &[
    ("model.int8.onnx", 239_233_841, "application/octet-stream"),
    ("tokens.txt", 315_894, "text/plain; charset=utf-8"),
];

fn mime_for(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("").to_ascii_lowercase().as_str() {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "mp3" => "audio/mpeg",
        "moc3" | "wasm" => "application/octet-stream",
        _ => "application/octet-stream",
    }
}

fn is_within(parent: &Path, child: &Path) -> bool {
    let parent = fs::canonicalize(parent).unwrap_or_else(|_| parent.to_path_buf());
    let child = fs::canonicalize(child).unwrap_or_else(|_| child.to_path_buf());
    child == parent || child.starts_with(&parent)
}

fn decode_path(raw: &str) -> Option<String> {
    let decoded = percent_decode_str(raw).decode_utf8().ok()?.to_string();
    if decoded.contains('\0') || decoded.contains('\\') || decoded.contains("..") {
        return None;
    }
    Some(decoded)
}

/// 伴星模型：只认 `installed.json` 里登记的文件，且磁盘字节数必须与标记一致。
pub fn resolve_companion_model_file(app_data: &Path, relative: &str) -> Option<(PathBuf, String, u64)> {
    let mut segments = relative.splitn(2, '/');
    let model_id = segments.next()?;
    let file_path = segments.next()?;
    if model_id.is_empty() || file_path.is_empty() {
        return None;
    }
    let model_root = app_data.join("companion-models").join(model_id);
    let marker = crate::companion_model::read_marker(&model_root, model_id)?;
    let files = marker.get("files")?.as_array()?;
    let entry = files.iter().find(|entry| entry.get("path").and_then(Value::as_str) == Some(file_path))?;
    let byte_length = entry.get("byteLength")?.as_u64()?;
    let content_type = entry.get("contentType")?.as_str()?.to_string();
    let absolute = model_root.join(file_path);
    if !is_within(&model_root, &absolute) {
        return None;
    }
    let metadata = fs::metadata(&absolute).ok()?;
    if !metadata.is_file() || metadata.len() != byte_length {
        return None;
    }
    Some((absolute, content_type, byte_length))
}

/// 识别模型：只有那两个文件，字节数与合同一致才算存在。
pub fn resolve_asr_model_file(app_data: &Path, name: &str) -> Option<(PathBuf, String, u64)> {
    let (_, expected, content_type) = ASR_MODEL_FILES.iter().find(|(allowed, _, _)| *allowed == name)?;
    let path = app_data.join("voice-models").join(name);
    let metadata = fs::metadata(&path).ok()?;
    if !metadata.is_file() || metadata.len() != *expected {
        return None;
    }
    Some((path, (*content_type).to_string(), metadata.len()))
}

fn plain(status: u16, message: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header("Content-Type", "text/plain; charset=utf-8")
        .body(message.as_bytes().to_vec())
        .expect("static response")
}

fn parse_range(header: Option<&str>, size: u64) -> Option<(u64, u64)> {
    let value = header?;
    let spec = value.strip_prefix("bytes=")?;
    let (start, end) = spec.split_once('-')?;
    let start: u64 = start.parse().ok()?;
    let end = if end.is_empty() { size.checked_sub(1)? } else { end.parse::<u64>().ok()?.min(size.checked_sub(1)?) };
    if start > end || start >= size {
        return None;
    }
    Some((start, end))
}

fn serve_file(path: &Path, content_type: &str, method: &str, range: Option<&str>) -> Response<Vec<u8>> {
    let Ok(metadata) = fs::metadata(path) else { return plain(404, "Not found") };
    let size = metadata.len();
    let mut file = match fs::File::open(path) {
        Ok(file) => file,
        Err(_) => return plain(404, "Not found"),
    };
    let is_head = method == "HEAD";
    let mut builder = Response::builder()
        .header("Accept-Ranges", "bytes")
        .header("Content-Type", content_type.to_string());
    if let Some((start, end)) = parse_range(range, size) {
        let length = end - start + 1;
        let mut buffer = vec![0u8; length as usize];
        if file.seek(SeekFrom::Start(start)).is_err() || file.read_exact(&mut buffer).is_err() {
            return plain(500, "Read failed");
        }
        builder = builder
            .status(206)
            .header("Content-Range", format!("bytes {start}-{end}/{size}"))
            .header("Content-Length", length.to_string());
        return builder.body(if is_head { Vec::new() } else { buffer }).expect("response");
    }
    builder = builder.status(200).header("Content-Length", size.to_string());
    if is_head {
        return builder.body(Vec::new()).expect("response");
    }
    let mut buffer = Vec::with_capacity(size as usize);
    if file.read_to_end(&mut buffer).is_err() {
        return plain(500, "Read failed");
    }
    builder.body(buffer).expect("response")
}

const ARTIFACT_CSP: &str = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

fn is_artifact_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    bytes.iter().enumerate().all(|(index, byte)| {
        if matches!(index, 8 | 13 | 18 | 23) {
            *byte == b'-'
        } else {
            byte.is_ascii_hexdigit()
        }
    })
}

/// `astella-app://artifact/<uuid>`：只认 uuid，只读 `<appData>/artifacts/<uuid>.html`。
/// 产物文档的沙箱由 iframe 的 `allow-scripts`（无 same-origin）承担，这里负责内容与 CSP。
pub fn resolve_artifact_file(app_data: &Path, requested: &str) -> Option<PathBuf> {
    let id = requested.trim_start_matches('/');
    if !is_artifact_id(id) {
        return None;
    }
    let file = app_data.join("artifacts").join(format!("{id}.html"));
    file.is_file().then_some(file)
}

fn serve_artifact<R: tauri::Runtime>(app: &tauri::AppHandle<R>, requested: &str, method: &str) -> Response<Vec<u8>> {
    use tauri::Manager;
    let Ok(app_data) = app.path().app_data_dir() else {
        return plain(500, "No app data");
    };
    let Some(file) = resolve_artifact_file(&app_data, requested) else {
        return plain(404, "Not found");
    };
    let method = if method == "HEAD" { "HEAD" } else { "GET" };
    let Ok(bytes) = std::fs::read(&file) else {
        return plain(404, "Not found");
    };
    Response::builder()
        .status(200)
        .header("Content-Type", "text/html; charset=utf-8")
        .header("Content-Security-Policy", ARTIFACT_CSP)
        .header("X-Content-Type-Options", "nosniff")
        .header("Cache-Control", "no-store")
        .body(if method == "HEAD" { Vec::new() } else { bytes })
        .expect("artifact response")
}

pub fn register<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder.register_uri_scheme_protocol("astella-app", |context, request| {
        let host = request.uri().host().unwrap_or("bundle");
        let raw_path = request.uri().path().trim_start_matches('/').to_string();
        let method = request.method().as_str().to_string();
        let range = request.headers().get("range").and_then(|value| value.to_str().ok());

        if host == "artifact" {
            return serve_artifact(context.app_handle(), &raw_path, &method);
        }

        let Some(path) = decode_path(&raw_path) else { return plain(400, "Bad request") };
        if path == "device/models" || path.starts_with("device/models/") {
            let app_data = match context.app_handle().path().app_data_dir() {
                Ok(dir) => dir,
                Err(_) => return plain(500, "No app data"),
            };
            let relative = path.trim_start_matches("device/models/");
            return match resolve_companion_model_file(&app_data, relative) {
                Some((file, content_type, _)) => serve_file(&file, &content_type, &method, range),
                None => plain(404, "Not found"),
            };
        }
        if path == "device/asr" || path.starts_with("device/asr/") {
            let app_data = match context.app_handle().path().app_data_dir() {
                Ok(dir) => dir,
                Err(_) => return plain(500, "No app data"),
            };
            let name = path.trim_start_matches("device/asr/");
            return match resolve_asr_model_file(&app_data, name) {
                Some((file, content_type, _)) => serve_file(&file, &content_type, &method, range),
                None => plain(404, "Not found"),
            };
        }

        let asset_path = if path.is_empty() { "index.html".to_string() } else { path };
        let resolver = context.app_handle().asset_resolver();
        match resolver.get(asset_path) {
            Some(asset) => Response::builder()
                .status(200)
                .header("Content-Type", asset.mime_type)
                .body(asset.bytes)
                .expect("static response"),
            None => plain(404, "Not found"),
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "astella-tauri-protocol-{}-{}-{name}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn install_model(root: &Path, model_id: &str, files: &[(&str, &[u8])]) {
        let model_root = root.join("companion-models").join(model_id);
        let entries: Vec<Value> = files
            .iter()
            .map(|(relative, bytes)| {
                let path = model_root.join(relative);
                fs::create_dir_all(path.parent().unwrap()).unwrap();
                let mut handle = fs::File::create(&path).unwrap();
                handle.write_all(bytes).unwrap();
                serde_json::json!({
                    "path": relative,
                    "contentType": "application/json",
                    "byteLength": bytes.len(),
                    "sha256": "0".repeat(64),
                })
            })
            .collect();
        fs::write(
            model_root.join("installed.json"),
            serde_json::json!({
                "version": 1,
                "modelId": model_id,
                "modelVersion": "v1",
                "installedAt": "2026-11-18T00:00:00Z",
                "files": entries,
            })
            .to_string(),
        )
        .unwrap();
    }

    #[test]
    fn model_route_only_serves_installed_and_size_matched_files() {
        let root = scratch("model");
        install_model(&root, "companion-live2d-test-v1", &[("model.json", b"{\"ok\":true}")]);
        assert!(resolve_companion_model_file(&root, "companion-live2d-test-v1/model.json").is_some());
        // 未登记
        assert!(resolve_companion_model_file(&root, "companion-live2d-test-v1/secret.txt").is_none());
        // 穿越
        assert!(resolve_companion_model_file(&root, "companion-live2d-test-v1/../installed.json").is_none());
        // 字节数对不上（标记说 11，磁盘被改）
        fs::write(root.join("companion-models/companion-live2d-test-v1/model.json"), b"short").unwrap();
        assert!(resolve_companion_model_file(&root, "companion-live2d-test-v1/model.json").is_none());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn asr_route_accepts_only_known_names_and_sizes() {
        let root = scratch("asr");
        let models = root.join("voice-models");
        fs::create_dir_all(&models).unwrap();
        fs::write(models.join("tokens.txt"), vec![b'x'; 315_894]).unwrap();
        assert!(resolve_asr_model_file(&root, "tokens.txt").is_some());
        assert!(resolve_asr_model_file(&root, "other.txt").is_none());
        fs::write(models.join("tokens.txt"), b"short").unwrap();
        assert!(resolve_asr_model_file(&root, "tokens.txt").is_none());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn artifact_route_only_serves_uuid_documents() {
        let root = scratch("artifact");
        let artifacts = root.join("artifacts");
        fs::create_dir_all(&artifacts).unwrap();
        let id = "11111111-2222-4333-8444-555555555555";
        fs::write(artifacts.join(format!("{id}.html")), b"<html></html>").unwrap();
        assert!(resolve_artifact_file(&root, id).is_some());
        assert!(resolve_artifact_file(&root, "/../../etc/passwd").is_none());
        assert!(resolve_artifact_file(&root, "not-a-uuid").is_none());
        assert!(resolve_artifact_file(&root, "22222222-3333-4444-8555-666666666666").is_none());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn range_parser_handles_open_and_closed_ranges() {
        assert_eq!(parse_range(Some("bytes=0-9"), 100), Some((0, 9)));
        assert_eq!(parse_range(Some("bytes=90-"), 100), Some((90, 99)));
        assert_eq!(parse_range(Some("bytes=0-999"), 100), Some((0, 99)));
        assert_eq!(parse_range(Some("bytes=100-"), 100), None);
        assert_eq!(parse_range(None, 100), None);
    }
}
