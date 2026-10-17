/**
 * P2 §5.2/§6.5 固定集成测试：worker companion_dialogue handler 真实 DB 编排。
 *
 * runbook 04 要求 `workers/ai-worker/src/integration-tests/companion-dialogue-postgres.integration.ts`
 * 存在（此前缺失，worker 链路零集成覆盖）。本文件覆盖：
 * - 真实终态：assistant.message 写入 + assistant.status/delta/final 事件 + run succeeded
 *   + last_event_seq 更新 + NOTIFY payload（companion_conversations 计数器推进）；
 * - fence：run 已被 cancel/supersede（status 非 active）时丢弃迟到输出，零副作用；
 * - userText 按 run.user_message_id 归属：当前 turn 是 voice_transcript（kind≠'text'）
 *   时也能取到本 run 的用户文本，而不是上一轮 text 消息（回归 2026-08-11 修复）。
 *
 * provider 使用 mock（测试环境显式不配置外部平台），
 * 验证的是 DB 编排与 fence，不验证 LLM 内容。
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sql as drizzleSql } from "drizzle-orm";
import {
  AgentRole,
  type AgentTurnRequest,
  COMPANION_IDENTITY_BOUNDARY_V4,
  COMPANION_PERSONA_V14_PROMPT_ID,
  COMPANION_PERSONA_V14_SHA256,
  companionPublicErrorCodeV1Schema,
} from "@astella/shared";
import { arrangeCompanionAttention } from "@astella/agent-host";
import { canonicalJsonV1, sha256Utf8V1, stableStringify } from "@astella/shared/content-hash";
import { testDatabaseUrl } from "@astella/shared/integration-test-db-env";
import type { CompanionContextHandoffSnapshotV1 } from "../handlers/turn/companion-dialogue-content.ts";
import { OpenCodeGoProvider } from "../lib/providers/opencode-go.ts";
import { ProviderStreamError } from "../lib/provider-request-error.ts";
import { AgentOutputError, CompanionContextChangedError } from "../lib/non-retryable-errors.ts";
import { JobLeaseLostError } from "../lib/job-lease.ts";
import { AIContextOverflowError } from "../lib/context-governor.ts";
import { createCompanionCompactionProgressStore } from "../handlers/context/companion-compaction-progress.ts";
import { summarizeCompleteCompanionSource } from "../handlers/context/companion-semantic-chunks.ts";
import type { CompanionSemanticCheckpoint } from "../handlers/context/companion-semantic-checkpoint.ts";
import { decodeCompanionToolResult } from "../handlers/agent/companion-runtime-checkpoint.ts";
import { agentTurnInterpretationV1Schema } from "@astella/shared/agent-contracts";

const CONN = testDatabaseUrl("DATABASE_URL_API");
// worker db.ts 读 DATABASE_URL，
// 确保 host 侧运行也指向同一数据库，避免回退到 Docker-only hostname `postgres`。
process.env.DATABASE_URL ??= CONN;
// 强制 mock provider：集成测试验证 DB 编排，不产生外部模型调用或费用。
delete process.env.TOKENRHYTHM_API_KEY;
delete process.env.AI_PLATFORMS_CONFIG;
process.env.COMPANION_DIALOGUE_V1_ENABLED = "true";

const sql = postgres(CONN, { max: 2 });

after(async () => {
  await sql.end({ timeout: 2 });
  const { closeDatabase } = await import("../db.ts");
  await closeDatabase();
});

const { runCompanionDialogue } = await import("../handlers/turn/companion-dialogue.ts");
// These cases script executeAgentTurn and check DB finalization. The generic
// mock chat stream does not execute those scripts. Streaming/first-step reuse
// is covered separately by companion-speculative-loop-postgres.integration.ts.
const { MockProvider } = await import("../lib/providers/mock.ts");
const mockStreamDescriptor = Object.getOwnPropertyDescriptor(MockProvider.prototype, "chatCompletionStream")!;
Object.defineProperty(MockProvider.prototype, "chatCompletionStream", { ...mockStreamDescriptor, value: undefined });
after(() => Object.defineProperty(MockProvider.prototype, "chatCompletionStream", mockStreamDescriptor));
const {
  persistCompanionContextHandoffSnapshot,
  markCompanionRunFailed,
  readConversationSummary,
  readCompanionHistoryRows,
  companionRecentHistoryFromRows,
  recordCompanionContextCompactions,
} = await import("../handlers/turn/companion-dialogue-store.ts");
const { buildCompanionPersonaMessages } = await import("../handlers/turn/companion-dialogue-content.ts");
const { withWorkerWorkspaceTransaction } = await import("../db.ts");
const { seedFormalAnswerRun } = await import("./helpers/formal-answer-fixture.ts");

/**
 * 断言用的读一律落在**这一轮的作用域**里。
 *
 * `companion_messages`／`companion_turn_runs`／`learning_exposures_v2` 三条策略在受限角色下
 * （本文件的 `CONN` 优先取 `DATABASE_URL_API`＝`astella_api`，`rolbypassrls=false`）要求
 * `app.workspace_id` **与** `app.user_id` 两个 GUC 同时成立，而裸 `sql` 读两个都不设 ⇒
 * 返回**空集而不是报错**——于是「她念了答案却没记账」和「这条连接根本读不到」在断言里长得
 * 一模一样（2026-09-25 干净一次性库实测：同一份文件、只换连接角色，超户 9／9、受限 6／9，
 * 红的正是三处裸读）。带上作用域以后 `rows.length === 1` 才是双重的：既证明写了，
 * 也证明那一空间那一用户真看得见。
 */
async function readInScope<T>(
  scope: { workspaceId: string; userId: string },
  fn: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  const scoped = await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${scope.workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${scope.userId}, true)`;
    return fn(tx);
  });
  // begin 的返回类型写成 `UnwrapPromiseArray<T>`，对泛型 T 永远收不拢（只有 T 已是数组时才展开），
  // 而运行时它就是 fn 的返回值本身——按调用点声明的形状收一次口。
  return scoped as unknown as T;
}

async function seedBase(): Promise<{ workspaceId: string; userId: string }> {
  const ws = randomUUID();
  const uid = randomUUID();
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
    await tx`SELECT set_config('app.user_id', ${uid}, true)`;
    await tx`INSERT INTO users (id, email, password_hash, role) VALUES (${uid}, ${"t-" + uid.slice(0, 8) + "@x.test"}, 'h', 'owner')`;
    await tx`INSERT INTO workspaces (id, name, owner_id) VALUES (${ws}, ${"w" + ws.slice(0, 8)}, ${uid})`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${ws}, ${uid}, 'owner')`;
    await tx`INSERT INTO user_ai_settings (user_id, consent_version, consent_at, data_policy)
             VALUES (${uid}, 'integration-test-v1', now(),
                     ${tx.json({ sendToExternal: false, sendImageContent: false, piiDetection: true, auditLogging: true })})`;
  });
  return { workspaceId: ws, userId: uid };
}

async function seedDialogueRun(
  ws: string,
  uid: string,
  options: {
    userKind?: "text" | "voice_transcript";
    runStatus?: string;
    userText?: string;
    /** 插入一条更新的 text 用户消息，验证 userText 不按“最近 text”取。 */
    newerTextMessage?: boolean;
    /**
     * 主动交流那一轮（方案 56）：没有用户消息，run 的 `input_source` 记 initiative。
     * 0423 的 `companion_turn_input_identity` 只允许这一形状（二者必居其一）。
     */
    initiative?: boolean;
    /** 多个 run 共用同一测试账号时，由最后一个 fixture 统一删除账号和空间。 */
    cleanupWorkspace?: boolean;
    /**
     * 这一轮开问时用户停在哪一屏：写**实时那一行** `assistant_page_contexts`
     * （伴星暴露记账的入口条件读它）。
     *
     * 这里刻意不写 `run.page_context`：那一列由 API 的 `sanitizeContext` 收窄成
     * pageKind/sharing/revision 三个审计字段，往它塞 `interactionState` 的夹具
     * 是在伪造一个服务端永远不会产生的形状——那样测出来的"绿"什么都不是。
     */
    livePage?: { pageKind: string; interactionState: string; learningRunId: string | null };
  } = {},
): Promise<{ runId: string; jobId: string; cid: string; userMessageId: string; cleanup: () => Promise<void> }> {
  const runId = randomUUID();
  const jobId = randomUUID();
  const cid = randomUUID();
  const userMessageId = randomUUID();
  const olderTextId = randomUUID();
  const pageContextId = randomUUID();
  // 主动交流的 run 由 `companion_initiative` 那一轮 job 建立，`input_source.preparationJobId`
  // 指向它（0423 的 worker 插入策略按这条链认来源）。这里照生产形状建一行。
  const preparationJobId = randomUUID();
  // 主动轮的 `facts.canSpeak=true` 是"人现在真的在前台"的声明；装配前的
  // `assertCompanionContextSourcesCurrent` 会回查这一行（45 秒内、前台且解锁、不在打字）。
  // 不种它，整轮会在 provider 边界之前以 CONTEXT_STALE 结束——测不到终态写入。
  const initiativeDeviceSessionId = `device:${randomUUID()}`;
  const userText = options.userText ?? "帮我复习光合作用";
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
    await tx`SELECT set_config('app.user_id', ${uid}, true)`;
    await tx`INSERT INTO companion_conversations (id, workspace_id, user_id, kind, title, title_source, status)
             VALUES (${cid}, ${ws}, ${uid}, 'dialogue', '会话', 'auto', 'active')`;
    if (!options.initiative) {
      // 本 run 的用户消息（可能是 voice_transcript，kind ≠ 'text'）
      await tx`INSERT INTO companion_messages (id, conversation_id, workspace_id, user_id, role, seq, kind, blocks, content_sha256)
               VALUES (${userMessageId}, ${cid}, ${ws}, ${uid}, 'user', 1, ${options.userKind ?? "text"},
                       ${tx.json([{ type: "text", text: userText }])}, ${"0".repeat(64)})`;
      if (options.newerTextMessage) {
        // 更新的 text 消息——修复前 userText 会错误取到它（ORDER BY seq DESC + kind='text'）
        await tx`INSERT INTO companion_messages (id, conversation_id, workspace_id, user_id, role, seq, kind, blocks, content_sha256)
                 VALUES (${olderTextId}, ${cid}, ${ws}, ${uid}, 'user', 2, 'text',
                         ${tx.json([{ type: "text", text: "上一轮的旧文本" }])}, ${"1".repeat(64)})`;
      }
    }
    // 账号状态行：生产里由 turn-service 在建 run 之前幂等建（2026-10-06 补的 fail-closed 修复）。
    // 这里照着建，否则这条夹具就绕过了生产路径——而 worker 的预留语句是 INNER JOIN
    // user_companion_account_state，缺行 ⇒ AGENT_BUDGET_EXCEEDED。
    await tx`INSERT INTO user_companion_account_state (user_id) VALUES (${uid})
             ON CONFLICT (user_id) DO NOTHING`;
    if (options.initiative) {
      await tx`INSERT INTO jobs
                 (id, type, workspace_id, requested_by, payload, status, attempts,
                  started_at, lease_token, priority, resource_class)
               VALUES (${preparationJobId}, 'companion_initiative', ${ws}, ${uid},
                       ${tx.json({ userId: uid })}, 'running', 0, now(), 'fixture-lease', 1, 'interactive_ai')`;
      await tx`INSERT INTO companion_awareness_sessions
                 (workspace_id, user_id, device_session_id, app_launch_id, host, context,
                  typing_until, observed_at, updated_at)
               VALUES (${ws}, ${uid}, ${initiativeDeviceSessionId}, ${randomUUID()}, 'desktop',
                       ${tx.json({ foreground: true, unlocked: true, typing: false, learning: false,
                           conversationId: cid,
                           page: { key: "home", label: "书房", revision: null, context: null } })},
                       NULL, now(), now())`;
    }
    await tx`INSERT INTO companion_turn_runs
             (id, conversation_id, workspace_id, user_id, user_message_id, generation, status,
              idempotency_key_hash, request_body_hash, job_id, input_source)
             VALUES (${runId}, ${cid}, ${ws}, ${uid}, ${options.initiative ? null : userMessageId},
                     1, ${options.runStatus ?? "accepted"}, ${"a".repeat(64)}, ${"b".repeat(64)}, ${jobId},
                     ${options.initiative
                       ? tx.json({ version: 1, kind: "initiative", preparationJobId,
                           observationId: null, attentionKey: null, attentionRevision: null,
                           preferenceRevision: 0, parentRunId: null,
                           deviceSessionId: initiativeDeviceSessionId,
                           topic: "attention.due", intent: "安静下来时问她一句近况。",
                           facts: { canSpeak: true } })
                       : null})`;
    await tx`INSERT INTO jobs
               (id, type, workspace_id, requested_by, payload, status, attempts,
                started_at, lease_token, priority, resource_class)
             VALUES (${jobId}, 'companion_agent', ${ws}, ${uid}, ${tx.json({ runId })}, 'running', 0,
                     now(), 'fixture-lease', 1, 'interactive_ai')`;
    // next_event_seq 需 ≥ 未来事件数（status+delta×N+final+segments），
    // 否则 handler 的 eventStart = next_event_seq - eventCount 为负，违反
    // companion_stream_events_seq_check (seq >= 1)。
    if (options.livePage) {
      // 与渲染层 `bridgePageContext` 同形：assessment 那一屏同时给出
      // pageKind=learning_run + interactionState=formal_answer + sensitivity=formal_assessment，
      // 并且把这一轮写进 entity_refs（记账要记到"当时在答的那一题"）。
      const { pageKind, interactionState, learningRunId } = options.livePage;
      const entityRefs = learningRunId ? [{ kind: "learning_run", runId: learningRunId }] : [];
      // entity_refs 走 tx.json：jsonb 列直接传 JS 数组会被 postgres.js 当成 Postgres 数组。
      await tx`
        INSERT INTO assistant_page_contexts
          (id, workspace_id, user_id, page_instance_id, revision, route_ref, page_kind,
           entity_refs, sensitivity, interaction_state, issued_at, expires_at)
        VALUES (${pageContextId}, ${ws}, ${uid}, ${`pi-${pageContextId}`}, ${`rev-${pageContextId}`},
                ${tx.json(learningRunId ? { kind: "learning_run", runId: learningRunId } : { kind: "today" })},
                ${pageKind}, ${tx.json(entityRefs)},
                ${interactionState === "formal_answer" ? "formal_assessment" : "normal"},
                ${interactionState}, now(), now() + interval '30 seconds')
      `;
    }
    await tx`UPDATE companion_conversations SET next_message_seq = 3, next_event_seq = 100 WHERE id = ${cid}`;
  });
  const cleanup = async () => {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
      await tx`SELECT set_config('app.user_id', ${uid}, true)`;
      await tx`DELETE FROM assistant_page_contexts WHERE id = ${pageContextId}`;
      await tx`DELETE FROM companion_turn_runs WHERE id = ${runId}`;
      await tx`DELETE FROM jobs WHERE id = ${jobId}`;
      // 主动轮的来源 job（普通轮没有这一行；DELETE 命中 0 行也无所谓）。
      await tx`DELETE FROM jobs WHERE id = ${preparationJobId}`;
      await tx`DELETE FROM conversation_summaries WHERE conversation_id = ${cid}`;
      await tx`DELETE FROM companion_messages WHERE conversation_id = ${cid} AND action_ref IS NOT NULL`;
      await tx`DELETE FROM companion_action_proposals WHERE conversation_id = ${cid}`;
      await tx`DELETE FROM companion_messages WHERE conversation_id = ${cid}`;
      await tx`DELETE FROM companion_stream_events WHERE conversation_id = ${cid}`;
      await tx`DELETE FROM companion_conversations WHERE id = ${cid}`;
      if (options.cleanupWorkspace !== false) {
        await tx`DELETE FROM workspace_members WHERE workspace_id = ${ws}`;
        await tx`DELETE FROM workspaces WHERE id = ${ws}`;
        await tx`DELETE FROM users WHERE id = ${uid}`;
      }
    });
  };
  return { runId, jobId, cid, userMessageId, cleanup };
}

function invokeRun(
  workspaceId: string,
  userId: string,
  run: { runId: string; jobId: string },
) {
  return runCompanionDialogue({
    id: run.jobId,
    payload: { runId: run.runId },
    workspaceId,
    requestedBy: userId,
    leaseToken: "fixture-lease",
    signal: new AbortController().signal,
  });
}

