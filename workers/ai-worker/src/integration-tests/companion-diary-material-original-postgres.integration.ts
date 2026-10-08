import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import postgres from "postgres";
import { testDatabaseUrl } from "@astella/shared/integration-test-db-env";
import { withWorkerWorkspaceTransaction, closeDatabase } from "../db.ts";
import { collectDiaryMaterial } from "../handlers/companion-daily-summary.ts";
import { buildDiaryCandidates, buildDiarySelectionMessages } from "../handlers/companion-diary-candidates.ts";

const fixtureDb = postgres(testDatabaseUrl("DATABASE_URL_API"), { max: 2 });
after(async () => { await fixtureDb.end({ timeout: 2 }); await closeDatabase(); });

test("日记从受限数据库读取完整对话、记忆和标题，后半段更正进入选材提示", async () => {
  const scope = { workspaceId: randomUUID(), userId: randomUUID() };
  const conversationId = randomUUID(), userMessageId = randomUUID(), assistantMessageId = randomUUID();
  const memoryId = randomUUID(), noteId = randomUUID();
  const userText = "整理报告的过程。".repeat(35) + "最后更正：只是初稿，没有提交。";
  const assistantText = "核对记录与来源。".repeat(35) + "最后确认：我没有替你提交报告。";
  const memoryText = "旧的学习偏好。".repeat(35) + "最后更正：旧偏好已撤销。";
  const title = "长笔记标题".repeat(20) + "末尾限定：初稿";
  const mutate = <T>(fn: (tx: postgres.TransactionSql) => Promise<T>) => fixtureDb.begin(async tx => {
    await tx`SELECT set_config('app.workspace_id',${scope.workspaceId},true), set_config('app.user_id',${scope.userId},true)`;
    return fn(tx);
  });
  try {
    await mutate(async tx => {
      await tx`INSERT INTO users(id,email,password_hash,role) VALUES(${scope.userId},${`diary-original-${scope.userId}@test.invalid`},'fixture','owner')`;
      await tx`INSERT INTO workspaces(id,name,owner_id) VALUES(${scope.workspaceId},'日记原文测试',${scope.userId})`;
      await tx`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES(${scope.workspaceId},${scope.userId},'owner')`;
      await tx`INSERT INTO notes(id,workspace_id,title,created_by,created_at,updated_at)
        VALUES(${noteId},${scope.workspaceId},${title},${scope.userId},'2026-10-08T10:00:00+08:00','2026-10-08T10:00:00+08:00')`;
      await tx`INSERT INTO companion_conversations(id,workspace_id,user_id,kind,title,title_source,status)
        VALUES(${conversationId},${scope.workspaceId},${scope.userId},'dialogue','原文验收','system','active')`;
      for (const [id,role,seq,text] of [[userMessageId,'user',1,userText],[assistantMessageId,'assistant',2,assistantText]] as const)
        await tx`INSERT INTO companion_messages(id,workspace_id,user_id,conversation_id,role,seq,kind,blocks,content_sha256,created_at)
          VALUES(${id},${scope.workspaceId},${scope.userId},${conversationId},${role},${seq},'text',${tx.json([{type:'text',text}])},${'0'.repeat(64)},'2026-10-08T10:05:00+08:00')`;
      await tx`INSERT INTO assistant_memory_items(id,workspace_id,user_id,kind,content,created_at)
        VALUES(${memoryId},${scope.workspaceId},${scope.userId},'episodic',${memoryText},'2026-10-08T10:10:00+08:00')`;
    });
    const material = await withWorkerWorkspaceTransaction(scope, tx => collectDiaryMaterial(tx, {
      ...scope, date: "2026-10-08", timezone: "Asia/Shanghai", diaryEnabledSince: new Date("2026-10-08T00:00:00+08:00"),
    }));
    for (const [id,text] of [[userMessageId,userText],[assistantMessageId,assistantText],[memoryId,memoryText],[noteId,title]])
      assert.ok(material.pieces.find(piece => piece.sourceId === id)?.text.includes(text!), `来源 ${id} 的末尾不能提前裁掉`);
    const candidates = buildDiaryCandidates(material);
    const prompt = JSON.stringify(buildDiarySelectionMessages("2026-10-08", candidates));
    assert.ok(prompt.includes(userText));
    assert.ok(prompt.includes(assistantText));
    const otherUserId = randomUUID();
    const otherUser = await withWorkerWorkspaceTransaction({ ...scope, userId: otherUserId }, tx => collectDiaryMaterial(tx, {
      ...scope, userId: otherUserId, date: "2026-10-08", timezone: "Asia/Shanghai", diaryEnabledSince: new Date(0),
    }));
    assert.deepEqual(otherUser.pieces.filter(piece => piece.sourceId), []);
  } finally {
    await mutate(async tx => {
      await tx`DELETE FROM assistant_memory_items WHERE workspace_id=${scope.workspaceId}`;
      await tx`DELETE FROM companion_messages WHERE conversation_id=${conversationId}`;
      await tx`DELETE FROM companion_conversations WHERE id=${conversationId}`;
      await tx`DELETE FROM notes WHERE id=${noteId}`;
      await tx`DELETE FROM workspace_members WHERE workspace_id=${scope.workspaceId}`;
      await tx`DELETE FROM workspaces WHERE id=${scope.workspaceId}`;
      await tx`DELETE FROM users WHERE id=${scope.userId}`;
    });
  }
});
