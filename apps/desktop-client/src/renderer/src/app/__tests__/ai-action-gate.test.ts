// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import { useRoomStore } from "../room-store";
import { ensureAiActionAllowed, guideAiPermissionFailure } from "../ai-action-gate";
import { notifyCompanion } from "../../components/companion/companion-notifications";

vi.mock("../../components/companion/companion-notifications", () => ({ notifyCompanion: vi.fn() }));
const read = vi.fn(), invoke = vi.fn();
const allowed = { requiresConsent: true, consentVersion: "signed", dataPolicy: { sendToExternal: true } };
beforeEach(() => {
  vi.clearAllMocks();
  useRoomStore.setState({ workspaceScopeRevision: 1, invoke, settingsAttention: null });
  read.mockResolvedValue({ ok: true, data: allowed });
  window.astella = { workspace: { getAiSettings: read } } as never;
});

it.each([
  { ...allowed, consentVersion: null },
  { ...allowed, dataPolicy: { sendToExternal: false } },
])("denies before task acceptance and sends local guidance directly to AI settings", async settings => {
  read.mockResolvedValue({ ok: true, data: settings });
  const enqueue = vi.fn();
  if (await ensureAiActionAllowed(7)) enqueue();
  expect(enqueue).not.toHaveBeenCalled();
  expect(invoke).toHaveBeenCalledWith("open-settings");
  expect(useRoomStore.getState()).toMatchObject({ settingsSection: "data", settingsAttention: "ai-consent" });
  expect(notifyCompanion).toHaveBeenCalledWith(expect.objectContaining({ kind: "help", delivery: "immediate", scope: 1 }));
});

it("allows signed external AI and local-only deployments", async () => {
  expect(await ensureAiActionAllowed()).toBe(true);
  read.mockResolvedValue({ ok: true, data: { requiresConsent: false, consentVersion: null } });
  expect(await ensureAiActionAllowed()).toBe(true);
  expect(invoke).not.toHaveBeenCalled();
});

it("fails closed on a settings read error", async () => {
  read.mockRejectedValue(new Error("offline"));
  await expect(ensureAiActionAllowed()).rejects.toThrow("offline");
  expect(notifyCompanion).not.toHaveBeenCalled();
});

it.each(["space", "request"])("does not accept a stale %s after a late settings read", async change => {
  let finish!: (value: unknown) => void;
  read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  let current = true;
  const checking = ensureAiActionAllowed(undefined, () => current);
  if (change === "space") useRoomStore.setState({ workspaceScopeRevision: 2 }); else current = false;
  finish({ ok: true, data: allowed });
  expect(await checking).toBe(false);
  expect(notifyCompanion).not.toHaveBeenCalled();
  expect(invoke).not.toHaveBeenCalled();
});

it("handles a transactional server rejection as the same guidance", () => {
  expect(guideAiPermissionFailure({ code: "ai_data_policy_denied" })).toBe(true);
  expect(invoke).toHaveBeenCalledWith("open-settings");
  expect(guideAiPermissionFailure({ code: "internal_error" })).toBe(false);
});
