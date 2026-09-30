/**
 * 核心路线册页在屏上的那几句话（39d W4-5 ③；PRD §4.4、§4.1、§5.6）。
 *
 * 每条判据都对着 §4.4／§4.1／§5.6 的一句话，且都做过**变异自证**（见交付说明）：
 * 把实现改坏，确认红在**这一条**上，而不是红在渲染错误上。
 */
import { expect, it } from "vitest";
import { ROUTE_QUESTION_STATE_COPY_V1, routeVerdictCopyV1 } from "../notebook/route-coverage-copy.ts";

it("§4.4：借助完成的那一次**单独报数**，屏上不说「全部会用」", () => {
  const copy = routeVerdictCopyV1({
    kind: "route_complete", totalCount: 3, coveredCount: 3, assistedCount: 2,
    scopeAdjustmentReason: null, uncoveredByState: {},
  });
  // §4.4 原话「借助完成和仍需帮助另外列出，不宣称全部会用」。
  expect(copy).toMatch(/其中 2 个是借着帮助完成的/);
  expect(copy).not.toMatch(/全部会用|全部掌握|完全掌握/);
  // 变异自证：把 assistedCount 那一段删掉 ⇒ 本条红。
});

it("§4.1：一个核心问题都没有时是「还不承诺覆盖」，不是「已完成」", () => {
  const copy = routeVerdictCopyV1({
    kind: "no_questions", totalCount: 0, coveredCount: 0, assistedCount: 0,
    scopeAdjustmentReason: null, uncoveredByState: {},
  });
  // 变异自证：no_questions 也发「都过一���了」⇒ 本条红。
  expect(copy).toMatch(/还没有整理出核心路线/);
  expect(copy).not.toMatch(/都学过/);
  // §4.1：目录不可靠时不给出全篇覆盖百分比。
  expect(copy).not.toMatch(/[%％]/);
});

it("§4.4 末句：范围缩小过时把理由**念出来**，且不承诺没走到的部分", () => {
  const copy = routeVerdictCopyV1({
    kind: "route_complete_within_adjusted_scope", totalCount: 2, coveredCount: 2, assistedCount: 0,
    scopeAdjustmentReason: "这次只走前两段", uncoveredByState: {},
  });
  expect(copy).toMatch(/按后来调整过的范围完成了/);
  expect(copy).toMatch(/这次只走前两段/);
  // 变异自证：只换口径不念理由（把 reason 丢掉）⇒ 本条红。
});

it("§4.4：没走到的**按状态说不同的话**，且每档都不许被说成「你不会」", () => {
  const copy = routeVerdictCopyV1({
    kind: "route_incomplete", totalCount: 5, coveredCount: 2, assistedCount: 0,
    scopeAdjustmentReason: null,
    uncoveredByState: { skipped_by_user: 1, blocked_by_material_conflict: 2, not_attempted: 1 },
  });
  expect(copy).toMatch(/1 个你跳过了/);
  expect(copy).toMatch(/2 个材料自己矛盾/);
  expect(copy).toMatch(/1 个还没练过/);
  // §4.1：不将沉默与跳过记作能力不足。
  expect(copy).not.toMatch(/不会/);
  // §4.1 也不要百分比。
  expect(copy).not.toMatch(/[%％]/);
  // 变异自证：把 skipped_by_user 那一档的词改成"不会" ⇒ 本条红。
});

it("§5.5：「我们判不了」与自己明说「不会」是**两句不同的话**", () => {
  // §4.1 明写不能把用户明说的「不会」报成系统的判不准，所以两档的词不许相同。
  expect(ROUTE_QUESTION_STATE_COPY_V1.not_assessable.label)
    .not.toBe(ROUTE_QUESTION_STATE_COPY_V1.still_needs_help.label);
  expect(ROUTE_QUESTION_STATE_COPY_V1.not_assessable.label).toBe("我们判不了");
  // 变异自证：把 still_needs_help 的词改成同一句 ⇒ 本条红。
});

it("§4.4：九档状态每一档都有一句屏上能念的话，没有一档是空的", () => {
  for (const [state, copy] of Object.entries(ROUTE_QUESTION_STATE_COPY_V1)) {
    expect(copy.label.length, `${state} 没有文案`).toBeGreaterThan(0);
  }
  // 变异自证：删掉一档 ⇒ 本条红（那一档会渲染成一枚空签）。
  expect(Object.keys(ROUTE_QUESTION_STATE_COPY_V1).length).toBe(9);
});

it("§4.1：没有任何一档状态的话里出现百分比或「掌握」", () => {
  // 一个百分比或一句「掌握」会把"还差着"读成"她会了"——这正是 §4.1 要防的。
  for (const [state, copy] of Object.entries(ROUTE_QUESTION_STATE_COPY_V1)) {
    expect(copy.label, `${state} 的文案里出现了百分比或「掌握」`).not.toMatch(/[%％]|掌握/);
  }
  // 变异自证：给某一档加上「掌握 80%」⇒ 本条红。
});
