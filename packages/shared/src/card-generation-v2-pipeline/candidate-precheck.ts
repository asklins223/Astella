/**
 * 候选的**确定性预检**与**离线 grounding**（39d W7-1 刀a）。
 *
 * 这两个函数原先住在 `workers/ai-worker/src/handlers/card-generation-v2-handler.ts`。
 * 简化链（V3）要用同一套判据，而它不能去 import 一份 4 000 行的 V2 处理器——那等于
 * 逼 V3 复制或另写一份程序校验。设计件 `39d-w71` §2 明写"复用，不写第二份"，
 * 所以把它们上移到这个纯逻辑目录（本目录边界：不做网络、不做 DB I/O，见 index.ts）。
 *
 * 判据本身一字未改：
 * - `buildCandidatePrecheck` = deterministic gates + grounding/pedagogy 两份 precheck，
 *   按 severity 分成 fatalPre（阻断候选、不发起付费调用）与 softPre（随审计落盘、
 *   并作为 Critic 输入的风险参考）；
 * - `runDeterministicGroundingContract` = 无模型时的 grounding 结论（离线与测试路径）。
 */
import { randomUUID } from "node:crypto";
import type {
  CanonicalAnswerV2,
  LearningCardCandidateRevisionV2,
} from "../card-generation-v2-contracts.ts";
import { computeCandidateEvidenceSetHashV2 } from "../card-generation-v2-hashing.ts";
import { hashCanonicalV2 } from "../hash-canonical-v2.ts";
import type {
  GroundingCriticReportV2,
  QualityIssue,
} from "../card-quality-v2-contracts.ts";
import type { AssemblerEvidenceManifest } from "./binding-plan-core.ts";

// `QualityIssue` 是两份 precheck 与门禁共同的结论形状，住在质量合同里（四阶段 Critic
// 删除后不再有"critic 服务"这一层）；这里原样转出去，`@ailearn/shared/card-generation-v2-pipeline`
// 那把 barrel 的读法不变。
export type { QualityIssue } from "../card-quality-v2-contracts.ts";
import { runCandidateDeterministicGatesV2 } from "./deterministic-gates.ts";

export interface CandidatePrecheckV2 {
  candidate: LearningCardCandidateRevisionV2;
  fatalPre: QualityIssue[];
  softPre: QualityIssue[];
}

/** 12.1 deterministic precheck（纯计算，无 IO）。 */
export function buildCandidatePrecheck(
  candidate: LearningCardCandidateRevisionV2,
  sourceContent: string,
  evidenceManifest: unknown,
): CandidatePrecheckV2 {
  const precheckGating = runCandidateDeterministicGatesV2({
    candidate,
    evidenceManifest: evidenceManifest as never,
  });
  const groundingPre = deterministicGroundingPrecheck(candidate, sourceContent);
  const pedagogyPre = deterministicPedagogyPrecheck(candidate, sourceContent);
  const allPre = [...precheckGating, ...groundingPre, ...pedagogyPre];
  return {
    candidate,
    fatalPre: allPre.filter((i) => i.severity === "hard"),
    softPre: allPre.filter((i) => i.severity === "soft"),
  };
}

/**
 * grounding 报告 `reportHash` 的配方（域名字符串照既有实现，一个字都不改）。
 *
 * 抽成一份是因为简化链（V3）要把模型给的那份报告**重新盖章**（身份字段以服务端为
 * 准）之后重算哈希——两处各写一份，迟早有一处与审计闭包不一致。
 */
export function computeGroundingReportHashV2(input: {
  candidateRevisionId: string;
  evidenceSetHash: string;
  verdict: string;
  hardIssues: readonly string[];
}): string {
  return hashCanonicalV2("card-generation-v2/grounding-critic-report", input);
}

/**
 * 确定性 Grounding：sealed 有证据时，逐一校验 answer/rubric 引用均落在
 * sealed evidence 范围内 → pass（保持离线/测试可用）。
 *
 * 2026-09-26（W7-1 刀a 上移时补的一件事）：逐单元的 `answerUnits` / `rubricSupport`
 * **必须填**。合同要求两者各至少一条，而这份报告原先给的是空数组——它躲过了 V2 主管线
 * （那里的确定性版本从不按合同解析），一到 V3 就把"离线那一版"整条判成 output_shape。
 * 逐单元结论本来就在这份函数已经算过的读数里（依据在不在范围内），写出来不算发明。
 */
