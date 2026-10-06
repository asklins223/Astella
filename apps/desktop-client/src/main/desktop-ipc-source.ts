import { sourceArchiveInputSchema, sourceCreateInputSchema, sourceCreateNoteInputSchema, sourceGetInputSchema, sourceImageGetInputSchema, sourceListInputSchema, sourceNotesInputSchema, sourceReparseInputSchema, sourceRestoreInputSchema, sourceUpdateInputSchema } from "./desktop-ipc-companion";
import {
  setPersonalRelationDecisionV2ResultSchema,
  setPersonalRelationDecisionV2Schema,
} from "@astella/shared/personal-relation-decision-rules-v2";
import * as ns_source from "./desktop-gateway-ns-source";
import { registerLearningChannels, shellOpenExternalInputSchema, windowThemeInputSchema, subscribeInputSchema, unsubscribeInputSchema, titlebarThemeOutputSchema, focusOutputSchema, subscriptionOutputSchema, closedSubscriptionOutputSchema, activityGetTodayInputSchema, statsGetOverviewAllInputSchema, assessmentDisputeGetInputSchema, assessmentDisputeOpenInputSchema, assessmentDisputeSupplementInputSchema, assessmentDisputeCloseInputSchema, assessmentDisputeSupplementResultV2Schema, noteIdInputSchema, noteLearningRoundOpenInputSchema, noteLearningRoundCreateInputSchema, noteLearningRoundReviseInputSchema, noteLearningRoundPersonalHistoryInputSchema, noteLearningRoundHistoryInputSchema, noteLearningRoundRouteInputSchema, noteLearningRoundTeachingInputSchema, noteLearningRoundPreparePracticeInputSchema, noteLearningRoundExplainInputSchema, artifactEnsureInputSchema, artifactEnsureResultSchema, noteLearningRoundCloseInputSchema, noteLearningRoundReopenInputSchema, noteLearningRoundResumeInputSchema, setPersonalRelationDecisionInputSchema, noteDeepeningInputSchema, searchGlobalInputSchema, noteSaveInputSchema, noteDocStateInputSchema, noteDocSyncUpdateInputSchema, noteDocSyncTitleInputSchema, noteSetShareInputSchema, noteDocPresenceInputSchema, noteDocDraftSaveInputSchema, noteDocDraftNoteInputSchema, cardGenerationStartInputSchema, cardGenerationGetRunInputSchema, cardGenerationGetCandidatesInputSchema, cardGenerationReviewInputSchema, cardGenerationRevealInputSchema, cardGenerationExposureInputSchema, cardGenerationActivateInputSchema, cardGenerationCancelInputSchema, cardGenerationRetryInputSchema, cardGenerationCloseInputSchema } from "./desktop-ipc-learning";
import { registerAuthChannels } from "./desktop-ipc-auth";
import { registerWorkspaceChannels, authUpdateProfileInputSchema, authAvatarUploadInputSchema, authAvatarGetInputSchema, authLeaveWorkspaceInputSchema, inviteCreateInputSchema, inviteRevokeInputSchema, memberRemoveInputSchema, revokeOutputSchema, memberRemoveOutputSchema } from "./desktop-ipc-workspace";
import * as ns_note from "./desktop-gateway-ns-note";
import * as ns_companion from "./desktop-gateway-ns-companion";
import * as ns_learning from "./desktop-gateway-ns-learning";
import * as ns_workspace from "./desktop-gateway-ns-workspace";
import * as ns_auth from "./desktop-gateway-ns-auth";
import * as ns_runtime from "./desktop-gateway-ns-runtime";
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
} from "@astella/shared/note-expansion-contracts";
import {
  createNoteDynamicArtifactTaskV1Schema,
  noteLearningArtifactPageV1Schema,
  noteLearningArtifactTaskListQueryV1Schema,
  noteLearningArtifactTaskPageV1Schema,
  noteLearningArtifactTaskV1Schema,
} from "@astella/shared/note-learning-artifact-contracts";
import { BrowserWindow, clipboard, dialog, ipcMain, shell, type IpcMainInvokeEvent, type WebContents } from "electron";
import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rename, rm, stat, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import {
  DESKTOP_API_SERVICE_ID,
  DESKTOP_IPC_CHANNELS,
  DESKTOP_IPC_CONTRACT_VERSION,
  DESKTOP_IPC_SCHEMA_REVISION,
  type ActionCapability,
  apiHealthSnapshotSchema,
  apiConnectionStateSchema,
  authSurfaceManifestResultV1Schema,
  capabilityProjectionSchema,
  companionBridgeStateV1Schema,
  clipboardReadLinksResultSchema,
  isWebLinkUrl,
  shellOpenExternalRequestV1Schema,
  shellOpenExternalResultV1Schema,
  desktopContractSnapshotSchema,
  desktopNamespaceM2Values,
  desktopRouteKindM2Values,
  desktopRouteSchema,
  extractCandidateLinks,
  gatewayEventSchema,
  navigationSnapshotSchema,
  sessionContextSchema,
  workspaceContextSchema,
  workspaceSummarySchema,
  type AstellaDesktopApiM2,
  type ApiHealthSnapshotV1,
  type DesktopContractSnapshotV1,
  type DesktopRouteV1,
  type GatewayErrorCode,
  type GatewayEventPayloadM2,
  type GatewayEventV1,
  type GatewayResultV1,
  type NavigationEntryV1,
  type NavigationSnapshotV1,
  type RequestMetaV1,
  type SessionContextV1,
  type SubscriptionTopicM2,
  type WindowStateSnapshotV1,
  desktopCreateLearningRunV2RequestSchema,
  desktopCreateCardGenerationRunRequestV2Schema,
  desktopCandidateReviewRequestV2Schema,
  desktopRevealCandidateRequestV2Schema,
  desktopCardGenerationActivationSelectionV1Schema,
  desktopLearningRunAbandonRequestV2Schema,
  desktopLearningRunActionRequestV2Schema,
  desktopPutLearningTaskDraftV2RequestSchema,
  desktopRecordLearningRunActivityLeaseRequestV2Schema,
  recordLearningRunActivityLeaseOutputV2Schema,
  desktopSubmitTaskArtifactV2Schema,
  desktopNoteSaveRequestV1Schema,
  commandIdSchema,
  emailSchema,
  gatewayErrorSchema,
  inviteTokenSchema,
  isoTimestampSchema,
  navigationReasonSchema,
  newPasswordSchema,
  requestIdSchema,
  requestMetaSchema,
  runtimeSnapshotSchema,
  secretInputSchema,
  subscriptionIdSchema,
  subscriptionTopicM2Schema,
  positiveIntSchema,
  uuidSchema,
  windowStateSnapshotV1Schema,
  aiDataPolicyV1Schema,
  workspaceAiSettingsV1Schema,
  workspaceExportResultV1Schema,
  // 旧版设置页回补（2026-09-18）。
  AVATAR_MAX_BYTES,
  authProfileResultV1Schema,
  avatarObjectKeySchema,
  avatarUploadResultV1Schema,
  inviteCreatedV1Schema,
  inviteListResultV1Schema,
  memberListResultV1Schema,
  NOTE_DOC_BLOCKS_MAX_COUNT,
  noteDocStateResultV1Schema,
  noteDocWriteResultV1Schema,
  noteDocPresenceResultV1Schema,
  noteDocDraftSaveResultV1Schema,
  noteDocDraftGetResultV1Schema,
  noteDocDraftClearResultV1Schema,
  type NoteDocDraftSaveResultV1,
  type NoteDocDraftGetResultV1,
  type NoteDocDraftClearResultV1,
  type NoteDocWriteResultV1,
  renameWorkspaceResultV1Schema,
  dissolvePreviewResultV1Schema,
  dissolveWorkspaceResultV1Schema,
  transferWorkspaceOwnershipResultV1Schema,
  createWorkspaceResultV1Schema,
  searchDriftResultV1Schema,
  searchReindexResultV1Schema,
  type DesktopRouteKindM2,
  NOTE_DOC_UPDATE_MAX_CHARS,
} from "@astella/shared/desktop-ipc-contracts";
import {
  NOTE_DOC_PRESENCE_MAX_CHARS,
  type NoteDocWatchHandle,
} from "./note-doc-transport.ts";
import { mainPageContextInputV2Schema } from "@astella/shared/companion-bridge-contracts";
import {
  desktopSourceListPageSchema,
  desktopSourceCreateRequestSchema,
  desktopSourceDetailSchema,
  desktopSourceNotesPageSchema,
  desktopSourceUpdateRequestSchema,
  desktopSourceNoteResultSchema,
  desktopSourceCreateResultV1Schema,
  desktopSourceArchiveResultSchema,
  desktopSourceRestoreResultSchema,
  desktopSourceReparseResultSchema,
  desktopAiAuditPageV1Schema,
  desktopNoteListPageSchema,
  desktopNoteCreateRequestSchema,
  desktopNoteMutationResultSchema,
  desktopNoteVersionListSchema,
  desktopSearchPageSchema,
} from "@astella/shared/desktop-surface-contracts";
import { objectiveListPageV3Schema, learningObjectiveSurfaceV3Schema } from "@astella/shared/learning-objective-surface-contracts";
import {
  noteLearningRoundHistoryPageV1Schema,
  noteLearningRoundPersonalHistoryPageV1Schema,
  noteLearningRoundV1Schema,
  noteLearningRoundViewV1Schema,
  ROUND_HISTORY_MAX_LIMIT_V1,
  roundDrivingQuestionSourceV1Schema,
  roundTeachingViewV1Schema,
} from "@astella/shared/note-learning-round-contracts";
import { noteRouteCoverageV1Schema } from "@astella/shared/note-route-coverage-v2";
import {
  recordRecallSourceRevealRequestV1Schema,
  recordRecallSourceRevealResultV1Schema,
} from "@astella/shared/recall-waiting-v2-contracts";
import { understandingTopologySnapshotV3Schema } from "@astella/shared/note-deepening-contracts";
import { noteDeepeningV3Schema } from "@astella/shared/note-deepening-v3-contracts";
import { todayActivityV1Schema } from "@astella/shared/activity-surface-contracts";
import { allWorkspacesStatsOverviewSchema } from "@astella/shared/stats-overview-contracts";
import {
  getLearningRunResultResponseV2Schema,
  learningRunTargetRevealV2Schema,
  learningRunActionResponseV2Schema,
  learningRunPublicSnapshotV2Schema,
  learningRunReturnContractV2Schema,
  learningTaskDraftV2Schema,
  learningTaskDraftWriteReceiptV2Schema,
  submitTaskArtifactReceiptV2Schema,
} from "@astella/shared/learning-run-v2-contracts";
import { reviewDeferRequestV2Schema, reviewDeferResultV2Schema, reviewQueueV2Schema } from "@astella/shared/review-queue-v2-contracts";
import {
  noteReviewSubscriptionsV2Schema,
  homeSuggestionWireV2Schema,
  homeSuggestionActionCommandV2Schema,
  homeSuggestionActionResultV2Schema,
  todayBatchOptionCommandV2Schema,
  todayBatchOptionResultV2Schema,
  objectiveHoldCommandV2Schema,
  objectiveHoldResultV2Schema,
  objectiveResumeCommandV2Schema,
  objectiveResumeResultV2Schema,
  reviewSubscriptionCommandV2Schema,
  reviewSubscriptionResultV2Schema,
} from "@astella/shared/review-queue-v2-contracts";
import {
  openAssessmentDisputeCommandV2Schema,
  openAssessmentDisputeResultV2Schema,
  closeAssessmentDisputeCommandV2Schema,
  closeAssessmentDisputeResultV2Schema,
  supplementAssessmentDisputeCommandV2Schema,
  assessmentDisputeEnvelopeV2Schema,
} from "@astella/shared/assessment-dispute-rules-v2";
import { roomProjectionV1Schema } from "@astella/shared/room-projection-contracts";
import {
  companionAccountPatchSchema,
  companionAccountStateV1Schema,
  companionAnswerModePreferenceV1Schema,
  companionVoicePreferenceV1Schema,
  companionOverviewSchema,
  onboardingTransitionRequestSchema,
  onboardingTransitionResponseSchema,
} from "@astella/shared/companion-shell-contracts";
import { ttsEngineV1Schema } from "@astella/shared/tts-voice-catalog";
import {
  companionHomeProjectionV1Schema,
  companionRoomProfilePatchV1Schema,
  companionRoomProfileV1Schema,
} from "@astella/shared/companion-home-contracts";
import {
  companionVoiceSpeakRequestV1Schema,
  companionVoiceSpeakResultV1Schema,
  companionVoiceSpeakSegmentRequestV2Schema,
  companionVoicePlaybackOutcomeRequestV1Schema,
  companionVoicePlaybackOutcomeResultV1Schema,
} from "@astella/shared/companion-voice-contracts";
import {
  companionChatEnsureRequestV1Schema,
  companionChatEnsureResultV1Schema,
  companionChatListMessagesRequestV1Schema,
  companionChatListMessagesResultV1Schema,
  companionChatSendTurnRequestV1Schema,
  companionChatSendTurnResultV1Schema,
  companionChatProposalGetRequestV1Schema,
  companionChatProposalGetResultV1Schema,
  companionChatProposalDecideRequestV1Schema,
  companionChatProposalDecideResultV1Schema,
  companionAgentRoutesListRequestV1Schema,
  companionAgentRoutesListResultV1Schema,
  companionChatOpenThoughtRequestV1Schema,
  companionChatOpenThoughtResultV1Schema,
  companionChatCancelRunRequestV1Schema,
  companionChatCancelRunResultV1Schema,
  companionRunNodesListRequestV1Schema,
  companionRunNodesListResultV1Schema,
} from "@astella/shared/companion-chat-desktop-contracts";
import {
  companionGroundedTutorGrantV1Schema,
  companionLearningContextV1Schema,
  companionLearningRunContextV1Schema,
  createCompanionLearningRunContextGrantRequestV1Schema,
} from "@astella/shared/companion-conversation-contracts";
import {
  sourceImageGetRequestV1Schema,
  sourceImageGetResultV1Schema,
} from "@astella/shared/source-image-contracts";
import {
  noteImageUploadRequestV1Schema,
  noteImageUploadResultV1Schema,
} from "@astella/shared/note-image-upload-contracts";
import {
  companionDailyDateV1Schema,
  companionDailyMonthValueV1Schema,
  companionDailySummaryV1Schema,
  companionDailyMonthV1Schema,
  companionActivityAckRequestV1Schema,
  companionActivityDeliveryV1Schema,
  companionActivityTimelineV1Schema,
  companionAuditDeleteResultV1Schema,
  companionExportKindV1Schema,
  companionExportResultV1Schema,
  companionHistoryClearResultV1Schema,
  companionHistoryPageV1Schema,
  companionHistoryQueryV1Schema,
  companionHistorySearchQueryV1Schema,
  companionHistorySearchV1Schema,
  companionMemoryItemV1Schema,
  companionMemoryClearResultV1Schema,
  companionMemoryConflictListV1Schema,
  companionMemoryConflictResolveResultV1Schema,
  companionMemoryCreateInputV1Schema,
  companionMemoryCorrectInputV1Schema,
  companionMemoryListQuerySchema,
  companionMemoryListV1Schema,
  companionMemoryQueueResultV1Schema,
  companionMemoryStarMapV2Schema,
  companionPersonaMutationV1Schema,
  companionPersonaPatchV1Schema,
  companionPersonaResetV1Schema,
  companionPersonaV1Schema,
} from "@astella/shared/companion-memory-desktop-contracts";
import {
  companionInvitationActionRequestSchema,
  companionInvitationSchema,
  companionJourneyActionRequestSchema,
  companionJourneyBootstrapSchema,
  companionJourneySchema,
} from "@astella/shared/companion-journey-contracts";
import { noteDetailV1Schema } from "@astella/shared/note-projection-contracts";
import { noteSaveReceiptV1Schema } from "@astella/shared/note-save-contracts";
import { noteShareScopeReceiptV1Schema, noteShareScopeValuesV1, type NoteShareScopeReceiptV1 } from "@astella/shared/note-share-contracts";
import {
  cardActivationReceiptDesktopV1Schema,
  cardGenerationCandidateListV1Schema,
  cardGenerationCancelResultV1Schema,
  cardGenerationRetryResultV1Schema,
  cardGenerationCloseResultV1Schema,
  cardGenerationExposureEligibilityV1Schema,
  cardGenerationJobAcceptedV1Schema,
  cardGenerationReviewResultV1Schema,
  cardGenerationRunSnapshotV1Schema,
} from "@astella/shared/card-generation-desktop-contracts";
import { candidateRevealV2Schema } from "@astella/shared/card-generation-v2-contracts";
import { DesktopGateway } from "./desktop-gateway";
import * as ns_assessment from "./desktop-gateway-ns-assessment";
import * as ns_search from "./desktop-gateway-ns-search";
import * as ns_invite from "./desktop-gateway-ns-invite";
import * as ns_home from "./desktop-gateway-ns-home";
import * as ns_artifact from "./desktop-gateway-ns-artifact";
import type { SessionCredentialStore } from "./desktop-gateway-credentials";
import { DesktopGatewayFailure } from "./desktop-gateway-failure";
import { createSessionCredentialStore } from "./session-credential-store";
import { FormalAssessmentGuard, type CompanionDeliveryKind } from "./formal-assessment-guard";
import { matchesLearningRunReturnRoute, recoverPendingReturnMarker, resolveLearningRunReturn, routeForLearningRunReturn } from "./learning-run-return-resolver";
import { MemoryPendingReturnMarkerStore, type PendingReturnMarkerStore } from "./pending-return-marker-store";
import {
  MemoryNoteDocCacheStore,
  type NoteDocCacheEntryV1,
  type NoteDocCacheKey,
  type NoteDocCacheStore,
} from "./note-doc-cache-store.ts";
import { ensureArtifactStored } from "./artifact-store";
import type { WindowStateSnapshot } from "../shared/window-state";
import type { GatewayTransport } from "./desktop-gateway-transport";
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
  ns_source: typeof import("./desktop-gateway-ns-source");
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
export const noteGetInputSchema = z.strictObject({ ...m1InputBase, noteId: uuidSchema });
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

channel(DESKTOP_IPC_CHANNELS.artifactEnsure, artifactEnsureInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "note.detail");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    // 落盘失败一律如实上抛（`ArtifactStoreFailure` 是网关失败的子类，`mapFailure` 会带着
    // `code` 翻出去）：回一个 `stored:false` 会让界面把"没落下来"读成"已经在了"。
    const ensured = await ensureArtifactStored(
      { artifactId: input.artifactId, requestId: input.meta.requestId },
      {
        userDataDir: artifactUserDataDir(),
        fetchArtifactHtml: (artifactId, requestId) => input.origin === "note_learning"
          ? ns_artifact.getNoteLearningArtifactHtml(gateway.gatewayTransport, artifactId, requestId)
          : ns_artifact.getNoteLearningRoundArtifactHtml(gateway.gatewayTransport, artifactId, requestId),
      },
    );
    return { stored: ensured.stored };
  }, artifactEnsureResultSchema)
}
