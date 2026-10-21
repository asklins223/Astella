import * as ns_source from "../gateway/desktop-gateway-ns-source";
import * as ns_note from "../gateway/desktop-gateway-ns-note";
import * as ns_companion from "../gateway/desktop-gateway-ns-companion";
import * as ns_workspace from "../gateway/desktop-gateway-ns-workspace";
import * as ns_auth from "../gateway/desktop-gateway-ns-auth";
import * as ns_runtime from "../gateway/desktop-gateway-ns-runtime";import { BrowserWindow, dialog, type IpcMainInvokeEvent } from "electron";import { mkdir, readdir, writeFile } from "node:fs/promises";import { dirname } from "node:path";
import { exportNotesAsMarkdown } from "../note-doc/note-markdown-export";
import { z } from "zod";import { DESKTOP_IPC_CHANNELS, sessionContextSchema, workspaceContextSchema, workspaceSummarySchema, type RequestMetaV1, type SessionContextV1, requestMetaSchema, uuidSchema, aiDataPolicyV1Schema, workspaceAiSettingsV1Schema, workspaceExportResultV1Schema, AVATAR_MAX_BYTES, avatarObjectKeySchema, notesMarkdownExportResultV1Schema, renameWorkspaceResultV1Schema, dissolvePreviewResultV1Schema, dissolveWorkspaceResultV1Schema, transferWorkspaceOwnershipResultV1Schema, createWorkspaceResultV1Schema } from "@astella/shared/desktop-ipc-contracts";import { desktopAiAuditPageV1Schema } from "@astella/shared/desktop-surface-contracts";
import { DesktopGateway } from "../gateway/desktop-gateway";
import * as ns_search from "../gateway/desktop-gateway-ns-search";
import * as ns_invite from "../gateway/desktop-gateway-ns-invite";

import * as ns_artifact from "../gateway/desktop-gateway-ns-artifact";
import { DesktopGatewayFailure } from "../gateway/desktop-gateway-failure";import { type NoteDocCacheStore } from "../note-doc/note-doc-cache-store.ts";

import { runtimeInputSchema } from "./desktop-ipc-companion";
import type { InputSchema, ParsedMeta } from "./desktop-ipc";
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
export type WorkspaceChannelDeps = {
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
  /** 工作区纪元——**getter，不是值**。按值传会被注册那一刻的快照锁死。 */
  /** 自由函数模块。**别定成 `unknown`**——段内每处 `ns_workspace.x` 都会变成类型错误。 */
  ns_workspace: typeof import("../gateway/desktop-gateway-ns-workspace");
  gateway: DesktopGateway;
  options: unknown;
  emit: (...args: unknown[]) => void;
  // ── ③ 类（2026-09-30 第 42 轮查实）：闭包里的 `let` / 容器 / 函数，**原样传引用** ──
  /** `let activeSubjectId: string | null` ——**getter**：按值传会停在注册那一刻。 */
  getActiveSubjectId: () => string | null;
  setActiveSubjectId: (value: string | null) => void;
  getActiveWorkspaceId: () => string | null;
  setActiveWorkspaceId: (value: string | null) => void;
  /**
   * ② 类：工作区纪元，**闭包里的 `let`**。
   *
   * **要一对 getter / setter**：段内有 `activeWorkspaceEpoch = …` 的赋值
   * （握手成功后把纪元写进去）。只给 getter 会报「不能给 const 赋值」——
   * 而**只给值更糟**：那会把纪元永远锁在注册那一刻的 0。
   */
  getActiveWorkspaceEpoch: () => number;
  setActiveWorkspaceEpoch: (value: number) => void;
  /** 握手前后的三类通道走它（此时还没有 epoch 可带）。 */
  /** 只有握手前后那三类通道走它（此时还没有 epoch 可带）——**真签名**，别简化。 */
  assertEpochBoundaryExempt: (meta: RequestMetaV1, activeWorkspaceEpoch: number) => void;
  safeWorkspaceEpoch: (value: unknown) => number | undefined;
  rememberSession: (session: SessionContextV1) => void;
  startCompanionLifecycle: (workspaceEpoch: number) => Promise<void>;
  stopCompanionLifecycle: () => void;
  stopCompanionChatStreams: () => void;
  /**
   * 本机草稿 / 回执落盘接口。
   *
   * ⚠️ **这一族自己没带它们过来**——它们是 `registerM1DesktopIpc` 闭包里的成员，
   * 段内要用就**必须作为依赖传引用**（定义见 `desktop-ipc.ts` 的 options 类型）。
   */
  noteDocCache: NoteDocCacheStore;
};



