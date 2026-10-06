import { registerAgentChannels } from "./desktop-ipc-agent";
import type { GatewayTransport } from "./desktop-gateway-transport";
import type { InputSchema, ParsedMeta } from "./desktop-ipc";
import {
  setPersonalRelationDecisionV2ResultSchema,
  setPersonalRelationDecisionV2Schema,
} from "@ailearn/shared/personal-relation-decision-rules-v2";
import * as ns_source from "./desktop-gateway-ns-source";
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
import { app, BrowserWindow, clipboard, ipcMain, shell, type IpcMainInvokeEvent, type WebContents } from "electron";
import { saveCompanionExportFile } from "./companion-export-file";
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
  COMPANION_DISCOVERY_KINDS,
  COMPANION_DISCOVERY_SOURCES,
  COMPANION_DISCOVERY_VISIBILITY,
  companionDiscoveryBookV1Schema,
  companionDiscoveryEntryV1Schema,
} from "@ailearn/shared/desktop-ipc-contracts";
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
  companionChatListThoughtsRequestV1Schema,
  companionChatListThoughtsResultV1Schema,
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
  companionDailyVisibilityV1Schema,
  companionDailyDeleteV1Schema,
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
  companionMemoryRecycleListV1Schema,
  companionMemoryRevisionListV1Schema,
  companionMemoryQueueResultV1Schema,
  companionMemoryStarMapV2Schema,
  companionPersonaMutationV1Schema,
  companionPersonaPatchV1Schema,
  companionPersonaRestoreV1Schema,
  companionPersonaStagedV1Schema,
  companionPersonaPendingV1Schema,
  companionPersonaActivatedV1Schema,
  companionPersonaResetV1Schema,
  companionPersonaV1Schema,
  companionPersonaVersionListV1Schema,
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

/**
 * 伴星这一族的 IPC 通道（2026-09-30 从 `desktop-ipc.ts` 搬出，第②步）。
 *
 * ## 为什么搬
 *
 * `desktop-ipc.ts` 原本 **218 条通道 / 3985 行**。按 AGENTS.md「主进程的判据单位是**通道**」
 * 与「不要按行数硬切」，要按命名空间切。伴星是最大的一族：
 * **56 条通道 / 385 行 + 49 个入参/出参 schema**。
 *
 * ## 通道**与**它专属的 schema 一起搬
 *
 * 只搬通道的话，段内会有一堆「在这里 import、定义却在另一个文件」的常量，
 * 读一条伴星通道要跳两个地方。schema 留在原文件、handler 搬走，比不搬更难读。
 *
 * ## 依赖面只有 16 项，因为第①步已经收过一次
 *
 * 这一族原本依赖 120 个自由标识符：**54 个可 import**、**49 个是原文件顶层常量（跟着搬）**、
 * **只剩下面这 16 个闭包状态**。其中 `channel`（闭包版 `installHandler`）
 * **已经带着纪元取值器**——第①步把 148 份重复样板收成一份之后，搬运才是纯搬运。
 */

/**
 * M1 通道共用的入参底座。
 *
 * `desktop-ipc.ts` 那边也有一份（它那边还有几十个别的族的 schema 在用）。
 * **两份是同一行 `{ meta: requestMetaSchema }`，`requestMetaSchema` 来自 `@ailearn/shared`**，
 * 所以是同一个对象。不从那边 import——它已经 import 这个模块，**会成环**。
 */
const m1InputBase = { meta: requestMetaSchema };

/** 这一族从 `registerM1DesktopIpc` 的闭包里拿到的全部东西。 */
export type CompanionChannelDeps = {
  /** 闭包版 `installHandler`：**已经绑定了 options 与纪元取值器**（第①步）。 */
  channel: <TInput extends ParsedMeta, TOutput>(
    name: string,
    schema: InputSchema<TInput>,
    operation: (event: IpcMainInvokeEvent, window: BrowserWindow, input: TInput) => TOutput | Promise<TOutput>,
    outputSchema?: z.ZodType<TOutput>,
  ) => void;
  /** 原样透传：这一族里有几条通道走的不是 `channel`。 */
  installHandler: (...args: unknown[]) => void;
  /** 这一族共用的路由门与边界断言。 */
  requireM2Route: (...args: unknown[]) => void;
  requireAnyM2Route: (...args: unknown[]) => void;
  assertEpoch: (meta: RequestMetaV1, activeWorkspaceEpoch: number) => void;
  /** 服务端这一版的 M1 合同快照与工作区纪元。 */
  contract: unknown;
  /**
   * 工作区纪元——**getter，不是值**。
   *
   * 它是闭包里的可变状态（`authGetState` 之后才会变成 9）。
   * **按值传会在注册那一刻把它快照下来**（= 0），于是每条通道的纪元都是 0，
   * 症状是 `stale_workspace` / 出参 `workspaceEpoch` 不对——类型检查与运行都不报错。
   */
  getActiveWorkspaceEpoch: () => number;
  /** 自由函数模块。 */
  ns_companion: typeof import("./desktop-gateway-ns-companion");
  ns_source: typeof import("./desktop-gateway-ns-source");
  /** 网关本身与注册选项。
   *
   * ⚠️ **不要定成 `unknown`**——那会让段内每一处 `gateway.gatewayTransport`
   * 都变成类型错误（110 条），而**运行时完全正常**。
   * deps 的类型要么给真类型，要么用 `typeof` 从真模块取。
   */
  gateway: {
    gatewayTransport: GatewayTransport;
    /** 伴星桥：投递租约与跨轮次上下文。**这四个方法是走它的**，
     *  所以它的形状必须写全（写成 `unknown` 段内每处都会变成类型错误）。 */
    companionBridge: {
      presentCompanionDelivery: (...args: unknown[]) => unknown;
      ackCompanionDelivery: (...args: unknown[]) => unknown;
      setCompanionBridgeContext: (...args: unknown[]) => unknown;
      clearCompanionBridgeContext: (...args: unknown[]) => unknown;
    };
  };
  options: unknown;
  /** 账号级 presence 生命周期：本族自己起的，不是别的族的状态。 */
  /**
   * 「本族自己起的 presence 生命周期」的状态——**getter + setter**，不是值。
   *
   * 它是闭包里的 `let`，而且**段内会给它赋值**（账号重新打开时把「已关闭」那一档作废）。
   * 按值传进来会变成 `const`——vite 直接报
   * `This assignment will throw because … is a constant`。
   */
  getCompanionLifecycleDisabledEpoch: () => number;
  setCompanionLifecycleDisabledEpoch: (value: number) => void;
  startCompanionLifecycle: (workspaceEpoch: number) => Promise<void>;
  stopCompanionLifecycle: () => void;
  /** 往 renderer 发事件的出口。 */
  emit: (channel: string, payload: unknown, workspaceEpoch: number) => void;
};

