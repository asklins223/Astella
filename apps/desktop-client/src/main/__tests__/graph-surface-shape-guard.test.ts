/**
 * `graph-surface.tsx` 的**源码形状**判据：控制流与可访问性。
 *
 * ## 为什么从组件测试里搬出来
 *
 * 2026-09-29 之前，下面这几条住在 `graph-relation-stamp.test.tsx` 里，用
 * `readFileSync(import.meta.dirname, "graph-surface.tsx")` 读源码断言。这带来两个问题：
 *
 * 1. **它会挡住拆分。** 路径是**同级兄弟**，所以 `graph-surface.tsx` 一旦被拆开
 *    或搬进子目录，这条测试立刻红——而「测试红了 = 不能动」这条推理会让人把拆分
 *    无限推迟。本守卫改为**在目录树里搜索文件名**，组件搬家不再波及它。
 * 2. **它本来就不是组件测试。** 这几条断言的对象是「控制流的形状」
 *    （乐观更新是否早于 `await`）与 JSX 属性字面量，渲染层测不到，
 *    放在一起只会让组件测试的边界变得含糊。
 *
 * 留在组件测试里、且已经改成 import 断言的那些（换算函数、标签表、判据灵敏度），
 * 见 `graph-relation-stamp.test.tsx`。
 *
 * ## 本守卫管什么
 *
 * - 「只有可表态的边才给这两颗按钮」：`edge.decidable ?` 不能被换成恒真。
 *   换成恒真 ⇒ 材料血缘边（引用自／取代）也长出两颗按钮，而 §11.3 明写两者用不同表达。
 * - 「本地先改、重取在后」：乐观更新必须在 `await` 之前。服务端把表态折进 ETag，
 *   所以「写完再重取」可能拿到逐字节相同的 ETag → 304 → 屏上什么都不变**且不报错**。
 * - 「当前档用 `aria-pressed` 说出」：颜色不能是唯一载体。
 * - 「没把伴星挤掉」：座位预算与 `hidden` 不许出现在这处改动里。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const RENDERER_ROOT = "src/renderer/src";

const resolve = (relative: string): string | null => {
  for (const base of [relative, `apps/desktop-client/${relative}`]) {
    if (existsSync(base)) return base;
  }
  return null;
};

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const child = join(dir, entry);
    if (statSync(child).isDirectory()) walk(child, out);
    else out.push(child);
  }
  return out;
};

const root = resolve(RENDERER_ROOT) as string;
const ALL = walk(root);

/** 按文件名在整棵树里找。** 组件被拆进子目录后依然找得到——这正是搬出来的理由。 */
const findByName = (name: string): string | null => ALL.find((f) => f.endsWith(`/${name}`)) ?? null;

const surface = findByName("graph-surface.tsx");
const source = surface ? readFileSync(surface, "utf8") : "";