for (const decision of ["confirm", "reject"] as const) test(`confirmation retains earlier reads and every unexecuted call / ${decision}`, async () => {
  const scope = await seedBase();
  const userText = "先核对原始记录，写一篇本轮测试笔记，不要读取笔记库，再读取当前上下文。";
  const run = await seedDialogueRun(scope.workspaceId, scope.userId, { userText });
  const admin = postgres(testDatabaseUrl("DATABASE_URL_MIGRATOR"), { max: 1 });
  const original = MockProvider.prototype.executeAgentTurn;
  const nextJobId = randomUUID();
  try {
    const interpretation = agentTurnInterpretationV1Schema.parse({ version: 1, requestHash: sha256Utf8V1(userText),
      intent: "task", toolUse: "act", subjects: [], goalRelation: "new", goalReference: null,
      candidateOperations: ["companion_create_note"], ambiguities: [], status: "interpreted" });
    await readInScope(scope, tx => tx`UPDATE companion_turn_runs SET permission_level='read_only',
      turn_interpretation=${tx.json(interpretation)} WHERE id=${run.runId}`);
    const calls = [{ id: "read-before-card", name: "companion_read_history", arguments: { fromSeq: 1, limit: 3 } },
      { id: "write-at-card", name: "companion_create_note", arguments: { title: "Confirmation recovery fixture", markdown: "Full retained body.", links: [] } },
      { id: "read-after-card", name: "companion_read_context", arguments: {} }];
    let originalCalls = 0;
    MockProvider.prototype.executeAgentTurn = async () => {
      assert.equal(++originalCalls, 1, "the original mixed batch must pause at its confirmation card");
      return { content: null, toolCalls: calls, finishReason: "tool_calls", usage: {}, providerRequestId: "mixed-round-before-confirmation" };
    };
    await invokeRun(scope.workspaceId, scope.userId, run);
    const before = await readInScope(scope, async tx => ({
      run: (await tx`SELECT status,waiting_proposal_id FROM companion_turn_runs WHERE id=${run.runId}`)[0],
      step: (await tx`SELECT status,runtime_checkpoint FROM companion_agent_steps WHERE run_id=${run.runId}`)[0],
      tools: await tx`SELECT tool_call_id,name,status FROM companion_agent_tool_calls WHERE run_id=${run.runId}`,
    }));
    assert.equal(before.run!.status, "waiting_for_confirmation");
    assert.equal(before.step!.status, "waiting");
    const snapshot = JSON.parse(before.step!.runtime_checkpoint.stateJson);
    assert.equal(snapshot.phase, "waiting");
    assert.equal(snapshot.proposalId, before.run!.waiting_proposal_id);
    assert.equal(snapshot.pendingCallId, "write-at-card");
    assert.equal(before.tools.length, 2, "the later read has not executed while waiting");
    const priorRead = snapshot.state.messages.find((message: { role: string; toolCallId?: string }) => message.role === "tool" && message.toolCallId === "read-before-card");
    assert.ok(priorRead.content.includes(userText));
    const preamble = "我先按你给的正文新建这篇笔记。";
    snapshot.state.visibleSegments = [preamble];
    snapshot.state.visibleSegmentDelivered = [true];
    snapshot.state.messages.find((message: { role: string; toolCalls?: unknown[] }) => message.role === "assistant" && message.toolCalls?.length === 3).content = preamble;
    const stateJson = stableStringify(snapshot);
    // A prior process committed only the first delta before its confirmation
    // card changed the run to waiting. Its full safe preamble survives privately.
    const checkpoint = { ...before.step!.runtime_checkpoint, stateJson, stateSha256: sha256Utf8V1(stateJson) };
    await readInScope(scope, async tx => {
      await tx`UPDATE companion_agent_steps SET runtime_checkpoint=${tx.json(checkpoint)} WHERE run_id=${run.runId}`;
      const [counter] = await tx`UPDATE companion_conversations SET next_event_seq=next_event_seq+1 WHERE id=${run.cid} RETURNING next_event_seq`;
      await tx`INSERT INTO companion_stream_events(conversation_id,seq,workspace_id,user_id,run_id,generation,account_epoch,type,payload,expires_at)
        VALUES(${run.cid},${Number(counter!.next_event_seq)-1},${scope.workspaceId},${scope.userId},${run.runId},1,0,'assistant.delta',
          ${tx.json({ appendFrom: 0, textDelta: preamble.slice(0,-3) })},now()+interval '1 hour')`;
    });
    await admin`UPDATE companion_action_proposals SET decision=${decision},status=${decision === "confirm" ? "accepted" : "rejected"}
      WHERE id=${before.run!.waiting_proposal_id}`;
    await admin`UPDATE companion_agent_tool_calls SET status=${decision === "confirm" ? "requested" : "not_executed"}
      WHERE run_id=${run.runId} AND tool_call_id='write-at-card'`;
    await admin`INSERT INTO jobs(id,type,workspace_id,requested_by,payload,status,lease_token,started_at,priority,resource_class)
      VALUES(${nextJobId},'companion_agent',${scope.workspaceId},${scope.userId},
        ${admin.json({ runId: run.runId, proposalId: before.run!.waiting_proposal_id })},'running','confirmation-worker',now(),1,'interactive_ai')`;
    // The decision API rebinds the run to this continuation job after enqueue.
    await admin`UPDATE companion_turn_runs SET status='accepted',waiting_proposal_id=NULL,job_id=${nextJobId}
      WHERE id=${run.runId}`;
    // A quick decision may arrive while the original job still holds its own
    // valid lease. Its late bookkeeping cannot restore the old waiting state.
    const events = await import("../handlers/agent/companion-agent-events.ts");
    const oldEvent = { ctx: { id: run.jobId, payload: { runId: run.runId }, workspaceId: scope.workspaceId,
      requestedBy: scope.userId, leaseToken: "fixture-lease", signal: new AbortController().signal },
    read: { runId: run.runId, conversationId: run.cid, userId: scope.userId, generation: 1, accountEpoch: 0 },
    expiresAt: new Date(Date.now() + 60_000).toISOString(), constraints: {} } as unknown as Parameters<typeof events.persistStep>[0];
    await events.updateRunMeta(oldEvent, { stepCount: 99, status: "waiting_for_confirmation", waitingProposalId: snapshot.proposalId });
    await events.appendAgentEvent(oldEvent, "agent.tool", { tool: { name: "obsolete-confirmation-owner" } });
    await markCompanionRunFailed(oldEvent.read, oldEvent.ctx, "INTERNAL_ERROR", true, "obsolete failure", "execution");
    const [stillAccepted] = await readInScope(scope, tx => tx`SELECT status,waiting_proposal_id,job_id,step_count FROM companion_turn_runs WHERE id=${run.runId}`);
    assert.equal(stillAccepted!.status, "accepted");
    assert.equal(stillAccepted!.waiting_proposal_id, null);
    assert.equal(stillAccepted!.job_id, nextJobId);
    assert.notEqual(stillAccepted!.step_count, 99);
    await admin`UPDATE jobs SET status='succeeded' WHERE id=${run.jobId}`;
    let resumedCalls = 0;
    MockProvider.prototype.executeAgentTurn = async request => {
      resumedCalls++;
      if (resumedCalls === 1) {
        assert.deepEqual(request.messages.find(message => message.role === "tool" && message.toolCallId === "read-before-card"), priorRead);
        assert.deepEqual(request.messages.find(message => message.role === "assistant" && message.toolCalls?.length === 3)?.toolCalls, calls);
        const decided = JSON.parse(String(request.messages.find(message => message.role === "tool" && message.toolCallId === "write-at-card")?.content));
        assert.equal(decided.ok, decision === "confirm", JSON.stringify(decided));
        if (decision === "confirm") assert.ok(decided.data, "the complete saved result returns to the model");
        const deferred = JSON.parse(String(request.messages.find(message => message.role === "tool" && message.toolCallId === "read-after-card")?.content));
        assert.equal(deferred.status, "not_executed");
        return { content: null, toolCalls: [
          ...(decision === "reject" ? [{ ...calls[1]!, id: "rejected-write-with-new-provider-id" }] : []),
          { ...calls[2]!, id: "remaining-read-replanned" }], finishReason: "tool_calls", usage: {},
          providerRequestId: "remaining-read-after-confirmation" };
      }
      return { content: "已按本轮的决定继续完成核对。", toolCalls: [], finishReason: "stop", usage: {}, providerRequestId: "completed-after-confirmation" };
    };
    await runCompanionDialogue({ id: nextJobId, payload: { runId: run.runId, proposalId: before.run!.waiting_proposal_id },
      workspaceId: scope.workspaceId, requestedBy: scope.userId, leaseToken: "confirmation-worker", signal: new AbortController().signal });
    assert.equal(resumedCalls, 2);
    await readInScope(scope, async tx => {
      const [finished] = await tx`SELECT status FROM companion_turn_runs WHERE id=${run.runId}`;
      assert.equal(finished!.status, "succeeded");
      const replies = await tx`SELECT blocks FROM companion_messages WHERE run_id=${run.runId} AND role='assistant' AND kind='text' ORDER BY seq`;
      const finalText = replies.at(-1)!.blocks.find((block: { type: string }) => block.type === "text").text;
      assert.ok(finalText.startsWith(preamble + "\n\n"), "the complete original preamble is retained once");
      const deltas = await tx`SELECT payload FROM companion_stream_events WHERE run_id=${run.runId} AND type='assistant.delta' ORDER BY seq`;
      assert.equal(deltas.map(row => row.payload.textDelta).join(""), finalText, "no pre-confirmation tail disappears at resume");
      const [notes] = await tx`SELECT count(*)::int AS count FROM notes WHERE workspace_id=${scope.workspaceId}`;
      assert.equal(notes!.count, decision === "confirm" ? 1 : 0);
      const tools = await tx`SELECT tool_call_id FROM companion_agent_tool_calls WHERE run_id=${run.runId}`;
      assert.equal(tools.length, 3, "the original read is not executed again");
      assert.equal(tools.some(row => row.tool_call_id === "read-after-card"), false);
      assert.equal(tools.some(row => row.tool_call_id === "rejected-write-with-new-provider-id"), false,
        "a new provider call id cannot bypass the user's rejection in the same run");
      const [proposals] = await tx`SELECT count(*)::int AS count FROM companion_action_proposals WHERE agent_run_id=${run.runId}`;
      assert.equal(proposals!.count, 1, "rejection must not create the same confirmation card again");
      const steps = await tx`SELECT status FROM companion_agent_steps WHERE run_id=${run.runId}`;
      assert.equal(steps.some(row => row.status === "waiting"), false, "the decided model step no longer appears pending");
    });
  } finally {
    MockProvider.prototype.executeAgentTurn = original;
    await admin`DELETE FROM jobs WHERE id=${nextJobId}`;
    await admin.end({ timeout: 2 });
    await run.cleanup();
  }
});

test("a late failed attempt cannot close a step or fail the run after another worker acquires its lease", async () => {
  const scope = await seedBase();
  const userText = "Answer only this current question.";
  const run = await seedDialogueRun(scope.workspaceId, scope.userId, { userText });
  const admin = postgres(testDatabaseUrl("DATABASE_URL_MIGRATOR"), { max: 1 });
  const original = MockProvider.prototype.executeAgentTurn;
  try {
    const interpretation = agentTurnInterpretationV1Schema.parse({ version: 1, requestHash: sha256Utf8V1(userText),
      intent: "question", toolUse: "none", subjects: [], goalRelation: "unrelated", goalReference: null,
      candidateOperations: [], ambiguities: [], status: "interpreted" });
    await readInScope(scope, tx => tx`UPDATE companion_turn_runs SET turn_interpretation=${tx.json(interpretation)} WHERE id=${run.runId}`);
    MockProvider.prototype.executeAgentTurn = async () => {
      await admin`UPDATE jobs SET lease_token='replacement-worker',lease_renewed_at=now() WHERE id=${run.jobId}`;
      throw new ProviderStreamError("mock", "stream_failed");
    };
    await assert.rejects(invokeRun(scope.workspaceId, scope.userId, run), JobLeaseLostError);
    const before = await readInScope(scope, async tx => ({
      run: (await tx`SELECT status,error_code FROM companion_turn_runs WHERE id=${run.runId}`)[0],
      step: (await tx`SELECT id,status,runtime_checkpoint FROM companion_agent_steps WHERE run_id=${run.runId}`)[0],
      errors: await tx`SELECT type FROM companion_stream_events WHERE run_id=${run.runId} AND type='error'`,
    }));
    assert.equal(before.run!.status, "running");
    assert.equal(before.run!.error_code, null);
    assert.equal(before.step!.status, "running");
    assert.ok(before.step!.runtime_checkpoint);
    assert.equal(before.errors.length, 0, "the old worker cannot publish a failure for the new owner");
    const events = await import("../handlers/agent/companion-agent-events.ts");
    const event = { ctx: { id: run.jobId, payload: { runId: run.runId }, workspaceId: scope.workspaceId,
      requestedBy: scope.userId, leaseToken: "fixture-lease", signal: new AbortController().signal },
    read: { runId: run.runId, conversationId: run.cid, userId: scope.userId, generation: 1, accountEpoch: 0 },
    expiresAt: new Date(Date.now() + 60_000).toISOString(), constraints: {} } as unknown as Parameters<typeof events.persistStep>[0];
    await assert.rejects(events.persistStep(event, 2, "a".repeat(64)), JobLeaseLostError);
    await assert.rejects(events.updateRunMeta(event, { stepCount: 99, status: "waiting_for_confirmation" }), JobLeaseLostError);
    await assert.rejects(events.appendAgentEvent(event, "agent.tool", { tool: { name: "old-worker" } }), JobLeaseLostError);
    await assert.rejects(events.finishStep(event, before.step!.id, "failed"), JobLeaseLostError);
    const ledger = await import("../handlers/tools/companion-tool-call-ledger.ts");
    const { getCompanionAgentTool } = await import("@astella/shared");
    const definition = getCompanionAgentTool("companion_read_history")!;
    const args = { conversationId: run.cid, fromSeq: 1, toSeq: 1 };
    await assert.rejects(ledger.ensureAgentToolCall(event, before.step!.id, definition,
      { id: "old-worker-read", arguments: args }, sha256Utf8V1(canonicalJsonV1(args))), JobLeaseLostError);
    await assert.rejects(ledger.updateToolCall(event, "old-worker-read", { status: "succeeded" }), JobLeaseLostError);
    await assert.rejects(ledger.updateToolCall(event, "old-worker-read", { status: "failed" }), JobLeaseLostError);
    await assert.rejects(ledger.recordRejectedToolCall(event, before.step!.id,
      { id: "old-worker-rejected", name: definition.name }, "a".repeat(64), definition, "blocked", "stale worker"), JobLeaseLostError);
    const [ledgerRows] = await readInScope(scope, tx => tx`SELECT count(*)::int AS count FROM companion_agent_tool_calls WHERE run_id=${run.runId}`);
    assert.equal(ledgerRows!.count, 0, "a replaced owner cannot leave new audit rows or receipts");
    MockProvider.prototype.executeAgentTurn = async () => ({ content: "The current answer is preserved.", toolCalls: [],
      finishReason: "stop", usage: {}, providerRequestId: "replacement-worker-answer" });
    await runCompanionDialogue({ ...event.ctx, leaseToken: "replacement-worker" });
    const [finished] = await readInScope(scope, tx => tx`SELECT status FROM companion_turn_runs WHERE id=${run.runId}`);
    assert.equal(finished!.status, "succeeded");
  } finally {
    MockProvider.prototype.executeAgentTurn = original;
    await admin.end({ timeout: 2 });
    await run.cleanup();
  }
});

test("a lease replaced after the settled checkpoint fences final delivery and resumes without another model call", async () => {
  const scope = await seedBase();
  const userText = "Answer only this current question.";
  const run = await seedDialogueRun(scope.workspaceId, scope.userId, { userText });
  const admin = postgres(testDatabaseUrl("DATABASE_URL_MIGRATOR"), { max: 1 });
  const original = MockProvider.prototype.executeAgentTurn;
  const hook = `qa_settled_lease_${run.runId.replaceAll("-", "")}`;
  try {
    const interpretation = agentTurnInterpretationV1Schema.parse({ version: 1, requestHash: sha256Utf8V1(userText),
      intent: "question", toolUse: "none", subjects: [], goalRelation: "unrelated", goalReference: null,
      candidateOperations: [], ambiguities: [], status: "interpreted" });
    await readInScope(scope, tx => tx`UPDATE companion_turn_runs SET turn_interpretation=${tx.json(interpretation)} WHERE id=${run.runId}`);
    // QA-only fault at the committed working-state/final-publication boundary.
    // Identifiers and UUIDs below are generated in this isolated test, never external input.
    await admin.unsafe(`CREATE FUNCTION public.${hook}() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
      SET search_path=pg_catalog,public AS $$ BEGIN
      UPDATE public.jobs SET lease_token='replacement-at-final',lease_renewed_at=now() WHERE id='${run.jobId}';
      RETURN NEW; END $$`);
    await admin.unsafe(`CREATE TRIGGER ${hook} AFTER UPDATE OF runtime_checkpoint ON public.companion_agent_steps
      FOR EACH ROW WHEN (NEW.run_id='${run.runId}' AND ((NEW.runtime_checkpoint->>'stateJson')::jsonb->>'phase')='settled')
      EXECUTE FUNCTION public.${hook}()`);
    let modelCalls = 0;
    MockProvider.prototype.executeAgentTurn = async () => {
      modelCalls++;
      return { content: "The completed answer survives final delivery recovery.", toolCalls: [], finishReason: "stop",
        usage: {}, providerRequestId: "settled-before-lease-replacement" };
    };
    await assert.rejects(invokeRun(scope.workspaceId, scope.userId, run), JobLeaseLostError);
    const before = await readInScope(scope, async tx => ({
      run: (await tx`SELECT status FROM companion_turn_runs WHERE id=${run.runId}`)[0],
      step: (await tx`SELECT runtime_checkpoint FROM companion_agent_steps WHERE run_id=${run.runId} ORDER BY step_no DESC LIMIT 1`)[0],
      finals: await tx`SELECT type FROM companion_stream_events WHERE run_id=${run.runId} AND type='assistant.final'`,
    }));
    assert.equal(before.run!.status, "running");
    assert.equal(JSON.parse(before.step!.runtime_checkpoint.stateJson).phase, "settled");
    assert.equal(before.finals.length, 0, "the obsolete owner cannot publish completion");
    await admin.unsafe(`DROP TRIGGER ${hook} ON public.companion_agent_steps`);
    await runCompanionDialogue({ id: run.jobId, payload: { runId: run.runId }, workspaceId: scope.workspaceId,
      requestedBy: scope.userId, leaseToken: "replacement-at-final", signal: new AbortController().signal });
    assert.equal(modelCalls, 1, "the replacement uses the complete settled result");
    const [finished] = await readInScope(scope, tx => tx`SELECT status FROM companion_turn_runs WHERE id=${run.runId}`);
    assert.equal(finished!.status, "succeeded");
  } finally {
    MockProvider.prototype.executeAgentTurn = original;
    await admin.unsafe(`DROP TRIGGER IF EXISTS ${hook} ON public.companion_agent_steps`);
    await admin.unsafe(`DROP FUNCTION IF EXISTS public.${hook}()`);
    await admin.end({ timeout: 2 });
    await run.cleanup();
  }
});

