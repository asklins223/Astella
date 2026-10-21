// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompanionMessageV1 } from "@astella/shared/companion-conversation-contracts";
import { buildCompanionRunTraces, mergeCompanionRunTraces, recordCompanionRunEvent, type CompanionRunTrace } from "../../../app/companion-session/companion-agent-nodes";
import { companionProcessRows } from "../../../app/companion-session/companion-process-timeline";
import { CompanionJournalTimeline } from "../journal/CompanionJournalTimeline";
import { CompanionRunTraceView } from "../journal/CompanionRunTraceView";
import { CompanionJournalViewState } from "../journal/companion-journal-view-state";
import { useCompanionResultPreview } from "../journal/companion-result-preview";
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
  it("结束状态优先于最后一条工具进度，旧档案中的发言纠正指令不再展示给用户", () => {
    const internal = "这轮已经开始连续回复，请接着把当前回复完成。需要分几句交流时，从第一句使用发言能力，避免正文和发言重复。";
    const current = recordCompanionRunEvent([], event(1, "agent.tool", { tool: {
      toolCallId: "speech", name: "companion_publish_utterance", status: "not_executed", safeLabel: "正在接着说", safeSummary: internal,
    } }))[0]!;
    const completed: CompanionRunTrace = { ...current, summary: { ...current.summary, status: "succeeded" } };
    const view = render(<CompanionRunTraceView trace={completed} />);
    const panel = view.container.querySelector<HTMLDetailsElement>(".companion-history__trace")!;
    expect(panel.querySelector("summary")!.textContent).toContain("已结束 · 1 项操作未执行");
    expect(panel.querySelector("summary")!.textContent).not.toContain("正在接着说");
    expect(view.container.textContent).not.toContain(internal);
    fireEvent.click(panel.querySelector("summary")!);
    const operation = view.container.querySelector<HTMLDetailsElement>(".companion-history__trace-tool")!;
    fireEvent.click(operation.querySelector("summary")!);
    expect(operation.textContent).toContain("分次发言");
    expect(operation.textContent).toContain("这次分条发送没有执行。");
    expect(operation.textContent).not.toContain(internal);
  });
  it("有成功步骤的收尾轮在过程摘要里仍说「已完成」，未完成的步骤只进计数", () => {
    useCompanionResultPreview.setState({ disclosures: new Map() });
    const settled: CompanionRunTrace = {
      summary: { version: 1, runId, status: "succeeded", generation: 1, stepCount: 2, toolCallCount: 2,
        maxSteps: 4, maxToolCalls: 12, assistantMessageId: messageId, nodeCount: 2 },
      nodes: [
        { key: "tool:search", kind: "tool", label: "正在翻你的笔记", state: "succeeded", toolName: "companion_search_notes", summary: "找到 3 篇", proposalId: null },
        { key: "tool:write", kind: "tool", label: "正在写成笔记", state: "failed", toolName: "companion_create_note", summary: "保存失败：网络暂时不可用", proposalId: null },
      ],
    };
    const view = render(<CompanionRunTraceView trace={settled} />);
    const summary = view.container.querySelector(".companion-history__trace > summary")!;
    expect(summary.textContent).toContain("已完成 · 1 项操作未成功");
    expect(summary.textContent).not.toContain("已结束");
  });
  it("一步都没有成功的收尾轮不声称已完成", () => {
    useCompanionResultPreview.setState({ disclosures: new Map() });
    const settled: CompanionRunTrace = {
      summary: { version: 1, runId, status: "succeeded", generation: 1, stepCount: 1, toolCallCount: 1,
        maxSteps: 4, maxToolCalls: 12, assistantMessageId: messageId, nodeCount: 1 },
      nodes: [
        { key: "tool:write", kind: "tool", label: "正在写成笔记", state: "not_executed", toolName: "companion_create_note", summary: "关联的笔记尚未读取。", proposalId: null },
      ],
    };
    const view = render(<CompanionRunTraceView trace={settled} />);
    expect(view.container.querySelector(".companion-history__trace > summary")!.textContent).toContain("已结束 · 1 项操作未执行");
  });
  it("等待正文时直接展示真实宿主进度，后续思考不会把它藏进过程折叠中", () => {
    let traces = recordCompanionRunEvent([], event(1, "assistant.status", { status: "thinking", safeLabel: "已读到指定笔记，正在整理回答。" }));
    traces = recordCompanionRunEvent(traces, event(2, "assistant.thinking", { index: 0, text: "核对概念之间的关系。" }));
    const view = render(<CompanionJournalTimeline chat={interactionSession({ phase: "sending", processRunId: runId, runTraces: traces })} draftText="" />);
    expect(view.container.querySelector("header time")?.textContent).toBe("已读到指定笔记，正在整理回答。");
    expect(view.container.querySelector("header time")?.textContent).not.toContain("核对概念之间的关系");
  });
  it("恢复成功后只移除旧的空失败占位，保留真实部分回答", () => {
    const current = trace();
    const completed: CompanionRunTrace = { ...current, summary: { ...current.summary, status: "succeeded", assistantMessageId: messageId } };
    const old: CompanionMessageV1 = { ...message(), id: "33333333-3333-4333-8333-333333333333", seq: 1, kind: "error", blocks: [{ type: "text", text: "这条回复暂时没能完成。" }] };
    const view = render(<CompanionJournalTimeline chat={interactionSession({ messages: [old, message()], runTraces: [completed] })} draftText="" />);
    expect(view.queryByText("这条回复暂时没能完成。")).toBeNull();
    expect(view.getByText("这是最终正文。")).toBeTruthy();
    view.rerender(<CompanionJournalTimeline chat={interactionSession({ messages: [{ ...old, blocks: [{ type: "text", text: "中断前实际生成的部分回答仍然保留。" }] }, message()], runTraces: [completed] })} draftText="" />);
    expect(view.getByText("中断前实际生成的部分回答仍然保留。")).toBeTruthy();
  });
  it("一段运行的多条发言只留一个名字，每条正文各在一个气泡里", () => {
    const first: CompanionMessageV1 = { ...message(), id: "44444444-4444-4444-8444-444444444444", seq: 2,
      blocks: [{ type: "text", text: "第一句。" }] };
    const second: CompanionMessageV1 = { ...message(), id: "55555555-5555-4555-8555-555555555555", seq: 3,
      blocks: [{ type: "text", text: "第二句。" }] };
    const view = render(<CompanionJournalTimeline chat={interactionSession({ messages: [first, second] })} draftText="" />);
    // 过程标题是这一组唯一的名字；两条正文都不再各自带头像和名字。
    expect(view.container.querySelectorAll(".companion-record__author strong")).toHaveLength(1);
    const bubbles = [...view.container.querySelectorAll<HTMLElement>("[data-bubble='true']")];
    expect(bubbles).toHaveLength(2);
    expect(bubbles[0]?.querySelector(".companion-record__body--bubble")?.textContent).toBe("第一句。");
    expect(bubbles[1]?.querySelector(".companion-record__body--bubble")?.textContent).toBe("第二句。");
    // 朗读/复制/材料只挂在最后一发言下，中间那条不插动作行。
    expect(view.container.querySelectorAll(".companion-record__actions")).toHaveLength(1);
  });
  it("首输出超时的原因和继续入口在过程折叠时仍能直接读取", async () => {
    useCompanionResultPreview.setState({ disclosures: new Map() });
    const initial = trace(); const failed: CompanionRunTrace = { ...initial, summary: { ...initial.summary, status: "failed", errorCode: "PROVIDER_FIRST_OUTPUT_TIMEOUT" } };
    const recover = vi.fn(async () => "已经从中断处接续");
    const view = render(<CompanionRunTraceView trace={failed} live={false} onRecoverRun={recover} />);
    expect(view.container.querySelector("details")!.open).toBe(false);
    expect(view.getByText(/模型服务未能及时返回首段内容/)).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "从中断处继续" }));
    await waitFor(() => expect(recover).toHaveBeenCalledWith(runId, false));
    expect(await view.findByText("已经从中断处接续")).toBeTruthy();
  });
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

  it("过程默认可读，思考默认折叠、可自由展开，答复在过程之后；手动选择从流式到完成保持", async () => {
    const current = trace();
    const view = render(<CompanionJournalTimeline chat={interactionSession({ phase: "sending", processRunId: runId,
      draft: { runId, text: "正文正在生成。" }, runTraces: [current] })} draftText="正文正在生成。" />);
    const panel = view.container.querySelector<HTMLDetailsElement>(".companion-history__trace")!;
    expect(panel.open).toBe(true);
    // 名字先出现，过程在名字下面，回复正文在过程之后。
    expect(view.container.querySelector("header")!.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(panel.compareDocumentPosition(view.container.querySelector(".companion-record__body")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // 思考块默认收起；要用时自己打开，完整原文在展开的详情里。
    const thoughts = [...panel.querySelectorAll<HTMLDetailsElement>(".companion-history__trace-thinking")];
    expect(thoughts).toHaveLength(2);
    expect(thoughts.every(thought => !thought.open)).toBe(true);
    fireEvent.click(thoughts[0]!.querySelector("summary")!);
    expect(thoughts[0]!.open).toBe(true);
    expect(thoughts[0]!.textContent).toContain("先读原文。");
    fireEvent.click(thoughts[1]!.querySelector("summary")!);
    expect(thoughts[1]!.open).toBe(true);
    expect(thoughts[1]!.textContent).toContain("再核对这个例子。");
    const operation = panel.querySelector<HTMLDetailsElement>(".companion-history__trace-tool")!;
    expect(operation.open).toBe(false);
    fireEvent.click(operation.querySelector("summary")!);
    expect(operation.open).toBe(true);
    fireEvent.click(operation.querySelector("summary")!);
    expect(operation.open).toBe(false);
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
    // 新会话/新打开没有显式选择，历史过程回到默认收起。
    useCompanionResultPreview.setState({ disclosures: new Map() });
    const history = render(<CompanionJournalTimeline chat={interactionSession({ messages: [message()], runTraces: settled })} draftText="" />);
    // 历史消息默认收起；要读思考得自己展开。
    expect(history.container.querySelector<HTMLDetailsElement>(".companion-history__trace")?.open).toBe(false);
  });

  it("手动展开的历史过程跨重开保留，换会话清除旧选择", () => {
    const current = trace();
    const chat = interactionSession({ messages: [message()], runTraces: [current] });
    const choices = new Map<string, boolean>();
    const view = render(<CompanionJournalViewState choices={choices}><CompanionJournalTimeline chat={chat} draftText="" /></CompanionJournalViewState>);
    const panel = view.container.querySelector<HTMLDetailsElement>(".companion-history__trace")!;
    expect(panel.open).toBe(false);
    fireEvent.click(panel.querySelector("summary")!);
    expect(panel.open).toBe(true);
    expect(panel.textContent).toContain("先读原文。");
    view.rerender(<CompanionJournalViewState choices={choices}>{null}</CompanionJournalViewState>);
    view.rerender(<CompanionJournalViewState choices={choices}><CompanionJournalTimeline chat={chat} draftText="" /></CompanionJournalViewState>);
    const reopened = view.container.querySelector<HTMLDetailsElement>(".companion-history__trace")!;
    expect(reopened.open).toBe(true);
    view.rerender(<CompanionJournalViewState choices={new Map()}><CompanionJournalTimeline chat={chat} draftText="" /></CompanionJournalViewState>);
    expect(reopened.open).toBe(false);
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
