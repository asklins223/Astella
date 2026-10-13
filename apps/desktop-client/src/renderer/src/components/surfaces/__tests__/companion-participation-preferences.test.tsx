// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanionParticipationPreferences } from "../companion/companion-participation-preferences";
import { useRoomStore } from "../../../app/room-store";
import type { CompanionParticipationPreferencesV1 } from "@astella/shared/companion-initiative-contracts";

const ok = <T,>(data: T) => ({ version: 1, ok: true, data, requestId: "participation", correlationId: "participation", schemaRevision: "desktop-ipc-v1" });
let value: CompanionParticipationPreferencesV1;
const write = vi.fn();
beforeEach(() => {
  value = { version: 1, revision: 3, enabled: true, markdown: "我重读同一篇笔记时，先帮我接上上次的问题。", updatedAt: null, source: null };
  write.mockReset().mockImplementation(async ({ request }) => {
    value = { ...value, ...request, revision: value.revision + 1 }; return ok(value);
  });
  Object.defineProperty(window, "astella", { configurable: true, value: {
    auth: { getState: vi.fn(async () => ok({ status: "authenticated", workspace: { workspaceEpoch: 1 } })) },
    companion: { initiative: { getPreferences: vi.fn(async () => ok(value)), setPreferences: write } },
  } });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); Reflect.deleteProperty(window, "astella"); });

describe("用户自由表达的相处偏好", () => {
  it("空白个人偏好仍清楚展示所有账号自带的默认行为", async () => {
    value = { ...value, markdown: "" };
    render(<CompanionParticipationPreferences />);
    await screen.findByText("你还没有添加个人约定；上面的默认方式仍会照常生效。");
    for (const label of ["自然接话与分句", "页面与难题帮助", "启动问候", "久学休息"]) expect(screen.getByText(label)).toBeTruthy();
  });
  it("保留自由原文，按已读版本保存，并可暂停和恢复", async () => {
    render(<CompanionParticipationPreferences />);
    await screen.findByText(value.markdown);
    fireEvent.click(screen.getByRole("button", { name: "编辑偏好" }));
    const text = "每次启动问好；学久了提醒我走走；如果我提出猜想，先追问依据再一起分析。";
    fireEvent.change(screen.getByRole("textbox"), { target: { value: text } });
    fireEvent.click(screen.getByRole("button", { name: "保存偏好" }));
    await waitFor(() => expect(write).toHaveBeenCalledWith(expect.objectContaining({ request: { markdown: text, enabled: true, expectedRevision: 3 } })));
    await screen.findByRole("button", { name: "暂停这些主动约定" });
    fireEvent.click(screen.getByRole("button", { name: "暂停这些主动约定" }));
    await screen.findByRole("button", { name: "恢复这些主动约定" });
    expect(write.mock.calls[1]![0].request).toEqual({ markdown: text, enabled: false, expectedRevision: 4 });
    fireEvent.click(screen.getByRole("button", { name: "恢复这些主动约定" }));
    await screen.findByRole("button", { name: "暂停这些主动约定" });
  });
  it("版本冲突保留草稿，重新读取不会覆盖输入", async () => {
    render(<CompanionParticipationPreferences />); await screen.findByText(value.markdown);
    fireEvent.click(screen.getByRole("button", { name: "编辑偏好" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "我的新约定" } });
    write.mockResolvedValueOnce({ version: 1, ok: false, error: { code: "participation_stale", message: "相处偏好刚刚有变化。" } });
    fireEvent.click(screen.getByRole("button", { name: "保存偏好" }));
    await screen.findByRole("alert");
    value = { ...value, markdown: "另一端保存的内容", revision: 4 };
    fireEvent.click(screen.getByRole("button", { name: "重新读取" }));
    await waitFor(() => expect(screen.getByText("另一端保存的内容")).toBeTruthy());
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("我的新约定");
  });
  it("切换空间时丢弃旧空间尚未保存的草稿", async () => {
    render(<CompanionParticipationPreferences />); await screen.findByText(value.markdown);
    fireEvent.click(screen.getByRole("button", { name: "编辑偏好" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "尚未保存" } });
    await act(async () => useRoomStore.setState(s => ({ workspaceScopeRevision: s.workspaceScopeRevision + 1 })));
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
  });
});
