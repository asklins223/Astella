/**
 * Companion Agent 运行时实库集成测试（方案《将 AI 伴星升级为可扩展 Agent》§1–§6）。
 *
 * 覆盖 Agent loop 的真实 DB 编排（provider 用 mock，不产生外部模型调用）：
 * - 模型不调工具 → 单步、零工具审计行；
 * - 模型调工具 → 有限循环、审计行落库、`agent.tool` SSE 事件符合共享合同；
 *   （判据是 `tool_call_count`，不是曾经那个"选中了哪个技能/哪种执行模式"的读数——
 *    技能层已整条删除，工具面每轮全给。）
 * - 确认续跑：run 停在 waiting_for_confirmation 并冻结 proposal → 带 proposalId 重新入队 →
 *   loadContinuation 回填结果 → 同一次 run 产出最终答复（不做新用户对话）；
 * - 执行预算耗尽：累计耗时段达到显式部署时限 → 直接终结，不再调用 provider；
 * - epoch 失效：run 冻结的 epoch 与当前不一致 → 拒绝执行且零副作用。
 *
 * 这些是方案验收清单里"确认后继续同一次 run""超过预算安全终止""global off/epoch
 * 变化拒绝迟到结果"的实库证据。
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testDatabaseUrl } from "@astella/shared/integration-test-db-env";
import { resetPlatformConfigCache } from "@astella/shared/platform-config-node";
import type { AgentTurnResult } from "@astella/shared";
import { MockProvider } from "../lib/providers/mock.ts";
import { registerFactory } from "../lib/provider-factory.ts";
import { ProviderRequestError, ProviderResponseRefusedError, ProviderResponseUnverifiedError } from "../lib/provider-request-error.ts";
import { currentCompanionSuccessfulReceipts } from "../handlers/tools/companion-tool-receipts.ts";
import { readCompanionWebSearchReceipts } from "../agent/web-search.ts";

// Fixtures create/delete complete scoped records; the runtime still connects
// through DATABASE_URL_WORKER and exercises its actual restricted role.
const CONN = testDatabaseUrl("DATABASE_URL_MIGRATOR");
process.env.DATABASE_URL ??= CONN;
// 强制 mock provider：验证 DB 编排与预算/fence，不产生外部模型调用或费用。
delete process.env.TOKENRHYTHM_API_KEY;
/**
 * 2026-09-15 修复：本用例此前会**继承开发者的真实平台配置**
 * （AI_PLATFORMS_CONFIG → config/ai-platforms.json），于是
 * resolveAIGovernanceContext 判定 anyExternalNonMock=true 并要求 workspace 签署
 * AI 同意书；fixture 没有签，companion-dialogue 的同意门（HEAD 既有行为，
 * 会 markCompanionRunFailed("AI_CONSENT_REQUIRED")）就把 8 个用例里的 5 个打挂。
 * 本用例测的是 agent 编排，不是 provider 接线，因此与其他 worker 集成测试一样
 * 把平台配置钉成 mock（mock 在治理层天然豁免同意门），从而与环境无关。
 */
delete process.env.AI_PLATFORMS_CONFIG;
process.env.COMPANION_DIALOGUE_V1_ENABLED = "true";

const sql = postgres(CONN, { max: 2 });

after(async () => {
  await sql.end({ timeout: 2 }).catch(() => undefined);
  const { closeDatabase } = await import("../db.ts");
  await closeDatabase();
});

const { runCompanionDialogue } = await import("../handlers/turn/companion-dialogue.ts");
const { ensureAgentToolCall, loadContinuation, safeArgumentsHash, updateToolCall } = await import("../handlers/tools/companion-tool-call-ledger.ts");
const { companionStreamEventV1Schema, getCompanionAgentTool } = await import("@astella/shared");