/** 这一族专属的 49 个入参 / 出参 schema。跟着通道一起搬——
 *  schema 留在 `desktop-ipc.ts` 的话，读一条伴星通道要跳两个文件。 */
export const runtimeInputSchema = z.strictObject(m1InputBase);
const companionRoomPatchInputSchema = z.strictObject({
  ...m1InputBase,
  request: companionRoomProfilePatchV1Schema,
});
const companionVoiceSpeakInputSchema = z.strictObject({
  ...m1InputBase,
  request: companionVoiceSpeakRequestV1Schema,
});
const companionVoiceSpeakSegmentInputSchema = z.strictObject({
  meta: requestMetaSchema,
  request: companionVoiceSpeakSegmentRequestV2Schema,
});
const companionVoicePlaybackOutcomeInputSchema = z.strictObject({
  meta: requestMetaSchema,
  request: companionVoicePlaybackOutcomeRequestV1Schema,
});
const companionChatEnsureInputSchema = z.strictObject({
  ...m1InputBase,
  request: companionChatEnsureRequestV1Schema,
});
const companionChatSendTurnInputSchema = z.strictObject({
  ...m1InputBase,
  request: companionChatSendTurnRequestV1Schema,
});
const companionImageUploadInputSchema = z.strictObject({
  ...m1InputBase,
  request: noteImageUploadRequestV1Schema,
});
const companionChatListMessagesInputSchema = z.strictObject({
  ...m1InputBase,
  request: companionChatListMessagesRequestV1Schema,
});
const companionChatProposalGetInputSchema = z.strictObject({
  ...m1InputBase,
  request: companionChatProposalGetRequestV1Schema,
});
const companionChatProposalDecideInputSchema = z.strictObject({
  ...m1InputBase,
  request: companionChatProposalDecideRequestV1Schema,
});
const companionChatAgentRoutesInputSchema = z.strictObject({
  ...m1InputBase,
  request: companionAgentRoutesListRequestV1Schema,
});
const companionChatRunNodesInputSchema = z.strictObject({
  ...m1InputBase,
  request: companionRunNodesListRequestV1Schema,
});
const companionChatOpenThoughtInputSchema = z.strictObject({
  ...m1InputBase,
  request: companionChatOpenThoughtRequestV1Schema,
});
const companionChatListThoughtsInputSchema = z.strictObject({
  ...m1InputBase,
  request: companionChatListThoughtsRequestV1Schema,
});
const companionChatCancelRunInputSchema = z.strictObject({
  ...m1InputBase,
  request: companionChatCancelRunRequestV1Schema,
});
const companionLearningRunContextInputSchema = z.strictObject({
  ...m1InputBase,
  runId: uuidSchema,
});
const companionLearningRunContextGrantInputSchema = z.strictObject({
  ...m1InputBase,
  runId: uuidSchema,
  request: createCompanionLearningRunContextGrantRequestV1Schema,
});
const companionAccountPatchInputSchema = z.strictObject({
  ...m1InputBase,
  request: companionAccountPatchSchema,
});
const companionOnboardingTransitionInputSchema = z.strictObject({
  ...m1InputBase,
  version: z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  request: onboardingTransitionRequestSchema,
});
const companionMemoryListInputSchema = z.strictObject({
  ...m1InputBase,
  query: companionMemoryListQuerySchema.optional(),
});
export const companionMemoryIdInputSchema = z.strictObject({ ...m1InputBase, memoryId: uuidSchema });
const companionMemoryCreateInputSchema = z.strictObject({ ...m1InputBase, request: companionMemoryCreateInputV1Schema });
const companionMemoryCorrectInputSchema = z.strictObject({ ...m1InputBase, memoryId: uuidSchema, request: companionMemoryCorrectInputV1Schema });
const companionMemoryResolveConflictInputSchema = z.strictObject({ ...m1InputBase, memoryId: uuidSchema, removeId: uuidSchema });
const companionDailyGetInputSchema = z.strictObject({
  ...m1InputBase,
  date: companionDailyDateV1Schema.optional(),
});
const companionDailyMonthInputSchema = z.strictObject({
  ...m1InputBase,
  month: companionDailyMonthValueV1Schema,
});
/** 隐藏/取消隐藏/删除都只认一个本地日期（YYYY-MM-DD）。 */
const companionDailyVisibilityInputSchema = z.strictObject({
  ...m1InputBase,
  date: companionDailyDateV1Schema,
});
const companionHistoryListInputSchema = z.strictObject({
  ...m1InputBase,
  query: companionHistoryQueryV1Schema.optional(),
});
const companionHistorySearchInputSchema = z.strictObject({
  ...m1InputBase,
  query: companionHistorySearchQueryV1Schema,
});
const companionInvitationActionInputSchema = z.strictObject({
  ...m1InputBase,
  request: companionInvitationActionRequestSchema,
});
const companionJourneyActionInputSchema = z.strictObject({
  ...m1InputBase,
  journeyId: uuidSchema,
  request: companionJourneyActionRequestSchema,
});
const companionActivityTimelineInputSchema = z.strictObject({
  ...m1InputBase,
  before: z.number().int().positive().optional(),
});
const companionActivityPresentInputSchema = z.strictObject({
  ...m1InputBase,
  deliveryId: uuidSchema,
  inboxSequence: z.number().int().min(0),
});
const companionActivityAckInputSchema = z.strictObject({
  ...m1InputBase,
  request: companionActivityAckRequestV1Schema,
});
const companionBridgeSetContextInputSchema = z.strictObject({
  ...m1InputBase,
  page: mainPageContextInputV2Schema,
});
const companionDataExportInputSchema = z.strictObject({
  ...m1InputBase,
  kind: companionExportKindV1Schema,
});
const companionPersonaPatchInputSchema = z.strictObject({
  ...m1InputBase,
  request: companionPersonaPatchV1Schema,
});
const companionPersonaResetInputSchema = z.strictObject({
  ...m1InputBase,
  revision: z.number().int().nonnegative(),
});
const companionPersonaRestoreInputSchema = z.strictObject({
  ...m1InputBase,
  revision: z.number().int().positive(),
  currentRevision: z.number().int().nonnegative(),
});
/**
 * 「排队」的请求体与 `patch` **同形**：服务端两条路由收的是同一份完整档案 schema，
 * 省略字段即被默认清空。写两份形状只会在其中一份漂掉，然后界面报出一个
 * 服务端从来没见过 422 的错。
 */
