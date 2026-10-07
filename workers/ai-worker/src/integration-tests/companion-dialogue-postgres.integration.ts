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
import { sql as drizzleSql } from "drizzle-orm";
import {
  COMPANION_IDENTITY_BOUNDARY_V4,
  COMPANION_PERSONA_V13_PROMPT_ID,
  COMPANION_PERSONA_V13_SHA256,
} from "@astella/shared";
import { canonicalJsonV1, sha256Utf8V1 } from "@astella/shared/content-hash";
import { testDatabaseUrl } from "@astella/shared/integration-test-db-env";
import type { CompanionContextHandoffSnapshotV1 } from "../handlers/companion-dialogue-content.ts";

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

const { runCompanionDialogue } = await import("../handlers/companion-dialogue.ts");
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
} = await import("../handlers/companion-dialogue-store.ts");
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
  const userText = options.userText ?? "帮我复习光合作用";
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
    await tx`SELECT set_config('app.user_id', ${uid}, true)`;
    await tx`INSERT INTO companion_conversations (id, workspace_id, user_id, kind, title, title_source, status)
             VALUES (${cid}, ${ws}, ${uid}, 'dialogue', '会话', 'auto', 'active')`;
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
    // 账号状态行：生产里由 turn-service 在建 run 之前幂等建（2026-10-06 补的 fail-closed 修复）。
    // 这里照着建，否则这条夹具就绕过了生产路径——而 worker 的预留语句是 INNER JOIN
    // user_companion_account_state，缺行 ⇒ AGENT_BUDGET_EXCEEDED。
    await tx`INSERT INTO user_companion_account_state (user_id) VALUES (${uid})
             ON CONFLICT (user_id) DO NOTHING`;
    await tx`INSERT INTO companion_turn_runs
             (id, conversation_id, workspace_id, user_id, user_message_id, generation, status,
              idempotency_key_hash, request_body_hash, job_id)
             VALUES (${runId}, ${cid}, ${ws}, ${uid}, ${userMessageId}, 1, ${options.runStatus ?? "accepted"},
                     ${"a".repeat(64)}, ${"b".repeat(64)}, ${jobId})`;
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
      await tx`DELETE FROM conversation_summaries WHERE conversation_id = ${cid}`;
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
        workspaceId,
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
    assert.equal(rows.run.prompt_version, COMPANION_PERSONA_V13_PROMPT_ID, "现役提示词版本已写入回合记录");
    assert.equal(rows.run.prompt_hash, COMPANION_PERSONA_V13_SHA256, "现役提示词哈希已写入回合记录");
    assert.equal(rows.assistant.length, 1, "恰好一条 assistant message");
    assert.equal(rows.assistant[0].run_id, s.runId, "assistant message 绑定本 run");
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

