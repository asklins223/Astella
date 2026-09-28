/**
 * 动态产物**失败**的写侧与读侧（39d W4-6 刀五·失败侧；§16.4「动态交付失败记录保留」）。
 *
 * ## 这一刀解决的是哪一个验收句
 *
 * §16.4 三句验收里，后两句今天已经成立（"用户有效作答照常记录"——产物状态不参与结算；
 * "不强迫回头补播才能完成本轮"——`close` 不检查 artifact）。**第一句不成立**：失败只进
 * `req.log.error({ scope: "note-round-artifact" })`，进程一重启就没了，"这一版的动态讲解
 * 为什么没生成"事后读不到——而 §18.3 明确要求"内容可教学／动画成功／评分可判断"分别
 * 统计，前两件没有数据面就只能靠人回忆。
 *
 * ## 三条不变量（写在这个文件里，而不是散在调用方）
 *
 *  1. **失败不许冒充成功，也不许冒充教学失败**（D4 §6.2）。产物行（0285）只会有成功行；
 *     教学行照常落、`artifact_id` 留空。本表是**第三份东西**，不改那两者的任何一格。
 *  2. **失败不碰能力证据**。这个文件里没有任何一处引用 `learning_*` 那几张表——判据
 *     按源码形状钉住（`artifact-failure.test.ts`）。理由与 §9.2 相同：一次交付失败不是
 *     一次学习观察，把它算进去就会让"动态这一版没出来"影响这个目标的掌握结论。
 *  3. **重试不抹掉历史**。本表只追加，同一个 `teachingId` 上可以有多行：用户可以重试
 *     （§6.2「用户可重试」），每次失败都是一件独立的事。把它做成状态位，重试成功就会
 *     把原因抹掉，而"曾经失败过"正是排查与试用统计要的那一半。
 *
 * ## 为什么 `teachingId` 可空
 *
 * 产物在**教学行落库之前**构建（`round-service.ts` 的 `createTeaching` 先写产物、后写
 * 教学行，因为产物 id 要挂到教学行上）。所以 `build` 类失败发生时，那一行还不存在。
 * 留空而不是猜一个，读侧据此知道"这是一次没能归到具体讲解的失败"——那与"这一条讲解的
 * 动态版本没落库"是两句不同的话。
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { noteLearningRoundArtifactFailures } from "@ailearn/shared/db-schema/note-learning-rounds";
import type { ApiTransaction } from "../../db/client.ts";

export type RoundScopeV1 = { workspaceId: string; userId: string };

/** `build` 是内容本身的问题（换一次输入照样失败）；`generate` 是**真的发了一次模型调用**那一档。 */
export type ArtifactFailureStageV1 = "build" | "generate" | "persist";
/**
 * 与迁移 0298 建立、0304 拓宽之后的 `nlraf_stage_reason_chk` 同一组取值，一档也不许多
 * 也不许少。`generate` 那两档是 39d W4-1 尾加的：产物改由模型生成之后，失败多了一种形状
 * ——外部调用没成（`model_failed`）或回执说没达成完成判据（`contract_rejected`）。它们
 * **不能**塞回 `build` 的两档里：那是谎报（它不空、也没超配额），而"这一版为什么没生成"
 * 正是这张表存在的理由。
 */
export type ArtifactFailureReasonV1 =
  | "empty"
  | "over_quota"
  | "model_failed"
  | "contract_rejected"
  | "persist_failed";

/** 合法组合穷举表——写出来是为了让"新增一档"时编译器喊，而不是让库 CHECK 半夜拒一次。 */
export const ARTIFACT_FAILURE_COMBINATIONS_V1: Readonly<Record<ArtifactFailureStageV1, readonly ArtifactFailureReasonV1[]>> = {
  build: ["empty", "over_quota"],
  generate: ["model_failed", "contract_rejected"],
  persist: ["persist_failed"],
};

export function isArtifactFailureReasonV1(stage: ArtifactFailureStageV1, reason: string): reason is ArtifactFailureReasonV1 {
  return (ARTIFACT_FAILURE_COMBINATIONS_V1[stage] as readonly string[]).includes(reason);
}

/**
 * 记一次失败。
 *
 * `detail` 截到 500：它是**人读的那一句**，不是结构化日志；迁移的 CHECK 也是 500。
 * 截断要留一个"被截过"的痕迹（末尾加省略号）——否则两段不同的话会截成同一段，
 * 而读侧会以为那是原文。
 */