async function seedBase(): Promise<{ workspaceId: string; userId: string }> {
  const ws = randomUUID();
  const uid = randomUUID();
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
    await tx`SELECT set_config('app.user_id', ${uid}, true)`;
    await tx`INSERT INTO users (id, email, password_hash, role) VALUES (${uid}, ${`agent-${uid.slice(0, 8)}@x.test`}, 'h', 'owner')`;
    await tx`INSERT INTO workspaces (id, name, owner_id) VALUES (${ws}, ${"w" + ws.slice(0, 8)}, ${uid})`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${ws}, ${uid}, 'owner')`;
  });
  return { workspaceId: ws, userId: uid };
}

interface Fixture {
  runId: string;
  conversationId: string;
  userMessageId: string;
  cleanup: () => Promise<void>;
}

async function seedAgentRun(
  ws: string,
  uid: string,
  opts: {
    userText: string;
    runStatus?: string;
    permissionLevel?: string;
    accountEpoch?: number;
    runAccountEpoch?: number;
    agentElapsedMs?: number;
  },
): Promise<Fixture> {
  const runId = randomUUID();
  const cid = randomUUID();
  const userMessageId = randomUUID();
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
    await tx`SELECT set_config('app.user_id', ${uid}, true)`;
    await tx`INSERT INTO companion_conversations (id, workspace_id, user_id, kind, title, title_source, status)
             VALUES (${cid}, ${ws}, ${uid}, 'dialogue', 'agent', 'auto', 'active')`;
    await tx`INSERT INTO companion_messages
               (id, conversation_id, workspace_id, user_id, role, seq, kind, blocks, content_sha256)
             VALUES (${userMessageId}, ${cid}, ${ws}, ${uid}, 'user', 1, 'text',
                     ${tx.json([{ type: "text", text: opts.userText }])}, ${"0".repeat(64)})`;
    await tx`INSERT INTO companion_turn_runs
               (id, conversation_id, workspace_id, user_id, user_message_id, generation, status,
                permission_level, idempotency_key_hash, request_body_hash, account_epoch, agent_elapsed_ms)
             VALUES (${runId}, ${cid}, ${ws}, ${uid}, ${userMessageId}, 1, ${opts.runStatus ?? "accepted"},
                     ${opts.permissionLevel ?? null},
                     ${"a".repeat(64)}, ${"b".repeat(64)},
                     ${opts.runAccountEpoch ?? 0}, ${opts.agentElapsedMs ?? 0})`;
    await tx`UPDATE companion_conversations SET next_message_seq = 3, next_event_seq = 100 WHERE id = ${cid}`;
    // account state 决定 agent_settings(permissionLevel) 与 epoch
    await tx`INSERT INTO user_companion_account_state (user_id, epoch, global_enabled)
             VALUES (${uid}, ${opts.accountEpoch ?? 0}, true)
             ON CONFLICT (user_id) DO UPDATE SET epoch = EXCLUDED.epoch, global_enabled = true`;
  });
  const cleanup = async () => {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
      await tx`SELECT set_config('app.user_id', ${uid}, true)`;
      await tx`DELETE FROM companion_agent_tool_calls WHERE conversation_id = ${cid}`;
      await tx`DELETE FROM companion_agent_steps WHERE conversation_id = ${cid}`;
      await tx`DELETE FROM companion_stream_events WHERE conversation_id = ${cid}`;
      // turn_runs 必须早于 messages：user_message_id 外键指向 companion_messages。
      await tx`DELETE FROM companion_turn_runs WHERE conversation_id = ${cid}`;
      // 卡与那条可读记录之间是**双向**外键：proposals.source_message_id 指向消息，
      // 而消息的 action_ref 指回卡。所以先解除消息这一侧，再删卡，最后删消息
      // （服务端清历史走的是同一个顺序，见 continuous-history-service）。
      await tx`UPDATE companion_messages SET action_ref = NULL WHERE conversation_id = ${cid}`;
      await tx`DELETE FROM companion_action_proposals WHERE conversation_id = ${cid}`;
      await tx`DELETE FROM companion_messages WHERE conversation_id = ${cid}`;
      await tx`DELETE FROM companion_conversations WHERE id = ${cid}`;
      await tx`DELETE FROM user_companion_account_state WHERE user_id = ${uid}`;
      await tx`DELETE FROM jobs WHERE workspace_id = ${ws}`;
      await tx`DELETE FROM workspace_members WHERE workspace_id = ${ws}`;
      await tx`DELETE FROM workspaces WHERE id = ${ws}`;
      await tx`DELETE FROM users WHERE id = ${uid}`;
    });
  };
  return { runId, conversationId: cid, userMessageId, cleanup };
}

async function invoke(ws: string, uid: string, payload: { runId: string; proposalId?: string }) {
  // Intent classification now verifies the real job/run lease through the task kernel.
  const jobId = randomUUID();
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
    await tx`SELECT set_config('app.user_id', ${uid}, true)`;
    await tx`INSERT INTO jobs (id,type,workspace_id,requested_by,payload,status,lease_token,started_at)
      VALUES (${jobId},'companion_agent',${ws},${uid},${tx.json(payload)},'running','fixture-lease',now())`;
    await tx`UPDATE companion_turn_runs SET job_id=${jobId} WHERE id=${String(payload.runId)}`;
  });
  return runCompanionDialogue({
    id: jobId,
    payload,
    workspaceId: ws,
    requestedBy: uid,
    leaseToken: "fixture-lease",
    signal: new AbortController().signal,
  });
}

/** Script the native author, including discovery, instead of relying on the
 * removed routing classifier to preload tools for the legacy mock markers. */
async function invokeScriptedWrite(ws: string, uid: string, payload: { runId: string }, kind: "memory" | "note") {
  const original = MockProvider.prototype.executeAgentTurn;
  MockProvider.prototype.executeAgentTurn = async function (request, signal): Promise<AgentTurnResult> {
    if (request.role !== "companion_agent") return original.call(this, request, signal);
    const call = (name: string, args: Record<string, unknown>): AgentTurnResult => ({
      content: "", toolCalls: [{ id: `script_${randomUUID()}`, name, arguments: args }], finishReason: "tool_calls",
      usage: null, providerRequestId: "scripted-native-write",
    });
    const writes = currentCompanionSuccessfulReceipts(request.messages).filter(receipt => receipt.riskClass !== "read");
    if (writes.length) return call("companion_finish", { text: "已保存这项要求。", outcome: "completed",
      actions: writes.map(receipt => ({ receiptId: receipt.id })),
      requirements: [{ requirement: "保存本次要求", fulfilled: true, evidenceCallIds: writes.map(receipt => receipt.id) }] });
    const name = kind === "memory" ? "companion_memory_save" : "companion_notes_write";
    if (!request.tools.some(tool => tool.name === name))
      return call("companion_load_tools", { groups: [kind === "memory" ? "memory" : "notes"] });
    return kind === "memory"
      ? call(name, { kind: "preference", content: "打招呼时就只打招呼，不盘点笔记", sourceQuote: "以后打招呼别盘点笔记" })
      : call(name, { action: "create", title: "代码示例", markdown: "```text\n" + "\\".repeat(9500) + "\n```", links: [] });
  };
  try { return await invoke(ws, uid, payload); }
  finally { MockProvider.prototype.executeAgentTurn = original; }
}

for (const delivery of ["body", "finish"] as const) test(`unread application records remain private through ${delivery} and recover using a real receipt`, async () => {
  let authorCalls = 0;
  registerFactory("mock", "agent_turn", config => {
    const provider = new MockProvider({ modelProfile: config.modelProfile });
    const scripted = async (request: import("@astella/shared").AgentTurnRequest): Promise<AgentTurnResult> => {
      authorCalls++;
      const success = currentCompanionSuccessfulReceipts(request.messages).some(receipt => receipt.operation === "observe.stats");
      if (authorCalls === 1) {
        assert.equal(request.reasoningEffort, "none", "retrieving an independently required record uses the primary's fast level");
        assert.equal(request.toolChoice, "auto", "source requirements stay host-checked without adding an unsupported forced-choice request");
      }
      if (success) return { content: "当前记录里，今日和本周学习时长均为 0 分钟。", toolCalls: [], finishReason: "stop", usage: null, providerRequestId: null };
      if (authorCalls === 1) return delivery === "body"
        ? { content: "你在9月17日学习过，掌握度100%。", toolCalls: [], finishReason: "stop", usage: null, providerRequestId: null }
        : { content: "", toolCalls: [{ id: "unsupported-finish", name: "companion_finish", arguments: {
          text: "你在9月17日学习过，掌握度100%。", outcome: "completed", actions: [], evidence: [],
          requirements: [{ requirement: "report current learning records", fulfilled: true, textOnly: true, evidenceCallIds: [] }],
        } }], finishReason: "tool_calls", usage: null, providerRequestId: null };
      return { content: "", toolCalls: [{ id: `actual-stats-${authorCalls}`, name: "companion_observe", arguments: { action: "stats" } }],
        finishReason: "tool_calls", usage: null, providerRequestId: null };
    };
    provider.executeAgentTurn = scripted;
    Object.defineProperty(provider, "chatCompletionStreamToolCalls", { value: true });
    provider.chatCompletionStream = async (_messages, options, _signal, onDelta) => {
      const result = await scripted(options.nativeAgentRequest!);
      const content = result.content ?? "";
      onDelta(content);
      return { ...result, content };
    };
    return provider;
  });
  const { workspaceId, userId } = await seedBase();
  const fixture = await seedAgentRun(workspaceId, userId, { userText: "我最近的学习数据怎么样？【mock:requires-stats-read】" });
  try {
    await invoke(workspaceId, userId, { runId: fixture.runId });
    const state = await readState(workspaceId, userId, fixture);
    assert.equal(state.run.status, "succeeded");
    assert.ok(authorCalls >= 3, "an unsupported final cannot bypass the actual read");
    assert.ok(state.toolCalls.some(call => call.name === "observe.stats" && call.status === "succeeded"));
    assert.doesNotMatch(JSON.stringify(state.assistant), /9月17|100%/);
    assert.doesNotMatch(JSON.stringify(state.events.filter(event => ["assistant.delta", "assistant.final", "assistant.utterance"].includes(String(event.type)))), /9月17|100%/);
    assert.match(JSON.stringify(state.assistant), /0 分钟/);
    const [run] = await sql`SELECT turn_interpretation->'readRequirements' AS requirement FROM companion_turn_runs WHERE id=${fixture.runId}`;
    assert.equal(run.requirement.status, "resolved");
    assert.deepEqual(run.requirement.requirements[0].operations, ["observe.stats"]);
    const [opportunity] = await sql`SELECT count(*)::int AS count FROM companion_awareness_observations WHERE parent_run_id=${fixture.runId} AND topic='reply.finished'`;
    assert.equal(opportunity.count, 1, "a genuinely verified answer keeps its normal participation opportunity");
  } finally {
    await fixture.cleanup();
    registerFactory("mock", "agent_turn", config => new MockProvider({ modelProfile: config.modelProfile }));
  }
});

for (const delivery of ["body", "finish"] as const) test(`an unsupported saved-memory ${delivery} cannot settle before the corresponding actual write`, async () => {
  let calls = 0;
  registerFactory("mock", "agent_turn", config => {
    const provider = new MockProvider({ modelProfile: config.modelProfile });
    const scripted = async (request: import("@astella/shared").AgentTurnRequest): Promise<AgentTurnResult> => {
      calls++;
      const call = (name: string, args: Record<string, unknown>): AgentTurnResult => ({ content: "",
        toolCalls: [{ id: `memory-${calls}`, name, arguments: args }], finishReason: "tool_calls", usage: null, providerRequestId: null });
      const writes = currentCompanionSuccessfulReceipts(request.messages).filter(receipt => receipt.operation === "memory.write.save");
      if (writes.length) return call("companion_finish", { text: "记住了：你周末喜欢去图书馆。", outcome: "completed",
        actions: writes.map(receipt => ({ receiptId: receipt.id })),
        requirements: [{ requirement: "save the current personal memory", fulfilled: true, evidenceCallIds: writes.map(receipt => receipt.id) }] });
      if (calls === 1) return delivery === "body" ? { content: "已经保存进长期记忆了。", toolCalls: [], finishReason: "stop", usage: null, providerRequestId: null }
        : call("companion_finish", { text: "已经保存进长期记忆了。", outcome: "completed", actions: [],
          requirements: [{ requirement: "save the memory", fulfilled: true, textOnly: true, evidenceCallIds: [] }] });
      if (!request.tools.some(tool => tool.name === "companion_memory_save")) return call("companion_load_tools", { groups: ["memory"] });
      return call("companion_memory_save", { kind: "preference", content: "用户周末喜欢去图书馆", sourceQuote: "我周末喜欢去图书馆" });
    };
    provider.executeAgentTurn = scripted;
    Object.defineProperty(provider, "chatCompletionStreamToolCalls", { value: true });
    provider.chatCompletionStream = async (_messages, options, _signal, delta) => {
      const result = await scripted(options.nativeAgentRequest!); const content = result.content ?? ""; delta(content); return { ...result, content };
    };
    return provider;
  });
  const { workspaceId, userId } = await seedBase();
  const fixture = await seedAgentRun(workspaceId, userId, { userText: "保存为长期记忆：我周末喜欢去图书馆。【mock:requires-memory-write】", permissionLevel: "full" });
  try {
    await invoke(workspaceId, userId, { runId: fixture.runId });
    const state = await readState(workspaceId, userId, fixture);
    assert.equal(state.run.status, "succeeded");
    assert.ok(state.toolCalls.some(call => call.name === "memory.write.save" && call.status === "succeeded"));
    assert.doesNotMatch(JSON.stringify(state.events.filter(event => ["assistant.delta", "assistant.final", "assistant.utterance"].includes(String(event.type)))), /已经保存进长期记忆了/);
    const [row] = await sql`SELECT count(*)::int AS count FROM assistant_memory_items WHERE workspace_id=${workspaceId} AND user_id=${userId} AND deleted_at IS NULL`;
    assert.equal(row.count, 1, "repair must save once rather than turn a fake acknowledgment into repeated writes");
    assert.match(JSON.stringify(state.assistant), /你周末喜欢去图书馆/);
  } finally {
    await fixture.cleanup();
    registerFactory("mock", "agent_turn", config => new MockProvider({ modelProfile: config.modelProfile }));
  }
});

test("repeated loading cannot revive a withdrawn malformed tool or grow into a context overflow", async () => {
  let authorCalls = 0, invalidWrites = 0, loadsAfterWithdrawal = 0;
  registerFactory("mock", "agent_turn", config => {
    const provider = new MockProvider({ modelProfile: config.modelProfile });
    Object.defineProperty(provider, "chatCompletionStreamToolCalls", { value: true });
    provider.chatCompletionStream = async (_messages, options) => {
      authorCalls++;
      const request = options.nativeAgentRequest!;
      const withdrawn = request.messages.some(message => message.role === "tool"
        && String(message.content).includes('"toolAvailable":false'));
      const hasMemory = request.tools.some(tool => tool.name === "companion_memory_save");
      if (withdrawn) {
        assert.equal(hasMemory, false, "a loader must not re-enable a tool withdrawn for repeated invalid arguments");
        loadsAfterWithdrawal++;
      }
      const name = hasMemory && !withdrawn ? "companion_memory_save" : "companion_load_tools";
      if (name === "companion_memory_save") invalidWrites++;
      return { content: "", toolCalls: [{ id: `loader-loop-${authorCalls}`, name,
        arguments: name === "companion_memory_save" ? { kind: "unsupported", content: "invalid fixture" } : { groups: ["memory"] } }],
        finishReason: "tool_calls" };
    };
    return provider;
  });
  const { workspaceId, userId } = await seedBase();
  const fixture = await seedAgentRun(workspaceId, userId, { userText: "保存一条记忆。" });
  try {
    await invoke(workspaceId, userId, { runId: fixture.runId });
    const state = await readState(workspaceId, userId, fixture);
    assert.equal(state.run.status, "succeeded");
    assert.equal(invalidWrites, 5);
    assert.ok(loadsAfterWithdrawal > 1 && loadsAfterWithdrawal < 10);
    assert.ok(authorCalls < 20, "a loop that adds no capability must settle before filling the context");
    assert.ok(!state.toolCalls.some(call => call.name === "memory.write.save" && call.status === "succeeded"));
    assert.match(JSON.stringify(state.assistant), /没有保存或修改/);
    const [row] = await sql`SELECT count(*)::int AS count FROM assistant_memory_items WHERE workspace_id=${workspaceId} AND user_id=${userId} AND deleted_at IS NULL`;
    assert.equal(row.count, 0);
    const laterLoads = state.events.filter(event => event.type === "agent.tool" && JSON.stringify(event).includes("本次没有新增能力"));
    assert.ok(laterLoads.length > 0, "loader receipts must describe existing availability rather than claim new progress");
  } finally {
    await fixture.cleanup();
    registerFactory("mock", "agent_turn", config => new MockProvider({ modelProfile: config.modelProfile }));
  }
});

for (const kind of ["chat", "chat-configure", "chat-deepen", "reasoned"] as const) test(`the guarded ${kind} reply uses the same primary with the appropriate reasoning setting`, async () => {
  const directory = mkdtempSync(join(tmpdir(), "companion-guarded-opening-"));
  const originalConfig = process.env.AI_PLATFORMS_CONFIG;
  const configPath = join(directory, "platforms.json");
  writeFileSync(configPath, JSON.stringify({ platforms: { paired: { type: "mock", models: {
    primary: { contextWindowTokens: 1_000_000, maxOutputTokens: 32_000, vision: false },
    reviewer: { contextWindowTokens: 1_000_000, maxOutputTokens: 32_000, vision: false },
  } } }, capabilities: { agent_turn: { platform: "paired", model: "primary" }, companion_fallback: { platform: "paired", model: "reviewer" } } }));
  process.env.AI_PLATFORMS_CONFIG = configPath;
  resetPlatformConfigCache();
  const efforts: Array<string | undefined> = [];
  registerFactory("mock", "agent_turn", config => {
    const provider = new MockProvider({ modelProfile: config.modelProfile });
    Object.defineProperty(provider, "chatCompletionStreamToolCalls", { value: true });
    provider.chatCompletionStream = async (_messages, options, _signal, delta) => {
      efforts.push(options.nativeAgentRequest!.reasoningEffort);
      if (efforts.length === 1 && (kind === "chat-configure" || kind === "chat-deepen")) {
        return { content: "", toolCalls: [{ id: `control-${kind}`,
          name: kind === "chat-deepen" ? "companion_deepen" : "companion_configure_turn",
          arguments: kind === "chat-deepen" ? {} : { sourceQuote: "轻声说", voiceStyle: {
            decision: "apply", instruction: "轻声说", persistentPreference: { action: "keep", dialect: null },
          } } }], finishReason: "tool_calls" };
      }
      const content = kind !== "reasoned" ? "嗯嗯。" : "冰的密度比水小，所以能浮在水上。";
      delta(content); return { content, toolCalls: [], finishReason: "stop" };
    };
    return provider;
  });
  const { workspaceId, userId } = await seedBase();
  const fixture = await seedAgentRun(workspaceId, userId, { userText: kind !== "reasoned" ? "嗯，知道了，轻声说。"
    : "解释一下冰为什么能浮在水上。【mock:requires-reasoning】" });
  try {
    await invoke(workspaceId, userId, { runId: fixture.runId });
    const state = await readState(workspaceId, userId, fixture);
    assert.equal(state.run.status, "succeeded");
    assert.deepEqual(efforts, kind === "chat-configure" ? ["none", "none"]
      : kind === "chat-deepen" ? ["none", "max"] : [kind === "chat" ? "none" : "low"]);
    assert.equal(state.toolCalls.length, 0);
  } finally {
    await fixture.cleanup();
    if (originalConfig === undefined) delete process.env.AI_PLATFORMS_CONFIG;
    else process.env.AI_PLATFORMS_CONFIG = originalConfig;
    resetPlatformConfigCache();
    registerFactory("mock", "agent_turn", config => new MockProvider({ modelProfile: config.modelProfile }));
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const channel of ["body", "finish", "publish", "unavailable", "stream", "stream-interrupted"] as const) test(`source-backed ${channel} delivery is reviewed before any answer reaches SSE or storage`, async () => {
  const directory = mkdtempSync(join(tmpdir(), "companion-source-review-"));
  const originalConfig = process.env.AI_PLATFORMS_CONFIG;
  const configPath = join(directory, "platforms.json");
  writeFileSync(configPath, JSON.stringify({ platforms: { paired: { type: "mock", models: {
    primary: { contextWindowTokens: 1_000_000, maxOutputTokens: 32_000, vision: false },
    reviewer: { contextWindowTokens: 1_000_000, maxOutputTokens: 32_000, vision: false },
  } } }, capabilities: { agent_turn: { platform: "paired", model: "primary" }, companion_fallback: { platform: "paired", model: "reviewer" } } }));
  process.env.AI_PLATFORMS_CONFIG = configPath; resetPlatformConfigCache();
  const sourceId = randomUUID();
  const bad = "BAD_DRAFT：这项研究证明70°C也成立。";
  const safe = "这项研究只测量10–37°C，不能据此外推到70°C。";
  const firstParagraph = safe + "所给原文没有包含70°C这个实验条件，已有结果也不足以证明该温度下同样成立；答复只能保留实际测量范围内的结论。";
  const streamed = firstParagraph + "\n\n需要区分实验结果与尚未测量的条件。";
  let reviewScope: { workspaceId: string; userId: string; runId: string };
  let reviews = 0, sequence = 0;
  registerFactory("mock", "agent_turn", config => {
    const provider = new MockProvider({ modelProfile: config.modelProfile });
    const chat = provider.chatCompletion.bind(provider);
    provider.chatCompletion = async (messages, options, signal) => {
      if (messages.some(message => message.role === "system" && String(message.content).startsWith("核对待交付答复与本轮实际读到的资料"))) {
        reviews++;
        const data = JSON.parse(String(messages.find(message => message.role === "user")!.content));
        assert.equal(data.documents[0].operation, "notes.read.source");
        assert.match(data.documents[0].data.body, /10–37/);
        if (channel === "unavailable") throw new Error("controlled source review failure");
        if (channel.startsWith("stream") && data.paragraphIndex === 1) {
          const deadline = Date.now() + 5000;
          let published = false;
          while (Date.now() < deadline) {
            const rows = await sql`SELECT payload FROM companion_stream_events WHERE run_id=${reviewScope.runId} AND type='assistant.delta' ORDER BY seq`;
            if (JSON.stringify(rows).includes(firstParagraph)) { published = true; break; }
            await new Promise(resolve => setTimeout(resolve, 20));
          }
          assert.equal(published, true, "the first verified paragraph must reach durable SSE before the second verdict returns");
          if (channel === "stream-interrupted") throw new Error("controlled interruption after a verified paragraph");
        }
        return { content: JSON.stringify({ reply: channel.startsWith("stream")
          ? data.paragraphIndex === 0 ? firstParagraph : "需要区分实验结果与尚未测量的条件。" : safe }), usage: {} };
      }
      return chat(messages, options, signal);
    };
    Object.defineProperty(provider, "chatCompletionStreamToolCalls", { value: true });
    provider.chatCompletionStream = async (_messages, options, _signal, delta) => {
      const request = options.nativeAgentRequest!;
      const call = (name: string, args: Record<string, unknown>) => ({ content: "", toolCalls: [{ id: `source-review-${++sequence}`, name, arguments: args }], finishReason: "tool_calls" });
      const receipts = request.messages.filter(message => message.role === "tool").flatMap(message => {
        try { return [JSON.parse(String(message.content))]; } catch { return []; }
      });
      if (!request.tools.some(tool => tool.name === "companion_notes_read")) return call("companion_load_tools", { groups: ["notes"] });
      if (!receipts.some(receipt => receipt.ok && receipt.operation === "notes.read.source")) return call("companion_notes_read", { action: "source", sourceId });
      if (receipts.some(receipt => receipt.ok && receipt.operation === "say.publish")) return call("companion_finish", { text: safe, actions: [], evidence: [] });
      if (channel === "finish") return call("companion_finish", { text: bad, actions: [], evidence: [] });
      if (channel === "publish") return call("companion_send_message", { text: bad });
      const content = channel.startsWith("stream") ? bad + "\n\nBAD_DRAFT：这是尚未核实的第二段。" : bad;
      delta(content); return { content, toolCalls: [], finishReason: "stop" };
    };
    return provider;
  });
  const scope = await seedBase();
  const fixture = await seedAgentRun(scope.workspaceId, scope.userId, { userText: `读取来源 ${sourceId}，只根据原文回答。` });
  reviewScope = { ...scope, runId: fixture.runId };
  try {
    await sql`INSERT INTO sources(id,workspace_id,type,title,status,created_by)
      VALUES(${sourceId},${scope.workspaceId},'text','范围实验','ready',${scope.userId})`;
    await sql`INSERT INTO source_segments(source_id,workspace_id,ordinal,text,char_start,char_end)
      VALUES(${sourceId},${scope.workspaceId},1,'本实验只测量10–37°C，不包含70°C。',0,24)`;
    await invoke(scope.workspaceId, scope.userId, { runId: fixture.runId });
    const state = await readState(scope.workspaceId, scope.userId, fixture);
    assert.equal(state.run.status, "succeeded");
    assert.ok(reviews > 0);
    const displayed = JSON.stringify(state.assistant) + JSON.stringify(state.events.filter(event => ["assistant.delta","assistant.utterance","assistant.final"].includes(event.type)));
    assert.ok(!displayed.includes("BAD_DRAFT"), "the original draft must never leak into an answer channel");
    if (channel === "unavailable" || channel === "stream-interrupted") {
      assert.match(displayed, channel === "unavailable" ? /回答还没有核对完成/ : /后续内容这次没有核对完成/);
      const [receipt] = await sql`SELECT delivery_receipt FROM companion_turn_runs WHERE id=${fixture.runId}`;
      assert.equal(receipt.delivery_receipt.outcome, "partial");
      if (channel === "stream-interrupted") {
        assert.ok(displayed.includes(firstParagraph));
        assert.ok(!displayed.includes("需要区分实验结果"));
      }
    } else assert.ok(displayed.includes(safe));
    if (channel === "stream") {
      const text = state.assistant.map(message => message.blocks.filter((block: { type: string }) => block.type === "text")
        .map((block: { text: string }) => block.text).join("")).join("");
      assert.equal(text, streamed, "final storage must match the streamed prefix plus its remainder exactly once");
    }
  } finally {
    await sql`DELETE FROM source_segments WHERE source_id=${sourceId}`;
    await sql`DELETE FROM sources WHERE id=${sourceId}`;
    await fixture.cleanup();
    if (originalConfig === undefined) delete process.env.AI_PLATFORMS_CONFIG; else process.env.AI_PLATFORMS_CONFIG = originalConfig;
    resetPlatformConfigCache(); registerFactory("mock", "agent_turn", config => new MockProvider({ modelProfile: config.modelProfile }));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an unavailable evidence check settles before author or tools and cannot start an unsolicited answer retry", async () => {
  let authorCalls = 0;
  registerFactory("mock", "agent_turn", config => {
    const provider = new MockProvider({ modelProfile: config.modelProfile });
    const chat = provider.chatCompletion.bind(provider);
    provider.chatCompletion = async (messages, options, signal) => {
      if (messages.some(message => message.role === "system" && String(message.content).includes("Companion application evidence requirements")))
        throw new Error("controlled evidence-check transport failure");
      return chat(messages, options, signal);
    };
    Object.defineProperty(provider, "chatCompletionStreamToolCalls", { value: true });
    provider.chatCompletionStream = async () => { authorCalls++; return { content: "未经核对的答案", toolCalls: [], finishReason: "stop" }; };
    return provider;
  });
  const { workspaceId, userId } = await seedBase();
  const fixture = await seedAgentRun(workspaceId, userId, { userText: "查一下这个问题，再告诉我结果。" });
  try {
    await invoke(workspaceId, userId, { runId: fixture.runId });
    const state = await readState(workspaceId, userId, fixture);
    assert.equal(state.run.status, "succeeded", "transport can deliver a truthful partial result");
    assert.equal(authorCalls, 0, "do not spend a whole native tool loop when its publication check is already unavailable");
    assert.equal(state.toolCalls.length, 0);
    assert.match(JSON.stringify(state.assistant), /还没有核对完成/);
    assert.doesNotMatch(JSON.stringify(state.events), /未经核对的答案/);
    const [run] = await sql`SELECT delivery_receipt FROM companion_turn_runs WHERE id=${fixture.runId}`;
    assert.equal(run.delivery_receipt.outcome, "partial");
    const [opportunity] = await sql`SELECT count(*)::int AS count FROM companion_awareness_observations WHERE parent_run_id=${fixture.runId} AND topic='reply.finished'`;
    assert.equal(opportunity.count, 0, "an incomplete answer must not be replayed through the unrequested reply.finished channel");
    const [suggestions] = await sql`SELECT count(*)::int AS count FROM jobs WHERE workspace_id=${workspaceId} AND type='companion_followup_suggestions'`;
    assert.equal(suggestions.count, 0);
  } finally {
    await fixture.cleanup();
    registerFactory("mock", "agent_turn", config => new MockProvider({ modelProfile: config.modelProfile }));
  }
});

test("new required read progress resets the correction streak instead of imposing a task-wide limit", async () => {
  const actions = ["stats", "activity", "context", "current_page", "history"];
  let authorCalls = 0;
  registerFactory("mock", "agent_turn", config => {
    const provider = new MockProvider({ modelProfile: config.modelProfile });
    const chat = provider.chatCompletion.bind(provider);
    provider.chatCompletion = async (messages, options, signal) => {
      if (messages.some(message => message.role === "system" && String(message.content).includes("Companion application evidence requirements")))
        return { content: JSON.stringify({ requirements: actions.map(action => ({ description: `Read ${action}`, operations: [`observe.${action}`] })), executionRequirements: [] }), usage: {} };
      return chat(messages, options, signal);
    };
    Object.defineProperty(provider, "chatCompletionStreamToolCalls", { value: true });
    provider.chatCompletionStream = async (_messages, options, _signal, delta) => {
      authorCalls++;
      const receipts = currentCompanionSuccessfulReceipts(options.nativeAgentRequest!.messages);
      const next = actions.find(action => !receipts.some(receipt => receipt.operation === `observe.${action}`));
      if (!next) { delta("五项都已按真实回执读过。"); return { content: "五项都已按真实回执读过。", toolCalls: [], finishReason: "stop" }; }
      if (authorCalls % 2 === 1) { delta("五项全部读完了。"); return { content: "五项全部读完了。", toolCalls: [], finishReason: "stop" }; }
      return { content: "", toolCalls: [{ id: `required-read-${next}`, name: "companion_observe", arguments: { action: next } }], finishReason: "tool_calls" };
    };
    return provider;
  });
  const { workspaceId, userId } = await seedBase();
  const fixture = await seedAgentRun(workspaceId, userId, { userText: "逐项读取这五类资料后再告诉我完成情况。" });
  try {
    await invoke(workspaceId, userId, { runId: fixture.runId });
    const state = await readState(workspaceId, userId, fixture);
    assert.equal(state.run.status, "succeeded");
    assert.equal(authorCalls, 11, "five independent unbacked drafts remain correctable when real evidence advances between them");
    for (const action of actions) assert.ok(state.toolCalls.some(call => call.name === `observe.${action}` && call.status === "succeeded"));
    assert.match(JSON.stringify(state.assistant), /真实回执读过/);
    assert.doesNotMatch(JSON.stringify(state.assistant), /五项全部读完了/);
  } finally {
    await fixture.cleanup();
    registerFactory("mock", "agent_turn", config => new MockProvider({ modelProfile: config.modelProfile }));
  }
});

test("an unsupported empirical mechanism is not published when no external source is available", async () => {
  let authorCalls = 0;
  registerFactory("mock", "agent_turn", config => {
    const provider = new MockProvider({ modelProfile: config.modelProfile });
    Object.defineProperty(provider, "chatCompletionStreamToolCalls", { value: true });
    provider.chatCompletionStream = async (_messages, _options, _signal, delta) => {
      authorCalls++;
      const content = "温度降低必然使甜味感知消失，苦味变强。";
      delta(content);
      return { content, toolCalls: [], finishReason: "stop" };
    };
    return provider;
  });
  const { workspaceId, userId } = await seedBase();
  const fixture = await seedAgentRun(workspaceId, userId, { userText: "为什么咖啡放凉了会更苦？【mock:requires-independent-evidence】" });
  try {
    await invoke(workspaceId, userId, { runId: fixture.runId });
    const state = await readState(workspaceId, userId, fixture);
    assert.equal(state.run.status, "succeeded");
    assert.ok(authorCalls <= 1, "known unavailable evidence must not cause serial author retries; it may settle before the author starts");
    assert.equal(state.toolCalls.length, 0, "an evidence check cannot execute or authorize a search");
    assert.match(JSON.stringify(state.assistant), /还不能确定/);
    assert.doesNotMatch(JSON.stringify(state.assistant), /甜味感知消失|苦味变强|搜索失败/);
    assert.doesNotMatch(JSON.stringify(state.events.filter(event => ["assistant.delta", "assistant.final", "assistant.utterance"].includes(String(event.type)))), /甜味感知消失|苦味变强/);
  } finally {
    await fixture.cleanup();
    registerFactory("mock", "agent_turn", config => new MockProvider({ modelProfile: config.modelProfile }));
  }
});

async function readState(ws: string, uid: string, f: Fixture) {
  return sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
    await tx`SELECT set_config('app.user_id', ${uid}, true)`;
    const run = await tx`SELECT status, permission_level, step_count, tool_call_count, model_call_count, budget_snapshot,
                                agent_elapsed_ms, waiting_proposal_id, last_event_seq
                         FROM companion_turn_runs WHERE id = ${f.runId}`;
    const assistant = await tx`SELECT id, seq, kind, blocks, run_id, action_ref
                               FROM companion_messages
                               WHERE conversation_id = ${f.conversationId} AND role = 'assistant'
                               ORDER BY seq`;
    const events = await tx`SELECT type, payload, seq, conversation_id, workspace_id, run_id,
                                   generation, account_epoch, created_at
                            FROM companion_stream_events
                            WHERE conversation_id = ${f.conversationId} ORDER BY seq`;
    const toolCalls = await tx`SELECT tool_call_id, name, status, result_safe_summary
                               FROM companion_agent_tool_calls WHERE run_id = ${f.runId}`;
    const steps = await tx`SELECT step_no, kind, status, request_hash
                           FROM companion_agent_steps WHERE run_id = ${f.runId} ORDER BY step_no`;
    const proposals = await tx`SELECT id, status, origin, risk_class, agent_tool_call_id,
                                      payload,expires_at IS NULL OR expires_at > now() AS live
                               FROM companion_action_proposals WHERE conversation_id = ${f.conversationId}`;
    return {
      run: run[0],
      assistant,
      events,
      toolCalls,
      steps,
      proposals,
    };
  });
}

test("exhausted argument repair returns exactly one receipt for each native tool call", async () => {
  const { workspaceId, userId } = await seedBase();
  const f = await seedAgentRun(workspaceId, userId, { userText: "计算这个表达式；参数不合适就说明没有算出来。" });
  const original = MockProvider.prototype.executeAgentTurn;
  let calls = 0;
  MockProvider.prototype.executeAgentTurn = async function (request, signal) {
    if (request.role !== "companion_agent") return original.call(this, request, signal);
    calls++;
    const receiptIds = request.messages.filter(message => message.role === "tool").map(message => message.toolCallId);
    assert.equal(receiptIds.length, new Set(receiptIds).size, "one native tool call must have one result, including exhaustion");
    if (calls <= 5) return { content: "", toolCalls: [{ id: `invalid_${calls}`, name: "companion_observe",
      arguments: { action: "calculate", expression: "1".repeat(501) } }], finishReason: "tool_calls", usage: null, providerRequestId: "argument-exhaustion-test" };
    assert.ok(!request.tools.some(tool => tool.name === "companion_observe"));
    const receipt = JSON.parse(String(request.messages.filter(message => message.role === "tool").at(-1)!.content));
    assert.equal(receipt.status, "not_executed");
    assert.equal(receipt.toolAvailable, false);
    return { content: "表达式没有执行，未取得计算结果。", toolCalls: [], finishReason: "stop", usage: null, providerRequestId: "argument-exhaustion-test" };
  };
  try {
    await invoke(workspaceId, userId, { runId: f.runId });
    const state = await readState(workspaceId, userId, f);
    assert.equal(state.run.status, "succeeded");
    assert.equal(calls, 6);
    assert.equal(state.toolCalls.length, 5);
    assert.ok(state.toolCalls.every(call => call.status === "not_executed"));
  } finally { MockProvider.prototype.executeAgentTurn = original; await f.cleanup(); }
});

test("a valid argument repair resets consecutive failures without withdrawing a working domain tool", async () => {
  const { workspaceId, userId } = await seedBase();
  const f = await seedAgentRun(workspaceId, userId, { userText: "计算这些表达式，参数错误时修正后继续。" });
  const original = MockProvider.prototype.executeAgentTurn;
  let calls = 0;
  MockProvider.prototype.executeAgentTurn = async function (request, signal) {
    if (request.role !== "companion_agent") return original.call(this, request, signal);
    calls++;
    assert.ok(request.tools.some(tool => tool.name === "companion_observe"), "successful corrections keep the domain usable: "
      + JSON.stringify({ calls, tools: request.tools.map(tool => tool.name), choice: request.toolChoice, last: request.messages.at(-1) }));
    if (calls <= 12) return { content: "", toolCalls: [{ id: `repair_${calls}`, name: "companion_observe",
      arguments: { action: "calculate", expression: calls % 2 ? "1".repeat(501 + calls) : `${calls}+1` } }],
      finishReason: "tool_calls", usage: null, providerRequestId: "argument-repair-test" };
    return { content: "最后一项计算结果是13。", toolCalls: [], finishReason: "stop", usage: null, providerRequestId: "argument-repair-test" };
  };
  try {
    await invoke(workspaceId, userId, { runId: f.runId });
    const state = await readState(workspaceId, userId, f);
    assert.equal(state.run.status, "succeeded");
    assert.equal(calls, 13);
    assert.equal(state.toolCalls.filter(call => call.status === "not_executed").length, 6);
    assert.equal(state.toolCalls.filter(call => call.status === "succeeded").length, 6);
  } finally { MockProvider.prototype.executeAgentTurn = original; await f.cleanup(); }
});

test("Agent：闲聊轮次正常收尾——有终态答复、不乱冻结确认", async () => {
  const { workspaceId, userId } = await seedBase();
  const f = await seedAgentRun(workspaceId, userId, { userText: "你好呀" });
  try {
    await invoke(workspaceId, userId, { runId: f.runId });
    const s = await readState(workspaceId, userId, f);

    assert.equal(s.run.status, "succeeded");
    // 这里**不再断言"闲聊不该调工具"**：工具面每轮全给（方案 29 §4.1），
    // 调不调是模型的选择。把"零工具"当不变量会反向逼系统去做无用调用——
    // 那正是 §8 作废"零工具率"这个指标时说过的同一件事。
    // 仍然要钉住的是：审计行数与 run 上的计数一致，且一句"你好呀"不许冻结任何确认。
    assert.equal(s.toolCalls.length, Number(s.run.tool_call_count), "工具审计行数必须等于 run 计数");
    assert.equal(s.proposals.length, 0, "闲聊不得冻结确认提案");
    assert.equal(s.assistant.length, 1, "产出 assistant 答复");
    const types = s.events.map((e) => (e as { type: string }).type);
    assert.ok(types.includes("assistant.final"), "闲聊也必须给出终态答复");
    // 有工具调用时才有 agent.tool 帧，且帧数与审计行数同源（不各自数一套）。
    const toolEventCalls = new Set(s.events
      .filter((e) => (e as { type: string }).type === "agent.tool")
      .map((e) => (e.payload as { tool?: { toolCallId?: string } })?.tool?.toolCallId));
    assert.equal(toolEventCalls.size, s.toolCalls.length, "工具事件覆盖的调用必须与审计行同一批");
    assert.ok(s.steps.length >= 1, "记录 model 步骤");
    assert.equal(s.steps[0].kind, "model");
    assert.ok(s.steps[0].request_hash, "步骤记录 request hash");
  } finally {
    await f.cleanup();
  }
});

test("voice-control-only output cannot silently satisfy an ordinary user request", async () => {
  const { workspaceId, userId } = await seedBase();
  const f = await seedAgentRun(workspaceId, userId, { userText: "你好呀" });
  const original = MockProvider.prototype.executeAgentTurn;
  const stream = Object.getOwnPropertyDescriptor(MockProvider.prototype, "chatCompletionStream")!;
  MockProvider.prototype.executeAgentTurn = async function (request, signal) {
    if (request.role !== "companion_agent") return original.call(this, request, signal);
    return { content: "[neutral]", toolCalls: [], finishReason: "stop", usage: null, providerRequestId: "tag-only-user-response" };
  };
  Object.defineProperty(MockProvider.prototype, "chatCompletionStream", { ...stream, value: undefined });
  try {
    await invoke(workspaceId, userId, { runId: f.runId });
    const s = await readState(workspaceId, userId, f);
    assert.equal(s.assistant.length, 1, "an actual user still receives an honest failure message");
    const text = JSON.stringify(s.assistant[0]!.blocks);
    assert.match(text, /这次没有生成有效回复/);
    assert.doesNotMatch(text, /\[neutral\]/);
    assert.ok(s.events.some(event => event.type === "assistant.final"));
    assert.ok(!s.events.some(event => event.type === "turn.completed" && event.payload.silent === true));
    const [step] = await sql`SELECT status,error_code FROM companion_agent_steps WHERE run_id=${f.runId} ORDER BY step_no DESC LIMIT 1`;
    assert.equal(step!.status, "failed");
    assert.equal(step!.error_code, "EMPTY_AGENT_RESPONSE");
  } finally {
    MockProvider.prototype.executeAgentTurn = original;
    Object.defineProperty(MockProvider.prototype, "chatCompletionStream", stream);
    await f.cleanup();
  }
});

for (const Failure of [ProviderResponseRefusedError, ProviderResponseUnverifiedError])
test(`${Failure.name} terminates once and remains non-recoverable in durable events`, async () => {
  const { workspaceId, userId } = await seedBase();
  const f = await seedAgentRun(workspaceId, userId, { userText: "synthetic provider refusal" });
  const original = MockProvider.prototype.executeAgentTurn;
  const stream = Object.getOwnPropertyDescriptor(MockProvider.prototype, "chatCompletionStream")!;
  let calls = 0;
  MockProvider.prototype.executeAgentTurn = async function (request, signal) {
    if (request.role !== "companion_agent") return original.call(this, request, signal);
    calls++;
    throw new Failure("mock");
  };
  Object.defineProperty(MockProvider.prototype, "chatCompletionStream", { ...stream, value: undefined });
  try {
    await assert.rejects(invoke(workspaceId, userId, { runId: f.runId }), Failure);
    const state = await readState(workspaceId, userId, f);
    assert.equal(calls, 1, "refusal must not enter repair or alternate-model recovery");
    assert.equal(state.run.status, "failed");
    const error = state.events.find(event => event.type === "error");
    assert.equal(error?.payload.code, new Failure("mock").code);
    assert.equal(error?.payload.recoverable, false);
    assert.doesNotMatch(JSON.stringify(state.assistant), /provider declined|mock|INTERNAL_ERROR/);
    assert.equal(state.toolCalls.length, 0);
  } finally {
    MockProvider.prototype.executeAgentTurn = original;
    Object.defineProperty(MockProvider.prototype, "chatCompletionStream", stream);
    await f.cleanup();
  }
});

test("§16.39(a)：闲聊那一圈不许留下任何正式学习记录的行", async () => {
  const { workspaceId, userId } = await seedBase();
  const f = await seedAgentRun(workspaceId, userId, { userText: "你好呀" });
  /**
   * 逐表数行，而不是数"有没有 proposal"。
   *
   * 上面那条 `s.proposals.length === 0` 证不了这件事：mock provider
   * （`src/lib/providers/mock.ts`）永远只挑 `companion_read_context`，所以它
   * **结构上不可能**让模型调起写工具——那条断言证明的是"mock 不会提议"，
   * 不是"系统不让提议"。而伴星此刻**确实**还持着 6 条会写正式学习记录的工具
   * （`COMPANION_PROPOSAL_EXECUTED_TOOLS`：start/resume/pause learning、
   * request_hint、switch_task_variant、defer_review），默认 `guided` 档全在面上。
   *
   * §16.39(a)「临时问答不自动生成正式学习记录或卡片」今天靠的是"模型没提议"
   * 这一件偶然的事，没有任何判据钉住它。钉在**行数**上：只要哪天有人给闲聊路径
   * 接上直接写库的分支（绕过提案确认），这里立刻红。
   *
   * 覆盖面是半边的——它管的是"服务端没有偷偷写库"，管不了"模型将来是否会提议
   * 一条写工具"。后者要真正解决，得在工具面按本轮性质收窄
   * （`resolveAllCompanionAgentTools` 加一个 turnKind 入参），那要动
   * `packages/shared/src/agent/companion-agent-registry.ts` 与
   * `companion-agent-runtime.ts`——两个文件当时都在别的会话里在途，故不在此刀。
   */
  // Plan 57 把旧的学习跑/复习链整条删了，能证明"闲聊不写正式记录"的只剩
  // 仍然活着的卡与事件表；已删的表不再盯着——盯一个不存在的表只会 42P01。
  const LEARNING_TABLES = [
    "note_learning_cards",
    "learning_metric_events",
  ] as const;

  async function countLearningRows(): Promise<Record<string, number>> {
    return sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${userId}, true)`;
      const out: Record<string, number> = {};
      for (const table of LEARNING_TABLES) {
        // 表名来自上面的白名单常量，不接受外部输入。
        const rows = await tx.unsafe(
          `SELECT count(*)::int AS n FROM ${table} WHERE workspace_id = $1`,
          [workspaceId],
        );
        out[table] = Number(rows[0].n);
      }
      return out;
    });
  }

  try {
    const before = await countLearningRows();
    await invoke(workspaceId, userId, { runId: f.runId });
    const after = await countLearningRows();
    for (const table of LEARNING_TABLES) {
      assert.equal(
        after[table],
        before[table],
        `一句"你好呀"之后 \`${table}\` 多出/少了行——临时问答不生成正式学习记录（§16.39(a)）`,
      );
    }

    /**
     * 反向对照：先证明这把尺子**量得到东西**。
     *
     * 没有这一段，上面那些 `0 === 0` 可能全是假的——RLS 把行挡住、列名写错、
     * 作用域写错，三种错法都会让计数恒为 0，用例照样全绿。这正是 mock provider
     * 让上一条 `proposals.length === 0` 失明的那一类。造一行出来，量到 +1 才算
     * 尺子成立；这一行随夹具按工作区级联删掉。
     */
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${userId}, true)`;
      await tx`INSERT INTO learning_metric_events
          (id, workspace_id, user_id, event_type, run_id, occurred_at)
        VALUES (${randomUUID()}, ${workspaceId}, ${userId}, 's1639_probe', ${f.runId}, now())`;
    });
    const probe = await countLearningRows();
    assert.equal(
      probe.learning_metric_events,
      before.learning_metric_events + 1,
      "反向对照：故意插的一行没被量到——这把尺子量不到东西，上面那些 0===0 是假的",
    );
  } finally {
    await f.cleanup();
  }
});

test("a blocked independent read does not block sibling reads; durable receipts stay in native call order", async () => {
  const { workspaceId, userId } = await seedBase();
  const f = await seedAgentRun(workspaceId, userId, { userText: "读取近期活动和本轮对话历史，简短告诉我。" });
  const lock = await sql.reserve();
  let locked = false;
  registerFactory("mock", "agent_turn", config => {
    const provider = new MockProvider({ modelProfile: config.modelProfile });
    provider.executeAgentTurn = async request => {
      const receipts = request.messages.filter(message => message.role === "tool" && message.toolCallId?.startsWith("parallel-"));
      if (receipts.length) {
        assert.deepEqual(receipts.map(message => message.toolCallId), ["parallel-activity", "parallel-history", "parallel-context"]);
        return { content: "近期没有活动，本轮对话历史已读取。", toolCalls: [], finishReason: "stop", usage: null, providerRequestId: null };
      }
      await lock`BEGIN`; await lock`LOCK TABLE notes IN ACCESS EXCLUSIVE MODE`; locked = true;
      return { content: "", toolCalls: ["activity", "history", "context"].map(action => ({ id: `parallel-${action}`,
        name: "companion_observe", arguments: { action } })), finishReason: "tool_calls", usage: null, providerRequestId: null };
    };
    return provider;
  });
  const invocation = invoke(workspaceId, userId, { runId: f.runId });
  void invocation.catch(() => undefined);
  try {
    const deadline = Date.now() + 12_000;
    let observed = false;
    while (Date.now() < deadline) {
      const rows = await sql`SELECT name,status FROM companion_agent_tool_calls WHERE run_id=${f.runId}`;
      if (["observe.history", "observe.context"].every(name => rows.some(row => row.name === name && row.status === "succeeded"))) {
        assert.ok(rows.some(row => row.name === "observe.activity" && row.status === "executing"));
        observed = true; break;
      }
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.equal(observed, true, "siblings must finish while the activity query is still held by the test lock");
  } finally {
    if (locked) await lock`COMMIT`;
    lock.release();
    try { await invocation; } finally {
      registerFactory("mock", "agent_turn", config => new MockProvider({ modelProfile: config.modelProfile }));
      await f.cleanup();
    }
  }
});

test("Agent：工具循环的审计行与 agent.tool SSE 事件符合共享合同", async () => {
  const { workspaceId, userId } = await seedBase();
  // 剧本同时声明工具意图和 provider 工具调用，走真实注意力解析与执行循环。
  const f = await seedAgentRun(workspaceId, userId, {
    userText: "看一下我的学习进度【mock:wants-tool】",
  });
  try {
    await invoke(workspaceId, userId, { runId: f.runId });
    const s = await readState(workspaceId, userId, f);

    assert.equal(s.run.status, "succeeded");
    assert.ok(s.run.step_count >= 2, "工具之后的回合才算一步完整的循环");
    assert.ok(s.run.tool_call_count >= 1, "至少执行一次工具");
    assert.ok(s.toolCalls.length >= 1, "工具调用写入审计表");
    assert.equal(s.toolCalls[0].status, "succeeded");
    assert.equal(s.toolCalls[0].name, "observe.context");
    assert.equal(s.assistant.length, 1, "循环结束后产出最终答复");

    const toolEvents = s.events.filter((e) => (e as { type: string }).type === "agent.tool");
    assert.ok(toolEvents.length >= 2, "agent.tool 至少有 requested + succeeded");

    // SSE 合同：每个 agent.* 事件都必须能被共享（strict）schema 解析。
    // 这里补齐 envelope 字段后校验 payload，等于端到端验证 §6 的事件合同。
    for (const event of toolEvents) {
      const parsed = companionStreamEventV1Schema.safeParse({
        version: 1,
        eventId: `${event.conversation_id}:${event.seq}`,
        seq: Number(event.seq),
        workspaceId: event.workspace_id,
        conversationId: event.conversation_id,
        runId: event.run_id,
        generation: event.generation,
        accountEpoch: event.account_epoch,
        createdAt: new Date(event.created_at).toISOString(),
        type: event.type,
        payload: event.payload,
      });
      assert.equal(parsed.success, true, `${event.type} 事件必须符合共享 SSE 合同`);
    }
    const toolPayload = toolEvents[toolEvents.length - 1].payload as { tool: { safeLabel: string } };
    assert.ok(toolPayload.tool.safeLabel.length > 0, "工具事件只暴露安全标签");
  } finally {
    await f.cleanup();
  }
});

/**
 * 只回一张确认卡的那一轮（2026-10-10 真实栈上撞到的形状）。
 *
 * 用户明确纠正"以后打招呼别盘点笔记"，模型一个字都不说、只调 `companion_save_memory`；
 * 那张卡此前**只存在于 `action.proposed` 事件里**，本轮没有任何伴星正文。于是卡没人点、
 * 五分钟后被回收时 run 落 `failed / ACTION_EXPIRED`，历史里就只剩用户自己那句话——
 * 用户回头查"她当时想做什么"什么也查不到（方案 50 §12.1 要口语化说真实状态、
 * §16 第 2 步要求本轮先接住纠正）。
 *
 * 这里钉的是补齐后的形状：卡同时是一条 `kind='action'` 的可读记录，
 * 文案来自提案自己的三行（不另外编一句话），并指回那个 proposal。
 */
test("只回一张确认卡：卡要在历史里留下可读的记录，而不是只有一个事件", async () => {
  const { workspaceId, userId } = await seedBase();
  const f = await seedAgentRun(workspaceId, userId, {
    userText: "以后打招呼别盘点笔记【mock:wants-memory】",
    permissionLevel: "guided",
  });
  try {
    await invokeScriptedWrite(workspaceId, userId, { runId: f.runId }, "memory");
    const s = await readState(workspaceId, userId, f);
    assert.equal(s.run.status, "waiting_for_confirmation");
    assert.equal(s.proposals.length, 1, "guided 档下这条写入必须冻结成一张确认卡");

    const cards = s.assistant.filter((row) => row.kind === "action");
    assert.equal(cards.length, 1, "确认卡必须留下一条可读记录");
    assert.equal(cards[0].run_id, f.runId);
    assert.equal(cards[0].action_ref, s.proposals[0].id);
    const blocks = cards[0].blocks as Array<{ type: string; text?: string; proposalId?: string }>;
    assert.equal(blocks[0].type, "text", "§3.3：先一个 text 块");
    assert.ok(blocks[0].text?.includes("以后打招呼别盘点笔记"),
      "记录要指名她准备记下的那句话，不是通用占位文案");
    assert.equal(blocks[1].type, "action_ref");
    assert.equal(blocks[1].proposalId, s.proposals[0].id);

    // 本轮仍**不发**终态帧：终态答复归确认后的续跑，一个回合两个"结束"会让客户端状态机打架。
    const types = s.events.map((e) => (e as { type: string }).type);
    assert.equal(types.includes("assistant.final"), false);
    assert.ok(types.includes("action.proposed"));

    // 记录不能顶掉本轮的终态消息位：续跑那条才是 `assistant_message_id`。
    const flagged = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${userId}, true)`;
      return tx`SELECT assistant_message_id FROM companion_turn_runs WHERE id = ${f.runId}`;
    });
    assert.equal(flagged[0].assistant_message_id, null,
      "卡是随行的可读记录，不冒充本轮的终态答复");
  } finally {
    await f.cleanup();
  }
});

