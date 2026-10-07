// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanionNotificationCenter } from "../CompanionNotificationCenter";
import { notifyCompanion, useCompanionNotifications, type CompanionNotificationInput } from "../companion-notifications";
import { setCompanionNotificationVoiceHost } from "../companion-notification-voice";
import { useRoomStore } from "../../../app/room-store";
vi.mock("../use-companion-notification-sources", () => ({ useCompanionNotificationSources: () => {} }));
vi.mock("../../motion/use-tactile-surface", () => ({ useTactileSurface: () => {} }));

const props = { replyBusy: false, blocked: false, muted: false, passiveMuted: false };
const notice = (patch: Partial<CompanionNotificationInput> = {}): CompanionNotificationInput => ({ id: "test", kind: "help", title: "需要下载模型", body: "选择下载后可以说话", scope: "device", delivery: "immediate", ...patch });
const flush = async (ms = 0) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
beforeEach(() => { vi.useFakeTimers(); useCompanionNotifications.setState({ items: [] }); vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} }); });
afterEach(() => { cleanup(); setCompanionNotificationVoiceHost(null); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("notification paper interactions", () => {
  it("keeps a notice in the inbox when a user-opened task bubble takes focus", async () => {
    const view = render(<CompanionNotificationCenter {...props} />);
    act(() => notifyCompanion(notice())); await flush();
    expect(screen.getByRole("region", { name: "伴星通知：需要下载模型" })).toBeTruthy();
    view.rerender(<CompanionNotificationCenter {...props} blocked />); await flush();
    view.rerender(<CompanionNotificationCenter {...props} />); await flush();
    expect(screen.queryByRole("region", { name: "伴星通知：需要下载模型" })).toBeNull();
    expect(useCompanionNotifications.getState().items).toHaveLength(1);
  });
  it("shows direct guidance silently while a reply is busy and retains its jump action", async () => {
    const synthesize = vi.fn(), run = vi.fn();
    setCompanionNotificationVoiceHost({ available: () => true, synthesize, play: vi.fn(), stop: vi.fn() });
    render(<CompanionNotificationCenter {...props} replyBusy />);
    act(() => notifyCompanion(notice({ audio: { text: "下载模型" }, actions: [{ id: "go", label: "去下载", kind: "navigate", run }] }))); await flush();
    expect(screen.getByText("伴星正在回复，这条通知仅显示文字")).toBeTruthy(); expect(synthesize).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "去下载" })); await flush(); expect(run).toHaveBeenCalledOnce();
  });
  it("delivers a queued completion after reply idle with a short pause", async () => {
    const view = render(<CompanionNotificationCenter {...props} replyBusy />);
    act(() => notifyCompanion(notice({ delivery: "when-idle" }))); await flush(1_000);
    expect(screen.queryByText("需要下载模型")).toBeNull();
    view.rerender(<CompanionNotificationCenter {...props} />); await flush(649); expect(screen.queryByText("需要下载模型")).toBeNull();
    await flush(1); expect(screen.getByText("需要下载模型")).toBeTruthy();
  });
  it("runs an async confirmation once, keeps failures open and supports retry", async () => {
    let reject!: (error: Error) => void;
    const run = vi.fn().mockImplementationOnce(() => new Promise<void>((_, no) => { reject = no; })).mockResolvedValue(undefined);
    render(<CompanionNotificationCenter {...props} />); act(() => notifyCompanion(notice({ actions: [{ id: "confirm", label: "确认", kind: "confirm", run }] }))); await flush();
    const button = screen.getByRole("button", { name: "确认" }); fireEvent.click(button); fireEvent.click(button); expect(run).toHaveBeenCalledOnce();
    await act(async () => reject(new Error("暂时不可用"))); expect(screen.getByRole("alert").textContent).toContain("可以重试");
    fireEvent.click(screen.getByRole("button", { name: "确认" })); await flush(); expect(run).toHaveBeenCalledTimes(2);
    expect(useCompanionNotifications.getState().items[0].state).toBe("read");
  });
  it("cancels an offered action without invoking its confirmation", async () => {
    const confirm = vi.fn(), cancel = vi.fn(); render(<CompanionNotificationCenter {...props} />);
    act(() => notifyCompanion(notice({ actions: [{ id: "yes", label: "确认", kind: "confirm", run: confirm }, { id: "no", label: "取消", kind: "cancel", run: cancel }] }))); await flush();
    fireEvent.click(screen.getByRole("button", { name: "取消" })); await flush();
    expect(cancel).toHaveBeenCalledOnce(); expect(confirm).not.toHaveBeenCalled();
  });
  it("keeps collapsed messages in the inbox and restores keyboard focus", async () => {
    render(<CompanionNotificationCenter {...props} />); act(() => notifyCompanion(notice())); await flush();
    fireEvent.click(screen.getByRole("button", { name: "收起通知，稍后查看" }));
    expect(screen.queryByText("需要下载模型")).toBeNull(); expect(document.activeElement?.getAttribute("aria-label")).toContain("查看伴星通知");
    fireEvent.click(screen.getByRole("button", { name: /查看伴星通知/ }));
    fireEvent.click(screen.getByRole("button", { name: /需要下载模型/ })); expect(screen.getByText("选择下载后可以说话")).toBeTruthy();
  });
  it("does not let a modal or assessment consume a queued message", async () => {
    const view = render(<CompanionNotificationCenter {...props} blocked />); act(() => notifyCompanion(notice())); await flush(1_000);
    expect(screen.queryByText("需要下载模型")).toBeNull(); view.rerender(<CompanionNotificationCenter {...props} />); await flush(); expect(screen.getByText("需要下载模型")).toBeTruthy();
  });
  it("shows the next attempt even when it reuses a removed download notice ID", async () => {
    render(<CompanionNotificationCenter {...props} />);
    act(() => notifyCompanion(notice())); await flush();
    act(() => useCompanionNotifications.getState().remove("test")); await flush();
    act(() => notifyCompanion(notice({ body: "重新下载的进度" }))); await flush();
    expect(screen.getByText("重新下载的进度")).toBeTruthy();
  });
  it("keeps scheduled reminders available during quiet hours and resumes tasks when the period ends", async () => {
    vi.setSystemTime(new Date("2026-10-04T22:59:30Z"));
    const quietHours = { timezone: "UTC", startLocal: "22:00", endLocal: "23:00" };
    render(<CompanionNotificationCenter {...props} quietHours={quietHours} />);
    act(() => notifyCompanion(notice({ id: "task", title: "后台完成", delivery: "when-idle", kind: "task" })));
    await flush(1_000); expect(screen.queryByText("后台完成")).toBeNull();
    act(() => notifyCompanion(notice({ id: "reminder", title: "约好的提醒", delivery: "when-idle", kind: "reminder" })));
    await flush(650); expect(screen.getByText("约好的提醒")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "关闭这条通知" }));
    await flush(29_000); await flush(650);
    expect(screen.getByText("后台完成")).toBeTruthy();
  });
  it("does not run a stale workspace action even before the view has cleared it", async () => {
    const scope = 10, run = vi.fn(); useRoomStore.setState({ workspaceScopeRevision: scope });
    render(<CompanionNotificationCenter {...props} />);
    act(() => notifyCompanion(notice({ scope, actions: [{ id: "open", kind: "navigate", label: "打开", run }] }))); await flush();
    useRoomStore.setState({ workspaceScopeRevision: scope + 1 });
    fireEvent.click(screen.getByRole("button", { name: "打开" })); await flush(); expect(run).not.toHaveBeenCalled();
  });
});
