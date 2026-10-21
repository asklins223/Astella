// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { useRoomStore } from "../../../../../../app/home/room-store";
import { openNoteLearningCard } from "../learning-card-navigation";

afterEach(() => useRoomStore.setState({ navigationGuard: null, returnTarget: null, activeNoteRef: null, surface: null, destination: "room", viewPreset: "room" }));

it("opens a separate card destination and returns to the same note and its parent", () => {
  const parent = { label: "返回星图", run: vi.fn() };
  const note = { noteId: "note-1", noteVersionId: "version-1", mode: "preview" as const };
  useRoomStore.setState({ surface: "notebook", destination: "notebook", viewPreset: "notebook", activeNoteRef: note, returnTarget: parent, navigationGuard: null });
  openNoteLearningCard(note);
  expect(useRoomStore.getState()).toMatchObject({ surface: "note-card", destination: "note-card", activeNoteRef: note, returnTarget: { label: "返回笔记" } });
  useRoomStore.getState().returnTarget!.run();
  expect(useRoomStore.getState()).toMatchObject({ surface: "notebook", activeNoteRef: note });
  expect(useRoomStore.getState().returnTarget).toBe(parent);
  expect(parent.run).not.toHaveBeenCalled();
});

it("cannot reopen a note in a different workspace using a stale return callback", () => {
  const room = useRoomStore.getState();
  openNoteLearningCard({ noteId: "note-1", noteVersionId: "version-1" });
  const back = useRoomStore.getState().returnTarget!.run;
  room.resetWorkspaceScope();
  back();
  expect(useRoomStore.getState()).toMatchObject({ surface: null, activeNoteRef: null });
});
