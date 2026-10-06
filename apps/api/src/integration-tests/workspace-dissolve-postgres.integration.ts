/**
 * doc 34 L6 的 ② —— 解散空间：把"这个空间没了"做成一件说得清后果、且不留孤儿的事（迁移 0276）。
 *
 * 三条判据全部在这里被验（都是量出来的，见 §13）：
 *  ① 102 张表带 `workspace_id`、只有 13 张有指向 workspaces 的外键 ⇒ 必须逐表清，
 *     这里用**同一份 catalog 清单**做残留对账：除排除名单外，每张表都得是 0 行。
 *  ② 记忆跟人绑定：`scope='global'` 改指回个人空间后**必须还活着**；`scope='workspace'` 被收掉。
 *  ③ 审计 tombstone 活得过解散：`workspace_audit_log` 那条 `workspace.dissolved` 要能查到，
 *     而且带着逐表计数。
 *
 * 角色：夹具写用超级用户（`DATABASE_URL`），解散由 **`astella_api`** 执行（生产形状）。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";

const ADMIN = process.env.DATABASE_URL;
const API = process.env.DATABASE_URL_API;
if (!ADMIN || !API) {
  throw new Error("解散空间集测要求 DATABASE_URL（夹具）+ DATABASE_URL_API（astella_api）");
}
const admin = postgres(ADMIN, { max: 2 });
const api = postgres(API, { max: 1 });

const EXCLUDED = [
  "workspaces",
  "ai_audit_log",
  "workspace_audit_log",
  "assistant_memory_items",
  "assistant_memory_embeddings",
];

const ws = randomUUID();
const owner = randomUUID();
const member = randomUUID();
const ownerPersonal = randomUUID();
const memberPersonal = randomUUID();
const globalMemory = randomUUID();
const workspaceMemory = randomUUID();
const noteId = randomUUID();

/**
 * 笔记学习轮次族（0282–0285）的一整套行——这一组是 2026-09-26 量到的那条 P0 的现场：
 * 三张子表的"只追加"守卫把 UPDATE 与 DELETE 一起挡了，而父表 `note_learning_rounds`
 * 那把 `nlr_identity_immutable` 只挡改不挡删。于是解散沿外键级联下来时，子表在半路抛
 * `P0001 … append-only: DELETE is not allowed`，整个解散事务回滚。
 * 四张表都要种：只种父表测不出来（那正是 F43 当年"真解散验通"的形状——当时这几张表还没有）。
 */
const roundVersionId = randomUUID();
const roundId = randomUUID();
const planRevisionId = randomUUID();
const teachingId = randomUUID();
const artifactId = randomUUID();
/** 真实主形状是 32 位 md5（0282/0284 那条注释记过：写成 64 会把真笔记挡在外面）。 */
const ROUND_SNAPSHOT_HASH = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";

/** 清单从 catalog 现生成，不手抄——手抄那份会随新迁移悄悄漏表。 */
async function workspaceTables(): Promise<string[]> {
  const rows = await admin`
    SELECT c.relname FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'workspace_id'
    WHERE n.nspname = 'public' AND c.relkind = 'r'
    ORDER BY c.relname
  `;
  return rows.map((r) => String(r.relname));
}

// 扇出形状（F43/F44）：同一条 global 记忆带着**完全相同的 source_event_id**
// 同时挂在被解散空间与发起者的个人空间里。伴星的记忆是按空间复制的，所以这是真实形状，
// 而原来的夹具只有"一条 global 记忆"，正好错过了唯一会让解散 100% 失败的那种数据。
const fanoutInDissolved = randomUUID();
const fanoutInPersonal = randomUUID();
const FANOUT_SOURCE_EVENT_ID = `memory-extract:${randomUUID()}:0`;

