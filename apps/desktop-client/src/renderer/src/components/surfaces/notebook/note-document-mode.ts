export type NoteBodyMode = "preview" | "live-preview" | "source";

export const NOTE_BODY_MODES = [
  { id: "preview", label: "阅读" },
  { id: "live-preview", label: "编辑" },
  { id: "source", label: "源码" },
] as const;

export function isNoteEditingMode(mode: NoteBodyMode): boolean {
  return mode !== "preview";
}
