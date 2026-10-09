// @vitest-environment jsdom
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { NotebookSharingControl } from "../notebook-sharing-control";

afterEach(cleanup);
const props = { shareScope: "shared" as const, canShare: true, busy: false, onShare: vi.fn(),
  peers: [], selfName: "Asklins", selfMode: "editing" as const, failure: null };

it("可见范围与在场共用一个入口，撤回仍要明确确认", () => {
  const onShare = vi.fn();
  const screen = render(<NotebookSharingControl {...props} onShare={onShare} />);
  expect(screen.getByRole("button", { name: "共享与协同" }).textContent).toContain("已共享");
  expect(screen.getByText("只有你在写")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "取消共享" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "共享与协同" }));
  const popup = screen.getByRole("dialog", { name: "共享与协同" });
  expect(within(popup).getByText("Asklins（你）")).toBeTruthy();
  fireEvent.click(within(popup).getByRole("button", { name: "取消共享" }));
  expect(onShare).not.toHaveBeenCalled();
  expect(popup.textContent).toContain("其他成员就读不到了");
  fireEvent.click(within(popup).getByRole("button", { name: "确认取消共享" }));
  expect(onShare).toHaveBeenCalledExactlyOnceWith("private");
});

it("多个人在场时入口限制印章，展开后完整展示姓名与档位", () => {
  const peers = Array.from({ length: 5 }, (_, i) => ({ clientId: i, name: `很长的读伴姓名 ${i}`, mode: i % 2 ? "reading" as const : "editing" as const, block: null }));
  const screen = render(<NotebookSharingControl {...props} peers={peers} />);
  expect(document.querySelectorAll(".notebook-presence__peer")).toHaveLength(3);
  expect(screen.getByText("6 人在场")).toBeTruthy();
  expect(screen.getByLabelText("还有 3 人")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "共享与协同" }));
  const people = screen.getByRole("list", { name: "此刻在这篇里的人" });
  expect(within(people).getAllByRole("listitem")).toHaveLength(6);
  expect(people.textContent).toContain("很长的读伴姓名 4");
  expect(people.textContent).toContain("在读");
  expect(people.textContent).toContain("在写");
});

it("私有笔记不虚构在场；只读成员仍能核对范围与权限", () => {
  const screen = render(<NotebookSharingControl {...props} shareScope="private" canShare={false} />);
  expect(screen.getByText("仅自己可见")).toBeTruthy();
  expect(document.querySelector(".notebook-presence")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "共享与协同" }));
  expect((screen.getByRole("button", { name: "共享给空间" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText("只有写下这篇的人能修改共享范围。")).toBeTruthy();
});

it("协同失败不报虚假独处，键盘收起弹层回到原入口", () => {
  const screen = render(<NotebookSharingControl {...props} failure="connection_lost" />);
  const trigger = screen.getByRole("button", { name: "共享与协同" });
  expect(screen.getByText("协同没连上")).toBeTruthy();
  expect(screen.queryByText("只有你在写")).toBeNull();
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  const popup = screen.getByRole("dialog", { name: "共享与协同" });
  expect(screen.queryByRole("list")).toBeNull();
  fireEvent.keyDown(popup, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(trigger);
});
