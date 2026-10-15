// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { CompanionRunTrace } from "../../../app/companion-agent-nodes.ts";
import { CompanionRunTraceView } from "../CompanionRunTraceView.tsx";

afterEach(cleanup);

describe("CompanionRunTraceView", () => {
  it("默认折叠历史执行过程，并保留每个节点的真实状态", () => {
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

  it("结果不明的操作默认折叠，展开内容保留待核对状态", () => {
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
    expect(screen.getByText("结果待核对")).toBeTruthy();
    expect(screen.getByText(/请先核对状态/, { selector: "p" })).toBeTruthy();
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
});

function traceWith(node: CompanionRunTrace["nodes"][number]): CompanionRunTrace {
  return {
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