test("a timed-out owner can record failure with its current lease", async () => {
  const scope = await seedBase(), run = await seedDialogueRun(scope.workspaceId, scope.userId);
  const controller = new AbortController(); controller.abort();
  try {
    await markCompanionRunFailed({ runId: run.runId, conversationId: run.cid, userId: scope.userId,
      generation: 1, accountEpoch: 0 }, { id: run.jobId, workspaceId: scope.workspaceId, requestedBy: scope.userId,
      leaseToken: "fixture-lease", signal: controller.signal }, "AGENT_BUDGET_EXCEEDED", false, "handler timed out", "execution");
    const [finished] = await readInScope(scope, tx => tx`SELECT status,error_code FROM companion_turn_runs WHERE id=${run.runId}`);
    assert.equal(finished!.status, "failed");
    assert.equal(finished!.error_code, "AGENT_BUDGET_EXCEEDED");
  } finally { await run.cleanup(); }
});

for (const mode of ["read", "repair-completes", "repair-repeated", "prefix-repair", "partial-stream"] as const)
  test(`a killed worker resumes exact tool evidence and correction state / ${mode}`, async () => {
    const scope = await seedBase();
    const userText = "只根据当前请求和已经读到的原文作答，不安排其他事。";
    const run = await seedDialogueRun(scope.workspaceId, scope.userId, { userText });
    const originalExecute = MockProvider.prototype.executeAgentTurn;
    let child: ReturnType<typeof spawn> | undefined;
    let childClosed: Promise<unknown> | undefined;
    try {
      const interpretation = agentTurnInterpretationV1Schema.parse({ version: 1, requestHash: sha256Utf8V1(userText),
        intent: "question", toolUse: "none", subjects: [], goalRelation: "unrelated", goalReference: null,
        candidateOperations: [], ambiguities: [], status: "interpreted" });
      await readInScope(scope, tx => tx`UPDATE companion_turn_runs SET turn_interpretation=${tx.json(interpretation)} WHERE id=${run.runId}`);
      child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./helpers/companion-runtime-recovery-process.ts", import.meta.url)),
        JSON.stringify({ ...scope, runId: run.runId, jobId: run.jobId,
          mode: ["read", "prefix-repair", "partial-stream"].includes(mode) ? mode : "format" })],
      { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
      childClosed = new Promise(resolve => child!.once("exit", (code, signal) => resolve({ code, signal })));
      await new Promise<void>((resolve, reject) => {
        let output = "", errors = "";
        const timer = setTimeout(() => reject(new Error(`worker did not reach its recovery boundary: ${errors.slice(-400)}`)), 20_000);
        child!.stdout!.on("data", chunk => {
          output += String(chunk);
          if (output.includes(`RUNTIME_RECOVERY_HELD:${run.runId}`)) { clearTimeout(timer); resolve(); }
        });
        child!.stderr!.on("data", chunk => { errors += String(chunk); });
        child!.once("error", error => { clearTimeout(timer); reject(error); });
        child!.once("exit", code => { clearTimeout(timer); reject(new Error(`worker exited before hold: ${code}, ${errors.slice(-400)}`)); });
      });
      const before = await readInScope(scope, async tx => ({
        steps: await tx`SELECT step_no,status,runtime_checkpoint FROM companion_agent_steps WHERE run_id=${run.runId} ORDER BY step_no`,
        tools: await tx`SELECT name,status,result_payload FROM companion_agent_tool_calls WHERE run_id=${run.runId}`,
      }));
      assert.equal(before.steps.length, mode === "partial-stream" ? 1 : 2);
      assert.equal(before.steps.at(-1)!.status, "running");
      const snapshot = JSON.parse(before.steps.at(-1)!.runtime_checkpoint.stateJson);
      if (mode === "read") {
        assert.equal(before.tools.length, 1);
        const payload = decodeCompanionToolResult(before.tools[0]!.result_payload)!;
        assert.equal((payload.value.messages as Array<{ text: string }>)[0]!.text, userText);
        assert.ok(snapshot.state.messages.some((message: { role: string; content: string }) => message.role === "tool"
          && message.content.includes(userText)), "the next step input includes the complete read result");
      } else if (mode !== "partial-stream") {
        assert.equal(snapshot.state.outputRepairToolCount, 0);
        assert.ok(snapshot.state.messages.some((message: { role: string; content: string }) => message.role === "system"
          && message.content.includes("上一版")));
        assert.equal(before.tools.length, 0, "textual protocol has no effects");
      }
      child.kill("SIGKILL");
      assert.deepEqual(await childClosed, { code: null, signal: "SIGKILL" });
      let resumedCalls = 0;
      const finalText = "已按当前原文核对，这轮没有新增操作。";
      MockProvider.prototype.executeAgentTurn = async request => {
        resumedCalls++;
        if (mode === "partial-stream") {
          assert.equal(request.messages.at(-1)?.content, userText);
          assert.ok(request.messages.some(message => message.role === "assistant" && message.content === "我先核对眼前这一句话的意思。"));
          assert.ok(request.messages.some(message => message.role === "system" && String(message.content).includes("执行进程中断")));
        } else assert.deepEqual(request.messages, snapshot.state.messages, "recovery uses the exact saved working transcript");
        return { content: mode === "repair-repeated"
          ? "<tool_call><function=agent_calculate><parameter=expression>1+1</parameter></function></tool_call>" : finalText,
        toolCalls: [], finishReason: "stop", usage: {}, providerRequestId: "resumed-worker-answer" };
      };
      if (mode === "repair-repeated") await assert.rejects(invokeRun(scope.workspaceId, scope.userId, run), AgentOutputError);
      else await invokeRun(scope.workspaceId, scope.userId, run);
      assert.equal(resumedCalls, 1, "a restart cannot reset the already-used no-progress repair allowance");
      await readInScope(scope, async tx => {
        const [finished] = await tx`SELECT status FROM companion_turn_runs WHERE id=${run.runId}`;
        assert.equal(finished!.status, mode === "repair-repeated" ? "failed" : "succeeded");
        const tools = await tx`SELECT name FROM companion_agent_tool_calls WHERE run_id=${run.runId}`;
        assert.equal(tools.length, mode === "read" ? 1 : 0, "completed reads are not requested again and format text never executes");
        if (mode !== "repair-repeated") {
          const messages = await tx`SELECT blocks FROM companion_messages WHERE run_id=${run.runId} AND role='assistant'`;
          const expected = ["prefix-repair", "partial-stream"].includes(mode) ? "我先核对眼前这一句话的意思。\n\n" + finalText : finalText;
          assert.equal(messages[0]!.blocks[0].text, expected);
          const deltas = await tx`SELECT payload FROM companion_stream_events WHERE run_id=${run.runId} AND type='assistant.delta' ORDER BY seq`;
          assert.equal(deltas.map(row => row.payload.textDelta).join(""), expected, "delivered prefix survives exactly once");
        }
      });
    } finally {
      child?.kill("SIGKILL");
      if (childClosed) await childClosed;
      MockProvider.prototype.executeAgentTurn = originalExecute;
      await run.cleanup();
    }
  });

for (const mode of ["protocol-stream", "arguments-stream", "protocol-buffered"] as const)
  for (const repaired of [true, false]) test(`malformed tool output / ${mode}: ${repaired ? "explicit correction completes" : "no-progress repetition terminates"}`, async () => {
    const scope = await seedBase();
    const userText = "只接着眼前这一句话自然聊，不执行操作。";
    const run = await seedDialogueRun(scope.workspaceId, scope.userId, { userText });
    const original = MockProvider.prototype.executeAgentTurn;
    const streamTools = Object.getOwnPropertyDescriptor(MockProvider.prototype, "chatCompletionStreamToolCalls");
    const prefix = "我先核对眼前这一句话的意思。";
    const answer = "现在就接着这一句聊，不另外安排事情。";
    const bad = "<tool_call><function=agent_calculate><parameter=expression>1+1</parameter></function></tool_call>";
    let attempts = 0;
    const scripted = async (request: import("@astella/shared").AgentTurnRequest, onDelta?: (text: string) => void) => {
      attempts++;
      if (attempts > 1) {
        assert.ok(request.messages.some(message => message.role === "system" && String(message.content).includes("上一版")), "retry carries explicit model feedback");
        assert.equal(request.messages.at(-1)?.content, userText, "the exact current request is reattached");
      }
      const invalid = attempts === 1 || !repaired;
      const text = invalid ? prefix + (mode === "arguments-stream" ? "" : bad) : answer;
      if (onDelta) {
        if (invalid) { onDelta(prefix); await new Promise(resolve => setTimeout(resolve, 20)); if (mode !== "arguments-stream") onDelta(bad); }
        else onDelta(answer);
      }
      if (invalid && mode === "arguments-stream") throw new AgentOutputError("arguments_malformed", "invalid native JSON");
      return { content: text, toolCalls: [], finishReason: "stop" as const, usage: null, providerRequestId: null };
    };
    try {
      const interpretation = agentTurnInterpretationV1Schema.parse({ version: 1, requestHash: sha256Utf8V1(userText),
        intent: "conversation", toolUse: "none", subjects: [], goalRelation: "unrelated", goalReference: null,
        candidateOperations: [], ambiguities: [], status: "interpreted" });
      await readInScope(scope, tx => tx`UPDATE companion_turn_runs SET turn_interpretation=${tx.json(interpretation)} WHERE id=${run.runId}`);
      MockProvider.prototype.executeAgentTurn = request => scripted(request);
      if (mode !== "protocol-buffered") {
        Object.defineProperty(MockProvider.prototype, "chatCompletionStreamToolCalls", { configurable: true, value: true });
        Object.defineProperty(MockProvider.prototype, "chatCompletionStream", { ...mockStreamDescriptor,
          value: async (_messages: unknown, options: { nativeAgentRequest: import("@astella/shared").AgentTurnRequest },
            _signal: unknown, onDelta: (text: string) => void) => scripted(options.nativeAgentRequest, onDelta) });
      }
      if (repaired) await invokeRun(scope.workspaceId, scope.userId, run);
      else await assert.rejects(invokeRun(scope.workspaceId, scope.userId, run), error => error instanceof AgentOutputError);
      assert.equal(attempts, 2, "a correction is tried, but unchanged failed evidence cannot spin forever");
      const actual = await readInScope(scope, async tx => ({
        run: (await tx`SELECT status,error_code FROM companion_turn_runs WHERE id=${run.runId}`)[0],
        messages: await tx`SELECT blocks FROM companion_messages WHERE run_id=${run.runId} AND role='assistant'`,
        events: await tx`SELECT type,payload FROM companion_stream_events WHERE run_id=${run.runId} ORDER BY seq`,
        calls: await tx`SELECT name FROM companion_agent_tool_calls WHERE run_id=${run.runId}`,
      }));
      assert.equal(actual.calls.length, 0, "textual tool syntax is never executed");
      assert.equal(actual.run!.status, repaired ? "succeeded" : "failed");
      const visible = actual.events.filter(event => event.type === "assistant.delta").map(event => event.payload.textDelta).join("");
      assert.doesNotMatch(visible + JSON.stringify(actual.messages), /tool_call|parameter=|function=/);
      if (repaired) {
        assert.ok(visible.endsWith(answer));
        assert.equal(visible, mode === "protocol-buffered" ? answer : prefix + "\n\n" + answer);
        assert.ok(actual.events.some(event => event.type === "assistant.final"));
        assert.ok(actual.events.every(event => event.type !== "error"));
      } else {
        assert.ok(actual.events.every(event => event.type !== "assistant.final"));
        assert.equal(actual.run!.error_code, mode === "arguments-stream" ? "TOOL_ARGUMENTS_INVALID" : "REPLY_FORMAT_INVALID");
      }
    } finally {
      MockProvider.prototype.executeAgentTurn = original;
      Object.defineProperty(MockProvider.prototype, "chatCompletionStream", { ...mockStreamDescriptor, value: undefined });
      if (streamTools) Object.defineProperty(MockProvider.prototype, "chatCompletionStreamToolCalls", streamTools);
      else Reflect.deleteProperty(MockProvider.prototype, "chatCompletionStreamToolCalls");
      await run.cleanup();
    }
  });

for (const repaired of [true, false]) test(`无效工具参数反馈：${repaired ? "按字段修正后继续完成" : "相同无效输入不会无限重试"}`, async () => {
  const scope = await seedBase();
  const run = await seedDialogueRun(scope.workspaceId, scope.userId, { userText: "计算1加1。" });
  const originalChat = MockProvider.prototype.chatCompletion;
  const originalExecute = MockProvider.prototype.executeAgentTurn;
  let calls = 0;
  try {
    MockProvider.prototype.chatCompletion = async () => ({ content: JSON.stringify({ intent: "question", toolUse: "read",
      subjects: [], goalRelation: "unrelated", candidateOperations: ["agent_calculate"], ambiguities: [],
      voiceStyle: { decision: "none", instruction: null }, pendingOfferIndexes: [] }), usage: {} });
    MockProvider.prototype.executeAgentTurn = async request => {
      calls += 1;
      if (calls === 2) {
        const receipt = request.messages.find(message => message.role === "tool");
        const feedback = JSON.parse(String(receipt?.content));
        assert.equal(feedback.code, "invalid_arguments");
        assert.ok(feedback.validationIssues.some((issue: { path: string[]; expected: string }) =>
          issue.path.join(".") === "expression" && issue.expected === "string"));
      }
      if (calls === 3 && repaired) return { content: "算出来是2。", toolCalls: [], finishReason: "stop", usage: null, providerRequestId: null };
      return { content: "", toolCalls: [{ id: `calculation-${calls}`, name: "agent_calculate",
        arguments: { expression: repaired && calls === 2 ? "1+1" : 2 } }],
        finishReason: "tool_calls", usage: null, providerRequestId: null };
    };
    if (repaired) await invokeRun(scope.workspaceId, scope.userId, run);
    else await assert.rejects(invokeRun(scope.workspaceId, scope.userId, run),
      (error: unknown) => error instanceof AgentOutputError && error.code === "arguments_malformed");
    assert.equal(calls, repaired ? 3 : 2);
    const [result] = await readInScope(scope, tx => tx`SELECT status FROM companion_turn_runs WHERE id=${run.runId}`);
    assert.equal(result.status, repaired ? "succeeded" : "failed");
    if (!repaired) {
      const steps = await readInScope(scope, tx => tx`SELECT error_code FROM companion_agent_steps WHERE run_id=${run.runId} ORDER BY step_no`);
      assert.equal(steps.at(-1)?.error_code, "REPEATED_INVALID_TOOL_ARGUMENTS");
      const errors = await readInScope(scope, tx => tx`SELECT payload FROM companion_stream_events WHERE run_id=${run.runId} AND type='error'`);
      assert.equal(errors[0]?.payload.code, "TOOL_ARGUMENTS_INVALID");
      assert.ok(companionPublicErrorCodeV1Schema.safeParse(errors[0]?.payload.code).success);
      assert.equal(errors[0]?.payload.recoverable, false);
    }
  } finally {
    MockProvider.prototype.chatCompletion = originalChat;
    MockProvider.prototype.executeAgentTurn = originalExecute;
    await run.cleanup();
  }
});

