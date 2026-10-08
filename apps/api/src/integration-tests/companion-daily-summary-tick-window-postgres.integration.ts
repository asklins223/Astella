/**
 * 日记入队窗口的实库回归（40 §5.5）。
 *
 * 只在本地 01:00–06:59 为昨天有材料的用户/空间排一篇日记。重启只检查最近一个已结束的
 * 本地日，不把停机期间的多个日期补成一串；窗口内重复 tick 由幂等键收敛。
 *
 * 时区是测试自己挑的：按当前时刻从固定表里选一个本地钟点在 1..6 的、一个不在的，
 * 所以断言不依赖跑测试的墙上时间。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { testDatabaseUrl } from "@astella/shared/integration-test-db-env";

// 定时函数和跨账号夹具由迁移角色执行；不把生产 API 连接当成管理员连接。
const CONN = testDatabaseUrl("DATABASE_URL_MIGRATOR");

const sql = postgres(CONN, { max: 2 });
const userId = randomUUID();
const workspaceId = randomUUID();
const prefix = userId.slice(0, 8);

/**
 * 覆盖 UTC-12..UTC+13 全部 26 个整点偏移（用 `Etc/GMT±N`，注意符号是反的），
 * 所以任意时刻都能挑到"落在 2..6 点"和"落在窗口外"的两个时区——
 * 断言不依赖跑测试的墙上时间。
 *
 * 为什么必须挑 2..6 而不是 1 点：1 点旧代码也入队，用它测不出放宽有没有生效。
 */
function zoneAtOffset(offsetHours: number): string {
  if (offsetHours === 0) return "Etc/UTC";
  return offsetHours > 0 ? `Etc/GMT-${offsetHours}` : `Etc/GMT+${-offsetHours}`;
}
function localHour(zone: string): number {
  return Number(new Intl.DateTimeFormat("en-US", {
    timeZone: zone, hour: "2-digit", hour12: false,
  }).format(new Date())) % 24;
}
const OFFSETS = Array.from({ length: 26 }, (_unused, i) => i - 12);
const widenedZone = OFFSETS.map(zoneAtOffset).find((z) => { const h = localHour(z); return h >= 2 && h <= 6; });
const outsideZone = OFFSETS.map(zoneAtOffset).find((z) => { const h = localHour(z); return h < 1 || h > 6; });
assert.ok(widenedZone && outsideZone, "时区表必须同时覆盖放宽段与窗口外");

/** 和调度器同一句算法，不在 JS 里重算时区。 */
async function yesterdayLocal(zone: string): Promise<string> {
  const rows = await sql`SELECT to_char((now() AT TIME ZONE ${zone}::text)::date - 1, 'YYYY-MM-DD') AS d`;
  return String(rows[0].d);
}

async function setZone(zone: string): Promise<void> {
  await sql`UPDATE user_companion_account_state SET quiet_hours = jsonb_build_object('timezone', ${zone}::text) WHERE user_id = ${userId}`;
}

async function jobCount(dateKey: string): Promise<number> {
  const rows = await sql`
    SELECT count(*)::int n FROM jobs
    WHERE workspace_id = ${workspaceId} AND requested_by = ${userId}
      AND type = 'companion_daily_summary' AND idempotency_key = ${`daily-summary:${workspaceId}:${userId}:${dateKey}`}
  `;
  return rows[0]?.n ?? 0;
}

after(async () => {
  await sql`DELETE FROM jobs WHERE workspace_id = ${workspaceId}`.catch(() => {});
  await sql`DELETE FROM notes WHERE workspace_id = ${workspaceId}`.catch(() => {});
  await sql`DELETE FROM user_companion_account_state WHERE user_id = ${userId}`.catch(() => {});
  await sql`DELETE FROM workspace_members WHERE user_id = ${userId}`.catch(() => {});
  await sql`DELETE FROM workspaces WHERE id = ${workspaceId}`.catch(() => {});
  await sql`DELETE FROM users WHERE id = ${userId}`.catch(() => {});
  await sql.end({ timeout: 5 }).catch(() => {});
});