const companionPersonaStageInputSchema = z.strictObject({
  ...m1InputBase,
  request: companionPersonaPatchV1Schema,
});
const companionPersonaActivateInputSchema = z.strictObject({
  ...m1InputBase,
  /** 当前 revision（CAS）。注意不是待生效那一版的号——服务端按当前版本做锁。 */
  revision: z.number().int().nonnegative(),
});
const companionMemoryDeleteOutputSchema = z.strictObject({ memoryItemId: uuidSchema });
export const sourceListInputSchema = z.strictObject({ ...m1InputBase, cursor: z.string().min(1).max(128).optional(), limit: z.number().int().min(1).max(100).optional(), status: z.string().min(1).max(32).optional() });
export const sourceCreateInputSchema = z.strictObject({ ...m1InputBase, request: desktopSourceCreateRequestSchema });
export const sourceGetInputSchema = z.strictObject({ ...m1InputBase, sourceId: uuidSchema });
export const sourceNotesInputSchema = z.strictObject({ ...m1InputBase, sourceId: uuidSchema });
export const sourceUpdateInputSchema = z.strictObject({
  ...m1InputBase,
  sourceId: uuidSchema,
  request: desktopSourceUpdateRequestSchema
});
export const sourceCreateNoteInputSchema = z.strictObject({
  ...m1InputBase,
  sourceId: uuidSchema,
  force: z.boolean().optional()
});
export const sourceArchiveInputSchema = z.strictObject({ ...m1InputBase, sourceId: uuidSchema });
export const sourceReparseInputSchema = z.strictObject({ ...m1InputBase, sourceId: uuidSchema });
export const sourceRestoreInputSchema = z.strictObject({ ...m1InputBase, sourceId: uuidSchema });
export const sourceImageGetInputSchema = z.strictObject({
  ...m1InputBase,
  request: sourceImageGetRequestV1Schema,
});
const answerModePatchInputSchema = z.strictObject({
  ...m1InputBase,
  preference: z.enum(["voice", "silent", "text", "any"]),
});
const voicePreferencePatchInputSchema = z.strictObject({
  ...m1InputBase,
  engine: ttsEngineV1Schema,
  voice: z.string().min(1).max(120),
});

/**
 * 注册伴星这一族的 56 条通道。
 *
 * **只做一件事**：把 `deps` 解构成局部名，然后把通道照原样摆上去。
 * 通道体一个字没改——搬的是**位置**，不是**行为**。
 */