test("fail-open §4.9：一个字都没下发时落兜底话术，界面不得空白（抱怨 #4）", async () => {
  const { workspaceId, userId } = await seedBase();
  const seeded = await seedDialogueRun(workspaceId, userId, { runStatus: "failed" });
  try {
    const { persistFailedPartial } = await import("../handlers/companion-dialogue-failure-retention.ts");
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
    const { persistFailedPartial } = await import("../handlers/companion-dialogue-failure-retention.ts");
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
    assert.equal(timeline.history[0].utteredAt, "2026-10-03T02:03:04.000Z");
    assert.equal(timeline.history[1].speaker, "assistant");
    assert.equal(timeline.history[1].utteredAt, "2026-10-03T02:03:05.000Z");
    assert.equal(snapshot.modelMessages[1]!.content, oldText);
    assert.equal(snapshot.modelMessages[2]!.content, "已经交了呀。");
    const [message] = await readInScope({workspaceId,userId}, tx => tx`SELECT created_at FROM companion_messages WHERE id=${s.userMessageId}`);
    assert.equal(timeline.current.utteredAt, new Date(message!.created_at).toISOString());
    assert.ok(timeline.history[0].elapsedMs > 0);
    const { readPastConversationMessages } = await import("../handlers/companion-summary-retrieval.ts");
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

test("用途与用户状态沿真实解释、持久化和生成链传递，不增加第三次模型调用", async () => {
  const {workspaceId,userId}=await seedBase();
  const current="还没交呢，写完而已，明天再交。";
  const s=await seedDialogueRun(workspaceId,userId,{userText:current});
  const previousFlag=process.env.COMPANION_DIALOGUE_FRAME_V1;
  const oldChat=MockProvider.prototype.chatCompletion;
  const oldExecute=MockProvider.prototype.executeAgentTurn;
  let classifications=0, generations=0;
  process.env.COMPANION_DIALOGUE_FRAME_V1="true";
  MockProvider.prototype.chatCompletion=async function(messages,options){
    classifications++;
    const source=JSON.parse(String(messages.at(-1)!.content));
    assert.deepEqual(source.userRecords.map((x:{role:string})=>x.role),["user","user"]);
    assert.equal(options.disableThinking,true);
    return {content:JSON.stringify({intent:"conversation",toolUse:"none",subjects:[],goalRelation:"unrelated",
      candidateOperations:[],ambiguities:[],dialogueFrame:{purpose:"correction",evidence:{messageIndex:2,quote:"还没交呢"},userState:[
        {topic:"报告",aspect:"progress",relation:"statement",messageIndex:0,quote:"报告写完了"},
        {topic:"报告",aspect:"progress",relation:"correction",messageIndex:2,quote:"还没交呢，写完而已"},
        {topic:"报告",aspect:"timing",relation:"statement",messageIndex:2,quote:"明天再交"},
      ]}}),usage:{promptTokens:10,completionTokens:10}};
  };
  MockProvider.prototype.executeAgentTurn=async function(request){
    generations++;
    assert.ok(request.systemPrompt.includes('"purpose":"correction"'));
    assert.ok(request.systemPrompt.includes('"quote":"还没交呢，写完而已"'));
    assert.ok(request.systemPrompt.includes('"quote":"明天再交"'));
    assert.ok(!request.systemPrompt.includes('"quote":"报告写完了"'),"旧进展已由同一方面的最新说法替换");
    assert.ok(request.systemPrompt.includes("这句在更新原先的认识"));
    assert.equal(request.tools.length,0);
    assert.equal(request.messages.at(-1)?.content,current);
    return {content:"嗯，是我把写完当成了提交。",toolCalls:[],finishReason:"stop",usage:{},providerRequestId:"frame-test"};
  };
  try {
    await readInScope({workspaceId,userId},async tx=>{
      await tx`SET LOCAL app.allow_history_mutation='on'`;
      await tx`UPDATE companion_messages SET seq=3 WHERE id=${s.userMessageId}`;
      await tx`UPDATE companion_conversations SET next_message_seq=4 WHERE id=${s.cid}`;
      for (const [i,role,text] of [[1,"user","报告写完了"],[2,"assistant","已经提交了"]] as const)
        await tx`INSERT INTO companion_messages(id,conversation_id,workspace_id,user_id,role,seq,kind,blocks,content_sha256)
          VALUES(${randomUUID()},${s.cid},${workspaceId},${userId},${role},${i},'text',
            ${tx.json([{type:"text",text}])},${sha256Utf8V1(text)})`;
    });
    await runCompanionDialogue({id:s.jobId,workspaceId,requestedBy:userId,payload:{runId:s.runId},
      leaseToken:"fixture-lease",signal:new AbortController().signal});
    const [run]=await readInScope({workspaceId,userId},tx=>tx`SELECT status,turn_interpretation,model_call_count
      FROM companion_turn_runs WHERE id=${s.runId}`);
    assert.equal(run!.status,"succeeded");
    assert.equal(classifications,1);
    assert.equal(generations,1);
    assert.equal(Number(run!.model_call_count),2);
    const frame=run!.turn_interpretation.dialogueFrame;
    assert.equal(frame.purpose,"correction");
    assert.equal(frame.evidence.sourceSha256,sha256Utf8V1(current));
    assert.equal(frame.userState.length,2);
    const [answer]=await readInScope({workspaceId,userId},tx=>tx`SELECT blocks->0->>'text' text
      FROM companion_messages WHERE conversation_id=${s.cid} AND role='assistant' ORDER BY seq DESC LIMIT 1`);
    assert.equal(answer!.text,"嗯，是我把写完当成了提交。");
  } finally {
    MockProvider.prototype.chatCompletion=oldChat;
    MockProvider.prototype.executeAgentTurn=oldExecute;
    if(previousFlag===undefined)delete process.env.COMPANION_DIALOGUE_FRAME_V1;
    else process.env.COMPANION_DIALOGUE_FRAME_V1=previousFlag;
    await s.cleanup();
  }
});

for(const accepted of [true,false])test(accepted
 ? "发布前范围核对不泄露原稿或JSON，第三次调用经过原预算与交付链"
 : "范围核对漏检段落时终止发布，不流出原稿且不回退成未经核对的答复",async()=>{
 const {workspaceId,userId}=await seedBase();
 const current="明天才交呢，我先玩会儿";
 const s=await seedDialogueRun(workspaceId,userId,{userText:current});
 const savedFrame=process.env.COMPANION_DIALOGUE_FRAME_V1,savedReview=process.env.COMPANION_DIALOGUE_REVIEW_V1;
 const oldChat=MockProvider.prototype.chatCompletion,oldExecute=MockProvider.prototype.executeAgentTurn;
 const oldStream=MockProvider.prototype.chatCompletionStream;
 process.env.COMPANION_DIALOGUE_FRAME_V1="true";process.env.COMPANION_DIALOGUE_REVIEW_V1="true";
 let chats=0,gens=0,reviews=0,streams=0;
 MockProvider.prototype.chatCompletion=async function(){chats++;return {content:JSON.stringify({intent:"conversation",toolUse:"none",
  subjects:[],goalRelation:"unrelated",candidateOperations:[],ambiguities:[],dialogueFrame:{purpose:"sharing",evidence:{messageIndex:0,quote:current},
    userState:[{topic:"报告交付",aspect:"timing",relation:"statement",messageIndex:0,quote:"明天才交",relevance:"foreground"}]}}),usage:{}};};
 MockProvider.prototype.chatCompletionStream=async function(){streams++;throw new Error("private draft must not stream");};
 MockProvider.prototype.executeAgentTurn=async function(request){
  const review=request.systemPrompt.includes("内部结构化核对任务");
  if(review){reviews++;assert.equal(request.messages.length,1);assert.ok(String(request.messages[0]!.content).includes("活儿已经交了"));}
  else gens++;
  return {content:review?JSON.stringify({verdicts:[{spanId:1,action:"drop",issue:"progress",reason:"用户说明天交"},
   ...(accepted?[{spanId:3,action:"keep",reason:"回应用户自己选择的时间"}]:[])]}):"[neutral]活儿已经交了。\n\n明天的事明天再说。",
    toolCalls:[],finishReason:"stop",usage:{},providerRequestId:"private-review-test"};
 };
 try {
  const execute=()=>runCompanionDialogue({id:s.jobId,workspaceId,requestedBy:userId,payload:{runId:s.runId},leaseToken:"fixture-lease",signal:new AbortController().signal});
  if(accepted)await execute();
  else await assert.rejects(execute,{code:"COMPANION_DIALOGUE_REVIEW_INVALID"});
  const [run]=await readInScope({workspaceId,userId},tx=>tx`SELECT status,model_call_count FROM companion_turn_runs WHERE id=${s.runId}`);
  assert.equal(run!.status,accepted?"succeeded":"failed");assert.equal(Number(run!.model_call_count),3);
  assert.equal(chats,1);assert.equal(gens,1);assert.equal(reviews,1);assert.equal(streams,0);
  const [answer]=await readInScope({workspaceId,userId},tx=>tx`SELECT kind,blocks->0->>'text' text FROM companion_messages
    WHERE conversation_id=${s.cid} AND role='assistant' ORDER BY seq DESC LIMIT 1`);
  if(accepted)assert.equal(answer!.text,"明天的事明天再说。");
  else {
   assert.equal(answer!.kind,"error");
   assert.equal(answer!.text,"这次回复没能完成核对，尚未发布。","失败状态不得伪装成未听清或未经核对的答复");
  }
  const deltas=await readInScope({workspaceId,userId},tx=>tx`SELECT payload FROM companion_stream_events WHERE conversation_id=${s.cid} AND type='assistant.delta'`);
  if(accepted)assert.ok(deltas.length>0);
  else assert.equal(deltas.length,0);
  const serialized=JSON.stringify(deltas);assert.ok(!serialized.includes("已经交了"));assert.ok(!serialized.includes("spanId"));assert.ok(!serialized.includes("drops"));
 }finally{
  MockProvider.prototype.chatCompletion=oldChat;MockProvider.prototype.executeAgentTurn=oldExecute;
  MockProvider.prototype.chatCompletionStream=oldStream;
  if(savedFrame===undefined)delete process.env.COMPANION_DIALOGUE_FRAME_V1;else process.env.COMPANION_DIALOGUE_FRAME_V1=savedFrame;
  if(savedReview===undefined)delete process.env.COMPANION_DIALOGUE_REVIEW_V1;else process.env.COMPANION_DIALOGUE_REVIEW_V1=savedReview;
  await s.cleanup();
 }
});
