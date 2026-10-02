export type NoteBodyMode = "preview" | "live-preview" | "source";

export const NOTE_BODY_MODES = [
  { id: "preview", label: "预览" },
  { id: "live-preview", label: "可编辑预览" },
  { id: "source", label: "纯编辑" },
] as const;

export function isNoteEditingMode(mode: NoteBodyMode): boolean {
  return mode !== "preview";
}
