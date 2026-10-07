// @vitest-environment jsdom

/**
 * F01 回归：门禁的 runtime 订阅以前把**任何**事件都当成会话失效，于是主进程每发
 * 一条 `companion_activity_changed`（收件箱投递），整棵房间就被卸载重来一次，附带
 * 一条 `/auth/me`；账号级关闭伴星时主进程每读一次会话就重发一条 snapshot_invalidated，
 * 门禁再读会话——自己喂自己，永远停不下来。
 *
 * 这一组用例钉住三件事：
 *  1. 伴星投递不重来：页面、焦点、房间视图状态都不动，请求数不随事件条数增长。
 *  2. 同代 snapshot_invalidated 只做静默复核：页面与焦点不动，但会话确实被重新确认。
 *  3. 真的换了空间边界仍然收口；卡住的 bootstrap 有能点的重试，而不是无限 spinner。
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  DESKTOP_IPC_CONTRACT_VERSION,
  desktopContractSnapshotSchema,
  runtimeSnapshotSchema,
  sessionContextSchema,
  type AstellaDesktopApiM2,
  type GatewayEventV1,
  type GatewayResultV1,
  type SessionContextV1,
  type SubscriptionTopicM2,
} from "@astella/shared/desktop-ipc-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearAccountSignOutNotice } from "../../app/account-signout.ts";
import { publishGateInvalidation } from "../../app/gate-invalidation.ts";
import { useRoomStore } from "../../app/room-store.ts";
import { DesktopAccessGate } from "../DesktopAccessGate.tsx";

// 登录页那张氛围画布是 pixi 画的，和这条判据无关；测试里不把它拉进来。
vi.mock("../AuthAmbientCanvas", () => ({ AuthAmbientCanvas: () => null }));

const USER_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";

const contract = desktopContractSnapshotSchema.parse({
  version: 1,
  contractVersion: DESKTOP_IPC_CONTRACT_VERSION,
  domainSchemaRevision: "domain-v2-test",
  deploymentConfigRevision: "deployment-test",
  namespaces: ["runtime", "auth", "workspace", "room", "subscriptions"],
  enabledRoutes: ["auth.login", "room.home"],
});

const runtimeSnapshot = runtimeSnapshotSchema.parse({
  version: 1,
  contractVersion: DESKTOP_IPC_CONTRACT_VERSION,
  appId: "astella-desktop",
  appVersion: "0.0.0-test",
  platform: "darwin",
  windowState: { version: 1, state: "visible", revision: 1 },
  apiConnection: { version: 1, kind: "ready", schemaRevision: "domain-v2-test" },
  nativeCapabilities: {
    filePicker: "unavailable",
    clipboard: "unavailable",
    notifications: "unavailable",
    asr: "unavailable",
    updates: "unavailable",
    live2d: "unavailable",
  },
  reducedMotion: false,
  startupRevision: 1,
  sessionCredential: { persistence: "memory", stored: false },
});

function session(workspaceEpoch: number, workspaceId = WORKSPACE_ID): SessionContextV1 {
  return sessionContextSchema.parse({
    version: 1,
    status: "authenticated",
    user: { userId: USER_ID, email: "owner@example.com", displayName: "Owner" },
    workspace: {
      version: 1,
      workspaceId,
      name: `Workspace ${workspaceEpoch}`,
      role: "owner",
      workspaceType: "personal",
      isPersonal: true,
      workspaceEpoch,
    },
    membership: { role: "owner" },
    capabilities: null,
    workspaceEpoch,
    credentialPersistence: "memory",
  });
}

/** 会话还在，但服务端要求重新验证身份——门禁停在「请再次输入密码」那一屏。 */
function reauthSession(): SessionContextV1 {
  return sessionContextSchema.parse({
    version: 1,
    status: "reauth_required",
    user: { userId: USER_ID, email: "owner@example.com", displayName: "Owner" },
    workspace: null,
    membership: null,
    capabilities: null,
    workspaceEpoch: 1,
    credentialPersistence: "memory",
  });
}

