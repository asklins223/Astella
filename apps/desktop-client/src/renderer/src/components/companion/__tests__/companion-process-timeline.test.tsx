// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompanionMessageV1 } from "@astella/shared/companion-conversation-contracts";
import { buildCompanionRunTraces, mergeCompanionRunTraces, recordCompanionRunEvent, type CompanionRunTrace } from "../../../app/companion-session/companion-agent-nodes";
import { companionProcessRows } from "../../../app/companion-session/companion-process-timeline";
import { CompanionJournalTimeline } from "../journal/CompanionJournalTimeline";
import { interactionSession } from "./companion-interaction-fixtures";

vi.mock("../voice/CompanionMessageAudioButton", () => ({ CompanionMessageAudioButton: () => null }));
afterEach(cleanup);
const runId = "11111111-1111-4111-8111-111111111111";
const messageId = "22222222-2222-4222-8222-222222222222";
const event = (seq: number, eventType: string, payload: unknown) => ({ runId, generation: 1, seq, eventType, payload });
const tool = (status: string) => ({ tool: { toolCallId: "read", name: "companion_open_card", status, safeLabel: "打开笔记", safeSummary: "已读到笔记正文" } });
const processEvents = [event(1, "assistant.thinking", { index: 0, text: "先读原文。" }), event(2, "agent.tool", tool("requested")),
  event(3, "agent.tool", tool("succeeded")), event(4, "assistant.thinking", { index: 1, text: "再核对这个例子。" })];
const trace = () => processEvents.reduce<readonly CompanionRunTrace[]>((traces, item) => recordCompanionRunEvent(traces, item), [])[0]!;
const message = (): CompanionMessageV1 => ({ version: 1, id: messageId, workspaceId: runId, conversationId: runId,
  seq: 2, role: "assistant", kind: "text", blocks: [{ type: "text", text: "这是最终正文。" }], runId,
  clientMessageId: null, contentSha256: "0".repeat(64), createdAt: "2026-10-13T10:00:00Z", editedAt: null });

describe("手记的思考与操作时间线", () => {
  it("思考与工具按发生顺序交织，同一个工具状态更新不新增操作", () => {
    const value = trace();
    expect(companionProcessRows(value).map(row => row.kind)).toEqual(["thinking", "node", "thinking"]);
    expect(value.summary.toolCallCount).toBe(1);
    expect(value.summary.thinkingText).toBe("先读原文。再核对这个例子。");
    expect(value.nodes[0]?.state).toBe("succeeded");
    expect(recordCompanionRunEvent([value], processEvents[3]!)[0]?.events).toHaveLength(4);
  });

  it("实时传输事件已清理，仍从持久档案恢复全部思考和工具", () => {
    const value = trace();
    const restored = buildCompanionRunTraces([{ ...value.summary, processTimeline: [...value.events!] }], []);
    expect(companionProcessRows(restored[0]!)).toEqual(companionProcessRows(value));
    expect(restored[0]?.nodes).toHaveLength(1);
  });

  it("较旧快照不会撤销终态、清空过程，或丢掉此前的历史轮次", () => {
    const settled = recordCompanionRunEvent([trace()], event(5, "assistant.final", { messageId }));
    const stale = { summary: { ...trace().summary, thinkingText: undefined }, nodes: [], events: [] };
    const merged = mergeCompanionRunTraces(settled, [stale]);
    expect(merged[0]?.summary.status).toBe("succeeded");
    expect(merged[0]?.summary.assistantMessageId).toBe(messageId);
    expect(companionProcessRows(merged[0]!)).toHaveLength(3);
    expect(mergeCompanionRunTraces(merged, [])).toHaveLength(1);
  });

  it("默认折叠并放在正文前；展开后从流式到完成保留同一个面板", async () => {
    const current = trace();
    const view = render(<CompanionJournalTimeline chat={interactionSession({ phase: "sending", processRunId: runId,
      draft: { runId, text: "正文正在生成。" }, runTraces: [current] })} draftText="正文正在生成。" />);
    const panel = view.container.querySelector<HTMLDetailsElement>(".companion-history__trace")!;
    expect(panel.open).toBe(false);
    expect(view.container.querySelector("header")!.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(panel.compareDocumentPosition(view.container.querySelector(".companion-record__body")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(panel.querySelector("summary")!);
    await waitFor(() => expect(panel.open).toBe(true));
    const thought = panel.querySelector<HTMLDetailsElement>(".companion-history__trace-thinking")!;
    expect(thought.open).toBe(false);
    fireEvent.click(thought.querySelector("summary")!);
    expect(thought.open).toBe(true);
    fireEvent.click(thought.querySelector("summary")!);
    expect(thought.open).toBe(false);
    expect(panel.open).toBe(true);
    const operation = panel.querySelector<HTMLDetailsElement>(".companion-history__trace-tool")!;
    expect(operation.open).toBe(false);
    fireEvent.click(operation.querySelector("summary")!);
    expect(operation.open).toBe(true);
    fireEvent.click(operation.querySelector("summary")!);
    expect(operation.open).toBe(false);
    expect(panel.querySelectorAll(".companion-history__trace-step .lucide-chevron-right")).toHaveLength(0);
    fireEvent.click(panel.querySelector("summary")!);
    expect(panel.open).toBe(false);
    fireEvent.click(panel.querySelector("summary")!);
    expect(panel.open).toBe(true);
    const settled = recordCompanionRunEvent([current], event(5, "assistant.final", { messageId }));
    view.rerender(<CompanionJournalTimeline chat={interactionSession({ phase: "ready", processRunId: runId,
      messages: [message()], runTraces: settled })} draftText="" />);
    expect(view.container.querySelector(".companion-history__trace")).toBe(panel);
    expect(panel.open).toBe(true);
    expect(panel.textContent).toContain("先读原文。");
    expect(panel.textContent).toContain("再核对这个例子。");
    expect(view.container.querySelector(".companion-record__body")?.textContent).toBe("这是最终正文。");
    view.unmount();
    const history = render(<CompanionJournalTimeline chat={interactionSession({ messages: [message()], runTraces: settled })} draftText="" />);
    expect(history.container.querySelector<HTMLDetailsElement>("details")?.open).toBe(false);
  });

  it("已经存下的分句在实时聚合正文中只展示一次，收尾后共用一个过程面板", () => {
    const value = trace();
    const first = { ...message(), id: "33333333-3333-4333-8333-333333333333", blocks: [{ type: "text" as const, text: "第一句。" }] };
    const view = render(<CompanionJournalTimeline chat={interactionSession({ phase: "sending", processRunId: runId,
      messages: [first], runTraces: [value], draft: { runId, text: "第一句。第二句。" } })} draftText="第一句。第二句。" />);
    expect(view.container.querySelectorAll(".companion-record__body")).toHaveLength(1);
    view.rerender(<CompanionJournalTimeline chat={interactionSession({ messages: [first, message()], runTraces: [value] })} draftText="" />);
    expect(view.container.querySelectorAll(".companion-history__trace")).toHaveLength(1);
  });
});
