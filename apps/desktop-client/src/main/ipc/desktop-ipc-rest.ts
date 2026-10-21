import { noteLearningCardGenerationOptionsV1Schema } from "@astella/shared/note-learning-card-contracts";
import { createNoteMindMapTaskV1Schema, noteMindMapLatestTaskQueryV1Schema, noteMindMapLatestTaskV1Schema, noteMindMapPageV1Schema, noteMindMapTaskV1Schema, noteMindMapSourceV1Schema } from "@astella/shared/note-mind-map-contracts";
import { runtimeInputSchema } from "./desktop-ipc-companion";
import type { NoteDocStreamEntry } from "./desktop-ipc";
import * as ns_source from "../gateway/desktop-gateway-ns-source";import { noteListInputSchema, noteCreateInputSchema, noteGetInputSchema, noteVersionsInputSchema, noteVersionRestoreInputSchema, noteImageUploadInputSchema } from "./desktop-ipc-source";
import { noteIdInputSchema, noteDeepeningInputSchema, searchGlobalInputSchema, noteSaveInputSchema, noteDocStateInputSchema, noteDocSyncUpdateInputSchema, noteDocSyncTitleInputSchema, noteSetShareInputSchema, noteDocPresenceInputSchema, noteDocDraftSaveInputSchema, noteDocDraftNoteInputSchema } from "./desktop-ipc-input-schemas";import { inviteCreateInputSchema, inviteRevokeInputSchema, memberRemoveInputSchema, revokeOutputSchema, memberRemoveOutputSchema } from "./desktop-ipc-workspace";
import * as ns_note from "../gateway/desktop-gateway-ns-note";
import * as ns_companion from "../gateway/desktop-gateway-ns-companion";
import * as ns_workspace from "../gateway/desktop-gateway-ns-workspace";
import * as ns_auth from "../gateway/desktop-gateway-ns-auth";
import * as ns_runtime from "../gateway/desktop-gateway-ns-runtime";
import { noteReflectionPageV1Schema, noteReflectionCommandV1Schema, noteReflectionWriteResultV1Schema } from "@astella/shared/note-learning-reflection-contracts";
import { noteAnnotationPageV1Schema, noteAnnotationCommandV1Schema, noteAnnotationWriteResultV1Schema, createNoteAnnotationTaskV1Schema, noteAnnotationLatestTaskQueryV1Schema, noteAnnotationLatestTaskV1Schema, noteAnnotationTaskV1Schema } from "@astella/shared/note-annotation-contracts";
import {
  createNoteOverviewTaskV1Schema,
  noteOverviewLatestTaskQueryV1Schema,
  noteOverviewLatestTaskV1Schema,
  noteOverviewPageV1Schema,
  noteOverviewTaskV1Schema,
} from "@astella/shared/note-overview-contracts";
import { noteRecallActionV1Schema, noteRecallActionResultV1Schema, noteRecallPageV1Schema, noteRecallStartInputV1Schema, noteRecallStartResultV1Schema } from "@astella/shared/note-recall-contracts";
import {
  createNoteExpansionTaskV1Schema,
  confirmNoteExpansionTaskV1Schema,
  noteExpansionBatchWriteResultV1Schema,
  noteExpansionLatestTaskQueryV1Schema,
  noteExpansionLatestTaskV1Schema,
  noteExpansionListQueryV1Schema,
  noteExpansionPageV1Schema,
  noteExpansionReviewV1Schema,
  noteExpansionTaskV1Schema,
  noteExpansionTaskListQueryV1Schema,
  noteExpansionTaskPageV1Schema,
} from "@astella/shared/note-expansion-contracts";
import {
  createNoteDynamicArtifactTaskV1Schema,
  noteLearningArtifactPageV1Schema,
  noteLearningArtifactTaskListQueryV1Schema,
  noteLearningArtifactTaskPageV1Schema,
  noteLearningArtifactTaskV1Schema,
} from "@astella/shared/note-learning-artifact-contracts";import { BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { z } from "zod";import { DESKTOP_IPC_CHANNELS, desktopNoteSaveRequestV1Schema, requestMetaSchema, uuidSchema, inviteCreatedV1Schema, inviteListResultV1Schema, memberListResultV1Schema, noteDocStateResultV1Schema, noteDocWriteResultV1Schema, noteDocPresenceResultV1Schema, noteDocDraftSaveResultV1Schema, noteDocDraftGetResultV1Schema, noteDocDraftClearResultV1Schema, type NoteDocDraftSaveResultV1, type NoteDocDraftGetResultV1, type NoteDocDraftClearResultV1, type NoteDocWriteResultV1, searchDriftResultV1Schema, searchReindexResultV1Schema } from "@astella/shared/desktop-ipc-contracts";import { desktopNoteListPageSchema, desktopNoteMutationResultSchema, desktopNoteVersionListSchema, desktopSearchPageSchema } from "@astella/shared/desktop-surface-contracts";
import { understandingTopologySnapshotV3Schema } from "@astella/shared/note-deepening-contracts";
import { noteDeepeningV3Schema } from "@astella/shared/note-deepening-v3-contracts";import { noteImageUploadResultV1Schema } from "@astella/shared/note-image-upload-contracts";
import { noteDetailV1Schema } from "@astella/shared/note-projection-contracts";
import { noteSaveReceiptV1Schema } from "@astella/shared/note-save-contracts";import { noteShareScopeReceiptV1Schema, type NoteShareScopeReceiptV1 } from "@astella/shared/note-share-contracts";
import { notePresenceListV1Schema } from "@astella/shared/note-presence-contracts";
import { DesktopGateway } from "../gateway/desktop-gateway";
import * as ns_search from "../gateway/desktop-gateway-ns-search";
import * as ns_invite from "../gateway/desktop-gateway-ns-invite";

import * as ns_artifact from "../gateway/desktop-gateway-ns-artifact";
import { DesktopGatewayFailure } from "../gateway/desktop-gateway-failure";import { type NoteDocCacheKey, type NoteDocCacheStore } from "../note-doc/note-doc-cache-store.ts";
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
export type RestChannelDeps = {
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
  ns_rest: typeof import("../gateway/desktop-gateway-ns-note");
  gateway: DesktopGateway;
  options: unknown;
  emit: (...args: unknown[]) => void;
  // ── ③ 类（`registerM1DesktopIpc` 闭包里的成员）：**原样传引用** ──
  getActiveWorkspaceId: () => string | null;
  setActiveWorkspaceId: (value: string | null) => void;
  /** ② 类：段内有赋值（握手后写纪元）——getter + setter **一对**。 */
  getActiveWorkspaceEpoch: () => number;
  setActiveWorkspaceEpoch: (value: number) => void;
  noteDocCacheKey: (noteId: string) => NoteDocCacheKey | null;
  persistNoteDocLocal: (noteId: string) => Promise<void>;
  noteDocStreams: Map<string, NoteDocStreamEntry>;
  noteDocPresenceToReplay: Map<string, string>;
  noteDocCache: NoteDocCacheStore;
};


/** 这一族专属的入参 / 出参 schema。 */


export function registerRestChannels(deps: RestChannelDeps): void {
  const {
    channel, installHandler, requireM2Route, requireAnyM2Route, assertEpoch,
    contract, getActiveWorkspaceEpoch, ns_rest, gateway, options, emit,
    getActiveWorkspaceId, setActiveWorkspaceId, setActiveWorkspaceEpoch,
    noteDocCacheKey, persistNoteDocLocal, noteDocStreams, noteDocPresenceToReplay,
    noteDocCache,
  } = deps;

channel(DESKTOP_IPC_CHANNELS.inviteCreate, inviteCreateInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "settings.section");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_invite.createInvite(gateway.gatewayTransport, 
      { role: input.role, expiresInHours: input.expiresInHours },
      input.meta.requestId,
    );
  }, inviteCreatedV1Schema);

  channel(DESKTOP_IPC_CHANNELS.inviteList, runtimeInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "settings.section");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_invite.listInvites(gateway.gatewayTransport, input.meta.requestId);
  }, inviteListResultV1Schema);

  channel(DESKTOP_IPC_CHANNELS.inviteRevoke, inviteRevokeInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "settings.section");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_invite.revokeInvite(gateway.gatewayTransport, input.inviteId, input.meta.requestId);
  }, revokeOutputSchema);

  channel(DESKTOP_IPC_CHANNELS.memberList, runtimeInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "settings.section");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return gateway.listMembers(input.meta.requestId);
  }, memberListResultV1Schema);

  channel(DESKTOP_IPC_CHANNELS.memberRemove, memberRemoveInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "settings.section");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return gateway.removeMember(input.userId, input.meta.requestId);
  }, memberRemoveOutputSchema);

  // 解散空间：不可逆，所以和邻居们走同一对门（M2 路由 + epoch 断言）。
  // 逐表计数由服务端带回，界面拿它说明"删了什么"——这里不替它编。
  ;

  // 搜索索引维护（F-025 / F-011，Owner）。
  channel(DESKTOP_IPC_CHANNELS.searchDriftGet, runtimeInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "settings.section");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_search.getSearchDrift(gateway.gatewayTransport, input.meta.requestId);
  }, searchDriftResultV1Schema);

  channel(DESKTOP_IPC_CHANNELS.searchReindex, runtimeInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "settings.section");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_search.reindexSearch(gateway.gatewayTransport, input.meta.requestId);
  }, searchReindexResultV1Schema)

