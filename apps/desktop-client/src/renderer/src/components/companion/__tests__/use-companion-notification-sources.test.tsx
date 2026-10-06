// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRoomStore } from "../../../app/room-store";
import { useCompanionNotifications } from "../companion-notifications";
import { useCompanionNotificationSources } from "../use-companion-notification-sources";

const source = vi.hoisted(() => ({
  home: null as null | { sanitizedReviewSummary: { state: string; data: { dueCount: number } } },
  companion: null as null | { proactiveCue: { origin: string; revision: number; text: string } },
  reload: vi.fn(), timeline: vi.fn(), present: vi.fn(), ack: vi.fn(), projection: vi.fn(),
}));
vi.mock("../../../app/home-projection", () => ({ useHomeProjection: () => ({ projection: source.home, reload: source.reload }) }));
vi.mock("../../../app/companion-home-projection", () => ({ useCompanionHomeProjection: () => ({ projection: source.companion }) }));
vi.mock("../use-voice-model-notifications", () => ({ useVoiceModelNotifications: () => {} }));

const ok = <T,>(data: T) => ({ ok: true, data });
let receive: ((event: { workspaceEpoch: number; data: { kind: string } }) => void) | undefined;
beforeEach(() => {
  vi.useFakeTimers(); vi.resetAllMocks();
  source.home = null; source.companion = null; receive = undefined;
  useRoomStore.setState({ workspaceScopeRevision: 7, surface: null, windowState: "visible" });
  useCompanionNotifications.setState({ items: [] });
  source.timeline.mockResolvedValue(ok({ items: [{ inboxSequence: 9, deliveryId: "reminder-delivery" }] }));
  source.present.mockResolvedValue(ok({})); source.ack.mockResolvedValue(ok({}));
  window.astella = {
    companion: { activity: { timeline: source.timeline, present: source.present, ack: source.ack }, home: { getProjection: source.projection } },
    subscriptions: {
      subscribe: vi.fn(async () => ok({ subscriptionId: "notifications-runtime" })),
      unsubscribe: vi.fn(async () => ok({})),
      onEvent: vi.fn((_, listener) => { receive = listener; return () => { receive = undefined; }; }),
    },
  } as unknown as typeof window.astella;
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("real notification source adapters", () => {
  it("offers today's due reviews once and its action opens the review page", async () => {
    source.home = { sanitizedReviewSummary: { state: "data", data: { dueCount: 2 } } };
    const view = renderHook(useCompanionNotificationSources);
    const notice = useCompanionNotifications.getState().items[0];
    expect(notice).toMatchObject({ kind: "review", title: "2 项知识等你温习", scope: 7, audio: { clip: "review-due" } });
    act(() => useCompanionNotifications.getState().dismiss(notice.id)); view.rerender();
    expect(useCompanionNotifications.getState().items).toHaveLength(1);
    await act(async () => notice.actions?.find(action => action.id === "review")?.run?.());
    expect(useRoomStore.getState().surface).toBe("review");
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

  it("receives due reminders through runtime events while Settings is open", async () => {
    useRoomStore.setState({ surface: "settings" });
    source.projection.mockResolvedValue(ok({ proactiveCue: { origin: "reminder", revision: 9, text: "该休息一下了" } }));
    renderHook(useCompanionNotificationSources); await act(async () => {});
    await act(async () => receive?.({ workspaceEpoch: 4, data: { kind: "companion_activity_changed" } }));
    expect(source.projection).toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ workspaceEpoch: 4 }) }));
    expect(useCompanionNotifications.getState().items[0].body).toBe("该休息一下了");
  });
  it("also accepts system deliveries, while personal thoughts keep their existing companion expression", async () => {
    source.companion = { proactiveCue: { origin: "system", revision: 9, text: "刚才的学习记录已保存" } };
    const view = renderHook(useCompanionNotificationSources);
    expect(useCompanionNotifications.getState().items[0]).toMatchObject({ kind: "help", source: "书房消息", body: "刚才的学习记录已保存" });
    source.companion = { proactiveCue: { origin: "thought", revision: 10, text: "想起昨天一起读的那段话" } };
    view.rerender(); expect(useCompanionNotifications.getState().items).toHaveLength(1);
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
});