export function registerCompanionChannels(deps: CompanionChannelDeps): void {
  registerAgentChannels(deps);
  const {
    channel, installHandler, requireM2Route, requireAnyM2Route, assertEpoch,
    contract, getActiveWorkspaceEpoch,
    ns_companion, ns_source, gateway, options,
    getCompanionLifecycleDisabledEpoch, setCompanionLifecycleDisabledEpoch,
    startCompanionLifecycle,
    stopCompanionLifecycle, emit,
  } = deps;

channel(DESKTOP_IPC_CHANNELS.companionAnswerModeGet, runtimeInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "settings.section");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_companion.getAnswerModePreference(gateway.gatewayTransport, input.meta.requestId);
  }, companionAnswerModePreferenceV1Schema);

  channel(DESKTOP_IPC_CHANNELS.companionAnswerModePatch, answerModePatchInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "settings.section");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_companion.setAnswerModePreference(gateway.gatewayTransport, input.preference, input.meta.requestId);
  }, companionAnswerModePreferenceV1Schema);

  // 音色与引擎偏好（账号级跨设备）+ 试听。整组归 settings.section，与作答模态偏好同一道闸。
  channel(DESKTOP_IPC_CHANNELS.companionVoicePreferenceGet, runtimeInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "settings.section");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_companion.getCompanionVoicePreference(gateway.gatewayTransport, input.meta.requestId);
  }, companionVoicePreferenceV1Schema);

  channel(DESKTOP_IPC_CHANNELS.companionVoicePreferencePatch, voicePreferencePatchInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "settings.section");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_companion.setCompanionVoicePreference(gateway.gatewayTransport, 
      { engine: input.engine, voice: input.voice },
      input.meta.requestId,
    );
  }, companionVoicePreferenceV1Schema)

