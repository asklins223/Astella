import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRoundReadingPlan, suggestRoundQuestion } from "./learning-plan.ts";

const blocks = [{ ordinal: 1, type: "heading", text: "## 条件" }, { ordinal: 2, type: "heading", text: "## 步骤" }];
test("a server suggestion names saved structure without demanding a form", () => {
  assert.match(suggestRoundQuestion("笔记", blocks), /条件/);
  assert.ok(suggestRoundQuestion("", []).length > 0);
});
test("rewritten question selects its named section and keeps a finite reading route", () => {
  const plan = buildRoundReadingPlan("先学步骤", blocks);
  assert.equal(plan.steps.length, 2); assert.match(plan.steps[0].text, /步骤/);
  assert.ok(!plan.steps[0].text.includes("「条件」"));
});
test("empty or huge heading text stays inside the plan contract", () => {
  assert.equal(buildRoundReadingPlan("问题", []).steps.length, 2);
  assert.ok(buildRoundReadingPlan("问题", [{ ordinal: 1, type: "heading", text: "字".repeat(5000) }]).steps[0].text.length < 500);
});

// 这一条盯的是真窗口里看到的那件事：问题句已经作为大标题印在纸面上了，
// 计划里再抄一遍，屏上就是同一个句子连着出现三遍——一堵没有信息量的字墙。
// 计划只准说标题没说的两件事：读哪几段、怎么检验。
test("计划不重打标题：没有小节时也不把问题句抄进每一步", () => {
  const question = "为什么有索引查询仍然可能慢？";
  for (const blocks of [[], [{ ordinal: 1, type: "heading", text: "## 完全不相干的一节" }]]) {
    const plan = buildRoundReadingPlan(question, blocks as never);
    for (const step of plan.steps) {
      assert.ok(
        !step.text.includes(question),
        `步骤里不该再出现问题原句：${step.text}`,
      );
    }
    // 收尾那一步讲的是**怎么检验**，不是检验什么——它必须有，但不带对象。
    const last = plan.steps.at(-1)!.text;
    assert.match(last, /例子/, "收尾那一步仍然要说明怎么检验");
    assert.ok(!last.includes("？"), "收尾那一步不重复问题");
  }
});
