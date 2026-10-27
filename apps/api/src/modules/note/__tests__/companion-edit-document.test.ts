import assert from "node:assert/strict";
import test from "node:test";
import * as Y from "yjs";
import { companionEditNoteV1Schema } from "@astella/shared/companion-note-authoring-contracts";
import { noteBlockMarkdown } from "@astella/shared/note-markdown";
import { applyCompanionNoteEdit, NoteEditConflict } from "../companion-edit-document.ts";
import { emptyFragmentNoteDoc, writeFragmentBlocks, projectFragmentBlocks } from "../doc-fragment.ts";

const base = { noteId: "11111111-1111-4111-8111-111111111111", noteVersionId: "22222222-2222-4222-8222-222222222222" };
function fixture() { const doc = emptyFragmentNoteDoc(); writeFragmentBlocks(doc, [
  { type: "paragraph", content: "甲乙丙丁" }, { type: "paragraph", content: "原段落", sourceRef: { sourceId: base.noteId, segmentId: "s1" } },
  { type: "paragraph", content: "最后一段" },
]); return doc; }
const texts = (doc: Y.Doc) => projectFragmentBlocks(doc).map(b => b.content);

test("在真实光标后插入，不受随后输入框焦点影响", () => {
  const doc = fixture(); applyCompanionNoteEdit(doc, { ...base, operation: "insert_at_cursor", markdown: "**新增**" },
    { cursor: { block: 0, offset: 2, coordinate: "document", expectedBlock: "甲乙丙丁" } });
  assert.equal(texts(doc)[0], "甲乙**新增**丙丁"); doc.destroy();
});
test("源码光标保留 Markdown 语法位置", () => {
  const doc = fixture(); applyCompanionNoteEdit(doc, { ...base, operation: "insert_at_cursor", markdown: "新" },
    { cursor: { block: 0, offset: 2, coordinate: "source", expectedBlock: "甲乙丙丁", sourceText: "甲乙丙丁" } });
  assert.equal(texts(doc)[0], "甲乙新丙丁"); doc.destroy();
});
test("追加、表格和 Mermaid 替换都保存成真实正文，其他节点/来源保留", () => {
  const doc = fixture(), untouched = doc.getXmlFragment("content").get(1);
  applyCompanionNoteEdit(doc, { ...base, operation: "append", markdown: "## 新内容\n\n末尾补充" });
  assert.equal(texts(doc).at(-1), "末尾补充");
  applyCompanionNoteEdit(doc, { ...base, operation: "replace_blocks", preserveBlockStructure: false, startBlock: 0, endBlock: 0, expectedBlocks: ["甲乙丙丁"], markdown: "| 名称 | 说明 |\n| --- | --- |\n| 甲 | 乙 |" });
  assert.match(texts(doc)[0]!, /\| 名称 \| 说明 \|/);
  assert.equal(doc.getXmlFragment("content").get(1), untouched);
  assert.equal(projectFragmentBlocks(doc)[1]?.sourceRef?.segmentId, "s1");
  applyCompanionNoteEdit(doc, { ...base, operation: "replace_blocks", preserveBlockStructure: false, startBlock: 0, endBlock: 0, expectedBlocks: [texts(doc)[0]!], markdown: "```mermaid\nflowchart LR\nA --> B\n```" });
  assert.match(texts(doc)[0]!, /^```mermaid/); doc.destroy();
});
test("只替换选中的原句，段落前后原文保留", () => {
  const doc = fixture(); applyCompanionNoteEdit(doc, { ...base, operation: "replace_selection", markdown: "新增" },
    { selection: { startBlock: 0, endBlock: 0, startOffset: 1, endOffset: 3, excerpt: "乙丙", expectedBlocks: ["甲乙丙丁"] } });
  assert.equal(texts(doc)[0], "甲新增丁"); doc.destroy();
});
test("只改时长不能悄悄把列表变成普通段落，失败时不写入", () => {
  const doc = emptyFragmentNoteDoc();
  writeFragmentBlocks(doc, [{ type: "heading", content: "# 周三散步" },
    { type: "list", content: "- 晚上：散步二十分钟\n- 回来后：拉伸五分钟" }]);
  const original = texts(doc)[1]!, snapshot = Y.encodeStateAsUpdate(doc);
  const edit = { ...base, operation: "replace_blocks" as const, startBlock: 1, endBlock: 1, expectedBlocks: [original] };
  assert.throws(() => applyCompanionNoteEdit(doc, { ...edit,
    markdown: "晚上：散步二十分钟\n回来后：拉伸十分钟" }), /尚未保存/);
  assert.deepEqual(Y.encodeStateAsUpdate(doc), snapshot);
  applyCompanionNoteEdit(doc, { ...edit, markdown: noteBlockMarkdown("list", original).replace("拉伸五分钟", "拉伸十分钟") });
  assert.equal(projectFragmentBlocks(doc)[1]?.type, "list");
  assert.deepEqual(texts(doc), ["# 周三散步", original.replace("拉伸五分钟", "拉伸十分钟")]);
  doc.destroy();
});
test("普通段落改字保留来源，列表不能静默丢失一个项目", () => {
  const doc = fixture();
  applyCompanionNoteEdit(doc, { ...base, operation: "replace_blocks", startBlock: 1, endBlock: 1,
    expectedBlocks: ["原段落"], markdown: "改后的段落" });
  assert.equal(projectFragmentBlocks(doc)[1]?.sourceRef?.segmentId, "s1");
  writeFragmentBlocks(doc, [{ type: "list", content: "- 散步二十分钟\n- 拉伸五分钟" }]);
  const snapshot = Y.encodeStateAsUpdate(doc);
  assert.throws(() => applyCompanionNoteEdit(doc, { ...base, operation: "replace_blocks", startBlock: 0,
    endBlock: 0, expectedBlocks: texts(doc), markdown: "- 散步三十分钟" }), /尚未保存/);
  assert.deepEqual(Y.encodeStateAsUpdate(doc), snapshot); doc.destroy();
});
test("跨段选区与删除段落保留其他内容", () => {
  const doc = fixture(); applyCompanionNoteEdit(doc, { ...base, operation: "delete_selection" },
    { selection: { startBlock: 0, endBlock: 1, startOffset: 2, endOffset: 1, excerpt: "丙丁\n\n原", expectedBlocks: ["甲乙丙丁", "原段落"] } });
  assert.deepEqual(texts(doc), ["甲乙段落", "最后一段"]);
  applyCompanionNoteEdit(doc, { ...base, operation: "delete_blocks", startBlock: 0, endBlock: 1, expectedBlocks: texts(doc) });
  assert.deepEqual(texts(doc), [""]); doc.destroy();
});
test("原文冲突、重复原文的错误位置和缺失光标都拒绝，零文档改动", () => {
  const doc = fixture(), snapshot = Y.encodeStateAsUpdate(doc);
  assert.throws(() => applyCompanionNoteEdit(doc, { ...base, operation: "delete_blocks", startBlock: 1, endBlock: 1, expectedBlocks: ["甲乙丙丁"] }), NoteEditConflict);
  assert.throws(() => applyCompanionNoteEdit(doc, { ...base, operation: "insert_at_cursor", markdown: "新增" }), NoteEditConflict);
  assert.deepEqual(Y.encodeStateAsUpdate(doc), snapshot); doc.destroy();
});
test("其他块的并发输入与 AI 修改收敛，不复制或吞段落", () => {
  const doc = fixture(), peer = new Y.Doc(); Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
  applyCompanionNoteEdit(doc, { ...base, operation: "replace_blocks", startBlock: 0, endBlock: 0, expectedBlocks: ["甲乙丙丁"], markdown: "伴星调整" });
  const text = (peer.getXmlFragment("content").get(2) as Y.XmlElement).get(0) as Y.XmlText; text.insert(text.length, "用户输入");
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer)); Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
  assert.deepEqual(texts(doc), ["伴星调整", "原段落", "最后一段用户输入"]); assert.deepEqual(texts(peer), texts(doc)); doc.destroy(); peer.destroy();
});
test("删除命令不可带新正文，段落范围必须完整可核对", () => {
  assert.equal(companionEditNoteV1Schema.safeParse({ ...base, operation: "delete_blocks", startBlock: 0, endBlock: 1, expectedBlocks: ["甲"] }).success, false);
  assert.equal(companionEditNoteV1Schema.safeParse({ ...base, operation: "delete_selection", markdown: "替换" }).success, false);
});
