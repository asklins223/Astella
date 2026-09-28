/**
 * 「先看笔记」那一发（39d W5-4；PRD §7.1、§16.24、§9.2、§14.1.1）。
 *
 * 三组判据：
 *  1. **落哪一档**（`answer_reveal`）：读的是来源正文，答案就从那份正文里冻结出来，
 *     与轮次教学那一档（`round-target.ts:141-144`）必须同档——不一致就等于
 *     「先看笔记」被静默降级成线索级，而 §7.1「如实按本次暴露条件处理」也就没了。
 *  2. **只写这一行**（§9.2「三种事实分别记录」）：这一发**不碰提醒、不写学习观察**。
 *     源码形状钉住，因为删掉一次 `insert` 不可能有别的测试红。
 *  3. **合同形状**：回执那几格必填（屏上那句话与条件上限都从那儿来）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  recordRecallSourceRevealRequestV1Schema,
  recordRecallSourceRevealResultV1Schema,
} from "@ailearn/shared/recall-waiting-v2-contracts";

// apps/api/src/modules/review → 上溯五级才是仓库根。
const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..", "..");
const SERVICE_FILE = join(REPO_ROOT, "apps/api/src/modules/review/recall-reveal-service.ts");
const SOURCE = readFileSync(SERVICE_FILE, "utf8");

const OBJECTIVE = "33333333-3333-4333-8333-333333333333";

test("§7.1：「先看笔记」落**答案级**暴露，不是线索级", () => {
  // 变异自证：把 `answer_reveal` 改成 `evidence_reveal` ⇒ 本条红。
  assert.match(SOURCE, /exposureKind:\s*"answer_reveal"/,
    "读的是来源正文（答案就从那份正文里冻结出来），必须是答案级");
  assert.doesNotMatch(SOURCE, /exposureKind:\s*"evidence_reveal"/,
    "线索级会让这一次被当成「只是看了一眼出处」");
});

test("§16.24 / §9.2：这一发**只**写暴露账——不碰提醒、不写学习观察", () => {
  // 变异自证：加一句 `reviewSchedules` 的 update ⇒ 本条红。
  for (const forbidden of ["reviewSchedules", "review_schedules", "learningObjectives", "learning_objectives", "learningRuns", "learning_runs"]) {
    assert.equal(SOURCE.includes(forbidden), false, `这一发碰到了 ${forbidden}——暴露与提醒/学习判定必须分开记（§9.2）`);
  }
  // 幂等的那一句必须在：`onConflictDoNothing` 之后回读既有那一笔，
  // 而不是报冲突（§7.1：用户点了那颗按钮，屏上要拿得到"记上了"）。
  assert.match(SOURCE, /onConflictDoNothing\(\)/);
  assert.match(SOURCE, /idempotencyKey:\s*scopedKey/);
});

test("§7.1：幂等键带上空间与用户，两个目标不会撞同一把键", () => {
  // 变异自证：把 scopedKey 换回原始 idempotencyKey ⇒ 本条红。
  assert.match(SOURCE, /const scopedKey = `recall-source-reveal:\$\{scope\.workspaceId\}:\$\{scope\.userId\}:\$\{idempotencyKey\}`/,
    "幂等键必须带上空间与用户，否则两个目标共用一把键会互相吞掉一次揭示");
  // 那一行构造出来的键要真的被写进去（不是建了不用）。
  assert.match(SOURCE, /idempotencyKey:\s*scopedKey/);
});

test("§7.1 / §14.1.1：回执说清条件上限，**不**在这里下「不算独立」的判决", () => {
  const result = recordRecallSourceRevealResultV1Schema.parse({
    version: 1,
    exposureId: "44444444-4444-4444-8444-444444444444",
    objectiveId: OBJECTIVE,
    exposedAt: "2026-09-27T10:00:00.000Z",
    alreadyRecorded: false,
    conditionsAfter: "practice_only",
    userFacingLabel: "已经记下了：这一次回忆的作答按看过材料来算，不会算成独立提取。",
  });
  // 屏上那句话必须真的提到"不会算成独立"——§7.1「如实按本次暴露条件处理」。
  assert.match(result.userFacingLabel, /不会算成独立提取/);
  assert.equal(result.conditionsAfter, "practice_only");
  // 缺格会被挡（屏上那句话不是可选的）。
  const { userFacingLabel: _drop, ...withoutLabel } = result;
  assert.equal(recordRecallSourceRevealResultV1Schema.safeParse(withoutLabel).success, false);
});

test("§7.1：请求不许带任何「我看过多少」的自报", () => {
  const base = { objectiveId: OBJECTIVE, waitingKind: "independent_recall" as const, idempotencyKey: "k1" };
  assert.equal(recordRecallSourceRevealRequestV1Schema.safeParse(base).success, true);
  // 变异自证：多带一格自报 ⇒ 本条红（`strict()` 是这里的执法点）。
  assert.equal(recordRecallSourceRevealRequestV1Schema.safeParse({ ...base, sawNothing: true }).success, false);
  assert.equal(recordRecallSourceRevealRequestV1Schema.safeParse({ ...base, helpCondition: "independent" }).success, false);
});

test("§7.1：请求缺 `waitingKind` 会被拒（两档不许由界面默认）", () => {
  // 变异自证：给 `waitingKind` 加 `.default("independent_recall")` ⇒ 本条红。
  assert.equal(recordRecallSourceRevealRequestV1Schema.safeParse({
    objectiveId: OBJECTIVE, idempotencyKey: "k1",
  }).success, false, "等待档位必须由调用方明确说，不许有默认值兜底");
});
