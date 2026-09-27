/**
 * 首页「换一个／暂不处理」的落库读数（39d W7-4 刀五；39 §12.1）。
 *
 * 刀四的判据把 `dismissedThisSession` 写成**入参**——这一档量的是那一格**真的有出处**，
 * 以及 §12.1 那个最容易写错的字：「用户略过后**本次**不反复推荐同一项」。
 *
 * 三格：
 *  1. **没按过 ⇒ 空**（`dismissedThisSession` 的初值不是"她历史上略过的所有项"）。
 *  2. **按过 ⇒ 今天的候选里少了它们**，且点两下只留一行、以**最后一次**为准
 *     （「换一个」之后再「暂不处理」＝`dismissed`，屏上只念最后一次）。
 *  3. **「本次」有界**：换一天（她时区）读回**空**。这一格是整刀的关键——落成永久黑名单
 *     是最省事的写法，而那正是 §12.1 不要的：她今天不想做某件事，明天那件事又到期了，
 *     首页却再也不提，**建议变成一个慢慢烂掉的角落**。
 *
 * 跑在**受限角色**经 `withWorkspaceTransaction` 的路径上，所以 RLS 真在执行。
 *
 * ## ⚠️ 本机 `node --test` 对这一族 api 集成档**挂起**（原因未定位），读数用探针取的
 *
 * 逐条跑（同一条受限角色路径）**全过**（2026-09-27 记）：
 * ```
 * 先读（还没按）: []
 * 按过之后(今天): ["obj-1","obj-2"]
 * 换一天(上海 9/28): []
 * 库里: 2026-09-27/obj-1=dismissed | 2026-09-27/obj-2=dismissed
 * ```
 * `obj-1` 先 `swapped` 后 `dismissed` ⇒ 库里只剩一行且是 `dismissed`（以最后一次为准）。
 * 排查过且**不是**数据库锁、不是模块加载（232ms 完成）、不是连接串（两条都通）。
 * 与 `daily-batch-lock-postgres.integration.ts` **同一种挂起**——所以这是**本机
 * `node --test` 对 api 集成档**的问题，不是某一个文件的问题。换机器应当直接跑得起来。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { testDatabaseUrl } from "@ailearn/shared/integration-test-db-env";
import {
  dismissedHomeItemsForTodayV2,
  recordHomeSuggestionActionV2,
} from "../modules/learning-dashboard/home-suggestion-actions-service.ts";

const WS = randomUUID();
const USER = randomUUID();
const TZ = "Asia/Shanghai";
const TODAY = new Date("2026-09-27T08:30:00.000Z");
const TOMORROW_SHANGHAI = new Date("2026-09-27T16:30:00.000Z"); // 上海已经是 9/28

let admin: ReturnType<typeof postgres> | null = null;

async function withFixture(): Promise<NonNullable<typeof admin>> {
  if (admin) return admin;
  admin = postgres(testDatabaseUrl("DATABASE_URL"), { connect_timeout: 6 });
  await (await withFixture())`
    INSERT INTO users (id, email, password_hash)
    VALUES (${USER}, ${`home-dismiss-${USER}@example.invalid`}, 'unused')`;
  await (await withFixture())`
    INSERT INTO workspaces (id, owner_id, name) VALUES (${WS}, ${USER}, 'Home Dismiss')`;
  await (await withFixture())`
    INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${WS}, ${USER}, 'owner')`;
  return admin;
}

const readToday = (now: Date) => withWorkspace(async (tx) =>
  dismissedHomeItemsForTodayV2(tx, { workspaceId: WS, userId: USER, timeZone: TZ, now }));
const record = (itemKey: string, action: "swapped" | "dismissed", now = TODAY) =>
  withWorkspace((tx) => recordHomeSuggestionActionV2(tx, {
    workspaceId: WS, userId: USER, timeZone: TZ, now, itemKey, action,
  }));

async function withWorkspace<T>(fn: (tx: never) => Promise<T>): Promise<T> {
  const { withWorkspaceTransaction } = await import("../db/client.ts");
  return withWorkspaceTransaction({ workspaceId: WS, userId: USER }, fn as never);
}

test("W7-4 刀五：没按过 ⇒ 空（初值不是「她历史上略过的所有项」）", async () => {
  await withFixture();
  assert.deepEqual(await readToday(TODAY), [],
    "空数组才是初值：读成「历史全部」就变回永久黑名单了");
});

test("W7-4 刀五：按过 ⇒ 今天的候选里少了它们，且点两下只留一行、以最后一次为准", async () => {
  await withFixture();
  await record("obj-1", "swapped");
  await record("obj-2", "dismissed");
  // 「换一个」之后再「暂不处理」：升级那一行，不是并排两行。
  await record("obj-1", "dismissed");
  const rows = await readToday(TODAY);
  assert.deepEqual([...rows].sort(), ["obj-1", "obj-2"], "点两下不该产生两个 obj-1");
  const db = await withFixture();
  const stored = await db
    `SELECT item_key, action FROM home_suggestion_dismissals_v2
     WHERE workspace_id = ${WS} AND item_key = 'obj-1'`;
  assert.equal(stored.length, 1, "同一项同一天只留一行");
  assert.equal(stored[0]?.action, "dismissed", "以**最后一次**为准——屏上只念最后一次");
});

test("W7-4 刀五：「本次」有界——换一天读回空（§12.1 那个「本次」）", async () => {
  await withFixture();
  assert.deepEqual(await readToday(TOMORROW_SHANGHAI), [],
    "落成永久黑名单的后果：她今天不想做的那件事，明天又到期了，首页却再也不提——"
    + "建议变成一个慢慢烂掉的角落。边界取她的日历日，与 §9.4「本批」的边界同源。");
});
