// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CompanionSelfNoteV1 } from "@astella/shared";
import { useRoomStore } from "../../../app/home/room-store";
import { CompanionHerNotesPage } from "../companion/companion-her-notes-page";

const note: CompanionSelfNoteV1 = { key: "counterexample", revision: 2, title: "我在想的反例",
  body: "# 暂定看法\n\n**先找反证**，再决定是否保留。", tier: "resident", userDisabled: false,
  nextReviewAt: null, expiresAt: null, reason: "这是我的关注角度。", updatedAt: "2026-10-10T00:00:00Z" };
const judgment = { memoryItemId: "99999999-9999-4999-8999-999999999999", kind: "judgment" as const,
  content: "他说明天讲完这章，所以今晚大概只想把例题过一遍。", revision: 1, updatedAt: "2026-10-10T01:00:00Z",
  createdAt: "2026-10-10T01:00:00Z", scope: "workspace" as const, candidate: false, userConfirmed: false,
  userStated: false, archived: false, pinned: false, dismissedAt: null, validFrom: null, validUntil: null,
  sourceType: "model_inferred" as const, sourceSpeaker: "companion" as const, sourceBasis: null, sourceEventId: null,
  sourceSessionId: null, appliesWhen: null, authorType: "companion" as const, authorId: null,
  epistemicStatus: "tentative" as const, importance: 0.5, confidence: 0.5, budgetTier: "active" as const,
  embeddingStatus: "none" as const, conflictGroup: null };
const ok = <T,>(data: T) => ({ version: 1, ok: true, data, requestId: "self", correlationId: "self", schemaRevision: "desktop-ipc-v1" });
let items: CompanionSelfNoteV1[], memories: typeof judgment[], agent: { listSelfNotes: ReturnType<typeof vi.fn>; getSelfNoteHistory: ReturnType<typeof vi.fn>;
  writeSelfNote: ReturnType<typeof vi.fn>; controlSelfNote: ReturnType<typeof vi.fn> }, memory: Record<string, ReturnType<typeof vi.fn>>;
beforeEach(() => {
  useRoomStore.setState({ workspaceScopeRevision: 1 }); items = [{ ...note }]; memories = [{ ...judgment }];
  agent = { listSelfNotes: vi.fn(async () => ok({ version: 1, items })), getSelfNoteHistory: vi.fn(async () => ok({ version: 1, items: [] })),
    writeSelfNote: vi.fn(async () => ok({ ...note, revision: 3 })),
    controlSelfNote: vi.fn(async () => { items = [{ ...note, revision: 3, userDisabled: true, tier: "archived" }]; return ok(items[0]); }) };
  memory = { list: vi.fn(async () => ok({ version: 2, items: memories })), revisions: vi.fn(async () => ok({ version: 1, memoryItemId: judgment.memoryItemId, items: [] })),
    correct: vi.fn(async () => ok({ ...judgment, revision: 2 })), confirm: vi.fn(async () => ok({ ...judgment, userConfirmed: true })),
    archive: vi.fn(async () => ok({ ...judgment, archived: true })), restore: vi.fn(async () => ok({ ...judgment, archived: false })) };
  Object.defineProperty(window, "astella", { configurable: true, value: { auth: { getState: vi.fn(async () => ok({ version: 1,
    status: "authenticated", workspace: { workspaceId: "22222222-2222-4222-8222-222222222222" }, workspaceEpoch: 1 })) }, agent, companion: { memory } } });
});
afterEach(cleanup);
const publishedView = () => useRoomStore.getState().pageReadableView?.view ?? null;
const filterValue = (label: string) => publishedView()?.filters?.find(entry => entry.label === label)?.value;

it("reads autonomous Markdown with no approval action, and serializes post-hoc stopping", async () => {
  render(<CompanionHerNotesPage refreshKey={0} />);
  fireEvent.click(await screen.findByRole("button", { name: /我在想的反例/ }));
  expect(screen.getByText("先找反证").tagName).toBe("STRONG");
  expect(screen.queryByRole("button", { name: /批准/ })).toBeNull();
  expect(agent.controlSelfNote).not.toHaveBeenCalled();
  const stop = screen.getByRole("button", { name: "停用这条记事" }); fireEvent.click(stop); fireEvent.click(stop);
  await screen.findByText("已停用，伴星不会自行恢复或继续重评这条记事。");
  expect(agent.controlSelfNote).toHaveBeenCalledTimes(1);
  expect(agent.controlSelfNote.mock.calls[0][0].request).toEqual({ key: note.key, expectedRevision: 2, action: "disable" });
  expect(screen.getByRole("button", { name: "恢复这条记事" })).toBeTruthy();
});

