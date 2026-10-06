/**
 * 提醒的**来源笔记**闸（39d W5-6 刀三；39 §16.13、§14.4）。
 *
 * §16.13 的验收有一半是"共享撤销后，**通知**和历史不泄露受保护内容"。这一份钉的就是
 * 那一半：迁移 0299 之前，`companion_reminders` 只有 `text` 一列，
 * `astella_fire_due_companion_reminders` 只按"账号开关／离线／空间静音"三道闸放行，
 * 于是**没有任何一处能知道一条提醒是在说哪篇笔记**——共享撤回之后，那句
 * "提醒你看《数据库索引优化策略》第 3 节"照样到点弹出来，篇名就在正文里。
 *
 * 钉住五件事：
 *  1. 带 `note_id` 的提醒，在笔记仍然共享时**照常兑现**（正控制：闸不能把正常提醒也掐了）；
 *  2. 共享撤回之后，它被置为 `cancelled` 且**不产生投递**——两个读数都要，
 *     只看状态不看 `assistant_deliveries` 的话，"标了取消但还是投出去了"读不出来；
 *  3. `note_id` 为空的存量行**继续照常兑现**（空 = 不知道来源，不拿可用性换一个
 *     查不出来的风险；这是迁移头注里写明的取舍）；
 *  4. 笔记**软删**同样掐（`deleted_at` 非空）；
 *  5. 作者本人对**自己**的私有笔记仍然拿得到提醒（判据第二支是 `created_by = 本人`，
 *     只测共享那一支会把这条判错）。
 *
 * 这份要能过，迁移 0299 必须已应用；`db-migrations.integration.ts` 之外这里也显式
 * 查一次列在不在，缺列时报的是"迁移没应用"而不是一串看不懂的 SQL 错误。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";

const fixtureUrl = process.env.DATABASE_URL_MIGRATOR ?? process.env.DATABASE_URL;
if (!fixtureUrl) throw new Error("提醒闸集测需要 DATABASE_URL_MIGRATOR");
const sql = postgres(fixtureUrl, { max: 4 });

const AUTHOR = randomUUID();
const MEMBER = randomUUID();
const WORKSPACE = randomUUID();
const SHARED_NOTE = randomUUID();
const PRIVATE_NOTE = randomUUID();
const AUTHOR_OWN_NOTE = randomUUID();
const DELETED_NOTE = randomUUID();

/** 造一条已到点的提醒，返回它的 id。 */
async function scheduleReminder(text: string, noteId: string | null): Promise<string> {
  const rows = await sql`
    INSERT INTO companion_reminders (workspace_id, user_id, text, fire_at, note_id)
    VALUES (${WORKSPACE}, ${MEMBER}, ${text}, now() - interval '1 minute', ${noteId}::uuid)
    RETURNING id::text AS id`;
  return rows[0].id;
}

async function fireOnce(): Promise<number> {
  const rows = await sql`SELECT public.astella_fire_due_companion_reminders(50) AS fired`;
  return Number(rows[0].fired ?? 0);
}

async function statusOf(reminderId: string): Promise<string> {
  const rows = await sql`SELECT status FROM companion_reminders WHERE id = ${reminderId}::uuid`;
  return rows[0]?.status ?? "";
}

/** 这条提醒有没有真的投递出去（`dedupe_key` 是 `'reminder:' || id`）。 */
async function deliveredCount(reminderId: string): Promise<number> {
  const rows = await sql`
    SELECT count(*)::int AS n FROM assistant_deliveries
     WHERE workspace_id = ${WORKSPACE} AND user_id = ${MEMBER}
       AND dedupe_key = ${"reminder:" + reminderId}`;
  return rows[0].n;
}

