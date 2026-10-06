// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import type { CompanionOnboardingStateV1 } from "@astella/shared/companion-shell-contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useRoomStore } from "../../../../app/room-store";
import { notifyCompanion } from "../../companion-notifications";
import { useCompanionGuide, type CompanionGuideController } from "../use-companion-guide";

const mockNotify = vi.mocked(notifyCompanion);
vi.mock("../../companion-notifications", () => ({
  notifyCompanion: vi.fn(),
  useCompanionNotifications: Object.assign(() => null, { getState: () => ({ remove: vi.fn() }) }),
}));

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const identity = { workspaceId: WORKSPACE, workspaceEpoch: 3, userId: "66666666-6666-4666-8666-666666666666",
  deploymentRef: "http://127.0.0.1:4000", name: "概率论", role: "owner" as const, isPersonal: true };
const fresh = (scope: "account" | "space"): CompanionOnboardingStateV1 => ({
  onboardingVersion: "companion-guide-v1", scope, revision: 1, offerStatus: "not_offered", visitedStepIds: [],
  updatedAt: new Date().toISOString(),
} as CompanionOnboardingStateV1);

let latest: CompanionGuideController | undefined;
function Probe({ decorative }: { decorative?: boolean }) {
  latest = useCompanionGuide(decorative);
  return null;
}

type Request = { scope: "account" | "space"; action: string; stepId?: string; topicId?: string };
/** 只演这条合同里真正被依赖的部分：一次性的邀请许可，和暂停令牌还在不在。 */
function serve(state: CompanionOnboardingStateV1, request: Request): CompanionOnboardingStateV1 {
  const next = { ...state, visitedStepIds: state.visitedStepIds ?? [], updatedAt: new Date().toISOString() } as CompanionOnboardingStateV1;
  if (request.action === "start" || request.action === "replay") {
    next.offerStatus = "offered";
    next.activeRun = { runId: "run-1", entryMode: request.action === "start" ? "first_run" : "manual_replay",
      runStatus: "in_progress", stepId: request.stepId ?? "room", topicId: request.topicId as never,
      resumeTokenRef: "token", resumeWorkspaceRef: WORKSPACE, expiresAt: new Date(Date.now() + 86_400_000).toISOString() } as never;
  } else if (request.action === "pause") {
    next.activeRun = { ...next.activeRun, runStatus: "paused", stepId: request.stepId ?? "room" } as never;
  } else if (request.action === "advance" || request.action === "resume") {
    next.activeRun = { ...next.activeRun, runStatus: "in_progress", stepId: request.stepId ?? "room" } as never;
  } else if (request.action === "skip" || request.action === "complete") {
    next.offerStatus = "consumed"; next.activeRun = undefined as never;
  }
  return next;
}

let signed = false;
/** @param rows 服务端已有的认识进度；缺哪一格就还没被邀请过。 */
function installApi(rows: Partial<Record<"account" | "space", CompanionOnboardingStateV1>> = {}) {
  const transitions: { scope: string; action: string; stepId?: string }[] = [];
  const states: Record<"account" | "space", CompanionOnboardingStateV1> = {
    account: rows.account ?? fresh("account"), space: rows.space ?? fresh("space"),
  };
  vi.stubGlobal("astella", {
    companion: { account: {
      getState: async () => ({ ok: true, data: { account: { revision: 1, epoch: 1, globalEnabled: true, diaryEnabled: true },
        onboardingStates: [states.account, states.space] } }),
      transitionOnboarding: async ({ request }: { request: Request }) => {
        transitions.push({ scope: request.scope, action: request.action, stepId: request.stepId });
        states[request.scope] = serve(states[request.scope], request);
        return { ok: true, data: { state: states[request.scope] } };
      },
    } },
    note: { list: async () => ({ ok: true, data: { total: 0, items: [] } }) },
    workspace: { getAiSettings: async () => ({ ok: true, data: { requiresConsent: true, consentVersion: signed ? "ai-consent-v1" : null,
      dataPolicy: { sendToExternal: true, sendImageContent: false, piiDetection: true, auditLogging: true } } }) },
  });
  return transitions;
}

beforeEach(() => {
  localStorage.clear(); signed = false;
  useRoomStore.setState({ spaceIdentity: identity, surface: null, destination: "room", masterMuted: true, hudPage: "home" });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); latest = undefined; mockNotify.mockReset(); });

it("walks a brand-new account into the tour instead of leaving an invitation to click", async () => {
  const transitions = installApi();
  render(<Probe />);
  await waitFor(() => expect(latest?.session?.topic).toBe("welcome"));
  await waitFor(() => expect(transitions).toEqual([
    { scope: "account", action: "start", stepId: "room" },
    { scope: "account", action: "advance", stepId: "room" },
  ]));
  expect(mockNotify).not.toHaveBeenCalled();
  expect(latest?.invitation).toBeNull();
});

it("holds the voice and names the missing consent instead of knocking on the gate each chapter", async () => {
  installApi();
  render(<Probe />);
  await waitFor(() => expect(latest?.session?.topic).toBe("welcome"));
  await waitFor(() => expect(latest?.consentNeeded).toBe(true));
});

it("takes the signed consent as the cue to take the same chapter back up", async () => {
  const transitions = installApi();
  render(<Probe />);
  await waitFor(() => expect(latest?.consentNeeded).toBe(true));
  latest!.openConsentSettings();
  latest!.pause();
  await waitFor(() => expect(useRoomStore.getState().surface).toBe("settings"));
  signed = true;
  useRoomStore.setState({ surface: null });
  await waitFor(() => expect(transitions).toContainEqual({ scope: "account", action: "resume", stepId: "room" }));
  expect(latest?.consentNeeded).toBe(false);
});

it("still lets an account that knows the system decide whether to be shown a new space", async () => {
  const transitions = installApi({ account: { ...fresh("account"), offerStatus: "consumed" } as CompanionOnboardingStateV1 });
  render(<Probe />);
  await waitFor(() => expect(mockNotify).toHaveBeenCalledOnce());
  expect(mockNotify.mock.calls[0][0].title).toBe("我们到「概率论」了");
  expect(transitions).toEqual([{ scope: "space", action: "start", stepId: "space" }]);
  expect(latest?.session).toBeNull();
});

it("never spends a one-shot invitation on a screen with no stage to show it on", async () => {
  const transitions = installApi();
  render(<Probe decorative />);
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(transitions).toEqual([]);
  expect(mockNotify).not.toHaveBeenCalled();
});
