/** Low-frequency supplemental reads; failures must not reset workspace access. */
import { useEffect, type Dispatch, type SetStateAction } from "react";
import { scheduleCompanionPoll } from "./companion-poll";
import {
  createRequestMeta,
  requireWorkspaceEpoch,
} from "../client/desktop-client";
import { buildCompanionRunTraces, mergeCompanionRunTraces, type CompanionRunTrace } from "./companion-agent-nodes";
import { desktopRouteFromAgentRoute } from "./companion-chat-routing";
import type { CompanionNavChip } from "./companion-chat-session";

/** 这两段轮询要驱动 Provider 的哪些动作。 */
export type CompanionPollDeps = {
  readonly conversation: { readonly id: string } | null;
  readonly mode: "closed" | "conversation" | "actions" | "history";
  readonly phase: "idle" | "loading" | "ready" | "sending" | "error";
  readonly followReviewContinuation?: boolean;
  /** agent 导航 route 轮询的游标（跨轮次保留，所以是 ref 而不是 state）。 */
  readonly routeCursorRef: { current: number | null };
  /** 收到新的导航 chip 就往 chip 行里塞。 */
  readonly pushNavChips: (chips: CompanionNavChip[]) => void;
  /** 过程留痕轮询的落点。 */
  readonly setRunTraces: Dispatch<SetStateAction<readonly CompanionRunTrace[]>>;
  /** A review decision requests a fresh run snapshot. */
  readonly tracesRevision: number;
  readonly historyRunIds?: readonly string[];
};

/** Supplemental reads share the API read quota with messages and review cards. */
const AGENT_ROUTE_POLL_INTERVAL_MS = 5_000;

export function useCompanionPolls(deps: CompanionPollDeps): void {
  const { conversation, mode, phase, routeCursorRef, pushNavChips, setRunTraces, tracesRevision, followReviewContinuation = false } = deps;
  const conversationId = conversation?.id;

  // ── agent 导航 route 轮询 ─────────────────────────────────────────────
  // 与抽屉同开同关：跳转 chip 只出现在抽屉里，常驻轮询没有必要。
  useEffect(() => {
    if (mode !== "history" || !conversationId) return;
    let cancelled = false;
    const poll = async () => {
      const epoch = await requireWorkspaceEpoch();
      if (cancelled) return;
      // 补白轮询**不能走 unwrapGatewayResult**（2026-09-19 用户实测）：它对任何
      // not-ok 都先 publishGateInvalidation 再 throw——`unsupported_contract`
      // （主进程/合同还没签发这两个新通道时）会把整个工作区视图打回首页默认
      // 态，catch 兜不住这个副作用。这里只读 result.ok，失败静默跳过。
      const result = await window.astella.companion.chat.listAgentRoutes({
        meta: createRequestMeta(epoch),
        request: {
          version: 1,
          conversationId,
          ...(routeCursorRef.current != null ? { afterSeq: routeCursorRef.current } : {}),
        },
      });
      if (cancelled) return;
      if (!result.ok) throw result.error;
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
    };
    const scheduled = scheduleCompanionPoll({ poll, intervalMs: AGENT_ROUTE_POLL_INTERVAL_MS, initialDelayMs: 0 });
    return () => {
      cancelled = true;
      scheduled.cancel();
    };
  }, [conversationId, mode, pushNavChips, routeCursorRef]);

  // ── 过程留痕轮询（2026-09-19） ────────────────────────────────────────
  // 跑在两个时刻：抽屉开着（要显示历史过程）与一轮正在跑（轨道要显示真实步数）。
  // 与 agent-routes 同一节奏的低频轮询，失败不打断聊天主链路——它是补白，不是主链路。
  const sending = phase === "sending";
  const runIdsKey = (deps.historyRunIds ?? []).join(",");
  useEffect(() => {
    if (!conversationId) return;
    if (mode !== "history" && !sending && !followReviewContinuation) return;
    let cancelled = false;
    let thinkingLoaded = false;
    let reading = false;
    const poll = async () => {
      if (reading) return;
      reading = true;
      try {
        const epoch = await requireWorkspaceEpoch();
        if (cancelled) return;
        const includeThinking = mode === "history" && !thinkingLoaded;
        const runIds = includeThinking && runIdsKey ? runIdsKey.split(",") : [];
        const batches = runIds.length ? Array.from({ length: Math.ceil(runIds.length / 100) }, (_, i) => runIds.slice(i * 100, (i + 1) * 100)) : [undefined];
        for (const batch of batches) {
        // 同上：补白轮询不走 unwrapGatewayResult，避免 not-ok 触发门禁全量重置。
        const result = await window.astella.companion.chat.listRunNodes({
          meta: createRequestMeta(epoch),
          request: { version: 1, conversationId, ...(includeThinking ? { includeThinking: true } : {}), ...(batch ? { runIds: batch } : {}) },
        });
        if (cancelled) return;
        if (!result.ok) throw result.error;
        const traces = buildCompanionRunTraces(result.data.runs, result.data.items);
        setRunTraces(current => mergeCompanionRunTraces(current, traces));
        }
        if (includeThinking) thinkingLoaded = true;
      } finally { reading = false; }
    };
    const scheduled = scheduleCompanionPoll({ poll, intervalMs: AGENT_ROUTE_POLL_INTERVAL_MS, initialDelayMs: 0 });
    return () => {
      cancelled = true;
      scheduled.cancel();
    };
  }, [conversationId, mode, sending, tracesRevision, setRunTraces, followReviewContinuation, runIdsKey]);
}
