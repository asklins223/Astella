/**
 * 书桌上那**一件**的组件判据（39d W7-4 刀八；39 §12.1）。
 *
 * 三条屏上纪律，各带正对照：
 *  1. **`swappableCount === 0` ⇒ 那颗「换一个」不画。** 画一颗按了没反应的按钮比没有
 *     更坏——它会让整张纸签显得不可信。
 *  2. **`nothing_due` 那一版画的是**入口**，不是"随便做点什么"。** §12.1
 *     「没有到期需求不制造『今日任务』」——这一档里没有一个按钮叫那个。
 *  3. **回执里那下一件就地替换**：按一下「换一个」要立刻看到另一件，而不是"空一下
 *     再刷"（**不重发读**）。
 *
 * ⚠️ 本机 `vitest` **起不来**（`@rollup/rollup-darwin-arm64` 的代码签名／Team-ID 不匹配，
 * 全部用例同样失败，与改动无关）。所以这一份**已写未跑**，记在这里不当作跑过。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { HomeSuggestionCard, TodayBatchOptions } from "./HomeSuggestionCard";

const SUGGESTED = {
  kind: "suggested" as const,
  itemKey: "batch:obj-1",
  kindOfItem: "authorized_review" as const,
  headline: "接着解释昨天卡住的条件",
  reasonLine: "昨天卡在这一步，今天接着走",
  swappableCount: 2,
};

function installApi(impl: {
  read?: (input: unknown) => Promise<unknown>;
  act?: (input: unknown) => Promise<unknown>;
}) {
  (window as unknown as { ailearn?: unknown }).ailearn = {
    review: {
      readHomeSuggestion: vi.fn(async (input: unknown) => ({
        workspaceEpoch: 1,
        result: { ok: true, value: (impl.read?.(input) as Promise<unknown>) ?? SUGGESTED },
      })),
      actOnHomeSuggestion: vi.fn(async (input: unknown) => ({
        workspaceEpoch: 1,
        result: { ok: true, value: await (impl.act?.(input) ?? { action: "swapped", suggestion: SUGGESTED }) },
      })),
    },
  };
}

const PROPS = { timeZone: "Asia/Shanghai", epochRef: { current: undefined as number | undefined } };

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("§12.1 书桌那一件", () => {
  it("画出**一件** ＋ 一句理由 ＋ 两颗动作", async () => {
    installApi({ read: async () => SUGGESTED });
    render(<HomeSuggestionCard {...PROPS} />);
    expect(await screen.findByText("接着解释昨天卡住的条件")).toBeTruthy();
    // §12.1「推荐附一句理由」——**必填**那一格。
    expect(screen.getByText("昨天卡在这一步，今天接着走")).toBeTruthy();
    expect(screen.getByText("换一个")).toBeTruthy();
    expect(screen.getByText("暂不处理")).toBeTruthy();
  });

  it("正对照：`swappableCount === 0` ⇒ 「换一个」**不画**（不画一颗按了没反应的）", async () => {
    installApi({ read: async () => ({ ...SUGGESTED, swappableCount: 0 }) });
    render(<HomeSuggestionCard {...PROPS} />);
    await screen.findByText("接着解释昨天卡住的条件");
    expect(screen.queryByText("换一个")).toBeNull();
    // 「暂不处理」**照画**：那一颗与有没有别的可换无关。
    expect(screen.getByText("暂不处理")).toBeTruthy();
  });

  it("正对照：`nothing_due` 那一版画的是三个**入口**，没有「今天没有任务」那种按钮", async () => {
    installApi({
      read: async () => ({ kind: "nothing_due", emptyActions: ["new_note", "write_from_source", "resume_reading"] }),
    });
    render(<HomeSuggestionCard {...PROPS} />);
    expect(await screen.findByText("新建笔记")).toBeTruthy();
    expect(screen.getByText("从资料写笔记")).toBeTruthy();
    expect(screen.getByText("继续最近读的")).toBeTruthy();
    // 一个「随便做点什么」都不许有。
    expect(screen.queryByText("换一个")).toBeNull();
    expect(screen.queryByText("暂不处理")).toBeNull();
  });

  it("按一下「换一个」⇒ 用回执里那**下一件**就地替换，**不重发读**", async () => {
    const next = { ...SUGGESTED, itemKey: "batch:obj-2", headline: "用几个小问题回访这篇笔记" };
    installApi({ read: async () => SUGGESTED, act: async () => ({ action: "swapped", suggestion: next }) });
    render(<HomeSuggestionCard {...PROPS} />);
    await screen.findByText("接着解释昨天卡住的条件");
    (screen.getByText("换一个") as HTMLButtonElement).click();
    expect(await screen.findByText("用几个小问题回访这篇笔记")).toBeTruthy();
    expect(screen.queryByText("接着解释昨天卡住的条件")).toBeNull();
    const api = (window as unknown as { ailearn: { review: { readHomeSuggestion: ReturnType<typeof vi.fn> } } }).ailearn;
    await waitFor(() => expect(api.review.readHomeSuggestion).toHaveBeenCalledTimes(1));
  });

  it("读不出来就**什么都不画**——凭空多一句「今天没有任务」是 §12.1 不许制造的", async () => {
    installApi({ read: async () => { throw new Error("offline"); } });
    const { container } = render(<HomeSuggestionCard {...PROPS} />);
    await waitFor(() => expect(container.querySelector(".hud-desk-next")).toBeNull());
    expect(container.querySelector(".hud-desk-elsewhere")).toBeNull();
  });
});

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
