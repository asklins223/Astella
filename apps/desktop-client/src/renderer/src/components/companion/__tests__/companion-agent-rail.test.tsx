// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompanionAgentNode, CompanionAgentNodes } from "../../../app/companion-agent-nodes.ts";
import { CompanionAgentRail } from "../companion-agent-rail.tsx";

afterEach(cleanup);

function toolNode(overrides: Partial<CompanionAgentNode> = {}): CompanionAgentNode {
  return {
    key: "tool:call-1",
    kind: "tool",
    label: "正在翻你的笔记",
    state: "succeeded",
    toolName: "companion_search_notes",
    summary: null,
    proposalId: null,
    ...overrides,
  };
}

const TOOL_NODES: CompanionAgentNodes = [toolNode()];
describe("CompanionAgentRail", () => {
  it("回合结束后显示完成摘要，不自计时退场", () => {
    vi.useFakeTimers();
    try {
      render(<CompanionAgentRail nodes={TOOL_NODES} progress={null} turnState="done" companionName="大肥鱼" />);
      expect(screen.getByRole("status", { name: "大肥鱼 正在做的事" })).toBeTruthy();
      act(() => { vi.advanceTimersByTime(500); });
      expect(screen.getByText(/1 项操作/)).toBeTruthy();
      // 曾经这里有个 5.4s 的 `expired`：整条轨道自己消失，与气泡何时走无关。
      act(() => { vi.advanceTimersByTime(30_000); });
      expect(screen.getByRole("status", { name: "大肥鱼 正在做的事" })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("可展开查看全部真实节点，并报告最近的阅读操作", () => {
    const onActivity = vi.fn();
    render(<CompanionAgentRail nodes={[toolNode({ key: "first", summary: "最早的一步" }), ...[1, 2, 3].map(index => toolNode({ key: `next-${index}` }))]} progress={null} turnState="done" companionName="大肥鱼" onActivity={onActivity} />);
    expect(screen.queryByText("最早的一步")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "查看过程" }));
    expect(screen.getByText("最早的一步")).toBeTruthy();
    expect(onActivity).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "收起过程" }));
    expect(screen.queryByText("最早的一步")).toBeNull();
  });

  it("工具过程保留失败轮次的真实说明", () => {
    render(
      <CompanionAgentRail
        nodes={TOOL_NODES}
        progress={{ stepCount: 2, maxSteps: 4, toolCallCount: 1, maxToolCalls: 12 }}
        turnState="failed"
        companionName="大肥鱼"
      />,
    );
    const rail = screen.getByRole("status", { name: "大肥鱼 正在做的事" });
    expect(rail.textContent).toContain("回复未完成");
  });

  it("结果不明时，紧凑摘要也保留待核对提醒", () => {
    render(
      <CompanionAgentRail
        nodes={[toolNode({ state: "outcome_unknown", summary: "暂时没有确定回执" })]}
        progress={{ stepCount: 1, maxSteps: 4, toolCallCount: 1, maxToolCalls: 12 }}
        turnState="done"
        companionName="大肥鱼"
      />,
    );
    expect(screen.getByRole("status", { name: "大肥鱼 正在做的事" }).textContent).toContain("结果待核对");
  });
  it("没有工具时不显示，包括只有思考节点和旧统计的情况", () => {
    const { container } = render(<CompanionAgentRail nodes={[toolNode({ kind: "thinking", toolName: null, state: "running" })]}
      progress={{ stepCount: 4, maxSteps: 20, toolCallCount: 3, maxToolCalls: 40 }} turnState="running" companionName="大肥鱼" />);
    expect(container.childElementCount).toBe(0);
  });

  it("执行帧实时更新当前动作；展开不会在下一次帧或终态时被强制合回", () => {
    const view = render(<CompanionAgentRail nodes={[toolNode({ state: "running" })]} progress={null} turnState="running" companionName="大肥鱼" />);
    expect(screen.getByRole("status").textContent).toContain("正在翻你的笔记");
    expect(screen.getByRole("status").textContent).toContain("进行中");
    fireEvent.click(screen.getByRole("button", { name: "查看过程" }));
    view.rerender(<CompanionAgentRail nodes={[toolNode(), toolNode({ key: "tool:read", toolName: "companion_read_note", state: "running", summary: "正在读取《中国古代史总揽》" })]} progress={null} turnState="running" companionName="大肥鱼" />);
    expect(screen.getByRole("status").textContent).toContain("正在读那篇笔记");
    expect(screen.getByRole("status").textContent).toContain("2 项操作");
    expect(screen.getByRole("button", { name: "收起过程" }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("正在读取《中国古代史总揽》")).toBeTruthy();
    view.rerender(<CompanionAgentRail nodes={[toolNode(), toolNode({ key: "tool:read", toolName: "companion_read_note" })]} progress={null} turnState="done" companionName="大肥鱼" />);
    expect(screen.getByRole("status").textContent).toContain("操作已完成");
    expect(screen.getByRole("button", { name: "收起过程" })).toBeTruthy();
    expect(document.body.textContent).not.toContain("0 步");
  });

  it.each(["not_executed", "unavailable", "outcome_unknown", "waiting_confirmation", "cancelled"] as const)("%s 的操作不会显示成成功", state => {
    render(<CompanionAgentRail nodes={[toolNode({ state })]} progress={null} turnState="done" companionName="大肥鱼" />);
    expect(screen.getByRole("status").textContent).not.toContain("操作已完成");
  });

  it("回复已结束但工具缺少回执时，明确保留待核对状态", () => {
    render(<CompanionAgentRail nodes={[toolNode({ state: "running" })]} progress={null} turnState="done" companionName="大肥鱼" />);
    expect(screen.getByRole("status").textContent).toContain("结果待核对");
  });

});
