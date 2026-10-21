export type ViewPresetId =
  | "room"
  | "notebook"
  | "note-card"
  | "search"
  | "graph"
  | "source-library"
  | "source-detail"
  | "note-library"
  | "companion-center"
  | "settings";

export type RoomDestination = ViewPresetId;

export type RoomSurface = Exclude<RoomDestination, "room"> | null;
export type RoomTheme = "day" | "night";
export type MotionMode = "full" | "lite" | "off";
export type WindowState = "visible" | "hidden" | "minimized";
export type PresentationPhase =
  | "booting"
  | "poster-ready"
  | "media-loading"
  | "media-ready"
  | "media-fallback";

export type RoomIntent =
  | "home"
  | "continue"
  | "open-notebook"
  | "open-note-card"
  | "search"
  | "graph"
  | "open-sources"
  | "open-source"
  | "open-notes"
  | "open-companion-center"
  | "open-settings";

export type RoomViewState = {
  destination: RoomDestination;
  viewPreset: ViewPresetId;
  surface: RoomSurface;
};

export const initialViewState: RoomViewState = {
  destination: "room",
  viewPreset: "room",
  surface: null,
};

export function resolveRoomIntent(intent: RoomIntent): RoomViewState {
  switch (intent) {
    case "continue":
      return { destination: "notebook", viewPreset: "notebook", surface: "notebook" };
    case "open-notebook":
      return { destination: "notebook", viewPreset: "notebook", surface: "notebook" };
    case "open-note-card":
      return { destination: "note-card", viewPreset: "note-card", surface: "note-card" };
    case "search":
      return { destination: "search", viewPreset: "search", surface: "search" };
    case "graph":
      return { destination: "graph", viewPreset: "graph", surface: "graph" };
    case "open-sources":
      return { destination: "source-library", viewPreset: "source-library", surface: "source-library" };
    case "open-source":
      return { destination: "source-detail", viewPreset: "source-detail", surface: "source-detail" };
    case "open-notes":
      return { destination: "note-library", viewPreset: "note-library", surface: "note-library" };
    case "open-companion-center":
      return { destination: "companion-center", viewPreset: "companion-center", surface: "companion-center" };
    case "open-settings":
      return { destination: "settings", viewPreset: "settings", surface: "settings" };
    case "home":
    default:
      return initialViewState;
  }
}

export function nextMotionMode(mode: MotionMode): MotionMode {
  if (mode === "full") return "lite";
  if (mode === "lite") return "off";
  return "full";
}