/** 这一族专属的入参 / 出参 schema。 */
const workspaceSwitchInputSchema = z.strictObject({ ...m1InputBase, workspaceId: uuidSchema });
const workspaceAiAuditLogInputSchema = z.strictObject({
  ...m1InputBase,
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).optional(),
});
const workspaceAiConsentUpdateInputSchema = z.strictObject({
  ...m1InputBase,
  consentVersion: z.string().trim().min(1).max(50),
});
const workspaceAiDataPolicyUpdateInputSchema = z.strictObject({
  ...m1InputBase,
  policy: aiDataPolicyV1Schema,
});
const workspaceListOutputSchema = z.strictObject({ workspaces: z.array(workspaceSummarySchema) });
export const authUpdateProfileInputSchema = z.strictObject({
  ...m1InputBase,
  displayName: z.string().trim().min(1).max(32).nullable().optional(),
  avatarUrl: z.string().trim().max(500).nullable().optional(),
});
export const authAvatarUploadInputSchema = z.strictObject({
  ...m1InputBase,
  request: z.strictObject({
    version: z.literal(1),
    fileName: z.string().min(1).max(255),
    mimeType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
    bytesBase64: z.string().min(1).max(Math.ceil(AVATAR_MAX_BYTES / 3) * 4 + 8),
  }),
});
export const authAvatarGetInputSchema = z.strictObject({
  ...m1InputBase,
  request: z.strictObject({ version: z.literal(1), objectKey: avatarObjectKeySchema }),
});
export const authLeaveWorkspaceInputSchema = z.strictObject({ ...m1InputBase, workspaceId: uuidSchema });
const workspaceRenameInputSchema = z.strictObject({
  ...m1InputBase,
  workspaceId: uuidSchema,
  name: z.string().trim().min(1).max(50),
});
const workspaceCreateInputSchema = z.strictObject({
  ...m1InputBase,
  name: z.string().trim().min(1).max(50),
});
export const inviteCreateInputSchema = z.strictObject({
  ...m1InputBase,
  role: z.enum(["member", "owner"]),
  expiresInHours: z.number().int().min(1).max(168).optional(),
});
export const inviteRevokeInputSchema = z.strictObject({ ...m1InputBase, inviteId: uuidSchema });
export const memberRemoveInputSchema = z.strictObject({ ...m1InputBase, userId: uuidSchema });
const workspaceDissolveInputSchema = z.strictObject({ ...m1InputBase, workspaceId: uuidSchema });
const workspaceDissolvePreviewInputSchema = workspaceDissolveInputSchema;
const workspaceTransferOwnershipInputSchema = z.strictObject({ ...m1InputBase, workspaceId: uuidSchema, toUserId: uuidSchema });
/**
 * Markdown 目录导出没有入参：范围就是「这个调用者看得见的全部笔记」，由服务端按人判。
 * 客户端不再传一篇篇的 id ——那等于让界面替服务端决定谁能看什么。
 */
const notesMarkdownExportInputSchema = z.strictObject({ ...m1InputBase });
export const revokeOutputSchema = z.strictObject({ revoked: z.literal(true) });
export const memberRemoveOutputSchema = z.strictObject({ removed: z.literal(true) });
const workspaceDissolvePreviewOutputSchema = dissolvePreviewResultV1Schema;
const workspaceDissolveOutputSchema = dissolveWorkspaceResultV1Schema;
const workspaceTransferOwnershipOutputSchema = transferWorkspaceOwnershipResultV1Schema;

