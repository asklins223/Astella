// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import { COMPANION_GUIDE_VERSION, type CompanionOnboardingStateV1 } from "@astella/shared/companion-shell-contracts";
import { GuideProgressClient, guideProgressKey, resumableGuide, type GuideIdentity } from "../guide-progress";
const identity: GuideIdentity = { workspaceId: "11111111-1111-4111-8111-111111111111", workspaceEpoch: 2, userId: "22222222-2222-4222-8222-222222222222", deploymentRef: "deployment-a", name: "同名", role: "owner", isPersonal: false };
const ok = (data: unknown) => ({ version: 1, ok: true, data, requestId: "test", correlationId: "test", schemaRevision: "test" });
let remote: CompanionOnboardingStateV1 | null;
const transition = vi.fn();
beforeEach(() => {
  localStorage.clear(); remote = null;
  transition.mockReset().mockImplementation(async ({ request }: { request: { action: string; revision?: number; stepId?: string; topicId?: string } }) => {
    expect(request.revision).toBe(remote?.revision);
    remote = { ...(remote ?? { onboardingVersion: COMPANION_GUIDE_VERSION, scope: "account", offerStatus: "offered", updatedAt: new Date().toISOString() }), revision: (remote?.revision ?? 0) + 1 };
    if (request.action === "replay" || request.action === "start") remote.activeRun = { runId: "server-run", entryMode: "manual_replay", runStatus: "in_progress", stepId: request.stepId ?? "room", topicId: request.topicId as "welcome", resumeTokenRef: "token", resumeWorkspaceRef: identity.workspaceId, expiresAt: new Date(Date.now() + 86_400_000).toISOString() };
    if (request.action === "advance" && remote.activeRun) remote.activeRun.stepId = request.stepId!;
    if (request.action === "pause" && remote.activeRun) remote.activeRun.runStatus = "paused";
    return ok({ state: remote });
  });
  Object.defineProperty(window, "astella", { configurable: true, value: { companion: { account: {
    getState: vi.fn(async () => ok({ account: { revision: 0, epoch: 0, globalEnabled: true, diaryEnabled: true }, onboardingStates: remote ? [remote] : [] })),
    transitionOnboarding: transition,
  } } } });
});
it("keeps user, deployment and equally named workspace progress separate", () => {
  expect(guideProgressKey(identity, "space")).not.toBe(guideProgressKey({ ...identity, workspaceId: "33333333-3333-4333-8333-333333333333" }, "space"));
  expect(guideProgressKey(identity, "account")).toBe(guideProgressKey({ ...identity, workspaceId: "33333333-3333-4333-8333-333333333333" }, "account"));
  expect(guideProgressKey(identity, "account")).not.toBe(guideProgressKey({ ...identity, deploymentRef: "deployment-b" }, "account"));
});
it("serializes rapid next/previous/pause through the latest CAS revision", async () => {
  const client = new GuideProgressClient(identity); await client.load();
  await client.transition("account", { action: "replay", stepId: "notes", topicId: "sources" });
  await Promise.all([client.transition("account", { action: "advance", stepId: "reading" }), client.transition("account", { action: "advance", stepId: "notes" }), client.transition("account", { action: "pause", stepId: "notes" })]);
  expect(client.states.account?.activeRun?.stepId).toBe("notes");
  expect(client.states.account?.activeRun?.runStatus).toBe("paused");
  expect(transition).toHaveBeenCalledTimes(4);
});
it("keeps pending skip locally and reconciles without rolling back a remote completion", async () => {
  transition.mockRejectedValueOnce(new Error("offline"));
  const client = new GuideProgressClient(identity); await client.load();
  await client.transition("account", { action: "skip" });
  expect(client.pending).toBe(true);
  expect(client.states.account?.offerStatus).toBe("consumed");
  remote = { onboardingVersion: COMPANION_GUIDE_VERSION, scope: "account", revision: 9, offerStatus: "consumed", offerDisposition: "completed", updatedAt: new Date().toISOString() };
  const reconnected = new GuideProgressClient(identity); await reconnected.load();
  expect(reconnected.states.account?.offerDisposition).toBe("completed");
  expect(transition).toHaveBeenCalledTimes(1);
});
it("offers resume only while the run is valid for this actual workspace", async () => {
  const client = new GuideProgressClient(identity); await client.load();
  await client.transition("account", { action: "replay", stepId: "notes" });
  expect(resumableGuide(client.states.account, identity)).toBe(true);
  expect(resumableGuide(client.states.account, { ...identity, workspaceId: "33333333-3333-4333-8333-333333333333" })).toBe(false);
  client.states.account!.activeRun!.expiresAt = new Date(Date.now() - 1).toISOString();
  expect(resumableGuide(client.states.account, identity)).toBe(false);
});