test("低权限长代码笔记完整到达预览，合法 JSON 转义不受通用字符上限拒绝", async () => {
  const { workspaceId, userId } = await seedBase();
  const f = await seedAgentRun(workspaceId, userId, {
    userText: "写一篇代码示例【mock:wants-tool】【mock:escaped-note】", permissionLevel: "read_only",
  });
  try {
    await invokeScriptedWrite(workspaceId, userId, { runId: f.runId }, "note");
    const state = await readState(workspaceId, userId, f);
    assert.equal(state.run.status, "waiting_for_confirmation");
    const [proposal] = state.proposals;
    const payload = typeof proposal.payload === "string" ? JSON.parse(proposal.payload) : proposal.payload;
    assert.equal(payload.kind, "agent_tool_review");
    assert.equal(payload.confirmationStage, "after_preview");
    assert.equal(payload.preview.markdown, "```text\n" + "\\".repeat(9500) + "\n```");
    assert.ok(state.toolCalls.some(call => call.name === "notes.write.create" && call.status === "waiting_confirmation"));
    const rows = await sql.begin(async tx => {
      await tx`SELECT set_config('app.workspace_id',${workspaceId},true),set_config('app.user_id',${userId},true)`;
      return tx`SELECT count(*)::int AS count FROM notes WHERE workspace_id=${workspaceId}`;
    });
    assert.equal(rows[0].count, 0, "预览不能进入正式笔记或自动保存");
  } finally { await f.cleanup(); }
});

