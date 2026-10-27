import * as ns_source from "../gateway/desktop-gateway-ns-source";import { authUpdateProfileInputSchema, authAvatarUploadInputSchema, authAvatarGetInputSchema, authLeaveWorkspaceInputSchema } from "./desktop-ipc-workspace";
import * as ns_note from "../gateway/desktop-gateway-ns-note";
import * as ns_companion from "../gateway/desktop-gateway-ns-companion";
import * as ns_workspace from "../gateway/desktop-gateway-ns-workspace";
import * as ns_auth from "../gateway/desktop-gateway-ns-auth";
import * as ns_runtime from "../gateway/desktop-gateway-ns-runtime";import { BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { z } from "zod";import { DESKTOP_IPC_CHANNELS, authSurfaceManifestResultV1Schema, sessionContextSchema, type RequestMetaV1, type SessionContextV1, commandIdSchema, emailSchema, inviteTokenSchema, newPasswordSchema, requestMetaSchema, secretInputSchema, authProfileResultV1Schema, avatarUploadResultV1Schema, avatarGetResultV1Schema } from "@astella/shared/desktop-ipc-contracts";
import { DesktopGateway } from "../gateway/desktop-gateway";
import * as ns_search from "../gateway/desktop-gateway-ns-search";
import * as ns_invite from "../gateway/desktop-gateway-ns-invite";

import * as ns_artifact from "../gateway/desktop-gateway-ns-artifact";import { type NoteDocCacheStore } from "../note-doc/note-doc-cache-store.ts";
import { runtimeInputSchema } from "./desktop-ipc-companion";
import type { InputSchema, ParsedMeta } from "./desktop-ipc";
import { rememberedDesktopAccountV1Schema } from "@astella/shared/desktop-ipc-contracts";
/**
 * 「空间」这一族的 IPC 通道（2026-09-30 从 `desktop-ipc.ts` 搬出，第②步）。
 *
 * 通道**与**它专属的 schema 一起搬。只搬通道的话，段内会有一堆
 * 「在这里 import、定义却在另一个文件」的常量，读一条通道要跳两个地方。
 *
 * 配方、依赖分类与踩过的坑见 `src/main/__tests__/component-size-guard.test.ts`。
 */
const m1InputBase = { meta: requestMetaSchema };

/**
 * 这一族从 `registerM1DesktopIpc` 的闭包里拿到的全部东西。
 *
 * ③ 类（闭包里的函数与可变容器）**必须原样传引用**——搬过去就是副本，
 * 症状是「typecheck 干净但每条通道 `ok: false`、落盘恒为空」。
 */
export type AuthChannelDeps = {
  /** 闭包版 `installHandler`：**已经绑定了 options 与纪元取值器**（第①步）。 */
  channel: <TInput extends ParsedMeta, TOutput>(
    name: string,
    schema: InputSchema<TInput>,
    operation: (event: IpcMainInvokeEvent, window: BrowserWindow, input: TInput) => TOutput | Promise<TOutput>,
    outputSchema?: z.ZodType<TOutput>,
  ) => void;
  installHandler: <TInput extends ParsedMeta, TOutput>(
    name: string,
    schema: InputSchema<TInput>,
    options: unknown,
    operation: (event: IpcMainInvokeEvent, window: BrowserWindow, input: TInput) => TOutput | Promise<TOutput>,
    getWorkspaceEpoch?: (output: TOutput) => number | undefined,
    outputSchema?: z.ZodType<TOutput>,
  ) => void;
  requireM2Route: (...args: unknown[]) => void;
  requireAnyM2Route: (...args: unknown[]) => void;
  assertEpoch: (meta: { readonly workspaceEpoch?: number }, activeWorkspaceEpoch: number) => void;
  contract: unknown;
  /** 自由函数模块。**别定成 `unknown`**——段内每处 `ns_auth.x` 都会变成类型错误。 */
  ns_auth: typeof import("../gateway/desktop-gateway-ns-auth");
  gateway: DesktopGateway;
  options: unknown;
  emit: (...args: unknown[]) => void;
  // ── ③ 类（`registerM1DesktopIpc` 闭包里的成员）：**原样传引用** ──
  getActiveSubjectId: () => string | null;
  setActiveSubjectId: (value: string | null) => void;
  getActiveWorkspaceId: () => string | null;
  setActiveWorkspaceId: (value: string | null) => void;
  getActiveWorkspaceEpoch: () => number;
  setActiveWorkspaceEpoch: (value: number) => void;
  assertEpochBoundaryExempt: (meta: RequestMetaV1, activeWorkspaceEpoch: number) => void;
  safeWorkspaceEpoch: (value: unknown) => number | undefined;
  noteDocCache: NoteDocCacheStore;
  rememberSession: (session: SessionContextV1) => void;
  startCompanionLifecycle: (workspaceEpoch: number) => Promise<void>;
  stopCompanionLifecycle: () => void;
  stopCompanionChatStreams: () => void;
  clearSubscriptionsForWindow: (window: BrowserWindow) => void;
};


/** 这一族专属的入参 / 出参 schema。 */
const authLoginInputSchema = z.strictObject({
  ...m1InputBase,
  email: emailSchema,
  password: secretInputSchema,
  remember: z.boolean(),
});
const authRegisterInputSchema = z.strictObject({
  ...m1InputBase,
  email: emailSchema,
  // 与 API 的 `/auth/register-v2` 保持一致：注册密码至少 8 位。登录不设下限，
  // 否则历史账号会被客户端挡在门外。
  password: newPasswordSchema,
  inviteToken: inviteTokenSchema.optional(),
  displayName: z.string().trim().min(1).max(200).optional(),
  // 邮箱验证码：服务端在发信通道配置齐全时才强制；未配置时服务端不看这一格。
  emailCode: z.string().trim().regex(/^\d{6}$/).optional(),
  remember: z.boolean(),
});
const authReauthenticateInputSchema = z.strictObject({ ...m1InputBase, password: secretInputSchema });
const authChangePasswordInputSchema = z.strictObject({
  ...m1InputBase,
  commandId: commandIdSchema,
  currentPassword: secretInputSchema,
  newPassword: newPasswordSchema,
});
const authJoinWorkspaceInputSchema = z.strictObject({
  ...m1InputBase,
  inviteToken: inviteTokenSchema,
});
const emailCodeField = z.string().trim().regex(/^\d{6}$/, "验证码为 6 位数字");
const authSendEmailCodeInputSchema = z.strictObject({
  ...m1InputBase,
  email: emailSchema,
  purpose: z.enum(["register", "login", "reset_password"]),
});
const authLoginWithCodeInputSchema = z.strictObject({
  ...m1InputBase,
  email: emailSchema,
  code: emailCodeField,
  remember: z.boolean(),
});
const authResetPasswordInputSchema = z.strictObject({
  ...m1InputBase,
  email: emailSchema,
  code: emailCodeField,
  newPassword: newPasswordSchema,
});
const logoutInputSchema = z.strictObject({ ...m1InputBase, keepQuickLogin: z.boolean().optional() });
const logoutOutputSchema = z.strictObject({ loggedOut: z.literal(true), serverRevoked: z.boolean(), quickLoginAvailable: z.boolean().optional() });
const changePasswordOutputSchema = z.strictObject({ changed: z.literal(true), sessionsRevoked: z.literal(true) });
const sendEmailCodeOutputSchema = z.strictObject({ ok: z.literal(true), resendInSeconds: z.number().int().nonnegative() });
const resetPasswordOutputSchema = z.strictObject({ ok: z.literal(true) });

export function registerAuthChannels(deps: AuthChannelDeps): void {
  const {
    channel, installHandler, requireM2Route, requireAnyM2Route, assertEpoch,
    contract, getActiveWorkspaceEpoch, ns_auth, gateway, options, emit,
    getActiveSubjectId, setActiveSubjectId, getActiveWorkspaceId, setActiveWorkspaceId,
    setActiveWorkspaceEpoch,
    assertEpochBoundaryExempt, safeWorkspaceEpoch, noteDocCache, rememberSession,
    startCompanionLifecycle, stopCompanionLifecycle, stopCompanionChatStreams,
    clearSubscriptionsForWindow,
  } = deps;

installHandler(DESKTOP_IPC_CHANNELS.authGetState, runtimeInputSchema, options, async (_event, _window, input) => {
    const session = await ns_auth.getSession(gateway.gatewayTransport, input.meta.requestId);
    setActiveWorkspaceEpoch(session.status === "authenticated" || session.status === "reauth_required" ? session.workspaceEpoch : 0);
    rememberSession(session);
    if (session.status === "authenticated") void startCompanionLifecycle(session.workspaceEpoch);
    else stopCompanionLifecycle();
    return session;
  }, (output) => safeWorkspaceEpoch(output), sessionContextSchema);

  installHandler(DESKTOP_IPC_CHANNELS.authGetSurfaceManifest, runtimeInputSchema, options, async (_event, _window, input) => {
    return ns_auth.getAuthSurfaceManifest(gateway.gatewayTransport, input.meta.requestId);
  }, undefined, authSurfaceManifestResultV1Schema);

  installHandler(DESKTOP_IPC_CHANNELS.authLogin, authLoginInputSchema, options, async (_event, _window, input) => {
    const session = await ns_auth.login(gateway.gatewayTransport, gateway.companionBridge, input.email, input.password, input.meta.requestId, input.remember);
    setActiveWorkspaceEpoch(session.workspaceEpoch);
    rememberSession(session);
    void startCompanionLifecycle(session.workspaceEpoch);
    emit("runtime", { kind: "snapshot_invalidated", scope: "runtime" }, getActiveWorkspaceEpoch());
    return session;
  }, (output) => safeWorkspaceEpoch(output), sessionContextSchema);

  installHandler(DESKTOP_IPC_CHANNELS.authRegister, authRegisterInputSchema, options, async (_event, _window, input) => {
    const session = await ns_auth.register(gateway.gatewayTransport, gateway.companionBridge, input.email, input.password, input.inviteToken, input.displayName, input.meta.requestId, input.remember, input.emailCode);
    setActiveWorkspaceEpoch(session.workspaceEpoch);
    rememberSession(session);
    void startCompanionLifecycle(session.workspaceEpoch);
    return session;
  }, (output) => safeWorkspaceEpoch(output), sessionContextSchema);

  // 邮箱验证码三通道。发码与找回密码都发生在**未登录**状态，与
  // authGetSurfaceManifest 同一注册形状（不带 epoch 取值器）。
  installHandler(DESKTOP_IPC_CHANNELS.authSendEmailCode, authSendEmailCodeInputSchema, options, async (_event, _window, input) => {
    return ns_auth.sendEmailCode(gateway.gatewayTransport, input.email, input.purpose, input.meta.requestId);
  }, undefined, sendEmailCodeOutputSchema);

  installHandler(DESKTOP_IPC_CHANNELS.authLoginWithCode, authLoginWithCodeInputSchema, options, async (_event, _window, input) => {
    const session = await ns_auth.loginWithCode(gateway.gatewayTransport, gateway.companionBridge, input.email, input.code, input.meta.requestId, input.remember);
    setActiveWorkspaceEpoch(session.workspaceEpoch);
    rememberSession(session);
    void startCompanionLifecycle(session.workspaceEpoch);
    return session;
  }, (output) => safeWorkspaceEpoch(output), sessionContextSchema);

  installHandler(DESKTOP_IPC_CHANNELS.authResetPassword, authResetPasswordInputSchema, options, async (_event, _window, input) => {
    return ns_auth.resetPassword(gateway.gatewayTransport, input.email, input.code, input.newPassword, input.meta.requestId);
  }, undefined, resetPasswordOutputSchema);

  installHandler(DESKTOP_IPC_CHANNELS.authJoinWorkspace, authJoinWorkspaceInputSchema, options, async (_event, _window, input) => {
    assertEpochBoundaryExempt(input.meta, getActiveWorkspaceEpoch());
    const session = await ns_auth.joinWorkspace(gateway.gatewayTransport, input.inviteToken, input.meta.requestId);
    setActiveWorkspaceEpoch(session.workspaceEpoch);
    rememberSession(session);
    void startCompanionLifecycle(session.workspaceEpoch);
    return session;
  }, (output) => safeWorkspaceEpoch(output), sessionContextSchema);

  installHandler(DESKTOP_IPC_CHANNELS.authRememberedAccount, runtimeInputSchema, options, async () => {
    return ns_auth.getRememberedAccount(gateway.gatewayTransport);
  }, undefined, rememberedDesktopAccountV1Schema.nullable());

  installHandler(DESKTOP_IPC_CHANNELS.authForgetRemembered, runtimeInputSchema, options, async () => {
    return ns_auth.forgetRememberedAccount(gateway.gatewayTransport);
  }, undefined, z.strictObject({ forgotten: z.literal(true) }));

  installHandler(DESKTOP_IPC_CHANNELS.authResumeRemembered, runtimeInputSchema, options, async (_event, _window, input) => {
    const session = await ns_auth.resumeRememberedAccount(gateway.gatewayTransport, gateway.companionBridge, input.meta.requestId);
    setActiveWorkspaceEpoch(session.workspaceEpoch);
    rememberSession(session);
    void startCompanionLifecycle(session.workspaceEpoch);
    return session;
  }, (output) => safeWorkspaceEpoch(output), sessionContextSchema);

  installHandler(DESKTOP_IPC_CHANNELS.authLogout, logoutInputSchema, options, async (_event, window, input) => {
    try {
      const result = await ns_auth.logout(gateway.gatewayTransport, gateway.companionBridge, input.meta.requestId, input.keepQuickLogin);
      stopCompanionChatStreams();
      stopCompanionLifecycle();
      setActiveWorkspaceEpoch(0);
      // 退登要连本机那份正文一起清掉：它存的是笔记内容，不是可以留给下一个登录者的
      // 元数据。缓存键里的 subjectId 挡住了别人读到，但账号换到人这一侧也要主动删。
      // 身份是两个 `let`：**读用 getter，写用 setter**。
      // 提到局部变量——getter 每次调用都重算，TS 不跨调用保持可空收窄。
      const leavingSubjectId = getActiveSubjectId();
      if (leavingSubjectId) {
        await noteDocCache.clearSubject(leavingSubjectId);
      }
      setActiveSubjectId(null);
      setActiveWorkspaceId(null);
      clearSubscriptionsForWindow(window);
      return result;
    } catch (error) {
      // logout clears main-owned credentials before attempting the remote revoke;
      // local subscriptions must follow that fact even when the API is offline.
      setActiveWorkspaceEpoch(0);
      stopCompanionChatStreams();
      stopCompanionLifecycle();
      // 退登要连本机那份正文一起清掉：它存的是笔记内容，不是可以留给下一个登录者的
      // 元数据。缓存键里的 subjectId 挡住了别人读到，但账号换到人这一侧也要主动删。
      const sid = getActiveSubjectId();
      if (sid) await noteDocCache.clearSubject(sid);
      clearSubscriptionsForWindow(window);
      throw error;
    }
  }, undefined, logoutOutputSchema);

  installHandler(DESKTOP_IPC_CHANNELS.authReauthenticate, authReauthenticateInputSchema, options, async (_event, _window, input) => {
    const session = await ns_auth.reauthenticate(gateway.gatewayTransport, gateway.companionBridge, input.password, input.meta.requestId);
    setActiveWorkspaceEpoch(session.workspaceEpoch);
    rememberSession(session);
    void startCompanionLifecycle(session.workspaceEpoch);
    return session;
  }, (output) => safeWorkspaceEpoch(output), sessionContextSchema);

  installHandler(DESKTOP_IPC_CHANNELS.authChangePassword, authChangePasswordInputSchema, options, async (_event, _window, input) => {
    assertEpochBoundaryExempt(input.meta, getActiveWorkspaceEpoch());
    const result = await ns_auth.changePassword(gateway.gatewayTransport, gateway.companionBridge, input.currentPassword, input.newPassword, input.meta.requestId);
    stopCompanionLifecycle();
    setActiveWorkspaceEpoch(0);
    return result;
  }, undefined, changePasswordOutputSchema);

  ;

  // ─── 旧版设置页回补（2026-09-18）────────────────────────────────────
  // 档案与头像（用户级，Member 也可用；服务端各自收口归属与限流）。
  channel(DESKTOP_IPC_CHANNELS.authProfileGet, runtimeInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "settings.section");
    assertEpochBoundaryExempt(input.meta, getActiveWorkspaceEpoch());
    return ns_auth.getProfile(gateway.gatewayTransport, input.meta.requestId);
  }, authProfileResultV1Schema);

  channel(DESKTOP_IPC_CHANNELS.authUpdateProfile, authUpdateProfileInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "settings.section");
    assertEpochBoundaryExempt(input.meta, getActiveWorkspaceEpoch());
    return ns_auth.updateProfile(gateway.gatewayTransport, 
      { displayName: input.displayName, avatarUrl: input.avatarUrl },
      input.meta.requestId,
    );
  }, authProfileResultV1Schema);

  channel(DESKTOP_IPC_CHANNELS.authUploadAvatar, authAvatarUploadInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "settings.section");
    assertEpochBoundaryExempt(input.meta, getActiveWorkspaceEpoch());
    return ns_auth.uploadAvatar(gateway.gatewayTransport, input.request, input.meta.requestId);
  }, avatarUploadResultV1Schema);

  channel(DESKTOP_IPC_CHANNELS.authAvatarGet, authAvatarGetInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "settings.section");
    assertEpochBoundaryExempt(input.meta, getActiveWorkspaceEpoch());
    return ns_auth.getAvatar(gateway.gatewayTransport, input.request.objectKey, input.meta.requestId);
  }, avatarGetResultV1Schema);

  // 退出协作工作区是空间边界变化：回执是重读后的会话，与 joinWorkspace 同构。
  installHandler(DESKTOP_IPC_CHANNELS.authLeaveWorkspace, authLeaveWorkspaceInputSchema, options, async (_event, _window, input) => {
    assertEpochBoundaryExempt(input.meta, getActiveWorkspaceEpoch());
    const session = await ns_auth.leaveWorkspace(gateway.gatewayTransport, input.workspaceId, input.meta.requestId);
    // 退出这个空间：这个空间的本机副本一起作废。留在盘上等下一次进来，是一次没有
    // 承诺的复活——成员被移出后不该还能翻出里面的正文。
    const sid = getActiveSubjectId();
    if (sid) await noteDocCache.clearWorkspace(sid, input.workspaceId);
    setActiveWorkspaceEpoch(session.workspaceEpoch);
    rememberSession(session);
    emit("workspace", { kind: "snapshot_invalidated", scope: "workspace" }, getActiveWorkspaceEpoch());
    return session;
  }, (output) => safeWorkspaceEpoch(output), sessionContextSchema)
}
