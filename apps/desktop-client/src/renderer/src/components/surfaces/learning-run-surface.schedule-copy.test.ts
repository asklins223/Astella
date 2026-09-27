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
 * 这一份把"表里必须有的档"钉住，并且**顺带钉住一件更要紧的事**：
 * 兜底句**不许**对任何已知档生效（否则新增一档又会静默退化）。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SURFACE = resolve(dirname(fileURLToPath(import.meta.url)), "learning-run-surface.tsx");
const source = readFileSync(SURFACE, "utf8");

/** 从源码里抽出那张表的键——直接从真源码读，而不是在这里再抄一份。 */
function labelKeys(): string[] {
  const at = source.indexOf("const scheduleReasonLabels: Record<string, string> = {");
  expect(at, "scheduleReasonLabels 不见了").toBeGreaterThan(-1);
  const open = source.indexOf("{", at);
  const close = source.indexOf("\n};", open);
  const body = source.slice(open + 1, close);
  return [...body.matchAll(/^\s{2}([a-z_]+):/gm)].map((m) => m[1]);
}

/** 合同里 `kind: "none"` 那一支的 reasonCode 全集（来自 @ailearn/shared）。 */
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

describe("scheduleImpact 的逐档文案", () => {
  it("合同里每一档 reasonCode 都有一句人话，不许落到兜底", () => {
    const keys = new Set(labelKeys());
    const missing = CONTRACT_REASON_CODES.filter((code) => !keys.has(code));
    expect(missing, `这些档会走 \`?? impact.reasonCode\` 的兜底，把内部词念给用户：${missing.join(", ")}`)
      .toEqual([]);
  });

  it("兜底句对**任何已知档**都不生效（新增一档时它得先有一句人话）", () => {
    const keys = new Set(labelKeys());
    for (const code of CONTRACT_REASON_CODES) {
      expect(keys.has(code), `${code} 缺文案`).toBe(true);
    }
  });

  it("§9.1 与 §14.2 那两档说的是两件不同的事，不许共用一句", () => {
    const at = source.indexOf("const scheduleReasonLabels");
    const body = source.slice(at, source.indexOf("\n};", at));
    const pick = (key: string) => {
      const m = new RegExp(`${key}:\\s*"([^"]*)"`).exec(body);
      expect(m, `没找到 ${key} 的文案`).not.toBeNull();
      return m![1]!;
    };
    const held = pick("objective_held");
    const disputed = pick("assessment_disputed");
    // 本人主动说了「暂不安排」 vs 我正在申诉上次判定——界面上必须能让人分清。
    expect(held).not.toBe(disputed);
    expect(held).toContain("暂不安排");
    expect(disputed).toContain("异议");
  });

  it("两档都不许把内部词漏给用户", () => {
    const at = source.indexOf("const scheduleReasonLabels");
    const body = source.slice(at, source.indexOf("\n};", at));
    // 只看**值**。两处细节：
    //  - 键与值在**同一行**（`key: "…"`），所以只能剥掉行首的 `key:`，
    //    整行丢掉就等于把值也丢了（第一版就是这么写成空断言的）；
    //  - 表里有几行注释提到了 `objective_held` 那些词，那是解释为什么补这一档，
    //    不是漏给用户的文案，所以先滤掉注释行。
    const valueText = body
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\/\*)/.test(line))
      .map((line) => line.replace(/^\s*[a-z_]+:\s*/, ""))
      .join("\n");
    for (const leaked of ["objective_held", "assessment_disputed", "note_evidence_changed", "stale", "facet_only"]) {
      expect(valueText, `${leaked} 出现在**值**里，等于把它念给用户了`).not.toContain(leaked);
    }
    // 反向自检：剥完之后确实还剩下值，否则上面那条是空断言。
    expect(valueText).toContain("暂不安排");
    expect(valueText).toContain("异议");
  });
});
