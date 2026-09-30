/**
 * 列表 DTO 投影（`toObjectiveListItemV3`）单元测试。
 *
 * 复盘 #7：`personal.practiceTrailCount / lastCanonicalAt / review.dueAt /
 * initialValidation` 这些数据一直在批量装配的 surface 里，但列表投影只挑了
 * 标题、形态和状态词，所以答完一张卡回到列表，行上看不到任何变化。
 * 本测试钉住"列表行自带进展"这件事，防止以后又被顺手精简掉。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { LearningObjectiveSurfaceV3 } from "@ailearn/shared/learning-objective-surface-contracts";
import { toObjectiveListItemV3 } from "../surface-service.ts";

function surface(
  personal: Partial<LearningObjectiveSurfaceV3["personal"]> = {},
): LearningObjectiveSurfaceV3 {
  const base = {
    version: 3,
    objectiveId: "11111111-1111-4111-8111-111111111111",
    surfaceRevision: 1,
    lifecycleEpoch: 1,
    content: {
      conceptLabel: "惯性与质量",
      publicSummary: "质量是惯性大小的唯一量度。",
      knowledgeForm: "fact",
      cardStrategy: null,
      lifecycle: "active",
      freshness: "fresh",
      presentation: { cardId: null, cardRevision: null, publicationRevision: null },
      sourceLabel: null,
    },
    sources: { origins: [], primaryNote: null, missingOrigin: false },
    noteChangeImpact: null,
    personal: {
      initialValidation: null,
      activeRun: null,
      review: null,
      practiceTrailCount: 0,
      lastCanonicalAt: null,
      reviewHold: null,
    },
    lifecycle: { status: "active", successorObjectiveId: null },
    personalState: { state: "unvalidated", activeRunId: null },
    primaryAction: { kind: "refresh" },
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
  };
  return { ...base, personal: { ...base.personal, ...personal } } as unknown as LearningObjectiveSurfaceV3;
}

test("列表行带上进展数据：答过几次、上次正式作答、下次复习", () => {
  const item = toObjectiveListItemV3(surface({
    practiceTrailCount: 3,
    lastCanonicalAt: "2026-09-19T08:00:00.000Z",
    review: {
      status: "scheduled",
      scheduleId: "22222222-2222-4222-8222-222222222222",
      generation: 1,
      dueAt: "2026-09-25T08:00:00.000Z",
    },
  }));
  assert.deepEqual(item.progress, {
    practiceTrailCount: 3,
    lastCanonicalAt: "2026-09-19T08:00:00.000Z",
    reviewDueAt: "2026-09-25T08:00:00.000Z",
    initialValidation: null,
    validationNotBefore: null,
  });
});

test("「还没安排」的 initialValidation 不把服务端内部枚举 idle 透给客户端", () => {
  const item = toObjectiveListItemV3(surface({
    initialValidation: {
      reminderId: "33333333-3333-4333-8333-333333333333",
      status: "idle",
      qualificationNotBefore: null,
    },
  }));
  assert.equal(item.progress.initialValidation, null);
  assert.equal(item.progress.validationNotBefore, null);
});

test("冷却中的正式验证把开放时间点带到列表上", () => {
  const item = toObjectiveListItemV3(surface({
    initialValidation: {
      reminderId: "33333333-3333-4333-8333-333333333333",
      status: "deferred",
      qualificationNotBefore: "2026-09-21T06:00:00.000Z",
    },
  }));
  assert.equal(item.progress.initialValidation, "deferred");
  assert.equal(item.progress.validationNotBefore, "2026-09-21T06:00:00.000Z");
});

// ─── W7-3 刀三：目标级「暂不安排」跟着列表行走 ──────────────────────────
//
// 这一格的作用不是"多一个字段"，是钉住**同一个值**：详情那一格
// （`personal.reviewHold`）与列表这一格（`reviewHold`）必须是同一份。
// 各自查一次排除表的那天，两边就会有一边说"暂不安排"、另一边说没有——
// 而屏上那两颗按钮长在不同的面上，用户点得到却说不清。
//
// 变异自证（改前改后对拍，不另造探针）：把 `toObjectiveListItemV3` 里的
// `reviewHold: surface.personal.reviewHold` 换成 `reviewHold: null` ⇒
// 下面那一格红，正控制那一格仍绿（它本来就该是 null）。

test("排除中的目标：列表行与详情读**同一份**排除（逐字相同，不是重建）", () => {
  const hold = {
    objectiveId: "11111111-1111-4111-8111-111111111111",
    noteId: "44444444-4444-4444-8444-444444444444",
    reasonCode: "user_deferred_objective",
    createdAt: "2026-09-26T02:00:00.000Z",
  };
  const detail = surface({ reviewHold: hold });
  const item = toObjectiveListItemV3(detail);
  // 逐字相同：`deepEqual` 之外的这条是"不许重建"，重建会让 `noteId` 之类
  // 的字段在某一天被挑掉而这里仍然绿。
  assert.equal(item.reviewHold, detail.personal.reviewHold);
  assert.deepEqual(item.reviewHold, hold);
});

test("正对照：没被排除的目标，列表行那个字段是 null 而不是被省略", () => {
  const item = toObjectiveListItemV3(surface());
  assert.ok("reviewHold" in item, "字段不许靠 undefined 表示'没有'——那与'忘了投影'同形");
  assert.equal(item.reviewHold, null);
});
