import assert from "node:assert/strict";
import test from "node:test";
import { applyCompanionToolLoad, createCompanionToolSurface } from "../companion-tool-surface.ts";
import { rejectUnknownCompanionTool, unofferedToolReceipt, validateCompanionToolCall } from "../companion-tool-call-validation.ts";
import { companionRecoveryIdentity, openCompanionTurn } from "../companion-turn-opening.ts";
import { resumeCompanionInterruptedInput } from "../companion-resume-input.ts";

/**
 * The surface, validation, opening and resume helpers extracted from the agent
 * loop on 2026-10-17. The loop still owns ordering; these tests pin the
 * decisions it delegates so a later refactor cannot quietly widen the surface
 * or lose the already-shown prefix.
 */

const tool = (name: string) => ({ name, description: "", parameters: {}, toolVersion: "1" });
const definitions = [
  tool("companion_read_context"),
  tool("companion_read_note"),
  tool("companion_search_notes"),
  tool("agent_web_search"),
  tool("companion_list_recent_activity"),
];

test("工具面：核心+当前页组先给，装载后只增不减", () => {
  const surface = createCompanionToolSurface({
    definitions: definitions as never, pageKind: "today", candidateOperations: [],
  });
  const initial = surface.offered().map(tool => tool.name);
  assert.ok(initial.includes("companion_read_context"), "核心里一定有读取上下文");
  assert.equal(initial.includes("agent_web_search"), false, "联网搜索不在核心面里");
  assert.equal(surface.loadedToolNames.size, 0);

  const before = new Set(initial);
  surface.loadedToolNames.add("agent_web_search");
  const after = surface.offered().map(tool => tool.name);
  for (const name of before) assert.ok(after.includes(name), `装载不能摘掉 ${name}`);
  assert.ok(after.includes("agent_web_search"));
});

test("工具面：候选操作只能加组，不会把页面组整体换掉", () => {
  const surface = createCompanionToolSurface({
    definitions: definitions as never, pageKind: "today",
    candidateOperations: ["agent_web_search"],
  });
  const names = surface.offered().map(tool => tool.name);
  assert.ok(names.includes("companion_read_context"));
  assert.ok(names.includes("agent_web_search"), "候选操作点名的能力要出现在面里");
});

test("装载工具组：回执只说装了什么，审计同步记一条", async () => {
  const surface = createCompanionToolSurface({
    definitions: definitions as never, pageKind: null, candidateOperations: [],
  });
  const receipts: string[] = [];
  const audits: string[] = [];
  const loaded = await applyCompanionToolLoad({
    surface, groups: ["web"], definitions,
    callId: "call-1", toolName: "companion_load_tools", toolVersion: "1",
    pushReceipt: content => receipts.push(content),
    recordAudit: async tool => { audits.push(tool.safeLabel); },
  });
  assert.deepEqual(loaded, ["agent_web_search"]);
  assert.equal(JSON.parse(receipts[0]!).data.loadedGroups[0], "web");
  assert.match(receipts[0]!, /已装载 1 个工具/);
  assert.deepEqual(audits, ["已装载更多能力"]);
  assert.ok(surface.offered().some(tool => tool.name === "agent_web_search"));
});

test("参数校验：无效参数给出可修字段，重复同一份无效输入才判死", () => {
  const first = validateCompanionToolCall({
    name: "companion_read_note", arguments: { noteId: "not-a-uuid" },
    alreadyRejected: new Set(), identity: "companion_read_note:x",
  });
  assert.ok(first.rejection);
  assert.equal(first.rejection!.repeatedInvalid, false);
  assert.equal(first.accepted, null);

  const again = validateCompanionToolCall({
    name: "companion_read_note", arguments: { noteId: "not-a-uuid" },
    alreadyRejected: new Set(["companion_read_note:x"]), identity: "companion_read_note:x",
  });
  assert.equal(again.rejection!.repeatedInvalid, true, "同样的无效输入再交一次不再有进展");

  const ok = validateCompanionToolCall({
    name: "companion_read_note",
    arguments: { noteId: "27af9007-a6da-400c-857b-b95bfbef5010" },
    alreadyRejected: new Set(), identity: "companion_read_note:y",
  });
  assert.ok(ok.accepted, "合法参数应当通过");
  assert.equal(ok.rejection, null);
});

test("未下发工具：回执点名该先装载，并列出当前可用", () => {
  const receipt = JSON.parse(unofferedToolReceipt("agent_web_search", ["companion_read_context", "companion_read_note"]));
  assert.equal(receipt.status, "not_executed");
  assert.match(receipt.error, /companion_load_tools/);
  assert.match(receipt.error, /companion_read_context/);
});

