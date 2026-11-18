use std::collections::HashMap;

use comrak::nodes::{AstNode, NodeValue};
use comrak::{parse_document, Arena, Options};
use regex::Regex;

/**
 * 笔记 Markdown 的图片地址重写（Electron `rewriteNoteImagePaths` 的 Rust 版）。
 *
 * 用真正的 Markdown AST（comrak）而不是字符串替换：代码块里的示例地址不该被改，
 * 参考式图片要把定义摊平为内联图片；HTML 的 `<img src>` 按同一张映射改。
 * 与 Electron 的差异（交接文档已记）：被摊平的参考式定义保留在文末（合法但冗余），
 * 因为 comrak 在解析期就把引用解析成了 Image 节点，拿不到 identifier。
 */
fn options() -> Options<'static> {
    let mut options = Options::default();
    options.extension.strikethrough = true;
    options.extension.table = true;
    options.extension.autolink = true;
    options.extension.tasklist = true;
    options.extension.math_dollars = true;
    options.extension.front_matter_delimiter = Some("---".to_string());
    options.render.unsafe_ = true;
    options
}

fn line_starts(markdown: &str) -> Vec<usize> {
    let mut starts = vec![0usize];
    for (index, byte) in markdown.bytes().enumerate() {
        if byte == b'\n' {
            starts.push(index + 1);
        }
    }
    starts
}

fn byte_offset(starts: &[usize], line: usize, column: usize) -> Option<usize> {
    let base = *starts.get(line.checked_sub(1)?)?;
    Some(base + column.saturating_sub(1))
}

fn html_img_pattern() -> Regex {
    Regex::new(r#"(?is)(<img\b[^>]*?\bsrc\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s>]+))"#).expect("img regex")
}

fn decode_html_src(src: &str) -> String {
    src.replace("&amp;", "&").replace("&quot;", "\"").replace("&#39;", "'")
}

fn escape_html(src: &str) -> String {
    src.replace('&', "&amp;").replace('"', "&quot;")
}

fn encode_url(src: &str) -> String {
    let mut out = String::with_capacity(src.len());
    for ch in src.chars() {
        match ch {
            '\\' => out.push_str("%5C"),
            '(' => out.push_str("%28"),
            ')' => out.push_str("%29"),
            c if c.is_whitespace() || (c as u32) < 0x20 => {
                let mut buffer = [0u8; 4];
                for byte in c.encode_utf8(&mut buffer).bytes() {
                    out.push_str(&format!("%{byte:02X}"));
                }
            }
            c => out.push(c),
        }
    }
    out
}

fn note_image_markdown(src: &str, alt: &str, title: &str) -> String {
    let label: String = alt
        .chars()
        .flat_map(|ch| match ch {
            '\\' | '[' | ']' => vec!['\\', ch],
            c => vec![c],
        })
        .collect();
    let url = encode_url(src);
    if title.is_empty() {
        format!("![{label}]({url})")
    } else {
        let escaped_title = title.replace('\\', "\\\\").replace('"', "\\\"");
        format!("![{label}]({url} \"{escaped_title}\")")
    }
}

fn rewrite_html(html: &str, replacements: &HashMap<String, String>) -> Option<String> {
    let pattern = html_img_pattern();
    let mut changed = false;
    let output = pattern
        .replace_all(html, |caps: &regex::Captures<'_>| {
            let prefix = &caps[1];
            let double = caps.get(2).map(|m| m.as_str());
            let single = caps.get(3).map(|m| m.as_str());
            let bare = caps.get(4).map(|m| m.as_str());
            let original = double.or(single).or(bare).unwrap_or("");
            let decoded = decode_html_src(original);
            match replacements.get(&decoded) {
                Some(target) => {
                    changed = true;
                    format!("{prefix}\"{}\"", escape_html(target))
                }
                None => caps[0].to_string(),
            }
        })
        .to_string();
    changed.then_some(output)
}

fn html_image_srcs(html: &str, found: &mut Vec<String>) {
    let pattern = html_img_pattern();
    for caps in pattern.captures_iter(html) {
        let original = caps.get(2).or(caps.get(3)).or(caps.get(4)).map(|m| m.as_str()).unwrap_or("");
        let decoded = decode_html_src(original);
        if !decoded.trim().is_empty() && !found.iter().any(|item| item == &decoded) {
            found.push(decoded);
        }
    }
}

/// Markdown → HTML 片段（GFM + 数学 + front matter，与重写共用同一套解析选项）。
pub fn render_html_fragment(markdown: &str) -> String {
    comrak::markdown_to_html(markdown, &options())
}

/// URL 路径的一段：空白与控制字符按百分号编码（其余原样，斜杠由调用方分隔）。
pub fn encode_url_segment(segment: &str) -> String {
    encode_url(segment)
}

/// 正文里的图片地址（去重、按出现顺序）：内联图片、参考式（comrak 已解析成 url）与 HTML `<img>`。
fn push_source(found: &mut Vec<String>, src: &str) {
    let trimmed = src.trim();
    if !trimmed.is_empty() && !found.iter().any(|item| item == trimmed) {
        found.push(trimmed.to_string());
    }
}

