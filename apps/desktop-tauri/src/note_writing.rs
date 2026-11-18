use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde_json::{json, Value};

use crate::opened_files::broker;

const MAX_NOTE_FILE_BYTES: u64 = 100 * 1024 * 1024;

/** 本地稿纸的文件动作（`noteWriting.perform` 的 macOS 阶段子集）。
 *
 * 已实现：open/read/save/image（路径来自系统「打开方式」或已授权的同级目录）。
 * 未实现（回 `unsupported_contract`，交接文档已记）：assets 的图片落盘与 Markdown 重写、
 * export 的 HTML/DOCX 生成、folder 的目录列举、clipboard 的富文本复制。
 * 跨出授权目录的路径一律 `forbidden`——本地文件只认系统真的交过的那一份。
 */
pub struct Outcome {
    pub body: Value,
}

fn authorized(path: &Path) -> bool {
    let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let text = canonical.to_string_lossy().to_string();
    broker().is_authorized(&text) || broker().is_in_authorized_dir(&text)
}

fn revision_of(path: &Path) -> Option<f64> {
    let metadata = std::fs::metadata(path).ok()?;
    let modified = metadata.modified().ok()?;
    modified.duration_since(UNIX_EPOCH).ok().map(|delta| delta.as_millis() as f64)
}

pub(crate) fn decode_note_bytes(bytes: &[u8]) -> Result<String, ()> {
    let strip_bom = |text: &str| text.strip_prefix('\u{FEFF}').unwrap_or(text).to_string();
    if let Ok(text) = std::str::from_utf8(bytes) {
        return Ok(strip_bom(text));
    }
    let (decoded, _, had_errors) = encoding_rs::GBK.decode(bytes);
    if had_errors || decoded.is_empty() {
        return Err(());
    }
    Ok(strip_bom(&decoded))
}

fn mime_for(path: &Path) -> Option<&'static str> {
    let extension = path.extension().and_then(|value| value.to_str()).map(str::to_ascii_lowercase)?;
    match extension.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

/// 把正文里的图片落进 `<stem>.assets/`（同字节同名，sha256 前 20 位），返回改写后的正文。
/// `skip_relative`：保存到原稿纸时，相对地址就是读者目录里的文件，保持原样。
fn localize_images_into_assets(
    path: &Path,
    markdown: &str,
    images: &[(String, String, String)],
    skip_relative: bool,
) -> Result<String, &'static str> {
    if images.is_empty() {
        return Ok(markdown.to_string());
    }
    use sha2::{Digest, Sha256};
    let Some(directory) = path.parent() else { return Err("local_storage_unavailable") };
    let stem = path.file_stem().and_then(|value| value.to_str()).unwrap_or("note");
    let assets_directory = directory.join(format!("{stem}.assets"));
    if std::fs::create_dir_all(&assets_directory).is_err() {
        return Err("local_storage_unavailable");
    }
    let mut replacements = std::collections::HashMap::new();
    for (src, mime, encoded) in images {
        let is_relative = !src.starts_with('/') && !src.contains(':');
        if skip_relative && is_relative {
            continue;
        }
        use base64::Engine;
        let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(encoded) else {
            return Err("validation");
        };
        let suffix = mime.split('/').nth(1).unwrap_or("bin");
        let digest = hex::encode(Sha256::digest(&bytes));
        let name = format!("{}.{}", &digest[..20], suffix);
        if std::fs::write(assets_directory.join(&name), &bytes).is_err() {
            return Err("local_storage_unavailable");
        }
        let relative = assets_directory
            .strip_prefix(directory)
            .map(|prefix| prefix.join(&name))
            .unwrap_or_else(|_| assets_directory.join(&name));
        let encoded_relative: String = relative
            .to_string_lossy()
            .split('/')
            .map(crate::markdown_images::encode_url_segment)
            .collect::<Vec<_>>()
            .join("/");
        replacements.insert(src.clone(), encoded_relative);
    }
    Ok(crate::markdown_images::rewrite_image_paths(markdown, &replacements))
}

