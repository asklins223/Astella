// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { CompanionOnboardingStateV1 } from "@astella/shared/companion-shell-contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useRoomStore } from "../../../../app/room-store";
import { AI_CONSENT_VERSION } from "@astella/shared/desktop-ipc-contracts";
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
  ...(scope === "space" ? { workspaceId: WORKSPACE } : {}),
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
    next.offerStatus = "consumed"; next.offerDisposition = request.action === "skip" ? "skipped" : "completed"; next.activeRun = undefined as never;
  }
  return next;
}

let signed = false;
let aiReads = 0;
const aiSettings = () => ({ version: 1 as const, requiresConsent: true, consentVersion: signed ? AI_CONSENT_VERSION : null, consentAt: null,
  dataPolicy: { sendToExternal: true, sendImageContent: false, piiDetection: true, auditLogging: true } });
const updateConsent = vi.fn(async (_input?: { consentVersion: string; meta: { workspaceEpoch?: number } }) => { signed = true; return { ok: true, data: aiSettings() }; });
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
    workspace: { getAiSettings: vi.fn(async () => { aiReads += 1; return { ok: true, data: aiSettings() }; }),
      updateAiConsent: updateConsent },
  });
  return transitions;
}

beforeEach(() => {
  localStorage.clear(); signed = false; aiReads = 0; updateConsent.mockClear();
  useRoomStore.setState({ spaceIdentity: identity, surface: null, destination: "room", masterMuted: true, hudPage: "home" });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); latest = undefined; mockNotify.mockReset(); });

it("opens the consent prerequisite for a brand-new account instead of leaving an invitation to click", async () => {
  const transitions = installApi();
  render(<Probe />);
  await waitFor(() => expect(latest?.session?.topic).toBe("welcome"));
  await waitFor(() => expect(transitions).toEqual([
    { scope: "account", action: "start", stepId: "voice" },
    { scope: "account", action: "advance", stepId: "voice" },
  ]));
  expect(mockNotify).not.toHaveBeenCalled();
  expect(latest?.invitation).toBeNull();
});

it("holds the voice and names the missing consent instead of knocking on the gate each chapter", async () => {
  installApi();
  render(<Probe />);
  await waitFor(() => expect(latest?.session?.topic).toBe("welcome"));
  await waitFor(() => expect(latest?.consent).toBe("required"));
});


it("leaves a walk in progress alone when the gate re-verifies the session", async () => {
  const transitions = installApi();
  render(<Probe />);
  await waitFor(() => expect(latest?.consent).toBe("required"));
  await act(() => latest!.signConsent());
  act(() => latest!.next(1));
  await waitFor(() => expect(latest?.session?.index).toBe(1));
  const writes = transitions.length;
  // 门禁重核会话只换纪元。它不是"用户离开了带路"，一次重跑都不该发生。
  act(() => useRoomStore.setState({ spaceIdentity: { ...identity, workspaceEpoch: 4 } }));
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(latest?.session).toMatchObject({ topic: "welcome", index: 1 });
  expect(transitions).toHaveLength(writes);
});

it("stands back on the first station after a remount while the voice is still off", async () => {
  const stuck = serve(fresh("account"), { scope: "account", action: "start", stepId: "voice", topicId: "welcome" });
  const transitions = installApi({ account: stuck });
  const writes = transitions.length;
  render(<Probe />);
  await waitFor(() => expect(latest?.session).toMatchObject({ topic: "welcome", index: 0 }));
  expect(latest?.consent).toBe("required");
  // 站回来是本地的事：服务端早就记着停在 voice，不该再为它写一笔。
  expect(transitions).toHaveLength(writes);
});

