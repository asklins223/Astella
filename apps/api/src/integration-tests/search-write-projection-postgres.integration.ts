/** 请求写入后即可搜索，无需手动重建；使用受限 API 连接验证公开投影和资料改名。 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { and, eq } from "drizzle-orm";
import { testDatabaseUrl } from "@ailearn/shared/integration-test-db-env";
import { searchDocuments } from "@ailearn/shared/db-schema/search";
import { seedV2Fixture, seedObjectiveNoteEvidence } from "./helpers/v2-card-fixture.ts";

const admin = postgres(testDatabaseUrl("DATABASE_URL_TEST_ADMIN"), { max: 1 });
const fixture = await seedV2Fixture(admin, { publicSummary: "公开的循环不变量说明" });
await seedObjectiveNoteEvidence(admin, fixture, { withEvidence: false });
const { withWorkspaceTransaction, closeDatabase } = await import("../db/client.ts");
const { refreshObjectiveSearchProjections } = await import("../modules/learning-objectives/search-projection.ts");
const { updateSource } = await import("../modules/source/service.ts");
const { setNoteShareScope, checkpointNote } = await import("../modules/note/service.ts");
const { search } = await import("../modules/search/service.ts");
const scope = { workspaceId: fixture.workspaceId, userId: fixture.userId };
after(async () => {
  try {
    await admin`DELETE FROM sources WHERE workspace_id = ${fixture.workspaceId}`;
    await fixture.cleanup();
  } finally {
    await closeDatabase();
    await admin.end({ timeout: 2 });
  }
});

test("新目标立即进入索引，重复刷新只留一份，私有来源和答案不进入公开正文", async () => {
  await admin`UPDATE notes SET title = '私有标题不应泄漏', share_scope = 'private', current_version_id = ${fixture.noteVersionId} WHERE id = ${fixture.noteId}`;
  await admin`INSERT INTO note_blocks (version_id,workspace_id,ordinal,type,content) VALUES (${fixture.noteVersionId},${scope.workspaceId},0,'paragraph','学习原文')`;
  await withWorkspaceTransaction(scope, (tx) => refreshObjectiveSearchProjections(tx, scope.workspaceId, [fixture.objectiveId, fixture.objectiveId]));
  const rows = await withWorkspaceTransaction(scope, (tx) => tx.select().from(searchDocuments).where(and(
    eq(searchDocuments.workspaceId, scope.workspaceId), eq(searchDocuments.objectType, "objective"), eq(searchDocuments.objectId, fixture.objectiveId),
  )));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].body, "公开的循环不变量说明");
  assert.doesNotMatch(JSON.stringify(rows), /私有标题不应泄漏|本金产生利息|canonicalAnswer|scoringRubric/);
  await withWorkspaceTransaction(scope, (tx) => refreshObjectiveSearchProjections(tx, scope.workspaceId, [fixture.objectiveId]));
  const count = await admin`SELECT count(*)::int AS n FROM search_documents WHERE workspace_id = ${scope.workspaceId} AND object_id = ${fixture.objectiveId}`;
  assert.equal(count[0].n, 1);
  await withWorkspaceTransaction(scope, (tx) => setNoteShareScope(tx, fixture.noteId, scope.workspaceId, scope.userId, "shared"));
  const publicRows = await admin`SELECT body FROM search_documents WHERE object_id = ${fixture.objectiveId}`;
  assert.match(publicRows[0].body, /私有标题不应泄漏/);
  const [note] = await admin`SELECT current_version_id FROM notes WHERE id = ${fixture.noteId}`;
  const saved = await withWorkspaceTransaction(scope, (tx) => checkpointNote(tx, fixture.noteId, scope.workspaceId, scope.userId, {
    baseVersionId: note.current_version_id, title: "公开笔记的新标题",
  }));
  assert.ok(saved);
  const renamedRows = await admin`SELECT body FROM search_documents WHERE object_id = ${fixture.objectiveId}`;
  assert.match(renamedRows[0].body, /公开笔记的新标题/);
  assert.doesNotMatch(renamedRows[0].body, /私有标题不应泄漏/);
  await withWorkspaceTransaction(scope, (tx) => setNoteShareScope(tx, fixture.noteId, scope.workspaceId, scope.userId, "private"));
  const privateRows = await admin`SELECT body FROM search_documents WHERE object_id = ${fixture.objectiveId}`;
  assert.equal(privateRows[0].body, "公开的循环不变量说明");
});

test("资料改名同步更新索引，保留片段正文，归档后改名不复活搜索结果", async () => {
  const sourceId = randomUUID();
  await admin`INSERT INTO sources (id,workspace_id,title,type,status,origin,created_by,metadata)
    VALUES (${sourceId},${scope.workspaceId},'旧标题','text','ready','text',${scope.userId},'{}'::jsonb)`;
  await admin`INSERT INTO source_segments (id,source_id,workspace_id,ordinal,text,char_start,char_end)
    VALUES (${randomUUID()},${sourceId},${scope.workspaceId},0,'资料片段正文',0,6)`;
  await withWorkspaceTransaction(scope, (tx) => updateSource(tx, sourceId, scope.workspaceId, { title: "更新后的资料标题" }));
  const rows = await admin`SELECT title, body FROM search_documents WHERE workspace_id = ${scope.workspaceId} AND object_id = ${sourceId}`;
  assert.deepEqual(rows.map(row => ({ ...row })), [{ title: "更新后的资料标题", body: "资料片段正文" }]);
  await admin`UPDATE sources SET status = 'archived' WHERE id = ${sourceId}`;
  await admin`DELETE FROM search_documents WHERE object_id = ${sourceId}`;
  await withWorkspaceTransaction(scope, (tx) => updateSource(tx, sourceId, scope.workspaceId, { title: "归档后的标题" }));
  const count = await admin`SELECT count(*)::int AS n FROM search_documents WHERE object_id = ${sourceId}`;
  assert.equal(count[0].n, 0);
});

test("无卡目标的搜索也跟随私有笔记权限，共享撤回后成员不能继续读取", async () => {
  const memberId = randomUUID();
  try {
    await admin`INSERT INTO users (id,email,password_hash,role) VALUES (${memberId},${`qa-search-${memberId}@example.test`},'h','owner')`;
    await admin`INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (${scope.workspaceId},${memberId},'member')`;
    await admin`DELETE FROM learning_cards_v2 WHERE card_id = ${fixture.cardId}`;
    const read = (userId: string) => withWorkspaceTransaction({ workspaceId: scope.workspaceId, userId }, tx =>
      search(tx, scope.workspaceId, "公开的循环不变量说明", { userId, type: "objective" }));
    assert.equal((await read(scope.userId)).items.length, 1);
    assert.equal((await read(memberId)).items.length, 0, "无卡不能被误判为没有私有笔记来源");
    await withWorkspaceTransaction(scope, tx => setNoteShareScope(tx, fixture.noteId, scope.workspaceId, scope.userId, "shared"));
    assert.equal((await read(memberId)).items.length, 1);
    await withWorkspaceTransaction(scope, tx => setNoteShareScope(tx, fixture.noteId, scope.workspaceId, scope.userId, "private"));
    assert.equal((await read(memberId)).items.length, 0);
  } finally {
    await admin`DELETE FROM workspace_members WHERE workspace_id = ${scope.workspaceId} AND user_id = ${memberId}`;
    await admin`DELETE FROM users WHERE id = ${memberId}`;
  }
});