fn atomic_write_bytes(path: &Path, bytes: &[u8]) -> Result<(), &'static str> {
    let temporary = path.with_extension(format!("tmp-{}", crate::opened_files::uuid_v4()));
    if std::fs::write(&temporary, bytes).is_err() {
        return Err("local_storage_unavailable");
    }
    if std::fs::rename(&temporary, path).is_err() {
        let _ = std::fs::remove_file(&temporary);
        return Err("local_storage_unavailable");
    }
    Ok(())
}

fn atomic_write(path: &Path, text: &str) -> Result<(), &'static str> {
    let temporary = path.with_extension(format!("tmp-{}", crate::opened_files::uuid_v4()));
    if std::fs::write(&temporary, text.as_bytes()).is_err() {
        return Err("local_storage_unavailable");
    }
    if std::fs::rename(&temporary, path).is_err() {
        let _ = std::fs::remove_file(&temporary);
        return Err("local_storage_unavailable");
    }
    Ok(())
}

/// 导出 HTML：图片转 data URI、正文渲染为片段，再包一层最小文档（标题 + 基础排版）。
pub fn build_export_html(title: &str, markdown: &str, images: &[(String, String, String)]) -> String {
    let mut replacements = std::collections::HashMap::new();
    for (src, mime, encoded) in images {
        if !src.is_empty() && !encoded.is_empty() {
            replacements.insert(src.clone(), format!("data:{mime};base64,{encoded}"));
        }
    }
    let localized = crate::markdown_images::rewrite_image_paths(markdown, &replacements);
    let body = crate::markdown_images::render_html_fragment(&localized);
    format!(
        "<!DOCTYPE html>\n<html lang=\"zh-CN\">\n<head>\n<meta charset=\"utf-8\" />\n<title>{}</title>\n<style>body{{max-width:46rem;margin:2rem auto;padding:0 1rem;font:16px/1.8 -apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;color:#1f2328;}}img{{max-width:100%;height:auto;}}pre{{background:#f6f8fa;padding:1rem;overflow:auto;}}code{{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;}}</style>\n</head>\n<body>\n{}</body>\n</html>\n",
        html_escape_text(title),
        body
    )
}

fn html_escape_text(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// 导出 PDF（macOS）：HTML → 隐藏 WebView → WKWebView `createPDF`（见 `pdf_export.rs`）。
#[cfg(any(target_os = "macos", target_os = "windows"))]
pub async fn export_pdf(input: &Value, app: Option<&tauri::AppHandle>) -> Result<Outcome, &'static str> {
    let app = app.ok_or("local_storage_unavailable")?;
    let title = input.get("title").and_then(Value::as_str).filter(|value| !value.is_empty()).unwrap_or("笔记");
    let Some(markdown) = input.get("markdown").and_then(Value::as_str) else {
        return Err("validation");
    };
    let images: Vec<(String, String, String)> = input
        .get("images")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .take(100)
                .filter_map(|image| {
                    Some((
                        image.get("src")?.as_str()?.to_string(),
                        image.get("mime")?.as_str()?.to_string(),
                        image.get("base64")?.as_str()?.to_string(),
                    ))
                })
                .collect()
        })
        .unwrap_or_default();
    let safe_name: String = title
        .chars()
        .map(|c| if matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || (c as u32) < 0x20 { '-' } else { c })
        .collect();
    let safe_name = safe_name.trim().trim_matches('.').to_string();
    let safe_name: String = if safe_name.is_empty() { "笔记".to_string() } else { safe_name.chars().take(120).collect() };
    let default_name = format!("{safe_name}.pdf");
    let path = match std::env::var("ASTELLA_EXPORT_PATH").ok().filter(|value| !value.is_empty()) {
        Some(path) => PathBuf::from(path),
        None => {
            use tauri_plugin_dialog::DialogExt;
            app.dialog()
                .file()
                .set_file_name(&default_name)
                .add_filter("PDF", &["pdf"])
                .blocking_save_file()
                .and_then(|file| file.into_path().ok())
                .ok_or("canceled")?
        }
    };
    let html = build_export_html(title, markdown, &images);
    #[cfg(target_os = "macos")]
    crate::pdf_export::export_html_to_pdf(app, &html, &path).await?;
    #[cfg(target_os = "windows")]
    crate::pdf_export_windows::export_html_to_pdf(app, &html, &path).await?;
    Ok(Outcome {
        body: json!({
            "path": path.to_string_lossy(),
            "revision": revision_of(&path).unwrap_or(0.0),
        }),
    })
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub async fn export_pdf(_input: &Value, _app: Option<&tauri::AppHandle>) -> Result<Outcome, &'static str> {
    Err("unsupported_contract")
}