it("does not start a second invitation while the first walk is still open", async () => {
  const walking = serve(fresh("account"), { scope: "account", action: "start", stepId: "room", topicId: "welcome" });
  const transitions = installApi({ account: walking });
  render(<Probe />);
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(transitions).toEqual([]);
  expect(mockNotify).not.toHaveBeenCalled();
  expect(latest?.session).toBeNull();
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


it("does not let navigation or completion bypass the consent prerequisite", async () => {
  const transitions = installApi(); render(<Probe />);
  await waitFor(() => expect(latest?.consent).toBe("required"));
  act(() => { latest!.next(3); latest!.next(1); latest!.end(); });
  expect(latest?.session?.index).toBe(0);
  expect(transitions.some(item => item.stepId === "reading" || item.action === "complete")).toBe(false);
});

it("signs the account agreement once and proceeds directly to the room chapter", async () => {
  const transitions = installApi(); render(<Probe />);
  await waitFor(() => expect(latest?.consent).toBe("required"));
  await act(async () => { await Promise.all([latest!.signConsent(), latest!.signConsent()]); });
  expect(updateConsent).toHaveBeenCalledOnce();
  expect(updateConsent.mock.calls[0]?.[0]).toMatchObject({ consentVersion: AI_CONSENT_VERSION, meta: { workspaceEpoch: 3 } });
  expect(latest?.consent).toBe("granted"); expect(latest?.session).toMatchObject({ topic: "welcome", index: 0 });
  await waitFor(() => expect(transitions.at(-1)).toEqual({ scope: "account", action: "advance", stepId: "room" }));
  expect(useRoomStore.getState().surface).toBeNull();
});

it("skips the prerequisite for an already signed account", async () => {
  signed = true; const transitions = installApi(); render(<Probe />);
  await waitFor(() => expect(latest?.consent).toBe("granted"));
  await waitFor(() => expect(transitions.at(-1)?.stepId).toBe("room"));
  expect(updateConsent).not.toHaveBeenCalled();
});

it("keeps a failed signature retryable and never grants permission optimistically", async () => {
  installApi(); updateConsent.mockRejectedValueOnce(new Error("签署服务暂时不可用")); render(<Probe />);
  await waitFor(() => expect(latest?.consent).toBe("required"));
  await act(() => latest!.signConsent());
  expect(latest?.consent).toBe("required"); expect(latest?.consentError).toBeTruthy(); expect(latest?.consentSaving).toBe(false);
  await act(() => latest!.signConsent());
  expect(latest?.consent).toBe("granted"); expect(latest?.consentError).toBeNull();
});

it("shows a read failure and can recover without restarting the guide", async () => {
  installApi();
  vi.mocked(window.astella.workspace.getAiSettings).mockRejectedValueOnce(new Error("同意状态暂时不可用"));
  render(<Probe />); await waitFor(() => expect(latest?.consentError).toBeTruthy());
  expect(latest?.consent).toBe("unknown"); expect(latest?.consentLoading).toBe(false);
  await act(() => latest!.retryConsent());
  expect(latest?.consent).toBe("required"); expect(latest?.consentError).toBeNull();
});

it("does not reopen a consent paper that the user explicitly paused", async () => {
  const state = serve(serve(fresh("account"), { scope: "account", action: "start", stepId: "voice", topicId: "welcome" }),
    { scope: "account", action: "pause", stepId: "voice" });
  const transitions = installApi({ account: state }); render(<Probe />);
  await waitFor(() => expect(latest?.account).toBeTruthy());
  expect(latest?.session).toBeNull(); expect(latest?.resume?.step).toBe("AI 使用协议"); expect(transitions).toEqual([]);
});

it("resumes a paused prerequisite at the first real chapter when consent was already signed", async () => {
  signed = true;
  const state = serve(serve(fresh("account"), { scope: "account", action: "start", stepId: "voice", topicId: "welcome" }),
    { scope: "account", action: "pause", stepId: "voice" });
  const transitions = installApi({ account: state }); render(<Probe />);
  await waitFor(() => expect(latest?.resume?.step).toBe("AI 使用协议"));
  act(() => latest!.start("welcome", true));
  await waitFor(() => expect(latest?.consent).toBe("granted"));
  await waitFor(() => expect(transitions.at(-1)).toEqual({ scope: "account", action: "resume", stepId: "room" }));
  expect(latest?.session).toMatchObject({ topic: "welcome", index: 0 });
  expect(updateConsent).not.toHaveBeenCalled();
});

it("ignores a signature arriving after the account changed", async () => {
  installApi();
  let finish!: (value: Awaited<ReturnType<typeof updateConsent>>) => void;
  updateConsent.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  render(<Probe />); await waitFor(() => expect(latest?.consent).toBe("required"));
  let writing!: Promise<void>;
  act(() => { writing = latest!.signConsent(); });
  act(() => useRoomStore.setState({ spaceIdentity: { ...identity, userId: "77777777-7777-4777-8777-777777777777" } }));
  await waitFor(() => expect(latest?.consent).toBe("required"));
  await act(async () => { finish({ ok: true, data: { ...aiSettings(), consentVersion: AI_CONSENT_VERSION } }); await writing; });
  expect(latest?.consent).toBe("required"); expect(latest?.consentSaving).toBe(false);
});

it("records the first real chapter after a delayed read of an existing signature", async () => {
  signed = true; const transitions = installApi();
  let finish!: (value: Awaited<ReturnType<typeof window.astella.workspace.getAiSettings>>) => void;
  vi.mocked(window.astella.workspace.getAiSettings).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  render(<Probe />);
  await waitFor(() => expect(latest?.consentLoading).toBe(true));
  await act(async () => { finish({ version: 1, ok: true, data: { ...aiSettings(), version: 1 },
    requestId: "consent-read", correlationId: "consent-read", schemaRevision: "desktop-ipc-v1" }); });
  await waitFor(() => expect(transitions.at(-1)?.stepId).toBe("room"));
  expect(latest?.consent).toBe("granted");
});

it("stays on the prerequisite when the signature response has no signed version", async () => {
  installApi(); updateConsent.mockResolvedValueOnce({ ok: true, data: { ...aiSettings(), requiresConsent: false } });
  render(<Probe />); await waitFor(() => expect(latest?.consent).toBe("required"));
  await act(() => latest!.signConsent());
  expect(latest?.consent).toBe("required"); expect(latest?.consentError).toBeTruthy();
});

it("drops the previous user's tour when the verified identity disappears", async () => {
  installApi(); render(<Probe />); await waitFor(() => expect(latest?.consent).toBe("required"));
  act(() => useRoomStore.setState({ spaceIdentity: null }));
  expect(latest?.session).toBeNull(); expect(latest?.consent).toBe("unknown");
});

it("ends the first walk for both the account and its first space", async () => {
  signed = true; const transitions = installApi();
  const { unmount } = render(<Probe />);
  await waitFor(() => expect(latest?.consent).toBe("granted"));
  act(() => latest!.end());
  await waitFor(() => expect(transitions.filter(item => item.action === "complete")).toEqual([
    { scope: "account", action: "complete" }, { scope: "space", action: "complete" },
  ]));
  unmount(); render(<Probe />);
  await waitFor(() => expect(latest?.account).toBeTruthy());
  expect(latest?.session).toBeNull(); expect(mockNotify).not.toHaveBeenCalled();
});

it("preserves the existing chapter when paused during consent verification", async () => {
  signed = true;
  const state = serve(serve(fresh("account"), { scope: "account", action: "start", stepId: "notes", topicId: "welcome" }),
    { scope: "account", action: "pause", stepId: "notes" });
  const transitions = installApi({ account: state });
  let finish!: (value: Awaited<ReturnType<typeof window.astella.workspace.getAiSettings>>) => void;
  vi.mocked(window.astella.workspace.getAiSettings).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  render(<Probe />); await waitFor(() => expect(latest?.resume).toBeTruthy());
  act(() => latest!.start("welcome", true)); await waitFor(() => expect(latest?.consentLoading).toBe(true));
  expect(transitions).toEqual([]);
  act(() => latest!.pause());
  await waitFor(() => expect(transitions.at(-1)).toEqual({ scope: "account", action: "pause", stepId: "notes" }));
  await act(async () => { finish({ version: 1, ok: true, data: aiSettings(), requestId: "read", correlationId: "read", schemaRevision: "desktop-ipc-v1" }); });
  expect(latest?.session).toBeNull(); expect(transitions.at(-1)?.stepId).toBe("notes");
});
