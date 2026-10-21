import { sourceArchiveInputSchema, sourceCreateInputSchema, sourceCreateNoteInputSchema, sourceGetInputSchema, sourceImageGetInputSchema, sourceListInputSchema, sourceNotesInputSchema, sourceReparseInputSchema, sourceRestoreInputSchema, sourceUpdateInputSchema } from "./desktop-ipc-companion";
import * as ns_source from "../gateway/desktop-gateway-ns-source";
import { artifactEnsureInputSchema, artifactEnsureResultSchema } from "./desktop-ipc-input-schemas";
import * as ns_note from "../gateway/desktop-gateway-ns-note";
import * as ns_companion from "../gateway/desktop-gateway-ns-companion";
import * as ns_workspace from "../gateway/desktop-gateway-ns-workspace";
import * as ns_auth from "../gateway/desktop-gateway-ns-auth";
import * as ns_runtime from "../gateway/desktop-gateway-ns-runtime";import { BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { z } from "zod";import { DESKTOP_IPC_CHANNELS, requestMetaSchema, uuidSchema } from "@astella/shared/desktop-ipc-contracts";import { desktopSourceListPageSchema, desktopSourceDetailSchema, desktopSourceNotesPageSchema, desktopSourceNoteResultSchema, desktopSourceCreateResultV1Schema, desktopSourceArchiveResultSchema, desktopSourceRestoreResultSchema, desktopSourceReparseResultSchema, desktopNoteCreateRequestSchema } from "@astella/shared/desktop-surface-contracts";import { SOURCE_IMAGE_MAX_BYTES, sourceImageGetResultV1Schema } from "@astella/shared/source-image-contracts";import { noteImageUploadRequestV1Schema } from "@astella/shared/note-image-upload-contracts";
import { DesktopGateway } from "../gateway/desktop-gateway";
import * as ns_search from "../gateway/desktop-gateway-ns-search";
import * as ns_invite from "../gateway/desktop-gateway-ns-invite";

import * as ns_artifact from "../gateway/desktop-gateway-ns-artifact";
import { DesktopGatewayFailure } from "../gateway/desktop-gateway-failure";
import { ensureArtifactStored } from "../artifact/artifact-store";
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
export type SourceChannelDeps = {
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
  getActiveWorkspaceEpoch: () => number;
  ns_source: typeof import("../gateway/desktop-gateway-ns-source");
  gateway: DesktopGateway;
  options: unknown;
  emit: (...args: unknown[]) => void;
  /**
   * ③ 类：产物落盘目录。
   *
   * `desktop-ipc.ts` **不 import Electron 的 `app`**（通道覆盖那份测试的替身里没有
   * `app.getPath`，模块加载期碰它就会红），生产由 `index.ts` 给
   * `() => app.getPath("userData")`。**这里是闭包里的那个函数，传引用。**
   */
  artifactUserDataDir: () => string;
};

/** 这一族专属的入参 / 出参 schema。 */
export const noteListInputSchema = z.strictObject({ ...m1InputBase, cursor: z.string().min(1).max(128).optional(), limit: z.number().int().min(1).max(100).optional(), trashed: z.boolean().optional() });
export const noteCreateInputSchema = z.strictObject({ ...m1InputBase, request: desktopNoteCreateRequestSchema });
export const noteGetInputSchema = z.strictObject({ ...m1InputBase, noteId: uuidSchema, noteVersionId: uuidSchema.optional() });
export const noteVersionsInputSchema = z.strictObject({
  ...m1InputBase,
  noteId: uuidSchema,
  currentVersionId: uuidSchema,
  limit: z.number().int().min(1).max(200).optional(),
});
export const noteVersionRestoreInputSchema = z.strictObject({
  ...m1InputBase,
  noteId: uuidSchema,
  versionId: uuidSchema,
  baseVersionId: uuidSchema,
});
export const noteImageUploadInputSchema = z.strictObject({
  ...m1InputBase,
  noteId: uuidSchema,
  request: noteImageUploadRequestV1Schema,
});

export function registerSourceChannels(deps: SourceChannelDeps): void {
  const {
    channel, installHandler, requireM2Route, requireAnyM2Route, assertEpoch,
    contract, getActiveWorkspaceEpoch, ns_source, gateway, options, emit,
    artifactUserDataDir,
  } = deps;

channel(DESKTOP_IPC_CHANNELS.sourceList, sourceListInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "source.library");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_source.listSources(gateway.gatewayTransport, { status: input.status, cursor: input.cursor, limit: input.limit }, input.meta.requestId);
  }, desktopSourceListPageSchema);

  // Capturing material is an owner-only write on the API, and the capability
  // projection already says so; checking it here keeps a member from filling in
  // the capture form only to be rejected at the end.
  channel(DESKTOP_IPC_CHANNELS.sourceCreate, sourceCreateInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "source.library");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    const capabilities = await ns_source.getCapabilities(gateway.gatewayTransport, input.meta.requestId);
    if (capabilities.actionCapabilities["source.create"] !== "allowed") {
      throw new DesktopGatewayFailure("forbidden", "never");
    }
    return ns_source.createSource(gateway.gatewayTransport, input.request, input.meta.requestId);
  }, desktopSourceCreateResultV1Schema);

  channel(DESKTOP_IPC_CHANNELS.sourceGet, sourceGetInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "source.detail");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_source.getSource(gateway.gatewayTransport, input.sourceId, input.meta.requestId);
  }, desktopSourceDetailSchema);

  channel(DESKTOP_IPC_CHANNELS.sourceNotes, sourceNotesInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "source.detail");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_source.listSourceNotes(gateway.gatewayTransport, input.sourceId, input.meta.requestId);
  }, desktopSourceNotesPageSchema);

  // Renaming and "write a note from this source" are owner-only writes the
  // capability projection already advertises, so a member is stopped here
  // instead of after filling in a title.
  channel(DESKTOP_IPC_CHANNELS.sourceUpdate, sourceUpdateInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "source.detail");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    const capabilities = await ns_source.getCapabilities(gateway.gatewayTransport, input.meta.requestId);
    if (capabilities.actionCapabilities["source.update"] !== "allowed") {
      throw new DesktopGatewayFailure("forbidden", "never");
    }
    return ns_source.updateSourceTitle(gateway.gatewayTransport, input.sourceId, input.request, input.meta.requestId);
  }, desktopSourceDetailSchema);

  channel(DESKTOP_IPC_CHANNELS.sourceCreateNote, sourceCreateNoteInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "source.detail");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    const capabilities = await ns_source.getCapabilities(gateway.gatewayTransport, input.meta.requestId);
    if (capabilities.actionCapabilities["source.createNote"] !== "allowed") {
      throw new DesktopGatewayFailure("forbidden", "never");
    }
    return ns_source.createNoteFromSource(gateway.gatewayTransport, input.sourceId, { force: input.force }, input.meta.requestId);
  }, desktopSourceNoteResultSchema);

  // Archiving is the source's soft delete and the last owner-only source write
  // the capability projection advertises; checking it here keeps a member from
  // confirming an action they were never allowed to ask for.
  channel(DESKTOP_IPC_CHANNELS.sourceArchive, sourceArchiveInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "source.detail");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    const capabilities = await ns_source.getCapabilities(gateway.gatewayTransport, input.meta.requestId);
    if (capabilities.actionCapabilities["source.archive"] !== "allowed") {
      throw new DesktopGatewayFailure("forbidden", "never");
    }
    return ns_source.archiveSource(gateway.gatewayTransport, input.sourceId, input.meta.requestId);
  }, desktopSourceArchiveResultSchema);

  /**
   * 重新解析一篇来源（doc 34 L7）。门控沿用 `source.update`：重新解析改的是这一篇
   * 自己的解析结果，与归档同一类 owner-only 写；服务端那边另有 `requireOwner`，
   * 这里挡的是"点了才知道没权限"。
   */
  channel(DESKTOP_IPC_CHANNELS.sourceReparse, sourceReparseInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "source.detail");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    const capabilities = await ns_source.getCapabilities(gateway.gatewayTransport, input.meta.requestId);
    if (capabilities.actionCapabilities["source.update"] !== "allowed") {
      throw new DesktopGatewayFailure("forbidden", "never");
    }
    return ns_source.reparseSource(gateway.gatewayTransport, input.sourceId, input.meta.requestId);
  }, desktopSourceReparseResultSchema);

  /**
   * 恢复一篇已归档的来源（审计 F08）。门控与归档同一处：服务端 `requireOwner`
   * 是真正的判据，这里先挡住"点了才知道没权限"。
   */
  channel(DESKTOP_IPC_CHANNELS.sourceRestore, sourceRestoreInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "source.detail");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    const capabilities = await ns_source.getCapabilities(gateway.gatewayTransport, input.meta.requestId);
    if (capabilities.actionCapabilities["source.archive"] !== "allowed") {
      throw new DesktopGatewayFailure("forbidden", "never");
    }
    return ns_source.restoreSource(gateway.gatewayTransport, input.sourceId, input.meta.requestId);
  }, desktopSourceRestoreResultSchema);

  // 站内图片字节：来源详情的正文片段与笔记阅读页都会用到（两者共用同一份
  // `/api/uploads/…` 引用），所以只要其中一个面可达就放行。这里没有 owner 门控
  // ——能读到正文的成员就该看到正文里的图，服务端的下载路由仍会按 workspace
  // 与登记记录自行收口。
  channel(DESKTOP_IPC_CHANNELS.sourceImageGet, sourceImageGetInputSchema, async (_event, _window, input) => {
    requireAnyM2Route(contract, ["source.detail", "note.detail"]);
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_source.getSourceImage(gateway.gatewayTransport, input.request, input.meta.requestId);
  }, sourceImageGetResultV1Schema)

  channel(DESKTOP_IPC_CHANNELS.sourceImageUpload, z.strictObject({ meta: requestMetaSchema, request: noteImageUploadRequestV1Schema }), async (_event, _window, input) => {
    requireM2Route(contract, "source.library");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    const capabilities = await ns_source.getCapabilities(gateway.gatewayTransport, input.meta.requestId);
    if (capabilities.actionCapabilities["source.create"] !== "allowed") throw new DesktopGatewayFailure("forbidden", "never");
    const bytes = Buffer.from(input.request.bytesBase64, "base64");
    if (!bytes.length || bytes.length > SOURCE_IMAGE_MAX_BYTES) throw new DesktopGatewayFailure("validation", "never");
    const url = await ns_source.uploadBundleImage(gateway.gatewayTransport, { fileName: input.request.fileName, mimeType: input.request.mimeType, bytes }, input.meta.requestId);
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return { version: 1 as const, url };
  }, z.strictObject({ version: z.literal(1), url: z.string().min(1).max(512) }));

channel(DESKTOP_IPC_CHANNELS.artifactEnsure, artifactEnsureInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "note.detail");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    // 落盘失败一律如实上抛（`ArtifactStoreFailure` 是网关失败的子类，`mapFailure` 会带着
    // `code` 翻出去）：回一个 `stored:false` 会让界面把"没落下来"读成"已经在了"。
    const ensured = await ensureArtifactStored(
      { artifactId: input.artifactId, requestId: input.meta.requestId },
      {
        userDataDir: artifactUserDataDir(),
        fetchArtifactHtml: (artifactId, requestId) => input.origin === "note_learning_card"
          ? ns_artifact.getNoteLearningCardOperationHtml(gateway.gatewayTransport, artifactId, requestId)
          : input.origin === "note_learning"
          ? ns_artifact.getNoteLearningArtifactHtml(gateway.gatewayTransport, artifactId, requestId)
          : ns_artifact.getNoteLearningRoundArtifactHtml(gateway.gatewayTransport, artifactId, requestId),
      },
    );
    return { stored: ensured.stored };
  }, artifactEnsureResultSchema)
}