/** A real, finite task must outlive the old guessed step/tool budgets. */
test("Agent：20 个工具回合继续执行到任务完成，不提前收起工具面", async () => {
  const { workspaceId, userId } = await seedBase();
  const f = await seedAgentRun(workspaceId, userId, {
    userText: "看一下我的学习进度【mock:wants-tool】【mock:twenty-tool-rounds】",
    agentElapsedMs: 3_000_000_000,
  });
  try {
    await invoke(workspaceId, userId, { runId: f.runId });
    const s = await readState(workspaceId, userId, f);
    const types = s.events.map(e => (e as { type: string }).type);
    assert.equal(s.run.status, "succeeded");
    assert.ok(types.includes("assistant.final"));
    assert.equal(types.includes("error"), false);
    assert.equal(Number(s.run.step_count), 21);
    assert.equal(Number(s.run.tool_call_count), 20);
    // 每一个模型步骤都过真实原子计数，不受旧默认调用上限截断。上限 12 次是这次
    // 要证明"早已不起作用"的那个数——21 步本身就超过它。
    assert.ok(Number(s.run.model_call_count) >= Number(s.run.step_count),
      `每一步都要计入模型调用（实际 ${s.run.model_call_count} 次 / ${s.run.step_count} 步）`);
    assert.ok(Number(s.run.model_call_count) > 12, "模型调用数必须真的越过旧默认上限");
    assert.ok(Number(s.run.agent_elapsed_ms) >= 3_000_000_000, "累计活跃时间不被整型毫秒计数截断");
    assert.deepEqual(s.run.budget_snapshot, { maxSteps: null, maxToolCallsPerStep: null,
      maxToolCalls: null, maxModelCalls: null, maxWebSearchCalls: null, deadlineMs: null });
    assert.equal(s.toolCalls.length, 20, "每次读取都经过真实账本，不复用旧读取回执");
    assert.ok(s.toolCalls.every(call => call.status === "succeeded"));
    assert.equal(s.assistant.length, 1);
  } finally {
    await f.cleanup();
  }
});

