import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { reviewSchedules } from "./db-schema/evidence.ts";

/**
 * 「这条复习排程指向的目标现在还可不可以消费」——唯一一句话。
 *
 * 四处读者（一处一个来源）：复习队列（`modules/review/service.ts`）、首页"待复习"读数
 * （`modules/stats/service.ts`）、学习看板（`modules/learning-dashboard/service.ts`），
 * 以及 W2-3 之后**伴星的到期读数与到期列表**（`workers/ai-worker`）。
 *
 * 为什么放进 shared：2026-09-24 的对账测试量到伴星那一侧是**另一份判据**（她自己写的
 * EXISTS，多带了一条"卡的来源笔记要对本人可见"），于是协作空间里出现"她说 2 项 / 首页说
 * 3 项"——两个数都自称"到期复习"，而这正是"同一口径两处各写一份"的经典形状
 * （本仓库已经用同样的办法收过 `noteVisibleSqlText`）。
 *
 * 判据本身只回答"能不能消费"：目标 active，且有可用卡片来源、有效的笔记
 * 订阅，或本人明确要求的一次提醒。无卡笔记目标不能被活卡检查挡掉。
 * 有来源笔记时同样检查当前排程本人可见性；权限撤回后四处读数一起隐藏。
 *
 * `ref` 收的是**排程表的三列引用**而不是表名/别名：调用方的 FROM 各不相同（drizzle 会
 * 把 `reviewSchedules` 渲染成别名 `"reviewSchedules"`，worker 那边是 `FROM review_schedules s`），
 * 而"哪一列"才是判据真正要的东西。拼表名会让两边各写一次别名，那正是本函数要消灭的东西。
 *
 * ## 争议未决的不进队列（2026-09-27，§16.22 / §14.2）
 *
 * 这条判据原先只判"卡还能不能消费"，**不读争议**，于是四处的到期读数会把一条正被
 * 争议的目标照常算作"今天该复习"：写侧 `scheduleBlockedByDisputeV2` 只挡"再排一条
 * 继任"（`run-processing-tick` 的 `applyDemonstratedSchedule` / `applyUnableSchedule`，
 * 位置在 `consume_pending` 之前），已经排好的那行仍是 `pending` 且照样到期。
 * 撤销只有一条路——用户勾"结束并暂不安排"，`holdObjectiveFromReviewV2` 才会把它改成
 * `dismissed`；**不结争议就永远到期**。更糟的是结算页已经写着"复核之前这次不推进
 * 复习"，同一件事在队列里又到期冒出来，文案与行为自相矛盾。
 *
 * 判据必须与写侧**同一份语义**，不能硬判 `status='open'`：`decideDisputedObservationV2`
 * 在复核结论是 `upheld` 时返回 `use_as_is`（这是 §16.22 防死循环的刻意设计——维护之后
 * 不该再压住这一项）。翻成 SQL 就是一行：
 *
 *   活争议（`closed_at IS NULL`）且 `recheck_outcome IS DISTINCT FROM 'upheld'` → 挡住
 *
 * 逐档对照 `decideDisputedObservationV2`：`null`→`withhold_conclusion` 挡；`undetermined`
 * →`withhold_conclusion` 挡；`corrected`→ 两条分支写侧都是 `blocked:true`（未应用走
 * `apply_correction_once`、已应用走 `withhold_conclusion`），一并挡；`upheld`→`use_as_is`
 * 放行。`correction_applied_at` 因此不必进 WHERE——`corrected` 两档读侧同挡。
 *
 * 匹配用**排程行自己的 `user_id`**，不是调用方的 userId：§14.4 争议是个人数据，
 * 而 `reviewSchedules.userId` 允许为 NULL（系统排期）。这样一处写法同时覆盖
 * "本人队列""首页读数 `user_id IS NULL OR =本人`""看板"和 worker 的 `s.user_id`，
 * 不必让每个调用方各自把 userId 传进来再传错。
 */
