/**
 * 39d · D3 §3 第 2 层——"稳定锚点仍指向同一段"今天是怎么失效的。
 *
 * **症状**：卡片证据预览对每一次**显式保存**（`checkpointNote` 开新版本）都回答"落点还在、
 * 文字没变"，哪怕用户正把那句话改了。自动保存那条路是好的（就地改写当前版本的行）。
 *
 * **成因**（读代码确认，不是猜）：`note_blocks.id` 不是跨版本稳定的。`checkpointNote` 先建
 * 新版本行，再让 `projectBlocksIntoVersion` 按 ordinal 把文档投影进**那个新版本**
 * （`note/service.ts:647` → `document-state.ts:419`：`existing` 按 `version_id` 查，新版本
 * 一行都没有 ⇒ 每个块都走 `toInsert`，拿到新 uuid，`note.ts:170` `defaultRandom()`）。
 * 密封时存下的 `block_id` 从此永远指向旧版本那一行，而旧行不会被后来的编辑改写。
 * ⇒ 读侧 `WHERE id = block_id` 拿到的**永远是当初的文字**，哈希自然对得上。
 *
 * **这条不是"预览显示错了字"**：显示的还是当初那一段。错的是它**声称**这一轮的依据还在原处，
 * 于是 D3 §13.3 要的那句"这一处条件更新了，先核对这里"在任何屏上都发不出来。
 *
 * 三份重算同一对哈希的读点（`evidence-preview.ts`、`run-critic.ts:447`、
 * `companion-grounded-evidence.ts:25`）都按块 id 取正文，三道都有这同一个瞎点。这一刀只修
 * **有人读的那一道**（卡片预览＝`GET /v2/cards` 与 reveal 的 `sourceState` 三档，界面已经在
 * 分档显示）；另两处一改就会让旧卡在新版本上抛错、改变运行结局，单独登记不顺手做。
 *
 * 跑法（真库，夹具走 `DATABASE_URL`，被测路径走 `withWorkspaceTransaction`）：
 * `node --import tsx --test --test-concurrency=1 src/integration-tests/evidence-anchor-version-drift-postgres.integration.ts`
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";

const ADMIN = process.env.DATABASE_URL;
if (!ADMIN) throw new Error("需要 DATABASE_URL（夹具要建 user/workspace/note 全链）");
const sql = postgres(ADMIN, { max: 2 });

const { withWorkspaceTransaction } = await import("../db/client.ts");
const { sealEvidenceSnapshotsV2 } = await import("@astella/card-generation");
const { loadEvidencePreviewItems } = await import(
  "../modules/card-generation-v2/evidence-preview.ts"
);
const { projectBlocksIntoVersion } = await import("../modules/note/document-state.ts");

const workspaceId = randomUUID();
const userId = randomUUID();
const noteId = randomUUID();
const versionOneId = randomUUID();
const sourceSnapshotId = randomUUID();
const runId = randomUUID();
const blockOneId = randomUUID();
const blockTwoId = randomUUID();

/** 锚点①（ordinal 1）当初那段。 */
const QUOTED = "间隔重复的关键是在快要忘记的时候复习，而不是在记得的时候。";
/** 同一篇里**没被引用**的那一段——它变了也不该牵连锚点①。 */
const UNQUOTED = "另一段与这条主张无关的记录：昨天读了二十分钟。";

/** `source_snapshot_id` 一次密封的一批；用例靠它把快照与块对上号。 */
async function snapshotIdByBlock(): Promise<Map<string, string>> {
  const rows = await sql`
    SELECT evidence_snapshot_id, block_id FROM evidence_snapshots_v2
    WHERE workspace_id = ${workspaceId} AND source_snapshot_id = ${sourceSnapshotId}
  `;
  return new Map(rows.map((r) => [String(r.block_id), String(r.evidence_snapshot_id)]));
}

