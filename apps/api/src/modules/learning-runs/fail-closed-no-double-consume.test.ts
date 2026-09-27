/**
 * W7-8 刀五：「失败后的保守展示与最终评估**不各消费一次同一日程**」。
 *
 * ## 这一格今天靠两件事成立，两件都长得像实现细节
 *
 *  1. **fail-closed 那条路 0 排期副作用**。评估失败（网络、形状不合、Critic 报错）时
 *     走 `not_assessable`：只把 `learning_assessments.status` 置成那一档、追加一个
 *     事件、把 run 打成 `checkpoint`，**不调任何 `apply*Schedule`**。所以结果页上那个
 *     **保守展示**（"这一次没能给出结论"）没有消费过那一格——后面的最终评估才有得消费。
 *     若它消费了，最终评估落地时那一格已经被 `consume_pending` 标成 `completed`，
 *     用户等于**同一格被算两次**：一次"她没做对"，一次"她做对了"。
 *  2. **一次 generation 至多被消费一次**。`consume_pending` 的那一支带 generation CAS
 *     （`run-processing-tick.ts`），同一条 `scheduleGeneration` 第二次来时取不到行 ⇒
 *     `stale`、0 副作用。这挡住"失败那一格又补一次展示、再补一次最终评估"的叠加。
 *
 * ## 为什么还要专门钉
 *
 * `not_assessable` 那一段今天**离得很远**——它在文件前部，而消费那一道在后部，两者
 * 之间隔着整个评估流程。任何人"顺手给失败路径补一个结算"（看起来像"让失败也有回执"）
 * 都不会让任何测试红，而后果是**同一格被消费两次**——屏上读不出来：两边的数字各自
 * 都合理。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const TICK = readFileSync(
  join(import.meta.dirname, "..", "..", "..", "..", "..", "apps/api/src/modules/learning-runs/run-processing-tick.ts"),
  "utf8",
);

/** fail-closed 那一支的函数体：从它落地 `not_assessable` 那一行起，往后取一段。 */
function failClosedBlock(): string {
  const at = TICK.indexOf('.set({ status: "not_assessable"');
  assert.ok(at > 0, "文件里找不到 not_assessable 那一档：这一判据的形状变了，要按新形状重写");
  return TICK.slice(at, at + 1600);
}

test("W7-8 刀五：fail-closed 那一支**不调任何 apply*Schedule**（保守展示没消费那一格）", () => {
  const block = failClosedBlock();
  // 这一段里出现任何一个 apply*Schedule，就意味着"失败也有回执"被顺手接上了——
  // 而那正是同一格被消费两次的开头。
  const offenders = block.match(/apply(Demonstrated|Unable)Schedule\(/g) ?? [];
  assert.deepEqual(offenders, [],
    `fail-closed 那一支里出现了 ${offenders.length} 次结算调用：`
    + "失败后的保守展示消费了那一格，后面的最终评估就消费不到（或消费第二次）。");
  assert.ok(!/ensurePendingReviewScheduleV2/.test(block),
    "fail-closed 那一支写了排期：保守展示不该有排期副作用");
});

test("W7-8 刀五 正对照：fail-closed 那一支**确实**落了那三件事（不是把整段删了）", () => {
  // 与上一条配套：上一条在"整段被删掉"的情况下会绿，而那正是缺陷——保守展示连
  // `not_assessable` 都不落，用户看到的是空白而不是一句保守的读数。
  const block = failClosedBlock();
  assert.match(block, /status: "not_assessable"/);
  assert.match(block, /learning_assessment\.not_assessable/,
    "没有追加那个事件：审计里看不出这一次没能给出结论");
  assert.match(block, /kind: "not_assessable"/,
    "run 没有打成 not_assessable checkpoint：续做与结果页都读不到那个形状");
});

test("W7-8 刀五 正对照：一次 generation 至多被消费一次（CAS 那一道仍在）", () => {
  assert.match(
    TICK,
    /eq\(reviewSchedules\.generation, authorization\.scheduleGeneration\)/,
    "消费那一支的 generation CAS 没了：同一格可以被消费两次。",
  );
});

test("W7-8 刀五：`declared_unable` 与 `not_assessable` 是**两件不同的事**", () => {
  // 用户明说"做不到"（declared_unable）要走结算；系统没给出结论（not_assessable）
  // 不走。把两者合成一档，就会让"系统没结论"也消费那一格。
  assert.match(TICK, /deterministic_declared_unable/,
    "declared_unable 那一支不见了");
  assert.match(TICK, /finishDeclaredUnableAssessment/,
    "用户明说做不到的那一档没有走结算");
  assert.notEqual(
    TICK.indexOf("finishDeclaredUnableAssessment(tx, command, assessmentId, run, at)"),
    -1,
    "declared_unable 那一档没有真的调结算",
  );
});
