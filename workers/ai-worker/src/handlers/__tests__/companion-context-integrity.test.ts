import assert from "node:assert/strict";
import { test } from "node:test";
import { renderCompanionUserTurn } from "../companion-dialogue-content.ts";
import { paginateReadBlocks } from "../companion-read-tools.ts";

test("全文编辑可以完整取得八千字及精确块边界，过长单块保留可续读位置", () => {
  const blocks = Array.from({ length: 55 }, (_, i) => ({ ordinal: i + 1, content: `第${i + 1}块\n` + "正文".repeat(75) }));
  const page = paginateReadBlocks(blocks, 20_000);
  assert.equal(page.endOrdinal, 55);
  assert.equal(page.blockTextTruncated, false);
  assert.deepEqual(page.blocks.map(block => block.content), blocks.map(block => block.content));
  assert.ok(page.blocks.every(block => block.complete && block.startOffset === 0));
  const partial = paginateReadBlocks([{ ordinal: 1, content: "代码".repeat(11_000) }], 20_000);
  assert.equal(partial.blocks[0]?.complete, false);
  assert.equal(partial.nextStartOffset, 20_000);
});
import { boundCompanionRecentHistory } from "../companion-context-handoff.ts";
import { foldReplayUnderSummaryCoverage, replayToMessages } from "../companion-compaction.ts";
import { companionClassifierRecent } from "../companion-tool-intent.ts";

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

test("摘要只覆盖中间一条时，前后没有覆盖的原文仍会发出", () => {
  const folded = foldReplayUnderSummaryCoverage({ system: [], trailing: [],
    tail: [1, 2, 3].map(n => ({ seq: String(n), message: { role: "user", content: `消息${n}` } })),
    coverage: { fromSeq: "2", throughSeq: "2", sourceSha256: "a".repeat(64) },
  });
  assert.deepEqual(replayToMessages(folded.replay).map(m => m.content), ["消息1", "消息3"]);
  assert.equal(folded.receipt?.foldedMessageCount, 1);
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

test("分类器仍可看到长回复结尾的未接邀请", () => {
  const recent = companionClassifierRecent([
    { role: "assistant", content: "长解释".repeat(2000) + "\n要不要接着讲下一步？" },
    { role: "user", content: "你好" },
  ]);
  assert.ok(recent[0]!.content.endsWith("要不要接着讲下一步？"));
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
