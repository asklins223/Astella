/**
 * 材料分页续读 + 任务记忆身份收窄的真库集测（39d W6-2；39b C5/C8）。
 *
 * 读侧走**生产装载函数**（loadNoteReadPage / loadSourceReadPage——与工具同一份
 * SQL，不是复刻形状），C8 走**生产召回函数**（retrieveCompanionMemoriesKeyword，
 * embedding 关闭时它就是真实路径）。夹具用超级用户（DATABASE_URL），被测读写用
 * 受限角色（DATABASE_URL_WORKER = ailearn_worker，与伴星运行时同角色）。
 *
 * 运行（一次性库，见 scripts/dev-disposable-db.sh）：
 *   node --import tsx --test --test-concurrency=1 \
 *     src/integration-tests/companion-read-pagination-task-memory-postgres.integration.ts
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { testDatabaseUrl } from "@ailearn/shared/integration-test-db-env";

const ADMIN_URL = testDatabaseUrl("DATABASE_URL");
process.env.DATABASE_URL_WORKER ??= testDatabaseUrl("DATABASE_URL_WORKER");

const admin = postgres(ADMIN_URL, { max: 2 });

const { withWorkerWorkspaceTransaction, closeDatabase } = await import("../db.ts");
const {
  loadNoteReadPage,
  loadSourceReadPage,
  paginateReadBlocks,
} = await import("../handlers/companion-agent-runtime.ts");
const { retrieveCompanionMemoriesKeyword } = await import("../handlers/companion-memory-vector.ts");

const HASH_A = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";

const workspaceId = randomUUID();
const ownerId = randomUUID();
const peerId = randomUUID();
const otherWorkspaceId = randomUUID();

/** 每块 800 字：四块 3200 字 > 3000 的单页预算，天然两页。 */
function block(i: number): string {
  return `第 ${i} 块：${"字".repeat(780)}`;
}

const noteId = randomUUID();
const noteVersionId = randomUUID();
const peerPrivateNoteId = randomUUID();
const peerPrivateVersionId = randomUUID();
const readySourceId = randomUUID();
const failedSourceId = randomUUID();

const NOTE_BLOCKS = 4;

async function seedMemory(input: {
  id: string; content: string; scope: string;
}): Promise<void> {
  await admin`
    INSERT INTO assistant_memory_items
      (id, workspace_id, user_id, kind, content, source_event_id, user_stated, user_confirmed,
       candidate, importance, confidence, scope, source_type, embedding_status, created_at, updated_at)
    VALUES (${input.id}, ${workspaceId}, ${ownerId}, 'goal', ${input.content},
            ${`seed:${input.id}`}, false, true, false, 0.8, 0.8, ${input.scope},
            'model_inferred', 'none', now(), now())
  `;
}

