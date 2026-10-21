import assert from "node:assert/strict";
import test from "node:test";
import type { AgentTurnRequest } from "@astella/shared";
import { companionNoteNeedsRelatedSearch as needsSearch } from "../note/companion-note-authoring-stage.ts";
import { companionExplicitNoteInterpretation as prepare } from "../turn/companion-entry-mode.ts";

test("note drafting waits for its actual search dependency, not an expensive rejected draft", () => {
  const request = "生成三篇秦朝、汉朝、唐朝的历史笔记";
  const call: AgentTurnRequest["messages"][number] = { role: "assistant", content: "",
    toolCalls: [{ id: "search", name: "companion_search_notes", arguments: { query: "秦朝 汉朝 唐朝", match: "any" } }] };
  const result = (ok: boolean): AgentTurnRequest["messages"][number] => ({ role: "tool", toolCallId: "search",
    content: JSON.stringify({ ok, data: { notes: [] } }) });
  assert.equal(needsSearch(request, true, []), true);
  assert.equal(needsSearch(request, true, [call]), true);
  assert.equal(needsSearch(request, true, [call, result(false)]), true);
  assert.equal(needsSearch(request, true, [call, result(true)]), false);
  assert.equal(needsSearch(request, true, [{ ...call, toolCalls: [] }, result(true)]), true);
  assert.equal(needsSearch(`${request}，不要搜索笔记库`, true, []), false);
  assert.equal(needsSearch(request, false, []), false);
  assert.equal(needsSearch("帮我读一下已有笔记", true, []), false);
  assert.equal(needsSearch("不要写任何笔记，只聊聊历史", true, []), false);
  assert.equal(needsSearch("“生成历史笔记”是什么意思？", true, []), false);
  assert.equal(needsSearch("写一篇完整的童话故事", true, []), false);
  assert.equal(needsSearch("先读这篇笔记，再写一篇新的历史笔记", true, []), true);
});

test("a fresh explicit note request prepares its operation without a blocking classifier call", () => {
  const tools = ["companion_create_note", "companion_search_notes"];
  const prepared = prepare("a".repeat(64), "生成三篇中国历史笔记，主题为秦朝、汉朝、唐朝。每篇约300字。", tools);
  assert.equal(prepared?.toolUse, "act"); assert.equal(prepared?.goalRelation, "new");
  assert.deepEqual(prepared?.candidateOperations, ["companion_create_note"]);
  assert.ok(prepare("a".repeat(64), "生成三篇中国历史笔记，主题分别是秦朝、汉朝、唐朝。要分别保存成笔记。每篇约300字，简短但完整，包含关键事实与结尾。", tools));
  for (const text of ["不要写任何笔记", "继续刚才的笔记", "生成三篇笔记并打开第二篇", "写一篇笔记，以后用粤语说话", "写一篇笔记是什么意思？", "把这篇笔记整理一下"])
    assert.equal(prepare("a".repeat(64), text, tools), null);
  assert.equal(prepare("a".repeat(64), "生成三篇历史笔记", []), null);
});