export async function runDeterministicGroundingContract(
  candidate: LearningCardCandidateRevisionV2,
  evidenceManifest: AssemblerEvidenceManifest,
): Promise<GroundingCriticReportV2> {
  const reportId = randomUUID();
  const manifestIds = new Set(evidenceManifest.evidence.map((e) => e.evidenceSnapshotId));
  const candidateSnapIds = [...candidate.objective.evidenceRefIds, ...candidate.objective.rubric.units.flatMap((u) => u.evidenceRefIds)];
  const anyRefOutside = candidateSnapIds.some((id) => !manifestIds.has(id));
  const inScope = evidenceManifest.evidence.length > 0 && !anyRefOutside;
  const verdict = inScope ? "pass" : "fail";
  const evidenceSetHash = computeCandidateEvidenceSetHashV2(
    evidenceManifest.evidence.map((e) => ({ evidenceSnapshotId: e.evidenceSnapshotId, evidenceSnapshotHash: e.evidenceSnapshotHash })),
  );
  const hardIssues = verdict === "fail" ? ["deterministic grounding failed"] : [];
  return {
    version: 2,
    reportId,
    candidateRevisionId: candidate.candidateRevisionId,
    candidateRevisionHash: candidate.candidateRevisionHash,
    evidenceSetHash,
    evidenceEligibilityVectorHash: candidate.evidenceSetHash,
    inputHash: candidate.evidenceSetHash,
    verdict,
    answerUnits: answerUnitIdsV2(candidate.objective.canonicalAnswer).map((answerUnitId) => ({
      answerUnitId,
      verdict: inScope ? ("entailed" as const) : ("insufficient" as const),
      evidenceSnapshotIds: candidate.objective.evidenceRefIds,
    })),
    learningSupport: [{
      field: "explanation" as const,
      verdict: inScope ? ("entailed" as const) : ("insufficient" as const),
      evidenceSnapshotIds: candidate.objective.evidenceRefIds,
    }],
    relationSupport: candidate.objective.relations.map((relation) => ({
      relationId: relation.relationId,
      verdict: inScope ? ("entailed" as const) : ("insufficient" as const),
      evidenceSnapshotIds: candidate.objective.evidenceRefIds,
    })),
    rubricSupport: candidate.objective.rubric.units.map((unit) => ({
      rubricUnitId: unit.rubricUnitId,
      verdict: inScope ? ("supported" as const) : ("unsupported" as const),
      evidenceSnapshotIds: unit.evidenceRefIds,
    })),
    hardIssues,
    criticVersion: "deterministic-grounding-v1",
    reportHash: computeGroundingReportHashV2({
      candidateRevisionId: candidate.candidateRevisionId,
      evidenceSetHash,
      verdict,
      hardIssues,
    }),
  };
}

/** 答案单元的 id 清单（七种答案形状各一处，与 `countAnswerUnits` 同一覆盖）。 */
function answerUnitIdsV2(answer: CanonicalAnswerV2): string[] {
  switch (answer.kind) {
    case "text": return [answer.unit.unitId];
    case "bullets": return answer.items.map((item) => item.unitId);
    case "ordered_steps": return answer.steps.map((step) => step.unitId);
    case "mapping": return answer.pairs.map((pair) => pair.unitId);
    case "comparison": return answer.rows.map((row) => row.unitId);
    case "formula": return [answer.unitId];
    case "code": return [answer.unitId];
  }
}

// ─── 两份确定性 precheck（原住 critic-service.ts，2026-09-27 随四阶段 Critic 删除搬来）──
// 判据一字未改，只是搬到唯一的消费者旁边：`buildCandidatePrecheck` 与
// `runDeterministicGroundingContract` 都直接用它们（简化链 V3 经这两个入口拿同一套结论）。
/**
 * 确定性 Grounding precheck（§10.1 step 6）。不调用模型，纯规则。
 */
export function deterministicGroundingPrecheck(
  candidate: LearningCardCandidateRevisionV2,
  sourceContent: string,
): QualityIssue[] {
  const issues: QualityIssue[] = [];
  const answer = candidate.objective.canonicalAnswer;

  // Check: answer text must not be empty
  if (answer.kind === "text" && answer.unit.text.trim().length === 0) {
    issues.push({
      code: "empty_answer",
      severity: "hard",
      detail: "Canonical answer text is empty",
      answerUnitIds: [answer.unit.unitId],
    });
  }

  // Check: answer must be supportable by source (basic overlap check)
  const answerText = extractAnswerText(answer);
  if (answerText && sourceContent.length > 0) {
    const answerLower = answerText.toLowerCase();
    const sourceLower = sourceContent.toLowerCase();

    // Try word-level overlap first (for Latin scripts)
    const answerWords = new Set(answerLower.split(/\s+/).filter((w) => w.length > 3));
    if (answerWords.size > 3) {
      let overlapCount = 0;
      for (const word of answerWords) {
        if (sourceLower.includes(word)) overlapCount++;
      }
      if (overlapCount / answerWords.size < 0.2) {
        issues.push({
          code: "answer_not_grounded",
          // 2026-08-16（实机验证修复）：按方案 20 §13.1「字符重合只能作为风险
          // 信号，不能作为教学转换是否发生的充分条件」，重叠检查从 hard 降级
          // 为 soft——真实 LLM 的教学转换（尤其中文改写）与原文词/字重叠天然
          // 偏低，hard 会误杀合法候选（deepseek-v4-flash 实测 100% 被拒）。
          severity: "soft",
          detail: "Canonical answer has <20% word overlap with source content",
        });
      }
    } else {
      // Fallback: character-level overlap (for CJK or short text)
      const answerChars = new Set<string>();
      for (let i = 0; i < answerLower.length - 1; i++) {
        const bigram = answerLower.slice(i, i + 2);
        if (bigram.trim().length === 2) answerChars.add(bigram);
      }
      if (answerChars.size > 5) {
        let charOverlap = 0;
        for (const bigram of answerChars) {
          if (sourceLower.includes(bigram)) charOverlap++;
        }
        if (charOverlap / answerChars.size < 0.15) {
          issues.push({
            code: "answer_not_grounded",
            // 2026-08-16：同词级检查，按 §13.1 降级为 soft 风险信号。
            severity: "soft",
            detail: "Canonical answer has <15% character overlap with source content",
          });
        }
      }
    }
  }

  // Check: rubric units must reference answer units
  const answerUnitIds = new Set(answerUnitIdsV2(answer));
  for (const unit of candidate.objective.rubric.units) {
    for (const ansId of unit.answerUnitIds) {
      if (!answerUnitIds.has(ansId)) {
        issues.push({
          code: "rubric_references_missing_answer_unit",
          severity: "hard",
          detail: `Rubric unit ${unit.rubricUnitId} references non-existent answer unit ${ansId}`,
          answerUnitIds: [ansId],
        });
      }
    }
  }

  return issues;
}

