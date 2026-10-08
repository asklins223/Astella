import assert from "node:assert/strict";
import test from "node:test";
import { companionCreateNoteV1Schema } from "@astella/shared/companion-note-authoring-contracts";
import { assertGeneratedNoteLinks, companionCreatedNoteId, createdNoteToolResult, readCreatedNoteReceipt } from "../companion-note-authoring.ts";

const NOTE = "11111111-1111-4111-8111-111111111111";
const VERSION = "22222222-2222-4222-8222-222222222222";

test("正文链接、Wiki和HTML都必须来自已核对的笔记，代码中的写法保持字面含义", () => {
  assert.doesNotThrow(() => assertGeneratedNoteLinks(`[欧姆定律](astella-note:${NOTE})`, new Set([NOTE])));
  for (const markdown of [`[假的](astella-note:${NOTE})`, "[[同名但没核对的笔记]]", `<a href="astella-note:${NOTE}">假的</a>`]) {
    assert.throws(() => assertGeneratedNoteLinks(markdown, new Set()), /库内链接还没有核对/);
  }
  assert.doesNotThrow(() => assertGeneratedNoteLinks("`[[字面]]` 和 [公开资料](https://example.com/)", new Set()));
});

test("创建身份稳定，保存回执含可打开的新笔记入口，恢复时只认真实回执形状", () => {
  const receipt = { kind: "created_note" as const, noteId: NOTE, noteVersionId: VERSION, title: "欧姆定律", linkedNotes: [] };
  assert.equal(companionCreatedNoteId(NOTE), companionCreatedNoteId(NOTE));
  assert.notEqual(companionCreatedNoteId(NOTE), companionCreatedNoteId(VERSION));
  const result = createdNoteToolResult(receipt);
  assert.deepEqual(result.blocks, [{ type: "nav", label: "打开《欧姆定律》", route: { kind: "note", noteId: NOTE } }]);
  assert.deepEqual(readCreatedNoteReceipt(result.resultRef!), receipt);
  assert.equal(readCreatedNoteReceipt(JSON.stringify({ kind: "created_note", noteId: NOTE })), null);
  assert.equal(readCreatedNoteReceipt("not json"), null);
});

test("独立笔记允许没有已有材料，关联必须带读取版本与具体关系", () => {
  const input = { title: "电功率", markdown: "电功率表示单位时间内电能转换的多少，需要区分适用条件。" };
  assert.deepEqual(companionCreateNoteV1Schema.parse(input).links, []);
  assert.equal(companionCreateNoteV1Schema.safeParse({ ...input, links: [{ noteId: NOTE, reason: "提供电流和电压的关系" }] }).success, false);
  assert.equal(companionCreateNoteV1Schema.safeParse({ ...input, links: [{ noteId: NOTE, noteVersionId: VERSION, reason: "提供电流和电压的关系" }] }).success, true);
});