test("未注册工具：按最高风险入账，并回一条阻止回执", async () => {
  const recorded: string[] = [];
  const events: { riskClass: string; status: string }[] = [];
  const receipts: string[] = [];
  await rejectUnknownCompanionTool({
    identity: { id: "call-x", name: "companion_invented_tool" },
    recordRejected: async reason => { recorded.push(reason); },
    appendEvent: async tool => { events.push({ riskClass: tool.riskClass, status: tool.status }); },
    pushReceipt: content => receipts.push(content),
  });
  assert.match(recorded[0]!, /未注册/);
  assert.deepEqual(events, [{ riskClass: "irreversible", status: "blocked" }]);
  assert.equal(JSON.parse(receipts[0]!).status, "blocked");
});

test("回合开场：历史保留 hostObservation，主动轮把观察压在末尾", () => {
  const base = {
    read: { runId: "r1", conversationId: "c1", initiativeInput: null },
    baseMessages: [
      { role: "user", content: "问题" },
      { role: "assistant", content: "回答", reasoning: "想一下" },
      { role: "system", content: "内部政策不该进历史" },
    ],
  } as never;
  const opening = openCompanionTurn(base);
  assert.equal(opening.messages.length, 2);
  assert.equal(opening.currentRequest.content, "问题");
  assert.equal((opening.messages[1] as { reasoning?: string }).reasoning, "想一下",
    "思考模式网关要求把 assistant 的 reasoning 交回去");

  const identity = companionRecoveryIdentity({
    args: base, currentRequest: opening.currentRequest, permissionLevel: "full",
    definitions: [{ name: "companion_read_note", toolVersion: "1", parameters: {} }],
    primary: { id: "mimo", modelId: "mimo-v2.6-flash", promptVersion: "p1" },
    fallback: { id: "deepseek", modelId: "deepseek-v3", promptVersion: "p2" },
  });
  assert.equal(identity.version, 1);
  assert.deepEqual(identity.definitions.map(item => item.name), ["companion_read_note"]);
  assert.equal(identity.fallback?.modelId, "deepseek-v3");
});

test("中断续跑：已显示的前缀只折一次，并带着纠正说明继续", async () => {
  const visibleSegments: string[] = [];
  const visibleSegmentDelivered: boolean[] = [];
  const messages: unknown[] = [];
  const event = { ctx: { workspaceId: "11111111-1111-4111-8111-111111111111" }, read: { userId: "22222222-2222-4222-8222-222222222222", runId: "33333333-3333-4333-8333-333333333333" } } as never;
  const result = await resumeCompanionInterruptedInput({
    event, stepId: "step-1",
    stepRequest: { role: "companion_agent", systemPrompt: "", messages: [], tools: [] } as never,
    stepProvider: {} as never, permissionLevel: "full",
    workspaceId: "w1", userId: "u1", runId: "r1", conversationId: "c1",
    initialVisibleText: "先说结论：\n\n第二段",
    visibleSegments, visibleSegmentDelivered, messages: messages as never,
    currentRequest: { role: "user", content: "问题" } as never,
    compactionCheckpoints: undefined,
    separator: "\n\n",
    loadStoredResult: async () => null,
  });
  // 没有 step checkpoint 时不能复用旧结果，只能把已显示的后缀折进对话。
  assert.equal(result.reuseStoredResult, false);
  // 本轮还没有任何已提交分段，所以已显示的全部内容就是这一段。
  assert.deepEqual(visibleSegments, ["先说结论：\n\n第二段"]);
  assert.deepEqual(visibleSegmentDelivered, [true]);
  // assistant 前缀 + 核对说明 + 原样重附的当前问题。
  assert.equal(messages.length, 3, "assistant 前缀与纠正说明要成对出现");
  assert.equal((messages[0] as { role: string }).role, "assistant");
  const request = result.stepRequest as { messages: unknown[] };
  assert.equal(request.messages.length, 3);
});

test("中断续跑：没有新增可见文字时原样返回", async () => {
  const stepRequest = { role: "companion_agent", systemPrompt: "", messages: [], tools: [] };
  const event = { ctx: { workspaceId: "11111111-1111-4111-8111-111111111111" }, read: { userId: "22222222-2222-4222-8222-222222222222", runId: "33333333-3333-4333-8333-333333333333" } } as never;
  const result = await resumeCompanionInterruptedInput({
    event, stepId: "step-1", stepRequest: stepRequest as never,
    stepProvider: {} as never, permissionLevel: "full",
    workspaceId: "w1", userId: "u1", runId: "r1", conversationId: "c1",
    initialVisibleText: undefined,
    visibleSegments: [], visibleSegmentDelivered: [], messages: [],
    currentRequest: { role: "user", content: "问题" } as never,
    compactionCheckpoints: undefined, separator: "\n\n",
    loadStoredResult: async () => null,
  });
  assert.equal(result.stepRequest, stepRequest);
  assert.equal(result.reuseStoredResult, false);
});
