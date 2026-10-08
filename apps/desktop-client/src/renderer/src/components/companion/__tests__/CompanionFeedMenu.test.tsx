// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanionFeedMenu } from "../CompanionFeedMenu.tsx";
import {
  COMPANION_FEED_MAX_CHARS,
  feedNoteIntentToCompanion,
  subscribeCompanionFeed,
} from "../companion-feed.ts";

beforeEach(() => {
  document.body.insertAdjacentHTML("beforeend", '<div class="companion-hud"></div>');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

/** 让 `window.getSelection()` 报告一段选区（jsdom 里没法真选）。 */
function selectText(text: string): void {
  vi.spyOn(window, "getSelection").mockReturnValue({ toString: () => text } as Selection);
}

/**
 * 返回"这次右键有没有被我们接管"。
 *
 * 不用 `fireEvent.contextMenu(...).defaultPrevented`：RTL 的 `fireEvent` 返回的是
 * 「事件未被取消」这个布尔，读它身上的 `defaultPrevented` 只会拿到 `undefined`，
 * 看起来像"组件没反应"，其实是我读错了探针自己的返回值。
 */
function rightClick(target: HTMLElement = document.body): boolean {
  const event = new MouseEvent("contextmenu", {
    bubbles: true, cancelable: true, clientX: 220, clientY: 260,
  });
  // 必须包在 `act` 里：裸 `dispatchEvent` 不会冲 React 的更新队列，
  // 组件的 `setMenu` 停在待办里，测试就会看到"菜单没出现"的假失败。
  act(() => {
    target.dispatchEvent(event);
  });
  return event.defaultPrevented;
}

describe("CompanionFeedMenu（划选投喂的右键浮层）", () => {
  it("速看意图带着笔记版本送到伴星，并打开对话", () => {
    const intents: unknown[] = [];
    let opened = 0;
    const off = subscribeCompanionFeed({
      onFeed: () => undefined,
      onNoteIntent: (intent) => intents.push(intent),
      onOpenChat: () => { opened += 1; },
    });
    feedNoteIntentToCompanion({
      kind: "overview",
      noteId: "11111111-1111-4111-8111-111111111111",
      noteVersionId: "22222222-2222-4222-8222-222222222222",
      noteTitle: "工具调用",
    });
    expect(intents).toEqual([expect.objectContaining({
      kind: "overview",
      noteId: "11111111-1111-4111-8111-111111111111",
      noteVersionId: "22222222-2222-4222-8222-222222222222",
      noteTitle: "工具调用",
      requestId: expect.any(String),
    })]);
    expect(opened).toBe(1);
    off();
  });

  it("拓展意图也带着当前版本送到伴星", () => {
    const intents: unknown[] = [];
    const off = subscribeCompanionFeed({ onFeed: () => undefined, onNoteIntent: (intent) => intents.push(intent), onOpenChat: () => undefined });
    feedNoteIntentToCompanion({
      kind: "expansion",
      noteId: "11111111-1111-4111-8111-111111111111",
      noteVersionId: "22222222-2222-4222-8222-222222222222",
      noteTitle: "工具调用",
    });
    expect(intents).toEqual([expect.objectContaining({
      kind: "expansion",
      noteId: "11111111-1111-4111-8111-111111111111",
      noteVersionId: "22222222-2222-4222-8222-222222222222",
      noteTitle: "工具调用",
      requestId: expect.any(String),
    })]);
    off();
  });

  it("回想和线索意图带着精确笔记版本送到伴星", () => {
    const intents: unknown[] = [];
    const off = subscribeCompanionFeed({ onFeed: () => undefined, onNoteIntent: (intent) => intents.push(intent), onOpenChat: () => undefined });
    const noteId = "11111111-1111-4111-8111-111111111111";
    const noteVersionId = "22222222-2222-4222-8222-222222222222";
    const recallId = "33333333-3333-4333-8333-333333333333";
    feedNoteIntentToCompanion({ kind: "recall", noteId, noteVersionId, noteTitle: "工具调用" });
    feedNoteIntentToCompanion({ kind: "recall_hint", noteId, noteVersionId, noteTitle: "工具调用", recallId, question: "为什么要把新增的利息也算进去？" });
    expect(intents).toEqual([
      expect.objectContaining({ kind: "recall", noteId, noteVersionId, noteTitle: "工具调用", requestId: expect.any(String) }),
      expect.objectContaining({ kind: "recall_hint", noteId, noteVersionId, noteTitle: "工具调用", recallId, question: "为什么要把新增的利息也算进去？", requestId: expect.any(String) }),
    ]);
    off();
  });

  it("拒绝缺少回想记录或问题的线索意图", () => {
    const intents: unknown[] = [];
    const off = subscribeCompanionFeed({ onFeed: () => undefined, onNoteIntent: (intent) => intents.push(intent), onOpenChat: () => undefined });
    feedNoteIntentToCompanion({ kind: "recall_hint", noteId: "11111111-1111-4111-8111-111111111111", noteVersionId: "22222222-2222-4222-8222-222222222222", noteTitle: "工具调用" });
    expect(intents).toEqual([]);
    off();
  });

  it("没有选区时不接管右键：系统菜单照旧，也不长出浮层", () => {
    selectText("   ");
    render(<CompanionFeedMenu />);

    expect(rightClick()).toBe(false);
    expect(screen.queryByRole("group", { name: "划选文本操作" })).toBeNull();
  });

  it("有选区时接管，点「丢给伴星」把内容送到事件总线上", () => {
    selectText("这一段是笔记里的原文");
    const fed: string[] = [];
    let opened = 0;
    // 用消费端那个订阅口而不是裸 addEventListener：它才返回退订函数，
    // 而且顺带验了"投喂 + 开抽屉"两个事件是成对发的（只收到一个就是总线断了）。
    const off = subscribeCompanionFeed({
      onFeed: (selection) => { fed.push(selection.text); },
      onNoteIntent: () => undefined,
      onOpenChat: () => { opened += 1; },
    });
    render(<CompanionFeedMenu />);

    expect(rightClick()).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /丢给伴星/ }));
    expect(fed).toEqual(["这一段是笔记里的原文"]);
    expect(opened).toBe(1);
    off();
  });

  it("计数报告完整选区，超上限提示分段而不默默发送前缀", () => {
    const long = "字".repeat(COMPANION_FEED_MAX_CHARS + 500);
    selectText(long);
    render(<CompanionFeedMenu />);
    rightClick();

    const count = screen.getByText(`已选 ${long.length} 字，超过 ${COMPANION_FEED_MAX_CHARS} 字，请分段选择`);
    expect(count).toBeTruthy();
    // 反面对照：以前的写法只存截断后的文本，读数永远是"正好装满"。
    expect(screen.queryByText(`${COMPANION_FEED_MAX_CHARS}/${COMPANION_FEED_MAX_CHARS}`)).toBeNull();
  });

  it("没超上限时计数显示实际长度与上限", () => {
    selectText("短句");
    render(<CompanionFeedMenu />);
    rightClick();
    expect(screen.getByText(`2/${COMPANION_FEED_MAX_CHARS}`)).toBeTruthy();
  });

  it("长划选和拖拽完整进入事件总线，尾部纠正与换行不丢", () => {
    const fed: string[] = [];
    const off = subscribeCompanionFeed({ onFeed: event => fed.push(event.text), onNoteIntent: () => {}, onOpenChat: () => {} });
    const text = "原文🫧\n".repeat(650) + "最后更正：交付还未发生。";
    selectText(text);
    render(<CompanionFeedMenu />);
    rightClick();
    fireEvent.click(screen.getByRole("button", { name: /丢给伴星/ }));
    expect(fed).toEqual([text]);
    const event = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: { types: ["text/plain"], getData: () => text } });
    fireEvent(document.body, event);
    expect(fed).toEqual([text, text]);
    off();
  });

  it("Esc 能把浮层收掉（鼠标打开的东西也该有不碰鼠标就关掉的出口）", async () => {
    selectText("要投喂的一段");
    render(<CompanionFeedMenu />);
    rightClick();
    expect(screen.getByRole("group", { name: "划选文本操作" })).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("group", { name: "划选文本操作" })).toBeNull());
  });

  it("编辑器保留原生右键，伴星缺席时不接管选区", () => {
    selectText("笔记原文");
    render(<CompanionFeedMenu />);
    const editor = document.createElement("textarea");
    document.body.append(editor);
    expect(rightClick(editor)).toBe(false);
    document.querySelector(".companion-hud")?.remove();
    expect(rightClick()).toBe(false);
    expect(screen.queryByRole("group", { name: "划选文本操作" })).toBeNull();
  });

  it("采集栏的文字拖放归采集栏；空白处的文字拖放只投喂一次", () => {
    const fed: string[] = [];
    const off = subscribeCompanionFeed({ onFeed: (selection) => fed.push(selection.text), onNoteIntent: () => undefined, onOpenChat: () => undefined });
    render(<CompanionFeedMenu />);
    const slot = document.createElement("div");
    slot.className = "capture-strip";
    document.body.append(slot);
    const drop = (target: HTMLElement, claimed = false) => {
      const event = new Event("drop", { bubbles: true, cancelable: true }) as DragEvent;
      Object.defineProperty(event, "dataTransfer", { value: { getData: () => "拖入的一段话" } });
      if (claimed) event.preventDefault();
      act(() => { target.dispatchEvent(event); });
      return event;
    };
    expect(drop(slot).defaultPrevented).toBe(false);
    expect(drop(document.body, true).defaultPrevented).toBe(true);
    expect(fed).toEqual([]);
    expect(drop(document.body).defaultPrevented).toBe(true);
    expect(fed).toEqual(["拖入的一段话"]);
    off();
  });

  it("右键浮层保留复制出口，超过发送边界仍复制完整选区", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const selected = "内容".repeat(COMPANION_FEED_MAX_CHARS);
    selectText(selected);
    render(<CompanionFeedMenu />);
    rightClick();
    fireEvent.click(screen.getByRole("button", { name: "复制选中内容" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(selected));
    await waitFor(() => expect(screen.queryByRole("group", { name: "划选文本操作" })).toBeNull());
  });
});
