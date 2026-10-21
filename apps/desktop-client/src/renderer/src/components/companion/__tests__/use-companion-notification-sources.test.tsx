// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRoomStore } from "../../../app/home/room-store";
import { useCompanionNotifications } from "../notify/companion-notifications";
import { useCompanionNotificationSources } from "../notify/use-companion-notification-sources";

const source = vi.hoisted(() => ({
  home: null as null | { sanitizedReviewSummary: { state: string; data: { dueCount: number } } },
  companion: null as null | { proactiveCue: { origin: string; revision: number; text: string } },
  invalidationRevision: 0,
  reload: vi.fn(), timeline: vi.fn(), present: vi.fn(), ack: vi.fn(),
}));
vi.mock("../../../app/home/home-projection", () => ({
  useHomeProjection: () => ({ projection: source.home, reload: source.reload }),
  useHomeProjectionInvalidation: () => ({ revision: source.invalidationRevision, workspaceEpoch: 1 }),
}));
vi.mock("../../../app/companion-pages/companion-home-projection", () => ({ useCompanionHomeProjection: () => ({ projection: source.companion }) }));
vi.mock("../voice/use-voice-model-notifications", () => ({ useVoiceModelNotifications: () => {} }));

const ok = <T,>(data: T) => ({ ok: true, data });
beforeEach(() => {
  vi.useFakeTimers(); vi.resetAllMocks();
  source.home = null; source.companion = null; source.invalidationRevision = 0;
  useRoomStore.setState({ workspaceScopeRevision: 7, surface: null, windowState: "visible", companionCenterTarget: null });
  useCompanionNotifications.setState({ items: [] });
  source.timeline.mockResolvedValue(ok({ items: [{ inboxSequence: 9, deliveryId: "reminder-delivery" }] }));
  source.present.mockResolvedValue(ok({})); source.ack.mockResolvedValue(ok({}));
  window.astella = {
    companion: { activity: { timeline: source.timeline, present: source.present, ack: source.ack } },
  } as unknown as typeof window.astella;
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("real notification source adapters", () => {
  it("does not create a due-review notice", async () => {
    source.home = { sanitizedReviewSummary: { state: "data", data: { dueCount: 2 } } };
    renderHook(useCompanionNotificationSources);
    expect(useCompanionNotifications.getState().items).toHaveLength(0);
  });

  it("routes reminders to independent messages and sends real displayed/acted receipts", async () => {
    source.companion = { proactiveCue: { origin: "reminder", revision: 9, text: "回来温习今天的笔记" } };
    renderHook(useCompanionNotificationSources);
    const notice = useCompanionNotifications.getState().items[0];
    expect(notice).toMatchObject({ kind: "reminder", audio: { text: "回来温习今天的笔记" } });
    await act(async () => notice.onShown?.());
    expect(source.present).toHaveBeenCalledWith(expect.objectContaining({ deliveryId: "reminder-delivery", inboxSequence: 9 }));
    await act(async () => notice.actions?.find(action => action.id === "ok")?.run?.());
    expect(source.ack).toHaveBeenCalledWith(expect.objectContaining({ request: { deliveryId: "reminder-delivery", inboxSequence: 9, transition: "acted" } }));
  });

  it("accepts system deliveries", async () => {
    source.companion = { proactiveCue: { origin: "system", revision: 9, text: "刚才的学习记录已保存" } };
    renderHook(useCompanionNotificationSources);
    expect(useCompanionNotifications.getState().items[0]).toMatchObject({ kind: "help", source: "书房消息", body: "刚才的学习记录已保存" });
  });

  it("prevents a late reminder receipt from acting in another workspace", async () => {
    source.companion = { proactiveCue: { origin: "reminder", revision: 9, text: "旧书房的约定" } };
    renderHook(useCompanionNotificationSources);
    const notice = useCompanionNotifications.getState().items[0];
    let finish!: (value: unknown) => void;
    source.timeline.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    let acted!: Promise<void | boolean> | void | boolean;
    act(() => { acted = notice.actions?.find(action => action.id === "ok")?.run?.(); });
    act(() => useRoomStore.setState({ workspaceScopeRevision: 8 }));
    await act(async () => { finish(ok({ items: [{ inboxSequence: 9, deliveryId: "reminder-delivery" }] })); await acted; });
    expect(source.ack).not.toHaveBeenCalled();
    expect(useCompanionNotifications.getState().items).toHaveLength(0);
  });

  /**
   * 过了展示窗口、又从未被任何设备接走的那几句，回来时至少留一枚路标
   * （见 `use-companion-notification-sources` 里那段说明）。判据只认 `queued`+过期：
   * 还在窗口里的、已经被接走（`delivered`/`displayed`）的、以及提醒类 system_event
   * 都不算"没听过"。
   */
  it("她说过却没人接的那几句只留一枚路标，动作打开动态", async () => {
    const delivery = (over: Record<string, unknown>) => ({
      version: 1, label: "她说过的话", createdAt: "2026-10-14T12:00:00.000Z", expiresAt: "2026-10-14T14:00:00.000Z",
      kind: "system_event", state: "queued", expired: true, target: { kind: "dialogue", messageId: "00000000-0000-4000-8000-000000000001" },
      ...over,
    });
    source.timeline.mockResolvedValue(ok({ items: [
      delivery({ deliveryId: "missed", inboxSequence: 3 }),
      delivery({ deliveryId: "live", inboxSequence: 4, expired: false }),
      delivery({ deliveryId: "taken", inboxSequence: 5, state: "displayed" }),
      delivery({ deliveryId: "reminder", inboxSequence: 6, target: { kind: "none" } }),
    ] }));
    renderHook(useCompanionNotificationSources);
    await act(async () => { await Promise.resolve(); });
    const notices = useCompanionNotifications.getState().items.filter(item => item.id.startsWith("initiative-missed"));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ kind: "help", scope: 7, title: "有几句话你还没听过" });
    expect(notices[0].body).toContain("1 次");
    await act(async () => notices[0].actions?.find(action => action.id === "activity")?.run?.());
    expect(useRoomStore.getState().companionCenterTarget).toEqual({ tab: "activity" });
  });
});