test("Agent 确认续跑：带 proposalId 重新入队 → 同一次 run 回填结果并产出最终答复", async () => {
  const { workspaceId, userId } = await seedBase();
  const f = await seedAgentRun(workspaceId, userId, { userText: "看一下我的学习进度" });
  try {
    // 造出"已确认"的现场：run 停在等待确认、冻结工具调用与 proposal（decision=confirm）
    const proposalId = randomUUID();
    const stepId = randomUUID();
    const toolCallId = "call_confirmed_1";
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${userId}, true)`;
      await tx`INSERT INTO companion_agent_steps
                 (id, workspace_id, user_id, conversation_id, run_id, step_no, kind, status)
               VALUES (${stepId}, ${workspaceId}, ${userId}, ${f.conversationId}, ${f.runId}, 1, 'model', 'waiting')`;
      await tx`INSERT INTO companion_agent_tool_calls
                 (id, workspace_id, user_id, conversation_id, run_id, step_id, tool_call_id, name,
                  tool_version, arguments, arguments_sha256, risk_class, status, proposal_id,
                  result_safe_summary)
               VALUES (${randomUUID()}, ${workspaceId}, ${userId}, ${f.conversationId}, ${f.runId}, ${stepId},
                       ${toolCallId}, 'companion_start_learning', '1.0.0',
                       '{}'::jsonb, ${"c".repeat(64)}, 'consequential', 'succeeded', ${proposalId},
                       '已开始学习')`;
      await tx`INSERT INTO companion_action_proposals
                 (id, workspace_id, user_id, conversation_id, source_message_id, source_generation,
                  payload, payload_sha256, title, target_summary, impact_summary, status, decision,
                  decided_at, idempotency_key_hash, expires_at, origin, agent_run_id, agent_tool_call_id,
                  agent_tool_version, risk_class)
               VALUES (${proposalId}, ${workspaceId}, ${userId}, ${f.conversationId}, ${f.userMessageId}, 1,
                       ${tx.json({ kind: "start_learning_run" })}, ${"d".repeat(64)},
                       '开始学习', '开始学习', '会改变学习状态', 'succeeded', 'confirm', now(),
                       ${"e".repeat(64)}, now() + interval '5 minutes', 'agent_tool', ${f.runId},
                       ${toolCallId}, '1.0.0', 'consequential')`;
      await tx`UPDATE companion_turn_runs
               SET status = 'waiting_for_confirmation', waiting_proposal_id = ${proposalId},
                   permission_level = 'guided', step_count = 1, tool_call_count = 1
               WHERE id = ${f.runId}`;
    });

    // 与 API 侧决定端点等价的续跑入队：payload 带 proposalId
    await invoke(workspaceId, userId, { runId: f.runId, proposalId });
    const s = await readState(workspaceId, userId, f);

    assert.equal(s.run.status, "succeeded", "续跑必须把同一次 run 带到终态");
    assert.equal(s.run.waiting_proposal_id, null, "终态清空挂起指针");
    assert.equal(s.assistant.length, 1, "续跑产出 assistant 答复");
    assert.equal(s.run.permission_level, "guided", "续跑沿用本轮冻结的权限档，不重读设置");
    assert.ok(Number(s.run.step_count) >= 2, "步骤计数在原基础上继续累计，不重置");
    const types = s.events.map((e) => (e as { type: string }).type);
    assert.ok(types.includes("assistant.final"), "续跑以 assistant.final 结束");
  } finally {
    await f.cleanup();
  }
});

/**
 * 造出「已确认」的现场：run 停在等待确认、冻结工具调用与 proposal（decision=confirm）。
 * reasoningHandles 为 null 表示 0218 之前创建的历史行（无句柄）。
 */
async function seedConfirmedProposal(
  ws: string,
  uid: string,
  f: Fixture,
  toolCallId: string,
  reasoningHandles: unknown[] | null,
): Promise<string> {
  const proposalId = randomUUID();
  const stepId = randomUUID();
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
    await tx`SELECT set_config('app.user_id', ${uid}, true)`;
    await tx`INSERT INTO companion_agent_steps
               (id, workspace_id, user_id, conversation_id, run_id, step_no, kind, status)
             VALUES (${stepId}, ${ws}, ${uid}, ${f.conversationId}, ${f.runId}, 1, 'model', 'waiting')`;
    await tx`INSERT INTO companion_agent_tool_calls
               (id, workspace_id, user_id, conversation_id, run_id, step_id, tool_call_id, name,
                tool_version, arguments, arguments_sha256, risk_class, status, proposal_id,
                result_safe_summary, reasoning_handles)
             VALUES (${randomUUID()}, ${ws}, ${uid}, ${f.conversationId}, ${f.runId}, ${stepId},
                     ${toolCallId}, 'companion_start_learning', '1.0.0',
                     '{}'::jsonb, ${"c".repeat(64)}, 'consequential', 'succeeded', ${proposalId},
                     '已开始学习', ${reasoningHandles === null ? null : tx.json(reasoningHandles as postgres.JSONValue)}::jsonb)`;
    await tx`INSERT INTO companion_action_proposals
               (id, workspace_id, user_id, conversation_id, source_message_id, source_generation,
                payload, payload_sha256, title, target_summary, impact_summary, status, decision,
                decided_at, idempotency_key_hash, expires_at, origin, agent_run_id, agent_tool_call_id,
                agent_tool_version, risk_class)
             VALUES (${proposalId}, ${ws}, ${uid}, ${f.conversationId}, ${f.userMessageId}, 1,
                     ${tx.json({ kind: "start_learning_run" })}, ${"d".repeat(64)},
                     '开始学习', '开始学习', '会改变学习状态', 'succeeded', 'confirm', now(),
                     ${"e".repeat(64)}, now() + interval '5 minutes', 'agent_tool', ${f.runId},
                     ${toolCallId}, '1.0.0', 'consequential')`;
    await tx`UPDATE companion_turn_runs
             SET status = 'waiting_for_confirmation', waiting_proposal_id = ${proposalId},
                 permission_level = 'guided', step_count = 1, tool_call_count = 1
             WHERE id = ${f.runId}`;
  });
  return proposalId;
}

function continuationEvent(ws: string, uid: string, f: Fixture) {
  return {
    // 这些用例只验句柄的写读往返，不执行任何受外发政策管的工具；给一个
    // 什么都不放开的约束集，让"漏传约束"在类型上就暴露，而不是运行期 undefined。
    constraints: {},
    ctx: {
      id: randomUUID(),
      payload: {},
      workspaceId: ws,
      requestedBy: uid,
      leaseToken: "fixture-lease",
      signal: new AbortController().signal,
    },
    read: {
      runId: f.runId,
      conversationId: f.conversationId,
      userId: uid,
      userMessageId: f.userMessageId,
      generation: 1,
      runStatus: "waiting_for_confirmation",
      accountEpoch: 0,
      pageContext: null,
      userText: "",
      recentMessages: [],
      residentMemories: [],
      memoryDirectory: [],
      playbookCatalog: [],
      playbookCandidates: [],      deliveryObservation: null,
      organizationSurface: null,
      memoryRefs: [],
      hereAndNow: null,
      thisTurnFacts: null,
      livePageView: null,
      factSpans: null,
      conversationSummary: null,
      petProfile: null,
      personaProfileRevision: 0,
      personaExamplesRevision: 0,
      defaultExpressionVersion: "1",
      nextMessageSeq: 3,
      nextEventSeq: 100,
    },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

/**
 * 冷启动续跑必须从库里取回 reasoning 句柄（0218）。
 *
 * 同一 job 内多步工具循环靠进程内存透传句柄；但「用户确认 → 新 job」时消息由
 * loadContinuation 从 companion_agent_tool_calls 反建，句柄只在列里可取。
 * 取不回时，要求回传 reasoning 的模型（deepseek 思考模式）会在这一步非重试 400
 * 「The reasoning_text in the thinking mode must be passed back」。
 */
test("Agent 确认续跑：reasoning 句柄落库并在续跑消息中回传（0218）", async () => {
  const { workspaceId, userId } = await seedBase();
  const f = await seedAgentRun(workspaceId, userId, { userText: "看一下我的学习进度" });
  const handles = [
    { id: "rs_1", type: "reasoning", status: "completed", summary: [], encrypted_content: "enc-1" },
  ];
  try {
    const proposalId = await seedConfirmedProposal(workspaceId, userId, f, "call_rh_1", handles);
    const messages = await loadContinuation(
      continuationEvent(workspaceId, userId, f),
      [{ role: "user", content: "看一下我的学习进度" }],
      proposalId,
    );
    const assistant = messages.find((m) => m.role === "assistant");
    const tool = messages.find((m) => m.role === "tool");
    assert.ok(assistant, "续跑消息必须包含 assistant(toolCalls)");
    assert.ok(tool, "续跑消息必须包含工具结果");
    assert.deepEqual(
      assistant.toolCalls,
      [{ id: "call_rh_1", name: "companion_start_learning", arguments: {} }],
    );
    assert.deepEqual(assistant.reasoning, handles, "句柄必须从列里取回并挂回 assistant 消息");
    assert.equal(tool.toolCallId, "call_rh_1");
    assert.ok(
      messages.indexOf(assistant) < messages.indexOf(tool),
      "assistant 必须排在工具结果之前",
    );
  } finally {
    await f.cleanup();
  }
});

test("Agent 确认续跑：长回执 JSON 保持合法并保留末尾纠正", async () => {
  const { workspaceId, userId } = await seedBase();
  const f = await seedAgentRun(workspaceId, userId, { userText: "确认这项操作" });
  const summary = '包含引号"和换行\n的完整回执。'.repeat(300) + "末尾说明：只完成准备，没有执行发送。🙂";
  try {
    const proposalId = await seedConfirmedProposal(workspaceId, userId, f, "call_long_receipt", null);
    await sql.begin(async tx => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true),set_config('app.user_id', ${userId}, true)`;
      await tx`UPDATE companion_agent_tool_calls SET result_safe_summary=${summary} WHERE run_id=${f.runId}`;
    });
    const messages = await loadContinuation(continuationEvent(workspaceId, userId, f),
      [{ role: "user", content: "确认这项操作" }], proposalId);
    const tool = messages.find(message => message.role === "tool");
    assert.ok(tool && typeof tool.content === "string");
    assert.equal(JSON.parse(tool.content).summary, summary);
  } finally { await f.cleanup(); }
});

