// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CompanionSelfNoteV1 } from "@astella/shared";
import { useRoomStore } from "../../../app/room-store";
import { CompanionSelfNotesPage } from "../companion/companion-self-notes-page";

const note: CompanionSelfNoteV1 = { key: "counterexample", revision: 2, title: "我在想的反例",
  body: "# 暂定看法\n\n**先找反证**，再决定是否保留。", tier: "resident", userDisabled: false,
  nextReviewAt: null, expiresAt: null, reason: "这是我的关注角度。", updatedAt: "2026-10-10T00:00:00Z" };
const ok = <T,>(data: T) => ({ version: 1, ok: true, data, requestId: "self", correlationId: "self", schemaRevision: "desktop-ipc-v1" });
let items: CompanionSelfNoteV1[], agent: { listSelfNotes: ReturnType<typeof vi.fn>; getSelfNoteHistory: ReturnType<typeof vi.fn>;
  writeSelfNote: ReturnType<typeof vi.fn>; controlSelfNote: ReturnType<typeof vi.fn> };
beforeEach(() => {
  useRoomStore.setState({ workspaceScopeRevision: 1 }); items = [{ ...note }];
  agent = { listSelfNotes: vi.fn(async () => ok({ version: 1, items })), getSelfNoteHistory: vi.fn(async () => ok({ version: 1, items: [] })),
    writeSelfNote: vi.fn(async () => ok({ ...note, revision: 3 })),
    controlSelfNote: vi.fn(async () => { items = [{ ...note, revision: 3, userDisabled: true, tier: "archived" }]; return ok(items[0]); }) };
  Object.defineProperty(window, "astella", { configurable: true, value: { auth: { getState: vi.fn(async () => ok({ version: 1,
    status: "authenticated", workspace: { workspaceId: "22222222-2222-4222-8222-222222222222" }, workspaceEpoch: 1 })) }, agent } });
});
afterEach(cleanup);

it("reads autonomous Markdown with no approval action, and serializes post-hoc stopping", async () => {
  render(<CompanionSelfNotesPage refreshKey={0} />);
  fireEvent.click(await screen.findByRole("button", { name: /我在想的反例/ }));
  expect(screen.getByText("先找反证").tagName).toBe("STRONG");
  expect(screen.queryByRole("button", { name: /确认|批准|采用/ })).toBeNull();
  expect(agent.controlSelfNote).not.toHaveBeenCalled();
  const stop = screen.getByRole("button", { name: "停用这条记事" }); fireEvent.click(stop); fireEvent.click(stop);
  await screen.findByText("已停用，伴星不会自行恢复或继续重评这条记事。");
  expect(agent.controlSelfNote).toHaveBeenCalledTimes(1);
  expect(agent.controlSelfNote.mock.calls[0][0].request).toEqual({ key: note.key, expectedRevision: 2, action: "disable" });
  expect(screen.getByRole("button", { name: "恢复这条记事" })).toBeTruthy();
});

it("preserves a failed correction and submits the version that was actually read", async () => {
  agent.writeSelfNote.mockResolvedValue({ version: 1, ok: false, error: { code: "self_note_revision_conflict", safeMessageKey: "error.conflict", retry: "user_action" } });
  render(<CompanionSelfNotesPage refreshKey={0} />);
  fireEvent.click(await screen.findByRole("button", { name: /我在想的反例/ }));
  fireEvent.click(screen.getByRole("button", { name: "纠正内容" }));
  fireEvent.change(screen.getByLabelText("她留下的内容"), { target: { value: "# 我的纠正\n\n不要把这一件事当成事实。" } });
  fireEvent.click(screen.getByRole("button", { name: "保存纠正" }));
  await waitFor(() => expect(agent.writeSelfNote).toHaveBeenCalledTimes(1));
  expect(agent.writeSelfNote.mock.calls[0][0].request.expectedRevision).toBe(2);
  expect((screen.getByLabelText("她留下的内容") as HTMLTextAreaElement).value).toContain("# 我的纠正");
});

it("hides old-space notes immediately and ignores late requests after switching", async () => {
  render(<CompanionSelfNotesPage refreshKey={0} />); await screen.findByRole("button", { name: /我在想的反例/ });
  let finish!: (value: unknown) => void;
  agent.listSelfNotes.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  act(() => useRoomStore.setState({ workspaceScopeRevision: 2 }));
  expect(screen.queryByRole("button", { name: /我在想的反例/ })).toBeNull();
  await waitFor(() => expect(agent.listSelfNotes.mock.calls.length).toBeGreaterThan(1));
  agent.listSelfNotes.mockResolvedValue(ok({ version: 1, items: [] }));
  act(() => useRoomStore.setState({ workspaceScopeRevision: 3 })); await screen.findByText("她还没有留下自己的记事");
  await act(async () => finish(ok({ version: 1, items: [note] })));
  expect(screen.queryByRole("button", { name: /我在想的反例/ })).toBeNull();
});

it("does not display the previous note's history while the next one is loading", async () => {
  items = [note, { ...note, key: "other", title: "另一个问题" }];
  agent.getSelfNoteHistory.mockImplementation(async ({ key }) => key === note.key
    ? ok({ version: 1, items: [{ ...note, body: "仅属于第一篇的旧历史" }] }) : new Promise(() => {}));
  render(<CompanionSelfNotesPage refreshKey={0} />);
  fireEvent.click(await screen.findByRole("button", { name: /我在想的反例/ })); await screen.findByText("仅属于第一篇的旧历史");
  fireEvent.click(screen.getByRole("button", { name: /另一个问题/ }));
  expect(screen.queryByText("仅属于第一篇的旧历史")).toBeNull();
});
