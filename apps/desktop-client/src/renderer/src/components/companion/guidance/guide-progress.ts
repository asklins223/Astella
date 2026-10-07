import { COMPANION_GUIDE_VERSION, companionOnboardingStateV1Schema, type CompanionOnboardingStateV1, type OnboardingTransitionRequest, type CompanionOverview } from "@astella/shared/companion-shell-contracts";
import { createRequestMeta, unwrapGatewayResult } from "../../../app/desktop-client";
import type { SpaceIdentity } from "../../../app/room-store";

export type GuideScope = "account" | "space";
export type GuideIdentity = SpaceIdentity & { workspaceId: string; workspaceEpoch: number; userId: string; deploymentRef: string };
export function verifiedGuideIdentity(identity: SpaceIdentity | null): identity is GuideIdentity {
  return Boolean(identity?.workspaceId && identity.workspaceEpoch && identity.userId && identity.deploymentRef);
}
export function guideProgressKey(identity: GuideIdentity, scope: GuideScope) {
  return `astella.guide.v1:${encodeURIComponent(identity.deploymentRef)}:${identity.userId}:${scope === "space" ? identity.workspaceId : "account"}`;
}
type PendingProgress = { state: CompanionOnboardingStateV1; pending: boolean };
function readLocal(identity: GuideIdentity, scope: GuideScope): PendingProgress | null {
  try {
    const raw = JSON.parse(localStorage.getItem(guideProgressKey(identity, scope)) ?? "null");
    const parsed = companionOnboardingStateV1Schema.safeParse(raw?.state);
    return parsed.success ? { state: parsed.data, pending: raw.pending === true } : null;
  } catch { return null; }
}
function storeLocal(identity: GuideIdentity, scope: GuideScope, state: CompanionOnboardingStateV1, pending: boolean) {
  try { localStorage.setItem(guideProgressKey(identity, scope), JSON.stringify({ state, pending })); } catch { /* This session still remains readable. */ }
}
export function resumableGuide(state: CompanionOnboardingStateV1 | null, identity: GuideIdentity) {
  const run = state?.activeRun;
  return Boolean(run && (run.runStatus === "paused" || run.entryMode === "manual_replay" || state?.visitedStepIds?.length)
    && run.resumeWorkspaceRef === identity.workspaceId && Date.parse(run.expiresAt) > Date.now());
}
function optimisticTransition(state: CompanionOnboardingStateV1 | null, scope: GuideScope, identity: GuideIdentity, action: OnboardingTransitionRequest): CompanionOnboardingStateV1 {
  const now = new Date().toISOString();
  const next: CompanionOnboardingStateV1 = state ? { ...state, updatedAt: now } : {
    onboardingVersion: COMPANION_GUIDE_VERSION, scope, ...(scope === "space" ? { workspaceId: identity.workspaceId } : {}),
    revision: 0, offerStatus: "not_offered", updatedAt: now, visitedStepIds: [],
  };
  if (action.action === "start" || action.action === "replay") {
    if (next.offerStatus === "not_offered") next.offerStatus = "offered";
    next.activeRun = { runId: `local_${crypto.randomUUID()}`, entryMode: action.action === "start" ? "first_run" : "manual_replay", runStatus: "in_progress", stepId: action.stepId ?? "room", topicId: action.topicId, resumeTokenRef: "local", resumeWorkspaceRef: identity.workspaceId, expiresAt: new Date(Date.now() + 7 * 86400_000).toISOString() };
  } else if (action.action === "skip" || action.action === "complete") {
    if (next.offerStatus !== "consumed" && next.activeRun?.entryMode !== "manual_replay") {
      next.offerStatus = "consumed"; next.offerDisposition = action.action === "skip" ? "skipped" : "completed";
    }
    next.lastRun = { entryMode: next.activeRun?.entryMode ?? "first_run", disposition: action.action === "skip" ? "skipped" : "completed", at: now };
    next.activeRun = undefined;
  } else if (next.activeRun) {
    next.activeRun = { ...next.activeRun, stepId: action.stepId ?? next.activeRun.stepId,
      ...(action.topicId ? { topicId: action.topicId } : {}),
      runStatus: action.action === "pause" ? "paused" : "in_progress" };
  }
  return next;
}

