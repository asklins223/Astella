import { describe, expect, it } from "vitest";
import {
  appendCompanionAgentNode,
  buildCompanionRunTraces,
  companionRunTraceExpired,
  companionTurnProcessLine,
  countAgentToolCalls,
  visibleAgentNodes,
  type CompanionAgentNodes,
} from "../companion-agent-nodes.ts";

/**
 * 这些用例固定的是"轨道不会越长越长"这条契约：同一个工具调用/技能/状态迁移只能占一行。
 * 它们是方案 §1 行为表里 `agent.tool` 那行的可执行版本（`agent.skill` 随技能层删除）。
 */

function fold(events: readonly { eventType: string; payload: unknown }[]): CompanionAgentNodes {
  return events.reduce<CompanionAgentNodes>((nodes, event) => appendCompanionAgentNode(nodes, event), []);
}

const tool = (status: string, extra: Record<string, unknown> = {}) => ({
  eventType: "agent.tool",
  payload: {
    tool: {
      toolCallId: "call-1",
      name: "companion_open_card",
      status,
      safeLabel: "翻开你的笔记",
      ...extra,
    },
  },
});

describe("companion agent node stream", () => {
  it("keeps one row per tool call across its whole status lifecycle", () => {
    const nodes = fold([tool("requested"), tool("executing"), tool("succeeded", { safeSummary: "已打开 3 张卡片" })]);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({
      key: "tool:call-1",
      kind: "tool",
      toolName: "companion_open_card",
      state: "succeeded",
      summary: "已打开 3 张卡片",
    });
    expect(countAgentToolCalls(nodes)).toBe(1);
  });

  it("rewrites the trailing status row instead of stacking status lines", () => {
    const nodes = fold([
      { eventType: "assistant.status", payload: { status: "thinking", safeLabel: "我先结合当前页面想一想" } },
      { eventType: "assistant.status", payload: { status: "acting", safeLabel: "我去翻一下你的笔记" } },
    ]);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ kind: "acting", label: "我去翻一下你的笔记" });
  });

  /**
   * 2026-10-07：伴星按本轮意图决定开不开思考，所以"发送中"不再是"她在想"。
   * 服务端在 provider 调用前只发 `waiting`，真开了思考档才补发 `thinking`——
   * 两种必须落成不同 kind，界面才不会拿等待当思考。
   */
  it("keeps waiting and thinking as different states", () => {
    const waiting = fold([{ eventType: "assistant.status", payload: { status: "waiting", safeLabel: "在听你说…" } }]);
    expect(waiting[0]).toMatchObject({ kind: "waiting", label: "在听你说…" });
    const thenThinking = fold([
      { eventType: "assistant.status", payload: { status: "waiting", safeLabel: "在听你说…" } },
      { eventType: "assistant.status", payload: { status: "thinking", safeLabel: "她在想…" } },
    ]);
    expect(thenThinking).toHaveLength(1);
    expect(thenThinking[0]).toMatchObject({ kind: "thinking", label: "她在想…" });
  });

  it("maps protocol states onto the rail visuals while preserving unknown outcomes", () => {
    expect(fold([tool("blocked")])[0].state).toBe("failed");
    expect(fold([tool("outcome_unknown", { safeSummary: "结果还没法确认" })])[0]).toMatchObject({
      state: "outcome_unknown",
      summary: "结果还没法确认",
    });
    expect(fold([tool("expired")])[0].state).toBe("cancelled");
    expect(fold([tool("waiting_confirmation")])[0].state).toBe("waiting_confirmation");
    expect(fold([tool("requested")])[0].state).toBe("running");
    expect(fold([tool("executing")])[0].state).toBe("running");
  });

  it("fails closed for missing, future, or inherited status names", () => {
    const missingStatus = {
      eventType: "agent.tool",
      payload: {
        tool: {
          toolCallId: "call-missing-status",
          name: "companion_schedule_reminder",
          safeLabel: "正在记下这个提醒",
        },
      },
    };
    for (const event of [
      tool("future_status"),
      tool("toString"),
      missingStatus,
    ]) {
      const [node] = fold([event]);
      expect(node.state).toBe("outcome_unknown");
      expect(node.summary).toMatch(/结果待核对/);
      expect(node.summary).toMatch(/不要重复操作/);
    }

    // Positive control: an explicitly recognized live state still renders as active.
    expect(fold([tool("executing")])[0].state).toBe("running");
  });

  it("drops frames it cannot verify instead of inventing a label", () => {
    const nodes = fold([
      { eventType: "agent.tool", payload: { tool: { toolCallId: "c", name: "n", status: "succeeded" } } },
      { eventType: "agent.tool", payload: { tool: { name: "n", safeLabel: "x" } } },
      { eventType: "assistant.status", payload: { status: "thinking" } },
      { eventType: "assistant.delta", payload: { textDelta: "hi" } },
    ]);
    expect(nodes).toHaveLength(0);
  });

  it("collapses the overflow into a hidden counter", () => {
    const nodes = fold([tool("succeeded"), tool("succeeded"), tool("succeeded"), tool("succeeded")].map((event, index) => ({
      ...event,
      payload: { tool: { toolCallId: `call-${index}`, name: "n", status: "succeeded", safeLabel: `第 ${index} 步` } },
    })));
    const { hiddenCount, visible } = visibleAgentNodes(nodes);
    expect(hiddenCount).toBe(1);
    expect(visible.map((node) => node.label)).toEqual(["第 1 步", "第 2 步", "第 3 步"]);
    expect(countAgentToolCalls(nodes)).toBe(4);
  });
});

