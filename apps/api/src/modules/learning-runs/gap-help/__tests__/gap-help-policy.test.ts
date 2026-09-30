/**
 * 缺口帮助停止规则的纯函数半边（39d W4-6 刀四）。
 *
 * 这一份不碰库、不碰网络：七档结论怎么归类、"连续帮助"怎么数、到没到该停的那一格、
 * 阈值怎么签发。落库与拦截在 `gap-help-service.ts` 与 `run-processing-tick.ts` 那一侧。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_GAP_HELP_STOP_THRESHOLD_V1,
  GAP_HELP_STOP_OPTIONS_V1,
  classifyGapOutcomeV1,
  consecutiveHelpCountWithoutImprovementV1,
  gapHelpStopThresholdV1,
  shouldStopAutoAddingQuestionsV1,
  type GapHelpTimelineEntryV1,
  type LearningRunOutcomeNameV1,
} from "../gap-help-policy.ts";

const help: GapHelpTimelineEntryV1 = { kind: "help" };
const outcome = (value: LearningRunOutcomeNameV1): GapHelpTimelineEntryV1 => ({ kind: "outcome", outcome: value });

test("七档结论一档不漏地归类：改善 / 明说的没改善 / 不知道", () => {
  assert.equal(classifyGapOutcomeV1("demonstrated"), "improved");
  assert.equal(classifyGapOutcomeV1("partial"), "not_improved");
  assert.equal(classifyGapOutcomeV1("needs_repair"), "not_improved");
  assert.equal(classifyGapOutcomeV1("not_assessable"), "unknown");
  assert.equal(classifyGapOutcomeV1("practice_completed"), "unknown");
  assert.equal(classifyGapOutcomeV1("skipped"), "unknown");
  assert.equal(classifyGapOutcomeV1("declared_unable"), "unknown");
  // 没结论 / 不认识的字符串都不算结论（读侧只认合同里的七档）。
  assert.equal(classifyGapOutcomeV1(null), null);
  assert.equal(classifyGapOutcomeV1("something_else" as never), null);
});

test("连续帮助次数：从后往前数，遇到最近一次「改善」就清零", () => {
  assert.equal(consecutiveHelpCountWithoutImprovementV1([]), 0);
  assert.equal(consecutiveHelpCountWithoutImprovementV1([help]), 1);
  assert.equal(consecutiveHelpCountWithoutImprovementV1([help, help]), 2);
  // 改善之后的帮助才开始重新累计；改善之前那几次不算"连续"。
  assert.equal(consecutiveHelpCountWithoutImprovementV1([help, help, outcome("demonstrated"), help]), 1);
  // 没改善的两类都不重置（它们只是"这一次没带来改善"）。
  assert.equal(consecutiveHelpCountWithoutImprovementV1([help, outcome("needs_repair"), help]), 2);
  assert.equal(consecutiveHelpCountWithoutImprovementV1([help, outcome("not_assessable"), help]), 2);
  assert.equal(consecutiveHelpCountWithoutImprovementV1([outcome("demonstrated")]), 0);
});

test("该不该停：到阈值且最近一次不是改善就停；改善过就不停", () => {
  const threshold = DEFAULT_GAP_HELP_STOP_THRESHOLD_V1;
  // 一次帮助 + 一次"还有要补的"：还没到两次，继续。
  assert.deepEqual(
    shouldStopAutoAddingQuestionsV1({ timeline: [help, outcome("needs_repair")], threshold }),
    { stopped: false, consecutiveHelpCount: 1 },
  );
  // 两次帮助 + 明说的没改善：停。
  assert.deepEqual(
    shouldStopAutoAddingQuestionsV1({ timeline: [help, outcome("partial"), help, outcome("needs_repair")], threshold }),
    { stopped: true, consecutiveHelpCount: 2 },
  );
  // 两次帮助 + 判不了：也停（停的是"自动加题"，不是对用户下判断）。
  assert.deepEqual(
    shouldStopAutoAddingQuestionsV1({ timeline: [help, outcome("not_assessable"), help], threshold }),
    { stopped: true, consecutiveHelpCount: 2 },
  );
  // 两次帮助之间一次结论都没有：同样按"没有改善的证据"算。
  assert.deepEqual(
    shouldStopAutoAddingQuestionsV1({ timeline: [help, help], threshold }),
    { stopped: true, consecutiveHelpCount: 2 },
  );
  // 最近一次是改善：不停（哪怕之前帮过两次）。
  assert.deepEqual(
    shouldStopAutoAddingQuestionsV1({ timeline: [help, help, outcome("demonstrated")], threshold }),
    { stopped: false, consecutiveHelpCount: 0 },
  );
  // 阈值是参数，不是逻辑里的常数：`1` 这一档真的"帮一次就停"。
  assert.equal(
    shouldStopAutoAddingQuestionsV1({ timeline: [help, outcome("needs_repair")], threshold: 1 }).stopped,
    true,
  );
});

test("「两次」由冻结值签发：默认 2、env 可覆盖、坏值回落默认", () => {
  assert.equal(gapHelpStopThresholdV1(), 2);
  process.env.NOTE_ROUND_GAP_HELP_STOP_THRESHOLD = "3";
  try {
    assert.equal(gapHelpStopThresholdV1(), 3);
    process.env.NOTE_ROUND_GAP_HELP_STOP_THRESHOLD = "1";
    assert.equal(gapHelpStopThresholdV1(), 1, "1 是合法值（帮一次就停）");
    process.env.NOTE_ROUND_GAP_HELP_STOP_THRESHOLD = "0";
    assert.equal(gapHelpStopThresholdV1(), 2, "0 是坏值");
    process.env.NOTE_ROUND_GAP_HELP_STOP_THRESHOLD = "两";
    assert.equal(gapHelpStopThresholdV1(), 2, "不是数也是坏值");
  } finally {
    delete process.env.NOTE_ROUND_GAP_HELP_STOP_THRESHOLD;
  }
});

test("四档选项就是 PRD 那四档，顺序固定（呈现顺序由这一处说了算）", () => {
  assert.deepEqual([...GAP_HELP_STOP_OPTIONS_V1], [
    "switch_explanation",
    "add_prerequisite",
    "back_to_material",
    "end_round",
  ]);
});
