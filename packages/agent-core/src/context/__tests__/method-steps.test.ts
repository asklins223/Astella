import assert from "node:assert/strict";
import { test } from "node:test";
import { planMethodStepsFromRun } from "../method-steps.ts";

/**
 * 方案 44 §2：方法步骤要来自**这次真实运行**，不是能力目录。
 *
 * 按目录生成的话，同一类任务每次得到的步骤完全一样——那其实没有从这次运行里
 * 提炼到任何东西。这几条把「实际走通的路径」「没走通的」「待核对的」分开。
 */

const renderStep = (capability: string) => `执行 ${capability}`;
const baseline = "当前要求、材料、权限和可用能力优先。";
const plan = (operations: Array<{ capability: string; status: "succeeded" | "failed" | "outcome_unknown" | "cancelled"; error?: string | null }>) =>
  planMethodStepsFromRun({ operations, renderStep, baselineException: baseline });

test("44 §2：步骤按真实顺序取自走通的那条路径", () => {
  const result = plan([
    { capability: "note_read", status: "succeeded" },
    { capability: "card_generate", status: "succeeded" },
    { capability: "card_check", status: "succeeded" },
  ]);
  assert.deepEqual(result.steps, ["执行 note_read", "执行 card_generate", "执行 card_check"]);
  assert.equal(result.contributes, true);
});

test("44 §2：同一能力被反复调用只算一步——那是返工，不是两步做法", () => {
  const result = plan([
    { capability: "note_read", status: "failed", error: "读不到" },
    { capability: "note_read", status: "succeeded" },
    { capability: "card_generate", status: "succeeded" },
  ]);
  assert.deepEqual(result.steps, ["执行 note_read", "执行 card_generate"]);
  assert.equal(result.steps.filter(step => step.includes("note_read")).length, 1);
});

test("44 §2：没走通的进例外，并记下改走了什么——这是「有效替代」", () => {
  const result = plan([
    { capability: "card_generate", status: "succeeded" },
    { capability: "note_expansion", status: "failed", error: "材料里没有可展开的定义" },
  ]);
  assert.deepEqual(result.steps, ["执行 card_generate"]);
  assert.ok(result.exceptions.some(line => line.includes("没有走通") && line.includes("材料里没有可展开的定义")));
  assert.ok(result.exceptions.some(line => line.includes("改走了：执行 card_generate")));
});

test("44 §2：待核对不算走通——它可能已经产生了副作用", () => {
  const result = plan([
    { capability: "note_read", status: "succeeded" },
    { capability: "card_generate", status: "outcome_unknown" },
  ]);
  assert.deepEqual(result.steps, ["执行 note_read"], "待核对的不能写进步骤——那会把没确认的结果说成做法");
  assert.ok(result.exceptions.some(line => line.includes("结果待核对")));
});

test("44 §2：没有替代路径时明说没有，不要默认「换个做法就行」", () => {
  const result = plan([{ capability: "card_generate", status: "failed", error: "上游 503" }]);
  assert.deepEqual(result.steps, []);
  assert.ok(result.exceptions.some(line => line.includes("没有记录到替代路径")));
  // 一条都没走通 → 不硬凑一条做法。
  assert.equal(result.contributes, false);
});

test("44 §2：取消不算失败，也不进例外", () => {
  const result = plan([
    { capability: "note_read", status: "succeeded" },
    { capability: "card_generate", status: "cancelled" },
  ]);
  assert.equal(result.exceptions.length, 1, "只有那句固定边界");
  assert.equal(result.exceptions[0], baseline);
});

test("44 §2：每条做法都带那句固定边界", () => {
  const result = plan([{ capability: "a", status: "succeeded" }]);
  assert.ok(result.exceptions.includes(baseline));
});

test("44 §2：同一条能力既走通又失败时，例外里的替代不会指向它自己", () => {
  const result = plan([
    { capability: "note_read", status: "succeeded" },
    { capability: "note_read", status: "failed", error: "第二次读不到" },
  ]);
  const failureNote = result.exceptions.find(line => line.includes("第二次读不到"))!;
  assert.ok(!failureNote.includes("改走了：执行 note_read"),
    "替代不能是自己——那条已经走通了");
});
