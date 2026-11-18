use yrs::updates::decoder::Decode;
use yrs::updates::encoder::Encode;
use yrs::{
    Doc, GetString, Map, ReadTxn, StateVector, Transact, Update, XmlElementPrelim, XmlFragment,
    XmlOut, XmlTextPrelim,
};

/**
 * 笔记协同的 Rust 侧（2026-11-18 Owner 裁决：Rust 兼容 CRDT，采用 yrs）。
 *
 * 文档结构与服务端 `doc-fragment.ts` 一致：`content` 是 XmlFragment（y-prosemirror
 * 结构），`meta` 是标题所在的 Y.Map，`_astella` 是内核锚点。本模块先钉住**字节级
 * 兼容**：用 yrs 产出/接收 Yjs v1 update；hocuspocus 客户端（鉴权帧与同步协议）
 * 在 `collab_client` 里实现。
 */
pub const CONTENT_ROOT: &str = "content";
pub const META_ROOT: &str = "meta";
pub const KERNEL_ROOT: &str = "_astella";

pub fn new_doc() -> Doc {
    Doc::new()
}

/// 写一段「一个段落、一段文字」的最小正文（测试与投影用）。
pub fn seed_paragraph(doc: &mut Doc, text: &str) {
    let fragment = doc.get_or_insert_xml_fragment(CONTENT_ROOT);
    let meta = doc.get_or_insert_map(META_ROOT);
    let mut txn = doc.transact_mut();
    let paragraph = fragment.push_back(&mut txn, XmlElementPrelim::empty("paragraph"));
    paragraph.push_back(&mut txn, XmlTextPrelim::new(text));
    meta.insert(&mut txn, "title", text.to_string());
}

/// 在正文尾部放一段「仅一张图」：`paragraph > image`（编辑器同形），图片节点带 src/alt 属性。
pub fn seed_image(doc: &mut Doc, src: &str, alt: &str) {
    let fragment = doc.get_or_insert_xml_fragment(CONTENT_ROOT);
    let mut txn = doc.transact_mut();
    let paragraph = fragment.push_back(&mut txn, XmlElementPrelim::empty("paragraph"));
    let mut image = XmlElementPrelim::empty("image");
    image.attributes.insert("src".into(), src.to_string());
    image.attributes.insert("alt".into(), alt.to_string());
    paragraph.push_back(&mut txn, image);
}

pub fn content_text(doc: &Doc) -> String {
    // 先取 fragment 再开读事务：反过来会在持读锁时请求写锁而自锁。
    let fragment = doc.get_or_insert_xml_fragment(CONTENT_ROOT);
    let txn = doc.transact();
    let mut out = String::new();
    for child in fragment.children(&txn) {
        if let XmlOut::Element(element) = child {
            for inner in element.children(&txn) {
                if let XmlOut::Text(text) = inner {
                    out.push_str(&text.get_string(&txn));
                }
            }
        }
    }
    out
}

pub fn encode_update(doc: &Doc) -> Vec<u8> {
    doc.transact().encode_state_as_update_v1(&StateVector::default())
}

pub fn apply_update(doc: &mut Doc, update: &[u8]) -> Result<(), String> {
    let parsed = Update::decode_v1(update).map_err(|_| "无法解码 Yjs 增量".to_string())?;
    let mut txn = doc.transact_mut();
    txn.apply_update(parsed).map_err(|_| "无法应用 Yjs 增量".to_string())?;
    Ok(())
}

pub fn state_vector(doc: &Doc) -> Vec<u8> {
    doc.transact().state_vector().encode_v1()
}

/// 对方声明的状态向量 → 本机缺的那一段增量（sync step2 的载荷）。
pub fn diff_update(doc: &Doc, remote_state_vector: &[u8]) -> Result<Vec<u8>, String> {
    let sv = StateVector::decode_v1(remote_state_vector).map_err(|_| "状态向量无法解码".to_string())?;
    Ok(doc.transact().encode_state_as_update_v1(&sv))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn updates_round_trip_between_documents() {
        let mut server = new_doc();
        seed_paragraph(&mut server, "拾星笔记");
        let update = encode_update(&server);

        let mut client = new_doc();
        apply_update(&mut client, &update).expect("apply");
        assert_eq!(content_text(&client), "拾星笔记");
    }

    #[test]
    fn state_vector_only_carries_the_missing_tail() {
        let mut server = new_doc();
        seed_paragraph(&mut server, "第一段");
        let mut client = new_doc();
        apply_update(&mut client, &encode_update(&server)).expect("apply first");

        {
            let fragment = server.get_or_insert_xml_fragment(CONTENT_ROOT);
            let mut txn = server.transact_mut();
            let paragraph = fragment.push_back(&mut txn, XmlElementPrelim::empty("paragraph"));
            paragraph.push_back(&mut txn, XmlTextPrelim::new("第二段"));
        }
        let missing = diff_update(&server, &state_vector(&client)).expect("diff");
        apply_update(&mut client, &missing).expect("apply tail");
        let merged = content_text(&client);
        assert!(merged.contains("第一段") && merged.contains("第二段"), "{merged}");
    }

    #[test]
    fn applying_the_same_update_twice_is_idempotent() {
        let mut server = new_doc();
        seed_paragraph(&mut server, "幂等");
        let update = encode_update(&server);
        let mut client = new_doc();
        apply_update(&mut client, &update).expect("first");
        apply_update(&mut client, &update).expect("second");
        assert_eq!(content_text(&client), "幂等");
    }
}