await sql`
  INSERT INTO users (id, email, password_hash, role)
  VALUES (${userId}, ${`diary-tick-${prefix}@example.test`}, 'test-hash', 'owner')
`;
await sql`INSERT INTO workspaces (id, name, owner_id) VALUES (${workspaceId}, 'diary-tick-ws', ${userId})`;
await sql`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${workspaceId}, ${userId}, 'owner')`;
await sql`
  INSERT INTO user_companion_account_state (user_id, global_enabled, diary_enabled, diary_enabled_since, quiet_hours)
  VALUES (${userId}, true, true, date_trunc('milliseconds', now()), jsonb_build_object('timezone', 'Etc/UTC'))
`;
// 活跃判据：昨天（用户本地日）有一篇新建笔记，否则调度器会直接跳过这个人。
// 钟点取当地正午，保证落在窗口中间，不贴边界。
const seedDateKey = await yesterdayLocal(widenedZone!);
await sql`
  INSERT INTO notes (id, workspace_id, title, title_source, created_by, created_at, updated_at)
  VALUES (gen_random_uuid(), ${workspaceId}, ${`diary-tick-${prefix}`}, 'manual', ${userId},
          (${seedDateKey}::date + interval '12 hours') AT TIME ZONE ${widenedZone!}::text,
          (${seedDateKey}::date + interval '12 hours') AT TIME ZONE ${widenedZone!}::text)
`;

test("窗口外：即使昨天有材料，也不排日记任务", async () => {
  const dateKey = await yesterdayLocal(outsideZone!);
  const title = `diary-outside-window-${prefix}`;
  await sql`
    INSERT INTO notes (id, workspace_id, title, title_source, created_by, created_at, updated_at)
    VALUES (gen_random_uuid(), ${workspaceId}, ${title}, 'manual', ${userId},
            (${dateKey}::date::timestamp + interval '12 hours') AT TIME ZONE ${outsideZone!}::text,
            (${dateKey}::date::timestamp + interval '12 hours') AT TIME ZONE ${outsideZone!}::text)
  `;
  await setZone(outsideZone!);
  await sql`SELECT public.astella_enqueue_companion_daily_summaries()`;
  assert.equal(await jobCount(dateKey), 0,
    `本地 ${localHour(outsideZone!)} 点在 01:00–06:59 之外，不该入队`);
  await sql`DELETE FROM notes WHERE workspace_id = ${workspaceId} AND title = ${title}`;
});

test("暂停不积累任务；恢复后只取重新开启之后的材料", async () => {
  const dateKey = await yesterdayLocal(widenedZone!);
  await setZone(widenedZone!);
  await sql`UPDATE user_companion_account_state SET diary_enabled = false, diary_enabled_since = NULL WHERE user_id = ${userId}`;
  await sql`SELECT public.astella_enqueue_companion_daily_summaries()`;
  assert.equal(await jobCount(dateKey), 0, "日记关闭时不排队，即使当天原本有活动");

  // 现有公共夹具在昨天正午；模拟当天 18:00 恢复，旧材料不应补成日记。
  await sql`
    UPDATE user_companion_account_state
    SET diary_enabled = true,
        diary_enabled_since = (${dateKey}::date::timestamp + interval '18 hours') AT TIME ZONE ${widenedZone!}::text
    WHERE user_id = ${userId}
  `;
  await sql`SELECT public.astella_enqueue_companion_daily_summaries()`;
  assert.equal(await jobCount(dateKey), 0, "暂停前的正午材料不得在恢复后补写");

  const title = `diary-after-resume-${prefix}`;
  await sql`
    INSERT INTO notes (id, workspace_id, title, title_source, created_by, created_at, updated_at)
    VALUES (gen_random_uuid(), ${workspaceId}, ${title}, 'manual', ${userId},
            (${dateKey}::date::timestamp + interval '20 hours') AT TIME ZONE ${widenedZone!}::text,
            (${dateKey}::date::timestamp + interval '20 hours') AT TIME ZONE ${widenedZone!}::text)
  `;
  await sql`SELECT public.astella_enqueue_companion_daily_summaries()`;
  assert.equal(await jobCount(dateKey), 1, "恢复后产生的材料仍可用于日记");
  await sql`DELETE FROM jobs WHERE workspace_id = ${workspaceId} AND idempotency_key = ${`daily-summary:${workspaceId}:${userId}:${dateKey}`}`;
  await sql`DELETE FROM notes WHERE workspace_id = ${workspaceId} AND title = ${title}`;
  // 后续用例重新设定明确的活跃期起点，避免受模拟暂停时间影响。
  await sql`
    UPDATE user_companion_account_state
    SET diary_enabled_since = (${dateKey}::date::timestamp) AT TIME ZONE ${widenedZone!}::text
    WHERE user_id = ${userId}
  `;
});

