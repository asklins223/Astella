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
  it("回合结束后只塌成摘要行，不自计时退场", () => {
    vi.useFakeTimers();
    try {
      render(<CompanionAgentRail nodes={TOOL_NODES} progress={null} turnState="done" companionName="大肥鱼" />);
      expect(screen.getByRole("status", { name: "大肥鱼 正在做的事" })).toBeTruthy();
      act(() => { vi.advanceTimersByTime(500); });
      expect(screen.getByText("1 次工具")).toBeTruthy();
      // 曾经这里有个 5.4s 的 `expired`：整条轨道自己消失，与气泡何时走无关。
      act(() => { vi.advanceTimersByTime(30_000); });
      expect(screen.getByRole("status", { name: "大肥鱼 正在做的事" })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("可展开查看全部真实节点，并报告最近的阅读操作", () => {
    const onActivity = vi.fn();
    render(<CompanionAgentRail nodes={[toolNode({ key: "first", kind: "thinking", label: "最早的一步", toolName: null }), ...[1, 2, 3].map(index => toolNode({ key: `next-${index}` }))]} progress={null} turnState="done" companionName="大肥鱼" onActivity={onActivity} />);
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
    expect(rail.textContent).toContain("没说完");
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
});
