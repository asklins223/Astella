// @vitest-environment jsdom

import { act, cleanup, render, waitFor } from "@testing-library/react";
import type {
  AstellaDesktopApiM2,
  GatewayEventV1,
  GatewayResultV1,
  SessionContextV1,
} from "@astella/shared/desktop-ipc-contracts";
import {
  companionHomeProjectionV1Schema,
  type CompanionHomeProjectionV1,
} from "@astella/shared/companion-home-contracts";
import type { RoomProjectionV1 } from "@astella/shared/room-projection-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRoomStore } from "../home/room-store.ts";
import { HomeProjectionProvider } from "../home/home-projection.tsx";
import {
  CompanionHomeProjectionProvider,
  useCompanionHomeProjection,
} from "../companion-pages/companion-home-projection.tsx";
import { useCompanionNotificationSources } from "../../components/companion/notify/use-companion-notification-sources.ts";
import { useCompanionNotifications } from "../../components/companion/notify/companion-notifications.ts";

type Deferred<T> = {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

function ok<T>(data: T, workspaceEpoch = 7): GatewayResultV1<T> {
  return {
    version: 1,
    ok: true,
    data,
    requestId: "request-companion-provider",
    correlationId: "correlation-companion-provider",
    schemaRevision: "desktop-ipc-v1",
    workspaceEpoch,
  };
}

function conflict(): GatewayResultV1<never> {
  return {
    version: 1,
    ok: false,
    requestId: "request-companion-conflict",
    correlationId: "correlation-companion-conflict",
    schemaRevision: "desktop-ipc-v1",
    workspaceEpoch: 7,
    error: {
      code: "conflict",
      safeMessageKey: "error.conflict",
      retry: "resync_first",
    },
  };
}

const authenticatedSession: SessionContextV1 = {
  version: 1,
  status: "authenticated",
  user: {
    userId: "11111111-1111-4111-8111-111111111111",
    email: "owner@example.com",
  },
  workspace: {
    version: 1,
    workspaceId: "22222222-2222-4222-8222-222222222222",
    name: "Owner workspace",
    role: "owner",
    workspaceType: "personal",
    isPersonal: true,
    workspaceEpoch: 7,
  },
  membership: { role: "owner" },
  capabilities: null,
  workspaceEpoch: 7,
  credentialPersistence: "memory",
};

const roomProjection: RoomProjectionV1 = {
  version: 1,
  workspaceEpoch: 7,
  snapshotAt: "2026-09-11T08:00:00.000Z",
  dashboardRevision: "home-provider-test",
  mode: "first_use",
  recentNote: null,
  recentActivitySummary: { state: "empty" },
  captureCapability: { state: "disabled", reason: "capability_denied" },
  sectionStates: { recentActivitySummary: { state: "empty" } },
  degradation: null,
};

function companionProjection(
  revision: number,
  proactiveCue: CompanionHomeProjectionV1["proactiveCue"] = null,
): CompanionHomeProjectionV1 {
  return companionHomeProjectionV1Schema.parse({
    version: 1,
    snapshotAt: `2026-09-11T08:00:0${revision}.000Z`,
    profileSummary: {
      name: "小岚",
      activeness: "quiet",
      boundaries: {
        allowPlayful: true,
        allowNudgeLearning: false,
        allowVoiceTags: false,
        catchphrase: null,
      },
      familiarity: 0.5,
      interactionCount: 4,
      source: "saved_profile",
    },
    memorySummary: {
      confirmedCount: 1,
      candidateCount: 0,
      updatedAt: "2026-09-11T08:00:00.000Z",
    },
    proactiveCue,
    roomProfile: {
      version: 1,
      revision,
      unlockedDecorIds: ["keepsake.first-note"],
      equippedDecorBySlot: {
        desk: "keepsake.first-note",
        shelf: null,
        window: null,
        rest: null,
      },
      unlockedEffectIds: [],
      equippedEffectId: null,
      // 0266：空间级打扰开关（契约必填）。
      proactiveMuted: false,
      updatedAt: `2026-09-11T08:00:0${revision}.000Z`,
    },
  });
}

type CompanionSnapshot = ReturnType<typeof useCompanionHomeProjection>;
let latest: CompanionSnapshot | null = null;

function Probe() {
  latest = useCompanionHomeProjection();
  return null;
}

function NotificationProbe() {
  useCompanionNotificationSources();
  return null;
}

function installApi(api: unknown) {
  Object.defineProperty(window, "astella", {
    configurable: true,
    value: api as AstellaDesktopApiM2,
  });
}

beforeEach(() => {
  useRoomStore.setState({ surface: null });
});

afterEach(() => {
  cleanup();
  latest = null;
  Reflect.deleteProperty(window, "astella");
  vi.restoreAllMocks();
});

describe("CompanionHomeProjectionProvider", () => {
  it("delivers a reminder after a runtime event while Settings is open", async () => {
    useRoomStore.setState({ surface: "settings" });
    useCompanionNotifications.setState({ items: [] });
    const callbacks = new Map<string, (event: GatewayEventV1) => void>();
    const reminder = {
      text: "该休息一下了",
      expiresAt: "2026-09-11T09:30:00.000Z",
      revision: 9,
      origin: "reminder" as const,
    };
    const getCompanionProjection = vi.fn()
      .mockResolvedValueOnce(ok(companionProjection(1)))
      .mockResolvedValueOnce(ok(companionProjection(2, reminder)));
    installApi({
      auth: { getState: vi.fn().mockResolvedValue(ok(authenticatedSession)) },
      room: { getProjection: vi.fn().mockResolvedValue(ok(roomProjection)) },
      companion: {
        home: { getProjection: getCompanionProjection },
        voice: { asrModel: { getState: vi.fn().mockResolvedValue(ok({ status: "installed" })) } },
      },
      subscriptions: {
        subscribe: vi.fn().mockImplementation(({ topic }: { topic: { kind: string } }) => (
          Promise.resolve(ok({ subscriptionId: `${topic.kind}-subscription` }))
        )),
        onEvent: vi.fn().mockImplementation((subscriptionId: string, callback: (event: GatewayEventV1) => void) => {
          callbacks.set(subscriptionId, callback);
          return () => callbacks.delete(subscriptionId);
        }),
        unsubscribe: vi.fn().mockResolvedValue(ok({ closed: true })),
      },
    });

    render(
      <HomeProjectionProvider>
        <CompanionHomeProjectionProvider><NotificationProbe /></CompanionHomeProjectionProvider>
      </HomeProjectionProvider>,
    );
    await waitFor(() => expect(getCompanionProjection).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(callbacks.size).toBe(2));

    act(() => callbacks.get("runtime-subscription")?.({
      version: 1,
      subscriptionId: "runtime-subscription",
      workspaceEpoch: 7,
      cursor: "cursor-companion-activity-1",
      eventRevision: 1,
      kind: "companion_activity_changed",
      schemaRevision: "desktop-ipc-v1",
      data: { kind: "companion_activity_changed", inboxSequence: 9 },
    }));

    await waitFor(() => expect(getCompanionProjection).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(useCompanionNotifications.getState().items[0]).toMatchObject({
      kind: "reminder",
      body: "该休息一下了",
    }));
  });

  it("refreshes after CAS conflict without replaying the rejected equipment choice", async () => {
    const refreshedProjection = deferred<GatewayResultV1<CompanionHomeProjectionV1>>();
    const getCompanionProjection = vi.fn()
      .mockResolvedValueOnce(ok(companionProjection(2)))
      .mockImplementationOnce(() => refreshedProjection.promise);
    const patchProfile = vi.fn().mockResolvedValue(conflict());
    installApi({
      auth: { getState: vi.fn().mockResolvedValue(ok(authenticatedSession)) },
      room: { getProjection: vi.fn().mockResolvedValue(ok(roomProjection)) },
      companion: {
        home: { getProjection: getCompanionProjection },
        room: {
          getProfile: vi.fn(),
          patchProfile,
        },
      },
      subscriptions: {
        subscribe: vi.fn().mockRejectedValue(new Error("stream intentionally absent")),
        onEvent: vi.fn(),
        unsubscribe: vi.fn().mockResolvedValue(ok({ closed: true })),
      },
    });

    render(
      <HomeProjectionProvider>
        <CompanionHomeProjectionProvider><Probe /></CompanionHomeProjectionProvider>
      </HomeProjectionProvider>,
    );
    await waitFor(() => expect(latest?.projection?.roomProfile.revision).toBe(2));

    let result: Awaited<ReturnType<CompanionSnapshot["patchRoomProfile"]>> | null = null;
    await act(async () => {
      result = await latest?.patchRoomProfile({ equippedDecorBySlot: { desk: null } }) ?? null;
    });
    expect(result).toEqual({
      ok: false,
      message: "这条学习状态已经发生变化，请先同步后再继续。",
    });
    expect(patchProfile).toHaveBeenCalledWith(expect.objectContaining({
      meta: expect.objectContaining({ workspaceEpoch: 7 }),
      request: {
        version: 1,
        revision: 2,
        equippedDecorBySlot: { desk: null },
      },
    }));
    expect(latest?.projection?.roomProfile).toMatchObject({
      revision: 2,
      equippedDecorBySlot: { desk: "keepsake.first-note" },
    });
    await waitFor(() => expect(getCompanionProjection).toHaveBeenCalledTimes(2));

    // The server wins after 409. The provider refreshes revision 3 and does
    // not silently replay the user's rejected `desk: null` mutation.
    refreshedProjection.resolve(ok(companionProjection(3)));
    await waitFor(() => expect(latest?.projection?.roomProfile.revision).toBe(3));
    expect(latest?.projection?.roomProfile.equippedDecorBySlot.desk).toBe("keepsake.first-note");
    expect(patchProfile).toHaveBeenCalledTimes(1);
  });
});