for (const repaired of [true, false]) test(`动作回执缺失：${repaired ? "核验无需变更后完成" : "纠正后仍不执行时不能交付完成声明"}`, async () => {
  const scope = await seedBase();
  const run = await seedDialogueRun(scope.workspaceId, scope.userId, { userText: "只保留前台安静事件，不要设置重评时间。" });
  const plan = { key: "quiet", expectedRevision: 0, intent: "只关注前台安静事件。", topics: ["presence.quiet"] as "presence.quiet"[],
    nextReviewAt: null, expiresAt: null, preferenceRevision: null, selfNote: null, state: "active" as const };
  const origin = { conversationId: run.cid, runId: run.runId };
  const saved = await withWorkerWorkspaceTransaction(scope, tx => arrangeCompanionAttention(tx, scope, plan, origin));
  const originalChat = MockProvider.prototype.chatCompletion, originalExecute = MockProvider.prototype.executeAgentTurn;
  let calls = 0;
  try {
    MockProvider.prototype.chatCompletion = async () => ({ content: JSON.stringify({ intent: "task_control", toolUse: "act",
      subjects: [], goalRelation: "unrelated", candidateOperations: ["companion_arrange_attention"], ambiguities: [],
      voiceStyle: { decision: "none", instruction: null }, pendingOfferIndexes: [] }), usage: {} });
    MockProvider.prototype.executeAgentTurn = async request => {
      calls += 1;
      if (calls === 2 && repaired) return { content: "", toolCalls: [{ id: "verify-quiet", name: "companion_arrange_attention",
        arguments: { ...plan, expectedRevision: 1 } }], finishReason: "tool_calls", usage: null, providerRequestId: null };
      if (calls === 3 && repaired) {
        const receipt = request.messages.find(message => message.role === "tool");
        const result = JSON.parse(String(receipt?.content));
        assert.equal(result.ok, true); assert.equal(result.data.changed, false);
        assert.deepEqual(result.data.attention, saved.attention);
      }
      return { content: "实际结果：只保留安静事件，没有定时唤醒。", toolCalls: [], finishReason: "stop", usage: null, providerRequestId: null };
    };
    if (repaired) await invokeRun(scope.workspaceId, scope.userId, run);
    else await assert.rejects(invokeRun(scope.workspaceId, scope.userId, run),
      (error: unknown) => error instanceof AgentOutputError && error.code === "action_unverified");
    assert.equal(calls, 3);
    const [state] = await readInScope(scope, tx => tx`SELECT status FROM companion_turn_runs WHERE id=${run.runId}`);
    assert.equal(state.status, repaired ? "succeeded" : "failed");
    const [current] = await readInScope(scope, tx => tx`SELECT revision,updated_at FROM companion_attention_plans WHERE user_id=${scope.userId}`);
    assert.equal(current.revision, 1); assert.equal(new Date(current.updated_at).toISOString(), saved.attention.updatedAt);
    if (!repaired) {
      const errors = await readInScope(scope, tx => tx`SELECT payload FROM companion_stream_events WHERE run_id=${run.runId} AND type='error'`);
      assert.equal(errors[0]?.payload.code, "ACTION_NOT_EXECUTED"); assert.equal(errors[0]?.payload.recoverable, false);
      assert.ok(companionPublicErrorCodeV1Schema.safeParse(errors[0]?.payload.code).success);
      const deltas = await readInScope(scope, tx => tx`SELECT payload FROM companion_stream_events WHERE run_id=${run.runId} AND type='assistant.delta'`);
      assert.equal(deltas.length, 0, "unverified completion text must never become visible");
    }
  } finally {
    MockProvider.prototype.chatCompletion = originalChat; MockProvider.prototype.executeAgentTurn = originalExecute;
    await run.cleanup();
  }
});

/**
 * 2026-10-16 线上 run `fb2da98f` 的形状：注意力点名的是 A，她实际做成的是 B。
 *
 * 旧行为：补正两步白烧之后整轮判死——12 步、8 分 22 秒的正文一个字都不许发，
 * 三篇笔记好好躺在库里，界面上只剩「这一轮没能说完」。
 * 上面那条"纠正后仍不执行"照旧是 failed（判据没放宽），放宽的只是**销毁**：
 * 本轮真落过写回执时，不许把已经做成的事说成没发生。
 */
test("点名的动作没回执、但本轮真做成了另一件写 → 照常交付", async () => {
  const scope = await seedBase();
  const run = await seedDialogueRun(scope.workspaceId, scope.userId, { userText: "只保留前台安静事件，不要设置重评时间。" });
  const plan = { key: "quiet", expectedRevision: 0, intent: "只关注前台安静事件。", topics: ["presence.quiet"] as "presence.quiet"[],
    nextReviewAt: null, expiresAt: null, preferenceRevision: null, selfNote: null, state: "active" as const };
  const saved = await withWorkerWorkspaceTransaction(scope, tx =>
    arrangeCompanionAttention(tx, scope, plan, { conversationId: run.cid, runId: run.runId }));
  const originalChat = MockProvider.prototype.chatCompletion, originalExecute = MockProvider.prototype.executeAgentTurn;
  let calls = 0;
  try {
    // 点的是 `companion_save_participation`，而她一次都没调过它（线上对 `agent_start_goal` 正是这个形状）。
    MockProvider.prototype.chatCompletion = async () => ({ content: JSON.stringify({ intent: "task_control", toolUse: "act",
      subjects: [], goalRelation: "unrelated", candidateOperations: ["companion_save_participation"], ambiguities: [],
      voiceStyle: { decision: "none", instruction: null }, pendingOfferIndexes: [] }), usage: {} });
    MockProvider.prototype.executeAgentTurn = async () => {
      calls += 1;
      if (calls === 2) return { content: "", toolCalls: [{ id: "verify-quiet", name: "companion_arrange_attention",
        arguments: { ...plan, expectedRevision: 1 } }], finishReason: "tool_calls", usage: null, providerRequestId: null };
      return { content: "实际结果：只保留安静事件，没有定时唤醒。", toolCalls: [], finishReason: "stop",
        usage: null, providerRequestId: null };
    };
    await invokeRun(scope.workspaceId, scope.userId, run);
    const [state] = await readInScope(scope, tx => tx`SELECT status FROM companion_turn_runs WHERE id=${run.runId}`);
    assert.equal(state.status, "succeeded", "已经落库的写被当成了没发生");
    const errors = await readInScope(scope, tx => tx`SELECT payload FROM companion_stream_events WHERE run_id=${run.runId} AND type='error'`);
    assert.equal(errors.length, 0, "这一轮不该留失败卡");
    const finals = await readInScope(scope, tx => tx`SELECT payload FROM companion_stream_events WHERE run_id=${run.runId} AND type='assistant.final'`);
    assert.equal(finals.length, 1, "正文必须真的交付出去，而不是只把写留在库里");
    const [current] = await readInScope(scope, tx => tx`SELECT revision FROM companion_attention_plans WHERE user_id=${scope.userId}`);
    assert.equal(current.revision, 1);
    assert.equal(new Date(saved.attention.updatedAt).getTime() > 0, true);
  } finally {
    MockProvider.prototype.chatCompletion = originalChat; MockProvider.prototype.executeAgentTurn = originalExecute;
    await run.cleanup();
  }
});

for (const repaired of [true, false]) test(`本轮禁止时间唤醒：${repaired ? "仅事件的修正可继续保存" : "换个时间也不能绕过禁止"}`, async () => {
  const scope = await seedBase();
  const run = await seedDialogueRun(scope.workspaceId, scope.userId, { userText: "只按安静事件触发，不要设置固定时间。" });
  const originalChat = MockProvider.prototype.chatCompletion;
  const originalExecute = MockProvider.prototype.executeAgentTurn;
  let calls = 0;
  try {
    MockProvider.prototype.chatCompletion = async () => ({ content: JSON.stringify({ intent: "task", toolUse: "act",
      subjects: [], goalRelation: "unrelated", candidateOperations: ["companion_arrange_attention"], ambiguities: [],
      executionConstraints: { timeBasedWakeups: "forbid", sourceQuote: "不要设置固定时间" },
      voiceStyle: { decision: "none", instruction: null }, pendingOfferIndexes: [] }), usage: {} });
    MockProvider.prototype.executeAgentTurn = async request => {
      calls += 1;
      assert.match(request.systemPrompt, /本轮执行边界/);
      if (calls === 2) assert.ok(request.messages.some(message => message.role === "tool"
        && String(message.content).includes("execution_constraint")));
      if (calls === 3 && repaired) return { content: "已按事件安排，没有定时重评。", toolCalls: [], finishReason: "stop", usage: null, providerRequestId: null };
      return { content: "", toolCalls: [{ id: `attention-${calls}`, name: "companion_arrange_attention", arguments: {
        key: "quiet-event-only", expectedRevision: 0, intent: "前台安静时自然问近况，只按事件触发。", topics: ["presence.quiet"],
        nextReviewAt: repaired && calls === 2 ? null : new Date(Date.now() + calls * 3600000).toISOString(),
        expiresAt: null, preferenceRevision: null, selfNote: null, state: "active",
      } }], finishReason: "tool_calls", usage: null, providerRequestId: null };
    };
    if (repaired) await invokeRun(scope.workspaceId, scope.userId, run);
    else await assert.rejects(invokeRun(scope.workspaceId, scope.userId, run),
      (error: unknown) => error instanceof AgentOutputError && error.code === "arguments_malformed");
    assert.equal(calls, repaired ? 3 : 2);
    const plans = await readInScope(scope, tx => tx`SELECT next_review_at FROM companion_attention_plans WHERE entry_key='quiet-event-only'`);
    assert.equal(plans.length, repaired ? 1 : 0);
    if (repaired) assert.equal(plans[0].next_review_at, null);
  } finally {
    MockProvider.prototype.chatCompletion = originalChat;
    MockProvider.prototype.executeAgentTurn = originalExecute;
    await run.cleanup();
  }
});

test("原文引文纠正后仍不匹配时发布失败，不保存成功答案或重投整轮", async () => {
  const scope = await seedBase();
  const run = await seedDialogueRun(scope.workspaceId, scope.userId, { userText: "这里原句怎么说的？" });
  const originalChat = MockProvider.prototype.chatCompletion;
  const originalExecute = MockProvider.prototype.executeAgentTurn;
  let calls = 0;
  try {
    await readInScope(scope, tx => tx`UPDATE companion_turn_runs SET page_context=${tx.json({ version: 1,
      selection: { text: "胡克定律仅在弹性限度内适用，超过范围后不能继续套用。", sharing: "user_selected" } })}
      WHERE id=${run.runId}`);
    MockProvider.prototype.chatCompletion = async () => ({ content: JSON.stringify({ intent: "question", toolUse: "none",
      subjects: [], goalRelation: "unrelated", candidateOperations: [], ambiguities: [], voiceStyle: { decision: "none", instruction: null }, pendingOfferIndexes: [] }), usage: {} });
    MockProvider.prototype.executeAgentTurn = async () => {
      calls += 1;
      return { content: "> 弹簧总是满足胡克定律，没有任何适用限制。", toolCalls: [], finishReason: "stop", usage: null, providerRequestId: null };
    };
    await assert.rejects(invokeRun(scope.workspaceId, scope.userId, run),
      (error: unknown) => error instanceof AgentOutputError && error.code === "unverified_quote");
    assert.equal(calls, 2, "只允许一次引文纠正，不无限生成");
    const [result] = await readInScope(scope, tx => tx`SELECT status, assistant_message_id FROM companion_turn_runs WHERE id=${run.runId}`);
    assert.equal(result.status, "failed");
    const history = await readInScope(scope, tx => tx`SELECT id, kind, blocks FROM companion_messages WHERE run_id=${run.runId} AND role='assistant'`);
    assert.equal(history.length, 1);
    assert.equal(history[0].id, result.assistant_message_id);
    assert.equal(history[0].kind, "error", "错误引文不造成功答案；历史只保留诚实的失败说明");
    assert.match(JSON.stringify(history[0].blocks), /引文.*原文/);
    assert.doesNotMatch(JSON.stringify(history[0].blocks), /弹簧总是满足/);
    const events = await readInScope(scope, tx => tx`SELECT type, payload FROM companion_stream_events WHERE run_id=${run.runId}`);
    const failure = events.find(event => event.type === "error");
    assert.equal(failure?.payload.recoverable, false);
    assert.match(JSON.stringify(failure?.payload), /引文.*原文/);
    assert.equal(events.some(event => event.type === "assistant.final"), false);
    const steps = await readInScope(scope, tx => tx`SELECT status, error_code FROM companion_agent_steps WHERE run_id=${run.runId} ORDER BY step_no`);
    assert.equal(steps.at(-1)?.status, "failed");
    assert.equal(steps.at(-1)?.error_code, "UNVERIFIED_QUOTE");
  } finally {
    MockProvider.prototype.chatCompletion = originalChat;
    MockProvider.prototype.executeAgentTurn = originalExecute;
    await run.cleanup();
  }
});

for (const corrected of [true, false]) test(`实际读取后引文纠正：${corrected ? "修正后完成答复" : "仍不匹配则诚实失败"}`, async () => {
  const scope = await seedBase();
  const run = await seedDialogueRun(scope.workspaceId, scope.userId, { userText: "看看现在的页面，原句怎么说的？" });
  const originalChat = MockProvider.prototype.chatCompletion;
  const originalExecute = MockProvider.prototype.executeAgentTurn;
  let calls = 0;
  try {
    MockProvider.prototype.chatCompletion = async () => ({ content: JSON.stringify({ intent: "question", toolUse: "read",
      subjects: [], goalRelation: "unrelated", candidateOperations: ["companion_read_current_page"], ambiguities: [], voiceStyle: { decision: "none", instruction: null }, pendingOfferIndexes: [] }), usage: {} });
    MockProvider.prototype.executeAgentTurn = async request => {
      calls += 1;
      if (calls === 1) return { content: "", toolCalls: [{ id: "read-for-quote", name: "companion_read_current_page", arguments: {} }],
        finishReason: "tool_calls", usage: null, providerRequestId: null };
      assert.ok(request.messages.some(message => message.role === "tool"), "校验前已经真实执行读取工具");
      if (calls === 3) assert.match(request.messages.filter(message => message.role === "system").map(message => message.content).join("\n"), /引语.*不一致/);
      return { content: corrected && calls === 3 ? "当前没有可读取的页面信息，我无法核对这段原文。" : "> 弹簧总是满足胡克定律，没有任何适用限制。",
        toolCalls: [], finishReason: "stop", usage: null, providerRequestId: null };
    };
    if (corrected) await invokeRun(scope.workspaceId, scope.userId, run);
    else await assert.rejects(invokeRun(scope.workspaceId, scope.userId, run),
      (error: unknown) => error instanceof AgentOutputError && error.code === "unverified_quote");
    assert.equal(calls, 3, "一次读取、一次答复、一次独立的引文纠正");
    const [result] = await readInScope(scope, tx => tx`SELECT status,tool_call_count FROM companion_turn_runs WHERE id=${run.runId}`);
    assert.equal(result.status, corrected ? "succeeded" : "failed");
    assert.equal(result.tool_call_count, 1, "引文纠正不重复读取工具");
    const history = await readInScope(scope, tx => tx`SELECT kind,blocks FROM companion_messages WHERE run_id=${run.runId} AND role='assistant'`);
    assert.equal(history.length, 1);
    assert.doesNotMatch(JSON.stringify(history[0].blocks), /弹簧总是满足/);
    if (corrected) assert.match(JSON.stringify(history[0].blocks), /无法核对/);
    else assert.equal(history[0].kind, "error");
  } finally {
    MockProvider.prototype.chatCompletion = originalChat;
    MockProvider.prototype.executeAgentTurn = originalExecute;
    await run.cleanup();
  }
});

test("20,000 字选区通过真实 handler 装配，末尾原文进入提交的模型快照", async () => {
  const previousWindow = process.env.MOCK_CONTEXT_WINDOW_TOKENS;
  // Exercise the active 1M route's input size; the default 128K mock route has
  // a different full-request budget and legitimately rejects this tool setup.
  process.env.MOCK_CONTEXT_WINDOW_TOKENS = "1000000";
  const scope = await seedBase();
  const run = await seedDialogueRun(scope.workspaceId, scope.userId, { userText: "最后那句改正了什么？" });
  const tail = "末尾更正：只写了初稿，还没有提交。";
  const selection = "段".repeat(20_000 - tail.length) + tail;
  try {
    await readInScope(scope, tx => tx`UPDATE companion_turn_runs SET page_context=${tx.json({ version: 1,
      selection: { text: selection, sharing: "user_selected" } })} WHERE id=${run.runId}`);
    await invokeRun(scope.workspaceId, scope.userId, run);
    const [snapshot] = await withWorkerWorkspaceTransaction(scope, tx => tx.execute<{
      snapshot: { modelMessages: Array<{ role: string; content: unknown }> };
    }>(drizzleSql`SELECT snapshot FROM companion_context_handoff_snapshots WHERE run_id=${run.runId}`));
    assert.ok(snapshot?.snapshot.modelMessages.some((m: { role: string; content: unknown }) =>
      m.role === "user" && typeof m.content === "string" && m.content.includes(selection)));
    const [result] = await readInScope(scope, tx => tx`SELECT status, model_call_count FROM companion_turn_runs WHERE id=${run.runId}`);
    assert.equal(result.status, "succeeded");
    assert.ok(Number(result.model_call_count) > 0);
  } finally {
    if (previousWindow === undefined) delete process.env.MOCK_CONTEXT_WINDOW_TOKENS;
    else process.env.MOCK_CONTEXT_WINDOW_TOKENS = previousWindow;
    await run.cleanup();
  }
});

test("存量超大必要来源在调用模型前失败并发布终态，不让界面一直准备回复", async () => {
  const scope = await seedBase();
  const run = await seedDialogueRun(scope.workspaceId, scope.userId, { userText: "读这一段。" });
  try {
    await readInScope(scope, tx => tx`UPDATE companion_turn_runs SET page_context=${tx.json({ version: 1,
      selection: { text: "段".repeat(110_000), sharing: "user_selected" } })} WHERE id=${run.runId}`);
    await assert.rejects(invokeRun(scope.workspaceId, scope.userId, run),
      (error: unknown) => error instanceof AIContextOverflowError);
    const [result] = await readInScope(scope, tx => tx`SELECT status, error_code, model_call_count FROM companion_turn_runs WHERE id=${run.runId}`);
    assert.equal(result.status, "failed");
    assert.equal(result.error_code, "AGENT_BUDGET_EXCEEDED");
    assert.equal(Number(result.model_call_count), 0);
    const events = await readInScope(scope, tx => tx`SELECT type, payload FROM companion_stream_events WHERE run_id=${run.runId}`);
    assert.ok(events.some(event => event.type === "character.cue"));
    assert.ok(events.some(event => event.type === "error" && event.payload.recoverable === false));
  } finally { await run.cleanup(); }
});

