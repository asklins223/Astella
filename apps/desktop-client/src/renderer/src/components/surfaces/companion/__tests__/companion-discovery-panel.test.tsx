// @vitest-environment jsdom

/**
 * 40 §7 发现簿面板的**措辞与空态**。
 *
 * ## 为什么盯措辞
 *
 * §7 有两条是对**用户会怎么理解**的约束，不是对实现的：
 *
 *  - 「取消收藏**不删除**原始回答或日记」——所以按钮不能写「删除」；
 *  - 「没有收藏时保持清爽，**不生成假内容**」——所以空态不能放示例或推荐。
 *
 * 这两条写错都不会报错，只会让用户以为日记没了、或者以为簿子在编内容。
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DiscoveryPanel } from "../companion-discovery-panel.tsx";
import type { CompanionDiscoveryEntryV1 } from "@astella/shared/desktop-ipc-contracts";

afterEach(cleanup);

const entry = (over: Partial<CompanionDiscoveryEntryV1> = {}): CompanionDiscoveryEntryV1 => ({
  entryId: "11111111-1111-4111-8111-111111111111",
  kind: "diary_excerpt",
  source: "diary",
  sourceId: "d-2026-10-01",
  author: "assistant",
  body: "嘿嘿，今天状态不错嘛。",
  annotation: null,
  visibility: "private",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  ...over,
});

function book(entries: CompanionDiscoveryEntryV1[], studyVisible: CompanionDiscoveryEntryV1[] = []) {
  return { section: { ok: true as const, value: { version: 1 as const, entries, studyVisible } }, busy: null, error: null, notice: null,
    onUncollect: vi.fn(), onAnnotate: vi.fn(), onRetry: vi.fn() };
}

describe("发现簿面板", () => {
  it("收藏的模型原话保留排版，用户字面输入不被解释成格式", () => {
    const original = entry({ body: "12×13 = **156**。\n\n步骤里保存 `key`。" });
    render(<DiscoveryPanel {...book([original, entry({ entryId: "22222222-2222-4222-8222-222222222222", author: "user", kind: "user_utterance", body: "请保留 **156** 和 `key` 的字面写法。" })])} />);
    const model = document.querySelector('[data-author="assistant"]');
    expect(model?.querySelector("strong:not(header strong)")?.textContent).toBe("156");
    expect(model?.querySelector("code")?.textContent).toBe("key");
    expect(document.querySelector('[data-author="user"] p')?.textContent).toBe("请保留 **156** 和 `key` 的字面写法。");
    expect(original.body).toBe("12×13 = **156**。\n\n步骤里保存 `key`。");
  });

  it("每条都**标清作者与来源**（§7「各自标清作者和来源」）", () => {
    render(<DiscoveryPanel {...book([entry({ author: "assistant", kind: "kept_ai_suggestion", source: "assistant_reply" })])} />);
    // 她整理的建议：作者写「她」，不写成用户自己的话。
    expect(document.querySelector('[data-author="assistant"]')).not.toBeNull();
    expect(screen.getByText("她")).toBeTruthy();
    expect(screen.getByText("她整理的")).toBeTruthy();
    expect(screen.getByText("一段对话")).toBeTruthy();
  });

  it("取消收藏**不叫删除** —— 叫「删除」会让用户以为日记也没了", () => {
    render(<DiscoveryPanel {...book([entry()])} />);
    const buttons = [...document.querySelectorAll("button")].map((b) => b.textContent?.trim());
    expect(buttons).toContain("取消收藏");
    expect(buttons).not.toContain("删除");
  });

  it("没有收藏时**不生成假内容**（§7「没有收藏时保持清爽」）", () => {
    render(<DiscoveryPanel {...book([])} />);
    expect(screen.getByText(/还没有收藏/)).toBeTruthy();
    // 尤其不能出现"示例"或"推荐你先收藏一条"这类编出来的内容。
    expect(document.body.textContent ?? "").not.toMatch(/示例|比如|为你推荐/);
  });

  it("入口能去对话和日记，未接通的书房展示不占筛选位置", () => {
    const onBrowse = vi.fn();
    render(<DiscoveryPanel {...book([])} onBrowse={onBrowse} />);
    act(() => screen.getByRole("button", { name: "去对话挑一句" }).click());
    act(() => screen.getByRole("button", { name: "去日记挑一段" }).click());
    expect(onBrowse.mock.calls).toEqual([["dialogue"], ["diary"]]);
    expect(screen.queryByText("书房里放出的")).toBeNull();
  });

  it("回到原文带回原消息身份，不用收藏正文搜索猜位置", () => {
    const onSource = vi.fn();
    const original = entry({ source: "assistant_reply", sourceId: "22222222-2222-4222-8222-222222222222" });
    render(<DiscoveryPanel {...book([original])} onSource={onSource} />);
    act(() => screen.getByRole("button", { name: "回到原文" }).click());
    expect(onSource).toHaveBeenCalledWith(original);
  });

  it("没有「成长里程碑」这类需要被维护的指标（§7 明令不自动生产）", () => {
    render(<DiscoveryPanel {...book([entry(), entry({ entryId: "33333333-3333-4333-8333-333333333333" })])} />);
    expect(document.body.textContent ?? "").not.toMatch(/里程碑|正确率|连续天数|成长/);
  });

  it("读不到时如实说明并给出重试", () => {
    const onRetry = vi.fn();
    render(<DiscoveryPanel {...book([])} section={{ ok: false, message: "网络断了" }} onRetry={onRetry} />);
    expect(screen.getByRole("alert").textContent).toContain("网络断了");
    act(() => { screen.getByRole("button", { name: "重新读取" }).click(); });
    expect(onRetry).toHaveBeenCalled();
  });

  it("批注与正文**分开**：编辑批注不动原文", () => {
    const onAnnotate = vi.fn();
    render(<DiscoveryPanel {...book([entry()])} onAnnotate={onAnnotate} />);
    act(() => { screen.getByRole("button", { name: "加批注" }).click(); });
    const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(textarea, "这句我不同意");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => { screen.getByRole("button", { name: "保存批注" }).click(); });
    expect(onAnnotate).toHaveBeenCalledWith(expect.objectContaining({ sourceId: "d-2026-10-01" }), "这句我不同意");
    // 原文一个字没改。
    expect(screen.getByText("嘿嘿，今天状态不错嘛。")).toBeTruthy();
  });
});
