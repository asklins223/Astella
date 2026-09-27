/**
 * 唯一调度边界：`review_schedules` 的**建立/关联**只有这一个入口
 * （39d W7-2 的前置；键的形状与理由在 39d-w02 D2 §3.1–§3.3，迁移 0287）。
 *
 * 改前的形状是四处 `insert(reviewSchedules)` 各自"先查后写"（D2 §1.1 量到的
 * `run-processing-tick.ts` 四条），而表上**没有任何**关于"待处理那一份唯一"的约束
 * ——先查后写没有并发保护，同一目标同一维度能安静长出第二条待办。0287 加了
 * `review_schedules_pending_subject_dim_unique`（部分唯一索引，`WHERE status='pending'`）
 * 之后，如果还留着裸 insert，症状只会从"多一条安排"变成"一次 23505"——那更糟。
 * 所以加索引与收边界必须同一批。
 *
 * 撞上已有安排时的语义是**关联而不是失败**：交回库里那一条的真实 id 与**实际到期时间**。
 * 调用方（结算的 `scheduleImpact`）因此不会报出一个屏幕上不存在的日期——
 * W7-2 的判据原文就是"已有同目标安排显示沿用后的实际日期"。
 */
import { and, eq } from "drizzle-orm";
import { reviewSchedules } from "@ailearn/shared/db-schema/evidence";
import { withWorkspaceTransaction } from "../../db/client.ts";
import { liveHoldForObjectiveV2 } from "./objective-review-holds.ts";

// 与 run-processing-tick 同一份"事务句柄"写法：从 withWorkspaceTransaction 的回调签名里取，
// 不在第二处手写它的形状。
type ReviewScheduleTx = Parameters<Parameters<typeof withWorkspaceTransaction>[1]>[0];

export interface EnsurePendingReviewScheduleV2Input {
  readonly workspaceId: string;
  readonly userId: string;
  /** 可确认的目标 id（`subject_type` 恒为 `'card'`，所以键里不放它——D2 §3.2 第 1 条）。 */
  readonly subjectId: string;
  /** 观察维度；缺省 = 空串（这一档照样参与唯一性，所以列不可空）。 */
  readonly reviewDimension?: string;
  readonly nextReviewAt: Date;
  readonly intervalDays: number;
  readonly generation: number;
  readonly policyVersion: string;
  readonly reasonCode: string;
  readonly supersedesScheduleId?: string | null;
  readonly at: Date;
  /**
   * 0297（W5-4 刀一）：「仅提醒这一次」还是「持续安排复习」。缺省 = 持续。
   *
   * 这一格**只在新建时**写进去；撞上已有安排时以**库里那一条的档位**为准，不覆盖
   * （同 `nextReviewAt` 那条纪律）。理由是 §9.1 末段：两种来意共用同一把唯一键，是同一项
   * 记忆需求的两种授权档位；如果这里按"新来的这一发更具体"去覆盖，一位已经持续订阅的
   * 用户点一次「仅提醒这一次」就会把自己的订阅降级成一次性的，而界面上没有任何一句提示
   * 说过这件事。所以覆盖权留给用户显式改期/停订那两条命令，不给排期这一发。
   */
  readonly reminderKind?: "one_time" | "sustained";
}

export interface EnsurePendingReviewScheduleV2Result {
  readonly scheduleId: string | null;
  /** **库里那一条的实际到期时间**——复用别人的安排时不报自己算的那个。 */
  readonly nextReviewAt: Date | null;
  readonly created: boolean;
  /**
   * §9.1 行 2：这一发被本人那句"暂不安排"挡住了 ⇒ 库里**什么都没写**。
   *
   * 单列一个读数而不是塞进 `created: false`：`false` 今天的意思是"那一格已经排着了，
   * 把那条交回你"，与"根本不许排"是两件要对用户说不同的话的事。
   */
  readonly held: boolean;
  /**
   * 库里那一行**实际的**档位（0297）。新建时等于传进来的那个；复用时以那一行为准——
   * 调用方要能如实回答"她点的『仅提醒这一次』是不是真的变成一次性的"，而不是回自己
   * 算的那个（与 `nextReviewAt` 同一纪律）。
   */
  readonly reminderKind: "one_time" | "sustained";
}

