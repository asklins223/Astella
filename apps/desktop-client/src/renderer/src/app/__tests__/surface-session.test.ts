// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import type { SessionContextV1 } from "@astella/shared/desktop-ipc-contracts";
import { readAuthenticatedSession, setAuthenticatedSurfaceSession } from "../surface-session";
import { setCurrentWorkspaceEpoch } from "../desktop-client";
import { publishGateInvalidation } from "../gate-invalidation";

const session = (epoch = 7) => ({ version: 1, status: "authenticated", workspaceEpoch: epoch,
  workspace: { workspaceId: "workspace", workspaceEpoch: epoch }, user: { userId: "user" } }) as SessionContextV1;
afterEach(() => { setAuthenticatedSurfaceSession(null); setCurrentWorkspaceEpoch(0); vi.unstubAllGlobals(); });

it("uses the gate's verified scope immediately, without serializing every page behind auth.getState", async () => {
  const getState = vi.fn(); vi.stubGlobal("astella", { auth: { getState } });
  const verified = session();
  setCurrentWorkspaceEpoch(7); setAuthenticatedSurfaceSession(verified);
  const cursor = { current: undefined as number | undefined };
  expect(await readAuthenticatedSession(cursor)).toBe(verified);
  expect(cursor.current).toBe(7); expect(getState).not.toHaveBeenCalled();
});

it.each(["stale_workspace", "auth_required"] as const)("re-reads authority after %s invalidation", async code => {
  const next = session(8), getState = vi.fn(async () => ({ ok: true, data: next, workspaceEpoch: 8 }));
  vi.stubGlobal("astella", { auth: { getState } });
  setCurrentWorkspaceEpoch(7); setAuthenticatedSurfaceSession(session());
  publishGateInvalidation(code);
  expect(await readAuthenticatedSession({ current: undefined })).toBe(next);
  expect(getState).toHaveBeenCalledOnce();
});

it("never uses an old verified session for a new workspace epoch", async () => {
  const next = session(8), getState = vi.fn(async () => ({ ok: true, data: next, workspaceEpoch: 8 }));
  vi.stubGlobal("astella", { auth: { getState } });
  setCurrentWorkspaceEpoch(8); setAuthenticatedSurfaceSession(session(7));
  expect(await readAuthenticatedSession({ current: undefined })).toBe(next);
  expect(getState).toHaveBeenCalledOnce();
});
