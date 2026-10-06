import { REVIEW_DIMENSION_VALUES_V2 } from "@astella/shared/review-dimension-v2";
import { sql } from "drizzle-orm";
import {
  DISCRETE_V2_FIRST_INTERVAL_DAYS,
  DISCRETE_V2_POLICY_VERSION,
  discreteV2FirstDueAt,
} from "@astella/shared";
import type { ApiTransaction } from "../../db/client.ts";
import { readObjectiveNoteChangeImpactV1 } from "../learning-objectives/change-impact-service.ts";
import { ensurePendingReviewScheduleV2 } from "./review-schedule-boundary.ts";

/**
 * An explicit note subscription also covers targets the learner already met.
 * A prepared private target alone is not learning: require a committed teaching
 * for that question or a locked answer in a note-round run. New observations
 * are scheduled by the run settlement boundary; this fills the activation gap.
 */
export async function scheduleStudiedNoteTargetsV2(
  tx: ApiTransaction,
  input: { workspaceId: string; userId: string; noteId: string; at: Date },
): Promise<void> {
  const rows = await tx.execute(sql`
    SELECT DISTINCT target.objective_id
    FROM note_learning_round_targets AS target
    JOIN note_learning_rounds AS round ON round.id = target.round_id
      AND round.workspace_id = target.workspace_id AND round.user_id = target.user_id
    JOIN learning_objectives_v2 AS objective ON objective.objective_id = target.objective_id
      AND objective.workspace_id = target.workspace_id AND objective.lifecycle = 'active'
    WHERE target.workspace_id = ${input.workspaceId}
      AND target.user_id = ${input.userId}
      AND round.note_id = ${input.noteId}
      AND (
        EXISTS (
          SELECT 1 FROM note_learning_round_teachings AS teaching
          WHERE teaching.workspace_id = target.workspace_id
            AND teaching.user_id = target.user_id
            AND teaching.round_id = target.round_id
            AND teaching.driving_question_revision = target.driving_question_revision
        )
        OR EXISTS (
          SELECT 1 FROM learning_runs AS run
          JOIN learning_artifacts AS answer ON answer.run_id = run.id
            AND answer.workspace_id = run.workspace_id
            AND answer.user_id = run.user_id
            AND answer.status = 'locked'
          WHERE run.workspace_id = target.workspace_id
            AND run.user_id = target.user_id
            AND run.origin ->> 'kind' = 'note_round'
            AND run.origin ->> 'roundId' = target.round_id::text
            AND run.origin ->> 'keyPointId' = target.objective_id::text
        )
      )
    ORDER BY target.objective_id
  `);
  for (const row of rows) {
    const objectiveId = String(row.objective_id);
    const impact = await readObjectiveNoteChangeImpactV1(tx, input, objectiveId, {
      lockSourceNotes: true,
      includeUnchanged: true,
    });
    if (impact?.status !== "unaffected") continue;
    await ensurePendingReviewScheduleV2(tx, {
      workspaceId: input.workspaceId,
      userId: input.userId,
      subjectId: objectiveId,
      // §9.1 事实提取与综合应用分别观察。这里落 recall：§9.1「首次回访从一个核心
      // 问题或**结构回忆**开始」——结构回忆就是提取。它与随后某次结算的 recall
      // 落在同一格，0287 那把唯一索引会把两者合成一条，不会多出一条。
      reviewDimension: REVIEW_DIMENSION_VALUES_V2[0],
      reminderKind: "sustained",
      nextReviewAt: discreteV2FirstDueAt(input.at),
      intervalDays: DISCRETE_V2_FIRST_INTERVAL_DAYS,
      generation: 1,
      policyVersion: DISCRETE_V2_POLICY_VERSION,
      reasonCode: "note_subscription_first_review",
      at: input.at,
    });
  }
}