for (const mode of ["eof", "output-limit", "delayed-phase"] as const) {
  test(`真实 handler / 受限数据库：Responses ${mode} 的流、消息与终态一致`, async () => {
    const scope = await seedBase();
    const s = await seedDialogueRun(scope.workspaceId, scope.userId,
      { userText: "简历改完了，还没投出去，看得我眼睛疼。" });
    const text = "改完简历这一关已经够费眼睛了，反复盯着那些句子和标点，字看久了都要长得一样。现在改完了，还没投出去，这两件事我分得清。";
    let requests = 0;
    const adapter = new OpenCodeGoProvider({ apiKey: "fixture", model: "fixture", baseUrl: "https://opencode.ai/zen/go/v1",
      modelProfile: { contextWindowTokens: 262144, maxOutputTokens: 8000, vision: false,
        supportsAssistantPhase: mode === "delayed-phase" },
      streamRequest: async () => {
        requests++;
        return { status: 200, statusText: "OK", cancel: () => undefined,
          body: (async function* () {
            const encoder = new TextEncoder();
            const data = (event: unknown) => encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
            yield data({ type: "response.output_text.delta", output_index: 0,
              delta: mode === "delayed-phase" ? "私有中间说明不应送达" : text });
            // This case tests preservation of an already delivered prefix.
            // Synchronize on its real committed event; a fixed 100ms raced the
            // classifier/restricted-role flush under the full regression load.
            if (mode !== "delayed-phase") {
              const deadline = Date.now() + 10_000;
              for (;;) {
                const rows = await readInScope(scope, tx => tx`SELECT 1 FROM companion_stream_events
                  WHERE run_id=${s.runId} AND type='assistant.delta' LIMIT 1`);
                if (rows.length) break;
                assert.ok(Date.now() < deadline, "the scripted prefix must be committed before simulating interruption");
                await new Promise(resolve => setTimeout(resolve, 20));
              }
            }
            if (mode === "output-limit") yield data({ type: "response.incomplete", response: {
              status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } });
            if (mode === "delayed-phase") yield data({ type: "response.completed", response: {
              status: "completed", output: [
                { type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "私有中间说明不应送达" }] },
                { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text }] },
              ] } });
          })() };
      } });
    Object.defineProperty(MockProvider.prototype, "chatCompletionStream", { ...mockStreamDescriptor,
      value: adapter.chatCompletionStream.bind(adapter) });
    try {
      if (mode === "delayed-phase") await invokeRun(scope.workspaceId, scope.userId, s);
      else await assert.rejects(() => invokeRun(scope.workspaceId, scope.userId, s), (error: unknown) =>
        mode === "eof" ? error instanceof ProviderStreamError && error.code === "stream_incomplete"
          : error instanceof AgentOutputError && error.code === "output_truncated");
      const actual = await readInScope(scope, async tx => ({
        run: (await tx`SELECT status, error_code FROM companion_turn_runs WHERE id = ${s.runId}`)[0],
        messages: await tx`SELECT kind, blocks FROM companion_messages WHERE run_id = ${s.runId} AND role = 'assistant'`,
        events: await tx`SELECT type, payload FROM companion_stream_events WHERE run_id = ${s.runId} ORDER BY seq`,
      }));
      assert.equal(requests, 1, "输出截断和已送达前缀都不能触发重试");
      const deltas = actual.events.filter(e => e.type === "assistant.delta").map(e => e.payload.textDelta).join("");
      assert.equal(actual.messages.length, 1);
      const savedText = actual.messages[0]!.blocks.filter((block: { type: string }) => block.type === "text")
        .map((block: { text: string }) => block.text).join("");
      assert.equal(savedText, text);
      assert.equal(deltas, text);
      assert.ok(!JSON.stringify(actual).includes("私有中间说明不应送达"));
      if (mode === "delayed-phase") {
        assert.equal(actual.run!.status, "succeeded");
        assert.equal(actual.messages[0]!.kind, "text");
        assert.ok(actual.events.some(e => e.type === "assistant.final"));
      } else {
        assert.equal(actual.run!.status, "failed");
        assert.equal(actual.messages[0]!.kind, "error");
        assert.ok(actual.events.some(e => e.type === "error"));
        assert.ok(actual.events.every(e => e.type !== "assistant.final"));
        if (mode === "output-limit") {
          const error = actual.events.find(e => e.type === "error")!;
          assert.equal(error.payload.recoverable, false);
          assert.equal(actual.run!.error_code, "REPLY_LENGTH_LIMIT");
        }
      }
    } finally {
      Object.defineProperty(MockProvider.prototype, "chatCompletionStream", { ...mockStreamDescriptor, value: undefined });
      await s.cleanup();
    }
  });
}

test("思考走独立通道：assistant.thinking 落库，正文、消息与朗读侧都看不见它", async () => {
  const { workspaceId, userId } = await seedBase();
  const s = await seedDialogueRun(workspaceId, userId, { userText: "今天学得有点绕不过来了。" });
  const answer = "绕不过来就先停在这一句上，不用今天把所有环节都补齐。";
  const thoughts = ["他还没说完的是哪一段，", "先接住情绪，", "再问要不要拆开看。"];
  const previousChatCompletion = MockProvider.prototype.chatCompletion;
  const previousExecute = MockProvider.prototype.executeAgentTurn;
  try {
    // 解释是干净的闲聊轮，投机的那一步被保留、正式第一步不再重跑。
    // mock 无所谓思考档（真机上闲聊轮压根不吐思考字），这里要测的是**通道**：
    // provider 交出来的思考必须只落在 assistant.thinking 这一条上。
    MockProvider.prototype.chatCompletion = async () => ({ content: JSON.stringify({
      intent: "conversation", toolUse: "none", subjects: [], goalRelation: "unrelated",
      candidateOperations: [], ambiguities: [], voiceStyle: { decision: "none", instruction: null },
      pendingOfferIndexes: [] }), usage: {} });
    MockProvider.prototype.executeAgentTurn = async () => {
      throw new Error("投机的那一步已被保留，不该再走缓冲重跑");
    };
    Object.defineProperty(MockProvider.prototype, "chatCompletionStream", { ...mockStreamDescriptor,
      value: async (_messages: unknown, options: { onReasoningDelta?: (text: string) => void },
        _signal: AbortSignal | undefined, onDelta: (text: string) => void) => {
        for (const thought of thoughts) {
          options.onReasoningDelta?.(thought);
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        onDelta(answer);
        return { content: answer, toolCalls: [], finishReason: "stop" };
      } });
    await invokeRun(workspaceId, userId, s);
    const actual = await readInScope({ workspaceId, userId }, async (tx) => ({
      events: await tx`SELECT type, payload FROM companion_stream_events WHERE run_id=${s.runId} ORDER BY seq`,
      messages: await tx`SELECT blocks FROM companion_messages WHERE run_id=${s.runId} AND role='assistant'`,
      run: (await tx`SELECT status FROM companion_turn_runs WHERE id=${s.runId}`)[0],
    }));
    assert.equal(actual.run!.status, "succeeded");
    const thinking = actual.events.filter((event) => event.type === "assistant.thinking");
    assert.ok(thinking.length > 0, "思考块必须真的落到事件流里");
    assert.equal(thinking.map((event) => event.payload.text).join(""), thoughts.join(""));
    assert.deepEqual(thinking.map((event) => event.payload.index), thinking.map((_, i) => i));
    const visible = actual.events.filter((event) => event.type === "assistant.delta")
      .map((event) => event.payload.textDelta).join("");
    assert.equal(visible, answer, "已下发正文只有答案，思考一个字都没混进来");
    const savedText = actual.messages[0]!.blocks
      .filter((block: { type: string }) => block.type === "text")
      .map((block: { text: string }) => block.text).join("");
    assert.equal(savedText, answer);
    // 朗读分段由已提交的可见正文驱动，所以"正文里没有"就等于"念不到"；
    // 这里再把这条不变量钉死一次：除 assistant.thinking 之外任何事件都不许带这些字。
    assert.ok(!JSON.stringify(actual.events.filter((event) => event.type !== "assistant.thinking"))
      .includes(thoughts[0]!));
    assert.ok(!JSON.stringify(actual.messages).includes(thoughts[1]!));
  } finally {
    MockProvider.prototype.chatCompletion = previousChatCompletion;
    MockProvider.prototype.executeAgentTurn = previousExecute;
    Object.defineProperty(MockProvider.prototype, "chatCompletionStream", { ...mockStreamDescriptor, value: undefined });
    await s.cleanup();
  }
});

test("P2 §5.2：accepted run → assistant message + status/delta/final 事件 + run succeeded + last_event_seq", async () => {
  const { workspaceId, userId } = await seedBase();
  const s = await seedDialogueRun(workspaceId, userId, { cleanupWorkspace: false });
  const failedFirst = await seedDialogueRun(workspaceId, userId, { cleanupWorkspace: false });
  const failedLatest = await seedDialogueRun(workspaceId, userId);
  const previousVoiceFlag = process.env.COMPANION_VOICE_DIALOGUE_V1_ENABLED;
  process.env.COMPANION_VOICE_DIALOGUE_V1_ENABLED = "true";
  try {
    // Two independent failed run transactions stand in for failures before a
    // worker restart. The succeeding turn below must recover the same durable span.
    for (const failed of [failedFirst, failedLatest]) {
      await markCompanionRunFailed(
        {
          runId: failed.runId,
          conversationId: failed.cid,
          userId,
          generation: 1,
          accountEpoch: 0,
        },
        { id: failed.jobId, workspaceId, requestedBy: userId, leaseToken: "fixture-lease" },
        "PROVIDER_UNAVAILABLE",
        true,
        "provider unavailable",
        "transport",
      );
    }

    await invokeRun(workspaceId, userId, s);

    const rows = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${userId}, true)`;
      const run = await tx`SELECT status, assistant_message_id, last_event_seq, provider_id, prompt_version, prompt_hash
                           FROM companion_turn_runs WHERE id = ${s.runId}`;
      const assistant = await tx`SELECT role, kind, run_id FROM companion_messages
                                  WHERE conversation_id = ${s.cid} AND role = 'assistant'`;
      const events = await tx`SELECT type FROM companion_stream_events
                               WHERE conversation_id = ${s.cid} ORDER BY seq`;
      const conv = await tx`SELECT next_message_seq, next_event_seq FROM companion_conversations WHERE id = ${s.cid}`;
      return { run: run[0], assistant, events, conv: conv[0] };
    });

    assert.equal(rows.run.status, "succeeded");
    assert.ok(rows.run.assistant_message_id, "assistant_message_id 已写");
    assert.ok(Number(rows.run.last_event_seq) >= 3, "last_event_seq 已推进");
    assert.equal(rows.run.provider_id, "mock", "mock provider 显式记录");
    assert.equal(rows.run.prompt_version, COMPANION_PERSONA_V14_PROMPT_ID, "现役提示词版本已写入回合记录");
    assert.equal(rows.run.prompt_hash, COMPANION_PERSONA_V14_SHA256, "现役提示词哈希已写入回合记录");
    assert.equal(rows.assistant.length, 1, "恰好一条 assistant message");
    assert.equal(rows.assistant[0].run_id, s.runId, "assistant message 绑定本 run");
    assert.equal(rows.assistant[0].kind, "text", "用户提问的回答不能被记成主动发言（对照主动轮的 proactive）");
    const types = rows.events.map((e) => e.type);
    assert.ok(types.includes("assistant.status"), "assistant.status 事件存在");
    assert.ok(types.includes("assistant.delta"), "assistant.delta 事件存在");
    assert.ok(types.includes("assistant.final"), "assistant.final 事件存在");
    assert.ok(types.includes("voice.segment.ready"), "TTS 分段真实进入事件流");
    assert.equal(types[0], "assistant.status", "事件顺序：status 最先");
    // §11.3：worker 是 TTS 切句唯一所有者——voice.segment.ready 在 final 之后；
    // 终态回复情绪 cue 也在 final 之后（同一终态事务原子写入）。
    const finalIdx = types.indexOf("assistant.final");
    assert.ok(
      types.slice(finalIdx + 1).every((t: string) => t === "voice.segment.ready" || t === "character.cue"),
      "事件顺序：final 之后只有 voice.segment.ready / character.cue",
    );
    assert.ok(Number(rows.conv.next_event_seq) > 1, "conversation 计数器推进");

    const handoffs = await withWorkerWorkspaceTransaction({ workspaceId, userId }, (tx) =>
      tx.execute<{
        snapshot: CompanionContextHandoffSnapshotV1;
        snapshot_sha256: string;
      }>(drizzleSql`
        SELECT snapshot, snapshot_sha256
        FROM companion_context_handoff_snapshots
        WHERE run_id = ${s.runId}
      `));
    const committedHandoff = handoffs[0];
    assert.ok(committedHandoff, "provider 调用前已持久化不可变交接快照");
    assert.equal(committedHandoff.snapshot.runId, s.runId);
    assert.equal(committedHandoff.snapshot.conversationId, s.cid);
    const systemContent = committedHandoff.snapshot.modelMessages[0]?.content;
    assert.ok(typeof systemContent === "string", "伴星 system 消息以文本形式保存在交接快照中");
    assert.match(systemContent, /记录可能出错或过时/, "持久化交接快照保留实际发送的身份边界");
    assert.ok(
      systemContent.includes(COMPANION_IDENTITY_BOUNDARY_V4),
      "交接快照中完整保留身份边界，而不只保存静态 prompt hash",
    );
    assert.equal(
      committedHandoff.snapshot.currentRequest.contentSha256,
      sha256Utf8V1("帮我复习光合作用"),
      "快照绑定本 run 的当前请求",
    );
    assert.equal(
      committedHandoff.snapshot.modelMessages.at(-1)?.content,
      "帮我复习光合作用",
      "快照保留实际送给模型的末尾 user message",
    );

    const changedRetryCandidate = structuredClone(committedHandoff.snapshot);
    const lastMessage = changedRetryCandidate.modelMessages.at(-1);
    assert.ok(lastMessage);
    lastMessage.content = "错误的重试输入";
    const retried = await persistCompanionContextHandoffSnapshot({
      workspaceId,
      userId,
      runId: s.runId,
      snapshot: changedRetryCandidate,
      sha256: sha256Utf8V1(canonicalJsonV1(changedRetryCandidate)),
    });
    assert.equal(retried.sha256, committedHandoff.snapshot_sha256, "重试沿用首次提交的内容哈希");
    assert.deepEqual(retried.snapshot, committedHandoff.snapshot, "重试不能覆盖已提交的模型输入");

    const failureSpans = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${userId}, true)`;
      return tx`SELECT failure_class, failure_count, first_run_id, last_run_id,
                       recovered_at, recovery_run_id
                FROM companion_run_failure_spans
                WHERE workspace_id = ${workspaceId} AND user_id = ${userId}
                ORDER BY failure_class`;
    });
    assert.deepEqual(failureSpans.map((span) => span.failure_class), ["transport"]);
    assert.equal(Number(failureSpans[0]?.failure_count), 2, "连续失败合并成同一段");
    assert.equal(failureSpans[0]?.first_run_id, failedFirst.runId, "失败段记录首次任务身份");
    assert.equal(failureSpans[0]?.last_run_id, failedLatest.runId, "失败段记录最近任务身份");
    assert.ok(failureSpans[0]?.recovered_at, "首次成功后保留恢复时间");
    assert.equal(failureSpans[0]?.recovery_run_id, s.runId, "恢复身份绑定真实成功 run");
  } finally {
    if (previousVoiceFlag === undefined) delete process.env.COMPANION_VOICE_DIALOGUE_V1_ENABLED;
    else process.env.COMPANION_VOICE_DIALOGUE_V1_ENABLED = previousVoiceFlag;
    await s.cleanup();
    await failedFirst.cleanup();
    await failedLatest.cleanup();
  }
});

test("P2 §5.2 fence：run 已被 cancel/supersede 时丢弃迟到输出，零副作用", async () => {
  const { workspaceId, userId } = await seedBase();
  const s = await seedDialogueRun(workspaceId, userId, { runStatus: "cancelled" });
  try {
    await invokeRun(workspaceId, userId, s);

    const rows = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${userId}, true)`;
      const run = await tx`SELECT status, assistant_message_id FROM companion_turn_runs WHERE id = ${s.runId}`;
      const assistant = await tx`SELECT id FROM companion_messages
                                  WHERE conversation_id = ${s.cid} AND role = 'assistant'`;
      const events = await tx`SELECT seq FROM companion_stream_events WHERE conversation_id = ${s.cid}`;
      return { run: run[0], assistant, events };
    });

    assert.equal(rows.run.status, "cancelled", "fence 不得改写终态");
    assert.equal(rows.run.assistant_message_id, null, "不得写入 assistant message");
    assert.equal(rows.assistant.length, 0, "零 assistant message");
    assert.equal(rows.events.length, 0, "零事件");
  } finally {
    await s.cleanup();
  }
});

test("P2 §5.2 userText 归属：voice_transcript turn 取本 run 用户消息，而非更新的 text 消息", async () => {
  const { workspaceId, userId } = await seedBase();
  const s = await seedDialogueRun(workspaceId, userId, {
    userKind: "voice_transcript",
    userText: "这段语音内容",
    newerTextMessage: true,
  });
  try {
    await invokeRun(workspaceId, userId, s);

    const rows = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${userId}, true)`;
      const run = await tx`SELECT status FROM companion_turn_runs WHERE id = ${s.runId}`;
      const assistant = await tx`SELECT blocks FROM companion_messages
                                  WHERE conversation_id = ${s.cid} AND role = 'assistant'`;
      return { run: run[0], assistant };
    });

    // mock provider 只证明链路跑通且 userText 查询无异常；真实文本内容
    // 的正确性由查询条件保证（id = user_message_id，含 kind='voice_transcript'）。
    assert.equal(rows.run.status, "succeeded", "voice_transcript turn 也能正常完成");
    assert.equal(rows.assistant.length, 1, "assistant 回复已写入");
  } finally {
    await s.cleanup();
  }
});

