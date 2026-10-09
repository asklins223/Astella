import assert from "node:assert/strict";
import { AgentRole, getCompanionAgentTool, validateCompanionAgentToolArguments, type AgentTurnRequest } from "@astella/shared";
import { noteBlockRenderedTextV1 } from "@astella/shared/note-doc-schema";
import { applyCompanionNoteEdit } from "../../../../apps/api/src/modules/note/companion-edit-document.ts";
import { emptyFragmentNoteDoc, projectFragmentBlocks, writeFragmentBlocks } from "../../../../apps/api/src/modules/note/doc-fragment.ts";
import { companionEditNoteV1Schema } from "@astella/shared/companion-note-authoring-contracts";
import { paginateReadBlocks } from "../handlers/companion-read-tools.ts";
import { companionStepRuntimePolicy } from "../handlers/companion-step-plan.ts";
import { platform, observedProvider, save, type WireReceipt } from "./acceptance-common.ts";

// Real model + real edit domain on a synthetic Y.Doc. No production notes, HTTP queue, or database persistence.
const route = platform("agent_turn"), wire: WireReceipt[] = [];
const provider = observedProvider(route, "full-note-format-edit", wire);
const noteId = "11111111-1111-4111-8111-111111111111", noteVersionId = "22222222-2222-4222-8222-222222222222";
const doc = emptyFragmentNoteDoc();
const sections = ["一、模型选型", "二、数据库表设计", "三、定时任务设计", "四、详细功能模块", "五、性能优化设计"];
const original = sections.flatMap((title, section) => [
  { type: "paragraph" as const, content: `<span style="font-size:28px"><strong>${title}</strong></span>` },
  ...Array.from({ length: 8 }, (_, i) => ({ type: "paragraph" as const,
    content: `第${section + 1}节说明${i + 1}：` + "任务状态通过保存回执核对，正文保留完整内容，标题与代码使用对应的文档结构。".repeat(5) })),
  { type: "paragraph" as const, content: `CREATE TABLE example_${section + 1} ( id UUID PRIMARY KEY, name TEXT NOT NULL );` },
  { type: "paragraph" as const, content: "本节小结：保存完成以后，才向用户显示成功。" },
]);
writeFragmentBlocks(doc, original);
const before = projectFragmentBlocks(doc);
const messages: AgentTurnRequest["messages"] = [{ role: "user", content:
  "调整下这篇笔记的格式规范，例如代码的要转成代码块，标题的要转标题。只调整格式，保留原文全部字句和代码。\n"
  + JSON.stringify({ context: { noteId, noteVersionId } }) }];
const definitions = ["companion_read_note", "companion_edit_note"].map(name => getCompanionAgentTool(name)!);
const operations: unknown[] = [];
let edited = false;
try {
  for (let step = 1; step <= 5; step++) {
    const request: AgentTurnRequest = { role: AgentRole.COMPANION_AGENT, messages,
      systemPrompt: companionStepRuntimePolicy({ permissionLevel: "full", toolCount: definitions.length,
        stepBudget: 8, finalAnswerOnly: false, attentionIntent: "task" }),
      tools: definitions.map(({ name, description, parameters }) => ({ name, description, parameters })),
      toolChoice: edited ? "auto" : "required", maxTokens: route.modelProfile?.maxOutputTokens ?? 32_768, temperature: 0.4 };
    const result = await provider.executeAgentTurn!(request, new AbortController().signal);
    assert.notEqual(result.finishReason, "length");
    const calls = result.toolCalls ?? [];
    if (!calls.length) { assert.ok(edited, "reading alone cannot complete formatting"); break; }
    messages.push({ role: "assistant", content: result.content ?? "", toolCalls: calls,
      ...(result.reasoning ? { reasoning: result.reasoning } : {}) });
    for (const call of calls) {
      const checked = validateCompanionAgentToolArguments(call.name, call.arguments);
      if (!checked.success) throw new Error(checked.reason);
      const definition = getCompanionAgentTool(call.name)!;
      const inputChars = JSON.stringify(checked.data).length;
      assert.ok(inputChars <= definition.maxInputChars);
      operations.push({ name: call.name, inputChars, arguments: checked.data });
      if (call.name === "companion_read_note") {
        const current = projectFragmentBlocks(doc);
        const start = Number(checked.data.startOrdinal ?? 1);
        const page = paginateReadBlocks(current.filter(block => block.ordinal + 1 >= start)
          .map(block => ({ ordinal: block.ordinal + 1, content: block.content })), Number(checked.data.maxChars ?? 3000), Number(checked.data.startOffset ?? 0));
        messages.push({ role: "tool", toolCallId: call.id, content: JSON.stringify({ ok: true, data: {
          noteId, version: noteVersionId, title: "全文格式测试", totalBlocks: current.length, body: page.body, blocks: page.blocks,
          truncated: page.endOrdinal! < current.length || page.blockTextTruncated,
          nextStartOrdinal: page.nextStartOffset === null ? page.endOrdinal! + 1 : page.endOrdinal,
          nextStartOffset: page.nextStartOffset ?? 0 } }) });
      } else {
        assert.equal(call.name, "companion_edit_note");
        const input = companionEditNoteV1Schema.parse(checked.data);
        applyCompanionNoteEdit(doc, input);
        edited = true;
        messages.push({ role: "tool", toolCallId: call.id, content: JSON.stringify({ ok: true, data: {
          kind: "edited_note", noteId, noteVersionId, operation: input.operation, summary: "合成文档已应用格式修改（不代表数据库保存）" } }) });
      }
    }
  }
  const after = projectFragmentBlocks(doc);
  const text = (blocks: typeof before) => blocks.map(block => noteBlockRenderedTextV1(block.type, block.content)).join("").replace(/\s/g, "");
  assert.ok(edited);
  assert.equal(text(after), text(before), "formatting must preserve every original word and code token");
  assert.equal(after.filter(block => block.type === "heading").length, 5);
  assert.equal(after.filter(block => block.type === "code").length, 5);
  save("note-formatting-edit-20261009", { model: route.model, originalChars: before.reduce((n, block) => n + block.content.length, 0),
    originalBlocks: before.length, operations, after, wire, scope: "synthetic-model-and-edit-domain-only" });
  console.log(JSON.stringify({ ok: true, model: route.model, originalBlocks: before.length, originalChars: before.reduce((n, block) => n + block.content.length, 0),
    tools: operations.length, headings: 5, codeBlocks: 5, allOriginalTextPreserved: true }));
} finally { doc.destroy(); }