test("Agent 确认续跑：历史行无句柄时不注入 reasoning 字段（0218 之前的数据）", async () => {
  const { workspaceId, userId } = await seedBase();
  const f = await seedAgentRun(workspaceId, userId, { userText: "看一下我的学习进度" });
  try {
    const proposalId = await seedConfirmedProposal(workspaceId, userId, f, "call_rh_legacy", null);
    const messages = await loadContinuation(
      continuationEvent(workspaceId, userId, f),
      [{ role: "user", content: "看一下我的学习进度" }],
      proposalId,
    );
    const assistant = messages.find((m) => m.role === "assistant");
    assert.ok(assistant, "续跑消息必须包含 assistant(toolCalls)");
    assert.equal(assistant.reasoning, undefined, "NULL 列不得变成空数组或伪造句柄");
  } finally {
    await f.cleanup();
  }
});

/** Ledger writes now require a real current job, as they do in the handler. */
async function leasedToolEvent(ws: string, uid: string, f: Fixture) {
  const event = continuationEvent(ws, uid, f);
  await sql.begin(async tx => {
    await tx`SELECT set_config('app.workspace_id',${ws},true),set_config('app.user_id',${uid},true)`;
    await tx`INSERT INTO jobs(id,type,workspace_id,requested_by,payload,status,lease_token,started_at)
      VALUES(${event.ctx.id},'companion_agent',${ws},${uid},${tx.json({ runId: f.runId })},'running','fixture-lease',now())`;
    await tx`UPDATE companion_turn_runs SET job_id=${event.ctx.id} WHERE id=${f.runId}`;
  });
  return event;
}

for (const calendar of [
  { name: "local midnight and leap day", zone: "Asia/Shanghai", acceptedAt: "2032-02-28T16:30:00Z", expected: "2032-03-01T01:00:00.000Z" },
  { name: "year boundary", zone: "Asia/Shanghai", acceptedAt: "2030-12-31T00:30:00Z", expected: "2031-01-01T01:00:00.000Z" },
  { name: "daylight-saving calendar day", zone: "America/New_York", acceptedAt: "2032-03-13T15:00:00Z", expected: "2032-03-14T13:00:00.000Z" },
  { name: "elapsed minutes", zone: "Asia/Shanghai", acceptedAt: "2032-02-28T16:30:00Z", expected: "2032-02-28T18:00:00.000Z",
    timing: { afterMinutes: 90 }, expectedDay: 0 },
  { name: "next calendar week", zone: "America/New_York", acceptedAt: "2032-03-13T15:00:00Z", expected: "2032-03-15T13:00:00.000Z",
    timing: { weekday: 1, weeksFromThisWeek: 1, time: "09:00" }, expectedDay: 2 },
]) test(`relative reminder uses the accepted local calendar across ${calendar.name}`, async () => {
  const { workspaceId, userId } = await seedBase();
  const fixture = await seedAgentRun(workspaceId, userId, { userText: "明天上午九点提醒我" });
  try {
    await sql`UPDATE user_companion_account_state SET quiet_hours=${sql.json({ timezone: calendar.zone })} WHERE user_id=${userId}`;
    await sql`UPDATE companion_messages SET created_at=${calendar.acceptedAt}::timestamptz WHERE id=${fixture.userMessageId}`;
    const { executeDirectTool } = await import("../handlers/tools/companion-tool-execution.ts");
    const result = await executeDirectTool(await leasedToolEvent(workspaceId, userId, fixture), getCompanionAgentTool("companion_attention_write")!,
      { action: "schedule_reminder", text: "复习", reminderTime: calendar.timing ?? { daysFromToday: 1, time: "09:00" } });
    assert.equal(result.value.daysFromRequest, calendar.expectedDay ?? 1);
    assert.equal(result.value.timezone, calendar.zone);
    const [row] = await sql`SELECT fire_at FROM companion_reminders WHERE workspace_id=${workspaceId} AND user_id=${userId}`;
    assert.equal(new Date(row.fire_at).toISOString(), calendar.expected,
      "execution time and UTC day must not replace the original user's calendar day");
  } finally { await fixture.cleanup(); }
});

test("past and nonexistent local reminder times create no pending or cancelled row", async () => {
  const { workspaceId, userId } = await seedBase();
  const fixture = await seedAgentRun(workspaceId, userId, { userText: "设置明确时间的提醒" });
  try {
    await sql`UPDATE user_companion_account_state SET quiet_hours=${sql.json({ timezone: "America/New_York" })} WHERE user_id=${userId}`;
    const { executeDirectTool } = await import("../handlers/tools/companion-tool-execution.ts");
    const event = await leasedToolEvent(workspaceId, userId, fixture);
    for (const reminderTime of [{ date: "2000-01-01", time: "09:00" }, { date: "2032-03-14", time: "02:30" }])
      await assert.rejects(executeDirectTool(event, getCompanionAgentTool("companion_attention_write")!,
        { action: "schedule_reminder", text: "test", reminderTime }), /已经过去|不存在/);
    const [row] = await sql`SELECT count(*)::int AS count FROM companion_reminders WHERE workspace_id=${workspaceId} AND user_id=${userId}`;
    assert.equal(row.count, 0, "invalid schedules must not leave a cancelled side effect behind");
  } finally { await fixture.cleanup(); }
});

