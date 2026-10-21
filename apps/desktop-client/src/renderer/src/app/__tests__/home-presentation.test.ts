import { describe, expect, it } from "vitest";
import type { RoomProjectionV1 } from "@astella/shared/room-projection-contracts";
import { homePresentation } from "../home/home-presentation.ts";

const NOTE_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";

function projection(overrides: Partial<RoomProjectionV1> = {}): RoomProjectionV1 {
  return {
    version: 1,
    workspaceEpoch: 1,
    snapshotAt: "2026-10-20T08:00:00.000Z",
    dashboardRevision: "room-1-0-none",
    mode: "first_use",
    recentNote: null,
    recentActivitySummary: { state: "empty" },
    captureCapability: { state: "enabled" },
    sectionStates: { recentActivitySummary: { state: "empty" } },
    degradation: null,
    ...overrides,
  };
}

describe("home presentation", () => {
  it("starts from a material when the space has no note yet", () => {
    const home = homePresentation(projection(), false, null);
    expect(home.title).toBe("从一份真正想弄懂的材料开始");
    expect(home.primaryIntent).toBeNull();
    expect(home.note).toBeNull();
    expect(home.notebookState).toBe("empty");
  });

  it("continues the most recent note", () => {
    const home = homePresentation(projection({
      mode: "notes",
      recentNote: { noteId: NOTE_ID, noteVersionId: VERSION_ID, title: "秦朝统一与中央集权制度" },
      recentActivitySummary: {
        state: "data",
        data: { items: [{ activityId: NOTE_ID, kind: "note.updated", occurredAt: "2026-10-19T01:00:00.000Z" }] },
      },
      sectionStates: { recentActivitySummary: { state: "data" } },
    }), false, null);
    expect(home.title).toBe("秦朝统一与中央集权制度");
    expect(home.primaryLabel).toBe("接着读");
    expect(home.primaryIntent).toBe("continue");
    expect(home.note).toEqual({ noteId: NOTE_ID, noteVersionId: VERSION_ID, title: "秦朝统一与中央集权制度" });
    expect(home.notebookState).toBe("ready");
  });

  it("reports loading and unreadable projections without inventing a note", () => {
    const loading = homePresentation(null, true, null);
    expect(loading.blockingLoading).toBe(true);
    expect(loading.note).toBeNull();
    const failed = homePresentation(null, false, "连接中断");
    expect(failed.title).toBe("笔记暂未送达");
    expect(failed.detail).toBe("连接中断");
    expect(failed.retry).toBe(true);
  });
});