test("恢复：只检查最近结束的本地日，不回填更早日期", async () => {
  await setZone(widenedZone!);
  const d2 = (await sql`
    SELECT to_char((now() AT TIME ZONE ${widenedZone!}::text)::date - 2, 'YYYY-MM-DD') AS d`)[0].d;
  const d2Key = String(d2);
  const y = await yesterdayLocal(widenedZone!);      // 昨天
  await sql`
    UPDATE user_companion_account_state
    SET diary_enabled = true,
        diary_enabled_since = (${y}::date::timestamp) AT TIME ZONE ${widenedZone!}::text
    WHERE user_id = ${userId}
  `;

  // 昨天已有公共夹具；额外放一条前天材料，确认恢复不会回填它。
  await sql`
    INSERT INTO notes (id, workspace_id, title, title_source, created_by, created_at, updated_at)
    VALUES (gen_random_uuid(), ${workspaceId}, ${`diary-older-${prefix}`}, 'manual', ${userId},
            (${d2Key}::date::timestamp + interval '12 hours') AT TIME ZONE ${widenedZone!}::text,
            (${d2Key}::date::timestamp + interval '12 hours') AT TIME ZONE ${widenedZone!}::text)`;

  await sql`SELECT public.astella_enqueue_companion_daily_summaries()`;
  assert.equal(await jobCount(y), 1, "最近结束的本地日有材料，应排一篇");
  assert.equal(await jobCount(d2Key), 0, "更早日期不能因服务恢复被批量回填");

  // 幂等：反复 tick 不得重复投最近一天，也不得补旧日期。
  await sql`SELECT public.astella_enqueue_companion_daily_summaries()`;
  await sql`SELECT public.astella_enqueue_companion_daily_summaries()`;
  assert.equal(await jobCount(y), 1, "重复 tick 仍只有一条 job（幂等键兜住）");
  assert.equal(await jobCount(d2Key), 0);
});

/**
 * 0329 一并修掉的**自喂**：函数投出去的那条 job，`scheduled_at` 就是 now()，
 * 会落进另一个日期的窗口，于是那一天被当成"当天有活动"又被投一条——
 * 库里就多出一条根本不存在的日记。
 *
 * 实测：没有排除自身时三次调用的结果是 `1 → 1 → 0`，而 jobs 表里是 **2 条**。
 * 语义上也该排除：日记 job 是这个函数的产物，不是用户活动。
 */
test("不自喂：活动判据必须排除日记 job 自己", async () => {
  // 上一版这条是**行为**断言（三次 tick 不得多出 job），但那样抓不住：
  // 自喂只在**特定钟点**发生——刚投出的 job 的 `scheduled_at` 落进目标日期窗口时才触发。
  //
  // 所以这里改成**结构**断言：判据必须显式排除 `companion_daily_summary`。
  // 行为侧仍然另跑三次 tick 做回归兜底，但不再指望它守住这一条。
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { join } = await import("node:path");
  const migration = readFileSync(
    join(fileURLToPath(import.meta.url), "..", "..", "db", "migrations", "0333_companion_diary_pause_cutoff.sql"),
    "utf8",
  );
  assert.ok(
    /type\s*<>\s*'companion_daily_summary'/.test(migration),
    "当前调度函数没有排除 companion_daily_summary，自身 job 不能成为用户活动素材",
  );

  // 行为侧兜底：在当前钟点下反复 tick 不得让条数增长超过 1
  await setZone(widenedZone!);
  const countAll = async () => {
    const rows = await sql`
      SELECT count(*)::int n FROM jobs
      WHERE workspace_id = ${workspaceId} AND requested_by = ${userId}
        AND type = 'companion_daily_summary'`;
    return rows[0]?.n ?? -1;
  };
  const before = await countAll();
  await sql`SELECT public.astella_enqueue_companion_daily_summaries()`;
  await sql`SELECT public.astella_enqueue_companion_daily_summaries()`;
  await sql`SELECT public.astella_enqueue_companion_daily_summaries()`;
  assert.ok((await countAll()) - before <= 1,
    "三次 tick 新增了多于一条日记 job——函数在喂自己");
});

