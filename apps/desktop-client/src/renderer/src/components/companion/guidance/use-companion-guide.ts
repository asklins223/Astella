import { useCallback, useEffect, useRef, useState } from "react";
import type { DesktopNoteListItem } from "@ailearn/shared/desktop-surface-contracts";
import type { CompanionAccountStateV1 } from "@ailearn/shared/companion-shell-contracts";
import { createRequestMeta, gatewayErrorMessage, unwrapGatewayResult } from "../../../app/desktop-client";
import { useRoomStore } from "../../../app/room-store";
import { notifyCompanion, useCompanionNotifications } from "../companion-notifications";
import { COMPANION_ACCOUNT_CHANGED } from "../companion-events";
import { GUIDE_STEPS, GUIDE_TOPICS, openCompanionGuide, topicForStep, type GuideTopicId } from "./guide-definitions";
import { GuideProgressClient, resumableGuide, verifiedGuideIdentity, type GuideScope } from "./guide-progress";

export type GuideSession = { topic: GuideTopicId; index: number; scope: GuideScope };
export type GuideContents = { status: "loading" | "ready" | "error"; total: number | null; notes: readonly DesktopNoteListItem[]; failure?: string };
export function useCompanionGuide() {
  const identity = useRoomStore(state => state.spaceIdentity);
  const client = useRef<GuideProgressClient | null>(null);
  const generation = useRef(0);
  const [session, setSession] = useState<GuideSession | null>(null);
  const sessionRef = useRef(session); sessionRef.current = session;
  const [revision, setRevision] = useState(0);
  const [account, setAccount] = useState<CompanionAccountStateV1 | null>(null);
  const [invitation, setInvitation] = useState<GuideScope | null>(null);
  const [contents, setContents] = useState<GuideContents>({ status: "loading", total: null, notes: [] });
  const refresh = () => setRevision(value => value + 1);
  const save = useCallback((scope: GuideScope, action: Parameters<GuideProgressClient["transition"]>[1]) => {
    const adapter = client.current; if (!adapter) return;
    const currentGeneration = generation.current;
    void adapter.transition(scope, action).then(() => { if (currentGeneration === generation.current) refresh(); }).catch(() => {});
  }, []);
  const skip = useCallback(() => {
    const scope = invitation; if (!scope) return;
    setInvitation(null); save(scope, { action: "skip" });
    if (scope === "account") save("space", { action: "skip" });
    const adapter = client.current;
    if (adapter) useCompanionNotifications.getState().remove(`guide:invite:${adapter.identity.userId}:${adapter.identity.workspaceId}`);
  }, [invitation, save]);
  const reloadContents = useCallback(async () => {
    const adapter = client.current; if (!adapter) return;
    const currentGeneration = generation.current;
    setContents({ status: "loading", total: null, notes: [] });
    try {
      const result = unwrapGatewayResult(await window.ailearn.note.list({ meta: createRequestMeta(adapter.identity.workspaceEpoch), limit: 3 }));
      if (currentGeneration === generation.current) setContents({ status: "ready", total: result.total, notes: result.items });
    } catch (error) {
      if (currentGeneration === generation.current) setContents({ status: "error", total: null, notes: [], failure: gatewayErrorMessage(error) });
    }
  }, []);
  useEffect(() => {
    if (!verifiedGuideIdentity(identity) || !window.ailearn) return;
    setSession(null); setInvitation(null); setAccount(null);
    const adapter = new GuideProgressClient(identity); client.current = adapter;
    const currentGeneration = ++generation.current;
    let inviteId: string | null = null;
    const initialize = async () => {
      const { overview } = await adapter.load();
      if (currentGeneration !== generation.current) return;
      setAccount(overview?.account ?? null);
      refresh();
      const legacy = overview?.onboardingStates.some(state => state.onboardingVersion !== "companion-guide-v1" && state.offerStatus !== "not_offered");
      const account = adapter.states.account;
      const scope: GuideScope | null = (!legacy && (!account || account.offerStatus === "not_offered")) ? "account"
        : (!adapter.states.space || adapter.states.space.offerStatus === "not_offered") ? "space" : null;
      if (!scope) return;
      const result = await adapter.transition(scope, { action: "start", stepId: scope === "account" ? "room" : "space", topicId: scope === "account" ? "welcome" : "space" });
      if (currentGeneration !== generation.current || result.won === false || result.state.offerStatus === "consumed") return;
      setInvitation(scope); refresh();
      inviteId = `guide:invite:${identity.userId}:${identity.workspaceId}`;
      notifyCompanion({ id: inviteId, kind: "help", title: scope === "account" ? "欢迎来到书房" : `我们到「${identity.name}」了`,
        body: scope === "account" ? "我可以陪你整理材料、读懂笔记，也能帮你做具体的事。一起看看从哪里开始？"
          : identity.role === "member" ? "这里的共享内容可以阅读；回想与学习记录属于你自己。一起找到一个起点？" : "先看看这里的内容，安顿好后，再挑一篇开始。",
        source: "伴星带路", scope: useRoomStore.getState().workspaceScopeRevision, delivery: "when-idle",
        actions: [
          { id: "start", label: scope === "account" ? "带我看看" : "带我认识这里", kind: "navigate", run: () => openCompanionGuide(scope === "account" ? "welcome" : "space") },
          { id: "explore", label: "我先自己探索", kind: "cancel", run: () => {
            setInvitation(null); save(scope, { action: "skip" }); if (scope === "account") save("space", { action: "skip" });
          } },
        ],
      });
    };
    void initialize().catch(() => {}); void reloadContents();
    const reconcile = () => { void adapter.load().then(({ overview }) => { if (currentGeneration === generation.current) { setAccount(overview?.account ?? null); refresh(); } }); };
    window.addEventListener(COMPANION_ACCOUNT_CHANGED, reconcile);
    window.addEventListener("online", reconcile);
    return () => {
      generation.current++;
      const active = sessionRef.current;
      if (active) {
        const topic = GUIDE_TOPICS.find(item => item.id === active.topic)!;
        void adapter.transition(active.scope, { action: "pause", stepId: topic.steps[active.index] }).catch(() => {});
      }
      if (inviteId) useCompanionNotifications.getState().remove(inviteId);
      useRoomStore.getState().setCompanionGuideOpen(false);
    };
  }, [identity?.userId, identity?.deploymentRef, identity?.workspaceId, identity?.workspaceEpoch, reloadContents, save]);

  const start = useCallback((topic: GuideTopicId, resume = false) => {
    const adapter = client.current;
    const scope: GuideScope = topic === "space" ? "space" : "account";
    const definition = GUIDE_TOPICS.find(item => item.id === topic)!;
    const stored = adapter?.states[scope];
    const canResume = adapter && resumableGuide(stored ?? null, adapter.identity);
    const stepId = resume && canResume ? stored!.activeRun!.stepId : definition.steps[0];
    const index = Math.max(0, definition.steps.indexOf(stepId as typeof definition.steps[number]));
    sessionRef.current = { topic, index, scope };
    setSession({ topic, index, scope }); setInvitation(null);
    if (adapter) useCompanionNotifications.getState().remove(`guide:invite:${adapter.identity.userId}:${adapter.identity.workspaceId}`);
    save(scope, { action: resume && canResume ? "resume" : stored?.activeRun?.entryMode === "first_run" && invitation === scope ? "advance" : "replay", stepId, topicId: topic });
  }, [invitation, save]);
  const pause = useCallback(() => {
    const current = sessionRef.current; if (!current) return;
    const topic = GUIDE_TOPICS.find(item => item.id === current.topic)!;
    save(current.scope, { action: "pause", stepId: topic.steps[current.index] });
    sessionRef.current = null; setSession(null);
  }, [save]);
  const next = useCallback((direction: number) => {
    const current = sessionRef.current; if (!current) return;
    const topic = GUIDE_TOPICS.find(item => item.id === current.topic)!;
    const index = current.index + direction;
    if (index >= topic.steps.length) {
      save(current.scope, { action: "complete" });
      if (current.topic === "welcome") {
        const space = client.current?.states.space;
        if (!space || space.offerStatus !== "consumed") save("space", { action: "complete" });
      }
      sessionRef.current = null; setSession(null); return;
    }
    if (index < 0) return;
    sessionRef.current = { ...current, index };
    setSession({ ...current, index }); save(current.scope, { action: "advance", stepId: topic.steps[index], topicId: current.topic });
  }, [save]);
  const end = useCallback(() => {
    const current = sessionRef.current; if (!current) return;
    save(current.scope, { action: "complete" }); sessionRef.current = null; setSession(null);
  }, [save]);
  const resumeState = client.current && (["space", "account"] as const).map(scope => ({ scope, state: client.current!.states[scope] }))
    .find(item => resumableGuide(item.state, client.current!.identity));
  const resume = resumeState ? { topic: resumeState.scope === "space" ? "space" as const : resumeState.state!.activeRun!.topicId ?? topicForStep(resumeState.state!.activeRun!.stepId), step: GUIDE_STEPS[resumeState.state!.activeRun!.stepId as keyof typeof GUIDE_STEPS]?.title ?? "继续带看" } : null;
  return { identity, account, session, invitation, contents, start, skip, pause, next, end, resume, reloadContents, pending: client.current?.pending ?? false, revision };
}
export type CompanionGuideController = ReturnType<typeof useCompanionGuide>;
