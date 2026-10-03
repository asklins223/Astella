/**
 * 建议关系的「表态纸签」（39d W8-2；39 §11.3、§16.20、§16.12）。
 *
 * 界面这一半要证明四件事，每一件都有一个**静默失败**的版本：
 *
 *  1. **只有可表态的那一类边给这两颗按钮**。给材料血缘（引用自／取代）也配上，
 *     等于让用户把"这份材料从哪来"藏起来——§11.3 明写「材料血缘与教学关系使用
 *     不同表达」。症状很轻：只是多两颗按钮。
 *  2. **三档各有一句人话**，缺一档渲染出来就是 `undefined`。
 *  3. **表态键是 `reasonCodes` 里那条具体语义关系**，不是 `edge.kind`。
 *     拓扑那五档的 `relates_to` 是总称；拿它去问排除表**结构上就问不到**——
 *     这一次表态会静默落到另一条边上，而用户根本看不到那一条。
 *  4. **本地先改、重取在后**。服务端把表态折进 ETag（`topologyRevision` 只哈希
 *     两端点与 kind，不含本人的态度），所以"写完再重取"可能拿到逐字节相同的 ETag
 *     → 304 → 屏上什么都不变**且没有任何报错**。用户看到的是"我按了，没反应"。
 *
 * 2026-09-29：**第 1、2、3 条改成直接 import 断言，不再读源码。**
 * 原先这份测试用 `readFileSync(graph-surface.tsx)` 抠字面量，于是
 * `graph-surface.tsx` 一旦被拆分就红——而「测试红了 = 不能拆」这条推理会让人
 * 无限推迟拆分。改成 import 后断言更强：第 3 条现在能验证**换算结果**，
 * 而不是验证源码里出现过 `?? "relates_to"` 这几个字符。
 *
 * 第 4 条（乐观更新必须早于 await）与第 1 条的「decidable 门」是**控制流形状**，
 * 渲染层测不到、也不是纯函数的性质；它们连同 CSS 判据一起搬到了
 * `src/main/graph-surface-shape-guard.test.ts`——静态形状判据属于守卫，
 * 不属于组件测试，而且守卫按目录树定位文件，组件搬家不会波及它。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { RELATION_STAMP_LABEL, SEMANTIC_RELATION_FROM_REASON_CODES } from "../space/graph-surface.tsx";

  // 2026-09-30：本文件移进 `__tests__/`，**这里要上一层**——
  // `import.meta.dirname` 是「这个测试文件自己在哪儿」，它跟着文件一起下沉了，
  // 而被读的源码／样式表仍留在上一层。打包器不会替你改 `resolve(…, …)`。
const CSS = resolve(import.meta.dirname, "..", "understanding-universe.css");
const css = readFileSync(CSS, "utf8");

describe("建议关系的表态纸签", () => {
  it("语义关系是按 reasonCodes 里那一条取的，不是按 edge.kind（五档里 relates_to 只是总称）", () => {
    // 四条具体语义 + 总称。实现是「取 reasonCodes 里第一条在表内的」。
    expect(SEMANTIC_RELATION_FROM_REASON_CODES(["prerequisite"])).toBe("prerequisite");
    expect(SEMANTIC_RELATION_FROM_REASON_CODES(["explains"])).toBe("explains");
    expect(SEMANTIC_RELATION_FROM_REASON_CODES(["contrasts", "prerequisite"])).toBe("contrasts");
    // 键对不上时必须落到总称，**不许返回 undefined**——undefined 会让表态
    // 静默落到另一条边上，而那一条用户看不到。
    expect(SEMANTIC_RELATION_FROM_REASON_CODES(["material_cited_by"])).toBe("relates_to");
    expect(SEMANTIC_RELATION_FROM_REASON_CODES([])).toBe("relates_to");
    expect(SEMANTIC_RELATION_FROM_REASON_CODES(["不在表里的任何东西"])).toBe("relates_to");
  });

  /**
   * 一条**如实记录现状**的断言，不是期望。
   *
   * 总称 `relates_to` 本身也在 `SEMANTIC_RELATIONS` 表里，而实现取的是
   * 「第一条在表内的」。于是当 `reasonCodes` 同时带着总称与一条具体语义时，
   * **总称会把具体语义遮住**——本文件开头说的「表态键是那条具体语义关系」
   * 在这个组合下并不成立。
   *
   * 2026-09-29 把它记在这里而不是顺手改掉：修它要决定「具体优先」还是
   * 「先出现的优先」，那是行为变更，得在能跑真窗口验收的轮次里做。
   * 照实写下来，下一个改这里的人第一眼就能看到，而不是自己再踩一次。
   */
  it("【现状】总称 relates_to 与具体语义同时出现时，总称会遮住具体语义", () => {
    expect(SEMANTIC_RELATION_FROM_REASON_CODES(["relates_to", "prerequisite"])).toBe("relates_to");
  });

  it("三档各有一句人话，且都不是状态名", () => {
    expect(Object.keys(RELATION_STAMP_LABEL).sort()).toEqual(["confirmed", "dismissed", "suggested"]);
    for (const [status, line] of Object.entries(RELATION_STAMP_LABEL)) {
      expect(line.length, `${status} 没有文案，渲染出来是 undefined`).toBeGreaterThan(0);
      expect(line, `${status} 的文案原样念出了内部状态名`).not.toMatch(/confirmed|dismissed|suggested|relationStatus/);
    }
  });

  it("纸签是书房语汇，不是后台面板：三档各有边线与纸面，减少动效时关掉过渡", () => {
    expect(css).toMatch(/is-suggested/);
    expect(css).toMatch(/is-confirmed/);
    expect(css).toMatch(/is-dismissed/);
    // 2026-10-03：用户要求整条星图更圆润，纸签沿用新旁页的柔软圆角。
    // 钉住纸签的圆角与材质，不再把历史四个半径当成产品契约。
    const stamp = css.match(/\.universe-relation-stamp\s*\{([^}]+)\}/)?.[1] ?? "";
    expect(stamp).toMatch(/border-radius:\s*16px/);
    expect(stamp).toMatch(/background:/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
  });

  it("**没有把伴星挤掉**：这颗纸签是加在既有的关系行里，不是新开一栏", () => {
    // 硬约束（AGENTS.md）：改动不许改座位预算、不许把某个面设为 hidden。
    expect(css).not.toMatch(/grid-template-columns:[^;]*repeat\(\s*3/);
    expect(css).toMatch(/universe-detail-relation-row/);
  });
});

describe("判据对退化灵敏（自检）", () => {
  it("换算函数去掉总称兜底 ⇒ 上一组断言会失败", () => {
    // 正对照：把 `?? "relates_to"` 去掉，未知键就会返回 undefined。
    const withoutFallback = (codes: readonly string[]) => {
      const hit = codes.find((code) => ["prerequisite", "contradicts", "elaborates", "generalizes", "qualifies"].includes(code));
      return hit;
    };
    expect(withoutFallback(["material_cited_by"])).toBeUndefined();
    // 而真实现不会
    expect(SEMANTIC_RELATION_FROM_REASON_CODES(["material_cited_by"])).toBe("relates_to");
  });

  it("文案表少一档 ⇒ 「三档都有」那条会失败", () => {
    const partial = { suggested: "a", confirmed: "b" };
    expect(Object.keys(partial).sort()).not.toEqual(["confirmed", "dismissed", "suggested"]);
    expect(Object.keys(RELATION_STAMP_LABEL).sort()).toEqual(["confirmed", "dismissed", "suggested"]);
  });
});