export function registerWorkspaceChannels(deps: WorkspaceChannelDeps): void {
  const {
    channel, installHandler, requireM2Route, requireAnyM2Route, assertEpoch,
    contract, getActiveWorkspaceEpoch, ns_workspace, gateway, options, emit,
    getActiveSubjectId, setActiveSubjectId, getActiveWorkspaceId, setActiveWorkspaceId,
    setActiveWorkspaceEpoch,
    assertEpochBoundaryExempt, safeWorkspaceEpoch, noteDocCache,
    rememberSession,
    startCompanionLifecycle, stopCompanionLifecycle, stopCompanionChatStreams,
  } = deps;

installHandler(DESKTOP_IPC_CHANNELS.workspaceList, runtimeInputSchema, options, async (_event, _window, input) => {
    assertEpochBoundaryExempt(input.meta, getActiveWorkspaceEpoch());
    return ns_workspace.listWorkspaces(gateway.gatewayTransport, input.meta.requestId);
  }, undefined, workspaceListOutputSchema);

  installHandler(DESKTOP_IPC_CHANNELS.workspaceSwitch, workspaceSwitchInputSchema, options, async (_event, _window, input) => {
    assertEpochBoundaryExempt(input.meta, getActiveWorkspaceEpoch());
    stopCompanionChatStreams();
    stopCompanionLifecycle();
    // 提到局部变量：**getter 每次调用都会重算**，TS 不会跨两次调用保持可空收窄。
    const subjectId = getActiveSubjectId();
    const spaceId = getActiveWorkspaceId();
    if (subjectId && spaceId) {
      // 审查附录 C：「磁盘侧（导出文件、图片缓存、资源目录）是否按空间分键？」
      // 核实结果：主进程落盘的缓存按 `(subjectId, workspaceId, …)` 分键，
      // 导出文件由读者自己在系统对话框里选路径（那是他的文件，不是本机缓存）。
      // **但"分键"只解决串读，不解决残留**：离开一个空间后正文还躺在盘上，下一次
      // 登录同一个账号仍能按 uuid 读回来。所以切走时把这个空间的本机副本一起作废——
      // 与退出那条路同一句话，只是触发时机不同。
      await noteDocCache.clearWorkspace(subjectId, spaceId);
    }
    const session = await ns_auth.switchWorkspace(gateway.gatewayTransport, gateway.companionBridge, input.workspaceId, input.meta.requestId);
    setActiveWorkspaceEpoch(session.workspaceEpoch);
    rememberSession(session);
    void startCompanionLifecycle(session.workspaceEpoch);
    emit("workspace", { kind: "snapshot_invalidated", scope: "workspace" }, getActiveWorkspaceEpoch());
    return session;
  }, (output) => safeWorkspaceEpoch(output), sessionContextSchema);

  installHandler(DESKTOP_IPC_CHANNELS.workspaceGetCurrent, runtimeInputSchema, options, async (_event, _window, input) => {
    assertEpochBoundaryExempt(input.meta, getActiveWorkspaceEpoch());
    const workspace = await ns_auth.getCurrentWorkspace(gateway.gatewayTransport, input.meta.requestId);
    setActiveWorkspaceEpoch(workspace.workspaceEpoch);
    return workspace;
  }, (output) => safeWorkspaceEpoch(output), workspaceContextSchema);

  // 设置页的「AI 数据同意」分区。每个人保存自己的账号授权与外发选择，
  // 读回的是服务端当前状态，因此投影与界面不会各自维护一份同意状态。
  channel(DESKTOP_IPC_CHANNELS.workspaceAiSettingsGet, runtimeInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "settings.section");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_workspace.getWorkspaceAiSettings(gateway.gatewayTransport, input.meta.requestId);
  }, workspaceAiSettingsV1Schema);

  channel(DESKTOP_IPC_CHANNELS.workspaceAiConsentUpdate, workspaceAiConsentUpdateInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "settings.section");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_workspace.updateAiConsent(gateway.gatewayTransport, input.consentVersion, input.meta.requestId);
  }, workspaceAiSettingsV1Schema);

  channel(DESKTOP_IPC_CHANNELS.workspaceAiDataPolicyUpdate, workspaceAiDataPolicyUpdateInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "settings.section");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_workspace.updateAiDataPolicy(gateway.gatewayTransport, input.policy, input.meta.requestId);
  }, workspaceAiSettingsV1Schema);

  /**
   * AI 外发审计的一页（doc 34 L3 的另一半：写侧一直在记，桌面以前没有任何地方读）。
   * Owner 门在服务端那条路由上（`requireOwner`），这里不写第二份——和整库导出同一口径。
   */
  channel(DESKTOP_IPC_CHANNELS.workspaceAiAuditLog, workspaceAiAuditLogInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "settings.section");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_workspace.getWorkspaceAiAuditLog(gateway.gatewayTransport, input.limit ?? 20, input.offset ?? 0, input.meta.requestId);
  }, desktopAiAuditPageV1Schema);

  /**
   * 整库导出。服务端出数据（`requireOwner` 收口），本机负责落盘：读者在系统
   * 保存对话框里自己选位置，主进程写文件。渲染进程只拿到回执——它既看不到
   * 文件系统，也没有任何写文件的通道。
   */
  channel(DESKTOP_IPC_CHANNELS.workspaceExport, runtimeInputSchema, async (_event, window, input) => {
    requireM2Route(contract, "settings.section");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    const payload = await ns_workspace.fetchWorkspaceExport(gateway.gatewayTransport, input.meta.requestId);
    // 网关把解不开的响应体读成 null。导出是数据出口，宁可失败也不能让读者
    // 在系统对话框里确认之后拿到一个写着 `null` 的文件。
    if (payload === null || typeof payload !== "object") {
      throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    }
    const text = JSON.stringify(payload, null, 2);
    const selection = await dialog.showSaveDialog(window, {
      title: "导出工作区",
      defaultPath: `astella-workspace-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (selection.canceled || !selection.filePath) {
      return { version: 1 as const, saved: false, canceled: true, filePath: null, bytes: 0 };
    }
    try {
      await writeFile(selection.filePath, text, "utf8");
    } catch {
      // 数据已经取回来了，失败的是本机写入（权限、磁盘、路径），所以这是一个
      // 读者可以自己重试的问题，而不是服务端错误。
      throw new DesktopGatewayFailure("safe_internal_error", "user_action");
    }
    return {
      version: 1 as const,
      saved: true,
      canceled: false,
      filePath: selection.filePath,
      bytes: Buffer.byteLength(text, "utf8"),
    };
  }, workspaceExportResultV1Schema)

/**
 * 笔记导出为 Markdown 目录：紧挨着上面那条整库导出，因为它们在设置页是同一组里的两行，
 * 而差别是**读者与形态**——上面那条要 owner、给一个 JSON；这条任何成员都能按自己看得见的
 * 范围导、给一个装满 `.md` 的目录。
 *
 * 分工也和上面一样：服务端出数据（可见性在服务端按人判），本机负责落盘。落盘这一段
 * 委托给 `note-markdown-export.ts`，因为「文件名怎么起、撞名怎么办、失败怎么数」是
 * 一份有自己判据的纯逻辑，不该埋在这条通道里。
 */
channel(DESKTOP_IPC_CHANNELS.notesMarkdownExport, notesMarkdownExportInputSchema, async (_event, window, input) => {
  requireM2Route(contract, "settings.section");
  assertEpoch(input.meta, getActiveWorkspaceEpoch());
  return exportNotesAsMarkdown({
    listNotes: () => ns_note.listNotesForMarkdownExport(gateway.gatewayTransport, input.meta.requestId),
    fetchMarkdown: (noteId) => ns_note.fetchNoteMarkdown(gateway.gatewayTransport, noteId, input.meta.requestId),
    pickDirectory: async () => {
      const selection = await dialog.showOpenDialog(window, {
        title: "导出笔记为 Markdown",
        // createDirectory：读者可以在这个对话框里当场新建一个文件夹，而不是被要求
        // 先自己去 Finder 建好再回来。
        properties: ["openDirectory", "createDirectory"],
        defaultPath: `书房笔记 ${new Date().toISOString().slice(0, 10)}`,
      });
      return selection.canceled ? null : (selection.filePaths[0] ?? null);
    },
    existingNames: async (directory) => {
      // 目录里读者自己的文件不能被覆盖：只取文件名，且一律小写去撞——
      // macOS 上 `读书.md` 与 `读书.MD` 是同一个文件。
      try {
        return new Set((await readdir(directory)).map((name) => name.toLowerCase()));
      } catch {
        // 读不到就当目录是空的：真撞上时 writeFile 的行为由下面的 flag 兜住。
        return new Set<string>();
      }
    },
    writeNote: (filePath, text) => writeFile(filePath, text, { encoding: "utf8", flag: "wx" }),
    // 图片走的是阅读页那同一条通道（main 带会话令牌取原始字节），不为导出另开一条路。
    fetchImage: async (objectKey) => {
      const image = await ns_source.getSourceImage(gateway.gatewayTransport, { version: 1, objectKey }, input.meta.requestId);
      return { bytes: Buffer.from(image.imageBase64, "base64"), mime: image.mimeType };
    },
    writeAsset: async (filePath, bytes) => {
      try {
        await mkdir(dirname(filePath), { recursive: true });
        // wx：名字是按内容哈希取的，同名即同字节。已经在那儿了就算成功，不去覆盖读者
        // 目录里可能存在的任何东西。
        await writeFile(filePath, bytes, { flag: "wx" });
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return true;
        return false;
      }
    },
  });
}, notesMarkdownExportResultV1Schema);

channel(DESKTOP_IPC_CHANNELS.workspaceRename, workspaceRenameInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "settings.section");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_auth.renameWorkspace(gateway.gatewayTransport, input.workspaceId, input.name, input.meta.requestId);
  }, renameWorkspaceResultV1Schema);

  // 新建协作空间。入口在房间控制的学习空间菜单里（不是设置页），所以路由门控取
  // room.home；创建不换空间，因此不触发令牌轮换。
  channel(DESKTOP_IPC_CHANNELS.workspaceCreate, workspaceCreateInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_auth.createWorkspace(gateway.gatewayTransport, gateway.companionBridge, input.name, input.meta.requestId);
  }, createWorkspaceResultV1Schema)

channel(DESKTOP_IPC_CHANNELS.workspaceDissolve, workspaceDissolveInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "settings.section");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_workspace.dissolveWorkspace(gateway.gatewayTransport, input.workspaceId, input.meta.requestId);
  }, workspaceDissolveOutputSchema);

  // 解散前的先睹计数（审计 F39 ③）：只读，所以确认展开时就取一次；取不到不拦解散，
  // 但界面必须说"这一项目前数不出来"，不能拿 0 冒充"这里什么都没有"。
  channel(DESKTOP_IPC_CHANNELS.workspaceDissolvePreview, workspaceDissolvePreviewInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "settings.section");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_workspace.previewWorkspaceDissolve(gateway.gatewayTransport, input.workspaceId, input.meta.requestId);
  }, workspaceDissolvePreviewOutputSchema);

  // 转让所有权：同一对门（M2 路由 + epoch）。服务端 requireOwner 是最终裁判。
  channel(DESKTOP_IPC_CHANNELS.workspaceTransferOwnership, workspaceTransferOwnershipInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "settings.section");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_workspace.transferWorkspaceOwnership(gateway.gatewayTransport, input.workspaceId, input.toUserId, input.meta.requestId);
  }, workspaceTransferOwnershipOutputSchema);

}