function ok<T>(data: T, workspaceEpoch?: number): GatewayResultV1<T> {
  return {
    version: 1,
    ok: true,
    data,
    requestId: "request-gate-test",
    correlationId: "correlation-gate-test",
    schemaRevision: "desktop-ipc-v1",
    ...(workspaceEpoch ? { workspaceEpoch } : {}),
  };
}

function companionEvent(inboxSequence: number): GatewayEventV1 {
  return {
    version: 1,
    subscriptionId: "runtime-subscription",
    workspaceEpoch: 1,
    cursor: `cursor-companion-${inboxSequence}`,
    eventRevision: inboxSequence,
    kind: "companion_activity_changed",
    schemaRevision: "desktop-ipc-v1",
    data: { kind: "companion_activity_changed", inboxSequence },
  };
}

function invalidationEvent(scope: "runtime" | "workspace", workspaceEpoch = 1): GatewayEventV1 {
  return {
    version: 1,
    subscriptionId: scope === "workspace" ? "workspace-subscription" : "runtime-subscription",
    workspaceEpoch,
    cursor: `cursor-invalidate-${scope}`,
    eventRevision: 1,
    kind: "snapshot_invalidated",
    schemaRevision: "desktop-ipc-v1",
    data: { kind: "snapshot_invalidated", scope },
  };
}

type Harness = {
  readonly getState: ReturnType<typeof vi.fn>;
  readonly getSnapshot: ReturnType<typeof vi.fn>;
  readonly retryConnection: ReturnType<typeof vi.fn>;
  readonly logout: ReturnType<typeof vi.fn>;
  readonly setSession: (next: SessionContextV1) => void;
  readonly emitRuntime: (event: GatewayEventV1) => void;
};

function installApi(options: { hangSession?: boolean; initialSession?: SessionContextV1 } = {}): Harness {
  let currentSession = options.initialSession ?? session(1);
  const listeners = new Map<string, (event: GatewayEventV1) => void>();
  const topics = new Map<string, SubscriptionTopicM2["kind"]>();
  let subscriptionSeq = 0;

  const getState = vi.fn(() => (
    options.hangSession
      ? new Promise<never>(() => {})
      : Promise.resolve(ok(currentSession, currentSession.workspaceEpoch))
  ));
  const getSnapshot = vi.fn(async () => ok(runtimeSnapshot));
  const retryConnection = vi.fn(async () => ok(runtimeSnapshot.apiConnection, 1));
  const logout = vi.fn(async () => ok({ loggedOut: true as const, serverRevoked: true as const }));

  const api = {
    contract,
    runtime: { getSnapshot, retryApiConnection: retryConnection },
    auth: {
      getState,
      getSurfaceManifest: vi.fn(async () => ok({ manifest: { surfaces: [] }, testMode: true })),
      login: vi.fn(),
      register: vi.fn(),
      reauthenticate: vi.fn(),
      joinWorkspace: vi.fn(),
      logout,
    },
    workspace: { list: vi.fn(), switch: vi.fn() },
    subscriptions: {
      subscribe: vi.fn(async ({ topic }: { readonly topic: SubscriptionTopicM2 }) => {
        const subscriptionId = `${topic.kind}-subscription-${++subscriptionSeq}`;
        topics.set(subscriptionId, topic.kind);
        return ok({ subscriptionId });
      }),
      onEvent: vi.fn((subscriptionId: string, listener: (event: GatewayEventV1) => void) => {
        listeners.set(subscriptionId, listener);
        return () => listeners.delete(subscriptionId);
      }),
      unsubscribe: vi.fn(async () => ok({ closed: true })),
    },
  };
  Object.defineProperty(window, "astella", { configurable: true, value: api as unknown as AstellaDesktopApiM2 });

  return {
    getState,
    getSnapshot,
    retryConnection,
    logout,
    setSession: (next) => { currentSession = next; },
    emitRuntime: (event) => {
      for (const [subscriptionId, listener] of [...listeners]) {
        if (topics.get(subscriptionId) === "runtime") listener(event);
      }
    },
  };
}