after(async () => {
  await admin.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${ownerId}, true)`;
    await tx`DELETE FROM assistant_memory_items WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM memory_links WHERE workspace_id = ${workspaceId}`;
  });
  await admin`DELETE FROM sources WHERE id IN (${readySourceId}, ${failedSourceId})`;
  await admin`DELETE FROM notes WHERE id IN (${noteId}, ${peerPrivateNoteId})`;
  await admin.begin(async (tx) => {
    await tx`DELETE FROM workspaces WHERE id IN (${workspaceId}, ${otherWorkspaceId})`;
    await tx`DELETE FROM users WHERE id IN (${ownerId}, ${peerId})`;
  });
  await admin.end({ timeout: 2 });
  await closeDatabase().catch(() => undefined);
});

await admin.begin(async (tx) => {
  await tx`INSERT INTO users (id, email, password_hash, display_name)
           VALUES (${ownerId}, ${`it-${ownerId.slice(0, 8)}@example.test`}, 'x', '主人')`;
  await tx`INSERT INTO users (id, email, password_hash, display_name)
           VALUES (${peerId}, ${`it-${peerId.slice(0, 8)}@example.test`}, 'x', '同伴')`;
  await tx`INSERT INTO workspaces (id, owner_id, name) VALUES (${workspaceId}, ${ownerId}, '分页与任务记忆集测')`;
  await tx`INSERT INTO workspaces (id, owner_id, name) VALUES (${otherWorkspaceId}, ${ownerId}, '另一个空间（跨空间负对照）')`;
  await tx`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${workspaceId}, ${ownerId}, 'owner')`;
  await tx`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${workspaceId}, ${peerId}, 'member')`;

  await tx`INSERT INTO notes (id, workspace_id, title, created_by)
           VALUES (${noteId}, ${workspaceId}, '分页集测笔记', ${ownerId})`;
  await tx`INSERT INTO note_versions (id, note_id, workspace_id, version_no, content_json, content_hash, created_by)
           VALUES (${noteVersionId}, ${noteId}, ${workspaceId}, 1, '{}'::jsonb, ${HASH_A}, ${ownerId})`;
  await tx`UPDATE notes SET current_version_id = ${noteVersionId} WHERE id = ${noteId}`;
  for (let i = 1; i <= NOTE_BLOCKS; i += 1) {
    await tx`INSERT INTO note_blocks (workspace_id, version_id, ordinal, type, content)
             VALUES (${workspaceId}, ${noteVersionId}, ${i}, 'paragraph', ${block(i)})`;
  }

  // 同伴的私有笔记（归属边界负对照）。
  await tx`INSERT INTO notes (id, workspace_id, title, created_by, share_scope)
           VALUES (${peerPrivateNoteId}, ${workspaceId}, '同伴私有', ${peerId}, 'private')`;
  await tx`INSERT INTO note_versions (id, note_id, workspace_id, version_no, content_json, content_hash, created_by)
           VALUES (${peerPrivateVersionId}, ${peerPrivateNoteId}, ${workspaceId}, 1, '{}'::jsonb, ${HASH_A}, ${peerId})`;
  await tx`UPDATE notes SET current_version_id = ${peerPrivateVersionId} WHERE id = ${peerPrivateNoteId}`;

  await tx`INSERT INTO sources (id, workspace_id, type, title, status, created_by)
           VALUES (${readySourceId}, ${workspaceId}, 'text', '就绪来源', 'ready', ${ownerId})`;
  await tx`INSERT INTO source_segments (source_id, workspace_id, ordinal, text, char_start, char_end)
           VALUES (${readySourceId}, ${workspaceId}, 1, ${"来".repeat(2500)}, 0, 2500)`;
  await tx`INSERT INTO source_segments (source_id, workspace_id, ordinal, text, char_start, char_end)
           VALUES (${readySourceId}, ${workspaceId}, 2, ${"源".repeat(2500)}, 2500, 5000)`;
  await tx`INSERT INTO sources (id, workspace_id, type, title, status, created_by)
           VALUES (${failedSourceId}, ${workspaceId}, 'text', '失败来源', 'failed', ${ownerId})`;
});

test("C5 笔记分页：第一页到预算为止并给出续读指针，续读到底后 truncated=false", async () => {
  await withWorkerWorkspaceTransaction({ workspaceId, userId: ownerId }, async (tx) => {
    const page1 = await loadNoteReadPage(tx, {
      workspaceId, userId: ownerId, noteId, startOrdinal: 1, maxChars: 3_000,
    });
    assert.ok(page1);
    assert.equal(page1.versionId, noteVersionId, "版本 id 必须回传（引用时说得出读的是哪一版）");
    assert.ok(page1.page.body.length <= 3_000, `单页正文不许超预算（实到 ${page1.page.body.length}）`);
    assert.equal(page1.page.endOrdinal, 3, "整块装不下就留给下一页（不切碎第 4 块）");
    assert.ok(page1.truncated, "四块 3200 字必然还有没读完的");
    assert.ok(page1.nextStartOrdinal && page1.nextStartOrdinal > 1);

    const page2 = await loadNoteReadPage(tx, {
      workspaceId, userId: ownerId, noteId, startOrdinal: page1.nextStartOrdinal, maxChars: 3_000,
    });
    assert.ok(page2);
    assert.equal(page2.nextStartOrdinal, null, "续读后应到结尾");
    assert.equal(page2.truncated, false);
    assert.ok(page2.page.body.includes(`第 ${NOTE_BLOCKS} 块`), "最后一块要真的读到");
    // 两页拼起来不重不漏：第一页的 endOrdinal + 1 == 第二页的 startOrdinal。
  });
});

test("C5 归属边界：同伴的私有笔记，我的伴星读不到（null 而不是正文）", async () => {
  await withWorkerWorkspaceTransaction({ workspaceId, userId: ownerId }, async (tx) => {
    const result = await loadNoteReadPage(tx, {
      workspaceId, userId: ownerId, noteId: peerPrivateNoteId, startOrdinal: 1, maxChars: 3_000,
    });
    assert.equal(result, null, "私有笔记对别人的伴星必须不可见");
  });
});

test("C5 来源读取：未解析的来源照实说明；就绪来源分页；别的空间读不到", async () => {
  await withWorkerWorkspaceTransaction({ workspaceId, userId: ownerId }, async (tx) => {
    const failed = await loadSourceReadPage(tx, {
      workspaceId, sourceId: failedSourceId, startOrdinal: 1, maxChars: 3_000,
    });
    assert.ok(failed);
    assert.equal(failed.status, "failed");
    assert.equal(failed.page, null, "没解析好就不给段，不假装读过");

    const page1 = await loadSourceReadPage(tx, {
      workspaceId, sourceId: readySourceId, startOrdinal: 1, maxChars: 3_000,
    });
    assert.ok(page1?.page);
    assert.equal(page1.page.endOrdinal, 1, "两段各 2500 字，一页只装得下一段");
    assert.equal(page1.nextStartOrdinal, 2);
    assert.equal(page1.truncated, true);

    const page2 = await loadSourceReadPage(tx, {
      workspaceId, sourceId: readySourceId, startOrdinal: 2, maxChars: 3_000,
    });
    assert.ok(page2?.page);
    assert.equal(page2.truncated, false);

    const missing = await loadSourceReadPage(tx, {
      workspaceId: otherWorkspaceId, sourceId: readySourceId, startOrdinal: 1, maxChars: 3_000,
    });
    assert.equal(missing, null, "别的空间读不到这份来源");
  });
});

test("C5 分页纯函数：单块超预算时切文本并如实标记（至少给一块）", () => {
  const page = paginateReadBlocks(
    [{ ordinal: 1, content: "长".repeat(5_000) }, { ordinal: 2, content: "短" }],
    3_000,
  );
  assert.ok(page.body.length <= 3_001, `单页不超预算（实到 ${page.body.length}）`);
  assert.equal(page.blockTextTruncated, true, "块内截断必须标记");
  assert.equal(page.endOrdinal, 1, "超预算的那块是本页最后一块");
});

test("C8 任务记忆：绑定匹配才可见；别的 run / 无身份 / 跨用户都不可见", async () => {
  const runA = randomUUID();
  const runB = randomUUID();
  const workspaceMemoryId = randomUUID();
  const taskMemoryA = randomUUID();
  const taskMemoryB = randomUUID();
  await seedMemory({ id: workspaceMemoryId, content: "工作区级记忆：用户在准备考试", scope: "workspace" });
  await seedMemory({ id: taskMemoryA, content: "本轮记忆：卡在第二步排序", scope: "task" });
  await seedMemory({ id: taskMemoryB, content: "另一轮记忆：混淆了两个概念", scope: "task" });
  await admin`
    INSERT INTO memory_links (workspace_id, user_id, memory_id, entity_type, entity_id, auto_linked)
    VALUES (${workspaceId}, ${ownerId}, ${taskMemoryA}, 'learning_run', ${runA}, true)
  `;
  await admin`
    INSERT INTO memory_links (workspace_id, user_id, memory_id, entity_type, entity_id, auto_linked)
    VALUES (${workspaceId}, ${ownerId}, ${taskMemoryB}, 'learning_run', ${runB}, true)
  `;

  await withWorkerWorkspaceTransaction({ workspaceId, userId: ownerId }, async (tx) => {
    const onRunA = await retrieveCompanionMemoriesKeyword(
      tx, { workspaceId, userId: ownerId }, "记忆", 20,
      { entityType: "learning_run", entityId: runA },
    );
    const contentsA = onRunA.items.map((item) => item.content);
    assert.ok(contentsA.some((text) => text.includes("准备考试")), "workspace 记忆总是可见");
    assert.ok(contentsA.some((text) => text.includes("卡在第二步排序")), "本轮的 task 记忆可见");
    assert.ok(!contentsA.some((text) => text.includes("混淆了两个概念")), "别的 run 的 task 记忆不可见（改前的泄漏）");

    const withoutEntity = await retrieveCompanionMemoriesKeyword(
      tx, { workspaceId, userId: ownerId }, "记忆", 20, null,
    );
    const contentsNone = withoutEntity.items.map((item) => item.content);
    assert.ok(contentsNone.some((text) => text.includes("准备考试")));
    assert.ok(!contentsNone.some((text) => text.includes("卡在第二步排序")), "无身份 ⇒ task 行不可见");
    assert.ok(!contentsNone.some((text) => text.includes("混淆了两个概念")));
  });

  // 跨用户：同伴在同一个空间里，连 workspace 记忆都看不见（RLS + 谓词双重）。
  await withWorkerWorkspaceTransaction({ workspaceId, userId: peerId }, async (tx) => {
    const asPeer = await retrieveCompanionMemoriesKeyword(
      tx, { workspaceId, userId: peerId }, "记忆", 20,
      { entityType: "learning_run", entityId: runA },
    );
    assert.equal(asPeer.items.length, 0, "别人的记忆一行都不可见");
  });
});