export function reviewScheduleTargetsConsumableCardPredicate(
  ref: {
    subjectType: SQLWrapper;
    subjectId: SQLWrapper;
    workspaceId: SQLWrapper;
    /** 排程行自己的 `user_id` 列。争议是个人数据（§14.4），匹配必须按它。 */
    userId: SQLWrapper;
    reminderKind: SQLWrapper;
  } = {
    subjectType: reviewSchedules.subjectType,
    subjectId: reviewSchedules.subjectId,
    workspaceId: reviewSchedules.workspaceId,
    userId: reviewSchedules.userId,
    reminderKind: reviewSchedules.reminderKind,
  },
): SQL<boolean> {
  return sql<boolean>`(
    NOT EXISTS (
      SELECT 1
      FROM assessment_disputes_v2 AS v2_consumer_dispute
      WHERE v2_consumer_dispute.objective_id = ${ref.subjectId}
        AND v2_consumer_dispute.workspace_id = ${ref.workspaceId}
        AND v2_consumer_dispute.user_id = ${ref.userId}
        AND v2_consumer_dispute.closed_at IS NULL
        AND v2_consumer_dispute.recheck_outcome IS DISTINCT FROM 'upheld'
    )
    AND ${ref.subjectType} = 'card'
    AND EXISTS (
      SELECT 1 FROM learning_objectives_v2 AS v2_consumer_obj
      WHERE v2_consumer_obj.objective_id = ${ref.subjectId}
        AND v2_consumer_obj.workspace_id = ${ref.workspaceId}
        AND v2_consumer_obj.lifecycle = 'active'
    )
    AND (
      EXISTS (
        SELECT 1 FROM learning_cards_v2 AS v2_consumer_card
        LEFT JOIN note_versions AS v2_consumer_version
          ON v2_consumer_version.id = v2_consumer_card.note_version_id
        LEFT JOIN notes AS v2_consumer_note
          ON v2_consumer_note.id = v2_consumer_version.note_id
        WHERE v2_consumer_card.objective_id = ${ref.subjectId}
          AND v2_consumer_card.workspace_id = ${ref.workspaceId}
          AND v2_consumer_card.lifecycle = 'active'
          AND (v2_consumer_card.note_version_id IS NULL OR (
            v2_consumer_note.deleted_at IS NULL
            AND (v2_consumer_note.share_scope = 'shared' OR v2_consumer_note.created_by = ${ref.userId})
          ))
          AND (
            NOT EXISTS (
              SELECT 1 FROM review_subscriptions_v2 AS v2_consumer_paused_card
              WHERE v2_consumer_paused_card.workspace_id = ${ref.workspaceId}
                AND v2_consumer_paused_card.user_id = ${ref.userId}
                AND v2_consumer_paused_card.source = 'card_review'
                AND v2_consumer_paused_card.subject_type = 'objective'
                AND v2_consumer_paused_card.subject_id = ${ref.subjectId}
                AND v2_consumer_paused_card.status = 'paused'
            )
            OR EXISTS (
              SELECT 1 FROM review_subscriptions_v2 AS v2_consumer_active_card
              WHERE v2_consumer_active_card.workspace_id = ${ref.workspaceId}
                AND v2_consumer_active_card.user_id = ${ref.userId}
                AND v2_consumer_active_card.source = 'card_review'
                AND v2_consumer_active_card.subject_type = 'objective'
                AND v2_consumer_active_card.subject_id = ${ref.subjectId}
                AND v2_consumer_active_card.status = 'active'
            )
          )
      )
      OR EXISTS (
        SELECT 1 FROM learning_objective_origins_v2 AS v2_consumer_origin
        JOIN notes AS v2_consumer_origin_note
          ON v2_consumer_origin_note.id = v2_consumer_origin.note_id
         AND v2_consumer_origin_note.workspace_id = ${ref.workspaceId}
         AND v2_consumer_origin_note.deleted_at IS NULL
         AND (v2_consumer_origin_note.share_scope = 'shared' OR v2_consumer_origin_note.created_by = ${ref.userId})
        WHERE v2_consumer_origin.objective_id = ${ref.subjectId}
          AND v2_consumer_origin.workspace_id = ${ref.workspaceId}
          AND v2_consumer_origin.origin_kind = 'note'
          AND (
            ${ref.reminderKind} = 'one_time'
            OR EXISTS (
              SELECT 1 FROM review_subscriptions_v2 AS v2_consumer_note_sub
              WHERE v2_consumer_note_sub.workspace_id = ${ref.workspaceId}
                AND v2_consumer_note_sub.user_id = ${ref.userId}
                AND v2_consumer_note_sub.source = 'note_subscription'
                AND v2_consumer_note_sub.subject_type = 'note'
                AND v2_consumer_note_sub.subject_id = v2_consumer_origin_note.id
                AND v2_consumer_note_sub.status = 'active'
            )
          )
      )
    )
  )`;
}
