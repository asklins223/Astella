import { randomUUID } from "node:crypto";
/**
 * 网关的「登录与账号」那一族里**已解锁**的部分 —— 2026-09-30 从 `DesktopGateway` 类搬出。
 *
 * ## 为什么只有 8 个，不是 13 个
 *
 * AST 实测：auth 的 13 个通道方法里有 4 个（`login` / `register` / `logout` /
 * `reauthenticate`）依赖 `clearCompanionBridgeContext` / `clearCompanionRuntimeState`，
 * 而那两个要 `companionBridgeContext` / `companionDeliveryLeases`——
 * **那是伴星域的状态，不是传输层的**。把它们硬塞进传输层是**把耦合换个地方藏**，
 * 不是拆开。所以那 4 个留在类上，等伴星桥状态自己先有落脚点。
 *
 * ## 为什么这 8 个现在能搬
 *
 * 它们原先依赖的 `loadSession`（用已存凭据恢复会话）与 `roomProjectionCache`
 * 已在第六刀里进了 `GatewayTransport`——**命名空间要等它依赖的私有状态先有落脚点**。
 * 依赖清空之后，这一族可以整体变成自由函数，第一个参数是那一个 `t: GatewayTransport`。
 *
 * 下面**逐字搬移**：成员由脚本按 TS AST 的精确源区间从 `desktop-gateway.ts` 切出，
 * 只做两处改写——签名前加 `t: GatewayTransport`，方法体里 `this.transport.` 换成 `t.`。
 */
const rawAuthResponseSchema = z.strictObject({
  token: nonEmptyStringSchema,
  ctx: z.strictObject({
    userId: z.string().uuid(),
    workspaceId: z.string().uuid(),
    membershipRole: z.string().nullable().optional(),
    // The API includes the server-authoritative workspace boundary in every
    // newly issued session. Session loading reads it again from /auth/me, but
    // the strict login envelope must still accept the field.
    workspaceEpoch: z.number().int().positive().optional(),
  }),
  // `login` / `register` 会带这一份名册，`switch-workspace` **不带**（它只回 token 与 ctx）。
  // 所以它是可选的：以前写成必填，切空间每次都 `unsupported_contract` —— 服务端已经切过去
  // 并轮换掉旧会话，客户端却因为解析失败没拿到新 token，下一次请求 401、弹重认证门，
  // 重认证又是"重新登录"，于是人回到默认空间（2026-09-21 实窗量到的那条即此）。
  // 之所以还声明着而不是删掉：`strictObject` 要能收下服务端完整的登录信封，
  // 而这个数组在本文件里没有任何读取方。
  workspaces: z.array(z.strictObject({
    workspaceId: z.string().uuid(),
    workspaceName: nonEmptyStringSchema,
    role: z.enum(["owner", "member"]),
    workspaceType: z.enum(["personal", "collaborative"]),
    isPersonal: z.boolean(),
    leftAt: z.string().datetime({ offset: true }).nullable(),
  })).optional(),
  // The API also returns a CSRF token for cookie-authenticated consumers.
  // Bearer-token desktop requests do not persist or expose it, but the strict
  // response contract must accept the server's complete login envelope.
  csrfToken: nonEmptyStringSchema.optional(),
});

import type { WorkspaceContextV1 } from "@ailearn/shared/desktop-ipc-contracts";
import { createWorkspaceResultV1Schema, renameWorkspaceResultV1Schema } from "@ailearn/shared/desktop-ipc-contracts";
import { nonEmptyStringSchema } from "@ailearn/shared/desktop-ipc-contracts";
import type { CreateWorkspaceResultV1, RenameWorkspaceResultV1 } from "@ailearn/shared/desktop-ipc-contracts";
import { z } from "zod";
import type { CompanionBridge } from "./desktop-gateway-companion-bridge";
import { DesktopGatewayFailure } from "./desktop-gateway-failure";
import {
  AVATAR_MAX_BYTES,
  AuthProfileResultV1,
  AvatarUploadResultV1,
  SessionContextV1,
  authProfileResultV1Schema,
  authSurfaceManifestResultV1Schema,
  avatarObjectKeySchema,
  avatarUploadResultV1Schema,
  sessionContextSchema,
} from "@ailearn/shared/desktop-ipc-contracts";
import {
  SOURCE_IMAGE_MIME_TYPES,
  SourceImageGetResultV1,
  sourceImageGetResultV1Schema,
} from "@ailearn/shared/source-image-contracts";
import type { GatewayTransport } from "./desktop-gateway-transport";

