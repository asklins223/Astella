import assert from "node:assert/strict";
import { test } from "node:test";
import { renderCompanionUserTurn } from "../turn/companion-dialogue-content.ts";
import { paginateReadBlocks } from "../tools/companion-read-tools.ts";
import { noteBlocksToPmNodes, pmNodesToNoteBlocks } from "@astella/shared/note-doc-schema";

test("读取真实编辑器投影时保留列表类型与Markdown，冲突核对仍用精确content", () => {
  const editable = pmNodesToNoteBlocks(noteBlocksToPmNodes([
    { type: "list", content: "- 晚上：散步二十分钟\n- 回来后：拉伸五分钟" },
  ]));
  const page = paginateReadBlocks(editable.map((block, index) => ({ ...block, ordinal: index + 1 })), 3000);
  assert.equal(page.blocks[0]?.type, "list");
  assert.equal(page.blocks[0]?.content, "晚上：散步二十分钟\n回来后：拉伸五分钟");
  assert.equal(page.body, "- 晚上：散步二十分钟\n- 回来后：拉伸五分钟");
  const partial = paginateReadBlocks([{ ordinal: 1, type: "list", content: "长内容".repeat(80) }], 30);
  assert.equal(partial.blocks[0]?.complete, false);
  assert.equal(partial.body, partial.blocks[0]?.content, "a partial block is never presented as complete Markdown");
});

test("全文编辑可以完整取得八千字及精确块边界，过长单块保留可续读位置", () => {
  const blocks = Array.from({ length: 55 }, (_, i) => ({ ordinal: i + 1, content: `第${i + 1}块\n` + "正文".repeat(75) }));
  const page = paginateReadBlocks(blocks, 20_000);
  assert.equal(page.endOrdinal, 55);
  assert.equal(page.blockTextTruncated, false);
  assert.deepEqual(page.blocks.map(block => block.content), blocks.map(block => block.content));
  assert.ok(page.blocks.every(block => block.complete && block.startOffset === 0));
  assert.deepEqual(page.blocks.map(block => block.blockIndex), Array.from({ length: 55 }, (_, i) => i));
  const partial = paginateReadBlocks([{ ordinal: 1, content: "代码".repeat(11_000) }], 20_000);
  assert.equal(partial.blocks[0]?.complete, false);
  assert.equal(partial.nextStartOffset, 20_000);
  const later = paginateReadBlocks(blocks.slice(20), 3000);
  assert.equal(later.blocks[0]?.blockIndex, 20, "editing coordinates must not restart at each read page");
});
import { boundCompanionRecentHistory } from "../context/companion-context-handoff.ts";
import { foldReplayUnderSummaryCoverage, replayToMessages } from "../context/companion-compaction.ts";

test("服务端接受的长问题完整进入模型，末尾约束不丢", () => {
  const text = "正文".repeat(9000) + "\n关键要求：不要删除原稿。";
  assert.equal(renderCompanionUserTurn(text, null), text);
});

test("近期原文完整保留，短确认不会带走用户刚给的约束", () => {
  const messages = [
    { seq: "1", role: "user" as const, text: "以后别每次都反问我。" },
    { seq: "2", role: "assistant" as const, text: "好。" },
    { seq: "3", role: "user" as const, text: "长材料".repeat(12000) + "结尾条件" },
  ];
  assert.deepEqual(boundCompanionRecentHistory(messages), messages);
});

test("partial summary coverage cannot split consecutive user additions in one exchange", () => {
  const folded = foldReplayUnderSummaryCoverage({ system: [], trailing: [],
    tail: [1, 2, 3].map(n => ({ seq: String(n), message: { role: "user", content: `消息${n}` } })),
    coverage: { fromSeq: "2", throughSeq: "2", sourceSha256: "a".repeat(64) },
  });
  assert.deepEqual(replayToMessages(folded.replay).map(m => m.content), ["消息1", "消息2", "消息3"]);
  assert.equal(folded.receipt, null);
});

test("摘要缺失或非法起点不能证明覆盖，因此不删除原文", () => {
  for (const fromSeq of [null, "invalid", "3"]) {
    const folded = foldReplayUnderSummaryCoverage({ system: [], trailing: [],
      tail: [{ seq: "1", message: { role: "user", content: "重要约定" } }],
      coverage: { fromSeq, throughSeq: "2", sourceSha256: "a".repeat(64) },
    });
    assert.equal(folded.receipt, null);
    assert.equal(folded.replay.tail.length, 1);
  }
});

test("一个超长笔记块可在块内续读，拼接后没有遗漏或重复", () => {
  const content = "正文🙂\\公式".repeat(900) + "关键结论";
  let offset = 0;
  const parts: string[] = [];
  do {
    const page = paginateReadBlocks([{ ordinal: 1, content }], 3000, offset);
    parts.push(page.body);
    assert.equal(page.endOrdinal, 1);
    assert.ok(page.body.length <= 3000);
    if (page.nextStartOffset === null) break;
    assert.ok(page.nextStartOffset > offset);
    offset = page.nextStartOffset;
  } while (true);
  assert.equal(parts.join(""), content);
});

test("分页不会把表格行切成两半，续读拼回原文", () => {
  const content = "前言\n| 项目 | 数值 | 说明 |\n| --- | --- | --- |\n| 速度 | 5 m/s | 匀速 |\n| 时间 | 2 s | 总时长 |\n结尾";
  let offset = 0;
  const parts: string[] = [];
  do {
    const page = paginateReadBlocks([{ ordinal: 1, content }], 24, offset);
    parts.push(page.body);
    if (page.nextStartOffset === null) break;
    assert.ok(page.nextStartOffset > offset);
    offset = page.nextStartOffset;
    assert.ok(parts.length < 20, "分页必须推进，不能卡在同一处");
  } while (true);
  assert.equal(parts.join(""), content);
  for (const part of parts) {
    for (const line of part.split("\n")) {
      if (/^\s*\|/.test(line)) assert.ok(line.trimEnd().endsWith("|"), `表格行被切坏：${line}`);
    }
  }
});

test("分页不会切断行内公式，续读拼回原文", () => {
  const content = "先看公式 $E_k=\\frac{1}{2}mv^2$，再看下一段。";
  let offset = 0;
  const parts: string[] = [];
  do {
    const page = paginateReadBlocks([{ ordinal: 1, content }], 18, offset);
    parts.push(page.body);
    if (page.nextStartOffset === null) break;
    assert.ok(page.nextStartOffset > offset);
    offset = page.nextStartOffset;
  } while (true);
  assert.equal(parts.join(""), content);
  for (const part of parts) {
    assert.equal((part.match(/(?<!\\)\$/g) ?? []).length % 2, 0, `公式被切开：${part}`);
  }
});