it("puts her notes and her readings of a moment in one directory, each kept apart by heading", async () => {
  render(<CompanionHerNotesPage refreshKey={0} />);
  expect(await screen.findByRole("heading", { name: "她写下的记事" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "她的看法" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /他说明天讲完这章/ }));
  // 看法是一条记忆，不是一篇记事：纠正走记忆的修订，停用是「暂时不这样看」。
  expect(screen.getByRole("button", { name: "暂时不这样看" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "纠正内容" }));
  fireEvent.change(screen.getByLabelText("她现在的看法"), { target: { value: "他说明天讲完这章，今晚只过例题。" } });
  fireEvent.click(screen.getByRole("button", { name: "保存纠正" }));
  await waitFor(() => expect(memory.correct).toHaveBeenCalledOnce());
  expect(memory.correct.mock.calls[0][0]).toMatchObject({ memoryId: judgment.memoryItemId,
    request: { content: "他说明天讲完这章，今晚只过例题。", expectedRevision: 1 } });
});

it("filters the two kinds apart, and registers the kind she is actually being shown", async () => {
  render(<CompanionHerNotesPage refreshKey={0} />);
  await screen.findByRole("button", { name: /他说明天讲完这章/ });
  fireEvent.click(screen.getByRole("button", { name: "筛选她的记事的类型" }));
  fireEvent.click(screen.getByRole("option", { name: "只看她写下的记事" }));
  expect(screen.queryByRole("button", { name: /他说明天讲完这章/ })).toBeNull();
  expect(screen.getByRole("heading", { name: "她写下的记事" })).toBeTruthy();
  await waitFor(() => expect(filterValue("类型")).toBe("只看她写下的记事"));
  expect(publishedView()?.items?.every(row => String(row.state).startsWith("她的记事"))).toBe(true);
});

it("preserves a failed correction and submits the version that was actually read", async () => {
  agent.writeSelfNote.mockResolvedValue({ version: 1, ok: false, error: { code: "self_note_revision_conflict", safeMessageKey: "error.conflict", retry: "user_action" } });
  render(<CompanionHerNotesPage refreshKey={0} />);
  fireEvent.click(await screen.findByRole("button", { name: /我在想的反例/ }));
  fireEvent.click(screen.getByRole("button", { name: "纠正内容" }));
  fireEvent.change(screen.getByLabelText("她留下的内容"), { target: { value: "# 我的纠正\n\n不要把这一件事当成事实。" } });
  fireEvent.click(screen.getByRole("button", { name: "保存纠正" }));
  await waitFor(() => expect(agent.writeSelfNote).toHaveBeenCalledTimes(1));
  expect(agent.writeSelfNote.mock.calls[0][0].request.expectedRevision).toBe(2);
  expect((screen.getByLabelText("她留下的内容") as HTMLTextAreaElement).value).toContain("# 我的纠正");
});

it("hides old-space notes immediately and ignores late requests after switching", async () => {
  render(<CompanionHerNotesPage refreshKey={0} />); await screen.findByRole("button", { name: /我在想的反例/ });
  let finish!: (value: unknown) => void;
  agent.listSelfNotes.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  act(() => useRoomStore.setState({ workspaceScopeRevision: 2 }));
  expect(screen.queryByRole("button", { name: /我在想的反例/ })).toBeNull();
  await waitFor(() => expect(agent.listSelfNotes.mock.calls.length).toBeGreaterThan(1));
  agent.listSelfNotes.mockResolvedValue(ok({ version: 1, items: [] }));
  memory.list.mockResolvedValue(ok({ version: 2, items: [] }));
  act(() => useRoomStore.setState({ workspaceScopeRevision: 3 })); await screen.findByText("她还没有留下自己的记事");
  await act(async () => finish(ok({ version: 1, items: [note] })));
  expect(screen.queryByRole("button", { name: /我在想的反例/ })).toBeNull();
});

it("does not display the previous note's history while the next one is loading", async () => {
  items = [note, { ...note, key: "other", title: "另一个问题" }];
  agent.getSelfNoteHistory.mockImplementation(async ({ key }) => key === note.key
    ? ok({ version: 1, items: [{ ...note, body: "仅属于第一篇的旧历史" }] }) : new Promise(() => {}));
  render(<CompanionHerNotesPage refreshKey={0} />);
  fireEvent.click(await screen.findByRole("button", { name: /我在想的反例/ })); await screen.findByText("仅属于第一篇的旧历史");
  fireEvent.click(screen.getByRole("button", { name: /另一个问题/ }));
  expect(screen.queryByText("仅属于第一篇的旧历史")).toBeNull();
});
