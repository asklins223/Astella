import {
  setPersonalRelationDecisionV2ResultSchema,
  setPersonalRelationDecisionV2Schema,
} from "@ailearn/shared/personal-relation-decision-rules-v2";
import * as ns_source from "./desktop-gateway-ns-source";
import { registerAuthChannels } from "./desktop-ipc-auth";
import { registerWorkspaceChannels, authUpdateProfileInputSchema, authAvatarUploadInputSchema, authAvatarGetInputSchema, authLeaveWorkspaceInputSchema, inviteCreateInputSchema, inviteRevokeInputSchema, memberRemoveInputSchema, revokeOutputSchema, memberRemoveOutputSchema } from "./desktop-ipc-workspace";
import * as ns_note from "./desktop-gateway-ns-note";
import * as ns_companion from "./desktop-gateway-ns-companion";
import * as ns_learning from "./desktop-gateway-ns-learning";
import * as ns_workspace from "./desktop-gateway-ns-workspace";
import * as ns_auth from "./desktop-gateway-ns-auth";
import * as ns_runtime from "./desktop-gateway-ns-runtime";
import { noteReflectionPageV1Schema, noteReflectionCommandV1Schema, noteReflectionWriteResultV1Schema } from "@ailearn/shared/note-learning-reflection-contracts";
import { noteAnnotationPageV1Schema, noteAnnotationCommandV1Schema, noteAnnotationWriteResultV1Schema, createNoteAnnotationTaskV1Schema, noteAnnotationLatestTaskQueryV1Schema, noteAnnotationLatestTaskV1Schema, noteAnnotationTaskV1Schema } from "@ailearn/shared/note-annotation-contracts";
import {
  createNoteOverviewTaskV1Schema,
  noteOverviewLatestTaskQueryV1Schema,
  noteOverviewLatestTaskV1Schema,
  noteOverviewPageV1Schema,
  noteOverviewTaskV1Schema,
} from "@ailearn/shared/note-overview-contracts";
import { noteRecallActionV1Schema, noteRecallActionResultV1Schema, noteRecallPageV1Schema, noteRecallStartInputV1Schema, noteRecallStartResultV1Schema } from "@ailearn/shared/note-recall-contracts";
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
} from "@ailearn/shared/note-expansion-contracts";
import {
  createNoteDynamicArtifactTaskV1Schema,
  noteLearningArtifactPageV1Schema,
  noteLearningArtifactTaskListQueryV1Schema,
  noteLearningArtifactTaskPageV1Schema,
  noteLearningArtifactTaskV1Schema,
} from "@ailearn/shared/note-learning-artifact-contracts";
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
  type AILearnDesktopApiM2,
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
} from "@ailearn/shared/desktop-ipc-contracts";
import {
  NOTE_DOC_PRESENCE_MAX_CHARS,
  type NoteDocWatchHandle,
} from "./note-doc-transport.ts";
import { mainPageContextInputV2Schema } from "@ailearn/shared/companion-bridge-contracts";
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
} from "@ailearn/shared/desktop-surface-contracts";
import { objectiveListPageV3Schema, learningObjectiveSurfaceV3Schema } from "@ailearn/shared/learning-objective-surface-contracts";
import {
  noteLearningRoundHistoryPageV1Schema,
  noteLearningRoundPersonalHistoryPageV1Schema,
  noteLearningRoundV1Schema,
  noteLearningRoundViewV1Schema,
  ROUND_HISTORY_MAX_LIMIT_V1,
  roundDrivingQuestionSourceV1Schema,
  roundTeachingViewV1Schema,
} from "@ailearn/shared/note-learning-round-contracts";
import { noteRouteCoverageV1Schema } from "@ailearn/shared/note-route-coverage-v2";
import {
  recordRecallSourceRevealRequestV1Schema,
  recordRecallSourceRevealResultV1Schema,
} from "@ailearn/shared/recall-waiting-v2-contracts";
import { understandingTopologySnapshotV3Schema } from "@ailearn/shared/note-deepening-contracts";
import { noteDeepeningV3Schema } from "@ailearn/shared/note-deepening-v3-contracts";
import { todayActivityV1Schema } from "@ailearn/shared/activity-surface-contracts";
import { allWorkspacesStatsOverviewSchema } from "@ailearn/shared/stats-overview-contracts";
import {
  getLearningRunResultResponseV2Schema,
  learningRunTargetRevealV2Schema,
  learningRunActionResponseV2Schema,
  learningRunPublicSnapshotV2Schema,
  learningRunReturnContractV2Schema,
  learningTaskDraftV2Schema,
  learningTaskDraftWriteReceiptV2Schema,
  submitTaskArtifactReceiptV2Schema,
} from "@ailearn/shared/learning-run-v2-contracts";
import { reviewDeferRequestV2Schema, reviewDeferResultV2Schema, reviewQueueV2Schema } from "@ailearn/shared/review-queue-v2-contracts";
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
} from "@ailearn/shared/review-queue-v2-contracts";
import {
  openAssessmentDisputeCommandV2Schema,
  openAssessmentDisputeResultV2Schema,
  closeAssessmentDisputeCommandV2Schema,
  closeAssessmentDisputeResultV2Schema,
  supplementAssessmentDisputeCommandV2Schema,
  assessmentDisputeEnvelopeV2Schema,
} from "@ailearn/shared/assessment-dispute-rules-v2";
import { roomProjectionV1Schema } from "@ailearn/shared/room-projection-contracts";
import {
  companionAccountPatchSchema,
  companionAccountStateV1Schema,
  companionAnswerModePreferenceV1Schema,
  companionVoicePreferenceV1Schema,
  companionOverviewSchema,
  onboardingTransitionRequestSchema,
  onboardingTransitionResponseSchema,
} from "@ailearn/shared/companion-shell-contracts";
import { ttsEngineV1Schema } from "@ailearn/shared/tts-voice-catalog";
import {
  companionHomeProjectionV1Schema,
  companionRoomProfilePatchV1Schema,
  companionRoomProfileV1Schema,
} from "@ailearn/shared/companion-home-contracts";
import {
  companionVoiceSpeakRequestV1Schema,
  companionVoiceSpeakResultV1Schema,
  companionVoiceSpeakSegmentRequestV2Schema,
  companionVoicePlaybackOutcomeRequestV1Schema,
  companionVoicePlaybackOutcomeResultV1Schema,
} from "@ailearn/shared/companion-voice-contracts";
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
} from "@ailearn/shared/companion-chat-desktop-contracts";
import {
  companionGroundedTutorGrantV1Schema,
  companionLearningContextV1Schema,
  companionLearningRunContextV1Schema,
  createCompanionLearningRunContextGrantRequestV1Schema,
} from "@ailearn/shared/companion-conversation-contracts";
import {
  sourceImageGetRequestV1Schema,
  sourceImageGetResultV1Schema,
} from "@ailearn/shared/source-image-contracts";
import {
  noteImageUploadRequestV1Schema,
  noteImageUploadResultV1Schema,
} from "@ailearn/shared/note-image-upload-contracts";
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
} from "@ailearn/shared/companion-memory-desktop-contracts";
import {
  companionInvitationActionRequestSchema,
  companionInvitationSchema,
  companionJourneyActionRequestSchema,
  companionJourneyBootstrapSchema,
  companionJourneySchema,
} from "@ailearn/shared/companion-journey-contracts";
import { noteDetailV1Schema } from "@ailearn/shared/note-projection-contracts";
import { noteSaveReceiptV1Schema } from "@ailearn/shared/note-save-contracts";
import { noteShareScopeReceiptV1Schema, noteShareScopeValuesV1, type NoteShareScopeReceiptV1 } from "@ailearn/shared/note-share-contracts";
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
} from "@ailearn/shared/card-generation-desktop-contracts";
import { candidateRevealV2Schema } from "@ailearn/shared/card-generation-v2-contracts";
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
export type LearningChannelDeps = {
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
  /** 自由函数模块。**别定成 `unknown`**——段内每处 `ns_learning.x` 都会变成类型错误。 */
  ns_learning: typeof import("./desktop-gateway-ns-learning");
  gateway: DesktopGateway;
  options: unknown;
  emit: (...args: unknown[]) => void;
  // ── ③ 类（`registerM1DesktopIpc` 闭包里的成员）：**原样传引用** ──
  getActiveSubjectId: () => string | null;
  setActiveSubjectId: (value: string | null) => void;
  getActiveWorkspaceId: () => string | null;
  setActiveWorkspaceId: (value: string | null) => void;
  /** ② 类：段内**有赋值**（握手后写纪元）——getter + setter **一对**。 */
  getActiveWorkspaceEpoch: () => number;
  setActiveWorkspaceEpoch: (value: number) => void;
  assertEpochBoundaryExempt: (meta: RequestMetaV1, activeWorkspaceEpoch: number) => void;
  safeWorkspaceEpoch: (value: unknown) => number | undefined;
  formalAssessmentGuard: FormalAssessmentGuard;
  pendingReturnMarkerStore: PendingReturnMarkerStore;
  noteDocCache: NoteDocCacheStore;
  recoverPersistedReturnMarker: (requestId?: string) => Promise<unknown>;
  rememberSession: (session: SessionContextV1) => void;
  startCompanionLifecycle: (workspaceEpoch: number) => Promise<void>;
  stopCompanionLifecycle: () => void;
  stopCompanionChatStreams: () => void;
  stopLearningRunStreams: () => void;
  stopCardGenerationStreams: () => void;
  trackedLearningRunIds: Set<string>;
  trackedCardGenerationRunIds: Set<string>;
  clearSubscriptionsForWindow: (window: BrowserWindow) => void;
  // ── 这一族特有的五个（也是闭包函数）──
  trackLearningRun: (runId: string) => void;
  maybeInjectPackagedLearningRunResponseLoss: (operation: "draft" | "submit" | "action") => void;
  resolveReturnContract: (contractValue: unknown) => Promise<void>;
  syncFormalGuard: (snapshot: unknown) => void;
  syncFormalGuardFromResult: (value: unknown) => void;
};


