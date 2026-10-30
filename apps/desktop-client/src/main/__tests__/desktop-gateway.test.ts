import * as ns_source from "../gateway/desktop-gateway-ns-source";import { noteModuleMock } from "./ns-note-stubs";

// 2026-09-30：笔记这一族已变成**自由函数**（`desktop-gateway-ns-note.ts`），
// `desktop-ipc.ts` 静态引用那个模块——**实例上挂的桩不再被调用**，桩要挂模块。
//
// **用 `importOriginal()` 部分 mock**而不是写死转发清单：desktop-ipc 里有 60+ 个
// `ns_note.*` 调用点，清单漏一个，vitest 就在运行时抛「没有这个导出」，
// 而它被 `safe_internal_error` 吞掉——症状离真因隔了三层。**部分 mock 不会过时。**
vi.mock("../gateway/desktop-gateway-ns-note", async (importOriginal) => {
  // **部分 mock**：只覆盖用 noteStub() 登记过的方法，其余走真实现。
  // 写死转发清单一定会过时——实测 desktop-ipc 里有 60+ 个 ns_note 调用点，漏一个
  // vitest 就在运行时抛「没有这个导出」，而它被 safe_internal_error 吞掉。
  //
  // ⚠️ 两处顺序不能改：
  // ① 工厂里**不能引用顶层 import**（vi.mock 被提升，顶层变量那时还没初始化）
  //    ——所以 noteModuleMock 也在工厂内部 import；
  // ② `importOriginal()` **不能与别的 import 并发**（实测 `Promise.all` 会让
  //    mock 提前返回半成品，症状是「桩登记了但一次都没被调用」）。
  const real = await importOriginal<typeof import("../gateway/desktop-gateway-ns-note")>();
  const { noteModuleMock } = await import("./ns-note-stubs");
  return noteModuleMock(real);
});
import * as ns_note from "../gateway/desktop-gateway-ns-note";
import * as ns_companion from "../gateway/desktop-gateway-ns-companion";
import * as ns_workspace from "../gateway/desktop-gateway-ns-workspace";
import * as ns_auth from "../gateway/desktop-gateway-ns-auth";
import * as ns_runtime from "../gateway/desktop-gateway-ns-runtime";
import { createHmac } from "node:crypto";
import * as Y from "yjs";
import {
  emptyNoteDoc,
  projectNoteBlocks,
  setNoteTitle,
  snapshotOf,
  syncNoteBlocksForEditor,
  writeNoteBlocks,
} from "../test-support/note-doc-test-doc";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DESKTOP_API_SERVICE_ID,
  DESKTOP_IPC_CONTRACT_VERSION,
  actionCapabilityValues,
  capabilityProjectionSchema,
  desktopTrustSignatureMessage,
  featureNameValues,
} from "@astella/shared/desktop-ipc-contracts";
import { noteDetailV1Schema } from "@astella/shared/note-projection-contracts";
import { noteSaveReceiptV1Schema } from "@astella/shared/note-save-contracts";
import {
  companionHomeProjectionV1Schema,
  companionRoomProfilePatchV1Schema,
  companionRoomProfileV1Schema,
} from "@astella/shared/companion-home-contracts";
import {
  COMPANION_VOICE_MAX_AUDIO_BYTES,
  COMPANION_VOICE_SPEAK_VOICE,
  companionVoiceSpeakResultV1Schema,
} from "@astella/shared/companion-voice-contracts";
import {
  SOURCE_IMAGE_MAX_BYTES,
  sourceImageGetResultV1Schema,
} from "@astella/shared/source-image-contracts";
import type { GatewayErrorCode } from "@astella/shared/desktop-ipc-contracts";
import { DesktopGatewayFailure } from "../gateway/desktop-gateway-failure";
import * as ns_search from "../gateway/desktop-gateway-ns-search";
import * as ns_invite from "../gateway/desktop-gateway-ns-invite";
import * as ns_artifact from "../gateway/desktop-gateway-ns-artifact";
import {
  DesktopGateway,
  parseCompanionAccountSseFrame,
  parseCompanionInboxSseFrame,
  parseCompanionSseFrame,
} from "../gateway/desktop-gateway";

const pairingSecret = Buffer.alloc(32, 9);
const pairingSecretEncoded = pairingSecret.toString("base64url");

function environment(): NodeJS.ProcessEnv {
  return {
    DESKTOP_API_ORIGIN: "http://127.0.0.1:4000",
    ASTELLA_DESKTOP_PAIRING_KEY_ID: "desktop-key-1",
    ASTELLA_DESKTOP_PAIRING_SECRET: pairingSecretEncoded,
    ASTELLA_DOMAIN_SCHEMA_REVISION: "domain-v2-test",
  };
}