/// 剪贴板 HTML：图片先换成 data URI（与 Electron 同义），再渲染 Markdown 片段。
fn build_clipboard_html(markdown: &str, images: &[(String, String, String)]) -> String {
    let mut replacements = std::collections::HashMap::new();
    for (src, mime, encoded) in images {
        if !src.is_empty() && !encoded.is_empty() {
            replacements.insert(src.clone(), format!("data:{mime};base64,{encoded}"));
        }
    }
    let localized = crate::markdown_images::rewrite_image_paths(markdown, &replacements);
    crate::markdown_images::render_html_fragment(&localized)
}

/// 目录扫描：深度 ≤5、条目 ≤500、跳过隐藏；只收 .md/.markdown，名字用相对 root 的路径。
fn scan_markdown_tree(root: &Path) -> Vec<Value> {
    fn walk(directory: &Path, root: &Path, depth: usize, entries: &mut Vec<Value>) {
        if depth > 5 || entries.len() >= 500 {
            return;
        }
        let Ok(read) = std::fs::read_dir(directory) else { return };
        let mut children: Vec<_> = read.flatten().collect();
        children.sort_by_key(|entry| entry.file_name());
        for entry in children {
            if entries.len() >= 500 {
                break;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            let path = entry.path();
            if path.is_dir() {
                walk(&path, root, depth + 1, entries);
            } else if path.is_file() {
                let lower = name.to_ascii_lowercase();
                if lower.ends_with(".md") || lower.ends_with(".markdown") {
                    let relative = path.strip_prefix(root).unwrap_or(&path).to_string_lossy().to_string();
                    entries.push(json!({ "path": path.to_string_lossy(), "name": relative }));
                }
            }
        }
    }
    let mut entries = Vec::new();
    walk(root, root, 0, &mut entries);
    entries.sort_by(|a, b| {
        let left = a.get("name").and_then(Value::as_str).unwrap_or("");
        let right = b.get("name").and_then(Value::as_str).unwrap_or("");
        left.to_lowercase().cmp(&right.to_lowercase())
    });
    entries
}

pub fn perform(input: &Value, app: Option<&tauri::AppHandle>) -> Result<Outcome, &'static str> {
    let action = input.get("action").and_then(Value::as_str).unwrap_or("");
    let path_field = input
        .get("src")
        .and_then(Value::as_str)
        .or_else(|| input.get("path").and_then(Value::as_str))
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    match action {
        "open" | "read" => {
            let path = match path_field {
                Some(path) => path,
                None if action == "open" => {
                    use tauri_plugin_dialog::DialogExt;
                    let app = app.ok_or("local_storage_unavailable")?;
                    let picked = app
                        .dialog()
                        .file()
                        .add_filter("Markdown", &["md", "markdown"])
                        .blocking_pick_file()
                        .and_then(|file| file.into_path().ok());
                    let Some(picked) = picked else {
                        return Ok(Outcome { body: json!({ "canceled": true }) });
                    };
                    if let Some(parent) = picked.parent() {
                        broker().grant_dir(parent);
                    }
                    picked
                }
                None => {
                    if action == "open" {
                        return Ok(Outcome { body: json!({ "canceled": true }) });
                    }
                    return Err("not_found");
                }
            };
            if !authorized(&path) {
                return Err("forbidden");
            }
            let metadata = std::fs::metadata(&path).map_err(|_| "not_found")?;
            if metadata.len() > MAX_NOTE_FILE_BYTES {
                return Err("validation");
            }
            let bytes = std::fs::read(&path).map_err(|_| "not_found")?;
            let text = decode_note_bytes(&bytes).map_err(|_| "unsupported_contract")?;
            Ok(Outcome {
                body: json!({
                    "path": path.to_string_lossy(),
                    "markdown": text,
                    "revision": revision_of(&path).unwrap_or(0.0),
                }),
            })
        }
        "save" | "assets" => {
            let Some(path) = path_field else { return Err("not_found") };
            if !authorized(&path) {
                return Err("forbidden");
            }
            let Some(markdown) = input.get("markdown").and_then(Value::as_str) else {
                return Err("validation");
            };
            let expected = input.get("revision").and_then(Value::as_f64);
            if let Some(expected) = expected {
                let current = revision_of(&path).ok_or("not_found")?;
                if (current - expected).abs() > 0.5 {
                    return Err("conflict");
                }
            }
            let images: Vec<(String, String, String)> = input
                .get("images")
                .and_then(Value::as_array)
                .map(|rows| {
                    rows.iter()
                        .take(100)
                        .filter_map(|image| {
                            Some((
                                image.get("src")?.as_str()?.to_string(),
                                image.get("mime")?.as_str()?.to_string(),
                                image.get("base64")?.as_str()?.to_string(),
                            ))
                        })
                        .collect()
                })
                .unwrap_or_default();
            if images.iter().map(|(_, _, data)| data.len()).sum::<usize>() > 559_240_533 {
                return Err("validation");
            }
            let markdown = localize_images_into_assets(&path, markdown, &images, action == "save")?;
            atomic_write(&path, &markdown)?;
            Ok(Outcome {
                body: json!({
                    "path": path.to_string_lossy(),
                    "markdown": markdown,
                    "revision": revision_of(&path).unwrap_or(0.0),
                }),
            })
        }
        "export" => {
            let format = input.get("format").and_then(Value::as_str).unwrap_or("md");
            if !matches!(format, "md" | "html" | "docx") {
                // PDF 生成未移植（需要 printToPDF 运行时，交接文档已记）。
                return Err("unsupported_contract");
            }
            let title = input.get("title").and_then(Value::as_str).filter(|value| !value.is_empty()).unwrap_or("笔记");
            let Some(markdown) = input.get("markdown").and_then(Value::as_str) else {
                return Err("validation");
            };
            let images: Vec<(String, String, String)> = input
                .get("images")
                .and_then(Value::as_array)
                .map(|rows| {
                    rows.iter()
                        .take(100)
                        .filter_map(|image| {
                            Some((
                                image.get("src")?.as_str()?.to_string(),
                                image.get("mime")?.as_str()?.to_string(),
                                image.get("base64")?.as_str()?.to_string(),
                            ))
                        })
                        .collect()
                })
                .unwrap_or_default();
            let safe_name: String = title
                .chars()
                .map(|c| if matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || (c as u32) < 0x20 { '-' } else { c })
                .collect();
            let safe_name = safe_name.trim().trim_matches('.').to_string();
            let safe_name: String = if safe_name.is_empty() { "笔记".to_string() } else { safe_name.chars().take(120).collect() };
            let default_name = format!("{safe_name}.{format}");
            let path = match std::env::var("ASTELLA_EXPORT_PATH").ok().filter(|value| !value.is_empty()) {
                Some(path) => PathBuf::from(path),
                None => {
                    use tauri_plugin_dialog::DialogExt;
                    let app = app.ok_or("local_storage_unavailable")?;
                    let extension = match format { "html" => "html", "docx" => "docx", _ => "md" };
                    app.dialog()
                        .file()
                        .set_file_name(&default_name)
                        .add_filter(extension.to_uppercase(), &[extension])
                        .blocking_save_file()
                        .and_then(|file| file.into_path().ok())
                        .ok_or("canceled")?
                }
            };
            if format == "md" {
                let localized = localize_images_into_assets(&path, markdown, &images, false)?;
                atomic_write(&path, &localized)?;
                Ok(Outcome {
                    body: json!({
                        "path": path.to_string_lossy(),
                        "markdown": localized,
                        "revision": revision_of(&path).unwrap_or(0.0),
                    }),
                })
            } else if format == "html" {
                let html = build_export_html(title, markdown, &images);
                atomic_write(&path, &html)?;
                Ok(Outcome {
                    body: json!({
                        "path": path.to_string_lossy(),
                        "revision": revision_of(&path).unwrap_or(0.0),
                    }),
                })
            } else {
                let bytes = crate::docx_export::build(title, markdown, &images).map_err(|_| "unsupported_contract")?;
                atomic_write_bytes(&path, &bytes)?;
                Ok(Outcome {
                    body: json!({
                        "path": path.to_string_lossy(),
                        "revision": revision_of(&path).unwrap_or(0.0),
                    }),
                })
            }
        }
        "image" => {
            let Some(path) = path_field else { return Err("not_found") };
            if !authorized(&path) {
                return Err("forbidden");
            }
            let Some(mime) = mime_for(&path) else { return Err("unsupported_contract") };
            let metadata = std::fs::metadata(&path).map_err(|_| "not_found")?;
            if metadata.len() > MAX_NOTE_FILE_BYTES {
                return Err("validation");
            }
            let bytes = std::fs::read(&path).map_err(|_| "not_found")?;
            use base64::Engine;
            Ok(Outcome {
                body: json!({
                    "mime": mime,
                    "base64": base64::engine::general_purpose::STANDARD.encode(&bytes),
                }),
            })
        }
        "folder" => {
            use tauri_plugin_dialog::DialogExt;
            let app = app.ok_or("local_storage_unavailable")?;
            let picked = app
                .dialog()
                .file()
                .blocking_pick_folder()
                .and_then(|file| file.into_path().ok());
            let Some(root) = picked else {
                return Ok(Outcome { body: json!({ "canceled": true }) });
            };
            broker().grant_dir(&root);
            let entries = scan_markdown_tree(&root);
            Ok(Outcome { body: json!({ "path": root.to_string_lossy(), "entries": entries }) })
        }
        "clipboard" => {
            let markdown = input.get("markdown").and_then(Value::as_str).unwrap_or("");
            let html_input = input.get("html").and_then(Value::as_str);
            if markdown.is_empty() && html_input.is_none() {
                return Err("validation");
            }
            if markdown.len() > 5_000_000 || html_input.map(str::len).unwrap_or(0) > 10_000_000 {
                return Err("validation");
            }
            let images: Vec<(String, String, String)> = input
                .get("images")
                .and_then(Value::as_array)
                .map(|rows| {
                    rows.iter()
                        .take(100)
                        .filter_map(|image| {
                            Some((
                                image.get("src")?.as_str()?.to_string(),
                                image.get("mime")?.as_str()?.to_string(),
                                image.get("base64")?.as_str()?.to_string(),
                            ))
                        })
                        .collect()
                })
                .unwrap_or_default();
            let html = match html_input {
                Some(html) => html.to_string(),
                None => build_clipboard_html(markdown, &images),
            };
            let app = app.ok_or("local_storage_unavailable")?;
            if crate::devices::write_clipboard_html(app, html, markdown.to_string()) {
                Ok(Outcome { body: json!({}) })
            } else {
                Err("local_storage_unavailable")
            }
        }
        _ => Err("unsupported_contract"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_export_html_documents() {
        let images = vec![("https://example.com/b.png".to_string(), "image/png".to_string(), "BBBB".to_string())];
        let html = super::build_export_html("我的<笔记>", "# 标题\n\n![图](https://example.com/b.png)\n", &images);
        assert!(html.starts_with("<!DOCTYPE html>"), "{html}");
        assert!(html.contains("<title>我的&lt;笔记&gt;</title>"), "{html}");
        assert!(html.contains("<h1>标题</h1>"), "{html}");
        assert!(html.contains("data:image/png;base64,BBBB"), "{html}");
    }

    #[test]
    fn builds_clipboard_html_with_inline_images() {
        let markdown = "# 标题\n\n正文 ![图](https://example.com/a.png) 结束。\n";
        let images = vec![(
            "https://example.com/a.png".to_string(),
            "image/png".to_string(),
            "AAAA".to_string(),
        )];
        let html = super::build_clipboard_html(markdown, &images);
        assert!(html.contains("<h1>标题</h1>"), "{html}");
        assert!(html.contains("data:image/png;base64,AAAA"), "{html}");
    }

    #[test]
    fn saves_images_into_assets_and_rewrites_markdown() {
        use base64::Engine;
        let root = std::env::temp_dir().join(format!("note-writing-assets-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let paper = root.join("paper.md");
        std::fs::write(&paper, "# 旧").unwrap();
        crate::opened_files::broker().grant_dir(&root);
        let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
        let markdown = "正文 ![图](data:image/png;base64,AAA=)\n\n```md\n![示例](data:image/png;base64,AAA=)\n```\n";
        let input = json!({
            "action": "save",
            "path": paper.to_string_lossy(),
            "markdown": markdown,
            "images": [{ "src": "data:image/png;base64,AAA=", "mime": "image/png", "base64": png }],
        });
        let outcome = super::perform(&input, None).expect("save with images");
        let saved = outcome.body["markdown"].as_str().unwrap();
        assert!(saved.contains("paper.assets/"), "saved: {saved:?}");
        assert!(saved.contains("```md\n![示例](data:image/png;base64,AAA=)"), "code fence was rewritten: {saved}");
        let assets: Vec<_> = std::fs::read_dir(root.join("paper.assets")).unwrap().flatten().collect();
        assert_eq!(assets.len(), 1);
        assert!(assets[0].file_name().to_string_lossy().ends_with(".png"));
        std::fs::remove_dir_all(&root).ok();
        let _ = base64::engine::general_purpose::STANDARD;
    }

    #[test]
    fn scans_markdown_tree_with_depth_and_hidden_rules() {
        let root = std::env::temp_dir().join(format!("note-writing-scan-{}", std::process::id()));
        let nested = root.join("nested");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(root.join("a.md"), "x").unwrap();
        std::fs::write(nested.join("b.markdown"), "x").unwrap();
        std::fs::write(nested.join("c.txt"), "x").unwrap();
        std::fs::write(root.join(".hidden.md"), "x").unwrap();
        let entries = super::scan_markdown_tree(&root);
        let names: Vec<&str> = entries.iter().filter_map(|entry| entry["name"].as_str()).collect();
        assert_eq!(names, vec!["a.md", "nested/b.markdown"]);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn decodes_utf8_and_gbk() {
        assert_eq!(decode_note_bytes("# 标题".as_bytes()).unwrap(), "# 标题");
        let (gbk, _, had_errors) = encoding_rs::GBK.encode("# 标题");
        assert!(!had_errors);
        assert_eq!(decode_note_bytes(&gbk).unwrap(), "# 标题");
    }
}
