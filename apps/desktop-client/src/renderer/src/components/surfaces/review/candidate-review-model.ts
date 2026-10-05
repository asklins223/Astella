import { PRE_RUN_REVEAL_COOLDOWN_MS } from "@ailearn/shared/card-generation-v2-contracts";
import type { CardGenerationCandidateV1, CardGenerationExposureEligibilityV1, DesktopCardRejectReasonV2 } from "@ailearn/shared/card-generation-desktop-contracts";
import { formatRelative } from "../notebook/surface-data";

export const revealCooldownHours = Math.round(PRE_RUN_REVEAL_COOLDOWN_MS / 3_600_000);

export function candidateDecisionLabel(candidate: CardGenerationCandidateV1): string {
  if (candidate.qualityState === "dropped") return "没进这批牌堆";
  if (candidate.qualityState === "failed") return "质量检查未通过";
  // A rewrite can end at authored after its second check. The API still
  // forbids keeping it, so do not imply a human approval action is available.
  if (candidate.qualityState === "checking") return "还在检查";
  if (candidate.qualityState === "authored") return "复查未通过";
  if (candidate.publishState === "activated") return "已保存进卡组";
  if (candidate.publishState === "activation_failed") return "保存没成功";
  if (candidate.publishState === "superseded" || candidate.publishState === "expired") return "已失效";
  if (candidate.reviewDecision === "reject") return "已拒绝";
  // keep/merged used to fall through to "待审核", so a candidate the reviewer had
  // just accepted still looked undecided.
  if (candidate.reviewDecision === "keep") return "已保留 · 等着保存到卡组";
  if (candidate.reviewDecision === "merged") return "已合并";
  return "待审核";
}

export function isActivatableCandidate(candidate: CardGenerationCandidateV1): candidate is CardGenerationCandidateV1 & { candidateEvidenceBindingPlanHash: string } {
  return candidate.reviewDecision === "keep"
    && candidate.publishState === "unpublished"
    && candidate.candidateEvidenceBindingPlanHash !== null;
}

export function isActionableUndecidedCandidate(candidate: CardGenerationCandidateV1): boolean {
  return candidate.reviewDecision === "undecided"
    && candidate.qualityState === "passed"
    && candidate.publishState === "unpublished"
    && candidate.isReviewReady
    && candidate.candidateEvidenceBindingPlanHash !== null;
}

export function knowledgeFormLabel(value: CardGenerationCandidateV1["objective"]["knowledgeForm"]): string {
  return {
    fact: "事实",
    definition: "定义",
    relationship: "关系",
    comparison: "比较",
    sequence: "顺序",
    procedure: "步骤",
    causal_model: "因果模型",
    boundary: "边界",
    application_rule: "应用规则",
  }[value];
}

export function practiceItemLabel(
  item: { kind: string; optionCount?: number } | null | undefined,
): string {
  if (!item) return "无附带客观题";
  switch (item.kind) {
    case "single_choice": return `选择题 · ${item.optionCount ?? "?"} 个选项`;
    case "true_false": return "判断题 · 对不对二选一";
    case "ordering": return `排序题 · 排 ${item.optionCount ?? "?"} 步`;
    case "matching": return `配对题 · ${item.optionCount ?? "?"} 组`;
    default: return "有，但这次没读出来";
  }
}

export function transformationLabel(value: CardGenerationCandidateV1["transformationKind"]): string {
  return {
    retrieval_definition: "提取定义",
    mechanism_reconstruction: "重建机制",
    structured_comparison: "结构化对比",
    procedure_reconstruction: "重建步骤",
    boundary_discrimination: "辨析边界",
    misconception_correction: "纠正误解",
    source_grounded_application: "来源情境应用",
  }[value];
}

export function exposureLabel(exposure: CardGenerationExposureEligibilityV1 | null, failure: string | null): string {
  if (failure) return "还没读到结果";
  if (!exposure) return "正在确认…";
  if (exposure.exposureStatus === "exposed") {
    return exposure.lastExposedAt
      ? `已查看 · ${formatRelative(exposure.lastExposedAt)}`
      : "已查看";
  }
  if (exposure.exposureStatus === "not_exposed") return "未查看";
  return "还没读到结果";
}

export function firstValidationLabel(exposure: CardGenerationExposureEligibilityV1 | null, failure: string | null): string {
  if (failure) return "还没读到结果";
  if (!exposure) return "正在确认…";
  switch (exposure.initialValidationPolicyEffect) {
    // 这里说代价，不说术语：审核人真正要决定的是"要不要现在看答案"，
    // 代价是激活之后这张卡要等一天才能正式验证（复盘 #9）。
    case "eligible": return "保存进卡组后马上能正式验证";
    case "wait_for_initial_validation": return `答案看过了：保存进卡组后要等 ${revealCooldownHours} 小时才能正式验证`;
    default: return "还没读到结果";
  }
}

export const REJECT_REASONS: readonly { readonly value: DesktopCardRejectReasonV2; readonly label: string }[] = [
  { value: "not_useful", label: "没有练习价值" },
  { value: "duplicate", label: "与已有内容重复" },
  { value: "too_trivial", label: "过于简单" },
  { value: "wrong", label: "内容不正确" },
  { value: "too_fragmented", label: "拆得太碎" },
  { value: "other", label: "其它原因" },
];