function trustResponse(request: Record<string, unknown>): Response {
  const unsigned = {
    version: 1 as const,
    nonce: request.nonce as string,
    serviceId: DESKTOP_API_SERVICE_ID,
    ipcContractVersion: DESKTOP_IPC_CONTRACT_VERSION,
    domainSchemaRevision: "domain-v2-test",
    pairingKeyId: "desktop-key-1",
    instanceId: "instance-1",
    algorithm: "HMAC-SHA256" as const,
  };
  const signature = createHmac("sha256", pairingSecret)
    .update(desktopTrustSignatureMessage(unsigned), "ascii")
    .digest("hex");
  return new Response(JSON.stringify({ ...unsigned, signature }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function healthResponse(): Response {
  return new Response(JSON.stringify({
    status: "ok",
    service: "api",
    timestamp: new Date().toISOString(),
  }), { status: 200 });
}

const ROOM_CAPABILITY = capabilityProjectionSchema.parse({
  version: 1,
  revision: "desktop-capability-v1:test",
  workspaceEpoch: 1,
  actionCapabilities: Object.fromEntries(actionCapabilityValues.map((key) => [key, key === "note.save" ? "allowed" : "denied"])),
  featureAvailability: Object.fromEntries(featureNameValues.map((key) => [key, key === "companion_dialogue_v1" ? { state: "enabled" } : { state: "disabled", reason: "error.feature_disabled" }])),
  nativeCapabilities: {
    filePicker: "unavailable",
    clipboard: "unavailable",
    notifications: "unavailable",
    asr: "unavailable",
    updates: "unavailable",
    live2d: "unavailable",
  },
});

const NOTE_DETAIL = noteDetailV1Schema.parse({
  version: 1,
  noteId: "00000000-0000-4000-8000-000000000010",
  workspaceId: "00000000-0000-4000-8000-000000000011",
  title: "真实 Note",
  titleSource: "manual",
  sourceId: null,
  currentVersionId: "00000000-0000-4000-8000-000000000012",
  currentVersion: {
    versionId: "00000000-0000-4000-8000-000000000012",
    noteId: "00000000-0000-4000-8000-000000000010",
    versionNo: 1,
    contentHash: "0123456789abcdef0123456789abcdef",
    createdAt: "2026-08-23T00:00:00.000Z",
    updatedAt: "2026-08-23T00:00:00.000Z",
    blocks: [{ ordinal: 0, type: "paragraph", content: "正文" }],
  },
  // 归属两态是详情的一部分：列表与详情都要说得出"别人看不看得到这篇"。
  shareScope: "private",
  permissions: { canRead: true, canEdit: false, canSave: false, canShare: true },
  revision: "00000000-0000-4000-8000-000000000012",
  snapshotAt: "2026-08-23T00:00:00.000Z",
});

const NOTE_SAVE_RECEIPT = noteSaveReceiptV1Schema.parse({
  version: 1,
  status: "committed",
  noteId: NOTE_DETAIL.noteId,
  workspaceId: NOTE_DETAIL.workspaceId,
  baseVersionId: NOTE_DETAIL.currentVersionId,
  versionId: "00000000-0000-4000-8000-000000000013",
  currentVersionId: "00000000-0000-4000-8000-000000000013",
  versionNo: 2,
  revision: "00000000-0000-4000-8000-000000000013",
  savedAt: "2026-08-23T00:00:03.000Z",
});

const COMPANION_ROOM_PROFILE = companionRoomProfileV1Schema.parse({
  version: 1,
  revision: 3,
  unlockedDecorIds: ["keepsake.first-note", "keepsake.first-review"],
  equippedDecorBySlot: {
    desk: "keepsake.first-note",
    shelf: null,
    window: null,
    rest: "keepsake.first-review",
  },
  unlockedEffectIds: ["effect.page-ribbon"],
  equippedEffectId: "effect.page-ribbon",
  proactiveMuted: false,
  updatedAt: "2026-08-23T00:00:03.000Z",
});

const COMPANION_HOME_PROJECTION = companionHomeProjectionV1Schema.parse({
  version: 1,
  snapshotAt: "2026-08-23T00:00:04.000Z",
  profileSummary: {
    name: "小岚",
    activeness: "moderate",
    boundaries: {
      allowPlayful: true,
      allowNudgeLearning: true,
      allowVoiceTags: false,
      catchphrase: "慢慢来。",
    },
    familiarity: 0.65,
    interactionCount: 12,
    source: "saved_profile",
  },
  memorySummary: {
    confirmedCount: 4,
    candidateCount: 1,
    updatedAt: "2026-08-23T00:00:02.000Z",
  },
  proactiveCue: {
    text: "今天还有一张复习卡。",
    expiresAt: "2026-08-23T00:10:00.000Z",
    revision: 2,
  },
  roomProfile: COMPANION_ROOM_PROFILE,
});

const COMPANION_ROOM_PATCH = companionRoomProfilePatchV1Schema.parse({
  version: 1,
  revision: 3,
  equippedDecorBySlot: {
    rest: null,
    window: "keepsake.first-note",
  },
  equippedEffectId: null,
  proactiveMuted: false,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseCompanionSseFrame（伴星 SSE 帧的过桥门槛）", () => {
  const frame = (payload: Record<string, unknown>, seq = 7): string =>
    `id: 2de8a3e9-f127-4089-80d5-ede6dd980d53:${seq}\nevent: companion\ndata: ${JSON.stringify({
      version: 1,
      eventId: `2de8a3e9-f127-4089-80d5-ede6dd980d53:${seq}`,
      seq,
      workspaceId: "97550966-adf4-47fa-8d91-f83eae9ebfc0",
      conversationId: "2de8a3e9-f127-4089-80d5-ede6dd980d53",
      runId: "f3bb3bf9-e241-4360-8b0f-faee864032c0",
      generation: 1,
      accountEpoch: 0,
      createdAt: "2026-09-19T03:30:10.000Z",
      ...payload,
    })}\n\n`;

  it("合法帧投影成最小形状（seq/runId/generation/事件类型/payload）", () => {
    const parsed = parseCompanionSseFrame(frame({ type: "assistant.delta", payload: { appendFrom: 0, textDelta: "你好" } }));
    expect(parsed).toEqual({
      seq: 7,
      runId: "f3bb3bf9-e241-4360-8b0f-faee864032c0",
      generation: 1,
      eventType: "assistant.delta",
      payload: { appendFrom: 0, textDelta: "你好" },
    });
  });

  it("心跳注释帧与空帧直接丢弃", () => {
    expect(parseCompanionSseFrame(": heartbeat 1789788618000\n\n")).toBeNull();
    expect(parseCompanionSseFrame("")).toBeNull();
  });

  it("畸形 JSON / 缺字段 / payload 不合分支合同一律丢弃（不透传原始帧）", () => {
    expect(parseCompanionSseFrame("data: {not json}\n\n")).toBeNull();
    // 事件类型缺失同样丢弃（没有类型的帧渲染层无从处理）。
    expect(parseCompanionSseFrame(frame({ payload: { textDelta: "x" } }))).toBeNull();
    // 主进程按 shared 分支 schema 严格校验 payload：assistant.delta 缺 appendFrom
    // 不再"放行给渲染层收窄"，而是整个丢弃（方案 §5 过桥门槛）。
    expect(parseCompanionSseFrame(frame({ type: "assistant.delta", payload: { textDelta: "x" } }))).toBeNull();
    expect(parseCompanionSseFrame(frame({ type: "assistant.delta", payload: { appendFrom: 0, textDelta: "x" } }))?.seq).toBe(7);
    expect(parseCompanionSseFrame('data: {"seq":1}\n\n')).toBeNull();
    expect(parseCompanionSseFrame(frame({ type: "assistant.delta", payload: "不是对象" }))).toBeNull();
    expect(parseCompanionSseFrame(frame({ type: "assistant.delta", payload: null }))).toBeNull();
  });

  it("payload 超过 16KB 的异常帧被拦下", () => {
    const huge = { type: "assistant.delta", payload: { appendFrom: 0, textDelta: "甲".repeat(20_000) } };
    expect(parseCompanionSseFrame(frame(huge))).toBeNull();
  });

  it("真实正文保存回执允许传递受限的长 CRDT 更新，超出合同仍丢弃", () => {
    const tool = { toolCallId: "edit-call", name: "notes.write.edit", toolVersion: "1.0.0", riskClass: "reversible_low", status: "succeeded", safeLabel: "已保存正文",
      noteEdit: { kind: "edited_note", noteId: "11111111-1111-4111-8111-111111111111", noteVersionId: "22222222-2222-4222-8222-222222222222", operation: "append", summary: "已追加", update: "A".repeat(24_000) } };
    expect(parseCompanionSseFrame(frame({ type: "agent.tool", payload: { tool } }))?.payload.tool).toEqual(tool);
    expect(parseCompanionSseFrame(frame({ type: "agent.tool", payload: { tool: { ...tool, noteEdit: { ...tool.noteEdit, update: "A".repeat(3_000_001) } } } }))).toBeNull();
  });
});

describe("伴星壳层 SSE 帧校验", () => {
  it("只接受严格的账号关闭事件", () => {
    const event = {
      version: 1,
      type: "account.global_off",
      userId: "00000000-0000-4000-8000-000000000011",
      epoch: 4,
    };
    expect(parseCompanionAccountSseFrame(`data: ${JSON.stringify(event)}\n\n`)?.epoch).toBe(4);
    expect(parseCompanionAccountSseFrame(`data: ${JSON.stringify({ ...event, token: "leak" })}\n\n`)).toBeNull();
  });

  it("只接受严格的 durable inbox delivery", () => {
    const delivery = {
      version: 2,
      deliveryId: "00000000-0000-4000-8000-000000000021",
      assistantSessionId: null,
      userId: "00000000-0000-4000-8000-000000000011",
      workspaceId: "00000000-0000-4000-8000-000000000012",
      inboxSequence: 9,
      dedupeKey: "delivery:test:9",
      state: "queued",
      kind: "system_event",
      payloadRef: { kind: "system_event", systemEventId: "companion.updated:9", text: "状态已更新" },
      displayLease: null,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    expect(parseCompanionInboxSseFrame(`id: 9\nevent: assistant.delivery\ndata: ${JSON.stringify(delivery)}\n\n`)?.inboxSequence).toBe(9);
    expect(parseCompanionInboxSseFrame(`data: ${JSON.stringify({ ...delivery, authToken: "leak" })}\n\n`)).toBeNull();
    expect(parseCompanionInboxSseFrame("data: {broken}\n\n")).toBeNull();
  });
});

describe("DesktopGateway", () => {
  it("starts untrusted with transport epoch zero and rejects missing pairing config", () => {
    const gateway = new DesktopGateway(environment());
    expect(gateway.getTrust()).toMatchObject({ state: "untrusted", transportEpoch: 1 });

    const unconfigured = new DesktopGateway({ DESKTOP_API_ORIGIN: "http://127.0.0.1:4000" });
    expect(unconfigured.getConnectionState()).toEqual({
      version: 1,
      kind: "configuration_error",
      reason: "pairing_secret_missing",
    });
  });

  it("trusts the exact local API challenge before any domain request", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input).endsWith("/challenge")) {
        expect(new Headers(init?.headers).get("Authorization")).toBeNull();
        const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return trustResponse(request);
      }
      expect(String(input)).toBe("http://127.0.0.1:4000/health");
      return healthResponse();
    });

    const gateway = new DesktopGateway(environment());
    await expect(gateway.connect()).resolves.toMatchObject({ kind: "ready", instanceId: "instance-1" });
    expect(gateway.getTrust()).toMatchObject({ state: "trusted", instanceId: "instance-1", transportEpoch: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("maps login 401 to invalid_credentials instead of auth_required", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/challenge")) return trustResponse(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (url.endsWith("/health")) return healthResponse();
      return new Response(JSON.stringify({ error: "invalid credentials" }), { status: 401 });
    });

    const gateway = new DesktopGateway(environment());
    await gateway.connect();
    await expect(ns_auth.login(gateway.gatewayTransport, gateway.companionBridge, "student@example.com", "wrong-password", "request-login")).rejects.toMatchObject({
      code: "invalid_credentials",
    } satisfies Partial<DesktopGatewayFailure>);
  });

  const authDomainCases: [number, string, GatewayErrorCode][] = [
    [409, "email_exists", "email_exists"],
    [400, "email_exists", "email_exists"],
    [409, "already_consumed", "invite_consumed"],
    [409, "concurrent_consumption", "invite_consumed"],
    [404, "not_found", "invite_invalid"],
    [410, "revoked", "invite_invalid"],
    [410, "expired", "invite_expired"],
    [409, "workspace_limit_reached", "workspace_limit"],
    [409, "already_member", "already_member"],
    // 审计 F31：这个 token 以前不在表里，落进通用 conflict，被翻成"这条学习状态
    // 已经发生变化"——说的不是这件事。现在它有自己的码与文案。
    [409, "personal_workspace_not_shareable", "personal_workspace_not_shareable"],
  ];
  it("does not report a missing workspace as an invalid invitation", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/challenge")) return trustResponse(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (url.endsWith("/health")) return healthResponse();
      return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    });
    const gateway = new DesktopGateway(environment()); await gateway.connect();
    await expect(ns_auth.renameWorkspace(gateway.gatewayTransport, "00000000-0000-4000-8000-000000000012", "新的空间"))
      .rejects.toMatchObject({ code: "not_found", httpStatus: 404 });
  });

  it.each(authDomainCases)("maps register %i/%s onto the %s auth code", async (status, token, code) => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/challenge")) return trustResponse(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (url.endsWith("/health")) return healthResponse();
      return new Response(JSON.stringify({ error: token }), { status });
    });

    const gateway = new DesktopGateway(environment());
    await gateway.connect();
    await expect(ns_auth.register(gateway.gatewayTransport, gateway.companionBridge, "student@example.com", "long-enough-password", undefined, undefined, "request-register"))
      .rejects.toMatchObject({ code } satisfies Partial<DesktopGatewayFailure>);
  });

  it("keeps unknown auth error tokens on the status-based mapping", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/challenge")) return trustResponse(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (url.endsWith("/health")) return healthResponse();
      // Fastify's own validation envelope: no machine-readable domain token.
      return new Response(JSON.stringify({ error: "Bad Request", message: "password: too small" }), { status: 400 });
    });

    const gateway = new DesktopGateway(environment());
    await gateway.connect();
    await expect(ns_auth.register(gateway.gatewayTransport, gateway.companionBridge, "student@example.com", "short", undefined, undefined, "request-register"))
      .rejects.toMatchObject({ code: "validation" } satisfies Partial<DesktopGatewayFailure>);
  });

  it.each([
    [422, "kind_not_preference", "memory_global_kind_rejected"],
    [422, "unknown_reason", "validation"],
  ])("maps memory scope rejection %i/%s to %s without exposing response text", async (status, reason, code) => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/challenge")) return trustResponse(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (url.endsWith("/health")) return healthResponse();
      return new Response(JSON.stringify({ error: "memory_global_scope_rejected", reason,
        message: "Untrusted response text must not reach the renderer" }), { status });
    });
    const gateway = new DesktopGateway(environment());
    await gateway.connect();
    await expect(ns_companion.createCompanionMemory(gateway.gatewayTransport, {
      kind: "preference", content: "讲这篇笔记时先举例", scope: "global",
    })).rejects.toMatchObject({ code, message: code });
    await expect(ns_companion.correctCompanionMemory(gateway.gatewayTransport,
      "00000000-0000-4000-8000-000000000099", { content: "讲解时先举例", appliesWhen: "讲这篇笔记时", expectedRevision: 1 },
    )).rejects.toMatchObject({ code, message: code });
  });

  describe("session credential persistence", () => {
    const SESSION_USER_ID = "00000000-0000-4000-8000-000000000011";
    const SESSION_WORKSPACE_ID = "00000000-0000-4000-8000-000000000012";

    const authEnvelope = (token: string) => ({
      token,
      ctx: { userId: SESSION_USER_ID, workspaceId: SESSION_WORKSPACE_ID, membershipRole: "owner" },
      workspaces: [{
        workspaceId: SESSION_WORKSPACE_ID,
        workspaceName: "书房",
        role: "owner",
        workspaceType: "personal",
        isPersonal: true,
        leftAt: null,
      }],
    });

    const meEnvelope = {
      userId: SESSION_USER_ID,
      workspaceId: SESSION_WORKSPACE_ID,
      email: "student@example.com",
      role: "owner",
      displayName: null,
      avatarUrl: null,
      workspaceName: "书房",
      workspaceType: "personal",
      isPersonal: true,
      personalWorkspaceId: SESSION_WORKSPACE_ID,
      // 0261：服务端边界令牌（本机 epoch 的权威值）。
      workspaceEpoch: 1,
    };

    function fakeStore(initial: string | null = null) {
      const state = { token: initial, saves: [] as string[], clears: 0, remembered: null as import("../gateway/desktop-gateway-credentials").QuickLoginCredential | null };
      return {
        state,
        store: {
          hasStored: () => state.token !== null,
          load: async () => state.token,
          save: async (token: string) => { state.token = token; state.saves.push(token) },
          clear: async () => { state.token = null; state.clears += 1 },
          loadRemembered: async () => state.remembered,
          saveRemembered: async (value: import("../gateway/desktop-gateway-credentials").QuickLoginCredential) => { state.remembered = value; },
          clearRemembered: async () => { state.remembered = null; },
        },
      };
    }

    function routeAuth(record: { loginBody?: string }) {
      return async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/challenge")) return trustResponse(JSON.parse(String(init?.body)) as Record<string, unknown>);
        if (url.endsWith("/health")) return healthResponse();
        if (url.endsWith("/auth/login")) {
          record.loginBody = String(init?.body);
          return new Response(JSON.stringify(authEnvelope("issued-token")), { status: 200 });
        }
        if (url.endsWith("/auth/me")) return new Response(JSON.stringify(meEnvelope), { status: 200 });
        if (url.endsWith("/auth/logout")) return new Response(null, { status: 204 });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      };
    }

    it("leaves a signed-out account closed until its avatar is explicitly used", async () => {
      const { state, store } = fakeStore();
      const fetcher = vi.fn(routeAuth({}));
      vi.stubGlobal("fetch", fetcher);
      const gateway = new DesktopGateway(environment(), { credentials: store });
      await ns_auth.login(gateway.gatewayTransport, gateway.companionBridge, "student@example.com", "password", undefined, true);
      await expect(ns_auth.logout(gateway.gatewayTransport, gateway.companionBridge, undefined, true))
        .resolves.toEqual({ loggedOut: true, serverRevoked: false, quickLoginAvailable: true });
      expect(state.token).toBeNull();
      expect(state.remembered?.token).toBe("issued-token");
      expect(fetcher.mock.calls.some(([url]) => String(url).endsWith("/auth/logout"))).toBe(false);
      const reopened = new DesktopGateway(environment(), { credentials: store });
      await expect(ns_auth.getSession(reopened.gatewayTransport)).resolves.toMatchObject({ status: "anonymous" });
      const hint = await ns_auth.getRememberedAccount(reopened.gatewayTransport);
      expect(hint).toEqual({ email: "student@example.com", displayName: null, avatarDataURL: null });
      await expect(ns_auth.resumeRememberedAccount(reopened.gatewayTransport, reopened.companionBridge))
        .resolves.toMatchObject({ status: "authenticated" });
      expect(state.token).toBe("issued-token");
    });

    it("retires an expired quick credential but preserves it during a network outage", async () => {
      const { state, store } = fakeStore();
      const base = routeAuth({});
      let failure: "offline" | "expired" | null = null;
      vi.stubGlobal("fetch", vi.fn(async (input, init) => {
        if (String(input).endsWith("/auth/me") && failure === "offline") throw new TypeError("offline");
        if (String(input).endsWith("/auth/me") && failure === "expired") return new Response("{}", { status: 401 });
        return base(input, init);
      }));
      const gateway = new DesktopGateway(environment(), { credentials: store });
      await ns_auth.login(gateway.gatewayTransport, gateway.companionBridge, "student@example.com", "password", undefined, true);
      await ns_auth.logout(gateway.gatewayTransport, gateway.companionBridge, undefined, true);
      failure = "offline";
      await expect(ns_auth.resumeRememberedAccount(gateway.gatewayTransport, gateway.companionBridge)).rejects.toBeInstanceOf(DesktopGatewayFailure);
      expect(state.remembered).not.toBeNull();
      expect(gateway.gatewayTransport.token).toBeNull();
      failure = "expired";
      await expect(ns_auth.resumeRememberedAccount(gateway.gatewayTransport, gateway.companionBridge)).rejects.toBeInstanceOf(DesktopGatewayFailure);
      expect(state.remembered).toBeNull();
      expect(state.token).toBeNull();
    });

    it("does not offer or send a remembered credential to a different service", async () => {
      const { state, store } = fakeStore();
      vi.stubGlobal("fetch", vi.fn(routeAuth({})));
      const gateway = new DesktopGateway(environment(), { credentials: store });
      await ns_auth.getSession(gateway.gatewayTransport);
      state.remembered = { origin: "https://another.test", token: "other-token", email: "student@example.com", displayName: null, avatarDataURL: null };
      await expect(ns_auth.getRememberedAccount(gateway.gatewayTransport)).resolves.toBeNull();
      await expect(ns_auth.resumeRememberedAccount(gateway.gatewayTransport, gateway.companionBridge)).rejects.toMatchObject({ code: "auth_required" });
      expect(gateway.gatewayTransport.token).toBeNull();
    });

    it("reports local-file persistence for a device that has not stored a credential yet", async () => {
      const { store } = fakeStore();
      const gateway = new DesktopGateway(environment(), { credentials: store });
      expect(gateway.getRuntimeSnapshot(
        { version: 1, revision: 1, state: "visible" },
        false,
      ).sessionCredential).toEqual({ persistence: "local_file", stored: false });
    });

    it("adopts a stored credential before the first authenticated call", async () => {
      const { store } = fakeStore("stored-token");
      const seen: (string | null)[] = [];
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const url = String(input);
        if (url.endsWith("/challenge")) return trustResponse(JSON.parse(String(init?.body)) as Record<string, unknown>);
        if (url.endsWith("/health")) return healthResponse();
        if (url.endsWith("/auth/me")) {
          seen.push(new Headers(init?.headers).get("Authorization"));
          return new Response(JSON.stringify(meEnvelope), { status: 200 });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      });

      const gateway = new DesktopGateway(environment(), { credentials: store });
      await expect(ns_auth.getSession(gateway.gatewayTransport)).resolves.toMatchObject({
        status: "authenticated",
        credentialPersistence: "local_file",
      });
      expect(seen).toEqual(["Bearer stored-token"]);
    });

    it("waits for the same credential load across concurrent session requests", async () => {
      const { store } = fakeStore("stored-token");
      let resolveLoad!: (token: string | null) => void;
      const load = vi.fn(() => new Promise<string | null>((resolve) => { resolveLoad = resolve }));
      const seen: (string | null)[] = [];
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const url = String(input);
        if (url.endsWith("/challenge")) return trustResponse(JSON.parse(String(init?.body)) as Record<string, unknown>);
        if (url.endsWith("/health")) return healthResponse();
        if (url.endsWith("/auth/me")) {
          seen.push(new Headers(init?.headers).get("Authorization"));
          return new Response(JSON.stringify(meEnvelope), { status: 200 });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      });

      const gateway = new DesktopGateway(environment(), { credentials: { ...store, load } });
      await gateway.connect();
      const completed: string[] = [];
      const readSession = () => ns_auth.getSession(gateway.gatewayTransport).then((session) => {
        completed.push(session.status);
        return session;
      });
      const first = readSession();
      const second = readSession();
      await new Promise<void>((resolve) => setImmediate(resolve));
      const completedWhileLoading = [...completed];
      resolveLoad("stored-token");
      const sessions = await Promise.all([first, second]);

      expect(completedWhileLoading).toEqual([]);
      expect(sessions.map((session) => session.status)).toEqual(["authenticated", "authenticated"]);
      expect(load).toHaveBeenCalledTimes(1);
      expect(seen).toEqual(["Bearer stored-token", "Bearer stored-token"]);
    });

    it("restores and reverifies the authoritative epoch before projecting the workspace", async () => {
      const { store } = fakeStore("stored-token");
      let serverEpoch = 6;
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const url = String(input);
        if (url.endsWith("/challenge")) return trustResponse(JSON.parse(String(init?.body)) as Record<string, unknown>);
        if (url.endsWith("/health")) return healthResponse();
        if (url.endsWith("/auth/me")) return new Response(JSON.stringify({ ...meEnvelope, workspaceEpoch: serverEpoch }), { status: 200 });
        return new Response(JSON.stringify({}), { status: 200 });
      });
      const gateway = new DesktopGateway(environment(), { credentials: store });
      for (const [nextEpoch, expectedEpoch] of [[6, 6], [7, 7], [3, 7]]) {
        serverEpoch = nextEpoch;
        const session = await ns_auth.getSession(gateway.gatewayTransport);
        expect(session.workspaceEpoch).toBe(expectedEpoch);
        expect(session.workspace?.workspaceEpoch).toBe(expectedEpoch);
      }
    });

    it("persists the issued token only when the user keeps the choice", async () => {
      const record: { loginBody?: string } = {};
      vi.spyOn(globalThis, "fetch").mockImplementation(routeAuth(record));

      const keep = fakeStore();
      const kept = new DesktopGateway(environment(), { credentials: keep.store });
      await ns_auth.login(kept.gatewayTransport, kept.companionBridge, "student@example.com", "long-enough-password", "request-a", true);
      expect(JSON.parse(record.loginBody!)).toMatchObject({ remember: true });
      expect(keep.state.saves).toEqual(["issued-token"]);

      const sessionOnly = fakeStore("stale-token");
      const discarded = new DesktopGateway(environment(), { credentials: sessionOnly.store });
      await ns_auth.login(discarded.gatewayTransport, discarded.companionBridge, "student@example.com", "long-enough-password", "request-b", false);
      expect(JSON.parse(record.loginBody!)).toMatchObject({ remember: false });
      expect(sessionOnly.state.saves).toEqual([]);
      expect(sessionOnly.state.clears).toBeGreaterThan(0);
    });

    it("degrades to memory and clears the file when the write fails", async () => {
      const state = { clears: 0 };
      const gateway = new DesktopGateway(environment(), {
        credentials: {
          hasStored: () => false,
          load: async () => null,
          save: async () => { throw new Error("disk full") },
          clear: async () => { state.clears += 1 },
        },
      });
      vi.spyOn(globalThis, "fetch").mockImplementation(routeAuth({}));

      await expect(ns_auth.login(gateway.gatewayTransport, gateway.companionBridge, "student@example.com", "long-enough-password", "request-c", true)).resolves.toMatchObject({
        credentialPersistence: "memory",
      });
      expect(state.clears).toBeGreaterThan(0);
    });

    it("retires a dead stored credential and asks for a fresh sign-in", async () => {
      const { store, state } = fakeStore("expired-token");
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const url = String(input);
        if (url.endsWith("/challenge")) return trustResponse(JSON.parse(String(init?.body)) as Record<string, unknown>);
        if (url.endsWith("/health")) return healthResponse();
        return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
      });

      const gateway = new DesktopGateway(environment(), { credentials: store });
      // `auth_required`, not `reauth_required`: there is no account to re-confirm,
      // so the renderer must fall back to the sign-in form.
      await expect(ns_auth.getSession(gateway.gatewayTransport)).rejects.toMatchObject({ code: "auth_required" } satisfies Partial<DesktopGatewayFailure>);
      expect(state.token).toBeNull();
      expect(state.clears).toBe(1);
    });

    it("signs out locally, and offline, once the stored credential is in hand", async () => {
      const { store, state } = fakeStore("stored-token");
      let serverReachable = true;
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const url = String(input);
        if (url.endsWith("/challenge")) return trustResponse(JSON.parse(String(init?.body)) as Record<string, unknown>);
        if (url.endsWith("/health")) return healthResponse();
        if (!serverReachable) throw new TypeError("network down");
        if (url.endsWith("/auth/me")) return new Response(JSON.stringify(meEnvelope), { status: 200 });
        return new Response(null, { status: 204 });
      });

      const gateway = new DesktopGateway(environment(), { credentials: store });
      await ns_auth.getSession(gateway.gatewayTransport);
      serverReachable = false;
      await expect(ns_auth.logout(gateway.gatewayTransport, gateway.companionBridge, "request-d")).rejects.toBeInstanceOf(DesktopGatewayFailure);
      expect(state.token).toBeNull();
      expect(state.clears).toBeGreaterThan(0);
    });

    it("still drops a stored credential that a sign-out never adopted", async () => {
      const { store, state } = fakeStore("stored-token");
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const url = String(input);
        if (url.endsWith("/challenge")) return trustResponse(JSON.parse(String(init?.body)) as Record<string, unknown>);
        if (url.endsWith("/health")) return healthResponse();
        return new Response(null, { status: 204 });
      });

      const gateway = new DesktopGateway(environment(), { credentials: store });
      await expect(ns_auth.logout(gateway.gatewayTransport, gateway.companionBridge, "request-e")).resolves.toEqual({ loggedOut: true, serverRevoked: false });
      expect(state.token).toBeNull();
      expect(state.clears).toBe(1);
    });
  });

  it("redeems an invite through /auth/join-workspace and reloads the session", async () => {
    const requested: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/challenge")) return trustResponse(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (url.endsWith("/health")) return healthResponse();
      if (url.endsWith("/auth/join-workspace")) {
        requested.push(String(init?.body));
        return new Response(JSON.stringify({ workspaceId: "00000000-0000-4000-8000-000000000099", workspaceName: "Studio", role: "member" }), { status: 200 });
      }
      if (url.endsWith("/auth/me")) {
        return new Response(JSON.stringify({
          userId: "00000000-0000-4000-8000-000000000011",
          workspaceId: "00000000-0000-4000-8000-000000000099",
          email: "student@example.com",
          role: "member",
          displayName: null,
          avatarUrl: null,
          workspaceName: "Studio",
          workspaceType: "collaborative",
          isPersonal: false,
          personalWorkspaceId: null,
          workspaceEpoch: 1,
        }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });

    const gateway = new DesktopGateway(environment());
    await gateway.connect();
    await expect(ns_auth.joinWorkspace(gateway.gatewayTransport, "invite-token-1", "request-join")).resolves.toMatchObject({
      status: "authenticated",
      workspace: { workspaceId: "00000000-0000-4000-8000-000000000099" },
    });
    expect(requested).toEqual([JSON.stringify({ inviteToken: "invite-token-1" })]);
  });

  it("reports an already-committed join when the session re-read fails", async () => {
    // 加入是两次往返：`POST /auth/join-workspace` 整笔落库，再 `GET /auth/me` 投影回本机。
    // 第二跳失败不能把已经成功的加入说成失败——那正是"第一次报错、第二次说码被用过、
    // 第三张新码说已经在空间里"这一串的来源。
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/challenge")) return trustResponse(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (url.endsWith("/health")) return healthResponse();
      if (url.endsWith("/auth/join-workspace")) {
        return new Response(JSON.stringify({ workspaceId: "00000000-0000-4000-8000-000000000099", workspaceName: "Studio", role: "member" }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: "internal_error" }), { status: 500 });
    });

    const gateway = new DesktopGateway(environment());
    await gateway.connect();
    await expect(ns_auth.joinWorkspace(gateway.gatewayTransport, "invite-token-1", "request-join"))
      .rejects.toMatchObject({ code: "join_committed_session_stale", retry: "resync_first" });
  });

  it("does not soften a join the server actually refused", async () => {
    // 反面对照：409 `already_consumed` 发生在 POST 那一跳，库里什么都没写，
    // 必须原样把域名失败传出去，不能被"已提交"那格吞掉。
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/challenge")) return trustResponse(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (url.endsWith("/health")) return healthResponse();
      return new Response(JSON.stringify({ error: "already_consumed" }), { status: 409 });
    });

    const gateway = new DesktopGateway(environment());
    await gateway.connect();
    await expect(ns_auth.joinWorkspace(gateway.gatewayTransport, "invite-token-1", "request-join"))
      .rejects.toMatchObject({ code: "invite_consumed" });
  });

  

  

  

  

  

  

  

  

  

  

  /**
   * 「保存并开启复习」这一档从主进程走到 HTTP 的那一段（39d W7-2 两颗按钮）。
   *
   * 为什么要在网关这一层再量一次：渲染层的用例只到 `window.astella` 为止，通道那一发
   * 替身顶掉了整个网关——**这一档真正落到请求体上**这件事没人看过。这一格丢了，
   * 屏幕上那颗按钮按下去仍然保存成功、仍然回一句"第一次复习排在…"（要是替身还带着排期），
   * 而库里一条安排都不会有。两发一起量：要排期的带着 `true`，没说的**连键都不出现**
   * （传输层不替用户补一个"不要"）。
   */
  


  it("builds the room projection from note and source lists and never reads the retired dashboard", async () => {
    const urls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith("/challenge")) return trustResponse(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (url.endsWith("/health")) return healthResponse();
      if (url.endsWith("/v1/auth/capabilities")) {
        return new Response(JSON.stringify(ROOM_CAPABILITY), { status: 200 });
      }
      if (url.includes("/notes?")) {
        return new Response(JSON.stringify({
          items: [{
            id: "11111111-1111-4111-8111-111111111111",
            title: "秦朝统一与中央集权制度",
            titleSource: "user",
            currentVersionId: null,
            createdAt: "2026-10-19T00:00:00.000Z",
            updatedAt: "2026-10-19T01:00:00.000Z",
            firstImageBlock: null,
            hasBody: true,
            shelfState: null,
          }],
          nextCursor: null,
          total: 1,
        }), { status: 200 });
      }
      if (url.includes("/sources?")) {
        return new Response(JSON.stringify({ items: [], nextCursor: null, total: 3 }), { status: 200 });
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const gateway = new DesktopGateway(environment());
    await gateway.connect();
    const projection = await gateway.getRoomProjection();

    expect(projection.dashboardRevision).toBe("room-1-3-11111111-1111-4111-8111-111111111111");
    expect(projection.mode).toBe("notes");
    expect(projection.recentActivitySummary).toMatchObject({
      state: "data",
      data: { items: [{ activityId: "11111111-1111-4111-8111-111111111111", kind: "note.updated", occurredAt: "2026-10-19T01:00:00.000Z" }] },
    });
    expect(projection.captureCapability).toEqual({ state: "enabled" });
    expect(urls.some((url) => url.includes("/v2/learning-dashboard"))).toBe(false);
  });

  it("reports an unavailable room projection when notes cannot be read", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/challenge")) return trustResponse(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (url.endsWith("/health")) return healthResponse();
      if (url.endsWith("/v1/auth/capabilities")) {
        return new Response(JSON.stringify(ROOM_CAPABILITY), { status: 200 });
      }
      if (url.includes("/notes?")) return new Response(null, { status: 503 });
      if (url.includes("/sources?")) return new Response(JSON.stringify({ items: [], nextCursor: null, total: 0 }), { status: 200 });
      throw new Error(`unexpected URL ${url}`);
    });

    const gateway = new DesktopGateway(environment());
    await gateway.connect();
    await expect(gateway.getRoomProjection()).rejects.toMatchObject({ code: "safe_internal_error" });
  });

  it("bridges companion home reads and room-profile CAS updates through strict API contracts", async () => {
    const companionRequests: Array<{
      readonly path: string;
      readonly method: string;
      readonly body: unknown;
    }> = [];
    let homeProjectionBody: unknown = COMPANION_HOME_PROJECTION;

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/challenge")) {
        return trustResponse(JSON.parse(String(init?.body)) as Record<string, unknown>);
      }
      if (url.pathname.endsWith("/health")) return healthResponse();
      if (url.pathname === "/companion/home-projection") {
        companionRequests.push({
          path: url.pathname,
          method: init?.method ?? "GET",
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        return new Response(JSON.stringify(homeProjectionBody), { status: 200 });
      }
      if (url.pathname === "/companion/room-profile") {
        companionRequests.push({
          path: url.pathname,
          method: init?.method ?? "GET",
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        return new Response(JSON.stringify(COMPANION_ROOM_PROFILE), { status: 200 });
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const gateway = new DesktopGateway(environment());
    await gateway.connect();

    await expect(ns_companion.getCompanionHomeProjection(gateway.gatewayTransport, "request-companion-home"))
      .resolves.toEqual(COMPANION_HOME_PROJECTION);
    await expect(ns_companion.getCompanionRoomProfile(gateway.gatewayTransport, "request-companion-room"))
      .resolves.toEqual(COMPANION_ROOM_PROFILE);
    await expect(ns_companion.patchCompanionRoomProfile(gateway.gatewayTransport, COMPANION_ROOM_PATCH, "request-companion-patch"))
      .resolves.toEqual(COMPANION_ROOM_PROFILE);

    expect(companionRequests).toEqual([
      { path: "/companion/home-projection", method: "GET", body: null },
      { path: "/companion/room-profile", method: "GET", body: null },
      { path: "/companion/room-profile", method: "PATCH", body: COMPANION_ROOM_PATCH },
    ]);

    homeProjectionBody = { ...COMPANION_HOME_PROJECTION, memoryText: "must stay server-side" };
    await expect(ns_companion.getCompanionHomeProjection(gateway.gatewayTransport, "request-companion-invalid"))
      .rejects.toMatchObject({ code: "unsupported_contract", retry: "user_action" });
  });

  it("routes companion onboarding through the strict account CAS transition", async () => {
    const sent: unknown[] = [];
    const state = {
      onboardingVersion: "home-v2-v1",
      revision: 1,
      offerStatus: "offered",
      activeRun: {
        runId: "run-home-v2-1",
        entryMode: "first_run",
        runStatus: "in_progress",
        stepId: "welcome",
        resumeTokenRef: "resume-home-v2-1",
        resumeWorkspaceRef: "00000000-0000-4000-8000-000000000099",
        expiresAt: "2026-09-19T01:00:00.000Z",
      },
      updatedAt: "2026-09-19T00:00:00.000Z",
    } as const;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/challenge")) return trustResponse(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (url.pathname.endsWith("/health")) return healthResponse();
      if (url.pathname === "/me/companion/onboarding/home-v2-v1/transition") {
        sent.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ won: true, state }), { status: 200 });
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const gateway = new DesktopGateway(environment());
    await gateway.connect();
    await expect(ns_companion.transitionCompanionOnboarding(gateway.gatewayTransport, "home-v2-v1", { action: "start" }))
      .resolves.toEqual({ won: true, state });
    expect(sent).toEqual([{ action: "start" }]);
  });

  it("loads the companion activity timeline newest-first without reusing the inbox after cursor", async () => {
    const requested: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/challenge")) return trustResponse(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (url.pathname.endsWith("/health")) return healthResponse();
      if (url.pathname === "/companion/deliveries/timeline") {
        requested.push(url.search);
        return new Response(JSON.stringify({ items: [], nextCursor: 0, serverTime: "2026-09-19T00:00:00.000Z" }), { status: 200 });
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const gateway = new DesktopGateway(environment());
    await gateway.connect();
    await expect(ns_companion.listCompanionActivityTimeline(gateway.gatewayTransport, )).resolves.toMatchObject({ version: 1, items: [], nextCursor: 0 });
    await expect(ns_companion.listCompanionActivityTimeline(gateway.gatewayTransport, 42)).resolves.toMatchObject({ version: 1, items: [], nextCursor: 0 });
    expect(requested).toEqual(["?limit=50", "?limit=50&before=42"]);
  });

  

  it("speaks companion cues through POST /voice/tts with raw audio-only wire rules", async () => {
    const ttsRequests: Array<{
      readonly path: string;
      readonly method: string;
      readonly accept: string | null;
      readonly contentType: string | null;
      readonly authorization: string | null;
      readonly body: unknown;
    }> = [];
    const audioBytes = new Uint8Array([0x49, 0x44, 0x33, 0x04]);

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/challenge")) {
        return trustResponse(JSON.parse(String(init?.body)) as Record<string, unknown>);
      }
      if (url.pathname.endsWith("/health")) return healthResponse();
      if (url.pathname === "/voice/tts") {
        const headers = new Headers(init?.headers);
        ttsRequests.push({
          path: url.pathname,
          method: init?.method ?? "GET",
          accept: headers.get("Accept"),
          contentType: headers.get("Content-Type"),
          authorization: headers.get("Authorization"),
          body: JSON.parse(String(init?.body)) as unknown,
        });
        return new Response(audioBytes, { status: 200, headers: { "Content-Type": "audio/mpeg" } });
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const gateway = new DesktopGateway(environment());
    await gateway.connect();
    // 2026-09-30：token 已搬进 `GatewayTransport`（见 `desktop-gateway-transport.ts`）。
    // 原来这里 `Object.defineProperty(gateway, "token", …)` 给**实例**加了一个属性，
    // 而发请求读的是 `this.transport.token` —— 于是头悄悄没了，报错却指向「请求头不对」。
(gateway as unknown as { transport: { token: string | null } }).transport.token = "test-voice-token";

    const request = { version: 1 as const, text: "今天还有一张复习卡。" };
    const spoken = await ns_companion.speakCompanionVoice(gateway.gatewayTransport, request, "request-companion-voice");
    expect(spoken).toEqual({
      version: 1,
      mimeType: "audio/mpeg",
      audioBase64: "SUQzBA==",
      byteLength: audioBytes.byteLength,
      voice: COMPANION_VOICE_SPEAK_VOICE,
    });
    // 返回值必须是冻结合同的 strict parse 结果，可直接回传 renderer。
    expect(companionVoiceSpeakResultV1Schema.parse(spoken)).toEqual(spoken);

    expect(ttsRequests).toEqual([{
      path: "/voice/tts",
      method: "POST",
      accept: "audio/mpeg",
      contentType: "application/json",
      authorization: "Bearer test-voice-token",
      body: { text: request.text, voice: "zh-CN-XiaoxiaoNeural" },
    }]);
    await ns_companion.speakCompanionVoice(gateway.gatewayTransport, { ...request, purpose: "notification" }, "request-notification-voice");
    expect(ttsRequests[1].body).toEqual({ text: request.text, voice: "zh-CN-XiaoxiaoNeural", purpose: "notification" });
    await ns_companion.speakCompanionVoice(gateway.gatewayTransport, { ...request, purpose: "guidance" }, "request-guide-voice");
    expect(ttsRequests[2].body).toEqual({ text: request.text, voice: "zh-CN-XiaoxiaoNeural", purpose: "guidance" });
  });

  it("fails closed on non-audio, oversized and failed companion voice responses", async () => {
    const ttsRequests: string[] = [];
    let ttsResponse = (): Response => new Response(JSON.stringify({ error: "TTS_FAILED", recoverable: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/challenge")) {
        return trustResponse(JSON.parse(String(init?.body)) as Record<string, unknown>);
      }
      if (url.pathname.endsWith("/health")) return healthResponse();
      if (url.pathname === "/voice/tts") {
        ttsRequests.push(url.pathname);
        return ttsResponse();
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const gateway = new DesktopGateway(environment());
    await gateway.connect();
    const request = { version: 1 as const, text: "慢慢来。" };

    // 200 JSON（非音频）响应绝不能被当作音频接受。
    await expect(ns_companion.speakCompanionVoice(gateway.gatewayTransport, request, "request-voice-json"))
      .rejects.toMatchObject({ code: "unsupported_contract", retry: "user_action" });

    // 超限 body：即使没有 content-length 也必须按字节硬截断。
    ttsResponse = () => new Response(new Uint8Array(COMPANION_VOICE_MAX_AUDIO_BYTES + 1), {
      status: 200,
      headers: { "Content-Type": "audio/mpeg" },
    });
    await expect(ns_companion.speakCompanionVoice(gateway.gatewayTransport, request, "request-voice-oversized"))
      .rejects.toMatchObject({ code: "unsupported_contract", retry: "user_action" });

    // 声明了超限 content-length 的音频响应同样在读取前被拒绝。
    ttsResponse = () => new Response(new Uint8Array([0x49, 0x44, 0x33]), {
      status: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Content-Length": String(COMPANION_VOICE_MAX_AUDIO_BYTES + 1),
      },
    });
    await expect(ns_companion.speakCompanionVoice(gateway.gatewayTransport, request, "request-voice-declared-oversized"))
      .rejects.toMatchObject({ code: "unsupported_contract", retry: "user_action" });

    // 服务端 502 是可恢复失败，不是 crash，也不把 JSON error body 透给 renderer。
    ttsResponse = () => new Response(JSON.stringify({ error: "TTS_FAILED", recoverable: true }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
    await expect(ns_companion.speakCompanionVoice(gateway.gatewayTransport, request, "request-voice-502"))
      .rejects.toMatchObject({ code: "safe_internal_error", retry: "user_action", httpStatus: 502 });

    expect(ttsRequests).toEqual([
      "/voice/tts",
      "/voice/tts",
      "/voice/tts",
      "/voice/tts",
    ]);
  });

  const sourceImageObjectKey =
    "11111111-1111-4111-8111-111111111111/sources/22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333.png";

  it("reads an in-app source image over GET /uploads with the session token", async () => {
    const imageRequests: Array<{
      readonly path: string;
      readonly method: string;
      readonly accept: string | null;
      readonly authorization: string | null;
    }> = [];
    // 真 PNG 头：这条通道只搬运字节，不做任何解码。
    const imageBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/challenge")) {
        return trustResponse(JSON.parse(String(init?.body)) as Record<string, unknown>);
      }
      if (url.pathname.endsWith("/health")) return healthResponse();
      if (url.pathname === `/uploads/${sourceImageObjectKey}`) {
        const headers = new Headers(init?.headers);
        imageRequests.push({
          path: url.pathname,
          method: init?.method ?? "GET",
          accept: headers.get("Accept"),
          authorization: headers.get("Authorization"),
        });
        return new Response(imageBytes, { status: 200, headers: { "Content-Type": "image/png" } });
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const gateway = new DesktopGateway(environment());
    await gateway.connect();
    // 2026-09-30：token 已搬进 `GatewayTransport`（见 `desktop-gateway-transport.ts`）。
    // 原来这里 `Object.defineProperty(gateway, "token", …)` 给**实例**加了一个属性，
    // 而发请求读的是 `this.transport.token` —— 于是头悄悄没了，报错却指向「请求头不对」。
(gateway as unknown as { transport: { token: string | null } }).transport.token = "test-image-token";

    const image = await ns_source.getSourceImage(gateway.gatewayTransport, 
      { version: 1, objectKey: sourceImageObjectKey },
      "request-source-image",
    );
    expect(image).toEqual({
      version: 1,
      mimeType: "image/png",
      imageBase64: "iVBORw0KGgo=",
      byteLength: imageBytes.byteLength,
    });
    // 返回值必须是冻结合同的 strict parse 结果，可直接回传 renderer。
    expect(sourceImageGetResultV1Schema.parse(image)).toEqual(image);

    expect(imageRequests).toEqual([{
      path: `/uploads/${sourceImageObjectKey}`,
      method: "GET",
      accept: "image/*",
      authorization: "Bearer test-image-token",
    }]);
  });

  it("fails closed on non-image, unsupported, oversized and missing source images", async () => {
    let imageResponse = (): Response => new Response(JSON.stringify({ error: "not_found" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/challenge")) {
        return trustResponse(JSON.parse(String(init?.body)) as Record<string, unknown>);
      }
      if (url.pathname.endsWith("/health")) return healthResponse();
      if (url.pathname.startsWith("/uploads/")) return imageResponse();
      throw new Error(`unexpected URL ${url}`);
    });

    const gateway = new DesktopGateway(environment());
    await gateway.connect();
    // 2026-09-30：token 已搬进 `GatewayTransport`（见 `desktop-gateway-transport.ts`）。
    // 原来这里 `Object.defineProperty(gateway, "token", …)` 给**实例**加了一个属性，
    // 而发请求读的是 `this.transport.token` —— 于是头悄悄没了，报错却指向「请求头不对」。
(gateway as unknown as { transport: { token: string | null } }).transport.token = "test-image-token";
    const request = { version: 1 as const, objectKey: sourceImageObjectKey };

    // 200 JSON（非图片）响应绝不能被当作图片接受。
    await expect(ns_source.getSourceImage(gateway.gatewayTransport, request, "request-image-json"))
      .rejects.toMatchObject({ code: "unsupported_contract", retry: "user_action" });

    // image/* 里不被合同承认的子类型（这里 svg 可携带脚本）同样 fail closed。
    imageResponse = () => new Response(new Uint8Array([0x3c, 0x73, 0x76, 0x67]), {
      status: 200,
      headers: { "Content-Type": "image/svg+xml" },
    });
    await expect(ns_source.getSourceImage(gateway.gatewayTransport, request, "request-image-svg"))
      .rejects.toMatchObject({ code: "unsupported_contract", retry: "user_action" });

    // 超限 body：即使没有 content-length 也必须按字节硬截断。
    imageResponse = () => new Response(new Uint8Array(SOURCE_IMAGE_MAX_BYTES + 1), {
      status: 200,
      headers: { "Content-Type": "image/png" },
    });
    await expect(ns_source.getSourceImage(gateway.gatewayTransport, request, "request-image-oversized"))
      .rejects.toMatchObject({ code: "unsupported_contract", retry: "user_action" });

    // 声明了超限 content-length 的图片同样在读取前被拒绝。
    imageResponse = () => new Response(new Uint8Array([0x89, 0x50]), {
      status: 200,
      headers: {
        "Content-Type": "image/png",
        "Content-Length": String(SOURCE_IMAGE_MAX_BYTES + 1),
      },
    });
    await expect(ns_source.getSourceImage(gateway.gatewayTransport, request, "request-image-declared-oversized"))
      .rejects.toMatchObject({ code: "unsupported_contract", retry: "user_action" });

    // 未登记的键、别的租户的键、已删除的对象都由服务端 404 收口，这里如实透传。
    imageResponse = () => new Response(JSON.stringify({ error: "not_found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
    await expect(ns_source.getSourceImage(gateway.gatewayTransport, request, "request-image-missing"))
      .rejects.toMatchObject({ code: "not_found", retry: "never", httpStatus: 404 });
  });

  

  

  it("reads only the strict V2 Note projection and rejects a legacy response", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/challenge")) return trustResponse(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (url.endsWith("/health")) return healthResponse();
      if (url.endsWith(`/v2/notes/${NOTE_DETAIL.noteId}`)) {
        return new Response(JSON.stringify(NOTE_DETAIL), { status: 200 });
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const gateway = new DesktopGateway(environment());
    await gateway.connect();
    await expect(ns_note.getNote(gateway.gatewayTransport, NOTE_DETAIL.noteId)).resolves.toEqual(NOTE_DETAIL);

    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/challenge")) return trustResponse(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (url.endsWith("/health")) return healthResponse();
      return new Response(JSON.stringify({ note: NOTE_DETAIL }), { status: 200 });
    });
    const legacyGateway = new DesktopGateway(environment());
    await legacyGateway.connect();
    await expect(ns_note.getNote(legacyGateway.gatewayTransport, NOTE_DETAIL.noteId)).rejects.toMatchObject({ code: "unsupported_contract" });
  });

  it("maps Note PATCH response loss to result_unknown and never retries the write", async () => {
    let patchCalls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/challenge")) return trustResponse(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (url.endsWith("/health")) return healthResponse();
      if (url.endsWith(`/v2/notes/${NOTE_DETAIL.noteId}`)) {
        patchCalls += 1;
        expect(init?.method).toBe("PATCH");
        expect(JSON.parse(String(init?.body))).toEqual({
          version: 1,
          title: "已保存标题",
          baseVersionId: NOTE_DETAIL.currentVersionId,
        });
        if (patchCalls === 1) throw new TypeError("socket closed after commit");
        return new Response(JSON.stringify(NOTE_SAVE_RECEIPT), { status: 200 });
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const gateway = new DesktopGateway(environment());
    await gateway.connect();
    const request = {
      version: 1 as const,
      title: "已保存标题",
      baseVersionId: NOTE_DETAIL.currentVersionId,
    };
    await expect(ns_note.saveNote(gateway.gatewayTransport, NOTE_DETAIL.noteId, request, "command-note-save")).rejects.toMatchObject({
      code: "result_unknown",
      retry: "resync_first",
    });
    await expect(ns_note.saveNote(gateway.gatewayTransport, NOTE_DETAIL.noteId, request, "command-note-save")).resolves.toEqual(NOTE_SAVE_RECEIPT);
    expect(patchCalls).toBe(2);
  });

  

  

  describe("source capture", () => {
    const WORKSPACE_ID = "00000000-0000-4000-8000-0000000000a1";
    const USER_ID = "00000000-0000-4000-8000-0000000000a2";
    const SOURCE_ID = "00000000-0000-4000-8000-0000000000a3";
    const CAPTURED_AT = "2026-09-16T08:00:00.000Z";

    const capturedDetail = (overrides: Record<string, unknown> = {}) => ({
      source: {
        id: SOURCE_ID,
        workspaceId: WORKSPACE_ID,
        type: "markdown",
        title: "间隔效应",
        origin: null,
        status: "draft",
        createdBy: USER_ID,
        createdAt: CAPTURED_AT,
        updatedAt: CAPTURED_AT,
        noteCount: 0,
        metadata: {},
        ...overrides,
      },
      segments: [],
      // 服务端的真实回执从 F33 起带这个字段：null = 这次真的新建了一份；
      // 非空时返回的是既有那份的详情（界面据此提示"已经采过"）。
      duplicateOf: null,
    });

    function routeCapture(record: { body?: string; method?: string }) {
      return async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/challenge")) return trustResponse(JSON.parse(String(init?.body)) as Record<string, unknown>);
        if (url.endsWith("/health")) return healthResponse();
        if (url.endsWith("/sources")) {
          record.body = String(init?.body);
          record.method = init?.method;
          return new Response(JSON.stringify(capturedDetail()), { status: 200 });
        }
        throw new Error(`unexpected URL ${url}`);
      };
    }

    it("posts the capture payload and returns the parsed detail", async () => {
      const record: { body?: string; method?: string } = {};
      vi.spyOn(globalThis, "fetch").mockImplementation(routeCapture(record));

      const gateway = new DesktopGateway(environment());
      await gateway.connect();
      const detail = await ns_source.createSource(gateway.gatewayTransport, { content: "# 间隔效应\n\n正文", title: "间隔效应" });

      expect(record.method).toBe("POST");
      expect(JSON.parse(String(record.body))).toEqual({ content: "# 间隔效应\n\n正文", title: "间隔效应" });
      expect(detail.source.id).toBe(SOURCE_ID);
      expect(detail.source.status).toBe("draft");
      expect(detail.segments).toEqual([]);
    });

    it("rejects a response that is not a source detail", async () => {
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const url = String(input);
        if (url.endsWith("/challenge")) return trustResponse(JSON.parse(String(init?.body)) as Record<string, unknown>);
        if (url.endsWith("/health")) return healthResponse();
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      });

      const gateway = new DesktopGateway(environment());
      await gateway.connect();
      await expect(ns_source.createSource(gateway.gatewayTransport, { url: "https://example.com/article" }))
        .rejects.toMatchObject({ code: "unsupported_contract" } satisfies Partial<DesktopGatewayFailure>);
    });

    it("maps a member's 403 onto forbidden so the strip can lock itself", async () => {
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const url = String(input);
        if (url.endsWith("/challenge")) return trustResponse(JSON.parse(String(init?.body)) as Record<string, unknown>);
        if (url.endsWith("/health")) return healthResponse();
        return new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
      });

      const gateway = new DesktopGateway(environment());
      await gateway.connect();
      await expect(ns_source.createSource(gateway.gatewayTransport, { content: "材料" }))
        .rejects.toMatchObject({ code: "forbidden" } satisfies Partial<DesktopGatewayFailure>);
    });

    /**
     * doc 34 L13 的下游那一半：`/voice/tts` 走的是取字节那条路，它过去**完全不读**
     * 失败响应的 body，所以服务端在 403 上回的 `ai_consent_required` 到不了界面，
     * "没签 AI 使用同意"被说成"这个账号没权限"。
     */
    it("语音那条路也认 error token：没签同意说的是没签同意，不是没权限", async () => {
      const ttsStatus = { value: 403 };
      const ttsBody = { value: JSON.stringify({ error: "ai_consent_required", message: "服务端那句原文" }) };
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const url = String(input);
        if (url.endsWith("/challenge")) return trustResponse(JSON.parse(String(init?.body)) as Record<string, unknown>);
        if (url.endsWith("/health")) return healthResponse();
        return new Response(ttsBody.value, {
          status: ttsStatus.value,
          headers: { "Content-Type": "application/json" },
        });
      });

      const gateway = new DesktopGateway(environment());
      await gateway.connect();
      const request = { version: 1 as const, text: "今天还有一张复习卡。" };
      const failure = await ns_companion.speakCompanionVoice(gateway.gatewayTransport, request, "request-consent-403").catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(DesktopGatewayFailure);
      expect(failure).toMatchObject({
        code: "ai_consent_required",
        retry: "never",
      } satisfies Partial<DesktopGatewayFailure>);
      // 失败体的 message 就是那个码（`DesktopGatewayFailure` 用 `super(code)`），
      // 所以这一条断的就是"服务端那句原文没有越界"。
      expect((failure as Error).message).toBe("ai_consent_required");

      ttsBody.value = JSON.stringify({ error: "ai_data_policy_denied" });
      await expect(ns_companion.speakCompanionVoice(gateway.gatewayTransport, request, "request-policy-403"))
        .rejects.toMatchObject({ code: "ai_data_policy_denied", retry: "never" });

      // 对照 1：403 上没在名单里的 token 仍然只是 `forbidden`——专用码是白名单，不是"读到了就信"。
      ttsBody.value = JSON.stringify({ error: "TTS_FAILED" });
      await expect(ns_companion.speakCompanionVoice(gateway.gatewayTransport, request, "request-unknown-token"))
        .rejects.toMatchObject({ code: "forbidden" });

      // 对照 2：登录/邀请那一族的 token 在 403 上**也不算数**。它们的意思是路由内的
      // （`not_found` 在邀请路上是"邀请码无效"），要是 403 也照表翻，一次取图失败
      // 就会被说成邀请码问题——这条不是假想，是这次改动被既有用例当场抓到的形状。
      ttsBody.value = JSON.stringify({ error: "not_found" });
      await expect(ns_companion.speakCompanionVoice(gateway.gatewayTransport, request, "request-auth-token-on-403"))
        .rejects.toMatchObject({ code: "forbidden" });

      // 对照 3：403 空 body（旧行为的那条路）不受这次改动影响。
      ttsBody.value = "";
      await expect(ns_companion.speakCompanionVoice(gateway.gatewayTransport, request, "request-empty-body"))
        .rejects.toMatchObject({ code: "forbidden" });
    });

    /**
     * 2026-10-06（全流程走查）：改密失败原来被并进 `forbidden`，界面说的是"当前工作区
     * 或账号没有执行这个动作的权限"——把人送去查权限，而他要做的只是重输当前密码。
     * `/auth/change-password` 的 403 带 `error: "invalid_password"`，网关按 token 翻成
     * `invalid_credentials`；界面那句"当前密码不正确"才有机会出现。
     */
    it("改密的 403 invalid_password 说成凭据问题，不是没权限", async () => {
      const changeBody = { value: JSON.stringify({ error: "invalid_password", message: "当前密码不正确" }) };
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const url = String(input);
        if (url.endsWith("/challenge")) return trustResponse(JSON.parse(String(init?.body)) as Record<string, unknown>);
        if (url.endsWith("/health")) return healthResponse();
        return new Response(changeBody.value, {
          status: 403,
          headers: { "Content-Type": "application/json" },
        });
      });

      const gateway = new DesktopGateway(environment());
      await gateway.connect();
      const failure = await ns_auth
        .changePassword(gateway.gatewayTransport, gateway.companionBridge, "wrong-current", "New-Password-20261006!", "request-change-password-403")
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(DesktopGatewayFailure);
      expect(failure).toMatchObject({ code: "invalid_credentials", retry: "never", httpStatus: 403 } satisfies Partial<DesktopGatewayFailure>);

      // 对照：同一个 403 上别的 token 仍只是 `forbidden`（白名单不是"读到了就信"）。
      changeBody.value = JSON.stringify({ error: "forbidden" });
      await expect(ns_auth.changePassword(gateway.gatewayTransport, gateway.companionBridge, "wrong-current", "New-Password-20261006!", "request-change-password-forbidden"))
        .rejects.toMatchObject({ code: "forbidden" });
    });
  });

  
});

