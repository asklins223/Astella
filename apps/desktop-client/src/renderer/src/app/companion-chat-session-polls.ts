/**
 * 伴星会话的两段**低频补白轮询**（2026-09-30 从 `companion-chat-session.tsx` 抽出）。
 *
 * ## 为什么抽
 *
 * Provider 里有两段形状完全一样的轮询：agent 导航 route（跳转 chip）与过程留痕（真实步数）。
 * 每一段都是「开抽屉或正在跑时开轮询 → 拉一次 → 挂定时器 → 清理」，
 * 加起来 78 行，而**它们都不是聊天主链路**——失败静默跳过，不弹错、不打断对话。
 *
 * 放在 Provider 里，读主链路的人要一路滑过这两段才看到「发送」，
 * 才知道它们与发送无关。**抽出来，它们的性质自己就写在文件名里。**
 *
 * ## 两段都不走 `unwrapGatewayResult`——这是行为的一部分，别顺手"修好"
 *
 * 2026-09-19 用户实测：那个包装对任何 not-ok 都先 `publishGateInvalidation` 再 throw，
 * 而 `unsupported_contract`（主进程 / 合同还没签发这两个新通道时）会把**整个工作区视图
 * 打回首页默认态**，`catch` 兜不住这个副作用。所以这里只读 `result.ok`，失败静默跳过。
 *
 * ## 拆的是位置，不是行为
 *
 * 两段 effect 一行没改，依赖数组一个没动。Provider 那边只多了一句调用。
 */
import { useEffect } from "react";
import {
  createRequestMeta,
  gatewayErrorMessage,
  requireWorkspaceEpoch,
} from "./desktop-client";
import { buildCompanionRunTraces, type CompanionRunTrace } from "./companion-agent-nodes";
import { desktopRouteFromAgentRoute } from "./companion-chat-routing";
import type { CompanionNavChip } from "./companion-chat-session";

/** 这两段轮询要驱动 Provider 的哪些动作。 */
export type CompanionPollDeps = {
  readonly conversation: { readonly id: string } | null;
  readonly mode: "closed" | "conversation" | "actions" | "history";
  readonly phase: "idle" | "loading" | "ready" | "sending" | "error";
  /** agent 导航 route 轮询的游标（跨轮次保留，所以是 ref 而不是 state）。 */
  readonly routeCursorRef: { current: number | null };
  /** 收到新的导航 chip 就往 chip 行里塞。 */
  readonly pushNavChips: (chips: CompanionNavChip[]) => void;
  /** 过程留痕轮询的落点。 */
  readonly setRunTraces: (traces: readonly CompanionRunTrace[]) => void;
  /** 留痕版本号——**刻意不进依赖**：它是这两个 effect 之间唯一的连接。 */
  readonly tracesRevision: number;
};

/** 与 agent-routes 同一节奏：1.6 秒一次。跑在抽屉开着、或一轮正在跑的时候。 */
const AGENT_ROUTE_POLL_INTERVAL_MS = 1_600;

export function useCompanionPolls(deps: CompanionPollDeps): void {
  const { conversation, mode, phase, routeCursorRef, pushNavChips, setRunTraces, tracesRevision } = deps;

  // ── agent 导航 route 轮询 ─────────────────────────────────────────────
  // 与抽屉同开同关：跳转 chip 只出现在抽屉里，常驻轮询没有必要。
  useEffect(() => {
    if (mode !== "history" || !conversation) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const epoch = await requireWorkspaceEpoch();
        // 补白轮询**不能走 unwrapGatewayResult**（2026-09-19 用户实测）：它对任何
        // not-ok 都先 publishGateInvalidation 再 throw——`unsupported_contract`
        // （主进程/合同还没签发这两个新通道时）会把整个工作区视图打回首页默认
        // 态，catch 兜不住这个副作用。这里只读 result.ok，失败静默跳过。
        const result = await window.ailearn.companion.chat.listAgentRoutes({
          meta: createRequestMeta(epoch),
          request: {
            version: 1,
            conversationId: conversation.id,
            ...(routeCursorRef.current != null ? { afterSeq: routeCursorRef.current } : {}),
          },
        });
        if (cancelled) return;
        if (!result.ok) return;
        const data = result.data;
        if (routeCursorRef.current == null) {
          routeCursorRef.current = Math.max(data.latestSeq, ...data.items.map((item) => item.seq));
          return;
        }
        routeCursorRef.current = Math.max(routeCursorRef.current, data.latestSeq);
        if (data.items.length === 0) return;
        pushNavChips(data.items.map<CompanionNavChip>((item) => ({
          id: `evt:${item.seq}`,
          summary: item.safeSummary,
          route: desktopRouteFromAgentRoute(item.route),
          ...(item.autoExecute ? { autoExecute: true } : {}),
        })));
      } catch {
        // 轮询失败不打断聊天主链路。
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), AGENT_ROUTE_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [conversation, mode, pushNavChips, routeCursorRef]);

  // ── 过程留痕轮询（2026-09-19） ────────────────────────────────────────
  // 跑在两个时刻：抽屉开着（要显示历史过程）与一轮正在跑（轨道要显示真实步数）。
  // 与 agent-routes 同一节奏的低频轮询，失败不打断聊天主链路——它是补白，不是主链路。
  const sending = phase === "sending";
  useEffect(() => {
    if (!conversation) return;
    if (mode !== "history" && !sending) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const epoch = await requireWorkspaceEpoch();
        // 同上：补白轮询不走 unwrapGatewayResult，避免 not-ok 触发门禁全量重置。
        const result = await window.ailearn.companion.chat.listRunNodes({
          meta: createRequestMeta(epoch),
          request: { version: 1, conversationId: conversation.id },
        });
        if (cancelled) return;
        if (!result.ok) return;
        setRunTraces(buildCompanionRunTraces(result.data.runs, result.data.items));
      } catch {
        // 只读补充信息：拿不到就维持上一次的快照，不把错误抛到气泡上。
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), AGENT_ROUTE_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [conversation, mode, sending, tracesRevision, setRunTraces]);
}
