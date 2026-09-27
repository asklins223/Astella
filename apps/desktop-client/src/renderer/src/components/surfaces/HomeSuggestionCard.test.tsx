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
import { HomeSuggestionCard } from "./HomeSuggestionCard";

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
