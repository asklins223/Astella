// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiaryPanel } from "../companion/companion-center-panels.tsx";
import { todayIsoDate } from "../companion/companion-diary-day.ts";
import type { CompanionDailySummaryV1 } from "@astella/shared/companion-memory-desktop-contracts";
import { useRoomStore } from "../../../app/room-store.ts";
import type { PageReadableV1 } from "@astella/shared/companion-bridge-contracts";

/**
 * 伴星中心「日记」这一块登记给伴星读的是什么（39d W2-7）。
 *
 * 这一格特殊在**四种屏幕状态共用一个入口**（读取中／读不到／这一天没写／这一天写了），
 * 而 hook 不能走在条件 return 之后——所以登记必须一次算完四种状态，
 * 每种都只说那一刻屏幕上真写着的那句。
 */

type DiaryPanelProps = Parameters<typeof DiaryPanel>[0];

const noop = () => undefined;

function daily(overrides: Partial<CompanionDailySummaryV1> = {}): CompanionDailySummaryV1 {
  return {
    version: 1,
    revision: 1,
    hidden: false,
    date: todayIsoDate(),
    status: "generated",
    generatedAt: "2026-09-24T21:00:00.000Z",
    failureReason: null,
    selectionReason: null,
    blocks: [
      { type: "text", text: "今天把惯性那一章往前推了一段。" },
      { type: "text", text: "课上那句反例还没有原文撑着。" },
    ],
    memory: null,
    ...overrides,
  } as CompanionDailySummaryV1;
}

function renderPanel(props: Partial<DiaryPanelProps> = {}) {
  const base = {
    section: { ok: true as const, value: daily() },
    loading: false,
    failure: null,
    date: null,
    onDate: noop,
    onMemory: noop,
    // 「聊聊这篇」（§6）。测试里是 noop：这一条只验证它被调用时带出
    // 日期与版本，不该在这里真去开对话。
    onDiscussDiary: noop,
    // §10 的三个写动作：这里只是让面板能渲染，不验证行为（行为由
    // companion-center-surface 的用例管）。
    onHideDiary: noop,
    onUnhideDiary: noop,
    onDeleteDiary: noop,
    confirmDeleteDiary: false,
    onConfirmDeleteDiary: noop,
    busy: false,
    onRetry: noop,
    marks: null,
    marksFailure: null,
    onMarksMonth: noop,
  } satisfies DiaryPanelProps;
  render(<DiaryPanel {...base} {...props} />);
}

function publishedView(): PageReadableV1 | null {
  return useRoomStore.getState().pageReadableView?.view ?? null;
}

const scroll = vi.fn();
beforeEach(() => {
  scroll.mockClear();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scroll });
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  useRoomStore.setState({ pageReadableView: null, motionMode: "full", reducedMotion: false });
});