/**
 * The settings page's AI consent block is only honest if its reads and writes
 * go through the server. These tests pin the wire contract: the read parses the
 * server's shape, each write is a real request followed by a re-read (so the UI
 * never shows an optimistic guess), and the native capability values come from
 * the desktop shell rather than from whatever the server guessed.
 */
describe("account AI settings", () => {
  const AI_SETTINGS = {
    version: 1,
    requiresConsent: true,
    consentVersion: null,
    consentAt: null,
    dataPolicy: { sendToExternal: false, sendImageContent: false, piiDetection: true, auditLogging: false },
  };

  function mockApi(handler: (url: string, init?: RequestInit) => Response | null) {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/challenge")) return trustResponse(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (url.endsWith("/health")) return healthResponse();
      const handled = handler(url, init);
      if (handled) return handled;
      throw new Error(`unexpected URL ${url}`);
    });
  }

  it("reads the signed-in account's consent state from the server", async () => {
    mockApi((url) => (url.includes("/me/ai-settings")
      ? new Response(JSON.stringify(AI_SETTINGS), { status: 200 })
      : null));

    const gateway = new DesktopGateway(environment());
    await gateway.connect();
    await expect(ns_workspace.getWorkspaceAiSettings(gateway.gatewayTransport, )).resolves.toEqual(AI_SETTINGS);
  });

  it("signs consent with the shared version and then re-reads the state", async () => {
    const sent: unknown[] = [];
    let signed = false;
    mockApi((url, init) => {
      if (url.includes("/me/ai-consent")) {
        sent.push(JSON.parse(String(init?.body)));
        signed = true;
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      if (url.includes("/me/ai-settings")) {
        return new Response(JSON.stringify({
          ...AI_SETTINGS,
          consentVersion: signed ? "ai-consent-v1" : null,
          consentAt: signed ? "2026-09-17T00:00:00.000Z" : null,
        }), { status: 200 });
      }
      return null;
    });

    const gateway = new DesktopGateway(environment());
    await gateway.connect();
    const answer = await ns_workspace.updateAiConsent(gateway.gatewayTransport, "ai-consent-v1");

    expect(sent).toEqual([{ consentVersion: "ai-consent-v1" }]);
    // The answer is the server's re-read, not the request echoed back.
    expect(answer.consentVersion).toBe("ai-consent-v1");
  });

  it("sends the whole policy object and refuses an unknown contract shape", async () => {
    const sent: unknown[] = [];
    mockApi((url, init) => {
      if (url.includes("/me/ai-data-policy")) {
        sent.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.includes("/me/ai-settings")) {
        return new Response(JSON.stringify({ ...AI_SETTINGS, canManage: "yes" }), { status: 200 });
      }
      return null;
    });

    const gateway = new DesktopGateway(environment());
    await gateway.connect();
    await expect(ns_workspace.updateAiDataPolicy(gateway.gatewayTransport, {
      sendToExternal: true,
      sendImageContent: false,
      piiDetection: true,
      auditLogging: true,
    })).rejects.toMatchObject({ code: "unsupported_contract" } satisfies Partial<DesktopGatewayFailure>);
    expect(sent).toEqual([{ sendToExternal: true, sendImageContent: false, piiDetection: true, auditLogging: true }]);
  });

  it.each(["consent", "policy"] as const)("invalidates cached permissions immediately after changing %s", async (change) => {
    let enabled = false;
    let capabilityReads = 0;
    mockApi((url) => {
      if (url.includes("/v1/auth/capabilities")) {
        capabilityReads += 1;
        return new Response(JSON.stringify({
          version: 1,
          revision: enabled ? "enabled" : "denied",
          workspaceEpoch: 1,
          actionCapabilities: Object.fromEntries(actionCapabilityValues.map((key) => [key, enabled ? "allowed" : "denied"])),
          featureAvailability: Object.fromEntries(featureNameValues.map((key) => [key, { state: "disabled" }])),
          nativeCapabilities: Object.fromEntries(["filePicker", "clipboard", "notifications", "asr", "updates", "live2d"].map((key) => [key, "unavailable"])),
        }), { status: 200 });
      }
      if (url.includes("/me/ai-consent") || url.includes("/me/ai-data-policy")) {
        enabled = true;
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      if (url.includes("/me/ai-settings")) return new Response(JSON.stringify(AI_SETTINGS), { status: 200 });
      return null;
    });
    const gateway = new DesktopGateway(environment());
    await gateway.connect();
    const denied = await ns_source.getCapabilities(gateway.gatewayTransport);
    expect((await ns_source.getCapabilities(gateway.gatewayTransport)).revision).toBe(denied.revision);
    expect(capabilityReads).toBe(1);
    if (change === "consent") await ns_workspace.updateAiConsent(gateway.gatewayTransport, "ai-consent-v1");
    else await ns_workspace.updateAiDataPolicy(gateway.gatewayTransport, { ...AI_SETTINGS.dataPolicy, sendToExternal: true });
    expect((await ns_source.getCapabilities(gateway.gatewayTransport)).revision).toBe("enabled");
    expect(capabilityReads).toBe(2);
  });

  it("shares concurrent capability reads and discards a response from before a policy change", async () => {
    let resolveResponse!: (value: Response) => void;
    let reads = 0;
    const pending = new Promise<Response>(resolve => { resolveResponse = resolve; });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/challenge")) return trustResponse(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (url.endsWith("/health")) return healthResponse();
      reads += 1; return pending;
    });
    const gateway = new DesktopGateway(environment()); await gateway.connect();
    const first = ns_source.getCapabilities(gateway.gatewayTransport);
    const second = ns_source.getCapabilities(gateway.gatewayTransport);
    const firstResult = expect(first).rejects.toMatchObject({ code: "stale_workspace" });
    const secondResult = expect(second).rejects.toMatchObject({ code: "stale_workspace" });
    await vi.waitFor(() => expect(reads).toBe(1));
    gateway.gatewayTransport.forgetCapabilities();
    resolveResponse(new Response("{}", { status: 200 }));
    await Promise.all([firstResult, secondResult]);
    expect(gateway.gatewayTransport.cachedCapabilities).toBeNull();
  });

  it("keeps cancellation attached until every parallel read in a request has settled", async () => {
    let completeJson!: () => void;
    let started = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/challenge")) return trustResponse(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (url.endsWith("/health")) return healthResponse();
      started += 1;
      if (url.endsWith("/parallel-json")) return new Promise<Response>(resolve => {
        completeJson = () => resolve(new Response("{}", { status: 200 }));
      });
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    });
    const gateway = new DesktopGateway(environment()); await gateway.connect();
    const t = gateway.gatewayTransport;
    const json = t.request("/parallel-json", { method: "GET" }, true, true, "parallel-read");
    const image = t.requestBinaryBytes("/parallel-image", { method: "GET" }, {
      accept: "image/*", contentTypePrefix: "image/", maxBytes: 1024,
    }, "parallel-read");
    const cancelled = expect(image).rejects.toMatchObject({ code: "cancelled" });
    await vi.waitFor(() => expect(started).toBe(2));
    completeJson(); await json;
    expect(t.activeRequests.has("parallel-read")).toBe(true);
    t.activeRequests.get("parallel-read")!.abort();
    await cancelled;
    expect(t.activeRequests.has("parallel-read")).toBe(false);
  });

  it("reports native capabilities from the desktop shell, not from the server's placeholder", async () => {
    mockApi((url) => {
      if (url.includes("/v1/auth/capabilities")) {
        // The server cannot know this machine; it answers with a fail-closed
        // placeholder that the main process has to replace.
        return new Response(JSON.stringify({
          version: 1,
          revision: "server",
          workspaceEpoch: 1,
          actionCapabilities: Object.fromEntries(actionCapabilityValues.map((key) => [key, "denied"])),
          featureAvailability: Object.fromEntries(featureNameValues.map((key) => [key, { state: "disabled" }])),
          nativeCapabilities: {
            filePicker: "available",
            clipboard: "available",
            notifications: "available",
            asr: "available",
            updates: "available",
            live2d: "available",
          },
        }), { status: 200 });
      }
      return null;
    });

    const gateway = new DesktopGateway(environment());
    await gateway.connect();
    const projection = await ns_source.getCapabilities(gateway.gatewayTransport, );

    // 剪贴板、本机 ASR 模型管理与自动更新通道已经实现（clipboardReadLinks /
    // companionVoiceAsrModelState / updateCheck），其余仍没有对应通道——答案来自通道
    // 注册表，而不是服务端。自动更新 2026-10-04 接线：检查 / 下载 / 重启安装，
    // 更新源是 GitHub Releases 直连。
    expect(projection.nativeCapabilities).toEqual({
      filePicker: "unavailable",
      clipboard: "available",
      notifications: "unavailable",
      asr: "available",
      updates: "available",
      live2d: "unavailable",
    });
    expect(capabilityProjectionSchema.safeParse(projection).success).toBe(true);
  });
});

