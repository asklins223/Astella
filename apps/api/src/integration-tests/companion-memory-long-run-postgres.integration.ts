/**
 * Isolated new-account, 80-turn memory journey. It exercises the HTTP write and
 * correction path, the worker's real keyword-recall tool, prompt assembly,
 * provenance/history, usage accounting, and user initiated derived-data purge.
 * No model/provider call is made; retrieval usefulness is asserted from the
 * returned records and not from a model grading itself.
 */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import postgres from "postgres";
import Fastify, { type FastifyInstance, type InjectOptions } from "fastify";
import sensible from "@fastify/sensible";
import { COMPANION_AGENT_TOOL_DEFINITIONS } from "@astella/shared/companion-agent-registry";

process.env.COMPANION_MEMORY_VECTOR_V1 = "true";
process.env.COMPANION_MEMORY_STAR_MAP_V1 = "true";

const CONN = process.env.DATABASE_URL_TEST_ADMIN ?? process.env.DATABASE_URL ?? process.env.DATABASE_URL_API;
if (!CONN) throw new Error("DATABASE_URL_API 未配置——长对话记忆集成测试要求隔离 Postgres");

const admin = postgres(CONN, { max: 3 });
const userId = randomUUID();
const otherUserId = randomUUID();
const workspaceId = randomUUID();
const conversationId = randomUUID();
const diaryCheckpointJobId = randomUUID();
const prefix = userId.slice(0, 8);
const messageIds: string[] = [];
const { memoryRoutes } = await import("../modules/companion-conversation/memory/memory-routes.ts");
const { issueSession, revokeSession } = await import("../modules/identity/service.ts");
const { closeDatabase: closeApiDatabase } = await import("../db/client.ts");
const { closeDatabase: closeWorkerDatabase, withWorkerWorkspaceTransaction } = await import("../../../../workers/ai-worker/src/db.ts");
const { assembleCompanionContext } = await import("../../../../workers/ai-worker/src/handlers/context/companion-context-orchestrator.ts");
const { executeCompanionMemoryTool } = await import("../../../../workers/ai-worker/src/handlers/tools/companion-memory-tools.ts");
const { buildCompanionPersonaMessages } = await import("../../../../workers/ai-worker/src/handlers/turn/companion-dialogue-content.ts");
const { getMemoryBudgetStatus } = await import("../modules/companion-conversation/memory/memory-service.ts");
const { exportCompanionDataStream } = await import("../modules/companion-conversation/turn/companion-export.ts");
const { withWorkspaceTransaction } = await import("../db/client.ts");

let app: FastifyInstance;
let token = "";