export async function recordArtifactFailureV1(
  tx: ApiTransaction,
  scope: RoundScopeV1,
  input: {
    roundId: string;
    /** 教学行已落库时传 id；`build` 类失败通常还没有（见文件头「为什么可空」）。 */
    teachingId?: string | null;
    stage: ArtifactFailureStageV1;
    reason: ArtifactFailureReasonV1;
    detail: string;
    snapshotHash: string;
    createdAt?: Date;
  },
): Promise<void> {
  if (!isArtifactFailureReasonV1(input.stage, input.reason)) {
    // 组合不合法时**抛**，不静默丢：那说明判据与迁移 0298 的 CHECK 脱钩了，
    // 而静默丢会让"这一版为什么没生成"永远查不到（正是这一刀要修的那个症状）。
    throw new Error(`artifact failure 组合不合法：stage=${input.stage} reason=${input.reason}`);
  }
  const raw = input.detail.trim();
  const detail = raw.length > 500 ? `${raw.slice(0, 499)}…` : raw;
  await tx.insert(noteLearningRoundArtifactFailures).values({
    workspaceId: scope.workspaceId,
    userId: scope.userId,
    roundId: input.roundId,
    teachingId: input.teachingId ?? null,
    stage: input.stage,
    reason: input.reason,
    detail,
    snapshotHash: input.snapshotHash,
    createdAt: input.createdAt ?? new Date(),
  });
}

export interface ArtifactFailureViewV1 {
  readonly stage: ArtifactFailureStageV1;
  readonly reason: ArtifactFailureReasonV1;
  readonly detail: string;
  readonly teachingId: string | null;
  /** 生成时刻那一版正文的哈希：材料变了正是 `over_quota` 的常见原因。 */
  readonly snapshotHash: string;
  readonly at: string;
}

/**
 * 这一轮最近一次产物失败（教学面那一格）。
 *
 * **最近一次而不是全部**：`build` 类失败归不到具体讲解，重试可能连着失败好几次；界面
 * 要回答的是"这一版的动态讲解为什么没打开"（§6.2），那一句对应的是最后一次。全量留给
 * 历史与分析那一层，不进教学面。
 */
export async function readLatestArtifactFailureV1(
  tx: ApiTransaction,
  scope: RoundScopeV1,
  roundId: string,
): Promise<ArtifactFailureViewV1 | null> {
  const rows = await tx
    .select({
      stage: noteLearningRoundArtifactFailures.stage,
      reason: noteLearningRoundArtifactFailures.reason,
      detail: noteLearningRoundArtifactFailures.detail,
      teachingId: noteLearningRoundArtifactFailures.teachingId,
      snapshotHash: noteLearningRoundArtifactFailures.snapshotHash,
      createdAt: noteLearningRoundArtifactFailures.createdAt,
    })
    .from(noteLearningRoundArtifactFailures)
    .where(and(
      eq(noteLearningRoundArtifactFailures.workspaceId, scope.workspaceId),
      eq(noteLearningRoundArtifactFailures.userId, scope.userId),
      eq(noteLearningRoundArtifactFailures.roundId, roundId),
    ))
    .orderBy(desc(noteLearningRoundArtifactFailures.createdAt), desc(noteLearningRoundArtifactFailures.id))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    stage: row.stage as ArtifactFailureStageV1,
    reason: row.reason as ArtifactFailureReasonV1,
    detail: row.detail,
    teachingId: row.teachingId,
    snapshotHash: row.snapshotHash,
    at: row.createdAt.toISOString(),
  };
}

/** 这一轮的失败次数（试用统计那一层：§18.3 把"动画成功"与"内容可教学"分开数）。 */
export async function countArtifactFailuresV1(
  tx: ApiTransaction,
  scope: RoundScopeV1,
  roundId: string,
): Promise<number> {
  const rows = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(noteLearningRoundArtifactFailures)
    .where(and(
      eq(noteLearningRoundArtifactFailures.workspaceId, scope.workspaceId),
      eq(noteLearningRoundArtifactFailures.userId, scope.userId),
      eq(noteLearningRoundArtifactFailures.roundId, roundId),
    ));
  return Number(rows[0]?.n ?? 0);
}
