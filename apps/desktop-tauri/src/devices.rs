use std::time::Duration;

use regex::Regex;

/**
 * 设备级能力（迁移切片 4）：剪贴板与外链。
 *
 * 剪贴板读取只把**命中的至多 3 个 http(s) 地址**交给渲染层（与 Electron
 * 同一隐私边界）：剪贴板原文永远不出主进程。链接提取规则逐条对齐
 * `@astella/shared` 的 `extractCandidateLinks` 与 `isWebLinkUrl`。
 */
const MAX_CANDIDATE_LINKS: usize = 3;
const MAX_CANDIDATE_LINK_LENGTH: usize = 2048;

pub fn extract_candidate_links(text: &str) -> Vec<String> {
    let pattern = Regex::new(r#"(?i)https?://[^\s<>"'\x60，。；：！？）】》]+"#).expect("link pattern");
    let trailing = Regex::new(r#"[.,;:!?)}\]'"'"，。；：！？）】》]+$"#).expect("trailing pattern");
    let mut found: Vec<String> = Vec::new();
    for capture in pattern.find_iter(text) {
        let candidate = trailing.replace(capture.as_str(), "").to_string();
        if candidate.is_empty() || candidate.len() > MAX_CANDIDATE_LINK_LENGTH {
            continue;
        }
        let Ok(url) = reqwest::Url::parse(&candidate) else { continue };
        if !matches!(url.scheme(), "http" | "https") || !url.username().is_empty() || url.password().is_some() {
            continue;
        }
        if found.iter().any(|existing| existing == &candidate) {
            continue;
        }
        found.push(candidate);
        if found.len() >= MAX_CANDIDATE_LINKS {
            break;
        }
    }
    found
}

pub fn is_web_link(value: &str) -> bool {
    if value.is_empty() || value.len() > MAX_CANDIDATE_LINK_LENGTH {
        return false;
    }
    reqwest::Url::parse(value).map(|url| matches!(url.scheme(), "http" | "https")).unwrap_or(false)
}

fn on_main_thread<T: Send + 'static>(
    app: &tauri::AppHandle,
    action: impl FnOnce() -> T + Send + 'static,
) -> Option<T> {
    let (sender, receiver) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = sender.send(action());
    })
    .ok()?;
    receiver.recv_timeout(Duration::from_secs(2)).ok()
}

pub fn read_clipboard_text(app: &tauri::AppHandle) -> Option<String> {
    on_main_thread(app, || arboard::Clipboard::new().ok().and_then(|mut clipboard| clipboard.get_text().ok()))
        .flatten()
}

pub fn write_clipboard_text(app: &tauri::AppHandle, text: String) -> bool {
    on_main_thread(app, move || {
        arboard::Clipboard::new()
            .and_then(|mut clipboard| clipboard.set_text(text))
            .is_ok()
    })
    .unwrap_or(false)
}

/// 富文本写入：HTML + 纯文本备选（Electron 的 text/html + text/plain 双写）。
pub fn write_clipboard_html(app: &tauri::AppHandle, html: String, alt_text: String) -> bool {
    on_main_thread(app, move || {
        arboard::Clipboard::new()
            .and_then(|mut clipboard| clipboard.set().html(html, Some(alt_text)))
            .is_ok()
    })
    .unwrap_or(false)
}

pub fn open_external(url: &str) -> bool {
    if !is_web_link(url) {
        return false;
    }
    open::that_detached(url).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_at_most_three_deduped_web_links() {
        let text = "看这个 https://example.com/a。还有 http://localhost:4000/b，以及 https://example.com/a 重复，https://third.example/c/d?e=1，https://fourth.example 不该出现";
        let links = extract_candidate_links(text);
        assert_eq!(links, vec![
            "https://example.com/a".to_string(),
            "http://localhost:4000/b".to_string(),
            "https://third.example/c/d?e=1".to_string(),
        ]);
    }

    #[test]
    fn rejects_non_web_and_userinfo_links() {
        assert!(extract_candidate_links("ftp://example.com/x").is_empty());
        assert!(extract_candidate_links("https://user:pass@example.com/x").is_empty());
        assert!(!is_web_link("file:///etc/passwd"));
        assert!(!is_web_link("javascript:alert(1)"));
        assert!(is_web_link("https://example.com"));
    }

    #[test]
    fn strips_trailing_punctuation() {
        assert_eq!(extract_candidate_links("见 https://example.com/a).").as_slice(), ["https://example.com/a"]);
        assert_eq!(extract_candidate_links("（https://example.com/b）").as_slice(), ["https://example.com/b"]);
    }
}