/** 这一族专属的入参 / 出参 schema。 */
export const shellOpenExternalInputSchema = z.strictObject({
  ...m1InputBase,
  request: shellOpenExternalRequestV1Schema,
});
export const windowThemeInputSchema = z.strictObject({ ...m1InputBase, theme: z.enum(["day", "night"]) });
export const subscribeInputSchema = z.strictObject({ ...m1InputBase, topic: subscriptionTopicM2Schema });
export const unsubscribeInputSchema = z.strictObject({ ...m1InputBase, subscriptionId: subscriptionIdSchema });
export const titlebarThemeOutputSchema = z.strictObject({ applied: z.literal(true) });
export const focusOutputSchema = z.strictObject({ focused: z.literal(true) });
export const subscriptionOutputSchema = z.strictObject({ subscriptionId: subscriptionIdSchema });
export const closedSubscriptionOutputSchema = z.strictObject({ closed: z.literal(true) });
const reviewQueueInputSchema = z.strictObject({ ...m1InputBase, cursor: z.string().min(1).max(128).optional(), limit: z.number().int().min(1).max(100).optional() });
export const activityGetTodayInputSchema = z.strictObject({
  ...m1InputBase,
  from: isoTimestampSchema.optional(),
  to: isoTimestampSchema.optional(),
});
export const statsGetOverviewAllInputSchema = z.strictObject(m1InputBase);
const reviewDeferInputSchema = z.strictObject({ ...m1InputBase, request: reviewDeferRequestV2Schema });
const reviewHoldObjectiveInputSchema = z.strictObject({ ...m1InputBase, request: objectiveHoldCommandV2Schema });
const reviewResumeObjectiveInputSchema = z.strictObject({ ...m1InputBase, request: objectiveResumeCommandV2Schema });
const reviewSubscriptionInputSchema = z.strictObject({ ...m1InputBase, request: reviewSubscriptionCommandV2Schema });
export const assessmentDisputeGetInputSchema = z.strictObject({ ...m1InputBase, assessmentId: uuidSchema });
export const assessmentDisputeOpenInputSchema = z.strictObject({ ...m1InputBase, request: openAssessmentDisputeCommandV2Schema });
export const assessmentDisputeSupplementInputSchema = z.strictObject({ ...m1InputBase, request: supplementAssessmentDisputeCommandV2Schema });
export const assessmentDisputeCloseInputSchema = z.strictObject({ ...m1InputBase, request: closeAssessmentDisputeCommandV2Schema });
export const assessmentDisputeSupplementResultV2Schema = z.strictObject({ accepted: z.literal(true) });
export const noteIdInputSchema = z.strictObject({ ...m1InputBase, noteId: uuidSchema });
const objectiveListInputSchema = z.strictObject({ ...m1InputBase, cursor: z.string().min(1).max(128).optional(), limit: z.number().int().min(1).max(100).optional(), lifecycle: z.enum(["active", "archived", "superseded"]).optional(), noteId: uuidSchema.optional() });
export const noteLearningRoundOpenInputSchema = z.strictObject({ ...m1InputBase, noteId: uuidSchema });
export const noteLearningRoundCreateInputSchema = z.strictObject({
  ...m1InputBase,
  noteId: uuidSchema,
  drivingQuestion: z.string().trim().min(1).max(500).optional(),
  drivingQuestionSource: roundDrivingQuestionSourceV1Schema,
});
export const noteLearningRoundReviseInputSchema = z.strictObject({
  ...m1InputBase,
  roundId: uuidSchema,
  expectedRevision: z.number().int().min(1),
  drivingQuestion: z.string().trim().min(1).max(500),
  drivingQuestionSource: roundDrivingQuestionSourceV1Schema,
});
export const noteLearningRoundPersonalHistoryInputSchema = z.strictObject({
  ...m1InputBase,
  // 与按笔记那一条唯一的差别就是没有 noteId：这一页读的是"我"的所有轮次。
  limit: z.number().int().min(1).max(ROUND_HISTORY_MAX_LIMIT_V1).optional(),
  before: uuidSchema.optional(),
});
export const noteLearningRoundHistoryInputSchema = z.strictObject({
  ...m1InputBase,
  noteId: uuidSchema,
  // 上限在服务端合同那一格（同一个数），这里只做"坏值不往上传"。
  limit: z.number().int().min(1).max(ROUND_HISTORY_MAX_LIMIT_V1).optional(),
  before: uuidSchema.optional(),
});
const recordRecallSourceRevealInputSchema = z.strictObject({
  ...m1InputBase,
  ...recordRecallSourceRevealRequestV1Schema.shape,
});
export const noteLearningRoundRouteInputSchema = z.strictObject({
  ...m1InputBase,
  noteId: uuidSchema,
});
export const noteLearningRoundTeachingInputSchema = z.strictObject({ ...m1InputBase, roundId: uuidSchema });
export const noteLearningRoundPreparePracticeInputSchema = z.strictObject({
  ...m1InputBase, roundId: uuidSchema, expectedRevision: z.number().int().min(1),
});
export const noteLearningRoundExplainInputSchema = z.strictObject({
  ...m1InputBase,
  roundId: uuidSchema,
  expectedRevision: z.number().int().min(1),
  /** 「换一种解释」（W4-6 刀四）：跳过复用、同一问题落第二条。 */
  regenerate: z.boolean().optional(),
  personalReflectionIds: z.array(uuidSchema).max(3).optional()
    .refine((ids) => ids === undefined || new Set(ids).size === ids.length, "private source ids must be unique"),
});
export const artifactEnsureInputSchema = z.strictObject({ ...m1InputBase, artifactId: uuidSchema, origin: z.enum(["round", "note_learning"]).default("round") });
export const artifactEnsureResultSchema = z.strictObject({
  stored: z.boolean(),
});
export const noteLearningRoundCloseInputSchema = z.strictObject({
  ...m1InputBase,
  roundId: uuidSchema,
  expectedRevision: z.number().int().min(1),
  // UI 上只有两种收尾：走完了 / 先到这里。system_failure 与 superseded 是服务端
  // 与"内容变了新开一轮"那两刀才会写的，不由这张表填。
  outcome: z.enum(["completed", "partial"]),
});
export const noteLearningRoundReopenInputSchema = z.strictObject({
  ...m1InputBase,
  roundId: uuidSchema,
  expectedRevision: z.number().int().min(1),
});
export const noteLearningRoundResumeInputSchema = z.strictObject({
  ...m1InputBase,
  roundId: uuidSchema,
  expectedRevision: z.number().int().min(1),
});
const objectiveGetInputSchema = z.strictObject({ ...m1InputBase, objectiveId: uuidSchema });
export const setPersonalRelationDecisionInputSchema = z.strictObject({
  ...m1InputBase,
  fromObjectiveId: uuidSchema,
  toObjectiveId: uuidSchema,
  relation: setPersonalRelationDecisionV2Schema.shape.relation,
  decision: setPersonalRelationDecisionV2Schema.shape.decision,
  noteId: setPersonalRelationDecisionV2Schema.shape.noteId,
});
export const noteDeepeningInputSchema = z.strictObject({
  ...m1InputBase,
  noteId: uuidSchema,
  limit: z.number().int().min(1).max(500).optional(),
});
export const searchGlobalInputSchema = z.strictObject({ ...m1InputBase, query: z.string().trim().min(1).max(500), type: z.enum(["note", "source", "objective"]).optional(), limit: z.number().int().min(1).max(50).optional(), cursor: z.string().min(1).max(512).optional() });
export const noteSaveInputSchema = z.strictObject({
  ...m1InputBase,
  commandId: commandIdSchema,
  noteId: uuidSchema,
  request: desktopNoteSaveRequestV1Schema,
});
export const noteDocStateInputSchema = z.strictObject({
  ...m1InputBase,
  noteId: uuidSchema,
});
export const noteDocSyncUpdateInputSchema = z.strictObject({
  ...m1InputBase,
  commandId: commandIdSchema,
  noteId: uuidSchema,
  // 本机文档产生的 yjs 增量（base64）。上限与下行帧同一处定义：两边各写一个数，
  // 迟早一边放行一边拒收。空增量界面就不该发（主进程仍会如实回 `unchanged`）。
  update: z.string().min(1).max(NOTE_DOC_UPDATE_MAX_CHARS),
});
export const noteDocSyncTitleInputSchema = z.strictObject({
  ...m1InputBase,
  commandId: commandIdSchema,
  noteId: uuidSchema,
  // 与 `note.save` 那条同一个上限：标题只有一个来源长度，两侧各写一个数迟早一边
  // 放行一边拒收。空标题由界面自己挡在发起之前，这里仍按 min(1) 收口。
  title: z.string().min(1).max(200),
  titleSource: z.enum(["manual", "auto"]),
});
export const noteSetShareInputSchema = z.strictObject({
  ...m1InputBase,
  commandId: commandIdSchema,
  noteId: uuidSchema,
  shareScope: z.enum(noteShareScopeValuesV1),
});
export const noteDocPresenceInputSchema = z.strictObject({
  ...m1InputBase,
  noteId: uuidSchema,
  // 空串 = 我离开了这篇。上限与主进程里的 awareness 检查同一个数。
  state: z.string().max(NOTE_DOC_PRESENCE_MAX_CHARS),
});
export const noteDocDraftSaveInputSchema = z.strictObject({
  ...m1InputBase,
  noteId: uuidSchema,
  // 与 `syncUpdate` 同一个上限：同一条增量走两条路，两侧不能各说一套。
  update: z.string().min(1).max(NOTE_DOC_UPDATE_MAX_CHARS),
});
export const noteDocDraftNoteInputSchema = z.strictObject({
  ...m1InputBase,
  noteId: uuidSchema,
});
export const cardGenerationStartInputSchema = z.strictObject({
  ...m1InputBase,
  commandId: commandIdSchema,
  noteId: uuidSchema,
  request: desktopCreateCardGenerationRunRequestV2Schema,
});
export const cardGenerationGetRunInputSchema = z.strictObject({ ...m1InputBase, runId: uuidSchema });
export const cardGenerationGetCandidatesInputSchema = z.strictObject({ ...m1InputBase, runId: uuidSchema });
export const cardGenerationReviewInputSchema = z.strictObject({
  ...m1InputBase,
  commandId: commandIdSchema,
  runId: uuidSchema,
  request: desktopCandidateReviewRequestV2Schema,
});
export const cardGenerationRevealInputSchema = z.strictObject({
  ...m1InputBase,
  commandId: commandIdSchema,
  runId: uuidSchema,
  candidateId: uuidSchema,
  request: desktopRevealCandidateRequestV2Schema,
});
export const cardGenerationExposureInputSchema = z.strictObject({
  ...m1InputBase,
  runId: uuidSchema,
  candidateId: uuidSchema,
  revision: positiveIntSchema,
});
export const cardGenerationActivateInputSchema = z.strictObject({
  ...m1InputBase,
  commandId: commandIdSchema,
  runId: uuidSchema,
  request: desktopCardGenerationActivationSelectionV1Schema,
});
export const cardGenerationCancelInputSchema = z.strictObject({ ...m1InputBase, commandId: commandIdSchema, runId: uuidSchema });
export const cardGenerationRetryInputSchema = z.strictObject({ ...m1InputBase, commandId: commandIdSchema, runId: uuidSchema });
export const cardGenerationCloseInputSchema = z.strictObject({
  ...m1InputBase,
  commandId: commandIdSchema,
  runId: uuidSchema,
  expectedReviewDraftRevision: positiveIntSchema,
});
const learningRunGetInputSchema = z.strictObject({ ...m1InputBase, runId: uuidSchema });
const learningRunStartInputSchema = z.strictObject({ ...m1InputBase, commandId: commandIdSchema, request: desktopCreateLearningRunV2RequestSchema });
const learningRunDraftGetInputSchema = z.strictObject({ ...m1InputBase, runId: uuidSchema, taskId: uuidSchema });
const learningRunDraftSaveInputSchema = z.strictObject({ ...m1InputBase, commandId: commandIdSchema, runId: uuidSchema, taskId: uuidSchema, request: desktopPutLearningTaskDraftV2RequestSchema });
const learningRunSubmitInputSchema = z.strictObject({ ...m1InputBase, commandId: commandIdSchema, runId: uuidSchema, taskId: uuidSchema, request: desktopSubmitTaskArtifactV2Schema });
const learningRunActionInputSchema = z.strictObject({ ...m1InputBase, commandId: commandIdSchema, runId: uuidSchema, request: desktopLearningRunActionRequestV2Schema });
const learningRunLeaseInputSchema = z.strictObject({ ...m1InputBase, runId: uuidSchema, request: desktopRecordLearningRunActivityLeaseRequestV2Schema });
const learningRunAbandonInputSchema = z.strictObject({ ...m1InputBase, commandId: commandIdSchema, runId: uuidSchema, request: desktopLearningRunAbandonRequestV2Schema });
const OBJECTIVE_REVIEW_ACTION_ROUTES = [
  "note.detail",
  "objective.detail",
  "objective.library",
] as const satisfies readonly DesktopRouteKindM2[];

