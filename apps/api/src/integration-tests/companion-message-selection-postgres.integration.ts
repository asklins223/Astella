import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { testDatabaseUrl } from "@ailearn/shared/integration-test-db-env";
import { companionMessageV1Schema } from "@ailearn/shared/companion-conversation-contracts";
import { companionHistoryPageV1Schema, companionHistorySearchV1Schema } from "@ailearn/shared/companion-memory-desktop-contracts";
import { listCompanionMessages } from "../modules/companion-conversation/turn/companion-conversations-service.ts";
import { listContinuousHistory, searchContinuousHistory } from "../modules/companion-conversation/memory/continuous-history-service.ts";
import { closeDatabase } from "../db/client.ts";

process.env.AUTH_SURFACE_MANIFEST_SECRET ??= "message-selection-integration-secret";
const connection = postgres(testDatabaseUrl("DATABASE_URL_API"), { max: 2 });

after(async () => {
  await closeDatabase();
  await connection.end({ timeout: 2 });
});

test("手记重读：从旧 run 恢复原文，普通消息/助手不串引用，分页和搜索保留同一快照", async () => {
  const scope = { workspaceId: randomUUID(), userId: randomUUID() };
  const conversationId = randomUUID();
  const messageIds = Array.from({ length: 4 }, () => randomUUID());
  const selection = { text: "第二段：间隔重复把复习排在快忘还没忘的时刻。", sharing: "user_selected" as const };
  const question = "请用通俗易懂的话解释这段。";
  const scoped = <T>(operation: (tx: postgres.TransactionSql) => Promise<T>) => connection.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${scope.workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${scope.userId}, true)`;
    return operation(tx);
  });
  try {
    await scoped(async (tx) => {
      await tx`INSERT INTO users (id, email, password_hash, role)
        VALUES (${scope.userId}, ${`selection-${scope.userId}@test.invalid`}, 'fixture', 'owner')`;
      await tx`INSERT INTO workspaces (id, name, owner_id) VALUES (${scope.workspaceId}, '手记选文测试', ${scope.userId})`;
      await tx`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${scope.workspaceId}, ${scope.userId}, 'owner')`;
      await tx`INSERT INTO companion_conversations (id, workspace_id, user_id, kind, title, title_source, status)
        VALUES (${conversationId}, ${scope.workspaceId}, ${scope.userId}, 'inbox', '手记', 'system', 'active')`;
      for (const [index, id] of messageIds.entries()) {
        await tx`INSERT INTO companion_messages (id, workspace_id, user_id, conversation_id, seq, role, kind, blocks, content_sha256, created_at)
          VALUES (${id}, ${scope.workspaceId}, ${scope.userId}, ${conversationId}, ${index + 1}, ${index % 2 ? 'assistant' : 'user'}, 'text',
                  ${tx.json([{ type: 'text', text: index % 2 ? '讲解的正文' : question }])}, ${'0'.repeat(64)}, ${`2026-10-02T10:${38 + index}:00Z`})`;
      }
      // 与修复前相同：消息只有提问；选文仅存在 run.page_context，不靠写回或回填。
      await tx`INSERT INTO companion_turn_runs (id, workspace_id, user_id, conversation_id, user_message_id, assistant_message_id, generation, status, idempotency_key_hash, request_body_hash, page_context)
        VALUES (${randomUUID()}, ${scope.workspaceId}, ${scope.userId}, ${conversationId}, ${messageIds[0]}, ${messageIds[1]}, 1, 'succeeded',
                ${'1'.repeat(64)}, ${'2'.repeat(64)}, ${tx.json({ version: 1, selection, privateContext: '不能出现在历史响应中' })})`;
      // 旧/损坏数据不可冒充已授权选文。
      await tx`INSERT INTO companion_turn_runs (id, workspace_id, user_id, conversation_id, user_message_id, assistant_message_id, generation, status, idempotency_key_hash, request_body_hash, page_context)
        VALUES (${randomUUID()}, ${scope.workspaceId}, ${scope.userId}, ${conversationId}, ${messageIds[2]}, ${messageIds[3]}, 2, 'succeeded',
                ${'3'.repeat(64)}, ${'4'.repeat(64)}, ${tx.json({ version: 1, selection: { text: '未授权的原文', sharing: 'page_registered' } })})`;
    });

    const recent = await listCompanionMessages({ ...scope, conversationId, limit: 2, beforeSeq: null });
    assert.equal(recent.body.hasMore, true);
    assert.deepEqual(recent.body.items.map((item) => item.id), messageIds.slice(2));
    assert.ok(recent.body.items.every((item) => item.selection === undefined));
    const older = await listCompanionMessages({ ...scope, conversationId, limit: 2, beforeSeq: recent.body.oldestSeq });
    const parsedMessages = older.body.items.map((item) => companionMessageV1Schema.parse(item));
    assert.deepEqual(parsedMessages[0].selection, selection);
    assert.equal(parsedMessages[1].selection, undefined);
    assert.deepEqual(parsedMessages[0].blocks, [{ type: 'text', text: question }]);
    assert.equal(parsedMessages[0].contentSha256, '0'.repeat(64));

    const first = await listContinuousHistory({ ...scope, limit: 2 });
    assert.equal(first.invalidCursor, false);
    assert.ok(first.value?.nextCursor);
    const next = await listContinuousHistory({ ...scope, limit: 2, before: first.value!.nextCursor! });
    const history = companionHistoryPageV1Schema.parse(next.value);
    assert.deepEqual(history.items.map((item) => item.messageId), messageIds.slice(0, 2));
    assert.deepEqual(history.items[0].selection, selection);
    assert.equal(history.items[1].selection, undefined);
    assert.equal(history.nextCursor, null);

    const searched = companionHistorySearchV1Schema.parse(await searchContinuousHistory({ ...scope, query: question, limit: 10 }));
    assert.equal(searched.items.length, 2);
    assert.deepEqual(searched.items.find((item) => item.messageId === messageIds[0])?.selection, selection);
    assert.equal(searched.items.find((item) => item.messageId === messageIds[2])?.selection, undefined);
    assert.ok(!JSON.stringify(searched).includes('privateContext'));
    const otherUser = await listContinuousHistory({ ...scope, userId: randomUUID(), limit: 100 });
    assert.deepEqual(otherUser.value?.items, []);
  } finally {
    await scoped(async (tx) => {
      await tx`DELETE FROM companion_turn_runs WHERE conversation_id = ${conversationId}`;
      await tx`DELETE FROM companion_messages WHERE conversation_id = ${conversationId}`;
      await tx`DELETE FROM companion_conversations WHERE id = ${conversationId}`;
      await tx`DELETE FROM workspace_members WHERE workspace_id = ${scope.workspaceId}`;
      await tx`DELETE FROM workspaces WHERE id = ${scope.workspaceId}`;
      await tx`DELETE FROM users WHERE id = ${scope.userId}`;
    });
  }
});