installHandler(DESKTOP_IPC_CHANNELS.noteGet, noteGetInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "note.detail");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    const note = await ns_note.getNote(gateway.gatewayTransport, input.noteId, input.meta.requestId, input.noteVersionId);
    if (getActiveWorkspaceId() && note.workspaceId !== getActiveWorkspaceId()) {
      throw new DesktopGatewayFailure("stale_workspace", "resync_first");
    }
    return note;
  }, undefined, noteDetailV1Schema);

  channel(DESKTOP_IPC_CHANNELS.noteList, noteListInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "note.library");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_note.listNotes(gateway.gatewayTransport, { cursor: input.cursor, limit: input.limit, trashed: input.trashed }, input.meta.requestId);
  }, desktopNoteListPageSchema);

  // 「此刻谁开着哪一篇」（共享空间在场）。与笔记列表同一个路线门槛：它服务的就是
  // "列表那一行有没有人在看"这句话，列表还读不动的时候这一发也不该发出去。
  channel(DESKTOP_IPC_CHANNELS.notePresenceList, z.strictObject({ ...m1InputBase }), async (_event, _window, input) => {
    requireM2Route(contract, "note.library");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_note.listNotePresence(gateway.gatewayTransport, input.meta.requestId);
  }, notePresenceListV1Schema);

  // Writing a note is gated on `note.detail` (the note surfaces) plus the
  // workspace capability, so a member never fills in a title only to be
  // rejected at the end of the call.
  channel(DESKTOP_IPC_CHANNELS.noteCreate, noteCreateInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "note.detail");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    const capabilities = await ns_source.getCapabilities(gateway.gatewayTransport, input.meta.requestId);
    if (capabilities.actionCapabilities["note.create"] !== "allowed") {
      throw new DesktopGatewayFailure("forbidden", "never");
    }
    return ns_note.createNote(gateway.gatewayTransport, input.request, input.meta.requestId);
  }, noteDetailV1Schema);

  // Removing and restoring a note are owner-only writes, gated the same way as
  // creating one: the note surfaces plus the workspace capability.
  channel(DESKTOP_IPC_CHANNELS.noteDelete, noteIdInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "note.detail");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    const capabilities = await ns_source.getCapabilities(gateway.gatewayTransport, input.meta.requestId);
    if (capabilities.actionCapabilities["note.delete"] !== "allowed") {
      throw new DesktopGatewayFailure("forbidden", "never");
    }
    return ns_note.deleteNote(gateway.gatewayTransport, input.noteId, input.meta.requestId);
  }, desktopNoteMutationResultSchema);

  channel(DESKTOP_IPC_CHANNELS.noteRestore, noteIdInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "note.detail");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    const capabilities = await ns_source.getCapabilities(gateway.gatewayTransport, input.meta.requestId);
    if (capabilities.actionCapabilities["note.restore"] !== "allowed") {
      throw new DesktopGatewayFailure("forbidden", "never");
    }
    return ns_note.restoreNote(gateway.gatewayTransport, input.noteId, input.meta.requestId);
  }, desktopNoteMutationResultSchema);

  // Reading a note's immutable version history is a read of the note surface.
  channel(DESKTOP_IPC_CHANNELS.noteVersions, noteVersionsInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "note.detail");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_note.listNoteVersions(gateway.gatewayTransport, 
      input.noteId,
      input.currentVersionId,
      input.limit ?? 50,
      input.meta.requestId,
    );
  }, desktopNoteVersionListSchema);

  // Pointing the note back at an older version is a write of its content, so it
  // carries the same capability as saving one.
  channel(DESKTOP_IPC_CHANNELS.noteVersionRestore, noteVersionRestoreInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "note.detail");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    const capabilities = await ns_source.getCapabilities(gateway.gatewayTransport, input.meta.requestId);
    if (capabilities.actionCapabilities["note.save"] !== "allowed") {
      throw new DesktopGatewayFailure("forbidden", "never");
    }
    return ns_note.restoreNoteVersion(gateway.gatewayTransport, input.noteId, input.versionId, input.baseVersionId, input.meta.requestId);
  }, desktopNoteMutationResultSchema);

  // 往笔记正文里放一张图，写的是笔记内容，所以和保存一条版本同一道能力门控。
  // 服务端的上传路由自己另有 owner 校验，这里先挡在前面，免得非 owner 走完整个
  // 上传流程才被拒。
  channel(DESKTOP_IPC_CHANNELS.noteImageUpload, noteImageUploadInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "note.detail");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    const capabilities = await ns_source.getCapabilities(gateway.gatewayTransport, input.meta.requestId);
    if (capabilities.actionCapabilities["note.save"] !== "allowed") {
      throw new DesktopGatewayFailure("forbidden", "never");
    }
    return ns_note.uploadNoteImage(gateway.gatewayTransport, input.noteId, input.request, input.meta.requestId);
  }, noteImageUploadResultV1Schema);

  ;

  channel(DESKTOP_IPC_CHANNELS.noteReflectionList, z.strictObject({ ...m1InputBase, noteId: uuidSchema, roundId: uuidSchema.optional(), before: uuidSchema.optional(), reflectionId: uuidSchema.optional() }), async (_event, _window, input) => {
    requireM2Route(contract, "note.detail");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_note.listNoteReflections(gateway.gatewayTransport, { noteId: input.noteId, roundId: input.roundId, before: input.before, reflectionId: input.reflectionId }, input.meta.requestId);
  }, noteReflectionPageV1Schema);

  channel(DESKTOP_IPC_CHANNELS.noteReflectionWrite, z.strictObject({ ...m1InputBase, noteId: uuidSchema, command: noteReflectionCommandV1Schema }), async (_event, _window, input) => {
    requireM2Route(contract, "note.detail");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_note.writeNoteReflection(gateway.gatewayTransport, input.noteId, noteReflectionCommandV1Schema.parse(input.command), input.meta.requestId);
  }, noteReflectionWriteResultV1Schema);

  channel(DESKTOP_IPC_CHANNELS.noteAnnotationList, z.strictObject({ ...m1InputBase, noteId: uuidSchema, noteVersionId: uuidSchema.optional(), before: uuidSchema.optional() }), async (_event, _window, input) => {
    requireM2Route(contract, "note.detail");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_note.listNoteAnnotations(gateway.gatewayTransport, { noteId: input.noteId, noteVersionId: input.noteVersionId, before: input.before }, input.meta.requestId);
  }, noteAnnotationPageV1Schema);

  channel(DESKTOP_IPC_CHANNELS.noteAnnotationWrite, z.strictObject({ ...m1InputBase, noteId: uuidSchema, command: noteAnnotationCommandV1Schema }), async (_event, _window, input) => {
    requireM2Route(contract, "note.detail");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_note.writeNoteAnnotation(gateway.gatewayTransport, input.noteId, noteAnnotationCommandV1Schema.parse(input.command), input.meta.requestId);
  }, noteAnnotationWriteResultV1Schema);

  channel(DESKTOP_IPC_CHANNELS.noteAnnotationStartTask, z.strictObject({ ...m1InputBase, noteId: uuidSchema, request: createNoteAnnotationTaskV1Schema }), async (_event, _window, input) => {
    requireM2Route(contract, "note.detail");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_note.startNoteAnnotationTask(gateway.gatewayTransport, input.noteId, createNoteAnnotationTaskV1Schema.parse(input.request), input.meta.requestId);
  }, noteAnnotationTaskV1Schema);

  channel(DESKTOP_IPC_CHANNELS.noteAnnotationLatestTask, z.strictObject({ ...m1InputBase, noteId: uuidSchema, query: noteAnnotationLatestTaskQueryV1Schema }), async (_event, _window, input) => {
    requireM2Route(contract, "note.detail");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_note.getLatestNoteAnnotationTask(gateway.gatewayTransport, input.noteId, noteAnnotationLatestTaskQueryV1Schema.parse(input.query), input.meta.requestId);
  }, noteAnnotationLatestTaskV1Schema);

  channel(DESKTOP_IPC_CHANNELS.noteAnnotationGetTask, z.strictObject({ ...m1InputBase, noteId: uuidSchema, taskId: uuidSchema }), async (_event, _window, input) => {
    requireM2Route(contract, "note.detail");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_note.getNoteAnnotationTask(gateway.gatewayTransport, input.noteId, input.taskId, input.meta.requestId);
  }, noteAnnotationTaskV1Schema);

  channel(DESKTOP_IPC_CHANNELS.noteOverviewList, z.strictObject({ ...m1InputBase, noteId: uuidSchema, before: uuidSchema.optional() }), async (_event, _window, input) => {
    requireM2Route(contract, "note.detail");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_note.listNoteOverviews(gateway.gatewayTransport, { noteId: input.noteId, before: input.before }, input.meta.requestId);
  }, noteOverviewPageV1Schema);

  channel(DESKTOP_IPC_CHANNELS.noteOverviewStartTask, z.strictObject({ ...m1InputBase, noteId: uuidSchema, request: createNoteOverviewTaskV1Schema }), async (_event, _window, input) => {
    requireM2Route(contract, "note.detail");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_note.startNoteOverviewTask(gateway.gatewayTransport, input.noteId, createNoteOverviewTaskV1Schema.parse(input.request), input.meta.requestId);
  }, noteOverviewTaskV1Schema);

  channel(DESKTOP_IPC_CHANNELS.noteOverviewLatestTask, z.strictObject({ ...m1InputBase, noteId: uuidSchema, query: noteOverviewLatestTaskQueryV1Schema }), async (_event, _window, input) => {
    requireM2Route(contract, "note.detail");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_note.getLatestNoteOverviewTask(gateway.gatewayTransport, input.noteId, noteOverviewLatestTaskQueryV1Schema.parse(input.query), input.meta.requestId);
  }, noteOverviewLatestTaskV1Schema);

  channel(DESKTOP_IPC_CHANNELS.noteOverviewGetTask, z.strictObject({ ...m1InputBase, noteId: uuidSchema, taskId: uuidSchema }), async (_event, _window, input) => {
    requireM2Route(contract, "note.detail");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_note.getNoteOverviewTask(gateway.gatewayTransport, input.noteId, input.taskId, input.meta.requestId);
  }, noteOverviewTaskV1Schema);
  channel(DESKTOP_IPC_CHANNELS.noteMindMapList, z.strictObject({ ...m1InputBase, noteId: uuidSchema, before: uuidSchema.optional() }), async (_event, _window, input) => {
    requireM2Route(contract, "note.detail");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_note.listNoteMindMaps(gateway.gatewayTransport, { noteId: input.noteId, before: input.before }, input.meta.requestId);
  }, noteMindMapPageV1Schema);

  channel(DESKTOP_IPC_CHANNELS.noteMindMapStartTask, z.strictObject({ ...m1InputBase, noteId: uuidSchema, request: createNoteMindMapTaskV1Schema }), async (_event, _window, input) => {
    requireM2Route(contract, "note.detail");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_note.startNoteMindMapTask(gateway.gatewayTransport, input.noteId, createNoteMindMapTaskV1Schema.parse(input.request), input.meta.requestId);
  }, noteMindMapTaskV1Schema);

  channel(DESKTOP_IPC_CHANNELS.noteMindMapLatestTask, z.strictObject({ ...m1InputBase, noteId: uuidSchema, query: noteMindMapLatestTaskQueryV1Schema }), async (_event, _window, input) => {
    requireM2Route(contract, "note.detail");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_note.getLatestNoteMindMapTask(gateway.gatewayTransport, input.noteId, noteMindMapLatestTaskQueryV1Schema.parse(input.query), input.meta.requestId);
  }, noteMindMapLatestTaskV1Schema);

  channel(DESKTOP_IPC_CHANNELS.noteMindMapGetTask, z.strictObject({ ...m1InputBase, noteId: uuidSchema, taskId: uuidSchema }), async (_event, _window, input) => {
    requireM2Route(contract, "note.detail");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_note.getNoteMindMapTask(gateway.gatewayTransport, input.noteId, input.taskId, input.meta.requestId);
  }, noteMindMapTaskV1Schema);
  channel(DESKTOP_IPC_CHANNELS.noteMindMapSource, z.strictObject({ ...m1InputBase, noteId: uuidSchema, mindMapId: uuidSchema }), async (_event, _window, input) => {
    requireM2Route(contract, "note.detail");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_note.getNoteMindMapSource(gateway.gatewayTransport, input.noteId, input.mindMapId, input.meta.requestId);
  }, noteMindMapSourceV1Schema);

  channel(DESKTOP_IPC_CHANNELS.noteRecallList, z.strictObject({ ...m1InputBase, noteId: uuidSchema, before: uuidSchema.optional() }), async (_event, _window, input) => {
    requireM2Route(contract, "note.detail");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_note.listNoteRecallRecords(gateway.gatewayTransport, { noteId: input.noteId, before: input.before }, input.meta.requestId);
  }, noteRecallPageV1Schema);

  channel(DESKTOP_IPC_CHANNELS.noteRecallStart, z.strictObject({ ...m1InputBase, noteId: uuidSchema, request: noteRecallStartInputV1Schema }), async (_event, _window, input) => {
    requireM2Route(contract, "note.detail");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_note.startNoteRecall(gateway.gatewayTransport, input.noteId, input.request, input.meta.requestId);
  }, noteRecallStartResultV1Schema);

  channel(DESKTOP_IPC_CHANNELS.noteRecallAction, z.strictObject({ ...m1InputBase, noteId: uuidSchema, recallId: uuidSchema, action: noteRecallActionV1Schema }), async (_event, _window, input) => {
    requireM2Route(contract, "note.detail");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_note.actOnNoteRecall(gateway.gatewayTransport, input.noteId, input.recallId, input.action, input.meta.requestId);
  }, noteRecallActionResultV1Schema);

  // Plan 57: note-scoped learning card. One card per note; grading runs on the
  // worker, so the renderer polls history instead of asking for a verdict here.
  channel(DESKTOP_IPC_CHANNELS.noteLearningCardGet, z.strictObject({ ...m1InputBase, noteId: uuidSchema, cardId: uuidSchema.optional() }), async (_event, _window, input) => {
    requireM2Route(contract, "note.detail");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_note.getNoteLearningCard(gateway.gatewayTransport, input.noteId, input.meta.requestId, input.cardId);
  }, z.unknown());

  channel(DESKTOP_IPC_CHANNELS.noteLearningCardGenerate, z.strictObject({ ...m1InputBase, noteId: uuidSchema, noteVersionId: uuidSchema, options: noteLearningCardGenerationOptionsV1Schema.optional() }), async (_event, _window, input) => {
    requireM2Route(contract, "note.detail");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_note.generateNoteLearningCard(gateway.gatewayTransport, input.noteId, input.noteVersionId, input.meta.requestId, { questionCount: input.options?.questionCount ?? 6 });
  }, z.unknown());

  channel(DESKTOP_IPC_CHANNELS.noteLearningCardStartAttempt, z.strictObject({ ...m1InputBase, cardId: uuidSchema }), async (_event, _window, input) => {
    requireM2Route(contract, "note.detail");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_note.startNoteLearningCardAttempt(gateway.gatewayTransport, input.cardId, input.meta.requestId);
  }, z.unknown());

  channel(DESKTOP_IPC_CHANNELS.noteLearningCardAnswer, z.strictObject({ ...m1InputBase, cardId: uuidSchema, attemptId: uuidSchema, questionId: uuidSchema, answer: z.unknown(), usedHint: z.boolean().optional() }), async (_event, _window, input) => {
    requireM2Route(contract, "note.detail");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_note.answerNoteLearningCard(gateway.gatewayTransport, { ...input, answer: input.answer ?? null }, input.meta.requestId);
  }, z.unknown());

  channel(DESKTOP_IPC_CHANNELS.noteLearningCardComplete, z.strictObject({ ...m1InputBase, cardId: uuidSchema, attemptId: uuidSchema, summaryOnly: z.boolean().optional() }), async (_event, _window, input) => {
    requireM2Route(contract, "note.detail");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_note.completeNoteLearningCard(gateway.gatewayTransport, input.cardId, input.attemptId, input.meta.requestId, input.summaryOnly);
  }, z.unknown());

  channel(DESKTOP_IPC_CHANNELS.noteLearningCardHistory, z.strictObject({ ...m1InputBase, cardId: uuidSchema }), async (_event, _window, input) => {
    requireM2Route(contract, "note.detail");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_note.listNoteLearningCardAttempts(gateway.gatewayTransport, input.cardId, input.meta.requestId);
  }, z.unknown());

  channel(DESKTOP_IPC_CHANNELS.noteExpansionList, z.strictObject({ ...m1InputBase, noteId: uuidSchema, query: noteExpansionListQueryV1Schema.optional() }), async (_event, _window, input) => {
    requireM2Route(contract, "note.detail");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_note.listNoteExpansions(gateway.gatewayTransport, input.noteId, input.query, input.meta.requestId);
  }, noteExpansionPageV1Schema);

  channel(DESKTOP_IPC_CHANNELS.noteExpansionStartTask, z.strictObject({ ...m1InputBase, noteId: uuidSchema, request: createNoteExpansionTaskV1Schema }), async (_event, _window, input) => {
    requireM2Route(contract, "note.detail");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_note.startNoteExpansionTask(gateway.gatewayTransport, input.noteId, input.request, input.meta.requestId);
  }, noteExpansionTaskV1Schema);

  channel(DESKTOP_IPC_CHANNELS.noteExpansionLatestTask, z.strictObject({ ...m1InputBase, noteId: uuidSchema, query: noteExpansionLatestTaskQueryV1Schema }), async (_event, _window, input) => {
    requireM2Route(contract, "note.detail");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_note.latestNoteExpansionTask(gateway.gatewayTransport, input.noteId, input.query, input.meta.requestId);
  }, noteExpansionLatestTaskV1Schema);

  channel(DESKTOP_IPC_CHANNELS.noteExpansionListTasks, z.strictObject({ ...m1InputBase, noteId: uuidSchema, query: noteExpansionTaskListQueryV1Schema }), async (_event, _window, input) => {
    requireM2Route(contract, "note.detail");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_note.listNoteExpansionTasks(gateway.gatewayTransport, input.noteId, input.query, input.meta.requestId);
  }, noteExpansionTaskPageV1Schema);

  channel(DESKTOP_IPC_CHANNELS.noteExpansionGetTask, z.strictObject({ ...m1InputBase, noteId: uuidSchema, taskId: uuidSchema }), async (_event, _window, input) => {
    requireM2Route(contract, "note.detail");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_note.getNoteExpansionTask(gateway.gatewayTransport, input.noteId, input.taskId, input.meta.requestId);
  }, noteExpansionTaskV1Schema);

  channel(DESKTOP_IPC_CHANNELS.noteExpansionReview, z.strictObject({ ...m1InputBase, noteId: uuidSchema, taskId: uuidSchema, review: noteExpansionReviewV1Schema }), async (_event, _window, input) => {
    requireM2Route(contract, "note.detail");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_note.reviewNoteExpansionTask(gateway.gatewayTransport, input.noteId, input.taskId, input.review, input.meta.requestId);
  }, noteExpansionTaskV1Schema);

  channel(DESKTOP_IPC_CHANNELS.noteExpansionConfirm, z.strictObject({ ...m1InputBase, noteId: uuidSchema, taskId: uuidSchema, request: confirmNoteExpansionTaskV1Schema }), async (_event, _window, input) => {
    requireM2Route(contract, "note.detail");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_note.confirmNoteExpansionTask(gateway.gatewayTransport, input.noteId, input.taskId, input.request, input.meta.requestId);
  }, noteExpansionBatchWriteResultV1Schema);

  channel(DESKTOP_IPC_CHANNELS.noteLearningArtifactList, z.strictObject({ ...m1InputBase, noteId: uuidSchema, before: uuidSchema.optional() }), async (_event, _window, input) => {
    requireM2Route(contract, "note.detail");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_note.listNoteLearningArtifacts(gateway.gatewayTransport, { noteId: input.noteId, before: input.before }, input.meta.requestId);
  }, noteLearningArtifactPageV1Schema);

  channel(DESKTOP_IPC_CHANNELS.noteLearningArtifactTaskStart, z.strictObject({ ...m1InputBase, noteId: uuidSchema, request: createNoteDynamicArtifactTaskV1Schema }), async (_event, _window, input) => {
    requireM2Route(contract, "note.detail");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_note.startNoteLearningArtifactTask(gateway.gatewayTransport, input.noteId, input.request, input.meta.requestId);
  }, noteLearningArtifactTaskV1Schema);

  channel(DESKTOP_IPC_CHANNELS.noteLearningArtifactTaskList, z.strictObject({ ...m1InputBase, noteId: uuidSchema, query: noteLearningArtifactTaskListQueryV1Schema }), async (_event, _window, input) => {
    requireM2Route(contract, "note.detail");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_note.listNoteLearningArtifactTasks(gateway.gatewayTransport, input.noteId, input.query, input.meta.requestId);
  }, noteLearningArtifactTaskPageV1Schema);

  channel(DESKTOP_IPC_CHANNELS.noteLearningArtifactTaskGet, z.strictObject({ ...m1InputBase, noteId: uuidSchema, taskId: uuidSchema }), async (_event, _window, input) => {
    requireM2Route(contract, "note.detail");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_note.getNoteLearningArtifactTask(gateway.gatewayTransport, input.noteId, input.taskId, input.meta.requestId);
  }, noteLearningArtifactTaskV1Schema);

  channel(DESKTOP_IPC_CHANNELS.understandingGetTopology, runtimeInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "understanding.graph");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return gateway.getUnderstandingTopology(input.meta.requestId);
  }, understandingTopologySnapshotV3Schema);

  // 39d W8-1：星图三层展开的层二／层三。**同一个 `understanding.graph` 路由门**——
  // 三层是同一条学习路径的三个尺度，分成三个门只会让人以为"能看总览的人看不了局部"。
  channel(DESKTOP_IPC_CHANNELS.understandingGetNoteDeepening, noteDeepeningInputSchema, async (_event, _window, input) => {
      requireM2Route(contract, "understanding.graph");
      assertEpoch(input.meta, getActiveWorkspaceEpoch());
      return gateway.getUnderstandingNoteDeepening({
        noteId: input.noteId,
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      }, input.meta.requestId);
    }, noteDeepeningV3Schema);

  channel(DESKTOP_IPC_CHANNELS.searchGlobal, searchGlobalInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "search.global");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_search.searchGlobal(gateway.gatewayTransport, input.query, { type: input.type, limit: input.limit, cursor: input.cursor }, input.meta.requestId);
  }, desktopSearchPageSchema);

  installHandler(DESKTOP_IPC_CHANNELS.noteSave, noteSaveInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "note.detail");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    const capabilities = await ns_source.getCapabilities(gateway.gatewayTransport, input.meta.requestId);
    if (capabilities.actionCapabilities["note.save"] !== "allowed") {
      throw new DesktopGatewayFailure("forbidden", "never");
    }
    const request = desktopNoteSaveRequestV1Schema.parse(input.request);
    const receipt = await ns_note.saveNote(gateway.gatewayTransport, input.noteId, request, input.commandId, input.meta.requestId);
    if (getActiveWorkspaceId() && receipt.workspaceId !== getActiveWorkspaceId()) {
      throw new DesktopGatewayFailure("stale_workspace", "resync_first");
    }
    return receipt;
  }, undefined, noteSaveReceiptV1Schema);

  // ─── 笔记协同（批次 4.3 / 决定 7 的落盘部分）─────────────────────────
  channel(DESKTOP_IPC_CHANNELS.noteDocState, noteDocStateInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "note.detail");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    const cacheKey = noteDocCacheKey(input.noteId);
    const cached = cacheKey ? await noteDocCache.get(cacheKey) : null;
    // 编辑起点必须有共同祖先：用 note.detail 的 blocks 自己拼一棵文档树，与库里那份
    // 没有祖先关系，两边一改就复制块。本机那份是从服务端编码长出来的，所以先把它
    // 接回来，再让服务端这次给的起点并进去。
    if (cached) ns_note.restoreNoteDocLocal(gateway.gatewayTransport, input.noteId, cached);
    const result = await ns_note.getNoteDocState(gateway.gatewayTransport, input.noteId, input.meta.requestId);
    await persistNoteDocLocal(input.noteId);
    return result;
  }, noteDocStateResultV1Schema);

  channel(DESKTOP_IPC_CHANNELS.noteDocSyncUpdate, noteDocSyncUpdateInputSchema, async (_event, _window, input): Promise<NoteDocWriteResultV1> => {
    requireM2Route(contract, "note.detail");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    // 实时连接及时广播；保存完成仍等同一个增量的 HTTP 落盘确认。
    // provider 接收本机增量没有后续持久化回执，直接回 stream 会让「正在同步」永不结束。
    // 可写性来自服务端：只有已鉴权的可写连接才广播，HTTP 同样按真实权限给答复。
    const stream = noteDocStreams.get(input.noteId);
    if (stream?.workspaceEpoch === getActiveWorkspaceEpoch() && stream.authorizedScope === "read-write") {
      stream.handle.applyLocal(input.update);
    }
    // 出口由网关如实报：uploaded（服务端已落盘）/ unchanged（这次没改动）/
    // queued（没网，已攒在本机文档里）。
    const receipt = await ns_note.syncNoteDocUpdate(gateway.gatewayTransport, 
      input.noteId,
      input.update,
      input.meta.requestId,
    );
    // 落盘跟着这次写走：`queued` 的那几条不留在内存里过夜就又没了。
    await persistNoteDocLocal(input.noteId);
    return { via: receipt.via, revision: receipt.revision, savedAt: receipt.savedAt };
  }, noteDocWriteResultV1Schema);

  /**
   * 列表里改名。这条通道此前只有契约、preload 转发与网关实现，**主进程没有注册过
   * handler**——`ipcRenderer.invoke` 直接 reject，界面落到"重命名未确认"那句兜底，
   * 而测试用一个 `vi.fn()` 替身把它跑绿了（doc 34 L1）。
   *
   * 这里不判可写性，与 `syncUpdate` 同一条规矩：判据只在服务端那一处。列表这条路径上
   * 没有打开的文档（`noteDocStreams` 里通常没有这一篇），所以标题由网关写进本机那份的
   * `meta` 再走同一个增量口上行；`via` 由网关如实报，不在这儿改写。
   */
  channel(DESKTOP_IPC_CHANNELS.noteDocSyncTitle, noteDocSyncTitleInputSchema, async (_event, _window, input): Promise<NoteDocWriteResultV1> => {
    requireM2Route(contract, "note.detail");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    const receipt = await ns_note.syncNoteDocTitle(gateway.gatewayTransport, 
      input.noteId,
      input.title,
      input.titleSource,
      input.meta.requestId,
    );
    // 与正文同一条落盘口径：改名同样可能停在 `queued`，不留在内存里过夜就又没了。
    await persistNoteDocLocal(input.noteId);
    return { via: receipt.via, revision: receipt.revision, savedAt: receipt.savedAt };
  }, noteDocWriteResultV1Schema);

  channel(DESKTOP_IPC_CHANNELS.noteSetShare, noteSetShareInputSchema, async (_event, _window, input): Promise<NoteShareScopeReceiptV1> => {
    requireM2Route(contract, "note.detail");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    // 这里不判"是不是作者"：判据只在服务端那一处。界面上的禁用只是让点下去之前就知道
    // 结果，不是权限。
    return await ns_note.setNoteShareScope(gateway.gatewayTransport, input.noteId, input.shareScope, input.meta.requestId);
  }, noteShareScopeReceiptV1Schema);

  channel(DESKTOP_IPC_CHANNELS.noteDocPresence, noteDocPresenceInputSchema, (_event, _window, input) => {
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    // 先记下，再看有没有连接可以马上交：连接的建立是异步的（见 `noteDocPresenceToReplay`），
    // 只按"此刻有没有句柄"回答就会把第一次报名字吞掉。
    noteDocPresenceToReplay.set(input.noteId, input.state);
    const stream = noteDocStreams.get(input.noteId);
    if (!stream || stream.workspaceEpoch !== getActiveWorkspaceEpoch()) return { shared: false as const };
    stream.handle.setPresence(input.state);
    return { shared: true as const };
  }, noteDocPresenceResultV1Schema);

  /**
   * 本机草稿（刷新/崩溃不丢字）。这三条**不碰 CRDT 流程**：不并文档、不上行、不改队列，
   * 只是把界面手里还没交出来的那条增量写进/读回/清掉本机那份缓存。
   *
   * 键在这里拼，界面只报 noteId：草稿与正文同一条边界——`(subjectId, workspaceId, noteId)`。
   * 少了 workspaceId，另一个空间里同名的 noteId 就能把这里的字复活过去（批次 1 立这条键
   * 要防的正是跨空间正文缝合）；少了 subjectId，同一台机器上的另一个账号就能读到别人的
   * 私有笔记草稿。身份不全时一律"不读也不写"，与 `noteDocCacheKey` 的既有口径一致。
   */
  channel(DESKTOP_IPC_CHANNELS.noteDocDraftSave, noteDocDraftSaveInputSchema, async (_event, _window, input): Promise<NoteDocDraftSaveResultV1> => {
    requireM2Route(contract, "note.detail");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    const key = noteDocCacheKey(input.noteId);
    if (!key) return { saved: false };
    // 时间取主进程这一刻：它与界面同一个钟，但"这份是什么时候留下的"不该由界面自己报
    // ——那等于让被存的一方定义自己的时间戳。
    const saved = await noteDocCache.setDraft(key, { update: input.update, savedAt: new Date().toISOString() });
    return { saved };
  }, noteDocDraftSaveResultV1Schema);

  channel(DESKTOP_IPC_CHANNELS.noteDocDraftGet, noteDocDraftNoteInputSchema, async (_event, _window, input): Promise<NoteDocDraftGetResultV1> => {
    requireM2Route(contract, "note.detail");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    const key = noteDocCacheKey(input.noteId);
    // 身份不全 = 读不到，而不是"读到某个没归属的那一份"。
    if (!key) return { draft: null };
    return { draft: await noteDocCache.getDraft(key) };
  }, noteDocDraftGetResultV1Schema);

  channel(DESKTOP_IPC_CHANNELS.noteDocDraftClear, noteDocDraftNoteInputSchema, async (_event, _window, input): Promise<NoteDocDraftClearResultV1> => {
    requireM2Route(contract, "note.detail");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    const key = noteDocCacheKey(input.noteId);
    if (!key) return { cleared: false };
    // `cleared` 如实回答"本来有没有这一份"：确认提交之后每次都会走到这里，说成 true
    // 就等于每次都宣称清掉了一份不存在的草稿。
    return { cleared: await noteDocCache.clearDraft(key) };
  }, noteDocDraftClearResultV1Schema);

}