export function registerLearningChannels(deps: LearningChannelDeps): void {
  const {
    channel, installHandler, requireM2Route, requireAnyM2Route, assertEpoch,
    contract, getActiveWorkspaceEpoch, ns_learning, gateway, options, emit,
    getActiveSubjectId, setActiveSubjectId, getActiveWorkspaceId, setActiveWorkspaceId,
    setActiveWorkspaceEpoch, assertEpochBoundaryExempt, safeWorkspaceEpoch, formalAssessmentGuard,
    pendingReturnMarkerStore, noteDocCache, recoverPersistedReturnMarker, rememberSession,
    startCompanionLifecycle, stopCompanionLifecycle, stopCompanionChatStreams,
    stopLearningRunStreams, stopCardGenerationStreams, trackedLearningRunIds,
    trackedCardGenerationRunIds, clearSubscriptionsForWindow,
    trackLearningRun, maybeInjectPackagedLearningRunResponseLoss, resolveReturnContract,
    syncFormalGuard, syncFormalGuardFromResult,
  } = deps;

channel(DESKTOP_IPC_CHANNELS.objectiveList, objectiveListInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "objective.library");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return gateway.listObjectives({ lifecycle: input.lifecycle, cursor: input.cursor, limit: input.limit, noteId: input.noteId }, input.meta.requestId);
  }, objectiveListPageV3Schema);

  channel(DESKTOP_IPC_CHANNELS.objectiveGet, objectiveGetInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "objective.detail");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return gateway.getObjective(input.objectiveId, input.meta.requestId);
  }, learningObjectiveSurfaceV3Schema)