/**
 * 2026-10-13 方案 56 遗留缺陷：主动那一轮的**普通收尾**原来也写 `kind='text'`。
 *
 * 两处写入口径必须一致：`companion_publish_utterance` 早就是 initiative ⇒ proactive，
 * 而终态正文写死 text，于是 `runCompanionInitiative` 的节奏读数
 * （`max(created_at) ... AND kind='proactive'`）与按 kind 认她发言的历史/记忆/摘要
 * 都漏掉她主动说的大部分话（真库读数：23 条 initiative 助手消息里 22 条是 text）。
 *
 * 这条用例把两侧一起钉住：主动轮 ⇒ proactive，普通问答 ⇒ text——后者同样重要，
 * 不能反过来把回答用户提问的消息记成主动发言。
 */
test("主动交流的普通收尾记 kind='proactive'，普通问答仍是 'text'", async () => {
  const initiativeScope = await seedBase();
  const ordinaryScope = await seedBase();
  const initiative = await seedDialogueRun(initiativeScope.workspaceId, initiativeScope.userId, { initiative: true });
  const ordinary = await seedDialogueRun(ordinaryScope.workspaceId, ordinaryScope.userId, {});
  try {
    await invokeRun(initiativeScope.workspaceId, initiativeScope.userId, initiative);
    await invokeRun(ordinaryScope.workspaceId, ordinaryScope.userId, ordinary);

    const rows = await readInScope(initiativeScope, tx => tx`
      SELECT role, kind, blocks->0->>'text' AS text FROM companion_messages
      WHERE run_id=${initiative.runId} AND role='assistant'`);
    assert.equal(rows.length, 1, "主动轮同样只写一条终态消息");
    assert.equal(rows[0].kind, "proactive", "她自己开口的那一轮，普通收尾也必须算 proactive");
    assert.ok(String(rows[0].text ?? "").trim().length > 0, "主动轮的收尾仍然有正文");

    const ordinaryRows = await readInScope(ordinaryScope, tx => tx`
      SELECT role, kind FROM companion_messages WHERE run_id=${ordinary.runId} AND role='assistant'`);
    assert.equal(ordinaryRows.length, 1);
    assert.equal(ordinaryRows[0].kind, "text", "用户提问的回答不能被记成主动发言");
  } finally {
    await initiative.cleanup();
    await ordinary.cleanup();
  }
});

/**
 * 只回情绪标记 = 她这一句没话讲，不是系统出错。
 *
 * 2026-10-16 生产 run `df40b8a9`：用户发「哈哈哈」，她回 `[neutral]`，人问这一支
 * 当时没有豁免，被判 `INTERNAL_ERROR` 并留下「这次回复没能完成」。原来这条测试
 * 断言的正是那个不对称（`initiative ? "succeeded" : "failed"`）；同一文件里
 * `!agentResult.text.trim()` 那条早就让人问轮的"真·空回复"安静收尾了，
 * 只回标记与它只差一层信封，不该是两种结局。
 * 反向对照留在下面：换成人问 + 信封泄露，仍然必须判失败。
 */
test("只回情绪标记时两支都安静收尾；人问的无效输出仍判失败", async () => {
  const original = MockProvider.prototype.executeAgentTurn;
  const fixtures: Array<Awaited<ReturnType<typeof seedDialogueRun>>> = [];
  try {
    MockProvider.prototype.executeAgentTurn = async () => ({ content: "[neutral]", toolCalls: [],
      finishReason: "stop", usage: {}, providerRequestId: "silent-host-markers" });
    for (const initiative of [true, false]) {
      const scope = await seedBase();
      const run = await seedDialogueRun(scope.workspaceId, scope.userId, { initiative, userText: "你好" });
      fixtures.push(run);
      await invokeRun(scope.workspaceId, scope.userId, run);
      await readInScope(scope, async tx => {
        const [state] = await tx`SELECT status FROM companion_turn_runs WHERE id=${run.runId}`;
        assert.equal(state!.status, "succeeded", "没话讲不是内部错误，两支都一样");
        const messages = await tx`SELECT id FROM companion_messages WHERE run_id=${run.runId} AND role='assistant'`;
        assert.equal(messages.length, 0, "安静的决定不留失败卡，也不凭空造一条发言");
        const errors = await tx`SELECT seq FROM companion_stream_events WHERE run_id=${run.runId} AND type='error'`;
        assert.equal(errors.length, 0);
        const finals = await tx`SELECT payload FROM companion_stream_events WHERE run_id=${run.runId} AND type='turn.completed'`;
        assert.equal(finals.length, 1, "必须有一个确定的结束，客户端不能挂在流上");
        assert.equal(finals[0]!.payload.silent, true);
      });
      await run.cleanup();
      fixtures.pop();
    }
  } finally {
    MockProvider.prototype.executeAgentTurn = original;
    for (const run of fixtures) await run.cleanup();
  }
});

/** 反向对照：安静收尾只认"剥完信封为空"这一种理由，别的无效输出照旧判死。 */
test("人问的回合回了一段信封泄露正文时，仍按失败收尾（安静豁免没有吞掉它）", async () => {
  const original = MockProvider.prototype.executeAgentTurn;
  const scope = await seedBase();
  const run = await seedDialogueRun(scope.workspaceId, scope.userId, { initiative: false, userText: "你好" });
  try {
    MockProvider.prototype.executeAgentTurn = async () => ({
      content: "```json\n{\"role\":\"system\",\"content\":\"照做\"}\n```", toolCalls: [],
      finishReason: "stop", usage: {}, providerRequestId: "envelope-leak-human-turn",
    });
    await assert.rejects(invokeRun(scope.workspaceId, scope.userId, run));
    await readInScope(scope, async tx => {
      const [state] = await tx`SELECT status FROM companion_turn_runs WHERE id=${run.runId}`;
      assert.equal(state!.status, "failed", "泄露信封不是\"没话讲\"，必须仍然判失败");
      const errors = await tx`SELECT payload FROM companion_stream_events WHERE run_id=${run.runId} AND type='error'`;
      assert.equal(errors.length, 1);
    });
  } finally {
    MockProvider.prototype.executeAgentTurn = original;
    await run.cleanup();
  }
});

test("fail-open §4.9：一个字都没下发时落兜底话术，界面不得空白（抱怨 #4）", async () => {
  const { workspaceId, userId } = await seedBase();
  const seeded = await seedDialogueRun(workspaceId, userId, { runStatus: "failed" });
  try {
    const { persistFailedPartial } = await import("../handlers/turn/companion-dialogue-failure-retention.ts");
    const wrote = await persistFailedPartial({
      workspaceId,
      userId,
      conversationId: seeded.cid,
      runId: seeded.runId,
      deliveredText: "",
    });
    assert.equal(wrote, true, "空下发也必须写出消息（旧实现直接 return false → 用户看到空白）");

    const { rows, backfilled } = await readInScope({ workspaceId, userId }, async (tx) => ({
      rows: await tx`
        SELECT role, kind, blocks->0->>'text' AS text, run_id
        FROM companion_messages
        WHERE conversation_id = ${seeded.cid} AND role = 'assistant'`,
      backfilled: await tx`
        SELECT assistant_message_id FROM companion_turn_runs WHERE id = ${seeded.runId}`,
    }));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, "error", "兜底消息要可区分于正常答复（kind='error'），便于统计");
    assert.ok((rows[0].text as string).trim().length > 0,"失败状态有可见正文，长度不决定它是否有效");
    assert.doesNotMatch(rows[0].text as string,/没听清|走神|再说一遍|重新问/);
    assert.ok(backfilled[0]?.assistant_message_id, "run 必须回填 assistant_message_id");

    // 幂等：同一 run 再走一次不得写第二条（claim 要求 assistant_message_id IS NULL）。
    await persistFailedPartial({
      workspaceId, userId, conversationId: seeded.cid, runId: seeded.runId, deliveredText: "",
    });
    const after = await readInScope({ workspaceId, userId }, async (tx) => tx`
      SELECT count(*)::int n FROM companion_messages
      WHERE conversation_id = ${seeded.cid} AND role = 'assistant'`);
    assert.equal(after[0].n, 1, "重投不应产生第二条兜底消息");
  } finally {
    await seeded.cleanup();
  }
});

test("fail-open §4.9：已有半句可保留时优先保留原文，不覆盖成兜底话术", async () => {
  const { workspaceId, userId } = await seedBase();
  const seeded = await seedDialogueRun(workspaceId, userId, { runStatus: "failed" });
  try {
    const { persistFailedPartial } = await import("../handlers/turn/companion-dialogue-failure-retention.ts");
    const partial = "我先把这道题的思路说清楚，然后再给你举一个例子";
    await persistFailedPartial({
      workspaceId, userId, conversationId: seeded.cid, runId: seeded.runId, deliveredText: partial,
    });
    const rows = await readInScope({ workspaceId, userId }, async (tx) => tx`
      SELECT blocks->0->>'text' AS text FROM companion_messages
      WHERE conversation_id = ${seeded.cid} AND role = 'assistant'`);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].text, partial, "已经说出口的那半句不能被人造话术顶掉");
  } finally {
    await seeded.cleanup();
  }
});


/**
 * 39d W2-5 的**端到端**一段：用户问学习数据 → 服务端读真值 → `<fact_spans>` 目录 →
 * 她引用键 → 下发前换成真实数值。
 *
 * 单元级用例只能证明"给定值会渲染"，这一条证的是**管道接通**：目录确实从读阶段走到了
 * 交付与落库两处（中间还有流式对账，两处不一致会整轮失败）。
 * 她**会不会**真去写占位符，仍只能靠每波末尾那一次真模型跑。
 *
 * 两次跑用**不同的时长**：数字必须跟着数据变，否则"42"可能只是 mock 文案里写死的。
 */
test("读数目录端到端：她写 {{f:today_minutes}}，落库的是服务端填的那个分钟数", async () => {
  const { workspaceId, userId } = await seedBase();
  const metricId = randomUUID();
  const cleanups: (() => Promise<void>)[] = [];
  const seedMetric = async (seconds: number) => {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${userId}, true)`;
      if (seconds === 0) {
        await tx`DELETE FROM learning_metric_events WHERE id = ${metricId}`;
        return;
      }
      // 今日已学：`readLearningStats` 按用户本地日切，这一条落在 now() 上。
      await tx`
        INSERT INTO learning_metric_events (id, workspace_id, user_id, event_type, occurred_at, active_seconds_used)
        VALUES (${metricId}, ${workspaceId}, ${userId}, 'session_tick', now(), ${seconds})
        ON CONFLICT (id) DO UPDATE SET active_seconds_used = ${seconds}
      `;
    });
  };
  const runOnce = async (expected: string) => {
    const s = await seedDialogueRun(workspaceId, userId, { userText: "我今天学了多久【mock:fact-span】" });
    cleanups.push(s.cleanup);
    await invokeRun(workspaceId, userId, s);
    const rows = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${userId}, true)`;
      return tx`SELECT blocks->0->>'text' AS text FROM companion_messages
                WHERE conversation_id = ${s.cid} AND role = 'assistant'`;
    });
    const text = String(rows[0]?.text ?? "");
    assert.ok(text.includes(expected), `目录里的值没被渲染成 ${expected}：${JSON.stringify(text)}`);
    assert.ok(!text.includes("{{"), `占位符漏到了落库正文里：${JSON.stringify(text)}`);
    return text;
  };
  try {
    await seedMetric(2520); // 42 分钟
    const first = await runOnce("42 分钟");
    await seedMetric(600); // 10 分钟
    const second = await runOnce("10 分钟");
    assert.ok(!second.includes("42"), `第二次还在念第一次的数（值不是这一轮读出来的）：${JSON.stringify(second)}`);
    assert.notEqual(first, second);
  } finally {
    await seedMetric(0).catch(() => undefined);
    for (const cleanup of cleanups) await cleanup().catch(() => undefined);
  }
});

/**
 * 39d W2-6 的端到端一段：用户正在正式作答，伴星把答案原句念回去了 ⇒
 * **终态事务里替她记一笔 `learning_exposures_v2`**。
 *
 * 为什么必须端到端：单元级只验得出"重合判据"，而这条链的要点是"写入门在服务端、
 * 不在她嘴里"——她没有"我泄露了"这个工具，判与写都发生在她这句话落库的同一次事务里。
 * 反向对照（普通一句不带题面的回答记 0 行）与幂等同款：只有正向会红时，那条 0 才有意义。
 */
test("她在作答页把答案念回去：同一轮终态事务里记一笔 answer_reveal", async () => {
  const fixture = await seedFormalAnswerRun(sql, {
    canonicalAnswer: "复利效应是本金产生利息后加入本金继续生息的现象",
  });
  const s = await seedDialogueRun(fixture.workspaceId, fixture.userId, {
    userText: "这题我不会，你给我说清楚点【mock:leak-answer】",
    // 入口条件：这一轮开问时人在作答页，且点名的就是这一轮（39d W2-6 / D7 §6）。
    livePage: { pageKind: "learning_run", interactionState: "formal_answer", learningRunId: fixture.runId },
  });
  try {
    await invokeRun(fixture.workspaceId, fixture.userId, s);
    const rows = await readInScope(
      { workspaceId: fixture.workspaceId, userId: fixture.userId },
      async (tx) => tx`SELECT exposure_kind, objective_id, objective_revision, idempotency_key
                       FROM learning_exposures_v2 WHERE workspace_id = ${fixture.workspaceId}`,
    );
    assert.equal(rows.length, 1, `她念了答案却没记账（或记重了）：${JSON.stringify(rows)}`);
    assert.equal(rows[0].exposure_kind, "answer_reveal");
    assert.equal(String(rows[0].objective_id), fixture.objectiveId);
    assert.equal(rows[0].idempotency_key, `companion-turn:${s.runId}`);
  } finally {
    await s.cleanup().catch(() => undefined);
    await fixture.cleanup().catch(() => undefined);
  }
});

test("反向：同一句话、同一个正式轮次，但那一轮不在作答页 ⇒ 一笔都不记", async () => {
  const fixture = await seedFormalAnswerRun(sql, {
    canonicalAnswer: "复利效应是本金产生利息后加入本金继续生息的现象",
  });
  const s = await seedDialogueRun(fixture.workspaceId, fixture.userId, {
    // 同样的那句话、同一个正在进行的正式轮次，**唯一差别是那一屏报的是 idle**（渲染层
    // 只在 assessment 屏报 formal_answer，result 屏就是 idle）。她可能只是在笔记页或
    // 结果页念原文（学习卡题面本来就从笔记里抽的），记一笔就会压低用户下一次独立作答
    // 的资格——那是误判方向，D7 §3 不允许。
    userText: "这题我不会，你给我说清楚点【mock:leak-answer】",
    livePage: { pageKind: "learning_run", interactionState: "idle", learningRunId: fixture.runId },
  });
  try {
    await invokeRun(fixture.workspaceId, fixture.userId, s);
    const rows = await readInScope(
      { workspaceId: fixture.workspaceId, userId: fixture.userId },
      async (tx) => tx`SELECT 1 FROM learning_exposures_v2 WHERE workspace_id = ${fixture.workspaceId}`,
    );
    assert.equal(rows.length, 0, "不在作答页的那一轮被记成答案暴露：她的每句话都会压低用户的独立判定资格");
  } finally {
    await s.cleanup().catch(() => undefined);
    await fixture.cleanup().catch(() => undefined);
  }
});

test("反向：她这一句没碰题面也没碰答案 ⇒ 一笔都不记（普通鼓励不是暴露）", async () => {
  const fixture = await seedFormalAnswerRun(sql, {
    canonicalAnswer: "复利效应是本金产生利息后加入本金继续生息的现象",
  });
  const s = await seedDialogueRun(fixture.workspaceId, fixture.userId, {
    // 页面条件成立，回答不沾题面/答案。为什么不用默认 mock 文案：没有剧本时它会先走一步
    // `companion_read_context` 再把工具结果整段回声出来，那一步撞的是"内部标记泄露"
    // 这道全文校验（与暴露记账无关的既有行为）。
    userText: "我今天学了多久【mock:fact-span】",
    livePage: { pageKind: "learning_run", interactionState: "formal_answer", learningRunId: fixture.runId },
  });
  try {
    await invokeRun(fixture.workspaceId, fixture.userId, s);
    const rows = await readInScope(
      { workspaceId: fixture.workspaceId, userId: fixture.userId },
      async (tx) => tx`SELECT 1 FROM learning_exposures_v2 WHERE workspace_id = ${fixture.workspaceId}`,
    );
    assert.equal(rows.length, 0, "一句普通回答被记成答案暴露");
  } finally {
    await s.cleanup().catch(() => undefined);
    await fixture.cleanup().catch(() => undefined);
  }
});

