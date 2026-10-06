import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * B6：桌面端 **IPC 通道名不得在 main 与 preload 各写一份字面量**。
 *
 * ## 为什么这条要立判据
 *
 * 通道名是一个字符串。`main/index.ts` 写 `'window:set-titlebar-theme'`、
 * `preload/index.ts` 也写一遍——两边**拼错一处不会报任何类型错**，编译照过，
 * 运行时表现为「用户点了没反应」。
 *
 * 2026-09-30 的实测：桌面端有两条通道常量早已收在 `shared/window-state.ts`
 * （`WINDOW_STATE_CHANNEL` / `WINDOW_STATE_SNAPSHOT_CHANNEL`），而
 * `window:set-titlebar-theme` **漏在外面**，正好是这个形状。已收进去。
 *
 * ## 为什么不是"把所有通道都收进 shared"
 *
 * 同日实测：preload 与 main 各自出现的**字面量**通道只有那一条，
 * 其余全部走 `@astella/shared/desktop-ipc-contracts` 的 `DESKTOP_IPC_CHANNELS`。
 * 所以剩下的是"守住"，不是"搬家"。
 */

const SRC = new URL("../../", import.meta.url).pathname;
const LAYERS = ["main", "preload"] as const;

function sourceOf(layer: string): string[] {
  const dir = join(SRC, layer);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => readFileSync(join(dir, f), "utf8"));
}

/** 形如 `send('a:b')` / `invoke("a:b")` 的**字面量**通道名。 */
function literalChannels(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?:send|invoke|on|once)\(\s*['"]([a-z][a-zA-Z0-9]*:[a-zA-Z0-9:_-]+)['"]/g)) {
    out.push(m[1]!);
  }
  return out;
}

describe("IPC 通道单一来源", () => {
  it("main 与 preload 里一个裸通道字面量都不许有", () => {
    // 走了两版才对：
    //  v1「两边都写才红」——收进常量后 main 没字面量了，preload 单方面写回**照样绿**，
    //     突变测试当场抓到。
    //  v2「字面量的值必须能在单一来源里找到」——还是绿，因为那个字面量的**值**和
    //     常量的值一模一样。判据问错了问题。
    //  v3：通道名的**字面形式**本身就是第二份真相。main/preload 里必须一个都没有，
    //     一律引用常量。要判 0 又不能让正则失效，所以自证放在下一条：
    //     同一套正则必须在 `shared/window-state.ts` 里认出那三条。
    const offenders: string[] = [];
    for (const layer of LAYERS) {
      for (const channel of new Set(sourceOf(layer).flatMap(literalChannels))) {
        offenders.push(`${layer}: ${channel}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("【自证】同一套正则确实能认出字面量（否则上一条恒绿）", () => {
    const shared = readFileSync(join(SRC, "shared", "window-state.ts"), "utf8");
    const found = [
      ...new Set([...shared.matchAll(/=\s*['"]([a-z][a-zA-Z0-9]*:[a-zA-Z0-9:_-]+)['"]/g)].map((m) => m[1]!)),
    ].sort();
    expect(found).toEqual([
      "window:get-state",
      "window:set-titlebar-theme",
      "window:state-changed",
    ]);
  });

  it("窗口那三条通道都从 shared 取（回归防护）", () => {
    const shared = readFileSync(join(SRC, "shared", "window-state.ts"), "utf8");
    for (const name of [
      "WINDOW_STATE_CHANNEL",
      "WINDOW_STATE_SNAPSHOT_CHANNEL",
      "TITLE_BAR_THEME_CHANNEL",
    ]) {
      expect(shared.includes(`export const ${name}`)).toBe(true);
    }
    for (const layer of LAYERS) {
      const text = sourceOf(layer).join("\n");
      expect(text.includes("TITLE_BAR_THEME_CHANNEL")).toBe(true);
    }
  });
});