channel(DESKTOP_IPC_CHANNELS.companionHomeGetProjection, runtimeInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_companion.getCompanionHomeProjection(gateway.gatewayTransport, input.meta.requestId);
  }, companionHomeProjectionV1Schema);

  channel(DESKTOP_IPC_CHANNELS.companionRoomGetProfile, runtimeInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_companion.getCompanionRoomProfile(gateway.gatewayTransport, input.meta.requestId);
  }, companionRoomProfileV1Schema);

  channel(DESKTOP_IPC_CHANNELS.companionRoomPatchProfile, companionRoomPatchInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_companion.patchCompanionRoomProfile(gateway.gatewayTransport, input.request, input.meta.requestId);
  }, companionRoomProfileV1Schema);

  // 账号级 presence（决策 3）：读当前账号状态 / 写入（revision CAS）。
  // 与其余伴星通道同一路由门控（设置入口在房间的伴星面板内）。
  channel(DESKTOP_IPC_CHANNELS.companionAccountGetState, runtimeInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_companion.getCompanionAccountOverview(gateway.gatewayTransport, input.meta.requestId);
  }, companionOverviewSchema);

  channel(DESKTOP_IPC_CHANNELS.companionAccountPatchState, companionAccountPatchInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    const account = await ns_companion.patchCompanionAccountState(gateway.gatewayTransport, input.request, input.meta.requestId);
    if (account.globalEnabled) {
      // 刚被重新打开：上面记的"这个纪元已关闭"要作废，否则这一趟会被当成已经
      // 处理过，两条常连接再也不会建起来。
      setCompanionLifecycleDisabledEpoch(0);
      void startCompanionLifecycle(getActiveWorkspaceEpoch());
    } else stopCompanionLifecycle();
    emit("runtime", { kind: "snapshot_invalidated", scope: "runtime" }, getActiveWorkspaceEpoch());
    return account;
  }, companionAccountStateV1Schema);

  channel(DESKTOP_IPC_CHANNELS.companionOnboardingTransition, companionOnboardingTransitionInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_companion.transitionCompanionOnboarding(gateway.gatewayTransport, input.version, input.request, input.meta.requestId);
  }, onboardingTransitionResponseSchema);

  channel(DESKTOP_IPC_CHANNELS.companionVoiceSpeak, companionVoiceSpeakInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_companion.speakCompanionVoice(gateway.gatewayTransport, input.request, input.meta.requestId);
  }, companionVoiceSpeakResultV1Schema);

  channel(DESKTOP_IPC_CHANNELS.companionVoiceSpeakSegment, companionVoiceSpeakSegmentInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_companion.speakCompanionVoiceSegment(gateway.gatewayTransport, input.request, input.meta.requestId);
  }, companionVoiceSpeakResultV1Schema);

  // 一段音频播没播成（0247）：与合成同一路由门控。渲染层是 fire-and-forget，
  // 这条链路失败只会变成"少一行统计"，不会打断朗读。
  channel(DESKTOP_IPC_CHANNELS.companionVoicePlaybackOutcome, companionVoicePlaybackOutcomeInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_companion.recordCompanionVoicePlaybackOutcome(gateway.gatewayTransport, input.request, input.meta.requestId);
  }, companionVoicePlaybackOutcomeResultV1Schema);

  channel(DESKTOP_IPC_CHANNELS.companionChatEnsureConversation, companionChatEnsureInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_companion.ensureCompanionConversation(gateway.gatewayTransport, input.request, input.meta.requestId);
  }, companionChatEnsureResultV1Schema);

  channel(DESKTOP_IPC_CHANNELS.companionChatSendTurn, companionChatSendTurnInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_companion.sendCompanionTurn(gateway.gatewayTransport, input.request, input.meta.requestId);
  }, companionChatSendTurnResultV1Schema);

  // 对话图片上传（2026-10-06 输入框传图）：与其余伴星通道同一路由门控；
  // 服务端负责 magic bytes/尺寸/像素数防线，这里只过同一份合同。
  channel(DESKTOP_IPC_CHANNELS.companionImageUpload, companionImageUploadInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_companion.uploadCompanionImage(gateway.gatewayTransport, input.request, input.meta.requestId);
  }, noteImageUploadResultV1Schema);

  channel(DESKTOP_IPC_CHANNELS.companionChatListMessages, companionChatListMessagesInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_companion.listCompanionChatMessages(gateway.gatewayTransport, input.request, input.meta.requestId);
  }, companionChatListMessagesResultV1Schema);

  // 提案确认 + agent 导航 route 轮询（2026-09-18）：与其余伴星通道同一路由门控。
  channel(DESKTOP_IPC_CHANNELS.companionChatProposalGet, companionChatProposalGetInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_companion.getCompanionChatProposal(gateway.gatewayTransport, input.request, input.meta.requestId);
  }, companionChatProposalGetResultV1Schema);

  channel(DESKTOP_IPC_CHANNELS.companionChatProposalDecide, companionChatProposalDecideInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_companion.decideCompanionChatProposal(gateway.gatewayTransport, input.request, input.meta.requestId);
  }, companionChatProposalDecideResultV1Schema);

  channel(DESKTOP_IPC_CHANNELS.companionChatAgentRoutes, companionChatAgentRoutesInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_companion.listCompanionAgentRoutes(gateway.gatewayTransport, input.request, input.meta.requestId);
  }, companionAgentRoutesListResultV1Schema);

  // 过程节点留痕（2026-09-19）：与其余伴星只读通道同一路由门控，形状照 agent-routes。
  channel(DESKTOP_IPC_CHANNELS.companionChatRunNodes, companionChatRunNodesInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_companion.listCompanionRunNodes(gateway.gatewayTransport, input.request, input.meta.requestId);
  }, companionRunNodesListResultV1Schema);

  // 念想历史只读，不消耗表达；与其余伴星通道共用路由与空间 epoch 门控。
  channel(DESKTOP_IPC_CHANNELS.companionChatListThoughts, companionChatListThoughtsInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_companion.listCompanionThoughts(gateway.gatewayTransport, input.request, input.meta.requestId);
  }, companionChatListThoughtsResultV1Schema);

  // 气泡念头主动开场：只有用户点气泡时才消费念头并写入对话。
  channel(DESKTOP_IPC_CHANNELS.companionChatOpenThought, companionChatOpenThoughtInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_companion.openCompanionThought(gateway.gatewayTransport, input.request, input.meta.requestId);
  }, companionChatOpenThoughtResultV1Schema);

  // 停止本轮（2026-09-19）：与其余伴星通道同一路由门控。202 / 200 幂等同形状。
  channel(DESKTOP_IPC_CHANNELS.companionChatCancelRun, companionChatCancelRunInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_companion.cancelCompanionChatRun(gateway.gatewayTransport, input.request, input.meta.requestId);
  }, companionChatCancelRunResultV1Schema);

  channel(DESKTOP_IPC_CHANNELS.companionLearningRunGetContext, companionLearningRunContextInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "learningRun.detail");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_companion.getCompanionLearningRunContext(gateway.gatewayTransport, input.runId, input.meta.requestId);
  }, companionLearningRunContextV1Schema);

  channel(DESKTOP_IPC_CHANNELS.companionLearningRunCreateContextGrant, companionLearningRunContextGrantInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "learningRun.detail");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_companion.createCompanionLearningRunContextGrant(gateway.gatewayTransport, input.runId, input.request, input.meta.requestId);
  }, companionGroundedTutorGrantV1Schema);

  // 伴星中心（页 20）的共同记录。与其余伴星通道同一路由门控：这些都是"书房"
  // 内的呈现，不新增导航目标，也不把记忆正文写进路由或快照。
  channel(DESKTOP_IPC_CHANNELS.companionMemoryList, companionMemoryListInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_companion.listCompanionMemories(gateway.gatewayTransport, input.query ?? {}, input.meta.requestId);
  }, companionMemoryListV1Schema);

  channel(DESKTOP_IPC_CHANNELS.companionMemoryStarMap, runtimeInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_companion.getCompanionMemoryStarMap(gateway.gatewayTransport, input.meta.requestId);
  }, companionMemoryStarMapV2Schema)

channel(DESKTOP_IPC_CHANNELS.companionMemoryDelete, companionMemoryIdInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_companion.deleteCompanionMemory(gateway.gatewayTransport, input.memoryId, input.meta.requestId);
  }, companionMemoryDeleteOutputSchema);

  // 回收区的两个动作都**不回传记忆体**：服务端在两处都返回 204，因为恢复后
