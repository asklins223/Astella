import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import postgres from "postgres";
import Fastify from "fastify";
import sensible from "@fastify/sensible";
import { testDatabaseUrl } from "@astella/shared/integration-test-db-env";
import { desktopNoteListPageSchema } from "@astella/shared/desktop-surface-contracts";
import { seedV2Fixture, type V2FixtureSeeded } from "./helpers/v2-card-fixture.ts";
import { closeDatabase } from "../db/client.ts";
import { noteShelfStatesByNoteId } from "../modules/note/shelf-state.ts";
import { withWorkspaceTransaction } from "../db/client.ts";
import { authRoutes } from "../modules/identity/routes.ts";
import { issueSession } from "../modules/identity/service.ts";
import { noteRoutes } from "../modules/note/routes.ts";

const admin = postgres(testDatabaseUrl("DATABASE_URL_MIGRATOR"), { max: 2 });
testDatabaseUrl("DATABASE_URL_API");

let owner: V2FixtureSeeded;
let memberId: string;
const app = Fastify({ logger: false });
const call = (url: string, token: string) => app.inject({
  method: "GET",
  url,
  headers: { authorization: `Bearer ${token}` },
});

/**
 * 给一篇笔记装上真实正文，并把它设为共享。
 *
 两个动作都不是装饰：
  - 不装正文，`hasBody` 为 false，一切档位都会是「空稿」——测的就不是想要的那件事了；
  - 不共享，成员在 `visibleNotesCondition` 里根本读不到这一行，成员那条用例会变成
    在断言"一篇不可见的笔记"，而不是在断言"痕迹不泄露"。
 */
async function seedBody(note: V2FixtureSeeded, text: string): Promise<void> {
  await admin.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${note.workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${note.userId}, true)`;
    await tx`UPDATE notes SET current_version_id=${note.noteVersionId},share_scope='shared' WHERE id=${note.noteId}`;
    await tx`DELETE FROM note_blocks WHERE workspace_id=${note.workspaceId} AND version_id=${note.noteVersionId}`;
    await tx`INSERT INTO note_blocks(workspace_id,version_id,ordinal,type,content)
      VALUES(${note.workspaceId},${note.noteVersionId},1,'paragraph',${text})`;
  });
}

async function seedOverview(note: V2FixtureSeeded, userId: string): Promise<void> {
  // `note_overviews_has_origin_check` 要求每条速看都说得出它从哪来：要么是后台任务，
  // 要么是伴星答复。这里走后台任务那条，与 41 §6「速看由可恢复的后台任务生成」一致。
  const jobId = randomUUID();
  await admin.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${note.workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${note.userId}, true)`;
    await tx`INSERT INTO jobs(id,workspace_id,type,payload,status,finished_at)
      VALUES(${jobId},${note.workspaceId},'note.overview.generate',${tx.json({})},'succeeded',now())`;
    await tx`INSERT INTO note_overviews(workspace_id,user_id,note_id,note_version_id,body,source_references,generation_job_id)
      VALUES(${note.workspaceId},${userId},${note.noteId},${note.noteVersionId},'这篇讲的是复利。',
        ${tx.json([{ blockOrdinal: 1, quote: "复利" }])},${jobId})`;
  });
}

async function seedRecall(
  note: V2FixtureSeeded,
  userId: string,
  selfReport: "remembered" | "partly" | "not_yet" | null,
  reportedAt: string | null,
): Promise<void> {
  await admin.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${note.workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${note.userId}, true)`;
    await tx`INSERT INTO note_recall_records
      (workspace_id,user_id,note_id,note_version_id,request_id,question,answer_snapshot,self_report,revealed_at,reported_at)
      VALUES(${note.workspaceId},${userId},${note.noteId},${note.noteVersionId},${randomUUID()},
        '复利是什么？','复利是利息变成本金。',${selfReport},
        ${selfReport === null ? null : reportedAt},${reportedAt})`;
  });
}

async function seedAnnotation(note: V2FixtureSeeded, userId: string, versionId: string): Promise<void> {
  await admin.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${note.workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${note.userId}, true)`;
    await tx`INSERT INTO note_annotations
      (workspace_id,user_id,note_id,note_version_id,start_block_ordinal,start_offset,end_block_ordinal,end_offset,excerpt,explanation)
      VALUES(${note.workspaceId},${userId},${note.noteId},${versionId},1,0,1,2,'复利','就是利息也变成本金。')`;
  });
}