describe("伴星中心 · 日记：只说那一刻屏幕上写着的", () => {
  it("写出来了：正文逐段与 DOM 相同，生成那行与日期胶囊也逐字", () => {
    renderPanel();
    const view = publishedView()!;
    expect(view.pageId).toBe("companion");
    expect(view.title).toBe("伴星中心");
    const prose = [...document.querySelectorAll(".cc-diary-paragraph > p")].map((node) => node.textContent);
    expect(prose).toHaveLength(2);
    expect(view.items?.map((entry) => entry.label)).toEqual(prose);
    expect(view.items?.map((entry) => entry.ordinal)).toEqual([1, 2]);
    expect(view.statusLine).toBe(document.querySelector(".cc-diary-sheet > header small")?.textContent);
    expect(view.filters).toEqual([{ label: "日期", value: document.querySelector(".cc-diary-nav__date span")?.textContent }]);
    expect(view.notice).toBeUndefined();
  });

  it("让可见选材理由与伴星读回内容都指向同一句", () => {
    renderPanel({
      section: { ok: true, value: daily({ selectionReason: "这段保留了我们一起核对的过程。" }) },
    });
    const reason = "她选了这段：这段保留了我们一起核对的过程。";
    expect(document.querySelector(".cc-diary-sheet")?.textContent).toContain(reason);
    expect(publishedView()?.items?.[0]).toEqual({ ordinal: 1, label: reason });
  });

  it("这一天还没有日记：说的是屏上那句，不登正文", () => {
    renderPanel({ section: { ok: true, value: daily({ status: "not_generated", blocks: [], date: null }) } });
    const view = publishedView()!;
    expect(view.items).toBeUndefined();
    // 逐字，不是"包含"：拼上日期或别的东西就该红。
    expect(view.statusLine).toBe(document.querySelector(".cc-state strong")?.textContent);
    expect(view.statusLine).toBe("这一天还没有日记");
    // 这一天没写，但上面那颗日期胶囊还写着 ⇒ 日期仍然进 filters。
    expect(view.filters).toEqual([{ label: "日期", value: document.querySelector(".cc-diary-nav__date span")?.textContent }]);
    expect(view.notice).toBeUndefined();
  });

  it("这一天没写下来：状态句与那句原因都来自屏幕", () => {
    renderPanel({
      section: {
        ok: true,
        value: daily({ status: "failed", failureReason: "model_unavailable", blocks: [{ type: "text", text: "占位，屏幕上不会显示这一段" }] }),
      },
    });
    const state = document.querySelector(".cc-state")!;
    const view = publishedView()!;
    // failed 那一格屏上只有一句标题＋原因：blocks 一条都不许登记（屏幕上是空的）。
    expect(view.items).toBeUndefined();
    expect(view.statusLine).toBe(state.querySelector("strong")?.textContent);
    expect(view.filters).toEqual([{ label: "日期", value: document.querySelector(".cc-diary-nav__date span")?.textContent }]);
    expect(view.notice).toBe(
      `${state.querySelector("strong")?.textContent}：${state.querySelector("p")?.textContent}`,
    );
    expect(view.notice).toContain("她试了几次没写出来");
  });

  it("整格读不到：只发状态与原因", () => {
    renderPanel({ section: null, failure: "伴星数据暂时不可用" });
    const view = publishedView()!;
    expect(view.statusLine).toBe(document.querySelector(".cc-state strong")?.textContent);
    expect(view.items).toBeUndefined();
    expect(view.filters).toBeUndefined();
    expect(view.notice).toBe("日记当前不可用：伴星数据暂时不可用");
  });

  it("第一次读取没回来：说的是「正在读取日记」，不发任何一天的内容", () => {
    renderPanel({ section: null, loading: true, failure: null });
    const view = publishedView()!;
    expect(view.statusLine).toBe(document.querySelector(".cc-state strong")?.textContent);
    expect(view.items).toBeUndefined();
  });

  it("同一文本块的两个段落有独立收藏入口，各自提交对应的原话", () => {
    const keep = vi.fn();
    renderPanel({
      section: { ok: true, value: daily({ date: "2026-10-04", revision: 2, blocks: [{ type: "text", text: "第一段。\n\n第二段。" }] }) },
      discoveryFor: request => ({ state: "offer", busy: false, failure: null, feedback: null, onKeep: () => keep(request) }),
    });
    const buttons = screen.getAllByRole("button", { name: "把这一段原话留在发现簿" });
    expect(buttons.every(button => !button.textContent && button.parentElement?.classList.contains("cc-diary-paragraph"))).toBe(true);
    expect([...document.querySelectorAll(".cc-diary-paragraph > p")].map(node => node.textContent)).toEqual(["第一段。", "第二段。"]);
    fireEvent.click(buttons[0]!);
    fireEvent.click(buttons[1]!);
    expect(keep.mock.calls.map(([request]) => request)).toEqual([
      { kind: "diary_excerpt", source: "diary", sourceId: "2026-10-04:v2:b0:p0", author: "assistant", body: "第一段。" },
      { kind: "diary_excerpt", source: "diary", sourceId: "2026-10-04:v2:b0:p1", author: "assistant", body: "第二段。" },
    ]);
  });

  it.each([
    { motionMode: "full" as const, reducedMotion: false, behavior: "smooth" },
    { motionMode: "off" as const, reducedMotion: false, behavior: "auto" },
    { motionMode: "full" as const, reducedMotion: true, behavior: "auto" },
  ])("返回段落立即交接键盘焦点，滚动遵守 $motionMode / reducedMotion=$reducedMotion", ({ motionMode, reducedMotion, behavior }) => {
    useRoomStore.setState({ motionMode, reducedMotion });
    const consumed = vi.fn();
    renderPanel({
      section: { ok: true, value: daily({ date: "2026-10-04", blocks: [{ type: "text", text: "第一段。\n\n第二段。" }] }) },
      sourceTarget: { sourceId: "2026-10-04:v1:b0:p1", revision: 1 },
      onSourceConsumed: consumed,
    });
    expect(document.activeElement?.getAttribute("data-source-id")).toBe("2026-10-04:v1:b0:p1");
    expect(scroll).toHaveBeenCalledWith({ block: "center", behavior });
    expect(consumed).toHaveBeenCalledOnce();
  });

  it("日记已经改版时说明实际版本，不把焦点移到新版的同号段落", () => {
    const consumed = vi.fn();
    renderPanel({
      section: { ok: true, value: daily({ date: "2026-10-04", revision: 2 }) },
      sourceTarget: { sourceId: "2026-10-04:v1:b0:p1", revision: 1 },
      onSourceConsumed: consumed,
    });
    expect(screen.getByRole("status").textContent).toContain("收藏来自第 1 版，这里是当前第 2 版");
    expect(scroll).not.toHaveBeenCalled();
    expect(consumed).not.toHaveBeenCalled();
  });
});
