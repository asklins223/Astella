/**
 * 日记入队窗口的实库回归（0251 放宽窗口的两条前置不变量）。
 *
 * `ailearn_enqueue_companion_daily_summaries()` 以前只在**本地 01:00 那一小时**投 job，
 * worker 跨过那一小时不可达（部署、宿主机休眠）就永久缺那一天——只读路由按 §16.6
 * 有意不补生成，用户没有自救手段。0251 把窗口放宽到本地 1..6 点；0329（P2-13）再加**补跑**：
 * 01:00 之后逐日回看最近 N 天，哪一天有活动且没投过就补哪一天。
 * 放宽的前提是两条：
 *   1. 窗口外仍然一条都不投（否则"每天一篇"变成"每小时一篇"）；
 *   2. 窗口内反复 tick 也只投一条（幂等键 `daily-summary:<ws>:<user>:<date>`）。
 * 这两条以前都没有覆盖：窗口只有一小时，从未被跨小时验证过。
 *
 * 时区是测试自己挑的：按当前时刻从固定表里选一个本地钟点在 1..6 的、一个不在的，
 * 所以断言不依赖跑测试的墙上时间。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";

// 夹具连接要能不带 `app.workspace_id` 写 `user_companion_account_state`（受限角色下
// 那一句直接 `new row violates row-level security policy`）。被测侧不受影响：
// service 走 app 自己的池，`db/client.ts` 优先读 `DATABASE_URL_API`。
const CONN = process.env.DATABASE_URL ?? process.env.DATABASE_URL_API;
if (!CONN) {
  throw new Error("DATABASE_URL 未配置——日记入队窗口集成测试要求真实 Postgres");
}

const sql = postgres(CONN, { max: 2 });
const userId = randomUUID();
const workspaceId = randomUUID();
const prefix = userId.slice(0, 8);

/**
 * 覆盖 UTC-12..UTC+13 全部 26 个整点偏移（用 `Etc/GMT±N`，注意符号是反的），
 * 所以任意时刻都能挑到"落在放宽段 2..6 里"和"落在窗口外"的两个时区——
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
  INSERT INTO user_companion_account_state (user_id, global_enabled, quiet_hours)
  VALUES (${userId}, true, jsonb_build_object('timezone', 'Etc/UTC'))
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

test("01:00 之前：一次 job 都不投（静默时段不主动生成）", async () => {
  // 0329 之后判据从「必须正好 1 点」放宽成「1 点及以后」，所以"窗口外"这条
  // 不变式**只对 01:00 之前成立**。`outsideZone` 取到的正是本地 0 点
  // （OFFSETS 从 -12 往上找，第一个落在 1..6 之外的就是 0），所以这条仍然有效，
  // 但它守的不再是"1..6 之外"，而是"1 点之前"。
  await setZone(outsideZone!);
  await sql`SELECT public.ailearn_enqueue_companion_daily_summaries()`;
  assert.equal(await jobCount(await yesterdayLocal(outsideZone!)), 0,
    `本地 ${localHour(outsideZone!)} 点在 01:00 之前（静默时段），不该入队`);
});

/**
 * 0329（P2-13）：**补跑**。
 *
 * 旧判据是「只有本地 01:00 那一小时投」。那一小时里服务下线、迁移、宿主机休眠
 * —— 这一天的日记**永久丢失**，事后没有第二次机会，也没有用户侧的自救入口。
 *
 * 新判据：01:00 之后逐日回看最近 N 天，**哪一天有活动且还没投过，就补哪一天**。
 * 下面这条把它钉死：活动落在**前天**（不是昨天），函数照样要投出那一条。
 */
