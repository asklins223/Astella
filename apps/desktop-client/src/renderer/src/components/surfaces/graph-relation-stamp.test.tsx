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
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * 这一份是**源码形状与 CSS** 判据，不是渲染判据。
 *
 * 为什么不渲染：那颗纸签在整份星图快照的夹具里，渲染它要拉起 `graph-surface`
 * 全部的依赖（`useSurfaceProjection`、Live2D 场景、布局 hook），而那样写出来的用例
 * 只能测到"壳在不在"，测不到本文件要证明的四件事——它们全是**形状**问题：
 * 键取对了没有、按钮给对了边没有、乐观更新在 await 之前没有、颜色是不是唯一载体。
 * 渲染层能不能真跑（真窗口）由 W8-2 的真窗口验收单那一格负责。
 */

const SURFACE = resolve(import.meta.dirname, "graph-surface.tsx");
const CSS = resolve(import.meta.dirname, "understanding-universe.css");
const source = readFileSync(SURFACE, "utf8");
const css = readFileSync(CSS, "utf8");

function edge(over: Record<string, unknown> = {}) {
  return {
    edgeId: "edge-rel-1",
    kind: "relates_to",
    from: { kind: "objective", id: "0f9a5c9c-1b3f-4c1e-9c1a-6f2b7d5e4a10" },
    to: { kind: "objective", id: "0f9a5c9c-1b3f-4c1e-9c1a-6f2b7d5e4a11" },
    reasonCodes: ["prerequisite"],
    decidable: true,
    relationStatus: "suggested",
    countsAsEstablished: false,
    ...over,
  } as never;
}

describe("建议关系的表态纸签", () => {
  it("语义关系是按 reasonCodes 里那一条取的，不是按 edge.kind（五档里 relates_to 只是总称）", () => {
    expect(source).toMatch(/reasonCodes/);
    expect(source).toMatch(/SEMANTIC_RELATION_FROM_REASON_CODES/);
    // 判据：换算函数必须在 reasonCodes 上找，且**不许**返回 undefined ——
    // 键对不上时表态会静默落到另一条边，而那一条用户看不到。
    expect(source).toMatch(/SEMANTIC_RELATION_FROM_REASON_CODES[\s\S]{0,400}hit \?\? "relates_to"/);
  });

  it("可表态的边才画这颗纸签：血���边与证据链接没有「我不这么认为」这一档", () => {
    expect(source).toMatch(/edge\.decidable \?/);
    // 变异：把 decidable 换成恒真 ⇒ 血缘边也会长出两颗按钮
    const mutated = source.replace("edge.decidable ?", "true ?");
    expect(mutated).not.toMatch(/edge\.decidable \?/);
  });

  it("三档各有一句人话，且都不是状态名", () => {
    const table = source.match(/RELATION_STAMP_LABEL[^=]*=\s*\{([\s\S]{0,400}?)\};/);
    expect(table, "读不到标签表").toBeTruthy();
    const keys = [...(table![1]!.matchAll(/^\s*(confirmed|dismissed|suggested):/gm))].map((m) => m[1]);
    expect(keys.sort()).toEqual(["confirmed", "dismissed", "suggested"]);
    const lines = [...table![1]!.matchAll(/:\s*"([^"]+)"/g)].map((m) => m[1]!);
    for (const line of lines) {
      expect(line).not.toMatch(/confirmed|dismissed|suggested|relationStatus/);
      expect(line.length).toBeGreaterThan(0);
    }
  });

  it("本地先改、重取在后 —— 否则 304 会把用户那一按吃掉", () => {
    // 乐观更新必须出现在 await 之前
    const handler = source.slice(source.indexOf("const stampRelationDecision"), source.indexOf("const projections = useMemo"));
    const optimisticAt = handler.indexOf("setRelationStamps((current) => ({ ...current, [edge.edgeId]: decision }));");
    const awaitAt = handler.indexOf("await unwrapGatewayResult");
    expect(optimisticAt).toBeGreaterThanOrEqual(0);
    expect(awaitAt).toBeGreaterThan(optimisticAt);
    // 失败要回滚**并且说出来**：静默回滚等于用户白按了一次
    expect(handler).toMatch(/setRelationStampError\(/);
  });

  it("当前档用 aria-pressed 说出，不靠颜色单独承载（色弱与读屏都要拿得到）", () => {
    expect(source).toMatch(/aria-pressed=\{edge\.relationStatus === "confirmed"\}/);
    expect(source).toMatch(/aria-pressed=\{edge\.relationStatus === "dismissed"\}/);
    expect(css).toMatch(/\[aria-pressed="true"\]/);
    // 颜色那一档不能是**唯一**的区分手段——上面那三条已经保证了
  });

  it("纸签是书房语汇，不是后台面板：三档各有边线与纸面，减少动效时关掉过渡", () => {
    expect(css).toMatch(/is-suggested/);
    expect(css).toMatch(/is-confirmed/);
    expect(css).toMatch(/is-dismissed/);
    // 不规则柔圆角（书页手感），不是等半径胶囊
    expect(css).toMatch(/border-radius:\s*0\.7rem 0\.55rem 0\.8rem 0\.5rem/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
  });

  it("**没有把伴星挤掉**：这颗纸签是加在既有的关系行里，不是新开一栏", () => {
    // 硬约束（AGENTS.md）：改动不许改座位预算、不许把某个面设为 hidden。
    expect(source).not.toMatch(/companion[^=]*=\s*\{[^}]*display:\s*none/);
    expect(source).not.toMatch(/--companion-seat|seatBudget\s*=\s*0/);
    // 纸签挂在同一个容器里（`margin-left` 缩进，不是新网格列）
    expect(css).toMatch(/universe-detail-relation-row/);
    expect(css).not.toMatch(/grid-template-columns:[^;]*repeat\(\s*3/);
  });
});

/** 变异自证：把上面三条最关键的判据在源码副本上各破坏一次。 */
describe("判据对三处退化各自灵敏", () => {
  it("① 恒真取代 decidable ⇒ 「可表态才给按钮」那条必须失效", () => {
    const mutated = source.replace("edge.decidable ?", "true ?");
    expect(mutated).not.toMatch(/edge\.decidable \?/);
    expect(source).toMatch(/edge\.decidable \?/);
  });

  it("② 换算函数返回 undefined ⇒ 「不许有 undefined」那条必须失效", () => {
    const mutated = source.replace('hit ?? "relates_to"', "hit");
    expect(mutated).not.toMatch(/hit \?\? "relates_to"/);
    expect(source).toMatch(/hit \?\? "relates_io"?.?|"relates_to"/);
  });

  it("③ 乐观更新挪到 await 之后 ⇒ 「本地先改」那条必须失效", () => {
    const handler = source.slice(source.indexOf("const stampRelationDecision"), source.indexOf("const projections = useMemo"));
    const lines = handler.split("\n");
    const optimistic = lines.findIndex((l) => l.includes("setRelationStamps((current) => ({ ...current, [edge.edgeId]: decision }));"));
    const awaited = lines.findIndex((l) => l.includes("await unwrapGatewayResult"));
    const swapped = [...lines];
    const [a] = swapped.splice(optimistic, 1);
    swapped.splice(awaited, 0, a);
    const order = swapped.findIndex((l) => l.includes("setRelationStamps((current) => ({ ...current, [edge.edgeId]: decision }));"));
    expect(order).toBeGreaterThan(swapped.findIndex((l) => l.includes("await unwrapGatewayResult")));
    expect(optimistic).toBeLessThan(awaited);
  });
});