// 那一行的归档/删除状态已变，回一份旧快照会让面板短暂显示成"没恢复"。
// 调用方刷新列表即可——那是唯一正确的口径。
channel(DESKTOP_IPC_CHANNELS.companionMemoryRestoreDeleted, companionMemoryIdInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    await ns_companion.restoreDeletedCompanionMemory(gateway.gatewayTransport, input.memoryId, input.meta.requestId);
    return null;
  }, z.null());

  channel(DESKTOP_IPC_CHANNELS.companionMemoryRecycleList, runtimeInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_companion.listCompanionMemoryRecycle(gateway.gatewayTransport, input.meta.requestId);
  }, companionMemoryRecycleListV1Schema);

channel(DESKTOP_IPC_CHANNELS.companionMemoryErase, companionMemoryIdInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    await ns_companion.eraseCompanionMemory(gateway.gatewayTransport, input.memoryId, input.meta.requestId);
    return null;
  }, z.null());

// ── 40 §7 发现簿 ───────────────────────────────────────────────────────
//
// 取消收藏**不叫 delete**：它只置不可见，原始回答与日记一个字都不动。
// 名字叫 delete 的后果，是下一次有人顺手把它接成级联。

const companionDiscoveryCollectInputSchema = z.strictObject({
  ...m1InputBase,
  request: z.strictObject({
    kind: z.enum(COMPANION_DISCOVERY_KINDS),
    source: z.enum(COMPANION_DISCOVERY_SOURCES),
    sourceId: z.string().min(1).max(200),
    author: z.enum(["user", "assistant"]),
    body: z.string().min(1).max(4000),
    annotation: z.string().max(2000).nullable().optional(),
    visibility: z.enum(COMPANION_DISCOVERY_VISIBILITY).optional(),
  }),
});
const companionDiscoveryIdentityInputSchema = z.strictObject({
  ...m1InputBase,
  request: z.strictObject({
    kind: z.enum(COMPANION_DISCOVERY_KINDS),
    source: z.enum(COMPANION_DISCOVERY_SOURCES),
    sourceId: z.string().min(1).max(200),
  }),
});

channel(DESKTOP_IPC_CHANNELS.companionDiscoveryGet, runtimeInputSchema, async (_event, _window, input) => {
  requireM2Route(contract, "room.home");
  assertEpoch(input.meta, getActiveWorkspaceEpoch());
  return ns_companion.getCompanionDiscoveryBook(gateway.gatewayTransport, input.meta.requestId);
}, companionDiscoveryBookV1Schema);

channel(DESKTOP_IPC_CHANNELS.companionDiscoveryCollect, companionDiscoveryCollectInputSchema, async (_event, _window, input) => {
  requireM2Route(contract, "room.home");
  assertEpoch(input.meta, getActiveWorkspaceEpoch());
  return ns_companion.collectCompanionDiscovery(gateway.gatewayTransport, input.request, input.meta.requestId);
}, z.object({ status: z.enum(["collected", "already_collected"]), entry: companionDiscoveryEntryV1Schema }));

channel(DESKTOP_IPC_CHANNELS.companionDiscoveryUncollect, companionDiscoveryIdentityInputSchema, async (_event, _window, input) => {
  requireM2Route(contract, "room.home");
  assertEpoch(input.meta, getActiveWorkspaceEpoch());
  return ns_companion.uncollectCompanionDiscovery(gateway.gatewayTransport, input.request, input.meta.requestId);
}, z.object({ status: z.enum(["uncollected", "not_collected"]) }));

channel(DESKTOP_IPC_CHANNELS.companionDiscoveryAnnotate, z.strictObject({ ...m1InputBase, request: z.strictObject({ entryId: uuidSchema, annotation: z.string().max(2000).nullable() }) }), async (_event, _window, input) => {
  requireM2Route(contract, "room.home");
  assertEpoch(input.meta, getActiveWorkspaceEpoch());
  return ns_companion.annotateCompanionDiscovery(gateway.gatewayTransport, input.request, input.meta.requestId);
}, z.object({ status: z.literal("annotated") }));

const companionDiscoveryStateInputSchema = z.strictObject({
  ...m1InputBase,
  kind: z.enum(COMPANION_DISCOVERY_KINDS),
  source: z.enum(COMPANION_DISCOVERY_SOURCES),
  sourceId: z.string().min(1).max(200),
});

channel(DESKTOP_IPC_CHANNELS.companionDiscoveryState, companionDiscoveryStateInputSchema, async (_event, _window, input) => {
  requireM2Route(contract, "room.home");
  assertEpoch(input.meta, getActiveWorkspaceEpoch());
  return ns_companion.getCompanionDiscoveryState(gateway.gatewayTransport, { kind: input.kind, source: input.source, sourceId: input.sourceId }, input.meta.requestId);
}, z.object({ collected: z.boolean(), entryId: uuidSchema.nullable(), annotation: z.string().nullable() }));

