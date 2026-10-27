import assert from "node:assert/strict";
import test from "node:test";
import type { AgentTurnRequest } from "@astella/shared";
import { companionNoteNeedsRelatedSearch as needsSearch, companionNoteEditPrerequisite } from "../note/companion-note-authoring-stage.ts";
import { companionExplicitNoteInterpretation as prepare } from "../turn/companion-entry-mode.ts";
import { reconcileCompanionInterpretation } from "../tools/companion-tool-intent.ts";
import { companionDirectInterpretation } from "../turn/companion-entry-mode.ts";

test("note drafting waits for its actual search dependency, not an expensive rejected draft", () => {
  const request = "生成三篇秦朝、汉朝、唐朝的历史笔记";
  const call: AgentTurnRequest["messages"][number] = { role: "assistant", content: "",
    toolCalls: [{ id: "search", name: "notes.read.search", arguments: { query: "秦朝 汉朝 唐朝", match: "any" } }] };
  const result = (ok: boolean): AgentTurnRequest["messages"][number] => ({ role: "tool", toolCallId: "search",
    content: JSON.stringify({ ok, data: { notes: [] } }) });
  assert.equal(needsSearch(request, true, []), true);
  assert.equal(needsSearch(request, true, [call]), true);
  assert.equal(needsSearch(request, true, [call, result(false)]), true);
  assert.equal(needsSearch(request, true, [call, result(true)]), false);
  const oldRequest: AgentTurnRequest["messages"][number] = { role: "user", content: "之前的笔记请求" };
  const newRequest: AgentTurnRequest["messages"][number] = { role: "user", content: request };
  assert.equal(needsSearch(request, true, [oldRequest, call, result(true), newRequest]), true,
    "a historical search must not release a new draft that the executor will reject");
  assert.equal(needsSearch(request, true, [oldRequest, call, result(true), newRequest, call, result(true)]), false);
  assert.equal(needsSearch(request, true, [{ ...call, toolCalls: [] }, result(true)]), true);
  assert.equal(needsSearch(`${request}，不要搜索笔记库`, true, []), false);
  assert.equal(needsSearch(request, false, []), false);
  assert.equal(needsSearch("帮我读一下已有笔记", true, []), false);
  assert.equal(needsSearch("不要写任何笔记，只聊聊历史", true, []), false);
  assert.equal(needsSearch("“生成历史笔记”是什么意思？", true, []), false);
  assert.equal(needsSearch("写一篇完整的童话故事", true, []), false);
  assert.equal(needsSearch("先读这篇笔记，再写一篇新的历史笔记", true, []), true);
});

test("UI hand-note wording and long titles preserve the authoritative edit path", () => {
  const initial = companionDirectInterpretation("a".repeat(64));
  const tools = ["companion_notes_write", "companion_notes_read"];
  const edit = reconcileCompanionInterpretation(initial,
    "请修改《一篇标题很长但可以准确定位的已保存材料》这篇已保存手记，在第三节追加一句，并保存。", tools, "full");
  assert.equal(edit.toolUse, "act");
  assert.ok(edit.candidateOperations.includes("companion_notes_write"));
  assert.equal(needsSearch("请新建一篇手记，标题《操作核对》，正文包含三个小节。", true, []), true);
  for (const text of ["不要修改这篇手记。", "《如何修改笔记》是什么意思？"]) {
    assert.ok(!reconcileCompanionInterpretation(initial, text, tools, "full").candidateOperations.includes("companion_notes_write"));
  }
});

test("an edit resolves its note, reads actual blocks, then releases drafting", () => {
  const base = { requestedActions: ["notes.write.edit"], hasPageNote: false, successfulTools: [] };
  assert.equal(companionNoteEditPrerequisite(base), "search");
  assert.equal(companionNoteEditPrerequisite({ ...base, hasPageNote: true }), "read");
  const found = { name: "notes.read.search", arguments: {}, data: { notes: [{ noteId: "actual-note" }] } };
  assert.equal(companionNoteEditPrerequisite({ ...base, successfulTools: [found] }), "read");
  assert.equal(companionNoteEditPrerequisite({ ...base, successfulTools: [{ ...found, data: { notes: [] } }] }), null,
    "an empty lookup does not force a made-up note ID");
  const read = { name: "notes.read.read", arguments: { includeBlocks: true }, data: { version: "actual-version", blocks: [] } };
  assert.equal(companionNoteEditPrerequisite({ ...base, successfulTools: [found, read] }), null);
  assert.equal(companionNoteEditPrerequisite({ ...base, requestedActions: ["notes.write.create"] }), null);
});

test("a fresh explicit note request prepares its operation without a blocking classifier call", () => {
  const tools = ["companion_notes_write", "companion_notes_read"];
  const prepared = prepare("a".repeat(64), "生成三篇中国历史笔记，主题为秦朝、汉朝、唐朝。每篇约300字。", tools);
  assert.equal(prepared?.toolUse, "act"); assert.equal(prepared?.goalRelation, "new");
  assert.deepEqual(prepared?.candidateOperations, ["companion_notes_write"]);
  assert.ok(prepare("a".repeat(64), "生成三篇中国历史笔记，主题分别是秦朝、汉朝、唐朝。要分别保存成笔记。每篇约300字，简短但完整，包含关键事实与结尾。", tools));
  for (const text of ["不要写任何笔记", "继续刚才的笔记", "生成三篇笔记并打开第二篇", "写一篇笔记，以后用粤语说话", "写一篇笔记是什么意思？", "把这篇笔记整理一下"])
    assert.equal(prepare("a".repeat(64), text, tools), null);
  assert.equal(prepare("a".repeat(64), "生成三篇历史笔记", []), null);
});
