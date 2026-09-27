import type { LearningRunAllowedActionV2, LearningRunPublicV1 } from "@ailearn/shared";

/**
 * retry_assessment 可重新入队的 assessment 状态：tick 的失败路径把它收尾为
 * failed；prepare 事务整体回滚时退回 queued；Critic 写回事务回滚时停在
 * running。三者在状态下都允许重新排队（processAssessmentCommand 只处理
 * queued，重试即先回到 queued）。
 */
const RETRYABLE_ASSESSMENT_STATUSES: ReadonlyArray<NonNullable<LearningRunPublicV1["activeAssessment"]>["status"]> = [
  "queued",
  "running",
  "failed",
];

/**
 * 可以被「停止本次评估」收掉的那两档（§5.5；0301 那一刀）。
 *
 * 与 `RETRYABLE_ASSESSMENT_STATUSES` 是**不同的集合**，不要合并：`failed` 可以重试也可以
 * 取消（它既没有结果也没有在跑），但把取消建立在"可重试"上会让「重试」与「取消」这两个
 * 独立动作再次耦在一起——而 §5.5 要求它们是三个独立动作里的两个。
 */
const CANCELLABLE_ASSESSMENT_STATUSES: ReadonlyArray<NonNullable<LearningRunPublicV1["activeAssessment"]>["status"]> = [
  "queued",
  "running",
];

/**
 * Project only server-authorized action templates. The renderer must consume
 * this exact union; it must never infer an action from phase or local state.
 */
export function buildLearningRunAllowedActionsV2(view: LearningRunPublicV1): LearningRunAllowedActionV2[] {
  const actions: LearningRunAllowedActionV2[] = [];
  const task = view.activeTask;

  if (view.phase === "active") {
    // 2026-09-20 实走复盘 #12：active 阶段曾经同时提供 skip_run / end / skip_task
    // 三个"无痕离开"，其中 skip_run 与 skip_task 产生逐字节相同的终态，而
    // 「暂时不会」是另一种真实作答结果。三个近义出口堆在菜单里，用户分不清也
    // 不需要分。现在只剩：不想做 → 稍后再做；不会做 → 暂时不会（提交侧）。
    // end 在其他阶段仍是唯一出口（paused / checkpoint / recoverable_error /
    // assessing / committing / preparing），照旧签发。
    actions.push(
      { version: 2, kind: "pause" },
      { version: 2, kind: "skip_run", confirmationRequired: true },
    );
    if (task) {
      for (let level = 1; level <= task.assistancePolicy.hintLevels; level += 1) {
        actions.push({ version: 2, kind: "request_hint", level: level as 1 | 2 | 3 });
      }
      for (const alternative of task.availableAlternatives) {
        actions.push({ version: 2, kind: "switch_variant", alternativeId: alternative.alternativeId });
      }
    }
  } else if (view.phase === "paused") {
    actions.push(
      { version: 2, kind: "resume" },
      { version: 2, kind: "end", abandonLockedEvidence: false, confirmationRequired: true },
    );
  } else if (view.phase === "checkpoint") {
    if (view.checkpoint?.kind === "partial") actions.push({ version: 2, kind: "finish_current_evidence" });
    if (view.checkpoint?.kind === "not_assessable") actions.push({ version: 2, kind: "finish_without_commit" });
    for (const followupId of view.checkpoint?.allowedFollowupIds ?? []) {
      actions.push({ version: 2, kind: "activate_followup", followupId });
    }
    actions.push({ version: 2, kind: "end", abandonLockedEvidence: false, confirmationRequired: true });
  } else if (view.phase === "recoverable_error") {
    if (view.failure?.stage === "prepare") actions.push({ version: 2, kind: "retry_prepare" });
    // H1（2026-08-24 审查）：只有「确实可重试」的 assessment 才宣告
    // retry_assessment——completed/not_assessable 的评估重试必然 409，投影与
    // 状态机必须一致（tick 失败路径会把 queued/running 收尾为 failed）。
    if (
      view.failure?.stage === "assessment"
      && view.activeAssessment
      && RETRYABLE_ASSESSMENT_STATUSES.includes(view.activeAssessment.status)
    ) {
      actions.push({ version: 2, kind: "retry_assessment", assessmentId: view.activeAssessment.assessmentId });
    }
    if (view.failure?.stage === "commit") actions.push({ version: 2, kind: "retry_commit" });
    // H4（2026-08-24 审查）：recoverable_error 的 end 必须被 applyAction 接受
    // （阶段无在锁证据，无需 abandonLockedEvidence）。
    actions.push({ version: 2, kind: "end", abandonLockedEvidence: false, confirmationRequired: true });
  } else if (view.phase === "assessing" || view.phase === "committing") {
    // §5.5 三个独立动作：在途评估时除了「先到这里」（那要 abandon 掉已锁定的作答）之外，
    // 还有一个**不放弃作答**的出路——明确停止本次评估。少了它，这一档就只剩"要么让评估
    // 跑完、要么丢掉我刚答的"二选一（D7 §7 明写结束活动默认允许评估完成）。
    //
    // **只在评估确实未终态时宣告**：completed / not_assessable 的那一发不接受取消
    // （§5.5「已先完成提交的判定不因后到取消而消失」），cancelled 的更不接受
    // （重放由状态机的幂等分支处理）。宣告一个注定 409 的动作 = 界面摆一颗按不动的按钮。
    if (view.activeAssessment && CANCELLABLE_ASSESSMENT_STATUSES.includes(view.activeAssessment.status)) {
      actions.push({
        version: 2,
        kind: "cancel_assessment",
        assessmentId: view.activeAssessment.assessmentId,
        confirmationRequired: true,
      });
    }
    actions.push({ version: 2, kind: "end", abandonLockedEvidence: true, confirmationRequired: true });
  } else if (view.phase === "preparing") {
    actions.push({ version: 2, kind: "end", abandonLockedEvidence: false, confirmationRequired: true });
  }

  return actions;
}