test("摘要读取：只注入水位早于实际回放尾部的摘要，忽略无水位旧摘要", async () => {
  const { workspaceId, userId } = await seedBase();
  const s = await seedDialogueRun(workspaceId, userId);
  try {
    await readInScope({ workspaceId, userId }, async (tx) => {
      const makeSummary = (title: string) => tx.json({ title });
      await tx`
        INSERT INTO conversation_summaries
          (workspace_id, user_id, conversation_id, summary, status,
           coverage_from_seq, coverage_through_seq, coverage_source_hash)
        VALUES
          (${workspaceId}, ${userId}, ${s.cid}, ${makeSummary("安全的旧摘要")}, 'confirmed',
           1, 2, ${"a".repeat(64)}),
          (${workspaceId}, ${userId}, ${s.cid}, ${makeSummary("与回放重叠")}, 'candidate',
           1, 3, ${"b".repeat(64)}),
          (${workspaceId}, ${userId}, ${s.cid}, ${makeSummary("位于回放之后")}, 'candidate',
           1, 4, ${"c".repeat(64)}),
          (${workspaceId}, ${userId}, ${s.cid}, ${makeSummary("旧版无水位")}, 'candidate',
           NULL, NULL, NULL)
      `;
    });

    const beforeTail = await withWorkerWorkspaceTransaction({ workspaceId, userId }, (tx) =>
      readConversationSummary(tx, s.cid, "3"));
    assert.equal((beforeTail?.summary as { title?: string } | undefined)?.title, "安全的旧摘要");
    assert.equal(beforeTail?.coverage_through_seq, "2");

    const noSafeSummary = await withWorkerWorkspaceTransaction({ workspaceId, userId }, (tx) =>
      readConversationSummary(tx, s.cid, "1"));
    assert.equal(noSafeSummary, null,
      "水位重叠及无水位旧摘要都不能冒充可靠的更早上下文");
  } finally {
    await s.cleanup();
  }
});


test("真实读取保留每条消息的时间和来源；重试不更新首次发送的时钟", async () => {
  const { workspaceId, userId } = await seedBase();
  const oldText = "昨天写完的，还没交。\r\n" + "🫧原文".repeat(2000) + "最后更正：只是写完，没交。";
  const s = await seedDialogueRun(workspaceId, userId, {userText:"你今天有什么有意思的事？"});
  try {
    await readInScope({workspaceId, userId}, async tx => {
      await tx`SET LOCAL app.allow_history_mutation = 'on'`;
      await tx`UPDATE user_companion_account_state SET quiet_hours=${tx.json({timezone:"Asia/Tokyo"})} WHERE user_id=${userId}`;
      await tx`UPDATE companion_messages SET seq=3 WHERE id=${s.userMessageId}`;
      await tx`UPDATE companion_conversations SET next_message_seq=4 WHERE id=${s.cid}`;
      await tx`INSERT INTO companion_messages(id,conversation_id,workspace_id,user_id,role,seq,kind,blocks,content_sha256,created_at)
        VALUES(${randomUUID()},${s.cid},${workspaceId},${userId},'user',1,'text',
          ${tx.json([{type:"text",text:oldText}])},${sha256Utf8V1(oldText)},'2026-10-03T02:03:04Z'),
          (${randomUUID()},${s.cid},${workspaceId},${userId},'assistant',2,'text',
          ${tx.json([{type:"text",text:"已经交了呀。"}])},${sha256Utf8V1("已经交了呀。")},'2026-10-03T02:03:05Z')`;
    });
    await runCompanionDialogue({id:s.jobId,workspaceId,requestedBy:userId,payload:{runId:s.runId},
      leaseToken:"fixture-lease",signal:new AbortController().signal});
    const rows = await withWorkerWorkspaceTransaction({workspaceId, userId}, tx => tx.execute<{
      snapshot: CompanionContextHandoffSnapshotV1; snapshot_sha256: string;
    }>(drizzleSql`SELECT snapshot, snapshot_sha256 FROM companion_context_handoff_snapshots WHERE run_id=${s.runId}`));
    const row = rows[0];
    assert.ok(row, "必须沿完整 handler 创建快照，不能只测试拼接函数");
    const snapshot = row.snapshot as CompanionContextHandoffSnapshotV1;
    const system = String(snapshot.modelMessages[0]!.content);
    assert.doesNotMatch(system, /用户这一轮问的是学习数据/, "普通聊天不能被恒定的作答影响键转成学习统计问题");
    const timeline = JSON.parse(system.slice(system.indexOf("<conversation_timeline>")).split("\n")[2]!);
    assert.equal(timeline.timezone, "Asia/Tokyo");
    // The question and its answer remain together, including the late correction.
    assert.equal(snapshot.replayWindow?.omittedCount, 0);
    assert.equal(timeline.history.length, 2);
    assert.equal(timeline.history[0].speaker, "user");
    assert.equal(timeline.history[0].utteredAt, "2026-10-03T02:03:04.000Z");
    assert.equal(timeline.history[1].utteredAt, "2026-10-03T02:03:05.000Z");
    assert.equal(snapshot.modelMessages[1]!.content, oldText);
    assert.equal(snapshot.modelMessages[2]!.content, "已经交了呀。");
    assert.equal(snapshot.modelMessages[3]!.content, "你今天有什么有意思的事？");
    const [message] = await readInScope({workspaceId,userId}, tx => tx`SELECT created_at FROM companion_messages WHERE id=${s.userMessageId}`);
    assert.equal(timeline.current.utteredAt, new Date(message!.created_at).toISOString());
    assert.ok(timeline.history[0].elapsedMs > 0);
    const { readPastConversationMessages } = await import("../handlers/context/companion-summary-retrieval.ts");
    const page = await withWorkerWorkspaceTransaction({workspaceId,userId}, tx =>
      readPastConversationMessages(tx, {workspaceId,userId}, {conversationId:s.cid,fromSeq:"1"}));
    assert.equal(page.messages[0]?.text, oldText, "实库原文取回不能静默截断尾部纠正");
    assert.equal(page.messages[0]?.createdAt, "2026-10-03T02:03:04.000Z");
    assert.equal(page.throughSeq, "1");
    assert.equal(page.truncated, true, "整条消息分页明确还有后续消息");
    const changed = structuredClone(snapshot);
    changed.modelMessages[0]!.content = system.replace(timeline.observedAt, "2099-01-01T00:00:00.000Z");
    const retried = await persistCompanionContextHandoffSnapshot({workspaceId,userId,runId:s.runId,
      snapshot:changed,sha256:sha256Utf8V1(canonicalJsonV1(changed))});
    assert.equal(retried.sha256, row.snapshot_sha256);
    assert.equal(retried.snapshot.modelMessages[0]!.content, system);
  } finally { await s.cleanup(); }
});

/**
 * reasoning 明文随终态消息落库，并经读取与 persona 组装带回去（0435）。
 *
 * 网关在思考模式下要求交回每个"纯文本续写位" assistant 的 `reasoning_text`
 * （三发实测：带明文过、只带 encrypted_content 400、完全不带 400，见
 * `scripts/probe-plaintext-reasoning.ts`）。这条链断在任何一环，主动参与轮
 * 每一轮都会 400——而 400 恰恰是最难从"消息有没有念出来"看出来的失败。
 *
 * 三段一起钉，因为它们分别落在三处不同的代码里、且没有一层能替代另一层：
 *   写入  insertCompanionFinalAssistantMessage（终态事务）
 *   读取  readCompanionHistoryRows 的 SELECT 列表
 *   回放  buildCompanionPersonaMessages 的 messages 组装
 * 快照那一段另由 companion-context-handoff.test.ts 盯。
 */
test("reasoning 明文：终态落库 → 历史读回 → persona 组装带回", async () => {
  const scope = await seedBase();
  const run = await seedDialogueRun(scope.workspaceId, scope.userId, { userText: "帮我复习光合作用" });
  const originalChat = MockProvider.prototype.chatCompletion;
  const originalExecute = MockProvider.prototype.executeAgentTurn;
  // 真实形状：明文在 `content[].reasoning_text` 里，其余字段原样保留。
  const reasoning = [{ type: "reasoning", id: "rs-int", status: "completed",
    encrypted_content: "enc-int", summary: [],
    content: [{ type: "reasoning_text", text: "他要复习，先给一篇最常考的。" }] }];
  try {
    MockProvider.prototype.chatCompletion = async () => ({ content: JSON.stringify({ intent: "question",
      toolUse: "none", subjects: [], goalRelation: "unrelated", candidateOperations: [],
      ambiguities: [], voiceStyle: { decision: "none", instruction: null }, pendingOfferIndexes: [] }),
      usage: {} });
    MockProvider.prototype.executeAgentTurn = async () => ({
      content: "光合作用先看光反应和暗反应这两段。",
      toolCalls: [], finishReason: "stop", reasoning,
      usage: null, providerRequestId: null });

    await invokeRun(scope.workspaceId, scope.userId, run);

    // ① 写入：终态 assistant 消息必须把明文存进 reasoning 列。
    const [written] = (await readInScope(scope, tx =>
      tx`SELECT reasoning FROM companion_messages WHERE run_id=${run.runId} AND role='assistant'`)
    ) as Array<{ reasoning: unknown }>;
    assert.ok(written, "终态 assistant 消息应当已写入");
    assert.equal(Array.isArray(written!.reasoning), true, "reasoning 必须是数组而不是标量");
    const writtenItem = (written!.reasoning as Array<Record<string, unknown>>)[0]!;
    assert.equal(writtenItem.id, "rs-int");
    assert.equal(
      (writtenItem.content as Array<{ text: string }>)[0]?.text,
      "他要复习，先给一篇最常考的。",
      "明文 reasoning_text 必须原样落库——网关要的就是这句话，剥掉就凑不回来");

    // ② 读取：下一轮读历史时要能把这一列带出来。
    const rows = await withWorkerWorkspaceTransaction(scope, tx =>
      readCompanionHistoryRows(tx, run.cid, { limit: 32 }));
    const recent = companionRecentHistoryFromRows(rows);
    const trailing = [...recent].reverse().find(message => message.role === "assistant");
    assert.ok(trailing, "历史里应当读得见这条 assistant 消息");
    assert.equal(trailing!.reasoning?.[0]?.id, "rs-int",
      "readCompanionHistoryRows 的 SELECT 必须带上 reasoning 列");

    // ③ 回放：persona 组装要把 reasoning 挂到 assistant 消息上交给 provider。
    const messages = buildCompanionPersonaMessages({
      userText: "那暗反应呢？", recentMessages: recent, pageContext: null,
    });
    const replayed = [...messages].reverse().find(message => message.role === "assistant") as
      { role: string; reasoning?: unknown } | undefined;
    assert.ok(replayed, "组装后的消息里应当有这条 assistant");
    assert.equal(
      (replayed!.reasoning as Array<Record<string, unknown>> | undefined)?.[0]?.id, "rs-int",
      "buildCompanionPersonaMessages 必须把 reasoning 挂回消息——不挂，"
      + "以 assistant 收尾的主动轮就会被网关 400");
  } finally {
    MockProvider.prototype.chatCompletion = originalChat;
    MockProvider.prototype.executeAgentTurn = originalExecute;
    await run.cleanup();
  }
});

for (const mode of ["buffered", "speculative", "latest-history-read", "history-read-advisory", "host-observation"] as const) test(`unsummarized overflowing history recovers on the first answer / ${mode}`, async () => {
  const scope = await seedBase();
  const userText = "为什么天空是蓝色的？";
  const run = await seedDialogueRun(scope.workspaceId, scope.userId, { userText, initiative: mode === "host-observation" });
  const oldWindow = process.env.MOCK_CONTEXT_WINDOW_TOKENS;
  const originalExecute = MockProvider.prototype.executeAgentTurn;
  const originalChat = MockProvider.prototype.chatCompletion;
  const currentStream = Object.getOwnPropertyDescriptor(MockProvider.prototype, "chatCompletionStream")!;
  const currentStreamTools = Object.getOwnPropertyDescriptor(MockProvider.prototype, "chatCompletionStreamToolCalls");
  const oldText = "Old source, retain the final restriction.\n" + "source ".repeat(25_000) + "\nThe final restriction forbids executing old tasks.";
  const parts: string[] = [];
  const toolParts: string[] = [];
  let answerCalls = 0;
  try {
    process.env.MOCK_CONTEXT_WINDOW_TOKENS = "250000";
    await readInScope(scope, async tx => {
      await tx`SET LOCAL app.allow_history_mutation = 'on'`;
      await tx`UPDATE companion_messages SET seq=9 WHERE id=${run.userMessageId}`;
      for (const [index, text] of [oldText, "Completed older answer.", "A middle question.", "A middle answer.",
        "Another older question.", "Another complete answer.", "Latest answered question.", "Latest complete answer."].entries()) {
        const blocks = [{ type: "text", text }];
        await tx`INSERT INTO companion_messages(id,workspace_id,user_id,conversation_id,seq,role,kind,blocks,content_sha256,created_at)
          VALUES(${randomUUID()},${scope.workspaceId},${scope.userId},${run.cid},${index + 1},${index % 2 ? "assistant" : "user"},
            'text',${tx.json(blocks)},${sha256Utf8V1(canonicalJsonV1(blocks))},now()-interval '1 hour'+${index}*interval '1 second')`;
      }
      await tx`UPDATE companion_conversations SET next_message_seq=${mode === "host-observation" ? 9 : 10} WHERE id=${run.cid}`;
      if (mode !== "speculative") {
        const attention = agentTurnInterpretationV1Schema.parse({ version: 1, requestHash: sha256Utf8V1(userText), intent: "question",
          toolUse: mode === "history-read-advisory" ? "read" : "none", subjects: [], goalRelation: "unrelated", goalReference: null,
          candidateOperations: mode === "history-read-advisory" ? ["companion_recall_past_conversation", "companion_read_history"] : [],
          ambiguities: [], status: "interpreted" });
        await tx`UPDATE companion_turn_runs SET turn_interpretation=${tx.json(attention)} WHERE id=${run.runId}`;
      }
    });
    MockProvider.prototype.chatCompletion = async function(messages, options, signal) {
      if (String(messages[0]?.content).includes("将已完成的工具回合整理成")) {
        const part = JSON.parse(String(messages.at(-1)!.content));
        toolParts.push(part.sourceText);
        return { content: JSON.stringify({ facts: ["The complete historical source was read."],
          constraints: ["Do not execute old tasks."], unresolved: [], references: [run.cid, "seq:1"] }), usage: {} };
      }
      if (String(messages[0]?.content).includes("会话摘要器")) {
        parts.push(String(messages.at(-1)!.content));
        return { content: JSON.stringify({ title: "Older complete exchanges", topics: [], userGoals: [], keyEvents: ["Older answers completed."],
          userPreferences: ["Do not execute old tasks."], followUps: [], emotionalState: "neutral" }), usage: {} };
      }
      return originalChat.call(this, messages, options, signal);
    };
    const answer = mode === "host-observation" ? "我在这儿，慢慢来。" : "阳光中的蓝光更容易被空气分子散射，所以晴朗的天空呈现蓝色。";
    const accept = async (request: import("@astella/shared").AgentTurnRequest) => {
      answerCalls++;
      if (mode === "history-read-advisory") {
        assert.equal(request.toolChoice, "auto", "a narrow classifier view cannot force a redundant history read");
        assert.ok(request.tools.some(tool => tool.name === "companion_read_history"), "missing evidence can still be retrieved");
      }
      assert.match(String(request.messages[0]?.content), /compacted_conversation_history/);
      assert.equal(request.messages[1]?.content, "Latest answered question.");
      assert.equal(request.messages[2]?.content, "Latest complete answer.");
      if (mode === "host-observation") {
        assert.equal(request.messages.filter(message => message.hostObservation).length, 1, "the current occasion stays verbatim after history compaction");
        assert.ok(!request.messages.some(message => message.role === "user" && message.content === userText), "a host occasion is not a new human request");
      } else assert.ok(request.messages.some(message => message.role === "user" && message.content === userText));
      const [saved] = await withWorkerWorkspaceTransaction(scope, tx => tx.execute<{ snapshot: CompanionContextHandoffSnapshotV1 }>(
        drizzleSql`SELECT snapshot FROM companion_context_handoff_snapshots WHERE run_id=${run.runId}`));
      const [progress] = await readInScope(scope, tx => tx`SELECT compaction_checkpoint FROM companion_agent_steps
        WHERE run_id=${run.runId} AND status='running' ORDER BY step_no DESC LIMIT 1`);
      const activeSource = mode === "latest-history-read" && answerCalls > 1;
      const sourceState = progress!.compaction_checkpoint[activeSource ? "active_tool_rounds" : "history_exchanges"].state;
      assert.equal(sourceState.end, sourceState.total, "complete source scan is durable before replacement/answer generation");
      assert.equal(sourceState.sourceSha256, sha256Utf8V1((activeSource ? toolParts : parts).join("")));
      assert.ok(saved!.snapshot.compactions!.some(trace => trace.checkpoint
        && canonicalJsonV1(JSON.parse(trace.checkpoint.messagesJson)) === canonicalJsonV1(request.messages)), "complete checkpoint is durable before the answer call");
      if (mode === "latest-history-read" && answerCalls === 1) return { content: null, toolCalls: [
        { id: "huge-latest-history-read", name: "companion_read_history", arguments: { fromSeq: 1, limit: 2 } }],
        finishReason: "tool_calls", usage: {}, providerRequestId: "history-pressure-read" };
      if (mode === "latest-history-read") {
        const checkpoint = saved!.snapshot.compactions!.find(trace => trace.sourceKind === "active_tool_rounds")!.checkpoint!;
        assert.ok(checkpoint.source, "the complete original tool output is durable before answer generation");
        assert.equal(toolParts.join(""), checkpoint.source.json);
        const originalRound = JSON.parse(checkpoint.source.json) as Array<{ role: string; content: string }>;
        const originalResult = originalRound.find(message => message.role === "tool")!;
        assert.equal(JSON.parse(originalResult.content).data.messages[0].text, oldText);
        assert.ok(request.messages.some(message => message.role === "assistant" && String(message.content).includes("compacted_tool_working_state")));
      }
      return { content: answer, toolCalls: [], finishReason: "stop", usage: {}, providerRequestId: "history-pressure-fixture" };
    };
    MockProvider.prototype.executeAgentTurn = async request => accept(request);
    if (mode === "speculative") {
      Object.defineProperty(MockProvider.prototype, "chatCompletionStreamToolCalls", { configurable: true, value: true });
      Object.defineProperty(MockProvider.prototype, "chatCompletionStream", { ...mockStreamDescriptor,
        value: async (_messages: unknown, options: import("@astella/shared").ChatOptions, _signal: unknown, onDelta: (text: string) => void) => {
          const result = await accept(options.nativeAgentRequest!);
          onDelta(answer);
          return result;
        } });
    }
    await invokeRun(scope.workspaceId, scope.userId, run);
    assert.equal(answerCalls, mode === "latest-history-read" ? 2 : 1, "oversized requests are rejected before model execution");
    assert.ok(parts.length > 1, "the old message really needs multiple source requests");
    const source = JSON.parse(parts.join(""));
    assert.equal(source.conversationId, run.cid);
    assert.equal(source.messages[0].text, oldText);
    assert.deepEqual(source.messages.map((message: { seq: string }) => message.seq), ["1", "2", "3", "4", "5", "6"]);
    await readInScope(scope, async tx => {
      const [state] = await tx`SELECT status FROM companion_turn_runs WHERE id=${run.runId}`;
      assert.equal(state!.status, "succeeded");
      const [stored] = await tx`SELECT blocks FROM companion_messages WHERE conversation_id=${run.cid} AND seq=1`;
      assert.equal(stored!.blocks[0].text, oldText, "durable source was not rewritten");
      const remainingProgress = await tx`SELECT id FROM companion_agent_steps
        WHERE run_id=${run.runId} AND compaction_checkpoint IS NOT NULL`;
      assert.equal(remainingProgress.length, 0, "finished steps clear intermediate private progress");
    });
    const [checkpoint] = await withWorkerWorkspaceTransaction(scope, tx => tx.execute<{ snapshot: CompanionContextHandoffSnapshotV1 }>(
      drizzleSql`SELECT snapshot FROM companion_context_handoff_snapshots WHERE run_id=${run.runId}`));
    assert.ok(checkpoint!.snapshot.compactions!.some(item => item.sourceKind === "history_exchanges"));
  } finally {
    if (oldWindow === undefined) delete process.env.MOCK_CONTEXT_WINDOW_TOKENS; else process.env.MOCK_CONTEXT_WINDOW_TOKENS = oldWindow;
    MockProvider.prototype.executeAgentTurn = originalExecute;
    MockProvider.prototype.chatCompletion = originalChat;
    Object.defineProperty(MockProvider.prototype, "chatCompletionStream", currentStream);
    if (currentStreamTools) Object.defineProperty(MockProvider.prototype, "chatCompletionStreamToolCalls", currentStreamTools);
    else delete (MockProvider.prototype as unknown as Record<string, unknown>).chatCompletionStreamToolCalls;
    await run.cleanup();
  }
});