before(async () => {
  await admin`
    INSERT INTO users (id, email, password_hash, role)
    VALUES (${userId}, ${`memory-longrun-${prefix}@example.test`}, 'test-hash', 'owner')
  `;
  await admin`
    INSERT INTO users (id, email, password_hash, role)
    VALUES (${otherUserId}, ${`memory-longrun-other-${prefix}@example.test`}, 'test-hash', 'owner')
  `;
  await admin`
    INSERT INTO workspaces (id, name, owner_id, workspace_type)
    VALUES (${workspaceId}, ${`memory-longrun-${prefix}`}, ${userId}, 'collaborative')
  `;
  await admin`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${workspaceId}, ${userId}, 'owner')`;
  await admin`
    INSERT INTO companion_conversations (id, workspace_id, user_id, kind, title, title_source, status)
    VALUES (${conversationId}, ${workspaceId}, ${userId}, 'dialogue', '长对话记忆实测', 'user', 'active')
  `;
  await admin`
    INSERT INTO jobs (id, type, workspace_id, requested_by, payload, status)
    VALUES (${diaryCheckpointJobId}, 'companion_daily_summary', ${workspaceId}, ${userId}, '{}', 'pending')
  `;
  await admin`
    INSERT INTO companion_diary_generation_checkpoints
      (job_id, workspace_id, user_id, task_id, task_version, input_snapshot_hash, output)
    VALUES
      (${diaryCheckpointJobId}, ${workspaceId}, ${userId}, 'own-private-draft', 1, ${'a'.repeat(64)}, '{"private":"own"}'),
      (${diaryCheckpointJobId}, ${workspaceId}, ${otherUserId}, 'other-private-draft', 1, ${'b'.repeat(64)}, '{"private":"other"}')
  `;
  const sourceStatement = "我在学习日语时希望先给结论，再用例子解释；工作日晚上更适合短轮次复习。";
  await admin.begin(async (tx) => {
    for (let turn = 1; turn <= 80; turn += 1) {
      const userText = turn === 1
        ? sourceStatement
        : `第 ${turn} 轮：继续讨论测试主题 ${turn % 9}，补充了一条普通学习记录。`;
      for (const [offset, role, text] of [
        [0, "user", userText] as const,
        [1, "assistant", `收到第 ${turn} 轮内容，继续沿用当前学习主题。`] as const,
      ]) {
        const id = randomUUID();
        messageIds.push(id);
        const digest = createHash("sha256").update(text).digest("hex");
        await tx`
          INSERT INTO companion_messages
            (id, workspace_id, user_id, conversation_id, seq, role, kind, blocks, content_sha256)
          VALUES
            (${id}, ${workspaceId}, ${userId}, ${conversationId}, ${(turn - 1) * 2 + offset + 1},
             ${role}, 'text', ${tx.json([{ type: "text", text }])}, ${digest})
        `;
      }
    }
  });
  await admin`
    UPDATE companion_conversations SET next_message_seq = 161, last_message_at = now()
     WHERE id = ${conversationId}
  `;

  token = (await issueSession(userId, workspaceId)).token;
  app = Fastify({ logger: false });
  await app.register(sensible);
  app.setErrorHandler((error, _request, reply) => {
    const errorRecord = error as Error & { code?: string; cause?: unknown };
    const cause = errorRecord.cause as { code?: string; message?: string } | undefined;
    console.error(`[longrun API error] code=${errorRecord.code ?? "none"} causeCode=${cause?.code ?? "none"} cause=${cause?.message?.split("\n")[0] ?? "none"}`);
    return reply.code(500).send({ statusCode: 500, error: "Internal Server Error" });
  });
  await app.register(memoryRoutes);
  await app.ready();
});

after(async () => {
  await revokeSession(token).catch(() => {});
  await app?.close();
  await admin`UPDATE users SET personal_workspace_id = NULL WHERE id = ${userId}`;
  await admin`DELETE FROM companion_diary_generation_checkpoints WHERE job_id = ${diaryCheckpointJobId}`;
  await admin`DELETE FROM jobs WHERE id = ${diaryCheckpointJobId}`;
  await admin`DELETE FROM companion_self_note_versions WHERE user_id = ${userId}`;
  await admin`DELETE FROM companion_self_notes WHERE user_id = ${userId}`;
  await admin`DELETE FROM companion_procedural_playbooks WHERE user_id = ${userId}`;
  await admin`DELETE FROM companion_discovery_entries WHERE user_id = ${userId}`;
  await admin`DELETE FROM companion_daily_summaries WHERE user_id = ${userId}`;
  await admin`DELETE FROM memory_usage_log WHERE user_id = ${userId}`;
  await admin`DELETE FROM assistant_memory_item_revisions WHERE user_id = ${userId}`;
  await admin`DELETE FROM assistant_memory_items WHERE user_id = ${userId}`;
  await admin`DELETE FROM assistant_memory_source_suppressions WHERE user_id = ${userId}`;
  await admin`DELETE FROM companion_conversations WHERE id = ${conversationId}`;
  await admin`DELETE FROM workspace_members WHERE workspace_id = ${workspaceId}`;
  await admin`DELETE FROM workspaces WHERE id = ${workspaceId}`;
  await admin`DELETE FROM users WHERE id = ${userId}`;
  await admin`DELETE FROM users WHERE id = ${otherUserId}`;
  const leftovers = await admin`SELECT count(*)::int AS count FROM users WHERE id = ${userId}`;
  assert.equal(leftovers[0]?.count, 0, "长对话测试账号必须清理干净");
  await admin.end({ timeout: 5 }).catch(() => {});
  await closeApiDatabase().catch(() => {});
  await closeWorkerDatabase().catch(() => {});
});

