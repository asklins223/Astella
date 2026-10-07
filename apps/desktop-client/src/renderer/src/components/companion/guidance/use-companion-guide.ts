import { useCallback, useEffect, useRef, useState } from "react";
import type { DesktopNoteListItem } from "@astella/shared/desktop-surface-contracts";
import type { CompanionAccountStateV1 } from "@astella/shared/companion-shell-contracts";
import { createRequestMeta, gatewayErrorMessage, unwrapGatewayResult } from "../../../app/desktop-client";
import { companionConsentGate, SETTINGS_ATTENTION_AI_CONSENT, SETTINGS_SECTION_AI_CONSENT } from "../../../app/companion-consent-gate";
import { useRoomStore } from "../../../app/room-store";
import { notifyCompanion, useCompanionNotifications } from "../companion-notifications";
import { COMPANION_ACCOUNT_CHANGED } from "../companion-events";
import { GUIDE_STEPS, GUIDE_TOPICS, openCompanionGuide, topicForStep, type GuideTopicId } from "./guide-definitions";
import { GuideProgressClient, resumableGuide, verifiedGuideIdentity, type GuideScope } from "./guide-progress";

export type GuideSession = { topic: GuideTopicId; index: number; scope: GuideScope };
export type GuideContents = { status: "loading" | "ready" | "error"; total: number | null; notes: readonly DesktopNoteListItem[]; failure?: string };
/**
 * 伴星带路的控制器。`decorative` 是首次那张纸上还没有可操作空间时的装饰岛：
 * 那里没有带路舞台，一次邀请都不该发出去——账号与空间的初次认识是**一次性许可**，
 * 被看不见的带路消费掉就再也没有了。
 */
