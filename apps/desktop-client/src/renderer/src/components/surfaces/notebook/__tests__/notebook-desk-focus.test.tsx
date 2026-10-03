// @vitest-environment jsdom
import { useRef, useState, type ComponentProps } from "react";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useRoomStore } from "../../../../app/room-store";
import { NotebookDesk, type NotebookSidePage } from "../notebook-desk";

function Desk() {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [sidePage, setSidePage] = useState<NotebookSidePage | null>(null);
  const props: ComponentProps<typeof NotebookDesk> = { noteId: "note", noteTitle: "长笔记", version: 1, mode: "preview", canEdit: true,
    pendingMode: null, onMode: vi.fn(), articleHeader: <h2>长笔记</h2>, outline: [{ block: 2, title: "第二节", level: 2 }],
    onLocate: vi.fn(), onOpenDirectory: vi.fn(), learningView: "body", onLearning: vi.fn(), onBody: vi.fn(), tools: null,
    primaryAction: null, taskActions: null, extraActions: null, status: null, scrollRef, children: <p>正文仍然留在册页。</p>, sidePage,
    sourceAction: <button type="button" onClick={() => setSidePage({ kind: "source", title: "资料袋", closeLabel: "合起资料袋", onClose: () => setSidePage(null), content: <p>来源原文</p> })}>资料袋</button> };
  return <NotebookDesk {...props} />;
}
beforeEach(() => useRoomStore.setState({ motionMode: "off", reducedMotion: false }));
afterEach(() => { cleanup(); useRoomStore.setState({ motionMode: "full", reducedMotion: false }); });

it("紧凑目录打开后焦点进入目录，Escape 关闭并回到可见触发按钮", () => {
  const view = render(<Desk />), trigger = view.getByRole("button", { name: "目录" });
  trigger.focus(); fireEvent.keyDown(trigger, { key: "Enter" }); fireEvent.click(trigger);
  const directory = view.getByRole("complementary", { name: "笔记目录" });
  expect(directory.contains(document.activeElement)).toBe(true);
  expect(view.queryByRole("group", { name: "正文视图" })).toBeNull();
  expect(view.getByText("正文仍然留在册页。").closest("[inert]")).toBeTruthy();
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(view.queryByRole("complementary", { name: "笔记目录" })).toBeNull();
  expect(document.activeElement).toBe(trigger); expect(trigger.closest("[hidden]")).toBeNull();
  expect(view.getByRole("group", { name: "正文视图" })).toBeTruthy();
});

it("紧凑旁页接住键盘焦点，关闭回到资料袋入口，正文位置与挂载保留", () => {
  const view = render(<Desk />), trigger = view.getByRole("button", { name: "资料袋" });
  const scroller = view.getByLabelText("正在阅读"); scroller.scrollTop = 320;
  trigger.focus(); fireEvent.keyDown(trigger, { key: "Enter" }); fireEvent.click(trigger);
  const side = view.getByRole("complementary", { name: "笔记旁页" });
  expect(document.activeElement).toBe(side); expect(within(side).getByText("来源原文")).toBeTruthy();
  expect(view.queryByRole("button", { name: "资料袋" })).toBeNull();
  fireEvent.click(within(side).getByRole("button", { name: "合起资料袋" }));
  expect(view.queryByRole("complementary", { name: "笔记旁页" })).toBeNull();
  expect(document.activeElement).toBe(trigger); expect(scroller.scrollTop).toBe(320);
  expect(view.getByRole("button", { name: "目录" })).toBeTruthy();
});