const request = (method: "GET" | "POST" | "DELETE", url: string, payload?: Record<string, unknown>): InjectOptions => ({
  method,
  url,
  headers: { authorization: `Bearer ${token}` },
  ...(payload === undefined ? {} : { payload }),
});

async function createMemory(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await app.inject(request("POST", "/companion/memory", body));
  assert.equal(response.statusCode, 201, response.body);
  return response.json();
}

async function recall(query: string, runId = randomUUID()): Promise<{ memories: Array<Record<string, unknown>>; retrievalMode: string }> {
  const definition = COMPANION_AGENT_TOOL_DEFINITIONS.find(item => item.name === "companion_memory_read");
  assert.ok(definition);
  const controller = new AbortController();
  const event = {
    ctx: { id: randomUUID(), workspaceId, requestedBy: userId, leaseToken: "longrun-test", signal: controller.signal },
    read: {
      runId, conversationId, userId, userMessageId: null, generation: 1, pageContext: null,
      memoryRefs: [], residentMemories: [],
    },
    constraints: {},
  } as never;
  const result = await executeCompanionMemoryTool(event, definition, { query, limit: 5 });
  return result.value as { memories: Array<Record<string, unknown>>; retrievalMode: string };
}

test("新账号经过 80 轮后仍能找回早期偏好、保留纠正历史、过滤争议并报告检索用途", async () => {
  assert.equal(messageIds.length, 160, "80 轮用户/伴星消息确实落在原始对话表");
  const sourceEventId = messageIds[0];
  const preferenceText = "学习日语时先给结论，再举例；工作日晚上用短轮次。";
  const saved = await createMemory({ kind: "preference", content: preferenceText, sourceEventId });
  const preferenceId = String(saved.memoryItemId);
  assert.equal(saved.sourceEventId, sourceEventId, "记忆关联到早期原话的真实消息 ID");
  assert.ok(saved.confirmedAt, "用户明确说出的偏好带确认时间");

  const duplicate = await createMemory({ kind: "preference", content: preferenceText, sourceEventId });
  assert.equal(duplicate.memoryItemId, preferenceId, "重复整理同一句来源不会新增副本");

  const oldGoal = await createMemory({
    kind: "goal", content: "我计划在 12 月参加 JLPT N2 考试。", sourceEventId: messageIds[4],
  });
  const oldRevision = Number(oldGoal.revision);
  const corrected = await app.inject(request("POST", `/companion/memory/${oldGoal.memoryItemId}/correct`, {
    content: "我现在准备在 7 月参加 JLPT N2 考试。",
    expectedRevision: oldRevision,
    reason: "第 80 轮用户明确更正日期",
  }));
  assert.equal(corrected.statusCode, 200, corrected.body);
  assert.equal(corrected.json().revision, oldRevision + 1);

  await admin`
    INSERT INTO assistant_memory_items
      (workspace_id, user_id, kind, content, source_type, author_type, epistemic_status,
       user_stated, user_confirmed, candidate, importance, confidence, scope, embedding_status)
    SELECT ${workspaceId}, ${userId}, 'learning_context',
           '测试噪声记忆编号 ' || n::text || '：' || repeat('与当前日语问题无关的背景材料。', 4),
           'model_inferred', 'extractor', 'tentative', false, false, false, 0.15, 0.45, 'workspace', 'none'
      FROM generate_series(1, 80) AS n
  `;

  const contextRunId = randomUUID();
  const context = await withWorkerWorkspaceTransaction({ workspaceId, userId }, tx => assembleCompanionContext(
    tx,
    { workspaceId, userId },
    { runId: contextRunId, pageContext: null, playbooksDisabled: true },
  ));
  await withWorkerWorkspaceTransaction({ workspaceId, userId }, tx => assembleCompanionContext(
    tx,
    { workspaceId, userId },
    { runId: contextRunId, pageContext: null, playbooksDisabled: true },
  ));
  const residentOmittedCount = context.residentOmittedCount ?? 0;
  const directoryOmittedCount = context.directoryOmittedCount ?? 0;
  assert.ok(context.memoryDirectory.length > 0, "active 长期记忆形成可按需读取的目录");
  assert.ok(directoryOmittedCount > 0, "目录超出小预算时统计省略条数而不静默假装不存在");
  const promptMessages = buildCompanionPersonaMessages({
    userText: "请按我们之前聊过的方式继续",
    recentMessages: [],
    pageContext: null,
    residentMemories: context.residentMemories,
    memoryDirectory: context.memoryDirectory,
    memoryOmissions: {
      residentCount: residentOmittedCount,
      directoryCount: directoryOmittedCount,
    },
  });
  const assembledPrompt = promptMessages.map(message => String(message.content)).join("\n");
  assert.match(assembledPrompt, /长期记忆小预算本轮未带入 resident \d+ 条、目录 \d+ 条/);
  assert.match(assembledPrompt, /没带入不代表不存在/);

  const preferenceRecall = await recall("我之前说日语学习先给结论还是先讲语法？");
  assert.equal(preferenceRecall.retrievalMode, "keyword_fallback", "无外发授权时走可用的关键词后备");
  assert.equal(preferenceRecall.memories[0]?.memoryId, preferenceId, "80 轮后的具体提问把正确偏好排在最前");
  assert.equal(preferenceRecall.memories[0]?.epistemicStatus, "supported");

  const history = await app.inject(request("GET", `/companion/memory/${oldGoal.memoryItemId}/revisions`));
  assert.equal(history.statusCode, 200);
  assert.equal(history.json().items.length, 1);
  assert.equal(history.json().items[0].content, "我计划在 12 月参加 JLPT N2 考试。", "更正前的原值仍可审计");
  const currentGoalRecall = await recall("JLPT N2 七月考试日期");
  assert.ok(currentGoalRecall.memories.some(memory => memory.memoryId === oldGoal.memoryItemId && String(memory.content).includes("7 月")));
  assert.equal(currentGoalRecall.memories.some(memory => String(memory.content).includes("12 月")), false, "当前检索不会把旧版本当现状");

  const disputed = await createMemory({
    kind: "learning_context", content: "用户似乎住在北京，但这只是待核对推断。", sourceEventId: messageIds[8],
    userStated: false, sourceType: "model_inferred",
  });
  const disputeResult = await app.inject(request("POST", `/companion/memory/${disputed.memoryItemId}/dispute`, {
    expectedRevision: disputed.revision,
  }));
  assert.equal(disputeResult.statusCode, 200);
  assert.equal(disputeResult.json().epistemicStatus, "disputed");
  const disputedRecall = await recall("北京居住地信息");
  assert.equal(disputedRecall.memories.some(memory => memory.memoryId === disputed.memoryItemId), false,
    "用户标记争议后不能再由检索作为定论返回");

  const exportResponse = await app.inject(request("GET", "/companion/memory/export"));
  assert.equal(exportResponse.statusCode, 200);
  assert.equal(exportResponse.json().items.find((item: { memoryItemId: string }) => item.memoryItemId === preferenceId).sourceEventId, sourceEventId,
    "导出保留原始来源引用");

  const diaryId = randomUUID();
  await admin`
    INSERT INTO companion_daily_summaries
      (id, workspace_id, user_id, date, timezone, facts, summary, source_event_ids)
    VALUES (${diaryId}, ${workspaceId}, ${userId}, '2099-01-01', 'Asia/Shanghai', '{"test":true}', '测试日记', ${admin.array([sourceEventId])})
  `;
  await admin`
    INSERT INTO companion_discovery_entries
      (workspace_id, user_id, kind, source, source_id, author, body)
    VALUES (${workspaceId}, ${userId}, 'diary', 'diary', ${diaryId}, 'assistant', '测试日记关联')
  `;
  await admin`
    INSERT INTO assistant_memory_items
      (workspace_id, user_id, kind, content, source_event_id, source_type, author_type, epistemic_status,
       user_stated, user_confirmed, candidate, importance, confidence, scope, embedding_status)
    VALUES (${workspaceId}, ${userId}, 'episodic', '日记派生记忆', ${`daily-summary:${diaryId}`},
       'summary', 'extractor', 'supported', false, false, false, 0.5, 0.7, 'workspace', 'none')
  `;
  await admin`
    INSERT INTO companion_self_notes
      (workspace_id, user_id, entry_key, title, body, tier, reason)
    VALUES (${workspaceId}, ${userId}, 'longrun-note', '测试整理笔记', '一段派生内容', 'active', '长对话测试')
  `;
  await admin`
    INSERT INTO companion_procedural_playbooks
      (playbook_key, workspace_id, user_id, title, trigger_condition)
    VALUES ('longrun-method', ${workspaceId}, ${userId}, '测试方法', '遇到长对话测试时')
  `;

  const budgetBeforeClear = await withWorkspaceTransaction({ workspaceId, userId }, tx => getMemoryBudgetStatus(tx, { workspaceId, userId }));
  assert.ok(budgetBeforeClear.usage.searchRequests >= 3);
  assert.ok(budgetBeforeClear.usage.keywordSearches >= 3);
  assert.ok(budgetBeforeClear.usage.returnedMemories > 0);
  assert.ok(budgetBeforeClear.usage.directoryExposures > 0, "自动注入的目录曝光进入 30 天使用账本");
  const directoryLogRows = await admin`
    SELECT count(*)::int AS count FROM memory_usage_log
     WHERE workspace_id = ${workspaceId} AND user_id = ${userId} AND run_id = ${contextRunId} AND retrieval_mode = 'directory'
  `;
  assert.equal(directoryLogRows[0]?.count, 1, "同一轮上下文重装不会重复计数目录曝光");

  const exportLines: string[] = [];
  const fullExport = await exportCompanionDataStream({ workspaceId, userId }, line => { exportLines.push(line); });
  assert.equal(fullExport.ok, true);
  const exportRecords = exportLines.map(line => JSON.parse(line) as Record<string, unknown>);
  const footer = exportRecords.at(-1);
  assert.equal(footer?.kind, "footer");
  const exportCounts = footer?.counts as Record<string, number>;
  assert.equal(exportCounts.messages, 160, "全部导出包含 80 轮原始对话");
  assert.equal(exportCounts.memoryUsageRecords, budgetBeforeClear.usage.searchRequests + 1,
    "全部导出包括检索统计与一次目录曝光");
  assert.ok(exportRecords.some(record => record.kind === "memory_usage"));

  const clear = await app.inject(request("DELETE", "/companion/derived-data"));
  assert.equal(clear.statusCode, 200, clear.body);
  assert.equal(clear.json().deletedDiaries, 1);
  assert.equal(clear.json().deletedDiaryEntries, 1);
  assert.equal(clear.json().deletedDiaryMemories, 1);
  assert.equal(clear.json().deletedDiaryCheckpoints, 1, "只删除当前账号的私密日记检查点");
  assert.equal(clear.json().deletedSelfNotes, 1);
  assert.equal(clear.json().deletedSelfNoteVersions, 1);
  assert.equal(clear.json().deletedMethods, 1);
  assert.ok(clear.json().deletedMemoryUsageRecords >= 4);
  assert.equal((await admin`SELECT count(*)::int AS count FROM companion_diary_generation_checkpoints WHERE user_id = ${userId}`)[0]?.count, 0);
  assert.equal((await admin`SELECT count(*)::int AS count FROM companion_diary_generation_checkpoints WHERE user_id = ${otherUserId}`)[0]?.count, 1,
    "RLS 清理不会触及同空间中的其他账号检查点");
  const scrubbed = await admin`SELECT deleted_at, summary, source_event_ids FROM companion_daily_summaries WHERE id = ${diaryId}`;
  assert.ok(scrubbed[0]?.deleted_at);
  assert.equal(scrubbed[0]?.summary, "", "已清除日记正文不会在日期唯一键下复活");
  assert.deepEqual(scrubbed[0]?.source_event_ids, []);
  assert.equal((await admin`SELECT count(*)::int AS count FROM companion_self_notes WHERE user_id = ${userId}`)[0]?.count, 0);
  assert.equal((await admin`SELECT count(*)::int AS count FROM companion_procedural_playbooks WHERE user_id = ${userId}`)[0]?.count, 0);
  const budgetAfterClear = await withWorkspaceTransaction({ workspaceId, userId }, tx => getMemoryBudgetStatus(tx, { workspaceId, userId }));
  assert.equal(budgetAfterClear.usage.searchRequests, 0, "清理会一并删除派生的召回统计");
});