/**
 * Workspace export is two halves: the server produces the data, the desktop
 * shell writes the file. The gateway owns only the first half, so these tests
 * pin that it fetches the real endpoint and never invents a payload.
 */
describe("workspace export", () => {
  it("reads the workspace export payload from the server's owner-only route", async () => {
    const requested: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/challenge")) return trustResponse(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (url.endsWith("/health")) return healthResponse();
      if (url.includes("/export/workspace")) {
        requested.push(url);
        return new Response(JSON.stringify({ workspace: { name: "Studio" }, notes: [{ id: "n-1" }] }), { status: 200 });
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const gateway = new DesktopGateway(environment());
    await gateway.connect();
    await expect(ns_workspace.fetchWorkspaceExport(gateway.gatewayTransport, )).resolves.toEqual({
      workspace: { name: "Studio" },
      notes: [{ id: "n-1" }],
    });
    expect(requested).toHaveLength(1);
  });

  it("surfaces a member's 403 instead of writing an empty file", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/challenge")) return trustResponse(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (url.endsWith("/health")) return healthResponse();
      return new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
    });

    const gateway = new DesktopGateway(environment());
    await gateway.connect();
    await expect(ns_workspace.fetchWorkspaceExport(gateway.gatewayTransport, ))
      .rejects.toMatchObject({ code: "forbidden" } satisfies Partial<DesktopGatewayFailure>);
  });
});

