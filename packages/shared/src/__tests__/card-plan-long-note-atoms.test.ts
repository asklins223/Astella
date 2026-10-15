/**
 * 一篇长笔记的知识对象数不该撞墙。
 *
 * 实测（2026-10-14）：`POST /v2/card-generation-runs` 对一篇 37 万字符（2,359 块）的长笔记
 * 在 `plan-assembly.ts` 的 `planBase` 里当场抛 `ZodError: Array must contain at most
 * 1000 element(s) (atomDecisions)`，出箱任务把它判成**可重试**，于是每一轮都在同一个位置红，
 * 这篇永远制不出卡。`atomDecisions` 的长度等于正文里知识对象的个数——那是内容决定的数，
 * 不是预算；真正限量的是 `activationHardMax`（合同里 superRefine 那条一直都在管）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { cardPlanV2Schema } from "../contracts/card-generation-v2-contracts.ts";
import { computeCardPlanHashV2 } from "../card-generation-v2-hashing.ts";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const PLAN_REVISION_ID = "22222222-2222-4222-8222-222222222222";

function planWithAtomDecisions(count: number) {
  const base = {
    version: 2 as const,
    planRevisionId: PLAN_REVISION_ID,
    runId: RUN_ID,
    inputSnapshotHash: "a".repeat(64),
    cardContentEpoch: 1,
    planVersion: 1,
    previousPlanRevisionId: null,
    result: { kind: "no_cards_recommended" as const, reasonCodes: ["no_pedagogically_useful_transformation" as const] },
    // 与 `planBase` 真实交出去的那一形状一致：每个原子一条记账。
    atomDecisions: Array.from({ length: count }, (_, i) => ({
      atomId: `atom-${i}`,
      decision: "omit_over_budget" as const,
    })),
  };
  return { ...base, planHash: computeCardPlanHashV2(base) };
}

test("长笔记上知识对象超过 1,000 个，计划照样收得下", () => {
  const parsed = cardPlanV2Schema.safeParse(planWithAtomDecisions(1_200));
  assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues?.[0] ?? {}));
  if (parsed.success) assert.equal(parsed.data.atomDecisions.length, 1_200, "一条记账都不该被丢掉");
});

test("限量仍然有效：推荐数超过这一轮的硬预算照样判红", () => {
  const base = planWithAtomDecisions(3);
  const overBudget = {
    ...base,
    result: {
      kind: "author_candidates" as const,
      recommendedCardCount: 9,
      activationHardMax: 8,
      objectives: [{ localId: "o1", title: "t", strategy: "recall" as const, knowledgeForm: "fact" as const,
        atomIds: ["atom-0"], evidenceRefs: [], rubricSummary: "s" }],
    },
  };
  assert.equal(cardPlanV2Schema.safeParse(overBudget).success, false,
    "去掉按内容拍的墙，不等于去掉预算——`activationHardMax` 这一条必须还在说话");
});