test("semantic source progress survives a fresh store instance and rejects stale request, owner and terminal run writes", async () => {
  const scope = await seedBase(), other = await seedBase();
  const run = await seedDialogueRun(scope.workspaceId, scope.userId, { userText: "Use the actual current request." });
  const otherRun = await seedDialogueRun(other.workspaceId, other.userId);
  const stepId = randomUUID();
  const request: AgentTurnRequest = { role: AgentRole.COMPANION_AGENT, systemPrompt: "Frozen current policy.",
    messages: [{ role: "user", content: "Use the actual current request." }], tools: [], maxTokens: 40, temperature: 0.2 };
  const event = { ctx: { id: run.jobId, payload: { runId: run.runId }, workspaceId: scope.workspaceId,
    requestedBy: scope.userId, leaseToken: "fixture-lease", signal: new AbortController().signal },
    read: { runId: run.runId, conversationId: run.cid, userId: scope.userId, generation: 1, accountEpoch: 0 } };
  const input = { event, stepId, request, provider: new MockProvider(), sourceKind: "history_exchanges" as const };
  const text = "Original task constraints.\n" + "complete source 🙂\n".repeat(60) + "Final correction: do not execute old tasks.";
  const seen: string[] = [];
  const parse = (value: unknown) => { assert.equal(typeof value, "string"); return value as string; };
  const common = { text, previous: null, inputTokens: 400, options: { maxTokens: 40 },
    counting: { countTokens: (value: string) => value.length },
    messages: (part: { text: string }, previous: string | null) => [{ role: "system" as const, content: JSON.stringify({ previous }) },
      { role: "user" as const, content: part.text }] };
  try {
    await readInScope(scope, tx => tx`INSERT INTO companion_agent_steps
      (id,workspace_id,user_id,conversation_id,run_id,step_no,kind,status,request_hash,checkpoint)
      VALUES(${stepId},${scope.workspaceId},${scope.userId},${run.cid},${run.runId},1,'model','running',
        ${sha256Utf8V1(canonicalJsonV1({ request: "fixture" }))},${tx.json({ independentModelResult: "preserve this column" })})`);
    await assert.rejects(summarizeCompleteCompanionSource({ ...common,
      checkpoint: { store: createCompanionCompactionProgressStore(input), parse },
      summarize: async (_messages, part, index) => {
        if (index === 1) throw new Error("process interrupted during the next source request");
        seen.push(part.text); return "first completed source state";
      } }), /process interrupted/);
    const [partial] = await readInScope(scope, tx => tx`SELECT status,checkpoint,compaction_checkpoint FROM companion_agent_steps WHERE id=${stepId}`);
    const state = partial!.compaction_checkpoint.history_exchanges.state as CompanionSemanticCheckpoint;
    assert.ok(state.end > 0 && state.end < text.length);
    assert.equal(state.parts, 1);
    assert.equal(partial!.status, "running", "a partial source scan is not a completed model step");
    assert.deepEqual(partial!.checkpoint, { independentModelResult: "preserve this column" });
    assert.equal(await createCompanionCompactionProgressStore({ ...input, request: { ...request, systemPrompt: "Changed policy." } }).load(), null);
    await assert.rejects(createCompanionCompactionProgressStore({ ...input,
      event: { ...event, ctx: { ...event.ctx, leaseToken: "old-owner-token" } } }).save(state), JobLeaseLostError);
    await assert.rejects(createCompanionCompactionProgressStore({ ...input,
      event: { ...event, ctx: { ...event.ctx, workspaceId: other.workspaceId, requestedBy: other.userId },
        read: { ...event.read, userId: other.userId } } }).load());
    const completed = await summarizeCompleteCompanionSource({ ...common,
      checkpoint: { store: createCompanionCompactionProgressStore(input), parse },
      summarize: async (messages, part, index) => {
        assert.equal(index, seen.length);
        assert.equal(part.start, seen.join("").length);
        if (index === 1) assert.equal(JSON.parse(String(messages[0]!.content)).previous, "first completed source state");
        seen.push(part.text); return "cumulative valid source state";
      } });
    assert.equal(seen.join(""), text, "resumption does not repeat the saved prefix or skip the unread suffix");
    assert.equal(completed.parts, seen.length);
    const finalStore = createCompanionCompactionProgressStore(input);
    const finalState = await finalStore.load() as CompanionSemanticCheckpoint;
    assert.equal(finalState.end, text.length);
    await readInScope(scope, tx => tx`UPDATE companion_turn_runs SET status='cancelled',finished_at=now() WHERE id=${run.runId}`);
    await assert.rejects(finalStore.save(finalState), CompanionContextChangedError);
    const [after] = await readInScope(scope, tx => tx`SELECT checkpoint,compaction_checkpoint FROM companion_agent_steps WHERE id=${stepId}`);
    assert.deepEqual(after!.checkpoint, partial!.checkpoint);
    assert.deepEqual(after!.compaction_checkpoint.history_exchanges.state, finalState, "a late write cannot change cancelled progress");
  } finally { await run.cleanup(); await otherRun.cleanup(); }
});

test("private compaction append merges concurrent traces, preserves frozen input, and resumes a versioned snapshot", async () => {
  const scope = await seedBase(), other = await seedBase();
  const userText = "Test checkpoint append fences.";
  const run = await seedDialogueRun(scope.workspaceId, scope.userId, { userText });
  const otherRun = await seedDialogueRun(other.workspaceId, other.userId, { userText });
  try {
    const snapshot: CompanionContextHandoffSnapshotV1 = { version: 1, runId: run.runId, conversationId: run.cid,
      watermark: { throughMessageSeq: "1", throughEventSeq: "0", historyStartSeq: "1", clippedMessageCount: 0 },
      currentRequest: { messageId: run.userMessageId, messageSeq: "1", contentSha256: sha256Utf8V1(userText) },
      authorization: { contextGrantId: null, permissionLevel: null, permissionSnapshot: null },
      runState: { status: "accepted", cancelRequestedAt: null }, pageSnapshotSha256: null, summaryCoverage: null,
      historyTail: [], actionLedger: { completed: [], unresolved: [], notCompleted: [] }, proposals: [], memoryRefs: [],
      modelMessages: [{ role: "user", content: userText }] };
    const sha256 = sha256Utf8V1(canonicalJsonV1(snapshot));
    await persistCompanionContextHandoffSnapshot({ ...scope, runId: run.runId, snapshot, sha256 });
    const trace = (id: string) => ({ sourceKind: "history_exchanges" as const, foldedFromSeq: id, foldedThroughSeq: id,
      foldedMessageCount: 1, summarySourceSha256: sha256Utf8V1(id), remainingFromSeq: "3", uncoveredBeforeSeq: null,
      modelId: "fixture", inputTokens: 400, triggerTokens: 300, hardInputTokens: 500, reason: "over_trigger_line", at: new Date().toISOString() });
    const a = trace("1"), b = trace("2");
    assert.deepEqual(await Promise.all([
      recordCompanionContextCompactions({ ...scope, runId: run.runId, snapshot, sha256, compactions: [a, a] }),
      recordCompanionContextCompactions({ ...scope, runId: run.runId, snapshot, sha256, compactions: [b] }),
    ]), [true, true]);
    const [current] = await withWorkerWorkspaceTransaction(scope, tx => tx.execute<{
      snapshot: CompanionContextHandoffSnapshotV1; snapshot_sha256: string; snapshot_version: number;
    }>(drizzleSql`SELECT snapshot,snapshot_sha256,snapshot_version FROM companion_context_handoff_snapshots WHERE run_id=${run.runId}`));
    assert.equal(current!.snapshot_version, 3);
    assert.equal(current!.snapshot.compactions!.length, 2);
    assert.deepEqual(new Set(current!.snapshot.compactions!.map(item => item.foldedFromSeq)), new Set(["1", "2"]));
    assert.deepEqual(current!.snapshot.modelMessages, snapshot.modelMessages);
    assert.equal(current!.snapshot_sha256, sha256Utf8V1(canonicalJsonV1(current!.snapshot)));
    const restored = await persistCompanionContextHandoffSnapshot({ ...scope, runId: run.runId, snapshot, sha256 });
    assert.equal(restored.sha256, current!.snapshot_sha256, "storage version greater than one remains recoverable");
    assert.deepEqual(restored.snapshot.modelMessages, snapshot.modelMessages);
    assert.equal(await recordCompanionContextCompactions({ ...scope, runId: run.runId, snapshot, sha256, compactions: [a, b] }), true);
    assert.equal(await recordCompanionContextCompactions({ ...other, runId: run.runId, snapshot, sha256, compactions: [trace("4")] }), false);
    const altered = { ...snapshot, modelMessages: [{ role: "user" as const, content: "Attempt to replace frozen input." }] };
    assert.equal(await recordCompanionContextCompactions({ ...scope, runId: run.runId, snapshot: altered,
      sha256: sha256Utf8V1(canonicalJsonV1(altered)), compactions: [trace("5")] }), false);
    const [grants] = await withWorkerWorkspaceTransaction(scope, tx => tx.execute<{ direct_update: boolean; api_execute: boolean }>(drizzleSql`
      SELECT has_table_privilege(current_user,'companion_context_handoff_snapshots','UPDATE') AS direct_update,
        has_function_privilege('astella_api','astella_append_handoff_compactions_v1(uuid,text,jsonb,text)','EXECUTE') AS api_execute`));
    assert.equal(grants!.direct_update, false);
    assert.equal(grants!.api_execute, false);
    await assert.rejects(readInScope(scope, tx => tx`SELECT public.astella_append_handoff_compactions_v1(${run.runId}::uuid,
      ${current!.snapshot_sha256},'[]'::jsonb,${sha256})`), /permission denied/);
    const [replacement] = await withWorkerWorkspaceTransaction(scope, tx => tx.execute<{ appended: boolean }>(drizzleSql`
      SELECT public.astella_append_handoff_compactions_v1(${run.runId}::uuid,${current!.snapshot_sha256},
        ${JSON.stringify([trace("6")])}::jsonb,${sha256}) AS appended`));
    assert.equal(replacement!.appended, false, "the append function refuses replacement of prior traces");
    await readInScope(scope, tx => tx`UPDATE companion_turn_runs SET status='cancelled',cancel_requested_at=now(),finished_at=now() WHERE id=${run.runId}`);
    assert.equal(await recordCompanionContextCompactions({ ...scope, runId: run.runId, snapshot, sha256, compactions: [trace("7")] }), false);
  } finally { await run.cleanup(); await otherRun.cleanup(); }
});

test("eager precommit rejects an asynchronously replaced job lease", async () => {
  const scope = await seedBase();
  const run = await seedDialogueRun(scope.workspaceId, scope.userId);
  const admin = postgres(testDatabaseUrl("DATABASE_URL_MIGRATOR"), { max: 1 });
  const { assertCompanionEagerCommitCurrent } = await import("../handlers/agent/companion-eager-dispatch-config.ts");
  const event = { ctx: { id: run.jobId, payload: { runId: run.runId }, workspaceId: scope.workspaceId,
    requestedBy: scope.userId, leaseToken: "fixture-lease", signal: new AbortController().signal },
    read: { runId: run.runId, conversationId: run.cid, userId: scope.userId, generation: 1, accountEpoch: 0 },
    expiresAt: new Date(Date.now() + 60_000).toISOString(), constraints: {} } as unknown as Parameters<typeof assertCompanionEagerCommitCurrent>[0];
  try {
    await assertCompanionEagerCommitCurrent(event);
    await admin`UPDATE jobs SET lease_token='replacement-eager-owner' WHERE id=${run.jobId}`;
    await assert.rejects(assertCompanionEagerCommitCurrent(event), /eager dispatch commit recheck/);
  } finally {
    await admin.end({ timeout: 2 });
    await run.cleanup();
  }
});

test("a cancelled, superseded or already finalized turn cannot count another interaction", async () => {
  const { finalizeCompanionDialogueTurn } = await import("../handlers/turn/companion-dialogue-finalization.ts");
  for (const runStatus of ["cancelled", "superseded", "succeeded"]) {
    const scope = await seedBase();
    const run = await seedDialogueRun(scope.workspaceId, scope.userId, { runStatus });
    try {
      // Enter the actual finalization boundary after cancellation/another owner won.
      // No model or stream is needed: publication must refuse this terminal run.
      await finalizeCompanionDialogueTurn({
        ctx: { id: run.jobId, payload: { runId: run.runId }, workspaceId: scope.workspaceId,
          requestedBy: scope.userId, leaseToken: "fixture-lease", signal: new AbortController().signal },
        read: { runId: run.runId, conversationId: run.cid, userId: scope.userId, generation: 1, accountEpoch: 0 },
        runId: run.runId, provider: { id: "mock", modelId: "mock-v1" },
        agentResult: { status: "completed", text: "Late answer", blocks: [] },
        assistantText: "Late answer", ttsRawText: "Late answer", voiceExpressionEnabled: false,
        memoryContext: { memoryRefs: [] }, voiceSegmentsWritten: false,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        streamingDelivery: { deliveredText: () => "" }, notifyCompanionEvent: async () => undefined,
      } as unknown as Parameters<typeof finalizeCompanionDialogueTurn>[0]);
      const profiles = await readInScope(scope, tx => tx`SELECT interaction_count FROM pet_profiles
        WHERE workspace_id=${scope.workspaceId} AND user_id=${scope.userId}`);
      assert.equal(profiles.length, 0, `${runStatus}: an unpublished turn must not create a relationship fact`);
      const messages = await readInScope(scope, tx => tx`SELECT id FROM companion_messages
        WHERE conversation_id=${run.cid} AND role='assistant'`);
      assert.equal(messages.length, 0);
    } finally { await run.cleanup(); }
  }
});

test("one successfully delivered turn counts exactly one interaction", async () => {
  const scope = await seedBase();
  const run = await seedDialogueRun(scope.workspaceId, scope.userId);
  try {
    await invokeRun(scope.workspaceId, scope.userId, run);
    await invokeRun(scope.workspaceId, scope.userId, run);
    const [profile] = await readInScope(scope, tx => tx`SELECT interaction_count,familiarity FROM pet_profiles
      WHERE workspace_id=${scope.workspaceId} AND user_id=${scope.userId}`);
    assert.equal(Number(profile?.interaction_count), 1);
    assert.equal(Number(profile?.familiarity), 0.01);
  } finally { await run.cleanup(); }
});
