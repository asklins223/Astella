// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompanionAgentNode, CompanionAgentNodes } from "../../../app/companion-session/companion-agent-nodes.ts";
import { CompanionAgentRail } from "../hud/companion-agent-rail.tsx";
import { useCompanionResultPreview } from "../journal/companion-result-preview";

beforeEach(() => useCompanionResultPreview.setState({ disclosures: new Map() }));
afterEach(cleanup);

function toolNode(overrides: Partial<CompanionAgentNode> = {}): CompanionAgentNode {
  return {
    key: "tool:call-1",
    kind: "tool",
    label: "正在翻你的笔记",
    state: "succeeded",
    toolName: "notes.read.search",
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
      expect(screen.getAllByText(/1 项操作/).length).toBeGreaterThan(0);
      // 曾经这里有个 5.4s 的 `expired`：整条轨道自己消失，与气泡何时走无关。
      act(() => { vi.advanceTimersByTime(30_000); });
      expect(screen.getByRole("status", { name: "大肥鱼 正在做的事" })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("已结束过程默认收起，回看由用户展开，并报告阅读操作", () => {
    const onActivity = vi.fn();
    render(<CompanionAgentRail nodes={[toolNode({ key: "first", summary: "最早的一步" }), ...[1, 2, 3].map(index => toolNode({ key: `next-${index}` }))]} progress={null} turnState="done" companionName="大肥鱼" onActivity={onActivity} />);
    expect(screen.queryByText("最早的一步")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "查看过程" }));
    expect(screen.getByText("最早的一步")).toBeTruthy();
    expect(onActivity).toHaveBeenCalled();
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

  it("执行时自动展开并更新当前动作；结束后自动收起，真实摘要继续显示", () => {
    const view = render(<CompanionAgentRail nodes={[toolNode({ state: "running" })]} progress={null} turnState="running" companionName="大肥鱼" />);
    expect(screen.getByRole("status").textContent).toContain("正在翻你的笔记");
    expect(screen.getByRole("status").textContent).toContain("进行中");
    expect(screen.getByRole("button", { name: "收起过程" })).toBeTruthy();
    view.rerender(<CompanionAgentRail nodes={[toolNode(), toolNode({ key: "tool:read", toolName: "notes.read.read", state: "running", summary: "正在读取《中国古代史总揽》" })]} progress={null} turnState="running" companionName="大肥鱼" />);
    expect(screen.getByRole("status").textContent).toContain("正在读那篇笔记");
    expect(screen.getByRole("status").textContent).toContain("2 项操作");
    expect(screen.getByRole("button", { name: "收起过程" }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("正在读取《中国古代史总揽》")).toBeTruthy();
    view.rerender(<CompanionAgentRail nodes={[toolNode(), toolNode({ key: "tool:read", toolName: "notes.read.read" })]} progress={null} turnState="done" companionName="大肥鱼" />);
    expect(screen.getByRole("status").textContent).toContain("操作已完成");
    expect(screen.getByRole("button", { name: "查看过程" })).toBeTruthy();
    expect(document.body.textContent).not.toContain("0 步");
  });

  it("自动展开不覆盖用户选择，手动打开的回看在终态保留", () => {
    const view = render(<CompanionAgentRail nodes={[toolNode({ state: "running" })]} progress={null} turnState="running" companionName="大肥鱼" />);
    fireEvent.click(screen.getByRole("button", { name: "收起过程" }));
    view.rerender(<CompanionAgentRail nodes={[toolNode({ state: "running", summary: "新的进展" })]} progress={null} turnState="running" companionName="大肥鱼" />);
    expect(screen.getByRole("button", { name: "查看过程" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "查看过程" }));
    view.rerender(<CompanionAgentRail nodes={TOOL_NODES} progress={null} turnState="done" companionName="大肥鱼" />);
    expect(screen.getByRole("button", { name: "收起过程" })).toBeTruthy();
  });

  it.each(["not_executed", "unavailable", "outcome_unknown", "waiting_confirmation", "cancelled"] as const)("%s 的操作不会显示成成功", state => {
    render(<CompanionAgentRail nodes={[toolNode({ state })]} progress={null} turnState="done" companionName="大肥鱼" />);
    expect(screen.getByRole("status").textContent).not.toContain("操作已完成");
    expect(screen.getByRole("status").textContent).not.toContain("正在翻你的笔记");
  });

  it("一步没做成不改变整轮结论：后面的步骤成功时仍报告已完成，并单独点出未完成数", () => {
    const { container } = render(<CompanionAgentRail
      nodes={[toolNode({ key: "write", state: "not_executed", toolName: "notes.write.create" }), toolNode({ key: "read", toolName: "notes.read.read" })]}
      progress={null} turnState="done" companionName="大肥鱼" />);
    const rail = container.querySelector(".companion-hud__rail")!;
    expect(rail.getAttribute("data-state")).toBe("succeeded");
    expect(screen.getByRole("status").textContent).toContain("操作已完成");
    expect(screen.getByRole("status").textContent).toContain("1 项未完成");
    expect(document.body.textContent).not.toContain("这项操作没有开始");
  });

  it("执行中某一步失败仍显示进行中，不把卡片切成失败态", () => {
    const { container } = render(<CompanionAgentRail
      nodes={[toolNode({ key: "failed", state: "failed" }), toolNode({ key: "next", state: "running" })]}
      progress={null} turnState="running" companionName="大肥鱼" />);
    const rail = container.querySelector(".companion-hud__rail")!;
    expect(rail.getAttribute("data-state")).toBe("running");
    expect(screen.getByRole("status").textContent).toContain("进行中");
  });

  it("全部步骤都没做成时，标题说清是这条回复里的操作没成功，而不是「回复未完成」", () => {
    render(<CompanionAgentRail nodes={[toolNode({ state: "failed" })]} progress={null} turnState="done" companionName="大肥鱼" />);
    const text = screen.getByRole("status").textContent ?? "";
    expect(text).toContain("这条回复里的操作没有成功");
    expect(text).not.toContain("回复未完成");
  });

  it("思考按一行尾巴显示在进展上方", () => {
    render(<CompanionAgentRail nodes={[toolNode({ state: "running" })]} progress={null} turnState="running"
      companionName="大肥鱼" thinking="…先看笔记，再回答。" />);
    expect(document.querySelector(".companion-hud__rail-thinking")?.textContent).toContain("先看笔记，再回答。");
  });

  it("回复已结束但工具缺少回执时，明确保留待核对状态", () => {
    render(<CompanionAgentRail nodes={[toolNode({ state: "running" })]} progress={null} turnState="done" companionName="大肥鱼" />);
    expect(screen.getByRole("status").textContent).toContain("结果待核对");
  });

});