before(async () => {
  // 缺列就明说"迁移没应用"，别让后面那些 SQL 报成看不懂的东西。
  const cols = await sql`
    SELECT count(*)::int AS n FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'companion_reminders' AND column_name = 'note_id'`;
  assert.equal(cols[0].n, 1, "companion_reminders.note_id 不在——迁移 0299 没应用");

  await sql`INSERT INTO users (id, email, password_hash, role)
    VALUES (${AUTHOR}, ${`remind-author-${AUTHOR.slice(0, 8)}@example.test`}, 'h', 'member'),
           (${MEMBER}, ${`remind-member-${MEMBER.slice(0, 8)}@example.test`}, 'h', 'member')`;
  await sql`INSERT INTO workspaces (id, owner_id, name)
    VALUES (${WORKSPACE}, ${AUTHOR}, ${`Reminder ${WORKSPACE.slice(0, 8)}`})`;
  await sql`INSERT INTO workspace_members (workspace_id, user_id, role)
    VALUES (${WORKSPACE}, ${AUTHOR}, 'owner'), (${WORKSPACE}, ${MEMBER}, 'member')`;
  for (const [noteId, shareScope, createdBy, deleted] of [
    [SHARED_NOTE, "shared", AUTHOR, null],
    [PRIVATE_NOTE, "private", AUTHOR, null],
    [AUTHOR_OWN_NOTE, "private", AUTHOR, null],
    [DELETED_NOTE, "shared", AUTHOR, new Date()],
  ] as const) {
    await sql`INSERT INTO notes (id, workspace_id, title, created_by, share_scope, deleted_at)
      VALUES (${noteId}, ${WORKSPACE}, ${`提醒闸-${noteId.slice(0, 6)}`}, ${createdBy}, ${shareScope}, ${deleted})`;
  }
});

after(async () => {
  await sql`DELETE FROM assistant_deliveries WHERE workspace_id = ${WORKSPACE}`;
  await sql`DELETE FROM companion_reminders WHERE workspace_id = ${WORKSPACE}`;
  await sql`DELETE FROM notes WHERE workspace_id = ${WORKSPACE}`;
  await sql`DELETE FROM workspace_members WHERE workspace_id = ${WORKSPACE}`;
  await sql`DELETE FROM workspaces WHERE id = ${WORKSPACE}`;
  await sql`DELETE FROM users WHERE id IN (${AUTHOR}, ${MEMBER})`;
  await sql.end({ timeout: 5 });
});

test("正控制：带 note_id 且笔记仍共享，照常兑现并投递", async () => {
  const id = await scheduleReminder("提醒你看索引那篇第 3 节", SHARED_NOTE);
  await fireOnce();
  assert.equal(await statusOf(id), "fired", "闸把正常提醒也掐了");
  assert.equal(await deliveredCount(id), 1, "状态是 fired 却没投递，读数自相矛盾");
});

test("共享撤回之后：置为 cancelled 且不投递（两个读数都要）", async () => {
  const id = await scheduleReminder("提醒你看复合索引那篇", SHARED_NOTE);
  await sql`UPDATE notes SET share_scope = 'private' WHERE id = ${SHARED_NOTE}`;
  await fireOnce();
  assert.equal(await statusOf(id), "cancelled", "失权之后这条提醒还在 pending 就是没被掐住");
  assert.equal(await deliveredCount(id), 0, "标了 cancelled 却还是投出去了——那才是真的泄露");
  await sql`UPDATE notes SET share_scope = 'shared' WHERE id = ${SHARED_NOTE}`;
});

test("note_id 为空的存量行继续照常兑现（空 = 不知道来源）", async () => {
  const id = await scheduleReminder("提醒你三点开会", null);
  await fireOnce();
  assert.equal(await statusOf(id), "fired");
  assert.equal(await deliveredCount(id), 1);
});

test("笔记软删同样掐掉（deleted_at 非空）", async () => {
  const id = await scheduleReminder("提醒你看那篇已删的", DELETED_NOTE);
  await fireOnce();
  assert.equal(await statusOf(id), "cancelled");
  assert.equal(await deliveredCount(id), 0);
});

test("判据第二支：作者对自己那篇私有笔记仍然拿得到提醒", async () => {
  // 上面几行是替**别人**造的提醒（user_id = MEMBER）。这一行用作者自己的身份：
  // 判据是 `share_scope = 'shared' OR created_by = 本人`，只测共享那一支
  // 会把这条判错——作者永远看得见自己写的笔记。
  const rows = await sql`
    INSERT INTO companion_reminders (workspace_id, user_id, text, fire_at, note_id)
    VALUES (${WORKSPACE}, ${AUTHOR}, '提醒我回看我自己那篇', now() - interval '1 minute', ${AUTHOR_OWN_NOTE}::uuid)
    RETURNING id::text AS id`;
  const id = rows[0].id;
  await fireOnce();
  assert.equal(await statusOf(id), "fired", "作者对自己那篇私有笔记的提醒被误掐了");
});
