// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useState } from "react";
import type { AgentRunV1 } from "@astella/shared/agent-contracts";
import { CompanionGoalBubble } from "../CompanionGoalBubble";
import { CompanionGoalJournal } from "../CompanionGoalJournal";
import type { AgentGoalsController } from "../use-agent-goals";
import { openAgentArtifact } from "../agent-goal-presentation";

vi.mock("../use-companion-floating-placement", () => ({ useCompanionFloatingPlacement: () => ({ side: "left" }) }));
const room = vi.hoisted(() => ({ workspaceScopeRevision: 1, setActiveNoteRef: vi.fn(), setActiveCardGenerationRunId: vi.fn(), invoke: vi.fn() }));
vi.mock("../../../app/room-store", () => ({ useRoomStore: Object.assign((select: (state: typeof room) => unknown) => select(room), { getState: () => room }) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const artifact = { kind: "note_overview" as const, id: "saved", jobId: "job", noteId: "note", noteVersionId: "version" };
const run: AgentRunV1 = { version: 1, runId: "run", revision: 2, identityId: "identity",
  goal: "把欧姆定律整理成速看，并做互动演示。", status: "waiting", conversationId: null, inputs: [], operations: [],
  artifacts: [{ ...artifact, id: "older" }, artifact], summary: "**速看已做好**\n\n- 已保留原文事实\n- 可以调整要求", error: null,
  modelCalls: 4, maxModelCalls: 16, createdAt: "2026-10-04T01:00:00Z", updatedAt: "2026-10-04T01:00:00Z" };
function controller(item = run): AgentGoalsController { return { items: [item], scope: 1, error: null, loading: false, pending: null,
  refresh: vi.fn(async () => {}), ensure: vi.fn(async()=>{}), change: vi.fn(async () => true), nextCursor: null,
  loadMore: vi.fn(async () => {}), moreLoading: false, moreError: null }; }
function bubble(goals = controller()) {
  return <CompanionGoalBubble anchorRef={{ current: null }} motionMode="off" blocked={false} open selectedId="run" goals={goals}
    onOpen={vi.fn()} onClose={vi.fn()} onSelect={vi.fn()} onDetails={vi.fn()} onChat={vi.fn()} />;
}
it("初次加载和读取失败不显示空任务邀请，已读取的成果在刷新期间保留", () => {
  const goals = controller();
  const view = render(bubble({ ...goals, items: [], loading: true }));
  expect(screen.getByRole("region", { name: "伴星手边的事" }).getAttribute("aria-busy")).toBe("true");
  expect(screen.queryByRole("button", { name: "说说要做什么" })).toBeNull();
  view.rerender(bubble({ ...goals, items: [], error: "网络连接中断" }));
  expect(screen.getByText("任务记录没有加载成功")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "说说要做什么" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "重新读取" }));
  expect(goals.refresh).toHaveBeenCalledOnce();
  view.rerender(bubble({ ...goals, loading: true }));
  expect(screen.getByRole("button", { name: "速看" })).toBeTruthy();
});
it("手记读取失败不被当成还没有任务", () => {
  render(<CompanionGoalJournal goals={{ ...controller(), items: [], error: "连接中断" }} targetId={null} onChat={vi.fn()} onArtifactOpen={vi.fn()} />);
  expect(screen.queryByText(/还没有交给我的任务/)).toBeNull();
  expect(screen.getByRole("alert").textContent).toContain("连接中断");
});
it("keeps detailed Markdown in the journal and exposes only the latest compatible result in the bubble", () => {
  const view = render(bubble());
  expect(screen.queryByText("速看已做好")).toBeNull();
  expect(screen.getAllByRole("button", { name: "速看" })).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "速看" }));
  expect(room.setActiveNoteRef).toHaveBeenCalledWith(expect.objectContaining({ learningResult: { kind: "note_overview", artifactId: "saved", taskId: "job", noteVersionId: "version" } }));
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
    learningView: "artifact", learningResult: { kind: "note_dynamic_artifact", artifactId: "saved", taskId: "job", noteVersionId: "version" },
  }));
  expect(room.invoke).toHaveBeenCalledWith("open-notebook");
});
it("opens expansion as the exact saved draft batch and labels it as a choice to review", () => {
  const goals = controller();
  const expansion = { ...artifact, kind: "note_expansion" as const, id: "job" };
  render(bubble({ ...goals, items: [{ ...run, status: "completed", artifacts: [expansion], operations: [{
    operationId: "operation", runId: run.runId, revision: run.revision, scope: { workspaceId: "workspace", userId: "user" },
    capability: "note_expansion_generate", execution: { kind: "job", id: "job" }, status: "succeeded", lastEventSeq: 1, result: { kind: "artifact", artifact: expansion }, error: null,
  }] }] }));
  fireEvent.click(screen.getByRole("button", { name: "拓展草稿" }));
  expect(room.setActiveNoteRef).toHaveBeenCalledWith(expect.objectContaining({ learningView: "expansion",
    learningResult: { kind: "note_expansion", artifactId: "job", taskId: "job", noteVersionId: "version" } }));
  expect(screen.getByText(/翻开后可以修改、挑选/)).toBeTruthy();
});
it("opens the exact card run for user review from both the light bubble and journal", () => {
  const cards = { kind: "card_candidates" as const, id: "card-run", noteId: "note", noteVersionId: "version" };
  const ready: AgentRunV1 = { ...run, status: "completed", artifacts: [cards], operations: [{
    operationId: "card-operation", runId: run.runId, revision: run.revision,
    scope: { workspaceId: "workspace", userId: "user" }, capability: "card_generation_generate",
    execution: { kind: "card_generation", id: cards.id }, status: "succeeded", lastEventSeq: 2,
    result: { kind: "artifact", artifact: cards }, error: null,
  }] };
  const view = render(bubble(controller(ready)));
  expect(screen.getByText(/你决定收下哪些，再保存到卡组/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "待审核学习卡" }));
  expect(room.setActiveNoteRef).toHaveBeenCalledWith({ noteId: "note", noteVersionId: "version" });
  expect(room.setActiveCardGenerationRunId).toHaveBeenCalledWith("card-run");
  expect(room.invoke).toHaveBeenCalledWith("open-card-generation");
  expect(room.setActiveCardGenerationRunId.mock.invocationCallOrder[0]).toBeLessThan(room.invoke.mock.invocationCallOrder[0]);
  view.unmount(); vi.clearAllMocks();
  const onArtifactOpen = vi.fn();
  render(<CompanionGoalJournal goals={controller(ready)} targetId="run" onChat={vi.fn()} onArtifactOpen={onArtifactOpen} />);
  fireEvent.click(screen.getByRole("button", { name: /待审核学习卡.*由你审核与保存/ }));
  expect(room.setActiveCardGenerationRunId).toHaveBeenCalledWith("card-run");
  expect(onArtifactOpen).toHaveBeenCalledOnce();
  vi.clearAllMocks();
  expect(openAgentArtifact(cards, 2)).toBe(false);
  expect(room.setActiveCardGenerationRunId).not.toHaveBeenCalled();
  expect(room.invoke).not.toHaveBeenCalled();
});
it("treats no card recommendation as an answer without inventing an artifact or an error", () => {
  const answer: AgentRunV1 = { ...run, status: "completed", artifacts: [], summary: "**这段更适合阅读理解**\n\n- 先理清概念，再决定是否练习。", operations: [{
    operationId: "card-operation", runId: run.runId, revision: run.revision,
    scope: { workspaceId: "workspace", userId: "user" }, capability: "card_generation_generate",
    execution: { kind: "card_generation", id: "card-run" }, status: "succeeded", lastEventSeq: 2,
    result: { kind: "no_cards_recommended", reasonCodes: ["insufficient_content"] }, error: null,
  }] };
  const view = render(bubble(controller(answer)));
  expect(screen.getByText(/这次没有推荐生成学习卡/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "待审核学习卡" })).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByText("这段更适合阅读理解")).toBeNull();
  view.unmount();
  render(<CompanionGoalJournal goals={controller(answer)} targetId="run" onChat={vi.fn()} onArtifactOpen={vi.fn()} />);
  expect(screen.getByText("这段更适合阅读理解").tagName).toBe("STRONG");
  expect(screen.getByText("这次不建议制卡")).toBeTruthy();
  expect(screen.queryByRole("region", { name: "做好的成果" })).toBeNull();
  expect(room.setActiveCardGenerationRunId).not.toHaveBeenCalled();
});
it("puts a later read-only answer ahead of retained artifacts without claiming a new generation", () => {
  const reading = { ...run, revision: 3, status: "completed" as const, goal: "核对上一批修改后的拓展草稿",
    artifacts: [{ ...artifact, kind: "note_expansion" as const, id: "earlier", jobId: "earlier-job" },
      { ...artifact, kind: "note_expansion" as const }], operations: [], summary: "**已核对修改后的正文**" };
  const view = render(bubble(controller(reading)));
  expect(screen.getByText("这次的答复留在手记里，之前的成果也保留着。")).toBeTruthy();
  expect(screen.queryByText(/拓展草稿已留好/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "拓展草稿" }));
  expect(room.setActiveNoteRef).toHaveBeenCalledWith(expect.objectContaining({ learningView: "expansion" }));
  view.unmount();
  render(<CompanionGoalJournal goals={controller(reading)} targetId="run" onChat={vi.fn()} onArtifactOpen={vi.fn()} />);
  const answer = screen.getByText("已核对修改后的正文"), retained = screen.getByRole("region", { name: "做好的成果" });
  expect(answer.compareDocumentPosition(retained) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /拓展草稿 · 第 1 批/ }));
  expect(room.setActiveNoteRef).toHaveBeenLastCalledWith(expect.objectContaining({
    learningResult: { kind: "note_expansion", artifactId: "earlier", taskId: "earlier-job", noteVersionId: "version" },
  }));
  fireEvent.click(screen.getByRole("button", { name: /拓展草稿 · 第 2 批/ }));
  expect(room.setActiveNoteRef).toHaveBeenLastCalledWith(expect.objectContaining({
    learningResult: { kind: "note_expansion", artifactId: "saved", taskId: "job", noteVersionId: "version" },
  }));
  fireEvent.click(screen.getByText("查看生成记录 · 0 项"));
  expect(screen.getByText("这次没有启动生成。")).toBeTruthy();
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