export function useCompanionGuide(decorative = false) {
  const identity = useRoomStore(state => state.spaceIdentity);
  const client = useRef<GuideProgressClient | null>(null);
  const generation = useRef(0);
  const [session, setSession] = useState<GuideSession | null>(null);
  const sessionRef = useRef(session); sessionRef.current = session;
  const [revision, setRevision] = useState(0);
  const [account, setAccount] = useState<CompanionAccountStateV1 | null>(null);
  const [invitation, setInvitation] = useState<GuideScope | null>(null);
  /** 邀请的同步副本：自动开始要在同一次调用里判定「这一步是不是初次邀请推进的」。 */
  const invitationRef = useRef<GuideScope | null>(null);
  const offer = (scope: GuideScope | null) => { invitationRef.current = scope; setInvitation(scope); };
  /** 同意状态：没读出来之前带路不出声也不发合成——"最坏撞一次"实测是撞三四次。 */
  const [consent, setConsent] = useState<"unknown" | "required" | "granted">("unknown");
  const [contents, setContents] = useState<GuideContents>({ status: "loading", total: null, notes: [] });
  const refresh = () => setRevision(value => value + 1);
  const save = useCallback((scope: GuideScope, action: Parameters<GuideProgressClient["transition"]>[1]) => {
    const adapter = client.current; if (!adapter) return;
    const currentGeneration = generation.current;
    void adapter.transition(scope, action).then(() => { if (currentGeneration === generation.current) refresh(); }).catch(() => {});
  }, []);
  const skip = useCallback(() => {
    const scope = invitation; if (!scope) return;
    offer(null); save(scope, { action: "skip" });
    if (scope === "account") save("space", { action: "skip" });
    const adapter = client.current;
    if (adapter) useCompanionNotifications.getState().remove(`guide:invite:${adapter.identity.userId}:${adapter.identity.workspaceId}`);
  }, [invitation, save]);
  const reloadContents = useCallback(async () => {
    const adapter = client.current; if (!adapter) return;
    const currentGeneration = generation.current;
    setContents({ status: "loading", total: null, notes: [] });
    try {
      const result = unwrapGatewayResult(await window.astella.note.list({ meta: createRequestMeta(adapter.identity.workspaceEpoch), limit: 3 }));
      if (currentGeneration === generation.current) setContents({ status: "ready", total: result.total, notes: result.items });
    } catch (error) {
      if (currentGeneration === generation.current) setContents({ status: "error", total: null, notes: [], failure: gatewayErrorMessage(error) });
    }
  }, []);
  /**
   * 带路出声前的同意预读。读不到不拦：服务端那道门仍然生效，失败侧的说明仍然给。
   * 预读的意义不是替服务端做决定，而是别让整个带路每一步都去撞同一记 403。
   */
  const readConsent = useCallback(async () => {
    const adapter = client.current; if (!adapter) return false;
    try {
      const settings = unwrapGatewayResult(await window.astella.workspace.getAiSettings({ meta: createRequestMeta(adapter.identity.workspaceEpoch) }));
      const needed = companionConsentGate(settings) === "consent_required";
      setConsent(needed ? "required" : "granted"); return needed;
    // 读不到时留在 unknown（不出声也不撞门），而不是当成"已同意"。
    } catch { setConsent("unknown"); return false; }
  }, []);
  const start = useCallback((topic: GuideTopicId, resume = false) => {
    const adapter = client.current;
    const scope: GuideScope = topic === "space" ? "space" : "account";
    const definition = GUIDE_TOPICS.find(item => item.id === topic)!;
    const stored = adapter?.states[scope];
    const canResume = adapter && resumableGuide(stored ?? null, adapter.identity);
    const stepId = resume && canResume ? stored!.activeRun!.stepId : definition.steps[0];
    const index = Math.max(0, definition.steps.indexOf(stepId as typeof definition.steps[number]));
    const fromInvite = invitationRef.current === scope && stored?.activeRun?.entryMode === "first_run";
    sessionRef.current = { topic, index, scope };
    setSession({ topic, index, scope }); offer(null);
    void readConsent();
    if (adapter) useCompanionNotifications.getState().remove(`guide:invite:${adapter.identity.userId}:${adapter.identity.workspaceId}`);
    save(scope, { action: resume && canResume ? "resume" : fromInvite ? "advance" : "replay", stepId, topicId: topic });
  }, [save, readConsent]);
  /** 从设置页回来（没被重挂的那种）就把同意重新读一次，第一站才知道能不能放行。 */
  useEffect(() => {
    const unsub = useRoomStore.subscribe((state, prev) => {
      if (state.surface === null && prev.surface === "settings") void readConsent();
    });
    return unsub;
  }, [readConsent]);
  const openConsentSettings = useCallback(() => {
    const room = useRoomStore.getState();
    room.setSettingsSection(SETTINGS_SECTION_AI_CONSENT);
    room.setSettingsAttention(SETTINGS_ATTENTION_AI_CONSENT);
    room.invoke("open-settings");
  }, []);
  useEffect(() => {
    if (!verifiedGuideIdentity(identity) || !window.astella) return;
    setSession(null); offer(null); setAccount(null); setConsent("unknown");
    const adapter = new GuideProgressClient(identity); client.current = adapter;
    const currentGeneration = ++generation.current;
    let inviteId: string | null = null;
    const initialize = async () => {
      const { overview } = await adapter.load();
      if (currentGeneration !== generation.current) return;
      setAccount(overview?.account ?? null);
      refresh();
      const account = adapter.states.account;
      // 第一站就是「开声音」。没开就走下去、之后又回来（含整棵重挂）时，服务端还记着
      // 停在 voice——那就不需要任何"交接"：重新站回这一站即可，也不该再写一次服务器。
      if (!decorative && account?.offerStatus !== "consumed" && account?.activeRun?.stepId === "voice" && account.activeRun.entryMode === "first_run") {
        sessionRef.current = { topic: "welcome", index: 0, scope: "account" };
        setSession(sessionRef.current); offer(null); void readConsent();
        return;
      }
      const legacy = overview?.onboardingStates.some(state => state.onboardingVersion !== "companion-guide-v1" && state.offerStatus !== "not_offered");
      // 新账号的第一间书房本来就并在这趟带路里：账号那一趟还没走完，就不再另起一次空间邀请。
      const accountInFlight = Boolean(account && account.offerStatus !== "consumed");
      const scope: GuideScope | null = (!legacy && (!account || account.offerStatus === "not_offered")) ? "account"
        : (!accountInFlight && (!adapter.states.space || adapter.states.space.offerStatus === "not_offered")) ? "space" : null;
      if (!scope || decorative) return;
      const result = await adapter.transition(scope, { action: "start", stepId: scope === "account" ? "voice" : "space", topicId: scope === "account" ? "welcome" : "space" });
      if (currentGeneration !== generation.current || result.won === false || result.state.offerStatus === "consumed") return;
      offer(scope); refresh();
      // 第一次认识系统不再等一次点击：欢迎直接接上连贯带路，伴星旁的第一段讲解就是起点。
      if (scope === "account") { start("welcome"); return; }
      inviteId = `guide:invite:${identity.userId}:${identity.workspaceId}`;
      notifyCompanion({ id: inviteId, kind: "help", title: `我们到「${identity.name}」了`,
        body: identity.role === "member" ? "这里的共享内容可以阅读；回想与学习记录属于你自己。一起找到一个起点？" : "先看看这里的内容，安顿好后，再挑一篇开始。",
        source: "伴星带路", scope: useRoomStore.getState().workspaceScopeRevision, delivery: "when-idle",
        actions: [
          { id: "start", label: "带我认识这里", kind: "navigate", run: () => openCompanionGuide("space") },
          { id: "explore", label: "我先自己探索", kind: "cancel", run: () => {
            offer(null); save(scope, { action: "skip" });
          } },
        ],
      });
    };
    // 这条链一旦抛异常，首次带路就"什么都没发生"，而且哪儿都查不到——所以留下这一行。
    void initialize().catch((error) => { console.warn("[companion-guide] first-run init failed", error); }); void reloadContents();
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
  // `workspaceEpoch` 不在依赖里：它只是请求边界，门禁每重核一次会话就换一个号。
  // 把它当身份变化，会让整段初始化在离开设置页那种时刻重跑，正在走的带路被清空、
  // 载入结果又被下一次的 generation 判掉，谁都接不回来（2026-10-07 真窗口插桩看到的就是这个）。
  }, [identity?.userId, identity?.deploymentRef, identity?.workspaceId, decorative, reloadContents, save, start]);
  useEffect(() => {
    if (client.current && identity?.workspaceEpoch) client.current.followEpoch(identity.workspaceEpoch);
  }, [identity?.workspaceEpoch]);
  const pause = useCallback(() => {
    const current = sessionRef.current;
    if (!current) return;
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
  return { identity, account, session, invitation, contents, consent, openConsentSettings, start, skip, pause, next, end, resume, reloadContents, pending: client.current?.pending ?? false, revision };
}
export type CompanionGuideController = ReturnType<typeof useCompanionGuide>;