export async function getSession(t: GatewayTransport, requestId?: string): Promise<SessionContextV1> {
    await t.ensureConnected(requestId);
    if (!t.token) {
      t.currentSession = sessionContextSchema.parse({
        version: 1,
        status: "anonymous",
        user: null,
        workspace: null,
        membership: null,
        capabilities: null,
        workspaceEpoch: 0,
        credentialPersistence: "none",
      });
      return t.currentSession;
    }
    return t.loadSession(requestId);
  }

export async function getProfile(t: GatewayTransport, requestId?: string): Promise<AuthProfileResultV1> {
    await t.ensureConnected(requestId);
    const result = await t.request("/auth/me", { method: "GET" }, true, true, requestId);
    const payload = (result.body ?? {}) as Record<string, unknown>;
    const parsed = authProfileResultV1Schema.safeParse({
      version: 1,
      displayName: payload.displayName ?? null,
      avatarUrl: payload.avatarUrl ?? null,
    });
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function getAvatar(t: GatewayTransport, objectKey: string, requestId?: string): Promise<SourceImageGetResultV1> {
    await t.ensureConnected(requestId);
    if (!avatarObjectKeySchema.safeParse(objectKey).success) {
      throw new DesktopGatewayFailure("validation", "user_action");
    }
    const result = await t.requestBinaryBytes(
      `/uploads/${objectKey}`,
      { method: "GET" },
      { accept: "image/*", contentTypePrefix: "image/", maxBytes: AVATAR_MAX_BYTES },
      requestId,
    );
    const mimeType = result.contentType.split(";")[0].trim();
    if (!(SOURCE_IMAGE_MIME_TYPES as readonly string[]).includes(mimeType)) {
      throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    }
    const parsed = sourceImageGetResultV1Schema.safeParse({
      version: 1,
      mimeType,
      imageBase64: Buffer.from(result.bytes).toString("base64"),
      byteLength: result.bytes.byteLength,
    });
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function uploadAvatar(t: GatewayTransport, 
    request: { fileName: string; mimeType: string; bytesBase64: string },
    requestId?: string,
  ): Promise<AvatarUploadResultV1> {
    await t.ensureConnected(requestId);
    const configuration = t.configuration;
    if (!configuration) throw new DesktopGatewayFailure("configuration_error", "user_action");
    const bytes = Buffer.from(request.bytesBase64, "base64");
    if (bytes.byteLength === 0 || bytes.byteLength > AVATAR_MAX_BYTES) {
      throw new DesktopGatewayFailure("validation", "user_action");
    }
    const form = new FormData();
    form.set("file", new Blob([bytes], { type: request.mimeType }), request.fileName);
    const headers = new Headers();
    if (t.token) headers.set("Authorization", `Bearer ${t.token}`);
    const controller = requestId ? new AbortController() : undefined;
    if (requestId && controller) t.activeRequests.set(requestId, controller);
    let response: Response;
    try {
      response = await fetch(new URL("/uploads/avatars", `${configuration.config.apiOrigin}/`), {
        method: "POST",
        headers,
        body: form,
        signal: controller?.signal,
        redirect: "manual",
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new DesktopGatewayFailure("cancelled", "never", { localEffect: "request_cancelled" });
      }
      t.connection = { version: 1, kind: "api_unavailable" };
      throw new DesktopGatewayFailure("api_unavailable", "safe_retry");
    } finally {
      if (requestId && controller && t.activeRequests.get(requestId) === controller) t.activeRequests.delete(requestId);
    }
    if (response.status >= 300 && response.status < 400 && response.status !== 304) {
      t.connection = { version: 1, kind: "api_untrusted", reason: "wrong_service" };
      throw new DesktopGatewayFailure("api_untrusted", "user_action");
    }
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!response.ok && response.status === 401 && t.tokenIsRestored) {
      await t.discardStoredCredential();
    }
    if (!response.ok) throw t.mapResponseError(response.status, response.headers, undefined, body);
    const payload = (body ?? {}) as Record<string, unknown>;
    const parsed = avatarUploadResultV1Schema.safeParse({
      version: 1,
      url: payload.url,
      objectKey: payload.objectKey,
    });
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function updateProfile(t: GatewayTransport, 
    fields: { displayName?: string | null; avatarUrl?: string | null },
    requestId?: string,
  ): Promise<AuthProfileResultV1> {
    await t.ensureConnected(requestId);
    const result = await t.request("/auth/profile", {
      method: "PUT",
      body: JSON.stringify(fields),
    }, true, true, requestId);
    const payload = (result.body ?? {}) as Record<string, unknown>;
    const parsed = authProfileResultV1Schema.safeParse({
      version: 1,
      displayName: payload.displayName ?? null,
      avatarUrl: payload.avatarUrl ?? null,
    });
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    // 会话里缓存了旧 displayName，丢掉缓存让下次 getState 重读。
    t.currentSession = null;
    return parsed.data;
  }

export async function getAuthSurfaceManifest(t: GatewayTransport, requestId?: string) {
    await t.ensureConnected(requestId);
    const result = await t.request(
      "/public/auth-surface-manifest",
      { method: "GET" },
      false,
      true,
      requestId,
    );
    const parsed = authSurfaceManifestResultV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function joinWorkspace(t: GatewayTransport, inviteToken: string, requestId?: string): Promise<SessionContextV1> {
    await t.ensureConnected(requestId);
    await t.request("/auth/join-workspace", {
      method: "POST",
      body: JSON.stringify({ inviteToken }),
    }, true, true, requestId);
    t.roomProjectionCache = null;
    return t.loadSession(requestId);
  }

export async function leaveWorkspace(t: GatewayTransport, workspaceId: string, requestId?: string): Promise<SessionContextV1> {
    await t.ensureConnected(requestId);
    const result = await t.request("/auth/leave-workspace", {
      method: "POST",
      body: JSON.stringify({ workspaceId }),
    }, true, true, requestId);
    const body = (result.body ?? {}) as Record<string, unknown>;
    if (body.switchedToPersonalWorkspace === true && typeof body.token === "string" && body.token.length > 0) {
      t.token = body.token;
      t.workspaceEpoch += 1;
      await t.persistCredential(t.credentialPersistence === "safe_storage");
    }
    t.roomProjectionCache = null;
    return t.loadSession(requestId);
  }

export async function login(t: GatewayTransport, b: CompanionBridge, email: string, password: string, requestId?: string, remember?: boolean): Promise<SessionContextV1> {
    await t.ensureConnected(requestId);
    await b.clearCompanionBridgeContext(requestId).catch(() => undefined);
    const persist = remember ?? t.credentialPersistence === "safe_storage";
    const result = await t.request("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password, remember: persist }),
    }, false, true, requestId, "invalid_credentials");
    const parsed = rawAuthResponseSchema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    t.commandIdempotency.clear();
    b.clearCompanionRuntimeState();
    t.token = parsed.data.token;
    t.workspaceEpoch = 1;
    t.roomProjectionCache = null;
    // 能力投影与房间投影同生命周期：换身份/换空间之后它必须重来，不能靠 epoch 相等蒙过去
    // （两处都会把 workspaceEpoch 复位成 1，复位之后"和缓存里的 epoch 一样"是必然成立）。
    t.forgetCapabilities();
    await t.persistCredential(persist);
    return t.loadSession(requestId);
  }

export async function register(t: GatewayTransport, b: CompanionBridge, email: string, password: string, inviteToken?: string, displayName?: string, requestId?: string, remember?: boolean): Promise<SessionContextV1> {
    await t.ensureConnected(requestId);
    await b.clearCompanionBridgeContext(requestId).catch(() => undefined);
    const persist = remember ?? t.credentialPersistence === "safe_storage";
    const body: { email: string; password: string; inviteToken?: string; displayName?: string } = { email, password };
    if (inviteToken) body.inviteToken = inviteToken;
    if (displayName) body.displayName = displayName;
    const result = await t.request("/auth/register-v2", { method: "POST", body: JSON.stringify(body) }, false, true, requestId, "invalid_credentials");
    const parsed = rawAuthResponseSchema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    t.commandIdempotency.clear();
    b.clearCompanionRuntimeState();
    t.token = parsed.data.token;
    t.workspaceEpoch = 1;
    t.roomProjectionCache = null;
    // 能力投影与房间投影同生命周期：换身份/换空间之后它必须重来，不能靠 epoch 相等蒙过去
    // （两处都会把 workspaceEpoch 复位成 1，复位之后"和缓存里的 epoch 一样"是必然成立）。
    t.forgetCapabilities();
    await t.persistCredential(persist);
    return t.loadSession(requestId);
  }

export async function logout(t: GatewayTransport, b: CompanionBridge, requestId?: string): Promise<{ loggedOut: true; serverRevoked: boolean }> {
    await b.clearCompanionBridgeContext(requestId).catch(() => undefined);
    const token = t.token;
    t.token = null;
    t.currentSession = null;
    // 退登是人自己要走，下一次登录落回默认空间就是对的，不该被拖回上一个空间。
    t.sessionWorkspaceReturn = null;
    t.roomProjectionCache = null;
    t.commandIdempotency.clear();
    b.clearCompanionRuntimeState();
    t.tokenIsRestored = false;
    t.credentialPersistence = "memory";
    // Local sign-out is authoritative: the stored credential goes even when the
    // server revoke cannot be reached.
    await t.credentials?.clear().catch(() => undefined);
    if (!token) return { loggedOut: true, serverRevoked: false };
    try {
      await t.ensureConnected(requestId);
      await t.request("/auth/logout", { method: "POST" }, true, true, requestId);
      return { loggedOut: true, serverRevoked: true };
    } catch (error) {
      if (error instanceof DesktopGatewayFailure) {
        throw new DesktopGatewayFailure(error.code, error.retry, {
          httpStatus: error.httpStatus,
          retryAfter: error.retryAfter,
          localEffect: "credential_cleared",
        });
      }
      throw error;
    }
  }

export async function reauthenticate(t: GatewayTransport, b: CompanionBridge, password: string, requestId?: string): Promise<SessionContextV1> {
    const current = t.currentSession ?? await getSession(t, requestId);
    if (current.status !== "authenticated") throw new DesktopGatewayFailure("reauth_required", "user_action");
    // 必须在 login 之前取：`loadSession` 会把这一位刷成"新会话所在的空间"，
    // 先登录再读就永远等于新会话，那个人刚离开的空间就查不到了。
    const wanted = t.sessionWorkspaceReturn;
    const session = await login(t, b, current.user.email, password, requestId);
    // 重新登录拿到的是这个账号**默认那一个**空间的会话。人本来在协作空间里，
    // 门开完却回到个人空间——切空间那一步等于被这道门吞掉了（2026-09-21 实窗量到的：
    // 成员点「验收空间 / 成员 · 只读」，服务端已经切过去，重认证之后胶囊又是个人空间）。
    // 所以门开完要把人送回他进来时那一个空间；回不去（已被移出、空间没了）不是错误，
    // 落回默认那个就行，硬抛错会让人连登录都完不成。
    if (!wanted || wanted.email !== current.user.email || session.status !== "authenticated") return session;
    if (session.workspace?.workspaceId === wanted.workspaceId) return session;
    try {
      return await switchWorkspace(t, b, wanted.workspaceId, requestId, "restore");
    } catch {
      return session;
    }
  }

export async function switchWorkspace(t: GatewayTransport, b: CompanionBridge, workspaceId: string, requestId?: string, reason: "switch" | "create" | "restore" = "switch"): Promise<SessionContextV1> {
    await t.ensureConnected(requestId);
    const previous = t.currentSession;
    t.pendingWorkspaceArrival = null;
    await b.clearCompanionBridgeContext(requestId).catch(() => undefined);
    const result = await t.request("/auth/switch-workspace", {
      method: "POST",
      body: JSON.stringify({ workspaceId }),
    }, true, true, requestId);
    const parsed = rawAuthResponseSchema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    t.commandIdempotency.clear();
    b.clearCompanionRuntimeState();
    t.token = parsed.data.token;
    t.workspaceEpoch += 1;
    t.roomProjectionCache = null;
    await t.persistCredential(t.credentialPersistence === "safe_storage");
    const session = await t.loadSession();
    if (reason !== "restore" && session.status === "authenticated" && session.workspace
      && previous?.user?.userId === session.user.userId && previous.workspace?.workspaceId !== session.workspace.workspaceId) {
      t.pendingWorkspaceArrival = {
        id: randomUUID(), requestId: requestId ?? randomUUID(), userId: session.user.userId,
        deploymentRef: session.deploymentRef ?? t.configuration!.config.apiOrigin,
        fromWorkspaceId: previous.workspace?.workspaceId ?? null,
        workspaceId: session.workspace.workspaceId, workspaceEpoch: session.workspaceEpoch,
        reason, acceptedAt: new Date().toISOString(),
      };
      t.currentSession = { ...session, workspaceArrival: t.pendingWorkspaceArrival };
      return t.currentSession;
    }
    return session;
  }

export async function createWorkspace(t: GatewayTransport, b: CompanionBridge, name: string, requestId?: string): Promise<CreateWorkspaceResultV1> {
    await t.ensureConnected(requestId);
    const result = await t.request("/workspaces", {
      method: "POST",
      body: JSON.stringify({ name }),
    }, true, true, requestId);
    const payload = (result.body ?? {}) as Record<string, unknown>;
    const parsed = createWorkspaceResultV1Schema.safeParse({
      version: 1,
      workspaceId: payload.workspaceId,
      name: payload.workspaceName,
    });
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    await switchWorkspace(t, b, parsed.data.workspaceId, requestId, "create");
    return parsed.data;
  }

export async function changePassword(t: GatewayTransport, b: CompanionBridge, currentPassword: string, newPassword: string, requestId?: string): Promise<{ changed: true; sessionsRevoked: true }> {
    await t.ensureConnected(requestId);
    await b.clearCompanionBridgeContext(requestId).catch(() => undefined);
    await t.request("/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ currentPassword, newPassword }),
    }, true, true, requestId);
    t.token = null;
    t.currentSession = null;
    t.roomProjectionCache = null;
    t.commandIdempotency.clear();
    b.clearCompanionRuntimeState();
    t.tokenIsRestored = false;
    t.credentialPersistence = "memory";
    await t.credentials?.clear().catch(() => undefined);
    return { changed: true, sessionsRevoked: true };
  }

export async function renameWorkspace(t: GatewayTransport, workspaceId: string, name: string, requestId?: string): Promise<RenameWorkspaceResultV1> {
    await t.ensureConnected(requestId);
    const result = await t.request(`/workspaces/${workspaceId}/name`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    }, true, true, requestId);
    const payload = (result.body ?? {}) as Record<string, unknown>;
    const parsed = renameWorkspaceResultV1Schema.safeParse({
      version: 1,
      workspaceId: payload.workspaceId,
      name: payload.name,
    });
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    t.currentSession = null;
    t.roomProjectionCache = null;
    return parsed.data;
  }

export async function getCurrentWorkspace(t: GatewayTransport, requestId?: string): Promise<WorkspaceContextV1> {
    const session = await getSession(t, requestId);
    if (session.status !== "authenticated" || !session.workspace) throw new DesktopGatewayFailure("auth_required", "user_action");
    return session.workspace;
  }

export function clearCredential(t: GatewayTransport, b: CompanionBridge, ): void {
    void b.clearCompanionBridgeContext().catch(() => undefined);
    t.token = null;
    t.currentSession = null;
    t.roomProjectionCache = null;
    t.commandIdempotency.clear();
    b.clearCompanionRuntimeState();
  }
