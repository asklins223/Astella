// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentRunHistoryV1, AgentRunV1 } from "@astella/shared/agent-contracts";
import { CompanionGoalRevisions } from "../goals/CompanionGoalRevisions";
import { useCompanionResultPreview } from "../journal/companion-result-preview";

const room = vi.hoisted(() => ({ workspaceScopeRevision: 1, setActiveNoteRef: vi.fn(), setActiveCardGenerationRunId: vi.fn(), invoke: vi.fn() }));
vi.mock("../../../app/home/room-store", () => ({ useRoomStore: { getState: () => room, subscribe: () => () => {} } }));
vi.mock("../../../app/client/desktop-client", () => ({ createRequestMeta: () => ({}),
  unwrapGatewayResult: (value: unknown) => value, gatewayErrorMessage: (error: Error) => error.message }));
const getRunHistory = vi.fn();
const run: AgentRunV1 = { version: 1, runId: "goal", identityId: "identity", revision: 3, status: "completed",
  goal: "现在只做拓展", conversationId: null, inputs: [], operations: [], artifacts: [], summary: null, error: null,
  modelCalls: 3, maxModelCalls: 16, createdAt: "2026-10-04T01:00:00Z", updatedAt: "2026-10-04T01:00:00Z" };
const page = (revision: number, nextBeforeRevision: number | null): AgentRunHistoryV1 => ({ version: 1, runId: "goal", currentRevision: 3,
  items: [{ version: 1, runId: "goal", revision, goal: `之前第 ${revision} 次要求`, status: "completed", conversationId: null,
    inputs: [], operations: [], artifacts: [{ kind: "note_expansion", id: `saved-${revision}`, jobId: `saved-${revision}`,
      noteId: "note", noteVersionId: `original-${revision}` }], summary: "**草稿已保存**\n\n- 保留原版本引用", error: null,
    modelCalls: 2, maxModelCalls: 16, startedAt: null, lastActiveAt: "2026-10-04T01:00:00Z",
    recordedAt: "2026-10-04T02:00:00Z", supersededByRevision: revision + 1 }], nextBeforeRevision, unrecordedRevisions: [] });
beforeEach(() => {
  room.workspaceScopeRevision = 1; vi.clearAllMocks();
  useCompanionResultPreview.setState({ target: null, disclosures: new Map(), goalHistory: new Map() });
  Object.defineProperty(window, "astella", { configurable: true, value: { agent: { getRunHistory } } });
});
afterEach(cleanup);
it("opens the archive on request, retries a page, and previews the exact saved revision without leaving the journal", async () => {
  getRunHistory.mockResolvedValueOnce(page(2, 1)).mockRejectedValueOnce(new Error("连接中断")).mockResolvedValueOnce(page(1, null));
  const onArtifactOpen = vi.fn();
  render(<CompanionGoalRevisions run={run} scope={1} onArtifactOpen={onArtifactOpen} />);
  expect(getRunHistory).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("之前的要求与交付"));
  await screen.findByText("第 2 次要求");
  expect(screen.getByText("草稿已保存").tagName).toBe("STRONG");
  expect(screen.getByText("保留原版本引用").tagName).toBe("LI");
  fireEvent.click(screen.getByRole("button", { name: "再翻一些更早的要求" }));
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "重新读取" }));
  await screen.findByText("第 1 次要求");
  expect(getRunHistory).toHaveBeenLastCalledWith(expect.objectContaining({ runId: "goal", query: { beforeRevision: 1 } }));
  expect(screen.getByText("第 2 次要求")).toBeTruthy();
  fireEvent.click(screen.getByText("第 2 次要求"));
  fireEvent.click(within(screen.getByText("第 2 次要求").closest("details")!).getByRole("button", { name: "拓展草稿" }));
  expect(useCompanionResultPreview.getState().target).toEqual(expect.objectContaining({ noteId: "note", noteVersionId: "original-2", goalRunId: "goal",
    artifact: expect.objectContaining({ id: "saved-2", kind: "note_expansion" }) }));
  expect(room.setActiveNoteRef).not.toHaveBeenCalled();
  expect(onArtifactOpen).not.toHaveBeenCalled();
});
it("ignores an old response when the visible run or space changes", async () => {
  let resolve!: (value: AgentRunHistoryV1) => void;
  getRunHistory.mockReturnValueOnce(new Promise<AgentRunHistoryV1>(yes => { resolve = yes; }));
  const view = render(<CompanionGoalRevisions run={run} scope={1} onArtifactOpen={vi.fn()} />);
  fireEvent.click(screen.getByText("之前的要求与交付"));
  await waitFor(() => expect(getRunHistory).toHaveBeenCalledOnce());
  room.workspaceScopeRevision = 2;
  getRunHistory.mockResolvedValueOnce({ ...page(1, null), runId: "new-goal", items: [], unrecordedRevisions: [1] });
  view.rerender(<CompanionGoalRevisions run={{ ...run, runId: "new-goal" }} scope={2} onArtifactOpen={vi.fn()} />);
  fireEvent.click(screen.getByText("之前的要求与交付"));
  await screen.findByText(/没有保存完整记录/);
  await act(async () => { resolve(page(2, null)); });
  expect(screen.queryByText("第 2 次要求")).toBeNull();
  expect(screen.getByText(/没有保存完整记录/)).toBeTruthy();
});


it("returning from a result keeps expanded archive pages and the user's disclosure choice", async () => {
  getRunHistory.mockResolvedValueOnce(page(2, 1)).mockResolvedValueOnce(page(1, null));
  const view = render(<CompanionGoalRevisions run={run} scope={1} onArtifactOpen={vi.fn()} />);
  fireEvent.click(screen.getByText("之前的要求与交付"));
  await screen.findByText("第 2 次要求");
  fireEvent.click(screen.getByRole("button", { name: "再翻一些更早的要求" }));
  await screen.findByText("第 1 次要求");
  fireEvent.click(screen.getByText("第 2 次要求"));
  fireEvent.click(screen.getByText("第 2 次要求"));
  expect(screen.getByText("第 2 次要求").closest("details")!.open).toBe(false);
  view.unmount();
  render(<CompanionGoalRevisions run={run} scope={1} onArtifactOpen={vi.fn()} />);
  expect(screen.getByText("第 1 次要求")).toBeTruthy();
  expect(screen.getByText("第 2 次要求").closest("details")!.open).toBe(false);
  expect(getRunHistory).toHaveBeenCalledTimes(2);
});