/**
 * 确定性 Pedagogy precheck（step 6 补充信号）。不作为最终教学价值判定，
 * 教学价值由独立的 contract 级 Pedagogy provider 判定（§12.4）。
 *
 * 2026-08-24（AI 设计审查 §4.5 认识论分工）：front 泄题的子串匹配分支从
 * hard 降级为 soft——"正面是否以改写方式泄露答案"是语义判断，正则子串匹配
 * 的残余假阳不可归零；逐字照抄类机械泄题已由 deterministic-gates 的
 * frontLeakageGate（压缩标点 ≥12 连续字符同一）承担 hard 判定。本 precheck
 * 命中仅产生 surface_paraphrase_only（soft）风险信号，语义裁决归 Pedagogy
 * Critic 的冻结 code front_leaks_answer。
 */
export function deterministicPedagogyPrecheck(
  candidate: LearningCardCandidateRevisionV2,
  _sourceContent: string,
): QualityIssue[] {
  const issues: QualityIssue[] = [];
  const front = candidate.presentation.front;
  const answerText = extractAnswerText(candidate.objective.canonicalAnswer);

  // Check: front must not leak answer——降级为 soft 风险信号（见函数头注释）
  if (answerText && front.prompt) {
    const answerLower = answerText.toLowerCase();
    const promptLower = front.prompt.toLowerCase();
    if (answerLower.length > 20 && promptLower.includes(answerLower.slice(0, 50))) {
      const firstAnswerUnitId = extractFirstAnswerUnitId(candidate.objective.canonicalAnswer);
      issues.push({
        code: "surface_paraphrase_only",
        severity: "soft",
        detail: "Front prompt contains answer text (risk signal; semantic verdict deferred to pedagogy critic)",
        answerUnitIds: firstAnswerUnitId ? [firstAnswerUnitId] : undefined,
      });
    }
  }

  // Check: cue must not be identical to claim
  if (front.cue === candidate.objective.objectiveStatement) {
    issues.push({
      code: "cue_is_claim_copy",
      severity: "hard",
      detail: "Front cue is identical to objective statement (surface paraphrase)",
    });
  }

  // Check: estimatedReviewSeconds must be reasonable
  if (candidate.presentation.estimatedReviewSeconds < 10) {
    issues.push({
      code: "review_time_too_short",
      severity: "soft",
      detail: "Estimated review time < 10 seconds suggests trivial card",
    });
  }

  return issues;
}

function extractAnswerText(answer: CanonicalAnswerV2): string {
  switch (answer.kind) {
    case "text": return answer.unit.text;
    case "bullets": return answer.items.map((i) => i.text).join(" ");
    case "ordered_steps": return answer.steps.map((s) => s.text).join(" ");
    case "mapping": return answer.pairs.map((p) => `${p.left}=${p.right}`).join(" ");
    case "comparison": return answer.rows.map((r) => r.values.join(" ")).join(" ");
    case "formula": return answer.latex;
    case "code": return answer.code;
  }
}

function extractFirstAnswerUnitId(answer: CanonicalAnswerV2): string | null {
  switch (answer.kind) {
    case "text": return answer.unit.unitId;
    case "bullets": return answer.items[0]?.unitId ?? null;
    case "ordered_steps": return answer.steps[0]?.unitId ?? null;
    case "mapping": return answer.pairs[0]?.unitId ?? null;
    case "comparison": return answer.rows[0]?.unitId ?? null;
    case "formula": return answer.unitId;
    case "code": return answer.unitId;
  }
}
