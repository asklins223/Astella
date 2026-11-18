use std::collections::HashMap;
use std::io::{Cursor, Write, Read};

use comrak::nodes::{AstNode, NodeValue};
use comrak::{parse_document, Arena, Options};
use serde_json::{json, Value};

/**
 * 笔记导出为 Word（`noteWriting.export` 的 docx 格式）。
 *
 * 手写最小 WordprocessingML（docx = 一个 zip 包）：标题/正文/粗斜体/行内代码/列表/引用/
 * 代码块/表格/图片。与 Electron（`docx` 库）的已知差异，交接文档同步记录：
 * - 数学公式降级为原文文字；嵌套列表与编号样式简化；图片只嵌 PNG/JPEG/GIF（Word 不认 WebP，
 *   Electron 会转码，这里跳过该图并在 alt 文本里保留文件名）。
 * 生成的包结构：`[Content_Types].xml`、`_rels/.rels`、`word/document.xml`、
 * `word/_rels/document.xml.rels`、`word/styles.xml`、`word/media/…`。
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

fn xml_escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

fn image_size(bytes: &[u8], mime: &str) -> Option<(u32, u32)> {
    match mime {
        "image/png" if bytes.len() >= 24 && &bytes[..8] == b"\x89PNG\r\n\x1a\n" => {
            let width = u32::from_be_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]);
            let height = u32::from_be_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]);
            Some((width, height))
        }
        "image/jpeg" => {
            let mut index = 2usize;
            while index + 9 < bytes.len() {
                if bytes[index] != 0xFF {
                    index += 1;
                    continue;
                }
                let marker = bytes[index + 1];
                if (0xC0..=0xC3).contains(&marker) {
                    let height = u16::from_be_bytes([bytes[index + 5], bytes[index + 6]]) as u32;
                    let width = u16::from_be_bytes([bytes[index + 7], bytes[index + 8]]) as u32;
                    return Some((width, height));
                }
                let length = u16::from_be_bytes([bytes[index + 2], bytes[index + 3]]) as usize;
                index += 2 + length;
            }
            None
        }
        "image/gif" if bytes.len() >= 10 => {
            let width = u16::from_le_bytes([bytes[6], bytes[7]]) as u32;
            let height = u16::from_le_bytes([bytes[8], bytes[9]]) as u32;
            Some((width, height))
        }
        _ => None,
    }
}

struct Media {
    rels_xml: String,
    content_types: String,
    files: Vec<(String, Vec<u8>)>,
}

fn inline_runs<'a>(
    node: &'a AstNode<'a>,
    formatting: &str,
    media: &mut Media,
    images: &HashMap<String, (String, Vec<u8>)>,
) -> String {
    let mut out = String::new();
    for child in node.children() {
        let data = child.data.borrow();
        match &data.value {
            NodeValue::Text(text) => {
                let run_props = if formatting.is_empty() { String::new() } else { format!("<w:rPr>{formatting}</w:rPr>") };
                out.push_str(&format!("<w:r>{run_props}<w:t xml:space=\"preserve\">{}</w:t></w:r>", xml_escape(text)));
            }
            NodeValue::Strong => out.push_str(&inline_runs(child, &format!("{formatting}<w:b/>"), media, images)),
            NodeValue::Emph => out.push_str(&inline_runs(child, &format!("{formatting}<w:i/>"), media, images)),
            NodeValue::Strikethrough => out.push_str(&inline_runs(child, &format!("{formatting}<w:strike/>"), media, images)),
            NodeValue::Code(code) => out.push_str(&format!(
                "<w:r><w:rPr>{}<w:rStyle w:val=\"InlineCode\"/></w:rPr><w:t xml:space=\"preserve\">{}</w:t></w:r>",
                if formatting.is_empty() { String::new() } else { format!("{formatting}") },
                xml_escape(&code.literal)
            )),
            NodeValue::Link(link) => {
                let text = inline_runs(child, formatting, media, images);
                out.push_str(&text);
                if !link.url.is_empty() {
                    out.push_str(&format!("<w:r><w:rPr><w:color w:val=\"1155CC\"/></w:rPr><w:t xml:space=\"preserve\"> ({})</w:t></w:r>", xml_escape(&link.url)));
                }
            }
            NodeValue::Image(link) => {
                let alt = link.title.trim();
                match images.get(&link.url) {
                    Some((mime, bytes)) if matches!(mime.as_str(), "image/png" | "image/jpeg" | "image/gif") => {
                        let extension = mime.rsplit('/').next().unwrap_or("png");
                        let name = format!("image{}.{}", media.files.len() + 1, extension);
                        let (width, height) = image_size(bytes, mime).unwrap_or((640, 480));
                        let index = media.files.len() + 1;
                        media.files.push((name.clone(), bytes.clone()));
                        media.rels_xml.push_str(&format!(
                            "<Relationship Id=\"rIdImg{index}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/image\" Target=\"media/{name}\"/>"
                        ));
                        media.content_types.push_str(&format!(
                            "<Default Extension=\"{extension}\" ContentType=\"{mime}\"/>"
                        ));
                        out.push_str(&format!(
                            "<w:r><w:drawing><wp:inline distT=\"0\" distB=\"0\" distL=\"0\" distR=\"0\"><wp:extent cx=\"{cx}\" cy=\"{cy}\"/><wp:docPr id=\"{index}\" name=\"{name}\"/><a:graphic><a:graphicData uri=\"http://schemas.openxmlformats.org/drawingml/2006/picture\"><pic:pic><pic:nvPicPr><pic:cNvPr id=\"{index}\" name=\"{name}\"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed=\"rIdImg{index}\"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"{cx}\" cy=\"{cy}\"/></a:xfrm><a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>",
                            cx = width as u64 * 9525,
                            cy = height as u64 * 9525
                        ));
                    }
                    _ => {
                        let label = if alt.is_empty() { link.url.as_str() } else { alt };
                        out.push_str(&format!(
                            "<w:r><w:rPr><w:color w:val=\"888888\"/></w:rPr><w:t xml:space=\"preserve\">[图片 {label} 未能嵌入 Word]</w:t></w:r>",
                            label = xml_escape(label)
                        ));
                    }
                }
            }
            NodeValue::SoftBreak | NodeValue::LineBreak => out.push_str("<w:r><w:br/></w:r>"),
            NodeValue::Math(math) => {
                out.push_str(&format!("<w:r><w:t xml:space=\"preserve\">{}</w:t></w:r>", xml_escape(&math.literal)));
            }
            _ => out.push_str(&inline_runs(child, formatting, media, images)),
        }
    }
    out
}

fn paragraph(style: Option<&str>, runs: &str) -> String {
    match style {
        Some(style) => format!("<w:p><w:pPr><w:pStyle w:val=\"{style}\"/></w:pPr>{runs}</w:p>"),
        None => format!("<w:p>{runs}</w:p>"),
    }
}

fn code_block(code: &comrak::nodes::NodeCodeBlock) -> String {
    let mut out = String::new();
    for (index, line) in code.literal.split('\n').enumerate() {
        if index > 0 {
            out.push_str("<w:r><w:br/></w:r>");
        }
        out.push_str(&format!("<w:r><w:t xml:space=\"preserve\">{}</w:t></w:r>", xml_escape(line)));
    }
    paragraph(Some("CodeBlock"), &out)
}

fn render_blocks<'a>(
    node: &'a AstNode<'a>,
    media: &mut Media,
    images: &HashMap<String, (String, Vec<u8>)>,
    out: &mut String,
    depth: usize,
    ordered: bool,
) {
    let mut counter = 0usize;
    for child in node.children() {
        let value = child.data.borrow().value.clone();
        match &value {
            NodeValue::Heading(heading) => {
                let level = heading.level.clamp(1, 3);
                out.push_str(&paragraph(Some(&format!("Heading{level}")), &inline_runs(child, "", media, images)));
            }
            NodeValue::Paragraph => out.push_str(&paragraph(None, &inline_runs(child, "", media, images))),
            NodeValue::CodeBlock(code) => out.push_str(&code_block(code)),
            NodeValue::BlockQuote => render_blocks(child, media, images, out, depth + 1, false),
            NodeValue::Item(_) | NodeValue::TaskItem(_) => {
                counter += 1;
                let prefix = if ordered { format!("{counter}. ") } else { "• ".to_string() };
                let mut runs = format!("<w:r><w:t xml:space=\"preserve\">{prefix}</w:t></w:r>");
                for inner in child.children() {
                    let inner_value = inner.data.borrow().value.clone();
                    match inner_value {
                        NodeValue::Paragraph => runs.push_str(&inline_runs(inner, "", media, images)),
                        _ => render_blocks(inner, media, images, out, depth + 1, false),
                    }
                }
                out.push_str(&paragraph(Some("ListParagraph"), &runs));
            }
            NodeValue::List(list) => render_blocks(child, media, images, out, depth, !matches!(list.list_type, comrak::nodes::ListType::Bullet)),
            NodeValue::Table(_) => {
                out.push_str("<w:tbl><w:tblPr><w:tblBorders><w:top w:val=\"single\" w:sz=\"4\"/><w:left w:val=\"single\" w:sz=\"4\"/><w:bottom w:val=\"single\" w:sz=\"4\"/><w:right w:val=\"single\" w:sz=\"4\"/><w:insideH w:val=\"single\" w:sz=\"4\"/><w:insideV w:val=\"single\" w:sz=\"4\"/></w:tblBorders></w:tblPr>");
                for row in child.children() {
                    out.push_str("<w:tr>");
                    for cell in row.children() {
                        out.push_str("<w:tc>");
                        for inner in cell.children() {
                            out.push_str(&paragraph(None, &inline_runs(inner, "", media, images)));
                        }
                        out.push_str("</w:tc>");
                    }
                    out.push_str("</w:tr>");
                }
                out.push_str("</w:tbl>");
            }
            NodeValue::ThematicBreak => out.push_str("<w:p><w:pPr><w:pBdr><w:bottom w:val=\"single\" w:sz=\"6\"/></w:pBdr></w:pPr></w:p>"),
            NodeValue::HtmlBlock(block) => {
                let text = crate::markdown_images::render_html_fragment(&block.literal);
                let stripped: String = regex::Regex::new("<[^>]+>").expect("tag regex").replace_all(&text, "").to_string();
                if !stripped.trim().is_empty() {
                    out.push_str(&paragraph(None, &format!("<w:r><w:t xml:space=\"preserve\">{}</w:t></w:r>", xml_escape(stripped.trim()))));
                }
            }
            NodeValue::FrontMatter(_) => {}
            _ => render_blocks(child, media, images, out, depth, false),
        }
    }
}

pub fn build(title: &str, markdown: &str, images: &[(String, String, String)]) -> Result<Vec<u8>, ()> {
    let image_map: HashMap<String, (String, Vec<u8>)> = images
        .iter()
        .filter_map(|(src, mime, base64)| {
            use base64::Engine;
            let bytes = base64::engine::general_purpose::STANDARD.decode(base64).ok()?;
            Some((src.clone(), (mime.clone(), bytes)))
        })
        .collect();
    let arena = Arena::new();
    let root = parse_document(&arena, markdown, &options());
    let mut media = Media { rels_xml: String::new(), content_types: String::new(), files: Vec::new() };
    let mut body = String::new();
    render_blocks(root, &mut media, &image_map, &mut body, 0, false);
    if body.is_empty() {
        body.push_str(&paragraph(None, "<w:r><w:t xml:space=\"preserve\"></w:t></w:r>"));
    }
    let content_types = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/><Override PartName=\"/word/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml\"/>{}</Types>",
        media.content_types
    );
    let rels = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"word/document.xml\"/></Relationships>";
    let document = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\" xmlns:wp=\"http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing\" xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" xmlns:pic=\"http://schemas.openxmlformats.org/drawingml/2006/picture\"><w:body>{body}<w:sectPr><w:pgSz w:w=\"11906\" w:h=\"16838\"/><w:pgMar w:top=\"1134\" w:right=\"1134\" w:bottom=\"1134\" w:left=\"1134\"/></w:sectPr></w:body></w:document>"
    );
    let document_rels = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">{}</Relationships>",
        media.rels_xml
    );
    let styles = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><w:styles xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:style w:type=\"paragraph\" w:styleId=\"Heading1\"><w:name w:val=\"heading 1\"/><w:basedOn w:val=\"Normal\"/><w:pPr><w:spacing w:before=\"240\" w:after=\"120\"/></w:pPr><w:rPr><w:b/><w:sz w:val=\"40\"/></w:rPr></w:style><w:style w:type=\"paragraph\" w:styleId=\"Heading2\"><w:name w:val=\"heading 2\"/><w:basedOn w:val=\"Normal\"/><w:pPr><w:spacing w:before=\"200\" w:after=\"100\"/></w:pPr><w:rPr><w:b/><w:sz w:val=\"32\"/></w:rPr></w:style><w:style w:type=\"paragraph\" w:styleId=\"Heading3\"><w:name w:val=\"heading 3\"/><w:basedOn w:val=\"Normal\"/><w:pPr><w:spacing w:before=\"160\" w:after=\"80\"/></w:pPr><w:rPr><w:b/><w:sz w:val=\"28\"/></w:rPr></w:style><w:style w:type=\"paragraph\" w:styleId=\"CodeBlock\"><w:name w:val=\"Code Block\"/><w:basedOn w:val=\"Normal\"/><w:pPr><w:shd w:val=\"clear\" w:fill=\"F6F8FA\"/></w:pPr><w:rPr><w:rFonts w:ascii=\"Menlo\" w:hAnsi=\"Menlo\"/><w:sz w:val=\"20\"/></w:rPr></w:style><w:style w:type=\"character\" w:styleId=\"InlineCode\"><w:name w:val=\"Inline Code\"/><w:rPr><w:rFonts w:ascii=\"Menlo\" w:hAnsi=\"Menlo\"/><w:sz w:val=\"20\"/></w:rPr></w:style><w:style w:type=\"paragraph\" w:styleId=\"ListParagraph\"><w:name w:val=\"List Paragraph\"/><w:basedOn w:val=\"Normal\"/><w:pPr><w:ind w:left=\"420\"/></w:pPr></w:style><w:style w:type=\"paragraph\" w:default=\"1\" w:styleId=\"Normal\"><w:name w:val=\"Normal\"/><w:pPr><w:spacing w:after=\"160\"/></w:pPr></w:style></w:styles>";
    let document_with_title = if title.trim().is_empty() {
        document
    } else {
        document.replace("<w:body>", &format!("<w:body><w:p><w:r><w:rPr><w:b/><w:sz w:val=\"48\"/></w:rPr><w:t xml:space=\"preserve\">{}</w:t></w:r></w:p>", xml_escape(title.trim())))
    };
    let cursor = Cursor::new(Vec::new());
    let mut writer = zip::ZipWriter::new(cursor);
    let options: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let mut add = |name: &str, bytes: &[u8]| -> Result<(), ()> {
        writer.start_file(name, options).map_err(|_| ())?;
        writer.write_all(bytes).map_err(|_| ())
    };
    add("[Content_Types].xml", content_types.as_bytes())?;
    add("_rels/.rels", rels.as_bytes())?;
    add("word/document.xml", document_with_title.as_bytes())?;
    add("word/_rels/document.xml.rels", document_rels.as_bytes())?;
    add("word/styles.xml", styles.as_bytes())?;
    for (name, bytes) in &media.files {
        add(&format!("word/media/{name}"), bytes)?;
    }
    let cursor = writer.finish().map_err(|_| ())?;
    let mut out = Vec::new();
    let mut reader = Cursor::new(cursor.into_inner());
    reader.read_to_end(&mut out).map_err(|_| ())?;
    Ok(out)
}

pub fn _unused_marker() -> Value { json!(null) }

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "macos")]
    #[test]
    fn word_extracts_the_text_back() {
        let bytes = super::build("探针标题", "# 第一节\n\n正文一段。\n", &[]).expect("docx");
        let path = std::env::temp_dir().join(format!("docx-probe-{}.docx", std::process::id()));
        std::fs::write(&path, &bytes).unwrap();
        let output = std::process::Command::new("textutil")
            .args(["-convert", "txt", "-stdout"])
            .arg(&path)
            .output()
            .expect("textutil");
        let text = String::from_utf8_lossy(&output.stdout).to_string();
        std::fs::remove_file(&path).ok();
        assert!(text.contains("探针标题"), "textutil: {text}");
        assert!(text.contains("第一节"), "textutil: {text}");
        assert!(text.contains("正文一段。"), "textutil: {text}");
    }

    #[test]
    fn builds_a_readable_docx_package() {
        let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
        let images = vec![("data:image/png;base64,AAA=".to_string(), "image/png".to_string(), png.to_string())];
        let markdown = "# 标题\n\n正文 **粗** *斜* `code`\n\n- 一\n- 二\n\n```rs\nfn main() {}\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n![图](data:image/png;base64,AAA=)\n";
        let bytes = super::build("我的笔记", markdown, &images).expect("docx bytes");
        let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).expect("zip");
        let mut document = String::new();
        archive.by_name("word/document.xml").unwrap().read_to_string(&mut document).unwrap();
        assert!(document.contains("我的笔记"));
        assert!(document.contains("<w:b/>"));
        assert!(document.contains("Heading1"));
        assert!(document.contains("<w:tbl>"));
        assert!(document.contains("rIdImg1"));
        assert!(archive.by_name("word/media/image1.png").is_ok());
    }
}