installHandler(DESKTOP_IPC_CHANNELS.reviewGetQueue, reviewQueueInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "review.queue");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return gateway.getReviewQueue(input.cursor, input.limit, input.meta.requestId);
  }, undefined, reviewQueueV2Schema);

  installHandler(DESKTOP_IPC_CHANNELS.reviewDefer, reviewDeferInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "review.queue");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return gateway.deferReview(input.request, input.meta.requestId);
  }, undefined, reviewDeferResultV2Schema);

  // 「先看笔记」（39d W5-4；PRD §7.1、§16.24）。路由门与 `reviewDefer` 同一条：
  // 它长在复习队列这一屏上，而那一屏的路由就是 `review.queue`。
  // **返回 schema 必填**：回执那两格（条件上限与屏上那句话）是服务端签发的，
  // 形状漂了要在这里红成"合同不受支持"，而不是漂到界面上某一句 undefined。
  installHandler(DESKTOP_IPC_CHANNELS.reviewRecordRecallSourceReveal, recordRecallSourceRevealInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "review.queue");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return gateway.recordRecallSourceReveal(
      { objectiveId: input.objectiveId, waitingKind: input.waitingKind, idempotencyKey: input.idempotencyKey },
      input.meta.requestId,
    );
  }, undefined, recordRecallSourceRevealResultV1Schema);

  // W7-3 刀三：目标级「暂不安排」／「恢复并开启」（39 §9.1 行 2、行 3）。
  //
  // 路由门用 `requireAnyM2Route` 而不是 `requireM2Route(contract, "review.queue")`：
  // 这颗动作不在复习队列那一屏上，它长在**目标**那一屏（笔记页的学习区、卡库列表行），
  // 而那两面各自的路由是 note.detail / objective.library / objective.detail。按单一路由
  // 收口会把另一个面上的合法操作挡在门外——这正是那个 helper 存在的理由。
  //
  // 两条都是**写**，所以走 `assertEpoch`（fail closed）：切空间之后带着旧 epoch 回来
  // 的排除/恢复必须被拒，否则会在新空间里把一个目标按掉。
  installHandler(DESKTOP_IPC_CHANNELS.reviewHoldObjective, reviewHoldObjectiveInputSchema, options, async (_event, _window, input) => {
    requireAnyM2Route(contract, OBJECTIVE_REVIEW_ACTION_ROUTES);
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return gateway.holdObjectiveForReview(input.request, input.meta.requestId);
  }, undefined, objectiveHoldResultV2Schema);

  installHandler(DESKTOP_IPC_CHANNELS.reviewResumeObjective, reviewResumeObjectiveInputSchema, options, async (_event, _window, input) => {
    requireAnyM2Route(contract, OBJECTIVE_REVIEW_ACTION_ROUTES);
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return gateway.resumeObjectiveForReview(input.request, input.meta.requestId);
  }, undefined, objectiveResumeResultV2Schema);

  // W7-3 刀六：订阅来源分别开停（39 §9.1 第一段与规则表行 1）。
  //
  // 路由门用**同一份** `OBJECTIVE_REVIEW_ACTION_ROUTES` 清单再加两个订阅面
  // （`note.library` 是"哪几篇订阅了"那一屏）。写成两份清单就会有一天只改一处，
  // 于是同一颗开关在笔记页能拨、在书房页报 `route_not_available`。
  const SUBSCRIPTION_ROUTES: readonly DesktopRouteKindM2[] = [
    ...OBJECTIVE_REVIEW_ACTION_ROUTES,
    "note.library",
  ];

  installHandler(DESKTOP_IPC_CHANNELS.reviewSubscriptionActivate, reviewSubscriptionInputSchema, options, async (_event, _window, input) => {
    requireAnyM2Route(contract, SUBSCRIPTION_ROUTES);
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return gateway.activateReviewSubscription(input.request, input.meta.requestId);
  }, undefined, reviewSubscriptionResultV2Schema);

  installHandler(DESKTOP_IPC_CHANNELS.reviewSubscriptionPause, reviewSubscriptionInputSchema, options, async (_event, _window, input) => {
    requireAnyM2Route(contract, SUBSCRIPTION_ROUTES);
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return gateway.pauseReviewSubscription(input.request, input.meta.requestId);
  }, undefined, reviewSubscriptionResultV2Schema);

  installHandler(DESKTOP_IPC_CHANNELS.reviewSubscriptionListNotes, z.strictObject(m1InputBase), options, async (_event, _window, input) => {
    requireM2Route(contract, "note.library");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return gateway.listNoteReviewSubscriptions(input.meta.requestId);
  }, undefined, noteReviewSubscriptionsV2Schema)

