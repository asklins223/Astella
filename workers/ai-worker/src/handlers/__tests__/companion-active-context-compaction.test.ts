import assert from "node:assert/strict";
import test from "node:test";
import { AgentRole, type AgentTurnRequest } from "@astella/shared";
import { activeCompactionMaterial, compactActiveToolContext, createWorkingStateSummarizer } from "../context/companion-active-context-compaction.ts";
import { MockProvider } from "../../lib/providers/mock.ts";

const round = (id: string, name = "companion_read_note"): AgentTurnRequest["messages"] => [
  { role: "assistant", content: "", toolCalls: [{ id, name, arguments: { noteId: id } }] },
  { role: "tool", toolCallId: id, content: JSON.stringify({ ok: true, data: "原始证据".repeat(1000) }) },
];
const question = { role: "user" as const, content: "整理当前笔记，保留末尾公式和全部限制" };

test("an oversized active tool source is fully read through capacity-sized requests before returning its checkpoint", async () => {
  const provider = new MockProvider();
  const capability = provider.getCapabilities();
  provider.getCapabilities = () => ({ ...capability, contextWindowTokens: 16_000 });
  const source = JSON.stringify({ callId: "read-source", result: "原文 👩‍🔬\n".repeat(2000), tail: "末尾约束必须读到" });
  const parts: string[] = [];
  const checkpoint = { facts: ["已读来源事实"], constraints: ["修改前重新读取"], unresolved: ["尚有原文未读取"], references: ["read-source"] };
  provider.chatCompletion = async messages => {
    assert.match(String(messages[0]!.content), /每一段都必须直接返回更新后的累计工作状态/);
    const data = JSON.parse(String(messages.at(-1)!.content));
    assert.deepEqual(data.previousWorkingState, parts.length ? checkpoint : null);
    assert.equal(data.sourcePart, undefined, "offsets belong to host accounting rather than generated task facts");
    parts.push(data.sourceText);
    assert.equal(data.inputComplete, parts.join("").length === source.length);
    return { content: JSON.stringify(checkpoint), usage: {} };
  };
  const summarize = createWorkingStateSummarizer(provider, { signal: new AbortController().signal, deadlineAt: Date.now() + 60_000 });
  await summarize(source, 1000);
  assert.ok(parts.length > 2);
  assert.equal(parts.join(""), source);
});

test("未知工具不作为已授权的读取回合压缩", () => {
  assert.equal(activeCompactionMaterial([question, ...round("unknown", "unregistered_read"), ...round("tail")]), null);
});

test("working-state checkpoints reject empty results and echoed source envelopes", async () => {
  for (const content of ["", "{}", JSON.stringify({ facts: ["source"], constraints: [], unresolved: [], references: [], sourcePart: { text: "invented next part" } })]) {
    const provider = new MockProvider();
    provider.chatCompletion = async () => ({ content, usage: {} });
    await assert.rejects(createWorkingStateSummarizer(provider,
      { signal: new AbortController().signal, deadlineAt: Date.now() + 60_000 })("complete original source", 1000));
  }
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

test("a single oversized historical read is fully consumed with its exact tool source retained privately", async () => {
  const source = JSON.stringify({ ok: true, data: { messages: [{ seq: "1", text: "Complete original source. ".repeat(5000)
    + "Final correction must survive.", sourceHash: "a".repeat(64) }], nextFromSeq: "2", confidence: 0.75 } });
  const messages: AgentTurnRequest["messages"] = [question,
    { role: "assistant", content: "", toolCalls: [{ id: "huge-history", name: "companion_read_history", arguments: { fromSeq: 1 } }] },
    { role: "tool", toolCallId: "huge-history", content: source }];
  const request: AgentTurnRequest = { role: AgentRole.COMPANION_AGENT, systemPrompt: "policy", messages, tools: [], maxTokens: 1000, temperature: 0.2 };
  const result = await compactActiveToolContext({ request, targetInputTokens: 5000, maxOutputTokens: 1000,
    summarize: async material => {
      assert.deepEqual(JSON.parse(material), messages.slice(1));
      assert.ok(material.includes("Final correction must survive."));
      return "The complete historical source was read; final correction applies; no write executed.";
    } });
  assert.ok(result);
  assert.equal(result.messages[0], question);
  assert.equal(result.messages.length, 2, "a complete native call/result round is replaced atomically");
  assert.deepEqual(JSON.parse(result.source!.json), messages.slice(1));
  assert.equal(messages[2]!.content, source);
  assert.ok(!JSON.stringify(result.receipt).includes("Complete original source."), "ordinary log receipt excludes private original");
});

test("latest small historical evidence stays native, and latest writes or mutable note reads never use the exceptional fold", async () => {
  const base = { role: AgentRole.COMPANION_AGENT, systemPrompt: "policy", tools: [], maxTokens: 1000, temperature: 0.2 };
  for (const name of ["companion_edit_note", "companion_read_note"]) {
    assert.equal(await compactActiveToolContext({ request: { ...base, messages: [question, ...round("latest", name)] },
      targetInputTokens: 500, maxOutputTokens: 1000, summarize: async () => { throw new Error("must not summarize protected source"); } }), null);
  }
  const small: AgentTurnRequest["messages"] = [question,
    { role: "assistant", content: "", toolCalls: [{ id: "small", name: "companion_read_history", arguments: {} }] },
    { role: "tool", toolCallId: "small", content: "A small complete historical result." }];
  assert.equal(await compactActiveToolContext({ request: { ...base, messages: small }, targetInputTokens: 5000,
    maxOutputTokens: 1000, summarize: async () => { throw new Error("a small result should not need compaction"); } }), null);
});