/** 把当前版本指针挪到新版本的某一版，并按 ordinal 投影给定的块。 */
async function reVersion(blocks: Array<{ ordinal: number; content: string }>): Promise<string> {
  const [latest] = await sql`
    SELECT version_no FROM note_versions WHERE note_id = ${noteId}
    ORDER BY version_no DESC LIMIT 1
  `;
  const nextVersionId = randomUUID();
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    await tx`INSERT INTO note_versions (id, note_id, workspace_id, version_no, content_json, content_hash, created_by)
      VALUES (${nextVersionId}, ${noteId}, ${workspaceId}, ${Number(latest.version_no) + 1},
        ${tx.json({ blocks: blocks.map((b) => ({ type: "paragraph", content: b.content })) })},
        'fixture-hash', ${userId})`;
    await tx`UPDATE notes SET current_version_id = ${nextVersionId} WHERE id = ${noteId}`;
  });
  await withWorkspaceTransaction({ workspaceId, userId }, (tx) =>
    projectBlocksIntoVersion(tx, workspaceId, nextVersionId, blocks.map((b) => ({
      ordinal: b.ordinal,
      type: "paragraph",
      content: b.content,
    }))));
  return nextVersionId;
}

before(async () => {
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    await tx`INSERT INTO users (id, email, password_hash, role)
      VALUES (${userId}, ${`anchor-drift-${workspaceId.slice(0, 8)}@example.test`}, 'h', 'owner')`;
    await tx`INSERT INTO workspaces (id, name, owner_id, workspace_type)
      VALUES (${workspaceId}, ${`ad-${workspaceId.slice(0, 8)}`}, ${userId}, 'personal')`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role)
      VALUES (${workspaceId}, ${userId}, 'owner')`;
    // `notes.current_version_id` 上是一条**带 workspace 的复合外键**，指向 `note_versions`：
    // 先建笔记再建版本会当场 23503。按"笔记 → 版本 → 块 → 把指针挪上去"的顺序写。
    await tx`INSERT INTO notes (id, workspace_id, title, created_by)
      VALUES (${noteId}, ${workspaceId}, 'anchor-drift', ${userId})`;
    await tx`INSERT INTO note_versions (id, note_id, workspace_id, version_no, content_json, content_hash, created_by)
      VALUES (${versionOneId}, ${noteId}, ${workspaceId}, 1,
        ${tx.json({ blocks: [] })}, 'fixture-hash', ${userId})`;
    await tx`UPDATE notes SET current_version_id = ${versionOneId} WHERE id = ${noteId}`;
    await tx`INSERT INTO note_blocks (id, version_id, workspace_id, type, content, ordinal)
      VALUES (${blockOneId}, ${versionOneId}, ${workspaceId}, 'paragraph', ${QUOTED}, 1)`;
    await tx`INSERT INTO note_blocks (id, version_id, workspace_id, type, content, ordinal)
      VALUES (${blockTwoId}, ${versionOneId}, ${workspaceId}, 'paragraph', ${UNQUOTED}, 2)`;
  });

  // 用**真**的密封口，不手搓哈希：块 id、offsets、`block` 与 `evidence-quote` 两个域、
  // 以及不可变副本三件事都由生产代码写，用例才有资格说"读侧瞎了"而不是"夹具假了"。
  await withWorkspaceTransaction({ workspaceId, userId }, (tx) =>
    sealEvidenceSnapshotsV2(tx, {
      workspaceId,
      runId,
      noteId,
      noteVersionId: versionOneId,
      sourceSnapshotId,
      sourceScope: { kind: "whole_note" },
      blocks: [
        { blockId: blockOneId, type: "paragraph", content: QUOTED, ordinal: 1 },
        { blockId: blockTwoId, type: "paragraph", content: UNQUOTED, ordinal: 2 },
      ],
    }));
});

after(async () => {
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    await tx`SELECT set_config('app.allow_history_mutation', 'on', true)`;
    await tx`DELETE FROM evidence_quote_copies_v2 WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM evidence_eligibility_states_v2 WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM evidence_snapshots_v2 WHERE workspace_id = ${workspaceId}`;
  });
  await sql`DELETE FROM note_blocks WHERE workspace_id = ${workspaceId}`;
  await sql`DELETE FROM note_versions WHERE workspace_id = ${workspaceId}`;
  await sql`DELETE FROM notes WHERE workspace_id = ${workspaceId}`;
  await sql`DELETE FROM workspace_members WHERE workspace_id = ${workspaceId}`;
  await sql`DELETE FROM workspaces WHERE id = ${workspaceId}`;
  await sql`DELETE FROM users WHERE id = ${userId}`;
  const left = await sql`
    SELECT (SELECT count(*) FROM evidence_snapshots_v2 WHERE workspace_id = ${workspaceId}) AS snaps,
           (SELECT count(*) FROM note_blocks WHERE workspace_id = ${workspaceId}) AS blocks,
           (SELECT count(*) FROM notes WHERE workspace_id = ${workspaceId}) AS notes
  `;
  assert.equal(Number(left[0].snaps) + Number(left[0].blocks) + Number(left[0].notes), 0,
    "夹具没清干净，留下的行会让下一次读数不可信");
  await sql.end();
  const { closeDatabase } = await import("../db/client.ts");
  await closeDatabase();
});

test("正控制：还没有新版本时，两条锚点都说落点还在", async () => {
  const byBlock = await snapshotIdByBlock();
  assert.equal(byBlock.size, 2, `密封只写出 ${byBlock.size} 条证据行——这条链根本没跑通`);

  const items = await withWorkspaceTransaction({ workspaceId, userId }, (tx) =>
    loadEvidencePreviewItems(tx, workspaceId, [...byBlock.values()]));

  assert.equal(items.length, 2);
  for (const item of items) {
    assert.equal(item.sourceState, "located",
      `没动过内容就判成 ${item.sourceState}——那后面几发读数红得没有意义`);
    assert.equal(item.originalPreview, null);
  }
});

test("开了新版本、被引用的那段改了：那一条要判漂移并给回当初那段", async () => {
  await reVersion([
    { ordinal: 1, content: QUOTED.replace("快要忘记的时候", "刚好想不起来的时候") },
    { ordinal: 2, content: UNQUOTED },
  ]);

  const byBlock = await snapshotIdByBlock();
  const items = await withWorkspaceTransaction({ workspaceId, userId }, (tx) =>
    loadEvidencePreviewItems(tx, workspaceId, [...byBlock.values()]));

  const quoted = items.find((i) => i.evidenceSnapshotId === byBlock.get(blockOneId));
  const untouched = items.find((i) => i.evidenceSnapshotId === byBlock.get(blockTwoId));
  assert.ok(quoted && untouched, "两条锚点没有都读回来");

  assert.equal(quoted.sourceState, "drifted",
    "改了正文却仍说落点还在——D3 §3 第 2 层在跨版本这一维上是瞎的");
  assert.equal(quoted.originalPreview, QUOTED, "当初那段取不回来，那句「先核对」就没有对照物");
  assert.ok(quoted.preview.includes("刚好想不起来的时候"), quoted.preview);

  // D3 §7 判据 2 的反半：没被引用的那段变了不许牵连这条。
  assert.equal(untouched.sourceState, "located",
    "未引用的段落被牵连——这条会把 §10.2 第一行「不新增学习任务」判反");
});

test("新版本里那一段被删了：这条只能落「无法确认」，不许按位置迁移", async () => {
  // 用户删掉第二段：当前版本里 ordinal 2 一行都没有。按位置"往下找一个块"是把另一句话
  // 当成当初的依据——D3 §2.1 明令第三种情况（没有可比的落点）不许当成"内容没变"。
  await reVersion([{ ordinal: 1, content: QUOTED }]);

  const byBlock = await snapshotIdByBlock();
  const items = await withWorkspaceTransaction({ workspaceId, userId }, (tx) =>
    loadEvidencePreviewItems(tx, workspaceId, [...byBlock.values()]));
  const moved = items.find((i) => i.evidenceSnapshotId === byBlock.get(blockTwoId));
  assert.ok(moved);
  assert.equal(moved.sourceState, "missing",
    "锚点位置已经空了却还给出文字——那是把「这一行没证据」说成「证据还在」（D3 §2.1 第三种情况）");
  assert.equal(moved.originalPreview, UNQUOTED,
    "落点没了也要能把当初那段给出来，否则界面只能说「找不到」");
});
