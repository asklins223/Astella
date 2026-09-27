/**
 * **"今天这一批"的锁**（39d W7-4 刀三；39 §9.4 第一段）。
 *
 * ## 这一刀补的是刀一/刀二之间那个空的问句
 *
 * 刀一的判据把 `lockedLength` 写成**入参**，刀二的读侧原样传下去。但 **`lockedLength`
 * 从哪来**至今没人答——调用方（屏上、首页、伴星）每一次进来都会重算"今天该有多少道"，
 * 于是 §9.4「批次一旦开始，不因后台新任务到期不断增加长度」只在**单次调用内**成立，
 * 跨轮不成立。这一份是那个数唯一的出处。
 *
 * ## 跨日另起一批
 *
 * `dayKey` 按**她的时区**日历日算。§9.4 的"本批"边界是"今天"，而"今天"是她的日历
 * ——按 UTC 算会在她的午夜前后切错一次，而那一次恰好是"她刚做完今天"的时候。
 * 所以传 `timeZone` 而不在服务里猜（本项目不猜时区：§6.3 那一族的东西都带进来）。
 *
 * ## 加量的**唯一**入口
 *
 * `growBatchV2` 是这张表上唯一的 UPDATE 路径，且它**只加不减**、只在 `userAskedForMore`
 * 为正时动。§9.4「用户主动加量才加入新的任务」——后台新到期没有任何一条能走到这里。
 */
import { and, eq } from "drizzle-orm";
import { dailyReviewBatchesV2 } from "@ailearn/shared/db-schema/evidence";
import { loadLimitedBatchV2 } from "./learning-batch-service.ts";
import type { LimitedBatchV2 } from "@ailearn/shared/limited-batch-v2";

/** 一批刚开头时的默认长度。§9.4 没有写死这个数，所以它是**参数**而不是常量。 */
export const DEFAULT_BATCH_LENGTH_V2 = 5;

export type ApiTx = Parameters<Parameters<typeof import("../../db/client.ts").withWorkspaceTransaction>[1]>[0];

/**
 * 她时区下的日历日。**按 UTC 取日期会在她的午夜前后切错一次**，而那一次恰好是
 * "她刚做完今天"的时候。
 */
