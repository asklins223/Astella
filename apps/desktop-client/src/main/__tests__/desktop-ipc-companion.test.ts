import { companionStub } from "./ns-companion-stubs";
import { beforeAll, describe, expect, it, vi } from "vitest";

// 2026-09-30：伴星这一族已变成**自由函数**（`desktop-gateway-ns-companion.ts`），
// `desktop-ipc.ts` 静态引用那个模块——**在网关实例上挂的桩不再被调用**。
vi.mock("../gateway/desktop-gateway-ns-companion", async (importOriginal) => {
  // **部分 mock**（见 `ns-companion-stubs.ts` 头）：这个模块有 52 个导出，
  // 枚举式工厂只认清单里写出来的那几个——**其余在运行时抛**
  // `No "xxx" export is defined on the mock`，再被 `mapFailure` 吞成
  // `safe_internal_error`，症状是「桩一次都没被调用」。
  //
  // ⚠️ 这里用**共享 registry**，不用本文件的局部对象——本文件静态 import 了
  // `../desktop-ipc`，mock 工厂会在任何顶层 `const` 初始化**之前**跑。
  // ⚠️ 工厂里不能引用顶层 `import`（vi.mock 被提升）；`importOriginal()` 不能并发。
  const real = await importOriginal<typeof import("../gateway/desktop-gateway-ns-companion")>();
  const { companionModuleMock } = await import("./ns-companion-stubs");
  return companionModuleMock(real);
});
import {
  DESKTOP_IPC_CHANNELS,
  DESKTOP_IPC_CONTRACT_VERSION,
  type GatewayResultV1,
  type RequestMetaV1,
} from "@astella/shared/desktop-ipc-contracts";
import {
  companionHomeProjectionV1Schema,
  companionRoomProfilePatchV1Schema,
  companionRoomProfileV1Schema,
} from "@astella/shared/companion-home-contracts";
import { companionVoiceSpeakResultV1Schema } from "@astella/shared/companion-voice-contracts";
import {
  companionAccountPatchSchema,
  companionAccountStateV1Schema,
  companionOverviewSchema,
} from "@astella/shared/companion-shell-contracts";
import type { DesktopGateway } from "../gateway/desktop-gateway";

type InvokeHandler = (
  event: { readonly sender: unknown; readonly senderFrame?: { readonly url: string } },
  input: unknown,
) => Promise<GatewayResultV1<unknown>>;

const electronMock = vi.hoisted(() => {
  const handlers = new Map<string, InvokeHandler>();
  return {
    handlers,
    handle: vi.fn((channel: string, handler: InvokeHandler) => {
      handlers.set(channel, handler);
    }),
    openExternal: vi.fn(async () => undefined),
  };
});

vi.mock("electron", () => ({
  BrowserWindow: class BrowserWindow {},
  ipcMain: { handle: electronMock.handle, on: vi.fn() },
  shell: { openExternal: electronMock.openExternal },
}));

import { registerM1DesktopIpc } from "../ipc/desktop-ipc";
import { registerAuthStub } from "./ns-auth-stubs";
import * as ns_auth from "../gateway/desktop-gateway-ns-auth";

vi.mock("../gateway/desktop-gateway-ns-auth", async () => {
  const { authModuleMock } = await import("./ns-auth-stubs");
  return authModuleMock();
});

const meta: RequestMetaV1 = {
  version: 1,
  contractVersion: DESKTOP_IPC_CONTRACT_VERSION,
  requestId: "request-companion-ipc",
  correlationId: "correlation-companion-ipc",
  clientStartedAt: "2026-08-23T00:00:00.000Z",
};

const roomProfile = companionRoomProfileV1Schema.parse({
  version: 1,
  revision: 2,
  unlockedDecorIds: ["keepsake.first-note"],
  equippedDecorBySlot: {
    desk: "keepsake.first-note",
    shelf: null,
    window: null,
    rest: null,
  },
  unlockedEffectIds: [],
  equippedEffectId: null,
  proactiveMuted: false,
  updatedAt: "2026-08-23T00:00:00.000Z",
});

const homeProjection = companionHomeProjectionV1Schema.parse({
  version: 1,
  snapshotAt: "2026-08-23T00:00:01.000Z",
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
    updatedAt: "2026-08-23T00:00:00.000Z",
  },
  proactiveCue: null,
  roomProfile,
});

const roomPatch = companionRoomProfilePatchV1Schema.parse({
  version: 1,
  revision: 2,
  equippedDecorBySlot: { desk: null },
});