test("窗口内（本地 2–6 点）：首次 tick 入队，之后的 tick 靠幂等键不再重复", async () => {
  await setZone(widenedZone!);
  const dateKey = await yesterdayLocal(widenedZone!);
  await sql`
    UPDATE user_companion_account_state
    SET diary_enabled = true,
        diary_enabled_since = (${dateKey}::date::timestamp) AT TIME ZONE ${widenedZone!}::text
    WHERE user_id = ${userId}
  `;
  await sql`SELECT public.astella_enqueue_companion_daily_summaries()`;
  assert.equal(await jobCount(dateKey), 1, "旧代码只认本地 1 点，2–6 点这一段必须也入队");

  // 放宽窗口的全部风险都在这一句：01:00 投过之后 02:00–06:59 每个 tick 都会再跑到这里。
  await sql`SELECT public.astella_enqueue_companion_daily_summaries()`;
  await sql`SELECT public.astella_enqueue_companion_daily_summaries()`;
  assert.equal(await jobCount(dateKey), 1, "同一本地日反复 tick 仍只有一条 job（幂等键兜住）");
});

/**
 * 本地日窗口的类型陷阱（0251 一并修掉的那半）。
 *
 * `d::date AT TIME ZONE tz` 在 Postgres 里得到的是 **timestamp without time zone**
 * （先把 date 按会话时区升成 timestamptz，再折算成该时区的墙上时间），
 * 与 timestamptz 列比较时又被按会话时区读回去 —— 整个窗口平移一个时区差，
 * 于是"09-20 的日记"讲的是 09-20 16:00 到 09-21 16:00。
 * 正确写法 `d::date::timestamp AT TIME ZONE tz` 才是"该地零点的那一刻"。
 */
test("本地日窗口：边界必须是 timestamptz，且上海时区的 09-20 从 UTC 16:00 起算", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { join } = await import("node:path");
  const migration = readFileSync(
    join(fileURLToPath(import.meta.url), "..", "..", "db", "migrations", "0333_companion_diary_pause_cutoff.sql"),
    "utf8",
  );
  assert.match(migration, /local_date::date::timestamp AT TIME ZONE tz/,
    "真实 scheduler 必须用本地日期墙上零点构造 timestamptz 边界");
  assert.doesNotMatch(migration, /local_date::date AT TIME ZONE tz/,
    "date 直接 AT TIME ZONE 会按会话时区先转换，导致窗口错位");

  const rows = await sql`
    SELECT pg_typeof(('2026-09-20'::date::timestamp AT TIME ZONE 'Asia/Shanghai'))::text right_type,
           pg_typeof(('2026-09-20'::date AT TIME ZONE 'Asia/Shanghai'))::text wrong_type,
           to_char(('2026-09-20'::date::timestamp AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') right_start,
           to_char(('2026-09-20'::date AT TIME ZONE 'Asia/Shanghai'), 'YYYY-MM-DD HH24:MI') wrong_start
  `;
  const row = rows[0];
  assert.equal(row.right_type, "timestamp with time zone");
  assert.equal(row.wrong_type, "timestamp without time zone",
    "date 直接 AT TIME ZONE 得到的是无时区值——这正是平移的来源");
  assert.equal(row.right_start, "2026-09-19 16:00", `窗口起点错：${row.right_start}`);
  assert.notEqual(row.right_start, row.wrong_start, "两种写法必须给出不同的窗口，否则这条断言是空的");
});
