import assert from "node:assert/strict";
import test from "node:test";
import { AgentRole, type AgentTurnRequest } from "@astella/shared";
import { activeCompactionMaterial, compactActiveToolContext } from "../companion-active-context-compaction.ts";

const round = (id: string, name = "companion_read_note"): AgentTurnRequest["messages"] => [
  { role: "assistant", content: "", toolCalls: [{ id, name, arguments: { noteId: id } }] },
  { role: "tool", toolCallId: id, content: JSON.stringify({ ok: true, data: "原始证据".repeat(1000) }) },
];
const question = { role: "user" as const, content: "整理当前笔记，保留末尾公式和全部限制" };

test("未知工具不作为已授权的读取回合压缩", () => {
  assert.equal(activeCompactionMaterial([question, ...round("unknown", "unregistered_read"), ...round("tail")]), null);
});

test("压缩当前工具回合保留用户原文、最近证据、写入回执与未完成调用", async () => {
  const messages: AgentTurnRequest["messages"] = [question, ...round("old-read"), ...round("saved", "companion_edit_note"),
    ...round("latest-read"), { role: "assistant", content: "", toolCalls: [{ id: "pending", name: "companion_edit_note", arguments: {} }] }];
  assert.deepEqual(activeCompactionMaterial(messages)!.removed, round("old-read"));
  const request: AgentTurnRequest = { role: AgentRole.COMPANION_AGENT, systemPrompt: "政策", messages, tools: [], toolChoice: "auto", temperature: 0.2, maxTokens: 1000 };
  let calls = 0;
  const folded = await compactActiveToolContext({ request, targetInputTokens: 100_000, maxOutputTokens: 1000,
    summarize: async (source, tokens) => { calls++; assert.ok(source.includes("old-read")); assert.equal(tokens, 1000); return "已读旧页，编辑前须重读精确原文。"; } });
  assert.equal(calls, 1);
  assert.equal(folded!.messages[0], question);
  assert.ok(folded!.messages.some(message => message.role === "tool" && message.toolCallId === "saved"));
  assert.ok(folded!.messages.some(message => message.role === "tool" && message.toolCallId === "latest-read"));
  assert.equal(folded!.messages.at(-1), messages.at(-1));
  assert.equal(folded!.receipt.sourceKind, "active_tool_rounds");
});

test("不拆散并行调用与结果；没有可压缩回合或摘要不缩小时原样保留", async () => {
  assert.equal(activeCompactionMaterial([question, ...round("only")]), null);
  const pair: AgentTurnRequest["messages"] = [{ role: "assistant", content: "", toolCalls: [
    { id: "a", name: "companion_read_note", arguments: {} }, { id: "b", name: "companion_read_note", arguments: {} }] },
    { role: "tool", toolCallId: "a", content: "a" }, { role: "user", content: "插入的用户要求" },
    { role: "tool", toolCallId: "b", content: "b" }];
  assert.equal(activeCompactionMaterial([...pair, ...round("tail")]), null);
  const request: AgentTurnRequest = { role: AgentRole.COMPANION_AGENT, systemPrompt: "政策", messages: [question, ...round("old"), ...round("latest")], tools: [], toolChoice: "auto", temperature: 0.2, maxTokens: 1000 };
  assert.equal(await compactActiveToolContext({ request, targetInputTokens: 100_000, maxOutputTokens: 1000,
    summarize: async () => "更长的无效摘要".repeat(30000) }), null);
});