async function renderReadyGate() {
  const onWorkspaceBoundaryReset = vi.fn();
  const view = render(
    <DesktopAccessGate onWorkspaceBoundaryReset={onWorkspaceBoundaryReset}>
      <button type="button" data-testid="room-focus">学习页面</button>
    </DesktopAccessGate>,
  );
  const room = await screen.findByTestId("room-focus");
  return { onWorkspaceBoundaryReset, room, view };
}

beforeEach(() => {
  useRoomStore.setState({ surface: null });
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("媒体清单在测试里不存在"))));
  // jsdom 没有 matchMedia，而门禁的入场动画会用它判断紧凑布局。
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      matches: false,
      media: "",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => false),
    })),
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, "astella");
  Reflect.deleteProperty(window, "matchMedia");
  useRoomStore.setState({ surface: null });
});

describe("DesktopAccessGate 的失效判据（F01）", () => {
  it("服务短暂离线隐藏内容，重连同一身份后保留笔记落点", async () => {
    const harness = installApi();
    const reset = vi.fn(() => useRoomStore.getState().resetWorkspaceScope());
    render(<DesktopAccessGate onWorkspaceBoundaryReset={reset}><button data-testid="room-focus">学习页面</button></DesktopAccessGate>);
    await screen.findByTestId("room-focus");
    useRoomStore.setState({ surface: "notebook", activeNoteRef: { noteId: "note-before-offline", noteVersionId: null } });
    act(() => harness.emitRuntime({ ...invalidationEvent("runtime"), kind: "connection_changed", data: { kind: "connection_changed", state: { version: 1, kind: "api_unavailable" } } }));
    await screen.findByRole("button", { name: "重新连接" });
    expect(screen.queryByTestId("room-focus")).toBeNull();
    expect(reset).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "重新连接" }));
    await screen.findByTestId("room-focus");
    expect(useRoomStore.getState().surface).toBe("notebook");
    expect(useRoomStore.getState().activeNoteRef?.noteId).toBe("note-before-offline");
    expect(reset).not.toHaveBeenCalled();
  });

  it("离线期间身份真的改变，重连仍清空旧笔记状态", async () => {
    const harness = installApi();
    const reset = vi.fn(() => useRoomStore.getState().resetWorkspaceScope());
    render(<DesktopAccessGate onWorkspaceBoundaryReset={reset}><button data-testid="room-focus">学习页面</button></DesktopAccessGate>);
    await screen.findByTestId("room-focus");
    useRoomStore.setState({ surface: "notebook", activeNoteRef: { noteId: "private-old-note", noteVersionId: null } });
    act(() => harness.emitRuntime({ ...invalidationEvent("runtime"), kind: "connection_changed", data: { kind: "connection_changed", state: { version: 1, kind: "api_unavailable" } } }));
    await screen.findByRole("button", { name: "重新连接" });
    harness.setSession(session(2, "33333333-3333-4333-8333-333333333333"));
    fireEvent.click(screen.getByRole("button", { name: "重新连接" }));
    await screen.findByTestId("room-focus");
    expect(reset).toHaveBeenCalledOnce();
    expect(useRoomStore.getState().activeNoteRef).toBeNull();
  });

  it("连续 100 条伴星投递不重来：页面、焦点、房间视图与请求数都不动", async () => {
    const harness = installApi();
    const { onWorkspaceBoundaryReset, room } = await renderReadyGate();
    room.focus();
    expect(document.activeElement).toBe(room);
    useRoomStore.setState({ surface: "notebook" });
    const sessionReads = harness.getState.mock.calls.length;
    const snapshots = harness.getSnapshot.mock.calls.length;

    act(() => {
      for (let inboxSequence = 1; inboxSequence <= 100; inboxSequence += 1) {
        harness.emitRuntime(companionEvent(inboxSequence));
      }
    });
    await act(async () => { await Promise.resolve(); });

    expect(document.activeElement).toBe(room);
    expect(screen.getByTestId("room-focus")).toBe(room);
    expect(useRoomStore.getState().surface).toBe("notebook");
    expect(onWorkspaceBoundaryReset).not.toHaveBeenCalled();
    expect(harness.getState.mock.calls.length).toBe(sessionReads);
    expect(harness.getSnapshot.mock.calls.length).toBe(snapshots);
    expect(harness.retryConnection).not.toHaveBeenCalled();
  });

  it("同代 snapshot_invalidated 只做静默复核：页面与焦点不动，会话仍被重新确认", async () => {
    const harness = installApi();
    const { onWorkspaceBoundaryReset, room } = await renderReadyGate();
    room.focus();
    useRoomStore.setState({ surface: "notebook" });
    const sessionReads = harness.getState.mock.calls.length;

    act(() => harness.emitRuntime(invalidationEvent("runtime")));

    await waitFor(() => expect(harness.getState.mock.calls.length).toBe(sessionReads + 1));
    expect(document.activeElement).toBe(room);
    expect(screen.getByTestId("room-focus")).toBe(room);
    expect(useRoomStore.getState().surface).toBe("notebook");
    expect(onWorkspaceBoundaryReset).not.toHaveBeenCalled();
    // 连接本来就是 ready：复核不该顺带强制重连。
    expect(harness.retryConnection).not.toHaveBeenCalled();
  });

  it("业务响应合同错误只复核会话，不清空当前卡片或焦点", async () => {
    const harness = installApi();
    const { onWorkspaceBoundaryReset, room } = await renderReadyGate();
    room.focus();
    useRoomStore.setState({ surface: "objective-detail", activeObjectiveId: "card-1" });
    const sessionReads = harness.getState.mock.calls.length;
    act(() => publishGateInvalidation("unsupported_contract"));
    await waitFor(() => expect(harness.getState.mock.calls.length).toBe(sessionReads + 1));
    expect(screen.getByTestId("room-focus")).toBe(room);
    expect(document.activeElement).toBe(room);
    expect(useRoomStore.getState().surface).toBe("objective-detail");
    expect(useRoomStore.getState().activeObjectiveId).toBe("card-1");
    expect(onWorkspaceBoundaryReset).not.toHaveBeenCalled();
  });

  it("复核发现真的换了空间：清空工作区视图，换成新边界的会话", async () => {
    const harness = installApi();
    const { onWorkspaceBoundaryReset } = await renderReadyGate();
    useRoomStore.setState({ surface: "notebook" });
    harness.setSession(session(2, "33333333-3333-4333-8333-333333333333"));

    act(() => harness.emitRuntime(invalidationEvent("workspace", 2)));

    await waitFor(() => expect(onWorkspaceBoundaryReset).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("room-focus")).toBeTruthy();
    expect(harness.getState.mock.calls.length).toBeGreaterThan(1);
  });

  it("同空间政策或改名推进纪元后清理旧领域状态，同时保留设置分区", async () => {
    const harness = installApi();
    const reset = vi.fn(() => useRoomStore.getState().resetWorkspaceScope());
    render(<DesktopAccessGate onWorkspaceBoundaryReset={reset}><button data-testid="room-focus">学习页面</button></DesktopAccessGate>);
    await screen.findByTestId("room-focus");
    useRoomStore.setState({ surface: "settings", settingsSection: "ai", activeSourceId: "old-source" });
    harness.setSession(session(2));
    act(() => harness.emitRuntime(invalidationEvent("runtime", 2)));
    await waitFor(() => expect(reset).toHaveBeenCalledTimes(1));
    expect(useRoomStore.getState().surface).toBe("settings");
    expect(useRoomStore.getState().settingsSection).toBe("ai");
    expect(useRoomStore.getState().activeSourceId).toBeNull();
    expect(useRoomStore.getState().spaceIdentity?.workspaceEpoch).toBe(2);
  });

  it("设置请求遇到 stale_workspace 后，复核同一身份仍回到当前设置分区", async () => {
    const harness = installApi();
    const reset = vi.fn(() => useRoomStore.getState().resetWorkspaceScope());
    render(<DesktopAccessGate onWorkspaceBoundaryReset={reset}><button data-testid="room-focus">学习页面</button></DesktopAccessGate>);
    await screen.findByTestId("room-focus");
    useRoomStore.setState({ surface: "settings", settingsSection: "ai", activeSourceId: "old-source" });
    harness.setSession(session(2));
    act(() => publishGateInvalidation("stale_workspace"));
    await waitFor(() => expect(useRoomStore.getState().spaceIdentity?.workspaceEpoch).toBe(2));
    expect(reset).toHaveBeenCalledOnce();
    expect(useRoomStore.getState().surface).toBe("settings");
    expect(useRoomStore.getState().settingsSection).toBe("ai");
    expect(useRoomStore.getState().activeSourceId).toBeNull();
  });

  it("bootstrap 卡住超过时限：无限 spinner 换成能点的重试", async () => {
    vi.useFakeTimers();
    try {
      installApi({ hangSession: true });
      render(
        <DesktopAccessGate>
          <button type="button" data-testid="room-focus">学习页面</button>
        </DesktopAccessGate>,
      );
      // 让订阅、getSnapshot 这些微任务先跑完，门禁停在"正在向学习服务确认会话"。
      for (let tick = 0; tick < 8; tick += 1) {
        await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      }
      expect(screen.getByRole("status")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "再试一次" })).toBeNull();

      await act(async () => { await vi.advanceTimersByTimeAsync(12_001); });

      expect(screen.queryByRole("status")).toBeNull();
      expect(screen.getByRole("button", { name: "再试一次" })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * 「请再次输入密码」那一屏唯一的输入就是密码。想不起来时没有第二条路可走，整扇
 * 门就锁死了——而这一屏恰恰是自动登录恢复出来的会话最常落到的地方。
 */
describe("DesktopAccessGate 重认证那一屏的出口", () => {
  beforeEach(() => {
    // 退出的结论停在模块里（见 app/account-signout.ts），用例之间不能互相带话。
    clearAccountSignOutNotice();
  });

  async function renderReauthGate() {
    render(
      <DesktopAccessGate>
        <button type="button" data-testid="room-focus">学习页面</button>
      </DesktopAccessGate>,
    );
    await screen.findByRole("heading", { name: "请再次输入密码" });
    return screen.getByRole("button", { name: "想不起来密码？退出并重新登录" });
  }

  it("密码想不起来时，这一屏给出一条退出并重新登录的路", async () => {
    const harness = installApi({ initialSession: reauthSession() });
    const exit = await renderReauthGate();
    expect(exit).toBeTruthy();
    expect(screen.queryByTestId("room-focus")).toBeNull();
  });

  it("退出后回到登录页，邮箱预填成刚离开的那个账号", async () => {
    const harness = installApi({ initialSession: reauthSession() });
    const exit = await renderReauthGate();

    fireEvent.click(exit);

    await screen.findByRole("button", { name: "登录" });
    expect(harness.logout).toHaveBeenCalledOnce();
    expect(screen.queryByRole("heading", { name: "请再次输入密码" })).toBeNull();
    expect((screen.getByLabelText("邮箱") as HTMLInputElement).value).toBe("owner@example.com");
    // 本机干净退出：登录页本身就是答案，不该再多挂一句。
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("撤销没送达时，退出结论跟着带到登录页", async () => {
    const harness = installApi({ initialSession: reauthSession() });
    const exit = await renderReauthGate();
    harness.logout.mockResolvedValueOnce(ok({ loggedOut: true as const, serverRevoked: false as const }));

    fireEvent.click(exit);

    await screen.findByText("这台设备已经退出登录。这次的登录状态没能通知学习服务撤销，它会在学习服务那边留到自动过期。");
  });
});
