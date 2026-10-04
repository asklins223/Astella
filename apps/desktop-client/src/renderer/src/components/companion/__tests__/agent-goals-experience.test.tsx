// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useState } from "react";
import type { AgentRunV1 } from "@ailearn/shared/agent-contracts";
import { CompanionGoalBubble } from "../CompanionGoalBubble";
import { CompanionGoalJournal } from "../CompanionGoalJournal";
import type { AgentGoalsController } from "../use-agent-goals";
import { openAgentArtifact } from "../agent-goal-presentation";

vi.mock("../use-companion-floating-placement", () => ({ useCompanionFloatingPlacement: () => ({ side: "left" }) }));
const room = vi.hoisted(() => ({ workspaceScopeRevision: 1, setActiveNoteRef: vi.fn(), invoke: vi.fn() }));
vi.mock("../../../app/room-store", () => ({ useRoomStore: { getState: () => room } }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const artifact = { kind: "note_overview" as const, id: "saved", jobId: "job", noteId: "note", noteVersionId: "version" };
const run: AgentRunV1 = { version: 1, runId: "run", revision: 2, identityId: "identity",
  goal: "把欧姆定律整理成速看，并做互动演示。", status: "waiting", conversationId: null, inputs: [], operations: [],
  artifacts: [{ ...artifact, id: "older" }, artifact], summary: "**速看已做好**\n\n- 已保留原文事实\n- 可以调整要求", error: null,
  modelCalls: 4, maxModelCalls: 16, createdAt: "2026-10-04T01:00:00Z", updatedAt: "2026-10-04T01:00:00Z" };
function controller(item = run): AgentGoalsController { return { items: [item], scope: 1, error: null, loading: false, pending: null,
  refresh: vi.fn(async () => {}), change: vi.fn(async () => true) }; }
function bubble(goals = controller()) {
  return <CompanionGoalBubble anchorRef={{ current: null }} motionMode="off" blocked={false} open selectedId="run" goals={goals}
    onOpen={vi.fn()} onClose={vi.fn()} onSelect={vi.fn()} onDetails={vi.fn()} onChat={vi.fn()} />;
}
it("keeps detailed Markdown in the journal and exposes only the latest compatible result in the bubble", () => {
  const view = render(bubble());
  expect(screen.queryByText("速看已做好")).toBeNull();
  expect(screen.getAllByRole("button", { name: "速看" })).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "速看" }));
  expect(room.setActiveNoteRef).toHaveBeenCalledWith(expect.objectContaining({ learningResult: { kind: "note_overview", artifactId: "saved", taskId: "job" } }));
  view.unmount();
  render(<CompanionGoalJournal goals={controller()} targetId="run" onChat={vi.fn()} onArtifactOpen={vi.fn()} />);
  expect(screen.getByText("速看已做好").tagName).toBe("STRONG");
  expect(screen.getByText("已保留原文事实").tagName).toBe("LI");
});
it("edits from the light bubble, preserves a rejected draft, and submits the visible revision", async () => {
  const goals = controller(); vi.mocked(goals.change).mockResolvedValue(false);
  render(bubble(goals));
  fireEvent.click(screen.getByRole("button", { name: "调整" }));
  fireEvent.click(screen.getByRole("button", { name: "修改要求" }));
  const field = screen.getByRole("textbox", { name: "这次想怎样调整" });
  fireEvent.change(field, { target: { value: "只做互动演示，解释短一点" } });
  fireEvent.click(screen.getByRole("button", { name: "按新要求继续" }));
  await waitFor(() => expect(goals.change).toHaveBeenCalledWith(run, { goal: "只做互动演示，解释短一点" }));
  expect((field as HTMLTextAreaElement).value).toBe("只做互动演示，解释短一点");
});
it("keeps an unsent draft when a conflicting revision is refreshed, and retries against the new receipt", async () => {
  const goals = controller(); vi.mocked(goals.change).mockResolvedValue(false);
  const view = render(bubble(goals));
  fireEvent.click(screen.getByRole("button", { name: "调整" }));
  fireEvent.click(screen.getByRole("button", { name: "修改要求" }));
  fireEvent.change(screen.getByRole("textbox", { name: "这次想怎样调整" }), { target: { value: "保留我的修改草稿" } });
  fireEvent.click(screen.getByRole("button", { name: "按新要求继续" }));
  await waitFor(() => expect(goals.change).toHaveBeenCalledOnce());
  const updated = { ...run, revision: 3, goal: "另一个窗口已修改的要求" };
  view.rerender(bubble({ ...goals, items: [updated] }));
  expect((screen.getByRole("textbox", { name: "这次想怎样调整" }) as HTMLTextAreaElement).value).toBe("保留我的修改草稿");
  expect(screen.getByText("这件事刚刚有了新要求，你的草稿仍在。核对后可以再次提交。")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "按新要求继续" }));
  await waitFor(() => expect(goals.change).toHaveBeenLastCalledWith(updated, { goal: "保留我的修改草稿" }));
});
it("keeps pause and stop available in the bubble and disables duplicate mutations while awaiting receipt", () => {
  const goals = controller(); const view = render(bubble(goals));
  fireEvent.click(screen.getByRole("button", { name: "调整" }));
  fireEvent.click(screen.getByRole("button", { name: "暂停" }));
  expect(goals.change).toHaveBeenCalledWith(run, "pause");
  view.rerender(bubble({ ...goals, pending: "run" }));
  expect((screen.getByRole("button", { name: "停止这件事" }) as HTMLButtonElement).disabled).toBe(true);
});
it("does not open a saved artifact after its workspace has changed", () => {
  render(bubble({ ...controller(), scope: 2 }));
  fireEvent.click(screen.getByRole("button", { name: "速看" }));
  expect(room.setActiveNoteRef).not.toHaveBeenCalled(); expect(room.invoke).not.toHaveBeenCalled();
});
it("takes an interactive result directly to its saved artifact page", () => {
  openAgentArtifact({ ...artifact, kind: "note_dynamic_artifact" }, 1);
  expect(room.setActiveNoteRef).toHaveBeenCalledWith(expect.objectContaining({
    learningView: "artifact", learningResult: { kind: "note_dynamic_artifact", artifactId: "saved", taskId: "job" },
  }));
  expect(room.invoke).toHaveBeenCalledWith("open-notebook");
});
it("keeps additional notes' results reachable through progressive disclosure in the bubble", () => {
  const inputs = [1, 2, 3, 4].map(index => ({ kind: "note_version" as const, noteId: `note-${index}`, noteVersionId: `version-${index}` }));
  const many = { ...run, inputs, artifacts: inputs.map(({ noteId, noteVersionId }, index) => ({ ...artifact, noteId, noteVersionId, id: `saved-${index}` })) };
  render(bubble(controller(many)));
  expect(screen.queryByRole("button", { name: "笔记 4 的速看" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "其余 1 份成果" }));
  fireEvent.click(screen.getByRole("button", { name: "笔记 4 的速看" }));
  expect(room.setActiveNoteRef).toHaveBeenCalledWith(expect.objectContaining({ noteId: "note-4", learningResult: expect.objectContaining({ artifactId: "saved-3" }) }));
});
it("keeps the opened task visible when it finishes and another task is still running", () => {
  function View({ items }: { items: AgentRunV1[] }) {
    const [selectedId, onSelect] = useState<string | null>(null);
    return <CompanionGoalBubble anchorRef={{ current: null }} motionMode="off" blocked={false} open selectedId={selectedId}
      goals={{ ...controller(), items }} onOpen={vi.fn()} onClose={vi.fn()} onSelect={onSelect} onDetails={vi.fn()} onChat={vi.fn()} />;
  }
  const other = { ...run, runId: "other", goal: "另一个仍在处理的目标" };
  const view = render(<View items={[run, other]} />);
  view.rerender(<View items={[{ ...run, status: "completed" }, other]} />);
  expect(screen.getByRole("heading", { name: "交给我的事做好了" })).toBeTruthy();
  expect(screen.queryByText("另一个仍在处理的目标")).toBeNull();
});
it("owns Escape after an action releases focus, folds controls first, and leaves the room in place", () => {
  const onClose = vi.fn(), roomEscape = vi.fn();
  window.addEventListener("keydown", roomEscape);
  try {
    render(<CompanionGoalBubble anchorRef={{ current: null }} motionMode="off" blocked={false} open selectedId="run" goals={controller()}
      onOpen={vi.fn()} onClose={onClose} onSelect={vi.fn()} onDetails={vi.fn()} onChat={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "调整" }));
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByRole("button", { name: "暂停" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "调整" }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "查看伴星手边的事" }));
    expect(roomEscape).not.toHaveBeenCalled();
  } finally { window.removeEventListener("keydown", roomEscape); }
});
