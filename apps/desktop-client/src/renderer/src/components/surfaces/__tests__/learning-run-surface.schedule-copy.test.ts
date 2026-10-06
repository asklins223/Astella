/**
 * 「本次没有改变复习安排」的**逐档文案**（39d W5-6 刀一补测 + 刀三）。
 *
 * 为什么这一份值得单独存在：`scheduleImpactText` 末尾是
 * `scheduleReasonLabels[impact.reasonCode] ?? impact.reasonCode`——
 * **兜底会把内部词原样念给用户**。而 §9.1/§14.2 新增的两档
 * （`objective_held` 本人说了"暂不安排"、`assessment_disputed` 争议未决）
 * 在补进那张表之前，正正走的就是这条兜底。
 *
 * 2026-09-27 的实情：`learning-run-surface.result.test.tsx` 37 条全绿，
 * 但 `objective_held` 那一行在**整个 renderer 里没有任何断言**——
 * 也就是说那张表少一档不会红，只会静默地把内部词漏给用户。
 *
 * 2026-09-29：**这份测试不再读源码。** 原先它用 `readFileSync(learning-run-surface.tsx)`
 * 抠出那张表的字面量，于是 `learning-run-surface.tsx` 一旦被拆分就红——
 * 而「测试红了就意味着不能拆」这条推理，会让拆分被无限推迟。改成直接 import 断言，
 * 断言强度反而更高：原来只能看**值**，现在能看 `scheduleImpactText` 真正**返回的那句话**。
 */
import { describe, expect, it } from "vitest";
import { facetText, scheduleImpactText, scheduleReasonLabels } from "../run/learning-run-copy.tsx";

/** 合同里 `kind: "none"` 那一支的 reasonCode 全集（来自 @astella/shared）。 */
const CONTRACT_REASON_CODES = [
  "not_authorized",
  "facet_only",
  "record_only",
  "practice_only",
  "diagnostic_only",
  "sandbox",
  "not_assessable",
  "objective_held",
  "note_evidence_changed",
  "assessment_disputed",
  "skipped",
  "ended",
  "stale",
] as const;

/** 走 `kind: "none"` 那一支，把某档的真实屏上文案取出来。 */
const screenTextFor = (reasonCode: string) =>
  scheduleImpactText({
    kind: "none",
    reasonCode,
    nextDueAt: null,
    reasonDetail: "",
  } as Parameters<typeof scheduleImpactText>[0]);

describe("scheduleImpact 的逐档文案", () => {
  it("同一能力的多条证据只显示一次能力名称", () => {
    expect(facetText(["recall", "recall", "boundary"], "暂无")).toBe("回忆、边界");
  });

  it("无法判定和未知的要点不被显示为需要补齐的能力", () => {
    const text = scheduleImpactText({ kind: "none", reasonCode: "facet_only" }, [
      { facet: "recall", verdict: "covered" },
      { facet: "boundary", verdict: "not_assessable" },
      { facet: "procedure", verdict: "unknown" },
      { facet: "relate", verdict: "partial" },
    ]);
    expect(text).toContain("还差 关联");
    expect(text).not.toContain("边界");
    expect(text).not.toContain("过程");
  });

  it("合同里每一档 reasonCode 都有一句人话，不许落到兜底", () => {
    const missing = CONTRACT_REASON_CODES.filter((code) => !(code in scheduleReasonLabels));
    expect(missing, `这些档会走 \`?? impact.reasonCode\` 的兜底，把内部词念给用户：${missing.join(", ")}`).toEqual([]);
  });

  it("兜底句对**任何已知档**都不生效（新增一档时它得先有一句人话）", () => {
    for (const code of CONTRACT_REASON_CODES) {
      expect(code in scheduleReasonLabels, `${code} 缺文案`).toBe(true);
      // 真正走一遍兜底那条路径：屏上那句话必须与内部词不同
      expect(screenTextFor(code), `${code} 的屏上文案原样念出了内部词`).not.toContain(code);
    }
  });

  it("§9.1 与 §14.2 那两档说的是两件不同的事，不许共用一句", () => {
    const held = scheduleReasonLabels.objective_held;
    const disputed = scheduleReasonLabels.assessment_disputed;
    // 本人主动说了「暂不安排」 vs 我正在申诉上次判定——界面上必须能让人分清。
    expect(held).not.toBe(disputed);
    expect(held).toContain("暂不安排");
    expect(disputed).toContain("异议");
  });

  it("两档都不许把内部词漏给用户", () => {
    for (const leaked of ["objective_held", "assessment_disputed", "note_evidence_changed", "stale", "facet_only"]) {
      expect(scheduleReasonLabels[leaked], `${leaked} 出现在**值**里，等于把它念给用户了`).not.toContain(leaked);
      // 更进一步：屏上真正呈现的那句话也不能含它
      expect(screenTextFor(leaked), `${leaked} 出现在屏上文案里`).not.toContain(leaked);
    }
    // 反向自检：上面那些断言不是空的
    expect(screenTextFor("objective_held")).toContain("暂不安排");
    expect(screenTextFor("assessment_disputed")).toContain("异议");
  });
});