/** 造第二个版本并把它设为当前版本——用来验证「这篇后来改过」。 */
async function addNewVersion(note: V2FixtureSeeded): Promise<string> {
  const versionId = randomUUID();
  await admin.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${note.workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${note.userId}, true)`;
    await tx`INSERT INTO note_versions(id,workspace_id,note_id,version_no,content_hash,content_json,created_by)
      SELECT ${versionId},${note.workspaceId},${note.noteId},version_no+1,
        ${createHash("sha256").update(randomUUID()).digest("hex")},
        ${tx.json({ blocks: [{ type: "paragraph", content: "改过之后的正文。" }] })},
        created_by
      FROM note_versions WHERE id=${note.noteVersionId}`;
    await tx`UPDATE notes SET current_version_id=${versionId} WHERE id=${note.noteId}`;
  });
  return versionId;
}

/**
 * 在**同一个空间**里再开一篇笔记。
 *
 `note_versions.workspace_id` 对 `notes` 有外键，所以不能把别处的笔记改挂过来——
 那条捷径会在外键上炸。这里照着真实写入路径新建一篇，顺带保证
 `note_expansions` 的两侧外键（源与目标）都能成立。
 */
async function seedNoteInside(note: V2FixtureSeeded, title: string): Promise<{ id: string; versionId: string }> {
  const noteId = randomUUID();
  const versionId = randomUUID();
  await admin.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${note.workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${note.userId}, true)`;
    await tx`INSERT INTO notes(id,workspace_id,title,title_source,created_by,share_scope)
      VALUES(${noteId},${note.workspaceId},${title},'user',${note.userId},'private')`;
    await tx`INSERT INTO note_versions(id,workspace_id,note_id,version_no,content_hash,content_json,created_by)
      VALUES(${versionId},${note.workspaceId},${noteId},1,${createHash("sha256").update(noteId).digest("hex")},
        ${tx.json({ blocks: [{ type: "paragraph", content: "长出来的那一篇。" }] })},${note.userId})`;
    await tx`INSERT INTO note_blocks(workspace_id,version_id,ordinal,type,content)
      VALUES(${note.workspaceId},${versionId},1,'paragraph','长出来的那一篇。')`;
    await tx`UPDATE notes SET current_version_id=${versionId} WHERE id=${noteId}`;
  });
  return { id: noteId, versionId };
}

async function readState(note: V2FixtureSeeded, asUser: string) {
  return withWorkspaceTransaction(
    { workspaceId: note.workspaceId, userId: asUser },
    (tx) => noteShelfStatesByNoteId(tx, {
      workspaceId: note.workspaceId,
      userId: asUser,
      notes: [{
        id: note.noteId,
        currentVersionId: note.noteVersionId,
        hasBody: true,
      }],
    }),
  );
}

