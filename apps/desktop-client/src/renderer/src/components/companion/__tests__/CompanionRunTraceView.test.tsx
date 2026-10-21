// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompanionRunTrace } from "../../../app/companion-session/companion-agent-nodes.ts";
import { CompanionRunTraceView } from "../journal/CompanionRunTraceView.tsx";
import { useCompanionResultPreview } from "../journal/companion-result-preview";

beforeEach(() => useCompanionResultPreview.setState({ disclosures: new Map() }));
afterEach(cleanup);

describe("CompanionRunTraceView", () => {
  it("历史过程与步骤默认收起，并保留每个节点的真实状态", () => {
    const trace: CompanionRunTrace = {
      summary: {
        version: 1,
        runId: "11111111-1111-4111-8111-111111111111",
        status: "waiting_for_confirmation",
        generation: 1,
        stepCount: 2,
        toolCallCount: 1,
        maxSteps: 4,
        maxToolCalls: 4,
        assistantMessageId: "22222222-2222-4222-8222-222222222222",
        nodeCount: 2,
      },
      nodes: [
        { key: "status:1", kind: "acting", label: "整理可执行方案", state: "succeeded", toolName: null, summary: null, proposalId: null },
        { key: "tool:choice", kind: "tool", label: "等待确认设置", state: "waiting_confirmation", toolName: "settings", summary: "需要你确认后才能修改", proposalId: null },
      ],
    };

    const { container } = render(<CompanionRunTraceView trace={trace} />);
    expect(container.querySelector("details")?.open).toBe(false);
    expect([...container.querySelectorAll(".companion-history__trace-step")].every(step => !(step as HTMLDetailsElement).open)).toBe(true);
    fireEvent.click(container.querySelector("summary")!);
    expect(screen.getByText("执行工具 1 次")).toBeTruthy();
    expect(screen.getByText("已完成", { selector: "small" })).toBeTruthy();
    expect(screen.getAllByText("待确认").length).toBeGreaterThan(0);
  });

  it("收起那一格不搬思考原文：英文内心独白留在展开的时间线里", () => {
    const leak = "The user wants a note recommendation. Recommending it again is fine, it's substantive. Write the final reply.";
    const trace: CompanionRunTrace = {
      summary: {
        version: 1, runId: "11111111-1111-4111-8111-111111111111", status: "succeeded",
        generation: 1, stepCount: 3, toolCallCount: 4, maxSteps: 4, maxToolCalls: 4,
        assistantMessageId: "22222222-2222-4222-8222-222222222222", nodeCount: 1,
        thinkingText: leak,
      },
      nodes: [
        { key: "tool:call-1", kind: "tool", label: "搜笔记", state: "succeeded",
          toolName: "companion_search_notes", summary: "找到 8 篇", proposalId: null },
      ],
    };

    const { container } = render(<CompanionRunTraceView trace={trace} />);
    const preview = container.querySelector(".companion-history__trace-preview")?.textContent ?? "";
    expect(preview).not.toContain("Recommending it again");
    expect(preview).toContain("正在翻你的笔记");
    expect(preview).toContain("找到 8 篇");
  });

  it("run 已结束时不会把缺少完成帧的实时节点继续标成进行中", () => {
    const trace: CompanionRunTrace = {
      summary: {
        version: 1,
        runId: "11111111-1111-4111-8111-111111111111",
        status: "succeeded",
        generation: 1,
        stepCount: 1,
        toolCallCount: 0,
        maxSteps: 4,
        maxToolCalls: 4,
        assistantMessageId: "22222222-2222-4222-8222-222222222222",
        nodeCount: 1,
      },
      nodes: [
        { key: "status:0", kind: "thinking", label: "思考中", state: "running", toolName: null, summary: null, proposalId: null },
      ],
    };

    render(<CompanionRunTraceView trace={trace} />);
    expect(screen.getByText("处理过程")).toBeTruthy();
    expect(screen.getByText("已完成", { selector: "small" })).toBeTruthy();
    expect(screen.queryByText("进行中")).toBeNull();
  });

  it("结果不明的历史操作不强制展开，摘要仍保留待核对说明", () => {
    const { container } = render(<CompanionRunTraceView trace={traceWith({
      key: "tool:uncertain",
      kind: "tool",
      label: "记下提醒",
      state: "outcome_unknown",
      toolName: "companion_schedule_reminder",
      summary: "这项操作可能已经发生，但暂时没有确定回执；请先核对状态，不要重复操作。",
      proposalId: null,
    })} />);
    expect(container.querySelector("details")?.open).toBe(false);
    expect(container.querySelector(".companion-history__trace-preview")?.textContent).toContain("请先核对状态");
    expect(screen.getByText("结果待核对")).toBeTruthy();
    expect(screen.getByText(/请先核对状态/, { selector: "p" })).toBeTruthy();
  });

  it("恢复只提交原运行身份，处理中不能连点，错误保留在记录里", async () => {
    const original = traceWith({ key: "tool:unknown", kind: "tool", label: "保存笔记", state: "outcome_unknown",
      toolName: "companion_create_note", summary: "尚未核对", proposalId: null });
    const trace = { ...original, summary: { ...original.summary, status: "failed" as const, errorCode: "PROVIDER_IDLE_TIMEOUT" as const, eventCursor: 9 } };
    let fail: (error: Error) => void = () => {};
    const recover = vi.fn(() => new Promise<string>((_resolve, reject) => { fail = reject; }));
    const { container } = render(<CompanionRunTraceView trace={trace} onRecoverRun={recover} />);
    fireEvent.click(container.querySelector("summary")!);
    fireEvent.click(screen.getByRole("button", { name: "核对保存结果" }));
    expect(recover).toHaveBeenCalledWith(trace.summary.runId, true);
    expect(screen.getByRole("button", { name: "从中断处继续" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "从中断处继续" }));
    expect(recover).toHaveBeenCalledOnce();
    await act(async () => fail(new Error("连接暂时中断")));
    expect(screen.getByRole("status").textContent).toContain("服务暂时没有返回可确认的结果");
    expect(screen.getByRole("button", { name: "从中断处继续" }).hasAttribute("disabled")).toBe(false);
  });

  /**
   * 工具节点的 `label` 装的是服务端下发的 `definition.description` —— 那是**给模型看的**
   * 工具说明。轨道与头顶那句都过 `nodeLabel()` 换成给人看的那句话，这一份以前是裸渲染
   * `node.label`（2026-09-23 真窗口截图：过程里明晃晃写着"**只在用户问自己学了多久时
   * 调用**；她跟你打招呼时不要调"），于是同一步在轨道上是「正在看你的学习数据」、
   * 在记录里是一份工具文档。
   */
  it("工具节点说给人听的那句话，不把模型看的工具说明吐到界面上", () => {
    const modelFacing = "读取学习数据统计：今天/本周学了多久、到期复习数。**只在用户问进度时调用**";
    render(<CompanionRunTraceView trace={traceWith({
      key: "tool:stats", kind: "tool", label: modelFacing, state: "succeeded",
      toolName: "companion_get_learning_stats", summary: "今日 39 分钟", proposalId: null,
    })} />);
    expect(screen.getByText("正在看你的学习数据", { selector: "strong" })).toBeTruthy();
    expect(screen.queryByText(modelFacing)).toBeNull();
    expect(document.body.textContent).not.toContain("只在用户问进度时调用");
  });

  it("认不出的工具不猜语义，统一说「正在处理…」", () => {
    render(<CompanionRunTraceView trace={traceWith({
      key: "tool:odd", kind: "tool", label: "companion_do_something_new 的说明文字", state: "succeeded",
      toolName: "companion_do_something_new", summary: null, proposalId: null,
    })} />);
    expect(screen.getByText("正在处理…", { selector: "strong" })).toBeTruthy();
    expect(document.body.textContent).not.toContain("companion_do_something_new");
  });

  it("流式时过程展开、完成后收起；思考默认折叠，需要时再打开", () => {
    const old = traceWith({ key: "tool:read", kind: "tool", label: "读笔记", state: "succeeded",
      toolName: "companion_read_note", summary: "已读完", proposalId: null });
    const trace: CompanionRunTrace = { ...old, summary: { ...old.summary, status: "running" }, events: [
      { version: 1, seq: 1, runId: old.summary.runId, type: "assistant.thinking", payload: { text: "第一段", index: 0 } },
      { version: 1, seq: 2, runId: old.summary.runId, type: "agent.tool", payload: { tool: { toolCallId: "read", name: "companion_read_note", status: "succeeded", safeLabel: "读笔记", safeSummary: "已读完" } } },
      { version: 1, seq: 3, runId: old.summary.runId, type: "assistant.thinking", payload: { text: "当前这一段", index: 1 } },
    ] };
    const view = render(<CompanionRunTraceView trace={trace} />);
    const outer = () => view.container.querySelector<HTMLDetailsElement>(".companion-history__trace")!;
    const thoughts = () => [...view.container.querySelectorAll<HTMLDetailsElement>(".companion-history__trace-thinking")];
    expect(outer().open).toBe(false);
    view.rerender(<CompanionRunTraceView trace={trace} live />);
    expect(outer().open).toBe(true);
    expect(thoughts()).toHaveLength(2);
    expect(thoughts().every(step => !step.open)).toBe(true);
    expect(view.container.querySelectorAll(".companion-history__trace-tool")).toHaveLength(1);
    fireEvent.click(thoughts()[0]!.querySelector("summary")!);
    expect(thoughts()[0]!.open).toBe(true);
    expect(screen.getByText("第一段")).toBeTruthy();
    view.rerender(<CompanionRunTraceView trace={{ ...trace, summary: { ...trace.summary, status: "succeeded" } }} live />);
    expect(outer().open).toBe(false);
  });

  it("流式增量不重开手动收起的步骤，手动展开的回看选择跨重开保留", () => {
    const old = traceWith({ key: "thinking:active", kind: "thinking", label: "思考中", state: "running", toolName: null, summary: "当前进展", proposalId: null });
    const trace = { ...old, summary: { ...old.summary, status: "running" as const } };
    const view = render(<CompanionRunTraceView trace={trace} live />);
    const step = view.container.querySelector<HTMLDetailsElement>(".companion-history__trace-step")!;
    expect(step.open).toBe(true);
    fireEvent.click(step.querySelector("summary")!);
    view.rerender(<CompanionRunTraceView trace={{ ...trace, nodes: [{ ...trace.nodes[0]!, summary: "又一段进展" }] }} live />);
    expect(step.open).toBe(false);
    const completed = { ...trace, summary: { ...trace.summary, status: "succeeded" as const } };
    view.rerender(<CompanionRunTraceView trace={completed} />);
    const outer = view.container.querySelector<HTMLDetailsElement>(".companion-history__trace")!;
    expect(outer.open).toBe(false);
    fireEvent.click(outer.querySelector("summary")!);
    fireEvent.click(step.querySelector("summary")!);
    view.unmount();
    const reopened = render(<CompanionRunTraceView trace={completed} />);
    expect(reopened.container.querySelector<HTMLDetailsElement>(".companion-history__trace")?.open).toBe(true);
    expect(reopened.container.querySelector<HTMLDetailsElement>(".companion-history__trace-step")?.open).toBe(true);
  });

});

function traceWith(node: CompanionRunTrace["nodes"][number]): CompanionRunTrace {  return {
    summary: {
      version: 1,
      runId: "11111111-1111-4111-8111-111111111111",
      status: "succeeded",
      generation: 1,
      stepCount: 1,
      toolCallCount: 1,
      maxSteps: 4,
      maxToolCalls: 4,
      assistantMessageId: "22222222-2222-4222-8222-222222222222",
      nodeCount: 1,
    },
    nodes: [node],
  };
}
