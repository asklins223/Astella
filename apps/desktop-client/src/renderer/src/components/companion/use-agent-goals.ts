import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentRunV1 } from "@ailearn/shared/agent-contracts";
import { createRequestMeta, gatewayErrorMessage, unwrapGatewayResult } from "../../app/desktop-client";
import { useRoomStore } from "../../app/room-store";
import { notifyCompanion } from "./companion-notifications";

export const agentGoalActive = (run: AgentRunV1) => ["queued", "running", "waiting"].includes(run.status);
export type AgentGoalsController = ReturnType<typeof useAgentGoals>;

/** Reads a projection only. Closing a bubble or journal never stops execution. */
export function useAgentGoals(chatPhase: string, onReady: (runId: string) => void) {
  const scope = useRoomStore(state => state.workspaceScopeRevision);
  const [snapshot, setSnapshot] = useState<{ scope: number; items: AgentRunV1[] }>({ scope, items: [] });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<string | null>(null);
  const sequence = useRef(0);
  const locked = useRef(false);
  const statuses = useRef(new Map<string, string>());
  const ready = useRef(onReady);
  ready.current = onReady;
  const current = () => useRoomStore.getState().workspaceScopeRevision === scope;

  const refresh = useCallback(async () => {
    const request = ++sequence.current;
    try {
      const api = window.ailearn?.agent;
      if (!api) return;
      const page = unwrapGatewayResult(await api.listRuns({ meta: createRequestMeta() }));
      if (!current() || request !== sequence.current) return;
      for (const run of page.items) {
        const key = `${run.runId}:${run.revision}`;
        const previous = statuses.current.get(key);
        if (previous && previous !== run.status && ["completed", "failed"].includes(run.status)) {
          notifyCompanion({ id: `agent:${key}:${run.status}`, kind: "task", scope, delivery: "when-idle",
            title: run.status === "completed" ? "交给我的事做好了" : run.artifacts.length ? "这件事有一部分没完成" : "这件事还没有完成",
            body: run.artifacts.length ? "做好的内容已留在对话手记里，方便时再看。" : "可以查看这件事的状态与下一步。",
            actions: [{ id: "open", label: "看看这件事", kind: "navigate", run: () => { if (current()) ready.current(run.runId); } }],
          });
        }
        statuses.current.set(key, run.status);
      }
      setSnapshot({ scope, items: page.items }); setError(null);
    } catch (cause) {
      if (current() && request === sequence.current) setError(gatewayErrorMessage(cause));
    } finally { if (current() && request === sequence.current) setLoading(false); }
  }, [scope]);

  useEffect(() => {
    ++sequence.current; locked.current = false; statuses.current.clear();
    setSnapshot({ scope, items: [] }); setPending(null); setError(null); setLoading(true);
    void refresh();
    const focus = () => { if (!document.hidden) void refresh(); };
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", focus);
    return () => { ++sequence.current; window.removeEventListener("focus", focus); document.removeEventListener("visibilitychange", focus); };
  }, [scope, refresh]);
  useEffect(() => { if (chatPhase !== "sending") void refresh(); }, [chatPhase, refresh]);
  const items = snapshot.scope === scope ? snapshot.items : [];
  const watching = items.some(run => agentGoalActive(run) || (run.status === "paused"
    && run.operations.some(operation => ["accepted", "running", "outcome_unknown"].includes(operation.status))));
  useEffect(() => {
    if (!watching) return;
    const timer = window.setInterval(() => { if (!document.hidden && !locked.current) void refresh(); }, 2_000);
    return () => window.clearInterval(timer);
  }, [watching, refresh]);

  const change = useCallback(async (run: AgentRunV1, action: "cancel" | "pause" | "resume" | { goal: string }) => {
    if (locked.current || !current()) return false;
    locked.current = true; ++sequence.current; setPending(run.runId); setError(null);
    try {
      const meta = createRequestMeta();
      const result = typeof action === "string"
        ? await window.ailearn.agent.controlRun({ meta, runId: run.runId, request: { expectedRevision: run.revision, action } })
        : await window.ailearn.agent.reviseRun({ meta, runId: run.runId, request: { expectedRevision: run.revision, goal: action.goal } });
      const updated = unwrapGatewayResult(result);
      if (!current()) return false;
      ++sequence.current;
      statuses.current.set(`${updated.runId}:${updated.revision}`, updated.status);
      setSnapshot(previous => ({ scope, items: [updated, ...previous.items.filter(item => item.runId !== updated.runId)] }));
      return true;
    } catch (cause) {
      if (current()) { await refresh(); if (current()) setError(`${gatewayErrorMessage(cause)} 请核对最新状态后重试。`); }
      return false;
    } finally { if (current()) { locked.current = false; setPending(null); } }
  }, [scope, refresh]);
  return { items, scope, error, loading, pending, refresh, change };
}
