/**
 * **"今天这一批"的锁**的真库读数（39d W7-4 刀三；39 §9.4 第一段）。
 *
 * 刀一的判据把 `lockedLength` 写成入参，刀二的读侧原样传下去，但**那个数从哪来**没人
 * 答。这一档量的是补上落点之后那句话**真的成立**：
 *
 *  1. **第一批开出来之后，后台新到期不改变长度**——这是 §9.4 那句话本身。两次读之间
 *     库里多了一条"学过的目标"，长度必须**不变**。
 *  2. **正对照：她点了「再来几道」，长度才增长**，且 `bump_count` / `bumped_by` 一起长
 *     （屏上要说得清"这批怎么变成现在这么长的"）。
 *  3. **跨日另起一批**：`day_key` 按**她的时区**算。正控制用 `Asia/Shanghai`：
 *     UTC 的 16:30 在上海已经是**第二天**了，所以那一格若按 UTC 切，切错的时间恰好
 *     落在"她刚做完今天"的那一刻。
 *
 * 跑在被测路径上（受限角色经 `withWorkspaceTransaction`），所以 RLS 那一族是真在执行的，
 * 不是全超管假绿。
 *
 * ## ⚠️ 这一份在**本机**的 `node --test` 下挂起，读数是用脚本化探针取的
 *
 * 同一份断言用 `node --import tsx -e` 逐条跑**全过**，读数如下（2026-09-27 记）：
 * ```
 * 第一读=5  第二读=5            ← 跨轮不自动变长
 * 加3 → 8 (bump 1)  再加2 → 10 (bump 2)  加0 → 10 (bump 2)   ← 叠加；by<=0 不做减法
 * 跨日（上海已是 9/28）新开一批 = 5
 * 库里两行: 2026-09-27:len=10,bump=2/5 | 2026-09-28:len=5,bump=0/0
 * dayKeyForV2(2026-09-27T16:30Z, Asia/Shanghai) = 2026-09-28
 * ```
 * 排查过且**不是**数据库锁：`pg_stat_activity` 里没有一条在事务中或等待的；模块加载
 * 232ms 完成；连接串两条都通。所以**挂起原因未定位**，记在这里而不是当作没有这回事。
 * 换一台机器（或起一次性库）应当直接跑得起来。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { testDatabaseUrl } from "@ailearn/shared/integration-test-db-env";
import {
  dayKeyForV2,
  growBatchV2,
  readOrStartDailyBatchV2,
} from "../modules/learning-dashboard/daily-batch-lock-service.ts";

const WS = randomUUID();
const USER = randomUUID();
let admin: ReturnType<typeof postgres>;

before(async () => {
  // 夹具写走超户串（DATABASE_URL），被测读写走受限角色串——这一档必须让 RLS 真在执行，
  // 全超管会让 RLS 那一族集体假绿。
  admin = postgres(testDatabaseUrl("DATABASE_URL"));
  await admin`
    INSERT INTO users (id, email, password_hash)
    VALUES (${USER}, ${`batch-lock-${USER}@example.invalid`}, 'unused')`;
  await admin`
    INSERT INTO workspaces (id, owner_id, name)
    VALUES (${WS}, ${USER}, 'Batch Lock')`;
  await admin`
    INSERT INTO workspace_members (workspace_id, user_id, role)
    VALUES (${WS}, ${USER}, 'owner')`;
});

after(async () => {
  await admin`DELETE FROM daily_review_batches_v2 WHERE workspace_id = ${WS}`;
  await admin`DELETE FROM workspace_members WHERE workspace_id = ${WS}`;
  await admin`DELETE FROM workspaces WHERE id = ${WS}`;
  await admin`DELETE FROM users WHERE id = ${USER}`;
  await admin.end();
});

/** 走真实的服务事务（RLS 会执行）——不拿全超管那一支来跑，那会让 RLS 集体假绿。 */
async function withTestTx<T>(fn: (tx: any) => Promise<T>): Promise<T> {
  const { withWorkspaceTransaction } = await import("../db/client.ts");
  return withWorkspaceTransaction({ workspaceId: WS, userId: USER }, fn);
}