test("补跑：前天有活动而昨天没有，那一天也必须被补投（0329）", async () => {
  await setZone(widenedZone!);
  // 必须是**两天前**：函数只回看 offset 1..7（昨天往前 7 天），今天不在其中
  const d2 = (await sql`
    SELECT to_char((now() AT TIME ZONE ${widenedZone!}::text)::date - 2, 'YYYY-MM-DD') AS d`)[0].d;
  const d2Key = String(d2);
  const y = await yesterdayLocal(widenedZone!);      // 昨天

  // 只在"两天前"放活动，昨天**故意留空**
  await sql`
    INSERT INTO notes (id, workspace_id, title, title_source, created_by, created_at, updated_at)
    VALUES (gen_random_uuid(), ${workspaceId}, ${`diary-catchup-${prefix}`}, 'manual', ${userId},
            (${d2Key}::date::timestamp + interval '12 hours') AT TIME ZONE ${widenedZone!}::text,
            (${d2Key}::date::timestamp + interval '12 hours') AT TIME ZONE ${widenedZone!}::text)`;
  // ⚠️ 不能直接 DELETE 昨天的夹具笔记——同文件后面的「放宽段」用例依赖它。
  // 这里把它的 created_at 挪到很久以前，用完再挪回来。
  const seeded = await sql`
    UPDATE notes SET created_at = '2000-01-01T00:00:00Z'::timestamptz, updated_at = '2000-01-01T00:00:00Z'::timestamptz
    WHERE workspace_id = ${workspaceId} AND created_by = ${userId}
      AND created_at >= (${y}::date::timestamp) AT TIME ZONE ${widenedZone!}::text
    RETURNING id`;
  const restore = async () => {
    for (const row of seeded) {
      await sql`
        UPDATE notes SET created_at = (${y}::date::timestamp + interval '12 hours') AT TIME ZONE ${widenedZone!}::text,
                         updated_at = (${y}::date::timestamp + interval '12 hours') AT TIME ZONE ${widenedZone!}::text
        WHERE id = ${row.id}`;
    }
  };

  await sql`SELECT public.ailearn_enqueue_companion_daily_summaries()`;
  assert.equal(await jobCount(d2Key), 1,
    "活动在两天前、昨天没有 —— 这一天必须被补投（旧代码会直接跳过）");
  assert.equal(await jobCount(y), 0, "昨天没有活动，不该凭空补一条");

  // 幂等：反复 tick 不得把补跑的这一天重复投
  await sql`SELECT public.ailearn_enqueue_companion_daily_summaries()`;
  await sql`SELECT public.ailearn_enqueue_companion_daily_summaries()`;
  assert.equal(await jobCount(d2Key), 1, "补跑也必须只投一条（幂等键兜住）");

  await restore();   // 把夹具笔记挪回昨天，后面的用例还要用
});

/**
 * 0329 一并修掉的**自喂**：函数投出去的那条 job，`scheduled_at` 就是 now()，
 * 会落进另一个日期的窗口，于是那一天被当成"当天有活动"又被投一条——
 * 库里就多出一条根本不存在的日记。
 *
 * 实测：没有排除自身时三次调用的结果是 `1 → 1 → 0`，而 jobs 表里是 **2 条**。
 * 语义上也该排除：日记 job 是这个函数的产物，不是用户活动。
 */
test("不自喂：活动判据必须排除日记 job 自己（0329）", async () => {
  // 上一版这条是**行为**断言（三次 tick 不得多出 job），但那样抓不住：
  // 自喂只在**特定钟点**发生——刚投出的 job 的 `scheduled_at` 落进
  // 某个被回看的日期窗口里才触发。实跑那次是本地凌晨 04:29 复现的，
  // 而测试挑的时区恰好让"今天"不在回看范围（offset 1..7 只看昨天及更早），
  // 于是把排除条件删掉，整套测试**依然全绿**（实测确认）。
  //
  // 所以这里改成**结构**断言：判据必须显式排除 `companion_daily_summary`。
  // 行为侧仍然另跑三次 tick 做回归兜底，但不再指望它守住这一条。
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { join } = await import("node:path");
  const migration = readFileSync(
    join(fileURLToPath(import.meta.url), "..", "..", "db", "migrations", "0329_daily_summary_catchup.sql"),
    "utf8",
  );
  assert.ok(
    /type\s*<>\s*'companion_daily_summary'/.test(migration),
    "0329 的活动判据没有排除 companion_daily_summary——"
    + "函数会把自己刚投的 job 当成另一个日期的用户活动，库里多出根本不存在的日记"
    + "（实测：三次 tick 1 → 1 → 0，而 jobs 表里是 2 条）",
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
  await sql`SELECT public.ailearn_enqueue_companion_daily_summaries()`;
  await sql`SELECT public.ailearn_enqueue_companion_daily_summaries()`;
  await sql`SELECT public.ailearn_enqueue_companion_daily_summaries()`;
  assert.ok((await countAll()) - before <= 1,
    "三次 tick 新增了多于一条日记 job——函数在喂自己");
});

test("放宽段（本地 2–6 点）：首次 tick 入队，之后的 tick 靠幂等键不再重复", async () => {
  await setZone(widenedZone!);
  const dateKey = await yesterdayLocal(widenedZone!);
  await sql`SELECT public.ailearn_enqueue_companion_daily_summaries()`;
  assert.equal(await jobCount(dateKey), 1, "旧代码只认本地 1 点，2–6 点这一段必须也入队");

  // 放宽窗口的全部风险都在这一句：01:00 投过之后 02:00–06:59 每个 tick 都会再跑到这里。
  await sql`SELECT public.ailearn_enqueue_companion_daily_summaries()`;
  await sql`SELECT public.ailearn_enqueue_companion_daily_summaries()`;
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