/** One serial CAS lane per verified identity. Local pending reading positions never become learning facts. */
export class GuideProgressClient {
  private ident: GuideIdentity;
  get identity(): GuideIdentity { return this.ident; }
  /** 会话重核只换纪元：带路这一趟不该因此重开，但写请求必须带上最新的纪元。 */
  followEpoch(workspaceEpoch: number) { this.ident = { ...this.ident, workspaceEpoch }; }
  states: Record<GuideScope, CompanionOnboardingStateV1 | null> = { account: null, space: null };
  pending = false;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(identity: GuideIdentity) { this.ident = identity; }
  private async send(scope: GuideScope, request: OnboardingTransitionRequest) {
    const result = unwrapGatewayResult(await window.astella.companion.account.transitionOnboarding({
      meta: createRequestMeta(this.identity.workspaceEpoch), version: COMPANION_GUIDE_VERSION, request: { ...request, scope },
    }));
    this.states[scope] = result.state; storeLocal(this.identity, scope, result.state, false);
    return result;
  }
  async load(): Promise<{ overview: CompanionOverview | null }> {
    let overview: CompanionOverview | null = null;
    try { overview = unwrapGatewayResult(await window.astella.companion.account.getState({ meta: createRequestMeta(this.identity.workspaceEpoch) })); } catch { this.pending = true; }
    for (const scope of ["account", "space"] as const) {
      const remote = overview?.onboardingStates.find(state => state.onboardingVersion === COMPANION_GUIDE_VERSION
        && (state.scope ?? "account") === scope && (scope === "account" || state.workspaceId === this.identity.workspaceId)) ?? null;
      const local = readLocal(this.identity, scope);
      this.states[scope] = remote ?? local?.state ?? null;
      if (overview && local?.pending) {
        try {
          // Monotone invitation outcomes win; a remote terminal never rolls back on replay.
          if (local.state.offerStatus === "consumed" && remote?.offerStatus !== "consumed") {
            await this.send(scope, { action: local.state.offerDisposition === "skipped" ? "skip" : "complete", revision: remote?.revision });
          } else if (local.state.activeRun && (!remote?.activeRun || remote.activeRun.runId.startsWith("local_")
            || remote.revision <= local.state.revision)) {
            const stepId = local.state.activeRun.stepId;
            await this.send(scope, { action: "replay", revision: remote?.revision, stepId, topicId: local.state.activeRun.topicId });
            await this.send(scope, { action: "pause", revision: this.states[scope]!.revision, runId: this.states[scope]!.activeRun!.runId, stepId });
          } else if (!remote && local.state.offerStatus === "offered") {
            await this.send(scope, { action: "start", stepId: "room" });
          } else if (remote) storeLocal(this.identity, scope, remote, false);
        } catch { this.pending = true; this.states[scope] = remote?.offerStatus === "consumed" ? remote : local.state; }
      }
    }
    return { overview };
  }
  transition(scope: GuideScope, request: OnboardingTransitionRequest): Promise<{ state: CompanionOnboardingStateV1; won?: boolean }> {
    const operation = this.queue.then(async () => {
      const state = this.states[scope];
      const input: OnboardingTransitionRequest = { ...request, revision: state?.revision };
      if (["advance", "pause", "resume"].includes(request.action) || request.action === "complete" && state?.activeRun) {
        input.runId = state?.activeRun?.runId;
        if (request.action === "resume") input.resumeTokenRef = state?.activeRun?.resumeTokenRef;
      }
      try {
        const result = await this.send(scope, input); this.pending = false; return result;
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === "conflict") {
          const overview = unwrapGatewayResult(await window.astella.companion.account.getState({ meta: createRequestMeta(this.identity.workspaceEpoch) }));
          const remote = overview.onboardingStates.find(item => item.onboardingVersion === COMPANION_GUIDE_VERSION && (item.scope ?? "account") === scope);
          if (remote) { this.states[scope] = remote; storeLocal(this.identity, scope, remote, false); return { state: remote, won: false }; }
        }
        this.pending = true;
        const optimistic = optimisticTransition(state, scope, this.identity, request);
        this.states[scope] = optimistic; storeLocal(this.identity, scope, optimistic, true);
        return { state: optimistic };
      }
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }
}