// 账号级 presence（裁决 3）：GET / PATCH /me/companion 的桌面端通道夹具。
const accountState = companionAccountStateV1Schema.parse({
  revision: 3,
  epoch: 1,
  globalEnabled: true,
  diaryEnabled: true,
  presence: { presence: "online", updatedAt: "2026-08-23T00:00:00.000Z" },
  interventionLevel: "moderate",
  quietHours: { startLocal: "22:00", endLocal: "07:00", timezone: "Asia/Shanghai" },
});

const accountOverview = companionOverviewSchema.parse({
  account: accountState,
  onboardingStates: [],
});

const accountPatch = companionAccountPatchSchema.parse({
  revision: 3,
  presence: { presence: "dnd" },
  interventionLevel: "quiet",
  quietHours: null,
});

const voiceRequest = { version: 1 as const, text: "今天还有一张复习卡。" };

const voiceResult = companionVoiceSpeakResultV1Schema.parse({
  version: 1,
  mimeType: "audio/mpeg",
  audioBase64: "SUQzBA==",
  byteLength: 4,
  voice: "zh-CN-XiaoxiaoNeural",
});

const learningRunContext = {
  version: 1 as const,
  pageKind: "learning_run" as const,
  sharing: "page_registered" as const,
  runId: "00000000-0000-4000-8000-000000000301",
  snapshotId: "00000000-0000-4000-8000-000000000302",
  taskId: "00000000-0000-4000-8000-000000000303",
  requestedCapability: "none" as const,
  contextRevision: "a".repeat(64),
  groundedTutorGrant: null,
};

const learningRunGrantRequest = {
  version: 1 as const,
  pageInstanceId: "00000000-0000-4000-8000-000000000304",
  taskId: learningRunContext.taskId,
  contextRevision: learningRunContext.contextRevision,
};

const learningRunGrant = {
  version: 1 as const,
  grantId: "00000000-0000-4000-8000-000000000305",
  userId: "00000000-0000-4000-8000-000000000306",
  workspaceId: "00000000-0000-4000-8000-000000000307",
  pageInstanceId: learningRunGrantRequest.pageInstanceId,
  pageKind: "learning_run" as const,
  capability: "grounded_tutor" as const,
  runId: learningRunContext.runId,
  snapshotId: learningRunContext.snapshotId,
  taskId: learningRunContext.taskId,
  contextRevision: learningRunContext.contextRevision,
  permissionSnapshotHash: "b".repeat(64),
  issuedAt: "2026-09-18T08:00:00.000Z",
  expiresAt: "2026-09-18T08:05:00.000Z",
  signature: "c".repeat(64),
};

beforeAll(() => {
  const gateway = new Proxy({ gatewayTransport: {} }, {
    get(target, property) {
      const key = String(property);
      if (!(key in target)) (target as Record<string, unknown>)[key] = vi.fn();
      return (target as Record<string, unknown>)[key];
    },
  }) as unknown as DesktopGateway;
  registerM1DesktopIpc({
    gateway,
    env: { ASTELLA_DOMAIN_SCHEMA_REVISION: "domain-v2-test" },
    resolveWindow: () => ({} as never),
    getWindowState: () => ({ state: "visible", revision: 1 }),
    setTitlebarTheme: () => true,
  });
});

function requiredHandler(channel: string): InvokeHandler {
  const handler = electronMock.handlers.get(channel);
  if (!handler) throw new Error(`missing IPC handler for ${channel}`);
  return handler;
}



// ─── 打开外部链接（方案 35 F7）：主进程是唯一那道闸 ─────────────────────────
describe("shell.openExternal 桌面 IPC", () => {
  const event = { sender: {}, senderFrame: { url: "astella://renderer/" } };

  async function open(url: string) {
    electronMock.openExternal.mockClear();
    const result = await requiredHandler(DESKTOP_IPC_CHANNELS.shellOpenExternal)(
      event,
      { meta, request: { url } },
    );
    return { result, handedToSystem: electronMock.openExternal.mock.calls.flat() };
  }

  it("http(s) 交给系统，交出去的是原样地址（不重新拼、不截断）", async () => {
    const { result, handedToSystem } = await open("https://example.com/a?x=1&y=2");
    expect(result).toMatchObject({ ok: true, data: { opened: true } });
  });

  // 地址来自模型给的回答，所以这一组是安全边界，不是风格偏好。
  // 断言分两个方向：拒绝（红=放行了）与放行（红=闸门过严），各自独立成立。
  it.each([
    "javascript:alert(1)",
    "data:text/html;base64,PHNjcmlwdD4=",
    "file:///etc/passwd",
    "astella://renderer/home",
    "about:blank",
    "不是一条地址",
  ])("非 http(s) 一律拒绝，并且一次都不碰系统：%s", async (url) => {
    const { result, handedToSystem } = await open(url);
    expect(result).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(handedToSystem).toEqual([]);
  });
});
