/**
 * Procedural 手册（40 §4.6.10，验收 A69）。
 *
 * ## 为什么这一节值得单独钉
 *
 * 它是 40 §4.5.2 五层用途里**唯一一个此前完全没有实现**的层。
 * 更要紧的是它有两种失败形状，而且都不会报错：
 *
 * - **手册收进 prompt 的全是正文** —— 目录形同虚设，上下文被手册吃满，
 *   而合同要的正是「默认只注入目录」。
 * - **按 ID 展开时不校验版本** —— 用户纠正之后，她还在按旧版做事，
 *   而且「她读的是哪一版」这个问题永远没人能回答。
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  PLAYBOOK_CATALOG_LIMIT,
  renderPlaybookCatalog,
  type PlaybookCatalogEntry,
} from "../companion-playbooks.ts";

const entry = (over: Partial<PlaybookCatalogEntry> = {}): PlaybookCatalogEntry => ({
  playbookId: "11111111-1111-1111-1111-111111111111",
  playbookKey: "讲机制先举例",
  title: "讲机制先举例",
  triggerCondition: "对方第一次接触一个陌生概念",
  version: 1,
  epistemicStatus: "supported",
  ...over,
});

test("目录渲染**不含正文**——步骤与例外不在目录里", () => {
  // 这是 §4.6.10「默认只注入目录」的机械部分。目录里只有标题与触发条件；
  // 正文只能经 companion_read_playbook 展开。
  const rendered = renderPlaybookCatalog([entry()]);
  assert.match(rendered, /讲机制先举例/);
  assert.match(rendered, /对方第一次接触一个陌生概念/);
  // 这两个词只在正文里，正文不该出现在目录
  assert.ok(!/步骤/.test(rendered), "目录里出现了「步骤」");
  assert.ok(!/例外/.test(rendered), "目录里出现了「例外」");
});

test("目录告诉模型**怎么展开**，而不是让它猜", () => {
  const rendered = renderPlaybookCatalog([entry()]);
  assert.match(rendered, /companion_read_playbook/,
    "目录必须说明按 ID 展开的入口，否则模型只会直接照着目录猜着做");
  assert.match(rendered, /不相关就别读/,
    "§4.6.10「条件匹配且与用户目标有关时按需读取」——不相关时不许读");
});

test("空目录渲染成空串——不留一段「暂无手册」的废话进 prompt", () => {
  assert.equal(renderPlaybookCatalog([]), "");
});

test("编号与顺序稳定，便于模型说「第 2 条」", () => {
  const rendered = renderPlaybookCatalog([
    entry({ title: "甲" }),
    entry({ title: "乙", playbookId: "22222222-2222-2222-2222-222222222222" }),
  ]);
  assert.match(rendered, /^1\. 甲/m);
  assert.match(rendered, /^2\. 乙/m);
});

test("争议状态在目录里就标出来——依据被用户纠正过的手册不能装作没事", () => {
  // 遗忘/修订经 0348 的触发器把 epistemic_status 降为 disputed。
  // 目录是模型唯一默认看到的东西，所以这里必须能看见。
  const rendered = renderPlaybookCatalog([entry({ epistemicStatus: "disputed" })]);
  assert.match(rendered, /依据已被用户纠正/);
});

test("有据的与暂定的不加额外噪音", () => {
  const rendered = renderPlaybookCatalog([
    entry({ epistemicStatus: "supported" }),
    entry({ epistemicStatus: "tentative", playbookId: "33333333-3333-3333-3333-333333333333" }),
  ]);
  assert.ok(!rendered.split("\n")[1]?.includes("依据已被用户纠正"));
});

test("目录条数有硬上限——它是要进 prompt 的", () => {
  // §4.6.10 明确「不造无界文件浏览器」。目录无界就等于把手册全量塞进上下文。
  assert.ok(PLAYBOOK_CATALOG_LIMIT > 0 && PLAYBOOK_CATALOG_LIMIT <= 64,
    `目录上限 ${PLAYBOOK_CATALOG_LIMIT} 不合理：要么没界，要么大到吃掉上下文`);
});

test("【自证】判据认得出「目录里塞正文」这个真实退化", () => {
  const leaky = [
    "（表达与协作手册）",
    "1. 讲机制先举例｜触发：第一次接触｜步骤：先给例子｜例外：他已经懂了",
  ].join("\n");
  assert.match(leaky, /步骤：/, "自证样本没造好：退化目录确实带正文");
  // 正确渲染里这两个词一次都不该出现。
  const good = renderPlaybookCatalog([entry()]);
  assert.ok(!/步骤|例外/.test(good), "自证：正确的目录确实不含正文");
});