/**
 * 插入这一目标这一维度的待处理安排；已经有一份就把它交回来。
 *
 * 不用 `ON CONFLICT (cols) DO UPDATE`：这里的语义不是"覆盖成新的到期时间"，
 * 而是"那一件事已经排着了"。也不带 target——部分唯一索引的推断写法在 drizzle 里
 * 要重复谓词，写错一次就退化成"什么冲突都不拦"；不写 target 的 `DO NOTHING`
 * 对任何唯一violations都成立，代价是多一次回读。
 *
 * **排除判在这里，不判在调用方**：这一发是 `review_schedules` 唯一的写入口，而 §9.1 那句
 * "在笔记订阅继续有效时也不自动加回来"管的就是所有自动排期——写在这里，将来再加入口
 * 也不会漏；写在调用方就是每个入口抄一遍，少抄一个就出现"这里排了那里没排"。
 */
export async function ensurePendingReviewScheduleV2(
  tx: ReviewScheduleTx,
  input: EnsurePendingReviewScheduleV2Input,
): Promise<EnsurePendingReviewScheduleV2Result> {
  const dimension = input.reviewDimension ?? "";
  const reminderKind = input.reminderKind ?? "sustained";
  const hold = await liveHoldForObjectiveV2(tx, {
    workspaceId: input.workspaceId,
    userId: input.userId,
    objectiveId: input.subjectId,
  });
  if (hold) {
    return { scheduleId: null, nextReviewAt: null, created: false, held: true, reminderKind };
  }
  const inserted = await tx
    .insert(reviewSchedules)
    .values({
      workspaceId: input.workspaceId,
      userId: input.userId,
      subjectType: "card",
      subjectId: input.subjectId,
      reviewDimension: dimension,
      reminderKind,
      status: "pending",
      nextReviewAt: input.nextReviewAt,
      intervalDays: input.intervalDays,
      generation: input.generation,
      supersedesScheduleId: input.supersedesScheduleId ?? null,
      policyVersion: input.policyVersion,
      reasonCode: input.reasonCode,
      createdAt: input.at,
      updatedAt: input.at,
    })
    .onConflictDoNothing()
    .returning({ id: reviewSchedules.id, nextReviewAt: reviewSchedules.nextReviewAt });
  if (inserted.length > 0) {
    return {
      scheduleId: inserted[0].id,
      nextReviewAt: inserted[0].nextReviewAt,
      created: true,
      held: false,
      reminderKind,
    };
  }
  const [existing] = await tx
    .select({
      id: reviewSchedules.id,
      nextReviewAt: reviewSchedules.nextReviewAt,
      reminderKind: reviewSchedules.reminderKind,
    })
    .from(reviewSchedules)
    .where(and(
      eq(reviewSchedules.workspaceId, input.workspaceId),
      eq(reviewSchedules.userId, input.userId),
      eq(reviewSchedules.subjectId, input.subjectId),
      eq(reviewSchedules.reviewDimension, dimension),
      eq(reviewSchedules.status, "pending"),
    ))
    .limit(1);
  // 走到这里说明那一格已被占（并发或重放）。回读不到就是索引之外的事——
  // 不猜一个 id 交出去。
  if (!existing) {
    throw new Error(
      `review schedule 唯一冲突之后回读不到那一条（subject=${input.subjectId}, dimension=${dimension || "''"}）`,
    );
  }
  return {
    scheduleId: existing.id,
    nextReviewAt: existing.nextReviewAt,
    created: false,
    held: false,
    // 复用时以库里那一行为准，**不**用这一发传进来的档位（见入参注释第 4 段）。
    reminderKind: existing.reminderKind,
  };
}