before(async () => {
  owner = await seedV2Fixture(admin);
  await seedBody(owner, "复利就是利息也变成本金，下一轮继续产生利息。");
  memberId = randomUUID();
  await admin.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${owner.workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${owner.userId}, true)`;
    await tx`INSERT INTO users(id,email,password_hash,role)
      VALUES(${memberId},${`shelf-${memberId}@example.test`},'h','member')`;
    await tx`INSERT INTO workspace_members(workspace_id,user_id,role)
      VALUES(${owner.workspaceId},${memberId},'member')`;
  });
  await app.register(sensible);
  await app.register(authRoutes);
  await app.register(noteRoutes);
  await app.ready();
});

after(async () => {
  try {
    await app.close();
    await owner?.cleanup();
    if (memberId) await admin`DELETE FROM users WHERE id=${memberId}`;
  } finally {
    await closeDatabase();
    await admin.end();
  }
});

test("一条痕迹都没有时是「还没看」，并且如实报告为零", async () => {
  const state = (await readState(owner, owner.userId)).get(owner.noteId);
  assert.ok(state, "这一行必须有状态");
  assert.equal(state.stage, "untouched");
  assert.equal(state.facts.overviewCount, 0);
  assert.equal(state.facts.recallCount, 0);
  assert.equal(state.facts.latestAt, null);
  assert.equal(state.editedAfterLearning, false);
});

test("速看与回想会被数出来，档位按最深的一条走", async () => {
  await seedOverview(owner, owner.userId);
  await seedRecall(owner, owner.userId, "not_yet", new Date().toISOString());
  const state = (await readState(owner, owner.userId)).get(owner.noteId);
  assert.ok(state);
  assert.equal(state.facts.overviewCount, 1);
  assert.equal(state.facts.recallCount, 1);
  // 自述是"没想起来"也仍然是回想过——41 §5 说的是两件不同的事，不是两个档位。
  assert.equal(state.facts.lastRecallSelfReport, "not_yet");
  assert.equal(state.stage, "recalled");
  assert.ok(state.facts.latestAt, "最近一次痕迹要有时间");
});

test("只翻了原文没自述的回想，不该被编出一个自述", async () => {
  const other = await seedV2Fixture(admin);
  try {
    await seedBody(other, "一段有正文的笔记。");
    await seedRecall(other, other.userId, null, null);
    const state = (await readState(other, other.userId)).get(other.noteId);
    assert.ok(state);
    assert.equal(state.facts.recallCount, 1);
    assert.equal(state.facts.lastRecallSelfReport, null);
    assert.equal(state.stage, "recalled");
  } finally {
    await other.cleanup();
  }
});

test("批注落在旧版本上时，界面要知道这篇后来改过", async () => {
  const other = await seedV2Fixture(admin);
  try {
    await seedBody(other, "第一版的正文。");
    await seedAnnotation(other, other.userId, other.noteVersionId);
    const newVersionId = await addNewVersion(other);
    const states = await withWorkspaceTransaction(
      { workspaceId: other.workspaceId, userId: other.userId },
      (tx) => noteShelfStatesByNoteId(tx, {
        workspaceId: other.workspaceId,
        userId: other.userId,
        notes: [{ id: other.noteId, currentVersionId: newVersionId, hasBody: true }],
      }),
    );
    const state = states.get(other.noteId);
    assert.ok(state);
    assert.equal(state.facts.annotationCount, 1);
    assert.equal(state.stage, "annotated");
    assert.equal(state.facts.latestVersionNumber, 1);
    assert.equal(state.editedAfterLearning, true);
  } finally {
    await other.cleanup();
  }
});

test("别人的学习痕迹不泄露给同空间的另一位成员", async () => {
  const state = (await readState(owner, memberId)).get(owner.noteId);
  assert.ok(state, "成员也要拿到这一行");
  // owner 已经有 1 次速看 + 1 次回想。成员看到的必须是一次痕迹都没有——
  // 把 owner 的自述"没想起来"显示到成员面前，是在泄露一条私人学习事实。
  assert.equal(state.facts.overviewCount, 0);
  assert.equal(state.facts.recallCount, 0);
  assert.equal(state.facts.lastRecallSelfReport, null);
  assert.equal(state.stage, "untouched");
});

test("互动讲解不冒充「看过这篇」", async () => {
  const other = await seedV2Fixture(admin);
  try {
    await seedBody(other, "一段有正文的笔记。");
    await admin.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${other.workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${other.userId}, true)`;
      await tx`INSERT INTO note_learning_artifacts
        (workspace_id,user_id,note_id,note_version_id,source_kind,source_content_hash,generator_ref,title,subject,caution,outline_json,html)
        VALUES(${other.workspaceId},${other.userId},${other.noteId},${other.noteVersionId},'annotation',
          ${createHash("sha256").update("x").digest("hex")},'g1','一个演示','讲什么','当心',
          ${tx.json([{ kind: "p", text: "第一步" }])},'<p>x</p>')`;
    });
    const state = (await readState(other, other.userId)).get(other.noteId);
    assert.ok(state);
    assert.equal(state.facts.artifactCount, 1);
    // 只有互动讲解说明用户问过某一句，不等于读过整篇。
    assert.equal(state.stage, "untouched");
  } finally {
    await other.cleanup();
  }
});

