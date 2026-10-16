import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { activeCompanionHostContexts, COMPANION_NAVIGATION_TOOL_NAMES, companionCapabilityOfferedInHostContext } from "../companion-host-context.ts";

const read = (name: string) => ({
  name,
  riskClass: name === "companion_read_note" || name === "companion_open_page" ? "read" : "reversible_low",
});

test("没有宿主事实时一律照旧全给：缺省是 fail open", () => {
  const nothing = { writingAnnotation: false, completeNoteReply: false, initiative: false };
  assert.deepEqual([...activeCompanionHostContexts(nothing)], ["user"]);
  for (const name of ["companion_create_note", "companion_edit_note", "companion_search_notes", "把名字写错的能力"]) {
    assert.equal(companionCapabilityOfferedInHostContext(read(name), nothing), true, name);
  }
});

test("三个声明过的能力只在各自宿主上下文里下发", () => {
  const plain = { writingAnnotation: false, completeNoteReply: false, initiative: false };
  const annotation = { ...plain, writingAnnotation: true };
  const noteReply = { ...plain, completeNoteReply: true };
  const initiative = { ...plain, initiative: true };

  // 批注：只有从句子批注入手那一轮才有批注目标，别处这个能力不可能成功。
  assert.equal(companionCapabilityOfferedInHostContext(read("companion_write_annotation"), plain), false);
  assert.equal(companionCapabilityOfferedInHostContext(read("companion_write_annotation"), annotation), true);
  // 整篇正文那一轮直接交付正文，不用分句发言（用了反而与正文分叉）。
  assert.equal(companionCapabilityOfferedInHostContext(read("companion_publish_utterance"), plain), true);
  assert.equal(companionCapabilityOfferedInHostContext(read("companion_publish_utterance"), noteReply), false);
  assert.equal(companionCapabilityOfferedInHostContext(read("companion_publish_utterance"), annotation), true,
    "批注轮仍然分句发言");
  // 收尾发言只存在于主动那一轮。
  assert.equal(companionCapabilityOfferedInHostContext(read("companion_finish_participation"), plain), false);
  assert.equal(companionCapabilityOfferedInHostContext(read("companion_finish_participation"), initiative), true);
});

test("主动那一轮只剩自主能力与非导航只读能力", () => {
  const initiative = { writingAnnotation: false, completeNoteReply: false, initiative: true };
  // 自主能力（她只碰自己的记录）留下。
  assert.equal(companionCapabilityOfferedInHostContext(read("companion_write_self_note"), initiative), true);
  // 非导航的只读能力留下。
  assert.equal(companionCapabilityOfferedInHostContext(read("companion_read_note"), initiative), true);
  // 导航只读能力摘掉：主动轮里"替用户跳页面"是业务操作。
  for (const name of COMPANION_NAVIGATION_TOOL_NAMES) {
    assert.equal(companionCapabilityOfferedInHostContext(read(name), initiative), false, name);
  }
  // 非自主的写类摘掉。
  assert.equal(companionCapabilityOfferedInHostContext(read("companion_create_note"), initiative), false);
});

test("判据在类型上就拿不到本轮意图（2026-10-09 那次翻车的入口）", () => {
  // 源码级判据：这一层只允许吃宿主事实。它一旦读起注意力判定，就会重演
  // 「分类器的一次猜测成了能力总闸」——那次一个做不到的请求（共享笔记）把
  // `act` 降成 `uncertain`，于是 `companion_create_note` 整批被摘。
  const source = readFileSync(new URL("../companion-host-context.ts", import.meta.url), "utf8")
    // 注释里会引用那些字段名（说明它们被有意排除），只看真代码。
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  for (const forbidden of ["toolUse", "attention", "candidateOperations", "interpretation"]) {
    assert.ok(!source.includes(forbidden), `宿主上下文的判据里出现了本轮判定字段：${forbidden}`);
  }
  // 正控制：它确实是靠宿主事实判的（否则上面那条可以是靠"什么都没写"通过的）。
  assert.match(source, /writingAnnotation/);
  assert.match(source, /completeNoteReply/);
  assert.match(source, /initiative/);
});
