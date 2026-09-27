/**
 * 方案 20 C3：两份确定性 precheck 的回归（C2 那一节已于 2026-09-27 迁走）。
 *
 * 2026-09-27（39d W7-7 刀二·附十二）：`executeAuthor` 这一层随四阶段链删除，原来 C2 那节
 * 断言的"提示不并进候选修订哈希"搬到了它的现职位置——
 * `workers/ai-worker/src/card-generation-v3/card-generation-v3.test.ts`（简化链的组装层）；
 * "确定性题面不许逐字照抄陈述"由已迁到默认档的 C02（门禁阻断）与 `front_leaks_answer` 量。
 *
 * 验证：
 * 4. deterministic pedagogy precheck 检测 front 泄漏答案。
 *
 * 2026-09-27（39d W7-7 刀二）：原来的第 5、6 节（final gates 阻断 hard issue、
 * merge/dedup 合并）随四阶段 Critic 一起删除——那两件的判据对象（集合级 deck gate 与
 * Global Selector 去重）在简化链上不产出对应结构。两份 precheck 今天仍在线上被调用
 * （`buildCandidatePrecheck` 与离线 grounding 走的就是它们），所以这两节留着。
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  deterministicGroundingPrecheck,
  deterministicPedagogyPrecheck,
} from "@ailearn/shared/card-generation-v2-pipeline";
import type {
  LearningCardCandidateRevisionV2,
} from "@ailearn/shared/card-generation-v2-contracts";
import {
  computeCandidateRevisionHashV2,
} from "@ailearn/shared/card-generation-v2-hashing";

// ─── Mock helpers ────────────────────────────────────────────────────────


function makeMockCandidate(
  overrides: Partial<LearningCardCandidateRevisionV2> = {},
): LearningCardCandidateRevisionV2 {
  const base: Omit<LearningCardCandidateRevisionV2, "candidateRevisionHash"> = {
    version: 2,
    candidateRevisionId: randomUUID(),
    candidateId: randomUUID(),
    revision: 1,
    runId: "r-00000000-0000-4000-8000-000000000001",
    planRevisionId: randomUUID(),
    planVersion: 1,
    planHash: "b".repeat(64),
    cardContentEpoch: 1,
    planObjectiveLocalId: "obj-1",
    recommendation: { recommended: true, reasonCodes: ["test"] },
    derivedFromCandidateRevisions: [],
    objective: {
      objectiveStatement: "定义：分布式共识是指多个节点对某个值达成一致的协议。",
      publicSummary: "分布式共识定义",
      conceptLabel: "测试概念标题",
      knowledgeForm: "definition",
      preferredTaskIntents: ["recall"],
      canonicalAnswer: {
        kind: "text",
        unit: {
          unitId: "ans-1",
          text: "分布式共识是指多个节点对某个值达成一致的协议。",
        },
      },
      learningSupport: {
        explanation: "共识协议确保节点在分布式系统中达成一致。",
      },
      rubric: {
        version: 2,
        units: [{
          rubricUnitId: "rubric-1",
          facet: "recall",
          criterion: "能正确回答分布式共识的定义",
          required: true,
          answerUnitIds: ["ans-1"],
          evidenceRefIds: [],
        }],
        passingPolicy: {
          requireAllRequiredUnits: true,
          allowContradiction: false,
        },
        rubricHash: "c".repeat(64),
      },
      relations: [],
      difficulty: "introductory",
      evidenceRefIds: [],
    },
    presentation: {
      strategy: "recall",
      transformationKind: "retrieval_definition",
      front: {
        cue: "分布式共识",
        prompt: "请回答：什么是分布式共识？",
      },
      estimatedReviewSeconds: 60,
    },
    evidenceSetHash: "d".repeat(64),
  };
  const hash = computeCandidateRevisionHashV2(base);
  return { ...base, candidateRevisionHash: hash, ...overrides };
}


describe("C3: Grounding Critic Precheck", () => {
  test("detects answer not grounded in source", () => {
    const candidate = makeMockCandidate({
      objective: {
        ...makeMockCandidate().objective,
        canonicalAnswer: {
          kind: "text",
          unit: {
            unitId: "ans-1",
            text: "量子力学是研究原子核内部结构的物理学分支。",
          },
        },
      },
    });
    const issues = deterministicGroundingPrecheck(candidate, "分布式共识是指多个节点对某个值达成一致的协议。");
    // 2026-08-16：按方案 20 §13.1「字符重合只能作为风险信号」，重叠检查降级
    // 为 soft——断言改为软信号而非 hard gate。
    const softIssues = issues.filter((i) => i.severity === "soft" && i.code === "answer_not_grounded");
    assert.ok(softIssues.length > 0, "should flag ungrounded answer as soft risk");
  });

  test("passes for grounded answer", () => {
    const candidate = makeMockCandidate();
    const issues = deterministicGroundingPrecheck(candidate, "分布式共识是指多个节点对某个值达成一致的协议。");
    const hardIssues = issues.filter((i) => i.severity === "hard");
    assert.equal(hardIssues.length, 0);
  });

  test("detects rubric referencing missing answer unit", () => {
    const candidate = makeMockCandidate({
      objective: {
        ...makeMockCandidate().objective,
        rubric: {
          ...makeMockCandidate().objective.rubric,
          units: [{
            ...makeMockCandidate().objective.rubric.units[0],
            answerUnitIds: ["nonexistent-unit"],
          }],
        },
      },
    });
    const issues = deterministicGroundingPrecheck(candidate, "some source");
    assert.ok(issues.some((i) => i.code === "rubric_references_missing_answer_unit"));
  });
});

describe("C3: Pedagogy Critic Precheck", () => {
  // 2026-08-24（AI 设计审查 §4.5 认识论分工）：改写式/照抄式泄题的子串匹配
  // 从 hard 降级为 soft 风险信号（surface_paraphrase_only）——语义裁决归
  // Pedagogy Critic 的冻结 code front_leaks_answer。
  test("flags front leaking answer as soft risk signal", () => {
    const candidate = makeMockCandidate({
      presentation: {
        ...makeMockCandidate().presentation,
        front: {
          cue: "test",
          prompt: "分布式共识是指多个节点对某个值达成一致的协议。",
        },
      },
    });
    const issues = deterministicPedagogyPrecheck(candidate, "source");
    assert.ok(issues.some((i) => i.code === "surface_paraphrase_only" && i.severity === "soft"));
  });

  test("detects cue identical to objective statement", () => {
    const candidate = makeMockCandidate({
      presentation: {
        ...makeMockCandidate().presentation,
        front: {
          cue: "定义：分布式共识是指多个节点对某个值达成一致的协议。",
          prompt: "请回答",
        },
      },
    });
    const issues = deterministicPedagogyPrecheck(candidate, "source");
    assert.ok(issues.some((i) => i.code === "cue_is_claim_copy"));
  });

  test("passes for good pedagogy", () => {
    const candidate = makeMockCandidate();
    const issues = deterministicPedagogyPrecheck(candidate, "source content here");
    const hardIssues = issues.filter((i) => i.severity === "hard");
    assert.equal(hardIssues.length, 0);
  });
});