pub fn image_sources(markdown: &str) -> Vec<String> {
    let arena = Arena::new();
    let options = options();
    let root = parse_document(&arena, markdown, &options);
    let mut found: Vec<String> = Vec::new();
    for node in root.descendants() {
        match &node.data.borrow().value {
            NodeValue::Image(link) => push_source(&mut found, &link.url),
            NodeValue::HtmlInline(html) => html_image_srcs(html, &mut found),
            NodeValue::HtmlBlock(block) => html_image_srcs(&block.literal, &mut found),
            _ => {}
        }
    }
    found
}

/// 按映射改写图片地址；没命中的保持原样（包括代码块里的示例）。
pub fn rewrite_image_paths(markdown: &str, replacements: &HashMap<String, String>) -> String {
    if replacements.is_empty() {
        return markdown.to_string();
    }
    let arena = Arena::new();
    let options = options();
    let root = parse_document(&arena, markdown, &options);
    let starts = line_starts(markdown);
    let mut edits: Vec<(usize, usize, String)> = Vec::new();
    for node in root.descendants() {
        let (start, end, replacement) = {
            let data = node.data.borrow();
            let sourcepos = data.sourcepos;
            let Some(start) = byte_offset(&starts, sourcepos.start.line, sourcepos.start.column) else { continue };
            let Some(end) = byte_offset(&starts, sourcepos.end.line, sourcepos.end.column).map(|offset| offset + 1) else {
                continue;
            };
            match &data.value {
                NodeValue::Image(link) => match replacements.get(&link.url) {
                    Some(target) => {
                        // mdast 的 alt 是图片节点的纯文本子节点；comrak 也在子节点里给。
                        let alt: String = node
                            .children()
                            .filter_map(|child| match &child.data.borrow().value {
                                NodeValue::Text(text) => Some(text.clone()),
                                _ => None,
                            })
                            .collect();
                        let text = note_image_markdown(target, &alt, &link.title);
                        (start, end, text)
                    }
                    None => continue,
                },
                NodeValue::HtmlInline(html) => match rewrite_html(html, replacements) {
                    Some(text) => (start, end, text),
                    None => continue,
                },
                NodeValue::HtmlBlock(block) => match rewrite_html(&block.literal, replacements) {
                    Some(text) => (start, end, text),
                    None => continue,
                },
                _ => continue,
            }
        };
        edits.push((start, end, replacement));
    }
    edits.sort_by(|a, b| b.0.cmp(&a.0));
    let mut output = markdown.to_string();
    for (start, end, replacement) in edits {
        if start <= end && end <= output.len() {
            output.replace_range(start..end, &replacement);
        }
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect()
    }

    #[test]
    fn rewrites_inline_images_but_not_code_blocks() {
        let source = "# 标题\n\n![图](https://example.com/a.png)\n\n```md\n![示例](https://example.com/a.png)\n```\n";
        let rewritten = rewrite_image_paths(source, &map(&[("https://example.com/a.png", "assets/a.png")]));
        assert!(rewritten.contains("![图](assets/a.png)"), "got: {rewritten}");
        assert!(rewritten.contains("![示例](https://example.com/a.png)"), "code fence was rewritten: {rewritten}");
    }

    #[test]
    fn rewrites_reference_and_html_images() {
        let source = "![引用][ref]\n\n<img src=\"https://example.com/b.png\" width=\"10\" />\n\n[ref]: https://example.com/b.png\n";
        let rewritten = rewrite_image_paths(source, &map(&[("https://example.com/b.png", "assets/b.png")]));
        assert!(rewritten.contains("![引用](assets/b.png)"), "{rewritten}");
        assert!(rewritten.contains("<img src=\"assets/b.png\""), "{rewritten}");
    }

    #[test]
    fn rewrites_data_urls() {
        let out = rewrite_image_paths(
            "正文 ![图](data:image/png;base64,AAA=)\n",
            &map(&[("data:image/png;base64,AAA=", "paper.assets/x.png")]),
        );
        assert!(out.contains("paper.assets/x.png"), "{out}");
    }

    #[test]
    fn rewrites_data_url_before_code_fence() {
        let markdown = "正文 ![图](data:image/png;base64,AAA=)\n\n```md\n![示例](data:image/png;base64,AAA=)\n```\n";
        let out = rewrite_image_paths(markdown, &map(&[("data:image/png;base64,AAA=", "paper.assets/x.png")]));
        assert!(out.contains("paper.assets/x.png"), "{out:?}");
    }

    #[test]
    fn collects_sources_without_duplicates() {
        let source = "![a](https://x/1.png) ![b](https://x/1.png) <img src='https://x/2.png'>";
        assert_eq!(image_sources(source), vec!["https://x/1.png", "https://x/2.png"]);
    }

    #[test]
    fn rewrites_with_cjk_offsets() {
        let source = "第一段。\n\n图片在这里 ![图](https://example.com/中文.png) 结束。\n";
        let rewritten = rewrite_image_paths(source, &map(&[("https://example.com/中文.png", "assets/图片.png")]));
        assert!(rewritten.contains("![图](assets/图片.png)"), "{rewritten}");
    }
}