test("search provenance restores canonical and legacy receipts only from the current successful scoped run", async () => {
  const scope = await seedBase();
  const f = await seedAgentRun(scope.workspaceId, scope.userId, { userText: "核对公开来源" });
  try {
    await sql.begin(async tx => {
      await tx`SELECT set_config('app.workspace_id',${scope.workspaceId},true),set_config('app.user_id',${scope.userId},true)`;
      const stepId = randomUUID();
      await tx`INSERT INTO companion_agent_steps(id,workspace_id,user_id,conversation_id,run_id,step_no,kind,status)
        VALUES(${stepId},${scope.workspaceId},${scope.userId},${f.conversationId},${f.runId},1,'model','running')`;
      for (const [index, name, status] of [[1,"web.search","succeeded"],[2,"agent_web_search","succeeded"],
        [3,"web.search","failed"],[4,"notes.read.read","succeeded"]] as const) {
        const ref = JSON.stringify({ status:"succeeded",query:"公开资料",searchedAt:new Date().toISOString(),
          sources:[{url:`https://example.com/source-${index}`,title:"来源",content:"事实",media:"官网",publishDate:""}] });
        await tx`INSERT INTO companion_agent_tool_calls(id,workspace_id,user_id,conversation_id,run_id,step_id,
          tool_call_id,name,tool_version,arguments,arguments_sha256,risk_class,status,result_ref)
          VALUES(${randomUUID()},${scope.workspaceId},${scope.userId},${f.conversationId},${f.runId},${stepId},${`source-${index}`},
            ${name},'1.0.0','{}'::jsonb,${"c".repeat(64)},'read',${status},${ref})`;
      }
    });
    const restored = await readCompanionWebSearchReceipts(scope, f.runId);
    assert.deepEqual(restored.flatMap(result => result.sources.map(source => source.url)).sort(),
      ["https://example.com/source-1","https://example.com/source-2"]);
    assert.deepEqual(await readCompanionWebSearchReceipts(scope, randomUUID()), []);
    assert.deepEqual(await readCompanionWebSearchReceipts({ ...scope,userId:randomUUID() },f.runId), []);
  } finally { await f.cleanup(); }
});

test("document redirect provenance restores only successful scoped reads with an intact result receipt", async () => {
  const scope = await seedBase();
  const f = await seedAgentRun(scope.workspaceId, scope.userId, { userText: "读取公开网页" });
  const { readCompanionDocumentRedirects } = await import("../handlers/tools/companion-document-provenance.ts");
  const { encodeCompanionToolResult } = await import("../handlers/agent/companion-runtime-checkpoint.ts");
  try {
    const stepId = randomUUID();
    await sql`INSERT INTO companion_agent_steps(id,workspace_id,user_id,conversation_id,run_id,step_no,kind,status)
      VALUES(${stepId},${scope.workspaceId},${scope.userId},${f.conversationId},${f.runId},1,'model','running')`;
    for (const [index, name, status] of [[1,"web.read_document","succeeded"],[2,"agent_read_public_document","succeeded"],
      [3,"web.read_document","failed"],[4,"notes.read.read","succeeded"],[5,"web.search","succeeded"],[6,"web.search","succeeded"]] as const) {
      const document = { status: "succeeded", url: `https://example.com/${index}/`, contentHash: "d".repeat(64), text: "Actually read paragraph" };
      const result = encodeCompanionToolResult({ value: name === "web.search" ? { status: "succeeded",
        sources: [{ referenceId: `web-${index}`, url: `https://example.com/${index}` }],
        documents: [{ referenceId: index === 6 ? "wrong-source" : `web-${index}`, requestedUrl: `https://example.com/${index}`, document }] }
        : document, safeSummary: "Read" });
      await sql`INSERT INTO companion_agent_tool_calls(id,workspace_id,user_id,conversation_id,run_id,step_id,
        tool_call_id,name,tool_version,arguments,arguments_sha256,risk_class,status,result_payload)
        VALUES(${randomUUID()},${scope.workspaceId},${scope.userId},${f.conversationId},${f.runId},${stepId},${`read-${index}`},
          ${name},'1.0.0',${sql.json({url:`https://example.com/${index}`})},${"c".repeat(64)},'read',${status},${sql.json(result)})`;
    }
    const expected = [1,2,5].map(index => ({ requestedUrl: `https://example.com/${index}`, url: `https://example.com/${index}/` }));
    assert.deepEqual((await readCompanionDocumentRedirects(scope, f.runId)).sort((a,b) => a.url.localeCompare(b.url)), expected);
    assert.deepEqual(await readCompanionDocumentRedirects(scope, randomUUID()), []);
    assert.deepEqual(await readCompanionDocumentRedirects({ ...scope, userId: randomUUID() }, f.runId), []);
  } finally { await f.cleanup(); }
});

test("Agent 工具调用：句柄经真实写入 SQL 落库，形状与读回一致（0218 写读往返）", async () => {
  const { workspaceId, userId } = await seedBase();
  const f = await seedAgentRun(workspaceId, userId, { userText: "开始学习" });
  const handles = [
    { id: "rs_rt", type: "reasoning", status: "completed", summary: [], encrypted_content: "enc-rt" },
  ];
  try {
    const stepId = randomUUID();
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${userId}, true)`;
      await tx`INSERT INTO companion_agent_steps
                 (id, workspace_id, user_id, conversation_id, run_id, step_no, kind, status)
               VALUES (${stepId}, ${workspaceId}, ${userId}, ${f.conversationId}, ${f.runId}, 1,
                       'model', 'running')`;
    });
    const definition = getCompanionAgentTool("companion_memory_write");
    assert.ok(definition, "工具定义必须存在");

    // 走生产写入路径（类型检查覆盖不到列名/参数绑定，必须实库往返）
    const record = await ensureAgentToolCall(
      await leasedToolEvent(workspaceId, userId, f),
      stepId,
      definition,
      { id: "call_rt_1", arguments: {} },
      "f".repeat(64),
      handles,
    );
    assert.equal(record.isNew, true, "首次写入必须落新行");

    const stored = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${userId}, true)`;
      return tx`SELECT reasoning_handles FROM companion_agent_tool_calls
                WHERE run_id = ${f.runId} AND tool_call_id = ${"call_rt_1"}`;
    });
    assert.deepEqual(
      stored[0].reasoning_handles,
      handles,
      "写入 SQL 必须把句柄原样存成 jsonb 数组（读回形状与产出一致）",
    );
  } finally {
    await f.cleanup();
  }
});

test("Agent 写操作结果不明：provider 换 call id 时不重放；相同只读查询仍可重读", async () => {
  const { workspaceId, userId } = await seedBase();
  const f = await seedAgentRun(workspaceId, userId, { userText: "设一个提醒" });
  try {
    const stepId = randomUUID();
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${userId}, true)`;
      await tx`INSERT INTO companion_agent_steps
                 (id, workspace_id, user_id, conversation_id, run_id, step_no, kind, status)
               VALUES (${stepId}, ${workspaceId}, ${userId}, ${f.conversationId}, ${f.runId}, 1,
                       'model', 'running')`;
    });
    const event = await leasedToolEvent(workspaceId, userId, f);
    const definition = getCompanionAgentTool("companion_attention_write");
    assert.ok(definition);
    const arguments_ = { text: "复习", fireAtLocal: "2026-10-01T18:00" };
    const argsHash = safeArgumentsHash(arguments_);
    const first = await ensureAgentToolCall(
      event,
      stepId,
      definition,
      { id: "call_uncertain_1", arguments: arguments_ },
      argsHash,
    );
    assert.equal(first.isNew, true);
    // Simulate a worker crash after execution began: the catch path never got
    // to persist an outcome, so recovery must fence the write as uncertain.
    await updateToolCall(event, first.toolCallId, { status: "executing" });

    const retry = await ensureAgentToolCall(
      event,
      stepId,
      definition,
      { id: "call_uncertain_2", arguments: arguments_ },
      argsHash,
    );
    assert.deepEqual(retry, {
      isNew: false,
      toolCallId: "call_uncertain_1",
      status: "outcome_unknown",
      proposalId: null,
      resultRef: null,
      safeSummary: "这项操作可能已经发生，但暂时没有确定回执；请先核对状态，不要重复操作。",
    });

    const rows = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${userId}, true)`;
      return tx`SELECT tool_call_id, status FROM companion_agent_tool_calls WHERE run_id = ${f.runId}`;
    });
    assert.deepEqual(
      rows.map((row) => ({ tool_call_id: row.tool_call_id, status: row.status })),
      [{ tool_call_id: "call_uncertain_1", status: "outcome_unknown" }],
    );

    const readDefinition = getCompanionAgentTool("companion_observe");
    assert.ok(readDefinition);
    const readHash = safeArgumentsHash({});
    const firstRead = await ensureAgentToolCall(
      event,
      stepId,
      readDefinition,
      { id: "call_read_1", arguments: {} },
      readHash,
    );
    const secondRead = await ensureAgentToolCall(
      event,
      stepId,
      readDefinition,
      { id: "call_read_2", arguments: {} },
      readHash,
    );
    assert.equal(firstRead.isNew, true);
    assert.equal(secondRead.isNew, true, "重复读取应重新查询，不折叠为旧回执");
  } finally {
    await f.cleanup();
  }
});

/** Explicit deployment time limits still stop before any provider or tool call. */
test("Agent 执行预算：累计耗时段已达显式部署时限 → 直接终结且不调用 provider", async () => {
  const { workspaceId, userId } = await seedBase();
  const f = await seedAgentRun(workspaceId, userId, {
    userText: "看一下我的学习进度",
    agentElapsedMs: 60_000,
  });
  const oldTimeout = process.env.WORKER_TIMEOUT_COMPANION_AGENT_MS;
  process.env.WORKER_TIMEOUT_COMPANION_AGENT_MS = "60000";
  try {
    await assert.rejects(
      invoke(workspaceId, userId, { runId: f.runId }),
      /execution budget exhausted/,
    );
    const s = await readState(workspaceId, userId, f);
    assert.equal(s.run.status, "failed", "预算耗尽必须失败关闭");
    // 被拒绝的轮次会留下**一条失败兜底答复**（fail-open：不能让用户面对空白），
    // 所以这里钉的是"没有终态答复事件"，而不是"没有 assistant 行"。
    assert.ok(!s.events.some((e) => (e as { type: string }).type === "assistant.final"),
      "被拒绝的执行不得下发终态答复");
    assert.equal(s.toolCalls.length, 0, "不得执行任何工具");
    assert.equal(s.steps.length, 0, "不得开始新步骤");
  } finally {
    if (oldTimeout === undefined) delete process.env.WORKER_TIMEOUT_COMPANION_AGENT_MS;
    else process.env.WORKER_TIMEOUT_COMPANION_AGENT_MS = oldTimeout;
    await f.cleanup();
  }
});

test("Agent epoch fence：run 冻结的 epoch 与当前不一致 → 拒绝执行且零副作用", async () => {
  const { workspaceId, userId } = await seedBase();
  const f = await seedAgentRun(workspaceId, userId, {
    userText: "看一下我的学习进度",
    runAccountEpoch: 0,
    accountEpoch: 5, // 账号已换代：迟到结果必须被拒绝
  });
  try {
    await assert.rejects(
      invoke(workspaceId, userId, { runId: f.runId }),
      /epoch is stale or globally disabled/,
    );
    const s = await readState(workspaceId, userId, f);
    // 被拒绝的轮次会留下**一条失败兜底答复**（fail-open：不能让用户面对空白），
    // 所以这里钉的是"没有终态答复事件"，而不是"没有 assistant 行"。
    assert.ok(!s.events.some((e) => (e as { type: string }).type === "assistant.final"),
      "被拒绝的执行不得下发终态答复");
    assert.equal(s.toolCalls.length, 0, "epoch 失效时不得执行工具");
    assert.equal(s.proposals.length, 0, "epoch 失效时不得冻结确认");
  } finally {
    await f.cleanup();
  }
});

/**
 * 通用读页面（doc 37）：`companion_read_current_page` 背后那条查询的真实往返。
 *
 * 这里唯一值得钉的是**跨空间/跨账号守卫**：`assistant_page_contexts` 的 RLS 守卫
 * 对 `astella_worker` 是按用户名放行的（`CURRENT_USER = 'astella_worker' OR ...`），
 * 也就是说行级隔离在这条路径上根本不存在，SQL 里那两个 id 条件是唯一的闸。
 * 本地绿不等于它有闸（dev 的 api 角色还是 BYPASSRLS），所以断言写成
 * "换一个 user 就必须什么都读不到"——去掉任一条件都会让它红。
 */
type ContextSeed = "live" | "revoked" | "expired" | "older-but-longer-lease";