describe("DesktopGateway · 笔记正文的离线提交（批次 4.4）", () => {
  const NOTE_ID = "77777777-7777-4777-8777-777777777777";
  const docStateUrl = `/v2/notes/${NOTE_ID}/doc-state`;
  const docUpdateUrl = `/v2/notes/${NOTE_ID}/doc-update`;

  function baseUpdate(): string {
    const doc = emptyNoteDoc();
    syncNoteBlocksForEditor(doc, [
      { type: "heading", content: "标题" },
      { type: "paragraph", content: "第一段" },
    ]);
    setNoteTitle(doc, "标题", "auto");
    return Buffer.from(snapshotOf(doc)).toString("base64");
  }

  /**
   * 把上送的那条增量应用到**同一份**起点上，读出正文——断言的是内容，不是字节。
   *
   * 起点必须逐字节复用：`baseUpdate()` 每调一次就是一份新文档，块条目的 struct id
   * 完全不同，把增量应用到"另一份同样的正文"上会因为找不到被改的那些条目而静默无操作
   * ——症状看着像"增量丢了"，其实是断言自己造了两个事实源。
   */
  function contentsAfter(base: string, updateBase64: string): string[] {
    const doc = emptyNoteDoc();
    Y.applyUpdate(doc, new Uint8Array(Buffer.from(base, "base64")));
    Y.applyUpdate(doc, new Uint8Array(Buffer.from(updateBase64, "base64")));
    const contents = projectNoteBlocks(doc).map((block) => block.content);
    doc.destroy();
    return contents;
  }

  function harness(options: {
    offline?: boolean;
    failStatus?: number;
    shareScope?: "private" | "shared";
    /**
     * 复用同一份服务端起点。跨重启的两个网关必须对着**同一份**编码差分：
     * 各造一份的话两份文档没有共同祖先，合并出来的就是两篇拼在一起，
     * 那测的是"两个事实源"而不是"重启"。
     */
    base?: string;
  } = {}) {
    const base = options.base ?? baseUpdate();
    const uploaded: string[] = [];
    let docStateReads = 0;
    let offline = options.offline ?? false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/challenge")) return trustResponse(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (url.endsWith("/health")) return healthResponse();
      if (offline) throw new TypeError("network down");
      if (url.endsWith(docStateUrl)) {
        docStateReads += 1;
        return new Response(JSON.stringify({
          update: base,
          revision: 3,
          backfilled: false,
          savedAt: "2026-09-21T00:00:00.000Z",
          // 起点带归属：客户端"要不要为这篇建长连接"以服务端为准，不看界面的说法。
          shareScope: options.shareScope ?? ("shared" as const),
        }), { status: 200 });
      }
      if (url.endsWith(docUpdateUrl)) {
        if (options.failStatus) {
          return new Response(JSON.stringify({ error: "forbidden" }), { status: options.failStatus });
        }
        uploaded.push(JSON.parse(String(init?.body)).update as string);
        return new Response(JSON.stringify({
          revision: 4 + uploaded.length,
          savedAt: "2026-09-21T00:00:09.000Z",
        }), { status: 200 });
      }
      throw new Error(`unexpected URL ${url}`);
    });
    const gateway = new DesktopGateway(environment());
    // 2026-09-30：本机正文会话表现在是**模块级状态**（它本来就是进程级的）。
    // 后果是**会话表跨用例串味**——上一个用例留下的会话带着上一个 base 的起点，
    // 这一条再差分就合不进（`note_doc_update_unmerged`）。
    // 每个 harness 开头清一次，**保住「每个用例从干净状态起步」这条既有判据**。
    ns_note.dropNoteDocLocalSessions(gateway.gatewayTransport);
    return { base, gateway, uploaded, docStateReads: () => docStateReads, goOffline: () => { offline = true; }, goOnline: () => { offline = false; } };
  }