export function dayKeyForV2(at: Date, timeZone: string): string {
  // `en-CA` 的 `toLocaleDateString` 输出 `YYYY-MM-DD`，是这几个 locale 里唯一不依赖
  // 手工拼装的（`en-US` 是 M/D/YYYY，`en-GB` 是 DD/MM/YYYY）。
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

/**
 * 读今天的锁；今天还没有��就**第一次**落一行，长度取 `firstLength`。
 *
 * 并发下两个调用同时"第一次"不会写两行——唯一键 `(workspace, user, day_key)` 挡着，
 * 冲突的那一发重读一次。
 */
export async function readOrStartDailyBatchV2(
  tx: ApiTx,
  input: {
    workspaceId: string;
    userId: string;
    timeZone: string;
    now: Date;
    /** 今天第一次开批时的长度（§9.4 没写死，所以是参数）。 */
    firstLength?: number;
  },
): Promise<number> {
  const dayKey = dayKeyForV2(input.now, input.timeZone);
  const existing = await tx
    .select({ lockedLength: dailyReviewBatchesV2.lockedLength })
    .from(dailyReviewBatchesV2)
    .where(and(
      eq(dailyReviewBatchesV2.workspaceId, input.workspaceId),
      eq(dailyReviewBatchesV2.userId, input.userId),
      eq(dailyReviewBatchesV2.dayKey, dayKey),
    ))
    .limit(1);
  if (existing[0]) return existing[0].lockedLength;

  const firstLength = Math.max(0, input.firstLength ?? DEFAULT_BATCH_LENGTH_V2);
  const inserted = await tx
    .insert(dailyReviewBatchesV2)
    .values({
      workspaceId: input.workspaceId,
      userId: input.userId,
      dayKey,
      lockedLength: firstLength,
      bumpCount: 0,
      bumpedBy: 0,
    })
    .onConflictDoNothing()
    .returning({ lockedLength: dailyReviewBatchesV2.lockedLength });
  if (inserted[0]) return inserted[0].lockedLength;
  // 冲突：别人刚开。**重读而不是猜**——猜出来的长度会让两个页面看到不同的一批。
  const raced = await tx
    .select({ lockedLength: dailyReviewBatchesV2.lockedLength })
    .from(dailyReviewBatchesV2)
    .where(and(
      eq(dailyReviewBatchesV2.workspaceId, input.workspaceId),
      eq(dailyReviewBatchesV2.userId, input.userId),
      eq(dailyReviewBatchesV2.dayKey, dayKey),
    ))
    .limit(1);
  if (!raced[0]) {
    throw new Error(`daily batch lock raced twice and vanished (ws=${input.workspaceId}, day=${dayKey})`);
  }
  return raced[0].lockedLength;
}

/**
 * 她点了「再来几道」。**这是这张表上唯一的 UPDATE 路径**，而且只加不减。
 *
 * §9.4「用户主动加量才加入新的任务」——后台新到期没有任何一条能走到这里。若这一发
 * 变成"重算今天该有多少道"，那 §9.4 那句话就整个失效了。
 */
export async function growBatchV2(
  tx: ApiTx,
  input: {
    workspaceId: string;
    userId: string;
    timeZone: string;
    now: Date;
    /** 她点了「再来几道」加的题数。<= 0 时**什么都不做**（不是"减回去"）。 */
    by: number;
  },
): Promise<{ lockedLength: number; bumpCount: number }> {
  if (input.by <= 0) {
    const locked = await readOrStartDailyBatchV2(tx, { ...input });
    const row = await tx
      .select({ bumpCount: dailyReviewBatchesV2.bumpCount })
      .from(dailyReviewBatchesV2)
      .where(and(
        eq(dailyReviewBatchesV2.workspaceId, input.workspaceId),
        eq(dailyReviewBatchesV2.userId, input.userId),
        eq(dailyReviewBatchesV2.dayKey, dayKeyForV2(input.now, input.timeZone)),
      ))
      .limit(1);
    return { lockedLength: locked, bumpCount: row[0]?.bumpCount ?? 0 };
  }
  // 读—改—写放在一个事务里（调用方用 withWorkspaceTransaction）：并发两次「再来几道」
  // 都要加上，不能互相覆盖。
  const current = await readOrStartDailyBatchV2(tx, { ...input });
  const row = await tx
    .select({ id: dailyReviewBatchesV2.id, bumpCount: dailyReviewBatchesV2.bumpCount, bumpedBy: dailyReviewBatchesV2.bumpedBy })
    .from(dailyReviewBatchesV2)
    .where(and(
      eq(dailyReviewBatchesV2.workspaceId, input.workspaceId),
      eq(dailyReviewBatchesV2.userId, input.userId),
      eq(dailyReviewBatchesV2.dayKey, dayKeyForV2(input.now, input.timeZone)),
    ))
    .limit(1);
  const target = row[0];
  if (!target) {
    throw new Error(`daily batch lock vanished mid-grow (ws=${input.workspaceId})`);
  }
  const lockedLength = current + input.by;
  const updated = await tx
    .update(dailyReviewBatchesV2)
    .set({
      lockedLength,
      bumpCount: target.bumpCount + 1,
      bumpedBy: target.bumpedBy + input.by,
      updatedAt: input.now,
    })
    .where(eq(dailyReviewBatchesV2.id, target.id))
    .returning({ lockedLength: dailyReviewBatchesV2.lockedLength, bumpCount: dailyReviewBatchesV2.bumpCount });
  if (!updated[0]) {
    throw new Error(`daily batch lock update matched nothing (id=${target.id})`);
  }
  return updated[0];
}

/**
 * 「今天这一批」的**唯一**入口：读锁 → 把锁交给刀一的判据。
 *
 * 屏上、首页、伴星**都**走这一发，所以三个地方看到的是**同一批**（§9.4 那一段的
 * 前提是"这个列表"有明确的定义）。
 */
export async function todayLimitedBatchV2(
  tx: ApiTx,
  input: {
    workspaceId: string;
    userId: string;
    timeZone: string;
    now: Date;
    /** 她点了「再来几道」；透传给判据，那才是长度的唯一增长点。 */
    userAskedForMore?: number;
    firstLength?: number;
  },
): Promise<LimitedBatchV2> {
  const lockedLength = await readOrStartDailyBatchV2(tx, { ...input });
  return loadLimitedBatchV2(tx, {
    workspaceId: input.workspaceId,
    userId: input.userId,
    lockedLength,
    now: input.now,
    userAskedForMore: input.userAskedForMore,
  });
}