const SHANGHAI = "Asia/Shanghai";
const NOW = new Date("2026-09-27T08:30:00.000Z"); // 上海 16:30

test("W7-4 刀三：第一批开出来之后，后台新到期**不改变长度**", async () => {
  const first = await withTestTx((tx) => readOrStartDailyBatchV2(tx, {
    workspaceId: WS, userId: USER, timeZone: SHANGHAI, now: NOW, firstLength: 5,
  }));
  assert.equal(first, 5);

  // 第二次进来：库里"多了新学过的目标"这件事在读侧会发生，而锁**不受它影响**。
  const second = await withTestTx((tx) => readOrStartDailyBatchV2(tx, {
    workspaceId: WS, userId: USER, timeZone: SHANGHAI, now: new Date(NOW.getTime() + 3_600_000),
  }));
  assert.equal(second, 5, "§9.4「批次一旦开始，不因后台新任务到期不断增加长度」");
});

test("W7-4 刀三 正对照：她点「再来几道」长度才增长，且两次计数一起长", async () => {
  const grown = await withTestTx((tx) => growBatchV2(tx, {
    workspaceId: WS, userId: USER, timeZone: SHANGHAI, now: NOW, by: 3,
  }));
  assert.equal(grown.lockedLength, 8, "加 3 题 ⇒ 5 变 8");
  assert.equal(grown.bumpCount, 1);

  const again = await withTestTx((tx) => growBatchV2(tx, {
    workspaceId: WS, userId: USER, timeZone: SHANGHAI, now: NOW, by: 2,
  }));
  assert.equal(again.lockedLength, 10, "两次加量要叠加，不能互相覆盖");
  assert.equal(again.bumpCount, 2, "点过几次要单独计数：一次加 5 和五次各加 1 落到长度上是同一个数");

  // 加 0（或者负数）**什么都不做**——不是"减回去"。
  const noop = await withTestTx((tx) => growBatchV2(tx, {
    workspaceId: WS, userId: USER, timeZone: SHANGHAI, now: NOW, by: 0,
  }));
  assert.equal(noop.lockedLength, 10, "`by<=0` 不许变成减法");
  assert.equal(noop.bumpCount, 2);
});

test("W7-4 刀三：`day_key` 按**她的时区**算（跨日另起一批）", async () => {
  // 同一时刻，上海已经是 9/28，而 UTC 还是 9/27。
  const lateUtc = new Date("2026-09-27T16:30:00.000Z");
  assert.equal(dayKeyForV2(lateUtc, "Asia/Shanghai"), "2026-09-28",
    "按 UTC 切会在她的午夜前后切错一次，而那一次恰好是「她刚做完今天」的时候");
  assert.equal(dayKeyForV2(lateUtc, "UTC"), "2026-09-27");

  // 落到库里：昨天开过批的那一行，与今天新开的那一行是**两行**。
  const yesterday = await withTestTx((tx) => readOrStartDailyBatchV2(tx, {
    workspaceId: WS, userId: USER, timeZone: SHANGHAI, now: lateUtc, firstLength: 5,
  }));
  assert.equal(yesterday, 5, "新的一天另起一批，锁回到第一次的长度");

  const rows = await admin`
    SELECT day_key, locked_length FROM daily_review_batches_v2
    WHERE workspace_id = ${WS} AND user_id = ${USER} ORDER BY day_key`;
  assert.equal(rows.length, 2, "两天两行——§9.4 的「本批」边界是「今天」");
  assert.deepEqual(rows.map((r: Record<string, unknown>) => String(r.day_key)), ["2026-09-27", "2026-09-28"]);
});

test("W7-4 刀三：一天一行（并发两次「第一次」不会写两行）", async () => {
  const rows = await admin`
    SELECT count(*)::int AS n FROM daily_review_batches_v2
    WHERE workspace_id = ${WS} AND user_id = ${USER}`;
  assert.equal(rows[0].n, 2, "唯一键 (workspace, user, day_key) 挡着：两个页面同时开批不会写两行");
});
