/**
 * 「先看笔记」那一发（39d W5-4；PRD §7.1、§16.24、§14.1.1）。
 *
 * ## 它是一次**暴露**，不是一次导航
 *
 * §7.1：「用户仍可主动选择「先看笔记」，**系统随后如实按本次暴露条件处理**」。
 * 「随后」那半句的落点就是这里：用户点了那颗按钮之后，这一行必须落进
 * `learning_exposures_v2`，否则"随后"就是一句空话，而 §14.1.1 的界
 * （以**回答锁定先后**为准）会把这一次算成独立提取——那与用户实际做过的事不符。
 *
 * ## 落哪一档
 *
 * **`answer_reveal`**（不是 `evidence_reveal`）。理由：用户读到的是**来源笔记正文**，
 * 而目标的答案就是从那份正文里冻结出来的（`persistRoundTarget` 的
 * `evidence_snapshots_v2` 全部指向本轮快照的块）。同一条链上，
 * 轮次教学一落库就已经记 `answer_reveal`（`round-target.ts:141-144`）——
 * **同一份材料、同一档**，两处不一致就等于「先看笔记」这一档被静默降级成线索级。
 *
 * ## 三条边界写在服务里
 *
 *  1. **幂等**：同一次等待里重复点那颗按钮只记一笔（`idempotency_key` 唯一），
 *     重放回**既有那笔**的 id——报冲突会让用户以为没记上。
 *  2. **只写这一行**：零 insert 到学习观察、零改排期。§9.2「三种事实分别记录」：
 *     这次是**暴露**，不是学习，也不是调度。
 *  3. **等待态这一段还没有 run**，所以这里不要求 runId；之后那一场的规划期闸
 *     （`target-snapshot-adapter.ts` 的 `RECENT_REVEAL_WINDOW_MS`）会读到这一行，
 *     如实把那一轮的条件上限压到 `practice_only`。**这里不新造第二道闸。**
 */
import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { ApiTransaction } from "../../db/client.ts";
import { learningExposuresV2 } from "@ailearn/shared/db-schema/card-generation-v2";
import { computeExposureScopeIdV2 } from "@ailearn/shared/card-generation-v2-hashing";
import {
  recordRecallSourceRevealRequestV1Schema,
  recordRecallSourceRevealResultV1Schema,
  type RecordRecallSourceRevealResultV1,
} from "@ailearn/shared/recall-waiting-v2-contracts";
import { RECALL_REVEAL_COPY_V1 } from "@ailearn/shared/recall-waiting-v2-contracts";
import { DomainError } from "@ailearn/shared";

export class RecallRevealError extends DomainError {
  constructor(code: string, message: string, status = 400) {
    super({ name: "RecallRevealError", code, message, statusCode: status });
  }
}

export async function recordRecallSourceRevealV2(
  tx: ApiTransaction,
  scope: { workspaceId: string; userId: string },
  request: unknown,
): Promise<RecordRecallSourceRevealResultV1> {
  const parsed = recordRecallSourceRevealRequestV1Schema.safeParse(request);
  if (!parsed.success) {
    throw new RecallRevealError("invalid_request", "「先看笔记」这一发需要的字段不对");
  }
  const { objectiveId, waitingKind, idempotencyKey } = parsed.data;

  // **幂等键带上空间与用户**：`learning_exposures_v2` 的唯一约束是
  // `(workspace_id, user_id, idempotency_key)`，而客户端给的键本身可能很短，
  // 不加前缀会让两个目标撞上同一把键——那会把另一次揭示吞成"已记录"。
  const scopedKey = `recall-source-reveal:${scope.workspaceId}:${scope.userId}:${idempotencyKey}`;
  const inserted = await tx.insert(learningExposuresV2).values({
    workspaceId: scope.workspaceId,
    exposureId: randomUUID(),
    userId: scope.userId,
    objectiveId,
    objectiveRevision: 0,
    cardId: null,
    cardRevision: null,
    // 读的是来源正文，答案就在那份正文里 ⇒ 答案级（理由见文件头）。
    exposureKind: "answer_reveal",
    contextHash: computeExposureScopeIdV2({ workspaceId: scope.workspaceId, objectiveId }),
    idempotencyKey: scopedKey,
  }).onConflictDoNothing().returning({ exposureId: learningExposuresV2.exposureId, exposedAt: learningExposuresV2.exposedAt });

  // 撞了唯一键 ⇒ 那一笔一定在（同一发事务或更早），取回来的是**它**的 id 与时刻，
  // 不是编的。`exposedAt` 原样取回而不是 `now`：重复点按钮不该把"第一次看的时间"
  // 往后挪（§9.2 三种事实分开记，这一笔是暴露，时刻就是暴露那一刻）。
  const existing = inserted[0] ?? (await tx
    .select({ exposureId: learningExposuresV2.exposureId, exposedAt: learningExposuresV2.exposedAt })
    .from(learningExposuresV2)
    .where(and(
      eq(learningExposuresV2.workspaceId, scope.workspaceId),
      eq(learningExposuresV2.userId, scope.userId),
      eq(learningExposuresV2.idempotencyKey, scopedKey),
    ))
    .limit(1))[0];
  if (!existing) throw new RecallRevealError("exposure_not_recorded", "这一笔暴露没能记上", 500);

  return recordRecallSourceRevealResultV1Schema.parse({
    version: 1,
    exposureId: existing.exposureId,
    objectiveId,
    exposedAt: existing.exposedAt.toISOString(),
    alreadyRecorded: inserted.length === 0,
    // §7.1「如实按本次暴露条件处理」：说清条件上限，**不**在这里下"这一次不算独立"
    // 的判决——那是 §14.1.1 按锁定先后在评估期做的事。
    conditionsAfter: "practice_only",
    userFacingLabel: RECALL_REVEAL_COPY_V1.recorded(waitingKind),
  });
}

/** 只读：这一发不改排期、不改目标、不写任何学习观察（§9.2）。 */
export const RECALL_REVEAL_READS_ONLY_TABLES_V1 = sql`learning_exposures_v2`;