/**
 * 本机改了正文：从起点开一份文档、整篇换成"标题 + 这一句"，交回**这一次产生的增量**。
 *
 * 界面交上来的从来不是整篇 blocks 了（那是 C2 之前那条路：主进程替界面差分，界面持有
 * 一份落后就可能覆盖对端的字），所以这批用例都得自己造出真实的本机增量。
 */
  /**
   * 本机连着改正文：每次都从**当前那份状态**出发产下一条增量，而不是每次都从起点出发。
   *
   * 这件事不是实现细节。三条"各自从同一起点整篇重写"的增量合起来是三段文字接在一起
   * （CRDT 不认识"整篇替换"，它只合并操作），而真实编辑器不会那样干——界面上第二次
   * 打字时文档里已经并进了第一次的结果。所以这里按运行状态链下去，与渲染层做的事一致。
   * 按起点字符串分组就够：每次 `harness()` 产出的起点都带着自己的 client id，互不相同。
   */
  const liveDocs = new Map<string, ReturnType<typeof emptyNoteDoc>>();
  const editTo = (base: string, second: string): string => {
    let doc = liveDocs.get(base);
    if (!doc) {
      doc = emptyNoteDoc();
      Y.applyUpdate(doc, Buffer.from(base, "base64"));
      liveDocs.set(base, doc);
    }
    const before = Y.encodeStateVector(doc);
    writeNoteBlocks(doc, [
      { type: "heading", content: "标题" },
      { type: "paragraph", content: second },
    ]);
    return Buffer.from(Y.encodeStateAsUpdate(doc, before)).toString("base64");
  };

  it("没网时如实报 queued：不假装服务端收到了", async () => {
    const { base, gateway, uploaded, goOffline } = harness();
    await gateway.connect();
    // 打开这篇时取过起点（离线编辑的前提），之后断网才只是"送不出去"。
    await ns_note.getNoteDocState(gateway.gatewayTransport, NOTE_ID);
    goOffline();

    await expect(ns_note.syncNoteDocUpdate(gateway.gatewayTransport, NOTE_ID, editTo(base, "第一段（离线改的）"))).resolves.toMatchObject({
      via: "queued",
    });
    expect(uploaded).toEqual([]);
  });

  it("实时帧已包含提交增量时，仍确认落盘，不提前报 unchanged", async () => {
    const { base, gateway, uploaded } = harness();
    await gateway.connect();
    await ns_note.getNoteDocState(gateway.gatewayTransport, NOTE_ID);
    const update = editTo(base, "已在实时帧出现，还要确认保存的一句");
    ns_note.noteDocLocalSession(gateway.gatewayTransport, NOTE_ID).state.applyRemote(update);
    const receipt = await ns_note.syncNoteDocUpdate(gateway.gatewayTransport, NOTE_ID, update);
    expect(receipt).toMatchObject({ via: "uploaded", revision: 5, savedAt: "2026-09-21T00:00:09.000Z" });
    expect(uploaded).toHaveLength(1);
    expect(contentsAfter(base, uploaded[0]!)).toEqual(["标题", "已在实时帧出现，还要确认保存的一句"]);
  });

  it("恢复后一次把攒下的都交掉，两条改动服务端都看得到", async () => {
    const { base, gateway, uploaded, goOffline, goOnline } = harness();
    await gateway.connect();
    await ns_note.getNoteDocState(gateway.gatewayTransport, NOTE_ID);
    goOffline();
    await ns_note.syncNoteDocUpdate(gateway.gatewayTransport, NOTE_ID, editTo(base, "甲加的这句"));
    await ns_note.syncNoteDocUpdate(gateway.gatewayTransport, NOTE_ID, editTo(base, "甲加的这句，还有乙补的半句"));
    expect(uploaded).toEqual([]);

    goOnline();
    const receipt = await ns_note.syncNoteDocUpdate(gateway.gatewayTransport, NOTE_ID, editTo(base, "甲加的这句，还有乙补的半句，加上丙的"));
    expect(receipt.via).toBe("uploaded");
    expect(uploaded).toHaveLength(1);
    expect(contentsAfter(base, uploaded[0]!)).toEqual(["标题", "甲加的这句，还有乙补的半句，加上丙的"]);
  });

  it("非网络类失败不进队列——重发一百次也是同一个 403", async () => {
    const { base, gateway, uploaded, docStateReads } = harness({ failStatus: 403 });
    await gateway.connect();
    await expect(ns_note.syncNoteDocUpdate(gateway.gatewayTransport, NOTE_ID, editTo(base, "不该被攒起来的一句")))
      .rejects.toMatchObject({ code: "forbidden" });
    expect(uploaded).toEqual([]);

    // 队列是空的：下一次提交只带这一次的增量，不会把上次被拒的那条偷偷再塞进去。
    const fresh = harness();
    await fresh.gateway.connect();
    await ns_note.syncNoteDocUpdate(fresh.gateway.gatewayTransport, NOTE_ID, editTo(fresh.base, "换一篇的增量"));
    expect(fresh.uploaded).toHaveLength(1);
    expect(docStateReads()).toBe(1);
  });

  it("切空间作废本机文档与队列：另一个空间的正文不能差分到这篇上", async () => {
    const { base, gateway, uploaded, goOffline } = harness();
    await gateway.connect();
    await ns_note.getNoteDocState(gateway.gatewayTransport, NOTE_ID);
    goOffline();
    await ns_note.syncNoteDocUpdate(gateway.gatewayTransport, NOTE_ID, editTo(base, "上一个空间的这句"));
    expect(uploaded).toEqual([]);

    ns_note.dropNoteDocLocalSessions(gateway.gatewayTransport, );

    // 换到另一个空间（这里是新建的会话）：上一空间攒下的那句绝不能跟着过来。
    const next = harness();
    await next.gateway.connect();
    await ns_note.getNoteDocState(next.gateway.gatewayTransport, NOTE_ID);
    const receipt = await ns_note.syncNoteDocUpdate(next.gateway.gatewayTransport, NOTE_ID, editTo(next.base, "这个空间的这句"));
    expect(receipt.via).toBe("uploaded");
    expect(next.uploaded).toHaveLength(1);
    expect(contentsAfter(next.base, next.uploaded[0]!)).toEqual(["标题", "这个空间的这句"]);
    // 旧的那台机器上：一次都没交出去，也没有在丢弃后被重新拾起。
    expect(uploaded).toEqual([]);
  });

  /** watchNoteDocument 要一个已鉴权的会话：给它一个内存里的凭据存储。 */
  function signedInStore() {
    return {
      available: true,
      hasStored: () => true,
      load: async () => "stored-token",
      save: async () => undefined,
      clear: async () => undefined,
    };
  };

  function watchProbe() {
    let transportCalls = 0;
    const gateway = new DesktopGateway(environment(), {
      credentials: signedInStore() as never,
      noteDocTransport: () => {
        transportCalls += 1;
        return {
          applyLocal: () => null,
          applyTitle: () => null,
          seed: () => undefined,
          setPresence: () => undefined,
          close: () => undefined,
        };
      },
    });
    return { gateway, transportCalls: () => transportCalls };
  }

  it("「仅自己可见」的那篇不建实时连接，但写入照旧", async () => {
    // 决定 7b 改到按篇判之后，门控关的是**传输**不是写入：私有笔记一样要能编辑，
    // 只是不广播。两个半边各钉一条，少任何一条都会留下一个"看起来对"的半成品。
    harness({ shareScope: "private" }); // 装 fetch 假实现：这篇是「仅自己可见」
    const { gateway, transportCalls } = watchProbe();
    await expect(ns_note.watchNoteDocument(gateway.gatewayTransport, gateway.noteDocTransportHandle, NOTE_ID, async () => undefined)).resolves.toBeNull();
    expect(transportCalls()).toBe(0);
  });

  it("已共享的那篇照常建连（上一条不是因为坏掉才返回 null）", async () => {
    harness(); // 这篇的 doc-state 报 shared
    const { gateway, transportCalls } = watchProbe();
    await gateway.connect();
    const handle = await ns_note.watchNoteDocument(gateway.gatewayTransport, gateway.noteDocTransportHandle, NOTE_ID, async () => undefined);
    expect(handle).not.toBeNull();
    expect(transportCalls()).toBe(1);
    handle?.stop();
  });

  it("只改标题不动正文：标题写进文档的 meta，正文一个字不变", async () => {
    const { base, gateway, uploaded } = harness();
    await gateway.connect();
    await ns_note.getNoteDocState(gateway.gatewayTransport, NOTE_ID);
    const receipt = await ns_note.syncNoteDocTitle(gateway.gatewayTransport, NOTE_ID, "改了名", "manual");
    expect(receipt.via).toBe("uploaded");
    expect(contentsAfter(base, uploaded[0]!)).toEqual(["标题", "第一段"]);
  });

  // ─── 本机那一份能跨过重启（决定 7）────────────────────────────────

  it("落盘的那一份接回来后，改出来的增量并回服务端起点上仍是同一篇", async () => {
    // 这是"重启 = 换一台空机器"的模拟：第二个网关没有任何起点，只拿到盘上那份。
    // 断言的不是"调用了 seed"，而是**增量并到服务端那份起点上之后不复制块**——
    // 4.0 实测过的失败模式就是两个没有共同祖先的副本一改就变四块。
    const first = harness();
    await first.gateway.connect();
    await ns_note.getNoteDocState(first.gateway.gatewayTransport, NOTE_ID);
    const saved = ns_note.noteDocLocalSnapshot(first.gateway.gatewayTransport, NOTE_ID);
    expect(saved).not.toBeNull();

    const reopened = harness({ base: first.base });
    await reopened.gateway.connect();
    ns_note.restoreNoteDocLocal(reopened.gateway.gatewayTransport, NOTE_ID, saved!);
    await ns_note.syncNoteDocUpdate(reopened.gateway.gatewayTransport, NOTE_ID, editTo(first.base, "第一段，重启后又改了"));

    expect(reopened.uploaded).toHaveLength(1);
    expect(contentsAfter(reopened.base, reopened.uploaded[0]!)).toEqual([
      "标题",
      "第一段，重启后又改了",
    ]);
  });

  it("没拿到起点之前没有可落盘的一份：不凭空造一个祖先", async () => {
    const { gateway } = harness();
    await gateway.connect();
    expect(ns_note.noteDocLocalSnapshot(gateway.gatewayTransport, NOTE_ID)).toBeNull();
  });

  it("盘上那份不覆盖已经取到的服务端起点", async () => {
    const { base, gateway, uploaded } = harness();
    await gateway.connect();
    await ns_note.getNoteDocState(gateway.gatewayTransport, NOTE_ID);
    // 一份来自上一次运行的状态：正文是"旧的那一句"。已经拿到过服务端起点时，
    // 接回来那一步必须被跳过，否则本机旧副本会盖掉服务端的现状——正是这一轮要
    // 消灭的那类覆盖。
    const staleDoc = emptyNoteDoc();
    syncNoteBlocksForEditor(staleDoc, [{ type: "paragraph", content: "旧的那一句" }]);
    ns_note.restoreNoteDocLocal(gateway.gatewayTransport, NOTE_ID, {
      docState: Buffer.from(snapshotOf(staleDoc)).toString("base64"),
      pending: [],
      revision: 1,
      savedAt: "2026-09-19T00:00:00.000Z",
      shareScope: "shared",
    });
    staleDoc.destroy();

    // 旧副本没进来时，这一次写的增量并回服务端起点上仍是"标题 + 这一句"；
    // 进了的话会多出一段旧正文，或被差分掉一段——两种都不是这个结果。
    await ns_note.syncNoteDocUpdate(gateway.gatewayTransport, NOTE_ID, editTo(base, "第一段，之后改的"));
    expect(contentsAfter(base, uploaded[0]!)).toEqual(["标题", "第一段，之后改的"]);
  });

  it("重启前欠的那几条，接回来之后一次交清", async () => {
    const { base, gateway, uploaded, goOffline } = harness();
    await gateway.connect();
    await ns_note.getNoteDocState(gateway.gatewayTransport, NOTE_ID);
    goOffline();
    await ns_note.syncNoteDocUpdate(gateway.gatewayTransport, NOTE_ID, editTo(base, "断网期间改的那一段"));
    const saved = ns_note.noteDocLocalSnapshot(gateway.gatewayTransport, NOTE_ID)!;
    expect(saved.pending).toHaveLength(1);

    const reopened = harness({ base });
    await reopened.gateway.connect();
    ns_note.restoreNoteDocLocal(reopened.gateway.gatewayTransport, NOTE_ID, saved);
    await ns_note.flushNoteDocPending(reopened.gateway.gatewayTransport, NOTE_ID);

    expect(reopened.uploaded).toHaveLength(1);
    expect(contentsAfter(base, reopened.uploaded[0]!)).toEqual(["标题", "断网期间改的那一段"]);
    // 交清之后不该再有欠的：否则下一次重启还会把同一批重新发一遍。
    expect(ns_note.noteDocLocalSnapshot(reopened.gateway.gatewayTransport, NOTE_ID)?.pending).toEqual([]);
  });
});