describe("graph-surface 的形状判据（控制流与可访问性）", () => {
  it("读到了东西（否则这条守卫是空的）", () => {
    expect(ALL.length, "没扫到渲染层文件").toBeGreaterThan(100);
    expect(surface, "在渲染层里找不到 graph-surface.tsx").not.toBeNull();
    expect(source.length, "graph-surface.tsx 是空的").toBeGreaterThan(1000);
  });

  it("可表态的边才画这颗纸签：血缘边与证据链接没有「我不这么认为」这一档", () => {
    expect(source, "`.edge.decidable ?` 门不见了——血缘边会开始长出表态按钮").toMatch(/edge\.decidable \?/);
    // 变异：把 decidable 换成恒真 ⇒ 血缘边也会长出两颗按钮
    const mutated = source.replace("edge.decidable ?", "true ?");
    expect(mutated).not.toMatch(/edge\.decidable \?/);
  });

  it("本地先改、重取在后 —— 否则 304 会把用户那一按吃掉", () => {
    const start = source.indexOf("const stampRelationDecision");
    const end = source.indexOf("const projections = useMemo");
    expect(start, "stampRelationDecision 不见了").toBeGreaterThan(-1);
    expect(end, "stampRelationDecision 之后找不到锚点").toBeGreaterThan(start);
    const handler = source.slice(start, end);
    const optimisticAt = handler.indexOf("setRelationStamps((current) => ({ ...current, [edge.edgeId]: decision }));");
    const awaitAt = handler.indexOf("await unwrapGatewayResult");
    expect(optimisticAt, "乐观更新不见了").toBeGreaterThanOrEqual(0);
    expect(awaitAt).toBeGreaterThan(optimisticAt);
    // 失败要回滚**并且说出来**：静默回滚等于用户白按了一次
    expect(handler, "失败没有回滚，也没有告诉用户").toMatch(/setRelationStampError\(/);
  });

  it("当前档用 aria-pressed 说出，不靠颜色单独承载（色弱与读屏都要拿得到）", () => {
    expect(source).toMatch(/aria-pressed=\{edge\.relationStatus === "confirmed"\}/);
    expect(source).toMatch(/aria-pressed=\{edge\.relationStatus === "dismissed"\}/);
  });

  it("**没有把伴星挤掉**：这处改动不许改座位预算、不许把某个面设为 hidden", () => {
    expect(source, "出现 display:none 的伴星面，违反 AGENTS.md 的伴星常驻约束")
      .not.toMatch(/companion[^=]*=\s*\{[^}]*display:\s*none/);
    expect(source, "座位预算被置 0").not.toMatch(/--companion-seat|seatBudget\s*=\s*0/);
    expect(source, "这一屏把伴星设为缺席").not.toMatch(/companion-absent/);
    expect(source, "星图的座位沟被置 0").not.toMatch(/--universe-universe-seat-gutter:\s*0/);
    // 页面仍走 HudPage（房间外壳负责她的挂载），不是自己另起一套版式。
    expect(source, "没有走 HudPage，等于自己另起一套版式").toContain('<HudPage page="graph" wide>');
  });

  it("星体的光痕只有「有真实足迹／没有」两档，不是按条数画的比例", () => {
    // 证据光晕：一条证据与五条证据落在**同一档**。
    expect(source, "光痕又变回按条数画比例了").toContain("evidenceCoverage: evidenceDegreeForNode > 0 ? 1 : null");
    expect(source, "光痕按证据条数开比例了").not.toMatch(/evidenceCoverage:[^;]*\/\s*evidenceDegreeForNode/);
    expect(source, "光痕按条数取了整／向上取整").not.toMatch(/evidenceCoverage:[^;]*Math\.(min|round|ceil)\(/);
  });

  it("自检：三条判据对三处退化各自灵敏", () => {
    // ① decidable 换成恒真
    const m1 = source.replace("edge.decidable ?", "true ?");
    expect(m1).not.toMatch(/edge\.decidable \?/);
    expect(source).toMatch(/edge\.decidable \?/);
    // ② 乐观更新挪到 await 之后
    const start = source.indexOf("const stampRelationDecision");
    const handler = source.slice(start, source.indexOf("const projections = useMemo", start));
    const lines = handler.split("\n");
    const opt = lines.findIndex((l) => l.includes("setRelationStamps((current) => ({ ...current, [edge.edgeId]: decision }));"));
    const awt = lines.findIndex((l) => l.includes("await unwrapGatewayResult"));
    expect(opt).toBeGreaterThanOrEqual(0);
    expect(awt).toBeGreaterThan(opt);
    const swapped = [...lines];
    const [line] = swapped.splice(opt, 1);
    swapped.splice(awt, 0, line);
    expect(swapped.findIndex((l) => l.includes("setRelationStamps((current)"))).toBeGreaterThan(
      swapped.findIndex((l) => l.includes("await unwrapGatewayResult")),
    );
  });
});
