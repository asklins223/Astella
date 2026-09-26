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
import type { GroundingCriticReportV2 } from "../card-quality-v2-contracts.ts";
import type { AssemblerEvidenceManifest } from "./binding-plan-core.ts";
import {
  deterministicGroundingPrecheck,
  deterministicPedagogyPrecheck,
  type QualityIssue,
} from "./critic-service.ts";
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
