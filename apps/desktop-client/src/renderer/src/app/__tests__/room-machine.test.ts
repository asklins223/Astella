import { describe, expect, it } from "vitest";
import { nextMotionMode, resolveRoomIntent } from "../home/room-machine.ts";

describe("room intent mapping", () => {
  it("keeps every live domain action on a deterministic 2D view preset", () => {
    expect(resolveRoomIntent("open-notebook").viewPreset).toBe("notebook");
    expect(resolveRoomIntent("open-note-card")).toEqual({ destination: "note-card", viewPreset: "note-card", surface: "note-card" });
    expect(resolveRoomIntent("search").viewPreset).toBe("search");
    expect(resolveRoomIntent("graph").viewPreset).toBe("graph");
    expect(resolveRoomIntent("open-sources").viewPreset).toBe("source-library");
    expect(resolveRoomIntent("open-notes").viewPreset).toBe("note-library");
    expect(resolveRoomIntent("open-settings").viewPreset).toBe("settings");
    expect(resolveRoomIntent("home")).toEqual({ destination: "room", viewPreset: "room", surface: null });
  });

  it("cycles through the explicit V1 motion modes", () => {
    expect(nextMotionMode("full")).toBe("lite");
    expect(nextMotionMode("lite")).toBe("off");
    expect(nextMotionMode("off")).toBe("full");
  });
});