describe("companion run traces (历史过程留痕)", () => {
  const summary = (over: Record<string, unknown> = {}) => ({
    version: 1 as const,
    runId: "7f0a1a2e-0000-4000-8000-000000000001",
    status: "succeeded",
    generation: 3,
    mode: "hybrid" as const,
    stepCount: 3,
    toolCallCount: 2,
    maxSteps: 8,
    maxToolCalls: 12,
    assistantMessageId: "7f0a1a2e-0000-4000-8000-0000000000aa",
    nodeCount: 2,
    ...over,
  });

  it("aligns nodes to a run by runId and reuses the live reducer", () => {
    const traces = buildCompanionRunTraces([summary()], [
      { version: 1, seq: 4, runId: summary().runId, type: "agent.tool", payload: tool("requested").payload },
      { version: 1, seq: 5, runId: summary().runId, type: "agent.tool", payload: tool("succeeded").payload },
      { version: 1, seq: 6, runId: null, type: "assistant.status", payload: { status: "thinking", safeLabel: "x" } },
    ]);
    expect(traces).toHaveLength(1);
    // 同一个 toolCallId 的两条事件在历史里也只是一行——与实时链路同一个函数。
    expect(traces[0].nodes).toHaveLength(1);
    expect(traces[0].nodes[0]).toMatchObject({ key: "tool:call-1", state: "succeeded" });
    expect(companionRunTraceExpired(traces[0])).toBe(false);
  });

  it("tells 'expired' apart from 'this turn had no process'", () => {
    const expired = buildCompanionRunTraces([summary({ nodeCount: 0 })], []);
    expect(companionRunTraceExpired(expired[0])).toBe(true);
    // single_step 闲聊：没有步数也没有节点 —— 是"没有过程"，不是"过期"。
    const chitchat = buildCompanionRunTraces([summary({ stepCount: 0, toolCallCount: 0, nodeCount: 0, mode: "single_step" })], []);
    expect(companionRunTraceExpired(chitchat[0])).toBe(false);
  });
});

/**
 * 「此刻她在做什么」的兜底映射（2026-10-07）。
 * 实机事件表形状：waiting → thinking → tool(requested/executing/succeeded 挤在 40ms 内)
 * → 3.6s 后才出第一个字。工具节点落定后它不再是活动节点，那一整段过去只能靠这句兜底，
 * 而它曾经固定是「在听…」——她明明在查东西。
 */
describe("companionTurnProcessLine 的过程文案映射", () => {
  it("收到文字消息后等待回复，不冒充正在拾音或思考", () => {
    expect(companionTurnProcessLine([])).toBe("正在准备回复…");
  });

  it("工具完成后进入回复阶段，不被之前的思考节点覆盖", () => {
    const nodes = fold([
      { eventType: "assistant.status", payload: { status: "thinking", safeLabel: "她在想…" } },
      tool("succeeded", { name: "companion_read_current_page" }),
    ]);
    expect(companionTurnProcessLine(nodes)).toBe("正在组织回复…");
  });

  it("工具运行失败也不宣称已看完材料", () => {
    expect(companionTurnProcessLine(fold([tool("failed")]))).toBe("正在组织回复…");
  });

  it("没开思考但跑过工具：进入回复阶段", () => {
    const nodes = fold([tool("succeeded", { name: "companion_read_note" })]);
    expect(companionTurnProcessLine(nodes)).toBe("正在组织回复…");
  });

  it("当前活动、待确认与结果不明分别保留真实状态", () => {
    const thinking = fold([{ eventType: "assistant.status", payload: { status: "thinking", safeLabel: "正在思考…" } }]);
    expect(companionTurnProcessLine(thinking)).toBe("正在思考…");
    expect(companionTurnProcessLine(fold([tool("waiting_confirmation")]))).toBe("等你确认这项操作");
    expect(companionTurnProcessLine(fold([tool("outcome_unknown")]))).toBe("操作结果待核对…");
  });
});
