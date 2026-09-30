/**
 * `notebook-surface.tsx` 的 §16.39「迟到的那一发」形状判据。
 *
 * ## 为什么从组件测试里搬出来
 *
 * 2026-09-29 之前，这几条住在 `notebook-surface.late-draft.test.tsx` 里，用
 * `readFileSync(resolve(process.cwd(), ".../notebook-surface.tsx"))` 读源码断言。三个问题：
 *
 * 1. **它会挡住拆分。** 路径写死在包根的固定层级，`notebook-surface.tsx` 一旦被拆开
 *    或搬进子目录，这条测试立刻红——而「测试红了 = 不能动」这条推理会让人把拆分无限推迟。
 * 2. **它断言的是字符不是行为。** 哪怕那一行渲染不出来，只要源码里出现过
 *    `data-round-lost` 三个字，它照样绿。
 * 3. **它旁边那条「正控制」是空断言。** 同文件的网关替身缺 `noteLearningRound.open`
 *    的信封形状，也没设 `activeNoteRef.learningRoundId`（`notebook-surface.tsx:874` 靠它
 *    打开「learning」叶），轮次面板在 jsdom 下**从来没渲染过**——所以
 *    「没有迟到草稿时那行不出现」是恒真的。替身已按真实网关形状修好，但补齐其余方法
 *    需要另开一轮；在此之前这里如实记着，不当作已覆盖。
 *
 * ## 本守卫管什么
 *
 * §16.39 的另一半：冲突那一支必须**带载荷**地留住那句问法，屏上必须有那一行与两颗按钮。
 * 三样少一样，§16.39 就退回成「把迟到那一份整块换成服务端那一版」。
 *
 * 为什么必须断「带载荷的那一次」而不能只断 token 出现：变异实测过——把
 * `setRoundLostDraft({ question, starter: roundStarter })` 换成 `setRoundLostDraft(null)`
 * （正是 W6-3 当年记下的症状）时，只断 token 的版本**照样全绿**。
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

/** 按文件名在整棵树里找——组件被拆进子目录后依然找得到，这正是搬出来的理由。 */
const findByName = (name: string): string | null => ALL.find((f) => f.endsWith(`/${name}`)) ?? null;

const surface = findByName("notebook-surface.tsx");
const line = findByName("notebook-round-line.tsx");
/**
 * §16.39 的实现**跨两个文件**：冲突那一支的写入在页面里（「那一轮」左栏抽出之前它们同处一处）。
 * 所以本守卫读的是**两份合起来**的文本——判据的对象是那条契约，不是某一个文件。
 * 找���到左栏那个文件时回退到只读页面，这样它在被拆回去时守卫仍然有效。
 */
const parts = [surface, line].filter((f): f is string => f !== null).map((f) => readFileSync(f, "utf8"));
const source = parts.join("\n");

describe("§16.39 迟到的那一发：形状判据", () => {
  it("读到了东西（否则这条守卫是空的）", () => {
    expect(ALL.length, "没扫到渲染层文件").toBeGreaterThan(100);
    expect(surface, "在渲染层里找不到 notebook-surface.tsx").not.toBeNull();
    expect(source.length, "notebook-surface.tsx 是空的").toBeGreaterThan(1000);
  });

  it("conflict 那一支确实把句子**带载荷**地留下来了（只写 null 等于没留）", () => {
    expect(
      /setRoundLostDraft\(\{\s*question,\s*starter:\s*roundStarter\s*\}\)/.test(source),
      "conflict 那一支不再把那一句带载荷地留下来了",
    ).toBe(true);
  });

  it("屏上有那一行与那两颗按钮，而且真挂在那一行上（不是只有常量定义）", () => {
    expect(source, "屏上不再有那一行「先替你留着」").toContain("data-round-lost");
    expect(source, "没有「把这一句改到新版本上」那颗按钮").toContain("applyLost");
    expect(source, "没有「不要这一句了」那颗按钮").toContain("dropLost");
    // 反向自检：这两处要真的在**渲染树**附近，不是散落在文件别处
    const at = source.indexOf("data-round-lost");
    expect(at, "找不到 data-round-lost").toBeGreaterThan(-1);
    const block = source.slice(Math.max(0, at - 400), at + 1200);
    expect(block, "applyLost 只在别处出现，没挂在这一行上").toContain("applyLost");
    expect(block, "dropLost 只在别处出现，没挂在这一行上").toContain("dropLost");
  });

  it("自检：两条判据对两处退化各自灵敏", () => {
    // ① 载荷被换成 null（正是 W6-3 当年记下的症状）
    const broken = source.replace(
      /setRoundLostDraft\(\{\s*question,\s*starter:\s*roundStarter\s*\}\)/,
      "setRoundLostDraft(null)",
    );
    expect(
      /setRoundLostDraft\(\{\s*question,\s*starter:\s*roundStarter\s*\}\)/.test(broken),
      "把载荷换成 null 之后这条判据必须失效",
    ).toBe(false);

    // ② 两颗按钮只剩定义、没挂在那一行上：把「挂载」改成「别处出现」必须被抓到
    const at = source.indexOf("data-round-lost");
    const block = source.slice(Math.max(0, at - 400), at + 1200);
    const stillHasBoth = block.includes("applyLost") && block.includes("dropLost");
    expect(stillHasBoth, "真源码里这一行本来就该挂着两颗按钮——否则前面的判据是空断言").toBe(true);
    // 把两处挂载从渲染树那一段里摘掉（它们在文件别处仍有定义）
    const stripped = block.replace(/applyLost/g, "").replace(/dropLost/g, "");
    expect(stripped.includes("applyLost") || stripped.includes("dropLost")).toBe(false);
  });
});
