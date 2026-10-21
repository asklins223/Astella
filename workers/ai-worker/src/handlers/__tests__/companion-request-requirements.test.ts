import assert from "node:assert/strict";
import { test } from "node:test";
import { companionRequestRequirements as requirements, companionRequirementIssue as issue, companionVisibleCharacterCount, companionReceiptOnlyNoteRequest as receiptOnly, companionUtteranceRequirementIssue } from "../turn/companion-request-requirements.ts";
import type { AgentTurnRequest } from "@astella/shared";
import { createdNoteToolResult } from "../note/companion-note-authoring.ts";

test("separate message counts use actual publication receipts and never treat final=false as complete", () => {
  const requested = requirements("分两条跟我说，先问好，再问今天想先做什么。");
  assert.equal(requested.utteranceCount, 2);
  assert.equal(requirements("不要分两条发给我，只说一句。").utteranceCount, undefined);
  const messages: AgentTurnRequest["messages"] = [
    { role: "assistant", content: "", toolCalls: [{ id: "first", name: "companion_publish_utterance", arguments: { text: "你好", final: false } }] },
    { role: "tool", toolCallId: "first", content: '{"ok":true,"data":{"messageId":"message-one","published":true}}' },
  ];
  assert.match(companionUtteranceRequirementIssue(requested, messages)!.instruction, /真实发布只有 1 条/);
  assert.ok(companionUtteranceRequirementIssue({}, messages));
  messages.push({ role: "assistant", content: "", toolCalls: [{ id: "last", name: "companion_publish_utterance", arguments: { text: "今天想先做什么？", final: true } }] },
    { role: "tool", toolCallId: "last", content: JSON.stringify({ ok: true, resultRef: JSON.stringify({ messageId: "message-two", published: true }) }) });
  assert.equal(companionUtteranceRequirementIssue(requested, messages), null);
  assert.equal(companionUtteranceRequirementIssue({}, messages), null);
  messages[3]!.content = '{"ok":false}';
  assert.ok(companionUtteranceRequirementIssue(requested, messages));
});

test("explicit current-turn length is checked without a model judge", () => {
  const requested = requirements("给我写一个约400字、有完整结尾的故事");
  assert.deepEqual(requested.characters, { min: 340, max: 460 });
  assert.ok(issue(requested, "这".repeat(114)));
  assert.equal(issue(requested, "这".repeat(400)), null);
  assert.deepEqual(requirements("恰好二百字的短文").characters, { min: 200, max: 200 });
  assert.deepEqual(requirements("至少三百字的介绍").characters, { min: 300, max: Infinity });
  assert.equal(companionVisibleCharacterCount("[excited]你好，世界！\n```js\nignored\n```"), 4);
  assert.equal(companionVisibleCharacterCount("阅读[秦朝](note://00000000-0000-4000-8000-000000000001)。"), 4);
  assert.equal(companionVisibleCharacterCount("阅读[秦朝](https://example.com/a-very-long-address)。"), 4);
  assert.equal(companionVisibleCharacterCount("## 标题不能凑字数\n\n这是正文。"), 4);
  assert.equal(requirements("不要写400字的故事").characters, undefined);
  assert.deepEqual(requirements("别写400字，写200字的故事").characters, { min: 170, max: 230 });
  assert.equal(requirements("解释一下‘400字’这句话").characters, undefined);
  assert.deepEqual(requirements("生成三篇中国历史笔记。每篇约300字，包含关键事实与结尾。").noteCharacters, { min: 255, max: 345 });
  assert.equal(requirements("写一篇300字的小说").noteCharacters, undefined);
});

test("three actual note-tool result envelopes fulfill the request before and after checkpoint replay", () => {
  const requested = requirements("给我写三篇历史笔记", true);
  const saved = [1, 2, 3].map(index => createdNoteToolResult({ kind: "created_note",
    noteId: `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`,
    noteVersionId: `22222222-2222-4222-8222-${String(index).padStart(12, "0")}`,
    title: ["秦朝", "汉朝", "唐朝"][index - 1], linkedNotes: [] }));
  const fresh = saved.map(result => ({ role: "tool" as const,
    content: JSON.stringify({ ok: true, data: result.value, summary: result.safeSummary }) }));
  const replay = saved.map(result => ({ role: "tool" as const,
    content: JSON.stringify({ ok: true, resultRef: result.resultRef, summary: result.safeSummary }) }));
  assert.equal(issue(requested, "三篇笔记都保存好了。", fresh), null);
  assert.equal(issue(requested, "三篇笔记都保存好了。", replay), null);
  assert.match(issue(requested, "", [fresh[0], replay[0], fresh[1]])!.instruction, /只有 2 篇/);
  assert.ok(issue(requested, "已完成", fresh.map(message => ({ ...message,
    content: message.content.replace('"status":"succeeded"', '"status":"executing"') }))));
  assert.ok(issue(requested, "已完成", replay.map(message => ({ ...message,
    content: message.content.replace('"ok":true', '"ok":false') }))));
});
test("saved note count uses distinct durable receipts and respects the allowed surface", () => {
  const requested = requirements("写三篇历史笔记，每篇约400字", true);
  assert.equal(requested.noteCount, 3); assert.equal(requested.characters, undefined);
  assert.deepEqual(requested.noteCharacters, { min: 340, max: 460 });
  const receipt = { kind: "created_note", noteId: "11111111-1111-4111-8111-111111111111", noteVersionId: "22222222-2222-4222-8222-222222222222", title: "秦朝", linkedNotes: [] };
  const tool = { role: "tool" as const, content: JSON.stringify({ ok: true, data: receipt }) };
  assert.match(issue(requested, "写好了三篇", [tool, tool])!.instruction, /只有 1 篇/);
  assert.equal(requirements("写三篇历史笔记", false).noteCount, undefined);
  assert.equal(requirements("什么是400字的总结？").characters, undefined);
});

test("receipts settle a plain save request but never swallow an additional answer or follow-up", () => {
  const text = "生成三篇中国历史笔记，每篇约300字，包含关键事实与结尾。";
  assert.equal(receiptOnly(text, true, requirements(text, true)), true);
  assert.equal(receiptOnly(text, false, requirements(text, true)), false);
  assert.equal(receiptOnly(text, true, {}), false);
  for (const extra of ["并且解释秦朝为何灭亡", "然后对比汉唐制度", "另外回答我的问题", "同时总结差异"])
    assert.equal(receiptOnly(`${text}${extra}`, true, requirements(text, true)), false);
});

test("an explicit calculation-tool request requires a successful current-run receipt", () => {
  const requested = requirements("请用计算工具核对347×29。", false, ["agent_calculate"]);
  assert.deepEqual(requested.requiredTools, ["agent_calculate"]);
  assert.ok(issue(requested, "结果是10063，但未核验。"));
  const calls = [{ id: "calculation", name: "agent_calculate", arguments: {} }];
  assert.equal(issue(requested, "结果是10063。", [{ role: "assistant", content: "", toolCalls: calls }, { role: "tool", toolCallId: "calculation", content: '{"ok":true}' }]), null);
  assert.ok(issue(requested, "10063", [{ role: "assistant", content: "", toolCalls: calls }, { role: "tool", toolCallId: "calculation", content: '{"ok":false}' }]));
  assert.equal(requirements("不要用计算工具，直接说结果。", false, ["agent_calculate"]).requiredTools, undefined);
});