installHandler(DESKTOP_IPC_CHANNELS.learningRunGet, learningRunGetInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "learningRun.detail");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    const snapshot = await ns_learning.getLearningRun(gateway.gatewayTransport, input.runId, input.meta.requestId);
    trackLearningRun(snapshot.runId);
    syncFormalGuard(snapshot);
    return snapshot;
  }, undefined, learningRunPublicSnapshotV2Schema);

  installHandler(DESKTOP_IPC_CHANNELS.learningRunStart, learningRunStartInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "learningRun.detail");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    const snapshot = await ns_learning.startLearningRun(gateway.gatewayTransport, { ...input.request, version: 2 }, input.commandId, input.meta.requestId);
    trackLearningRun(snapshot.runId);
    syncFormalGuard(snapshot);
    emit("learningRun", { kind: "learning_run_changed", runId: snapshot.runId, revision: snapshot.runRevision }, getActiveWorkspaceEpoch());
    return snapshot;
  }, undefined, learningRunPublicSnapshotV2Schema);

  installHandler(DESKTOP_IPC_CHANNELS.learningRunGetDraft, learningRunDraftGetInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "learningRun.detail");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    trackLearningRun(input.runId);
    return ns_learning.getLearningRunDraft(gateway.gatewayTransport, input.runId, input.taskId, input.meta.requestId);
  }, undefined, learningTaskDraftV2Schema.nullable());

  installHandler(DESKTOP_IPC_CHANNELS.learningRunSaveDraft, learningRunDraftSaveInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "learningRun.detail");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    trackLearningRun(input.runId);
    const receipt = await ns_learning.saveLearningRunDraft(gateway.gatewayTransport, input.runId, input.taskId, input.request, input.commandId, input.meta.requestId);
    emit("learningRun", { kind: "learning_run_changed", runId: receipt.runId, revision: receipt.runRevision }, getActiveWorkspaceEpoch());
    maybeInjectPackagedLearningRunResponseLoss("draft");
    return receipt;
  }, undefined, learningTaskDraftWriteReceiptV2Schema);

  installHandler(DESKTOP_IPC_CHANNELS.learningRunSubmit, learningRunSubmitInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "learningRun.detail");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    trackLearningRun(input.runId);
    const receipt = await ns_learning.submitLearningRunArtifact(gateway.gatewayTransport, input.runId, input.taskId, input.request, input.commandId, input.meta.requestId);
    try {
      syncFormalGuard(await ns_learning.getLearningRun(gateway.gatewayTransport, input.runId, input.meta.requestId));
    } catch {
      formalAssessmentGuard.failClosed("unknown");
    }
    emit("learningRun", { kind: "learning_run_changed", runId: receipt.runId, revision: receipt.runRevision }, getActiveWorkspaceEpoch());
    maybeInjectPackagedLearningRunResponseLoss("submit");
    return receipt;
  }, undefined, submitTaskArtifactReceiptV2Schema);

  installHandler(DESKTOP_IPC_CHANNELS.learningRunAction, learningRunActionInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "learningRun.detail");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    trackLearningRun(input.runId);
    const response = await ns_learning.applyLearningRunAction(gateway.gatewayTransport, input.runId, input.request, input.commandId, input.meta.requestId);
    syncFormalGuardFromResult(response);
    emit("learningRun", { kind: "learning_run_changed", runId: response.runId, revision: response.snapshot.runRevision }, getActiveWorkspaceEpoch());
    maybeInjectPackagedLearningRunResponseLoss("action");
    return response;
  }, undefined, learningRunActionResponseV2Schema);

  installHandler(DESKTOP_IPC_CHANNELS.learningRunGetResult, learningRunGetInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "learningRun.detail");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    trackLearningRun(input.runId);
    const result = await ns_learning.getLearningRunResult(gateway.gatewayTransport, input.runId, input.meta.requestId);
    // The result DTO intentionally carries no private phase field. Re-read the
    // strict public snapshot before returning it so a completed/ended run can
    // move the main-owned FormalAssessmentGuard into terminal release; a
    // transport/contract failure remains fail-closed and never unlocks the
    // Companion broker on the basis of a result-shaped payload alone.
    try {
      syncFormalGuard(await ns_learning.getLearningRun(gateway.gatewayTransport, input.runId, input.meta.requestId));
    } catch {
      formalAssessmentGuard.failClosed("unknown");
    }
    if (result.status === "learning_result" || result.status === "terminal_without_result") {
      // A terminal result is itself a server proof even when the immediately
      // adjacent snapshot is still one processing revision behind. Reuse the
      // main-owned key and enter the same release protocol; renderer code may
      // only complete it after its sensitive Player tree has unmounted.
      const guardState = formalAssessmentGuard.getSnapshot();
      if (guardState.state === "active" && guardState.runId === result.runId && guardState.runtimeEpoch !== null) {
        formalAssessmentGuard.beginRelease({ runId: guardState.runId, runtimeEpoch: guardState.runtimeEpoch }, true);
      }
    }
    emit("learningRun", { kind: "learning_run_changed", runId: result.runId, revision: result.status === "pending" ? result.runRevision : 0 }, getActiveWorkspaceEpoch());
    return result;
  }, undefined, getLearningRunResultResponseV2Schema);

  installHandler(DESKTOP_IPC_CHANNELS.learningRunRevealTarget, learningRunGetInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "learningRun.detail");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_learning.revealLearningRunTarget(gateway.gatewayTransport, input.runId, input.meta.requestId);
  }, undefined, learningRunTargetRevealV2Schema);

  installHandler(DESKTOP_IPC_CHANNELS.learningRunGetReturnContract, learningRunGetInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "learningRun.detail");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    trackLearningRun(input.runId);
    const contractValue = await ns_learning.getLearningRunReturnContract(gateway.gatewayTransport, input.runId, input.meta.requestId);
    await resolveReturnContract(contractValue);
    return contractValue;
  }, undefined, learningRunReturnContractV2Schema);

  installHandler(DESKTOP_IPC_CHANNELS.learningRunRecordActivityLease, learningRunLeaseInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "learningRun.detail");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    trackLearningRun(input.runId);
    return ns_learning.recordLearningRunActivityLease(gateway.gatewayTransport, input.runId, input.request, input.meta.requestId);
  }, undefined, recordLearningRunActivityLeaseOutputV2Schema);

  installHandler(DESKTOP_IPC_CHANNELS.learningRunAbandon, learningRunAbandonInputSchema, options, async (_event, _window, input) => {
    requireM2Route(contract, "learningRun.detail");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    trackLearningRun(input.runId);
    const response = await ns_learning.abandonLearningRun(gateway.gatewayTransport, input.runId, input.request, input.commandId, input.meta.requestId);
    syncFormalGuardFromResult(response);
    emit("learningRun", { kind: "learning_run_changed", runId: response.runId, revision: response.snapshot.runRevision }, getActiveWorkspaceEpoch());
    return response;
  }, undefined, learningRunActionResponseV2Schema)
}