describe("DesktopGateway · 重认证那道门不该把空间换掉", () => {
  const USER_ID = "11111111-1111-4111-8111-111111111111";
  const PERSONAL = "22222222-2222-4222-8222-222222222222";
  const COLLAB = "33333333-3333-4333-8333-333333333333";
  const EMAIL = "member@example.test";

  const meBody = (workspaceId: string) => ({
    userId: USER_ID,
    workspaceId,
    email: EMAIL,
    role: workspaceId === COLLAB ? "member" : "owner",
    displayName: null,
    avatarUrl: null,
    workspaceName: workspaceId === COLLAB ? "验收空间" : "我的个人空间",
    workspaceType: workspaceId === COLLAB ? "collaborative" : "personal",
    isPersonal: workspaceId === PERSONAL,
    personalWorkspaceId: PERSONAL,
    workspaceEpoch: 1,
  });

  const listBody = () => ({
    workspaces: [
      { workspaceId: PERSONAL, workspaceName: "我的个人空间", role: "owner", workspaceType: "personal", isPersonal: true, leftAt: null },
      { workspaceId: COLLAB, workspaceName: "验收空间", role: "member", workspaceType: "collaborative", isPersonal: false, leftAt: null },
    ],
  });

  function reauthHarness() {
    // 服务端这一侧的事实：登录恒常落在账号的默认（个人）空间，切空间才会把人挪走。
    let active = PERSONAL;
    let switchCalls = 0;
    // 默认允许切；用例里 `blockSwitch()` 之后才扮演"那个人已经被移出去了"。
    let switchAllowed = true;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/health")) return healthResponse();
      if (url.endsWith("/challenge")) return trustResponse(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (url.endsWith("/auth/login")) {
        // 登录建的是**新会话**，落在这个账号的默认空间；上一个会话在哪一个空间与它无关。
        active = PERSONAL;
        return new Response(JSON.stringify({ token: "tok-1", ctx: { userId: USER_ID, workspaceId: PERSONAL, membershipRole: "owner" }, ...listBody() }), { status: 200 });
      }
      if (url.endsWith("/auth/me")) {
        return new Response(JSON.stringify(meBody(active)), { status: 200 });
      }
      if (url.endsWith("/auth/switch-workspace")) {
        switchCalls += 1;
        const wanted = JSON.parse(String(init?.body)).workspaceId as string;
        if (!switchAllowed) return new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
        active = wanted;
        // 服务端这个端点真实的形状：只有 token + ctx（+ csrfToken），**没有** workspaces 名册。
        return new Response(JSON.stringify({ token: "tok-2", ctx: { userId: USER_ID, workspaceId: wanted, membershipRole: wanted === COLLAB ? "member" : "owner" } }), { status: 200 });
      }
      if (url.endsWith("/auth/workspaces")) return new Response(JSON.stringify(listBody()), { status: 200 });
      if (url.endsWith("/auth/logout")) return new Response(JSON.stringify({ loggedOut: true }), { status: 200 });
      throw new Error(`unexpected URL ${url}`);
    });
    const gateway = new DesktopGateway(environment());
    return {
      gateway,
      active: () => active,
      switchCalls: () => switchCalls,
      blockSwitch: () => { switchAllowed = false; },
    };
  }

  it("在协作空间里过的重认证门，开完还在同一个空间", async () => {
    const { gateway, active } = reauthHarness();
    await gateway.connect();
    await ns_auth.login(gateway.gatewayTransport, gateway.companionBridge, EMAIL, "pw");
    await ns_auth.switchWorkspace(gateway.gatewayTransport, gateway.companionBridge, COLLAB);
    expect(active()).toBe(COLLAB);

    const session = await ns_auth.reauthenticate(gateway.gatewayTransport, gateway.companionBridge, "pw");
    expect(session.workspace?.workspaceId).toBe(COLLAB);
    expect(active()).toBe(COLLAB);
    // 顶栏胶囊读的就是这份会话：它不能再报成个人空间。
    expect(session.workspace?.workspaceType).toBe("collaborative");
    expect(session.workspace?.role).toBe("member");
  });

  it("本来就在默认空间时不多发一次切换", async () => {
    const { gateway, switchCalls } = reauthHarness();
    await gateway.connect();
    await ns_auth.login(gateway.gatewayTransport, gateway.companionBridge, EMAIL, "pw");
    const before = switchCalls();
    const session = await ns_auth.reauthenticate(gateway.gatewayTransport, gateway.companionBridge, "pw");
    expect(session.workspace?.workspaceId).toBe(PERSONAL);
    expect(switchCalls()).toBe(before);
  });

  it("那个空间已经回不去了（被移出）：门照样开，落回默认空间而不是卡住", async () => {
    const { gateway, blockSwitch } = reauthHarness();
    await gateway.connect();
    await ns_auth.login(gateway.gatewayTransport, gateway.companionBridge, EMAIL, "pw");
    await ns_auth.switchWorkspace(gateway.gatewayTransport, gateway.companionBridge, COLLAB);
    // -setup 之后才断：模拟"人在这个空间里待过，回来时已经被移出去了"。
    blockSwitch();
    const session = await ns_auth.reauthenticate(gateway.gatewayTransport, gateway.companionBridge, "pw");
    // 抛错的话人连登录都完不成——回不去是"落在能落的那个空间"，不是一次失败。
    expect(session.workspace?.workspaceId).toBe(PERSONAL);
    expect(session.status).toBe("authenticated");
  });

  it("退登之后再登录，不会被拖回上一个空间", async () => {
    const { gateway, active } = reauthHarness();
    await gateway.connect();
    await ns_auth.login(gateway.gatewayTransport, gateway.companionBridge, EMAIL, "pw");
    await ns_auth.switchWorkspace(gateway.gatewayTransport, gateway.companionBridge, COLLAB);
    await ns_auth.logout(gateway.gatewayTransport, gateway.companionBridge, );
    await ns_auth.login(gateway.gatewayTransport, gateway.companionBridge, EMAIL, "pw");
    expect(active()).toBe(PERSONAL);
    expect((await ns_auth.getSession(gateway.gatewayTransport)).workspace?.workspaceId).toBe(PERSONAL);
  });
});

