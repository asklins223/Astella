import assert from "node:assert/strict";
import test from "node:test";
import { companionNoteEditTarget } from "../companion-note-edit.ts";

const noteId = "11111111-1111-4111-8111-111111111111";
const noteVersionId = "22222222-2222-4222-8222-222222222222";
const base = { noteId, noteVersionId, markdown: "新内容" };
const page = { context: { noteId, editing: {
  cursor: { block: 1, offset: 2, coordinate: "document", expectedBlock: "光标段落" },
  tail: { block: 5, expectedBlock: "末尾" },
  selection: { startBlock: 2, endBlock: 3, startOffset: 0, endOffset: 2, excerpt: "甲\n\n乙", expectedBlocks: ["甲", "乙"] },
} } };

test("实际编辑工具的锁定范围来自冻结的光标、选区和末尾，不依赖请求关键词", () => {
  for (const [operation, startBlock, endBlock] of [
    ["insert_at_cursor", 1, 1], ["append", 5, 5], ["replace_selection", 2, 3], ["delete_selection", 2, 3],
  ] as const) assert.deepEqual(companionNoteEditTarget({ ...base, operation, ...(operation.startsWith("delete") ? { markdown: undefined } : {}) }, page), { noteId, startBlock, endBlock });
});

test("指定段落直接使用本次工具范围；无对应页面或位置不猜范围", () => {
  assert.deepEqual(companionNoteEditTarget({ ...base, operation: "replace_blocks", startBlock: 0, endBlock: 0, expectedBlocks: ["首段"] }, null), { noteId, startBlock: 0, endBlock: 0 });
  assert.equal(companionNoteEditTarget({ ...base, operation: "replace_selection" }, null), undefined);
  assert.equal(companionNoteEditTarget({ ...base, operation: "append" }, { context: { ...page.context, noteId: noteVersionId } }), undefined);
  assert.equal(companionNoteEditTarget({ ...base, operation: "delete_blocks" }, page), undefined);
});