test("从别处长出来的笔记，两侧都算「长出过新笔记」", async () => {
  const source = await seedV2Fixture(admin);
  try {
    const grown = await seedNoteInside(source, "从这篇长出来的");
    await admin.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${source.workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${source.userId}, true)`;
      await tx`INSERT INTO note_expansions
        (workspace_id,user_id,source_note_id,source_note_version_id,expanded_note_id,expanded_note_version_id,request_id,request_body_hash)
        VALUES(${source.workspaceId},${source.userId},${source.noteId},${source.noteVersionId},
          ${grown.id},${grown.versionId},${randomUUID()},${"a".repeat(64)})`;
    });
    const states = await withWorkspaceTransaction(
      { workspaceId: source.workspaceId, userId: source.userId },
      (tx) => noteShelfStatesByNoteId(tx, {
        workspaceId: source.workspaceId,
        userId: source.userId,
        notes: [
          { id: source.noteId, currentVersionId: source.noteVersionId, hasBody: true },
          { id: grown.id, currentVersionId: grown.versionId, hasBody: true },
        ],
      }),
    );
    // 两侧都要有。查询只按 source 查的话，从别处长出来的这篇永远拿不到这一枚纸签。
    assert.equal(states.get(source.noteId)?.facts.expansionCount, 1);
    assert.equal(states.get(source.noteId)?.stage, "grew");
    assert.equal(states.get(grown.id)?.facts.expansionCount, 1);
    assert.equal(states.get(grown.id)?.stage, "grew");
  } finally {
    await source.cleanup();
  }
});

test("空页不发查询，也不编出状态", async () => {
  const states = await withWorkspaceTransaction(
    { workspaceId: owner.workspaceId, userId: owner.userId },
    (tx) => noteShelfStatesByNoteId(tx, {
      workspaceId: owner.workspaceId,
      userId: owner.userId,
      notes: [],
    }),
  );
  assert.equal(states.size, 0);
});

test("GET /notes 把这一行的状态带出来，且能被桌面契约原样接住", async () => {
  // 自己一篇，不借用上面那篇：那些用例已经在它身上种过痕迹，计数会继续往上加。
  const own = await seedV2Fixture(admin);
  try {
    await seedBody(own, "复利就是利息也变成本金。");
    await seedOverview(own, own.userId);
    await seedRecall(own, own.userId, "partly", new Date().toISOString());
    const token = (await issueSession(own.userId, own.workspaceId)).token;
    const response = await call("/notes?limit=50", token);
    assert.equal(response.statusCode, 200);

    // 走一遍桌面端真正会走的那道校验。契约是 `passthrough` + `.default()`，
    // 漏一个字段不会炸、只会悄悄变成默认值——所以这里断言的是**值**，
    // 而不只是「请求没报错」。
    const page = desktopNoteListPageSchema.parse(response.json());
    const row = page.items.find((item) => item.id === own.noteId);
    assert.ok(row, "刚种过痕迹的那篇必须出现在列表里");
    assert.ok(row.shelfState, "这一行必须带状态");
    assert.equal(row.shelfState.stage, "recalled");
    assert.equal(row.shelfState.facts.overviewCount, 1);
    assert.equal(row.shelfState.facts.recallCount, 1);
    assert.equal(row.shelfState.facts.lastRecallSelfReport, "partly");
  } finally {
    await own.cleanup();
  }
});

test("同空间的成员读同一份列表，看不到别人的学习痕迹", async () => {
  const memberToken = (await issueSession(memberId, owner.workspaceId)).token;
  const response = await call("/notes?limit=50", memberToken);
  assert.equal(response.statusCode, 200);
  const page = desktopNoteListPageSchema.parse(response.json());
  const row = page.items.find((item) => item.id === owner.noteId);
  // 成员读不到 owner 的自述。这一格若显示成"回想过"，就是在替成员编一个
  // 属于 owner 的私人学习事实。
  assert.equal(row?.shelfState?.facts.recallCount, 0);
  assert.equal(row?.shelfState?.facts.lastRecallSelfReport, null);
  assert.notEqual(row?.shelfState?.stage, "recalled");
});

test("回收站那一页不因为这一项而失败", async () => {
  const ownerToken = (await issueSession(owner.userId, owner.workspaceId)).token;
  const response = await call("/notes?limit=50&trashed=true", ownerToken);
  assert.equal(response.statusCode, 200);
  desktopNoteListPageSchema.parse(response.json());
});