describe("DesktopGateway · 伴星「这一页」的租约每 10 秒要真续上", () => {
  const USER_ID = "11111111-1111-4111-8111-111111111111";
  const PERSONAL = "22222222-2222-4222-8222-222222222222";
  const EMAIL = "member@example.test";
  const CONTEXT_ID = "55555555-5555-4555-8555-555555555555";
  const PAGE = {
    routeRef: { kind: "home" },
    pageKind: "other",
    entityRefs: [],
    interactionState: "idle",
    capabilityHints: [],
    sensitivity: "normal",
  };
  const ISSUED_AT = new Date(0).toISOString();

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  /** publish 回的是整份快照（服务端 `buildContextSnapshot`），renew 只回两个字段。 */
  const snapshotBody = (expiresAt: string) => ({
    version: 2,
    contextId: CONTEXT_ID,
    accountSessionId: "acct-1",
    deviceSessionId: "dev-1",
    workspaceId: PERSONAL,
    userId: USER_ID,
    pageInstanceId: "page-instance-1",
    revision: "rev-1",
    issuedAt: ISSUED_AT,
    expiresAt,
    ...PAGE,
  });

  function bridgeHarness(renewReply: (tick: number) => { status: number; body: unknown }) {
    const requests: string[] = [];
    let renewTick = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      const method = String(init?.method ?? "GET");
      requests.push(`${method} ${url}`);
      if (url.endsWith("/health")) return healthResponse();
      if (url.endsWith("/challenge")) {
        return trustResponse(JSON.parse(String(init?.body)) as Record<string, unknown>);
      }
      if (url.endsWith("/auth/login")) {
        return json({
          token: "tok-1",
          ctx: { userId: USER_ID, workspaceId: PERSONAL, membershipRole: "owner" },
          workspaces: [{
            workspaceId: PERSONAL, workspaceName: "我的个人空间", role: "owner",
            workspaceType: "personal", isPersonal: true, leftAt: null,
          }],
        });
      }
      if (url.endsWith("/auth/me")) {
        return json({
          userId: USER_ID,
          workspaceId: PERSONAL,
          email: EMAIL,
          role: "owner",
          displayName: null,
          avatarUrl: null,
          workspaceName: "我的个人空间",
          workspaceType: "personal",
          isPersonal: true,
          personalWorkspaceId: PERSONAL,
          workspaceEpoch: 1,
        });
      }
      if (url.endsWith("/renew")) {
        renewTick += 1;
        const reply = renewReply(renewTick);
        return json(reply.body, reply.status);
      }
      if (url.includes("/companion/bridge/contexts")) {
        if (method === "DELETE") return json({});
        return json(snapshotBody(new Date(30_000).toISOString()), 201);
      }
      throw new Error(`unexpected URL ${url}`);
    });
    const count = (verb: string, suffix: string) =>
      requests.filter((entry) => entry.startsWith(`${verb} `) && entry.endsWith(suffix)).length;
    return { count, requests };
  }

  async function bridgeReady(gateway: DesktopGateway) {
    await gateway.connect();
    await ns_auth.login(gateway.gatewayTransport, gateway.companionBridge, EMAIL, "pw");
  }

  it("续租响应只有 revision/expiresAt 时：租约照续，不多发一次 publish", async () => {
    // 服务端 renewContext 的返回形状（context-service.ts:182）——拿整份快照的
    // schema 去解它必然失败，失败的那条 catch 会把上下文清掉、停掉定时器，
    // 而渲染层按内容去重发布：屏上没变就不会再推，于是她从此读不到这一页。
    // 本仓实测过这条链的产物：assistant_page_contexts 里 expires_at-issued_at
    // 恒为 30＋10 秒（只续上一拍），48 小时里 335 次 renew 200 对 427 次 publish。
    const { count } = bridgeHarness((tick) => ({
      status: 200,
      body: { revision: "rev-1", expiresAt: new Date((30 + tick * 10) * 1000).toISOString() },
    }));
    const gateway = new DesktopGateway(environment());
    await bridgeReady(gateway);
    vi.useFakeTimers();
    try {
      const published = await gateway.companionBridge.setCompanionBridgeContext(PAGE as never, "req-1");
      expect(published.active).toBe(true);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(count("POST", "/renew")).toBe(2);
      expect(count("POST", "/companion/bridge/contexts")).toBe(1);
      // 内容没变时再登记一次：走的是本地去重，报回来的必须是**续租后**那份到期时间。
      const again = await gateway.companionBridge.setCompanionBridgeContext(PAGE as never, "req-2");
      expect(again).toMatchObject({ active: true, revision: "rev-1", expiresAt: new Date(50_000).toISOString() });
    } finally {
      vi.useRealTimers();
    }
  });

  it("续租被服务端拒了（行没了）：拿手里这份 page 重新 publish，而不是永久变暗", async () => {
    const { count } = bridgeHarness(() => ({
      status: 404,
      body: { error: "context_not_found", message: "页面上下文不存在或已撤销" },
    }));
    const gateway = new DesktopGateway(environment());
    await bridgeReady(gateway);
    vi.useFakeTimers();
    try {
      await gateway.companionBridge.setCompanionBridgeContext(PAGE as never, "req-1");
      await vi.advanceTimersByTimeAsync(10_000);
      expect(count("POST", "/renew")).toBe(1);
      expect(count("POST", "/companion/bridge/contexts")).toBe(2);
      const state = await gateway.companionBridge.setCompanionBridgeContext(PAGE as never, "req-2");
      expect(state.active).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
