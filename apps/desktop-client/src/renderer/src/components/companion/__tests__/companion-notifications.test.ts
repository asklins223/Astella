import { beforeEach, describe, expect, it, vi } from "vitest";
import { nextCompanionNotification, notificationKey, notifyCompanion, useCompanionNotifications, type CompanionNotificationInput } from "../companion-notifications";
import { placeCompanionNotification } from "../notification-placement";

const notice = (id: string, patch: Partial<CompanionNotificationInput> = {}): CompanionNotificationInput => ({ id, kind: "task", scope: 3, title: "任务完成", body: "已保存", ...patch });
beforeEach(() => useCompanionNotifications.setState({ items: [] }));

describe("companion notification delivery", () => {
  it("deduplicates a business event even after it was dismissed", () => {
    notifyCompanion(notice("task:1")); useCompanionNotifications.getState().dismiss("task:1"); notifyCompanion(notice("task:1"));
    expect(useCompanionNotifications.getState().items).toHaveLength(1);
    expect(useCompanionNotifications.getState().items[0].state).toBe("read");
  });
  it("repeated direct guidance is a new occurrence and precedes a busy background queue", () => {
    notifyCompanion(notice("task:1")); notifyCompanion(notice("model", { scope: "device", delivery: "immediate", repeat: true }));
    const first = useCompanionNotifications.getState().items[1];
    notifyCompanion(notice("model", { scope: "device", delivery: "immediate", repeat: true }));
    const items = useCompanionNotifications.getState().items;
    expect(items[1].revision).toBe(2); expect(notificationKey(items[1])).not.toBe(notificationKey(first));
    expect(nextCompanionNotification(items, new Set(), true)?.id).toBe("model");
    expect(nextCompanionNotification(items, new Set([notificationKey(items[1])]), true)).toBeNull();
    expect(nextCompanionNotification(items, new Set([notificationKey(items[1])]), false)?.id).toBe("task:1");
  });
  it("snoozes then re-delivers exactly once, and removes expired actions", () => {
    vi.useFakeTimers(); vi.setSystemTime(1_000);
    notifyCompanion(notice("task", { expiresAt: 100_000 }));
    const original = useCompanionNotifications.getState().items[0];
    useCompanionNotifications.getState().snooze("task", 20_000);
    useCompanionNotifications.getState().tick(20_000); expect(nextCompanionNotification(useCompanionNotifications.getState().items, new Set(), false)).toBeNull();
    useCompanionNotifications.getState().tick(21_000);
    expect(nextCompanionNotification(useCompanionNotifications.getState().items, new Set([notificationKey(original)]), false)?.id).toBe("task");
    useCompanionNotifications.getState().tick(100_000); expect(useCompanionNotifications.getState().items).toEqual([]);
    vi.useRealTimers();
  });
  it("keeps device downloads and discards another workspace's actions", () => {
    notifyCompanion(notice("old")); notifyCompanion(notice("device", { scope: "device" })); notifyCompanion(notice("new", { scope: 4 }));
    useCompanionNotifications.getState().clearWorkspace(4);
    expect(useCompanionNotifications.getState().items.map(item => item.id)).toEqual(["device", "new"]);
  });
  it("progress updates do not replay or resurrect a closed notice", () => {
    notifyCompanion(notice("download")); useCompanionNotifications.getState().dismiss("download");
    useCompanionNotifications.getState().update("download", { progress: { percent: 65, label: "下载中" } });
    const item = useCompanionNotifications.getState().items[0];
    expect(item.revision).toBe(1); expect(item.state).toBe("read"); expect(item.progress?.percent).toBe(65);
  });
  it("delivers a new attempt after its previous progress notice was removed", () => {
    notifyCompanion(notice("download"));
    const seen = new Set([notificationKey(useCompanionNotifications.getState().items[0])]);
    useCompanionNotifications.getState().remove("download");
    notifyCompanion(notice("download"));
    expect(nextCompanionNotification(useCompanionNotifications.getState().items, seen, false)?.id).toBe("download");
  });
  it("prioritizes an installation outcome without bypassing an active reply", () => {
    notifyCompanion(notice("review", { kind: "review" }));
    notifyCompanion(notice("model-ready", { kind: "model", priority: "high", scope: "device" }));
    const items = useCompanionNotifications.getState().items;
    expect(nextCompanionNotification(items, new Set(), false)?.id).toBe("model-ready");
    expect(nextCompanionNotification(items, new Set(), true)).toBeNull();
  });
});

describe("notice placement", () => {
  it.each([[1440, 810], [1152, 648], [960, 540], [720, 405], [320, 240]])("keeps controls inside %s × %s", (width, height) => {
    const result = placeCompanionNotification({ viewport: { width, height }, paper: { width: 326, height: 420 }, companion: { left: width - 180, top: height - 220, width: 160, height: 220 } });
    expect(result.left).toBeGreaterThanOrEqual(12); expect(result.top).toBeGreaterThanOrEqual(12);
    expect(result.left + Math.min(326, width - 24)).toBeLessThanOrEqual(width - 12);
    expect(result.top + Math.min(420, height - 24)).toBeLessThanOrEqual(height - 12);
  });
  it("moves away from an open reply without covering the character", () => {
    const result = placeCompanionNotification({ viewport: { width: 1440, height: 810 }, paper: { width: 326, height: 250 }, companion: { left: 1110, top: 420, width: 160, height: 300 }, obstacles: [{ left: 750, top: 420, width: 344, height: 260 }] });
    expect(result.top + 250).toBeLessThanOrEqual(420);
  });
});