/** 按这几种生命周期各造一条 context 行；时间全部在 JS 侧算，不拼裸 SQL。 */
async function seedPageContext(
  ws: string,
  uid: string,
  title: string,
  state: ContextSeed,
): Promise<string> {
  const id = randomUUID();
  const now = Date.now();
  // `older-but-longer-lease`：发得更早、剩余租约却长得多（后台那一屏一直在续租）。
  const issuedAt = new Date(
    state === "expired" ? now - 60_000 : state === "older-but-longer-lease" ? now - 20_000 : now,
  );
  const expiresAt = new Date(
    state === "expired" ? now - 5_000 : state === "older-but-longer-lease" ? now + 600_000 : now + 30_000,
  );
  const revokedAt = state === "revoked" ? new Date(now) : null;
  const routeRef = { kind: "note", noteId: randomUUID() };
  const readableView = {
    pageId: "card_generation_progress",
    title,
    metrics: [{ label: "进度", value: "已写出 3 / 4 张候选" }],
    items: [{ ordinal: 1, label: "提取线索" }],
  };
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
    await tx`SELECT set_config('app.user_id', ${uid}, true)`;
    // entity_refs / capability_hints 走列默认值：jsonb 列直接传 JS 空数组会被
    // postgres.js 当成 Postgres 数组，那是另一类静默失败。
    await tx`
      INSERT INTO assistant_page_contexts
        (id, workspace_id, user_id, page_instance_id, revision, route_ref, page_kind,
         sensitivity, interaction_state, readable_view, issued_at, expires_at, revoked_at)
      VALUES (${id}, ${ws}, ${uid}, ${`pi-${id}`}, ${`rev-${id}`}, ${tx.json(routeRef)}, ${"note"},
              ${"normal"}, ${"processing"}, ${tx.json(readableView)},
              ${issuedAt}, ${expiresAt}, ${revokedAt})
    `;
  });
  return id;
}

test("读页面：worker 绕过 RLS，但 workspace/user 两个条件仍然把别人的屏挡住", async () => {
  const mine = await seedBase();
  const theirs = await seedBase();
  await seedPageContext(mine.workspaceId, mine.userId, "上一屏（已撤销）", "revoked");
  await seedPageContext(mine.workspaceId, mine.userId, "早就关掉的窗口", "expired");
  await seedPageContext(mine.workspaceId, mine.userId, "把《我的笔记》整理成学习卡", "live");
  await seedPageContext(theirs.workspaceId, theirs.userId, "把《别人的笔记》整理成学习卡", "live");

  const { withWorkerWorkspaceTransaction } = await import("../db.ts");
  const { readLatestPageContextRow, currentPageToolResult } = await import(
    "../handlers/tools/companion-read-tools.ts"
  );
  const read = (ws: string, uid: string) => withWorkerWorkspaceTransaction(
    { workspaceId: ws, userId: uid },
    (tx) => readLatestPageContextRow(tx, { workspaceId: ws, userId: uid }),
  );

  const own = await read(mine.workspaceId, mine.userId);
  assert.ok(own, "自己这一页必须读得到");
  assert.equal((own.readable_view as { title: string }).title, "把《我的笔记》整理成学习卡",
    "已撤销与已过期的那两条不能被当成当前这一屏");
  const result = currentPageToolResult(own);
  assert.equal(result.value.available, true);
  assert.equal((result.value.metrics as Array<{ value: string }>)[0].value, "已写出 3 / 4 张候选");

  // 同 workspace 换 user：必须什么都读不到（漏掉 user_id 条件时这里会拿到上面那条）。
  assert.equal(await read(mine.workspaceId, theirs.userId), null,
    "user 条件一漏，别人这一屏就成了她的读数");

  // 全新作用域：available=false，而不是拿旧数据或别人的数据顶上。
  const lonely = await seedBase();
  const none = await read(lonely.workspaceId, lonely.userId);
  assert.equal(none, null);
  assert.equal(currentPageToolResult(none).value.available, false);
});

test("读页面：同一账号同时两行活着时，认的是最新那一屏而不是剩得最久的那一行", async () => {
  // 为什么现在要钉这一条：2026-09-25 修好续租之前，租约最多活 40 秒，"两行同时活着"
  // 只可能出现在一次导航风暴里；修完之后一个挂着不动的窗口可以一直续下去，
  // 于是"早发出去、租约还长"这一行会长期存在（dev 实测 14 天内 1 470 个瞬间同时有多行）。
  // 读侧唯一的凭据就是 `ORDER BY issued_at DESC`——改成按剩余租约排就会说错屏。
  const { withWorkerWorkspaceTransaction } = await import("../db.ts");
  const { readLatestPageContextRow } = await import("../handlers/tools/companion-read-tools.ts");
  const read = (ws: string, uid: string) => withWorkerWorkspaceTransaction(
    { workspaceId: ws, userId: uid },
    (tx) => readLatestPageContextRow(tx, { workspaceId: ws, userId: uid }),
  );
  const titleOf = (row: { readable_view: unknown } | null) =>
    (row?.readable_view as { title?: string } | undefined)?.title ?? null;

  // 第一半是分母自证：单独造那一条"后台屏"时必须**读得到**。少了这一步，
  // 第二半可能只是在比"谁被 expires／revoked 过滤掉了"，而不是比顺序。
  const backStage = await seedBase();
  await seedPageContext(backStage.workspaceId, backStage.userId, "后台那一屏（一直在续租）", "older-but-longer-lease");
  assert.equal(titleOf(await read(backStage.workspaceId, backStage.userId)), "后台那一屏（一直在续租）",
    "这条夹具形状本身就该是活的，否则下面那句比的是过滤不是顺序");

  // 第二半：同一个账号再叠一条刚发出去的，读到的必须是新的那条。
  const scope = await seedBase();
  await seedPageContext(scope.workspaceId, scope.userId, "后台那一屏（一直在续租）", "older-but-longer-lease");
  await seedPageContext(scope.workspaceId, scope.userId, "正在看的这一屏", "live");
  const row = await read(scope.workspaceId, scope.userId);
  assert.equal(titleOf(row), "正在看的这一屏",
    "按剩余租约排就会把用户没在看的那一屏当成「这一页」");
  assert.ok(Number(row?.content_age_seconds) <= 5,
    "这一屏的年龄只由 issued_at 算：拿到 20 秒前那一条，说明读的是后台那一屏");
});

/**
 * 同一条偏好不许存两遍，且她已经记过的那几条要对她可见（2026-10-10 真实栈）。
 *
 * 现场：用户三次说同一句纠正，她三次都"新存"了一条偏好——每一遍都能逐字核对过来源门，
 * 而**已有条目对她不可见**，于是措辞略有差别就变成第二条、第三条。这里钉两件事：
 * 逐字相同的不写第二遍（并把已有那条的 id 交回去），同类已有条目连 id 一起给她看。
 */
test("同一句偏好不重复写第二遍：第二次回执指向已有的那条", async () => {
  // 两轮在**同一个 workspace**：重复写入是同一份记忆台账里的事。清理按 workspace 一次做完
  // （两个 fixture 各删一次 workspace 会撞上另一边的会话外键）。
  const { workspaceId, userId } = await seedBase();
  const first = await seedAgentRun(workspaceId, userId, {
    userText: "以后打招呼别盘点笔记【mock:wants-memory】", permissionLevel: "full",
  });
  const second = await seedAgentRun(workspaceId, userId, {
    userText: "以后打招呼别盘点笔记【mock:wants-memory】", permissionLevel: "full",
  });
  const readMemories = async () => await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${userId}, true)`;
    return tx`SELECT id, content, kind FROM assistant_memory_items
              WHERE workspace_id = ${workspaceId} AND user_id = ${userId}
                AND deleted_at IS NULL AND dismissed_at IS NULL AND archived_at IS NULL`;
  });
  try {
    await invokeScriptedWrite(workspaceId, userId, { runId: first.runId }, "memory");
    const afterFirst = await readMemories();
    assert.equal(afterFirst.length, 1, "第一遍应当真的写进一条偏好");

    await invokeScriptedWrite(workspaceId, userId, { runId: second.runId }, "memory");
    const afterSecond = await readMemories();
    assert.equal(afterSecond.length, 1, "逐字相同的第二条不该落库");
    assert.equal(afterSecond[0].id, afterFirst[0].id, "留下的仍是第一条");

    const calls = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${userId}, true)`;
      return tx`SELECT result_safe_summary FROM companion_agent_tool_calls
                WHERE run_id = ${second.runId} AND name = 'memory.write.save'`;
    });
    assert.match(String(calls[0]?.result_safe_summary ?? ""), /已经记过/,
      "第二遍的回执要说清是「已经记过」，而不是假装又存了一条");
  } finally {
    // 两个 fixture 共用一个 workspace：清理由这里做一次（fixture 的 cleanup 各自会去删
    // workspace，先跑的会把另一个还没删的会话顶在外键上）。
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${userId}, true)`;
      await tx`DELETE FROM companion_agent_tool_calls WHERE conversation_id IN (${first.conversationId}, ${second.conversationId})`;
      await tx`DELETE FROM companion_agent_steps WHERE conversation_id IN (${first.conversationId}, ${second.conversationId})`;
      await tx`DELETE FROM companion_stream_events WHERE conversation_id IN (${first.conversationId}, ${second.conversationId})`;
      await tx`DELETE FROM companion_turn_runs WHERE conversation_id IN (${first.conversationId}, ${second.conversationId})`;
      await tx`DELETE FROM companion_messages WHERE conversation_id IN (${first.conversationId}, ${second.conversationId})`;
      await tx`DELETE FROM companion_conversations WHERE id IN (${first.conversationId}, ${second.conversationId})`;
      await tx`DELETE FROM assistant_memory_items WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM jobs WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM workspace_members WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM workspaces WHERE id = ${workspaceId}`;
      await tx`DELETE FROM users WHERE id = ${userId}`;
    });
  }
});

test("primary 429 continues the same durable turn on the configured alternate without retrying the limited account", async () => {
  const directory = mkdtempSync(join(tmpdir(), "companion-rate-recovery-"));
  const originalConfig = process.env.AI_PLATFORMS_CONFIG;
  const configPath = join(directory, "platforms.json");
  writeFileSync(configPath, JSON.stringify({platforms:{recovery:{type:"mock",models:{
    limited:{contextWindowTokens:1_000_000,maxOutputTokens:32_000,vision:false},
    alternate:{contextWindowTokens:1_000_000,maxOutputTokens:32_000,vision:false},
  }}},capabilities:{agent_turn:{platform:"recovery",model:"limited"},
    companion_fallback:{platform:"recovery",model:"alternate"}}}));
  process.env.AI_PLATFORMS_CONFIG = configPath;
  resetPlatformConfigCache();
  let primaryCalls = 0, alternateCalls = 0;
  registerFactory("mock", "agent_turn", config => {
    const provider = new MockProvider({modelProfile:config.modelProfile});
    provider.modelId = config.model ?? "mock-v1";
    Object.defineProperty(provider, "chatCompletionStream", {value:undefined});
    const original = provider.executeAgentTurn.bind(provider);
    provider.executeAgentTurn = async (request, signal) => {
      if (request.role !== "companion_agent") return original(request, signal);
      if (config.model === "limited") {
        primaryCalls++;
        throw new ProviderRequestError({provider:"mock",status:429});
      }
      alternateCalls++;
      assert.equal(request.messages.filter(message => message.role === "user").length, 1);
      return {content:"[neutral]在呢。",toolCalls:[],finishReason:"stop",usage:null,providerRequestId:"alternate-result"};
    };
    return provider;
  });
  const {workspaceId,userId} = await seedBase();
  const fixture = await seedAgentRun(workspaceId,userId,{userText:"你好",permissionLevel:"full"});
  try {
    await invoke(workspaceId,userId,{runId:fixture.runId});
    const [run] = await sql`SELECT status,model_id FROM companion_turn_runs WHERE id=${fixture.runId}`;
    assert.equal(run.status,"succeeded");
    assert.equal(run.model_id,"alternate");
    assert.equal(primaryCalls,1);
    assert.equal(alternateCalls,1);
    const steps = await sql`SELECT status,error_code FROM companion_agent_steps WHERE run_id=${fixture.runId} ORDER BY step_no`;
    assert.equal(steps[0]?.error_code,"PROVIDER_RATE_LIMITED");
    assert.equal(steps.at(-1)?.status,"succeeded");
    const messages = await sql`SELECT blocks FROM companion_messages WHERE run_id=${fixture.runId} AND role='assistant'`;
    assert.equal(messages.length,1);
    assert.match(JSON.stringify(messages[0]?.blocks),/在呢/);
  } finally {
    await fixture.cleanup();
    if (originalConfig === undefined) delete process.env.AI_PLATFORMS_CONFIG;
    else process.env.AI_PLATFORMS_CONFIG = originalConfig;
    resetPlatformConfigCache();
    registerFactory("mock", "agent_turn", config => new MockProvider({modelProfile:config.modelProfile}));
    rmSync(directory,{recursive:true,force:true});
  }
});