before(async () => {
  await admin.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
    await tx`INSERT INTO users (id, email, password_hash, role)
      VALUES (${owner}, ${`dis-own-${ws.slice(0, 8)}@example.test`}, 'h', 'owner'),
              (${member}, ${`dis-mem-${ws.slice(0, 8)}@example.test`}, 'h', 'owner')`;
    await tx`INSERT INTO workspaces (id, name, owner_id, workspace_type)
      VALUES (${ownerPersonal}, ${`dis-po-${ws.slice(0, 8)}`}, ${owner}, 'personal'),
              (${memberPersonal}, ${`dis-pm-${ws.slice(0, 8)}`}, ${member}, 'personal'),
              (${ws}, ${`dis-solve-${ws.slice(0, 8)}`}, ${owner}, 'collaborative')`;
    await tx`UPDATE users SET personal_workspace_id = ${ownerPersonal} WHERE id = ${owner}`;
    await tx`UPDATE users SET personal_workspace_id = ${memberPersonal} WHERE id = ${member}`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role)
      VALUES (${ws}, ${owner}, 'owner'), (${ws}, ${member}, 'member'),
              (${ownerPersonal}, ${owner}, 'owner'), (${memberPersonal}, ${member}, 'owner')`;
    // 一篇笔记 + 一条属于人的记忆 + 一条关联空间的记忆（global 那条故意挂在这个空间上，
    // 这就是实测里 92/105 那种形状：跟人绑定的记忆未必要跟着空间一起死）。
    await tx`INSERT INTO notes (id, workspace_id, title, created_by)
      VALUES (${noteId}, ${ws}, 'dissolve-me', ${owner})`;
    // 这一篇上真的开过一轮、改过一次计划、讲过一次课、还有一份动态产物——四张表一起种。
    await tx`INSERT INTO note_versions (id, note_id, workspace_id, version_no, content_json, content_hash, created_by)
      VALUES (${roundVersionId}, ${noteId}, ${ws}, 1,
              ${tx.json({ blocks: [{ type: "paragraph", content: "有索引，查询仍然可能慢" }] })}, 'dis-ver-hash', ${owner})`;
    await tx`INSERT INTO note_learning_rounds (id, workspace_id, user_id, note_id, phase, outcome,
              driving_question, driving_question_source, driving_question_revision,
              note_version_id, source_content_hash, evidence_snapshot_ids,
              max_model_calls, max_wall_clock_seconds, max_tasks, revision, closed_at)
      VALUES (${roundId}, ${ws}, ${owner}, ${noteId}, 'closed', 'partial',
              '为什么有索引还是慢', 'suggested', 1,
              ${roundVersionId}, ${ROUND_SNAPSHOT_HASH}, '{}',
              8, 900, 6, 3, now())`;
    await tx`INSERT INTO note_learning_round_plan_revisions (id, workspace_id, user_id, round_id,
              plan_ordinal, round_revision, plan, reason)
      VALUES (${planRevisionId}, ${ws}, ${owner}, ${roundId}, 1, 1,
              ${tx.json({ items: [{ key: "explain", label: "先讲清多一跳访问的代价" }] })}, '换成先讲代价')`;
    await tx`INSERT INTO note_learning_round_artifacts (id, workspace_id, user_id, round_id, kind, html, snapshot_hash)
      VALUES (${artifactId}, ${ws}, ${owner}, ${roundId}, 'dynamic_explanation',
              '<section class="astella-artifact-pane" data-artifact-step="0"></section>', ${ROUND_SNAPSHOT_HASH})`;
    await tx`INSERT INTO note_learning_round_teachings (id, workspace_id, user_id, round_id, ordinal, kind,
              content, source_block_ordinals, snapshot_hash, driving_question_revision, artifact_id)
      VALUES (${teachingId}, ${ws}, ${owner}, ${roundId}, 1, 'explanation',
              ${tx.json({ explanation: "统计信息过期时优化器会选全表扫" })}, '{1}',
              ${ROUND_SNAPSHOT_HASH}, 1, ${artifactId})`;
    await tx`INSERT INTO assistant_memory_items (id, workspace_id, user_id, kind, content, scope)
      VALUES (${globalMemory}, ${ws}, ${owner}, 'preference', '属于人的那条', 'global'),
              (${workspaceMemory}, ${ws}, ${owner}, 'preference', '关联空间的那条', 'workspace')`;
    await tx`UPDATE assistant_memory_items SET global_key = ${globalMemory} WHERE id = ${globalMemory}`;
    await tx`INSERT INTO assistant_memory_items (id, workspace_id, user_id, kind, content, scope, source_event_id)
      VALUES (${fanoutInDissolved}, ${ws}, ${owner}, 'preference', '扇出到本空间的那一份', 'global', ${FANOUT_SOURCE_EVENT_ID}),
              (${fanoutInPersonal}, ${ownerPersonal}, ${owner}, 'preference', '个人空间里的原件', 'global', ${FANOUT_SOURCE_EVENT_ID})`;
  });
});

after(async () => {
  await admin.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
    await tx`SELECT set_config('app.allow_history_mutation', 'on', true)`;
    for (const id of [globalMemory, workspaceMemory]) {
      await tx`DELETE FROM assistant_memory_embeddings WHERE memory_id = ${id}`;
    }
    await tx`DELETE FROM assistant_memory_items WHERE id IN (${globalMemory}, ${workspaceMemory}, ${fanoutInDissolved}, ${fanoutInPersonal})`;
    await tx`DELETE FROM notes WHERE id = ${noteId}`;
    // 解散预览用例在**三个空间**都种过相撞的行；被解散那一份由真函数收掉，
    // 个人空间那一份没人动——不清就撞 `sources_created_by_users_id_fk`。
    await tx`DELETE FROM review_schedules WHERE workspace_id IN (${ws}, ${ownerPersonal}, ${memberPersonal})`;
    await tx`DELETE FROM sources WHERE workspace_id IN (${ws}, ${ownerPersonal}, ${memberPersonal})`;
    await tx`DELETE FROM workspace_audit_log WHERE target_id = ${ws} OR workspace_id IN (${ws}, ${ownerPersonal}, ${memberPersonal})`;
    await tx`DELETE FROM workspace_members WHERE workspace_id IN (${ws}, ${ownerPersonal}, ${memberPersonal})`;
    await tx`UPDATE users SET personal_workspace_id = NULL WHERE id IN (${owner}, ${member})`;
    await tx`DELETE FROM workspaces WHERE id IN (${ws}, ${ownerPersonal}, ${memberPersonal})`;
    await tx`DELETE FROM users WHERE id IN (${owner}, ${member})`;
  });
  await admin.end();
  await api.end();
  const { closeDatabase } = await import("../db/client.ts");
  await closeDatabase();
});

test("正控制：这份 catalog 清单大到足以说明问题（不是空表对账）", async () => {
  const tables = await workspaceTables();
  assert.ok(tables.length >= 90, `catalog 只认出 ${tables.length} 张带 workspace_id 的表，清单本身可能失效`);
});

test("个人空间与非 owner 一律被挡下", async () => {
  await assert.rejects(
    () => api`SELECT public.astella_dissolve_workspace(${ownerPersonal}::uuid, ${owner}::uuid)`,
    /cannot_dissolve_personal_workspace/,
    "个人空间可以被解散——会话就没有落回点了",
  );
  await assert.rejects(
    () => api`SELECT public.astella_dissolve_workspace(${ws}::uuid, ${member}::uuid)`,
    /actor_is_not_active_owner/,
    "member 也能解散别人的空间",
  );
});

/**
 * 解散**之前**的先睹计数（审计 F39 ③）。
 *
 * 确认文案写着"会连同其中的笔记、卡片与排程一起消失"，但界面上一个数都没有。
 * 夹具刻意在**另一个空间**（发起者的个人空间）也放了同样的行：预览的 SQL 一旦
 * 漏掉 `workspace_id` 过滤，数出来就会把两个空间加在一起——没有这批相撞的行，
 * "过滤写了"和"过滤生效"是两件事。
 */
test("解散预览：数得出这个空间里有多少东西，且只数这个空间的", async () => {
  const { previewWorkspaceDissolve } = await import("../modules/identity/service.ts");

  await admin.begin(async (tx) => {
    for (const [workspaceId, userId] of [[ws, owner], [ownerPersonal, owner]] as const) {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${userId}, true)`;
      await tx`INSERT INTO sources (id, workspace_id, type, title, origin, status, metadata, created_by)
        VALUES (${randomUUID()}, ${workspaceId}, 'text', ${"相撞的夹具来源"}, 'pasted', 'ready',
                ${tx.json({})}, ${userId})`;
      await tx`INSERT INTO review_schedules
        (id, workspace_id, user_id, subject_type, subject_id, status, next_review_at,
         interval_days, generation, policy_version, reason_code, created_at, updated_at)
        VALUES (${randomUUID()}, ${workspaceId}, ${userId}, 'card', ${randomUUID()},
                'pending', now() + interval '1 day', 1, 1, 'discrete-v2', 'initial_validation', now(), now())`;
    }
  });

  const allowed = await previewWorkspaceDissolve(ws, owner);
  assert.ok(allowed.ok, `owner 读预览应当成功，实际 ${JSON.stringify(allowed)}`);
  assert.deepEqual(allowed.counts, { notes: 1, sources: 1, cards: 0, schedules: 1 },
    "计数应当只算被解散那一个空间（个人空间里那一套相撞的行不算进来）");

  const denied = await previewWorkspaceDissolve(ws, member);
  assert.deepEqual(denied, { ok: false, error: "actor_is_not_active_owner" },
    "member 不该看到这份计数——他没有解散的权力");
  const personal = await previewWorkspaceDissolve(ownerPersonal, owner);
  assert.equal(personal.ok, false, "个人空间没有解散这回事，预览也不该给数");
});