channel(DESKTOP_IPC_CHANNELS.companionMemoryCreate, companionMemoryCreateInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_companion.createCompanionMemory(gateway.gatewayTransport, input.request, input.meta.requestId);
  }, companionMemoryItemV1Schema);

  channel(DESKTOP_IPC_CHANNELS.companionMemoryCorrect, companionMemoryCorrectInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_companion.correctCompanionMemory(gateway.gatewayTransport, input.memoryId, input.request, input.meta.requestId);
  }, companionMemoryItemV1Schema);

  channel(DESKTOP_IPC_CHANNELS.companionMemoryRevisions, companionMemoryIdInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_companion.readCompanionMemoryRevisions(gateway.gatewayTransport, input.memoryId, input.meta.requestId);
  }, companionMemoryRevisionListV1Schema);

  channel(DESKTOP_IPC_CHANNELS.companionMemoryDismiss, companionMemoryIdInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_companion.dismissCompanionMemory(gateway.gatewayTransport, input.memoryId, input.meta.requestId);
  }, companionMemoryItemV1Schema);

  channel(DESKTOP_IPC_CHANNELS.companionMemoryConflicts, runtimeInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_companion.listCompanionMemoryConflicts(gateway.gatewayTransport, input.meta.requestId);
  }, companionMemoryConflictListV1Schema);

  channel(DESKTOP_IPC_CHANNELS.companionMemoryResolveConflict, companionMemoryResolveConflictInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_companion.resolveCompanionMemoryConflict(gateway.gatewayTransport, input.memoryId, input.removeId, input.meta.requestId);
  }, companionMemoryConflictResolveResultV1Schema);

  channel(DESKTOP_IPC_CHANNELS.companionMemoryRebuildEmbeddings, runtimeInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_companion.rebuildCompanionMemoryEmbeddings(gateway.gatewayTransport, input.meta.requestId);
  }, companionMemoryQueueResultV1Schema);

  channel(DESKTOP_IPC_CHANNELS.companionMemoryClear, runtimeInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_companion.clearCompanionMemories(gateway.gatewayTransport, input.meta.requestId);
  }, companionMemoryClearResultV1Schema);

  channel(DESKTOP_IPC_CHANNELS.companionMemorySummarizeRecent, runtimeInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_companion.summarizeRecentCompanionHistory(gateway.gatewayTransport, input.meta.requestId);
  }, companionMemoryQueueResultV1Schema);

  channel(DESKTOP_IPC_CHANNELS.companionDailyGet, companionDailyGetInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_companion.getCompanionDailySummary(gateway.gatewayTransport, input.date, input.meta.requestId);
  }, companionDailySummaryV1Schema);

  channel(DESKTOP_IPC_CHANNELS.companionDailyMonth, companionDailyMonthInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_companion.getCompanionDailyMonth(gateway.gatewayTransport, input.month, input.meta.requestId);
  }, companionDailyMonthV1Schema);

  // §10：「隐藏日记」与「删除日记」是两种语义（隐藏可恢复、删除清派生），
  // 所以是两条独立通道而不是一个带 action 的通道——调用点读起来更不容易搞混。
  channel(DESKTOP_IPC_CHANNELS.companionDailyHide, companionDailyVisibilityInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_companion.hideCompanionDiary(gateway.gatewayTransport, input.date, input.meta.requestId);
  }, companionDailyVisibilityV1Schema);

  channel(DESKTOP_IPC_CHANNELS.companionDailyUnhide, companionDailyVisibilityInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_companion.unhideCompanionDiary(gateway.gatewayTransport, input.date, input.meta.requestId);
  }, companionDailyVisibilityV1Schema);

  channel(DESKTOP_IPC_CHANNELS.companionDailyDelete, companionDailyVisibilityInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_companion.removeCompanionDiary(gateway.gatewayTransport, input.date, input.meta.requestId);
  }, companionDailyDeleteV1Schema);

  channel(DESKTOP_IPC_CHANNELS.companionPersonaGet, runtimeInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_companion.getCompanionPersona(gateway.gatewayTransport, input.meta.requestId);
  }, companionPersonaV1Schema);

  channel(DESKTOP_IPC_CHANNELS.companionPersonaVersions, runtimeInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_companion.getCompanionPersonaVersions(gateway.gatewayTransport, input.meta.requestId);
  }, companionPersonaVersionListV1Schema);

  channel(DESKTOP_IPC_CHANNELS.companionPersonaPatch, companionPersonaPatchInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_companion.patchCompanionPersona(gateway.gatewayTransport, input.request, input.meta.requestId);
  }, companionPersonaMutationV1Schema);

  channel(DESKTOP_IPC_CHANNELS.companionPersonaRestore, companionPersonaRestoreInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_companion.restoreCompanionPersona(gateway.gatewayTransport, {
      revision: input.revision,
      currentRevision: input.currentRevision,
    }, input.meta.requestId);
  }, companionPersonaRestoreV1Schema);

  channel(DESKTOP_IPC_CHANNELS.companionPersonaReset, companionPersonaResetInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_companion.resetCompanionPersona(gateway.gatewayTransport, input.revision, input.meta.requestId);
  }, companionPersonaResetV1Schema);

  // ── 人格「待生效版本」（40 §4.8.4 / A50）────────────────────────────────
  // 与上面四条人格通道同一套路由门控与 epoch 校验：它们都是"书房内的呈现"，
  // 不新增导航目标，也不把人格正文写进路由或快照。

  channel(DESKTOP_IPC_CHANNELS.companionPersonaPending, runtimeInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_companion.getCompanionPersonaPending(gateway.gatewayTransport, input.meta.requestId);
  }, companionPersonaPendingV1Schema);

  channel(DESKTOP_IPC_CHANNELS.companionPersonaStage, companionPersonaStageInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_companion.stageCompanionPersonaRevision(gateway.gatewayTransport, input.request, input.meta.requestId);
  }, companionPersonaStagedV1Schema);

  channel(DESKTOP_IPC_CHANNELS.companionPersonaActivate, companionPersonaActivateInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_companion.activateCompanionPersonaPending(gateway.gatewayTransport, input.revision, input.meta.requestId);
  }, companionPersonaActivatedV1Schema);

  channel(DESKTOP_IPC_CHANNELS.companionHistoryList, companionHistoryListInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_companion.listCompanionHistory(gateway.gatewayTransport, input.query ?? {}, input.meta.requestId);
  }, companionHistoryPageV1Schema);

  channel(DESKTOP_IPC_CHANNELS.companionHistorySearch, companionHistorySearchInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_companion.searchCompanionHistory(gateway.gatewayTransport, input.query, input.meta.requestId);
  }, companionHistorySearchV1Schema);

  channel(DESKTOP_IPC_CHANNELS.companionHistoryClear, runtimeInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_companion.clearCompanionHistory(gateway.gatewayTransport, input.meta.requestId);
  }, companionHistoryClearResultV1Schema);

  channel(DESKTOP_IPC_CHANNELS.companionLearningContextGet, runtimeInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_companion.getCompanionLearningContext(gateway.gatewayTransport, input.meta.requestId);
  }, companionLearningContextV1Schema);

  channel(DESKTOP_IPC_CHANNELS.companionJourneyBootstrap, runtimeInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_companion.getCompanionJourneyBootstrap(gateway.gatewayTransport, input.meta.requestId);
  }, companionJourneyBootstrapSchema);

  channel(DESKTOP_IPC_CHANNELS.companionInvitationAction, companionInvitationActionInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_companion.actOnCompanionInvitation(gateway.gatewayTransport, input.request, input.meta.requestId);
  }, companionInvitationSchema);

  channel(DESKTOP_IPC_CHANNELS.companionJourneyGet, companionJourneyActionInputSchema.pick({ meta: true, journeyId: true }), async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_companion.getCompanionJourney(gateway.gatewayTransport, input.journeyId, input.meta.requestId);
  }, companionJourneySchema);

  channel(DESKTOP_IPC_CHANNELS.companionJourneyAction, companionJourneyActionInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_companion.actOnCompanionJourney(gateway.gatewayTransport, input.journeyId, input.request, input.meta.requestId);
  }, companionJourneySchema);

  channel(DESKTOP_IPC_CHANNELS.companionActivityTimeline, companionActivityTimelineInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_companion.listCompanionActivityTimeline(gateway.gatewayTransport, input.before, input.meta.requestId);
  }, companionActivityTimelineV1Schema);

  channel(DESKTOP_IPC_CHANNELS.companionActivityPresent, companionActivityPresentInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return gateway.companionBridge?.presentCompanionDelivery(input.deliveryId, input.inboxSequence, input.meta.requestId);
  }, companionActivityDeliveryV1Schema);

  channel(DESKTOP_IPC_CHANNELS.companionActivityAck, companionActivityAckInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return gateway.companionBridge?.ackCompanionDelivery(input.request, input.meta.requestId);
  }, companionActivityDeliveryV1Schema);

  channel(DESKTOP_IPC_CHANNELS.companionBridgeSetContext, companionBridgeSetContextInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return gateway.companionBridge?.setCompanionBridgeContext(input.page, input.meta.requestId);
  }, companionBridgeStateV1Schema);

  channel(DESKTOP_IPC_CHANNELS.companionBridgeClearContext, runtimeInputSchema, async (_event, _window, input) => {
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return gateway.companionBridge?.clearCompanionBridgeContext(input.meta.requestId);
  }, companionBridgeStateV1Schema);

  channel(DESKTOP_IPC_CHANNELS.companionDataExport, companionDataExportInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    const response = await ns_companion.openCompanionExport(gateway.gatewayTransport, input.kind, input.meta.requestId);
    try {
      return await saveCompanionExportFile({
        downloadsPath: app.getPath("downloads"), kind: input.kind, response,
        beforeCommit: () => assertEpoch(input.meta, getActiveWorkspaceEpoch()),
      });
    } catch (cause) {
      if (cause instanceof DesktopGatewayFailure) throw cause;
      throw new DesktopGatewayFailure("safe_internal_error", "user_action");
    }
  }, companionExportResultV1Schema);

  channel(DESKTOP_IPC_CHANNELS.companionAuditDelete, runtimeInputSchema, async (_event, _window, input) => {
    requireM2Route(contract, "room.home");
    assertEpoch(input.meta, getActiveWorkspaceEpoch());
    return ns_companion.deleteCompanionAudit(gateway.gatewayTransport, input.meta.requestId);
  }, companionAuditDeleteResultV1Schema)
}
