// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { NoteDetailV1 } from "@astella/shared/note-projection-contracts";
import { useNotebookVersions } from "../use-notebook-versions";

it("恢复回执到达后列表立即标出目标版本，不沿用回读前的当前版本", async () => {
  const versions = vi.fn(async ({ currentVersionId }: { currentVersionId: string }) => ({
    ok: true, data: { items: [{ versionId: currentVersionId, versionNo: 1, current: true }] },
  }));
  const reload = vi.fn(async () => undefined);
  const api = { note: { versions, restoreVersion: vi.fn(async () => ({ ok: true, data: { status: "restored" } })) } };
  const { result } = renderHook(() => useNotebookVersions({
    data: { note: { noteId: "note", currentVersionId: "v2" } as NoteDetailV1 },
    epochRef: { current: 1 }, reload,
    api: api as unknown as NonNullable<Window["astella"]>,
  }));
  await act(async () => {
    await result.current.restoreVersion({ versionId: "v1", versionNo: 1, current: false, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" });
  });
  expect(reload).toHaveBeenCalledWith({ silent: true });
  expect(versions).toHaveBeenCalledWith(expect.objectContaining({ currentVersionId: "v1" }));
  expect(result.current.versions?.[0]?.versionId).toBe("v1");
  expect(result.current.versionsFailure).toBeNull();
});
