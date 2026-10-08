import { useCallback, useEffect, useRef, useState } from "react";
import type { DesktopNoteListItem } from "@astella/shared/desktop-surface-contracts";
import type { CompanionAccountStateV1 } from "@astella/shared/companion-shell-contracts";
import { AI_CONSENT_VERSION } from "@astella/shared/desktop-ipc-contracts";
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
  const consentRef = useRef(consent);
  const [consentLoading, setConsentLoading] = useState(false);
  const [consentSaving, setConsentSaving] = useState(false);
  const [consentError, setConsentError] = useState<string | null>(null);
  const consentRead = useRef(0);
  const consentWrite = useRef(false);
  const pendingStart = useRef<{ scope: GuideScope; action: "resume" | "advance" | "replay"; stepId: string; topicId: GuideTopicId } | null>(null);
  const updateConsent = (value: typeof consent) => { consentRef.current = value; setConsent(value); };
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
  /** 协议先于整个带看。读失败留在协议纸页；过期账号或请求的回执不接管当前状态。 */
  const readConsent = useCallback(async () => {
    const adapter = client.current; if (!adapter) return null;
    const currentGeneration = generation.current, request = ++consentRead.current;
    const current = () => currentGeneration === generation.current && adapter === client.current && request === consentRead.current;
    setConsentLoading(true); setConsentError(null);
    try {
      const settings = unwrapGatewayResult(await window.astella.workspace.getAiSettings({ meta: createRequestMeta(adapter.identity.workspaceEpoch) }));
      if (!current()) return null;
      const needed = companionConsentGate(settings) !== null;
      updateConsent(needed ? "required" : "granted"); return needed;
    } catch (error) {
      if (current()) { updateConsent("unknown"); setConsentError(gatewayErrorMessage(error)); }
      return null;
    } finally { if (current()) setConsentLoading(false); }
  }, []);
  const start = useCallback((topic: GuideTopicId, resume = false) => {
    const adapter = client.current;
    if (!adapter || consentWrite.current) return;
    const scope: GuideScope = topic === "space" ? "space" : "account";
    const definition = GUIDE_TOPICS.find(item => item.id === topic)!;
    const stored = adapter?.states[scope];
    const canResume = adapter && resumableGuide(stored ?? null, adapter.identity);
    const storedStep = resume && canResume ? stored!.activeRun!.stepId : definition.steps[0];
    const index = Math.max(0, definition.steps.indexOf(storedStep as typeof definition.steps[number]));
    const stepId = definition.steps[index];
    const fromInvite = invitationRef.current === scope && stored?.activeRun?.entryMode === "first_run";
    sessionRef.current = { topic, index, scope };
    setSession(sessionRef.current); offer(null);
    updateConsent("unknown");
    const selected = sessionRef.current;
    if (adapter) useCompanionNotifications.getState().remove(`guide:invite:${adapter.identity.userId}:${adapter.identity.workspaceId}`);
    const entry = { scope, action: resume && canResume ? "resume" as const : fromInvite ? "advance" as const : "replay" as const, stepId, topicId: topic };
    pendingStart.current = entry;
    void readConsent().then(needed => {
      if (sessionRef.current !== selected || adapter !== client.current) return;
      if (needed === null) return;
      pendingStart.current = null;
      save(scope, { ...entry, stepId: needed ? "voice" : stepId });
    });
  }, [save, readConsent]);
  /** 核对期间暂停不覆盖原来读到的章节；新的一趟仍停在协议前置位置。 */
  const checkpoint = useCallback((active: GuideSession) => {
    const entry = pendingStart.current;
    const topic = GUIDE_TOPICS.find(item => item.id === active.topic)!;
    const stepId = consentRef.current === "required" || consentRef.current === "unknown" && entry?.action !== "resume" ? "voice" : topic.steps[active.index];
    if (entry) save(entry.scope, { ...entry, stepId });
    pendingStart.current = null;
    return stepId;
  }, [save]);
  const enterTour = useCallback(() => {
    const active = sessionRef.current;
    if (!active || consentRef.current !== "granted") return;
    const topic = GUIDE_TOPICS.find(item => item.id === active.topic)!;
    save(active.scope, { action: "advance", stepId: topic.steps[active.index], topicId: active.topic });
  }, [save]);
  const retryConsent = useCallback(async () => {
    if (consentWrite.current) return;
    if (await readConsent() === false) enterTour();
  }, [readConsent, enterTour]);
  const signConsent = useCallback(async () => {
    const adapter = client.current;
    if (!adapter || consentWrite.current || consentRef.current !== "required") return;
    const currentGeneration = generation.current;
    consentWrite.current = true; setConsentSaving(true); setConsentError(null);
    // 取消仍在路上的预读，避免它用签署前的快照覆盖成功回执。
    ++consentRead.current;
    try {
      const response = await window.astella.workspace.updateAiConsent({
        meta: createRequestMeta(adapter.identity.workspaceEpoch), consentVersion: AI_CONSENT_VERSION,
      });
      if (currentGeneration !== generation.current || adapter !== client.current) return;
      const settings = unwrapGatewayResult(response);
      if (settings.consentVersion !== AI_CONSENT_VERSION) {
        setConsentError("暂时没有确认签署结果，请重试。"); return;
      }
      if (!settings.dataPolicy.sendToExternal) {
        setConsentError("外部 AI 尚未开启，请重试或在 AI 数据同意页开启外发。"); return;
      }
      if (response.workspaceEpoch) adapter.followEpoch(response.workspaceEpoch);
      updateConsent("granted"); enterTour();
    } catch (error) {
      if (currentGeneration === generation.current && adapter === client.current) setConsentError(gatewayErrorMessage(error));
    } finally {
      if (currentGeneration === generation.current && adapter === client.current) {
        consentWrite.current = false; setConsentSaving(false); setConsentLoading(false);
      }
    }
  }, [enterTour]);
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
    sessionRef.current = null; setSession(null); offer(null); setAccount(null); updateConsent("unknown");
    setConsentError(null); setConsentLoading(false); setConsentSaving(false); consentWrite.current = false;
    client.current = null;
    pendingStart.current = null;
    if (!verifiedGuideIdentity(identity) || !window.astella) return;
    const adapter = new GuideProgressClient(identity); client.current = adapter;
    const currentGeneration = ++generation.current;
    let inviteId: string | null = null;
    const initialize = async () => {
      const { overview } = await adapter.load();
      if (currentGeneration !== generation.current) return;
      setAccount(overview?.account ?? null);
      refresh();
      const account = adapter.states.account;
      // voice 是已持久化的协议前置位置。重挂后继续阅读，已签署时直接进入书房第一站。
      if (!decorative && account?.offerStatus !== "consumed" && account?.activeRun?.stepId === "voice" && account.activeRun.runStatus === "in_progress" && account.activeRun.entryMode === "first_run") {
        sessionRef.current = { topic: "welcome", index: 0, scope: "account" };
        setSession(sessionRef.current); offer(null);
        void readConsent().then(needed => { if (needed === false) enterTour(); });
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
        void adapter.transition(active.scope, { action: "pause", stepId: checkpoint(active) }).catch(() => {});
      }
      if (inviteId) useCompanionNotifications.getState().remove(inviteId);
      useRoomStore.getState().setCompanionGuideOpen(false);
    };
  // `workspaceEpoch` 不在依赖里：它只是请求边界，门禁每重核一次会话就换一个号。
  // 把它当身份变化，会让整段初始化在离开设置页那种时刻重跑，正在走的带路被清空、
  // 载入结果又被下一次的 generation 判掉，谁都接不回来（2026-10-07 真窗口插桩看到的就是这个）。
  }, [identity?.userId, identity?.deploymentRef, identity?.workspaceId, decorative, reloadContents, save, start, readConsent, enterTour, checkpoint]);
  useEffect(() => {
    if (client.current && identity?.workspaceEpoch) client.current.followEpoch(identity.workspaceEpoch);
  }, [identity?.workspaceEpoch]);
  const pause = useCallback(() => {
    if (consentWrite.current) return;
    const current = sessionRef.current;
    if (!current) return;
    save(current.scope, { action: "pause", stepId: checkpoint(current) });
    sessionRef.current = null; setSession(null);
  }, [save, checkpoint]);
  const next = useCallback((direction: number) => {
    if (consentRef.current !== "granted") return;
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
    setSession(sessionRef.current); save(current.scope, { action: "advance", stepId: topic.steps[index], topicId: current.topic });
  }, [save]);
  const end = useCallback(() => {
    if (consentRef.current !== "granted") return;
    const current = sessionRef.current; if (!current) return;
    save(current.scope, { action: "complete" });
    if (current.topic === "welcome" && client.current?.states.space?.offerStatus !== "consumed") save("space", { action: "complete" });
    sessionRef.current = null; setSession(null);
  }, [save]);
  const resumeState = client.current && (["space", "account"] as const).map(scope => ({ scope, state: client.current!.states[scope] }))
    .find(item => resumableGuide(item.state, client.current!.identity));
  const resume = resumeState ? { topic: resumeState.scope === "space" ? "space" as const : resumeState.state!.activeRun!.topicId ?? topicForStep(resumeState.state!.activeRun!.stepId), step: GUIDE_STEPS[resumeState.state!.activeRun!.stepId as keyof typeof GUIDE_STEPS]?.title ?? "继续带看" } : null;
  return { identity, account, session, invitation, contents, consent, consentLoading, consentSaving, consentError, signConsent, retryConsent, openConsentSettings, start, skip, pause, next, end, resume, reloadContents, pending: client.current?.pending ?? false, revision };
}
export type CompanionGuideController = ReturnType<typeof useCompanionGuide>;