test("解散：逐表清干净、属于人的记忆活着、审计留得下", async () => {
  /**
   * 先做阳性对照：轮次族那四张表**确实各有行**，否则下面那句"解散后为 0"可以靠
   * "从来没种进去"蒙过去（这条用例要钉的正是 2026-09-26 那条 P0：解散沿外键级联
   * 清这四张表时，被三张子表的只追加守卫挡在半路）。
   */
  const ROUND_TABLES = [
    "note_learning_rounds",
    "note_learning_round_plan_revisions",
    "note_learning_round_teachings",
    "note_learning_round_artifacts",
  ] as const;
  for (const table of ROUND_TABLES) {
    const seeded = await admin.unsafe(
      `SELECT count(*)::int AS n FROM public.${table} WHERE workspace_id = '${ws}'::uuid`,
    );
    assert.ok(Number(seeded[0].n) >= 1, `起点就没种 ${table} ⇒ 这一条测不到级联清理`);
  }

  const result = await api`
    SELECT public.astella_dissolve_workspace(${ws}::uuid, ${owner}::uuid) AS counts
  `;
  const counts = result[0].counts as Record<string, number>;
  assert.ok((counts.notes ?? 0) >= 1, `返回计数里没有 notes：${JSON.stringify(counts)}`);

  for (const table of ROUND_TABLES) {
    const left = await admin.unsafe(
      `SELECT count(*)::int AS n FROM public.${table} WHERE workspace_id = '${ws}'::uuid`,
    );
    assert.equal(Number(left[0].n), 0,
      `解散之后 ${table} 里还留着这个空间的行（只追加守卫挡住外键级联的那条 P0）`);
  }

  const left = await admin`SELECT id FROM notes WHERE id = ${noteId}`;
  assert.equal(left.length, 0, "空间里的笔记成了孤儿（102 张表只有 13 张有外键，靠 CASCADE 清不掉）");

  const survived = await admin`
    SELECT workspace_id, scope FROM assistant_memory_items WHERE id = ${globalMemory}
  `;
  assert.equal(survived.length, 1, "属于人的记忆被跟着空间删了");
  assert.equal(String(survived[0].workspace_id), ownerPersonal, "global 记忆没被改指回个人空间");
  const gone = await admin`SELECT id FROM assistant_memory_items WHERE id = ${workspaceMemory}`;
  assert.equal(gone.length, 0, "关联空间的记忆还挂在已消失的空间上");

  // F43 的形状：同一条 global 记忆按空间扇出，两份带着同一个 source_event_id。
  // 改指针前不先丢掉重复的那一份，就会撞
  // `assistant_memory_items_content_unique_idx`，整个解散事务回滚——用户侧是
  // "学习服务内部出了点问题，请稍后重试"，而重试永远再失败。
  const fanout = await admin`SELECT id FROM assistant_memory_items
    WHERE id IN (${fanoutInDissolved}, ${fanoutInPersonal})`;
  assert.equal(fanout.length, 1,
    "扇出的 global 记忆让解散失败/或两份都在：应丢掉重复的一份、留下个人空间原件");
  assert.equal(String(fanout[0].id), fanoutInPersonal,
    "丢掉的是个人空间的原件而不是被解散空间那一份——用户会看到记忆凭空变少");

  // tombstone 记在**发起者的个人空间**名下：`workspace_audit_log.workspace_id` 对 workspaces
  // 是 ON DELETE CASCADE，记在被解散的空间名下等于自己把它删了。
  const tombstone = await admin`
    SELECT action, detail FROM workspace_audit_log
    WHERE workspace_id = ${ownerPersonal} AND target_id = ${ws} AND action = 'workspace.dissolved'
  `;
  assert.equal(tombstone.length, 1, "审计 tombstone 没留下或被一起删了");
  assert.ok((tombstone[0].detail as { workspaceName: string }).workspaceName.startsWith("dis-solve-"));

  const tables = (await workspaceTables()).filter((t) => !EXCLUDED.includes(t));
  const dangling: string[] = [];
  for (const table of tables) {
    const rows = await admin.unsafe(
      `SELECT count(*)::int AS n FROM public.${table} WHERE workspace_id = '${ws}'::uuid`,
    );
    if (Number(rows[0]?.n ?? 0) > 0) dangling.push(table);
  }
  assert.deepEqual(
    dangling,
    [],
    `这些表里还留着指向已解散空间的行：${dangling.join(", ")}（清单来自 catalog，漏一张就是一批孤儿）`,
  );
});
