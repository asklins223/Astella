// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { TodayBatchOptions } from "../library/HomeSuggestionCard.tsx";

function installApi(impl: { act: (input: unknown) => Promise<unknown> }) {
  (window as unknown as { ailearn?: unknown }).ailearn = {
    review: {
      actOnTodayBatch: vi.fn(async (input: unknown) => ({
        workspaceEpoch: 1,
        ok: true,
        data: await impl.act(input),
      })),
    },
  };
}

const PROPS = { timeZone: "Asia/Shanghai", epochRef: { current: undefined as number | undefined } };

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(cleanup);

/**
 * 那三颗动作的组件判据（39d W7-4 刀十三；§12 表「今日复习」行）。
 *
 * 三条，各带正对照：
 *  1. **`screenLine` 原样念**：服务端给的那一句一个字都不拼（§12 表「剩余需求不伪称
 *     完成」）。正对照：服务端给「今天先做 3 道，剩下 2 道还在」，屏上就**必须**出现
 *     「剩下 2 道」——渲染层自己拼的话迟早漏掉那一半。
 *  2. **暂停 ⇒ 那颗按钮变成「接着做」**，而**不是**同时画着两颗。
 *  3. **失败不更新那一行**：屏上宁可留着上一句，也不显示一个她没按过的结果——句子里
 *     带着一个没发生的数，那就是「伪称完成」那一侧。
 */
describe("§12.1 今日复习那三颗动作", () => {
  it("正对照：`screenLine` 原样念，「剩下 N 道」不许丢", async () => {
    installApi({
      act: async () => ({
        action: "reduce",
        lockedLength: 3,
        paused: false,
        remaining: 2,
        screenLine: "今天先做 3 道，剩下 2 道还在。",
      }),
    });
    render(<TodayBatchOptions {...PROPS} />);
    (screen.getByText("今天少做两道") as HTMLButtonElement).click();
    expect(await screen.findByText("今天先做 3 道，剩下 2 道还在。")).toBeTruthy();
  });

  it("正对照：暂停 ⇒ 那颗变成「接着做」，**不是**同时画着两颗", async () => {
    installApi({
      act: async () => ({ action: "pause", lockedLength: 5, paused: true, remaining: 4, screenLine: "这一批先停在这里，剩下 4 道还在。" }),
    });
    render(<TodayBatchOptions {...PROPS} />);
    (screen.getByText("先停一下") as HTMLButtonElement).click();
    await screen.findByText("接着做");
    expect(screen.queryByText("先停一下")).toBeNull();
    // 暂停那一行**必须**念出剩余——它是"没有丢掉"的那句话。
    expect(screen.getByText("这一批先停在这里，剩下 4 道还在。")).toBeTruthy();
  });

  it("失败不更新那一行（不显示一个她没按过的结果）", async () => {
    installApi({ act: async () => { throw new Error("offline"); } });
    const { container } = render(<TodayBatchOptions {...PROPS} />);
    (screen.getByText("今天少做两道") as HTMLButtonElement).click();
    await waitFor(() => expect(container.querySelector(".hud-today-batch__line")).toBeNull());
  });
});
